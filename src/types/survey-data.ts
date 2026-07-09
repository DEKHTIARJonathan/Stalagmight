/**
 * Struct-of-Arrays representation of a survey's bulk numeric data.
 *
 * Background: the legacy in-memory shape is `Project.sections[].shots[]`
 * (75k+ JS `Shot` objects across 14k+ `Section` arrays) plus a parallel
 * `Station[]` (89k+ `Station` objects). Each object has 5-16 named
 * fields and JSC's IsoHeap commits a per-class slab that doesn't
 * decommit on close. After loading 92.stalx once the WebProcess ends
 * up with ~2 GB of committed but-mostly-empty slabs that won't return
 * to the OS without external pressure.
 *
 * This module defines a flat typed-array layout (`SurveyData`) and
 * thin accessor helpers (`getShot`, `getStation`) that materialize a
 * legacy-shape object on demand. The intent:
 *
 *   - In-store representation: ~6 typed arrays + small sparse Maps.
 *     One bmalloc large-block per array. No per-class slabs.
 *   - Consumer representation: still `Shot` / `Station` objects, but
 *     created on access. DataTable/DetailPanel only materialize the
 *     ~100 rows/items they actually display.
 *
 * Field correspondence between SurveyData and the existing IPC types
 * (`Shot`, `Station`) is intentionally one-to-one so the migration is
 * mechanical: anywhere a consumer reads `shot.azimuth_in`, after the
 * migration it reads `data.shotAzimuthIn[i]` directly, or — if it
 * needs an object — calls `getShot(data, i)`.
 */

import type { Shot } from './ipc/Shot';
import type { Station } from './ipc/Station';
import type { StationRef } from './ipc/StationRef';
import type { ClosureRef } from './ipc/ClosureRef';
import type { GpsCoordinates } from './ipc/GpsCoordinates';
import type { SurveyDirection } from './ipc/SurveyDirection';

/** Section metadata kept as small structured objects. ~14k items for
 *  92.stalx; total memory is tiny compared to the shot payload. The
 *  `shots[]` array is *gone* — shots live in `SurveyData` keyed by
 *  global index and looked up via `shotOffset` + `shotCount`.
 *
 *  Field names match the IPC `Section` shape minus `shots`. */
export interface SectionMetadata {
  id: number;
  name: string | null;
  surveyor: string | null;
  /** ISO 8601 date string (matches IPC), or null. */
  date: string | null;
  color: string;
  direction: SurveyDirection;
  quality: number;
  next_shot_id: number;
  /** Offset into the flat shot arrays where this section's shots start. */
  shotOffset: number;
  /** Number of shots in this section (== section.shots.length pre-SoA). */
  shotCount: number;
}

/** Flat struct-of-arrays layout for shots + stations. All numeric
 *  fields live in typed arrays. Sparse / variable fields live in
 *  `Map`s keyed by global index. */
export interface SurveyData {
  // ─── Sections ──────────────────────────────────────────────────────
  /** Sections in declaration order. Each entry's `shotOffset` /
   *  `shotCount` index into the flat shot arrays below. */
  sections: SectionMetadata[];

  // ─── Shots (flat, one slot per shot) ───────────────────────────────
  /** Number of shots == length of each shot* array divided by stride. */
  shotCount: number;
  /** Shot.id per global shot index. */
  shotIds: Int32Array;
  /** Section id per global shot index. Redundant with the section
   *  metadata's shotOffset+shotCount but lets a consumer go from
   *  shot index → section id without a binary search. */
  shotSectionIds: Int32Array;
  shotAzimuthIn: Float32Array;
  shotAzimuthOut: Float32Array;
  shotLength: Float32Array;
  shotDepthIn: Float32Array;
  shotDepthOut: Float32Array;
  /** `NaN` represents `null` (Shot.pitch_in is `number | null`). */
  shotPitchIn: Float32Array;
  shotPitchOut: Float32Array;
  shotLeft: Float32Array;
  shotRight: Float32Array;
  shotUp: Float32Array;
  shotDown: Float32Array;
  shotTemperature: Float32Array;
  /** Bit 0: is_reference. Room to grow (e.g. has_comment cache bit). */
  shotFlags: Uint8Array;
  /** `-1` represents `null` for the IPC's optional marker_index. */
  shotMarkerIndex: Int32Array;
  /** Sparse map of shot global index → comment string. Only shots
   *  that actually have a comment are in the map (most don't). */
  shotComments: Map<number, string>;

