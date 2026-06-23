import { useEffect, useRef, type RefObject } from 'react';

interface UseDismissableLayerOptions {
  /** Whether the layer is currently open (listeners attach only while open). */
  open: boolean;
  /** Dismiss the layer (called on outside mousedown, external scroll, or resize). */
  onDismiss: () => void;
  /** Elements that count as "inside": a mousedown within any of them is NOT an
   *  outside click. Typically the trigger plus the portaled surface(s). */
  contains: Array<RefObject<HTMLElement | null>>;
  /** Subset whose own scrolling must NOT dismiss (the portaled, scrollable surface).
   *  Scrolling anything else — the page behind a `position:fixed` portal — dismisses
   *  so the portal's captured position can't go stale. Defaults to `contains`. */
  scrollSafe?: Array<RefObject<HTMLElement | null>>;
}

/**
 * Shared "dismiss a portaled popover/menu on outside interaction" behavior:
 * close on a mousedown outside the layer, on external scroll (the portal uses a
 * captured `position:fixed` rect that scrolling would invalidate), and on resize.
 *
 * Extracted from Select and AppMenu, which each had their own near-identical copy
 * of these three effects. Positioning (flip/clamp) stays per-component since the two
 * differ (Select matches the trigger width; AppMenu caps height and adds a submenu).
 *
 * The latest `onDismiss` and ref arrays are read at event time via refs, so the
 * three listeners bind once per open — a fresh inline `onDismiss`/array each render
 * doesn't re-bind them.
 */
export function useDismissableLayer({
  open,
  onDismiss,
  contains,
  scrollSafe,
}: UseDismissableLayerOptions): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const containsRef = useRef(contains);
  containsRef.current = contains;
  const scrollSafeRef = useRef(scrollSafe ?? contains);
  scrollSafeRef.current = scrollSafe ?? contains;

  useEffect(() => {
    if (!open) return undefined;
    const isInside = (refs: Array<RefObject<HTMLElement | null>>, node: Node | null) =>
      node !== null && refs.some((r) => r.current?.contains(node));

    const onMouseDown = (e: MouseEvent) => {
      if (!isInside(containsRef.current, e.target as Node)) onDismissRef.current();
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && isInside(scrollSafeRef.current, e.target)) return;
      onDismissRef.current();
    };
    const onResize = () => onDismissRef.current();

    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
    };
  }, [open]);
}
