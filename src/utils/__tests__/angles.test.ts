import { describe, it, expect } from 'vitest';
import { circularMeanDegrees, normalizeAngle } from '../angles';

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
