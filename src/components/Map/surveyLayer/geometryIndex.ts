/**
 * Screen-space hit-test resolver over the SoA `SurveyData` (#mem).
 *
 * With merged shot/station features (see `features.ts` `mergeFeatures`), the
 * rendered hitbox layers can only tell us WHICH GROUPS (sections) are under
 * the cursor - the per-item identity (`shotId` / `stationIndex`) is no longer
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
 * it lies within the rendered hit area too - and every item within the
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
  isVirtualKind,
  shotKindFromFlags,
  STATION_FLAG_IS_ZERO_DATUM,
} from '../../../types/survey-data';
import { metersToMapCoords } from '../../../utils/coordinates';
import { encodeFeatureId } from '../../../utils/ids';
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

/**
 * Which virtual shot kinds are currently drawn (#27). Hit-testing must agree
 * with what is on screen, so a hidden kind is also non-interactive.
 */
export interface VisibleKinds {
  jump: boolean;
  reference: boolean;
}

/** True when a shot of this kind is currently drawn. */
export function isKindVisible(flags: number, visible: VisibleKinds): boolean {
  const kind = shotKindFromFlags(flags);
  if (kind === 'Jump') return visible.jump;
  if (kind === 'Reference') return visible.reference;
  return true;
}

/**
 * A station touched only by virtual shots stays visible while EITHER kind is
 * drawn, matching the circle shader's `u_hide_reference && u_hide_jump` test.
 * Conservative on purpose: a station never vanishes while one of its legs shows.
 */
export function anyVirtualVisible(visible: VisibleKinds): boolean {
  return visible.jump || visible.reference;
}

export interface ResolveOptions {
  /** Mirror of the per-kind visibility toggles: a hidden kind's shots (and
   *  stations touched only by hidden kinds) are skipped, since they are
   *  filtered out of the hitbox layers and must stay non-interactive. */
  visibleKinds: VisibleKinds;
}

/**
 * Cheap snapshot of the map camera for {@link SurveyGeometryIndex.sectionsIntersectingBox}'s
 * projected-AABB cache. `key` is any stable string that changes iff `project`
 * would map a given lng/lat to a different pixel (zoom / center / bearing /
 * pitch / viewport). `axisAligned` is true when the projection preserves axis
 * order (bearing 0 and pitch 0), which lets the reprojection use only the two
 * diagonal AABB corners instead of all four - exact under a top-down mercator
 * view, so the conservative-superset contract is unchanged. Omit the snapshot
 * to force a full 4-corner reprojection every call (the legacy behavior).
 */
export interface CameraSnapshot {
  key: string;
  axisAligned: boolean;
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
   *  (both endpoints present - mirrors the builder's feature-emission guard). */
  private nonRefStationCache = new Map<number, Set<number>>();
  /** Per-section world-coord (map coords) AABB over its stations, stored as flat
   *  parallel arrays (index 0..boundsCount-1) for cache-friendly projection.
   *  Lazily built by {@link ensureBounds} the first time the gate runs. */
  private boundsSid: Int32Array = new Int32Array(0);
  private boundsMinLng: Float64Array = new Float64Array(0);
  private boundsMinLat: Float64Array = new Float64Array(0);
  private boundsMaxLng: Float64Array = new Float64Array(0);
  private boundsMaxLat: Float64Array = new Float64Array(0);
  private boundsCount = 0;
  private boundsBuilt = false;
  /** Projected screen-space AABB per section (parallel to the bounds arrays),
   *  reused across probes of the SAME camera. {@link sectionsIntersectingBox}
   *  reprojects only when the caller's camera key changes - during hover the
   *  camera is static, so every probe after the first is pure AABB overlap. */
  private projMinX: Float32Array = new Float32Array(0);
  private projMinY: Float32Array = new Float32Array(0);
  private projMaxX: Float32Array = new Float32Array(0);
  private projMaxY: Float32Array = new Float32Array(0);
  private cachedCameraKey: string | null = null;

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
    // Accumulate per-section AABBs in a Map, then flatten to parallel arrays.
    const acc = new Map<
      number,
      { minLng: number; minLat: number; maxLng: number; maxLat: number }
    >();
    for (let g = 0; g < this.data.stationCount; g++) {
      const sid = this.data.stationSectionIds[g]!;
      const [lng, lat] = this.stationLngLat(g);
      const b = acc.get(sid);
      if (!b) {
        acc.set(sid, { minLng: lng, minLat: lat, maxLng: lng, maxLat: lat });
        continue;
      }
      if (lng < b.minLng) b.minLng = lng;
      if (lng > b.maxLng) b.maxLng = lng;
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
    }
    const n = acc.size;
    this.boundsCount = n;
    this.boundsSid = new Int32Array(n);
    this.boundsMinLng = new Float64Array(n);
    this.boundsMinLat = new Float64Array(n);
    this.boundsMaxLng = new Float64Array(n);
    this.boundsMaxLat = new Float64Array(n);
    this.projMinX = new Float32Array(n);
    this.projMinY = new Float32Array(n);
    this.projMaxX = new Float32Array(n);
    this.projMaxY = new Float32Array(n);
    let i = 0;
    for (const [sid, b] of acc) {
      this.boundsSid[i] = sid;
      this.boundsMinLng[i] = b.minLng;
      this.boundsMinLat[i] = b.minLat;
      this.boundsMaxLng[i] = b.maxLng;
      this.boundsMaxLat[i] = b.maxLat;
      i++;
    }
    // Force a reprojection on the first query (no camera key matches null yet).
    this.cachedCameraKey = null;
  }

