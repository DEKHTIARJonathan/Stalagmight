/**
 * Custom Select component with dark theme styling.
 * Replaces native HTML select which has dropdown styling issues in WebView.
 */
import { useState, useRef, useEffect, useCallback } from 'react';

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
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close on escape - stop propagation to prevent dialog from closing
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        setIsOpen(false);
      }
    };

    // Use capture phase to handle before other listeners
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  const handleSelect = useCallback((optionValue: string, optionDisabled?: boolean) => {
    if (optionDisabled) return;
    onChange(optionValue);
    setIsOpen(false);
  }, [onChange]);

  const selectedLabel = findLabel(options, value);

  const renderOptions = (opts: SelectOption[], groupLabel?: string) => (
    <>
      {groupLabel && (
        <div className="px-3 py-1 text-xs text-text-secondary font-semibold bg-background/50">
          {groupLabel}
        </div>
      )}
      {opts.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`w-full px-3 py-2 text-left text-sm hover:bg-accent/20 ${
            option.value === value ? 'bg-accent/10 text-accent' : ''
          } ${option.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          onClick={() => handleSelect(option.value, option.disabled)}
          disabled={option.disabled}
        >
          {option.label}
        </button>
      ))}
    </>
  );

  return (
    <div ref={containerRef} className={`relative ${className}`} data-testid={testId} data-dropdown-open={isOpen || undefined}>
      {/* Trigger button */}
      <button
        type="button"
        className={`w-full px-3 py-2 bg-background border border-border rounded text-left flex items-center justify-between ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-accent'
        }`}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={selectedLabel ? 'text-foreground' : 'text-text-secondary'}>
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

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-panel border border-border rounded shadow-lg max-h-60 overflow-auto">
          {isGroupedOptions(options) ? (
            options.map((group, idx) => (
              <div key={group.label + idx}>
                {renderOptions(group.options, group.label)}
              </div>
            ))
          ) : (
            renderOptions(options)
          )}
        </div>
      )}
    </div>
  );
}
