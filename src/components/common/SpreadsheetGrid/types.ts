import type { ReactNode } from 'react';

/**
 * SpreadsheetGrid — a self-contained, library-free, Excel-like editing grid.
 *
 * Clean-room note: implemented from observable spreadsheet behaviour and
 * commodity algorithms only; no third-party grid library source was referenced.
 *
 * The grid is **controlled**: it renders the `rows` you pass and emits edits via
 * callbacks. It never mutates your data. Selection/active-cell/edit-mode are
 * owned internally (transient, high-frequency state); persisted concerns
 * (hidden/ordered columns, maximized) are lifted to props so the host can store
 * them.
 *
 * Survey-specific behaviour (frozen rows, computed columns, azimuth deltas,
 * locale parsing) plugs in through `GridColumn` predicates and `parse`, so the
 * grid itself stays domain-agnostic and reusable.
 */
export interface GridColumn<Row> {
  /** Stable identity for the column. Selection/copy/paste are keyed by this,
   *  never by position, so hiding/reordering never desyncs a selection. */
  key: string;
  header: string;
  /** Width in px (default {@link DEFAULT_COL_WIDTH}). Fixed widths keep the
   *  selection-overlay geometry exact. */
  width?: number;
  align?: 'left' | 'center' | 'right';

  /** Read the cell's logical value from a row. */
  getValue: (row: Row, rowIndex: number) => unknown;
  /** Format the value for display AND for the clipboard (so a copy round-trips
   *  into a same-locale spreadsheet). Defaults to `String(value ?? '')`. */
  format?: (value: unknown, row: Row) => string;
  /** Custom cell content (badges, dropdowns, icons). Defaults to formatted text. */
  render?: (row: Row, rowIndex: number) => ReactNode;

  /** Whether the column accepts edits at all (default false → read-only). */
  editable?: boolean;
  /** Per-cell override; if present it wins over {@link editable}. Use for frozen
   *  rows / closure-adjusted mode at integration time. */
  isEditable?: (row: Row, rowIndex: number) => boolean;

  /** Coercion hint used by the default parser and for type-to-edit gating. */
  kind?: 'text' | 'number' | 'number-nullable';
  /** Open a larger multi-line editor (comments etc.) instead of the
   *  cell-sized one. */
  multiline?: boolean;
  /** Parse a raw typed/pasted string into the value to commit. Return
   *  `undefined` to SKIP the write (e.g. a non-finite number, or an empty string
   *  into a non-nullable numeric — never silently write 0). Defaults to a
   *  locale-aware parser based on {@link kind}. */
  parse?: (raw: string, row: Row) => unknown;
  /** Validate a parsed value before it is committed. Return an error message to
   *  REJECT it, or `null` to accept. Interactive edits flash the cell red and
   *  keep the editor open so the value can be fixed; bulk paste/fill/move skip a
   *  rejected cell. Clears are never validated. */
  validate?: (value: unknown, row: Row) => string | null;
}

/** A cell identified by data-row index + column key (never DOM/position). */
export interface CellCoord {
  row: number;
  colKey: string;
}

/** A selection rectangle plus the active cell.
 *  - `anchor` / `focus` are the rectangle corners (`focus` is the moving corner
 *    while extending).
 *  - `active` is where typing/editing happens and the unfilled "white" cell.
 *    During a range extension it stays put (Google-Sheets behaviour); Tab/Enter
 *    cycle it within the rectangle. For a single-cell selection all three are
 *    equal. */
export interface GridSelection {
  anchor: CellCoord;
  focus: CellCoord;
  active: CellCoord;
}

/** A single resolved edit emitted to the host. `value` is already coerced. */
export interface CellEdit {
  row: number;
  colKey: string;
  value: unknown;
}

export const DEFAULT_COL_WIDTH = 120;
export const ROW_HEIGHT = 33;
