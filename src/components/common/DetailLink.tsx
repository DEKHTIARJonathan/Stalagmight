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
 * - Hover/focus highlighting: optionally highlights corresponding map element on mouse
 *   hover or keyboard focus via onHoverStart/onHoverEnd callbacks. Mouse leave only
 *   clears highlight if the element is not keyboard-focused (prevents highlight loss
 *   when user moves mouse away but keeps element focused).
 */

import { useCallback, useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { EntitySymbol } from './toolIcons';

export type DetailLinkType = 'station' | 'shot' | 'section';

/**
 * Target identifier for station or shot links.
 * Both sectionId and position are required.
 */
export interface StationOrShotTarget {
  sectionId: number;
  /** Position within section: 0-indexed for stations, 1-indexed for shots */
  position: number;
}

/**
 * Target identifier for section links.
 * Only sectionId is required.
 */
export interface SectionTarget {
  sectionId: number;
}

/**
 * Union type for all target types.
 * Use StationOrShotTarget for stations/shots, SectionTarget for sections.
 */
export type DetailLinkTarget = StationOrShotTarget | SectionTarget;

/**
 * Type guard to check if target has position (station or shot target).
 */
export function hasPosition(target: DetailLinkTarget): target is StationOrShotTarget {
  return 'position' in target && typeof target.position === 'number';
}

export interface DetailLinkProps {
  /** Type of element this link navigates to */
  type: DetailLinkType;
  /** Target identifier (sectionId required, position required for stations/shots) */
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
  /** Callback when hover/focus starts (for map highlighting). Ignored if isMissing. */
  onHoverStart?: () => void;
  /** Callback when hover/focus ends (for map highlighting). */
  onHoverEnd?: () => void;
}

/**
 * Generate a stable test ID based on element type and target.
 *
 * Formats:
 * - Station: "station-{sectionId}-{position}-link"
 * - Shot: "shot-{sectionId}-{position}-link"
 * - Section: "section-{sectionId}-link"
 *
 * @throws Error if station/shot type is used without position
 */
export function generateTestId(type: DetailLinkType, target: DetailLinkTarget): string {
  if (type === 'section') {
    return `section-${target.sectionId}-link`;
  }
  // Station and shot require position
  if (!hasPosition(target)) {
    throw new Error(`${type} links require a position in target, got: ${JSON.stringify(target)}`);
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
  const trimmed = displayText.trim();
  if (trimmed === '') {
    return `Select ${type}`;
  }
  return `Select ${type} ${trimmed}`;
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
  onHoverStart,
  onHoverEnd,
}: DetailLinkProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mouseDownRef = useRef(false);
  const computedTestId = testId ?? generateTestId(type, target);
  const ariaLabel = generateAriaLabel(type, displayText);

  // Full highlighting: a leading entity symbol signals what the link points to
  // (station ring, shot line, section zigzag), colored by entity. Hidden for
  // missing targets (the warning glyph already conveys state).
  const syntacticLevel = useUIStore((s) => s.syntacticLevel);
  const showSymbol = syntacticLevel === 'full' && !isMissing;

  const handleClick = useCallback(() => {
    if (isMissing) {
      // Don't navigate to missing targets
      return;
    }
    const shouldClearHover = mouseDownRef.current;
    mouseDownRef.current = false;
    if (shouldClearHover && onHoverEnd) {
      onHoverEnd();
    }
    onSelect();
    if (onAnnounce) {
      onAnnounce(`Selected ${type} ${displayText}`);
    }
  }, [type, displayText, onSelect, onAnnounce, isMissing, onHoverEnd]);

  const handleMouseEnter = useCallback(() => {
    if (isMissing || !onHoverStart) return;
    onHoverStart();
  }, [isMissing, onHoverStart]);

  const handleMouseDown = useCallback(() => {
    if (isMissing) return;
    mouseDownRef.current = true;
  }, [isMissing]);

  const handleMouseLeave = useCallback(() => {
    // Skip for missing links (they never started hover, so nothing to clear)
    if (isMissing || !onHoverEnd) return;
    mouseDownRef.current = false;
    // Only clear highlight if element is not focused (keyboard focus takes precedence)
    const isFocused = typeof document !== 'undefined' && document.activeElement === buttonRef.current;
    if (!isFocused) {
      onHoverEnd();
    }
  }, [isMissing, onHoverEnd]);

  const handleFocus = useCallback(() => {
    if (isMissing || !onHoverStart) return;
    onHoverStart();
  }, [isMissing, onHoverStart]);

  const handleBlur = useCallback(() => {
    // Skip for missing links (they never started hover, so nothing to clear)
    if (isMissing || !onHoverEnd) return;
    onHoverEnd();
  }, [isMissing, onHoverEnd]);

  // Build class list conditionally to avoid conflicting Tailwind utilities
  const baseClasses = 'underline focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset';
  const colorClass = isMissing ? 'text-warning' : 'text-accent';
  const cursorClass = isMissing ? 'cursor-not-allowed' : 'cursor-pointer';

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={`${baseClasses} ${colorClass} ${cursorClass} ${className}`}
      aria-label={ariaLabel}
      aria-disabled={isMissing}
      data-testid={computedTestId}
      title={isMissing ? `${type} not found` : undefined}
    >
      {showSymbol && (
        <EntitySymbol
          entity={type}
          size={14}
          className="mr-1"
          testId={`${computedTestId}-symbol`}
        />
      )}
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
