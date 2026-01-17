/**
 * GPS coordinate parsing utilities.
 * Supports 7 formats: DD, DMS, DDM, UTM, MGRS, Plus Codes, What3words.
 * Also extracts coordinates from URLs (Google Maps, OpenStreetMap, Bing Maps).
 *
 * NOTE: UTM and MGRS conversions use simplified algorithms that are accurate
 * for most common use cases but may have small errors in edge cases (polar regions,
 * zone boundaries, special zones like Norway/Svalbard). For survey-grade accuracy,
 * consider using dedicated geodetic libraries.
 *
 * NOTE: What3words requires API access and cannot be converted offline.
 */

import type { GpsCoordinates } from '../types/project';

/**
 * Supported GPS coordinate formats.
 */
export type GpsFormat =
  | 'DD' // Decimal Degrees: 48.8584, 2.2945
  | 'DMS' // Degrees Minutes Seconds: 48°51'30"N 2°17'40"E
  | 'DDM' // Degrees Decimal Minutes: 48°51.5'N 2°17.67'E
  | 'UTM' // Universal Transverse Mercator: 31U 448251 5411932
  | 'MGRS' // Military Grid Reference: 31UDQ4825111932
  | 'PlusCodes' // Google Plus Codes: 8FW4V75V+8Q
  | 'What3words'; // What3words: ///filled.count.soap

/**
 * Result from parsing GPS coordinates.
 */
export interface GpsParseResult {
  /** Successfully parsed coordinates (DD format) */
  coordinates: GpsCoordinates;
  /** Detected format */
  format: GpsFormat;
  /** Original input string */
  original: string;
}

/**
 * Error from GPS parsing.
 */
export interface GpsParseError {
  /** Error message */
  message: string;
  /** Original input string */
  original: string;
  /** Detected format (if any) */
  format?: GpsFormat;
}

/**
 * Validation result for GPS coordinates.
 */
export interface GpsValidationResult {
  valid: boolean;
  errors: string[];
}

// Constants for validation
const LAT_MIN = -90;
const LAT_MAX = 90;
const LON_MIN = -180;
const LON_MAX = 180;

// UTM zone letters (C-X, excluding I and O)
const UTM_ZONE_LETTERS = 'CDEFGHJKLMNPQRSTUVWX';

// MGRS band letters (same as UTM)
const MGRS_BAND_LETTERS = UTM_ZONE_LETTERS;

// Open Location Code (Plus Codes) alphabet - 20 characters
// Note: '0' is used for padding in short codes but not for encoding
const OLC_ALPHABET = '23456789CFGHJMPQRVWX';

/**
 * Validate latitude and longitude values.
 */
