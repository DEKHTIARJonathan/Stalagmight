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
import { type SurveyData, SHOT_FLAG_IS_REFERENCE } from '../../../../types/survey-data';
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
  /** Per-vertex reference flag (1 = reference shot, else 0). Mirrors the stock
   *  shots layer's `isReference` property: the shader dims reference shots to
   *  0.5 opacity and collapses them when reference shots are hidden. */
  reference: Float32Array;
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
  /** Per-vertex all-reference flag (1 = every shot touching this station is a
   *  reference shot, else 0). Mirrors the stock stations layer's
   *  `allShotsReference` property: the shader collapses these stations when
   *  reference shots are hidden (`setShowReferenceShots(false)`). */
  allReference: Float32Array;
  /** Two triangles per station, `stationCount*6`, `UNSIGNED_INT`. */
  indices: Uint32Array;
  byteLength: number;
}

/**
 * Which features the custom buffers must SKIP, mirroring the MapLibre
 * setFilter exclusions the stock bulk layers apply during a move drag
 * (SurveyLayer.beginDragPreview / beginStationDragPreview). Without this the
 * custom layer keeps drawing the originals under the drag preview.
 *
 * Key types are chosen so the SoA iteration can test membership O(1):
 *  - `sectionIds`         : segment drag hides whole connected sections (both
 *                           shots and stations) — tested against `section.id`
 *                           (lines) and `data.stationSectionIds[g]` (circles).
 *  - `stationGlobalIndices`: station / shot move hides specific stations —
 *                           tested against the circle loop's global index `g`.
 *  - `shotGlobalIndices`  : station / shot move hides specific shots — tested
 *                           against the line loop's `section.shotOffset + i`.
 *
 * All fields optional; an absent (or `undefined`) exclusion is the zero-cost
 * hot path (`undefined?.has(...)` short-circuits, no allocation).
 */
