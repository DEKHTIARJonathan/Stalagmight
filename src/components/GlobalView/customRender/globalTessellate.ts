/**
 * SoA -> WebGL vertex buffers for the global view's custom survey layer
 * (#customRender). Sibling of `Map/surveyLayer/customRender/tessellate.ts`,
 * tailored to the global view's data shape: an array of systems, each already
 * carrying GPS-transformed `[lng, lat]` shot endpoints (SurveyGeometry), rather
 * than the single-system meters SoA.
 *
 * Pure (no GL, no DOM) so the whole build is unit-testable in the `node` vitest
 * env. Reuses the shared anchor-relative float32 mercator scheme (magnitudes
 * stay small near the anchor; the large anchor translation is folded back into
 * the per-frame float64 matrix by `composeAnchorMatrix`) and the shared
 * `packCssColor` (extended for `hsl(...)`, which is what generateSystemColor
 * emits).
 *
 * LINES (shots): each shot is an independent butt-cap quad (2 triangles), just
 * like the single-system layer; joins are covered by the station discs. CIRCLES
 * (stations): one quad per unique station, drawn as a disc + stroke ring in the
 * fragment shader.
 *
 * Per-vertex emphasis attributes bake the stock global layers' paint cases:
 *  - `system`   : the system's index (matched against the hover uniform).
 *  - `selected` : 1 when the vertex's system is in the selection set.
 *  - `dim`      : 1 when the vertex's system does NOT match the search term.
 *  - `reference`: for LINES the ShotKind discriminant (0 Normal / 1 Jump /
 *    2 Reference, #27); for CIRCLES still a 0/1 all-reference flag.
 */
import type { GeometryShot } from '../../../types/survey';
import { lngLatToMercator } from '../../Map/surveyLayer/mercatorCoords';
import { packCssColor } from '../../Map/surveyLayer/customRender/colorPack';
import { generateSystemColor, type SystemGeometry } from '../systemColor';

/**
 * Extract unique station positions from a system's shots. Returns
 * `[lng, lat, allShotsReference]` per unique station; `allShotsReference` is
 * true when the station only ever appears on reference shots. Mirrors the stock
 * global build's station derivation (the shared single source of truth for both
 * the vector-tile path and the custom render path).
 */
export function extractSystemStations(shots: GeometryShot[]): [number, number, boolean][] {
  const stationCoords = new Map<string, [number, number]>();
  const stationsWithNonReferenceShot = new Set<string>();

  for (const shot of shots) {
    let fromKey: string | undefined;
    let toKey: string | undefined;

    if (shot.from.length >= 2) {
      const fromX = shot.from[0];
      const fromY = shot.from[1];
      if (fromX === undefined || fromY === undefined) continue;
      fromKey = `${fromX.toFixed(8)},${fromY.toFixed(8)}`;
      if (!stationCoords.has(fromKey)) stationCoords.set(fromKey, [fromX, fromY]);
    }
    if (shot.to.length >= 2) {
      const toX = shot.to[0];
      const toY = shot.to[1];
      if (toX === undefined || toY === undefined) continue;
      toKey = `${toX.toFixed(8)},${toY.toFixed(8)}`;
      if (!stationCoords.has(toKey)) stationCoords.set(toKey, [toX, toY]);
    }

    if (shot.kind === 'Normal') {
      if (fromKey) stationsWithNonReferenceShot.add(fromKey);
      if (toKey) stationsWithNonReferenceShot.add(toKey);
    }
  }

  return Array.from(stationCoords.entries()).map(([key, coords]) => [
    coords[0],
    coords[1],
    !stationsWithNonReferenceShot.has(key),
  ]);
}

