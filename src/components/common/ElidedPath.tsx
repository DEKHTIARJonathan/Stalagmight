import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { pathElisionCandidates } from '../../utils/pathElision';

interface ElidedPathProps {
  /** The full file path to display (and reveal in full on hover). */
  path: string;
  /** Extra classes for the (single-line) text element. */
  className?: string;
  /** Test ID applied to the rendered text element. */
  'data-testid'?: string;
}

/** Cached canvas 2d context for text measurement (created lazily, reused). */
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  measureCtx = canvas.getContext('2d');
  return measureCtx;
}

/** Marquee scroll speed when revealing the full path on hover (px per second). */
const SCROLL_SPEED_PX_PER_S = 45;

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
 * stays over it.
 */
export function ElidedPath({
  path,
  className = '',
  'data-testid': dataTestId,
}: ElidedPathProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(path);
  const [hovering, setHovering] = useState(false);
  const [scroll, setScroll] = useState<{ distance: number; duration: number } | null>(null);

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

      const ctx = getMeasureContext();
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

  // On hover the inner element shows the full path; measure how far it overflows
  // the clip box so the marquee scrolls exactly to the end and back.
  useLayoutEffect(() => {
    if (!hovering) {
      setScroll(null);
      return;
    }
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;
    const overflow = inner.scrollWidth - container.clientWidth;
    if (overflow > 1) {
      setScroll({ distance: overflow, duration: Math.max(2, overflow / SCROLL_SPEED_PX_PER_S) });
    } else {
      // Already fits at full length — nothing to scroll.
      setScroll(null);
    }
  }, [hovering, path]);

  const innerStyle: CSSProperties | undefined =
    hovering && scroll
      ? ({
          '--elided-scroll-distance': `${-scroll.distance}px`,
          animation: `elided-path-scroll ${scroll.duration}s linear infinite alternate`,
        } as CSSProperties)
      : undefined;

  return (
    <span
      ref={containerRef}
      className={`block w-full overflow-hidden whitespace-nowrap ${className}`}
      data-testid={dataTestId}
      data-full-path={path}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span ref={innerRef} className="inline-block align-top" style={innerStyle}>
        {hovering ? path : display}
      </span>
    </span>
  );
}

export default ElidedPath;
