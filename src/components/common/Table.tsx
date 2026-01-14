import { type ReactNode } from 'react';

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
}: EditableTableProps<T>) {
  const alignmentClasses = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };

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
                  className={isSelected ? 'bg-accent/20' : ''}
                >
                  {columns.map((column) => {
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
                            className="w-full px-2 py-1 bg-transparent border-none focus:bg-panel"
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
