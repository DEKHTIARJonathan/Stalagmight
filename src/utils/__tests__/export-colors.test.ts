/**
 * Unit tests for export-colors utilities.
 * Tests the multi-stop color interpolation matching Rust backend.
 */

import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  interpolateHsl,
  interpolateStops,
  getDepthColor,
  computeStationColor,
  computeShotColor,
  calculateDepthRange,
  formatDepth,
  type ColorStop,
} from '../export-colors';

describe('hexToRgb', () => {
  it('parses standard hex color with #', () => {
    const result = hexToRgb('#ff0000');
    expect(result).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('parses standard hex color without #', () => {
    const result = hexToRgb('00ff00');
    expect(result).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('returns black for invalid short hex', () => {
    const result = hexToRgb('#fff');
    expect(result).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('returns black for empty string', () => {
    const result = hexToRgb('');
    expect(result).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('rgbToHex', () => {
  it('converts RGB to hex', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
    expect(rgbToHex(0, 255, 0)).toBe('#00ff00');
    expect(rgbToHex(0, 0, 255)).toBe('#0000ff');
  });

  it('clamps values outside 0-255', () => {
    expect(rgbToHex(300, -50, 128)).toBe('#ff0080');
  });

  it('pads single digit values', () => {
    expect(rgbToHex(0, 0, 15)).toBe('#00000f');
  });
});

describe('rgbToHsl', () => {
  it('converts red correctly', () => {
    const [h, s, l] = rgbToHsl(255, 0, 0);
    expect(h).toBeCloseTo(0, 1);
    expect(s).toBeCloseTo(1, 2);
    expect(l).toBeCloseTo(0.5, 2);
  });

  it('converts green correctly', () => {
    const [h, s, l] = rgbToHsl(0, 255, 0);
    expect(h).toBeCloseTo(120, 1);
    expect(s).toBeCloseTo(1, 2);
    expect(l).toBeCloseTo(0.5, 2);
  });

  it('converts blue correctly', () => {
    const [h, s, l] = rgbToHsl(0, 0, 255);
    expect(h).toBeCloseTo(240, 1);
    expect(s).toBeCloseTo(1, 2);
    expect(l).toBeCloseTo(0.5, 2);
  });

  it('handles achromatic (gray) colors', () => {
    const [h, s, l] = rgbToHsl(128, 128, 128);
    expect(h).toBe(0);
    expect(s).toBe(0);
    expect(l).toBeCloseTo(0.5, 1);
  });

  it('handles black', () => {
    const [h, s, l] = rgbToHsl(0, 0, 0);
    expect(h).toBe(0);
    expect(s).toBe(0);
    expect(l).toBe(0);
  });

  it('handles white', () => {
    const [h, s, l] = rgbToHsl(255, 255, 255);
    expect(h).toBe(0);
    expect(s).toBe(0);
    expect(l).toBe(1);
  });
});

describe('hslToRgb', () => {
  it('converts red correctly', () => {
    const [r, g, b] = hslToRgb(0, 1, 0.5);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('converts green correctly', () => {
    const [r, g, b] = hslToRgb(120, 1, 0.5);
    expect(r).toBe(0);
    expect(g).toBe(255);
    expect(b).toBe(0);
  });

  it('converts blue correctly', () => {
    const [r, g, b] = hslToRgb(240, 1, 0.5);
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(255);
  });

  it('handles achromatic (zero saturation)', () => {
    const [r, g, b] = hslToRgb(180, 0, 0.5);
    // All RGB values should be equal for gray
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBe(128);
  });
});

describe('interpolateHsl', () => {
  it('returns first color at t=0', () => {
    const result = interpolateHsl('#ff0000', '#0000ff', 0);
    expect(result.toLowerCase()).toBe('#ff0000');
  });

  it('returns second color at t=1', () => {
    const result = interpolateHsl('#ff0000', '#0000ff', 1);
    expect(result.toLowerCase()).toBe('#0000ff');
  });

  it('takes shortest hue path (red to blue goes through magenta, not green)', () => {
    // Red (hue 0) to Blue (hue 240) - shortest path is backwards through magenta (hue 300),
    // not forwards through green (hue 120)
    const result = interpolateHsl('#ff0000', '#0000ff', 0.5);
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);

    // Parse RGB components - midpoint should be magenta-ish (high R, low G, high B)
    const r = parseInt(result.slice(1, 3), 16);
    const g = parseInt(result.slice(3, 5), 16);
    const b = parseInt(result.slice(5, 7), 16);

    // Magenta has high red and blue, low green
    expect(r).toBeGreaterThan(100); // High red
    expect(g).toBeLessThan(100); // Low green (would be high if going through green)
    expect(b).toBeGreaterThan(100); // High blue
  });

  it('produces valid hex output', () => {
    const result = interpolateHsl('#00bfff', '#ff4444', 0.5);
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('interpolateStops', () => {
  const twoStops: ColorStop[] = [
    { position: 0, color: '#00bfff' },
    { position: 1, color: '#ff4444' },
  ];

  const threeStops: ColorStop[] = [
    { position: 0, color: '#00bfff' },
    { position: 0.5, color: '#00ff00' },
    { position: 1, color: '#ff4444' },
  ];

  describe('safety guards', () => {
    it('returns #000000 for empty array', () => {
      const result = interpolateStops(0.5, []);
      expect(result).toBe('#000000');
    });

    it('returns single color for single-element array', () => {
      const result = interpolateStops(0.5, [{ position: 0.5, color: '#ff0000' }]);
      expect(result).toBe('#ff0000');
    });

    it('handles equal positions (avoid divide by zero)', () => {
      const stops: ColorStop[] = [
        { position: 0.5, color: '#00ff00' },
        { position: 0.5, color: '#ff0000' },
      ];
      const result = interpolateStops(0.5, stops);
      expect(result).toBe('#00ff00');
    });
  });

  describe('clamping', () => {
    it('clamps t below 0', () => {
      const result = interpolateStops(-0.5, twoStops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('clamps t above 1', () => {
      const result = interpolateStops(1.5, twoStops);
      expect(result.toLowerCase()).toBe('#ff4444');
    });
  });

  describe('interpolation', () => {
    it('returns first color at t=0', () => {
      const result = interpolateStops(0, twoStops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('returns last color at t=1', () => {
      const result = interpolateStops(1, twoStops);
      expect(result.toLowerCase()).toBe('#ff4444');
    });

    it('interpolates between stops', () => {
      const result = interpolateStops(0.5, twoStops);
      // Should be valid hex, different from endpoints
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
      expect(result.toLowerCase()).not.toBe('#00bfff');
      expect(result.toLowerCase()).not.toBe('#ff4444');
    });

    it('handles multi-stop gradients correctly', () => {
      // At 0.5, should be exactly the middle stop
      const atMiddle = interpolateStops(0.5, threeStops);
      expect(atMiddle.toLowerCase()).toBe('#00ff00');

      // At 0.25, should be between first and second stop
      const atQuarter = interpolateStops(0.25, threeStops);
      expect(atQuarter).toMatch(/^#[0-9a-f]{6}$/i);
      expect(atQuarter.toLowerCase()).not.toBe('#00bfff');
      expect(atQuarter.toLowerCase()).not.toBe('#00ff00');
    });
  });
});

describe('getDepthColor', () => {
  const stops: ColorStop[] = [
    { position: 0, color: '#00bfff' },
    { position: 1, color: '#ff4444' },
  ];

  it('returns first color at min depth', () => {
    const result = getDepthColor(0, 0, 50, stops);
    expect(result.toLowerCase()).toBe('#00bfff');
  });

  it('returns last color at max depth', () => {
    const result = getDepthColor(50, 0, 50, stops);
    expect(result.toLowerCase()).toBe('#ff4444');
  });

  it('returns interpolated color at midpoint', () => {
    const result = getDepthColor(25, 0, 50, stops);
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    expect(result.toLowerCase()).not.toBe('#00bfff');
    expect(result.toLowerCase()).not.toBe('#ff4444');
  });

  describe('edge cases', () => {
    it('returns first color for NaN depth', () => {
      const result = getDepthColor(NaN, 0, 50, stops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('returns first color for Infinity depth', () => {
      const result = getDepthColor(Infinity, 0, 50, stops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('returns first color for -Infinity depth', () => {
      const result = getDepthColor(-Infinity, 0, 50, stops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('returns first color for NaN minDepth', () => {
      const result = getDepthColor(25, NaN, 50, stops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('returns first color for NaN maxDepth', () => {
      const result = getDepthColor(25, 0, NaN, stops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('returns first color for flat range (min equals max)', () => {
      const result = getDepthColor(25, 25, 25, stops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('returns #000000 for empty stops', () => {
      const result = getDepthColor(25, 0, 50, []);
      expect(result).toBe('#000000');
    });

    it('clamps depth below min to first color', () => {
      const result = getDepthColor(-10, 0, 100, stops);
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('clamps depth above max to last color', () => {
      const result = getDepthColor(150, 0, 100, stops);
      expect(result.toLowerCase()).toBe('#ff4444');
    });
  });
});

describe('computeStationColor', () => {
  const depthRange = { min: 0, max: 50 };
  const stops: ColorStop[] = [
    { position: 0, color: '#00bfff' },
    { position: 1, color: '#ff4444' },
  ];

  it('returns gold for zero datum', () => {
    const station = { coordinates: { z: 25 }, is_zero_datum: true };
    const result = computeStationColor(station, '#ffffff', 'depth', depthRange, stops);
    expect(result).toBe('#ffd700');
  });

  it('returns section color in section mode', () => {
    const station = { coordinates: { z: 25 }, is_zero_datum: false };
    const result = computeStationColor(station, '#ffffff', 'section', depthRange, stops);
    expect(result).toBe('#ffffff');
  });

  it('returns section color when no preset stops', () => {
    const station = { coordinates: { z: 25 }, is_zero_datum: false };
    const result = computeStationColor(station, '#ffffff', 'depth', depthRange, null);
    expect(result).toBe('#ffffff');
  });

  it('returns section color when preset stops empty', () => {
    const station = { coordinates: { z: 25 }, is_zero_datum: false };
    const result = computeStationColor(station, '#ffffff', 'depth', depthRange, []);
    expect(result).toBe('#ffffff');
  });

  it('returns depth color in depth mode with preset', () => {
    const station = { coordinates: { z: 0 }, is_zero_datum: false };
    const result = computeStationColor(station, '#ffffff', 'depth', depthRange, stops);
    expect(result.toLowerCase()).toBe('#00bfff');
  });
});

describe('computeShotColor', () => {
  const depthRange = { min: 0, max: 50 };
  const stops: ColorStop[] = [
    { position: 0, color: '#00bfff' },
    { position: 1, color: '#ff4444' },
  ];

  it('returns section color in section mode', () => {
    const result = computeShotColor(0, 50, '#ffffff', 'section', depthRange, stops);
    expect(result).toBe('#ffffff');
  });

  it('returns section color when no preset stops', () => {
    const result = computeShotColor(0, 50, '#ffffff', 'depth', depthRange, null);
    expect(result).toBe('#ffffff');
  });

  it('uses average depth for color calculation', () => {
    // From z=0 to z=50, average is 25 (midpoint)
    const result = computeShotColor(0, 50, '#ffffff', 'depth', depthRange, stops);
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    // Should be interpolated, not at endpoints
    expect(result.toLowerCase()).not.toBe('#00bfff');
    expect(result.toLowerCase()).not.toBe('#ff4444');
  });
});

describe('calculateDepthRange', () => {
  it('returns default range for empty array', () => {
    const result = calculateDepthRange([]);
    expect(result).toEqual({ min: 0, max: 50 });
  });

  it('calculates correct range from stations', () => {
    const stations = [
      { coordinates: { z: 10 } },
      { coordinates: { z: 30 } },
      { coordinates: { z: 20 } },
    ];
    const result = calculateDepthRange(stations);
    expect(result).toEqual({ min: 10, max: 30 });
  });

  it('handles single station', () => {
    const stations = [{ coordinates: { z: 25 } }];
    const result = calculateDepthRange(stations);
    expect(result).toEqual({ min: 25, max: 25 });
  });

  it('ignores non-finite values', () => {
    const stations = [
      { coordinates: { z: 10 } },
      { coordinates: { z: NaN } },
      { coordinates: { z: Infinity } },
      { coordinates: { z: 30 } },
    ];
    const result = calculateDepthRange(stations);
    expect(result).toEqual({ min: 10, max: 30 });
  });

  it('returns default for all non-finite values', () => {
    const stations = [
      { coordinates: { z: NaN } },
      { coordinates: { z: Infinity } },
    ];
    const result = calculateDepthRange(stations);
    expect(result).toEqual({ min: 0, max: 50 });
  });
});

describe('formatDepth', () => {
  it('formats meters with correct precision', () => {
    expect(formatDepth(25.123, 'm', 1)).toBe('25.1m');
    expect(formatDepth(25.123, 'm', 2)).toBe('25.12m');
    expect(formatDepth(25.123, 'm', 0)).toBe('25m');
  });

  it('converts to feet correctly', () => {
    // 1m = 3.28084ft
    const result = formatDepth(10, 'ft', 1);
    expect(result).toBe('32.8ft');
  });

  it('handles negative depths', () => {
    expect(formatDepth(-10, 'm', 1)).toBe('-10.0m');
  });

  describe('precision clamping (matches Rust MAX_DECIMAL_PRECISION=6)', () => {
    it('clamps negative precision to 0', () => {
      expect(formatDepth(25.123456789, 'm', -1)).toBe('25m');
      expect(formatDepth(25.123456789, 'm', -100)).toBe('25m');
    });

    it('clamps precision above 6 to 6', () => {
      expect(formatDepth(25.123456789, 'm', 7)).toBe('25.123457m');
      expect(formatDepth(25.123456789, 'm', 100)).toBe('25.123457m');
    });

    it('handles NaN precision by using 0', () => {
      expect(formatDepth(25.123, 'm', NaN)).toBe('25m');
    });

    it('handles non-integer precision by flooring', () => {
      expect(formatDepth(25.123, 'm', 1.9)).toBe('25.1m');
      expect(formatDepth(25.123, 'm', 2.5)).toBe('25.12m');
    });

    it('does not throw RangeError for edge case precisions', () => {
      // These would throw RangeError without clamping
      expect(() => formatDepth(25.123, 'm', Infinity)).not.toThrow();
      expect(() => formatDepth(25.123, 'm', -Infinity)).not.toThrow();
      expect(() => formatDepth(25.123, 'm', 1e10)).not.toThrow();
    });
  });
});
