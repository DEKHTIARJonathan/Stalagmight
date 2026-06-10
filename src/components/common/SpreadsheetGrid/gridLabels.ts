/**
 * User-facing chrome strings for SpreadsheetGrid (context menu, toolbar,
 * editor aria-label). The grid itself stays i18next-free: hosts localize by
 * passing a (partial) `labels` prop backed by their own `t()`; anything not
 * provided falls back to these English defaults.
 */
export interface GridLabels {
  /** Context-menu entries taking the selection-shape suffix the grid computes:
   *  '' for a plain range, ' 3 shots' for full rows, ' 2 columns' for full
   *  columns (leading space included). */
  copy: (suffix: string) => string;
  cut: (suffix: string) => string;
  clear: (suffix: string) => string;
  paste: string;
  fillDown: string;
  /** Row entries taking the counted-rows label ('shot', '3 shots'). */
  insertAbove: (rowsLabel: string) => string;
  insertBelow: (rowsLabel: string) => string;
  deleteRows: (rowsLabel: string) => string;
  /** Domain noun for a row, used in context-menu labels ("Delete shot",
   *  "Copy 3 shots"). */
  rowNoun: (count: number) => string;
  columnNoun: (count: number) => string;
  /** Built-in toolbar buttons. */
  columnsButton: string;
  maximize: string;
  restore: string;
  /** Cell-editor textarea aria-label ("Edit Length row 3"; 1-based row). */
  editCellAria: (columnHeader: string, rowNumber: number) => string;
  /** Shortcut hints rendered beside the context-menu entries. */
  shortcutCopy: string;
  shortcutCut: string;
  shortcutPaste: string;
  shortcutClear: string;
  shortcutFillDown: string;
}

export const DEFAULT_GRID_LABELS: GridLabels = {
  copy: (suffix) => `Copy${suffix}`,
  cut: (suffix) => `Cut${suffix}`,
  clear: (suffix) => `Clear${suffix}`,
  paste: 'Paste',
  fillDown: 'Fill down',
  insertAbove: (rowsLabel) => `Insert ${rowsLabel} above`,
  insertBelow: (rowsLabel) => `Insert ${rowsLabel} below`,
  deleteRows: (rowsLabel) => `Delete ${rowsLabel}`,
  rowNoun: (count) => (count === 1 ? 'row' : 'rows'),
  columnNoun: (count) => (count === 1 ? 'column' : 'columns'),
  columnsButton: 'Columns',
  maximize: 'Maximize',
  restore: 'Restore',
  editCellAria: (columnHeader, rowNumber) => `Edit ${columnHeader} row ${rowNumber}`,
  shortcutCopy: 'Ctrl+C',
  shortcutCut: 'Ctrl+X',
  shortcutPaste: 'Ctrl+V',
  shortcutClear: 'Del',
  shortcutFillDown: 'Ctrl+D',
};
