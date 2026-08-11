/**
 * Long-press on a raw canvas -> the same context menu right-click opens.
 *
 * The two map layers that own a context menu (`SurveyLayer`,
 * `GlobalSurveyLayer`) hang their listeners off `map.getCanvas()`, a DOM node
 * React never sees, so neither can use the `useLongPress` hook the React
 * surfaces use. Both grew their own copy of the same small state machine - a
 * 500 ms hold, cancelled by a 10 px wobble, that swallows the `touchend`
 * ending a press which opened a menu (#338) - and the copies were identical
 * line for line. One copy is enough: the feel of the gesture is now edited in
 * exactly one place, and a fix to it cannot land on one map and miss the other.
 *
 * Swallowing that `touchend` is the load-bearing part. `preventDefault()` on it
 * is what stops the browser synthesising the compatibility mouse events it
 * would otherwise fire from the lift, which would run the tool underneath the
 * menu that just opened - a mutation the user did not ask for, hidden behind
 * the menu. Deliberately no `stopPropagation`: MapLibre's own `touchend` still
 * has to run or pan and pinch break. That is also why `touchend` is registered
 * `{ passive: false }` - a passive listener may not preventDefault.
 */

/** Hold this long, unmoved, and the press counts as a long press. */
const LONG_PRESS_MS = 500;
/** Move further than this from where the finger landed and the press is off. */
const MOVE_CANCEL_PX = 10;
const MOVE_CANCEL_PX_SQUARED = MOVE_CANCEL_PX * MOVE_CANCEL_PX;

/** The press as it began, copied out of the starting `Touch` at touchstart. */
export interface LongPressStart {
  clientX: number;
  clientY: number;
  /**
   * What the finger came down on, snapshotted for the same reason the
   * coordinates are: read at fire time it is a different question ("what is
   * under the finger now"), and the wobble-cancel already guarantees the two
   * answers agree within 10 px.
   */
  target: EventTarget | null;
}

export interface LongPressTouchOptions {
  /**
   * The hold completed. Receives where the finger landed - which is the
   * position the menu belongs at - and what it landed on. The coordinates are
   * copied at touchstart rather than read off the `Touch` later: the spec says
   * a `Touch` is a snapshot, but both implementations this helper replaced kept
   * a defensive copy, and a webview that reused `Touch` objects would otherwise
   * silently break the wobble-cancel whose whole job is "did the finger move".
   *
   * Return whether a menu actually opened. `true` arms the `touchend`
   * suppression described in the module doc; `false` (nothing under the
   * finger) leaves the trailing tap alone, so it behaves like any other tap.
   */
  onLongPress: (start: LongPressStart) => boolean;
  /**
   * Gate: `false` keeps the press inert. Consulted both when the finger lands
   * and again before the menu would open, because what it reads (a modal
   * interaction elsewhere in the app) can start or end during the hold.
   */
  isEnabled?: () => boolean;
}

/**
 * Bind the long-press listeners to `target`.
 *
 * @returns a detach function; call it before the element goes away.
 */
export function attachLongPressTouch(
  target: HTMLElement,
  options: LongPressTouchOptions
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** How the pending press began, or null when none is pending. */
  let pending: LongPressStart | null = null;
  /** Set once a press opened a menu, so the `touchend` ending it is swallowed. */
  let fired = false;

  const clearPending = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  const handleTouchStart = (e: TouchEvent) => {
    // A second finger is a pinch, and it ends any press already pending: a
    // pinch that starts one finger at a time leaves the first finger sitting
    // still, so the wobble-cancel would never see it and the hold would fire
    // mid-gesture. `fired` is deliberately untouched - a press that already
    // opened a menu still owns the `touchend` that ends it.
    if (e.touches.length !== 1) {
      clearPending();
      return;
    }
    if (options.isEnabled?.() === false) return;
    const touch = e.touches[0]!;
    const start: LongPressStart = {
      clientX: touch.clientX,
      clientY: touch.clientY,
      target: e.target,
    };
    pending = start;
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      pending = null;
      if (options.isEnabled?.() === false) return;
      fired = options.onLongPress(start);
    }, LONG_PRESS_MS);
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (!pending || timer === null) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - pending.clientX;
    const dy = touch.clientY - pending.clientY;
    if (dx * dx + dy * dy > MOVE_CANCEL_PX_SQUARED) {
      clearPending();
      fired = false;
    }
  };

  const handleTouchEnd = (e: TouchEvent) => {
    if (fired) {
      e.preventDefault();
      fired = false;
    }
    clearPending();
  };

  const handleTouchCancel = () => {
    clearPending();
    fired = false;
  };

  target.addEventListener('touchstart', handleTouchStart, { passive: false });
  target.addEventListener('touchmove', handleTouchMove, { passive: false });
  target.addEventListener('touchend', handleTouchEnd, { passive: false });
  target.addEventListener('touchcancel', handleTouchCancel);

  return () => {
    target.removeEventListener('touchstart', handleTouchStart);
    target.removeEventListener('touchmove', handleTouchMove);
    target.removeEventListener('touchend', handleTouchEnd);
    target.removeEventListener('touchcancel', handleTouchCancel);
    clearPending();
    fired = false;
  };
}
