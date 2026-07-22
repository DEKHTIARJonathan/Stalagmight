/**
 * DragPreviewSet -> WebGL vertex buffers for the drag-GHOST custom layer
 * (#mem drag latency). Pure (no GL, no DOM): unit-testable in the `node` vitest
 * env, sibling of `tessellate.ts`.
 *
 * The moving geometry captured for a move drag (shots + closures as 2-point
 * lines, stations as points; see `dragPreviewSource.ts` /
 * `buildDragPreviewFeatureCollection`) is tessellated ONCE here into round-cap
 * capsule + disc buffers, reusing `tessellate.ts`'s exact vertex-layout
 * templates (`LINE_EP` / `LINE_SIDE` / `CIRCLE_CX` / `CIRCLE_CY`) and `movesVertex`
 * so the ghost shaders (`ghostShaders.ts`) draw with the same extrusion the bulk
 * layer uses. Positions are anchor-relative mercator (`mercator.ts` precision
 * trick); the per-frame drag delta is a SHADER uniform, so these buffers are
 * built once and never touched again during the drag.
 *
 * Colors are resolved to packed RGBA8 at CAPTURE time by the caller (base /
 * severity / depth color from the feature's own `color`, or the analytical
 * overlay ramp), matching whatever the bulk geometry currently shows. The
 * preview's translucency (line / fill 0.85, per `dragPreviewLayers.ts`) is baked
 * into the alpha channel; the station stroke keeps full alpha.
 */
import { lngLatToMercator } from '../vectorTileData';
import { movesVertex, type DragPreviewFeature, type DragPreviewSet } from '../dragPreviewSource';
import { LINE_EP, LINE_SIDE, CIRCLE_CX, CIRCLE_CY } from './tessellate';
import type { Rgba8 } from './colorPack';

/** GPU-ready line (shot + closure capsule) buffers for the ghost. */
export interface GhostLineBuffers {
  segmentCount: number;
  vertexCount: number;
  /** Endpoint A / B of each vertex's segment (anchor-relative mercator). */
  posA: Float32Array;
  posB: Float32Array;
  /** 0 at endpoint A, 1 at endpoint B. */
  endpoint: Float32Array;
  /** Extrusion side -1 / +1 (also the AA cross coordinate). */
  side: Float32Array;
  /** Per-endpoint drag-follow flags: whether A / B tracks the offset uniform (a
   *  one-end shot drag stretches the capsule). Replicated across all 4 verts. */
  moveA: Float32Array;
  moveB: Float32Array;
  /** Flat per-vertex RGBA8, alpha pre-baked to the preview line opacity. */
  color: Uint8Array;
  /** Per-vertex width multiplier over `u_half_width` (shots 1, wider closures). */
  widthMul: Float32Array;
  /** Two triangles per segment, `segmentCount*6`, UNSIGNED_INT. */
  indices: Uint32Array;
  byteLength: number;
}

/** GPU-ready station-disc buffers for the ghost. */
export interface GhostCircleBuffers {
  stationCount: number;
  vertexCount: number;
  /** Station center (anchor-relative mercator). */
  center: Float32Array;
  /** Unit quad corner. */
  corner: Float32Array;
  /** Whether the station tracks the offset uniform (all captured stations do). */
  move: Float32Array;
  /** Per-vertex fill RGBA8 (alpha pre-baked) and stroke RGBA8 (full alpha). */
  fill: Uint8Array;
  stroke: Uint8Array;
  /** Two triangles per station, `stationCount*6`, UNSIGNED_INT. */
  indices: Uint32Array;
  byteLength: number;
}

/** Everything the pure build needs from the caller (colors resolved at capture,
 *  preview opacity + width policy). */
export interface GhostBuildInputs {
  /** Resolved base RGB for a feature (alpha ignored; `fillAlpha` is applied). */
  colorFor: (f: DragPreviewFeature) => Rgba8;
  /** Station stroke color (kept at full alpha). */
  strokeColor: Rgba8;
  /** Preview translucency (0..1) baked into line / fill alpha. */
  fillAlpha: number;
  /** Line width multiplier over the shot base width (closures render wider). */
  widthMulFor: (f: DragPreviewFeature) => number;
}

/** Built ghost buffers + the shared anchor for `composeAnchorMatrix`. */
export interface GhostBuffers {
  anchorX: number;
  anchorY: number;
  line: GhostLineBuffers;
  circle: GhostCircleBuffers;
}

function isLine(f: DragPreviewFeature): boolean {
  return f.emit === 'line' && f.coords.length >= 2;
}

function isPoint(f: DragPreviewFeature): boolean {
  return f.emit === 'point' && f.coords.length >= 1;
}

/** Mercator centroid (bbox midpoint) of every captured coord — the anchor that
 *  keeps anchor-relative float32 positions tiny. `[0.5, 0.5]` for an empty set. */
