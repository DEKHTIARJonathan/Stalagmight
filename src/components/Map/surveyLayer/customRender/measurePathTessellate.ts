/**
 * Measured-path -> WebGL vertex buffers for the dedicated MEASURE-PATH custom
 * layer (#26, stage 2a). Pure (no GL, no DOM): unit-testable in the `node`
 * vitest env, a small sibling of `tessellate.ts` / `ghostTessellate.ts`.
 *
 * The measured along-cave-line path (the ruler result) is a set of measured
 * shots (2-point lines) and measured stations (points). Both are tessellated
 * ONCE here into round-cap capsule + disc buffers, reusing `tessellate.ts`'s
 * exact vertex-layout templates (`LINE_EP` / `LINE_SIDE` / `CIRCLE_CX` /
 * `CIRCLE_CY`) so the measure-path shaders (`measurePathShaders.ts`) draw with
 * the same extrusion the bulk layer and stock `line-cap: round` use.
 *
 * Unlike the ghost, there is no color attribute and no move flag: the whole path
 * is one tint, carried as a shader UNIFORM, so these buffers hold ONLY geometry
 * (anchor-relative mercator positions + the extrusion templates). Positions are
 * anchor-relative (the `mercator.ts` precision trick): the caller folds the
 * anchor back into the per-frame matrix, so a mid-measurement zoom stays exact.
 */
import { lngLatToMercator } from '../mercatorCoords';
import { LINE_EP, LINE_SIDE, CIRCLE_CX, CIRCLE_CY } from './tessellate';

/** A measured shot: its two map-coord endpoints. */
export interface MeasureSegment {
  a: [number, number];
  b: [number, number];
}

/** A measured station: its map-coord center. */
export interface MeasurePoint {
  center: [number, number];
}

/** GPU-ready capsule buffers for the measured shots. */
export interface MeasureLineBuffers {
  segmentCount: number;
  vertexCount: number;
  /** Endpoint A / B of each vertex's segment (anchor-relative mercator). */
  posA: Float32Array;
  posB: Float32Array;
  /** 0 at endpoint A, 1 at endpoint B. */
  endpoint: Float32Array;
  /** Extrusion side -1 / +1 (also the AA cross coordinate). */
  side: Float32Array;
  /** Two triangles per segment, `segmentCount*6`, UNSIGNED_INT. */
  indices: Uint32Array;
  byteLength: number;
}

/** GPU-ready disc buffers for the measured stations. */
export interface MeasureCircleBuffers {
  pointCount: number;
  vertexCount: number;
  /** Station center (anchor-relative mercator). */
  center: Float32Array;
  /** Unit quad corner. */
  corner: Float32Array;
  /** Two triangles per station, `pointCount*6`, UNSIGNED_INT. */
  indices: Uint32Array;
  byteLength: number;
}

/** Built measure-path buffers + the shared anchor for `composeAnchorMatrix`. */
export interface MeasurePathBuffers {
  anchorX: number;
  anchorY: number;
  line: MeasureLineBuffers;
  circle: MeasureCircleBuffers;
}

/** Mercator centroid (bbox midpoint) of every coord - the anchor that keeps
 *  anchor-relative float32 positions tiny. `[0.5, 0.5]` for an empty set. */
function computeAnchor(segments: MeasureSegment[], points: MeasurePoint[]): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  const acc = (lng: number, lat: number): void => {
    const [mx, my] = lngLatToMercator(lng, lat);
    if (mx < minX) minX = mx;
    if (my < minY) minY = my;
    if (mx > maxX) maxX = mx;
    if (my > maxY) maxY = my;
    any = true;
  };
  for (const s of segments) {
    acc(s.a[0], s.a[1]);
    acc(s.b[0], s.b[1]);
  }
  for (const p of points) acc(p.center[0], p.center[1]);
  if (!any) return [0.5, 0.5];
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Tessellate a measured path (shots + stations) into line + circle buffers. */
export function buildMeasurePathBuffers(
  segments: MeasureSegment[],
  points: MeasurePoint[],
): MeasurePathBuffers {
  const [anchorX, anchorY] = computeAnchor(segments, points);
  return {
    anchorX,
    anchorY,
    line: buildLine(segments, anchorX, anchorY),
    circle: buildCircle(points, anchorX, anchorY),
  };
}

function buildLine(segments: MeasureSegment[], anchorX: number, anchorY: number): MeasureLineBuffers {
  const segmentCount = segments.length;
  const vertexCount = segmentCount * 4;
  const posA = new Float32Array(vertexCount * 2);
  const posB = new Float32Array(vertexCount * 2);
  const endpoint = new Float32Array(vertexCount);
  const side = new Float32Array(vertexCount);
  const indices = new Uint32Array(segmentCount * 6);

  for (let seg = 0; seg < segmentCount; seg++) {
    const s = segments[seg]!;
    const [ax, ay] = lngLatToMercator(s.a[0], s.a[1]);
    const [bx, by] = lngLatToMercator(s.b[0], s.b[1]);
    const base = seg * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      posA[v * 2] = ax - anchorX;
      posA[v * 2 + 1] = ay - anchorY;
      posB[v * 2] = bx - anchorX;
      posB[v * 2 + 1] = by - anchorY;
      endpoint[v] = LINE_EP[c]!;
      side[v] = LINE_SIDE[c]!;
    }
    const io = seg * 6;
    indices[io] = base;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base + 2;
    indices[io + 4] = base + 1;
    indices[io + 5] = base + 3;
  }

  const byteLength =
    posA.byteLength + posB.byteLength + endpoint.byteLength + side.byteLength + indices.byteLength;
  return { segmentCount, vertexCount, posA, posB, endpoint, side, indices, byteLength };
}

function buildCircle(points: MeasurePoint[], anchorX: number, anchorY: number): MeasureCircleBuffers {
  const pointCount = points.length;
  const vertexCount = pointCount * 4;
  const center = new Float32Array(vertexCount * 2);
  const corner = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(pointCount * 6);

  for (let pt = 0; pt < pointCount; pt++) {
    const p = points[pt]!;
    const [mx, my] = lngLatToMercator(p.center[0], p.center[1]);
    const base = pt * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      center[v * 2] = mx - anchorX;
      center[v * 2 + 1] = my - anchorY;
      corner[v * 2] = CIRCLE_CX[c]!;
      corner[v * 2 + 1] = CIRCLE_CY[c]!;
    }
    const io = pt * 6;
    indices[io] = base;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base;
    indices[io + 4] = base + 2;
    indices[io + 5] = base + 3;
  }

  const byteLength = center.byteLength + corner.byteLength + indices.byteLength;
  return { pointCount, vertexCount, center, corner, indices, byteLength };
}
