import { type ReactNode, useRef, useEffect, useCallback, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CheckIcon } from './icons';

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
  /** Input mode: 'text' (default) renders an <input>, 'textarea' renders a <textarea> for multiline editing */
  inputMode?: 'text' | 'textarea';
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
                    ${isSelected ? 'bg-accent-20' : ''}
                  `}
                  onClick={() => onRowClick?.(item, index)}
                  data-selected={isSelected ? 'true' : undefined}
                >
                  {columns.map((column, columnIndex) => {
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
                        className={`${alignmentClasses[column.align ?? 'left']} ${isFirstColumn && isSelected ? 'selected-cell-indicator' : ''}`}
                        data-selected={isFirstColumn && isSelected ? 'true' : undefined}
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

/**
 * EditableCell - Input that uses local state while editing and commits on blur/Enter.
 * Prevents lag and multiple undo events when typing.
 */
interface EditableCellProps {
  value: string;
  /** Raw (unformatted) value shown when editing. When omitted, value is used. */
  rawValue?: string;
  onCommit: (value: string) => void;
  inputType?: 'text' | 'number' | undefined;
  inputStep?: string | undefined;
  align?: 'left' | 'center' | 'right' | undefined;
  testId?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  /** When 'textarea', renders a multiline <textarea> instead of <input> */
  inputMode?: 'text' | 'textarea' | undefined;
}

function EditableCell({
  value,
  rawValue,
  onCommit,
  inputType = 'text',
  inputStep,
  align = 'left',
  testId,
  onKeyDown,
  inputMode = 'text',
}: EditableCellProps) {
  const isTextarea = inputMode === 'textarea';
  const editValue = rawValue ?? value;
  const [localValue, setLocalValue] = useState(editValue);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Track if we just committed (to prevent double commit on Enter then blur)
  const justCommittedRef = useRef(false);
  // Track the last raw value to detect external changes (undo/redo)
  const lastEditValueRef = useRef(editValue);

  // Sync local state when external value changes (e.g., undo/redo)
  useEffect(() => {
    if (editValue !== lastEditValueRef.current) {
      if (focused) {
        setLocalValue(editValue);
      }
      lastEditValueRef.current = editValue;
    }
  }, [editValue, focused]);

  const alignmentClasses = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };

  const handleFocus = useCallback(() => {
    setFocused(true);
    setLocalValue(editValue);
  }, [editValue]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    // Skip if we just committed via Enter (prevents double commit)
    if (justCommittedRef.current) {
      justCommittedRef.current = false;
      return;
    }
    // Only commit if value actually changed from original
    if (localValue !== lastEditValueRef.current) {
      lastEditValueRef.current = localValue;
      onCommit(localValue);
    }
  }, [localValue, onCommit]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Commit on Enter if value changed
      if (localValue !== lastEditValueRef.current) {
        justCommittedRef.current = true;
        lastEditValueRef.current = localValue;
        onCommit(localValue);
      }
    } else if (e.key === 'Escape') {
      // Revert on Escape
      setLocalValue(lastEditValueRef.current);
      inputRef.current?.blur();
    }
    // Pass to parent handler for navigation
    onKeyDown?.(e);
  }, [localValue, onCommit, onKeyDown]);

  const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      // Revert on Escape
      setLocalValue(lastEditValueRef.current);
      textareaRef.current?.blur();
    } else if (e.key === 'Tab') {
      // Tab commits and moves to next cell (handled by parent)
      if (localValue !== lastEditValueRef.current) {
        justCommittedRef.current = true;
        lastEditValueRef.current = localValue;
        onCommit(localValue);
      }
      // Parent handler expects HTMLInputElement | HTMLTextAreaElement union
      onKeyDown?.(e as React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>);
    }
    // Enter = newline (default textarea behavior, no preventDefault)
  }, [localValue, onCommit, onKeyDown]);

  // Show formatted value when blurred, local edit value when focused
  const displayedValue = focused ? localValue : value;

  // Commit from the check button — mark as committed so blur doesn't double-fire
  const handleTextareaCommitClick = useCallback(() => {
    if (localValue !== lastEditValueRef.current) {
      justCommittedRef.current = true;
      lastEditValueRef.current = localValue;
      onCommit(localValue);
    }
    textareaRef.current?.blur();
  }, [localValue, onCommit]);

  // Fixed-position overlay coordinates for textarea (escapes overflow clipping)
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [overlayStyle, setOverlayStyle] = useState<React.CSSProperties>({});

  const handleTextareaFocus = useCallback(() => {
    handleFocus();
    // Calculate fixed position from the wrapper's bounding rect
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (rect) {
      const TEXTAREA_HEIGHT = 4 * 24; // ~4 rows
      setOverlayStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        // Expand upward from the bottom of the cell
        top: rect.bottom - TEXTAREA_HEIGHT,
        height: TEXTAREA_HEIGHT,
      });
    }
  }, [handleFocus]);

  if (isTextarea) {
    return (
      <div ref={wrapperRef} className="w-full">
        {focused ? (
          <>
            <textarea
              ref={textareaRef}
              value={displayedValue}
              onChange={(e) => setLocalValue(e.target.value)}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleTextareaKeyDown}
              className={`px-2 py-1 border-none resize-none z-50 bg-panel shadow-lg ring-1 ring-accent ${alignmentClasses[align]}`}
              style={overlayStyle}
              data-testid={testId}
            />
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                handleTextareaCommitClick();
              }}
              className="fixed z-50 p-0.5 rounded bg-accent text-white hover:bg-accent-hover"
              style={{
                left: (overlayStyle.left as number) + (overlayStyle.width as number) - 22,
                top: (overlayStyle.top as number) + (overlayStyle.height as number) - 22,
              }}
              title="Save comment"
            >
              <CheckIcon size={14} />
            </button>
          </>
        ) : (
          <textarea
            ref={textareaRef}
            value={displayedValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onFocus={handleTextareaFocus}
            onBlur={handleBlur}
            onKeyDown={handleTextareaKeyDown}
            rows={1}
            className={`w-full px-2 py-1 border-none resize-none bg-transparent ${alignmentClasses[align]}`}
            data-testid={testId}
          />
        )}
      </div>
    );
  }

  return (
    <input
      ref={inputRef}
      type={inputType}
      step={inputStep}
      value={displayedValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleInputKeyDown}
      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel ${alignmentClasses[align]} ${inputType === 'number' ? 'tabular-nums' : ''}`}
      data-testid={testId}
    />
  );
}

