import type { Coordinates, GpsCoordinates } from '../types/project';
import type { GpsOrigin } from '../types/config';
import { formatFixed } from '../i18n/format';
import { normalizeAzimuth } from './azimuth';

// WGS84, the ellipsoid the backend places every zero datum on
// (`gps_to_local`, src-tauri/crates/models/src/geo.rs). The map, the data
// table's GPS column and GlobalView must invert THAT projection: this file used
// a 6371000 m sphere, which drew a datum ~3 m per km away from its own fix
// (#576 D36). Constants and operation order mirror geo.rs, so the two sides
// agree to the last few ulps (pinned by the parity table in
// __tests__/coordinates.test.ts and survey_geometry.rs).
const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;
const WGS84_B = WGS84_A * Math.sqrt(1 - WGS84_E2);
const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);

// Meters per degree (approximately at equator)
// Used to transform local meter coordinates to pseudo-lat/lng for MapLibre
// when the project has no GPS origin - a display convention, not geodesy.
const METERS_PER_DEGREE = 111320;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

type Ecef = { x: number; y: number; z: number };
type Enu = { east: number; north: number; up: number };

type OriginFrame = {
  latRad: number;
  lonRad: number;
  sinLat: number;
  cosLat: number;
  sinLon: number;
  cosLon: number;
  ecef: Ecef;
};

function toRadians(deg: number): number {
  return deg * DEG_TO_RAD;
}

function toDegrees(rad: number): number {
  return rad * RAD_TO_DEG;
}

/** Geodetic (altitude 0) to ECEF on WGS84; mirrors `geodetic_to_ecef`. */
function gpsToEcef(latitude: number, longitude: number): Ecef {
  const latRad = toRadians(latitude);
  const lonRad = toRadians(longitude);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  // N = radius of curvature in the prime vertical
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: n * cosLat * Math.cos(lonRad),
    y: n * cosLat * Math.sin(lonRad),
    z: n * (1 - WGS84_E2) * sinLat,
  };
}

/**
 * ECEF to geodetic latitude/longitude on WGS84 (Bowring's formula; mirrors
 * `ecef_to_geodetic`). Sub-millimetre for any point within kilometres of the
 * surface, which is every point this file converts.
 */
function ecefToGps(ecef: Ecef): { latitude: number; longitude: number } {
  const p = Math.sqrt(ecef.x * ecef.x + ecef.y * ecef.y);
  const theta = Math.atan2(ecef.z * WGS84_A, p * WGS84_B);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const latRad = Math.atan2(
    ecef.z + WGS84_EP2 * WGS84_B * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta,
  );
  const lonRad = Math.atan2(ecef.y, ecef.x);
  return {
    latitude: toDegrees(latRad),
    longitude: toDegrees(lonRad),
  };
}

// One-entry memo: every caller converts many points against the same origin
// (the renderer once per station), so the frame's trig is paid once per origin.
let cachedFrame: { latitude: number; longitude: number; frame: OriginFrame } | null = null;

function buildOriginFrame(origin: { latitude: number; longitude: number }): OriginFrame {
  if (
    cachedFrame !== null &&
    cachedFrame.latitude === origin.latitude &&
    cachedFrame.longitude === origin.longitude
  ) {
    return cachedFrame.frame;
  }
  const frame = computeOriginFrame(origin);
  cachedFrame = { latitude: origin.latitude, longitude: origin.longitude, frame };
  return frame;
}

function computeOriginFrame(origin: { latitude: number; longitude: number }): OriginFrame {
  const latRad = toRadians(origin.latitude);
  const lonRad = toRadians(origin.longitude);
  return {
    latRad,
    lonRad,
    sinLat: Math.sin(latRad),
    cosLat: Math.cos(latRad),
    sinLon: Math.sin(lonRad),
    cosLon: Math.cos(lonRad),
    ecef: gpsToEcef(origin.latitude, origin.longitude),
  };
}

function ecefToEnu(ecef: Ecef, origin: OriginFrame): Enu {
  const dx = ecef.x - origin.ecef.x;
  const dy = ecef.y - origin.ecef.y;
  const dz = ecef.z - origin.ecef.z;
  return {
    east: -origin.sinLon * dx + origin.cosLon * dy,
    north:
      -origin.sinLat * origin.cosLon * dx -
      origin.sinLat * origin.sinLon * dy +
      origin.cosLat * dz,
    up:
      origin.cosLat * origin.cosLon * dx +
      origin.cosLat * origin.sinLon * dy +
      origin.sinLat * dz,
  };
}

function enuToEcef(enu: Enu, origin: OriginFrame): Ecef {
  const dx =
    -origin.sinLon * enu.east -
    origin.sinLat * origin.cosLon * enu.north +
    origin.cosLat * origin.cosLon * enu.up;
  const dy =
    origin.cosLon * enu.east -
    origin.sinLat * origin.sinLon * enu.north +
    origin.cosLat * origin.sinLon * enu.up;
  const dz = origin.cosLat * enu.north + origin.sinLat * enu.up;
  return {
    x: origin.ecef.x + dx,
    y: origin.ecef.y + dy,
    z: origin.ecef.z + dz,
  };
}

function gpsToEnu(
  gps: { latitude: number; longitude: number },
  origin: { latitude: number; longitude: number }
): Enu {
  const frame = buildOriginFrame(origin);
  const ecef = gpsToEcef(gps.latitude, gps.longitude);
  return ecefToEnu(ecef, frame);
}

