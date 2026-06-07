import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/** Cached canvas 2d context for text measurement (created lazily, reused). */
let measureCtx: CanvasRenderingContext2D | null = null;
export function getTextMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  measureCtx = canvas.getContext('2d');
  return measureCtx;
}

/** Marquee scroll speed when revealing overflowing text on hover (px per second). */
const SCROLL_SPEED_PX_PER_S = 45;

export interface HoverMarquee {
  /** True while hovering AND the text overflows — render the scrolling overlay. */
  scrolling: boolean;
  /** Inline style (animation + distance var) for the absolutely-positioned overlay. */
  overlayStyle: CSSProperties | undefined;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/**
 * Hover-to-scroll (marquee) for single-line text that may overflow `ref`'s width.
 * On hover it measures how far `fullText` overflows (via canvas, so the caller's
 * scrolling overlay can stay out of flow and never resize its container) and
 * returns the animation state. Pairs with the `elided-path-scroll` keyframe.
 */
export function useHoverMarquee(fullText: string, ref: RefObject<HTMLElement>): HoverMarquee {
  const [hovering, setHovering] = useState(false);
  const [scroll, setScroll] = useState<{ distance: number; duration: number } | null>(null);

  useLayoutEffect(() => {
    if (!hovering) {
      setScroll(null);
      return;
    }
    const el = ref.current;
    const ctx = getTextMeasureContext();
    if (!el || !ctx) return;
    const available = el.clientWidth;
    if (available <= 0) {
      setScroll(null);
      return;
    }
    ctx.font = window.getComputedStyle(el).font;
    const overflow = ctx.measureText(fullText).width - available;
    setScroll(
      overflow > 1
        ? { distance: overflow, duration: Math.max(2, overflow / SCROLL_SPEED_PX_PER_S) }
        : null,
    );
  }, [hovering, fullText, ref]);

  const overlayStyle: CSSProperties | undefined = scroll
    ? ({
        '--elided-scroll-distance': `${-scroll.distance}px`,
        animation: `elided-path-scroll ${scroll.duration}s linear infinite alternate`,
      } as CSSProperties)
    : undefined;

  return {
    scrolling: hovering && scroll != null,
    overlayStyle,
    onMouseEnter: () => setHovering(true),
    onMouseLeave: () => setHovering(false),
  };
}
