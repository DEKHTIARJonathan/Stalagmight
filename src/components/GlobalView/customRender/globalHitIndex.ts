/**
 * Screen-space hit index over the global view's systems (#customRender).
 *
 * When the custom WebGL layer draws the global survey, the stock shots/stations
 * layers (and their invisible hitbox layers) are hidden and their vector-tile
 * sources are dropped, so `queryRenderedFeatures` returns nothing. Interaction
 * therefore resolves geometrically here instead: given a screen point, find the
 * system under the cursor (station priority, then shot), the same station-first
 * order the stock hitbox queries used.
 *
 * Pure of MapLibre: takes a projection closure (`[lng,lat] -> {x,y}`), so it is
 * unit-testable in the `node` env with a synthetic projector. A conservative
 * per-system projected-AABB prefilter bounds the exact test to nearby systems.
 */
import type { SystemGeometry } from '../systemColor';
import { distanceToLineSegment } from '../../Map/surveyLayer/hitTest';
import { extractSystemStations } from './globalTessellate';

/** Screen projection: `[lng, lat] -> pixel coords`. Wraps `map.project`. */
export type ProjectFn = (lngLat: [number, number]) => { x: number; y: number };

/** A resolved hit: which system, and whether a station or a shot was nearest. */
export interface GlobalHit {
  systemId: string;
  kind: 'station' | 'shot';
}

export interface GlobalHitOptions {
  /** When false, reference shots + all-reference stations are non-interactive
   *  (mirrors setShowReferenceShots(false) filtering the hitbox layers). */
  includeReference: boolean;
  /** Station hit radius, px (stock station hitbox circle-radius). */
  stationReach: number;
  /** Shot hit reach, px (stock shot hitbox line-width / 2). */
  shotReach: number;
}

interface SystemEntry {
  systemId: string;
  /** Station centers, interleaved `[lng,lat,...]`. */
  stations: Float64Array;
  /** 1 when the station only touches reference shots. */
  stationAllRef: Uint8Array;
  /** Shot endpoints, interleaved `[fromLng,fromLat,toLng,toLat,...]`. */
  shots: Float64Array;
  /** 1 when the shot is a reference shot. */
  shotRef: Uint8Array;
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  // Screen-space projections, rebuilt only when the camera key changes (see
  // GlobalHitIndex.pick). Parallel to `stations` / `shots`; the AABB is the
  // projected diagonal corners. `projValid` is false until first projected, and
  // stays false for a degenerate (no-shot / infinite-AABB) system that is never
  // projected — those are skipped in the scan, as before.
  projStations: Float64Array;
  projShots: Float64Array;
  projMinX: number;
  projMinY: number;
  projMaxX: number;
  projMaxY: number;
  projValid: boolean;
}

/** Build the per-system station/shot arrays + world AABB once. */
function buildEntry(system: SystemGeometry): SystemEntry {
  const rawShots = system.geometry.shots;
  const shotList: number[] = [];
  const refList: number[] = [];
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const bump = (lng: number, lat: number): void => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  };
  for (const shot of rawShots) {
    if (shot.from.length < 2 || shot.to.length < 2) continue;
    const f0 = shot.from[0]!;
    const f1 = shot.from[1]!;
    const t0 = shot.to[0]!;
    const t1 = shot.to[1]!;
    shotList.push(f0, f1, t0, t1);
    refList.push(shot.is_reference ? 1 : 0);
    bump(f0, f1);
    bump(t0, t1);
  }
  const stationTriples = extractSystemStations(rawShots);
  const stations = new Float64Array(stationTriples.length * 2);
  const stationAllRef = new Uint8Array(stationTriples.length);
  for (let i = 0; i < stationTriples.length; i++) {
    stations[i * 2] = stationTriples[i]![0];
    stations[i * 2 + 1] = stationTriples[i]![1];
    stationAllRef[i] = stationTriples[i]![2] ? 1 : 0;
  }
  const shots = new Float64Array(shotList);
  return {
    systemId: system.metadata.file_path,
    stations,
    stationAllRef,
    shots,
    shotRef: new Uint8Array(refList),
    minLng,
    minLat,
    maxLng,
    maxLat,
    projStations: new Float64Array(stations.length),
    projShots: new Float64Array(shots.length),
    projMinX: 0,
    projMinY: 0,
    projMaxX: 0,
    projMaxY: 0,
    projValid: false,
  };
}

export class GlobalHitIndex {
  private readonly entries: SystemEntry[];
  /** Camera key the cached screen projections were built for; null forces a
   *  reproject on the next pick (initial state, and the uncached test path). */
  private cachedCameraKey: string | null = null;

  constructor(systems: SystemGeometry[]) {
    this.entries = systems.map(buildEntry);
  }

