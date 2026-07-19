/**
 * SoA -> WebGL vertex buffers for the custom-render prototype (#customRender).
 *
 * Pure (no GL, no DOM): builds typed-array vertex + index buffers straight from
 * `SurveyData`, so the whole tessellation / anchor-relative / sizing story is
 * unit-testable in the `node` vitest environment. The GL layer
 * (`surveyCustomLayer.ts`) just uploads what these return.
 *
 * LINES (shots): screen-space-width antialiased lines, MapLibre-style per-segment
 * quads extruded along the segment normal in the vertex shader. Tessellation is
 * SIMPLIFIED vs MapLibre: each valid shot is an INDEPENDENT butt-cap quad (2
 * triangles) — no miter / bevel joins, no round caps. Joins between consecutive
 * shots are visually covered by the station circles drawn at each vertex (the
 * same way the stock circle layer sits over the stock line joins), so butt caps
 * read as credible at cave scale. The extrusion + edge-feather math is lifted
 * from MapLibre GL JS `src/shaders/line.{vertex,fragment}.glsl` (BSD-3-Clause);
 * see `shaders.ts`.
 *
 * CIRCLES (stations): one quad per station, the disc + stroke ring drawn in the
 * fragment shader with a feathered edge (`shaders.ts`).
 *
 * Valid-shot selection mirrors `vtSurveyBuild.buildShotsPerFeature`: a shot
 * contributes only when both endpoint stations (`stationIndex` i and i+1) exist.
 * That keeps the custom layer's shot set identical to the stock shots layer.
 */
import type { GpsOrigin } from '../../../../types/config';
import type { SurveyData } from '../../../../types/survey-data';
import { metersToMapCoords } from '../../../../utils/coordinates';
import { lngLatToMercator } from '../vectorTileData';
import type { Rgba8 } from './colorPack';

/** Anchor-relative float32 station positions, interleaved `[x0,y0,x1,y1,...]`
 *  in global station-index order. */
export type StationRel = Float32Array;

export interface LineBuffers {
  segmentCount: number;
  vertexCount: number;
  /** Endpoint A of each vertex's segment (anchor-relative), `vertexCount*2`. */
  posA: Float32Array;
  /** Endpoint B of each vertex's segment (anchor-relative), `vertexCount*2`. */
  posB: Float32Array;
  /** 0 at endpoint A, 1 at endpoint B; selects which endpoint this vertex sits on. */
  endpoint: Float32Array;
  /** Physical extrusion side, -1 / +1; also the AA cross-width coordinate. */
  side: Float32Array;
  /** Per-vertex RGBA8. */
  color: Uint8Array;
  /** Two triangles per segment, `segmentCount*6`, `UNSIGNED_INT`. */
  indices: Uint32Array;
  /** Total attribute + index bytes (for cost logging). */
  byteLength: number;
}

export interface CircleBuffers {
  stationCount: number;
  vertexCount: number;
  /** Station center (anchor-relative), `vertexCount*2`. */
  center: Float32Array;
  /** Unit quad corner in {-1,-1}..{-1,1}, `vertexCount*2`. */
  corner: Float32Array;
  /** Per-vertex fill RGBA8. */
  fill: Uint8Array;
  /** Per-vertex stroke RGBA8. */
  stroke: Uint8Array;
  /** Two triangles per station, `stationCount*6`, `UNSIGNED_INT`. */
  indices: Uint32Array;
  byteLength: number;
}

/** (sectionId, stationIndex) -> global station index. Mirrors vtSurveyBuild. */
export function buildStationLookup(data: SurveyData): Map<number, Map<number, number>> {
  const lookup = new Map<number, Map<number, number>>();
  for (let g = 0; g < data.stationCount; g++) {
    const sid = data.stationSectionIds[g]!;
    let inner = lookup.get(sid);
    if (!inner) {
      inner = new Map();
      lookup.set(sid, inner);
    }
    inner.set(data.stationIndices[g]!, g);
  }
  return lookup;
}

/**
 * Project every station meters->mercator once and store anchor-relative float32.
 * Uses the SAME two-function pass as the vt build so the custom layer lands in
 * the same coordinate space as the stock layers.
 */
export function projectStationsRel(
  data: SurveyData,
  gpsOrigin: GpsOrigin | null,
  anchorX: number,
  anchorY: number,
): StationRel {
  const n = data.stationCount;
  const rel = new Float32Array(n * 2);
  for (let g = 0; g < n; g++) {
    const ll = metersToMapCoords(data.stationCoords[g * 3]!, data.stationCoords[g * 3 + 1]!, gpsOrigin);
    const [mx, my] = lngLatToMercator(ll[0], ll[1]);
    rel[g * 2] = mx - anchorX;
    rel[g * 2 + 1] = my - anchorY;
  }
  return rel;
}

/** Count valid shots (both endpoints present), matching vtSurveyBuild. */
export function countValidShots(data: SurveyData, lookup: Map<number, Map<number, number>>): number {
  let count = 0;
  for (const section of data.sections) {
    const inner = lookup.get(section.id);
    if (!inner) continue;
    for (let i = 0; i < section.shotCount; i++) {
      if (inner.get(i) !== undefined && inner.get(i + 1) !== undefined) count++;
    }
  }
  return count;
}

