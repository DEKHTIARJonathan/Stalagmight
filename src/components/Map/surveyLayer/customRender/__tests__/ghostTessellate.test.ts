import { describe, it, expect } from 'vitest';
import { buildGhostBuffers, type GhostBuildInputs, type GhostHighlights } from '../ghostTessellate';
import { mat4Multiply } from '../mercator';
import { lngLatToMercator } from '../../vectorTileData';
import type { DragPreviewFeature, DragPreviewSet } from '../../dragPreviewSource';
import type { Rgba8 } from '../colorPack';

/**
 * Drag-ghost tessellator (#mem drag latency). Locks the capture -> buffer
 * contract the custom ghost layer draws: vertex / index counts, per-endpoint
 * move flags derived from `movingEnd`, colors packed with the preview opacity
 * baked in, and the anchor-relative-mercator invariant that makes a mid-drag
 * ZOOM correct (an anchored vertex re-projects through the frame matrix; only
 * the screen-px offset uniform carries the cursor delta).
 */

function station(coord: [number, number], color = '#00ff00'): DragPreviewFeature {
  return { emit: 'point', coords: [coord], movingEnd: 'uniform', properties: { kind: 'station', color } };
}

function shot(
  a: [number, number],
  b: [number, number],
  movingEnd: DragPreviewFeature['movingEnd'],
  color = '#ff0000',
): DragPreviewFeature {
  return { emit: 'line', coords: [a, b], movingEnd, properties: { kind: 'shot', color } };
}

const STROKE: Rgba8 = [10, 20, 30, 255];

const INPUTS: GhostBuildInputs = {
  colorFor: (f) => {
    const c = String(f.properties.color);
    // Trivial hex parse for the fixture colors used here.
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
  },
  strokeColor: STROKE,
  fillAlpha: 0.85,
  widthMulFor: (f) => (f.properties.kind === 'closure' ? 2.5 : 1),
};

const ALPHA = Math.round(0.85 * 255); // 217

describe('buildGhostBuffers counts + indices', () => {
  it('emits 4 verts / 6 indices per line and per station', () => {
    const set: DragPreviewSet = {
      features: [
        station([0, 0]),
        station([0.001, 0.001]),
        shot([0, 0], [0.001, 0], 'uniform'),
        shot([0.001, 0], [0.001, 0.001], 'from'),
        { emit: 'line', coords: [[0, 0], [0.001, 0.001]], movingEnd: 'both', properties: { kind: 'closure', color: '#0000ff' } },
      ],
    };
    const { line, circle } = buildGhostBuffers(set, INPUTS);
    expect(line.segmentCount).toBe(3);
    expect(line.vertexCount).toBe(12);
    expect(line.indices.length).toBe(18);
    expect(circle.stationCount).toBe(2);
    expect(circle.vertexCount).toBe(8);
    expect(circle.indices.length).toBe(12);
    // Index buffers are UNSIGNED_INT for the WebGL2 drawElements path.
    expect(line.indices).toBeInstanceOf(Uint32Array);
    expect(circle.indices).toBeInstanceOf(Uint32Array);
  });

  it('is empty (anchor 0.5,0.5) for an empty set', () => {
    const { anchorX, anchorY, line, circle } = buildGhostBuffers({ features: [] }, INPUTS);
    expect([anchorX, anchorY]).toEqual([0.5, 0.5]);
    expect(line.segmentCount).toBe(0);
    expect(circle.stationCount).toBe(0);
  });
});

describe('per-endpoint move flags from movingEnd', () => {
  it('maps uniform/both/from/to to the right a_move_a / a_move_b', () => {
    const set: DragPreviewSet = {
      features: [
        shot([0, 0], [1, 0], 'uniform'),
        shot([0, 0], [1, 0], 'from'),
        shot([0, 0], [1, 0], 'to'),
      ],
    };
    const { line } = buildGhostBuffers(set, INPUTS);
    // seg 0 uniform: both ends follow.
    for (let v = 0; v < 4; v++) {
      expect(line.moveA[v]).toBe(1);
      expect(line.moveB[v]).toBe(1);
    }
    // seg 1 'from': only A follows.
    for (let v = 4; v < 8; v++) {
      expect(line.moveA[v]).toBe(1);
      expect(line.moveB[v]).toBe(0);
    }
    // seg 2 'to': only B follows.
    for (let v = 8; v < 12; v++) {
      expect(line.moveA[v]).toBe(0);
      expect(line.moveB[v]).toBe(1);
    }
  });

  it('every captured station follows the offset', () => {
    const { circle } = buildGhostBuffers({ features: [station([0, 0]), station([1, 1])] }, INPUTS);
    for (let v = 0; v < circle.vertexCount; v++) expect(circle.move[v]).toBe(1);
  });
});

describe('colors: preview opacity baked, stroke opaque, width multiplier', () => {
  it('bakes fillAlpha into line + fill alpha and keeps stroke alpha', () => {
    const set: DragPreviewSet = {
      features: [
        station([0, 0], '#00ff00'),
        { emit: 'line', coords: [[0, 0], [1, 0]], movingEnd: 'both', properties: { kind: 'closure', color: '#0000ff' } },
      ],
    };
    const { line, circle } = buildGhostBuffers(set, INPUTS);
    // Station fill = #00ff00 @ 0.85; stroke = STROKE @ 255.
    expect([circle.fill[0], circle.fill[1], circle.fill[2], circle.fill[3]]).toEqual([0, 255, 0, ALPHA]);
    expect([circle.stroke[0], circle.stroke[1], circle.stroke[2], circle.stroke[3]]).toEqual([10, 20, 30, 255]);
    // Closure line = #0000ff @ 0.85, width multiplier 2.5.
    expect([line.color[0], line.color[1], line.color[2], line.color[3]]).toEqual([0, 0, 255, ALPHA]);
    expect(line.widthMul[0]).toBe(2.5);
  });
});

