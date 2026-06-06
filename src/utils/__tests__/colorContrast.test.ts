import { describe, it, expect } from 'vitest';
import { relativeLuminance, readableTextColor } from '../colorContrast';

describe('relativeLuminance', () => {
  it('is 0 for black and ~1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('accepts shorthand and hashless hex', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('000')).toBeCloseTo(0, 5);
  });

  it('returns 0 for invalid input', () => {
    expect(relativeLuminance('not-a-color')).toBe(0);
  });
});

describe('readableTextColor', () => {
  it('uses dark ink on light backgrounds', () => {
    expect(readableTextColor('#ffffff')).toBe('#16181c');
    expect(readableTextColor('#5fcf83')).toBe('#16181c'); // default station green
    expect(readableTextColor('#eab946')).toBe('#16181c'); // default comment amber
  });

  it('uses light ink on dark backgrounds', () => {
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#0070dd')).toBe('#ffffff'); // default shot blue
    expect(readableTextColor('#a335ee')).toBe('#ffffff'); // default section purple
  });

  it('falls back to dark ink for invalid colors', () => {
    expect(readableTextColor('garbage')).toBe('#ffffff'); // luminance 0 -> light ink
  });
});
