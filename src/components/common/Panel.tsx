import { type ReactNode, useState, useRef, useCallback } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from './icons';
import { useResizeHandle } from '../SingleSystemView/useResizeHandle';

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
  // Locally-owned size, seeded from defaultSize and driven by the shared
  // useResizeHandle drag loop (rect math, clamp+round, no-op-drag guard, and the
  // ref/state isResizing dance all live there - one resize implementation).
  const [size, setSize] = useState(defaultSize);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback(
    (next: number) => {
      setSize(next);
      onResize?.(next);
    },
    [onResize],
  );

  const { isResizing, handleProps } = useResizeHandle({
    direction,
    handlePosition,
    minSize,
    maxSize,
    measureRef: panelRef,
    onResize: handleResize,
    onResizeEnd,
  });

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
        {...handleProps}
      >
        <div className={direction === 'horizontal' ? 'w-full h-full' : 'w-full h-full'} />
      </div>
    </div>
  );
}
