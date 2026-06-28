import { describe, it, expect } from 'vitest';

import {
  formatLength,
  formatPressure,
  formatRmv,
  formatVolume,
  pressureFromDisplay,
  pressureToDisplay,
  rmvFromDisplay,
  rmvToDisplay,
} from '../formatGas';

// Values kept under 1000 in their formatted form so Intl grouping (thousands
// separators) can't make the assertions locale-dependent.
describe('formatGas', () => {
  describe('formatPressure', () => {
    it('formats bar (metric) with no conversion', () => {
      expect(formatPressure(230, 'metric')).toBe('230 bar');
    });
    it('converts bar → psi (imperial)', () => {
      // 50 bar × 14.5037738 = 725.19 → "725 psi" (0 dp)
      expect(formatPressure(50, 'imperial')).toBe('725 psi');
    });
    it('respects an explicit precision', () => {
      expect(formatPressure(230.4, 'metric', 1)).toBe('230.4 bar');
    });
    it('renders "--" for non-finite', () => {
      expect(formatPressure(NaN, 'metric')).toBe('--');
      expect(formatPressure(Infinity, 'imperial')).toBe('--');
    });
  });

  describe('formatVolume', () => {
    it('formats litres (metric)', () => {
      expect(formatVolume(500, 'metric')).toBe('500 L');
    });
    it('converts litres → cuft (imperial)', () => {
      // 500 L × 0.0353146667 = 17.66 → "18 cuft" (0 dp)
      expect(formatVolume(500, 'imperial')).toBe('18 cuft');
    });
    it('renders "--" for non-finite', () => {
      expect(formatVolume(NaN, 'metric')).toBe('--');
    });
  });

  describe('formatRmv', () => {
    it('formats L/min (metric, 1 dp default)', () => {
      expect(formatRmv(14, 'metric')).toBe('14.0 L/min');
    });
    it('converts L/min → cuft/min (imperial, 2 dp default)', () => {
      // 14 L/min × 0.0353146667 = 0.494 → "0.49 cuft/min"
      expect(formatRmv(14, 'imperial')).toBe('0.49 cuft/min');
    });
    it('renders "--" for non-finite', () => {
      expect(formatRmv(NaN, 'metric')).toBe('--');
    });
  });

  describe('formatLength', () => {
    it('formats metres (metric, 0 dp default)', () => {
      expect(formatLength(300, 'metric')).toBe('300 m');
    });
    it('converts metres → feet (imperial)', () => {
      // 100 m × 3.2808399 = 328.08 → "328 ft" (0 dp)
      expect(formatLength(100, 'imperial')).toBe('328 ft');
    });
    it('respects an explicit precision (depth shown to 1 dp)', () => {
      expect(formatLength(30, 'metric', 1)).toBe('30.0 m');
    });
    it('renders "--" for non-finite', () => {
      expect(formatLength(NaN, 'metric')).toBe('--');
      expect(formatLength(Infinity, 'imperial')).toBe('--');
    });
  });

  // High-precision assertions that PIN the conversion constants. The expected values are
  // computed by hand (not from the implementation), so a constant typo (e.g. 14.5 vs
  // 14.5037738, or × vs ÷) flips the 4th decimal and fails — unlike the 0-dp cases above,
  // where a ~2% constant error would round away.
  describe('conversion constants (high-precision)', () => {
    it('bar → psi factor is 14.5037738', () => {
      // 10 bar × 14.5037738 = 145.037738
      expect(formatPressure(10, 'imperial', 4)).toBe('145.0377 psi');
    });
    it('litre → cuft factor is 0.0353146667', () => {
      // 1000 L × 0.0353146667 = 35.3146667
      expect(formatVolume(1000, 'imperial', 4)).toBe('35.3147 cuft');
    });
    it('RMV uses the same litre → cuft factor', () => {
      expect(formatRmv(1000, 'imperial', 4)).toBe('35.3147 cuft/min');
    });
  });

  // The editable-input converters must round-trip exactly (no drift across a unit
  // toggle) and be no-ops in metric.
  describe('display converters (editable inputs)', () => {
    it('pressure: metric is a no-op; imperial round-trips bar↔psi', () => {
      expect(pressureToDisplay(207, 'metric')).toBe(207);
      expect(pressureFromDisplay(207, 'metric')).toBe(207);
      expect(pressureToDisplay(207, 'imperial')).toBeCloseTo(3002.28, 2);
      expect(pressureFromDisplay(pressureToDisplay(207, 'imperial'), 'imperial')).toBeCloseTo(207, 9);
    });
    it('RMV: metric is a no-op; imperial round-trips L/min↔cuft/min', () => {
      expect(rmvToDisplay(20, 'metric')).toBe(20);
      expect(rmvFromDisplay(20, 'metric')).toBe(20);
      expect(rmvToDisplay(20, 'imperial')).toBeCloseTo(0.7063, 4);
      expect(rmvFromDisplay(rmvToDisplay(20, 'imperial'), 'imperial')).toBeCloseTo(20, 9);
    });
  });
});