  /**
   * Reproject every section's world-coord AABB into the screen-space cache.
   * With `axisAligned` (bearing 0, pitch 0) the projection preserves axis order,
   * so the two diagonal corners bound the footprint exactly; otherwise all four
   * corners are projected to keep the superset conservative under an affine map.
   */
  private projectBounds(project: ProjectFn, axisAligned: boolean): void {
    for (let i = 0; i < this.boundsCount; i++) {
      const minLng = this.boundsMinLng[i]!;
      const minLat = this.boundsMinLat[i]!;
      const maxLng = this.boundsMaxLng[i]!;
      const maxLat = this.boundsMaxLat[i]!;
      if (axisAligned) {
        const p1 = project([minLng, minLat]);
        const p2 = project([maxLng, maxLat]);
        this.projMinX[i] = Math.min(p1.x, p2.x);
        this.projMaxX[i] = Math.max(p1.x, p2.x);
        this.projMinY[i] = Math.min(p1.y, p2.y);
        this.projMaxY[i] = Math.max(p1.y, p2.y);
      } else {
        const p1 = project([minLng, minLat]);
        const p2 = project([minLng, maxLat]);
        const p3 = project([maxLng, minLat]);
        const p4 = project([maxLng, maxLat]);
        this.projMinX[i] = Math.min(p1.x, p2.x, p3.x, p4.x);
        this.projMaxX[i] = Math.max(p1.x, p2.x, p3.x, p4.x);
        this.projMinY[i] = Math.min(p1.y, p2.y, p3.y, p4.y);
        this.projMaxY[i] = Math.max(p1.y, p2.y, p3.y, p4.y);
      }
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
        if (isVirtualKind(shotKindFromFlags(this.data.shotFlags[shotGlobalIdx]!))) continue;
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
      const visibleIdxs = anyVirtualVisible(opts.visibleKinds) ? null : this.nonRefStations(sid);
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
        if (!isKindVisible(this.data.shotFlags[shotGlobalIdx]!, opts.visibleKinds)) continue;
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
      const visibleIdxs = anyVirtualVisible(opts.visibleKinds) ? null : this.nonRefStations(sid);
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
   * superset - the per-item resolvers ({@link nearestStation} /
   * {@link nearestShot} / {@link stationsInBox}) then trim to exact tolerance,
   * so no in-tolerance hit is dropped and none leaks past it.
   */
  sectionsIntersectingBox(
    project: ProjectFn,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    camera?: CameraSnapshot | null,
  ): Set<number> {
    this.ensureBounds();
    // Reproject the section AABBs only when the camera changed. Without a
    // snapshot (unit tests / legacy callers) reproject every call - same result,
    // just uncached. With a matching key, skip straight to the overlap test.
    if (!camera || camera.key !== this.cachedCameraKey) {
      this.projectBounds(project, camera?.axisAligned ?? false);
      this.cachedCameraKey = camera ? camera.key : null;
    }
    const out = new Set<number>();
    for (let i = 0; i < this.boundsCount; i++) {
      if (
        this.projMaxX[i]! >= minX &&
        this.projMinX[i]! <= maxX &&
        this.projMaxY[i]! >= minY &&
        this.projMinY[i]! <= maxY
      ) {
        out.add(this.boundsSid[i]!);
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
  ): {
    from: [number, number];
    to: [number, number];
    globalIdx: number;
    isReference: boolean;
    /** Raw flags byte, so callers can resolve the exact kind (#27). */
    kindFlags: number;
  } | null {
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
        isReference: isVirtualKind(shotKindFromFlags(this.data.shotFlags[shotGlobalIdx]!)),
        kindFlags: this.data.shotFlags[shotGlobalIdx]!,
      };
    }
    return null;
  }

  /**
   * Endpoints of every shot whose canonical feature id
   * (`encodeFeatureId(sectionId, shotId)`) is in `fids`. The measured along-line
   * path's shot tint (#26) resolves its segments through here.
   *
   * Membership is tested by RE-DERIVING each shot's fid the same way every
   * producer does (`colorResolvers` / distance + gas overlays / the interact
   * overlay), NOT by decoding the fid back to `(section, shot)`. Decoding is lossy
   * for shots: the scoped id folded into the fid is the GLOBAL shot id (already
   * `sectionId * FEATURE_ID_STRIDE + local`), so a `floor(fid / STRIDE)` split
   * mis-attributes every shot in section >= 1 to the wrong section and shot id,
   * dropping its tint. Re-deriving is exact regardless of the shot-id range.
   *
   * `visibleKinds` mirrors the per-kind toggles: legs of a hidden kind are
   * skipped, matching the interact overlay / measure-path filter.
   */
  measuredShotSegments(
    fids: ReadonlySet<number>,
    visibleKinds: VisibleKinds,
  ): Array<{ from: [number, number]; to: [number, number] }> {
    this.ensureBuilt();
    const out: Array<{ from: [number, number]; to: [number, number] }> = [];
    if (fids.size === 0) return out;
    for (const section of this.data.sections) {
      const lookup = this.stationLookup.get(section.id);
      if (!lookup) continue;
      for (let i = 0; i < section.shotCount; i++) {
        const gi = section.shotOffset + i;
        if (!fids.has(encodeFeatureId(section.id, this.data.shotIds[gi]!))) continue;
        if (!isKindVisible(this.data.shotFlags[gi]!, visibleKinds)) continue;
        const fromGlobal = lookup.get(i);
        const toGlobal = lookup.get(i + 1);
        if (fromGlobal === undefined || toGlobal === undefined) continue;
        out.push({ from: this.stationLngLat(fromGlobal), to: this.stationLngLat(toGlobal) });
      }
    }
    return out;
  }

  /**
   * Every station center and shot segment in MAP coords, with identities.
   *
   * The authoritative geometry enumeration for tests/tooling: with the custom
   * WebGL renderer there are no stock `survey-stations` / `survey-shots` layers
   * for `queryRenderedFeatures` to read, so an E2E test that needs on-screen
   * positions projects these instead (see MapCanvas's `__stalagmight_geometry__`
   * hook). Same source of truth the renderer and hit-testing use, so positions
   * agree with what is actually drawn.
   *
   * `visibleKinds` mirrors the per-kind toggles - shots of a hidden kind, and
   * stations touched only by hidden kinds, are omitted exactly as the layers
   * filter them.
   */
  enumerateGeometry(visibleKinds: VisibleKinds): {
    stations: Array<{ sectionId: number; stationIndex: number; lngLat: [number, number] }>;
    shots: Array<{
      sectionId: number;
      shotId: number;
      from: [number, number];
      to: [number, number];
    }>;
  } {
    this.ensureBuilt();
    const stations: Array<{ sectionId: number; stationIndex: number; lngLat: [number, number] }> = [];
    for (let g = 0; g < this.data.stationCount; g++) {
      const sectionId = this.data.stationSectionIds[g]!;
      const stationIndex = this.data.stationIndices[g]!;
      if (!anyVirtualVisible(visibleKinds) && !this.nonRefStations(sectionId).has(stationIndex)) continue;
      stations.push({ sectionId, stationIndex, lngLat: this.stationLngLat(g) });
    }
    const shots: Array<{
      sectionId: number;
      shotId: number;
      from: [number, number];
      to: [number, number];
    }> = [];
    for (const section of this.data.sections) {
      const lookup = this.stationLookup.get(section.id);
      if (!lookup) continue;
      for (let i = 0; i < section.shotCount; i++) {
        const gi = section.shotOffset + i;
        if (!isKindVisible(this.data.shotFlags[gi]!, visibleKinds)) continue;
        const fromGlobal = lookup.get(i);
        const toGlobal = lookup.get(i + 1);
        if (fromGlobal === undefined || toGlobal === undefined) continue;
        shots.push({
          sectionId: section.id,
          shotId: this.data.shotIds[gi]!,
          from: this.stationLngLat(fromGlobal),
          to: this.stationLngLat(toGlobal),
        });
      }
    }
    return { stations, shots };
  }

  /**
   * One section's stations (ordered by `station_index`) and shots, straight from
   * the SoA - map coords + the global indices the color resolvers need.
   *
   * This exists so the drag-preview capture never touches the lazy `Station[]`
   * proxy or the lazy `section.shots` getter. Doing `stations.filter(s => s.
   * station_ref.section_id === id)` per section materialized the WHOLE ~89k
   * station object graph once per section (quadratic, and on a 14k-section
   * project it pinned a core for minutes), and `shotGeometry()` per shot is a
   * linear scan over the section, so the pair was O(stations x sections) +
   * O(shots^2). Both are linear here.
   */
  sectionGeometry(sectionId: number): {
    stations: Array<{ stationIndex: number; lngLat: [number, number]; globalIdx: number }>;
    shots: Array<{
      /** Position in the section: joins station `index` to `index + 1`. NOT the
       *  array position - shots with a missing endpoint are skipped. */
      index: number;
      shotId: number;
      globalIdx: number;
      isReference: boolean;
      from: [number, number];
      to: [number, number];
    }>;
  } {
    this.ensureBuilt();
    const section = this.sectionById.get(sectionId);
    const lookup = this.stationLookup.get(sectionId);
    if (!section || !lookup) return { stations: [], shots: [] };

    const stations: Array<{ stationIndex: number; lngLat: [number, number]; globalIdx: number }> = [];
    for (const g of this.sectionStationIdxs.get(sectionId) ?? []) {
      stations.push({
        stationIndex: this.data.stationIndices[g]!,
        lngLat: this.stationLngLat(g),
        globalIdx: g,
      });
    }
    // The capture walks stations in station_index order (shot i joins station i
    // to i+1); SoA iteration order is global-index order, which normally matches
    // but is not guaranteed after edits.
    stations.sort((a, b) => a.stationIndex - b.stationIndex);

    const shots: Array<{
      index: number;
      shotId: number;
      globalIdx: number;
      isReference: boolean;
      from: [number, number];
      to: [number, number];
    }> = [];
    for (let i = 0; i < section.shotCount; i++) {
      const gi = section.shotOffset + i;
      const fromGlobal = lookup.get(i);
      const toGlobal = lookup.get(i + 1);
      if (fromGlobal === undefined || toGlobal === undefined) continue;
      shots.push({
        index: i,
        shotId: this.data.shotIds[gi]!,
        globalIdx: gi,
        isReference: isVirtualKind(shotKindFromFlags(this.data.shotFlags[gi]!)),
        from: this.stationLngLat(fromGlobal),
        to: this.stationLngLat(toGlobal),
      });
    }
    return { stations, shots };
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
