import { describe, it, expect } from 'vitest';
import {
  buildDragPreviewFeatureCollection,
  movesVertex,
  offsetVertex,
  transformFeatureCoords,
  type DragPreviewFeature,
  type DragPreviewSet,
  type Projector,
} from '../dragPreviewSource';

// A trivial linear projector: pixels == coords (1 unit = 1 px). project([lng,lat])
// = {x:lng, y:lat}; unproject([x,y]) = {lng:x, lat:y}. This makes a screen offset
// [dx,dy] add directly to lng/lat, so expected outputs are easy to reason about.
const identityProjector: Projector = {
  project: ([lng, lat]) => ({ x: lng, y: lat }),
  unproject: ([x, y]) => ({ lng: x, lat: y }),
};

// A non-identity projector (scale x2) to prove the transform round-trips through
// project/unproject rather than adding the offset to lng/lat directly.
const scaleProjector: Projector = {
  project: ([lng, lat]) => ({ x: lng * 2, y: lat * 2 }),
  unproject: ([x, y]) => ({ lng: x / 2, lat: y / 2 }),
};

describe('movesVertex', () => {
  it('moves every vertex for uniform and both', () => {
    for (const end of ['uniform', 'both'] as const) {
      expect(movesVertex(end, 0, 3)).toBe(true);
      expect(movesVertex(end, 1, 3)).toBe(true);
      expect(movesVertex(end, 2, 3)).toBe(true);
    }
  });

  it('moves only the first vertex for from', () => {
    expect(movesVertex('from', 0, 2)).toBe(true);
    expect(movesVertex('from', 1, 2)).toBe(false);
  });

  it('moves only the last vertex for to', () => {
    expect(movesVertex('to', 0, 2)).toBe(false);
    expect(movesVertex('to', 1, 2)).toBe(true);
  });

  it('moves nothing for none', () => {
    expect(movesVertex('none', 0, 2)).toBe(false);
    expect(movesVertex('none', 1, 2)).toBe(false);
  });
});

describe('offsetVertex', () => {
  it('adds the screen offset through the identity projector', () => {
    expect(offsetVertex([10, 20], identityProjector, 3, -4)).toEqual([13, 16]);
  });

  it('applies the offset in screen space, not lng/lat space', () => {
    // project([10,20]) = [20,40]; +[4,0] = [24,40]; unproject = [12,20].
    expect(offsetVertex([10, 20], scaleProjector, 4, 0)).toEqual([12, 20]);
  });
});

describe('transformFeatureCoords', () => {
  it('offsets all vertices uniformly for a segment-drag line', () => {
    const f: DragPreviewFeature = {
      emit: 'line',
      coords: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      movingEnd: 'uniform',
      properties: {},
    };
    expect(transformFeatureCoords(f, identityProjector, 5, 5)).toEqual([
      [5, 5],
      [15, 5],
      [15, 15],
    ]);
  });

  it('offsets only the moving endpoint for a station-drag shot', () => {
    const fromMoving: DragPreviewFeature = {
      emit: 'line',
      coords: [
        [0, 0],
        [10, 0],
      ],
      movingEnd: 'from',
      properties: {},
    };
    expect(transformFeatureCoords(fromMoving, identityProjector, 3, 0)).toEqual([
      [3, 0],
      [10, 0],
    ]);

    const toMoving: DragPreviewFeature = { ...fromMoving, movingEnd: 'to' };
    expect(transformFeatureCoords(toMoving, identityProjector, 3, 0)).toEqual([
      [0, 0],
      [13, 0],
    ]);
  });
});

describe('buildDragPreviewFeatureCollection', () => {
  it('passes properties through unchanged (colors / labels / gradient props)', () => {
    const set: DragPreviewSet = {
      features: [
        {
          emit: 'point',
          coords: [[1, 2]],
          movingEnd: 'uniform',
          properties: { kind: 'station', color: '#abc', radius: 5 },
        },
        {
          emit: 'line',
          coords: [
            [0, 0],
            [4, 0],
          ],
          movingEnd: 'both',
          properties: { kind: 'shot', color: '#def', width: 3, dist: 12 },
        },
      ],
    };
    const fc = buildDragPreviewFeatureCollection(set, identityProjector, 1, 1);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features[0]!.properties).toEqual({ kind: 'station', color: '#abc', radius: 5 });
    expect(fc.features[1]!.properties).toEqual({ kind: 'shot', color: '#def', width: 3, dist: 12 });
  });

  it('moves a uniform segment set so every coordinate shifts by the offset', () => {
    const set: DragPreviewSet = {
      features: [
        { emit: 'point', coords: [[0, 0]], movingEnd: 'uniform', properties: { kind: 'station' } },
        {
          emit: 'line',
          coords: [
            [0, 0],
            [2, 2],
          ],
          movingEnd: 'uniform',
          properties: { kind: 'shot' },
        },
      ],
    };
    const fc = buildDragPreviewFeatureCollection(set, identityProjector, 10, -5);
    expect((fc.features[0]!.geometry as GeoJSON.Point).coordinates).toEqual([10, -5]);
    expect((fc.features[1]!.geometry as GeoJSON.LineString).coordinates).toEqual([
      [10, -5],
      [12, -3],
    ]);
  });

  it('offsets only moving endpoints for a station drag (station + connected shots)', () => {
    const set: DragPreviewSet = {
      features: [
        // The dragged station.
        { emit: 'point', coords: [[0, 0]], movingEnd: 'uniform', properties: { kind: 'station' } },
        // Shot whose FROM end is the dragged station; TO end is fixed.
        {
          emit: 'line',
          coords: [
            [0, 0],
            [10, 0],
          ],
          movingEnd: 'from',
          properties: { kind: 'shot' },
        },
        // Label sits at the midpoint of the (stretched) shot.
        {
          emit: 'midpoint',
          coords: [
            [0, 0],
            [10, 0],
          ],
          movingEnd: 'from',
          properties: { kind: 'shotLabel' },
        },
      ],
    };
    const fc = buildDragPreviewFeatureCollection(set, identityProjector, 4, 0);
    expect((fc.features[0]!.geometry as GeoJSON.Point).coordinates).toEqual([4, 0]);
    expect((fc.features[1]!.geometry as GeoJSON.LineString).coordinates).toEqual([
      [4, 0],
      [10, 0],
    ]);
    // Midpoint of moved [4,0] and fixed [10,0] => [7,0].
    expect((fc.features[2]!.geometry as GeoJSON.Point).coordinates).toEqual([7, 0]);
  });

  it('leaves a stationary feature at its true coordinates', () => {
    const set: DragPreviewSet = {
      features: [
        { emit: 'point', coords: [[3, 7]], movingEnd: 'none', properties: { kind: 'highlight' } },
      ],
    };
    const fc = buildDragPreviewFeatureCollection(set, identityProjector, 100, 100);
    expect((fc.features[0]!.geometry as GeoJSON.Point).coordinates).toEqual([3, 7]);
  });
});
