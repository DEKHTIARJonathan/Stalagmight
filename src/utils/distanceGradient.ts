import type { ExpressionSpecification } from 'maplibre-gl';
import type { DistanceField, Section } from '../types/project';
import { encodeFeatureId } from './ids';

/**
 * Distance-gradient overlay helpers (#34).
 *
 * The overlay colors shots/stations by along-cave distance from a chosen origin
 * using MapLibre `feature-state` (`dist`) + a swapped paint `interpolate`. These
 * pure helpers turn a backend `DistanceField` into per-feature `dist` values and
 * build the paint expression, kept here so they're unit-testable in isolation.
 */

/** Sentinel `dist` for unreachable / unknown features (renders grey). */
export const UNREACHABLE_DIST = -1;

/**
 * Dedicated distance-gradient ramp endpoints (near → far). Fixed hex (like the
 * depth ramp, which also forces constants regardless of theme) and deliberately
 * distinct hues from depth so it reads as a different encoding. (#34)
 */
export const DISTANCE_NEAR = '#f4d03f'; // gold — close to origin
export const DISTANCE_FAR = '#7d3c98'; // purple — far from origin

export interface DistanceFeatureState {
  /** featureId → dist (avg of the shot's two endpoints; -1 if either unreachable) */
  shots: Map<number, number>;
  /** featureId → dist (the station's own distance; -1 if unreachable) */
  stations: Map<number, number>;
  /** Largest finite distance, for the interpolate scale. */
  max: number;
}

/**
 * Build per-feature `dist` values from a `DistanceField`. Station value is its
 * own distance; shot value is the average of its two endpoint stations (so the
 * gradient flows along passage). Unreachable (`null`) or missing endpoints →
 * `UNREACHABLE_DIST`. Keys use the shared `encodeFeatureId` so they line up with
 * the feature ids produced by `surveyLayer/features.ts`.
 */
export function buildDistanceFeatureState(
  sections: Section[],
  field: DistanceField,
): DistanceFeatureState {
  // station ref → distance (null = unreachable)
  const byRef = new Map<string, number | null>();
  for (let i = 0; i < field.station_refs.length; i++) {
    const r = field.station_refs[i]!;
    byRef.set(`${r.section_id}:${r.station_index}`, field.distances[i] ?? null);
  }

  const stations = new Map<number, number>();
  const shots = new Map<number, number>();

  for (const section of sections) {
    const n = section.shots.length;
    // Stations: index 0..=n
    for (let idx = 0; idx <= n; idx++) {
      const d = byRef.get(`${section.id}:${idx}`);
      stations.set(encodeFeatureId(section.id, idx), d == null ? UNREACHABLE_DIST : d);
    }
    // Shots: connect station i → i+1; key by the shot's stable id.
    for (let i = 0; i < n; i++) {
      const shot = section.shots[i]!;
      const from = byRef.get(`${section.id}:${i}`);
      const to = byRef.get(`${section.id}:${i + 1}`);
      const value = from == null || to == null ? UNREACHABLE_DIST : (from + to) / 2;
      shots.set(encodeFeatureId(section.id, shot.id), value);
    }
  }

  return { shots, stations, max: field.max_reachable };
}

/**
 * MapLibre color expression for the distance gradient: interpolate `near → far`
 * over `0 → max` on the `dist` feature-state; anything with no/negative `dist`
 * (unset or unreachable) renders `grey`. Guards a degenerate `max <= 0` so the
 * interpolate stops stay strictly ascending.
 */
export function distanceColorExpression(
  near: string,
  far: string,
  max: number,
  grey: string,
): ExpressionSpecification {
  const safeMax = max > 0 ? max : 1;
  return [
    'let',
    'd',
    ['coalesce', ['feature-state', 'dist'], UNREACHABLE_DIST],
    [
      'case',
      ['<', ['var', 'd'], 0],
      grey,
      ['interpolate', ['linear'], ['var', 'd'], 0, near, safeMax, far],
    ],
  ] as ExpressionSpecification;
}
