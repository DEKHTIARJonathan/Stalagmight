import { describe, expect, it } from 'vitest';
import type { Section, Shot, Station } from '../../types/project';
import { surveyDataFromLegacy, getShot } from '../../types/survey-data';
import { shotStationGlobals } from '../shotEndpoints';
import { SurveyGeometryIndex } from '../../components/Map/surveyLayer/geometryIndex';
import { buildLineBuffers, buildStationLookup } from '../../components/Map/surveyLayer/customRender/tessellate';
import { buildDistanceFeatureState } from '../distanceGradient';
import { encodeFeatureId } from '../ids';

function fixture() {
  const shot = (id: number, number: number, from_id: number | null): Shot => ({
    id, number, from_id, azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: 0, depth_out: 0,
    pitch_in: null, pitch_out: null, left: null, right: null, up: null, down: null,
    kind: 'Normal', marker_index: null, temperature: null, comment: null,
  });
  const sections = [
    { id: 1, shots: [shot(100000, 1, null), shot(100001, 2, 3)] },
    { id: 2, shots: [shot(200000, 3, 1)] },
  ].map(section => ({ name: 'Synthetic', surveyor: null, date: null, color: '#abcdef', direction: 'in', quality: 1, next_shot_id: 0, ...section })) as Section[];
  const refs = [
    { section_id: 1, station_index: 0 }, { section_id: 1, station_index: 1 },
    { section_id: 1, station_index: 2 }, { section_id: 1, station_index: 0x80000001 },
    { section_id: 2, station_index: 0 }, { section_id: 2, station_index: 1 },
  ];
  const xy = [[0, 0], [10, 0], [30, 10], [20, 10], [10, 0], [20, 10]];
  const stations: Station[] = refs.map((station_ref, index) => ({
    station_ref, coordinates: { x: xy[index]![0]!, y: xy[index]![1]!, z: 0 },
    is_zero_datum: false, gps_coordinates: null, merged_with: [],
  }));
  const data = surveyDataFromLegacy(sections, stations, {
    shot_from_ids: [null, 3, 1], shot_start_refs: [refs[0]!, refs[3]!, refs[4]!],
  });
  return { data, refs };
}

describe('directed shot endpoint consumers', () => {
  it('preserves From ID and independently indexed START endpoints in SoA data', () => {
    const { data } = fixture();
    expect(getShot(data, 0).from_id).toBeNull();
    expect(getShot(data, 1).from_id).toBe(3);
    expect(shotStationGlobals(data, data.sections[0]!, 1, buildStationLookup(data))).toEqual([3, 2]);
  });
  it('draws and hit-tests the actual origin rather than the previous table row', () => {
    const { data, refs } = fixture();
    const index = new SurveyGeometryIndex(data, null);
    const geometry = index.shotGeometry(1, 100001)!;
    expect(geometry.from).toEqual(index.stationCoords(refs[3]!)!);
    expect(geometry.from).not.toEqual(index.stationCoords(refs[1]!)!);
    const midpoint = { x: (geometry.from[0] + geometry.to[0]) / 2, y: (geometry.from[1] + geometry.to[1]) / 2 };
    const hit = index.nearestShot(point => ({ x: point[0], y: point[1] }), midpoint.x, midpoint.y, [1, 2], 1e-8, { visibleKinds: { jump: true, reference: true } });
    expect(hit?.shotId).toBe(100001);
    const stationRel = Float32Array.from(Array.from({ length: data.stationCount }, (_, global) => [data.stationCoords[global * 3]!, data.stationCoords[global * 3 + 1]!]).flat());
    const buffers = buildLineBuffers(data, stationRel, buildStationLookup(data), () => [255, 255, 255, 255]);
    expect(Array.from(buffers.posA.slice(8, 10))).toEqual([20, 10]);
    expect(Array.from(buffers.posB.slice(8, 10))).toEqual([30, 10]);
  });
  it('colors distance gradients from graph endpoints including detached roots', () => {
    const { data, refs } = fixture();
    const state = buildDistanceFeatureState(data, { station_refs: refs, distances: [0, 10, 70, 60, 10, 60], max_reachable: 70 });
    expect(state.shots.get(encodeFeatureId(1, 100001))).toBe(65);
    expect(state.stations.get(encodeFeatureId(1, 0x80000001))).toBe(60);
  });
});