  // ─── Stations (flat, one slot per station) ─────────────────────────
  stationCount: number;
  stationSectionIds: Int32Array;
  stationIndices: Uint32Array;
  /** Stride-3 flat coordinates: [x0,y0,z0, x1,y1,z1, …]. */
  stationCoords: Float64Array;
  /** Bit 0: is_zero_datum. */
  stationFlags: Uint8Array;
  /** Sparse extras keyed by global station index. */
  stationGps: Map<number, GpsCoordinates>;
  stationMergedWith: Map<number, StationRef[]>;
  stationClosuresWith: Map<number, ClosureRef[]>;
  stationComments: Map<number, string>;
}

/** Sentinel: `Int32Array`'s representation of "the marker_index is null". */
export const SHOT_MARKER_NULL = -1;
/** Bit position of the `is_reference` flag in `shotFlags`. */
export const SHOT_FLAG_IS_REFERENCE = 0b01;
/** Bit position of the `is_zero_datum` flag in `stationFlags`. */
export const STATION_FLAG_IS_ZERO_DATUM = 0b01;

/** Convert a `Float32Array` slot back to `number | null`, using NaN as
 *  the null sentinel — matches the encoding in `loadProjectBinary.ts`. */
export function nanToNull(v: number): number | null {
  return Number.isNaN(v) ? null : v;
}

/**
 * Materialize a single `Shot` from a `SurveyData` at the given global
 * shot index (0-based across all sections). Cheap (one object alloc,
 * ~250 B) but call it sparingly — calling for every shot in a 75k
 * project undoes the point of the SoA layout. Use raw typed-array
 * field access (`data.shotAzimuthIn[i]`) in hot iteration paths.
 *
 * Throws if the index is out of range (defensive; would otherwise
 * silently return NaN'd / -1'd nonsense).
 */
export function getShot(data: SurveyData, globalIndex: number): Shot {
  if (globalIndex < 0 || globalIndex >= data.shotCount) {
    throw new RangeError(`shot index ${globalIndex} out of range (0..${data.shotCount})`);
  }
  return {
    id: data.shotIds[globalIndex]!,
    azimuth_in: data.shotAzimuthIn[globalIndex]!,
    azimuth_out: data.shotAzimuthOut[globalIndex]!,
    length: data.shotLength[globalIndex]!,
    depth_in: data.shotDepthIn[globalIndex]!,
    depth_out: data.shotDepthOut[globalIndex]!,
    pitch_in: nanToNull(data.shotPitchIn[globalIndex]!),
    pitch_out: nanToNull(data.shotPitchOut[globalIndex]!),
    left: nanToNull(data.shotLeft[globalIndex]!),
    right: nanToNull(data.shotRight[globalIndex]!),
    up: nanToNull(data.shotUp[globalIndex]!),
    down: nanToNull(data.shotDown[globalIndex]!),
    comment: data.shotComments.get(globalIndex) ?? null,
    is_reference: (data.shotFlags[globalIndex]! & SHOT_FLAG_IS_REFERENCE) !== 0,
    marker_index: data.shotMarkerIndex[globalIndex] === SHOT_MARKER_NULL
      ? null
      : data.shotMarkerIndex[globalIndex]!,
    temperature: nanToNull(data.shotTemperature[globalIndex]!),
  };
}