/** GPU-ready shot-quad buffers for all systems. */
export interface GlobalLineBuffers {
  segmentCount: number;
  vertexCount: number;
  /** Endpoint A / B of each vertex's segment (anchor-relative), `vertexCount*2`. */
  posA: Float32Array;
  posB: Float32Array;
  /** 0 at endpoint A, 1 at endpoint B. */
  endpoint: Float32Array;
  /** Extrusion side -1 / +1 (also the AA cross-width coordinate). */
  side: Float32Array;
  /** Per-vertex RGBA8 (the system color). */
  color: Uint8Array;
  /** Per-vertex ShotKind discriminant: 0 Normal / 1 Jump / 2 Reference (#27). */
  reference: Float32Array;
  /** Per-vertex search-dim flag (1 = system does not match the search term). */
  dim: Float32Array;
  /** Per-vertex system index (matched against the hover uniform). */
  system: Float32Array;
  /** Per-vertex selection flag (1 = system is selected). */
  selected: Float32Array;
  /** Two triangles per segment, `segmentCount*6`, `UNSIGNED_INT`. */
  indices: Uint32Array;
  byteLength: number;
}

/** GPU-ready station-quad buffers for all systems. */
export interface GlobalCircleBuffers {
  stationCount: number;
  vertexCount: number;
  /** Station center (anchor-relative), `vertexCount*2`. */
  center: Float32Array;
  /** Unit quad corner, `vertexCount*2`. */
  corner: Float32Array;
  /** Per-vertex fill RGBA8 (the system color). Stroke is a shader uniform. */
  fill: Uint8Array;
  /** Per-vertex all-reference flag (1 = station only touches reference shots). */
  allReference: Float32Array;
  dim: Float32Array;
  system: Float32Array;
  selected: Float32Array;
  indices: Uint32Array;
  byteLength: number;
}

/** Everything the buffer builder needs beyond the systems themselves. */
export interface GlobalBuildOptions {
  /** Lowercased search term; a system dims unless its name contains it. Null =
   *  no filter (nothing dims). */
  searchTerm: string | null;
  /** Selected system file paths (baked into the per-vertex `selected` flag). */
  selectedIds: ReadonlySet<string>;
}

/** Build products plus the maps the controller needs for cheap refreshes. */
export interface GlobalBuildResult {
  anchorX: number;
  anchorY: number;
  line: GlobalLineBuffers;
  circle: GlobalCircleBuffers;
  /** system file_path -> its dense index (the value baked into `system`). */
  systemIndex: Map<string, number>;
}

/** True when the system's name does not contain the (lowercased) search term. */
function isDimmed(name: string, searchTerm: string | null): boolean {
  if (!searchTerm) return false;
  return !name.toLowerCase().includes(searchTerm);
}

/**
 * Anchor = mercator center of the bounding box over every system's station
 * positions. Keeps anchor-relative float32 magnitudes small. Returns the
 * mercator world center `[0.5, 0.5]` when there is no geometry.
 */
function computeAnchor(systems: SystemGeometry[]): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const system of systems) {
    for (const shot of system.geometry.shots) {
      for (const p of [shot.from, shot.to]) {
        if (p.length < 2 || p[0] === undefined || p[1] === undefined) continue;
        const [mx, my] = lngLatToMercator(p[0], p[1]);
        if (mx < minX) minX = mx;
        if (my < minY) minY = my;
        if (mx > maxX) maxX = mx;
        if (my > maxY) maxY = my;
        any = true;
      }
    }
  }
  if (!any) return [0.5, 0.5];
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Count shots with both endpoints present (the drawn segments). */
function countSegments(systems: SystemGeometry[]): number {
  let count = 0;
  for (const system of systems) {
    for (const shot of system.geometry.shots) {
      if (shot.from.length >= 2 && shot.to.length >= 2) count++;
    }
  }
  return count;
}

const LINE_EP = [0, 0, 1, 1];
const LINE_SIDE = [-1, 1, -1, 1];
const CIRCLE_CX = [-1, 1, 1, -1];
const CIRCLE_CY = [-1, -1, 1, 1];

/**
 * Build the shot-quad + station-quad buffers for every system, resolving each
 * system's stable hash color once. The single pass that both the initial upload
 * and a full-rebuild path use.
 */