interface EditableTableProps<T> extends Omit<TableProps<T>, 'onRowClick'> {
  onCellEdit?: (item: T, key: string, value: unknown, index: number) => void;
  editableColumns?: string[];
  /** Return false to render all cells as read-only text for this row */
  isRowEditable?: (item: T, index: number) => boolean;
  // Row interaction props
  onRowClick?: (item: T, index: number) => void;
  onRowDoubleClick?: (item: T, index: number) => void;
  onRowContextMenu?: (item: T, index: number, event: React.MouseEvent) => void;
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
  isRowEditable,
  selectedKey,
  className = '',
  emptyMessage = 'No data',
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const ROW_HEIGHT = 33;
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  // Store callbacks in refs to avoid stale closures
  const onRowHoverRef = useRef(onRowHover);

  useEffect(() => {
    onRowHoverRef.current = onRowHover;
  }, [onRowHover]);

  // Scroll to row when scrollToKey changes (external selection from map/panels)
  useEffect(() => {
    if (scrollToKey == null) return;

    const index = data.findIndex((item) => item[keyField] === scrollToKey);
    if (index === -1) return;

    // Use 'center' to place the target row in the middle of the viewport.
    // 'auto' doesn't account for the sticky thead, causing off-by-N errors.
    virtualizer.scrollToIndex(index, { align: 'center' });
    // Retry after virtualizer has measured (needed on fresh mount after view switch)
    const timer = setTimeout(() => {
      virtualizer.scrollToIndex(index, { align: 'center' });
    }, 50);
    return () => clearTimeout(timer);
  }, [scrollToKey, data, keyField, virtualizer]);

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
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
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

      // Ensure target row is visible
      virtualizer.scrollToIndex(targetRowIndex, { align: 'auto' });

      // Focus after render (row may not be in DOM yet)
      requestAnimationFrame(() => {
        const targetRow = rowRefs.current.get(targetRowIndex);
        if (targetRow) {
          const cells = targetRow.querySelectorAll('td');
          const targetCell = cells[columnIndex];
          if (targetCell) {
            const input = targetCell.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
            if (input) {
              input.focus();
              if (input instanceof HTMLInputElement) {
                input.select();
              }
            }
          }
        }
      });
    }
  }, [data.length, virtualizer]);

  // Get default row styling (for <tr> element)
  const getRowClassName = (item: T, isSelected: boolean, isHovered: boolean): string => {
    if (rowClassName) {
      return rowClassName(item, isSelected, isHovered);
    }

    // Default styling: hovered has subtle background
    const classes: string[] = [];

    if (isSelected) {
      classes.push('bg-accent-20');
    } else if (isHovered) {
      classes.push('bg-accent-10');
    } else if (hoveredKey === undefined) {
      // Only add hover:bg-accent-10 when no external hover state is being managed
      classes.push('hover:bg-accent-10');
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

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const paddingBottom = virtualRows.length > 0
    ? totalSize - virtualRows[virtualRows.length - 1]!.end
    : 0;

  return (
    <div ref={scrollContainerRef} className={`overflow-auto h-full ${className}`}>
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
          {paddingTop > 0 && (
            <tr data-spacer><td colSpan={columns.length} style={{ height: paddingTop, padding: 0, border: 'none' }} /></tr>
          )}
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
            virtualRows.map((virtualRow) => {
              const index = virtualRow.index;
              const item = data[index]!;
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
                  onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(item, index, e) : undefined}
                  onMouseEnter={() => handleRowMouseEnter(item, index)}
                  onMouseLeave={handleRowMouseLeave}
                  data-testid={`table-row-${String(key)}`}
                  data-selected={isSelected ? 'true' : undefined}
                >
                  {columns.map((column, columnIndex) => {
                    const rowEditable = isRowEditable ? isRowEditable(item, index) : true;
                    const isEditable = rowEditable && editableColumns.includes(column.key);
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
                          <EditableCell
                            value={displayValue}
                            {...(column.formatValue ? { rawValue: String(value ?? '') } : {})}
                            onCommit={(value) => handleInputChange(item, column.key, value, index)}
                            inputType={column.inputType}
                            inputStep={column.inputStep}
                            align={column.align}
                            testId={`table-cell-${String(key)}-${column.key}`}
                            onKeyDown={(e) => handleCellKeyDown(e, index, columnIndex)}
                            inputMode={column.inputMode}
                          />
                        ) : (
                          <span className="px-2 py-1 inline-block select-text">
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
          {paddingBottom > 0 && (
            <tr data-spacer><td colSpan={columns.length} style={{ height: paddingBottom, padding: 0, border: 'none' }} /></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
