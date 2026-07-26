/**
 * Toast stack geometry: how many toasts may be on screen, and where each one
 * sits.
 *
 * Both answers are pure functions of measured pixel heights, deliberately kept
 * out of the component so they can be tested without a layout engine (jsdom has
 * none). ToastStack does the measuring; this module does the arithmetic.
 *
 * The capacity rule is "min(5, what fits in 20% of the window height), but never
 * fewer than 2": a tall window must not turn into a wall of toasts, a short one
 * must not hide the map behind them, and even a very short one still shows a
 * second toast so a follow-up message is never invisible.
 */

/**
 * Floor. Two toasts always fit, even when 20% of the window is not enough room
 * for them: a single-slot stack would silently swallow the second half of any
 * "did X, then Y failed" pair.
 */
export const MIN_VISIBLE_TOASTS = 2;

/**
 * Ceiling, however tall the window. Past five the stack stops reading as a list
 * of notifications and starts reading as a panel, and the oldest entries are
 * long stale by the time the eye reaches them.
 */
export const MAX_VISIBLE_TOASTS = 5;

/** Fraction of the window height the stack may occupy before it stops growing. */
export const TOAST_HEIGHT_BUDGET = 0.2;

/** Vertical gap between two stacked toasts, in CSS px. */
export const TOAST_GAP_PX = 8;

/**
 * Stand-in height for a toast that has not been measured yet - a single-line
 * toast at the default UI scale. Used for the not-yet-mounted slots when asking
 * "could another one fit?", and for the first frame of a new toast (which is
 * invisible anyway: it enters at opacity 0).
 */
export const ESTIMATED_TOAST_HEIGHT_PX = 40;

/** Clamp any candidate capacity into the allowed band. */
export function clampToastCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) return MAX_VISIBLE_TOASTS;
  return Math.min(MAX_VISIBLE_TOASTS, Math.max(MIN_VISIBLE_TOASTS, Math.floor(capacity)));
}

/**
 * How many toasts fit on screen.
 *
 * `heights` is NEWEST-FIRST: the newest toast is the one nearest the bottom
 * edge and is the last to be given up, so the walk starts there. Slots past the
 * end of `heights` (toasts that have not arrived yet) are costed at
 * `fallbackHeight`, which is what makes the answer a capacity rather than just a
 * description of the current stack.
 *
 * @param viewportHeight window height in CSS px
 * @param heights measured toast heights, newest first, in CSS px
 */
export function fitToastCapacity(
  viewportHeight: number,
  heights: readonly number[],
  gap: number = TOAST_GAP_PX,
  fallbackHeight: number = ESTIMATED_TOAST_HEIGHT_PX,
): number {
  // A non-positive height means NOT MEASURED YET (first paint, a webview that
  // has not reported a size, a zero-layout test env) - not "a window with no
  // room". Collapsing to the floor on a degenerate reading would strand the
  // stack at 2 forever, because nothing re-triggers the measurement on a window
  // that never resizes. Unmeasured therefore means no constraint.
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return MAX_VISIBLE_TOASTS;

  const budget = viewportHeight * TOAST_HEIGHT_BUDGET;

  let used = 0;
  let fitted = 0;
  while (fitted < MAX_VISIBLE_TOASTS) {
    const measured = heights[fitted];
    const height =
      typeof measured === 'number' && Number.isFinite(measured) && measured > 0
        ? measured
        : fallbackHeight;
    const next = used + height + (fitted > 0 ? gap : 0);
    if (next > budget) break;
    used = next;
    fitted += 1;
  }

  return clampToastCapacity(fitted);
}

/**
 * Distance in px from the stack's bottom anchor to each toast's own bottom edge.
 *
 * `heights` is OLDEST-FIRST, matching `UIStore.toasts`; the returned offsets are
 * in the same order. The newest (last) toast sits ON the anchor at 0 and every
 * older one is pushed up by the full height of everything newer than it, gaps
 * included. Rendering is `translateY(-offset)`, so a changed offset is animated
 * by the CSS transition rather than jumping the way a flex reflow would.
 */
export function toastStackOffsets(heights: readonly number[], gap: number = TOAST_GAP_PX): number[] {
  const offsets = new Array<number>(heights.length).fill(0);
  let stacked = 0;
  for (let i = heights.length - 1; i >= 0; i -= 1) {
    offsets[i] = stacked;
    stacked += (heights[i] ?? 0) + gap;
  }
  return offsets;
}

/** Total height of the stack, gaps included - the hover/hit area of the column. */
export function toastStackHeight(heights: readonly number[], gap: number = TOAST_GAP_PX): number {
  if (heights.length === 0) return 0;
  const total = heights.reduce((sum, h) => sum + (h || 0), 0);
  return total + gap * (heights.length - 1);
}
