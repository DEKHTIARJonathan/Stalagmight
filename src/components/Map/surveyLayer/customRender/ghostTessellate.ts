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
 * A trailing HIGHLIGHT pass re-emits the grabbed feature (the hovered/selected
 * station/shot that picked up the drag) at the interact-overlay highlight style
 * (larger disc / wider capsule, hover or selection stroke), drawn ON TOP of the
 * base moving copy so it shares `u_offset_px` and tracks the cursor exactly in
 * tandem with the ghost. That replaces the async per-frame overlay `setData`
 * that lagged the synchronous ghost.
 *
 * Colors are resolved to packed RGBA8 at CAPTURE time by the caller (base /
 * severity / depth color from the feature's own `color`, or the analytical
 * overlay ramp), matching whatever the bulk geometry currently shows. The
 * preview's translucency (line / fill 0.85, per `dragPreviewLayers.ts`) is baked
 * into the alpha channel; the base station stroke keeps full alpha.
 */
import { lngLatToMercator } from '../mercatorCoords';
import { movesVertex, type DragPreviewFeature, type DragPreviewSet, type MovingEnd } from '../dragPreviewSource';
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
  /** Per-vertex width multiplier over `u_half_width` (shots 1, wider closures /
   *  the highlight pass). */
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
  /** Per-vertex fill RGBA8 (alpha pre-baked) and stroke RGBA8. */
  fill: Uint8Array;
  stroke: Uint8Array;
  /** Per-vertex radius / stroke-width multipliers (base 1; the highlight pass
   *  enlarges the grabbed station's disc + ring to the overlay hover/selection
   *  size). */
  sizeMul: Float32Array;
  strokeMul: Float32Array;
  /** Two triangles per station, `stationCount*6`, UNSIGNED_INT. */
  indices: Uint32Array;
  byteLength: number;
}

/** Everything the pure build needs from the caller (colors resolved at capture,
 *  preview opacity + width policy). */
export interface GhostBuildInputs {
  /** Resolved base RGB for a feature (alpha ignored; `fillAlpha` is applied). */
  colorFor: (f: DragPreviewFeature) => Rgba8;
  /** Base station stroke color (kept at full alpha). */
  strokeColor: Rgba8;
  /** Preview translucency (0..1) baked into line / fill alpha. */
  fillAlpha: number;
  /** Line width multiplier over the shot base width (closures render wider). */
  widthMulFor: (f: DragPreviewFeature) => number;
}

/** The grabbed station's highlight, re-drawn on top at overlay style. */
export interface GhostStationHighlight {
  coord: [number, number];
  movingEnd: MovingEnd;
  /** Fill + stroke RGB (alpha applied from `opacity`). */
  fill: Rgba8;
  stroke: Rgba8;
  /** Overlay opacity (0..1) baked into fill + stroke alpha. */
  opacity: number;
  /** Radius / stroke-width multipliers over the ghost base (hover/selection). */
  sizeMul: number;
  strokeMul: number;
}

/** The grabbed shot's highlight, re-drawn on top at overlay style. */
export interface GhostShotHighlight {
  a: [number, number];
  b: [number, number];
  movingEnd: MovingEnd;
  color: Rgba8;
  opacity: number;
  /** Width multiplier over the ghost base half-width (hover/selection). */
  widthMul: number;
}

export interface GhostHighlights {
  stations: GhostStationHighlight[];
  shots: GhostShotHighlight[];
}

/** Built ghost buffers + the shared anchor for `composeAnchorMatrix`. */
export interface GhostBuffers {
  anchorX: number;
  anchorY: number;
  line: GhostLineBuffers;
  circle: GhostCircleBuffers;
}

/** Internal unified line vertex source (base capsule + highlight capsule). */
interface LinePrim {
  a: [number, number];
  b: [number, number];
  moveA: number;
  moveB: number;
  color: Rgba8;
  alpha: number;
  widthMul: number;
}

/** Internal unified circle vertex source (base disc + highlight disc). */
interface CirclePrim {
  center: [number, number];
  move: number;
  fill: Rgba8;
  stroke: Rgba8;
  fillAlpha: number;
  strokeAlpha: number;
  sizeMul: number;
  strokeMul: number;
}

function isLine(f: DragPreviewFeature): boolean {
  return f.emit === 'line' && f.coords.length >= 2;
}

function isPoint(f: DragPreviewFeature): boolean {
  return f.emit === 'point' && f.coords.length >= 1;
}

function byteClamp(a: number): number {
  return Math.max(0, Math.min(255, Math.round(a * 255)));
}

/** Mercator centroid (bbox midpoint) of every prim coord - the anchor that keeps
 *  anchor-relative float32 positions tiny. `[0.5, 0.5]` for an empty set. */
