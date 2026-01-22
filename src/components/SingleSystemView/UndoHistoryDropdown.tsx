import { useState, useRef, useEffect, useCallback } from 'react';
import { formatDistanceToNow, isValid, parseISO, differenceInDays, format } from 'date-fns';
import { useProjectStore } from '../../store/projectStore';
import type { UndoHistoryItem } from '../../types/commands';

interface UndoHistoryDropdownProps {
  /** 'undo' for undo button, 'redo' for redo button */
  mode: 'undo' | 'redo';
  /** Whether the button should be enabled */
  disabled: boolean;
  /** Trigger button content */
  children: React.ReactNode;
  /** Callback when single undo/redo is triggered */
  onSingleAction: () => void;
  /** Test ID prefix for data-testid attributes */
  testId: string;
}

/** Map command types to icon characters (matching toolbar icon style) */
function getCommandIcon(commandType: string): string {
  switch (commandType) {
    case 'create_section':
      return '+';
    case 'update_shot':
    case 'update_section_metadata':
      return '✏';
    case 'delete_section':
    case 'delete_shot':
      return '✕';
    case 'merge_stations':
      return '⊕';
    case 'batch':
      return '▤';
    case 'create_shot':
      return '+';
    case 'set_zero_datum':
      return '◉';
    case 'remove_zero_datum':
      return '○';
    case 'move_section':
    case 'move_station':
      return '↔';
    case 'unmerge_stations':
      return '⊖';
    case 'set_shot_virtual':
      return '┄';
    default:
      return '•';
  }
}

/** Format timestamp for display using date-fns for consistent cross-runtime support */
function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return 'Unknown';
  }

  const date = parseISO(timestamp);
  if (!isValid(date)) {
    return 'Unknown';
  }

  const now = new Date();
  const daysDiff = differenceInDays(now, date);

  if (daysDiff < 1) {
    // Less than 1 day - show relative time
    return formatDistanceToNow(date, { addSuffix: true });
  } else {
    // 1 day or older - show date with time using date-fns format
    return format(date, 'MMM d, h:mm a');
  }
}

/** Truncate description to ~40 chars with ellipsis */
function truncateDescription(description: string, maxLength = 40): string {
  if (description.length <= maxLength) {
    return description;
  }
  return description.slice(0, maxLength - 1) + '…';
}

