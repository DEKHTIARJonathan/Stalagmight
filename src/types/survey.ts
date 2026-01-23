import type { SectionId } from './project';

/**
 * A self-contained shot with GPS coordinates and metadata.
 * Coordinates are in [lng, lat] order (MapLibre format).
 */
export interface GeometryShot {
  /** GPS coordinates of the from station [lng, lat] */
  from: [number, number];
  /** GPS coordinates of the to station [lng, lat] */
  to: [number, number];
  /** Whether this shot is virtual (temporary connection) */
  is_virtual: boolean;
  /** Section ID this shot belongs to */
  section_id: SectionId;
}

/**
 * Survey geometry response containing GPS-transformed shot data.
 */
export interface SurveyGeometry {
  /** Array of shots with GPS coordinates */
  shots: GeometryShot[];
  /** GPS origin used for the transformation [lng, lat] */
  origin: [number, number];
}

/**
 * Error response for survey geometry command.
 */
export interface SurveyGeometryError {
  message: string;
}

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
