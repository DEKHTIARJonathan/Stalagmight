import { describe, it, expect } from 'vitest';
import { reverseGeocodeCountry } from './reverseGeocodeCountry';
import { COUNTRY_BOUNDS } from '../data/countryBounds';
import { COUNTRIES } from '../data/countries';

describe('reverseGeocodeCountry', () => {
  it('resolves interior points to the right country', () => {
    // Mexico - Yucatan cenote country (near Tulum).
    expect(reverseGeocodeCountry(20.21, -87.46)).toBe('MX');
    // Metropolitan France (near Lyon).
    expect(reverseGeocodeCountry(45.76, 4.83)).toBe('FR');
    // Contiguous US (near Marianna, Florida cave country).
    expect(reverseGeocodeCountry(30.77, -85.23)).toBe('US');
    // Australia - Mount Gambier.
    expect(reverseGeocodeCountry(-37.83, 140.78)).toBe('AU');
  });

  it('returns null in open ocean (outside every box)', () => {
    // Mid-Atlantic.
    expect(reverseGeocodeCountry(30.0, -40.0)).toBeNull();
    // Mid-Pacific.
    expect(reverseGeocodeCountry(0.0, -140.0)).toBeNull();
    // Southern Ocean.
    expect(reverseGeocodeCountry(-60.0, 100.0)).toBeNull();
  });

  it('returns null for non-finite or out-of-range input', () => {
    expect(reverseGeocodeCountry(Number.NaN, 0)).toBeNull();
    expect(reverseGeocodeCountry(0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(reverseGeocodeCountry(91, 0)).toBeNull();
    expect(reverseGeocodeCountry(-91, 0)).toBeNull();
    expect(reverseGeocodeCountry(0, 181)).toBeNull();
    expect(reverseGeocodeCountry(0, -181)).toBeNull();
  });

  it('prefers the nearest box centre when boxes overlap', () => {
    // A point clearly inside Belgium but also within the looser NL/DE boxes
    // should still resolve to BE (its tight box centre is nearer). Brussels.
    expect(reverseGeocodeCountry(50.85, 4.35)).toBe('BE');
  });

  it('only ever returns a code the Publish country dropdown can display', () => {
    // Every bounding-box code MUST exist in COUNTRIES, or the prefill would set the
    // <select> to a value with no matching <option> (e.g. Kosovo XK, dropped for
    // exactly this reason). This pins the two tables together so they cannot drift.
    const publishable = new Set(COUNTRIES.map((c) => c.code));
    const orphans = COUNTRY_BOUNDS.map(([code]) => code).filter((code) => !publishable.has(code));
    expect(orphans).toEqual([]);
  });
});