export default function UndoHistoryDropdown({
  mode,
  disabled,
  children,
  onSingleAction,
  testId,
}: UndoHistoryDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [items, setItems] = useState<UndoHistoryItem[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Token to detect stale hover callbacks (incremented on any close)
  const hoverTokenRef = useRef(0);
  // Track disabled in a ref to avoid closure issues
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const { getUndoStack, getRedoStack, undoTo, redoTo } = useProjectStore();

  // Centralized "hard close" helper that cancels all timers and closes
  const hardClose = useCallback(() => {
    // Increment token to invalidate any pending hover callback
    hoverTokenRef.current += 1;

    // Clear any pending hover timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }

    // Clear any pending leave timeout
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }

    setIsOpen(false);
  }, []);

  // Fetch stack data and return it (single fetch, no double call)
  const fetchStack = useCallback(async (): Promise<UndoHistoryItem[]> => {
    try {
      const stack = mode === 'undo' ? await getUndoStack() : await getRedoStack();
      setItems(stack);
      return stack;
    } catch (error) {
      console.error(`Failed to fetch ${mode} stack:`, error);
      setItems([]);
      return [];
    }
  }, [mode, getUndoStack, getRedoStack]);

  // Open dropdown with delay
  const openDropdown = useCallback(() => {
    if (disabledRef.current) return;

    // Clear any pending leave timeout
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }

    // Capture current token to detect if mouse left before timeout fires
    const currentToken = hoverTokenRef.current;

    // Set hover timeout for 300ms delay
    hoverTimeoutRef.current = setTimeout(async () => {
      // Bail out if token changed (any close path was triggered) or disabled is now true
      if (hoverTokenRef.current !== currentToken || disabledRef.current) {
        return;
      }

      try {
        // Single fetch - use returned stack to decide whether to open
        const stack = await fetchStack();

        // Re-check token and disabled after async operation
        if (hoverTokenRef.current !== currentToken || disabledRef.current) {
          return;
        }

        // Only open if there are items
        if (stack.length > 0) {
          setIsOpen(true);
        }
      } catch {
        // Error already logged in fetchStack
      }
    }, 300);
  }, [fetchStack]);

  // Close dropdown with small delay buffer (for mouse leave)
  const closeDropdown = useCallback((event?: React.MouseEvent) => {
    // If we have a related target, check if we're moving within the component
    if (event?.relatedTarget && containerRef.current) {
      const relatedTarget = event.relatedTarget as Node;
      if (containerRef.current.contains(relatedTarget)) {
        // Moving within the component, don't close
        return;
      }
    }

    // Increment token to invalidate any pending hover callback
    hoverTokenRef.current += 1;

    // Clear any pending hover timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }

    // Clear any existing leave timeout before scheduling new one
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }

    // Small delay before closing to allow moving within component
    leaveTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 100);
  }, []);

  // Cancel close if entering dropdown
  const cancelClose = useCallback(() => {
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
  }, []);

  // Handle item click with index validation
  const handleItemClick = useCallback(async (index: number) => {
    // Validate index before sending to backend
    if (!Number.isInteger(index) || index < 0) {
      console.error('Invalid undo/redo index:', index);
      return;
    }
    // Hard close before action to prevent any race conditions
    hardClose();
    const action = mode === 'undo' ? undoTo : redoTo;
    await action(index);
  }, [mode, undoTo, redoTo, hardClose]);

  // Handle button click (single undo/redo) - cancel pending hover and close
  const handleButtonClick = useCallback(() => {
    if (!disabledRef.current) {
      // Hard close to cancel any pending hover timer and close dropdown
      hardClose();
      onSingleAction();
    }
  }, [onSingleAction, hardClose]);

  // Close on Escape - use hardClose
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hardClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, hardClose]);

  // Close on Ctrl+Z/Y keyboard shortcuts (only when open) - use hardClose
  useEffect(() => {
    if (!isOpen) return;

    const handleShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isUndo = (event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey;
      const isRedo = (event.ctrlKey || event.metaKey) && (key === 'y' || (key === 'z' && event.shiftKey));

      if (isUndo || isRedo) {
        hardClose();
      }
    };

    document.addEventListener('keydown', handleShortcut);
    return () => {
      document.removeEventListener('keydown', handleShortcut);
    };
  }, [isOpen, hardClose]);

  // Close on click outside - use hardClose
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        hardClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, hardClose]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      if (leaveTimeoutRef.current) {
        clearTimeout(leaveTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={openDropdown}
      onMouseLeave={closeDropdown}
    >
      <button
        onClick={handleButtonClick}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className={`
          px-3 py-1.5 text-sm rounded transition-colors
          ${disabled
            ? 'opacity-50 cursor-not-allowed'
            : 'bg-background hover:bg-background/80'
          }
        `}
        data-testid={testId}
      >
        {children}
      </button>

      {isOpen && (
        <div
          className="absolute left-0 top-full mt-1 w-72 bg-panel border border-border rounded-lg shadow-lg z-50"
          role="menu"
          data-dropdown-open
          data-testid={`${testId}-dropdown`}
          onMouseEnter={cancelClose}
        >
          <div className="px-3 py-2 text-xs font-medium text-text-secondary uppercase tracking-wide border-b border-border">
            {mode === 'undo' ? 'Undo History' : 'Redo History'}
          </div>

          <div
            className="overflow-y-auto undo-history-scrollable"
            style={{
              // Each item is ~44px (py-1.5 = 6px*2 + line-height ~20px*2 = ~52px, but flex shrinks it)
              // 10 items * ~44px = 440px; add some buffer
              maxHeight: '440px',
            }}
          >
            {items.length === 0 ? (
              <div className="px-3 py-4 text-center text-text-secondary text-sm">
                No {mode} history
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.index}
                  role="menuitem"
                  onClick={() => handleItemClick(item.index)}
                  className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-background/50 transition-colors text-left"
                  data-testid={`${testId}-item-${item.index}`}
                >
                  {/* Icon */}
                  <span className="w-5 h-5 flex items-center justify-center text-sm shrink-0">
                    {getCommandIcon(item.commandType)}
                  </span>

                  {/* Description and timestamp */}
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-sm text-text-primary truncate"
                      title={item.description}
                    >
                      {truncateDescription(item.description)}
                    </div>
                    <div className="text-xs text-text-secondary">
                      {formatTimestamp(item.timestamp)}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* CSS for auto-hide scrollbar */}
      <style>{`
        .undo-history-scrollable {
          scrollbar-width: thin;
          scrollbar-color: transparent transparent;
        }
        .undo-history-scrollable:hover {
          scrollbar-color: var(--color-border) transparent;
        }
        .undo-history-scrollable::-webkit-scrollbar {
          width: 6px;
        }
        .undo-history-scrollable::-webkit-scrollbar-track {
          background: transparent;
        }
        .undo-history-scrollable::-webkit-scrollbar-thumb {
          background-color: transparent;
          border-radius: 3px;
        }
        .undo-history-scrollable:hover::-webkit-scrollbar-thumb {
          background-color: var(--color-border);
        }
      `}</style>
    </div>
  );
}
