/**
 * #681: per-shot choices for repeated survey.
 *
 * INJECTION (tried): `resolvedReading` returning the existing reading for
 * 'use_new' reds "Use new copies the new reading"; dropping the `+ 180 ... - 180`
 * wrap in `readingDiff` reds the 359/1 azimuth case; `>=` in
 * `exceedsRepeatTolerance` reds the at-tolerance case.
 */
import { describe, it, expect } from 'vitest';
import type { TargetShotLike } from '../overlapHelpers';
import {
  exceedsRepeatTolerance,
  readingDiff,
  resolvedReading,
  REPEAT_DIFF_TOLERANCE,
} from '../overlapChoices';

function shot(over: Partial<TargetShotLike> = {}): TargetShotLike {
  return {
    azimuth_in: 90,
    azimuth_out: 90,
    length: 10,
    depth_in: 5,
    depth_out: 6,
    pitch_in: -5,
    pitch_out: -5,
    left: 1,
    right: 1,
    up: 1,
    down: 1,
    ...over,
  };
}

describe('resolvedReading', () => {
  const existing = shot({ length: 10, azimuth_in: 350, azimuth_out: 350, depth_out: 6 });
  const incoming = shot({ length: 12, azimuth_in: 10, azimuth_out: 10, depth_out: 8 });

  it('Keep existing leaves the existing shot alone', () => {
    expect(resolvedReading('keep_existing', existing, incoming)).toBeNull();
  });

  it('Use new copies the new reading, and nothing but the reading', () => {
    const withIdentity = { ...incoming, id: 42, kind: 'Normal', comment: 'x' };
    expect(resolvedReading('use_new', existing, withIdentity)).toEqual(incoming);
  });

  it('Average takes the mean, circular for azimuth', () => {
    const r = resolvedReading('average', existing, incoming)!;
    expect(r.length).toBeCloseTo(11);
    expect(r.depth_out).toBeCloseTo(7);
    // 350 and 10 average to north, not south.
    expect(Math.min(r.azimuth_in, 360 - r.azimuth_in)).toBeCloseTo(0);
    expect(Object.keys(r)).not.toContain('id');
  });
});

describe('readingDiff / exceedsRepeatTolerance', () => {
  it('an identical repeat differs by nothing and is not flagged', () => {
    const d = readingDiff(shot(), shot());
    expect(d).toEqual({ length: 0, azimuth: 0, inclination: 0, depth: 0 });
    expect(exceedsRepeatTolerance(d)).toBe(false);
  });

  it('azimuth difference wraps through north', () => {
    const d = readingDiff(shot({ azimuth_in: 359, azimuth_out: 359 }), shot({ azimuth_in: 1, azimuth_out: 1 }));
    expect(d.azimuth).toBeCloseTo(2);
    expect(exceedsRepeatTolerance(d)).toBe(true);
  });

  it('depth difference is the larger of the start and end differences', () => {
    const d = readingDiff(shot({ depth_in: 5, depth_out: 6 }), shot({ depth_in: 5.05, depth_out: 6.3 }));
    expect(d.depth).toBeCloseTo(0.3);
  });

  it('inclination is null when either reading has none', () => {
    const d = readingDiff(shot(), shot({ pitch_in: null, pitch_out: null }));
    expect(d.inclination).toBeNull();
    expect(exceedsRepeatTolerance(d)).toBe(false);
  });

  it('a difference exactly at the tolerance is not flagged; just over it is', () => {
    const at = { length: REPEAT_DIFF_TOLERANCE.length, azimuth: 0, inclination: 0, depth: 0 };
    expect(exceedsRepeatTolerance(at)).toBe(false);
    expect(exceedsRepeatTolerance({ ...at, length: REPEAT_DIFF_TOLERANCE.length + 0.01 })).toBe(true);
  });
});
