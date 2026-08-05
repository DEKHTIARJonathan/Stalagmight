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

export interface LongPressTouchOptions {
  /**
   * The hold completed. Receives the `Touch` that started it - a `Touch` is a
   * snapshot rather than a live handle, so its `clientX`/`clientY` are still
   * where the finger landed, which is the position the menu belongs at.
   *
   * Return whether a menu actually opened. `true` arms the `touchend`
   * suppression described in the module doc; `false` (nothing under the
   * finger) leaves the trailing tap alone, so it behaves like any other tap.
   */
  onLongPress: (touch: Touch) => boolean;
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
  /** The touch that started the pending press, or null when none is pending. */
  let pending: Touch | null = null;
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
    if (e.touches.length !== 1) return;
    if (options.isEnabled?.() === false) return;
    const touch = e.touches[0]!;
    pending = touch;
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      pending = null;
      if (options.isEnabled?.() === false) return;
      fired = options.onLongPress(touch);
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
