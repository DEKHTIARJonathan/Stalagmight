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
  /** Fired with the row index under the pointer (null on leave) — for host-level
   *  hover effects (e.g. highlighting the corresponding map feature). */
  onRowHover?: (rowIndex: number | null) => void;
  /** When set, scroll this data-row index into view (e.g. an external selection
   *  from the map). Re-scrolls whenever the value changes. */
  scrollToRow?: number | null;
  /** External row selection: when this CHANGES to an in-range row index, the
   *  grid moves its selection/active cell to that row (keeping the active
   *  column). Internal navigation never writes back through this prop, so it
   *  can't loop with {@link onActiveCellChange}. */
  selectedRow?: number | null;
  /** Row index to tint with `sg-row-hover` (e.g. hovering the matching map
   *  feature). Purely visual; never affects selection. */
  hoveredRow?: number | null;
  /** Extra class for a row element (e.g. a frozen-row tint). */
  rowClassName?: (row: Row, rowIndex: number) => string | undefined;

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
  /** The draft as seeded from the model — committing an unchanged draft is a
   *  no-op (never rewrite stored data with a re-parsed display value). */
  initial: string;
}

const PRINTABLE = /^.$/u;

/** Full-precision, group-free, locale-decimal string for editing/converting —
 *  must round-trip through parseLocaleNumber. */
