import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/** Floor for the height cap so a degenerate gap still shows a scrollable sliver
 *  rather than a zero-height (invisible) menu. */
const MIN_MENU_HEIGHT = 64;

/** Breathing room kept between the menu and a boundary (the toolbar's bottom /
 *  the status bar's top, or the viewport edges), so a capped menu doesn't sit
 *  flush against the chrome. */
const EDGE_MARGIN = 8;

interface AnchoredMenuOptions {
  /** Horizontal anchoring relative to the trigger. */
  align: 'center' | 'right';
  /** Gap (px) between trigger and menu, and the minimum margin from any viewport edge. */
  gap: number;
  /** Menu width (px) — must match the menu's fixed width class (e.g. `w-52` = 208). */
  width: number;
  /** Optional absolute cap (px) on the menu's height, applied on top of the
   *  per-side free-space cap — restores the old fixed `max-h-*` so a long list
   *  stays compact (and scrolls) on a tall window instead of growing to fill the
   *  whole free side. Omit to bound only by the available side space. */
  maxHeightCap?: number;
}

interface Placement {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * Position a trigger-anchored dropdown with `position: fixed` so it escapes any
 * ancestor `overflow: hidden` (e.g. the Dock's clip box) — unlike `position:
 * absolute`, which gets clipped when the menu flips upward and makes its items
 * unclickable (clicks fall through to whatever is painted behind the clip).
 *
 * Mirrors the measure-then-place pattern in {@link Select} and the data-table
 * right-click header menu: a hidden first pass lets a `useLayoutEffect` measure
 * the menu's natural height before paint, so it flips to whichever side has more
 * room, clamps within the viewport, and caps `maxHeight` to the chosen side's
 * free space (a short window then scrolls the list instead of overflowing
 * off-screen). Dismissal/scroll/resize handling stays with the caller via
 * {@link useDismissableLayer}.
 *
 * Returns a `fixed` CSS style for the menu element; render the menu while `open`
 * and spread the returned object onto its `style`.
 */
export function useAnchoredFixedMenu(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  { align, gap, width, maxHeightCap }: AnchoredMenuOptions
): CSSProperties {
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const rect = trigger.getBoundingClientRect();
    const naturalHeight = menu.getBoundingClientRect().height;

    // Keep the menu clear of the app chrome that would otherwise clip/cover it:
    // the opaque top toolbar when flipping up, the bottom status bar when flipping
    // down. `--toolbar-h` / `--statusbar-h` are their measured heights, set on the
    // SingleSystemView root and inherited here; absent → 0. EDGE_MARGIN keeps a
    // capped menu from sitting flush against the bar.
    const cs = getComputedStyle(trigger);
    const topBound = (parseFloat(cs.getPropertyValue('--toolbar-h')) || 0) + EDGE_MARGIN;
    const bottomBound =
      window.innerHeight - (parseFloat(cs.getPropertyValue('--statusbar-h')) || 0) - EDGE_MARGIN;

    // Flip toward the side with more room (matches the prior on-open heuristic).
    const spaceBelow = bottomBound - rect.bottom - gap;
    const spaceAbove = rect.top - topBound - gap;
    const up = spaceAbove > spaceBelow;
    const sideSpace = Math.max(up ? spaceAbove : spaceBelow, 0);
    const cappedNatural = Math.min(naturalHeight, maxHeightCap ?? Infinity);
    const maxHeight = Math.max(Math.min(cappedNatural, sideSpace), MIN_MENU_HEIGHT);
    // Up: clamp the top to `topBound`. Down: clamp the BOTTOM to `bottomBound`
    // (so the MIN_MENU_HEIGHT floor in a tiny window can't push the menu down
    // past the status bar); `Math.max(topBound, …)` keeps it on-screen if even
    // that overflows upward.
    const top = up
      ? Math.max(topBound, rect.top - maxHeight - gap)
      : Math.max(topBound, Math.min(rect.bottom + gap, bottomBound - maxHeight));

    const rawLeft = align === 'center' ? rect.left + rect.width / 2 - width / 2 : rect.right - width;
    const left = Math.min(Math.max(rawLeft, gap), window.innerWidth - width - gap);

    setPlacement({ top, left, maxHeight });
  }, [open, triggerRef, menuRef, align, gap, width]);

  if (!placement) {
    // Hidden first pass: render at natural size, out of the way, so the layout
    // effect can measure height before we place and reveal it (no flicker).
    return { position: 'fixed', top: 0, left: 0, zIndex: 50, visibility: 'hidden', pointerEvents: 'none' };
  }
  return {
    position: 'fixed',
    top: placement.top,
    left: placement.left,
    maxHeight: placement.maxHeight,
    zIndex: 50,
    visibility: 'visible',
  };
}