  /** Number of indexed systems (diagnostics / tests). */
  get systemCount(): number {
    return this.entries.length;
  }

  /**
   * Project every system's stations + shot endpoints + world-AABB corners into
   * screen space, once. Skips a degenerate (no-shot / infinite-AABB) system:
   * projecting its +/-Infinity bounds hands MapLibre an invalid lng/lat and
   * throws for the WHOLE global map.
   */
  private reproject(project: ProjectFn): void {
    for (const e of this.entries) {
      if (
        !Number.isFinite(e.minLng) ||
        !Number.isFinite(e.minLat) ||
        !Number.isFinite(e.maxLng) ||
        !Number.isFinite(e.maxLat)
      ) {
        e.projValid = false;
        continue;
      }
      for (let s = 0; s < e.stationAllRef.length; s++) {
        const p = project([e.stations[s * 2]!, e.stations[s * 2 + 1]!]);
        e.projStations[s * 2] = p.x;
        e.projStations[s * 2 + 1] = p.y;
      }
      for (let i = 0; i < e.shotRef.length; i++) {
        const a = project([e.shots[i * 4]!, e.shots[i * 4 + 1]!]);
        const b = project([e.shots[i * 4 + 2]!, e.shots[i * 4 + 3]!]);
        e.projShots[i * 4] = a.x;
        e.projShots[i * 4 + 1] = a.y;
        e.projShots[i * 4 + 2] = b.x;
        e.projShots[i * 4 + 3] = b.y;
      }
      // Diagonal corners (the app's global map has no bearing/pitch, so axis
      // order is preserved) give the screen AABB.
      const p1 = project([e.minLng, e.minLat]);
      const p2 = project([e.maxLng, e.maxLat]);
      e.projMinX = Math.min(p1.x, p2.x);
      e.projMaxX = Math.max(p1.x, p2.x);
      e.projMinY = Math.min(p1.y, p2.y);
      e.projMaxY = Math.max(p1.y, p2.y);
      e.projValid = true;
    }
  }

  /**
   * The system under the screen point, station-first then shot, or null. A
   * system whose projected world-AABB (expanded by the larger reach) does not
   * contain the point is skipped before any per-feature math.
   *
   * Projections are cached per `cameraKey`: during hover the camera is static,
   * so all but the first pick at a given camera reuse the cached screen coords
   * and never call `project` — otherwise a single large system under the cursor
   * would re-project all of its (up to ~150k) endpoints on every mousemove. Pass
   * a stable key that changes iff the projection changes (zoom / center /
   * bearing / pitch / viewport); pass `null` to reproject every call (the
   * uncached path, used by tests).
   */
  pick(
    project: ProjectFn,
    px: number,
    py: number,
    opts: GlobalHitOptions,
    cameraKey: string | null = null,
  ): GlobalHit | null {
    if (cameraKey === null || cameraKey !== this.cachedCameraKey) {
      this.reproject(project);
      this.cachedCameraKey = cameraKey;
    }

    const pad = Math.max(opts.stationReach, opts.shotReach);
    let bestStation: { systemId: string; dist: number } | null = null;
    let bestShot: { systemId: string; dist: number } | null = null;

    for (const e of this.entries) {
      if (!e.projValid) continue;
      // Padded screen-AABB prefilter (cached corners).
      if (
        px < e.projMinX - pad ||
        px > e.projMaxX + pad ||
        py < e.projMinY - pad ||
        py > e.projMaxY + pad
      ) {
        continue;
      }

      // Stations (priority) — cached screen coords, no projection.
      for (let s = 0; s < e.stationAllRef.length; s++) {
        if (!opts.includeReference && e.stationAllRef[s] === 1) continue;
        const dx = e.projStations[s * 2]! - px;
        const dy = e.projStations[s * 2 + 1]! - py;
        const dist = Math.hypot(dx, dy);
        if (dist <= opts.stationReach && (!bestStation || dist < bestStation.dist)) {
          bestStation = { systemId: e.systemId, dist };
        }
      }

      // Shots — cached screen coords, no projection.
      for (let i = 0; i < e.shotRef.length; i++) {
        if (!opts.includeReference && e.shotRef[i] === 1) continue;
        const dist = distanceToLineSegment(
          px,
          py,
          e.projShots[i * 4]!,
          e.projShots[i * 4 + 1]!,
          e.projShots[i * 4 + 2]!,
          e.projShots[i * 4 + 3]!,
        );
        if (dist <= opts.shotReach && (!bestShot || dist < bestShot.dist)) {
          bestShot = { systemId: e.systemId, dist };
        }
      }
    }

    if (bestStation) return { systemId: bestStation.systemId, kind: 'station' };
    if (bestShot) return { systemId: bestShot.systemId, kind: 'shot' };
    return null;
  }
}
