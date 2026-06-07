import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import './SpreadsheetGrid.css';
import {
  type GridColumn,
  type GridSelection,
  type CellEdit,
  DEFAULT_COL_WIDTH,
  ROW_HEIGHT,
} from './types';
import { parseLocaleNumber, parseTSV, serializeRangeToTSV } from './gridClipboard';
import {
  arrowTarget,
  clamp,
  columnOffsets,
  fillTargets,
  isInRect,
  placePaste,
  selectionRect,
  tabTarget,
  type Rect,
} from './gridGeometry';

const HEADER_HEIGHT = 33;
const MIN_COL_WIDTH = 40;
const EDGE_SCROLL_ZONE = 26;

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
  const totalWidth = offsets[offsets.length - 1] ?? 0;
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
    return { anchor: { row: 0, colKey: key }, focus: { row: 0, colKey: key } };
  });
  const [editing, setEditing] = useState<EditState | null>(null);
  const [copiedRect, setCopiedRect] = useState<Rect | null>(null);
  const [fillPreview, setFillPreview] = useState<Rect | null>(null);
  const [interacting, setInteracting] = useState(false);
  const dragging = useRef(false);
  const fillDragging = useRef(false);
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const dragMouseY = useRef(0);
  const autoScrollRAF = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [scrolled, setScrolled] = useState(false);

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

  // --- Helpers --------------------------------------------------------------
  const colAt = useCallback((idx: number) => visibleColumns[idx], [visibleColumns]);

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

  // --- Focus movement -------------------------------------------------------
  const moveFocusTo = useCallback(
    (row: number, colIdx: number, extend: boolean) => {
      const key = colKeys[clamp(colIdx, 0, Math.max(0, colCount - 1))];
      if (key === undefined) return;
      const r = clamp(row, 0, Math.max(0, rowCount - 1));
      setSelection((prev) => ({
        anchor: extend ? prev.anchor : { row: r, colKey: key },
        focus: { row: r, colKey: key },
      }));
      virtualizer.scrollToIndex(r, { align: 'auto' });
      onActiveCellChange?.(r, key);
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
      setCopiedRect(null);
      setEditing({ row: rowIdx, colKey: col.key, draft });
    },
    [colAt, cellEditable, displayAt],
  );

  const commitEdit = useCallback(
    (advance: 'down' | 'right' | 'up' | 'left' | null) => {
      setEditing((cur) => {
        if (!cur) return null;
        const colIdx = colIndexOf(cur.colKey);
        const col = colAt(colIdx);
        if (col) {
          const value = parseForColumn(col, cur.draft, cur.row);
          if (value !== undefined) onEdit(cur.row, cur.colKey, value);
        }
        if (advance) {
          const d =
            advance === 'down'
              ? [1, 0]
              : advance === 'up'
                ? [-1, 0]
                : advance === 'right'
                  ? [0, 1]
                  : [-1 < 0 ? 0 : 0, -1];
          const t = arrowTarget(cur.row, colIdx, d[0] ?? 0, d[1] ?? 0, rowCount, colCount);
          moveFocusTo(t.row, t.colIdx, false);
        }
        return null;
      });
    },
    [colIndexOf, colAt, parseForColumn, onEdit, rowCount, colCount, moveFocusTo],
  );

  const cancelEdit = useCallback(() => setEditing(null), []);

  useEffect(() => {
    if (editing && editorRef.current) {
      const el = editorRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

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
    const { targets } = placePaste(clip, rect, rowCount, colCount);
    const edits: CellEdit[] = [];
    for (const t of targets) {
      const col = colAt(t.colIdx);
      if (!col || !cellEditable(t.row, col)) continue;
      const value = parseForColumn(col, t.raw, t.row);
      if (value !== undefined) edits.push({ row: t.row, colKey: col.key, value });
    }
    applyEdits(edits);
    setCopiedRect(null);
  }, [rect, rowCount, colCount, colAt, cellEditable, parseForColumn, applyEdits]);

  // Copy-fill the selection block across `preview`'s extension (tiled).
  const commitFill = useCallback(
    (preview: Rect) => {
      const srcH = rect.r1 - rect.r0 + 1;
      const srcW = rect.c1 - rect.c0 + 1;
      const edits: CellEdit[] = [];
      for (let r = preview.r0; r <= preview.r1; r++) {
        for (let c = preview.c0; c <= preview.c1; c++) {
          if (isInRect(rect, r, c)) continue; // keep the source intact
          const col = colAt(c);
          if (!col || !cellEditable(r, col)) continue;
          const srcR = rect.r0 + ((((r - rect.r0) % srcH) + srcH) % srcH);
          const srcC = rect.c0 + ((((c - rect.c0) % srcW) + srcW) % srcW);
          const srcCol = colAt(srcC);
          if (!srcCol) continue;
          const value = parseForColumn(col, displayAt(srcR, srcCol), r);
          if (value !== undefined) edits.push({ row: r, colKey: col.key, value });
        }
      }
      applyEdits(edits);
      const a = colKeys[preview.c0];
      const f = colKeys[preview.c1];
      if (a !== undefined && f !== undefined) {
        setSelection({
          anchor: { row: preview.r0, colKey: a },
          focus: { row: preview.r1, colKey: f },
        });
      }
    },
    [rect, colAt, cellEditable, parseForColumn, displayAt, applyEdits, colKeys],
  );

  const doFill = useCallback(
    (down: boolean) => {
      const edits: CellEdit[] = [];
      for (const f of fillTargets(rect, down)) {
        const col = colAt(f.colIdx);
        const srcCol = colAt(f.srcColIdx);
        if (!col || !srcCol || !cellEditable(f.row, col)) continue;
        const raw = displayAt(f.srcRow, srcCol);
        const value = parseForColumn(col, raw, f.row);
        if (value !== undefined) edits.push({ row: f.row, colKey: col.key, value });
      }
      applyEdits(edits);
    },
    [rect, colAt, cellEditable, displayAt, parseForColumn, applyEdits],
  );

  const doClear = useCallback(() => {
    const edits: CellEdit[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        const col = colAt(c);
        if (!col || !cellEditable(r, col)) continue;
        if (col.kind === 'number') continue; // never write 0 into a required number
        edits.push({ row: r, colKey: col.key, value: col.kind === 'number-nullable' ? null : '' });
      }
    }
    applyEdits(edits);
  }, [rect, colAt, cellEditable, applyEdits]);

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

      const row = selection.focus.row;
      const colIdx = focusColIdx;
      const ctrl = e.ctrlKey || e.metaKey;

      // Clipboard / fill / select-all
      if (ctrl && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); void doCopy(); return; }
      if (ctrl && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); void doCopy(); doClear(); return; }
      if (ctrl && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); void doPaste(); return; }
      if (ctrl && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); doFill(true); return; }
      if (ctrl && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); doFill(false); return; }
      if (ctrl && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const firstKey = colKeys[0];
        const lastKey = colKeys[colCount - 1];
        if (firstKey !== undefined && lastKey !== undefined) {
          setSelection({ anchor: { row: 0, colKey: firstKey }, focus: { row: rowCount - 1, colKey: lastKey } });
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); { const t = ctrl ? dataEdgeTarget(row, colIdx, 1, 0) : arrowTarget(row, colIdx, 1, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowUp': e.preventDefault(); { const t = ctrl ? dataEdgeTarget(row, colIdx, -1, 0) : arrowTarget(row, colIdx, -1, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowRight': e.preventDefault(); { const t = ctrl ? dataEdgeTarget(row, colIdx, 0, 1) : arrowTarget(row, colIdx, 0, 1, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowLeft': e.preventDefault(); { const t = ctrl ? dataEdgeTarget(row, colIdx, 0, -1) : arrowTarget(row, colIdx, 0, -1, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'Home': e.preventDefault(); moveFocusTo(ctrl ? 0 : row, 0, e.shiftKey); return;
        case 'End': e.preventDefault(); moveFocusTo(ctrl ? rowCount - 1 : row, colCount - 1, e.shiftKey); return;
        case 'PageDown': e.preventDefault(); { const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1); const t = arrowTarget(row, colIdx, page, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'PageUp': e.preventDefault(); { const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1); const t = arrowTarget(row, colIdx, -page, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'Tab': {
          e.preventDefault();
          const t = tabTarget(row, colIdx, e.shiftKey ? -1 : 1, writableColIdxs, rowCount);
          if (t) moveFocusTo(t.row, t.colIdx, false);
          return;
        }
        case 'Enter': e.preventDefault(); beginEdit(row, colIdx, null); return;
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
    ],
  );

  // --- Mouse selection + fill-handle drag ----------------------------------
  const onCellMouseDown = useCallback(
    (rowIdx: number, colIdx: number, e: ReactMouseEvent) => {
      const key = colKeys[colIdx];
      if (key === undefined) return;
      e.preventDefault(); // suppress native text selection; the grid owns selection
      scrollRef.current?.focus(); // receive keyboard after a click
      dragging.current = true;
      setInteracting(true);
      setCopiedRect(null);
      setSelection((prev) =>
        e.shiftKey
          ? { anchor: prev.anchor, focus: { row: rowIdx, colKey: key } }
          : { anchor: { row: rowIdx, colKey: key }, focus: { row: rowIdx, colKey: key } },
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
      setSelection((prev) => ({ anchor: prev.anchor, focus: { row: rowIdx, colKey: key } }));
    },
    [colKeys, rect],
  );

  const startResize = useCallback((e: ReactMouseEvent, key: string, startW: number) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = { key, startX: e.clientX, startW };
    setInteracting(true);
  }, []);

  const onHeaderSelectColumn = useCallback(
    (colIdx: number, shiftKey: boolean) => {
      const key = colKeys[colIdx];
      if (key === undefined || rowCount === 0) return;
      scrollRef.current?.focus();
      setCopiedRect(null);
      setSelection((prev) => ({
        anchor: shiftKey ? { row: 0, colKey: prev.anchor.colKey } : { row: 0, colKey: key },
        focus: { row: rowCount - 1, colKey: key },
      }));
    },
    [colKeys, rowCount],
  );

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
      else setSelection((prev) => ({ anchor: prev.anchor, focus: { row, colKey: prev.focus.colKey } }));
    },
    [rect],
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
  onMoveRef.current = (e) => {
    if (resizing.current) {
      const { key, startX, startW } = resizing.current;
      setColWidthOverrides((m) => ({ ...m, [key]: Math.max(MIN_COL_WIDTH, startW + (e.clientX - startX)) }));
      return;
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
  onUpRef.current = () => {
    if (fillDragging.current && fillPreview) commitFill(fillPreview);
    dragging.current = false;
    fillDragging.current = false;
    resizing.current = null;
    if (autoScrollRAF.current) {
      cancelAnimationFrame(autoScrollRAF.current);
      autoScrollRAF.current = 0;
    }
    setInteracting(false);
    setFillPreview(null);
  };
  useEffect(() => {
    const mv = (e: MouseEvent) => onMoveRef.current(e);
    const up = () => onUpRef.current();
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
  }, []);

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
  const dragColKey = useRef<string | null>(null);
  const onHeaderDrop = useCallback(
    (targetKey: string) => {
      const from = dragColKey.current;
      dragColKey.current = null;
      if (!from || from === targetKey || !onColumnOrderChange) return;
      const base = colKeys.slice();
      const fromIdx = base.indexOf(from);
      const toIdx = base.indexOf(targetKey);
      if (fromIdx < 0 || toIdx < 0) return;
      base.splice(fromIdx, 1);
      base.splice(toIdx, 0, from);
      // Preserve hidden columns' relative positions by appending them.
      const hidden = (hiddenColumns ?? []).filter((k) => !base.includes(k));
      onColumnOrderChange([...base, ...hidden]);
    },
    [colKeys, hiddenColumns, onColumnOrderChange],
  );

  // --- Render ---------------------------------------------------------------
  const virtualRows = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  const overlayStyle: CSSProperties = {
    position: 'absolute',
    // The overlay lives INSIDE the rows-area (which starts below the sticky
    // header), where row 0 is at y=0 — so no header offset here.
    top: rect.r0 * ROW_HEIGHT,
    left: offsets[rect.c0] ?? 0,
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
    left: offsets[r.c0] ?? 0,
    width: (offsets[r.c1 + 1] ?? 0) - (offsets[r.c0] ?? 0),
    height: (r.r1 - r.r0 + 1) * ROW_HEIGHT,
    pointerEvents: 'none',
  });

  return (
    <div
      className={`sg-grid relative flex flex-col ${maximized ? 'fixed inset-0 z-50 bg-panel' : ''} ${className}`}
      data-testid="spreadsheet-grid"
    >
      {(onHiddenColumnsChange || onToggleMaximize) && (
        <div className="flex items-center justify-end gap-1 px-1 py-0.5">
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
                <div className="absolute right-0 top-full z-50 mt-0.5 max-h-64 overflow-auto rounded border border-white/10 bg-panel p-1 shadow-lg">
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
      )}

      <div
        ref={scrollRef}
        className="relative overflow-auto outline-none flex-1"
        style={{ height: maximized ? undefined : height }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        role="grid"
        aria-rowcount={rowCount}
        aria-colcount={colCount}
      >
        <div style={{ width: totalWidth, position: 'relative' }}>
          {/* Sticky header */}
          <div
            className={`sg-header-bar sticky top-0 z-10 flex bg-panel ${scrolled ? 'sg-scrolled' : ''}`}
            style={{ height: HEADER_HEIGHT }}
          >
            {visibleColumns.map((c, i) => (
              <div
                key={c.key}
                className={`sg-header relative flex items-center border-b border-r border-white/10 px-2 text-xs font-medium text-text-secondary ${
                  i >= rect.c0 && i <= rect.c1 ? 'sg-header-selected text-text-primary' : ''
                }`}
                style={{ width: widths[i], minWidth: widths[i] }}
                draggable={!!onColumnOrderChange}
                onDragStart={() => { dragColKey.current = c.key; }}
                onDragOver={(e) => { if (dragColKey.current) e.preventDefault(); }}
                onDrop={() => onHeaderDrop(c.key)}
                onClick={(e) => onHeaderSelectColumn(i, e.shiftKey)}
                data-testid={`grid-header-${c.key}`}
              >
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{c.header}</span>
                {/* Drag this edge to resize the column. */}
                <div
                  className="sg-col-resize"
                  data-testid={`grid-col-resize-${c.key}`}
                  onMouseDown={(e) => startResize(e, c.key, widths[i] ?? DEFAULT_COL_WIDTH)}
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => e.preventDefault()}
                />
              </div>
            ))}
          </div>

          {/* Rows area */}
          <div style={{ height: totalHeight, position: 'relative' }}>
            {virtualRows.map((vr) => {
              const rowIdx = vr.index;
              const row = rows[rowIdx];
              if (row === undefined) return null;
              return (
                <div
                  key={rowKey(row, rowIdx)}
                  className="absolute left-0 flex"
                  style={{ top: vr.start - HEADER_HEIGHT, height: ROW_HEIGHT, width: totalWidth }}
                  data-testid={`grid-row-${rowIdx}`}
                >
                  {visibleColumns.map((col, c) => {
                    const inSel = isInRect(rect, rowIdx, c);
                    const isFocus = rowIdx === selection.focus.row && c === focusColIdx;
                    const isEditingCell = editing?.row === rowIdx && editing.colKey === col.key;
                    return (
                      <div
                        key={col.key}
                        className={`sg-cell flex items-center overflow-hidden border-b border-r border-white/5 px-2 text-xs ${
                          col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : ''
                        }`}
                        style={{
                          width: widths[c],
                          minWidth: widths[c],
                          // Range fill, but leave the active cell unfilled (GS look).
                          backgroundColor: inSel && !isFocus ? 'var(--sg-blue-fill)' : undefined,
                        }}
                        data-testid={`grid-cell-${rowIdx}-${col.key}`}
                        data-in-selection={inSel ? 'true' : undefined}
                        data-active-cell={isFocus ? 'true' : undefined}
                        onMouseDown={(e) => onCellMouseDown(rowIdx, c, e)}
                        onMouseEnter={() => onCellMouseEnter(rowIdx, c)}
                        onDoubleClick={(e) => { e.stopPropagation(); beginEdit(rowIdx, c, null); }}
                      >
                        {isEditingCell ? (
                          <textarea
                            ref={editorRef}
                            className="h-full w-full resize-none bg-panel text-xs outline-none"
                            value={editing.draft}
                            rows={1}
                            onChange={(ev) => setEditing({ ...editing, draft: ev.target.value })}
                            onBlur={() => commitEdit(null)}
                            onKeyDown={(ev) => {
                              // Let caret keys work inside the editor; commit/cancel bubble.
                              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
                                ev.stopPropagation();
                              }
                            }}
                          />
                        ) : (
                          renderCell(col, row, rowIdx)
                        )}
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

            {/* Selection rectangle overlay (survives row virtualization). */}
            {rowCount > 0 && colCount > 0 && (
              <div
                className={`sg-selection-overlay ${interacting ? 'sg-no-anim' : ''}`}
                style={overlayStyle}
                data-testid="grid-selection-overlay"
                data-rect={`${rect.r0},${rect.c0},${rect.r1},${rect.c1}`}
              >
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
          </div>
        </div>
      </div>
    </div>
  );
}

function isColWritable<Row>(c: GridColumn<Row>): boolean {
  return !!(c.editable || c.isEditable);
}

function renderCell<Row>(col: GridColumn<Row>, row: Row, rowIdx: number): ReactNode {
  if (col.render) return col.render(row, rowIdx);
  const value = col.getValue(row);
  return col.format ? col.format(value, row) : String(value ?? '');
}
