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
   *  Beyond those, only the page and the layer's own ancestors dismiss, so the
   *  portal's captured position can't go stale; an unrelated scroller elsewhere in
   *  the app is ignored. Defaults to `contains`. */
  scrollSafe?: Array<RefObject<HTMLElement | null>>;
  /** The region the layer's captured position is anchored to: a scroll ANYWHERE
   *  inside it dismisses.
   *
   *  Needed by layers that pin themselves to cursor coordinates and render as a
   *  `position:fixed` sibling of the thing they point at, because then `contains`
   *  holds only the menu, whose own ancestors are just body/html - the scroll that
   *  actually strands it (the grid the header cell lives in) is neither an
   *  ancestor of the menu nor the page. Pass the enclosing panel and that scroll
   *  is covered, while a scroll outside the panel still is not. */
  anchorScope?: RefObject<HTMLElement | null>;
}

/**
 * Shared "dismiss a portaled popover/menu on outside interaction" behavior:
 * close on a mousedown outside the layer, on a scroll that could move it (the portal uses a
 * captured `position:fixed` rect that scrolling would invalidate), and on resize.
 *
 * Extracted from Select and AppMenu, which each had their own near-identical copy
 * of these three effects. Positioning (flip/clamp) stays per-component since the two
 * differ (Select matches the trigger width; AppMenu caps height and adds a submenu).
 *
 * The latest `onDismiss` and ref arrays are read at event time via refs, so the
 * three listeners bind once per open - a fresh inline `onDismiss`/array each render
 * doesn't re-bind them.
 */
export function useDismissableLayer({
  open,
  onDismiss,
  contains,
  scrollSafe,
  anchorScope,
}: UseDismissableLayerOptions): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const containsRef = useRef(contains);
  containsRef.current = contains;
  const scrollSafeRef = useRef(scrollSafe ?? contains);
  scrollSafeRef.current = scrollSafe ?? contains;
  const anchorScopeRef = useRef(anchorScope);
  anchorScopeRef.current = anchorScope;

  useEffect(() => {
    if (!open) return undefined;
    const isInside = (refs: Array<RefObject<HTMLElement | null>>, node: Node | null) =>
      node !== null && refs.some((r) => r.current?.contains(node));

    const onMouseDown = (e: MouseEvent) => {
      if (!isInside(containsRef.current, e.target as Node)) onDismissRef.current();
    };
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && isInside(scrollSafeRef.current, target)) return;
      // Only a scroll that can MOVE this layer should close it. These layers are
      // fixed-position portals pinned to coordinates captured when they opened,
      // so the scrolls that invalidate that position are the page itself and any
      // ANCESTOR of the layer (or of its trigger, which is what callers put in
      // `contains`). A scroll in a sibling subtree cannot shift it by a pixel.
      //
      // It used to dismiss on ANY scroll in the document, which made a map
      // right-click close its own menu: selecting the station scrolls the data
      // table's row and the sections panel's section into view, and that scroll
      // arrived while the menu was opening. The menu flashed and vanished, and
      // only a second right-click - by which point the row was already in view,
      // so nothing scrolled - would stay open.
      // Only an Element can be the "unrelated scroller" this guard is about; a
      // non-Element target is the page itself (window or document), which moves
      // everything. Tested by shape rather than `target === window` because
      // jsdom hands the listener a different Window object than the global.
      const movesLayer =
        !(target instanceof Element) ||
        containsRef.current.some((r) => {
          const el = r.current;
          return el !== null && el !== target && target.contains(el);
        }) ||
        // ...or the scroll happened inside the region the layer is anchored to.
        // The ancestor test above cannot see this case: a menu pinned to cursor
        // coordinates renders as a fixed sibling of the scroller, so the scroller
        // contains the ANCHOR but not the menu.
        anchorScopeRef.current?.current?.contains(target) === true;
      if (!movesLayer) return;
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
