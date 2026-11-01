import { describe, it, expect } from 'vitest';
import { circularMeanDegrees, meanOrLoneLeg, normalizeAngle } from '../angles';

describe('normalizeAngle', () => {
  it('returns angle unchanged when already in [0, 360)', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(359.9)).toBe(359.9);
  });

  it('normalizes 360 to 0', () => {
    expect(normalizeAngle(360)).toBe(0);
  });

  it('normalizes angles > 360', () => {
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(720)).toBe(0);
    expect(normalizeAngle(725)).toBe(5);
  });

  it('normalizes negative angles', () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(-270)).toBe(90);
    expect(normalizeAngle(-360)).toBe(0);
    expect(normalizeAngle(-10)).toBe(350);
  });

  it('handles very large angles', () => {
    expect(normalizeAngle(3600)).toBe(0);
    expect(normalizeAngle(3605)).toBe(5);
  });

  it('handles very small negative angles', () => {
    expect(normalizeAngle(-3600)).toBe(0);
    expect(normalizeAngle(-3605)).toBe(355);
  });

  it('folds a tiny negative angle to 0, never to exactly 360', () => {
    // `-1e-14 % 360` is -1e-14, and `-1e-14 + 360` rounds to exactly 360 in
    // binary floating point - a bearing outside [0, 360) that the backend
    // flags as a non-ignorable INVALID_AZIMUTH.
    expect(normalizeAngle(-1e-14)).toBe(0);
    expect(normalizeAngle(-4.440892098500626e-16)).toBe(0);
    expect(normalizeAngle(-Number.MIN_VALUE)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(normalizeAngle(NaN)).toBe(0);
  });

  it('returns 0 for Infinity', () => {
    expect(normalizeAngle(Infinity)).toBe(0);
  });

  it('returns 0 for -Infinity', () => {
    expect(normalizeAngle(-Infinity)).toBe(0);
  });
});

describe('circularMeanDegrees', () => {
  it('calculates simple average for angles not crossing 0/360', () => {
    // Use toBeCloseTo for floating point comparisons
    expect(circularMeanDegrees(10, 20)).toBeCloseTo(15, 10);
    expect(circularMeanDegrees(100, 110)).toBeCloseTo(105, 10);
    expect(circularMeanDegrees(0, 90)).toBeCloseTo(45, 10);
  });

  it('handles wrap-around at 0/360 boundary', () => {
    // 350 and 10 should average to ~0, not 180
    const result = circularMeanDegrees(350, 10);
    expect(result).toBeCloseTo(0, 5);
  });

  it('handles wrap-around with 355 and 5', () => {
    const result = circularMeanDegrees(355, 5);
    expect(result).toBeCloseTo(0, 5);
  });

  it('handles wrap-around with 359 and 1', () => {
    const result = circularMeanDegrees(359, 1);
    expect(result).toBeCloseTo(0, 5);
  });

  it('handles opposite angles (180 degrees apart)', () => {
    // When angles are exactly opposite, the mean is ambiguous
    // but the algorithm will return something consistent
    const result = circularMeanDegrees(0, 180);
    // Mean of opposite angles is poorly defined, but should be a valid angle
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(360);
  });

  it('handles same angle', () => {
    expect(circularMeanDegrees(45, 45)).toBeCloseTo(45, 10);
    expect(circularMeanDegrees(350, 350)).toBeCloseTo(350, 10);
    expect(circularMeanDegrees(0, 0)).toBeCloseTo(0, 10);
  });

  it('returns result in [0, 360) range', () => {
    // Various inputs should always produce output in [0, 360)
    const testCases: [number, number][] = [
      [270, 280],
      [350, 10],
      [10, 350],
      [180, 270],
      [90, 180],
    ];

    for (const [a, b] of testCases) {
      const result = circularMeanDegrees(a, b);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(360);
    }
  });

  it('handles angles > 360 (they still work)', () => {
    // Even though inputs aren't normalized, the math still works
    const result = circularMeanDegrees(370, 380);
    expect(result).toBeCloseTo(15, 5); // 370=10, 380=20, mean=15
  });
});

describe('meanOrLoneLeg', () => {
  it('is the circular mean when both legs are measured', () => {
    expect(meanOrLoneLeg(10, 20)).toBeCloseTo(15, 10);
    expect(meanOrLoneLeg(350, 10)).toBeCloseTo(0, 5);
  });

  it('is the lone leg when only one was measured', () => {
    // A shot with one azimuth is real and saveable (the other leg is duplicated
    // at commit); averaging it against the unset NaN leg showed it as blank.
    expect(meanOrLoneLeg(123, NaN)).toBe(123);
    expect(meanOrLoneLeg(NaN, 123)).toBe(123);
  });

  it('is NaN only when neither leg was measured', () => {
    expect(Number.isNaN(meanOrLoneLeg(NaN, NaN))).toBe(true);
  });

  it('treats an infinite leg as unmeasured', () => {
    expect(meanOrLoneLeg(Infinity, 42)).toBe(42);
  });
});
