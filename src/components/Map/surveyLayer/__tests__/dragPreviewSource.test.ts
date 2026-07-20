import { describe, it, expect } from 'vitest';
import {
  buildDragPreviewFeatureCollection,
  dragLabelTranslate,
  movesVertex,
  offsetOverlayPoint,
  offsetOverlayShot,
  offsetVertex,
  textPreviewFeature,
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

  // Text features (label === true) render at their STATIC anchor and follow the
  // drag with a text-translate paint uniform, so buildDragPreviewFeatureCollection
  // must emit them un-offset even at a large offset (else they'd double-move).
  it('emits a point label at its static anchor regardless of offset', () => {
    const set: DragPreviewSet = {
      features: [
        textPreviewFeature('stationLabel', 'point', [[2, 3]], 'uniform', '7', '#fff'),
      ],
    };
    const fc = buildDragPreviewFeatureCollection(set, identityProjector, 100, -40);
    expect((fc.features[0]!.geometry as GeoJSON.Point).coordinates).toEqual([2, 3]);
    expect(fc.features[0]!.properties).toEqual({ kind: 'stationLabel', label: '7', color: '#fff', half: false });
  });

  it('emits a midpoint label at the static shot midpoint regardless of offset', () => {
    const set: DragPreviewSet = {
      features: [
        textPreviewFeature('shotLabel', 'midpoint', [[0, 0], [10, 4]], 'from', '1m', '#abc'),
      ],
    };
    const fc = buildDragPreviewFeatureCollection(set, identityProjector, 100, 100);
    // Midpoint of the ORIGINAL endpoints ([0,0], [10,4]) => [5,2], no offset.
    expect((fc.features[0]!.geometry as GeoJSON.Point).coordinates).toEqual([5, 2]);
    // A single-endpoint shot's midpoint moves half the offset -> half layer.
    expect(fc.features[0]!.properties).toMatchObject({ kind: 'shotLabel', half: true });
  });
});

describe('dragLabelTranslate', () => {
  it('returns the full offset for a fully-translating label', () => {
    expect(dragLabelTranslate(12, -8, false)).toEqual([12, -8]);
  });
  it('halves the offset for a stretching shot midpoint', () => {
    expect(dragLabelTranslate(12, -8, true)).toEqual([6, -4]);
  });
});

describe('textPreviewFeature', () => {
  it('flags text features as static labels and derives half from movingEnd', () => {
    const uniform = textPreviewFeature('stationLabel', 'point', [[1, 1]], 'uniform', '0', '#111');
    expect(uniform.label).toBe(true);
    expect(uniform.properties).toEqual({ kind: 'stationLabel', label: '0', color: '#111', half: false });

    // A shot midpoint with one moving endpoint (from / to) moves half the offset.
    for (const end of ['from', 'to'] as const) {
      const half = textPreviewFeature('shotComment', 'midpoint', [[0, 0], [2, 0]], end, 'note', '#222');
      expect(half.properties.half).toBe(true);
    }
    // Both endpoints (a shot move) -> full offset.
    const both = textPreviewFeature('shotLabel', 'midpoint', [[0, 0], [2, 0]], 'both', '2m', '#333');
    expect(both.properties.half).toBe(false);
  });
});

// Interact-overlay follow (#C): a highlight on a moving station/shot tracks the
// drag; a stationary highlighted station keeps its true coordinates.
describe('offsetOverlayPoint', () => {
  it('offsets a moving station highlight', () => {
    expect(offsetOverlayPoint([1, 1], true, identityProjector, 5, -2)).toEqual([6, -1]);
  });
  it('leaves a stationary highlighted station unchanged', () => {
    expect(offsetOverlayPoint([1, 1], false, identityProjector, 5, -2)).toEqual([1, 1]);
  });
});

describe('offsetOverlayShot', () => {
  it('stretches only the moving endpoint (from)', () => {
    expect(offsetOverlayShot([0, 0], [10, 0], 'from', identityProjector, 3, 0)).toEqual({
      from: [3, 0],
      to: [10, 0],
    });
  });
  it('stretches only the moving endpoint (to)', () => {
    expect(offsetOverlayShot([0, 0], [10, 0], 'to', identityProjector, 3, 0)).toEqual({
      from: [0, 0],
      to: [13, 0],
    });
  });
  it('offsets both endpoints when both move', () => {
    expect(offsetOverlayShot([0, 0], [10, 0], 'both', identityProjector, 2, 2)).toEqual({
      from: [2, 2],
      to: [12, 2],
    });
  });
  it('leaves a stationary (undefined / none) shot unchanged', () => {
    expect(offsetOverlayShot([0, 0], [10, 0], undefined, identityProjector, 9, 9)).toEqual({
      from: [0, 0],
      to: [10, 0],
    });
    expect(offsetOverlayShot([0, 0], [10, 0], 'none', identityProjector, 9, 9)).toEqual({
      from: [0, 0],
      to: [10, 0],
    });
  });
});

// The scenario the task calls out: a selected station + shot in the moving set,
// plus one stationary highlighted station — moving pair offsets, stationary one
// stays. Modeled over the same primitives the overlay builders use.
describe('overlay follow scenario', () => {
  it('offsets the moving station+shot and leaves the stationary highlight put', () => {
    const proj = identityProjector;
    const dx = 4;
    const dy = 0;
    const movingStationKeys = new Set(['1:0']);
    const movingShots = new Map([['1:5', 'from' as const]]);

    // Selected station 1:0 is moving.
    const selStation = offsetOverlayPoint([0, 0], movingStationKeys.has('1:0'), proj, dx, dy);
    // Selected shot 1:5 has its from-endpoint moving.
    const selShot = offsetOverlayShot([0, 0], [10, 0], movingShots.get('1:5'), proj, dx, dy);
    // A stationary highlighted station 2:3 is NOT in the moving set.
    const highlight = offsetOverlayPoint([7, 7], movingStationKeys.has('2:3'), proj, dx, dy);

    expect(selStation).toEqual([4, 0]);
    expect(selShot).toEqual({ from: [4, 0], to: [10, 0] });
    expect(highlight).toEqual([7, 7]);
  });
});
