import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
} from './gridGeometry';

const HEADER_HEIGHT = 33;

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

  const colKeys = useMemo(() => visibleColumns.map((c) => c.key), [visibleColumns]);
  const widths = useMemo(
    () => visibleColumns.map((c) => c.width ?? DEFAULT_COL_WIDTH),
    [visibleColumns],
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
  const dragging = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

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

  // --- Editing --------------------------------------------------------------
  const beginEdit = useCallback(
    (rowIdx: number, colIdx: number, seed: string | null) => {
      const col = colAt(colIdx);
      if (!col || !cellEditable(rowIdx, col)) return;
      const draft = seed ?? displayAt(rowIdx, col);
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
    try {
      await navigator.clipboard.writeText(serializeRangeToTSV(buildRangeMatrix()));
    } catch {
      /* clipboard may be unavailable in the webview; integration adds a fallback */
    }
  }, [buildRangeMatrix]);

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
  }, [rect, rowCount, colCount, colAt, cellEditable, parseForColumn, applyEdits]);

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
        case 'ArrowDown': e.preventDefault(); { const t = arrowTarget(row, colIdx, 1, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowUp': e.preventDefault(); { const t = arrowTarget(row, colIdx, -1, 0, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowRight': e.preventDefault(); { const t = arrowTarget(row, colIdx, 0, 1, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
        case 'ArrowLeft': e.preventDefault(); { const t = arrowTarget(row, colIdx, 0, -1, rowCount, colCount); moveFocusTo(t.row, t.colIdx, e.shiftKey); } return;
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
        case 'Escape': return;
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
      writableColIdxs, colIndexOf, moveFocusTo, beginEdit, commitEdit, cancelEdit,
      doCopy, doPaste, doFill, doClear, colAt, cellEditable,
    ],
  );

  // --- Mouse selection ------------------------------------------------------
  const onCellMouseDown = useCallback(
    (rowIdx: number, colIdx: number, e: { shiftKey: boolean }) => {
      const key = colKeys[colIdx];
      if (key === undefined) return;
      dragging.current = true;
      setSelection((prev) =>
        e.shiftKey
          ? { anchor: prev.anchor, focus: { row: rowIdx, colKey: key } }
          : { anchor: { row: rowIdx, colKey: key }, focus: { row: rowIdx, colKey: key } },
      );
      onActiveCellChange?.(rowIdx, key);
    },
    [colKeys, onActiveCellChange],
  );

  const onCellMouseEnter = useCallback(
    (rowIdx: number, colIdx: number) => {
      if (!dragging.current) return;
      const key = colKeys[colIdx];
      if (key === undefined) return;
      setSelection((prev) => ({ anchor: prev.anchor, focus: { row: rowIdx, colKey: key } }));
    },
    [colKeys],
  );

  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
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
    top: HEADER_HEIGHT + rect.r0 * ROW_HEIGHT,
    left: offsets[rect.c0] ?? 0,
    width: (offsets[rect.c1 + 1] ?? 0) - (offsets[rect.c0] ?? 0),
    height: (rect.r1 - rect.r0 + 1) * ROW_HEIGHT,
    border: '2px solid #3b82f6',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: 3,
  };

  return (
    <div
      className={`relative flex flex-col ${maximized ? 'fixed inset-0 z-50 bg-panel' : ''} ${className}`}
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
        role="grid"
        aria-rowcount={rowCount}
        aria-colcount={colCount}
      >
        <div style={{ width: totalWidth, position: 'relative' }}>
          {/* Sticky header */}
          <div
            className="sticky top-0 z-10 flex bg-panel"
            style={{ height: HEADER_HEIGHT }}
          >
            {visibleColumns.map((c, i) => (
              <div
                key={c.key}
                className="flex items-center border-b border-r border-white/10 px-2 text-xs font-medium text-text-secondary select-none"
                style={{ width: widths[i], minWidth: widths[i] }}
                draggable={!!onColumnOrderChange}
                onDragStart={() => { dragColKey.current = c.key; }}
                onDragOver={(e) => { if (dragColKey.current) e.preventDefault(); }}
                onDrop={() => onHeaderDrop(c.key)}
                data-testid={`grid-header-${c.key}`}
              >
                {c.header}
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
                        className={`flex items-center overflow-hidden border-b border-r border-white/5 px-2 text-xs ${
                          inSel ? 'bg-accent-10' : ''
                        } ${col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : ''}`}
                        style={{ width: widths[c], minWidth: widths[c] }}
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

            {/* Selection rectangle overlay (survives row virtualization) */}
            {rowCount > 0 && colCount > 0 && (
              <div style={overlayStyle} data-testid="grid-selection-overlay" data-rect={`${rect.r0},${rect.c0},${rect.r1},${rect.c1}`} />
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
