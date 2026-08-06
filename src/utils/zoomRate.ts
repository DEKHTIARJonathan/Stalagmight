/**
 * Scroll-zoom speed <-> MapLibre's wheel zoom rate.
 *
 * MapLibre consumes the wheel delta accumulated since the last rendered frame
 * and scales the camera by `maxScalePerFrame / (1 + exp(-|delta * rate|))`, with
 * `maxScalePerFrame` a hard-coded 2 (maplibre-gl 5.16 scroll_zoom). A standard
 * 100 px notch therefore moves
 *
 *     levels = log2(2 / (1 + e^-(100 * rate)))
 *
 * zoom levels: a sigmoid whose ceiling is ONE level per notch at any rate. The
 * setting used to be handed straight to MapLibre as `speed / 100`, which made
 * the top of its 0.1-5.0 range inert - 0.548 levels at 1.0, 0.930 at 3.0, 0.990
 * at 5.0, so more than half the range was indistinguishable (#429). Configs
 * written under that scheme hold values up to 5.0; they clamp to the new
 * maximum, which is the closest the range gets to what they used to ask for.
 *
 * `map.controls.zoom_speed` is now the levels-per-notch figure itself, and this
 * module inverts the sigmoid for it:
 *
 *     rate = -ln(2 / 2^levels - 1) / 100
 *
 * which is exact for every `levels` strictly below the ceiling, so every step of
 * the range is worth the same 0.1 levels.
 */

/** Zoom levels moved by one wheel notch at the slowest setting. */
export const ZOOM_LEVELS_PER_NOTCH_MIN = 0.1;

/**
 * The fastest setting. It stops short of the sigmoid's one-level ceiling
 * because the rate needed to REACH the ceiling is infinite, and a rate merely
 * near it is already unusable for anything that is not a full notch: the
 * setting drives trackpad scrolling too, and at the 0.4 rate that a 40-capped
 * solve produces, a 10 px trackpad delta is a whole zoom level. 0.95 solves to
 * 0.0334, inside the 0.001-0.05 band the old speed knob already shipped.
 */
export const ZOOM_LEVELS_PER_NOTCH_MAX = 0.95;

/**
 * Mirrors `MapControlsConfig::default().zoom_speed`, and the fallback before
 * config loads. 0.55 is what the pre-remap default of 1.0 actually delivered
 * (0.548 levels), so the default gesture feels the same as it always did.
 */
export const ZOOM_LEVELS_PER_NOTCH_DEFAULT = 0.55;

/** Wheel delta of one mouse notch, in the px units MapLibre normalises to. */
const WHEEL_NOTCH_PX = 100;

/** MapLibre's `maxScalePerFrame`, the numerator of its sigmoid. */
const MAX_SCALE_PER_FRAME = 2;

/** Keep a configured value inside the range the sigmoid can usefully deliver. */
export function clampZoomLevelsPerNotch(levels: number): number {
  if (!Number.isFinite(levels)) return ZOOM_LEVELS_PER_NOTCH_DEFAULT;
  return Math.min(ZOOM_LEVELS_PER_NOTCH_MAX, Math.max(ZOOM_LEVELS_PER_NOTCH_MIN, levels));
}

/**
 * The MapLibre zoom rate that moves `levels` zoom levels per 100 px wheel notch.
 * The clamp keeps `levels` under the ceiling, so the ratio stays positive and
 * the solve stays finite for every input, junk included.
 */
export function wheelZoomRateForLevels(levels: number): number {
  const ratio = MAX_SCALE_PER_FRAME / Math.pow(2, clampZoomLevelsPerNotch(levels)) - 1;
  return -Math.log(ratio) / WHEEL_NOTCH_PX;
}

/** MapLibre's own sigmoid: the levels a 100 px notch moves at `rate`. */
export function levelsPerNotchForWheelZoomRate(rate: number): number {
  return Math.log2(MAX_SCALE_PER_FRAME / (1 + Math.exp(-Math.abs(WHEEL_NOTCH_PX * rate))));
}
