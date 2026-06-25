import { describe, it, expect } from 'vitest';

import { formatPressure, formatRmv, formatVolume } from '../formatGas';

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
});
