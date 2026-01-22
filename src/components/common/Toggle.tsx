import { type KeyboardEvent } from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-testid'?: string;
}

/**
 * iOS-style toggle/switch component.
 *
 * Uses a non-button focusable element to ensure:
 * - Space key toggles the switch
 * - Enter key does NOT toggle (unlike buttons)
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': dataTestId,
}: ToggleProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Only Space key toggles the switch (not Enter)
    if (event.key === ' ') {
      event.preventDefault();
      if (!disabled) {
        onChange(!checked);
      }
    }
  };

  const handleClick = () => {
    if (!disabled) {
      onChange(!checked);
    }
  };

  const toggleElement = (
    <div
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      data-testid={dataTestId}
      className={`
        relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full
        transition-all duration-200
        focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background
        ${checked ? 'bg-accent' : 'bg-gray-600'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
    >
      {/* Thumb (sliding circle) */}
      <span
        className={`
          inline-block h-4 w-4 rounded-full bg-white shadow-sm
          transition-all duration-200
          ${checked ? 'translate-x-6' : 'translate-x-1'}
        `}
        aria-hidden="true"
      />
    </div>
  );

  // If label is provided, wrap in a label element
  if (label) {
    return (
      <label className="inline-flex items-center gap-2 cursor-pointer">
        {toggleElement}
        <span className={`text-text-primary ${disabled ? 'opacity-50' : ''}`}>
          {label}
        </span>
      </label>
    );
  }

  return toggleElement;
}
