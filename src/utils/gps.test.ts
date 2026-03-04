/**
 * Unit tests for GPS parsing utilities.
 * Tests all 7 formats: DD, DMS, DDM, UTM, MGRS, Plus Codes, What3words.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDD,
  parseDMS,
  parseDDM,
  parseUTM,
  parseMGRS,
  parsePlusCodes,
  parseWhat3words,
  parseUrl,
  parseGps,
  detectFormat,
  validateCoordinates,
  formatGpsCoordinates,
  type GpsParseResult,
  type GpsParseError,
} from './gps';

// Helper to check if result is successful
function isSuccess(result: GpsParseResult | GpsParseError): result is GpsParseResult {
  return 'coordinates' in result;
}

// Helper to check coordinates are close (for floating point comparison)
function expectCoordsClose(
  result: GpsParseResult | GpsParseError,
  expectedLat: number,
  expectedLon: number,
  _tolerance = 0.0001
) {
  expect(isSuccess(result)).toBe(true);
  if (isSuccess(result)) {
    expect(result.coordinates.latitude).toBeCloseTo(expectedLat, 4);
    expect(result.coordinates.longitude).toBeCloseTo(expectedLon, 4);
  }
}

describe('validateCoordinates', () => {
  it('accepts valid coordinates', () => {
    const result = validateCoordinates(48.8584, 2.2945);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects latitude out of range', () => {
    const result = validateCoordinates(91, 0);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Latitude');
  });

  it('rejects longitude out of range', () => {
    const result = validateCoordinates(0, 181);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Longitude');
  });

  it('rejects NaN values', () => {
    const result = validateCoordinates(NaN, 0);
    expect(result.valid).toBe(false);
  });
});

describe('parseDD', () => {
  it('parses comma-separated coordinates', () => {
    const result = parseDD('48.8584, 2.2945');
    expectCoordsClose(result, 48.8584, 2.2945);
    if (isSuccess(result)) {
      expect(result.format).toBe('DD');
    }
  });

  it('parses space-separated coordinates', () => {
    const result = parseDD('48.8584 2.2945');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('parses negative coordinates (southern/western)', () => {
    const result = parseDD('-33.8688, 151.2093');
    expectCoordsClose(result, -33.8688, 151.2093);
  });

  it('parses both negative coordinates', () => {
    const result = parseDD('-33.8688, -70.6693');
    expectCoordsClose(result, -33.8688, -70.6693);
  });

  it('rejects invalid format', () => {
    const result = parseDD('invalid');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.format).toBe('DD');
    }
  });

  it('rejects out-of-range latitude', () => {
    const result = parseDD('91.0, 2.0');
    expect(isSuccess(result)).toBe(false);
  });
});

describe('parseDMS', () => {
  it('parses standard DMS format with symbols', () => {
    // 48°51'30"N 2°17'40"E = 48.8583, 2.2944 approximately
    const result = parseDMS('48°51\'30"N 2°17\'40"E');
    expectCoordsClose(result, 48.8583, 2.2944);
    if (isSuccess(result)) {
      expect(result.format).toBe('DMS');
    }
  });

  it('parses DMS with space separators', () => {
    const result = parseDMS('48 51 30 N 2 17 40 E');
    expectCoordsClose(result, 48.8583, 2.2944);
  });

  it('parses southern/western coordinates', () => {
    const result = parseDMS('33°51\'54"S 151°12\'33"E');
    expectCoordsClose(result, -33.865, 151.2092);
  });

  it('handles decimal seconds', () => {
    const result = parseDMS('48°51\'30.5"N 2°17\'40.5"E');
    expect(isSuccess(result)).toBe(true);
  });

  it('rejects invalid minutes (>= 60)', () => {
    const result = parseDMS('48°60\'30"N 2°17\'40"E');
    expect(isSuccess(result)).toBe(false);
  });

  it('rejects invalid seconds (>= 60)', () => {
    const result = parseDMS('48°51\'60"N 2°17\'40"E');
    expect(isSuccess(result)).toBe(false);
  });

  it('parses signed DMS with negative latitude', () => {
    // -33°51'54" 151°12'33" (Sydney) - negative lat, positive lon
    const result = parseDMS('-33°51\'54" 151°12\'33"');
    expectCoordsClose(result, -33.865, 151.2092);
    if (isSuccess(result)) {
      expect(result.format).toBe('DMS');
    }
  });

  it('parses signed DMS with negative longitude', () => {
    // 40°42'46" -74°0'22" (New York) - positive lat, negative lon
    const result = parseDMS('40°42\'46" -74°0\'22"');
    expectCoordsClose(result, 40.7128, -74.0061);
    if (isSuccess(result)) {
      expect(result.format).toBe('DMS');
    }
  });

  it('parses signed DMS with both negative', () => {
    // -33°26'16" -70°39'1" (Santiago, Chile)
    const result = parseDMS('-33°26\'16" -70°39\'1"');
    expectCoordsClose(result, -33.4378, -70.6503);
    if (isSuccess(result)) {
      expect(result.format).toBe('DMS');
    }
  });

  it('rejects ambiguous DMS without direction or sign', () => {
    // Both positive without direction letters = ambiguous
    const result = parseDMS('33°51\'54" 151°12\'33"');
    expect(isSuccess(result)).toBe(false);
  });
});

describe('parseDDM', () => {
  it('parses standard DDM format', () => {
    // 48°51.5'N 2°17.67'E
    const result = parseDDM("48°51.5'N 2°17.67'E");
    expectCoordsClose(result, 48.8583, 2.2945);
    if (isSuccess(result)) {
      expect(result.format).toBe('DDM');
    }
  });

  it('requires direction letters for disambiguation', () => {
    // DDM now requires direction letters to avoid ambiguity with DMS
    const result = parseDDM("48°51.5' 2°17.67'");
    expect(isSuccess(result)).toBe(false);
  });

  it('parses southern/western coordinates', () => {
    const result = parseDDM("33°51.9'S 151°12.55'E");
    expectCoordsClose(result, -33.865, 151.2092);
  });

  it('rejects invalid minutes (>= 60)', () => {
    const result = parseDDM("48°60.5'N 2°17.67'E");
    expect(isSuccess(result)).toBe(false);
  });
});

describe('parseUTM', () => {
  it('parses standard UTM format', () => {
    // 31U 448251 5411932 is near Paris
    const result = parseUTM('31U 448251 5411932');
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.format).toBe('UTM');
      // Approximate check - UTM conversion has some tolerance
      expect(result.coordinates.latitude).toBeGreaterThan(48);
      expect(result.coordinates.latitude).toBeLessThan(50);
    }
  });

  it('parses UTM with comma separators', () => {
    const result = parseUTM('31U, 448251, 5411932');
    expect(isSuccess(result)).toBe(true);
  });

  it('rejects invalid zone number', () => {
    const result = parseUTM('61U 448251 5411932');
    expect(isSuccess(result)).toBe(false);
  });

  it('rejects invalid band letter', () => {
    const result = parseUTM('31I 448251 5411932');
    expect(isSuccess(result)).toBe(false);
  });
});

describe('parseMGRS', () => {
  // Note: parseMGRS validates format only - full MGRS conversion requires a dedicated library.
  // These tests validate format recognition and validation logic.

  it('validates valid MGRS format', () => {
    // 31UDQ4825111932 is near Paris
    // Format validation should succeed but not return coordinates (requires library)
    const result = parseMGRS('31UDQ4825111932');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.format).toBe('MGRS');
      expect(result.message).toContain('library');
    }
  });

  it('validates different precision levels', () => {
    // Test 1km precision (4 digits) vs 1m precision (10 digits)
    const result1km = parseMGRS('31UDQ4811');
    const result1m = parseMGRS('31UDQ4825111932');
    // Both should be recognized as valid MGRS format
    expect(isSuccess(result1km)).toBe(false);
    expect(isSuccess(result1m)).toBe(false);
    if (!isSuccess(result1km) && !isSuccess(result1m)) {
      expect(result1km.format).toBe('MGRS');
      expect(result1m.format).toBe('MGRS');
      // Both should indicate library required, not format error
      expect(result1km.message).toContain('library');
      expect(result1m.message).toContain('library');
    }
  });

  it('rejects invalid zone number', () => {
    const result = parseMGRS('61ABC1234567890');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.message).toContain('zone');
    }
  });

  it('rejects invalid band letter', () => {
    const result = parseMGRS('31IAB1234512345');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.message).toContain('band');
    }
  });

  it('rejects odd-length coordinates', () => {
    const result = parseMGRS('31UDQ48251');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.message).toContain('even');
    }
  });

  it('rejects invalid format', () => {
    const result = parseMGRS('not-mgrs');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.format).toBe('MGRS');
    }
  });
});

describe('parsePlusCodes', () => {
  it('parses valid Plus Code with exact coordinates', () => {
    // 8FW4V75V+8Q is near Paris - known coordinates
    // Reference: https://plus.codes/8FW4V75V+8Q = 48.858350, 2.294495
    const result = parsePlusCodes('8FW4V75V+8Q');
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.format).toBe('PlusCodes');
      // Check both lat and lon with reasonable tolerance
      expect(result.coordinates.latitude).toBeCloseTo(48.8584, 3);
      expect(result.coordinates.longitude).toBeCloseTo(2.2945, 3);
    }
  });

  it('parses longer Plus Code (refinement >10 chars)', () => {
    // 8FW4V75V+8QX is a refinement of the above code (11 chars)
    // The refinement grid is 4x5, so +8QX refines +8Q further
    const result = parsePlusCodes('8FW4V75V+8QX');
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.format).toBe('PlusCodes');
      // Should be near same location but more precise
      expect(result.coordinates.latitude).toBeCloseTo(48.8584, 3);
      expect(result.coordinates.longitude).toBeCloseTo(2.2945, 3);
    }
  });

  it('parses lowercase Plus Code', () => {
    const result = parsePlusCodes('8fw4v75v+8q');
    expect(isSuccess(result)).toBe(true);
  });

  it('rejects invalid Plus Code format', () => {
    const result = parsePlusCodes('invalid');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.format).toBe('PlusCodes');
    }
  });

  it('rejects Plus Code with invalid characters', () => {
    const result = parsePlusCodes('8FW4V75V+01');
    expect(isSuccess(result)).toBe(false);
  });
});

describe('parseWhat3words', () => {
  it('validates What3words format', () => {
    const result = parseWhat3words('filled.count.soap');
    // Should fail with message about API requirement
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.format).toBe('What3words');
      expect(result.message).toContain('API');
    }
  });

  it('validates What3words with slashes', () => {
    const result = parseWhat3words('///filled.count.soap');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.format).toBe('What3words');
    }
  });

  it('rejects invalid What3words format', () => {
    const result = parseWhat3words('invalid');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.message).toContain('Invalid');
    }
  });
});

describe('parseUrl', () => {
  it('extracts from Google Maps @ URL', () => {
    const result = parseUrl('https://www.google.com/maps/@48.8584,2.2945,15z');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('extracts from Google Maps place URL with text name (falls back to @)', () => {
    const result = parseUrl('https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,15z');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('extracts DMS from Google Maps place name (short URL)', () => {
    // 20°12'02.0"N 87°29'59.8"W
    const result = parseUrl(
      'https://www.google.com/maps/place/20%C2%B012\'02.0%22N+87%C2%B029\'59.8%22W/'
    );
    expectCoordsClose(result, 20.200556, -87.499944);
  });

  it('extracts DMS from Google Maps place name over viewport @', () => {
    // The @ coordinates (20.200562,-87.5005877) are the viewport center, NOT the pin.
    // The place name DMS (20°12'02.0"N 87°29'59.8"W) is the correct location.
    const result = parseUrl(
      'https://www.google.com/maps/place/20%C2%B012\'02.0%22N+87%C2%B029\'59.8%22W/@20.200562,-87.5005877,500m/data=!3m2!1e3!4b1!4m4!3m3!8m2!3d20.200562!4d-87.499944?entry=ttu'
    );
    expectCoordsClose(result, 20.200556, -87.499944);
  });

  it('extracts !3d/!4d data params for place URLs without coordinate names', () => {
    const result = parseUrl(
      'https://www.google.com/maps/place/Some+Cave/@20.2,−87.5,500m/data=!3m2!1e3!4b1!4m4!3m3!8m2!3d20.200556!4d-87.499944'
    );
    expectCoordsClose(result, 20.200556, -87.499944);
  });

  it('extracts from Google Maps query URL', () => {
    const result = parseUrl('https://maps.google.com/?q=48.8584,2.2945');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('extracts from OpenStreetMap URL', () => {
    const result = parseUrl('https://www.openstreetmap.org/#map=15/48.8584/2.2945');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('extracts from Bing Maps URL', () => {
    const result = parseUrl('https://www.bing.com/maps?cp=48.8584~2.2945');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('rejects non-URL input', () => {
    const result = parseUrl('not a url');
    expect(isSuccess(result)).toBe(false);
  });
});

describe('detectFormat', () => {
  it('detects DD format', () => {
    expect(detectFormat('48.8584, 2.2945')).toBe('DD');
  });

  it('detects DMS format', () => {
    expect(detectFormat('48°51\'30"N 2°17\'40"E')).toBe('DMS');
  });

  it('detects DDM format', () => {
    expect(detectFormat("48°51.5'N 2°17.67'E")).toBe('DDM');
  });

  it('detects UTM format', () => {
    expect(detectFormat('31U 448251 5411932')).toBe('UTM');
  });

  it('detects MGRS format', () => {
    expect(detectFormat('31UDQ4825111932')).toBe('MGRS');
  });

  it('detects Plus Codes format', () => {
    expect(detectFormat('8FW4V75V+8Q')).toBe('PlusCodes');
  });

  it('detects What3words format', () => {
    expect(detectFormat('filled.count.soap')).toBe('What3words');
    expect(detectFormat('///filled.count.soap')).toBe('What3words');
  });

  it('returns undefined for URLs', () => {
    expect(detectFormat('https://maps.google.com')).toBeUndefined();
  });
});

describe('parseGps', () => {
  it('auto-detects and parses DD', () => {
    const result = parseGps('48.8584, 2.2945');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('auto-detects and parses DMS', () => {
    const result = parseGps('48°51\'30"N 2°17\'40"E');
    expect(isSuccess(result)).toBe(true);
  });

  it('auto-detects and parses URLs', () => {
    const result = parseGps('https://www.google.com/maps/@48.8584,2.2945,15z');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('returns error for empty input', () => {
    const result = parseGps('');
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.message).toContain('Empty');
    }
  });

  it('returns error for unparseable input', () => {
    const result = parseGps('completely invalid garbage');
    expect(isSuccess(result)).toBe(false);
  });

  it('parses DD with extra internal whitespace and newlines', () => {
    const result = parseGps('  48.8584  ,\n   2.2945  ');
    expectCoordsClose(result, 48.8584, 2.2945);
  });

  it('parses Plus Codes with inserted whitespace', () => {
    const result = parseGps(' 8FW4V75V + 8Q ');
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.format).toBe('PlusCodes');
    }
  });
});

describe('formatGpsCoordinates', () => {
  const coords = { latitude: 48.8584, longitude: 2.2945, depth_reference: 0 };

  it('formats as DD', () => {
    const result = formatGpsCoordinates(coords, 'DD', 4);
    expect(result).toBe('48.8584, 2.2945');
  });

  it('formats as DMS', () => {
    const result = formatGpsCoordinates(coords, 'DMS');
    expect(result).toContain('°');
    expect(result).toContain('N');
    expect(result).toContain('E');
  });

  it('formats as DDM', () => {
    const result = formatGpsCoordinates(coords, 'DDM');
    expect(result).toContain('°');
    expect(result).toContain('N');
    expect(result).toContain('E');
  });

  it('handles negative coordinates in DMS', () => {
    const southWest = { latitude: -33.8688, longitude: -151.2093, depth_reference: 0 };
    const result = formatGpsCoordinates(southWest, 'DMS');
    expect(result).toContain('S');
    expect(result).toContain('W');
  });

  it('falls back to DD for unsupported formats', () => {
    // UTM/MGRS/PlusCodes formatting not implemented, falls back to DD
    const result = formatGpsCoordinates(coords, 'UTM');
    expect(result).toContain('48.8584');
  });
});