function computeGhostAnchor(set: DragPreviewSet): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const f of set.features) {
    if (!isLine(f) && !isPoint(f)) continue;
    for (const [lng, lat] of f.coords) {
      const [mx, my] = lngLatToMercator(lng, lat);
      if (mx < minX) minX = mx;
      if (my < minY) minY = my;
      if (mx > maxX) maxX = mx;
      if (my > maxY) maxY = my;
      any = true;
    }
  }
  if (!any) return [0.5, 0.5];
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Tessellate a captured drag set into ghost line + circle buffers. */
export function buildGhostBuffers(set: DragPreviewSet, inputs: GhostBuildInputs): GhostBuffers {
  const [anchorX, anchorY] = computeGhostAnchor(set);
  const alpha = Math.max(0, Math.min(255, Math.round(inputs.fillAlpha * 255)));

  const lineFeatures = set.features.filter(isLine);
  const pointFeatures = set.features.filter(isPoint);

  const line = buildLine(lineFeatures, inputs, anchorX, anchorY, alpha);
  const circle = buildCircle(pointFeatures, inputs, anchorX, anchorY, alpha);
  return { anchorX, anchorY, line, circle };
}

function buildLine(
  features: DragPreviewFeature[],
  inputs: GhostBuildInputs,
  anchorX: number,
  anchorY: number,
  alpha: number,
): GhostLineBuffers {
  const segmentCount = features.length;
  const vertexCount = segmentCount * 4;
  const posA = new Float32Array(vertexCount * 2);
  const posB = new Float32Array(vertexCount * 2);
  const endpoint = new Float32Array(vertexCount);
  const side = new Float32Array(vertexCount);
  const moveA = new Float32Array(vertexCount);
  const moveB = new Float32Array(vertexCount);
  const color = new Uint8Array(vertexCount * 4);
  const widthMul = new Float32Array(vertexCount);
  const indices = new Uint32Array(segmentCount * 6);

  for (let seg = 0; seg < segmentCount; seg++) {
    const f = features[seg]!;
    const a = f.coords[0]!;
    const b = f.coords[f.coords.length - 1]!;
    const [ax, ay] = lngLatToMercator(a[0], a[1]);
    const [bx, by] = lngLatToMercator(b[0], b[1]);
    const mvA = movesVertex(f.movingEnd, 0, 2) ? 1 : 0;
    const mvB = movesVertex(f.movingEnd, 1, 2) ? 1 : 0;
    const [cr, cg, cb] = inputs.colorFor(f);
    const wm = inputs.widthMulFor(f);
    const base = seg * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      posA[v * 2] = ax - anchorX;
      posA[v * 2 + 1] = ay - anchorY;
      posB[v * 2] = bx - anchorX;
      posB[v * 2 + 1] = by - anchorY;
      endpoint[v] = LINE_EP[c]!;
      side[v] = LINE_SIDE[c]!;
      moveA[v] = mvA;
      moveB[v] = mvB;
      color[v * 4] = cr;
      color[v * 4 + 1] = cg;
      color[v * 4 + 2] = cb;
      color[v * 4 + 3] = alpha;
      widthMul[v] = wm;
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
    posA.byteLength + posB.byteLength + endpoint.byteLength + side.byteLength +
    moveA.byteLength + moveB.byteLength + color.byteLength + widthMul.byteLength +
    indices.byteLength;
  return {
    segmentCount, vertexCount, posA, posB, endpoint, side, moveA, moveB, color, widthMul,
    indices, byteLength,
  };
}

function buildCircle(
  features: DragPreviewFeature[],
  inputs: GhostBuildInputs,
  anchorX: number,
  anchorY: number,
  alpha: number,
): GhostCircleBuffers {
  const stationCount = features.length;
  const vertexCount = stationCount * 4;
  const center = new Float32Array(vertexCount * 2);
  const corner = new Float32Array(vertexCount * 2);
  const move = new Float32Array(vertexCount);
  const fill = new Uint8Array(vertexCount * 4);
  const stroke = new Uint8Array(vertexCount * 4);
  const indices = new Uint32Array(stationCount * 6);
  const [sr, sg, sb, saByte] = inputs.strokeColor;

  for (let st = 0; st < stationCount; st++) {
    const f = features[st]!;
    const p = f.coords[0]!;
    const [mx, my] = lngLatToMercator(p[0], p[1]);
    const mv = movesVertex(f.movingEnd, 0, 1) ? 1 : 0;
    const [fr, fg, fb] = inputs.colorFor(f);
    const base = st * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      center[v * 2] = mx - anchorX;
      center[v * 2 + 1] = my - anchorY;
      corner[v * 2] = CIRCLE_CX[c]!;
      corner[v * 2 + 1] = CIRCLE_CY[c]!;
      move[v] = mv;
      fill[v * 4] = fr;
      fill[v * 4 + 1] = fg;
      fill[v * 4 + 2] = fb;
      fill[v * 4 + 3] = alpha;
      stroke[v * 4] = sr;
      stroke[v * 4 + 1] = sg;
      stroke[v * 4 + 2] = sb;
      stroke[v * 4 + 3] = saByte;
    }
    const io = st * 6;
    indices[io] = base;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base;
    indices[io + 4] = base + 2;
    indices[io + 5] = base + 3;
  }

  const byteLength =
    center.byteLength + corner.byteLength + move.byteLength + fill.byteLength +
    stroke.byteLength + indices.byteLength;
  return { stationCount, vertexCount, center, corner, move, fill, stroke, indices, byteLength };
}
