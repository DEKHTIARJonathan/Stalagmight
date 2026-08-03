import type { ExpressionSpecification } from 'maplibre-gl';
import type { GasReachField } from '../types/ipc.generated';
import type { SurveyData } from '../types/survey-data';
import { encodeFeatureId } from './ids';

/**
 * Gas reachable-frontier overlay helpers (#38 Phase 1; #395 three-way split).
 *
 * Sibling of {@link ./distanceGradient}: colors shots/stations by the litres of
 * gas it costs to reach them from the origin, using MapLibre `feature-state`
 * (`gasReach`) + a swapped paint `interpolate`. Stations **within the turn
 * budget** carry a colorable value (gold near the origin -> purple at the
 * budget); stations connected to the survey but beyond reach - the gas budget
 * OR the scooter rig's usable range (the backend ANDs both, `gas.rs`
 * `budget_view`'s `in_range`) - keep their BASE color (dimmed, not greyed -
 * see `GAS_DIM_ALPHA`); only topologically UNCONNECTED stations read grey.
 * This three-way split lets a diver tell "past my turn point or scooter range"
 * (dimmed, colored) apart from "not part of this cave section at all" (grey)
 * at a glance. These pure helpers keep the transform unit-testable in
 * isolation.
 */

/** Sentinel `gasReach` for "no path cost solved" - unconnected or a stalled
 *  walk (renders grey). */
export const UNREACHABLE_GAS = -1;

/** Sentinel `gasReach` for "connected to the survey, but beyond the gas/turn
 *  budget" (renders the base section color, dimmed - never grey, never ramped). */
export const BEYOND_GAS_RANGE = -2;

/**
 * Reachable-overlay ramp endpoints (near → far). Reuses the distance gradient's
 * gold→purple hues so the two analytical overlays read consistently: gold = little
 * gas spent (near the origin), purple = at the turn budget (your turn point).
 */
export const GAS_NEAR = '#f4d03f'; // gold - little gas spent
export const GAS_FAR = '#7d3c98'; // purple - at the turn budget

/**
 * The set of `${section_id}:${station_index}` keys for stations reachable on the current gas plan.
 * Centralizes the "what counts as reachable" rule + the key format so the reach overlay and the
 * Plan-mode nearest-turnaround pick (`nearestReachableStationRef`) can't drift (#236). `station_refs`
 * and `reachable` are parallel arrays from the backend `GasReachField`.
 */
export function reachableStationKeySet(field: GasReachField): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < field.station_refs.length; i++) {
    if (field.reachable[i]) {
      const r = field.station_refs[i]!;
      keys.add(`${r.section_id}:${r.station_index}`);
    }
  }
  return keys;
}

export interface GasReachFeatureState {
  /** featureId → litres-to-reach (avg of the shot's two endpoints), or one of
   *  {@link UNREACHABLE_GAS} / {@link BEYOND_GAS_RANGE} - the "worse" class wins
   *  when the shot's two endpoints disagree (unconnected dominates beyond-reach). */
  shots: Map<number, number>;
  /** featureId → litres-to-reach for the station, or {@link UNREACHABLE_GAS} /
   *  {@link BEYOND_GAS_RANGE}. */
  stations: Map<number, number>;
  /** The turn budget (litres) - the far (purple) end of the interpolate scale. */
  max: number;
}

/** Classify one station's backend fact into the carried `gasReach` value:
 *  `gas_to_reach === null` means no path cost was solved at all - either the
 *  station is topologically unconnected, or the walk STALLED before reaching
 *  it (e.g. zero swim speed/RMV; backend `gas.rs` sets `reach_gas` to
 *  infinity, which serializes as null); a finite cost with `reachable ===
 *  false` means connected but past the turn/gas budget OR the scooter rig's
 *  usable range; otherwise the litres-to-reach are the value. */
function classifyStation(gasToReach: number | null | undefined, reachable: boolean): number {
  if (gasToReach == null) return UNREACHABLE_GAS;
  return reachable ? gasToReach : BEYOND_GAS_RANGE;
}

/** The "worse" of two station classes for a shot spanning them: unconnected
 *  dominates beyond-reach, which dominates any in-reach litre value. */
