/**
 * Unit tests for zoomRate - the scroll-zoom setting is levels-per-notch, and
 * the rate handed to MapLibre is the inverse of MapLibre's own sigmoid (#429).
 *
 * `levelsPerNotchForWheelZoomRate` is a transcription of maplibre-gl 5.16's
 * `ScrollZoomHandler.renderFrame`:
 *
 *     let scale = maxScalePerFrame / (1 + Math.exp(-Math.abs(this._delta * zoomRate)));
 *
 * with `maxScalePerFrame = 2` and `_delta = 100` for one wheel notch, so a
 * round-trip through it is a round-trip through the renderer's arithmetic.
 */

import { describe, it, expect } from 'vitest';
import {
  clampZoomLevelsPerNotch,
  levelsPerNotchForWheelZoomRate,
  wheelZoomRateForLevels,
  ZOOM_LEVELS_PER_NOTCH_DEFAULT,
  ZOOM_LEVELS_PER_NOTCH_MAX,
  ZOOM_LEVELS_PER_NOTCH_MIN,
} from '../zoomRate';

/** Every step the settings input offers, min (0.1) to max (0.95) inclusive. */
const SETTING_STEPS = Array.from({ length: 18 }, (_, i) => Number((0.1 + 0.05 * i).toFixed(2)));

describe('wheelZoomRateForLevels', () => {
  it.each(SETTING_STEPS)('%s levels/notch round-trips through MapLibre\'s sigmoid', (levels) => {
    expect(levelsPerNotchForWheelZoomRate(wheelZoomRateForLevels(levels))).toBeCloseTo(levels, 10);
  });

  it('the whole range is linear: equal setting steps are equal level steps', () => {
    const delivered = SETTING_STEPS.map((l) => levelsPerNotchForWheelZoomRate(wheelZoomRateForLevels(l)));
    delivered.slice(1).forEach((level, i) => {
      expect(level - delivered[i]!).toBeCloseTo(0.05, 9);
    });
  });

  it('stays finite and usable at the top of the range', () => {
    // The solve runs to Infinity AT the sigmoid's ceiling, and the rates just
    // below it turn a small trackpad delta into a whole zoom level. The maximum
    // has to sit far enough short of the ceiling to stay in the rate band the
    // setting already shipped (0.001 at the old 0.1, 0.05 at the old 5.0).
    const rate = wheelZoomRateForLevels(ZOOM_LEVELS_PER_NOTCH_MAX);
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeLessThan(0.05);
    // A 10 px trackpad delta stays a small fraction of a level at full speed.
    expect(levelsPerNotchForWheelZoomRate(rate / 10)).toBeLessThan(0.25);
  });

  it('the old top half of the range is no longer wasted', () => {
    // What the setting used to deliver: rate = speed / 100, so speed 3.0 and 5.0
    // were 0.06 levels apart out of a nominal 2.0 of travel.
    expect(levelsPerNotchForWheelZoomRate(3.0 / 100)).toBeCloseTo(0.9299, 4);
    expect(levelsPerNotchForWheelZoomRate(5.0 / 100)).toBeCloseTo(0.9903, 4);
    // Two setting steps now differ by the two-tenths of a level they claim,
    // anywhere in the range - including at the top, where the old knob was flat.
    for (const low of [0.1, 0.4, 0.75]) {
      const spread =
        levelsPerNotchForWheelZoomRate(wheelZoomRateForLevels(low + 0.2)) -
        levelsPerNotchForWheelZoomRate(wheelZoomRateForLevels(low));
      expect(spread).toBeCloseTo(0.2, 9);
    }
  });

  it('is monotonic in the setting', () => {
    const rates = SETTING_STEPS.map(wheelZoomRateForLevels);
    rates.slice(1).forEach((rate, i) => {
      expect(rate).toBeGreaterThan(rates[i]!);
    });
  });

  it('clamps out-of-range and junk values to something the sigmoid can deliver', () => {
    // Configs written before the remap hold up to 5.0; they must land on the
    // maximum, not produce an Infinite or NaN rate that would break scroll zoom.
    for (const legacy of [1.0, 1.5, 3.0, 5.0]) {
      expect(levelsPerNotchForWheelZoomRate(wheelZoomRateForLevels(legacy)))
        .toBeCloseTo(ZOOM_LEVELS_PER_NOTCH_MAX, 10);
    }
    for (const tooSlow of [0, -1, 0.001]) {
      expect(levelsPerNotchForWheelZoomRate(wheelZoomRateForLevels(tooSlow)))
        .toBeCloseTo(ZOOM_LEVELS_PER_NOTCH_MIN, 10);
    }
    expect(levelsPerNotchForWheelZoomRate(wheelZoomRateForLevels(NaN)))
      .toBeCloseTo(ZOOM_LEVELS_PER_NOTCH_DEFAULT, 10);
    for (const junk of [NaN, Infinity, -Infinity, 5.0, -1]) {
      expect(Number.isFinite(wheelZoomRateForLevels(junk))).toBe(true);
    }
  });

  it('the default setting preserves the pre-remap default feel', () => {
    // The old default fed rate = 1.0/100 and delivered 0.548 levels per notch.
    expect(levelsPerNotchForWheelZoomRate(0.01)).toBeCloseTo(0.548, 3);
    expect(levelsPerNotchForWheelZoomRate(wheelZoomRateForLevels(ZOOM_LEVELS_PER_NOTCH_DEFAULT)))
      .toBeCloseTo(0.548, 2);
  });
});

describe('clampZoomLevelsPerNotch', () => {
  it('passes in-range values through untouched', () => {
    for (const levels of SETTING_STEPS) {
      expect(clampZoomLevelsPerNotch(levels)).toBe(levels);
    }
  });

  it('clamps to the range ends', () => {
    expect(clampZoomLevelsPerNotch(5.0)).toBe(ZOOM_LEVELS_PER_NOTCH_MAX);
    expect(clampZoomLevelsPerNotch(1.0)).toBe(ZOOM_LEVELS_PER_NOTCH_MAX);
    expect(clampZoomLevelsPerNotch(0.01)).toBe(ZOOM_LEVELS_PER_NOTCH_MIN);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampZoomLevelsPerNotch(NaN)).toBe(ZOOM_LEVELS_PER_NOTCH_DEFAULT);
    expect(clampZoomLevelsPerNotch(-Infinity)).toBe(ZOOM_LEVELS_PER_NOTCH_DEFAULT);
  });
});
