/**
 * #429 item 7 - UI scale 3.0 collapsed the layout.
 *
 * The webview page zoom divides the window, so the CSS viewport the app lays out
 * in is `window / scale`. Scale is user-settable up to 3.0 and the window minimum
 * is 800x600, which put a reachable 427x240 viewport on screen. `effectiveUiScale`
 * caps what reaches the webview so `window / scale` never drops below
 * MIN_UI_VIEWPORT_WIDTH x MIN_UI_VIEWPORT_HEIGHT, without touching the stored
 * preference.
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveUiScale,
  shouldApplyUiScale,
  MIN_UI_VIEWPORT_WIDTH,
  MIN_UI_VIEWPORT_HEIGHT,
  UI_SCALE_APPLY_DEADBAND,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from '../uiScale';

/**
 * `window / scale` is a reciprocal of a value that is not exactly representable
 * (640 / 1.28 is 499.99999999999994), so the viewport assertions carry a
 * sub-nanometre tolerance. It absorbs double rounding only - a real percent of
 * slack in the cap is five orders of magnitude larger and still fails.
 */
const EPS = 1e-9;

describe('effectiveUiScale', () => {
  it('leaves a preference that already fits alone', () => {
    expect(effectiveUiScale(1.0, 1280, 720)).toBe(1.0);
    expect(effectiveUiScale(2.0, 2560, 1440)).toBe(2.0);
    // Exactly at the floor on both axes: the preference is reachable, so it stands.
    expect(effectiveUiScale(2.0, MIN_UI_VIEWPORT_WIDTH * 2, MIN_UI_VIEWPORT_HEIGHT * 2)).toBe(2.0);
  });

  it('caps the reported repro: scale 3.0 in a 1280x720 window', () => {
    // Height binds first: 720/500 = 1.44 vs 1280/800 = 1.6.
    expect(effectiveUiScale(3.0, 1280, 720)).toBe(1.44);
  });

  it('caps on whichever axis binds', () => {
    // Width binds: 900/800 = 1.125 vs 1200/500 = 2.4.
    expect(effectiveUiScale(3.0, 900, 1200)).toBe(1.12);
    // Height binds: 1000/500 = 2.0 vs 3000/800 = 3.75.
    expect(effectiveUiScale(3.0, 3000, 1000)).toBe(2.0);
  });

  it('never lets the resulting viewport fall below the minimum', () => {
    for (const [w, h] of [
      [800, 600],
      [1024, 640],
      [1280, 720],
      [1366, 768],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ] as const) {
      const scale = effectiveUiScale(UI_SCALE_MAX, w, h);
      expect(w / scale).toBeGreaterThanOrEqual(MIN_UI_VIEWPORT_WIDTH - EPS);
      expect(h / scale).toBeGreaterThanOrEqual(MIN_UI_VIEWPORT_HEIGHT - EPS);
    }
  });

  it('allows scale 1.0 at the 800x600 window minimum', () => {
    expect(effectiveUiScale(1.0, 800, 600)).toBe(1.0);
  });

  it('only ever caps downward - it never magnifies a modest preference', () => {
    expect(effectiveUiScale(1.0, 3840, 2160)).toBe(1.0);
    expect(effectiveUiScale(0.5, 1280, 720)).toBe(0.5);
  });

  it('does not zoom out past the slider floor for an undersized window', () => {
    // Below the window minimum no scale satisfies the viewport; shrinking the UI
    // past 0.5 to chase it would only make it unreadable.
    expect(effectiveUiScale(1.0, 200, 120)).toBe(UI_SCALE_MIN);
    expect(effectiveUiScale(UI_SCALE_MIN, 200, 120)).toBe(UI_SCALE_MIN);
  });

  it('clamps the preference itself before capping', () => {
    expect(effectiveUiScale(99, 8000, 6000)).toBe(UI_SCALE_MAX);
    expect(effectiveUiScale(0.01, 8000, 6000)).toBe(UI_SCALE_MIN);
  });

  it('passes the preference through on an unmeasured window', () => {
    expect(effectiveUiScale(3.0, 0, 0)).toBe(3.0);
    expect(effectiveUiScale(3.0, -1, 720)).toBe(3.0);
    expect(effectiveUiScale(3.0, Number.NaN, 720)).toBe(3.0);
    expect(effectiveUiScale(3.0, Number.POSITIVE_INFINITY, 720)).toBe(3.0);
  });

  it('settles within the apply deadband when re-measured through the applied zoom', () => {
    // Setting the zoom fires `resize`, and the handler recovers the window size as
    // `innerSize * appliedScale` from an INTEGER innerSize - so the second pass sees
    // a slightly different number. The recomputation has to converge inside the
    // deadband on the first re-measure, or setZoom and resize ping-pong forever.
    for (const [w, h] of [
      [1280, 720],
      [1024, 640],
      [1366, 768],
      [1920, 1080],
      [1600, 900],
      [800, 600],
    ] as const) {
      let applied = 1;
      for (let i = 0; i < 6; i += 1) {
        const innerW = Math.floor(w / applied);
        const innerH = Math.floor(h / applied);
        const next = effectiveUiScale(UI_SCALE_MAX, innerW * applied, innerH * applied);
        if (i > 0) expect(shouldApplyUiScale(applied, next)).toBe(false);
        applied = next;
        // The recovered size slightly understates the window, so the cap it yields
        // is if anything conservative - the real viewport still clears the floor.
        expect(w / applied).toBeGreaterThanOrEqual(MIN_UI_VIEWPORT_WIDTH - EPS);
        expect(h / applied).toBeGreaterThanOrEqual(MIN_UI_VIEWPORT_HEIGHT - EPS);
      }
    }
  });

  it('leaves the deadband narrower than one slider step', () => {
    expect(UI_SCALE_APPLY_DEADBAND).toBeLessThan(UI_SCALE_STEP);
  });

  it('is monotonic in the window size, so growing the window never shrinks the UI', () => {
    let previous = 0;
    for (let width = 600; width <= 4000; width += 37) {
      const scale = effectiveUiScale(UI_SCALE_MAX, width, 4000);
      expect(scale).toBeGreaterThanOrEqual(previous);
      previous = scale;
    }
  });
});

describe('shouldApplyUiScale', () => {
  it('always applies the first time - the webview starts at 1.0', () => {
    expect(shouldApplyUiScale(null, 1.0)).toBe(true);
  });

  it('applies every step the user can actually ask for', () => {
    expect(shouldApplyUiScale(1.0, 1.0 + UI_SCALE_STEP)).toBe(true);
    expect(shouldApplyUiScale(1.0, 1.0 - UI_SCALE_STEP)).toBe(true);
    expect(shouldApplyUiScale(1.44, 3.0)).toBe(true);
  });

  it('swallows sub-deadband jitter in either direction', () => {
    expect(shouldApplyUiScale(1.44, 1.44)).toBe(false);
    expect(shouldApplyUiScale(1.44, 1.45)).toBe(false);
    expect(shouldApplyUiScale(1.44, 1.43)).toBe(false);
  });
});
