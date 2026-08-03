/**
 * The grid's built-in toolbar: name box, Columns menu, Maximize.
 *
 * Split out of `SpreadsheetGrid` (#157-style): props in, JSX out. Hosts that
 * fold the grid into their own chrome turn it off with `showToolbar={false}` and
 * never render this at all (the data table does exactly that).
 *
 * The Columns button appears only when the host supplied
 * `onHiddenColumnsChange`, and Maximize only with `onToggleMaximize` - a grid
 * whose host does not own that state should not advertise the control.
 */
import type { GridColumn } from './types';
import type { GridLabels } from './gridLabels';

export interface GridToolbarProps<Row> {
  columns: GridColumn<Row>[];
  hiddenColumns: string[];
  labels: GridLabels;
  /** Selection summary rendered on the left ("3R x 2C", a cell reference, ...). */
  nameBox: string;
  testIdPrefix: string;
  menuOpen: boolean;
  setMenuOpen: (update: (open: boolean) => boolean) => void;
  onToggleHidden: (key: string) => void;
  onHiddenColumnsChange?: (hidden: string[]) => void;
  maximized: boolean;
  onToggleMaximize?: () => void;
}

export function GridToolbar<Row>({
  columns,
  hiddenColumns,
  labels,
  nameBox,
  testIdPrefix,
  menuOpen,
  setMenuOpen,
  onToggleHidden,
  onHiddenColumnsChange,
  maximized,
  onToggleMaximize,
}: GridToolbarProps<Row>) {
  return (
    <div className="sg-toolbar flex items-center justify-between gap-2 px-2 py-0.5">
      <span className="sg-namebox" data-testid={`${testIdPrefix}-namebox`}>
        {nameBox}
      </span>
      <div className="flex items-center gap-1">
        {onHiddenColumnsChange && (
          <div className="relative">
            <button
              type="button"
              className="text-xs px-2 py-0.5 rounded hover:bg-accent-10"
              data-testid={`${testIdPrefix}-columns-menu`}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {labels.columnsButton}
            </button>
            {menuOpen && (
              <div
                data-dropdown-open
                className="sg-colmenu absolute right-0 top-full z-50 mt-0.5 max-h-64 overflow-auto rounded border p-1 shadow-lg"
              >
                {columns.map((c) => (
                  <label
                    key={c.key}
                    className="flex items-center gap-2 px-2 py-0.5 text-xs whitespace-nowrap hover:bg-accent-10"
                    data-testid={`${testIdPrefix}-col-toggle-${c.key}`}
                  >
                    <input
                      type="checkbox"
                      checked={!hiddenColumns.includes(c.key)}
                      data-testid={`${testIdPrefix}-col-toggle-input-${c.key}`}
                      onChange={() => onToggleHidden(c.key)}
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
            data-testid={`${testIdPrefix}-maximize`}
            onClick={onToggleMaximize}
          >
            {maximized ? labels.restore : labels.maximize}
          </button>
        )}
      </div>
    </div>
  );
}
