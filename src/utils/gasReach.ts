import type { ExpressionSpecification } from 'maplibre-gl';
import type { GasReachField } from '../types/ipc.generated';
import type { Section } from '../types/project';
import { encodeFeatureId } from './ids';

/**
 * Gas reachable-frontier overlay helpers (#38, Phase 1).
 *
 * Sibling of {@link ./distanceGradient}: colors shots/stations by the litres of
 * gas it costs to reach them from the origin, using MapLibre `feature-state`
 * (`gasReach`) + a swapped paint `interpolate`. Only stations **within the turn
 * budget** carry a colorable value (gold near the origin → purple at the budget);
 * disconnected stations AND finite-but-over-budget stations both read grey — the
 * conservative direction (never paint a station reachable that the diver couldn't
 * turn at). These pure helpers keep the transform unit-testable in isolation.
 */

/** Sentinel `gasReach` for "not reachable on this gas plan" (renders grey). */
export const UNREACHABLE_GAS = -1;

/**
 * Reachable-overlay ramp endpoints (near → far). Reuses the distance gradient's
 * gold→purple hues so the two analytical overlays read consistently: gold = little
 * gas spent (near the origin), purple = at the turn budget (your turn point).
 */
export const GAS_NEAR = '#f4d03f'; // gold — little gas spent
export const GAS_FAR = '#7d3c98'; // purple — at the turn budget

export interface GasReachFeatureState {
  /** featureId → litres-to-reach (avg of the shot's two endpoints; -1 if either unreachable). */
  shots: Map<number, number>;
  /** featureId → litres-to-reach for the station (-1 if not reachable). */
  stations: Map<number, number>;
  /** The turn budget (litres) — the far (purple) end of the interpolate scale. */
  max: number;
}

/**
 * Turn a backend `GasReachField` into per-feature `gasReach` values. The scale max
 * is the **turn budget** (`budget_litres`), not the deepest reachable cost, so the
 * purple end always means "at your turn pressure" regardless of how much of the
 * cave is in range — spare budget reads as spare color, never a false "at-limit".
 */
export function buildGasReachFeatureState(
  sections: Section[],
  field: GasReachField,
): GasReachFeatureState {
  // station ref → litres (null = not reachable on this plan).
  const byRef = new Map<string, number | null>();
  for (let i = 0; i < field.station_refs.length; i++) {
    const r = field.station_refs[i]!;
    const litres = field.reachable[i] ? (field.gas_to_reach[i] ?? null) : null;
    byRef.set(`${r.section_id}:${r.station_index}`, litres);
  }

  const stations = new Map<number, number>();
  const shots = new Map<number, number>();

  for (const section of sections) {
    const n = section.shots.length;
    // Stations: index 0..=n
    for (let idx = 0; idx <= n; idx++) {
      const v = byRef.get(`${section.id}:${idx}`);
      stations.set(encodeFeatureId(section.id, idx), v == null ? UNREACHABLE_GAS : v);
    }
    // Shots: connect station i → i+1; key by the shot's stable id.
    for (let i = 0; i < n; i++) {
      const shot = section.shots[i]!;
      const from = byRef.get(`${section.id}:${i}`);
      const to = byRef.get(`${section.id}:${i + 1}`);
      const value = from == null || to == null ? UNREACHABLE_GAS : (from + to) / 2;
      shots.set(encodeFeatureId(section.id, shot.id), value);
    }
  }

  return { shots, stations, max: field.budget_litres };
}

/**
 * The gas reachable-frontier color ramp (shared by shots line-color and stations
 * circle-color so the two can't drift). Mirrors `distanceColorExpression` but reads
 * the `gasReach` feature-state key.
 */
export function gasReachColorExpression(
  near: string,
  far: string,
  max: number,
  grey: string,
): ExpressionSpecification {
  const safeMax = max > 0 ? max : 1;
  return [
    'let',
    'g',
    ['coalesce', ['feature-state', 'gasReach'], UNREACHABLE_GAS],
    [
      'case',
      ['<', ['var', 'g'], 0],
      grey,
      ['interpolate', ['linear'], ['var', 'g'], 0, near, safeMax, far],
    ],
  ] as ExpressionSpecification;
}
