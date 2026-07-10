/**
 * Tests for GlobalSurveyLayer's feature construction + vector-tile conversion
 * (#mem). GlobalSurveyLayer serves its bulk geometry as two on-demand vt
 * sources (line shots + point stations) instead of one bulk GeoJSON source;
 * these tests pin the shot/station split and that each set converts to a
 * non-empty VtLayerData whose scalar props survive.
 */
import { describe, it, expect } from 'vitest';
import { buildGlobalSurveyFeatures, type SystemGeometry } from '../GlobalSurveyLayer';
import type { ProjectMetadata } from '../../../types/project';
import type { GeometryShot, SurveyGeometry } from '../../../types/survey';
import {
  vtLinesFromFeatures,
  vtPointsFromFeatures,
  vtGroupCount,
  cutTile,
} from '../../Map/surveyLayer/vectorTileData';

function shot(
  from: [number, number],
  to: [number, number],
  isReference = false,
): GeometryShot {
  return { from, to, is_reference: isReference, section_id: 0 };
}

function makeSystem(filePath: string, shots: GeometryShot[]): SystemGeometry {
  const metadata: ProjectMetadata = {
    name: `name-${filePath}`,
    location: null,
    file_path: filePath,
    modified_at: '2026-01-01T00:00:00Z',
    section_count: 1,
    total_length: 1234.5,
    station_count: 42,
    gps_center: [0, 0],
    gps_bounds: null,
    collab_enabled: false,
    is_remote: false,
  };
  const geometry: SurveyGeometry = { shots, origin: [0, 0] };
  return { metadata, geometry };
}

// System A: 2 non-reference shots -> 2 shot features, 3 unique stations.
// Whole-degree spans so segments survive tile-pixel rounding at any zoom.
const systemA = makeSystem('a.tml', [
  shot([0, 0], [1, 0]),
  shot([1, 0], [2, 0]),
]);

// System B: 1 non-reference + 1 reference shot -> 2 shot features, 3 stations.
// The far station only connects to the reference shot (allShotsReference).
const systemB = makeSystem('b.tml', [
  shot([10, 10], [11, 10]),
  shot([11, 10], [12, 10], true),
]);

describe('buildGlobalSurveyFeatures', () => {
  it('splits systems into shot LineStrings and station Points', () => {
    const { shots, stations } = buildGlobalSurveyFeatures([systemA, systemB]);

    // 2 + 2 shot lines, 3 + 3 unique station points.
    expect(shots).toHaveLength(4);
    expect(stations).toHaveLength(6);

    // Shots are LineStrings tagged featureType 'shot'.
    for (const f of shots) {
      expect(f.geometry.type).toBe('LineString');
      expect(f.properties?.featureType).toBe('shot');
      expect(typeof f.properties?.systemId).toBe('string');
    }
    // Stations are Points tagged featureType 'station'.
    for (const f of stations) {
      expect(f.geometry.type).toBe('Point');
      expect(f.properties?.featureType).toBe('station');
      expect(typeof f.properties?.systemId).toBe('string');
    }
  });

  it('preserves per-system systemId and reference flags', () => {
    const { shots, stations } = buildGlobalSurveyFeatures([systemA, systemB]);

    // systemId partitions the features by project.
    expect(shots.filter((f) => f.properties?.systemId === 'a.tml')).toHaveLength(2);
    expect(shots.filter((f) => f.properties?.systemId === 'b.tml')).toHaveLength(2);

    // Exactly one reference shot, exactly one reference-only station.
    expect(shots.filter((f) => f.properties?.isReference === true)).toHaveLength(1);
    expect(
      stations.filter((f) => f.properties?.allShotsReference === true),
    ).toHaveLength(1);

    // Metadata scalars carried onto every feature (drive the tooltip).
    for (const f of [...shots, ...stations]) {
      expect(f.properties?.name).toMatch(/^name-/);
      expect(typeof f.properties?.totalLength).toBe('number');
      expect(typeof f.properties?.stationCount).toBe('number');
    }
  });
});

describe('GlobalSurveyLayer vt conversion (update path)', () => {
  it('converts the split into non-empty line + point VtLayerData', () => {
    const { shots, stations } = buildGlobalSurveyFeatures([systemA, systemB]);

    const shotsVt = vtLinesFromFeatures(shots);
    const stationsVt = vtPointsFromFeatures(stations);

    expect(shotsVt.kind).toBe('line');
    expect(stationsVt.kind).toBe('point');
    expect(vtGroupCount(shotsVt)).toBe(4);
    expect(vtGroupCount(stationsVt)).toBe(6);

    // The scalar props the color/opacity/visual expressions read survive as
    // MVT tags (strings + booleans preserved, nothing dropped as non-scalar).
    expect(typeof shotsVt.props[0]?.systemId).toBe('string');
    expect(typeof shotsVt.props[0]?.isReference).toBe('boolean');
    expect(typeof stationsVt.props[0]?.systemId).toBe('string');
    expect(typeof stationsVt.props[0]?.allShotsReference).toBe('boolean');
  });

  it('cuts a non-empty MVT tile from the shot payload at z=0', () => {
    const { shots } = buildGlobalSurveyFeatures([systemA, systemB]);
    const shotsVt = vtLinesFromFeatures(shots);
    // The whole world is one tile at z=0; all geometry lands inside it.
    const bytes = cutTile(shotsVt, 0, 0, 0);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBeGreaterThan(0);
  });
});