/**
 * Look up a shot by `(section_id, shot_id)` — the natural identity for
 * UI handlers that receive these from MapLibre feature properties.
 * Returns `null` if not found.
 *
 * Iterates the section's shot range. For sections of typical size
 * (~5-100 shots) this is cheap; for a 5000-shot section it's still
 * sub-millisecond. If lookups become a bottleneck, add an
 * `(sectionId, shotId) → globalIndex` Map at construction time.
 */
export function findShotGlobalIndex(
  data: SurveyData,
  sectionId: number,
  shotId: number,
): number | null {
  // Find the section's range.
  const sec = data.sections.find((s) => s.id === sectionId);
  if (!sec) return null;
  for (let i = sec.shotOffset; i < sec.shotOffset + sec.shotCount; i++) {
    if (data.shotIds[i] === shotId) return i;
  }
  return null;
}

/**
 * Materialize a single `Station` from a `SurveyData` at the given
 * global station index.
 */
export function getStation(data: SurveyData, globalIndex: number): Station {
  if (globalIndex < 0 || globalIndex >= data.stationCount) {
    throw new RangeError(`station index ${globalIndex} out of range (0..${data.stationCount})`);
  }
  const sectionId = data.stationSectionIds[globalIndex]!;
  const stationIndex = data.stationIndices[globalIndex]!;
  const coordBase = globalIndex * 3;
  const station: Station = {
    station_ref: {
      section_id: sectionId,
      station_index: stationIndex,
    },
    coordinates: {
      x: data.stationCoords[coordBase]!,
      y: data.stationCoords[coordBase + 1]!,
      z: data.stationCoords[coordBase + 2]!,
    },
    is_zero_datum: (data.stationFlags[globalIndex]! & STATION_FLAG_IS_ZERO_DATUM) !== 0,
    gps_coordinates: data.stationGps.get(globalIndex) ?? null,
    merged_with: data.stationMergedWith.get(globalIndex) ?? [],
    closures_with: data.stationClosuresWith.get(globalIndex) ?? [],
  };
  const cmt = data.stationComments.get(globalIndex);
  if (cmt !== undefined) station.comment = cmt;
  return station;
}

/**
 * Find a station's global index by `(section_id, station_index)`.
 * Used by MapLibre click/hover handlers that get those two numbers
 * from feature properties.
 *
 * Linear scan; fine for the volumes we care about. Add a Map index if
 * a profile shows this in hot paths.
 */
export function findStationGlobalIndex(
  data: SurveyData,
  sectionId: number,
  stationIndex: number,
): number | null {
  for (let i = 0; i < data.stationCount; i++) {
    if (data.stationSectionIds[i] === sectionId &&
        data.stationIndices[i] === stationIndex) {
      return i;
    }
  }
  return null;
}

/**
 * Build a read-only, lazily-materialized `Station[]` view over a
 * `SurveyData`.
 *
 * Numeric index access (`view[i]`) calls `getStation(data, i)`, `.length`
 * reports `data.stationCount`, and the standard read-only `Array` methods
 * (`find`, `filter`, `map`, `some`, `forEach`, `slice`, `for…of`,
 * `entries`) work because they read `length` and indices back through the
 * proxy traps. `Array.isArray(view)` is `true` (the proxy target is a real
 * array), so array-producing methods (`map`/`filter`/`slice`) return real
 * arrays.
 *
 * Memory intent: no `Station` object is retained. Each index access
 * materializes a fresh object, so a full pass (e.g. fit-to-bounds)
 * produces garbage-collectable temporaries instead of a persistent
 * ~89 k-object array that duplicates `stationCoords` / `stationSectionIds`
 * / `stationIndices` (the eager `Station[]` the binary loader used to
 * build). The proxy is read-only — the app never mutates the store
 * `stations` array — so no write/mutate traps are provided.
 */
