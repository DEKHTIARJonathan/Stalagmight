import { type ReactNode, useState, useRef, useCallback, useEffect } from 'react';

interface PanelProps {
  title?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  headerActions?: ReactNode;
}

export function Panel({
  title,
  children,
  collapsible = false,
  defaultOpen = true,
  className = '',
  headerActions,
}: PanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`bg-panel border border-border rounded ${className}`}>
      {title && (
        <div
          className={`
            flex items-center justify-between px-3 py-2 border-b border-border
            ${collapsible ? 'cursor-pointer hover:bg-background/50' : ''}
          `}
          onClick={collapsible ? () => setIsOpen(!isOpen) : undefined}
        >
          <div className="flex items-center gap-2">
            {collapsible && (
              <span className="text-text-secondary">
                {isOpen ? '▼' : '▶'}
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
  className?: string;
}

export function ResizablePanel({
  children,
  direction,
  minSize = 100,
  maxSize = 600,
  defaultSize = 250,
  onResize,
  className = '',
}: ResizablePanelProps) {
  const [size, setSize] = useState(defaultSize);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing || !panelRef.current) return;

      const rect = panelRef.current.getBoundingClientRect();
      let newSize: number;

      if (direction === 'horizontal') {
        newSize = e.clientX - rect.left;
      } else {
        newSize = rect.bottom - e.clientY;
      }

      newSize = Math.max(minSize, Math.min(maxSize, newSize));
      setSize(newSize);
      onResize?.(newSize);
    },
    [isResizing, direction, minSize, maxSize, onResize]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
    return undefined;
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const style = direction === 'horizontal' ? { width: size } : { height: size };
  const handleStyle = direction === 'horizontal'
    ? 'right-0 top-0 w-1 h-full cursor-ew-resize'
    : 'bottom-0 left-0 h-1 w-full cursor-ns-resize';

  return (
    <div
      ref={panelRef}
      className={`relative flex-shrink-0 ${className}`}
      style={style}
    >
      {children}
      <div
        className={`absolute bg-transparent hover:bg-accent/50 transition-colors ${handleStyle}`}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}
