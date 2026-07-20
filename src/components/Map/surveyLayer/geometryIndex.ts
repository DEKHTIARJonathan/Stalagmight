/**
 * Screen-space hit-test resolver over the SoA `SurveyData` (#mem).
 *
 * With merged shot/station features (see `features.ts` `mergeFeatures`), the
 * rendered hitbox layers can only tell us WHICH GROUPS (sections) are under
 * the cursor — the per-item identity (`shotId` / `stationIndex`) is no longer
 * a feature property. This module resolves the exact item geometrically:
 * MapLibre's rendered query gates the candidate sections, then we search only
 * those sections' shots/stations in screen space with the same
 * point-to-segment / point-distance math the old per-feature resolvers used
 * (`hitTest.ts`), so hover/click/snap targets and tolerances are identical.
 *
 * Equivalence argument (same pick as the per-feature path): the rendered
 * query returns a group iff at least one member is within the rendered hit
 * area (circle radius / half line width). The geometric argmin over ALL
 * members of returned groups therefore has distance <= that member's, i.e.
 * it lies within the rendered hit area too — and every item within the
 * rendered hit area belongs to a returned group. So the argmin sets coincide.
 * The one deliberate improvement: distances/`t` are computed from the TRUE
 * endpoints instead of tile-clipped rendered geometry, which fixes the
 * documented long-shot clip edge case in `queryNearestShotPoint`.
 *
 * The resolver also mirrors the reference-visibility filters the hitbox
 * layers apply (`isReference` shots / `allShotsReference` stations), so
 * hidden reference legs stay non-interactive.
 */
import type { GpsOrigin } from '../../../types/config';
import type { StationRef } from '../../../types/project';
import {
  type SurveyData,
  type SectionMetadata,
  SHOT_FLAG_IS_REFERENCE,
  STATION_FLAG_IS_ZERO_DATUM,
} from '../../../types/survey-data';
import { metersToMapCoords } from '../../../utils/coordinates';
import { distanceToLineSegment, projectParamOnSegment } from './hitTest';

/** Screen projection: [lng, lat] -> pixel coords. Wraps `map.project`. */
export type ProjectFn = (lngLat: [number, number]) => { x: number; y: number };

export interface NearestStationHit {
  ref: StationRef;
  /** Screen-space distance to the station center, px. */
  distance: number;
  /** The station's map coordinates. */
  lngLat: [number, number];
}

export interface NearestShotHit {
  sectionId: number;
  shotId: number;
  /** Screen-space distance to the segment, px. */
  distance: number;
  /** Fractional position of the projected point along the shot (0..1). */
  t: number;
  /** True (unclipped) shot endpoints in map coordinates. */
  from: [lng: number, lat: number];
  to: [lng: number, lat: number];
}

export interface ResolveOptions {
  /** Mirror of the reference-shots visibility toggle: when false, reference
   *  shots and all-reference stations are skipped (they are filtered out of
   *  the hitbox layers and must stay non-interactive). */
  includeReference: boolean;
}

export class SurveyGeometryIndex {
  private readonly data: SurveyData;
  private readonly gpsOrigin: GpsOrigin | null;

  // Lazily built (first query) so update() flushes stay cheap.
  private built = false;
  private sectionById = new Map<number, SectionMetadata>();
  /** sectionId -> global station indices (iteration order). */
  private sectionStationIdxs = new Map<number, number[]>();
  /** sectionId -> (stationIndex -> global station index). */
  private stationLookup = new Map<number, Map<number, number>>();
  /** Per-section cache: stationIndex values that touch >=1 non-reference shot
   *  (both endpoints present — mirrors the builder's feature-emission guard). */
  private nonRefStationCache = new Map<number, Set<number>>();
  /** sectionId -> world-coord (map coords) AABB over its stations. Lazily built
   *  by {@link ensureBounds} the first time the candidate-section gate runs. */
  private sectionBounds = new Map<
    number,
    { minLng: number; minLat: number; maxLng: number; maxLat: number }
  >();
  private boundsBuilt = false;

