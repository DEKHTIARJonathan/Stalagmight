import { describe, it, expect } from 'vitest';
import { applyAzimuthEdit, getAzimuthAverage } from '../shotTable';

describe('getAzimuthAverage', () => {
  it('uses circular mean across 0/360 wrap-around', () => {
    const result = getAzimuthAverage(359, 1);
    expect(result).toBeCloseTo(0, 5);
  });
});

describe('applyAzimuthEdit', () => {
  it('sets azimuth in/out to the same normalized value', () => {
    expect(applyAzimuthEdit(45)).toEqual({ azimuth_in: 45, azimuth_out: 45 });
    expect(applyAzimuthEdit(405)).toEqual({ azimuth_in: 45, azimuth_out: 45 });
    expect(applyAzimuthEdit('-15')).toEqual({ azimuth_in: 345, azimuth_out: 345 });
  });

  it('falls back to 0 for invalid input', () => {
    expect(applyAzimuthEdit('')).toEqual({ azimuth_in: 0, azimuth_out: 0 });
  });
});