const formatEditValue = (value: unknown, locale: string): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 12 }).format(value)
    : String(value ?? '');

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
    onRowHover,
    scrollToRow,
    selectedRow,
    hoveredRow,
    rowClassName,
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
  const [copiedRect, setCopiedRect] = useState<Rect | null>(null);
  // A pending cut: the source range is cleared when its content is PASTED
  // (Excel semantics), so Esc cancels a cut without losing data.
  const [cutRect, setCutRect] = useState<Rect | null>(null);
  // Raw values of the last copy, so an internal paste keeps full numeric
  // precision (the clipboard TSV is display-formatted). Used only when the
  // clipboard text still matches `text`.
  const copyStash = useRef<{ text: string; values: unknown[][]; colKeys: string[] } | null>(null);
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

  // Google-Sheets-style selection summary (Count + Sum/Avg/Min/Max of numerics).
  // Shown when >1 cell is selected.
  const selectionStats = useMemo(() => {
    const cellsSelected = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
    if (cellsSelected <= 1) return null;
    const nums: number[] = [];
    let count = 0;
    for (let r = rect.r0; r <= rect.r1; r++) {
      const data = rows[r];
      if (data === undefined) continue;
      for (let c = rect.c0; c <= rect.c1; c++) {
        const col = visibleColumns[c];
        if (!col) continue;
        const v = col.getValue(data);
        if (v !== null && v !== undefined && v !== '') count += 1;
        const n = typeof v === 'number' ? v : parseLocaleNumber(String(v ?? ''), locale);
        if (n !== undefined && Number.isFinite(n)) nums.push(n);
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
  }, [rect, rows, visibleColumns, locale]);

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

  // Move a RAW value between cells (fill/move/internal paste): same column key
  // → the value transfers as-is (validated against the destination row, empty
  // values routed through the column's own clear semantics); across columns →
  // re-coerce through the destination's parser from a full-precision string.
  // Returns `undefined` to skip the write. Never round-trips display strings.
  const transferValue = useCallback(
    (value: unknown, srcColKey: string, dstCol: GridColumn<Row>, dstRow: number): unknown => {
      if (srcColKey === dstCol.key) {
        if (value === null || value === undefined || value === '') return parseForColumn(dstCol, '', dstRow);
        const row = rows[dstRow];
        if (row !== undefined && dstCol.validate && dstCol.validate(value, row)) return undefined;
        return value;
      }
      return coerce(dstCol, formatEditValue(value, locale), dstRow);
    },
    [parseForColumn, coerce, rows, locale],
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
      const row = rows[rowIdx];
      // Seed with the FULL-PRECISION value (not the rounded display string), so
      // open+commit can never silently rewrite stored data at display precision.
      const initial = row === undefined ? '' : formatEditValue(col.getValue(row), locale);
      const cell = { row: rowIdx, colKey: col.key };
      // The edited cell becomes the sole active selection, so the editor and the
      // selection overlay always coincide (e.g. on double-click).
      setSelection({ anchor: cell, focus: cell, active: cell });
      setCopiedRect(null);
      setCutRect(null);
      suppressBlurCommitRef.current = false; // a stale flag must not eat this session's blur-commit
      setEditing({ row: rowIdx, colKey: col.key, draft: seed ?? initial, initial });
    },
    [colAt, cellEditable, rows, locale],
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
      // An untouched draft just closes the editor — no edit, no undo entry.
      const dirty = cur.draft !== cur.initial;
      const value = dirty && col ? parseForColumn(col, cur.draft, cur.row) : undefined;
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
      if (refocus) {
        // This refocus blurs the still-mounted textarea synchronously; without
        // the flag its onBlur would re-enter commitEdit via a stale closure and
        // fire onEdit a second time.
        suppressBlurCommitRef.current = true;
        scrollRef.current?.focus({ preventScroll: true });
      }
    },
    [editing, colIndexOf, colAt, parseForColumn, rows, flashInvalid, onEdit, rowCount, colCount, moveFocusTo],
  );

  // Refocusing the scroller (from commitEdit or cancelEdit) blurs the still-
  // mounted textarea synchronously, and its onBlur would otherwise commit the
  // draft — a double commit after Enter/Tab, or a commit of the dirty draft
  // Escape just discarded. The flag tells that one blur to skip the commit. It
  // is cleared by the blur handler itself (one-shot) and defensively on the
  // next beginEdit, in case an editor unmounts without ever blurring.
  const suppressBlurCommitRef = useRef(false);
  const cancelEdit = useCallback(() => {
    suppressBlurCommitRef.current = true;
    setEditing(null);
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  // Focus + caret-to-end when the editor OPENS (keyed on the cell, not the
  // editing object — draft keystrokes must not snap the caret back to the end).
  const editingCellId = editing ? `${editing.row}:${editing.colKey}` : null;
  useEffect(() => {
    if (editingCellId && editorRef.current) {
      const el = editorRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editingCellId]);

  // Reconcile the selection when the controlled rows/columns change (host hides a
  // column, deletes/filters rows, etc.): clamp rows into range, re-map a dropped
  // column key to a surviving column, and drop stale copy/cut state (its row
  // indices no longer mean what they did). Keyed on a structural signature so it
  // only runs on real structural changes (not on every render when the host
  // passes a fresh columns array, and not on per-cell edits which keep row count
  // + keys stable). Identity-preserving when already valid.
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
    setCopiedRect(null);
    setCutRect(null);
    copyStash.current = null;
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

  const doCopy = useCallback(async (): Promise<boolean> => {
    const text = serializeRangeToTSV(buildRangeMatrix());
    // Stash the RAW values alongside the display-formatted clipboard text, so a
    // paste back into the grid keeps full numeric precision. The stash and the
    // marquee are set unconditionally (and synchronously, before the clipboard
    // write), so in-grid copy/cut/paste keep working in webviews where async
    // clipboard access is denied — the OS write is best-effort on top.
    const values: unknown[][] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const data = rows[r];
      const line: unknown[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        const col = colAt(c);
        line.push(col && data !== undefined ? col.getValue(data) : undefined);
      }
      values.push(line);
    }
    copyStash.current = { text, values, colKeys: colKeys.slice(rect.c0, rect.c1 + 1) };
    setCopiedRect(rect); // marching-ants until paste / Esc / edit
    setCutRect(null);
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false; // OS clipboard unavailable — informational only
    }
  }, [buildRangeMatrix, rect, rows, colAt, colKeys]);

  // Cut = copy + remember the source; the source clears when the content is
  // PASTED (Excel semantics) so Esc cancels a cut. Nothing is cleared until the
  // paste lands, so it's safe to proceed even when the OS-clipboard write
  // fails — the move then runs entirely on the internal stash.
  const doCut = useCallback(async () => {
    const copied = doCopy(); // stash + marquee are set synchronously
    setCutRect(rect);
    await copied;
  }, [doCopy, rect]);

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

  const pasteText = useCallback(
    (text: string) => {
      if (!text) return;
      const clip = parseTSV(text);
      const { targets, clipped } = placePaste(clip, rect, rowCount, colCount);
      // Clipboard text matching our own last copy → source the stashed RAW
      // values (full fidelity); external data re-parses through each column.
      const stash = copyStash.current;
      const internal = stash !== null && stash.text === text ? stash : null;
      const ch = clip.length;
      const cw = clip.reduce((m, r) => Math.max(m, r.length), 0);
      const single = ch === 1 && cw === 1;
      const edits: CellEdit[] = [];
      // Stash cells (by stash-relative coords) whose value actually produced a
      // destination edit. A cut may only clear sources that LANDED somewhere —
      // a write skipped by cellEditable/coerce/validate must keep its source
      // intact (mirrors `moved` in moveCells).
      const landed = new Set<string>();
      for (const t of targets) {
        const col = colAt(t.colIdx);
        if (!col || !cellEditable(t.row, col)) continue;
        let value: unknown;
        let stashCell: string | null = null;
        if (internal) {
          const si = single ? 0 : (t.row - rect.r0) % ch;
          const sj = single ? 0 : (t.colIdx - rect.c0) % cw;
          const srcKey = internal.colKeys[sj];
          if (srcKey === undefined) {
            value = coerce(col, t.raw, t.row);
          } else {
            value = transferValue(internal.values[si]?.[sj], srcKey, col, t.row);
            stashCell = `${si}:${sj}`;
          }
        } else {
          value = coerce(col, t.raw, t.row);
        }
        if (value !== undefined) {
          edits.push({ row: t.row, colKey: col.key, value });
          if (stashCell !== null) landed.add(stashCell);
        }
      }
      const written = edits.length;
      // Pasting our own CUT range completes the move: clear the clearable cut-
      // source cells the destination doesn't cover, in the SAME batch (one undo).
      if (internal && cutRect) {
        const selH = rect.r1 - rect.r0 + 1;
        const selW = rect.c1 - rect.c0 + 1;
        const tiles = !single && selH % ch === 0 && selW % cw === 0 && (selH > ch || selW > cw);
        const dst: Rect = {
          r0: rect.r0,
          c0: rect.c0,
          r1: rect.r0 + (single || tiles ? selH : ch) - 1,
          c1: rect.c0 + (single || tiles ? selW : cw) - 1,
        };
        for (let r = cutRect.r0; r <= cutRect.r1; r++) {
          for (let c = cutRect.c0; c <= cutRect.c1; c++) {
            if (isInRect(dst, r, c)) continue;
            // The stash was captured from cutRect, so stash-relative coords map
            // 1:1 onto cut-source cells. Only clear a source whose value landed.
            if (!landed.has(`${r - cutRect.r0}:${c - cutRect.c0}`)) continue;
            const col = colAt(c);
            if (!col || !cellEditable(r, col)) continue;
            const cleared = parseForColumn(col, '', r);
            if (cleared === undefined) continue;
            edits.push({ row: r, colKey: col.key, value: cleared });
          }
        }
        copyStash.current = null; // a cut pastes once
      }
      applyEdits(edits);
      setCopiedRect(null);
      setCutRect(null);
      // Surface what the paste couldn't fully apply (out-of-bounds vs read-only/
      // unparseable), so the host can show a notice rather than silently dropping.
      if (clipped > 0 || written < targets.length) {
        onPasteReport?.({ written, clipped, skipped: targets.length - written });
      }
    },
    [rect, rowCount, colCount, colAt, cellEditable, coerce, transferValue, parseForColumn, cutRect, applyEdits, onPasteReport],
  );

  // Context-menu paste: a synthetic (untrusted) `paste` event can't carry
  // clipboard data, so this path tries the async clipboard API, and where
  // reads are denied (e.g. WebKitGTK) falls back to the internal copy stash so
  // in-grid copy/paste still works. When the clipboard IS readable, its text
  // wins — pasteText only uses the stash values when the texts match.
  const doPaste = useCallback(async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = copyStash.current?.text ?? '';
    }
    pasteText(text);
  }, [pasteText]);

  // Keyboard Ctrl/Cmd+V plumbing. The native `paste` event on the container is
  // the PRIMARY path (the only one that works where async clipboard reads are
  // denied), so the keydown handler never calls preventDefault. But some
  // webviews (WebKit) don't dispatch `paste` to non-editable elements at all,
  // so each Ctrl+V also arms a one-shot fallback: if no paste event arrives
  // shortly after the keystroke, read the clipboard — and failing that, paste
  // the internal copy stash.
  const pasteTextRef = useRef(pasteText);
  pasteTextRef.current = pasteText;
  const editingRef = useRef<EditState | null>(editing);
  editingRef.current = editing;
  const lastPasteEventAt = useRef(0); // set by the container's onPaste handler
  const suppressNativePasteUntil = useRef(0); // fallback ran → swallow a late event
  const pasteFallbackTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (pasteFallbackTimer.current) window.clearTimeout(pasteFallbackTimer.current);
    },
    [],
  );
  const schedulePasteFallback = useCallback(() => {
    const pressedAt = Date.now();
    if (pasteFallbackTimer.current) window.clearTimeout(pasteFallbackTimer.current);
    pasteFallbackTimer.current = window.setTimeout(() => {
      pasteFallbackTimer.current = undefined;
      if (editingRef.current) return; // the editor textarea owns its own paste
      if (lastPasteEventAt.current >= pressedAt) return; // native path handled it
      // One paste per keystroke: mark BEFORE the async read so a native paste
      // event racing (or trailing) the fallback can't double-apply.
      suppressNativePasteUntil.current = Date.now() + 400;
      void (async () => {
        let text: string;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          text = copyStash.current?.text ?? '';
        }
        if (text) pasteTextRef.current(text);
      })();
    }, 150);
  }, []);

  // Copy-fill the selection block across `preview`'s extension: tile the RAW
  // source values (modular repeat, fill order away from the source). NO series
  // extrapolation — deliberate for survey data.
  const commitFill = useCallback(
    (preview: Rect) => {
      const edits: CellEdit[] = [];
      const srcH = rect.r1 - rect.r0 + 1;
      const srcW = rect.c1 - rect.c0 + 1;
      const pushEdit = (srcRow: number, srcCol: GridColumn<Row>, dstRow: number, dstCol: GridColumn<Row>) => {
        if (!cellEditable(dstRow, dstCol)) return;
        const data = rows[srcRow];
        if (data === undefined) return;
        const value = transferValue(srcCol.getValue(data), srcCol.key, dstCol, dstRow);
        if (value !== undefined) edits.push({ row: dstRow, colKey: dstCol.key, value });
      };
      const vertical = preview.r1 > rect.r1 || preview.r0 < rect.r0;
      if (vertical) {
        const below = preview.r1 > rect.r1;
        const count = below ? preview.r1 - rect.r1 : rect.r0 - preview.r0;
        for (let c = rect.c0; c <= rect.c1; c++) {
          const col = colAt(c);
          if (!col) continue;
          for (let i = 0; i < count; i++) {
            const dstRow = below ? rect.r1 + 1 + i : rect.r0 - 1 - i;
            const srcRow = below ? rect.r0 + (i % srcH) : rect.r1 - (i % srcH);
            pushEdit(srcRow, col, dstRow, col);
          }
        }
      } else {
        const right = preview.c1 > rect.c1;
        const count = right ? preview.c1 - rect.c1 : rect.c0 - preview.c0;
        for (let r = rect.r0; r <= rect.r1; r++) {
          for (let i = 0; i < count; i++) {
            const dstCol = colAt(right ? rect.c1 + 1 + i : rect.c0 - 1 - i);
            const srcCol = colAt(right ? rect.c0 + (i % srcW) : rect.c1 - (i % srcW));
            if (!dstCol || !srcCol) continue;
            pushEdit(r, srcCol, r, dstCol);
          }
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
    [rect, colAt, cellEditable, transferValue, rows, applyEdits, colKeys],
  );

  const doFill = useCallback(
    (down: boolean) => {
      const edits: CellEdit[] = [];
      for (const f of fillTargets(rect, down)) {
        const col = colAt(f.colIdx);
        const srcCol = colAt(f.srcColIdx);
        const data = rows[f.srcRow];
        if (!col || !srcCol || data === undefined || !cellEditable(f.row, col)) continue;
        const value = transferValue(srcCol.getValue(data), srcCol.key, col, f.row);
        if (value !== undefined) edits.push({ row: f.row, colKey: col.key, value });
      }
      applyEdits(edits);
    },
    [rect, colAt, rows, cellEditable, transferValue, applyEdits],
  );

  const doClear = useCallback(() => {
    const edits: CellEdit[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        const col = colAt(c);
        if (!col || !cellEditable(r, col)) continue;
        // Route through the column's coercion: number → undefined (skip, never
        // write 0), number-nullable → null, text/custom-parse → its empty value.
        const value = parseForColumn(col, '', r);
        if (value === undefined) continue;
        edits.push({ row: r, colKey: col.key, value });
      }
    }
    applyEdits(edits);
  }, [rect, colAt, cellEditable, parseForColumn, applyEdits]);

  // --- Keyboard -------------------------------------------------------------
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editing) {
        // Editing mode: most keys belong to the editor; handle commit/cancel.
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.altKey || e.ctrlKey || e.metaKey) {
            // Alt+Enter (and Ctrl+Enter, old-table muscle memory) inserts a
            // newline at the caret instead of committing.
            const el = editorRef.current;
            const start = el?.selectionStart ?? editing.draft.length;
            const end = el?.selectionEnd ?? start;
            setEditing({
              ...editing,
              draft: `${editing.draft.slice(0, start)}\n${editing.draft.slice(end)}`,
            });
            // Restore the caret after the controlled value re-renders.
            requestAnimationFrame(() => editorRef.current?.setSelectionRange(start + 1, start + 1));
          } else {
            commitEdit(e.shiftKey ? 'up' : 'down');
          }
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

      // Clipboard / fill / select-all. Ctrl+V deliberately does NOT
      // preventDefault: the native `paste` event on the container stays the
      // primary paste path (the only one where clipboard reads are denied);
      // the keydown merely arms a fallback for webviews that never dispatch
      // `paste` to non-editable elements.
      if (ctrl && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); void doCopy(); return; }
      if (ctrl && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); void doCut(); return; }
      if (ctrl && (e.key === 'v' || e.key === 'V')) { schedulePasteFallback(); return; }
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
        case 'Escape': setCopiedRect(null); setCutRect(null); return;
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
      doCopy, doCut, schedulePasteFallback, doFill, doClear, colAt, cellEditable,
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
      scrollRef.current?.focus({ preventScroll: true }); // receive keyboard after a click
      const cell = { row: rowIdx, colKey: key };
      // Arm drag-select only after the pointer moves past a threshold, so a plain
      // click with a few px of drift doesn't "brush" into a 2-cell selection.
      pendingDrag.current = { x: e.clientX, y: e.clientY };
      setInteracting(true);
      setCopiedRect(null);
      setSelection((prev) =>
        e.shiftKey
          ? { anchor: prev.anchor, focus: cell, active: prev.active }
          : { anchor: cell, focus: cell, active: cell },
      );
      onActiveCellChange?.(rowIdx, key);
    },
    [colKeys, onActiveCellChange],
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

  const onRowHoverRef = useRef(onRowHover);
  onRowHoverRef.current = onRowHover;
  const hoverRowRef = useRef<number | null>(null);
  const onCellMouseEnter = useCallback(
    (rowIdx: number, colIdx: number) => {
      if (hoverRowRef.current !== rowIdx) {
        hoverRowRef.current = rowIdx;
        onRowHoverRef.current?.(rowIdx);
      }
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
      scrollRef.current?.focus({ preventScroll: true });
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
      scrollRef.current?.focus({ preventScroll: true });
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
      // Snapshot source RAW values first (src/dst may overlap).
      const srcCols = Array.from({ length: w + 1 }, (_, dc) => colAt(src.c0 + dc));
      const vals: unknown[][] = [];
      for (let dr = 0; dr <= h; dr++) {
        const data = rows[src.r0 + dr];
        vals.push(srcCols.map((col) => (col && data !== undefined ? col.getValue(data) : undefined)));
      }
      const edits: CellEdit[] = [];
      const written = new Set<string>(); // destination cells written
      const moved = new Set<string>(); // source cells whose value actually landed
      for (let dr = 0; dr <= h; dr++) {
        for (let dc = 0; dc <= w; dc++) {
          const col = colAt(dst.c0 + dc);
          const srcCol = srcCols[dc];
          const drow = dst.r0 + dr;
          if (!col || !srcCol || !cellEditable(drow, col)) continue;
          const value = transferValue(vals[dr]?.[dc], srcCol.key, col, drow);
          if (value !== undefined) {
            edits.push({ row: drow, colKey: col.key, value });
            written.add(`${drow}:${col.key}`);
            moved.add(`${src.r0 + dr}:${srcCol.key}`);
          }
        }
      }
      // Clear only source cells whose value landed at the destination (a write
      // rejected by validate / type mismatch keeps its source intact), and which
      // the destination doesn't overwrite.
      const inDst = (r: number, c: number) => r >= dst.r0 && r <= dst.r1 && c >= dst.c0 && c <= dst.c1;
      for (let r = src.r0; r <= src.r1; r++) {
        for (let c = src.c0; c <= src.c1; c++) {
          if (inDst(r, c)) continue;
          const col = colAt(c);
          if (!col || !cellEditable(r, col)) continue;
          if (!moved.has(`${r}:${col.key}`)) continue;
          if (written.has(`${r}:${col.key}`)) continue;
          const cleared = parseForColumn(col, '', r);
          if (cleared === undefined) continue;
          edits.push({ row: r, colKey: col.key, value: cleared });
        }
      }
      applyEdits(edits);
      const ak = colKeys[dst.c0];
      const fk = colKeys[dst.c1];
      if (ak !== undefined && fk !== undefined) {
        setSelection({
          anchor: { row: dst.r0, colKey: ak },
          focus: { row: dst.r1, colKey: fk },
          active: { row: dst.r0, colKey: ak },
        });
      }
    },
    [colAt, rows, cellEditable, transferValue, parseForColumn, applyEdits, colKeys],
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
      scrollRef.current?.focus({ preventScroll: true });
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

  // Scroll an externally-requested row into view (e.g. a map selection).
  useEffect(() => {
    if (scrollToRow != null && scrollToRow >= 0 && scrollToRow < rowCount) {
      virtualizer.scrollToIndex(scrollToRow, { align: 'auto' });
    }
  }, [scrollToRow, rowCount, virtualizer]);

  // External row selection: react only when the prop CHANGES (prev ref), so the
  // grid's own navigation isn't fought; deliberately does NOT fire
  // onActiveCellChange, which would loop the selection back to the host.
  const prevSelectedRow = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevSelectedRow.current;
    prevSelectedRow.current = selectedRow;
    if (selectedRow == null || selectedRow === prev) return;
    if (selectedRow < 0 || selectedRow >= rowCount) return;
    setSelection((prevSel) => {
      if (prevSel.active.row === selectedRow) return prevSel;
      const colKey = colKeys.includes(prevSel.active.colKey) ? prevSel.active.colKey : colKeys[0];
      if (colKey === undefined) return prevSel;
      const cell = { row: selectedRow, colKey };
      return { anchor: cell, focus: cell, active: cell };
    });
    virtualizer.scrollToIndex(selectedRow, { align: 'auto' });
  }, [selectedRow, rowCount, colKeys, virtualizer]);

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
        // flex-1 fills the viewport when maximized; otherwise it must NOT apply
        // (flex-basis 0 beats the explicit height when the host gives the grid
        // an indefinite height, which silently disables row virtualization).
        style={maximized ? undefined : { height, flex: '0 0 auto' }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          if (editing) return; // the editor textarea owns its own paste
          e.preventDefault();
          lastPasteEventAt.current = Date.now();
          // The Ctrl+V keydown fallback already applied this paste → don't
          // double-apply a late-arriving native event.
          if (Date.now() < suppressNativePasteUntil.current) return;
          pasteText(e.clipboardData.getData('text/plain'));
        }}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        onMouseLeave={() => {
          if (hoverRowRef.current !== null) {
            hoverRowRef.current = null;
            onRowHoverRef.current?.(null);
          }
        }}
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
              const extraRowClass = rowClassName?.(row, rowIdx);
              return (
                <div
                  key={rowKey(row, rowIdx)}
                  role="row"
                  aria-rowindex={rowIdx + 2}
                  className={`absolute left-0 flex${rowIdx === hoveredRow ? ' sg-row-hover' : ''}${
                    extraRowClass ? ` ${extraRowClass}` : ''
                  }`}
                  style={{ top: vr.start - HEADER_HEIGHT, height: ROW_HEIGHT, width: totalWidth }}
                  data-testid={`grid-row-${rowIdx}`}
                  data-active={rowIdx === selection.active.row ? 'true' : undefined}
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
                    const inSel = isInRect(rect, rowIdx, c);
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

            {/* Marching-ants for a copied range; a pending cut renders its own
                (visually distinct) marquee instead. */}
            {copiedRect && !cutRect && (
              <div
                className="sg-marching-ants"
                data-testid="grid-copy-marquee"
                style={{ ...rectOverlay(copiedRect), zIndex: 3 }}
              />
            )}
            {cutRect && (
              <div
                className="sg-cut-marquee"
                data-testid="grid-cut-marquee"
                style={{ ...rectOverlay(cutRect), zIndex: 3 }}
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
                onBlur={() => {
                  // A blur caused by commitEdit's or cancelEdit's own refocus
                  // must NOT commit — the draft is already committed/discarded.
                  if (suppressBlurCommitRef.current) {
                    suppressBlurCommitRef.current = false;
                    return;
                  }
                  commitEdit(null, false);
                }}
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
          <button type="button" onClick={() => { void doCut(); setCtxMenu(null); }}>Cut<span className="sg-shortcut">Ctrl+X</span></button>
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