export function buildGlobalBuffers(
  systems: SystemGeometry[],
  opts: GlobalBuildOptions,
): GlobalBuildResult {
  const [anchorX, anchorY] = computeAnchor(systems);
  const systemIndex = new Map<string, number>();

  const segmentCount = countSegments(systems);
  const lineVerts = segmentCount * 4;
  const line: GlobalLineBuffers = {
    segmentCount,
    vertexCount: lineVerts,
    posA: new Float32Array(lineVerts * 2),
    posB: new Float32Array(lineVerts * 2),
    endpoint: new Float32Array(lineVerts),
    side: new Float32Array(lineVerts),
    color: new Uint8Array(lineVerts * 4),
    reference: new Float32Array(lineVerts),
    dim: new Float32Array(lineVerts),
    system: new Float32Array(lineVerts),
    selected: new Float32Array(lineVerts),
    indices: new Uint32Array(segmentCount * 6),
    byteLength: 0,
  };

  // Station quads are appended per system; the total is not known up front
  // (dedup is per system), so collect into growable arrays then pack.
  const centerList: number[] = [];
  const fillList: number[] = [];
  const allRefList: number[] = [];
  const dimList: number[] = [];
  const systemList: number[] = [];
  const selectedList: number[] = [];

  let seg = 0;
  for (const system of systems) {
    const filePath = system.metadata.file_path;
    let si = systemIndex.get(filePath);
    if (si === undefined) {
      si = systemIndex.size;
      systemIndex.set(filePath, si);
    }
    const [cr, cg, cb, ca] = packCssColor(generateSystemColor(filePath));
    const dim = isDimmed(system.metadata.name, opts.searchTerm) ? 1 : 0;
    const sel = opts.selectedIds.has(filePath) ? 1 : 0;

    for (const shot of system.geometry.shots) {
      if (shot.from.length < 2 || shot.to.length < 2) continue;
      const [ax, ay] = lngLatToMercator(shot.from[0]!, shot.from[1]!);
      const [bx, by] = lngLatToMercator(shot.to[0]!, shot.to[1]!);
      const relAx = ax - anchorX;
      const relAy = ay - anchorY;
      const relBx = bx - anchorX;
      const relBy = by - anchorY;
      // The ShotKind discriminant, not a bool (#27): the global shader dims a
      // Reference further than a Jump, so collapsing them here would drop the
      // distinction before the shader ever sees it.
      const kindBit = shot.kind === 'Jump' ? 1 : shot.kind === 'Reference' ? 2 : 0;
      const base = seg * 4;
      for (let c = 0; c < 4; c++) {
        const v = base + c;
        line.posA[v * 2] = relAx;
        line.posA[v * 2 + 1] = relAy;
        line.posB[v * 2] = relBx;
        line.posB[v * 2 + 1] = relBy;
        line.endpoint[v] = LINE_EP[c]!;
        line.side[v] = LINE_SIDE[c]!;
        line.color[v * 4] = cr;
        line.color[v * 4 + 1] = cg;
        line.color[v * 4 + 2] = cb;
        line.color[v * 4 + 3] = ca;
        line.reference[v] = kindBit;
        line.dim[v] = dim;
        line.system[v] = si;
        line.selected[v] = sel;
      }
      const io = seg * 6;
      line.indices[io] = base;
      line.indices[io + 1] = base + 1;
      line.indices[io + 2] = base + 2;
      line.indices[io + 3] = base + 2;
      line.indices[io + 4] = base + 1;
      line.indices[io + 5] = base + 3;
      seg++;
    }

    for (const [lng, lat, allRef] of extractSystemStations(system.geometry.shots)) {
      const [mx, my] = lngLatToMercator(lng, lat);
      centerList.push(mx - anchorX, my - anchorY);
      fillList.push(cr, cg, cb, ca);
      allRefList.push(allRef ? 1 : 0);
      dimList.push(dim);
      systemList.push(si);
      selectedList.push(sel);
    }
  }

  line.byteLength =
    line.posA.byteLength + line.posB.byteLength + line.endpoint.byteLength +
    line.side.byteLength + line.color.byteLength + line.reference.byteLength +
    line.dim.byteLength + line.system.byteLength + line.selected.byteLength +
    line.indices.byteLength;

  const circle = packCircleBuffers(centerList, fillList, allRefList, dimList, systemList, selectedList);
  return { anchorX, anchorY, line, circle, systemIndex };
}

