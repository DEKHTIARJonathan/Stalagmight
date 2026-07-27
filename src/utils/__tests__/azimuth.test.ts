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

  it('clamps the 360 escape a bare `% 360` + `+= 360` leaves behind', () => {
    // Precondition: the addend ROUNDS, so the naive form returns exactly 360 -
    // out of range, and INVALID_AZIMUTH is error severity, so not ignorable.
    const naive = (v: number) => { let n = v % 360; if (n < 0) n += 360; return n; };
    expect(naive(-1e-14)).toBe(360);

    expect(normalizeAzimuth(-1e-14)).toBe(0);
    expect(normalizeAzimuth(-1e-300)).toBe(0);
  });

  it('never returns negative zero', () => {
    // `-0 % 360` is `-0`, which is not `< 0`, so it slipped past the old guard.
    expect(Object.is(naiveNegativeZero(), -0)).toBe(true);
    expect(Object.is(normalizeAzimuth(-0), 0)).toBe(true);
    expect(Object.is(normalizeAzimuth(-360), 0)).toBe(true);
  });

  it('passes a non-finite value through', () => {
    expect(normalizeAzimuth(Number.NaN)).toBeNaN();
    expect(normalizeAzimuth(Infinity)).toBe(Infinity);
    expect(normalizeAzimuth(-Infinity)).toBe(-Infinity);
  });
});

/** The old body, kept only to pin the precondition of the negative-zero test. */
function naiveNegativeZero(): number {
  let n = -0 % 360;
  if (n < 0) n += 360;
  return n;
}

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

  it('matches Rust for readings outside [0, 360)', () => {
    // Rust wraps with `rem_euclid` (sign of the divisor); a bare JS `%` keeps the
    // sign of the dividend, so the two agreed only while `out - in + 540` stayed
    // non-negative. Past that they returned ANTIPODES - this case read 280 here
    // against the backend's 100. Out-of-range readings are reachable:
    // INVALID_AZIMUTH is only a warning and DMP headings are stored verbatim.
    expect(averageAzimuth(400, -200)).toBeCloseTo(100, 6);
    // diff = (-400 - 400 + 540).rem_euclid(360) - 180 = 100 - 180 = -80
    // -> (400 - 40).rem_euclid(360) = 0, i.e. the same as averaging 40 and 320.
    expect(averageAzimuth(400, -400)).toBeCloseTo(0, 6);
    expect(averageAzimuth(400, -400)).toBeCloseTo(averageAzimuth(40, 320), 6);
    // diff = (10 - 730 + 540).rem_euclid(360) - 180 = 180 - 180 = 0 -> 730 % 360
    expect(averageAzimuth(730, 10)).toBeCloseTo(10, 6);
    // A negative pair still lands on the same bearing as its in-range twin.
    expect(averageAzimuth(-10, -30)).toBeCloseTo(averageAzimuth(350, 330), 6);
  });

  it('never returns 360 for an ordinary fore/back pair averaging to north', () => {
    // The reachable case, not a crafted ulp: every pair whose circular mean is
    // exactly north lands on the 360 escape, and there are 360 of them on a plain
    // 0.1-degree grid. Mirrors the Rust
    // `average_of_ordinary_fore_back_readings_is_never_360`.
    for (const [a, b] of [[0.1, 359.9], [0.3, 359.7], [0.6, 359.4]]) {
      const avg = averageAzimuth(a!, b!);
      expect(avg).toBeGreaterThanOrEqual(0);
      expect(avg).toBeLessThan(360);
    }
    expect(averageAzimuth(0.1, 359.9)).toBe(0);
  });

  it('always returns a value in [0, 360)', () => {
    for (const [a, b] of [[0, 0], [359, 1], [180, 180], [1, 359], [200, 20]]) {
      const avg = averageAzimuth(a!, b!);
      expect(avg).toBeGreaterThanOrEqual(0);
      expect(avg).toBeLessThan(360);
    }
  });
});
