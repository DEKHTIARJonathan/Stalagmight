/**
 * Custom Select component with dark theme styling.
 * Replaces native HTML select which has dropdown styling issues in WebView.
 * Dropdown renders via createPortal to document.body with position:fixed
 * to escape stacking contexts (e.g. sticky table headers).
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

interface SelectProps {
  /** Currently selected value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Options to display - can be flat list or grouped */
  options: SelectOption[] | SelectOptionGroup[];
  /** Placeholder text when no value selected */
  placeholder?: string;
  /** Whether the select is disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Test ID for E2E tests */
  'data-testid'?: string;
  /** Accessible label for screen readers */
  'aria-label'?: string;
  /** ID of element that labels this select */
  'aria-labelledby'?: string;
  /** Callback when an option is hovered (mouse or keyboard). Fires null on close. */
  onOptionHover?: (value: string | null) => void;
}

/**
 * Check if options are grouped
 */
function isGroupedOptions(options: SelectOption[] | SelectOptionGroup[]): options is SelectOptionGroup[] {
  return options.length > 0 && options[0] !== undefined && 'options' in options[0];
}

/**
 * Find the label for a value in options
 */
function findLabel(options: SelectOption[] | SelectOptionGroup[], value: string): string | null {
  if (isGroupedOptions(options)) {
    for (const group of options) {
      for (const option of group.options) {
        if (option.value === value) return option.label;
      }
    }
  } else {
    for (const option of options) {
      if (option.value === value) return option.label;
    }
  }
  return null;
}

/**
 * Flatten grouped options into a single array with metadata
 */
interface FlattenedOption extends SelectOption {
  groupLabel?: string;
  isFirstInGroup?: boolean;
}

function flattenOptions(options: SelectOption[] | SelectOptionGroup[]): FlattenedOption[] {
  if (isGroupedOptions(options)) {
    const result: FlattenedOption[] = [];
    for (const group of options) {
      for (let i = 0; i < group.options.length; i++) {
        const opt = group.options[i];
        if (!opt) continue;
        const flatOpt: FlattenedOption = {
          value: opt.value,
          label: opt.label,
          groupLabel: group.label,
          isFirstInGroup: i === 0,
        };
        if (opt.disabled !== undefined) {
          flatOpt.disabled = opt.disabled;
        }
        result.push(flatOpt);
      }
    }
    return result;
  }
  return options.map(opt => {
    const flatOpt: FlattenedOption = {
      value: opt.value,
      label: opt.label,
    };
    if (opt.disabled !== undefined) {
      flatOpt.disabled = opt.disabled;
    }
    return flatOpt;
  });
}

