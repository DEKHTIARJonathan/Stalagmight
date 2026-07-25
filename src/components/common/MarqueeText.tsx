import { useRef } from 'react';
import { useHoverMarquee } from './useHoverMarquee';

interface MarqueeTextProps {
  /** The full text to display (truncated to fit) and reveal in full on hover. */
  text: string;
  /** Extra classes for the (single-line) text element (e.g. layout/sizing). */
  className?: string;
  /** Test ID applied to the rendered text element. */
  'data-testid'?: string;
}

/**
 * Single-line text truncated with an ellipsis to fit its width; on hover the full
 * text scrolls (marquee) in place - no tooltip - for as long as the pointer stays
 * over it. The scrolling copy is absolutely positioned, so it never widens its
 * container. For file paths use {@link ElidedPath} instead (smart path elision).
 */
export function MarqueeText({
  text,
  className = '',
  'data-testid': dataTestId,
}: MarqueeTextProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const { scrolling, overlayStyle, onMouseEnter, onMouseLeave } = useHoverMarquee(text, containerRef);

  return (
    <span
      ref={containerRef}
      // The ellipsis only applies at rest - while scrolling it would otherwise
      // stay pinned at the clip edge over the moving overlay.
      className={`relative block overflow-hidden whitespace-nowrap ${scrolling ? '' : 'text-ellipsis'} ${className}`}
      data-testid={dataTestId}
      data-full-text={text}
      aria-label={text}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* In-flow copy: sizes/anchors the element; CSS-truncates with an ellipsis at
          rest, hidden (size kept) while the marquee overlay scrolls. */}
      <span className={scrolling ? 'invisible' : undefined}>{text}</span>
      {/* Marquee overlay: absolute (out of flow) → never widens its container. */}
      {scrolling && (
        <span
          className="absolute inset-y-0 left-0 flex items-center whitespace-nowrap"
          style={overlayStyle}
          data-elided-overlay=""
          aria-hidden="true"
        >
          {text}
        </span>
      )}
    </span>
  );
}

export default MarqueeText;
