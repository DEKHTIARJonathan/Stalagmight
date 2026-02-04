import type { Coordinates, GpsCoordinates } from '../types/project';
import type { GpsOrigin } from '../types/config';
import { formatFixed } from '../i18n/format';

// Earth radius in meters for coordinate conversions
const EARTH_RADIUS = 6371000;

// Meters per degree (approximately at equator)
// Used to transform local meter coordinates to pseudo-lat/lng for MapLibre
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

function gpsToEcef(latitude: number, longitude: number): Ecef {
  const latRad = toRadians(latitude);
  const lonRad = toRadians(longitude);
  const cosLat = Math.cos(latRad);
  return {
    x: EARTH_RADIUS * cosLat * Math.cos(lonRad),
    y: EARTH_RADIUS * cosLat * Math.sin(lonRad),
    z: EARTH_RADIUS * Math.sin(latRad),
  };
}

function ecefToGps(ecef: Ecef): { latitude: number; longitude: number } {
  const p = Math.sqrt(ecef.x * ecef.x + ecef.y * ecef.y);
  const latRad = Math.atan2(ecef.z, p);
  const lonRad = Math.atan2(ecef.y, ecef.x);
  return {
    latitude: toDegrees(latRad),
    longitude: toDegrees(lonRad),
  };
}

function buildOriginFrame(origin: { latitude: number; longitude: number }): OriginFrame {
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

function enuToGps(
  enu: Enu,
  origin: { latitude: number; longitude: number }
): { latitude: number; longitude: number } {
  const frame = buildOriginFrame(origin);
  const ecef = enuToEcef(enu, frame);
  return ecefToGps(ecef);
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

  const gps = enuToGps({ east: x, north: y, up: 0 }, gpsOrigin);
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
  const gps = enuToGps({ east: coords.x, north: coords.y, up: 0 }, origin);
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
 * Calculate azimuth from point A to point B (degrees, 0-360)
 */
export function calculateAzimuth(from: Coordinates, to: Coordinates): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let angle = Math.atan2(dx, dy) * (180 / Math.PI);
  if (angle < 0) {
    angle += 360;
  }
  return angle;
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
