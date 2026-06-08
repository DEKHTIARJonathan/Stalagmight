import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import './SpreadsheetGrid.css';
import {
  type GridColumn,
  type GridSelection,
  type CellCoord,
  type CellEdit,
  DEFAULT_COL_WIDTH,
  ROW_HEIGHT,
} from './types';
import { parseLocaleNumber, parseTSV, serializeRangeToTSV } from './gridClipboard';
import {
  arrowTarget,
  clamp,
  columnOffsets,
  cycleActiveInRect,
  extendSeries,
  fillTargets,
  isInRect,
  placePaste,
  rectIsSingleCell,
  selectionRect,
  tabTarget,
  type Rect,
} from './gridGeometry';

const HEADER_HEIGHT = 33;
const MIN_COL_WIDTH = 40;
const EDGE_SCROLL_ZONE = 26;
const GUTTER_WIDTH = 48; // frozen row-number gutter on the left

export interface SpreadsheetGridProps<Row> {
  columns: GridColumn<Row>[];
  rows: Row[];
  /** Stable key per row (used for React keys only). */
  rowKey: (row: Row, index: number) => string | number;
  /** Commit a single coerced cell value. */
  onEdit: (rowIndex: number, colKey: string, value: unknown) => void;
  /** Commit many coerced edits as ONE undo unit (paste / fill / clear). */
  onBatchEdit?: (edits: CellEdit[]) => void;

  /** Locale for number parsing/formatting (default: 'en-US'). At integration
   *  pass the app's active locale so comma-decimals parse correctly. */
  locale?: string;
  /** Visible height in px (default 400). */
  height?: number;

  /** Column keys hidden from view (controlled). `id`-style columns can be kept
   *  always-on by the host simply by never hiding them. */
  hiddenColumns?: string[];
  /** Visible column order as a list of keys (controlled). Unknown/missing keys
   *  fall back to declaration order. */
  columnOrder?: string[];
  onColumnOrderChange?: (order: string[]) => void;
  onHiddenColumnsChange?: (hidden: string[]) => void;
  /** Reorder rows by dragging the row-number gutter. Move the contiguous block
   *  of data-row indices [fromStart..fromEnd] so it starts before `toIndex` (an
   *  insertion boundary in the ORIGINAL indexing). Omit to disable row moving
   *  (the gutter then only selects). The host owns row order, so it must apply. */
  onMoveRows?: (fromStart: number, fromEnd: number, toIndex: number) => void;
  /** Insert `count` blank rows before `beforeIndex` (host owns the row set).
   *  Enables "Insert N rows above/below" in the context menu. */
  onInsertRows?: (beforeIndex: number, count: number) => void;
  /** Delete the contiguous data rows [fromRow..toRow] (host owns the row set).
   *  Enables "Delete N rows" in the context menu. */
  onDeleteRows?: (fromRow: number, toRow: number) => void;
  /** Called after a paste that couldn't be applied in full: `written` cells were
   *  committed, `clipped` fell past the grid's last row/column, `skipped` landed
   *  on read-only/unparseable cells. Let the host surface a notice. */
  onPasteReport?: (info: { written: number; clipped: number; skipped: number }) => void;

  maximized?: boolean;
  onToggleMaximize?: () => void;

  className?: string;
  /** Notified when the user moves the focus (active cell) — wire to app
   *  selection (map/detail sync) at integration. */
  onActiveCellChange?: (rowIndex: number, colKey: string) => void;
}

interface EditState {
  row: number;
  colKey: string;
  draft: string;
}

const PRINTABLE = /^.$/u;