export function lazyStationArray(data: SurveyData): Station[] {
  // Empty target: holds no slots, so no per-station memory. `length` and
  // indices are served entirely by the traps below.
  const target: Station[] = [];

  /** Parse a property key as a canonical array index, else null. Mirrors
   *  the ECMAScript "array index" definition (non-negative integer with
   *  no leading zeros / other noise), so `'01'`, `'1.0'`, `'-1'`, `'x'`
   *  fall through to the ordinary property path. */
  const asIndex = (prop: string): number | null => {
    const n = Number(prop);
    if (!Number.isInteger(n) || n < 0) return null;
    if (String(n) !== prop) return null;
    return n;
  };

  const handler: ProxyHandler<Station[]> = {
    get(t, prop, receiver) {
      if (prop === 'length') return data.stationCount;
      if (typeof prop === 'string') {
        const idx = asIndex(prop);
        if (idx !== null) {
          return idx < data.stationCount ? getStation(data, idx) : undefined;
        }
      }
      return Reflect.get(t, prop, receiver);
    },
    has(t, prop) {
      if (prop === 'length') return true;
      if (typeof prop === 'string') {
        const idx = asIndex(prop);
        if (idx !== null) return idx < data.stationCount;
      }
      return Reflect.has(t, prop);
    },
  };

  return new Proxy(target, handler);
}

/**
 * Construct `SurveyData` from the legacy `Project.sections[].shots[]` +
 * `Station[]` shape that `refreshProjectState` still returns (it pulls
 * via JSON IPC, not the binary `load_project_full_binary` route).
 *
 * This is the migration-window converter — once the JSON IPC is also
 * binary-ized (out of scope for Phase A), this stops being needed.
 *
 * For the binary IPC path, see `buildSurveyData` inside
 * `utils/loadProjectBinary.ts` which builds `SurveyData` directly from
 * the wire bytes without going through legacy objects (faster, but
 * specific to that input shape).
 */