function computeAnchor(lines: LinePrim[], circles: CirclePrim[]): [number, number] {
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
  for (const l of lines) {
    acc(l.a[0], l.a[1]);
    acc(l.b[0], l.b[1]);
  }
  for (const c of circles) acc(c.center[0], c.center[1]);
  if (!any) return [0.5, 0.5];
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Tessellate a captured drag set (+ optional grabbed-feature highlights) into
 *  ghost line + circle buffers. Highlights are appended so they draw on top. */
export function buildGhostBuffers(
  set: DragPreviewSet,
  inputs: GhostBuildInputs,
  highlights?: GhostHighlights,
): GhostBuffers {
  const baseAlpha = byteClamp(inputs.fillAlpha);

  const lines: LinePrim[] = [];
  const circles: CirclePrim[] = [];
  for (const f of set.features) {
    if (isLine(f)) {
      const a = f.coords[0]!;
      const b = f.coords[f.coords.length - 1]!;
      lines.push({
        a, b,
        moveA: movesVertex(f.movingEnd, 0, 2) ? 1 : 0,
        moveB: movesVertex(f.movingEnd, 1, 2) ? 1 : 0,
        color: inputs.colorFor(f),
        alpha: baseAlpha,
        widthMul: inputs.widthMulFor(f),
      });
    } else if (isPoint(f)) {
      circles.push({
        center: f.coords[0]!,
        move: movesVertex(f.movingEnd, 0, 1) ? 1 : 0,
        fill: inputs.colorFor(f),
        stroke: inputs.strokeColor,
        fillAlpha: baseAlpha,
        strokeAlpha: 255,
        sizeMul: 1,
        strokeMul: 1,
      });
    }
  }

  // Highlight pass LAST -> drawn on top of the base moving copy.
  for (const s of highlights?.shots ?? []) {
    lines.push({
      a: s.a, b: s.b,
      moveA: movesVertex(s.movingEnd, 0, 2) ? 1 : 0,
      moveB: movesVertex(s.movingEnd, 1, 2) ? 1 : 0,
      color: s.color,
      alpha: byteClamp(s.opacity),
      widthMul: s.widthMul,
    });
  }
  for (const st of highlights?.stations ?? []) {
    circles.push({
      center: st.coord,
      move: movesVertex(st.movingEnd, 0, 1) ? 1 : 0,
      fill: st.fill,
      stroke: st.stroke,
      fillAlpha: byteClamp(st.opacity),
      strokeAlpha: byteClamp(st.opacity),
      sizeMul: st.sizeMul,
      strokeMul: st.strokeMul,
    });
  }

  const [anchorX, anchorY] = computeAnchor(lines, circles);
  return {
    anchorX, anchorY,
    line: buildLine(lines, anchorX, anchorY),
    circle: buildCircle(circles, anchorX, anchorY),
  };
}

function buildLine(prims: LinePrim[], anchorX: number, anchorY: number): GhostLineBuffers {
  const segmentCount = prims.length;
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
    const p = prims[seg]!;
    const [ax, ay] = lngLatToMercator(p.a[0], p.a[1]);
    const [bx, by] = lngLatToMercator(p.b[0], p.b[1]);
    const [cr, cg, cb] = p.color;
    const base = seg * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      posA[v * 2] = ax - anchorX;
      posA[v * 2 + 1] = ay - anchorY;
      posB[v * 2] = bx - anchorX;
      posB[v * 2 + 1] = by - anchorY;
      endpoint[v] = LINE_EP[c]!;
      side[v] = LINE_SIDE[c]!;
      moveA[v] = p.moveA;
      moveB[v] = p.moveB;
      color[v * 4] = cr;
      color[v * 4 + 1] = cg;
      color[v * 4 + 2] = cb;
      color[v * 4 + 3] = p.alpha;
      widthMul[v] = p.widthMul;
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

function buildCircle(prims: CirclePrim[], anchorX: number, anchorY: number): GhostCircleBuffers {
  const stationCount = prims.length;
  const vertexCount = stationCount * 4;
  const center = new Float32Array(vertexCount * 2);
  const corner = new Float32Array(vertexCount * 2);
  const move = new Float32Array(vertexCount);
  const fill = new Uint8Array(vertexCount * 4);
  const stroke = new Uint8Array(vertexCount * 4);
  const sizeMul = new Float32Array(vertexCount);
  const strokeMul = new Float32Array(vertexCount);
  const indices = new Uint32Array(stationCount * 6);

  for (let st = 0; st < stationCount; st++) {
    const p = prims[st]!;
    const [mx, my] = lngLatToMercator(p.center[0], p.center[1]);
    const [fr, fg, fb] = p.fill;
    const [sr, sg, sb] = p.stroke;
    const base = st * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      center[v * 2] = mx - anchorX;
      center[v * 2 + 1] = my - anchorY;
      corner[v * 2] = CIRCLE_CX[c]!;
      corner[v * 2 + 1] = CIRCLE_CY[c]!;
      move[v] = p.move;
      fill[v * 4] = fr;
      fill[v * 4 + 1] = fg;
      fill[v * 4 + 2] = fb;
      fill[v * 4 + 3] = p.fillAlpha;
      stroke[v * 4] = sr;
      stroke[v * 4 + 1] = sg;
      stroke[v * 4 + 2] = sb;
      stroke[v * 4 + 3] = p.strokeAlpha;
      sizeMul[v] = p.sizeMul;
      strokeMul[v] = p.strokeMul;
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
    stroke.byteLength + sizeMul.byteLength + strokeMul.byteLength + indices.byteLength;
  return { stationCount, vertexCount, center, corner, move, fill, stroke, sizeMul, strokeMul, indices, byteLength };
}