export interface CustomRenderExclusion {
  sectionIds?: ReadonlySet<number>;
  stationGlobalIndices?: ReadonlySet<number>;
  shotGlobalIndices?: ReadonlySet<number>;
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
 * Per global station index: 1 when every shot touching the station is a
 * reference shot (or the station has no shots at all), else 0. Mirrors
 * `buildSurveyFeatures`' `allShotsReference` property (features.ts): a station
 * is "all-reference" unless some non-reference shot names it as an endpoint.
 * `setShowReferenceShots(false)` hides exactly these stations in the stock
 * layer, so the custom layer needs the same per-station flag to match.
 */
export function computeStationAllReference(
  data: SurveyData,
  lookup: Map<number, Map<number, number>>,
): Float32Array {
  // Start all-reference; clear the flag for any station an unhidden
  // (non-reference) shot connects to.
  const allRef = new Float32Array(data.stationCount).fill(1);
  for (const section of data.sections) {
    const inner = lookup.get(section.id);
    if (!inner) continue;
    for (let i = 0; i < section.shotCount; i++) {
      const shotGlobalIdx = section.shotOffset + i;
      const fromGlobal = inner.get(i);
      const toGlobal = inner.get(i + 1);
      // Only VALID shots (both endpoints present) count, matching the stock
      // build's `stationsWithNonReferenceShot` (features.ts) and the set of
      // shots the line buffers actually draw.
      if (fromGlobal === undefined || toGlobal === undefined) continue;
      const isReference = (data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0;
      if (isReference) continue;
      allRef[fromGlobal] = 0;
      allRef[toGlobal] = 0;
    }
  }
  return allRef;
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

/** Count valid shots (both endpoints present), matching vtSurveyBuild. When
 *  `exclude` is given, excluded sections / shots are skipped so the count stays
 *  in lock-step with {@link buildLineBuffers}. */
export function countValidShots(
  data: SurveyData,
  lookup: Map<number, Map<number, number>>,
  exclude?: CustomRenderExclusion,
): number {
  const exSections = exclude?.sectionIds;
  const exShots = exclude?.shotGlobalIndices;
  let count = 0;
  for (const section of data.sections) {
    if (exSections?.has(section.id)) continue;
    const inner = lookup.get(section.id);
    if (!inner) continue;
    for (let i = 0; i < section.shotCount; i++) {
      if (exShots?.has(section.shotOffset + i)) continue;
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
 *
 * `colorForShotEndpoints`, when supplied, wins over `colorForShot`: it returns
 * `[fromColor, toColor]` and the two A-vertices get the from-color while the
 * two B-vertices get the to-color, so the GPU interpolates a per-shot color
 * ramp along the segment. This reproduces the stock `survey-shot-gradients`
 * layer's depth ramp (from-endpoint depth color -> to-endpoint depth color)
 * natively, with no gradient sub-segments. Absent -> the flat, whole-segment
 * `colorForShot` path (byte-identical to the previous behavior).
 */
export function buildLineBuffers(
  data: SurveyData,
  stationRel: StationRel,
  lookup: Map<number, Map<number, number>>,
  colorForShot: (globalShotIdx: number, sectionId: number) => Rgba8,
  exclude?: CustomRenderExclusion,
  colorForShotEndpoints?: (globalShotIdx: number, sectionId: number) => readonly [Rgba8, Rgba8],
): LineBuffers {
  const exSections = exclude?.sectionIds;
  const exShots = exclude?.shotGlobalIndices;
  const segmentCount = countValidShots(data, lookup, exclude);
  const vertexCount = segmentCount * 4;
  const posA = new Float32Array(vertexCount * 2);
  const posB = new Float32Array(vertexCount * 2);
  const endpoint = new Float32Array(vertexCount);
  const side = new Float32Array(vertexCount);
  const color = new Uint8Array(vertexCount * 4);
  const reference = new Float32Array(vertexCount);
  const indices = new Uint32Array(segmentCount * 6);

  // Per-segment vertex template: [endpoint, side] for the 4 corners.
  // v0 A-left, v1 A-right, v2 B-left, v3 B-right.
  const EP = [0, 0, 1, 1];
  const SIDE = [-1, 1, -1, 1];

  let seg = 0;
  for (const section of data.sections) {
    if (exSections?.has(section.id)) continue;
    const inner = lookup.get(section.id);
    if (!inner) continue;
    for (let i = 0; i < section.shotCount; i++) {
      const shotGlobalIdx = section.shotOffset + i;
      if (exShots?.has(shotGlobalIdx)) continue;
      const fromGlobal = inner.get(i);
      const toGlobal = inner.get(i + 1);
      if (fromGlobal === undefined || toGlobal === undefined) continue;
      // Per-endpoint colors (depth gradient) win; else the flat segment color
      // at both ends. `EP[c]` selects the A (0) or B (1) color per vertex.
      const ends = colorForShotEndpoints?.(shotGlobalIdx, section.id);
      const colA = ends ? ends[0] : colorForShot(shotGlobalIdx, section.id);
      const colB = ends ? ends[1] : colA;
      const isRef =
        (data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0 ? 1 : 0;
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
        const [r, g, b, a] = EP[c] === 0 ? colA : colB;
        color[v * 4] = r;
        color[v * 4 + 1] = g;
        color[v * 4 + 2] = b;
        color[v * 4 + 3] = a;
        reference[v] = isRef;
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
    color.byteLength + reference.byteLength + indices.byteLength;
  return {
    segmentCount, vertexCount, posA, posB, endpoint, side, color, reference, indices, byteLength,
  };
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
  exclude?: CustomRenderExclusion,
  allReferenceFlags?: Float32Array,
): CircleBuffers {
  const exSections = exclude?.sectionIds;
  const exStations = exclude?.stationGlobalIndices;
  const skip = (g: number): boolean =>
    exStations?.has(g) === true || exSections?.has(data.stationSectionIds[g]!) === true;

  // Count first only when an exclusion is present; the no-exclusion hot path
  // keeps every station and skips the extra pass entirely.
  let stationCount = data.stationCount;
  if (exStations || exSections) {
    stationCount = 0;
    for (let g = 0; g < data.stationCount; g++) if (!skip(g)) stationCount++;
  }
  const vertexCount = stationCount * 4;
  const center = new Float32Array(vertexCount * 2);
  const corner = new Float32Array(vertexCount * 2);
  const fill = new Uint8Array(vertexCount * 4);
  const stroke = new Uint8Array(vertexCount * 4);
  const allReference = new Float32Array(vertexCount);
  const indices = new Uint32Array(stationCount * 6);

  // Unit corners: v0 bottom-left, v1 bottom-right, v2 top-right, v3 top-left.
  const CX = [-1, 1, 1, -1];
  const CY = [-1, -1, 1, 1];

  let out = 0;
  for (let g = 0; g < data.stationCount; g++) {
    if (skip(g)) continue;
    const cx = stationRel[g * 2]!;
    const cy = stationRel[g * 2 + 1]!;
    const [fr, fg, fb, fa] = fillForStation(g);
    const [sr, sg, sb, sa] = strokeForStation(g);
    const allRef = allReferenceFlags ? allReferenceFlags[g]! : 0;
    const base = out * 4;
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
      allReference[v] = allRef;
    }
    const io = out * 6;
    indices[io] = base;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base;
    indices[io + 4] = base + 2;
    indices[io + 5] = base + 3;
    out++;
  }

  const byteLength =
    center.byteLength + corner.byteLength + fill.byteLength + stroke.byteLength +
    allReference.byteLength + indices.byteLength;
  return {
    stationCount, vertexCount, center, corner, fill, stroke, allReference, indices, byteLength,
  };
}
