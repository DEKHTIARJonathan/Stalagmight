import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { formatDistanceToNow, isValid, parseISO, differenceInDays, format } from 'date-fns';
import { useProjectStore } from '../../store/projectStore';
import type { UndoHistoryItem, PreviewData } from '../../types/commands';

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

interface DetailPreviewPopupProps {
  previewData: PreviewData | null;
  anchorRect: DOMRect;
  dropdownRect: DOMRect;
}

/** Detail preview popup showing field changes */
function DetailPreviewPopup({ previewData, anchorRect, dropdownRect }: DetailPreviewPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<'right' | 'left'>('right');

  // Calculate position on mount and when anchor changes
  useEffect(() => {
    const popupWidth = 220; // Approximate width of preview popup
    const padding = 8; // Gap between dropdown and preview
    const viewportWidth = window.innerWidth;

    // Calculate position to the right of the dropdown
    const rightEdge = dropdownRect.right + padding + popupWidth;

    // Flip to left if would overflow right edge
    if (rightEdge > viewportWidth) {
      setPosition('left');
    } else {
      setPosition('right');
    }
  }, [dropdownRect]);

  // If no preview data, show "No details" message
  const hasChanges = previewData && previewData.changes.length > 0;

  // Calculate actual position
  const style: React.CSSProperties = {
    position: 'fixed',
    top: anchorRect.top,
    zIndex: 60, // Above dropdown (z-50)
    ...(position === 'right'
      ? { left: dropdownRect.right + 8 }
      : { right: window.innerWidth - dropdownRect.left + 8 }),
  };

  return createPortal(
    <div
      ref={popupRef}
      className="detail-preview-popup bg-panel border border-border rounded-lg shadow-lg p-3 w-[220px]"
      style={style}
      data-testid="detail-preview-popup"
    >
      {!hasChanges ? (
        <div className="text-sm text-text-secondary">No details</div>
      ) : (
        <>
          <div className="space-y-2">
            {previewData.changes.map((change, idx) => (
              <div key={idx} className="text-xs">
                <div className="text-text-secondary font-medium mb-0.5">
                  {change.field}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-text-primary truncate max-w-[70px]" title={change.oldValue}>
                    {change.oldValue || '(empty)'}
                  </span>
                  <span className="text-text-secondary shrink-0">→</span>
                  <span className="text-text-primary truncate max-w-[70px]" title={change.newValue}>
                    {change.newValue || '(empty)'}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {previewData.additionalChanges > 0 && (
            <div className="mt-2 pt-2 border-t border-border text-xs text-text-secondary">
              +{previewData.additionalChanges} more
            </div>
          )}
        </>
      )}
    </div>,
    document.body
  );
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
  // State for preview popup
  const [hoveredItem, setHoveredItem] = useState<UndoHistoryItem | null>(null);
  const [hoveredItemRect, setHoveredItemRect] = useState<DOMRect | null>(null);
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  // State for keyboard navigation - index into items array (-1 = none)
  const [activeIndex, setActiveIndex] = useState(-1);
  // Separate hover highlight index (does not trigger focus stealing)
  const [hoverIndex, setHoverIndex] = useState(-1);
  // Flag to track if dropdown was opened via keyboard (for focus management)
  const keyboardNavActiveRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardOpenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Token to detect stale hover callbacks (incremented on any close)
  const hoverTokenRef = useRef(0);
  // Track disabled in a ref to avoid closure issues
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // Unique ID for ARIA attributes
  const menuId = useId();

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

    // Clear any pending keyboard open timeout
    if (keyboardOpenTimeoutRef.current) {
      clearTimeout(keyboardOpenTimeoutRef.current);
      keyboardOpenTimeoutRef.current = null;
    }

    // Clear hovered item state
    setHoveredItem(null);
    setHoveredItemRect(null);
    setDropdownRect(null);

    // Reset keyboard navigation state
    setActiveIndex(-1);
    setHoverIndex(-1);
    keyboardNavActiveRef.current = false;

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
      // Reset all navigation state on close
      setActiveIndex(-1);
      setHoverIndex(-1);
      keyboardNavActiveRef.current = false;
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

  // Handle item hover - show preview popup immediately (no delay per spec)
  const handleItemHover = useCallback((item: UndoHistoryItem, event: React.MouseEvent<HTMLButtonElement>) => {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const dropdown = dropdownRef.current;
    if (dropdown) {
      setDropdownRect(dropdown.getBoundingClientRect());
    }
    setHoveredItemRect(rect);
    setHoveredItem(item);
  }, []);

  // Handle item leave - clear preview
  const handleItemLeave = useCallback(() => {
    setHoveredItem(null);
    setHoveredItemRect(null);
  }, []);

  // Scroll active item into view
  const scrollActiveItemIntoView = useCallback((index: number) => {
    if (!scrollContainerRef.current || index < 0) return;
    const container = scrollContainerRef.current;
    const itemId = `${menuId}-item-${index}`;
    const itemElement = container.querySelector(`[id="${itemId}"]`) as HTMLElement | null;
    if (itemElement) {
      itemElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [menuId]);

  // Handle item click with index validation (defined before keyboard handlers that use it)
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

  // Handle keyboard navigation on trigger button
  const handleButtonKeyDown = useCallback(async (event: React.KeyboardEvent) => {
    // Arrow Down opens dropdown and focuses first item
    if (event.key === 'ArrowDown' && !isOpen && !disabledRef.current) {
      event.preventDefault();
      // Fetch stack and open
      const stack = await fetchStack();
      if (stack.length > 0) {
        // Mark as keyboard navigation for focus management
        keyboardNavActiveRef.current = true;
        setIsOpen(true);
        // Set first item as active after React renders (store timeout for cleanup)
        keyboardOpenTimeoutRef.current = setTimeout(() => {
          setActiveIndex(0);
          scrollActiveItemIntoView(0);
          keyboardOpenTimeoutRef.current = null;
        }, 0);
      }
    }
  }, [isOpen, fetchStack, scrollActiveItemIntoView]);

  // Handle keyboard navigation when dropdown is open
  const handleDropdownKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!isOpen || items.length === 0) return;

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const nextIndex = activeIndex < items.length - 1 ? activeIndex + 1 : 0;
        setActiveIndex(nextIndex);
        scrollActiveItemIntoView(nextIndex);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prevIndex = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
        setActiveIndex(prevIndex);
        scrollActiveItemIntoView(prevIndex);
        break;
      }
      case 'Enter': {
        event.preventDefault();
        const item = items[activeIndex];
        if (item && activeIndex >= 0 && activeIndex < items.length) {
          handleItemClick(item.index);
        }
        break;
      }
      case 'Escape': {
        event.preventDefault();
        hardClose();
        // Return focus to trigger button
        buttonRef.current?.focus();
        break;
      }
      case 'Home': {
        event.preventDefault();
        setActiveIndex(0);
        scrollActiveItemIntoView(0);
        break;
      }
      case 'End': {
        event.preventDefault();
        const lastIndex = items.length - 1;
        setActiveIndex(lastIndex);
        scrollActiveItemIntoView(lastIndex);
        break;
      }
    }
  }, [isOpen, items, activeIndex, handleItemClick, hardClose, scrollActiveItemIntoView]);

  // Handle button click (single undo/redo) - cancel pending hover and close
  const handleButtonClick = useCallback(() => {
    if (!disabledRef.current) {
      // Hard close to cancel any pending hover timer and close dropdown
      hardClose();
      onSingleAction();
    }
  }, [onSingleAction, hardClose]);

  // Close on Escape - use hardClose and return focus to button
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hardClose();
        // Return focus to trigger button for consistent behavior
        buttonRef.current?.focus();
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
      if (keyboardOpenTimeoutRef.current) {
        clearTimeout(keyboardOpenTimeoutRef.current);
      }
    };
  }, []);

  // Focus dropdown when opened via keyboard (only when keyboardNavActiveRef is true)
  useEffect(() => {
    if (isOpen && keyboardNavActiveRef.current && dropdownRef.current) {
      dropdownRef.current.focus();
      // Clear the flag after focusing to prevent re-focusing on hover state changes
      keyboardNavActiveRef.current = false;
    }
  }, [isOpen]);

  // Get the active item ID for aria-activedescendant
  const activeItemId = activeIndex >= 0 && items[activeIndex]
    ? `${menuId}-item-${activeIndex}`
    : undefined;

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={openDropdown}
      onMouseLeave={closeDropdown}
    >
      <button
        ref={buttonRef}
        onClick={handleButtonClick}
        onKeyDown={handleButtonKeyDown}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-controls={isOpen ? `${menuId}-menu` : undefined}
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
          ref={dropdownRef}
          id={`${menuId}-menu`}
          className="absolute left-0 top-full mt-1 w-72 bg-panel border border-border rounded-lg shadow-lg z-50"
          role="menu"
          aria-activedescendant={activeItemId}
          data-dropdown-open
          data-testid={`${testId}-dropdown`}
          onMouseEnter={cancelClose}
          onKeyDown={handleDropdownKeyDown}
          tabIndex={-1}
        >
          <div className="px-3 py-2 text-xs font-medium text-text-secondary uppercase tracking-wide border-b border-border">
            {mode === 'undo' ? 'Undo History' : 'Redo History'}
          </div>

          <div
            ref={scrollContainerRef}
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
              items.map((item, idx) => {
                // Keyboard nav takes precedence; otherwise use hover highlight
                const isKeyboardActive = idx === activeIndex;
                const isHoverActive = idx === hoverIndex;
                const isHighlighted = isKeyboardActive || isHoverActive;
                return (
                  <button
                    key={item.index}
                    id={`${menuId}-item-${idx}`}
                    role="menuitem"
                    onClick={() => handleItemClick(item.index)}
                    onMouseEnter={(e) => {
                      handleItemHover(item, e);
                      // Update hover index for visual highlight (does not affect keyboard nav)
                      setHoverIndex(idx);
                    }}
                    onMouseLeave={() => {
                      handleItemLeave();
                      setHoverIndex(-1);
                    }}
                    className={`
                      w-full px-3 py-1.5 flex items-center gap-2 transition-colors text-left
                      ${isHighlighted ? 'bg-background/50' : 'hover:bg-background/50'}
                    `}
                    data-testid={`${testId}-item-${item.index}`}
                    tabIndex={-1}
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
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Detail preview popup - rendered via portal */}
      {hoveredItem && hoveredItemRect && dropdownRect && (
        <DetailPreviewPopup
          previewData={hoveredItem.previewData}
          anchorRect={hoveredItemRect}
          dropdownRect={dropdownRect}
        />
      )}

      {/* CSS for auto-hide scrollbar and preview animation */}
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

        /* Detail preview popup fade-in animation */
        @keyframes previewFadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .detail-preview-popup {
          animation: previewFadeIn 150ms ease-out;
        }
        /* Respect prefers-reduced-motion */
        @media (prefers-reduced-motion: reduce) {
          .detail-preview-popup {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
