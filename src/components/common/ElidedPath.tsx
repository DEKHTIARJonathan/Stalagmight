import { useLayoutEffect, useRef, useState } from 'react';
import { pathElisionCandidates } from '../../utils/pathElision';
import { useHoverMarquee, getTextMeasureContext } from './useHoverMarquee';

interface ElidedPathProps {
  /** The full file path to display (and reveal in full on hover). */
  path: string;
  /** Extra classes for the (single-line) text element. */
  className?: string;
  /** Test ID applied to the rendered text element. */
  'data-testid'?: string;
}

/**
 * Renders a file path on a single line, abbreviated to fit its available width:
 * leading folders collapse to single letters, then the middle is truncated with
 * `…`, with the filename always kept whole (see {@link pathElisionCandidates}).
 *
 * Fitting is pixel-based — the candidate is chosen by measuring against the
 * element's real width using the element's computed font, re-fitting on resize.
 *
 * When the path is abbreviated, hovering reveals the full path by scrolling it
 * (marquee) within the same clip box — no tooltip — for as long as the pointer
 * stays over it. The scrolling copy is absolutely positioned, so it never widens
 * its container (e.g. it won't stretch a table column).
 */
export function ElidedPath({
  path,
  className = '',
  'data-testid': dataTestId,
}: ElidedPathProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(path);
  const { scrolling, overlayStyle, onMouseEnter, onMouseLeave } = useHoverMarquee(path, containerRef);

  // Fit the abbreviated (resting) display to the available width.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const fit = () => {
      const available = el.clientWidth;
      const candidates = pathElisionCandidates(path);
      if (available <= 0) {
        // Not yet laid out — show the full path until we can measure.
        setDisplay(candidates[0] ?? path);
        return;
      }

      const ctx = getTextMeasureContext();
      if (!ctx) {
        setDisplay(candidates[0] ?? path);
        return;
      }
      ctx.font = window.getComputedStyle(el).font;

      // Candidates run longest → shortest; pick the first that fits, else the
      // most-elided (last) one.
      const fitted =
        candidates.find((c) => ctx.measureText(c).width <= available) ??
        candidates[candidates.length - 1] ??
        path;
      setDisplay(fitted);
    };

    fit();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [path]);

  return (
    <span
      ref={containerRef}
      className={`relative block w-full overflow-hidden whitespace-nowrap ${className}`}
      data-testid={dataTestId}
      data-full-path={path}
      aria-label={path}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* In-flow copy: sizes the element and provides height. Hidden (size kept)
          while the marquee overlay scrolls, so the container never grows. */}
      <span className={scrolling ? 'invisible' : undefined}>{display}</span>
      {/* Marquee overlay: absolute (out of flow) → never widens a table column. */}
      {scrolling && (
        <span
          className="absolute inset-y-0 left-0 flex items-center whitespace-nowrap"
          style={overlayStyle}
          data-elided-overlay=""
          aria-hidden="true"
        >
          {path}
        </span>
      )}
    </span>
  );
}

export default ElidedPath;
