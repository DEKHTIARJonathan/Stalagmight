export type { GeometryShot, SurveyGeometry, SurveyGeometryError } from './ipc.generated';

/**
 * Convert local meters to GPS coordinates relative to origin.
 *
 * Uses the same algorithm as the Rust backend for consistency.
 * This is useful for client-side coordinate transformations.
 *
 * @param east - Meters east of origin (positive = east)
 * @param north - Meters north of origin (positive = north)
 * @param originLat - Origin latitude in degrees
 * @param originLng - Origin longitude in degrees
 * @returns [lng, lat] tuple in MapLibre order
 */
export function metersToMapCoords(
  east: number,
  north: number,
  originLat: number,
  originLng: number
): [number, number] {
  const METERS_PER_DEGREE_LAT = 111320.0;

  const originLatRad = (originLat * Math.PI) / 180;
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(originLatRad);

  const lat = originLat + north / METERS_PER_DEGREE_LAT;
  const lng = originLng + east / metersPerDegreeLng;

  return [lng, lat];
}