/**
 * Build the per-segment quad buffers for shots. Each valid shot becomes 4
 * vertices (A-left, A-right, B-left, B-right) and 6 indices (two triangles).
 * `colorForShot(globalShotIdx, sectionId)` resolves the packed RGBA for the
 * whole segment.
 */
export function buildLineBuffers(
  data: SurveyData,
  stationRel: StationRel,
  lookup: Map<number, Map<number, number>>,
  colorForShot: (globalShotIdx: number, sectionId: number) => Rgba8,
): LineBuffers {
  const segmentCount = countValidShots(data, lookup);
  const vertexCount = segmentCount * 4;
  const posA = new Float32Array(vertexCount * 2);
  const posB = new Float32Array(vertexCount * 2);
  const endpoint = new Float32Array(vertexCount);
  const side = new Float32Array(vertexCount);
  const color = new Uint8Array(vertexCount * 4);
  const indices = new Uint32Array(segmentCount * 6);

  // Per-segment vertex template: [endpoint, side] for the 4 corners.
  // v0 A-left, v1 A-right, v2 B-left, v3 B-right.
  const EP = [0, 0, 1, 1];
  const SIDE = [-1, 1, -1, 1];

  let seg = 0;
  for (const section of data.sections) {
    const inner = lookup.get(section.id);
    if (!inner) continue;
    for (let i = 0; i < section.shotCount; i++) {
      const fromGlobal = inner.get(i);
      const toGlobal = inner.get(i + 1);
      if (fromGlobal === undefined || toGlobal === undefined) continue;
      const shotGlobalIdx = section.shotOffset + i;
      const [r, g, b, a] = colorForShot(shotGlobalIdx, section.id);
      const ax = stationRel[fromGlobal * 2]!;
      const ay = stationRel[fromGlobal * 2 + 1]!;
      const bx = stationRel[toGlobal * 2]!;
      const by = stationRel[toGlobal * 2 + 1]!;

      const base = seg * 4;
      for (let c = 0; c < 4; c++) {
        const v = base + c;
        posA[v * 2] = ax;
        posA[v * 2 + 1] = ay;
        posB[v * 2] = bx;
        posB[v * 2 + 1] = by;
        endpoint[v] = EP[c]!;
        side[v] = SIDE[c]!;
        color[v * 4] = r;
        color[v * 4 + 1] = g;
        color[v * 4 + 2] = b;
        color[v * 4 + 3] = a;
      }
      const io = seg * 6;
      indices[io] = base;
      indices[io + 1] = base + 1;
      indices[io + 2] = base + 2;
      indices[io + 3] = base + 2;
      indices[io + 4] = base + 1;
      indices[io + 5] = base + 3;
      seg++;
    }
  }

  const byteLength =
    posA.byteLength + posB.byteLength + endpoint.byteLength + side.byteLength +
    color.byteLength + indices.byteLength;
  return { segmentCount, vertexCount, posA, posB, endpoint, side, color, indices, byteLength };
}

/**
 * Build the per-station quad buffers for station discs. Each station becomes 4
 * corner vertices and 6 indices. `fillForStation` / `strokeForStation` resolve
 * packed RGBA per station (global index).
 */
export function buildCircleBuffers(
  data: SurveyData,
  stationRel: StationRel,
  fillForStation: (globalIdx: number) => Rgba8,
  strokeForStation: (globalIdx: number) => Rgba8,
): CircleBuffers {
  const stationCount = data.stationCount;
  const vertexCount = stationCount * 4;
  const center = new Float32Array(vertexCount * 2);
  const corner = new Float32Array(vertexCount * 2);
  const fill = new Uint8Array(vertexCount * 4);
  const stroke = new Uint8Array(vertexCount * 4);
  const indices = new Uint32Array(stationCount * 6);

  // Unit corners: v0 bottom-left, v1 bottom-right, v2 top-right, v3 top-left.
  const CX = [-1, 1, 1, -1];
  const CY = [-1, -1, 1, 1];

  for (let g = 0; g < stationCount; g++) {
    const cx = stationRel[g * 2]!;
    const cy = stationRel[g * 2 + 1]!;
    const [fr, fg, fb, fa] = fillForStation(g);
    const [sr, sg, sb, sa] = strokeForStation(g);
    const base = g * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      center[v * 2] = cx;
      center[v * 2 + 1] = cy;
      corner[v * 2] = CX[c]!;
      corner[v * 2 + 1] = CY[c]!;
      fill[v * 4] = fr;
      fill[v * 4 + 1] = fg;
      fill[v * 4 + 2] = fb;
      fill[v * 4 + 3] = fa;
      stroke[v * 4] = sr;
      stroke[v * 4 + 1] = sg;
      stroke[v * 4 + 2] = sb;
      stroke[v * 4 + 3] = sa;
    }
    const io = g * 6;
    indices[io] = base;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base;
    indices[io + 4] = base + 2;
    indices[io + 5] = base + 3;
  }

  const byteLength =
    center.byteLength + corner.byteLength + fill.byteLength + stroke.byteLength + indices.byteLength;
  return { stationCount, vertexCount, center, corner, fill, stroke, indices, byteLength };
}