function worseOf(a: number, b: number): number {
  if (a === UNREACHABLE_GAS || b === UNREACHABLE_GAS) return UNREACHABLE_GAS;
  if (a === BEYOND_GAS_RANGE || b === BEYOND_GAS_RANGE) return BEYOND_GAS_RANGE;
  return (a + b) / 2;
}

/**
 * Turn a backend `GasReachField` into per-feature `gasReach` values. The scale max
 * is the **turn budget** (`budget_litres`), not the deepest reachable cost, so the
 * purple end always means "at your turn pressure" regardless of how much of the
 * cave is in range - spare budget reads as spare color, never a false "at-limit".
 *
 * Reads the struct-of-arrays `SurveyData` (section metadata + `shotIds`) rather
 * than `Section[].shots[]`, for the same reason as `buildDistanceFeatureState`:
 * enabling the overlay must not force-materialize every lazy `Shot` at load.
 */
export function buildGasReachFeatureState(
  data: Pick<SurveyData, 'sections' | 'shotIds'>,
  field: GasReachField,
): GasReachFeatureState {
  // station ref → classified value (litres, UNREACHABLE_GAS, or BEYOND_GAS_RANGE).
  const byRef = new Map<string, number>();
  for (let i = 0; i < field.station_refs.length; i++) {
    const r = field.station_refs[i]!;
    byRef.set(
      `${r.section_id}:${r.station_index}`,
      classifyStation(field.gas_to_reach[i], field.reachable[i] ?? false),
    );
  }

  const stations = new Map<number, number>();
  const shots = new Map<number, number>();

  for (const section of data.sections) {
    const n = section.shotCount;
    // Stations: index 0..=n
    for (let idx = 0; idx <= n; idx++) {
      const v = byRef.get(`${section.id}:${idx}`);
      stations.set(encodeFeatureId(section.id, idx), v ?? UNREACHABLE_GAS);
    }
    // Shots: connect station i → i+1; key by the shot's stable id (from SoA).
    // Conservative rule: if either endpoint is not in-reach, the shot takes the
    // worse of the two classes (unconnected dominates beyond-reach).
    for (let i = 0; i < n; i++) {
      const shotId = data.shotIds[section.shotOffset + i]!;
      const from = byRef.get(`${section.id}:${i}`) ?? UNREACHABLE_GAS;
      const to = byRef.get(`${section.id}:${i + 1}`) ?? UNREACHABLE_GAS;
      shots.set(encodeFeatureId(section.id, shotId), worseOf(from, to));
    }
  }

  return { shots, stations, max: field.budget_litres };
}

/**
 * The featureIds whose value is {@link BEYOND_GAS_RANGE} in a `shots` / `stations`
 * map from {@link GasReachFeatureState} - the custom renderer's gas-dim set (#395).
 * `undefined` (overlay off, or no state yet) yields an empty set.
 */
export function gasBeyondReachFeatureIds(map: Map<number, number> | undefined): ReadonlySet<number> {
  if (!map) return new Set<number>();
  const ids = new Set<number>();
  for (const [fid, value] of map) {
    if (value === BEYOND_GAS_RANGE) ids.add(fid);
  }
  return ids;
}

/**
 * The gas reachable-frontier color ramp (shared by shots line-color and stations
 * circle-color so the two can't drift). Mirrors `distanceColorExpression` but reads
 * the `gasReach` feature-state key, plus a third case: {@link BEYOND_GAS_RANGE}
 * (connected but past budget) falls through to `baseColorInput` - the feature's
 * own already-resolved base/section color (`['get', 'color']` on the interact /
 * drag-preview overlay features) - rather than grey or the ramp, approximating
 * the custom renderer's per-vertex dim.
 */
export function gasReachColorExpression(
  near: string,
  far: string,
  max: number,
  grey: string,
  gasInput: ExpressionSpecification = ['feature-state', 'gasReach'] as ExpressionSpecification,
  baseColorInput: ExpressionSpecification = ['get', 'color'] as ExpressionSpecification,
): ExpressionSpecification {
  const safeMax = max > 0 ? max : 1;
  return [
    'let',
    'g',
    ['coalesce', gasInput, UNREACHABLE_GAS],
    [
      'case',
      ['==', ['var', 'g'], BEYOND_GAS_RANGE],
      baseColorInput,
      ['<', ['var', 'g'], 0],
      grey,
      ['interpolate', ['linear'], ['var', 'g'], 0, near, safeMax, far],
    ],
  ] as ExpressionSpecification;
}
