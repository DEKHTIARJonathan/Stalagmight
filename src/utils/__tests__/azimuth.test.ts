import { describe, it, expect } from 'vitest';
import { normalizeAzimuth, averageAzimuth } from '../azimuth';

describe('normalizeAzimuth', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeAzimuth(0)).toBe(0);
    expect(normalizeAzimuth(360)).toBe(0);
    expect(normalizeAzimuth(370)).toBe(10);
    expect(normalizeAzimuth(-10)).toBe(350);
    expect(normalizeAzimuth(-370)).toBe(350);
    expect(normalizeAzimuth(725)).toBe(5);
  });
});

describe('averageAzimuth', () => {
  it('averages within the same quadrant', () => {
    expect(averageAzimuth(45, 69)).toBeCloseTo(57, 6);
    expect(averageAzimuth(90, 90)).toBeCloseTo(90, 6);
  });

  it('averages across the short arc through north', () => {
    // 350° and 10° should average to 0°, not 180°.
    expect(averageAzimuth(350, 10)).toBeCloseTo(0, 6);
    expect(averageAzimuth(10, 350)).toBeCloseTo(0, 6);
  });

  it('matches the Rust Shot::average_azimuth examples', () => {
    // 270° and 0° → short arc midpoint at 315°.
    expect(averageAzimuth(270, 0)).toBeCloseTo(315, 6);
  });

  it('pins the ambiguous antipodal case to match Rust (floor toward -180)', () => {
    // Rust's +540/%360-180 biases the 180°-apart case: average_azimuth(0,180)=270,
    // average_azimuth(180,0)=90. Lock both so a "symmetric rounding" refactor can't
    // silently diverge from the backend.
    expect(averageAzimuth(0, 180)).toBeCloseTo(270, 6);
    expect(averageAzimuth(180, 0)).toBeCloseTo(90, 6);
  });

  it('always returns a value in [0, 360)', () => {
    for (const [a, b] of [[0, 0], [359, 1], [180, 180], [1, 359], [200, 20]]) {
      const avg = averageAzimuth(a!, b!);
      expect(avg).toBeGreaterThanOrEqual(0);
      expect(avg).toBeLessThan(360);
    }
  });
});
