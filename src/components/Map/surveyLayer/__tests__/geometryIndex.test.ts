/**
 * Hit-test equivalence tests (#mem).
 *
 * The merged-feature sources can no longer resolve per-item hits from feature
 * properties, so `SurveyGeometryIndex` re-derives them from the SoA
 * `SurveyData`. These tests prove the new resolver picks the SAME station /
 * shot as the old per-feature path (`resolveNearestStation` /
 * `resolveNearestShot` over per-feature build output) for a grid of probe
 * points, with the same tolerances.
 */
import { describe, expect, it } from 'vitest';
import type { Map as MaplibreMap, MapMouseEvent, MapGeoJSONFeature } from 'maplibre-gl';
import { buildSurveyFeatures } from '../features';
import { resolveNearestShot, resolveNearestStation } from '../hitTest';
import { SurveyGeometryIndex } from '../geometryIndex';
import { surveyDataFromLegacy } from '../../../../types/survey-data';
import { getMapThemeColors } from '../../../../utils/themeColors';
import type { Section } from '../../../../types/ipc/Section';
import type { Station } from '../../../../types/ipc/Station';

const theme = getMapThemeColors();

/** Deterministic screen projection for tests: 1 degree = 100000 px, y down. */
const SCALE = 100000;
const project = (lngLat: [number, number]) => ({
  x: lngLat[0] * SCALE,
  y: -lngLat[1] * SCALE,
});
const fakeMap = { project: (c: [number, number]) => project(c) } as unknown as MaplibreMap;
const eventAt = (x: number, y: number) => ({ point: { x, y } }) as MapMouseEvent;

function fixture(): { sections: Section[]; stations: Station[] } {
  const shot = (id: number, is_reference = false) => ({
    id,
    azimuth_in: 0,
    azimuth_out: 0,
    length: 10,
    depth_in: 0,
    depth_out: 0,
    pitch_in: null,
    pitch_out: null,
    left: null,
    right: null,
    up: null,
    down: null,
    comment: null,
    is_reference,
    marker_index: null,
    temperature: null,
  });
  // Two sections crossing near the origin plus a reference spur, so probe
  // points have competing candidates from different sections.
  const sections: Section[] = [
    {
      id: 1, name: 'A', surveyor: null, date: null, color: '#ff0000',
      direction: 'in', quality: 1, next_shot_id: 10,
      shots: [shot(101), shot(102), shot(103, true)],
    },
    {
      id: 2, name: 'B', surveyor: null, date: null, color: '#00ff00',
      direction: 'in', quality: 1, next_shot_id: 10,
      shots: [shot(201), shot(202)],
    },
  ];
  const st = (section_id: number, station_index: number, x: number, y: number): Station => ({
    station_ref: { section_id, station_index },
    coordinates: { x, y, z: 0 },
    is_zero_datum: false,
    gps_coordinates: null,
    merged_with: [],
    closures_with: [],
  });
  const stations: Station[] = [
    st(1, 0, 0, 0),
    st(1, 1, 30, 0),
    st(1, 2, 30, 25),
    st(1, 3, 60, 25), // reference-shot endpoint
    st(2, 0, 5, 20),
    st(2, 1, 25, -10),
    st(2, 2, 55, -10),
  ];
  return { sections, stations };
}

function buildPerFeature() {
  const { sections, stations } = fixture();
  const data = surveyDataFromLegacy(sections, stations);
  const sets = buildSurveyFeatures(
    data, undefined, null, false, { min: 0, max: 10 }, theme, undefined,
    { mergeFeatures: false, buildLabels: false },
  );
  return { data, sets };
}

/** Wrap a built GeoJSON feature as the minimal MapGeoJSONFeature shape the
 *  old resolvers consumed. */
function asRendered(f: GeoJSON.Feature): MapGeoJSONFeature {
  return { geometry: f.geometry, properties: f.properties } as unknown as MapGeoJSONFeature;
}

/** Probe grid covering the fixture extent (in px). */
function probeGrid(): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  // Fixture spans roughly x 0..60 m, y -10..25 m; meters/deg = 111320 so px
  // ~ m * (SCALE / 111320) ~ m * 0.898. Probe a dense grid over that region.
  for (let mx = -5; mx <= 65; mx += 2.5) {
    for (let my = -15; my <= 30; my += 2.5) {
      points.push({ x: (mx / 111320) * SCALE, y: -(my / 111320) * SCALE });
    }
  }
  return points;
}