export function surveyDataFromLegacy(
  sections: import('./ipc/Section').Section[],
  stations: import('./ipc/Station').Station[],
): SurveyData {
  const totalShots = sections.reduce((s, sec) => s + sec.shots.length, 0);
  const data: SurveyData = {
    sections: [],
    shotCount: totalShots,
    shotIds: new Int32Array(totalShots),
    shotSectionIds: new Int32Array(totalShots),
    shotAzimuthIn: new Float32Array(totalShots),
    shotAzimuthOut: new Float32Array(totalShots),
    shotLength: new Float32Array(totalShots),
    shotDepthIn: new Float32Array(totalShots),
    shotDepthOut: new Float32Array(totalShots),
    shotPitchIn: new Float32Array(totalShots),
    shotPitchOut: new Float32Array(totalShots),
    shotLeft: new Float32Array(totalShots),
    shotRight: new Float32Array(totalShots),
    shotUp: new Float32Array(totalShots),
    shotDown: new Float32Array(totalShots),
    shotTemperature: new Float32Array(totalShots),
    shotFlags: new Uint8Array(totalShots),
    shotMarkerIndex: new Int32Array(totalShots),
    shotComments: new Map(),
    stationCount: stations.length,
    stationSectionIds: new Int32Array(stations.length),
    stationIndices: new Uint32Array(stations.length),
    stationCoords: new Float64Array(stations.length * 3),
    stationFlags: new Uint8Array(stations.length),
    stationGps: new Map(),
    stationMergedWith: new Map(),
    stationClosuresWith: new Map(),
    stationComments: new Map(),
  };

  const nullToNaN = (v: number | null | undefined): number => (v == null ? NaN : v);

  let cursor = 0;
  for (const section of sections) {
    data.sections.push({
      id: section.id,
      name: section.name,
      surveyor: section.surveyor,
      date: section.date,
      color: section.color,
      direction: section.direction,
      quality: section.quality,
      next_shot_id: section.next_shot_id,
      shotOffset: cursor,
      shotCount: section.shots.length,
    });
    for (const shot of section.shots) {
      data.shotIds[cursor] = shot.id;
      data.shotSectionIds[cursor] = section.id;
      data.shotAzimuthIn[cursor] = shot.azimuth_in;
      data.shotAzimuthOut[cursor] = shot.azimuth_out;
      data.shotLength[cursor] = shot.length;
      data.shotDepthIn[cursor] = shot.depth_in;
      data.shotDepthOut[cursor] = shot.depth_out;
      data.shotPitchIn[cursor] = nullToNaN(shot.pitch_in);
      data.shotPitchOut[cursor] = nullToNaN(shot.pitch_out);
      data.shotLeft[cursor] = nullToNaN(shot.left);
      data.shotRight[cursor] = nullToNaN(shot.right);
      data.shotUp[cursor] = nullToNaN(shot.up);
      data.shotDown[cursor] = nullToNaN(shot.down);
      data.shotTemperature[cursor] = nullToNaN(shot.temperature);
      data.shotFlags[cursor] = shot.is_reference ? SHOT_FLAG_IS_REFERENCE : 0;
      data.shotMarkerIndex[cursor] = shot.marker_index ?? SHOT_MARKER_NULL;
      if (shot.comment) data.shotComments.set(cursor, shot.comment);
      cursor++;
    }
  }

  stations.forEach((s, i) => {
    data.stationSectionIds[i] = s.station_ref.section_id;
    data.stationIndices[i] = s.station_ref.station_index;
    data.stationCoords[i * 3] = s.coordinates.x;
    data.stationCoords[i * 3 + 1] = s.coordinates.y;
    data.stationCoords[i * 3 + 2] = s.coordinates.z;
    data.stationFlags[i] = s.is_zero_datum ? STATION_FLAG_IS_ZERO_DATUM : 0;
    if (s.gps_coordinates) data.stationGps.set(i, s.gps_coordinates);
    // Rust's `Station` serializer skips `merged_with` / `closures_with`
    // when the vec is empty (see #[serde(skip_serializing_if =
    // "Vec::is_empty")] on src-tauri/src/models/station.rs), so the
    // JSON IPC path (`get_project_state`) hands back stations with
    // those fields *missing* — not empty arrays.  Treat undefined as
    // empty.  The binary IPC path always sets them via the sparse
    // pair maps so this only matters for the legacy JSON path.
    const mergedWith = s.merged_with;
    if (mergedWith && mergedWith.length > 0) {
      data.stationMergedWith.set(i, mergedWith);
    }
    const closuresWith = s.closures_with;
    if (closuresWith && closuresWith.length > 0) {
      data.stationClosuresWith.set(i, closuresWith);
    }
    if (s.comment) data.stationComments.set(i, s.comment);
  });

  return data;
}

/**
 * Build an empty `SurveyData` (zero shots, zero stations, zero
 * sections). Useful as the initial store value and for tests.
 */
export function emptySurveyData(): SurveyData {
  return {
    sections: [],
    shotCount: 0,
    shotIds: new Int32Array(0),
    shotSectionIds: new Int32Array(0),
    shotAzimuthIn: new Float32Array(0),
    shotAzimuthOut: new Float32Array(0),
    shotLength: new Float32Array(0),
    shotDepthIn: new Float32Array(0),
    shotDepthOut: new Float32Array(0),
    shotPitchIn: new Float32Array(0),
    shotPitchOut: new Float32Array(0),
    shotLeft: new Float32Array(0),
    shotRight: new Float32Array(0),
    shotUp: new Float32Array(0),
    shotDown: new Float32Array(0),
    shotTemperature: new Float32Array(0),
    shotFlags: new Uint8Array(0),
    shotMarkerIndex: new Int32Array(0),
    shotComments: new Map(),
    stationCount: 0,
    stationSectionIds: new Int32Array(0),
    stationIndices: new Uint32Array(0),
    stationCoords: new Float64Array(0),
    stationFlags: new Uint8Array(0),
    stationGps: new Map(),
    stationMergedWith: new Map(),
    stationClosuresWith: new Map(),
    stationComments: new Map(),
  };
}