  constructor(data: SurveyData, gpsOrigin: GpsOrigin | null) {
    this.data = data;
    this.gpsOrigin = gpsOrigin;
  }

  private ensureBuilt(): void {
    if (this.built) return;
    this.built = true;
    for (const s of this.data.sections) this.sectionById.set(s.id, s);
    for (let g = 0; g < this.data.stationCount; g++) {
      const sid = this.data.stationSectionIds[g]!;
      let idxs = this.sectionStationIdxs.get(sid);
      if (!idxs) {
        idxs = [];
        this.sectionStationIdxs.set(sid, idxs);
      }
      idxs.push(g);
      let inner = this.stationLookup.get(sid);
      if (!inner) {
        inner = new Map();
        this.stationLookup.set(sid, inner);
      }
      inner.set(this.data.stationIndices[g]!, g);
    }
  }

  /**
   * Build the per-section world-coord bounding boxes used by
   * {@link sectionsIntersectingBox}. Kept separate from + lazier than
   * {@link ensureBuilt}: only the candidate-section gate needs projected bounds,
   * so the per-item resolvers must not pay this pass. One metersToMapCoords per
   * station, on the first gate query only.
   */
  private ensureBounds(): void {
    if (this.boundsBuilt) return;
    this.boundsBuilt = true;
    for (let g = 0; g < this.data.stationCount; g++) {
      const sid = this.data.stationSectionIds[g]!;
      const [lng, lat] = this.stationLngLat(g);
      const b = this.sectionBounds.get(sid);
      if (!b) {
        this.sectionBounds.set(sid, { minLng: lng, minLat: lat, maxLng: lng, maxLat: lat });
        continue;
      }
      if (lng < b.minLng) b.minLng = lng;
      if (lng > b.maxLng) b.maxLng = lng;
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
    }
  }

  /** Station map coords for a global index. */
  private stationLngLat(g: number): [number, number] {
    const base = g * 3;
    return metersToMapCoords(
      this.data.stationCoords[base]!,
      this.data.stationCoords[base + 1]!,
      this.gpsOrigin,
    );
  }