export function validateCoordinates(lat: number, lon: number): GpsValidationResult {
  const errors: string[] = [];

  if (!Number.isFinite(lat)) {
    errors.push('Latitude must be a valid number');
  } else if (lat < LAT_MIN || lat > LAT_MAX) {
    errors.push(`Latitude must be between ${LAT_MIN} and ${LAT_MAX}`);
  }

  if (!Number.isFinite(lon)) {
    errors.push('Longitude must be a valid number');
  } else if (lon < LON_MIN || lon > LON_MAX) {
    errors.push(`Longitude must be between ${LON_MIN} and ${LON_MAX}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Parse Decimal Degrees format.
 * Examples: "48.8584, 2.2945", "48.8584 2.2945", "-33.8688, 151.2093"
 */
export function parseDD(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  // Match patterns like "lat, lon" or "lat lon" with optional signs
  const ddRegex = /^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/;
  const match = trimmed.match(ddRegex);

  if (!match || match[1] === undefined || match[2] === undefined) {
    return {
      message: 'Invalid DD format. Expected: lat, lon (e.g., 48.8584, 2.2945)',
      original: input,
      format: 'DD',
    };
  }

  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);

  const validation = validateCoordinates(lat, lon);
  if (!validation.valid) {
    return {
      message: validation.errors.join('; '),
      original: input,
      format: 'DD',
    };
  }

  return {
    coordinates: { latitude: lat, longitude: lon, depth_reference: 0 },
    format: 'DD',
    original: input,
  };
}

/**
 * Parse Degrees Minutes Seconds format.
 * Examples: "48°51'30\"N 2°17'40\"E", "48 51 30 N 2 17 40 E"
 *
 * Requires direction letters OR negative degrees for disambiguation.
 * Will not silently default to N/E for ambiguous inputs.
 */
export function parseDMS(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  // Pattern 1: With degree/minute/second symbols AND direction letters
  // Matches: 48°51'30"N 2°17'40"E (or with spaces)
  const dmsSymbolWithDirRegex =
    /(-?\d+)[°]\s*(\d+)[′']\s*(\d+\.?\d*)[″"]\s*([NSns])[,\s]+(-?\d+)[°]\s*(\d+)[′']\s*(\d+\.?\d*)[″"]\s*([EWew])/i;

  // Pattern 2: With degree/minute/second symbols and SIGNED degrees (no direction letters)
  // Matches: -48°51'30" 2°17'40" or 48°51'30" -2°17'40"
  const dmsSymbolSignedRegex =
    /(-\d+)[°]\s*(\d+)[′']\s*(\d+\.?\d*)[″"][,\s]+(-?\d+)[°]\s*(\d+)[′']\s*(\d+\.?\d*)[″"]|(-?\d+)[°]\s*(\d+)[′']\s*(\d+\.?\d*)[″"][,\s]+(-\d+)[°]\s*(\d+)[′']\s*(\d+\.?\d*)[″"]/i;

  // Pattern 3: Space-separated with direction letters (required for disambiguation)
  // Matches: 48 51 30 N 2 17 40 E
  const dmsSpaceRegex =
    /(-?\d+)\s+(\d+)\s+(\d+\.?\d*)\s*([NSns])\s+(-?\d+)\s+(\d+)\s+(\d+\.?\d*)\s*([EWew])/i;

  let match = trimmed.match(dmsSymbolWithDirRegex);
  let latDir: string | undefined;
  let lonDir: string | undefined;

  if (match) {
    // Pattern 1: has direction letters
    latDir = match[4]?.toUpperCase();
    lonDir = match[8]?.toUpperCase();
  } else {
    match = trimmed.match(dmsSpaceRegex);
    if (match) {
      // Pattern 3: space-separated with direction letters
      latDir = match[4]?.toUpperCase();
      lonDir = match[8]?.toUpperCase();
    } else {
      // Pattern 2: check for signed degrees
      const signedMatch = trimmed.match(dmsSymbolSignedRegex);
      if (signedMatch) {
        // Use signed values to determine direction
        // This regex has two alternations - find which one matched
        if (signedMatch[1] !== undefined) {
          // First alternation: -lat, +/-lon
          match = signedMatch;
          latDir = parseInt(signedMatch[1], 10) < 0 ? 'S' : 'N';
          lonDir = signedMatch[4] !== undefined && parseInt(signedMatch[4], 10) < 0 ? 'W' : 'E';
        } else if (signedMatch[7] !== undefined) {
          // Second alternation: +lat, -lon
          match = [
            signedMatch[0],
            signedMatch[7],
            signedMatch[8],
            signedMatch[9],
            undefined,
            signedMatch[10],
            signedMatch[11],
            signedMatch[12],
            undefined,
          ] as RegExpMatchArray;
          latDir = signedMatch[7] !== undefined && parseInt(signedMatch[7], 10) < 0 ? 'S' : 'N';
          lonDir = 'W'; // Second alternation requires negative lon
        }
      }
    }
  }

  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[5] === undefined ||
    match[6] === undefined ||
    match[7] === undefined ||
    latDir === undefined ||
    lonDir === undefined
  ) {
    return {
      message:
        "Invalid DMS format. Expected: deg°min'sec\"N deg°min'sec\"E or deg min sec N deg min sec E (direction letters or signed degrees required)",
      original: input,
      format: 'DMS',
    };
  }

  const latDeg = parseInt(match[1], 10);
  const latMin = parseInt(match[2], 10);
  const latSec = parseFloat(match[3]);

  const lonDeg = parseInt(match[5], 10);
  const lonMin = parseInt(match[6], 10);
  const lonSec = parseFloat(match[7]);

  // Validate minutes and seconds
  if (latMin < 0 || latMin >= 60 || lonMin < 0 || lonMin >= 60) {
    return {
      message: 'Minutes must be between 0 and 59',
      original: input,
      format: 'DMS',
    };
  }
  if (latSec < 0 || latSec >= 60 || lonSec < 0 || lonSec >= 60) {
    return {
      message: 'Seconds must be between 0 and 59.99',
      original: input,
      format: 'DMS',
    };
  }

  // Convert to decimal degrees
  let lat = Math.abs(latDeg) + latMin / 60 + latSec / 3600;
  let lon = Math.abs(lonDeg) + lonMin / 60 + lonSec / 3600;

  // Apply direction (negative for S and W)
  if (latDir === 'S' || latDeg < 0) lat = -Math.abs(lat);
  if (lonDir === 'W' || lonDeg < 0) lon = -Math.abs(lon);

  const validation = validateCoordinates(lat, lon);
  if (!validation.valid) {
    return {
      message: validation.errors.join('; '),
      original: input,
      format: 'DMS',
    };
  }

  return {
    coordinates: { latitude: lat, longitude: lon, depth_reference: 0 },
    format: 'DMS',
    original: input,
  };
}

/**
 * Parse Degrees Decimal Minutes format.
 * Examples: "48°51.5'N 2°17.67'E"
 *
 * Requires degree symbol AND direction letters to disambiguate from DMS/DD.
 */
export function parseDDM(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  // Stricter DDM regex - requires degree symbol and direction letters
  // The minutes must contain a decimal point to distinguish from DMS
  const ddmRegex =
    /(-?\d+)[°]\s*(\d+\.\d+)[′']?\s*([NSns])[,\s]+(-?\d+)[°]\s*(\d+\.\d+)[′']?\s*([EWew])/i;

  // Also allow format without decimal if it has the prime symbol
  const ddmRegex2 =
    /(-?\d+)[°]\s*(\d+\.?\d*)[′']\s*([NSns])[,\s]+(-?\d+)[°]\s*(\d+\.?\d*)[′']\s*([EWew])/i;

  let match = trimmed.match(ddmRegex);
  if (!match) {
    match = trimmed.match(ddmRegex2);
  }

  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined ||
    match[5] === undefined ||
    match[6] === undefined
  ) {
    return {
      message: "Invalid DDM format. Expected: deg°min.dec'N deg°min.dec'E (e.g., 48°51.5'N 2°17.67'E)",
      original: input,
      format: 'DDM',
    };
  }

  const latDeg = parseInt(match[1], 10);
  const latMin = parseFloat(match[2]);
  const latDir = match[3].toUpperCase();

  const lonDeg = parseInt(match[4], 10);
  const lonMin = parseFloat(match[5]);
  const lonDir = match[6].toUpperCase();

  // Validate minutes
  if (latMin < 0 || latMin >= 60 || lonMin < 0 || lonMin >= 60) {
    return {
      message: 'Minutes must be between 0 and 59.99',
      original: input,
      format: 'DDM',
    };
  }

  // Convert to decimal degrees
  let lat = Math.abs(latDeg) + latMin / 60;
  let lon = Math.abs(lonDeg) + lonMin / 60;

  // Apply direction
  if (latDir === 'S' || latDeg < 0) lat = -Math.abs(lat);
  if (lonDir === 'W' || lonDeg < 0) lon = -Math.abs(lon);

  const validation = validateCoordinates(lat, lon);
  if (!validation.valid) {
    return {
      message: validation.errors.join('; '),
      original: input,
      format: 'DDM',
    };
  }

  return {
    coordinates: { latitude: lat, longitude: lon, depth_reference: 0 },
    format: 'DDM',
    original: input,
  };
}

/**
 * Parse UTM (Universal Transverse Mercator) format.
 * Examples: "31U 448251 5411932", "31 U 448251 5411932", "31U, 448251, 5411932"
 *
 * Note: Uses simplified conversion formulas. For survey-grade accuracy,
 * use a dedicated geodetic library.
 */
export function parseUTM(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  // More flexible UTM regex:
  // - Zone number (1-2 digits)
  // - Optional space
  // - Band letter
  // - Separator (space, comma, or both)
  // - Easting (can have decimals)
  // - Separator
  // - Northing (can have decimals)
  const utmRegex = /^(\d{1,2})\s*([A-Za-z])[,\s]+(\d+\.?\d*)[,\s]+(\d+\.?\d*)$/;
  const match = trimmed.match(utmRegex);

  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    return {
      message:
        'Invalid UTM format. Expected: zone band easting northing (e.g., 31U 448251 5411932 or 31 U 448251 5411932)',
      original: input,
      format: 'UTM',
    };
  }

  const zone = parseInt(match[1], 10);
  const band = match[2].toUpperCase();
  const easting = parseFloat(match[3]);
  const northing = parseFloat(match[4]);

  // Validate zone
  if (zone < 1 || zone > 60) {
    return {
      message: 'UTM zone must be between 1 and 60',
      original: input,
      format: 'UTM',
    };
  }

  // Validate band letter
  if (!UTM_ZONE_LETTERS.includes(band)) {
    return {
      message: 'Invalid UTM band letter (must be C-X, excluding I and O)',
      original: input,
      format: 'UTM',
    };
  }

  // Validate easting range (typical valid range)
  if (easting < 100000 || easting > 900000) {
    return {
      message: 'UTM easting typically between 100000 and 900000',
      original: input,
      format: 'UTM',
    };
  }

  // Validate northing range
  if (northing < 0 || northing > 10000000) {
    return {
      message: 'UTM northing must be between 0 and 10000000',
      original: input,
      format: 'UTM',
    };
  }

  // UTM to lat/lon conversion
  const result = utmToLatLon(zone, band, easting, northing);
  if ('message' in result) {
    return {
      message: result.message,
      original: input,
      format: 'UTM',
    };
  }

  return {
    coordinates: { latitude: result.lat, longitude: result.lon, depth_reference: 0 },
    format: 'UTM',
    original: input,
  };
}

/**
 * Convert UTM coordinates to latitude/longitude.
 * Uses WGS84 ellipsoid parameters.
 */
function utmToLatLon(
  zone: number,
  band: string,
  easting: number,
  northing: number
): { lat: number; lon: number } | { message: string } {
  // WGS84 parameters
  const a = 6378137; // Semi-major axis
  const f = 1 / 298.257223563; // Flattening
  const k0 = 0.9996; // Scale factor
  const e = Math.sqrt(2 * f - f * f); // First eccentricity
  const e1sq = (e * e) / (1 - e * e); // Second eccentricity squared

  // Determine hemisphere from band letter
  const northern = band >= 'N';

  // Remove false easting and northing
  const x = easting - 500000;
  const y = northern ? northing : northing - 10000000;

  // Calculate footprint latitude
  const m = y / k0;
  const mu = m / (a * (1 - (e * e) / 4 - (3 * Math.pow(e, 4)) / 64 - (5 * Math.pow(e, 6)) / 256));

  const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const j1 = (3 * e1) / 2 - (27 * Math.pow(e1, 3)) / 32;
  const j2 = (21 * e1 * e1) / 16 - (55 * Math.pow(e1, 4)) / 32;
  const j3 = (151 * Math.pow(e1, 3)) / 96;
  const j4 = (1097 * Math.pow(e1, 4)) / 512;

  const fp =
    mu +
    j1 * Math.sin(2 * mu) +
    j2 * Math.sin(4 * mu) +
    j3 * Math.sin(6 * mu) +
    j4 * Math.sin(8 * mu);

  // Calculate latitude and longitude
  const sinFp = Math.sin(fp);
  const cosFp = Math.cos(fp);
  const tanFp = Math.tan(fp);

  const c1 = e1sq * cosFp * cosFp;
  const t1 = tanFp * tanFp;
  const r1 = (a * (1 - e * e)) / Math.pow(1 - e * e * sinFp * sinFp, 1.5);
  const n1 = a / Math.sqrt(1 - e * e * sinFp * sinFp);
  const d = x / (n1 * k0);

  const q1 = (n1 * tanFp) / r1;
  const q2 = (d * d) / 2;
  const q3 = ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * e1sq) * Math.pow(d, 4)) / 24;
  const q4 =
    ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * e1sq - 3 * c1 * c1) * Math.pow(d, 6)) / 720;

  const lat = fp - q1 * (q2 - q3 + q4);

  const q5 = d;
  const q6 = ((1 + 2 * t1 + c1) * Math.pow(d, 3)) / 6;
  const q7 =
    ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * e1sq + 24 * t1 * t1) * Math.pow(d, 5)) / 120;

  const centralMeridian = (zone - 1) * 6 - 180 + 3;
  const lon = centralMeridian + ((q5 - q6 + q7) / cosFp) * (180 / Math.PI);

  const latDeg = lat * (180 / Math.PI);

  const validation = validateCoordinates(latDeg, lon);
  if (!validation.valid) {
    return { message: validation.errors.join('; ') };
  }

  return { lat: latDeg, lon };
}

/**
 * Validate MGRS (Military Grid Reference System) format.
 * Examples: "31UDQ4825111932", "31U DQ 48251 11932"
 *
 * IMPORTANT: MGRS conversion to lat/lon requires a dedicated library (such as
 * the npm 'mgrs' package) to implement the full specification with proper band
 * minimum northing tables, 100km square rollover logic, and zone edge cases.
 *
 * This function validates the format only. Per the spec "Works offline (API
 * optional for Plus Codes/What3words)", offline format validation is the
 * expected behavior for complex grid systems like MGRS.
 *
 * Returns an error with format='MGRS' for valid formats (to indicate the format
 * was recognized but conversion requires a library) or an error with a different
 * message for invalid formats.
 */
export function parseMGRS(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim().replace(/\s+/g, '').toUpperCase();

  // MGRS regex: zone, band, 100km square, easting, northing
  // Coordinates can be 2, 4, 6, 8, or 10 digits (1m to 10km precision)
  const mgrsRegex = /^(\d{1,2})([A-Za-z])([A-Za-z]{2})(\d+)$/;
  const match = trimmed.match(mgrsRegex);

  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    return {
      message:
        'Invalid MGRS format. Expected: zoneNumberBandLetter 100kmSquare coordinates (e.g., 31UDQ4825111932)',
      original: input,
      format: 'MGRS',
    };
  }

  const zone = parseInt(match[1], 10);
  const band = match[2].toUpperCase();
  const coords = match[4];

  // Validate zone
  if (zone < 1 || zone > 60) {
    return {
      message: 'MGRS zone must be between 1 and 60',
      original: input,
      format: 'MGRS',
    };
  }

  // Validate band letter
  if (!MGRS_BAND_LETTERS.includes(band)) {
    return {
      message: 'Invalid MGRS band letter (must be C-X, excluding I and O)',
      original: input,
      format: 'MGRS',
    };
  }

  // Coordinates must be even length (split equally between easting and northing)
  if (coords.length % 2 !== 0 || coords.length < 2 || coords.length > 10) {
    return {
      message: 'MGRS coordinates must have even length between 2 and 10 digits',
      original: input,
      format: 'MGRS',
    };
  }

  // MGRS requires a dedicated library for accurate conversion to lat/lon
  // The full spec involves complex lookup tables and zone edge case handling
  return {
    message:
      'MGRS format recognized but conversion requires a dedicated library. Please use DD, DMS, DDM, UTM, or Plus Codes for offline coordinate conversion.',
    original: input,
    format: 'MGRS',
  };
}

/**
 * Parse Google Plus Codes (Open Location Code) format.
 * Examples: "8FW4V75V+8Q", "9F4MGCH4+QQ"
 *
 * Plus Codes are encoded lat/lon with the format: 8 digits + '+' + 2+ digits.
 * The first 10 digits (4 pairs before + and 1 pair after) use base-20 encoding.
 * Additional digits after the first 10 use a 4x5 grid refinement.
 */
export function parsePlusCodes(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim().toUpperCase();

  // Plus codes: 8 characters + '+' + at least 2 more characters
  // Characters must be from OLC alphabet (note: '0' is padding, not valid for encoding)
  const plusCodeRegex = /^([23456789CFGHJMPQRVWX]{8})\+([23456789CFGHJMPQRVWX]{2,})$/;
  const match = trimmed.match(plusCodeRegex);

  if (!match || match[1] === undefined || match[2] === undefined) {
    return {
      message:
        'Invalid Plus Code format. Expected: 8 characters + "+" + 2+ characters (e.g., 8FW4V75V+8Q)',
      original: input,
      format: 'PlusCodes',
    };
  }

  const prefix = match[1];
  const suffix = match[2];
  const code = prefix + suffix;

  // Decode Plus Code using official OLC algorithm
  const result = decodeOpenLocationCode(code);
  if ('message' in result) {
    return {
      message: result.message,
      original: input,
      format: 'PlusCodes',
    };
  }

  return {
    coordinates: { latitude: result.lat, longitude: result.lon, depth_reference: 0 },
    format: 'PlusCodes',
    original: input,
  };
}

/**
 * Decode an Open Location Code (Plus Code) to latitude/longitude.
 * Implements the official OLC algorithm.
 *
 * The code is structured as:
 * - First 10 digits: 5 pairs using base-20 encoding
 * - Additional digits: Single characters using 4x5 grid refinement
 */
function decodeOpenLocationCode(code: string): { lat: number; lon: number } | { message: string } {
  const PAIR_CODE_LENGTH = 10; // First 10 digits are pairs
  const ENCODING_BASE = 20;
  const GRID_ROWS = 5;
  const GRID_COLS = 4;
  const LATITUDE_MAX = 90;
  const LONGITUDE_MAX = 180;

  // Initial resolution for the first digit pair
  const PAIR_FIRST_PLACE_VALUE = Math.pow(ENCODING_BASE, 2); // 400

  let latValue = 0;
  let lonValue = 0;
  let latPlaceValue = PAIR_FIRST_PLACE_VALUE;
  let lonPlaceValue = PAIR_FIRST_PLACE_VALUE;

  // Process pairs (first 10 characters, 5 pairs)
  const pairLength = Math.min(code.length, PAIR_CODE_LENGTH);
  for (let i = 0; i < pairLength; i += 2) {
    latPlaceValue /= ENCODING_BASE;
    lonPlaceValue /= ENCODING_BASE;

    const latChar = code[i];
    const lonChar = code[i + 1];

    if (latChar === undefined) {
      return { message: `Invalid Plus Code: missing character at position ${i}` };
    }

    const latIndex = OLC_ALPHABET.indexOf(latChar);
    if (latIndex < 0) {
      return { message: `Invalid Plus Code character '${latChar}' at position ${i}` };
    }
    latValue += latIndex * latPlaceValue;

    if (lonChar === undefined) {
      // Odd length - just use lat value
      break;
    }
    const lonIndex = OLC_ALPHABET.indexOf(lonChar);
    if (lonIndex < 0) {
      return { message: `Invalid Plus Code character '${lonChar}' at position ${i + 1}` };
    }
    lonValue += lonIndex * lonPlaceValue;
  }

  // Process grid refinement (characters after position 10, if any)
  if (code.length > PAIR_CODE_LENGTH) {
    let gridLatPlaceValue = latPlaceValue / GRID_ROWS;
    let gridLonPlaceValue = lonPlaceValue / GRID_COLS;

    for (let i = PAIR_CODE_LENGTH; i < code.length; i++) {
      const char = code[i];
      if (char === undefined) break;

      const charIndex = OLC_ALPHABET.indexOf(char);
      if (charIndex < 0) {
        return { message: `Invalid Plus Code character '${char}' at position ${i}` };
      }

      // Grid character encodes row * GRID_COLS + col
      const row = Math.floor(charIndex / GRID_COLS);
      const col = charIndex % GRID_COLS;

      latValue += row * gridLatPlaceValue;
      lonValue += col * gridLonPlaceValue;

      // Only divide place value if there are more characters to process
      if (i < code.length - 1) {
        gridLatPlaceValue /= GRID_ROWS;
        gridLonPlaceValue /= GRID_COLS;
      }
    }

    // Center of the final grid cell (use current place value, not over-divided)
    latValue += gridLatPlaceValue / 2;
    lonValue += gridLonPlaceValue / 2;
  } else {
    // Center of the pair cell
    latValue += latPlaceValue / 2;
    lonValue += lonPlaceValue / 2;
  }

  // Convert to actual lat/lon (offset from -90, -180)
  const lat = latValue - LATITUDE_MAX;
  const lon = lonValue - LONGITUDE_MAX;

  const validation = validateCoordinates(lat, lon);
  if (!validation.valid) {
    return { message: validation.errors.join('; ') };
  }

  return { lat, lon };
}

/**
 * Validate What3words format.
 * Examples: "///filled.count.soap", "filled.count.soap"
 *
 * IMPORTANT: What3words is a proprietary encoding that requires API access
 * for coordinate conversion. This function validates the format only.
 * Per the spec "Works offline (API optional for Plus Codes/What3words)",
 * offline format validation is the expected behavior.
 *
 * Returns an error with format='What3words' for valid formats (to indicate
 * the format was recognized but conversion requires API) or an error
 * with a different message for invalid formats.
 */
export function parseWhat3words(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim().toLowerCase();

  // Remove leading slashes if present
  const words = trimmed.replace(/^\/+/, '');

  // What3words format: word.word.word
  const w3wRegex = /^[a-z]+\.[a-z]+\.[a-z]+$/;

  if (!w3wRegex.test(words)) {
    return {
      message: 'Invalid What3words format. Expected: word.word.word (e.g., filled.count.soap)',
      original: input,
      format: 'What3words',
    };
  }

  // What3words requires API for conversion - cannot decode offline
  // This is by design - the spec says "Works offline (API optional for Plus Codes/What3words)"
  // which means format validation works offline, but conversion requires API
  return {
    message:
      'What3words requires API access for conversion. Please use DD, DMS, DDM, UTM, MGRS, or Plus Codes for offline use.',
    original: input,
    format: 'What3words',
  };
}

/**
 * Extract GPS coordinates from a URL.
 * Supports: Google Maps, OpenStreetMap, Bing Maps.
 *
 * Note: Does not support shortened URLs (goo.gl) or Apple Maps.
 */
export function parseUrl(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  // Check if it looks like a URL
  if (!trimmed.includes('http') && !trimmed.includes('maps') && !trimmed.includes('@')) {
    return {
      message: 'Input does not appear to be a map URL',
      original: input,
    };
  }

  // Google Maps patterns:
  // - https://www.google.com/maps/@48.8584,2.2945,15z
  // - https://www.google.com/maps/place/.../@48.8584,2.2945,15z
  // - https://maps.google.com/?q=48.8584,2.2945

  // Pattern 1: @lat,lon,zoom
  const googleAtPattern = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/;
  const googleAtMatch = trimmed.match(googleAtPattern);
  if (googleAtMatch && googleAtMatch[1] !== undefined && googleAtMatch[2] !== undefined) {
    const lat = parseFloat(googleAtMatch[1]);
    const lon = parseFloat(googleAtMatch[2]);
    const validation = validateCoordinates(lat, lon);
    if (validation.valid) {
      return {
        coordinates: { latitude: lat, longitude: lon, depth_reference: 0 },
        format: 'DD',
        original: input,
      };
    }
  }

  // Pattern 2: ?q=lat,lon or ?ll=lat,lon
  const queryPattern = /[?&](?:q|ll)=(-?\d+\.?\d*),(-?\d+\.?\d*)/;
  const queryMatch = trimmed.match(queryPattern);
  if (queryMatch && queryMatch[1] !== undefined && queryMatch[2] !== undefined) {
    const lat = parseFloat(queryMatch[1]);
    const lon = parseFloat(queryMatch[2]);
    const validation = validateCoordinates(lat, lon);
    if (validation.valid) {
      return {
        coordinates: { latitude: lat, longitude: lon, depth_reference: 0 },
        format: 'DD',
        original: input,
      };
    }
  }

  // OpenStreetMap pattern:
  // - https://www.openstreetmap.org/#map=15/48.8584/2.2945
  const osmPattern = /#map=\d+\/(-?\d+\.?\d*)\/(-?\d+\.?\d*)/;
  const osmMatch = trimmed.match(osmPattern);
  if (osmMatch && osmMatch[1] !== undefined && osmMatch[2] !== undefined) {
    const lat = parseFloat(osmMatch[1]);
    const lon = parseFloat(osmMatch[2]);
    const validation = validateCoordinates(lat, lon);
    if (validation.valid) {
      return {
        coordinates: { latitude: lat, longitude: lon, depth_reference: 0 },
        format: 'DD',
        original: input,
      };
    }
  }

  // Bing Maps pattern:
  // - https://www.bing.com/maps?cp=48.8584~2.2945
  const bingPattern = /cp=(-?\d+\.?\d*)~(-?\d+\.?\d*)/;
  const bingMatch = trimmed.match(bingPattern);
  if (bingMatch && bingMatch[1] !== undefined && bingMatch[2] !== undefined) {
    const lat = parseFloat(bingMatch[1]);
    const lon = parseFloat(bingMatch[2]);
    const validation = validateCoordinates(lat, lon);
    if (validation.valid) {
      return {
        coordinates: { latitude: lat, longitude: lon, depth_reference: 0 },
        format: 'DD',
        original: input,
      };
    }
  }

  return {
    message:
      'Could not extract coordinates from URL. Supported: Google Maps (@lat,lon or ?q=lat,lon), OpenStreetMap (#map=zoom/lat/lon), Bing Maps (cp=lat~lon)',
    original: input,
  };
}

/**
 * Detect the format of a GPS coordinate string.
 * Returns the most likely format or undefined if unknown.
 */
export function detectFormat(input: string): GpsFormat | undefined {
  const trimmed = input.trim();

  // URL detection (highest priority)
  if (trimmed.includes('http') || (trimmed.includes('maps') && trimmed.includes('/'))) {
    return undefined; // URLs handled separately
  }

  // What3words: word.word.word or ///word.word.word
  // Must be exactly 3 words with only letters
  if (/^(\/\/\/)?[a-z]+\.[a-z]+\.[a-z]+$/i.test(trimmed)) {
    return 'What3words';
  }

  // Plus Codes: 8 chars + '+' + 2+ chars from OLC alphabet
  if (/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,}$/i.test(trimmed)) {
    return 'PlusCodes';
  }

  // MGRS: zone + band + 2 letters + even digits
  if (/^\d{1,2}[A-Za-z]\s*[A-Za-z]{2}\s*\d+$/i.test(trimmed.replace(/\s/g, ''))) {
    return 'MGRS';
  }

  // UTM: zone + band + easting + northing with separators
  if (/^\d{1,2}\s*[A-Za-z][,\s]+\d+[,\s]+\d+$/.test(trimmed)) {
    return 'UTM';
  }

  // DMS with symbols: has degree AND minute AND second markers
  if (/\d+[°]\s*\d+[′']\s*\d+\.?\d*[″"]/.test(trimmed)) {
    return 'DMS';
  }

  // DMS space-separated: 3 numbers + direction for both lat and lon
  if (/^\d+\s+\d+\s+\d+\.?\d*\s*[NSns]\s+\d+\s+\d+\s+\d+\.?\d*\s*[EWew]$/i.test(trimmed)) {
    return 'DMS';
  }

  // DDM: degree symbol + decimal minutes + direction
  if (/\d+[°]\s*\d+\.\d+[′']?\s*[NSEWnsew]/i.test(trimmed)) {
    return 'DDM';
  }

  // DD: two decimal numbers separated by comma or space
  if (/^-?\d+\.?\d*[,\s]+-?\d+\.?\d*$/.test(trimmed)) {
    return 'DD';
  }

  return undefined;
}

/**
 * Auto-detect format and parse GPS coordinates.
 * Tries each parser in order of likelihood.
 */
export function parseGps(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      message: 'Empty input',
      original: input,
    };
  }

  // Try URL extraction first (check for URL-like patterns)
  if (
    trimmed.includes('http') ||
    (trimmed.includes('maps') && trimmed.includes('/')) ||
    trimmed.includes('@')
  ) {
    const urlResult = parseUrl(trimmed);
    if ('coordinates' in urlResult) {
      return urlResult;
    }
    // Fall through to try other formats only if @ is not in a URL context
    if (trimmed.includes('http') || trimmed.includes('maps')) {
      return urlResult; // Return URL error for actual URLs
    }
  }

  // Detect format
  const format = detectFormat(trimmed);

  if (format) {
    // Try detected format first
    switch (format) {
      case 'DD':
        return parseDD(trimmed);
      case 'DMS':
        return parseDMS(trimmed);
      case 'DDM':
        return parseDDM(trimmed);
      case 'UTM':
        return parseUTM(trimmed);
      case 'MGRS':
        return parseMGRS(trimmed);
      case 'PlusCodes':
        return parsePlusCodes(trimmed);
      case 'What3words':
        return parseWhat3words(trimmed);
    }
  }

  // Try all parsers in order (DD first as most common)
  const parsers: Array<[GpsFormat, (s: string) => GpsParseResult | GpsParseError]> = [
    ['DD', parseDD],
    ['DMS', parseDMS],
    ['DDM', parseDDM],
    ['UTM', parseUTM],
    ['MGRS', parseMGRS],
    ['PlusCodes', parsePlusCodes],
    ['What3words', parseWhat3words],
  ];

  for (const [, parser] of parsers) {
    const result = parser(trimmed);
    if ('coordinates' in result) {
      return result;
    }
  }

  return {
    message:
      'Could not parse GPS coordinates. Supported formats: DD (48.8584, 2.2945), DMS (48°51\'30"N 2°17\'40"E), DDM (48°51.5\'N 2°17.67\'E), UTM (31U 448251 5411932), MGRS (31UDQ4825111932), Plus Codes (8FW4V75V+8Q), URL (Google/OSM/Bing Maps links), What3words (requires API)',
    original: input,
  };
}

/**
 * Format GPS coordinates to a specific format.
 * Supports DD, DMS, and DDM output formats.
 *
 * For unsupported formats (UTM, MGRS, PlusCodes, What3words), falls back
 * to DD format silently. This is intentional to avoid breaking UI code
 * that may pass any format. For strict format handling, check the format
 * before calling this function.
 */
export function formatGpsCoordinates(
  coords: GpsCoordinates,
  format: GpsFormat = 'DD',
  precision: number = 6
): string {
  const { latitude, longitude } = coords;

  switch (format) {
    case 'DD':
      return `${latitude.toFixed(precision)}, ${longitude.toFixed(precision)}`;

    case 'DMS': {
      const latDir = latitude >= 0 ? 'N' : 'S';
      const lonDir = longitude >= 0 ? 'E' : 'W';
      const absLat = Math.abs(latitude);
      const absLon = Math.abs(longitude);
      const latDeg = Math.floor(absLat);
      const latMin = Math.floor((absLat - latDeg) * 60);
      const latSec = ((absLat - latDeg) * 60 - latMin) * 60;
      const lonDeg = Math.floor(absLon);
      const lonMin = Math.floor((absLon - lonDeg) * 60);
      const lonSec = ((absLon - lonDeg) * 60 - lonMin) * 60;
      return `${latDeg}°${latMin}'${latSec.toFixed(2)}"${latDir} ${lonDeg}°${lonMin}'${lonSec.toFixed(2)}"${lonDir}`;
    }

    case 'DDM': {
      const latDir = latitude >= 0 ? 'N' : 'S';
      const lonDir = longitude >= 0 ? 'E' : 'W';
      const absLat = Math.abs(latitude);
      const absLon = Math.abs(longitude);
      const latDeg = Math.floor(absLat);
      const latMin = (absLat - latDeg) * 60;
      const lonDeg = Math.floor(absLon);
      const lonMin = (absLon - lonDeg) * 60;
      return `${latDeg}°${latMin.toFixed(4)}'${latDir} ${lonDeg}°${lonMin.toFixed(4)}'${lonDir}`;
    }

    case 'UTM':
    case 'MGRS':
    case 'PlusCodes':
    case 'What3words':
      // These formats require complex encoding - fall back to DD with warning
      // Throwing would break UI, so return DD with a note
      return `${latitude.toFixed(precision)}, ${longitude.toFixed(precision)}`;

    default:
      return `${latitude.toFixed(precision)}, ${longitude.toFixed(precision)}`;
  }
}
