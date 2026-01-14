import type { Coordinates, GpsCoordinates } from '../types/project';

// Earth radius in meters for coordinate conversions
const EARTH_RADIUS = 6371000;

// Meters per degree (approximately at equator)
// Used to transform local meter coordinates to pseudo-lat/lng for MapLibre
const METERS_PER_DEGREE = 111320;

/**
 * Transform local meter coordinates to MapLibre-compatible pseudo-lat/lng
 * This allows MapLibre's scale bar to show correct distances
 */
export function metersToMapCoords(x: number, y: number): [number, number] {
  // lng, lat format for MapLibre
  return [x / METERS_PER_DEGREE, y / METERS_PER_DEGREE];
}

/**
 * Transform MapLibre pseudo-lat/lng back to local meter coordinates
 */
export function mapCoordsToMeters(lng: number, lat: number): { x: number; y: number } {
  return {
    x: lng * METERS_PER_DEGREE,
    y: lat * METERS_PER_DEGREE,
  };
}

/**
 * Convert GPS coordinates to internal XY coordinates (meters from origin)
 */
export function gpsToXY(
  gps: GpsCoordinates,
  origin: GpsCoordinates
): Coordinates {
  const latDiff = gps.latitude - origin.latitude;
  const lonDiff = gps.longitude - origin.longitude;

  // Convert to meters using simple equirectangular projection
  const y = latDiff * (Math.PI / 180) * EARTH_RADIUS;
  const x =
    lonDiff *
    (Math.PI / 180) *
    EARTH_RADIUS *
    Math.cos((origin.latitude * Math.PI) / 180);

  return {
    x,
    y,
    z: gps.depth_reference,
  };
}

/**
 * Convert internal XY coordinates to GPS coordinates
 */
export function xyToGps(
  coords: Coordinates,
  origin: GpsCoordinates
): GpsCoordinates {
  const latDiff = coords.y / ((Math.PI / 180) * EARTH_RADIUS);
  const lonDiff =
    coords.x /
    ((Math.PI / 180) * EARTH_RADIUS * Math.cos((origin.latitude * Math.PI) / 180));

  return {
    latitude: origin.latitude + latDiff,
    longitude: origin.longitude + lonDiff,
    depth_reference: coords.z,
  };
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
  return value.toFixed(precision);
}

/**
 * Format a GPS coordinate for display
 */
export function formatGps(gps: GpsCoordinates, precision: number = 6): string {
  return `${gps.latitude.toFixed(precision)}, ${gps.longitude.toFixed(precision)}`;
}