/** Position state for the portaled dropdown */
interface DropdownPosition {
  top: number;
  left: number;
  width: number;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  disabled = false,
  className = '',
  'data-testid': testId,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  onOptionHover,
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  // Trigger rect captured on open so the hidden dropdown can use correct width/left
  // for accurate height measurement before the position is finalized.
  const [triggerRect, setTriggerRect] = useState<{ left: number; width: number; top: number; bottom: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Refs to avoid stale closures in unmount cleanup
  const onOptionHoverRef = useRef(onOptionHover);
  onOptionHoverRef.current = onOptionHover;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  // Unmount cleanup: fire onOptionHover(null) if dropdown was open
  useEffect(() => {
    return () => {
      if (isOpenRef.current) {
        onOptionHoverRef.current?.(null);
      }
    };
  }, []);

  // Generate unique IDs for ARIA
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const getOptionId = (index: number) => `${baseId}-option-${index}`;

  // Flatten options for keyboard navigation
  const flatOptions = flattenOptions(options);

  // Find index of currently selected value
  const findSelectedIndex = useCallback(() => {
    return flatOptions.findIndex(opt => opt.value === value);
  }, [flatOptions, value]);

  // Close dropdown when clicking outside — checks both triggerRef and dropdownRef
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      onOptionHover?.(null);
      setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onOptionHover]);

  // Close on external scroll (not internal dropdown scroll)
  useEffect(() => {
    if (!isOpen) return;

    const handleScroll = (event: Event) => {
      // Ignore scroll events inside the portaled dropdown (user scrolling options,
      // or scrollIntoView from keyboard navigation).
      // Guard: event.target may not be a Node (e.g. window/document in some environments).
      if (
        event.target instanceof Node &&
        dropdownRef.current?.contains(event.target)
      ) {
        return;
      }
      onOptionHoverRef.current?.(null);
      setIsOpen(false);
    };

    window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', handleScroll, { capture: true });
  }, [isOpen]);

  // Close on window resize
  useEffect(() => {
    if (!isOpen) return;

    const handleResize = () => {
      onOptionHoverRef.current?.(null);
      setIsOpen(false);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isOpen]);

  // Position calculation with flicker prevention via useLayoutEffect.
  // The hidden render pass already has correct width/left from triggerRect state,
  // so the measured height accounts for text wrapping at the final width.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRect) {
      setDropdownPosition(null);
      return;
    }

    const dropdownEl = dropdownRef.current;
    if (!dropdownEl) return;

    const dropdownHeight = dropdownEl.getBoundingClientRect().height;

    let top = triggerRect.bottom;

    // Flip upward if insufficient space below
    if (triggerRect.bottom + dropdownHeight > window.innerHeight) {
      top = triggerRect.top - dropdownHeight;
    }

    // Clamp top to >= 0 to prevent overflow above viewport
    top = Math.max(0, top);

    setDropdownPosition({
      top,
      left: triggerRect.left,
      width: triggerRect.width,
    });
  }, [isOpen, triggerRect]);

  // Reset highlighted index when dropdown opens/closes
  useEffect(() => {
    if (isOpen) {
      // When opening, highlight the currently selected option if enabled, otherwise first enabled option
      const selectedIdx = findSelectedIndex();
      const selectedOpt = selectedIdx >= 0 ? flatOptions[selectedIdx] : null;
      if (selectedIdx >= 0 && selectedOpt && !selectedOpt.disabled) {
        setHighlightedIndex(selectedIdx);
      } else {
        // Find first enabled option (returns -1 if none)
        const firstEnabled = flatOptions.findIndex(opt => opt && !opt.disabled);
        setHighlightedIndex(firstEnabled);
      }
    } else {
      setHighlightedIndex(-1);
    }
  }, [isOpen, findSelectedIndex, flatOptions]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (isOpen && highlightedIndex >= 0 && optionRefs.current[highlightedIndex]) {
      optionRefs.current[highlightedIndex]?.scrollIntoView({
        block: 'nearest',
      });
    }
  }, [isOpen, highlightedIndex]);

  // Find next non-disabled option index
  const findNextEnabledIndex = useCallback((currentIndex: number, direction: 'up' | 'down'): number => {
    const step = direction === 'down' ? 1 : -1;
    let nextIndex = currentIndex + step;

    while (nextIndex >= 0 && nextIndex < flatOptions.length) {
      const opt = flatOptions[nextIndex];
      if (opt && !opt.disabled) {
        return nextIndex;
      }
      nextIndex += step;
    }

    return currentIndex; // Stay at current if no enabled option found
  }, [flatOptions]);

  // Find first/last non-disabled option (returns -1 if none found)
  const findFirstEnabledIndex = useCallback((): number => {
    for (let i = 0; i < flatOptions.length; i++) {
      const opt = flatOptions[i];
      if (opt && !opt.disabled) return i;
    }
    return -1;
  }, [flatOptions]);

  const findLastEnabledIndex = useCallback((): number => {
    for (let i = flatOptions.length - 1; i >= 0; i--) {
      const opt = flatOptions[i];
      if (opt && !opt.disabled) return i;
    }
    return -1;
  }, [flatOptions]);

  const handleSelect = useCallback((optionValue: string, optionDisabled?: boolean) => {
    if (optionDisabled) return;
    onOptionHover?.(null);
    onChange(optionValue);
    setIsOpen(false);
    // Return focus to trigger
    triggerRef.current?.focus();
  }, [onChange, onOptionHover]);

  // Open the dropdown, capturing trigger rect for accurate portal positioning
  const openDropdown = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setTriggerRect({ left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom });
    }
    setIsOpen(true);
  }, []);

  // Keyboard navigation handler
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (disabled) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        if (!isOpen) {
          openDropdown();
          // Compute the initially highlighted option (same logic as useEffect on open)
          const selectedIdx = findSelectedIndex();
          const selectedOpt = selectedIdx >= 0 ? flatOptions[selectedIdx] : null;
          let initialIdx: number;
          if (selectedIdx >= 0 && selectedOpt && !selectedOpt.disabled) {
            initialIdx = selectedIdx;
          } else {
            initialIdx = flatOptions.findIndex(opt => opt && !opt.disabled);
          }
          if (initialIdx >= 0) {
            onOptionHover?.(flatOptions[initialIdx]?.value ?? null);
          }
        } else {
          const nextIndex = findNextEnabledIndex(highlightedIndex, 'down');
          setHighlightedIndex(nextIndex);
          if (nextIndex >= 0) {
            onOptionHover?.(flatOptions[nextIndex]?.value ?? null);
          }
        }
        break;

      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        if (!isOpen) {
          openDropdown();
          // Compute the initially highlighted option (same logic as useEffect on open)
          const selectedIdxUp = findSelectedIndex();
          const selectedOptUp = selectedIdxUp >= 0 ? flatOptions[selectedIdxUp] : null;
          let initialIdxUp: number;
          if (selectedIdxUp >= 0 && selectedOptUp && !selectedOptUp.disabled) {
            initialIdxUp = selectedIdxUp;
          } else {
            initialIdxUp = flatOptions.findIndex(opt => opt && !opt.disabled);
          }
          if (initialIdxUp >= 0) {
            onOptionHover?.(flatOptions[initialIdxUp]?.value ?? null);
          }
        } else {
          const nextIndex = findNextEnabledIndex(highlightedIndex, 'up');
          setHighlightedIndex(nextIndex);
          if (nextIndex >= 0) {
            onOptionHover?.(flatOptions[nextIndex]?.value ?? null);
          }
        }
        break;

      case 'Home':
        if (isOpen) {
          event.preventDefault();
          event.stopPropagation();
          const firstIdx = findFirstEnabledIndex();
          if (firstIdx >= 0) {
            setHighlightedIndex(firstIdx);
            onOptionHover?.(flatOptions[firstIdx]?.value ?? null);
          }
        }
        break;

      case 'End':
        if (isOpen) {
          event.preventDefault();
          event.stopPropagation();
          const lastIdx = findLastEnabledIndex();
          if (lastIdx >= 0) {
            setHighlightedIndex(lastIdx);
            onOptionHover?.(flatOptions[lastIdx]?.value ?? null);
          }
        }
        break;

      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        if (isOpen && highlightedIndex >= 0 && flatOptions[highlightedIndex]) {
          handleSelect(flatOptions[highlightedIndex].value, flatOptions[highlightedIndex].disabled);
        } else if (!isOpen) {
          openDropdown();
        }
        break;

      case 'Escape':
        // Only prevent default/stop propagation when dropdown is open
        // This allows modal Escape-to-close to work when dropdown is closed
        if (isOpen) {
          event.preventDefault();
          event.stopPropagation();
          onOptionHover?.(null);
          setIsOpen(false);
          triggerRef.current?.focus();
        }
        break;

      case 'Tab':
        // Close dropdown on tab, let default behavior move focus
        if (isOpen) {
          onOptionHover?.(null);
          setIsOpen(false);
        }
        break;
    }
  }, [disabled, isOpen, highlightedIndex, flatOptions, findNextEnabledIndex, findFirstEnabledIndex, findLastEnabledIndex, findSelectedIndex, handleSelect, openDropdown, onOptionHover]);

  const selectedLabel = findLabel(options, value);

  // Track current flattened index for rendering
  let flatIndex = -1;

  const renderOption = (option: SelectOption, optionIndex: number, groupLabel?: string, isFirstInGroup?: boolean) => {
    const isHighlighted = optionIndex === highlightedIndex;
    const isSelected = option.value === value;

    return (
      <div key={option.value}>
        {groupLabel && isFirstInGroup && (
          <div className="px-3 py-1 text-xs text-text-secondary font-semibold bg-background/50">
            {groupLabel}
          </div>
        )}
        <div
          ref={(el) => { optionRefs.current[optionIndex] = el; }}
          role="option"
          id={getOptionId(optionIndex)}
          aria-selected={isSelected}
          aria-disabled={option.disabled || undefined}
          className={`w-full px-3 py-2 text-left text-sm cursor-pointer ${
            isHighlighted ? 'bg-accent/30' : ''
          } ${isSelected ? 'bg-accent/10 text-accent' : ''} ${
            option.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-accent/20'
          }`}
          onClick={() => handleSelect(option.value, option.disabled)}
          onMouseEnter={() => {
            if (!option.disabled) {
              setHighlightedIndex(optionIndex);
              onOptionHover?.(option.value);
            }
          }}
        >
          {option.label}
        </div>
      </div>
    );
  };

  const renderOptions = () => {
    flatIndex = -1;

    if (isGroupedOptions(options)) {
      return options.map((group) => (
        <div key={group.label} role="group" aria-label={group.label}>
          {group.options.map((option, idx) => {
            flatIndex++;
            return renderOption(option, flatIndex, group.label, idx === 0);
          })}
        </div>
      ));
    } else {
      return options.map((option) => {
        flatIndex++;
        return renderOption(option, flatIndex);
      });
    }
  };

  // Dropdown style: position:fixed, invisible until position is computed.
  // The hidden pass uses triggerRect width/left so the dropdown renders at the
  // correct width for accurate height measurement (avoids shrink-to-fit mismatch).
  const dropdownStyle: React.CSSProperties = dropdownPosition
    ? {
        position: 'fixed',
        top: dropdownPosition.top,
        left: dropdownPosition.left,
        width: dropdownPosition.width,
        zIndex: 9999,
        visibility: 'visible',
      }
    : {
        position: 'fixed',
        top: 0,
        left: triggerRect?.left ?? 0,
        width: triggerRect?.width ?? 'auto',
        zIndex: 9999,
        visibility: 'hidden',
        pointerEvents: 'none',
      };

  return (
    <div className={`relative ${className}`} data-testid={testId} data-dropdown-open={isOpen || undefined}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        className={`w-full px-3 py-2 bg-background border border-border rounded text-left flex items-center justify-between ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-accent'
        }`}
        onClick={() => {
          if (disabled) return;
          if (isOpen) {
            onOptionHover?.(null);
            setIsOpen(false);
          } else {
            openDropdown();
          }
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-owns={isOpen ? listboxId : undefined}
        aria-activedescendant={isOpen && highlightedIndex >= 0 ? getOptionId(highlightedIndex) : undefined}
      >
        <span className={selectedLabel ? 'text-text-primary' : 'text-text-secondary'}>
          {selectedLabel || placeholder}
        </span>
        <svg
          className={`w-4 h-4 text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown — portaled to document.body to escape stacking contexts */}
      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          role="listbox"
          id={listboxId}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className="bg-panel border border-border rounded shadow-lg max-h-60 overflow-auto"
          style={dropdownStyle}
        >
          {renderOptions()}
        </div>,
        document.body,
      )}
    </div>
  );
}
