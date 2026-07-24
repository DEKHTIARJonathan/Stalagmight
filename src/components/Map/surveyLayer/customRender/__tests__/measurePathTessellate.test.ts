import { describe, it, expect } from 'vitest';
import {
  buildMeasurePathBuffers,
  type MeasureSegment,
  type MeasurePoint,
} from '../measurePathTessellate';
import { mat4Multiply } from '../mercator';
import { lngLatToMercator } from '../../mercatorCoords';

/**
 * Measure-path tessellator (#26, stage 2a). Locks the measured-path -> buffer
 * contract the custom measure-path layer draws: vertex / index counts, the
 * UNSIGNED_INT index type for the WebGL2 drawElements path, and the anchor-
 * relative-mercator invariant that makes a mid-measurement ZOOM correct (an
 * anchored vertex re-projects through the frame matrix, the anchor folded into
 * the matrix). Unlike the ghost buffers there is no color / move attribute — the
 * tint is a shader uniform — so these buffers hold ONLY geometry.
 */

const seg = (a: [number, number], b: [number, number]): MeasureSegment => ({ a, b });
const pt = (center: [number, number]): MeasurePoint => ({ center });

describe('buildMeasurePathBuffers counts + indices', () => {
  it('emits 4 verts / 6 indices per segment and per point', () => {
    const segments = [seg([0, 0], [0.001, 0]), seg([0.001, 0], [0.001, 0.001])];
    const points = [pt([0, 0]), pt([0.001, 0]), pt([0.001, 0.001])];
    const { line, circle } = buildMeasurePathBuffers(segments, points);

    expect(line.segmentCount).toBe(2);
    expect(line.vertexCount).toBe(8);
    expect(line.indices.length).toBe(12);
    expect(line.posA.length).toBe(16);
    expect(line.posB.length).toBe(16);
    expect(line.endpoint.length).toBe(8);
    expect(line.side.length).toBe(8);

    expect(circle.pointCount).toBe(3);
    expect(circle.vertexCount).toBe(12);
    expect(circle.indices.length).toBe(18);
    expect(circle.center.length).toBe(24);
    expect(circle.corner.length).toBe(24);

    // WebGL2 drawElements path uses 32-bit indices.
    expect(line.indices).toBeInstanceOf(Uint32Array);
    expect(circle.indices).toBeInstanceOf(Uint32Array);
  });

  it('winds two non-degenerate triangles per segment / per point', () => {
    const { line, circle } = buildMeasurePathBuffers([seg([0, 0], [1, 0])], [pt([0, 0])]);
    // Segment quad: 0,1,2 / 2,1,3 (four distinct corners referenced).
    expect(Array.from(line.indices)).toEqual([0, 1, 2, 2, 1, 3]);
    // Disc quad: 0,1,2 / 0,2,3.
    expect(Array.from(circle.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    // Endpoint / side templates repeat per the LINE_EP / LINE_SIDE layout.
    expect(Array.from(line.endpoint)).toEqual([0, 0, 1, 1]);
    expect(Array.from(line.side)).toEqual([-1, 1, -1, 1]);
  });

  it('is empty (anchor 0.5,0.5) for an empty set', () => {
    const { anchorX, anchorY, line, circle } = buildMeasurePathBuffers([], []);
    expect([anchorX, anchorY]).toEqual([0.5, 0.5]);
    expect(line.segmentCount).toBe(0);
    expect(line.vertexCount).toBe(0);
    expect(circle.pointCount).toBe(0);
    expect(circle.vertexCount).toBe(0);
  });

  it('handles a shots-only or stations-only path', () => {
    const shotsOnly = buildMeasurePathBuffers([seg([0, 0], [1, 1])], []);
    expect(shotsOnly.line.segmentCount).toBe(1);
    expect(shotsOnly.circle.pointCount).toBe(0);

    const stationsOnly = buildMeasurePathBuffers([], [pt([0, 0])]);
    expect(stationsOnly.line.segmentCount).toBe(0);
    expect(stationsOnly.circle.pointCount).toBe(1);
  });
});

describe('anchor-relative mercator invariant (zoom correctness)', () => {
  it('stores each vertex as mercator - anchor and folds the anchor into the matrix exactly', () => {
    const coordA: [number, number] = [12.34, 45.67];
    const coordB: [number, number] = [12.35, 45.68];
    const { anchorX, anchorY, line, circle } = buildMeasurePathBuffers(
      [seg(coordA, coordB)],
      [pt(coordA)],
    );

    const [mAx, mAy] = lngLatToMercator(coordA[0], coordA[1]);
    // Vertex 0 stores endpoint A anchor-relative.
    expect(line.posA[0]).toBeCloseTo(mAx - anchorX, 6);
    expect(line.posA[1]).toBeCloseTo(mAy - anchorY, 6);
    // The station center likewise.
    expect(circle.center[0]).toBeCloseTo(mAx - anchorX, 6);
    expect(circle.center[1]).toBeCloseTo(mAy - anchorY, 6);

    // composeAnchorMatrix(mvp, anchor) * rel maps to the SAME clip position as
    // projecting the raw mercator coord under mvp, for realistic mercator->clip
    // matrices — why a mid-measurement zoom keeps the tint glued.
    const rel = [mAx - anchorX, mAy - anchorY, 0, 1];
    const matrices: number[][] = [
      [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, -0.5, -1.2, 0, 1],
      [4.2, 0, 0, 0, 0, 4.2, 0, 0, 0, 0, 1, 0, -1.9, -2.4, 0, 1],
    ];
    for (const mvp of matrices) {
      const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, anchorX, anchorY, 0, 1];
      const composed = mat4Multiply(mvp, translate);
      const viaLayer = mat4Multiply(composed, colVec(rel));
      const viaDirect = mat4Multiply(mvp, colVec([mAx, mAy, 0, 1]));
      for (let i = 0; i < 4; i++) expect(viaLayer[i]).toBeCloseTo(viaDirect[i]!, 9);
    }
  });

  it('anchors at the mercator bbox midpoint of all coords', () => {
    const a: [number, number] = [10, 20];
    const b: [number, number] = [12, 24];
    const { anchorX, anchorY } = buildMeasurePathBuffers([seg(a, b)], []);
    const [ax, ay] = lngLatToMercator(a[0], a[1]);
    const [bx, by] = lngLatToMercator(b[0], b[1]);
    expect(anchorX).toBeCloseTo((ax + bx) / 2, 12);
    expect(anchorY).toBeCloseTo((ay + by) / 2, 12);
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
