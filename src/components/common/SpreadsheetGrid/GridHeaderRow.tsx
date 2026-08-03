/**
 * The grid's sticky column-header row: labels, the frozen top-left corner above
 * the row-number gutter, and each column's resize handle.
 *
 * Split out of `SpreadsheetGrid` (#157-style): props in, JSX out, no state of
 * its own. Header drag-to-reorder and drag-to-select still live in the parent -
 * this only renders the targets and forwards the events.
 */
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { GridColumn } from './types';
import { DEFAULT_COL_WIDTH } from './types';
import type { Rect } from './gridGeometry';

export interface GridHeaderRowProps<Row> {
  columns: GridColumn<Row>[];
  /** Resolved pixel width per visible column, parallel to {@link columns}. */
  widths: number[];
  /** Current selection rectangle, for the selected/active header tints. */
  rect: Rect;
  activeColIdx: number;
  rowCount: number;
  gutterWidth: number;
  headerHeight: number;
  /** Whether the scroller has moved, which draws the header's drop shadow. */
  scrolled: boolean;
  testIdPrefix: string;
  /** Present when the host owns column order - a fully-selected column then
   *  shows a grab cursor because it can be dragged to reorder. */
  reorderable: boolean;
  onHeaderMouseDown: (colIdx: number, e: ReactMouseEvent) => void;
  onHeaderMouseEnter: (colIdx: number) => void;
  onHeaderContextMenu?: (colKey: string, pos: { x: number; y: number }) => void;
  onStartResize: (e: ReactMouseEvent, key: string, startWidth: number) => void;
  onAutoFitColumn: (key: string) => void;
}

export function GridHeaderRow<Row>({
  columns,
  widths,
  rect,
  activeColIdx,
  rowCount,
  gutterWidth,
  headerHeight,
  scrolled,
  testIdPrefix,
  reorderable,
  onHeaderMouseDown,
  onHeaderMouseEnter,
  onHeaderContextMenu,
  onStartResize,
  onAutoFitColumn,
}: GridHeaderRowProps<Row>) {
  return (
    <div
      role="row"
      aria-rowindex={1}
      className={`sg-header-bar sticky top-0 z-30 flex bg-panel ${scrolled ? 'sg-scrolled' : ''}`}
      style={{ height: headerHeight }}
    >
      {/* Frozen top-left corner above the row-number gutter. */}
      <div
        className="sg-corner sticky left-0 z-30 flex items-center justify-center border-b border-r border-white/10 bg-panel"
        style={{ width: gutterWidth, minWidth: gutterWidth }}
      />
      {columns.map((c, i) => {
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
              cursor: colSelected && reorderable ? 'grab' : 'pointer',
            }}
            onMouseDown={(e) => onHeaderMouseDown(i, e)}
            onMouseEnter={() => onHeaderMouseEnter(i)}
            onContextMenu={(e) => {
              if (!onHeaderContextMenu) return;
              e.preventDefault();
              onHeaderContextMenu(c.key, { x: e.clientX, y: e.clientY });
            }}
            data-testid={`${testIdPrefix}-header-${c.key}`}
          >
            <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {c.header}
            </span>
            {/* Drag this edge to resize the column. The handle normally
                straddles the boundary (right: -2px); on the last column that
                boundary is the content's right edge, so keep it inside the
                cell to avoid a few-px phantom horizontal scrollbar. */}
            <div
              className={`sg-col-resize${i === columns.length - 1 ? ' sg-col-resize-end' : ''}`}
              data-testid={`${testIdPrefix}-col-resize-${c.key}`}
              onMouseDown={(e) => onStartResize(e, c.key, widths[i] ?? DEFAULT_COL_WIDTH)}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onAutoFitColumn(c.key);
              }}
              onDragStart={(e) => e.preventDefault()}
            />
          </div>
        );
      })}
    </div>
  );
}
