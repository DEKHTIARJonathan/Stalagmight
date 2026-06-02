import { useLayoutEffect, useRef, useState } from 'react';
import { pathElisionCandidates } from '../../utils/pathElision';
import { Tooltip } from './Tooltip';

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

/**
 * Renders a file path on a single line, abbreviated to fit its available width:
 * leading folders collapse to single letters, then the middle is truncated with
 * `…`, with the filename always kept whole (see {@link pathElisionCandidates}).
 *
 * Fitting is pixel-based — the candidate is chosen by measuring against the
 * element's real width using the element's computed font, re-fitting on resize.
 * The full path is always available via a themed tooltip on hover.
 */
export function ElidedPath({
  path,
  className = '',
  'data-testid': dataTestId,
}: ElidedPathProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(path);

  useLayoutEffect(() => {
    const el = ref.current;
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

  return (
    <Tooltip content={path} className="block w-full" tooltipClassName="max-w-none">
      <span
        ref={ref}
        className={`block w-full overflow-hidden whitespace-nowrap ${className}`}
        data-testid={dataTestId}
        data-full-path={path}
      >
        {display}
      </span>
    </Tooltip>
  );
}

export default ElidedPath;