export function SpreadsheetGrid<Row>(props: SpreadsheetGridProps<Row>) {
  const {
    columns,
    rows,
    rowKey,
    onEdit,
    onBatchEdit,
    locale = 'en-US',
    height = 400,
    hiddenColumns,
    columnOrder,
    onColumnOrderChange,
    onHiddenColumnsChange,
    onMoveRows,
    onInsertRows,
    onDeleteRows,
    onPasteReport,
    maximized = false,
    onToggleMaximize,
    className = '',
    onActiveCellChange,
  } = props;

  // --- Visible columns: order then hide ------------------------------------
  const visibleColumns = useMemo(() => {
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const ordered: GridColumn<Row>[] = [];
    if (columnOrder && columnOrder.length) {
      for (const key of columnOrder) {
        const c = byKey.get(key);
        if (c) ordered.push(c);
      }
      for (const c of columns) if (!columnOrder.includes(c.key)) ordered.push(c);
    } else {
      ordered.push(...columns);
    }
    const hidden = new Set(hiddenColumns ?? []);
    return ordered.filter((c) => !hidden.has(c.key));
  }, [columns, columnOrder, hiddenColumns]);

  const [colWidthOverrides, setColWidthOverrides] = useState<Record<string, number>>({});
  const colKeys = useMemo(() => visibleColumns.map((c) => c.key), [visibleColumns]);
  const widths = useMemo(
    () => visibleColumns.map((c) => colWidthOverrides[c.key] ?? c.width ?? DEFAULT_COL_WIDTH),
    [visibleColumns, colWidthOverrides],
  );
  const offsets = useMemo(() => columnOffsets(widths), [widths]);
  const totalWidth = GUTTER_WIDTH + (offsets[offsets.length - 1] ?? 0);
  const colIndexOf = useCallback((key: string) => colKeys.indexOf(key), [colKeys]);
  const writableColIdxs = useMemo(
    () => visibleColumns.map((c, i) => (isColWritable(c) ? i : -1)).filter((i) => i >= 0),
    [visibleColumns],
  );

  const rowCount = rows.length;
  const colCount = visibleColumns.length;

  // --- State ----------------------------------------------------------------
  const firstWritable = writableColIdxs[0] ?? 0;
  const [selection, setSelection] = useState<GridSelection>(() => {
    const key = colKeys[firstWritable] ?? colKeys[0] ?? '';
    const c = { row: 0, colKey: key };
    return { anchor: c, focus: c, active: c };
  });
  const [editing, setEditing] = useState<EditState | null>(null);
  // Additional committed ranges for non-contiguous (Ctrl+click) selection. The
  // live range is `selection`; these are the previously-added rectangles.
  const [extraRanges, setExtraRanges] = useState<Rect[]>([]);
  const [copiedRect, setCopiedRect] = useState<Rect | null>(null);
  const [fillPreview, setFillPreview] = useState<Rect | null>(null);
  const [interacting, setInteracting] = useState(false);
  const dragging = useRef(false);
  const pendingDrag = useRef<{ x: number; y: number } | null>(null);
  const fillDragging = useRef(false);
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const dragMouseY = useRef(0);
  const autoScrollRAF = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [grabbing, setGrabbing] = useState(false); // closed-hand cursor during a move drag
  const [invalidCell, setInvalidCell] = useState<CellCoord | null>(null); // rejected-edit flash
  const invalidTimer = useRef<number | undefined>(undefined);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // Header drag: 'select' extends a multi-column selection; 'move' reorders the
  // already-selected column block (Google-Sheets behaviour).
  const colDrag = useRef<{ mode: 'select' | 'move'; anchorCol: number; fromC0: number; fromC1: number } | null>(null);
  const [colMoveDrop, setColMoveDrop] = useState<{ index: number; lineX: number } | null>(null);
  // Generic floating drag-ghost (used by both column and row moves).
  const [colGhost, setColGhost] = useState<{ x: number; y: number; label: string; count: number } | null>(null);
  const rowDrag = useRef<{ mode: 'select' | 'move'; anchorRow: number; fromR0: number; fromR1: number } | null>(null);
  const [rowMoveDrop, setRowMoveDrop] = useState<{ index: number; lineY: number } | null>(null);
  // Drag the selection border to move the cells' contents (cut-and-drop).
  const cellMove = useRef<{ grabRow: number; grabCol: number; src: Rect } | null>(null);
  const [cellMoveDrop, setCellMoveDrop] = useState<Rect | null>(null);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    scrollMargin: HEADER_HEIGHT,
  });

  // --- Derived rectangle ----------------------------------------------------
  const rect = useMemo(() => selectionRect(selection, colIndexOf), [selection, colIndexOf]);
  const focusColIdx = colIndexOf(selection.focus.colKey);
  const activeColIdx = colIndexOf(selection.active.colKey);
  const multiCell = !rectIsSingleCell(rect);

  // --- Helpers --------------------------------------------------------------
  const colAt = useCallback((idx: number) => visibleColumns[idx], [visibleColumns]);

  // Google-Sheets-style selection summary (Count + Sum/Avg/Min/Max of numerics),
  // computed across all ranges (deduped). Shown when >1 cell is selected.
  const selectionStats = useMemo(() => {
    const cellsSelected = [rect, ...extraRanges].reduce(
      (s, rg) => s + (rg.r1 - rg.r0 + 1) * (rg.c1 - rg.c0 + 1),
      0,
    );
    if (cellsSelected <= 1) return null;
    const seen = new Set<string>();
    const nums: number[] = [];
    let count = 0;
    for (const rg of [rect, ...extraRanges]) {
      for (let r = rg.r0; r <= rg.r1; r++) {
        const data = rows[r];
        if (data === undefined) continue;
        for (let c = rg.c0; c <= rg.c1; c++) {
          const col = visibleColumns[c];
          if (!col) continue;
          const id = `${r}:${col.key}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const v = col.getValue(data);
          if (v !== null && v !== undefined && v !== '') count += 1;
          const n = typeof v === 'number' ? v : parseLocaleNumber(String(v ?? ''), locale);
          if (n !== undefined && Number.isFinite(n)) nums.push(n);
        }
      }
    }
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const n of nums) {
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    return { count, numeric: nums.length, sum, avg: nums.length ? sum / nums.length : 0, min, max };
  }, [rect, extraRanges, rows, visibleColumns, locale]);

  const cellEditable = useCallback(
    (rowIdx: number, col: GridColumn<Row> | undefined): boolean => {
      if (!col) return false;
      const row = rows[rowIdx];
      if (row === undefined) return false;
      if (col.isEditable) return col.isEditable(row, rowIdx);
      return !!col.editable;
    },
    [rows],
  );

  const displayAt = useCallback(
    (rowIdx: number, col: GridColumn<Row>): string => {
      const row = rows[rowIdx];
      if (row === undefined) return '';
      const value = col.getValue(row);
      return col.format ? col.format(value, row) : String(value ?? '');
    },
    [rows],
  );

  const parseForColumn = useCallback(
    (col: GridColumn<Row>, raw: string, rowIdx: number): unknown => {
      const row = rows[rowIdx];
      if (row !== undefined && col.parse) return col.parse(raw, row);
      // Default coercion by kind.
      if (col.kind === 'number' || col.kind === 'number-nullable') {
        if (raw.trim() === '') return col.kind === 'number-nullable' ? null : undefined;
        return parseLocaleNumber(raw, locale);
      }
      return raw;
    },
    [rows, locale],
  );

  // Parse + validate for bulk paths (paste/fill/move): a rejected value is
  // skipped (undefined), never written. Clears bypass this (always allowed).
  const coerce = useCallback(
    (col: GridColumn<Row>, raw: string, rowIdx: number): unknown => {
      const value = parseForColumn(col, raw, rowIdx);
      if (value === undefined) return undefined;
      const row = rows[rowIdx];
      if (row !== undefined && col.validate && col.validate(value, row)) return undefined;
      return value;
    },
    [parseForColumn, rows],
  );

  // Brief red flash on a cell whose interactive edit was rejected by validate.
  const flashInvalid = useCallback((cell: CellCoord) => {
    setInvalidCell(cell);
    if (invalidTimer.current) window.clearTimeout(invalidTimer.current);
    invalidTimer.current = window.setTimeout(() => setInvalidCell(null), 900);
  }, []);
  useEffect(() => () => { if (invalidTimer.current) window.clearTimeout(invalidTimer.current); }, []);

  // --- Focus movement -------------------------------------------------------
  const moveFocusTo = useCallback(
    (row: number, colIdx: number, extend: boolean) => {
      const key = colKeys[clamp(colIdx, 0, Math.max(0, colCount - 1))];
      if (key === undefined) return;
      const r = clamp(row, 0, Math.max(0, rowCount - 1));
      const cell = { row: r, colKey: key };
      setExtraRanges([]); // keyboard movement collapses a non-contiguous selection
      setSelection((prev) => ({
        anchor: extend ? prev.anchor : cell,
        focus: cell,
        // During an extension the active cell stays put (GS); a plain move
        // collapses the selection onto the new cell.
        active: extend ? prev.active : cell,
      }));
      virtualizer.scrollToIndex(r, { align: 'auto' });
      // The active cell only changes on a plain (collapsing) move.
      if (!extend) onActiveCellChange?.(r, key);
    },
    [colKeys, colCount, rowCount, virtualizer, onActiveCellChange],
  );

  // Google-Sheets Ctrl+Arrow: jump to the edge of the contiguous data block in a
  // direction — skip a gap to the next non-empty cell, or run to the last
  // non-empty cell before a gap / the grid boundary.
  const dataEdgeTarget = useCallback(
    (startRow: number, startColIdx: number, dRow: number, dCol: number) => {
      const vertical = dRow !== 0;
      const count = vertical ? rowCount : colCount;
      const step = vertical ? dRow : dCol;
      const isEmpty = (i: number): boolean => {
        const r = vertical ? i : startRow;
        const ci = vertical ? startColIdx : i;
        const col = colAt(ci);
        const data = rows[r];
        if (!col || data === undefined) return true;
        const v = col.getValue(data);
        return v == null || v === '';
      };
      let i = vertical ? startRow : startColIdx;
      const next = i + step;
      if (next < 0 || next >= count) {
        // already at the boundary — stay put
      } else if (isEmpty(i) || isEmpty(next)) {
        let j = next;
        while (j >= 0 && j < count && isEmpty(j)) j += step;
        i = j < 0 || j >= count ? clamp(j - step, 0, count - 1) : j;
      } else {
        let j = i;
        while (j + step >= 0 && j + step < count && !isEmpty(j + step)) j += step;
        i = j;
      }
      return vertical ? { row: i, colIdx: startColIdx } : { row: startRow, colIdx: i };
    },
    [rowCount, colCount, colAt, rows],
  );

  // --- Editing --------------------------------------------------------------
  const beginEdit = useCallback(
    (rowIdx: number, colIdx: number, seed: string | null) => {
      const col = colAt(colIdx);
      if (!col || !cellEditable(rowIdx, col)) return;
      const draft = seed ?? displayAt(rowIdx, col);
      const cell = { row: rowIdx, colKey: col.key };
      // The edited cell becomes the sole active selection, so the editor and the
      // selection overlay always coincide (e.g. on double-click).
      setExtraRanges([]);
      setSelection({ anchor: cell, focus: cell, active: cell });
      setCopiedRect(null);
      setEditing({ row: rowIdx, colKey: col.key, draft });
    },
    [colAt, cellEditable, displayAt],
  );

  // Commit the editor's draft. Side effects run OUTSIDE setEditing (a state
  // updater must be pure — StrictMode double-invokes it in dev). `refocus`
  // returns keyboard focus to the grid so the type→Enter→Arrow loop keeps
  // working; the blur path passes false so a deliberate click-away isn't trapped.
  const commitEdit = useCallback(
    (advance: 'down' | 'up' | null, refocus = true) => {
      const cur = editing;
      if (!cur) return;
      const colIdx = colIndexOf(cur.colKey);
      const col = colAt(colIdx);
      const value = col ? parseForColumn(col, cur.draft, cur.row) : undefined;
      // Reject an invalid value: flash red, and on a keyboard commit keep the
      // editor open so it can be fixed (blur just discards the invalid draft).
      const row = rows[cur.row];
      if (col && value !== undefined && row !== undefined && col.validate && col.validate(value, row)) {
        flashInvalid({ row: cur.row, colKey: cur.colKey });
        if (refocus) return;
        setEditing(null);
        return;
      }
      setEditing(null);
      if (col && value !== undefined) onEdit(cur.row, cur.colKey, value);
      if (advance) {
        const t = arrowTarget(cur.row, colIdx, advance === 'down' ? 1 : -1, 0, rowCount, colCount);
        moveFocusTo(t.row, t.colIdx, false);
      }
      if (refocus) scrollRef.current?.focus();
    },
    [editing, colIndexOf, colAt, parseForColumn, rows, flashInvalid, onEdit, rowCount, colCount, moveFocusTo],
  );

  const cancelEdit = useCallback(() => {
    setEditing(null);
    scrollRef.current?.focus();
  }, []);

  useEffect(() => {
    if (editing && editorRef.current) {
      const el = editorRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  // Reconcile the selection when the controlled rows/columns change (host hides a
  // column, deletes/filters rows, etc.): clamp rows into range, re-map a dropped
  // column key to a surviving column, and drop transient extra ranges. Keyed on a
  // structural signature so it only runs on real structural changes (not on every
  // render when the host passes a fresh columns array, and not on per-cell edits
  // which keep row count + keys stable). Identity-preserving when already valid.
  const structuralKey = `${rowCount}:${colCount}:${colKeys.join('')}`;
  useEffect(() => {
    setSelection((prev) => {
      const fix = (c: CellCoord): CellCoord => {
        const row = clamp(c.row, 0, Math.max(0, rowCount - 1));
        const colKey = colKeys.includes(c.colKey) ? c.colKey : (colKeys[0] ?? c.colKey);
        return row === c.row && colKey === c.colKey ? c : { row, colKey };
      };
      const anchor = fix(prev.anchor);
      const focus = fix(prev.focus);
      const active = fix(prev.active);
      return anchor === prev.anchor && focus === prev.focus && active === prev.active
        ? prev
        : { anchor, focus, active };
    });
    setExtraRanges((prev) => (prev.length ? [] : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- structuralKey gates re-runs
  }, [structuralKey]);

  // --- Clipboard ------------------------------------------------------------
  const buildRangeMatrix = useCallback((): string[][] => {
    const out: string[][] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const line: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        const col = colAt(c);
        line.push(col ? displayAt(r, col) : '');
      }
      out.push(line);
    }
    return out;
  }, [rect, colAt, displayAt]);

  const doCopy = useCallback(async () => {
    setCopiedRect(rect); // marching-ants until paste / Esc / edit
    try {
      await navigator.clipboard.writeText(serializeRangeToTSV(buildRangeMatrix()));
    } catch {
      /* clipboard may be unavailable in the webview; integration adds a fallback */
    }
  }, [buildRangeMatrix, rect]);

  const applyEdits = useCallback(
    (edits: CellEdit[]) => {
      if (edits.length === 0) return;
      if (edits.length === 1 && edits[0]) {
        onEdit(edits[0].row, edits[0].colKey, edits[0].value);
      } else if (onBatchEdit) {
        onBatchEdit(edits);
      } else {
        for (const e of edits) onEdit(e.row, e.colKey, e.value);
      }
    },
    [onEdit, onBatchEdit],
  );

  const doPaste = useCallback(async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    const clip = parseTSV(text);
    const { targets, clipped } = placePaste(clip, rect, rowCount, colCount);
    const edits: CellEdit[] = [];
    for (const t of targets) {
      const col = colAt(t.colIdx);
      if (!col || !cellEditable(t.row, col)) continue;
      const value = coerce(col, t.raw, t.row);
      if (value !== undefined) edits.push({ row: t.row, colKey: col.key, value });
    }
    applyEdits(edits);
    setCopiedRect(null);
    // Surface what the paste couldn't fully apply (out-of-bounds vs read-only/
    // unparseable), so the host can show a notice rather than silently dropping.
    if (clipped > 0 || edits.length < targets.length) {
      onPasteReport?.({ written: edits.length, clipped, skipped: targets.length - edits.length });
    }
  }, [rect, rowCount, colCount, colAt, cellEditable, coerce, applyEdits, onPasteReport]);

  // Copy-fill the selection block across `preview`'s extension (tiled).
  const commitFill = useCallback(
    (preview: Rect) => {
      const parseNum = (s: string) => parseLocaleNumber(s, locale);
      const edits: CellEdit[] = [];
      const vertical = preview.r1 > rect.r1 || preview.r0 < rect.r0;
      if (vertical) {
        const below = preview.r1 > rect.r1;
        // Extension rows in fill order (away from the source).
        const extRows: number[] = below
          ? Array.from({ length: preview.r1 - rect.r1 }, (_, i) => rect.r1 + 1 + i)
          : Array.from({ length: rect.r0 - preview.r0 }, (_, i) => rect.r0 - 1 - i);
        for (let c = rect.c0; c <= rect.c1; c++) {
          const col = colAt(c);
          if (!col) continue;
          const seed: string[] = [];
          for (let r = rect.r0; r <= rect.r1; r++) seed.push(displayAt(r, col));
          const vals = extendSeries(below ? seed : [...seed].reverse(), extRows.length, parseNum);
          extRows.forEach((r, i) => {
            if (!cellEditable(r, col)) return;
            const value = coerce(col, vals[i] ?? '', r);
            if (value !== undefined) edits.push({ row: r, colKey: col.key, value });
          });
        }
      } else {
        const right = preview.c1 > rect.c1;
        const extCols: number[] = right
          ? Array.from({ length: preview.c1 - rect.c1 }, (_, i) => rect.c1 + 1 + i)
          : Array.from({ length: rect.c0 - preview.c0 }, (_, i) => rect.c0 - 1 - i);
        for (let r = rect.r0; r <= rect.r1; r++) {
          const seed: string[] = [];
          for (let c = rect.c0; c <= rect.c1; c++) {
            const sc = colAt(c);
            seed.push(sc ? displayAt(r, sc) : '');
          }
          const vals = extendSeries(right ? seed : [...seed].reverse(), extCols.length, parseNum);
          extCols.forEach((c, i) => {
            const col = colAt(c);
            if (!col || !cellEditable(r, col)) return;
            const value = coerce(col, vals[i] ?? '', r);
            if (value !== undefined) edits.push({ row: r, colKey: col.key, value });
          });
        }
      }
      applyEdits(edits);
      const a = colKeys[preview.c0];
      const f = colKeys[preview.c1];
      if (a !== undefined && f !== undefined) {
        setSelection({
          anchor: { row: preview.r0, colKey: a },
          focus: { row: preview.r1, colKey: f },
          active: { row: preview.r0, colKey: a },
        });
      }
    },
    [rect, colAt, cellEditable, coerce, displayAt, applyEdits, colKeys, locale],
  );

  const doFill = useCallback(
    (down: boolean) => {
      const edits: CellEdit[] = [];
      for (const f of fillTargets(rect, down)) {
        const col = colAt(f.colIdx);
        const srcCol = colAt(f.srcColIdx);
        if (!col || !srcCol || !cellEditable(f.row, col)) continue;
        const raw = displayAt(f.srcRow, srcCol);
        const value = coerce(col, raw, f.row);
        if (value !== undefined) edits.push({ row: f.row, colKey: col.key, value });
      }
      applyEdits(edits);
    },
    [rect, colAt, cellEditable, displayAt, coerce, applyEdits],
  );

  const doClear = useCallback(() => {
    const edits: CellEdit[] = [];
    const seen = new Set<string>();
    for (const rg of [rect, ...extraRanges]) {
      for (let r = rg.r0; r <= rg.r1; r++) {
        for (let c = rg.c0; c <= rg.c1; c++) {
          const col = colAt(c);
          if (!col || !cellEditable(r, col)) continue;
          const id = `${r}:${col.key}`;
          if (seen.has(id)) continue;
          // Route through the column's coercion: number → undefined (skip, never
          // write 0), number-nullable → null, text/custom-parse → its empty value.
          const value = parseForColumn(col, '', r);
          if (value === undefined) continue;
          seen.add(id);
          edits.push({ row: r, colKey: col.key, value });
        }
      }
    }
    applyEdits(edits);
  }, [rect, extraRanges, colAt, cellEditable, parseForColumn, applyEdits]);

  // --- Keyboard -------------------------------------------------------------
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editing) {
        // Editing mode: most keys belong to the editor; handle commit/cancel.
        if (e.key === 'Enter') {
          e.preventDefault();
          commitEdit(e.shiftKey ? 'up' : 'down');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const t = tabTarget(editing.row, colIndexOf(editing.colKey), e.shiftKey ? -1 : 1, writableColIdxs, rowCount);
          commitEdit(null);
          if (t) moveFocusTo(t.row, t.colIdx, false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        }
        return;
      }

      // Most operations originate at the ACTIVE cell; only shift-extension moves
      // the FOCUS (the opposite corner).
      const row = selection.active.row;
      const colIdx = colIndexOf(selection.active.colKey);
      const fRow = selection.focus.row;
      const fColIdx = focusColIdx;
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+Space → select the active cell's column; Shift+Space → its row.
      if (e.key === ' ' && ctrl) {
        e.preventDefault();
        const key = colKeys[colIdx];
        if (key !== undefined && rowCount > 0) {
          setSelection((prev) => ({
            anchor: { row: 0, colKey: key },
            focus: { row: rowCount - 1, colKey: key },
            active: prev.active,
          }));
        }
        return;
      }
      if (e.key === ' ' && e.shiftKey) {
        e.preventDefault();
        const firstKey = colKeys[0];
        const lastKey = colKeys[colCount - 1];
        if (firstKey !== undefined && lastKey !== undefined) {
          setSelection((prev) => ({
            anchor: { row: prev.active.row, colKey: firstKey },
            focus: { row: prev.active.row, colKey: lastKey },
            active: prev.active,
          }));
        }
        return;
      }

      // Clipboard / fill / select-all
      if (ctrl && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); void doCopy(); return; }
      if (ctrl && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); void doCopy(); doClear(); return; }
      if (ctrl && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); void doPaste(); return; }
      if (ctrl && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); doFill(true); return; }
      if (ctrl && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); doFill(false); return; }
      if (ctrl && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        // Two-stage (Google Sheets): first Ctrl+A selects the contiguous data
        // region around the active cell, the second expands to the whole grid.
        const ai = colIndexOf(selection.active.colKey);
        const region = {
          r0: dataEdgeTarget(selection.active.row, ai, -1, 0).row,
          r1: dataEdgeTarget(selection.active.row, ai, 1, 0).row,
          c0: dataEdgeTarget(selection.active.row, ai, 0, -1).colIdx,
          c1: dataEdgeTarget(selection.active.row, ai, 0, 1).colIdx,
        };
        const all = { r0: 0, r1: rowCount - 1, c0: 0, c1: colCount - 1 };
        const isAll = rect.r0 === 0 && rect.r1 === rowCount - 1 && rect.c0 === 0 && rect.c1 === colCount - 1;
        const isRegion = rect.r0 === region.r0 && rect.r1 === region.r1 && rect.c0 === region.c0 && rect.c1 === region.c1;
        const target = isAll || isRegion ? all : region;
        const ak = colKeys[target.c0];
        const fk = colKeys[target.c1];
        if (ak !== undefined && fk !== undefined) {
          setExtraRanges([]);
          setSelection((prev) => ({
            anchor: { row: target.r0, colKey: ak },
            focus: { row: target.r1, colKey: fk },
            active: prev.active,
          }));
        }
        return;
      }

      // Shift-extension moves the focus corner; a plain move starts at active.
      const oR = e.shiftKey ? fRow : row;
      const oC = e.shiftKey ? fColIdx : colIdx;
      // Move the active cell WITHIN a multi-cell selection (Tab/Enter cycling).
      const cycle = (horizontal: boolean) => {
        setExtraRanges([]); // cycling traverses the live rect only
        const n = cycleActiveInRect(rect, row, colIdx, horizontal, e.shiftKey);
        const key = colKeys[n.colIdx];
        if (key === undefined) return;
        setSelection((prev) => ({ ...prev, active: { row: n.row, colKey: key } }));
        virtualizer.scrollToIndex(n.row, { align: 'auto' });
        onActiveCellChange?.(n.row, key);
      };

      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); { const t = ctrl ? dataEdgeTarget(oR, oC, 1, 0) : arrowTarget(oR, oC, 1, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowUp': e.preventDefault(); { const t = ctrl ? dataEdgeTarget(oR, oC, -1, 0) : arrowTarget(oR, oC, -1, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowRight': e.preventDefault(); { const t = ctrl ? dataEdgeTarget(oR, oC, 0, 1) : arrowTarget(oR, oC, 0, 1, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowLeft': e.preventDefault(); { const t = ctrl ? dataEdgeTarget(oR, oC, 0, -1) : arrowTarget(oR, oC, 0, -1, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'Home': e.preventDefault(); moveFocusTo(ctrl ? 0 : oR, 0, e.shiftKey); return;
        case 'End': e.preventDefault(); moveFocusTo(ctrl ? rowCount - 1 : oR, colCount - 1, e.shiftKey); return;
        case 'PageDown': e.preventDefault(); { const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1); const t = arrowTarget(oR, oC, page, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'PageUp': e.preventDefault(); { const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1); const t = arrowTarget(oR, oC, -page, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'Tab': {
          e.preventDefault();
          if (!rectIsSingleCell(rect)) { cycle(true); return; }
          const t = tabTarget(row, colIdx, e.shiftKey ? -1 : 1, writableColIdxs, rowCount);
          if (t) moveFocusTo(t.row, t.colIdx, false);
          return;
        }
        case 'Enter': {
          e.preventDefault();
          if (!rectIsSingleCell(rect)) { cycle(false); return; }
          // GS: Enter on a single cell moves down (Shift+Enter up); F2/typing edits.
          const t = arrowTarget(row, colIdx, e.shiftKey ? -1 : 1, 0, rowCount, colCount);
          moveFocusTo(t.row, t.colIdx, false);
          return;
        }
        case 'F2': e.preventDefault(); beginEdit(row, colIdx, null); return;
        case 'Delete':
        case 'Backspace': e.preventDefault(); doClear(); return;
        case 'Escape': setCopiedRect(null); return;
        default:
          // Type-to-edit: a printable character starts an edit seeded with it.
          if (!ctrl && !e.altKey && PRINTABLE.test(e.key) && !e.nativeEvent.isComposing) {
            const col = colAt(colIdx);
            if (col && cellEditable(row, col)) {
              e.preventDefault();
              beginEdit(row, colIdx, e.key);
            }
          }
      }
    },
    [
      editing, selection.focus.row, focusColIdx, colKeys, colCount, rowCount, height,
      writableColIdxs, colIndexOf, moveFocusTo, dataEdgeTarget, beginEdit, commitEdit, cancelEdit,
      doCopy, doPaste, doFill, doClear, colAt, cellEditable,
      rect, selection.active, onActiveCellChange, virtualizer,
    ],
  );

  // --- Mouse selection + fill-handle drag ----------------------------------
  const onCellMouseDown = useCallback(
    (rowIdx: number, colIdx: number, e: ReactMouseEvent) => {
      if (e.button !== 0) return; // right-click is owned by onCellContextMenu
      const key = colKeys[colIdx];
      if (key === undefined) return;
      e.preventDefault(); // suppress native text selection; the grid owns selection
      scrollRef.current?.focus(); // receive keyboard after a click
      const cell = { row: rowIdx, colKey: key };
      const ctrl = e.ctrlKey || e.metaKey;
      // Arm drag-select only after the pointer moves past a threshold, so a plain
      // click with a few px of drift doesn't "brush" into a 2-cell selection.
      pendingDrag.current = { x: e.clientX, y: e.clientY };
      setInteracting(true);
      setCopiedRect(null);
      if (ctrl && !e.shiftKey) {
        // Non-contiguous: bank the current range and start a new one here.
        setExtraRanges((prev) => [...prev, rect]);
        setSelection({ anchor: cell, focus: cell, active: cell });
      } else {
        if (!e.shiftKey) setExtraRanges([]); // a fresh selection drops extra ranges
        setSelection((prev) =>
          e.shiftKey
            ? { anchor: prev.anchor, focus: cell, active: prev.active }
            : { anchor: cell, focus: cell, active: cell },
        );
      }
      onActiveCellChange?.(rowIdx, key);
    },
    [colKeys, rect, onActiveCellChange],
  );

  const onFillHandleDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      fillDragging.current = true;
      setInteracting(true);
      setFillPreview(rect);
    },
    [rect],
  );

  const onCellMouseEnter = useCallback(
    (rowIdx: number, colIdx: number) => {
      if (fillDragging.current) {
        // Extend the fill preview from the selection toward the entered cell,
        // along the dominant axis (Google-Sheets behaviour).
        const vMax = Math.max(rowIdx - rect.r1, rect.r0 - rowIdx, 0);
        const hMax = Math.max(colIdx - rect.c1, rect.c0 - colIdx, 0);
        if (vMax === 0 && hMax === 0) setFillPreview(rect);
        else if (vMax >= hMax)
          setFillPreview({ r0: Math.min(rect.r0, rowIdx), r1: Math.max(rect.r1, rowIdx), c0: rect.c0, c1: rect.c1 });
        else
          setFillPreview({ r0: rect.r0, r1: rect.r1, c0: Math.min(rect.c0, colIdx), c1: Math.max(rect.c1, colIdx) });
        return;
      }
      if (!dragging.current) return;
      const key = colKeys[colIdx];
      if (key === undefined) return;
      setSelection((prev) => ({ anchor: prev.anchor, focus: { row: rowIdx, colKey: key }, active: prev.active }));
    },
    [colKeys, rect],
  );

  const startResize = useCallback((e: ReactMouseEvent, key: string, startW: number) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = { key, startX: e.clientX, startW };
    setInteracting(true);
  }, []);

  const selectColumnRange = useCallback(
    (anchorColIdx: number, focusColIdx: number) => {
      const ak = colKeys[clamp(anchorColIdx, 0, colCount - 1)];
      const fk = colKeys[clamp(focusColIdx, 0, colCount - 1)];
      if (ak === undefined || fk === undefined || rowCount === 0) return;
      setCopiedRect(null);
      setExtraRanges([]);
      setSelection({
        anchor: { row: 0, colKey: ak },
        focus: { row: rowCount - 1, colKey: fk },
        active: { row: 0, colKey: ak },
      });
    },
    [colKeys, colCount, rowCount],
  );

  const onHeaderMouseDown = useCallback(
    (colIdx: number, e: ReactMouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      scrollRef.current?.focus();
      const isFullCol = rect.r0 === 0 && rect.r1 === rowCount - 1;
      const inSel = isFullCol && colIdx >= rect.c0 && colIdx <= rect.c1;
      if (inSel && onColumnOrderChange && !e.shiftKey) {
        // The column is already selected → start a MOVE of the selected block.
        colDrag.current = { mode: 'move', anchorCol: colIdx, fromC0: rect.c0, fromC1: rect.c1 };
        setInteracting(true);
        setGrabbing(true);
      } else {
        // Otherwise select this column; dragging across headers extends it.
        const anchorCol = e.shiftKey ? colIndexOf(selection.anchor.colKey) : colIdx;
        colDrag.current = { mode: 'select', anchorCol, fromC0: 0, fromC1: 0 };
        setInteracting(true);
        selectColumnRange(anchorCol, colIdx);
      }
    },
    [rect, rowCount, onColumnOrderChange, colIndexOf, selection.anchor.colKey, selectColumnRange],
  );

  const onHeaderMouseEnter = useCallback(
    (colIdx: number) => {
      if (colDrag.current?.mode === 'select') selectColumnRange(colDrag.current.anchorCol, colIdx);
    },
    [selectColumnRange],
  );

  const selectRowRange = useCallback(
    (anchorRow: number, focusRow: number) => {
      const firstKey = colKeys[0];
      const lastKey = colKeys[colCount - 1];
      if (firstKey === undefined || lastKey === undefined) return;
      const a = clamp(anchorRow, 0, rowCount - 1);
      const f = clamp(focusRow, 0, rowCount - 1);
      setCopiedRect(null);
      setExtraRanges([]);
      setSelection({
        anchor: { row: a, colKey: firstKey },
        focus: { row: f, colKey: lastKey },
        active: { row: a, colKey: firstKey },
      });
    },
    [colKeys, colCount, rowCount],
  );

  const onGutterMouseDown = useCallback(
    (rowIdx: number, e: ReactMouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      scrollRef.current?.focus();
      const isFullRow = rect.c0 === 0 && rect.c1 === colCount - 1;
      const inSel = isFullRow && rowIdx >= rect.r0 && rowIdx <= rect.r1;
      if (inSel && onMoveRows && !e.shiftKey) {
        rowDrag.current = { mode: 'move', anchorRow: rowIdx, fromR0: rect.r0, fromR1: rect.r1 };
        setInteracting(true);
        setGrabbing(true);
      } else {
        const anchorRow = e.shiftKey ? selection.anchor.row : rowIdx;
        rowDrag.current = { mode: 'select', anchorRow, fromR0: 0, fromR1: 0 };
        setInteracting(true);
        selectRowRange(anchorRow, rowIdx);
      }
    },
    [rect, colCount, onMoveRows, selection.anchor.row, selectRowRange],
  );

  const onGutterMouseEnter = useCallback(
    (rowIdx: number) => {
      if (rowDrag.current?.mode === 'select') selectRowRange(rowDrag.current.anchorRow, rowIdx);
    },
    [selectRowRange],
  );

  // Apply a row move via the host callback, then keep the moved block selected.
  const reorderRows = useCallback(
    (fromR0: number, fromR1: number, dropIdx: number) => {
      if (!onMoveRows) return;
      const n = fromR1 - fromR0 + 1;
      onMoveRows(fromR0, fromR1, dropIdx);
      let insertAt = dropIdx;
      if (dropIdx > fromR1) insertAt = dropIdx - n;
      else if (dropIdx > fromR0) insertAt = fromR0;
      insertAt = clamp(insertAt, 0, Math.max(0, rowCount - n));
      const firstKey = colKeys[0];
      const lastKey = colKeys[colCount - 1];
      if (firstKey !== undefined && lastKey !== undefined) {
        setSelection({
          anchor: { row: insertAt, colKey: firstKey },
          focus: { row: insertAt + n - 1, colKey: lastKey },
          active: { row: insertAt, colKey: firstKey },
        });
      }
    },
    [onMoveRows, rowCount, colKeys, colCount],
  );

  // Double-click a resize border → fit the column to its widest VISIBLE content
  // (virtualized, so off-screen rows aren't measured — a pragmatic approximation).
  const autoFitColumn = useCallback((key: string) => {
    const root = scrollRef.current;
    if (!root) return;
    let max = 0;
    const header = root.querySelector(`[data-testid="grid-header-${key}"] span`);
    if (header) max = Math.max(max, (header as HTMLElement).scrollWidth);
    root.querySelectorAll('[data-testid^="grid-cell-"]').forEach((el) => {
      const node = el as HTMLElement;
      if (node.dataset.testid?.endsWith(`-${key}`)) max = Math.max(max, node.scrollWidth);
    });
    if (max > 0) setColWidthOverrides((m) => ({ ...m, [key]: clamp(max + 18, MIN_COL_WIDTH, 600) }));
  }, []);

  // Double-click the fill handle: fill down to the data extent of the left
  // neighbour column (Google-Sheets auto-fill), or the selection's own column.
  const onFillHandleDoubleClick = useCallback(() => {
    const guide = colAt(rect.c0 > 0 ? rect.c0 - 1 : rect.c0);
    if (!guide) return;
    let end = rect.r1;
    for (let r = rect.r1 + 1; r < rowCount; r++) {
      const data = rows[r];
      if (!data) break;
      const v = guide.getValue(data);
      if (v == null || v === '') break;
      end = r;
    }
    if (end > rect.r1) commitFill({ r0: rect.r0, r1: end, c0: rect.c0, c1: rect.c1 });
  }, [colAt, rect, rowCount, rows, commitFill]);

  // Window-level pointer handling: drag-select extension past the viewport
  // (auto-scroll), column resize, and release. Refs keep closures fresh behind
  // stable listeners.
  const extendToRow = useCallback(
    (row: number) => {
      if (fillDragging.current)
        setFillPreview({ r0: Math.min(rect.r0, row), r1: Math.max(rect.r1, row), c0: rect.c0, c1: rect.c1 });
      else setSelection((prev) => ({ anchor: prev.anchor, focus: { row, colKey: prev.focus.colKey }, active: prev.active }));
    },
    [rect],
  );

  // The (row, visible-col) under a viewport point.
  const cellAtClient = useCallback(
    (clientX: number, clientY: number): { row: number; col: number } => {
      const el = scrollRef.current;
      if (!el) return { row: 0, col: 0 };
      const r = el.getBoundingClientRect();
      const yC = clientY - r.top + el.scrollTop - HEADER_HEIGHT;
      const xC = clientX - r.left + el.scrollLeft - GUTTER_WIDTH;
      const row = clamp(Math.floor(yC / ROW_HEIGHT), 0, Math.max(0, rowCount - 1));
      let col = 0;
      for (let i = 0; i < colCount; i++) {
        if (xC >= (offsets[i] ?? 0)) col = i;
        else break;
      }
      return { row, col: clamp(col, 0, Math.max(0, colCount - 1)) };
    },
    [rowCount, colCount, offsets],
  );

  // Cut-and-drop: move the source rect's values to the destination rect (same
  // size, translated), clearing source cells the destination doesn't cover.
  const moveCells = useCallback(
    (src: Rect, dst: Rect) => {
      if (src.r0 === dst.r0 && src.c0 === dst.c0) return;
      const h = src.r1 - src.r0;
      const w = src.c1 - src.c0;
      // Abort the whole move if ANY destination cell is non-writable — otherwise
      // the source-clear below would blank source data with nowhere to land it.
      for (let dr = 0; dr <= h; dr++) {
        for (let dc = 0; dc <= w; dc++) {
          const dCol = colAt(dst.c0 + dc);
          if (!dCol || !cellEditable(dst.r0 + dr, dCol)) return;
        }
      }
      // Snapshot source display values first (src/dst may overlap).
      const vals: string[][] = [];
      for (let dr = 0; dr <= h; dr++) {
        const line: string[] = [];
        for (let dc = 0; dc <= w; dc++) {
          const col = colAt(src.c0 + dc);
          line.push(col ? displayAt(src.r0 + dr, col) : '');
        }
        vals.push(line);
      }
      const edits: CellEdit[] = [];
      const seen = new Set<string>();
      for (let dr = 0; dr <= h; dr++) {
        for (let dc = 0; dc <= w; dc++) {
          const col = colAt(dst.c0 + dc);
          const drow = dst.r0 + dr;
          if (!col || !cellEditable(drow, col)) continue;
          const value = coerce(col, vals[dr]?.[dc] ?? '', drow);
          if (value !== undefined) {
            edits.push({ row: drow, colKey: col.key, value });
            seen.add(`${drow}:${col.key}`);
          }
        }
      }
      // Clear source cells the destination doesn't overwrite.
      const inDst = (r: number, c: number) => r >= dst.r0 && r <= dst.r1 && c >= dst.c0 && c <= dst.c1;
      for (let r = src.r0; r <= src.r1; r++) {
        for (let c = src.c0; c <= src.c1; c++) {
          if (inDst(r, c)) continue;
          const col = colAt(c);
          if (!col || !cellEditable(r, col)) continue;
          if (seen.has(`${r}:${col.key}`)) continue;
          const cleared = parseForColumn(col, '', r);
          if (cleared === undefined) continue;
          edits.push({ row: r, colKey: col.key, value: cleared });
        }
      }
      applyEdits(edits);
      const ak = colKeys[dst.c0];
      const fk = colKeys[dst.c1];
      if (ak !== undefined && fk !== undefined) {
        setExtraRanges([]);
        setSelection({
          anchor: { row: dst.r0, colKey: ak },
          focus: { row: dst.r1, colKey: fk },
          active: { row: dst.r0, colKey: ak },
        });
      }
    },
    [colAt, displayAt, cellEditable, coerce, parseForColumn, applyEdits, colKeys],
  );

  const onMoveBorderDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const c = cellAtClient(e.clientX, e.clientY);
      cellMove.current = { grabRow: c.row, grabCol: c.col, src: rect };
      setInteracting(true);
      setGrabbing(true);
    },
    [cellAtClient, rect],
  );

  const autoScrollTick = useCallback(() => {
    autoScrollRAF.current = 0;
    const el = scrollRef.current;
    if (!el || (!dragging.current && !fillDragging.current)) return;
    const r = el.getBoundingClientRect();
    const topZone = r.top + HEADER_HEIGHT + EDGE_SCROLL_ZONE;
    const botZone = r.bottom - EDGE_SCROLL_ZONE;
    const dir = dragMouseY.current < topZone ? -1 : dragMouseY.current > botZone ? 1 : 0;
    if (dir === 0) return;
    el.scrollTop += dir * 18;
    const y = dir < 0 ? topZone : botZone;
    const idx = Math.floor((el.scrollTop + (y - r.top) - HEADER_HEIGHT) / ROW_HEIGHT);
    extendToRow(clamp(idx, 0, rowCount - 1));
    autoScrollRAF.current = requestAnimationFrame(autoScrollTick);
  }, [extendToRow, rowCount]);

  const onMoveRef = useRef<(e: MouseEvent) => void>(() => {});
  const onUpRef = useRef<() => void>(() => {});
  const cancelDragRef = useRef<() => void>(() => {});
  onMoveRef.current = (e) => {
    // A mouseup we missed (released outside the window) leaves a flag latched; a
    // later buttonless move must abort the drag rather than keep extending.
    const anyDrag =
      dragging.current ||
      fillDragging.current ||
      resizing.current !== null ||
      cellMove.current !== null ||
      colDrag.current !== null ||
      rowDrag.current !== null;
    if (e.buttons === 0 && anyDrag) {
      cancelDragRef.current();
      return;
    }
    if (cellMove.current) {
      const c = cellAtClient(e.clientX, e.clientY);
      const src = cellMove.current.src;
      const h = src.r1 - src.r0;
      const w = src.c1 - src.c0;
      const r0 = clamp(c.row - (cellMove.current.grabRow - src.r0), 0, Math.max(0, rowCount - 1 - h));
      const c0 = clamp(c.col - (cellMove.current.grabCol - src.c0), 0, Math.max(0, colCount - 1 - w));
      setCellMoveDrop({ r0, r1: r0 + h, c0, c1: c0 + w });
      return;
    }
    if (colDrag.current?.mode === 'move') {
      const el = scrollRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const xContent = e.clientX - r.left + el.scrollLeft - GUTTER_WIDTH;
      let idx = 0;
      for (let i = 0; i < colCount; i++) {
        if (xContent > (offsets[i] ?? 0) + (widths[i] ?? 0) / 2) idx = i + 1;
        else break;
      }
      setColMoveDrop({ index: idx, lineX: GUTTER_WIDTH + (offsets[idx] ?? 0) });
      const from = colDrag.current.fromC0;
      setColGhost({
        x: e.clientX,
        y: e.clientY,
        label: visibleColumns[from]?.header ?? colKeys[from] ?? '',
        count: colDrag.current.fromC1 - from + 1,
      });
      return;
    }
    if (rowDrag.current?.mode === 'move') {
      const el = scrollRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const yContent = e.clientY - r.top + el.scrollTop - HEADER_HEIGHT;
      const idx = clamp(Math.floor((yContent + ROW_HEIGHT / 2) / ROW_HEIGHT), 0, rowCount);
      setRowMoveDrop({ index: idx, lineY: HEADER_HEIGHT + idx * ROW_HEIGHT });
      setColGhost({
        x: e.clientX,
        y: e.clientY,
        label: `${rowDrag.current.fromR0 + 1}`,
        count: rowDrag.current.fromR1 - rowDrag.current.fromR0 + 1,
      });
      return;
    }
    if (resizing.current) {
      const { key, startX, startW } = resizing.current;
      setColWidthOverrides((m) => ({ ...m, [key]: Math.max(MIN_COL_WIDTH, startW + (e.clientX - startX)) }));
      return;
    }
    if (pendingDrag.current && !dragging.current) {
      // Promote a pending cell press to a drag-select only past the threshold.
      const p = pendingDrag.current;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 4) return;
      dragging.current = true;
    }
    if (dragging.current || fillDragging.current) {
      dragMouseY.current = e.clientY;
      const el = scrollRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const nearEdge =
          e.clientY < r.top + HEADER_HEIGHT + EDGE_SCROLL_ZONE || e.clientY > r.bottom - EDGE_SCROLL_ZONE;
        if (nearEdge && autoScrollRAF.current === 0) autoScrollRAF.current = requestAnimationFrame(autoScrollTick);
      }
    }
  };
  // Reset all drag flags + transient drag state WITHOUT committing anything.
  const resetDrag = () => {
    colDrag.current = null;
    rowDrag.current = null;
    cellMove.current = null;
    dragging.current = false;
    pendingDrag.current = null;
    fillDragging.current = false;
    resizing.current = null;
    if (autoScrollRAF.current) {
      cancelAnimationFrame(autoScrollRAF.current);
      autoScrollRAF.current = 0;
    }
    setInteracting(false);
    setGrabbing(false);
    setFillPreview(null);
    setColMoveDrop(null);
    setColGhost(null);
    setRowMoveDrop(null);
    setCellMoveDrop(null);
  };
  cancelDragRef.current = resetDrag;
  onUpRef.current = () => {
    if (colDrag.current?.mode === 'move' && colMoveDrop) {
      reorderColumns(colDrag.current.fromC0, colDrag.current.fromC1, colMoveDrop.index);
    }
    if (rowDrag.current?.mode === 'move' && rowMoveDrop) {
      reorderRows(rowDrag.current.fromR0, rowDrag.current.fromR1, rowMoveDrop.index);
    }
    if (cellMove.current && cellMoveDrop) moveCells(cellMove.current.src, cellMoveDrop);
    if (fillDragging.current && fillPreview) commitFill(fillPreview);
    resetDrag();
  };
  useEffect(() => {
    const mv = (e: MouseEvent) => onMoveRef.current(e);
    const up = () => onUpRef.current();
    const cancel = () => cancelDragRef.current(); // window blur: abort, don't commit
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', cancel);
    };
  }, []);

  const onCellContextMenu = useCallback(
    (rowIdx: number, c: number, e: ReactMouseEvent) => {
      e.preventDefault();
      scrollRef.current?.focus();
      // Right-clicking outside the current selection moves the selection there.
      if (!isInRect(rect, rowIdx, c)) {
        const key = colKeys[c];
        if (key !== undefined) {
          const cell = { row: rowIdx, colKey: key };
          setSelection({ anchor: cell, focus: cell, active: cell });
        }
      }
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [rect, colKeys],
  );

  useEffect(() => {
    if (!ctxMenu) return undefined;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [ctxMenu]);

  // --- Column hide / reorder ------------------------------------------------
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleHidden = useCallback(
    (key: string) => {
      const cur = new Set(hiddenColumns ?? []);
      if (cur.has(key)) cur.delete(key);
      else cur.add(key);
      onHiddenColumnsChange?.([...cur]);
    },
    [hiddenColumns, onHiddenColumnsChange],
  );
  // Move the selected column block [fromC0..fromC1] to insertion index `dropIdx`
  // (a boundary index among visible columns), preserving hidden columns and
  // keeping the moved block selected.
  const reorderColumns = useCallback(
    (fromC0: number, fromC1: number, dropIdx: number) => {
      if (!onColumnOrderChange) return;
      const block = colKeys.slice(fromC0, fromC1 + 1);
      const rest = colKeys.filter((_, i) => i < fromC0 || i > fromC1);
      let insertAt = dropIdx;
      if (dropIdx > fromC1) insertAt = dropIdx - block.length;
      else if (dropIdx > fromC0) insertAt = fromC0; // inside the block → no-op
      insertAt = clamp(insertAt, 0, rest.length);
      const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
      const hidden = (hiddenColumns ?? []).filter((k) => !next.includes(k));
      onColumnOrderChange([...next, ...hidden]);
      const ak = block[0];
      const fk = block[block.length - 1];
      if (ak !== undefined && fk !== undefined && rowCount > 0) {
        setSelection({
          anchor: { row: 0, colKey: ak },
          focus: { row: rowCount - 1, colKey: fk },
          active: { row: 0, colKey: ak },
        });
      }
    },
    [colKeys, hiddenColumns, onColumnOrderChange, rowCount],
  );

  // --- Render ---------------------------------------------------------------
  const virtualRows = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  // Name box: active-cell reference, or selection size while a range is selected.
  const nameBox = multiCell
    ? `${rect.r1 - rect.r0 + 1}R × ${rect.c1 - rect.c0 + 1}C`
    : `${columns.find((c) => c.key === selection.active.colKey)?.header ?? selection.active.colKey} ${selection.active.row + 1}`;

  const overlayStyle: CSSProperties = {
    position: 'absolute',
    // The overlay lives INSIDE the rows-area (which starts below the sticky
    // header), where row 0 is at y=0 — so no header offset here.
    top: rect.r0 * ROW_HEIGHT,
    left: GUTTER_WIDTH + (offsets[rect.c0] ?? 0),
    width: (offsets[rect.c1 + 1] ?? 0) - (offsets[rect.c0] ?? 0),
    height: (rect.r1 - rect.r0 + 1) * ROW_HEIGHT,
    border: '2px solid var(--sg-blue)',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: 3,
  };

  const rectOverlay = (r: Rect): CSSProperties => ({
    position: 'absolute',
    top: r.r0 * ROW_HEIGHT,
    left: GUTTER_WIDTH + (offsets[r.c0] ?? 0),
    width: (offsets[r.c1 + 1] ?? 0) - (offsets[r.c0] ?? 0),
    height: (r.r1 - r.r0 + 1) * ROW_HEIGHT,
    pointerEvents: 'none',
  });

  return (
    <div
      className={`sg-grid relative flex flex-col ${grabbing ? 'sg-grabbing' : ''} ${maximized ? 'fixed inset-0 z-50 bg-panel' : ''} ${className}`}
      data-testid="spreadsheet-grid"
    >
      <div className="sg-toolbar flex items-center justify-between gap-2 px-2 py-0.5">
        <span className="sg-namebox" data-testid="grid-namebox">{nameBox}</span>
        <div className="flex items-center gap-1">
          {onHiddenColumnsChange && (
            <div className="relative">
              <button
                type="button"
                className="text-xs px-2 py-0.5 rounded hover:bg-accent-10"
                data-testid="data-table-columns-menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                Columns
              </button>
              {menuOpen && (
                <div className="sg-colmenu absolute right-0 top-full z-50 mt-0.5 max-h-64 overflow-auto rounded border p-1 shadow-lg">
                  {columns.map((c) => (
                    <label
                      key={c.key}
                      className="flex items-center gap-2 px-2 py-0.5 text-xs whitespace-nowrap hover:bg-accent-10"
                      data-testid={`col-toggle-${c.key}`}
                    >
                      <input
                        type="checkbox"
                        checked={!(hiddenColumns ?? []).includes(c.key)}
                        onChange={() => toggleHidden(c.key)}
                      />
                      {c.header || c.key}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {onToggleMaximize && (
            <button
              type="button"
              className="text-xs px-2 py-0.5 rounded hover:bg-accent-10"
              data-testid="data-table-maximize"
              onClick={onToggleMaximize}
            >
              {maximized ? 'Restore' : 'Maximize'}
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="relative overflow-auto outline-none flex-1"
        style={{ height: maximized ? undefined : height }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        role="grid"
        aria-multiselectable
        aria-rowcount={rowCount + 1}
        aria-colcount={colCount}
        aria-activedescendant={`sg-cell-${selection.active.row}-${selection.active.colKey}`}
      >
        <div style={{ width: totalWidth, position: 'relative' }}>
          {/* Sticky header */}
          <div
            role="row"
            aria-rowindex={1}
            className={`sg-header-bar sticky top-0 z-10 flex bg-panel ${scrolled ? 'sg-scrolled' : ''}`}
            style={{ height: HEADER_HEIGHT }}
          >
            {/* Frozen top-left corner above the row-number gutter. */}
            <div
              className="sg-corner sticky left-0 z-30 flex items-center justify-center border-b border-r border-white/10 bg-panel"
              style={{ width: GUTTER_WIDTH, minWidth: GUTTER_WIDTH }}
            />
            {visibleColumns.map((c, i) => {
              const fullColSel = rect.r0 === 0 && rect.r1 === rowCount - 1;
              const colSelected = fullColSel && i >= rect.c0 && i <= rect.c1;
              return (
              <div
                key={c.key}
                role="columnheader"
                aria-colindex={i + 1}
                className={`sg-header relative flex items-center border-b border-r border-white/10 px-2 text-xs font-medium text-text-secondary ${
                  i >= rect.c0 && i <= rect.c1 ? 'sg-header-selected text-text-primary' : ''
                } ${i === activeColIdx ? 'sg-header-active' : ''}`}
                style={{
                  width: widths[i],
                  minWidth: widths[i],
                  cursor: colSelected && onColumnOrderChange ? 'grab' : 'pointer',
                }}
                onMouseDown={(e) => onHeaderMouseDown(i, e)}
                onMouseEnter={() => onHeaderMouseEnter(i)}
                data-testid={`grid-header-${c.key}`}
              >
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{c.header}</span>
                {/* Drag this edge to resize the column. */}
                <div
                  className="sg-col-resize"
                  data-testid={`grid-col-resize-${c.key}`}
                  onMouseDown={(e) => startResize(e, c.key, widths[i] ?? DEFAULT_COL_WIDTH)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(c.key); }}
                  onDragStart={(e) => e.preventDefault()}
                />
              </div>
              );
            })}
          </div>

          {/* Rows area */}
          <div role="rowgroup" style={{ height: totalHeight, position: 'relative' }}>
            {virtualRows.map((vr) => {
              const rowIdx = vr.index;
              const row = rows[rowIdx];
              if (row === undefined) return null;
              return (
                <div
                  key={rowKey(row, rowIdx)}
                  role="row"
                  aria-rowindex={rowIdx + 2}
                  className="absolute left-0 flex"
                  style={{ top: vr.start - HEADER_HEIGHT, height: ROW_HEIGHT, width: totalWidth }}
                  data-testid={`grid-row-${rowIdx}`}
                >
                  {/* Frozen row-number gutter; click to select, drag a selected
                      row to move it (mirrors column move). */}
                  <div
                    role="rowheader"
                    className={`sg-gutter sticky left-0 z-20 flex items-center justify-center border-b border-r border-white/10 bg-panel text-text-secondary ${
                      rowIdx >= rect.r0 && rowIdx <= rect.r1 ? 'sg-gutter-selected' : ''
                    } ${rowIdx === selection.active.row ? 'sg-gutter-active' : ''}`}
                    style={{
                      width: GUTTER_WIDTH,
                      minWidth: GUTTER_WIDTH,
                      cursor:
                        onMoveRows && rect.c0 === 0 && rect.c1 === colCount - 1 && rowIdx >= rect.r0 && rowIdx <= rect.r1
                          ? 'grab'
                          : 'pointer',
                    }}
                    data-testid={`grid-gutter-${rowIdx}`}
                    onMouseDown={(e) => onGutterMouseDown(rowIdx, e)}
                    onMouseEnter={() => onGutterMouseEnter(rowIdx)}
                  >
                    {rowIdx + 1}
                  </div>
                  {visibleColumns.map((col, c) => {
                    const inSel =
                      isInRect(rect, rowIdx, c) || extraRanges.some((er) => isInRect(er, rowIdx, c));
                    const isActive = rowIdx === selection.active.row && c === activeColIdx;
                    const isEditingCell = editing?.row === rowIdx && editing.colKey === col.key;
                    const cellText = col.render
                      ? null
                      : col.format
                        ? col.format(col.getValue(row), row)
                        : String(col.getValue(row) ?? '');
                    return (
                      <div
                        key={col.key}
                        id={`sg-cell-${rowIdx}-${col.key}`}
                        role="gridcell"
                        aria-colindex={c + 1}
                        aria-selected={inSel}
                        className={`sg-cell flex items-center overflow-hidden border-b border-r border-white/5 px-2 text-xs ${
                          col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : ''
                        }`}
                        style={{
                          width: widths[c],
                          minWidth: widths[c],
                          // Range fill, but leave the active cell unfilled (GS look).
                          backgroundColor: inSel && !isActive ? 'var(--sg-blue-fill)' : undefined,
                          // Thin ring on the active cell inside a multi-cell range.
                          boxShadow: isActive && multiCell ? 'inset 0 0 0 1px var(--sg-blue)' : undefined,
                        }}
                        data-testid={`grid-cell-${rowIdx}-${col.key}`}
                        data-in-selection={inSel ? 'true' : undefined}
                        data-active-cell={isActive ? 'true' : undefined}
                        onMouseDown={(e) => onCellMouseDown(rowIdx, c, e)}
                        onMouseEnter={() => onCellMouseEnter(rowIdx, c)}
                        onContextMenu={(e) => onCellContextMenu(rowIdx, c, e)}
                        onDoubleClick={(e) => { e.stopPropagation(); beginEdit(rowIdx, c, null); }}
                      >
                        {/* Content always renders; the editor (below) overlays the
                            active cell when editing so it fills the whole cell.
                            Plain text truncates with an ellipsis + tooltip. */}
                        {!isEditingCell &&
                          (col.render ? (
                            col.render(row, rowIdx)
                          ) : (
                            <span className="sg-cell-text" title={cellText || undefined}>
                              {cellText}
                            </span>
                          ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {/* Marching-ants for a copied / cut range. */}
            {copiedRect && (
              <div
                className="sg-marching-ants"
                data-testid="grid-copy-marquee"
                style={{ ...rectOverlay(copiedRect), zIndex: 3 }}
              />
            )}

            {/* Fill-drag preview. */}
            {fillPreview && (
              <div className="sg-fill-preview" style={{ ...rectOverlay(fillPreview), zIndex: 4 }} />
            )}

            {/* Cut-and-drop move target outline. */}
            {cellMoveDrop && (
              <div
                className="sg-move-target"
                data-testid="grid-move-target"
                style={{ ...rectOverlay(cellMoveDrop), zIndex: 5 }}
              />
            )}

            {/* Border for each non-contiguous (Ctrl+click) extra range. */}
            {extraRanges.map((er, i) => (
              <div
                key={`xr-${i}`}
                style={{ ...rectOverlay(er), border: '2px solid var(--sg-blue)', boxSizing: 'border-box', zIndex: 3 }}
                data-testid={`grid-extra-range-${i}`}
              />
            ))}

            {/* Selection rectangle overlay (survives row virtualization). */}
            {rowCount > 0 && colCount > 0 && (
              <div
                className={`sg-selection-overlay ${interacting ? 'sg-no-anim' : ''}`}
                style={overlayStyle}
                data-testid="grid-selection-overlay"
                data-rect={`${rect.r0},${rect.c0},${rect.r1},${rect.c1}`}
              >
                {/* Grab any edge (not the interior) to move the cells. */}
                {!editing && onBatchEdit && (
                  <>
                    <div className="sg-move-edge" style={{ top: -3, left: 0, right: 0, height: 6 }} onMouseDown={onMoveBorderDown} />
                    <div className="sg-move-edge" style={{ bottom: -3, left: 0, right: 0, height: 6 }} onMouseDown={onMoveBorderDown} />
                    <div className="sg-move-edge" style={{ top: 0, bottom: 0, left: -3, width: 6 }} onMouseDown={onMoveBorderDown} />
                    <div className="sg-move-edge" style={{ top: 0, bottom: 0, right: -3, width: 6 }} onMouseDown={onMoveBorderDown} />
                  </>
                )}
                {!editing && (
                  <div
                    className="sg-fill-handle"
                    data-testid="grid-fill-handle"
                    onMouseDown={onFillHandleDown}
                    onDoubleClick={onFillHandleDoubleClick}
                  />
                )}
              </div>
            )}

            {/* Cell editor — overlays the active cell so it fills the whole cell
                and sits above the selection overlay. */}
            {editing && colIndexOf(editing.colKey) >= 0 && (
              <textarea
                ref={editorRef}
                data-testid="grid-cell-editor"
                aria-label={`Edit ${columns.find((c) => c.key === editing.colKey)?.header ?? editing.colKey} row ${editing.row + 1}`}
                className="sg-editor"
                style={{
                  ...rectOverlay({
                    r0: editing.row,
                    r1: editing.row,
                    c0: colIndexOf(editing.colKey),
                    c1: colIndexOf(editing.colKey),
                  }),
                  pointerEvents: 'auto',
                  zIndex: 20,
                }}
                value={editing.draft}
                onChange={(ev) => setEditing({ ...editing, draft: ev.target.value })}
                onBlur={() => commitEdit(null, false)}
                onKeyDown={(ev) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) ev.stopPropagation();
                }}
              />
            )}

            {/* Rejected-edit flash (validate returned an error). Above the editor. */}
            {invalidCell && colIndexOf(invalidCell.colKey) >= 0 && (
              <div
                className="sg-invalid-flash"
                data-testid="grid-invalid-flash"
                style={{
                  ...rectOverlay({
                    r0: invalidCell.row,
                    r1: invalidCell.row,
                    c0: colIndexOf(invalidCell.colKey),
                    c1: colIndexOf(invalidCell.colKey),
                  }),
                  zIndex: 25,
                }}
              />
            )}
          </div>

          {/* Column-move drop indicator (spans header + body, scrolls with content). */}
          {colMoveDrop && (
            <div
              className="sg-drop-line"
              style={{
                position: 'absolute',
                top: 0,
                left: colMoveDrop.lineX,
                width: 2,
                height: HEADER_HEIGHT + totalHeight,
                zIndex: 40,
                pointerEvents: 'none',
              }}
            />
          )}

          {/* Row-move drop indicator (spans the full width). */}
          {rowMoveDrop && (
            <div
              className="sg-drop-line"
              style={{
                position: 'absolute',
                left: 0,
                top: rowMoveDrop.lineY,
                height: 2,
                width: totalWidth,
                zIndex: 40,
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      </div>

      {/* Selection summary (Google-Sheets-style), shown when >1 cell is selected. */}
      {selectionStats && (
        <div className="sg-statusbar" data-testid="grid-statusbar">
          {selectionStats.numeric > 0 && (
            <>
              <span>Sum: {fmtStat(selectionStats.sum, locale)}</span>
              <span>Avg: {fmtStat(selectionStats.avg, locale)}</span>
              <span>Min: {fmtStat(selectionStats.min, locale)}</span>
              <span>Max: {fmtStat(selectionStats.max, locale)}</span>
            </>
          )}
          <span>Count: {selectionStats.count}</span>
        </div>
      )}

      {/* Floating "ghost" of the column(s) being moved. */}
      {colGhost && (
        <div
          className="sg-col-ghost"
          style={{ position: 'fixed', left: colGhost.x + 12, top: colGhost.y + 12, zIndex: 70 }}
        >
          {colGhost.label}
          {colGhost.count > 1 ? ` +${colGhost.count - 1}` : ''}
        </div>
      )}

      {ctxMenu && (
        <div
          className="sg-context-menu"
          data-testid="grid-context-menu"
          style={{ position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 60 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => { void doCopy(); setCtxMenu(null); }}>Copy<span className="sg-shortcut">Ctrl+C</span></button>
          <button type="button" onClick={() => { void doCopy(); doClear(); setCtxMenu(null); }}>Cut<span className="sg-shortcut">Ctrl+X</span></button>
          <button type="button" onClick={() => { void doPaste(); setCtxMenu(null); }}>Paste<span className="sg-shortcut">Ctrl+V</span></button>
          {(onInsertRows || onDeleteRows) && <div className="sg-context-sep" />}
          {onInsertRows && (
            <button type="button" onClick={() => { onInsertRows(rect.r0, rect.r1 - rect.r0 + 1); setCtxMenu(null); }}>
              {`Insert ${rect.r1 - rect.r0 + 1} row${rect.r1 > rect.r0 ? 's' : ''} above`}
            </button>
          )}
          {onInsertRows && (
            <button type="button" onClick={() => { onInsertRows(rect.r1 + 1, rect.r1 - rect.r0 + 1); setCtxMenu(null); }}>
              {`Insert ${rect.r1 - rect.r0 + 1} row${rect.r1 > rect.r0 ? 's' : ''} below`}
            </button>
          )}
          {onDeleteRows && (
            <button type="button" onClick={() => { onDeleteRows(rect.r0, rect.r1); setCtxMenu(null); }}>
              {`Delete ${rect.r1 - rect.r0 + 1} row${rect.r1 > rect.r0 ? 's' : ''}`}
            </button>
          )}
          <div className="sg-context-sep" />
          <button type="button" onClick={() => { doClear(); setCtxMenu(null); }}>Clear<span className="sg-shortcut">Del</span></button>
          <button type="button" onClick={() => { doFill(true); setCtxMenu(null); }}>Fill down<span className="sg-shortcut">Ctrl+D</span></button>
        </div>
      )}
    </div>
  );
}

function isColWritable<Row>(c: GridColumn<Row>): boolean {
  return !!(c.editable || c.isEditable);
}

function fmtStat(n: number, locale: string): string {
  return n.toLocaleString(locale, { maximumFractionDigits: 3 });
}
