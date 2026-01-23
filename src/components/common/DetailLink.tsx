/**
 * DetailLink - Reusable hyperlink component for navigating between survey elements.
 *
 * Features:
 * - Button element styled as link (actions that change state, not navigation)
 * - Accent color with underline styling
 * - Focus ring for keyboard accessibility
 * - Warning indicator for missing targets
 * - Generates stable test IDs based on element type and position
 * - ARIA labels for accessibility
 */

import { useCallback } from 'react';

export type DetailLinkType = 'station' | 'shot' | 'section';

/**
 * Target identifier for DetailLink.
 * For stations and shots: sectionId + position (1-indexed)
 * For sections: just sectionId
 */
export interface DetailLinkTarget {
  sectionId: number;
  /** 1-indexed position within section (required for stations and shots) */
  position?: number;
}

export interface DetailLinkProps {
  /** Type of element this link navigates to */
  type: DetailLinkType;
  /** Target identifier (sectionId required, position for stations/shots) */
  target: DetailLinkTarget;
  /** Text to display in the link */
  displayText: string;
  /** Callback when link is clicked */
  onSelect: () => void;
  /** Whether the target element is missing/invalid */
  isMissing?: boolean;
  /** Callback to announce selection change for screen readers */
  onAnnounce?: (message: string) => void;
  /** Optional explicit test ID (overrides auto-generated) */
  testId?: string;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Generate a stable test ID based on element type and target.
 *
 * Formats:
 * - Station: "station-{sectionId}-{position}-link"
 * - Shot: "shot-{sectionId}-{position}-link"
 * - Section: "section-{sectionId}-link"
 */
export function generateTestId(type: DetailLinkType, target: DetailLinkTarget): string {
  if (type === 'section') {
    return `section-${target.sectionId}-link`;
  }
  return `${type}-${target.sectionId}-${target.position}-link`;
}

/**
 * Generate an accessible aria-label for the link.
 *
 * Format: "Select [type] [displayText]"
 * Example: "Select station 2:5"
 */
export function generateAriaLabel(type: DetailLinkType, displayText: string): string {
  return `Select ${type} ${displayText}`;
}

/**
 * DetailLink component for navigating between survey elements.
 */
export function DetailLink({
  type,
  target,
  displayText,
  onSelect,
  isMissing = false,
  onAnnounce,
  testId,
  className = '',
}: DetailLinkProps) {
  const computedTestId = testId ?? generateTestId(type, target);
  const ariaLabel = generateAriaLabel(type, displayText);

  const handleClick = useCallback(() => {
    if (isMissing) {
      // Don't navigate to missing targets
      return;
    }
    onSelect();
    if (onAnnounce) {
      onAnnounce(`Selected ${type} ${displayText}`);
    }
  }, [type, displayText, onSelect, onAnnounce, isMissing]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleClick();
      }
    },
    [handleClick]
  );

  // Base styles: text-accent underline with focus ring
  const baseStyles = `
    text-accent underline
    focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset
    cursor-pointer
  `.trim();

  // Warning styles for missing targets: yellow text
  const warningStyles = isMissing
    ? 'text-yellow-400 cursor-not-allowed'
    : '';

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`${baseStyles} ${warningStyles} ${className}`}
      aria-label={ariaLabel}
      aria-disabled={isMissing}
      data-testid={computedTestId}
      title={isMissing ? `${type} not found` : undefined}
    >
      {displayText}
      {isMissing && (
        <span className="ml-1" aria-hidden="true" title={`${type} not found`}>
          &#x26A0;
        </span>
      )}
    </button>
  );
}

export default DetailLink;
