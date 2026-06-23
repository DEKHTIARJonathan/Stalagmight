/**
 * Clamp `value` into the inclusive `[min, max]` range.
 *
 * Precondition: `min <= max`. With inverted bounds the result is `max` (the
 * outer `Math.min` wins), which is intentional but only meaningful for valid
 * ranges — all callers pass constant `min < max`.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp `value` into `[min, max]` and round to a whole pixel.
 *
 * Resize math runs on `getBoundingClientRect`, which is sub-pixel under the
 * webview UI zoom / HiDPI. Rounding keeps live drag layout on integer widths
 * (no sub-pixel reflow). It is also the layout-side companion to the `u32`
 * panel-size persist contract: that contract is enforced once at the store
 * choke-point (`savePanelSizes`), but emitting integers from the resize path
 * keeps the live and persisted values identical.
 */
export function clampRound(value: number, min: number, max: number): number {
  // A non-finite input (NaN/±Infinity) would survive `clamp` unchanged (every
  // comparison with NaN is false) and round to NaN — which downstream fails the
  // `u32` panel-size persist contract and is silently dropped. Fall back to the
  // floor so the result is always a valid in-range integer.
  if (!Number.isFinite(value)) return min;
  return Math.round(clamp(value, min, max));
}
