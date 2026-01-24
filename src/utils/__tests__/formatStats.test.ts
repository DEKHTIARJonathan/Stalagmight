import { describe, it, expect } from 'vitest';
import { formatLength, formatDepthRange } from '../formatStats';

describe('formatLength', () => {
  describe('meters unit', () => {
    it('formats with default precision (1 decimal)', () => {
      expect(formatLength(42.345, 'meters')).toBe('42.3m');
    });

    it('formats with specified precision', () => {
      expect(formatLength(42.345, 'meters', 0)).toBe('42m');
      expect(formatLength(42.346, 'meters', 2)).toBe('42.35m');
      expect(formatLength(42.345, 'meters', 3)).toBe('42.345m');
    });

    it('formats negative values', () => {
      expect(formatLength(-10.5, 'meters', 1)).toBe('-10.5m');
    });
  });

  describe('feet unit', () => {
    it('converts meters to feet', () => {
      // 10m = 32.8084ft
      expect(formatLength(10, 'feet', 1)).toBe('32.8ft');
    });

    it('converts with higher precision', () => {
      // 10m * 3.28084 = 32.8084ft
      expect(formatLength(10, 'feet', 4)).toBe('32.8084ft');
    });
  });

  describe('non-finite values', () => {
    it('returns "--" for NaN', () => {
      expect(formatLength(NaN, 'meters')).toBe('--');
    });

    it('returns "--" for Infinity', () => {
      expect(formatLength(Infinity, 'meters')).toBe('--');
    });

    it('returns "--" for -Infinity', () => {
      expect(formatLength(-Infinity, 'meters')).toBe('--');
    });
  });

  describe('precision clamping', () => {
    it('clamps negative precision to 0', () => {
      expect(formatLength(42.345, 'meters', -1)).toBe('42m');
    });

    it('clamps precision above 6 to 6', () => {
      expect(formatLength(42.3456789, 'meters', 10)).toBe('42.345679m');
    });

    it('handles NaN precision by defaulting to 0', () => {
      expect(formatLength(42.345, 'meters', NaN)).toBe('42m');
    });

    it('handles fractional precision by flooring', () => {
      expect(formatLength(42.345, 'meters', 1.9)).toBe('42.3m');
    });
  });
});

describe('formatDepthRange', () => {
  describe('basic formatting', () => {
    it('formats range with default precision', () => {
      expect(formatDepthRange(2.1, 15.4, 'meters')).toBe('2.1-15.4m');
    });

    it('formats range with specified precision', () => {
      expect(formatDepthRange(2.123, 15.456, 'meters', 2)).toBe('2.12-15.46m');
    });

    it('formats range in feet', () => {
      // 2m = 6.56168ft, 10m = 32.8084ft
      expect(formatDepthRange(2, 10, 'feet', 1)).toBe('6.6-32.8ft');
    });
  });

  describe('null values', () => {
    it('returns "--" when min is null', () => {
      expect(formatDepthRange(null, 15.4, 'meters')).toBe('--');
    });

    it('returns "--" when max is null', () => {
      expect(formatDepthRange(2.1, null, 'meters')).toBe('--');
    });

    it('returns "--" when both are null', () => {
      expect(formatDepthRange(null, null, 'meters')).toBe('--');
    });
  });

  describe('non-finite values', () => {
    it('returns "--" when min is NaN', () => {
      expect(formatDepthRange(NaN, 15.4, 'meters')).toBe('--');
    });

    it('returns "--" when max is NaN', () => {
      expect(formatDepthRange(2.1, NaN, 'meters')).toBe('--');
    });

    it('returns "--" when min is Infinity', () => {
      expect(formatDepthRange(Infinity, 15.4, 'meters')).toBe('--');
    });

    it('returns "--" when max is -Infinity', () => {
      expect(formatDepthRange(2.1, -Infinity, 'meters')).toBe('--');
    });
  });

  describe('edge cases', () => {
    it('handles zero values', () => {
      expect(formatDepthRange(0, 10, 'meters')).toBe('0.0-10.0m');
    });

    it('handles negative depths', () => {
      expect(formatDepthRange(-5, 10, 'meters')).toBe('-5.0-10.0m');
    });

    it('handles min greater than max (no validation)', () => {
      expect(formatDepthRange(15, 5, 'meters')).toBe('15.0-5.0m');
    });
  });
});