  /** The set of stationIndex values in `sectionId` that are an endpoint of at
   *  least one non-reference shot (with both endpoints present). Mirrors the
   *  builder's `stationsWithNonReferenceShot` semantics per section. */
  private nonRefStations(sectionId: number): Set<number> {
    let cached = this.nonRefStationCache.get(sectionId);
    if (cached) return cached;
    cached = new Set<number>();
    const section = this.sectionById.get(sectionId);
    const lookup = this.stationLookup.get(sectionId);
    if (section && lookup) {
      for (let i = 0; i < section.shotCount; i++) {
        const shotGlobalIdx = section.shotOffset + i;
        if ((this.data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0) continue;
        if (lookup.get(i) === undefined || lookup.get(i + 1) === undefined) continue;
        cached.add(i);
        cached.add(i + 1);
      }
    }
    this.nonRefStationCache.set(sectionId, cached);
    return cached;
  }

  /**
   * Nearest station (screen space) among the candidate sections, within
   * `maxDistance` px of (px, py). Returns null if none qualifies.
   */
  nearestStation(
    project: ProjectFn,
    px: number,
    py: number,
    sectionIds: Iterable<number>,
    maxDistance: number,
    opts: ResolveOptions,
  ): NearestStationHit | null {
    this.ensureBuilt();
    let best: NearestStationHit | null = null;
    for (const sid of sectionIds) {
      const idxs = this.sectionStationIdxs.get(sid);
      if (!idxs) continue;
      const visibleIdxs = opts.includeReference ? null : this.nonRefStations(sid);
      for (const g of idxs) {
        if (visibleIdxs && !visibleIdxs.has(this.data.stationIndices[g]!)) continue;
        const lngLat = this.stationLngLat(g);
        const p = project(lngLat);
        const dist = Math.hypot(p.x - px, p.y - py);
        if (dist <= maxDistance && (!best || dist < best.distance)) {
          best = {
            ref: { section_id: sid, station_index: this.data.stationIndices[g]! },
            distance: dist,
            lngLat,
          };
        }
      }
    }
    return best;
  }

  /**
   * Nearest shot segment (screen space) among the candidate sections, within
   * `maxDistance` px of (px, py). Returns null if none qualifies.
   */
  nearestShot(
    project: ProjectFn,
    px: number,
    py: number,
    sectionIds: Iterable<number>,
    maxDistance: number,
    opts: ResolveOptions,
  ): NearestShotHit | null {
    this.ensureBuilt();
    let best: NearestShotHit | null = null;
    for (const sid of sectionIds) {
      const section = this.sectionById.get(sid);
      const lookup = this.stationLookup.get(sid);
      if (!section || !lookup) continue;
      for (let i = 0; i < section.shotCount; i++) {
        const shotGlobalIdx = section.shotOffset + i;
        const isReference =
          (this.data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0;
        if (isReference && !opts.includeReference) continue;
        const fromGlobal = lookup.get(i);
        const toGlobal = lookup.get(i + 1);
        if (fromGlobal === undefined || toGlobal === undefined) continue;
        const from = this.stationLngLat(fromGlobal);
        const to = this.stationLngLat(toGlobal);
        const p1 = project(from);
        const p2 = project(to);
        const dist = distanceToLineSegment(px, py, p1.x, p1.y, p2.x, p2.y);
        if (dist <= maxDistance && (!best || dist < best.distance)) {
          best = {
            sectionId: sid,
            shotId: this.data.shotIds[shotGlobalIdx]!,
            distance: dist,
            t: projectParamOnSegment(px, py, p1.x, p1.y, p2.x, p2.y),
            from,
            to,
          };
        }
      }
    }
    return best;
  }

  /**
   * All stations of the candidate sections whose rendered hit circle
   * (center +/- `radius` px) intersects the screen-space box. Matches the old
   * `queryRenderedFeatures(bbox)` box-select semantics (a circle is returned
   * when any of its pixels intersects the box).
   */
  stationsInBox(
    project: ProjectFn,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    sectionIds: Iterable<number>,
    radius: number,
    opts: ResolveOptions,
  ): StationRef[] {
    this.ensureBuilt();
    const out: StationRef[] = [];
    for (const sid of sectionIds) {
      const idxs = this.sectionStationIdxs.get(sid);
      if (!idxs) continue;
      const visibleIdxs = opts.includeReference ? null : this.nonRefStations(sid);
      for (const g of idxs) {
        if (visibleIdxs && !visibleIdxs.has(this.data.stationIndices[g]!)) continue;
        const p = project(this.stationLngLat(g));
        // Circle-rectangle intersection: clamp the center to the box, then
        // compare the residual distance to the radius.
        const cx = Math.min(Math.max(p.x, minX), maxX);
        const cy = Math.min(Math.max(p.y, minY), maxY);
        if (Math.hypot(p.x - cx, p.y - cy) <= radius) {
          out.push({ section_id: sid, station_index: this.data.stationIndices[g]! });
        }
      }
    }
    return out;
  }

  /**
   * Sections whose geometry may intersect the screen-space box
   * `[minX, minY, maxX, maxY]` (already padded by the caller to the type's hit
   * reach). Replaces the old `queryRenderedFeatures` candidate-section prefilter
   * (#customRender): once the custom WebGL layer renders the survey, the stock
   * shots/stations layers are hidden (visibility:none) and return nothing from
   * `queryRenderedFeatures`, so candidate discovery must come from the SoA index
   * rather than rendered features.
   *
   * Each section's world-coord AABB is projected corner by corner; the screen
   * AABB of those four corners is a conservative SUPERSET of the section's
   * projected footprint (exact under the app's unrotated top-down projection,
   * a safe over-approximation under any affine map transform). A section is a
   * candidate iff that screen AABB overlaps the probe box. The result is a
   * superset — the per-item resolvers ({@link nearestStation} /
   * {@link nearestShot} / {@link stationsInBox}) then trim to exact tolerance,
   * so no in-tolerance hit is dropped and none leaks past it.
   */
  sectionsIntersectingBox(
    project: ProjectFn,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): Set<number> {
    this.ensureBounds();
    const out = new Set<number>();
    for (const [sid, b] of this.sectionBounds) {
      const p1 = project([b.minLng, b.minLat]);
      const p2 = project([b.minLng, b.maxLat]);
      const p3 = project([b.maxLng, b.minLat]);
      const p4 = project([b.maxLng, b.maxLat]);
      const sMinX = Math.min(p1.x, p2.x, p3.x, p4.x);
      const sMaxX = Math.max(p1.x, p2.x, p3.x, p4.x);
      const sMinY = Math.min(p1.y, p2.y, p3.y, p4.y);
      const sMaxY = Math.max(p1.y, p2.y, p3.y, p4.y);
      if (sMaxX >= minX && sMinX <= maxX && sMaxY >= minY && sMinY <= maxY) {
        out.add(sid);
      }
    }
    return out;
  }

  /** Map coords of one station by ref, or null if unknown. Used by the
   *  interact overlay to place individual highlight features. */
  stationCoords(ref: StationRef): [number, number] | null {
    this.ensureBuilt();
    const g = this.stationLookup.get(ref.section_id)?.get(ref.station_index);
    return g === undefined ? null : this.stationLngLat(g);
  }

  /** Global station index by ref, or null. */
  stationGlobalIndex(ref: StationRef): number | null {
    this.ensureBuilt();
    const g = this.stationLookup.get(ref.section_id)?.get(ref.station_index);
    return g === undefined ? null : g;
  }

  /**
   * Endpoints + global index of one shot by (sectionId, shotId), or null.
   * Used by the interact overlay to draw individual shot highlights.
   */
  shotGeometry(
    sectionId: number,
    shotId: number,
  ): { from: [number, number]; to: [number, number]; globalIdx: number; isReference: boolean } | null {
    this.ensureBuilt();
    const section = this.sectionById.get(sectionId);
    const lookup = this.stationLookup.get(sectionId);
    if (!section || !lookup) return null;
    for (let i = 0; i < section.shotCount; i++) {
      const shotGlobalIdx = section.shotOffset + i;
      if (this.data.shotIds[shotGlobalIdx] !== shotId) continue;
      const fromGlobal = lookup.get(i);
      const toGlobal = lookup.get(i + 1);
      if (fromGlobal === undefined || toGlobal === undefined) return null;
      return {
        from: this.stationLngLat(fromGlobal),
        to: this.stationLngLat(toGlobal),
        globalIdx: shotGlobalIdx,
        isReference: (this.data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0,
      };
    }
    return null;
  }

  /** Whether every shot touching the station is a reference shot (the
   *  station is filtered out while reference shots are hidden). Stations
   *  with no feature-producing shots at all also count as all-reference,
   *  mirroring the builder's `allShotsReference` property. */
  isAllReferenceStation(ref: StationRef): boolean {
    this.ensureBuilt();
    return !this.nonRefStations(ref.section_id).has(ref.station_index);
  }

  /** Section metadata by id (color lookup for overlay styling). */
  section(sectionId: number): SectionMetadata | undefined {
    this.ensureBuilt();
    return this.sectionById.get(sectionId);
  }

  /** Whether the station is a zero-datum station. */
  isZeroDatum(ref: StationRef): boolean {
    const g = this.stationGlobalIndex(ref);
    if (g === null) return false;
    return (this.data.stationFlags[g]! & STATION_FLAG_IS_ZERO_DATUM) !== 0;
  }
}