describe('SurveyGeometryIndex equivalence with per-feature resolvers', () => {
  const { data, sets } = buildPerFeature();
  const index = new SurveyGeometryIndex(data, null);
  const allSectionIds = [1, 2];
  const stationHitArea = 10;
  const shotHitArea = 8;

  const stationFeatures = sets.stationFeatures.map(asRendered);
  const shotFeatures = sets.shotFeatures.map(asRendered);

  it('nearest station matches the old resolver across the probe grid', () => {
    let hits = 0;
    for (const p of probeGrid()) {
      // Old path: candidates = features whose rendered circle contains the
      // cursor (radius = hit area), i.e. distance <= stationHitArea.
      const oldCandidates = stationFeatures.filter((f) => {
        const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        const s = project(c);
        return Math.hypot(s.x - p.x, s.y - p.y) <= stationHitArea;
      });
      const oldPick = resolveNearestStation(fakeMap, eventAt(p.x, p.y), oldCandidates, stationHitArea);
      const newPick = index.nearestStation(
        (c) => project(c), p.x, p.y, allSectionIds, stationHitArea, { includeReference: true },
      );
      if (oldPick) {
        hits++;
        expect(newPick).not.toBeNull();
        expect(newPick!.ref.section_id).toBe(oldPick.properties!.sectionId);
        expect(newPick!.ref.station_index).toBe(oldPick.properties!.stationIndex);
      } else {
        expect(newPick).toBeNull();
      }
    }
    expect(hits).toBeGreaterThan(0); // the grid actually exercised hits
  });

  it('nearest shot matches the old resolver across the probe grid', () => {
    let hits = 0;
    for (const p of probeGrid()) {
      // Old path: candidates = features within half the rendered line width
      // of the cursor (MapLibre's line hit test), then nearest-of-candidates.
      const oldCandidates = shotFeatures.filter((f) => {
        const coords = (f.geometry as GeoJSON.LineString).coordinates as [number, number][];
        const a = project(coords[0]!);
        const b = project(coords[1]!);
        const t = Math.max(0, Math.min(1,
          ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) /
          (((b.x - a.x) ** 2 + (b.y - a.y) ** 2) || 1)));
        const qx = a.x + t * (b.x - a.x);
        const qy = a.y + t * (b.y - a.y);
        return Math.hypot(p.x - qx, p.y - qy) <= shotHitArea / 2;
      });
      const oldPick = resolveNearestShot(fakeMap, eventAt(p.x, p.y), oldCandidates, shotHitArea);
      const newPick = index.nearestShot(
        (c) => project(c), p.x, p.y, allSectionIds, shotHitArea, { includeReference: true },
      );
      if (oldPick) {
        hits++;
        expect(newPick).not.toBeNull();
        expect(newPick!.sectionId).toBe(oldPick.properties!.sectionId);
        expect(newPick!.shotId).toBe(oldPick.properties!.shotId);
      } else if (newPick) {
        // The rendered gate (half line width) is narrower than the resolver
        // ceiling (full hit area): the resolver may hit where the old query
        // returned nothing only OUTSIDE the rendered gate.
        expect(newPick.distance).toBeGreaterThan(shotHitArea / 2);
      }
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('reference filtering hides reference shots and all-reference stations', () => {
    // Probe directly on the reference shot (section 1, shot 103: (30,25)-(60,25)).
    const px = (45 / 111320) * SCALE;
    const py = -(25 / 111320) * SCALE;
    const withRef = index.nearestShot((c) => project(c), px, py, allSectionIds, 8, { includeReference: true });
    expect(withRef?.shotId).toBe(103);
    const withoutRef = index.nearestShot((c) => project(c), px, py, allSectionIds, 8, { includeReference: false });
    expect(withoutRef?.shotId).not.toBe(103);
    // Station (1,3) only touches the reference shot -> hidden when refs are.
    const stPx = (60 / 111320) * SCALE;
    const stPy = -(25 / 111320) * SCALE;
    const stWith = index.nearestStation((c) => project(c), stPx, stPy, allSectionIds, 10, { includeReference: true });
    expect(stWith?.ref).toEqual({ section_id: 1, station_index: 3 });
    const stWithout = index.nearestStation((c) => project(c), stPx, stPy, allSectionIds, 10, { includeReference: false });
    expect(stWithout?.ref).not.toEqual({ section_id: 1, station_index: 3 });
  });

  it('t parameter matches projectParamOnSegment on the true endpoints', () => {
    // Probe near the midpoint of shot 101 ((0,0)-(30,0)).
    const px = (12 / 111320) * SCALE;
    const py = -(1 / 111320) * SCALE;
    const hit = index.nearestShot((c) => project(c), px, py, [1], 8, { includeReference: true })!;
    expect(hit.shotId).toBe(101);
    expect(hit.t).toBeCloseTo(12 / 30, 3);
    expect(hit.from[0]).toBeCloseTo(0, 9);
    expect(hit.to[0]).toBeCloseTo(30 / 111320, 9);
  });

  it('stationsInBox matches circle-box intersection semantics', () => {
    // Box around stations (1,0) and (2,0): x -2..7 m, y -2..21 m.
    const minX = (-2 / 111320) * SCALE;
    const maxX = (7 / 111320) * SCALE;
    const minY = -(21 / 111320) * SCALE;
    const maxY = (2 / 111320) * SCALE;
    const refs = index.stationsInBox(
      (c) => project(c), minX, minY, maxX, maxY, allSectionIds, 10, { includeReference: true },
    );
    const keys = refs.map((r) => `${r.section_id}:${r.station_index}`).sort();
    expect(keys).toContain('1:0');
    expect(keys).toContain('2:0');
    expect(keys).not.toContain('1:2');
    // A station just OUTSIDE the box but within the hit radius intersects:
    // station (2,1) at (25,-10) m is far away -> not included.
    expect(keys).not.toContain('2:1');
  });

  it('shotGeometry / stationCoords resolve overlay geometry', () => {
    const g = index.shotGeometry(1, 102)!;
    expect(g.from[0]).toBeCloseTo(30 / 111320, 9);
    expect(g.to[1]).toBeCloseTo(25 / 111320, 9);
    expect(g.isReference).toBe(false);
    const ref = index.stationCoords({ section_id: 2, station_index: 2 })!;
    expect(ref[0]).toBeCloseTo(55 / 111320, 9);
    expect(index.stationCoords({ section_id: 9, station_index: 0 })).toBeNull();
    expect(index.isZeroDatum({ section_id: 1, station_index: 0 })).toBe(false);
  });
});
