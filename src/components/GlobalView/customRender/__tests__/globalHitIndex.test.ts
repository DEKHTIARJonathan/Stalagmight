/**
 * Hit-index tests for the global view's custom render (#customRender). Resolves
 * a screen point to a system with a synthetic projector (no MapLibre), covering
 * station priority, shot fallback, reference filtering, and the AABB prefilter.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectMetadata } from '../../../../types/project';
import type { GeometryShot, SurveyGeometry } from '../../../../types/survey';
import type { SystemGeometry } from '../../systemColor';
import { GlobalHitIndex, type ProjectFn } from '../globalHitIndex';

function shot(from: [number, number], to: [number, number], isReference = false): GeometryShot {
  return { from, to, is_reference: isReference, section_id: 0 };
}

function makeSystem(filePath: string, shots: GeometryShot[]): SystemGeometry {
  const metadata: ProjectMetadata = {
    name: filePath,
    location: null,
    file_path: filePath,
    modified_at: '2026-01-01T00:00:00Z',
    section_count: 1,
    total_length: 100,
    station_count: 3,
    gps_center: [0, 0],
    gps_bounds: null,
    collab_enabled: false,
    is_remote: false,
  };
  const geometry: SurveyGeometry = { shots, origin: [0, 0] };
  return { metadata, geometry };
}

// Identity projector: 1 lng/lat unit == 1 px. Keeps the reach math readable.
const project: ProjectFn = ([lng, lat]) => ({ x: lng, y: lat });

const OPTS = { includeReference: true, stationReach: 10, shotReach: 5 };

// Two well-separated systems so their AABBs never overlap the same probe.
const systemA = makeSystem('a.tml', [shot([0, 0], [100, 0]), shot([100, 0], [200, 0])]);
const systemB = makeSystem('b.tml', [shot([1000, 1000], [1100, 1000])]);

describe('GlobalHitIndex.pick', () => {
  const index = new GlobalHitIndex([systemA, systemB]);

  it('indexes every system', () => {
    expect(index.systemCount).toBe(2);
  });

  it('resolves the system whose station is under the point', () => {
    const hit = index.pick(project, 100, 0, OPTS);
    expect(hit).toEqual({ systemId: 'a.tml', kind: 'station' });
  });

  it('resolves a shot when no station is within reach', () => {
    // Mid-segment of A's first shot (50,0): 50px from either station (> radius
    // 10) but on the line (dist 0).
    const hit = index.pick(project, 50, 0, OPTS);
    expect(hit).toEqual({ systemId: 'a.tml', kind: 'shot' });
  });

  it('returns the nearer system when two are in play', () => {
    const hit = index.pick(project, 1000, 1000, OPTS);
    expect(hit?.systemId).toBe('b.tml');
  });

  it('returns null for empty space', () => {
    expect(index.pick(project, 500, 500, OPTS)).toBeNull();
  });

  it('skips reference features when includeReference is false', () => {
    const refSys = makeSystem('r.tml', [shot([0, 0], [100, 0], true)]);
    const refIndex = new GlobalHitIndex([refSys]);
    // On the reference shot's line, away from either endpoint station.
    const excluded = refIndex.pick(project, 50, 0, { ...OPTS, includeReference: false });
    expect(excluded).toBeNull();
    // With reference included, it resolves.
    const included = refIndex.pick(project, 50, 0, OPTS);
    expect(included?.systemId).toBe('r.tml');
  });

  it('skips a system with no shots (Infinity bounds) without projecting it', () => {
    // A shot-less system keeps its initial +/-Infinity AABB; projecting those
    // corners would hand map.project an invalid lng/lat and throw for the whole
    // global map. The pick loop must skip it before any projection.
    const empty = makeSystem('empty.tml', []);
    const idx = new GlobalHitIndex([empty, systemA]);
    const guarded: ProjectFn = ([lng, lat]) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error('non-finite projected');
      return { x: lng, y: lat };
    };
    expect(() => idx.pick(guarded, 100, 0, OPTS)).not.toThrow();
    // The real system still resolves through the same call.
    expect(idx.pick(guarded, 100, 0, OPTS)?.systemId).toBe('a.tml');
  });

  it('honors the reach radius (miss just outside)', () => {
    // 6px above the line: within station reach of no station (nearest station at
    // (0,0) is >10px away) and just outside the 5px shot reach.
    expect(index.pick(project, 50, 6, OPTS)).toBeNull();
    // 4px above the line: within the 5px shot reach.
    expect(index.pick(project, 50, 4, OPTS)?.kind).toBe('shot');
  });
});