/** Expand the per-station scalar lists into interleaved quad buffers. */
function packCircleBuffers(
  centerList: number[],
  fillList: number[],
  allRefList: number[],
  dimList: number[],
  systemList: number[],
  selectedList: number[],
): GlobalCircleBuffers {
  const stationCount = allRefList.length;
  const verts = stationCount * 4;
  const center = new Float32Array(verts * 2);
  const corner = new Float32Array(verts * 2);
  const fill = new Uint8Array(verts * 4);
  const allReference = new Float32Array(verts);
  const dim = new Float32Array(verts);
  const system = new Float32Array(verts);
  const selected = new Float32Array(verts);
  const indices = new Uint32Array(stationCount * 6);

  for (let s = 0; s < stationCount; s++) {
    const cx = centerList[s * 2]!;
    const cy = centerList[s * 2 + 1]!;
    const fr = fillList[s * 4]!;
    const fg = fillList[s * 4 + 1]!;
    const fb = fillList[s * 4 + 2]!;
    const fa = fillList[s * 4 + 3]!;
    const base = s * 4;
    for (let c = 0; c < 4; c++) {
      const v = base + c;
      center[v * 2] = cx;
      center[v * 2 + 1] = cy;
      corner[v * 2] = CIRCLE_CX[c]!;
      corner[v * 2 + 1] = CIRCLE_CY[c]!;
      fill[v * 4] = fr;
      fill[v * 4 + 1] = fg;
      fill[v * 4 + 2] = fb;
      fill[v * 4 + 3] = fa;
      allReference[v] = allRefList[s]!;
      dim[v] = dimList[s]!;
      system[v] = systemList[s]!;
      selected[v] = selectedList[s]!;
    }
    const io = s * 6;
    indices[io] = base;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base;
    indices[io + 4] = base + 2;
    indices[io + 5] = base + 3;
  }

  const byteLength =
    center.byteLength + corner.byteLength + fill.byteLength + allReference.byteLength +
    dim.byteLength + system.byteLength + selected.byteLength + indices.byteLength;
  return {
    stationCount,
    vertexCount: verts,
    center,
    corner,
    fill,
    allReference,
    dim,
    system,
    selected,
    indices,
    byteLength,
  };
}

/**
 * Recompute per-vertex search-dim flags for `line` + `circle` in place from a
 * per-system predicate, keyed by the baked `system` index. Cheap refresh for a
 * search-term change (no reprojection, no color re-pack); the caller re-uploads
 * only the two dim buffers.
 */
export function recomputeDimFlags(
  line: GlobalLineBuffers,
  circle: GlobalCircleBuffers,
  dimForSystemIndex: (index: number) => boolean,
): void {
  for (let v = 0; v < line.vertexCount; v++) line.dim[v] = dimForSystemIndex(line.system[v]!) ? 1 : 0;
  for (let v = 0; v < circle.vertexCount; v++) circle.dim[v] = dimForSystemIndex(circle.system[v]!) ? 1 : 0;
}

/**
 * Recompute per-vertex selection flags for `line` + `circle` in place from a
 * per-system predicate. Cheap refresh for a selection change; the caller
 * re-uploads only the two selected buffers.
 */
export function recomputeSelectedFlags(
  line: GlobalLineBuffers,
  circle: GlobalCircleBuffers,
  selectedForSystemIndex: (index: number) => boolean,
): void {
  for (let v = 0; v < line.vertexCount; v++) {
    line.selected[v] = selectedForSystemIndex(line.system[v]!) ? 1 : 0;
  }
  for (let v = 0; v < circle.vertexCount; v++) {
    circle.selected[v] = selectedForSystemIndex(circle.system[v]!) ? 1 : 0;
  }
}