/**
 * The exact inverse of the backend's `gps_to_local`: the point ON the ellipsoid
 * whose east/north from `origin` are (`east`, `north`). Mirrors `local_to_gps`
 * in geo.rs.
 *
 * `gps_to_local` drops the "up" component, so the answer is not the point at
 * (east, north, 0) on the origin's tangent plane: that point floats above the
 * curving surface, and dropping it straight down lands about d^3/(2 R^2) short
 * (1.5 mm at 5 km, 10 cm at 20 km). One correction re-aims at (east, north,
 * up) with the `up` the surface has under the first guess, which shrinks the
 * error by ~d/R: about 1 micrometre at 20 km and 0.1 mm at 50 km.
 */
function enuToGps(
  east: number,
  north: number,
  origin: { latitude: number; longitude: number }
): { latitude: number; longitude: number } {
  const frame = buildOriginFrame(origin);
  const guess = ecefToGps(enuToEcef({ east, north, up: 0 }, frame));
  const up = ecefToEnu(gpsToEcef(guess.latitude, guess.longitude), frame).up;
  return ecefToGps(enuToEcef({ east, north, up }, frame));
}

/**
 * Transform local meter coordinates to MapLibre-compatible lat/lng
 * If gpsOrigin is provided, coordinates are offset from that origin.
 * This allows satellite tiles to align with real-world geography.
 */
export function metersToMapCoords(
  x: number,
  y: number,
  gpsOrigin?: GpsOrigin | null
): [number, number] {
  if (!gpsOrigin) {
    // Fallback pseudo-lat/lng for local-only mode (no GPS origin).
    const metersPerDegreeLng = METERS_PER_DEGREE;
    const lng = x / metersPerDegreeLng;
    const lat = y / METERS_PER_DEGREE;
    return [lng, lat];
  }

  const gps = enuToGps(x, y, gpsOrigin);
  return [gps.longitude, gps.latitude];
}

/**
 * Transform MapLibre lat/lng back to local meter coordinates
 * If gpsOrigin is provided, coordinates are relative to that origin.
 */
export function mapCoordsToMeters(
  lng: number,
  lat: number,
  gpsOrigin?: GpsOrigin | null
): { x: number; y: number } {
  if (!gpsOrigin) {
    return {
      x: lng * METERS_PER_DEGREE,
      y: lat * METERS_PER_DEGREE,
    };
  }

  const enu = gpsToEnu({ latitude: lat, longitude: lng }, gpsOrigin);
  return { x: enu.east, y: enu.north };
}

/**
 * Convert GPS coordinates to internal XY coordinates (meters from origin)
 */
export function gpsToXY(
  gps: GpsCoordinates,
  origin: GpsCoordinates
): Coordinates {
  const enu = gpsToEnu(gps, origin);
  return { x: enu.east, y: enu.north, z: gps.depth_reference };
}

/**
 * Convert internal XY coordinates to GPS coordinates
 */
export function xyToGps(
  coords: Coordinates,
  origin: GpsCoordinates
): GpsCoordinates {
  const gps = enuToGps(coords.x, coords.y, origin);
  return { latitude: gps.latitude, longitude: gps.longitude, depth_reference: coords.z };
}

/**
 * Calculate distance between two coordinates
 */
export function distance(a: Coordinates, b: Coordinates): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Calculate horizontal distance between two coordinates
 */
export function horizontalDistance(a: Coordinates, b: Coordinates): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate the bounding box of a set of coordinates
 */
export function getBounds(coords: Coordinates[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
} {
  if (coords.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const coord of coords) {
    minX = Math.min(minX, coord.x);
    maxX = Math.max(maxX, coord.x);
    minY = Math.min(minY, coord.y);
    maxY = Math.max(maxY, coord.y);
    minZ = Math.min(minZ, coord.z);
    maxZ = Math.max(maxZ, coord.z);
  }

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Bounds over an interleaved `[x,y,z, x,y,z, …]` station-coordinate buffer (the
 * SoA `SurveyData.stationCoords`) - equivalent to `getBounds` but WITHOUT
 * materializing a `Coordinates[]`. The initial-view sizing used to
 * `stations.map((s) => s.coordinates)` the lazy `Station[]` proxy, which rebuilt
 * the whole ~89k-object graph on load just to read coordinates (#mem). Empty
 * buffer -> zeros, matching `getBounds([])`.
 */
export function getBoundsFromStationCoords(stationCoords: Float64Array): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
} {
  if (stationCoords.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 3 <= stationCoords.length; i += 3) {
    const x = stationCoords[i]!;
    const y = stationCoords[i + 1]!;
    const z = stationCoords[i + 2]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Calculate azimuth from point A to point B (degrees, [0, 360))
 *
 * Wrapped through `normalizeAzimuth` rather than a local `if (angle < 0) angle
 * += 360`: for a hair-west-of-north displacement that addend rounds to exactly
 * `360`, which is out of range and trips a non-ignorable `INVALID_AZIMUTH`.
 */
export function calculateAzimuth(from: Coordinates, to: Coordinates): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return normalizeAzimuth(Math.atan2(dx, dy) * (180 / Math.PI));
}

/**
 * Calculate new position from a point given azimuth and distance
 */
export function calculatePosition(
  from: Coordinates,
  azimuth: number,
  distance: number,
  depthChange: number
): Coordinates {
  const azimuthRad = (azimuth * Math.PI) / 180;
  return {
    x: from.x + distance * Math.sin(azimuthRad),
    y: from.y + distance * Math.cos(azimuthRad),
    z: from.z + depthChange,
  };
}

/**
 * Format a coordinate for display
 */
export function formatCoordinate(value: number, precision: number = 1): string {
  return formatFixed(value, undefined, precision);
}

/**
 * Format a GPS coordinate for display
 */
export function formatGps(gps: GpsCoordinates, precision: number = 6): string {
  return `${formatFixed(gps.latitude, undefined, precision)}, ${formatFixed(gps.longitude, undefined, precision)}`;
}
