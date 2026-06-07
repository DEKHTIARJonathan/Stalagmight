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
 * stays over it. The scrolling copy is absolutely positioned, so it never widens
 * its container (e.g. it won't stretch a table column); an invisible in-flow copy
 * keeps the element at its resting size.
 */
export function ElidedPath({
  path,
  className = '',
  'data-testid': dataTestId,
}: ElidedPathProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
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

  // On hover, measure how far the full path overflows the clip box (via canvas,
  // so the marquee overlay can stay out of flow and never resize the container).
  useLayoutEffect(() => {
    if (!hovering) {
      setScroll(null);
      return;
    }
    const el = containerRef.current;
    const ctx = getMeasureContext();
    if (!el || !ctx) return;
    const available = el.clientWidth;
    if (available <= 0) {
      setScroll(null);
      return;
    }
    ctx.font = window.getComputedStyle(el).font;
    const overflow = ctx.measureText(path).width - available;
    setScroll(
      overflow > 1
        ? { distance: overflow, duration: Math.max(2, overflow / SCROLL_SPEED_PX_PER_S) }
        : null,
    );
  }, [hovering, path]);

  const scrolling = hovering && scroll != null;
  const overlayStyle: CSSProperties | undefined = scroll
    ? ({
        '--elided-scroll-distance': `${-scroll.distance}px`,
        animation: `elided-path-scroll ${scroll.duration}s linear infinite alternate`,
      } as CSSProperties)
    : undefined;

  return (
    <span
      ref={containerRef}
      className={`relative block w-full overflow-hidden whitespace-nowrap ${className}`}
      data-testid={dataTestId}
      data-full-path={path}
      aria-label={path}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
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
