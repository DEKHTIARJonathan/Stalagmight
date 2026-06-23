import { type ReactNode, useState, useRef, useCallback } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from './icons';
import { useResizingFlag } from '../../hooks/useResizingFlag';

interface PanelProps {
  title?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  headerActions?: ReactNode;
  /** Drop the outer card border + rounding (the title divider is kept). Used
   *  where the surrounding container is already the visual frame. */
  bare?: boolean;
}

export function Panel({
  title,
  children,
  collapsible = false,
  defaultOpen = true,
  className = '',
  headerActions,
  bare = false,
}: PanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`bg-panel ${bare ? '' : 'border border-border rounded'} ${className}`}>
      {title && (
        <div
          className={`
            flex items-center justify-between px-3 py-2 border-b border-border
            ${collapsible ? 'cursor-pointer hover:bg-background-50' : ''}
          `}
          onClick={collapsible ? () => setIsOpen(!isOpen) : undefined}
        >
          <div className="flex items-center gap-2">
            {collapsible && (
              <span className="text-text-secondary">
                {isOpen ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
              </span>
            )}
            <h3 className="font-medium text-text-primary">{title}</h3>
          </div>
          {headerActions && (
            <div onClick={(e) => e.stopPropagation()}>{headerActions}</div>
          )}
        </div>
      )}
      {(!collapsible || isOpen) && (
        <div className="p-3">{children}</div>
      )}
    </div>
  );
}

interface ResizablePanelProps {
  children: ReactNode;
  direction: 'horizontal' | 'vertical';
  minSize?: number;
  maxSize?: number;
  defaultSize?: number;
  onResize?: (size: number) => void;
  /** Called when resize operation completes (mouse up) */
  onResizeEnd?: (size: number) => void;
  className?: string;
  /** For horizontal panels: which edge to put the resize handle on */
  handlePosition?: 'start' | 'end';
}

export function ResizablePanel({
  children,
  direction,
  minSize = 100,
  maxSize = 600,
  defaultSize = 250,
  onResize,
  onResizeEnd,
  className = '',
  handlePosition = 'end',
}: ResizablePanelProps) {
  const [size, setSize] = useState(defaultSize);
  // `isResizing` drives the handle highlight; the pointer handlers gate on the
  // ref so the first pointermove after pointerdown isn't dropped (see
  // useResizingFlag).
  const { isResizing, isResizingRef, beginResizing, endResizing } = useResizingFlag();
  const panelRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef(size);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    // Capture pointer so all subsequent events arrive on this element
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    beginResizing();
  }, [beginResizing]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizingRef.current || !panelRef.current) return;

      const rect = panelRef.current.getBoundingClientRect();
      let newSize: number;

      if (direction === 'horizontal') {
        if (handlePosition === 'end') {
          newSize = e.clientX - rect.left;
        } else {
          newSize = rect.right - e.clientX;
        }
      } else {
        newSize = rect.bottom - e.clientY;
      }

      newSize = Math.max(minSize, Math.min(maxSize, newSize));
      setSize(newSize);
      sizeRef.current = newSize;
      onResize?.(newSize);
    },
    [isResizingRef, direction, handlePosition, minSize, maxSize, onResize]
  );

  const handlePointerUp = useCallback(() => {
    if (!isResizingRef.current) return;
    onResizeEnd?.(sizeRef.current);
    endResizing();
  }, [isResizingRef, onResizeEnd, endResizing]);

  const style = direction === 'horizontal' ? { width: size } : { height: size };

  // Handle styling based on direction and position
  // Using w-1 but with padding to make it easier to grab (total 8px hit area)
  let handleStyle: string;
  let handleClass: string;
  if (direction === 'horizontal') {
    handleClass = 'resize-handle-h';
    if (handlePosition === 'end') {
      handleStyle = 'right-0 top-0 w-1 h-full cursor-ew-resize -mr-1 px-1';
    } else {
      handleStyle = 'left-0 top-0 w-1 h-full cursor-ew-resize -ml-1 px-1';
    }
  } else {
    handleClass = 'resize-handle-v';
    handleStyle = 'top-0 left-0 h-1 w-full cursor-ns-resize -mt-1 py-1';
  }

  return (
    <div
      ref={panelRef}
      className={`relative flex-shrink-0 ${className}`}
      style={style}
    >
      {children}
      <div
        className={`absolute bg-transparent hover:bg-accent-50 transition-colors ${handleClass} ${handleStyle} ${isResizing ? 'bg-accent-50' : ''}`}
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className={direction === 'horizontal' ? 'w-full h-full' : 'w-full h-full'} />
      </div>
    </div>
  );
}
