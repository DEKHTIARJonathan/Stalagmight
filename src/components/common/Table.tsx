import { type ReactNode, useRef, useEffect, useCallback } from 'react';

interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render?: (item: T, index: number) => ReactNode;
  align?: 'left' | 'center' | 'right';
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
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={alignmentClasses[column.align ?? 'left']}
                    >
                      {column.render
                        ? column.render(item, index)
                        : String((item as Record<string, unknown>)[column.key] ?? '')}
                    </td>
                  ))}
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
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  // Track pending single-click to distinguish from double-click
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingClickRef = useRef<{ item: T; index: number } | null>(null);

  // Track which column index has focus for keyboard navigation
  const focusedColumnIndexRef = useRef<number>(-1);

  // Store callbacks in refs to avoid stale closures in setTimeout
  const onRowClickRef = useRef(onRowClick);
  const onRowDoubleClickRef = useRef(onRowDoubleClick);
  const onRowHoverRef = useRef(onRowHover);

  useEffect(() => {
    onRowClickRef.current = onRowClick;
  }, [onRowClick]);

  useEffect(() => {
    onRowDoubleClickRef.current = onRowDoubleClick;
  }, [onRowDoubleClick]);

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
    const originalValue = (item as Record<string, unknown>)[key];
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

  // Handle single click with delay to distinguish from double-click
  const handleRowClick = useCallback((item: T, index: number) => {
    // Clear any pending click
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }

    pendingClickRef.current = { item, index };

    clickTimerRef.current = setTimeout(() => {
      if (pendingClickRef.current) {
        onRowClickRef.current?.(pendingClickRef.current.item, pendingClickRef.current.index);
        pendingClickRef.current = null;
      }
      clickTimerRef.current = null;
    }, 200);
  }, []);

  // Handle double-click - cancel pending single click and fire double-click
  const handleRowDoubleClick = useCallback((item: T, index: number) => {
    // Cancel pending single click
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    pendingClickRef.current = null;

    onRowDoubleClickRef.current?.(item, index);
  }, []);

  // Handle mouse enter on row
  const handleRowMouseEnter = useCallback((item: T, index: number) => {
    onRowHoverRef.current?.(item, index);
  }, []);

  // Handle mouse leave on row
  const handleRowMouseLeave = useCallback(() => {
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

      // Remember which column we're in
      focusedColumnIndexRef.current = columnIndex;

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

  // Get default row styling
  const getRowClassName = (item: T, isSelected: boolean, isHovered: boolean): string => {
    if (rowClassName) {
      return rowClassName(item, isSelected, isHovered);
    }

    // Default styling: selected has accent left border, hovered has subtle background
    const classes: string[] = [];

    if (isSelected) {
      classes.push('border-l-3 border-accent');
    } else {
      // Reserve space for border to prevent layout shift
      classes.push('border-l-3 border-transparent');
    }

    if (isHovered && !isSelected) {
      classes.push('bg-accent/10');
    }

    if (onRowClick || onRowDoubleClick) {
      classes.push('cursor-pointer');
    }

    return classes.join(' ');
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
        <tbody ref={tbodyRef}>
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
                  onClick={() => handleRowClick(item, index)}
                  onDoubleClick={() => handleRowDoubleClick(item, index)}
                  onMouseEnter={() => handleRowMouseEnter(item, index)}
                  onMouseLeave={handleRowMouseLeave}
                  data-testid={`table-row-${String(key)}`}
                >
                  {columns.map((column, columnIndex) => {
                    const isEditable = editableColumns.includes(column.key);
                    const value = (item as Record<string, unknown>)[column.key];

                    return (
                      <td
                        key={column.key}
                        className={`p-0 ${alignmentClasses[column.align ?? 'left']}`}
                      >
                        {column.render ? (
                          column.render(item, index)
                        ) : isEditable ? (
                          <input
                            type="text"
                            value={String(value ?? '')}
                            onChange={(e) =>
                              handleInputChange(item, column.key, e.target.value, index)
                            }
                            onKeyDown={(e) => handleCellKeyDown(e, index, columnIndex)}
                            className="w-full px-2 py-1 bg-transparent border-none focus:bg-panel"
                            data-testid={`table-cell-${String(key)}-${column.key}`}
                          />
                        ) : (
                          <span className="px-2 py-1 inline-block">
                            {String(value ?? '')}
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
