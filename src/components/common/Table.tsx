import { type ReactNode, useRef, useEffect, useCallback } from 'react';

interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render?: (item: T, index: number) => ReactNode;
  align?: 'left' | 'center' | 'right';
  /** Get the value for a virtual column (not a direct property on the item) */
  getValue?: (item: T) => unknown;
  /** Format the value for display (applied to input value and non-editable display) */
  formatValue?: (value: unknown) => string;
  /** Input type for editable cells (default: 'text') */
  inputType?: 'text' | 'number';
  /** Step for number inputs */
  inputStep?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyField: keyof T;
  onRowClick?: (item: T, index: number) => void;
  selectedKey?: T[keyof T] | null | undefined;
  className?: string;
  emptyMessage?: string;
}

export function Table<T extends object>({
  columns,
  data,
  keyField,
  onRowClick,
  selectedKey,
  className = '',
  emptyMessage = 'No data',
}: TableProps<T>) {
  const alignmentClasses = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };

  return (
    <div className={`overflow-auto ${className}`}>
      <table className="w-full">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`
                  sticky top-0 bg-panel z-10
                  ${alignmentClasses[column.align ?? 'left']}
                `}
                style={{ width: column.width }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="text-center text-text-secondary py-8"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((item, index) => {
              const key = item[keyField];
              const isSelected = key === selectedKey;

              return (
                <tr
                  key={String(key)}
                  className={`
                    ${onRowClick ? 'cursor-pointer' : ''}
                    ${isSelected ? 'bg-accent/20' : ''}
                  `}
                  onClick={() => onRowClick?.(item, index)}
                >
                  {columns.map((column) => {
                    // Use getValue for virtual columns, otherwise access property directly
                    const value = column.getValue
                      ? column.getValue(item)
                      : (item as Record<string, unknown>)[column.key];
                    // Apply formatValue if provided, otherwise stringify
                    const displayValue = column.formatValue
                      ? column.formatValue(value)
                      : String(value ?? '');

                    return (
                      <td
                        key={column.key}
                        className={alignmentClasses[column.align ?? 'left']}
                      >
                        {column.render ? column.render(item, index) : displayValue}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

interface EditableTableProps<T> extends Omit<TableProps<T>, 'onRowClick'> {
  onCellEdit?: (item: T, key: string, value: unknown, index: number) => void;
  editableColumns?: string[];
  // Row interaction props
  onRowClick?: (item: T, index: number) => void;
  onRowDoubleClick?: (item: T, index: number) => void;
  onRowHover?: (item: T | null, index: number | null) => void;
  hoveredKey?: T[keyof T] | null;
  scrollToKey?: T[keyof T] | null;
  rowClassName?: (item: T, isSelected: boolean, isHovered: boolean) => string;
}

export function EditableTable<T extends object>({
  columns,
  data,
  keyField,
  onCellEdit,
  editableColumns = [],
  selectedKey,
  className = '',
  emptyMessage = 'No data',
  onRowClick,
  onRowDoubleClick,
  onRowHover,
  hoveredKey,
  scrollToKey,
  rowClassName,
}: EditableTableProps<T>) {
  const alignmentClasses = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };

  // Refs for row elements, indexed by data index
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  // Store callbacks in refs to avoid stale closures
  const onRowHoverRef = useRef(onRowHover);

  useEffect(() => {
    onRowHoverRef.current = onRowHover;
  }, [onRowHover]);

  // Scroll to row when scrollToKey changes
  useEffect(() => {
    if (scrollToKey == null) return;

    const index = data.findIndex((item) => item[keyField] === scrollToKey);
    if (index === -1) return;

    const rowEl = rowRefs.current.get(index);
    if (rowEl) {
      rowEl.scrollIntoView({ block: 'nearest' });
    }
  }, [scrollToKey, data, keyField]);

  const handleInputChange = (
    item: T,
    key: string,
    value: string,
    index: number
  ) => {
    // Try to parse as number if the original value was a number
    // For virtual columns (getValue), check the returned value type
    const column = columns.find((c) => c.key === key);
    const originalValue = column?.getValue
      ? column.getValue(item)
      : (item as Record<string, unknown>)[key];
    let parsedValue: unknown = value;

    if (typeof originalValue === 'number') {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        parsedValue = num;
      }
    } else if (typeof originalValue === 'boolean') {
      parsedValue = value === 'true';
    }

    onCellEdit?.(item, key, parsedValue, index);
  };

  // Handle click - use event.detail to distinguish single from double click
  // event.detail === 1 means single click, === 2 means double click
  const handleRowClick = useCallback((e: React.MouseEvent, item: T, index: number) => {
    // Only fire onRowClick for true single clicks (detail === 1)
    // This prevents firing twice during double-click
    if (e.detail === 1) {
      onRowClick?.(item, index);
    }
  }, [onRowClick]);

  // Handle double-click directly
  const handleRowDoubleClick = useCallback((item: T, index: number) => {
    onRowDoubleClick?.(item, index);
  }, [onRowDoubleClick]);

  // Handle mouse enter on row
  const handleRowMouseEnter = useCallback((item: T, index: number) => {
    onRowHoverRef.current?.(item, index);
  }, []);

  // Handle mouse leave on row - only clear hover when leaving the table entirely
  // This prevents flicker when moving between rows
  const handleRowMouseLeave = useCallback((e: React.MouseEvent<HTMLTableRowElement>) => {
    // Check if relatedTarget (where mouse is going) is still within the table
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    if (relatedTarget) {
      // Check if we're moving to another row in the same tbody
      const parentTbody = e.currentTarget.parentElement;
      if (parentTbody && parentTbody.contains(relatedTarget)) {
        // Moving to another row, don't clear hover (mouseenter on new row will update it)
        return;
      }
    }
    // Actually leaving the table, clear hover
    onRowHoverRef.current?.(null, null);
  }, []);

  // Handle keyboard navigation in cells
  const handleCellKeyDown = useCallback((
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    columnIndex: number
  ) => {
    if (e.key === 'Enter') {
      e.preventDefault();

      const targetRowIndex = e.shiftKey ? rowIndex - 1 : rowIndex + 1;

      // Stay at boundary (no wrap)
      if (targetRowIndex < 0 || targetRowIndex >= data.length) {
        return;
      }

      // Find the input in the target row at the same column
      const targetRow = rowRefs.current.get(targetRowIndex);
      if (targetRow) {
        const cells = targetRow.querySelectorAll('td');
        const targetCell = cells[columnIndex];
        if (targetCell) {
          const input = targetCell.querySelector('input');
          if (input) {
            input.focus();
            input.select();
          }
        }
      }
    }
  }, [data.length]);

  // Get default row styling (for <tr> element)
  const getRowClassName = (item: T, isSelected: boolean, isHovered: boolean): string => {
    if (rowClassName) {
      return rowClassName(item, isSelected, isHovered);
    }

    // Default styling: hovered has subtle background
    const classes: string[] = [];

    // External hover state takes precedence, otherwise use default hover:bg-accent/10
    if (isHovered) {
      classes.push('bg-accent/10');
    } else if (hoveredKey === undefined) {
      // Only add hover:bg-accent/10 when no external hover state is being managed
      classes.push('hover:bg-accent/10');
    }

    if (onRowClick || onRowDoubleClick) {
      classes.push('cursor-pointer');
    }

    return classes.join(' ');
  };

  // Get first cell class for selection indicator (gradient pseudo-element bar)
  const getFirstCellSelectionClass = (isSelected: boolean): string => {
    if (isSelected) {
      return 'selected-cell-indicator';
    }
    return '';
  };

  return (
    <div className={`overflow-auto ${className}`}>
      <table className="w-full">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`
                  sticky top-0 bg-panel z-10
                  ${alignmentClasses[column.align ?? 'left']}
                `}
                style={{ width: column.width }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="text-center text-text-secondary py-8"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((item, index) => {
              const key = item[keyField];
              const isSelected = key === selectedKey;
              const isHovered = key === hoveredKey;

              return (
                <tr
                  key={String(key)}
                  ref={(el) => {
                    if (el) {
                      rowRefs.current.set(index, el);
                    } else {
                      rowRefs.current.delete(index);
                    }
                  }}
                  className={getRowClassName(item, isSelected, isHovered)}
                  onClick={(e) => handleRowClick(e, item, index)}
                  onDoubleClick={() => handleRowDoubleClick(item, index)}
                  onMouseEnter={() => handleRowMouseEnter(item, index)}
                  onMouseLeave={handleRowMouseLeave}
                  data-testid={`table-row-${String(key)}`}
                >
                  {columns.map((column, columnIndex) => {
                    const isEditable = editableColumns.includes(column.key);
                    // Use getValue for virtual columns, otherwise access property directly
                    const value = column.getValue
                      ? column.getValue(item)
                      : (item as Record<string, unknown>)[column.key];
                    const isFirstColumn = columnIndex === 0;
                    // Apply formatValue if provided, otherwise stringify
                    const displayValue = column.formatValue
                      ? column.formatValue(value)
                      : String(value ?? '');

                    return (
                      <td
                        key={column.key}
                        className={`p-0 ${alignmentClasses[column.align ?? 'left']} ${isFirstColumn ? getFirstCellSelectionClass(isSelected) : ''}`}
                        data-selected={isFirstColumn && isSelected ? 'true' : undefined}
                      >
                        {column.render ? (
                          column.render(item, index)
                        ) : isEditable ? (
                          <input
                            type={column.inputType ?? 'text'}
                            step={column.inputStep}
                            value={displayValue}
                            onChange={(e) =>
                              handleInputChange(item, column.key, e.target.value, index)
                            }
                            onKeyDown={(e) => handleCellKeyDown(e, index, columnIndex)}
                            className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel ${alignmentClasses[column.align ?? 'left']} ${column.inputType === 'number' ? 'tabular-nums' : ''}`}
                            data-testid={`table-cell-${String(key)}-${column.key}`}
                          />
                        ) : (
                          <span className="px-2 py-1 inline-block">
                            {displayValue}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