describe('highlight pass (grabbed feature drawn on top)', () => {
  it('appends a larger disc / wider capsule after the base, with the given style', () => {
    const set: DragPreviewSet = { features: [station([0, 0]), shot([0, 0], [1, 0], 'uniform')] };
    const highlights: GhostHighlights = {
      stations: [{
        coord: [0, 0], movingEnd: 'uniform',
        fill: [1, 2, 3, 255], stroke: [9, 8, 7, 255], opacity: 1, sizeMul: 1.2, strokeMul: 1.6,
      }],
      shots: [{ a: [0, 0], b: [1, 0], movingEnd: 'to', color: [4, 5, 6, 255], opacity: 0.5, widthMul: 1.5 }],
    };
    const { line, circle } = buildGhostBuffers(set, INPUTS, highlights);
    // base + highlight for each geometry kind.
    expect(circle.stationCount).toBe(2);
    expect(line.segmentCount).toBe(2);

    // Base circle (vertex 0) keeps size 1; the highlight (vertex 4) carries the mults.
    expect(circle.sizeMul[0]).toBe(1);
    expect(circle.strokeMul[0]).toBe(1);
    expect(circle.sizeMul[4]).toBeCloseTo(1.2);
    expect(circle.strokeMul[4]).toBeCloseTo(1.6);
    expect([circle.fill[16], circle.fill[17], circle.fill[18], circle.fill[19]]).toEqual([1, 2, 3, 255]);
    expect([circle.stroke[16], circle.stroke[17], circle.stroke[18]]).toEqual([9, 8, 7]);

    // Highlight shot (seg 1 -> vertex 4): width multiplier, baked opacity, and the
    // 'to' movingEnd (only endpoint B follows the offset).
    expect(line.widthMul[4]).toBeCloseTo(1.5);
    expect(line.color[19]).toBe(Math.round(0.5 * 255));
    expect(line.moveA[4]).toBe(0);
    expect(line.moveB[4]).toBe(1);
  });

  it('is a no-op when no highlights are passed', () => {
    const set: DragPreviewSet = { features: [station([0, 0]), shot([0, 0], [1, 0], 'uniform')] };
    const { line, circle } = buildGhostBuffers(set, INPUTS, { stations: [], shots: [] });
    expect(circle.stationCount).toBe(1);
    expect(line.segmentCount).toBe(1);
    expect(circle.sizeMul[0]).toBe(1);
  });
});

describe('anchor-relative mercator invariant (zoom correctness)', () => {
  it('stores each vertex as mercator - anchor, so composeAnchorMatrix reconstructs the absolute position at ANY matrix', () => {
    const coordA: [number, number] = [12.34, 45.67];
    const coordB: [number, number] = [12.35, 45.68];
    const set: DragPreviewSet = { features: [shot(coordA, coordB, 'uniform')] };
    const { anchorX, anchorY, line } = buildGhostBuffers(set, INPUTS);

    const [mAx, mAy] = lngLatToMercator(coordA[0], coordA[1]);
    // Vertex 0 stores endpoint A anchor-relative (float32 buffer, so ~1e-3 with
    // float32 resolution — the mercator.ts precision trick that keeps rel small).
    expect(line.posA[0]).toBeCloseTo(mAx - anchorX, 6);
    expect(line.posA[1]).toBeCloseTo(mAy - anchorY, 6);

    // The anchor fold is exact (float64): for the float64 rel = mercator - anchor,
    // composeAnchorMatrix(mvp, anchor) * rel maps to the SAME clip position as
    // projecting the raw mercator coord under mvp — for realistic mercator->clip
    // matrices (scale ~1-4). This is why a mid-drag ZOOM keeps the ghost glued:
    // the anchored position re-projects correctly whatever the camera, and the
    // screen-px drag delta is a separate additive uniform (zero here).
    const rel = [mAx - anchorX, mAy - anchorY, 0, 1];
    const matrices: number[][] = [
      [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, -0.5, -1.2, 0, 1],
      [4.2, 0, 0, 0, 0, 4.2, 0, 0, 0, 0, 1, 0, -1.9, -2.4, 0, 1],
    ];
    for (const mvp of matrices) {
      // Compose in float64 (the anchor fold is exact; the shipping code downcasts
      // to float32 for the GPU uniform, a separate documented precision tradeoff).
      const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, anchorX, anchorY, 0, 1];
      const composed = mat4Multiply(mvp, translate);
      const viaGhost = mat4Multiply(composed, colVec(rel));
      const viaDirect = mat4Multiply(mvp, colVec([mAx, mAy, 0, 1]));
      for (let i = 0; i < 4; i++) expect(viaGhost[i]).toBeCloseTo(viaDirect[i]!, 9);
    }
  });
});

/** A column vector as a 4x4 with the vector in column 0 (so mat4Multiply's
 *  column-major `a*b` yields `a*v` in its first column). */
function colVec(v: number[]): Float64Array {
  const m = new Float64Array(16);
  m[0] = v[0]!;
  m[1] = v[1]!;
  m[2] = v[2]!;
  m[3] = v[3]!;
  return m;
}
