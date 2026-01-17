/**
 * GPS coordinate parsing utilities.
 * Supports 7 formats: DD, DMS, DDM, UTM, MGRS, Plus Codes, What3words.
 * Also extracts coordinates from URLs (Google Maps, OpenStreetMap, etc.)
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

// Plus Codes alphabet (20 characters, no 0, 1, I, O)
const PLUS_CODE_CHARS = '23456789CFGHJMPQRVWX';

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
 */
export function parseDMS(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  // Flexible DMS regex supporting various delimiters
  // Matches: degrees, minutes, seconds with optional direction
  const dmsRegex =
    /(-?\d+)[°\s]+(\d+)['\s]+(\d+\.?\d*)["\s]*([NSns])?[,\s]+(-?\d+)[°\s]+(\d+)['\s]+(\d+\.?\d*)["\s]*([EWew])?/i;

  const match = trimmed.match(dmsRegex);

  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[5] === undefined ||
    match[6] === undefined ||
    match[7] === undefined
  ) {
    return {
      message: "Invalid DMS format. Expected: deg°min'sec\"N deg°min'sec\"E",
      original: input,
      format: 'DMS',
    };
  }

  const latDeg = parseInt(match[1], 10);
  const latMin = parseInt(match[2], 10);
  const latSec = parseFloat(match[3]);
  const latDir = (match[4] ?? 'N').toUpperCase();

  const lonDeg = parseInt(match[5], 10);
  const lonMin = parseInt(match[6], 10);
  const lonSec = parseFloat(match[7]);
  const lonDir = (match[8] ?? 'E').toUpperCase();

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
 * Examples: "48°51.5'N 2°17.67'E", "48 51.5 N 2 17.67 E"
 */
export function parseDDM(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  // Flexible DDM regex
  const ddmRegex =
    /(-?\d+)[°\s]+(\d+\.?\d*)['\s]*([NSns])?[,\s]+(-?\d+)[°\s]+(\d+\.?\d*)['\s]*([EWew])?/i;

  const match = trimmed.match(ddmRegex);

  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[4] === undefined ||
    match[5] === undefined
  ) {
    return {
      message: "Invalid DDM format. Expected: deg°min.dec'N deg°min.dec'E",
      original: input,
      format: 'DDM',
    };
  }

  const latDeg = parseInt(match[1], 10);
  const latMin = parseFloat(match[2]);
  const latDir = (match[3] ?? 'N').toUpperCase();

  const lonDeg = parseInt(match[4], 10);
  const lonMin = parseFloat(match[5]);
  const lonDir = (match[6] ?? 'E').toUpperCase();

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
 * Examples: "31U 448251 5411932", "31U448251,5411932"
 *
 * Note: UTM to lat/lon conversion uses simplified formulas.
 * For high precision, a geodetic library should be used.
 */
export function parseUTM(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim();

  // UTM regex: zone number, band letter, easting, northing
  const utmRegex = /^(\d{1,2})([A-Za-z])[,\s]+(\d+)[,\s]+(\d+)$/;
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
        'Invalid UTM format. Expected: zoneNumber zoneLetter easting northing (e.g., 31U 448251 5411932)',
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
 * Parse MGRS (Military Grid Reference System) format.
 * Examples: "31UDQ4825111932", "31U DQ 48251 11932"
 *
 * Note: MGRS to lat/lon uses simplified conversion via UTM.
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
  const square = match[3].toUpperCase();
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

  const halfLen = coords.length / 2;
  const eastingStr = coords.substring(0, halfLen);
  const northingStr = coords.substring(halfLen);

  // Pad to 5 digits for meter precision
  const eastingPadded = eastingStr.padEnd(5, '0');
  const northingPadded = northingStr.padEnd(5, '0');

  // Convert MGRS to UTM
  const result = mgrsToUtm(
    zone,
    band,
    square,
    parseInt(eastingPadded, 10),
    parseInt(northingPadded, 10)
  );
  if ('message' in result) {
    return {
      message: result.message,
      original: input,
      format: 'MGRS',
    };
  }

  // Convert UTM to lat/lon
  const latLon = utmToLatLon(zone, band, result.easting, result.northing);
  if ('message' in latLon) {
    return {
      message: latLon.message,
      original: input,
      format: 'MGRS',
    };
  }

  return {
    coordinates: { latitude: latLon.lat, longitude: latLon.lon, depth_reference: 0 },
    format: 'MGRS',
    original: input,
  };
}

/**
 * Convert MGRS 100km square identifier to UTM easting/northing.
 */
function mgrsToUtm(
  zone: number,
  band: string,
  square: string,
  easting: number,
  northing: number
): { easting: number; northing: number } | { message: string } {
  // 100km square letters
  // Column letters (A-Z excluding I and O) repeat every 3 zones, starting from zone set
  // Row letters (A-V excluding I and O) repeat every 2,000,000m
  const colLetters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const rowLetters = 'ABCDEFGHJKLMNPQRSTUV';

  const colLetter = square[0];
  const rowLetter = square[1];

  if (colLetter === undefined || rowLetter === undefined) {
    return { message: 'Invalid MGRS 100km square identifier' };
  }

  // Find column index (1-8 for each zone set)
  const setIndex = (zone - 1) % 3;
  const colOffset = setIndex * 8;
  let colIndex = colLetters.indexOf(colLetter) - colOffset;
  if (colIndex < 0) colIndex += 24;
  if (colIndex > 7) {
    return { message: 'Invalid MGRS 100km square column letter for this zone' };
  }

  // Find row index
  const rowIndex = rowLetters.indexOf(rowLetter);
  if (rowIndex < 0) {
    return { message: 'Invalid MGRS 100km square row letter' };
  }

  // Calculate UTM easting (100km squares start at 100000m)
  const utmEasting = (colIndex + 1) * 100000 + easting;

  // Calculate UTM northing
  // Row letters repeat every 2,000,000m, offset alternates by odd/even zones
  const rowOffset = zone % 2 === 0 ? 5 : 0;
  let baseNorthing = ((rowIndex - rowOffset + 20) % 20) * 100000;

  // Determine which 2,000,000m block based on band
  const bandIndex = MGRS_BAND_LETTERS.indexOf(band);
  // Approximate latitude range for band (each band is 8 degrees except X which is 12)
  const minLat = -80 + bandIndex * 8;

  // Calculate base northing for the band
  // This is a simplification - proper MGRS needs lookup tables
  const bandBaseNorthing = Math.floor((minLat + 80) / 8) * 2000000 - 10000000;
  if (band >= 'N') {
    // Northern hemisphere
    baseNorthing += Math.floor(bandBaseNorthing / 2000000) * 2000000;
  } else {
    // Southern hemisphere
    baseNorthing += Math.floor((bandBaseNorthing + 10000000) / 2000000) * 2000000;
  }

  const utmNorthing = baseNorthing + northing;

  return { easting: utmEasting, northing: utmNorthing };
}

/**
 * Parse Google Plus Codes (Open Location Code) format.
 * Examples: "8FW4V75V+8Q", "9F4MGCH4+QQ"
 *
 * Plus Codes are encoded lat/lon with 10+ characters (8 before +, 2+ after).
 * Can be shortened by removing prefix if area context is known.
 */
export function parsePlusCodes(input: string): GpsParseResult | GpsParseError {
  const trimmed = input.trim().toUpperCase();

  // Remove any leading/trailing characters that aren't part of the code
  // Plus codes are 8 characters + '+' + at least 2 more characters
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

  // Decode Plus Code
  const result = decodePlusCode(code);
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
 * Decode a Plus Code to latitude/longitude.
 */
function decodePlusCode(code: string): { lat: number; lon: number } | { message: string } {
  // Plus Code decoding
  // First 2 chars encode latitude in 20-degree blocks
  // Next 2 chars encode longitude in 20-degree blocks
  // Pairs after that refine by factor of 20

  const GRID_SIZE = 20;
  const chars = PLUS_CODE_CHARS;

  let lat = -90;
  let lon = -180;
  let latRes = GRID_SIZE;
  let lonRes = GRID_SIZE;

  // Process pairs
  for (let i = 0; i < code.length - 1; i += 2) {
    const latChar = code[i];
    const lonChar = code[i + 1];

    if (latChar === undefined || lonChar === undefined) {
      return { message: `Invalid Plus Code: incomplete pair at position ${i}` };
    }

    const latIndex = chars.indexOf(latChar);
    const lonIndex = chars.indexOf(lonChar);

    if (latIndex < 0 || lonIndex < 0) {
      return { message: `Invalid Plus Code character at position ${i}` };
    }

    lat += latIndex * latRes;
    lon += lonIndex * lonRes;

    // Each pair refines by factor of 20, except after position 8 where it's 5x4
    if (i < 8) {
      latRes /= GRID_SIZE;
      lonRes /= GRID_SIZE;
    } else {
      // After position 8, refinement is 5x4
      latRes /= 5;
      lonRes /= 4;
    }
  }

  // Return center of the cell
  lat += latRes / 2;
  lon += lonRes / 2;

  const validation = validateCoordinates(lat, lon);
  if (!validation.valid) {
    return { message: validation.errors.join('; ') };
  }

  return { lat, lon };
}

/**
 * Parse What3words format.
 * Examples: "///filled.count.soap", "filled.count.soap"
 *
 * Note: What3words requires API access for actual conversion.
 * This function validates the format but cannot convert offline.
 * Returns an error indicating API is required.
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
  return {
    message:
      'What3words requires API access for conversion. Please use DD, DMS, DDM, UTM, MGRS, or Plus Codes for offline use.',
    original: input,
    format: 'What3words',
  };
}

/**
 * Extract GPS coordinates from a URL.
 * Supports: Google Maps, OpenStreetMap, Apple Maps, Bing Maps, and generic @lat,lon patterns.
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
  // - https://goo.gl/maps/... (shortened, cannot resolve)
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
    message: 'Could not extract coordinates from URL. Try copying the coordinates directly from the map.',
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
  if (trimmed.includes('http') || trimmed.includes('maps')) {
    return undefined; // URLs handled separately
  }

  // What3words: word.word.word or ///word.word.word
  if (/^(\/\/\/)?[a-z]+\.[a-z]+\.[a-z]+$/i.test(trimmed)) {
    return 'What3words';
  }

  // Plus Codes: 8 chars + '+' + 2+ chars
  if (/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,}$/i.test(trimmed)) {
    return 'PlusCodes';
  }

  // MGRS: zone + band + 2 letters + even digits
  if (/^\d{1,2}[A-Za-z]\s*[A-Za-z]{2}\s*\d+$/i.test(trimmed.replace(/\s/g, ''))) {
    return 'MGRS';
  }

  // UTM: zone + band + easting + northing
  if (/^\d{1,2}[A-Za-z][,\s]+\d+[,\s]+\d+$/.test(trimmed)) {
    return 'UTM';
  }

  // DMS: contains degree symbol or N/S/E/W with minutes/seconds
  if (
    /[°'"]\s*[NSEWnsew]|[NSEWnsew]\s*[°'"]/.test(trimmed) ||
    /\d+[°]\s*\d+[′']\s*\d+/.test(trimmed)
  ) {
    // Check if it has seconds (DMS) or just minutes (DDM)
    if (
      /['′]\s*\d+\.?\d*\s*["″]/.test(trimmed) ||
      /\d+[°]\s*\d+[′']\s*\d+\.?\d*[″"]/i.test(trimmed)
    ) {
      return 'DMS';
    }
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

  // Try URL extraction first
  if (trimmed.includes('http') || trimmed.includes('maps') || trimmed.includes('@')) {
    const urlResult = parseUrl(trimmed);
    if ('coordinates' in urlResult) {
      return urlResult;
    }
    // Fall through to try other formats
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

  // Try all parsers in order
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
      'Could not parse GPS coordinates. Supported formats: DD (48.8584, 2.2945), DMS (48°51\'30"N 2°17\'40"E), DDM (48°51.5\'N 2°17.67\'E), UTM (31U 448251 5411932), MGRS (31UDQ4825111932), Plus Codes (8FW4V75V+8Q)',
    original: input,
  };
}

/**
 * Format GPS coordinates to a specific format.
 * Default format is DD with configurable precision.
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

    default:
      // UTM, MGRS, Plus Codes require complex encoding - return DD for now
      return `${latitude.toFixed(precision)}, ${longitude.toFixed(precision)}`;
  }
}
