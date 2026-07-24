/**
 * Compact survey vector-tile data model + on-demand MVT tile cutter (#mem).
 *
 * Why this exists: feeding MapLibre a bulk GeoJSON FeatureCollection (75k shot
 * lines / 89k station points / 14k labels on 92.stalx) runs it through a chain
 * of full-graph materializations — structured clone to its worker, a retained
 * `toUpdateable` Map, geojson-vt conversion + per-zoom tile cutting, a
 * GeoJSONWrapper retained per loaded tile, and a vt-pbf re-encode per tile.
 * On WebKitGTK the burst of interleaved live+transient allocations commits
 * bmalloc/libpas slabs that never decommit; measured on 92.stalx this pipeline
 * alone kept the webview's resting RSS ~1 GB above its live needs.
 *
 * Instead, each bulk layer's geometry lives here as a handful of flat typed
 * arrays (mercator-projected once, structured-clone/transfer friendly), and
 * tiles are cut on demand straight into Mapbox-Vector-Tile bytes: bbox filter
 * + Liang-Barsky segment clip + delta/zigzag encode. MapLibre's vector-tile
 * pipeline then holds only the compact pbf per loaded tile plus the render
 * buckets. Feature ids and properties are preserved exactly (MVT feature `id`
 * is first-class, so feature-state works without promoteId).
 *
 * This module is worker-safe (no maplibre import); the main-thread registry +
 * protocol handler lives in `vectorTileRegistry.ts`.
 */

import { lngLatToMercator } from './mercatorCoords';

export type VtPropValue = string | number | boolean;

/** A mercator [minX,minY,maxX,maxY] rectangle in [0,1] world space, used to
 *  scope a live tile reload to the region an edit touched. See the dirty-bounds
 *  diffing section below. */
export type VtDirtyBounds = [minX: number, minY: number, maxX: number, maxY: number];

/**
 * One bulk layer's geometry, struct-of-arrays style.
 *
 * Groups correspond 1:1 to the GeoJSON features they replace (merged
 * MultiLineString/MultiPoint groups, or per-feature lines/points in
 * per-feature mode). All coordinates for all groups share one flat
 * `coords` array; per-group ranges are delimited by offset arrays, so the
 * whole structure posts across workers with a fixed, tiny transfer list.
 */
export interface VtLayerData {
  kind: 'line' | 'point';
  /** MVT feature id per group (drives feature-state; matches the geojson
   *  path's promoted `featureId`). Float64 so encoded ids above 2^31
   *  (encodeFeatureId composites) survive untruncated. */
  ids: Float64Array;
  /** Feature properties per group (encoded as MVT tags). */
  props: Array<Record<string, VtPropValue>>;
  /** All points, mercator world space in [0,1]: [x0,y0, x1,y1, ...]. */
  coords: Float64Array;
  /** Per group: start POINT index, plus a terminal entry (length = groups+1).
   *  For point groups this fully describes the geometry. */
  groupPointOffsets: Uint32Array;
  /** Line kind only: start POINT index of every line across all groups,
   *  plus a terminal entry. */
  lineOffsets?: Uint32Array;
  /** Line kind only: per group, start LINE index into `lineOffsets`,
   *  plus a terminal entry (length = groups+1). */
  groupLineOffsets?: Uint32Array;
}

/**
 * Streamed feature-chunk payload: bulk groups arrive as `vt` (built in the
 * features worker, typed arrays moved via the transfer list); small groups
 * and the inline/sync build paths still deliver GeoJSON `features`.
 */
export type VtFeatureChunk =
  | { features: GeoJSON.Feature[]; vt?: undefined }
  | { features?: undefined; vt: VtLayerData };

/** Number of groups (features) in a layer. */
export function vtGroupCount(data: VtLayerData): number {
  return data.ids.length;
}

/** The ArrayBuffers to move in a postMessage transfer list. */
export function vtTransferables(data: VtLayerData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [
    data.ids.buffer as ArrayBuffer,
    data.coords.buffer as ArrayBuffer,
    data.groupPointOffsets.buffer as ArrayBuffer,
  ];
  if (data.lineOffsets) out.push(data.lineOffsets.buffer as ArrayBuffer);
  if (data.groupLineOffsets) out.push(data.groupLineOffsets.buffer as ArrayBuffer);
  // De-dupe (defensive: views could share a buffer).
  return [...new Set(out)];
}

// ─── Dirty-bounds diffing ─────────────────────────────────────────────────
//
// `VtDirtyBounds` (declared above with the data-model types) is a mercator
// [minX,minY,maxX,maxY] rectangle in [0,1] world space. It scopes a live tile
// reload to the region an edit actually touched, so unchanged tiles are never
// refetched. A diff returns `null` when nothing changed (the caller skips the
// reload entirely); a full, unbounded reload is signalled by omitting the
// bounds at the reload call site. Adapted from the budget branch, which read
// per-group bounds from a precomputed spatial index; this branch has no such
// index, so bounds are computed straight from the flat `coords` array.

/** Mercator bounds of one group's points, or null for an empty group. Works for
 *  both kinds: a line group's every point lives in the shared `coords` array
 *  delimited by `groupPointOffsets`, exactly like a point group. */
function groupBounds(data: VtLayerData, gi: number): VtDirtyBounds | null {
  const start = data.groupPointOffsets[gi]!;
  const end = data.groupPointOffsets[gi + 1]!;
  if (end <= start) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let p = start; p < end; p++) {
    const x = data.coords[p * 2]!;
    const y = data.coords[p * 2 + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Union `group` into `bounds` (either may be null). */
function extendDirtyBounds(
  bounds: VtDirtyBounds | null,
  group: VtDirtyBounds | null,
): VtDirtyBounds | null {
  if (!group) return bounds;
  if (!bounds) return [group[0], group[1], group[2], group[3]];
  bounds[0] = Math.min(bounds[0], group[0]);
  bounds[1] = Math.min(bounds[1], group[1]);
  bounds[2] = Math.max(bounds[2], group[2]);
  bounds[3] = Math.max(bounds[3], group[3]);
  return bounds;
}

/** Whether two groups carry identical MVT properties. (This branch does not
 *  stamp geometry/style generation onto props, so every key is significant —
 *  no revision keys to filter out, unlike the budget branch.) */
function equalProps(
  a: Record<string, VtPropValue>,
  b: Record<string, VtPropValue>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/** Whether two groups have identical geometry: the same point coordinates and,
 *  for lines, the same per-line topology. Reads offsets straight off the flat
 *  arrays. */
function equalGroupGeometry(a: VtLayerData, ai: number, b: VtLayerData, bi: number): boolean {
  const aStart = a.groupPointOffsets[ai]!;
  const aEnd = a.groupPointOffsets[ai + 1]!;
  const bStart = b.groupPointOffsets[bi]!;
  const bEnd = b.groupPointOffsets[bi + 1]!;
  if (aEnd - aStart !== bEnd - bStart) return false;
  for (let offset = 0; offset < (aEnd - aStart) * 2; offset++) {
    if (a.coords[aStart * 2 + offset] !== b.coords[bStart * 2 + offset]) return false;
  }
  if (a.kind === 'point' && b.kind === 'point') return true;
  if (a.kind !== 'line' || b.kind !== 'line') return false;
  const aGroupLines = a.groupLineOffsets!;
  const bGroupLines = b.groupLineOffsets!;
  const aLineStart = aGroupLines[ai]!;
  const aLineEnd = aGroupLines[ai + 1]!;
  const bLineStart = bGroupLines[bi]!;
  const bLineEnd = bGroupLines[bi + 1]!;
  if (aLineEnd - aLineStart !== bLineEnd - bLineStart) return false;
  for (let offset = 0; offset <= aLineEnd - aLineStart; offset++) {
    if (
      a.lineOffsets![aLineStart + offset]! - aStart !==
      b.lineOffsets![bLineStart + offset]! - bStart
    ) return false;
  }
  return true;
}

/**
 * Union the old and new bounds of every changed feature group. Groups are
 * emitted in deterministic order, so unchanged prefixes and stable-topology
 * edits stay sharply bounded. An insert/delete shifts later groups and
 * conservatively expands the union (a broader reload, still correct). Returns
 * null when nothing changed so the caller can skip the reload entirely.
 */
export function diffVtLayerBounds(previous: VtLayerData, next: VtLayerData): VtDirtyBounds | null {
  const common = Math.min(vtGroupCount(previous), vtGroupCount(next));
  let dirty: VtDirtyBounds | null = null;
  for (let gi = 0; gi < common; gi++) {
    const equal =
      previous.kind === next.kind &&
      previous.ids[gi] === next.ids[gi] &&
      equalProps(previous.props[gi]!, next.props[gi]!) &&
      equalGroupGeometry(previous, gi, next, gi);
    if (equal) continue;
    dirty = extendDirtyBounds(dirty, groupBounds(previous, gi));
    dirty = extendDirtyBounds(dirty, groupBounds(next, gi));
  }
  for (let gi = common; gi < vtGroupCount(previous); gi++) {
    dirty = extendDirtyBounds(dirty, groupBounds(previous, gi));
  }
  for (let gi = common; gi < vtGroupCount(next); gi++) {
    dirty = extendDirtyBounds(dirty, groupBounds(next, gi));
  }
  return dirty;
}

/**
 * Whether `next` changes the group *structure* relative to `previous`: a
 * different group count, or a different group-identity sequence (layer `kind`,
 * plus each group's MVT id and `sectionId`). Pure geometry edits — moves that
 * keep every group's identity in place — are NOT structural.
 *
 * A structural edit (delete / merge / split / reorder, and the undo of any of
 * them) can empty resident tiles wholesale as groups vanish or shift between
 * tiles. The index-aligned rectangle diff stays correct for these, but a
 * *bounded* reload of that rectangle is only as reliable as the weakest tile it
 * skips or a superseding publication leaves stale. The caller answers a
 * structural change with a full in-place reload instead (bounds omitted), which
 * re-cuts every resident tile and resets the whole out-of-view cache, so no tile
 * that lost its geometry can be left rendering the pre-edit bucket. In-place
 * full reloads never blank (resident tiles stay renderable while re-cutting), so
 * the no-flash property is preserved. Cheap: one pass, no coordinate reads.
 */
export function isStructuralChange(previous: VtLayerData, next: VtLayerData): boolean {
  if (previous.kind !== next.kind) return true;
  const count = vtGroupCount(previous);
  if (count !== vtGroupCount(next)) return true;
  for (let gi = 0; gi < count; gi++) {
    if (previous.ids[gi] !== next.ids[gi]) return true;
    if (previous.props[gi]!['sectionId'] !== next.props[gi]!['sectionId']) return true;
  }
  return false;
}

/** Full mercator extent of a layer, or null when it holds no geometry. Used for
 *  the first publication, where there is no previous payload to diff against. */
export function vtLayerBounds(data: VtLayerData): VtDirtyBounds | null {
  const { coords } = data;
  if (vtGroupCount(data) === 0 || coords.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let p = 0; p < coords.length; p += 2) {
    const x = coords[p]!;
    const y = coords[p + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Standard MVT tile extent. */
export const VT_EXTENT = 4096;
/** Clip buffer in tile units. 512 (an eighth of the extent) mirrors the
 *  headroom the geojson sources used (`buffer: 512`) so drag-translate
 *  previews near tile edges don't clip. */
const VT_BUFFER = 512;
/** Source-layer name inside every generated tile. */
export const VT_SOURCE_LAYER = 'g';

function idOf(f: GeoJSON.Feature): number {
  const fid = f.properties?.featureId;
  if (typeof fid === 'number') return fid;
  if (typeof f.id === 'number') return f.id;
  return 0;
}

function propsOf(f: GeoJSON.Feature): Record<string, VtPropValue> {
  const out: Record<string, VtPropValue> = {};
  for (const [k, v] of Object.entries(f.properties ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * Build a line-kind VtLayerData from LineString/MultiLineString features
 * (merged shot groups, per-feature shots, gradient segments). Projects to
 * mercator once. Non-line features are skipped.
 */
export function vtLinesFromFeatures(features: GeoJSON.Feature[]): VtLayerData {
  // Pass 1: count.
  let groupCount = 0;
  let lineCount = 0;
  let pointCount = 0;
  for (const f of features) {
    const g = f.geometry;
    if (g.type === 'LineString') {
      groupCount++;
      lineCount += 1;
      pointCount += g.coordinates.length;
    } else if (g.type === 'MultiLineString') {
      groupCount++;
      lineCount += g.coordinates.length;
      for (const line of g.coordinates) pointCount += line.length;
    }
  }
  const ids = new Float64Array(groupCount);
  const props: Array<Record<string, VtPropValue>> = new Array(groupCount);
  const coords = new Float64Array(pointCount * 2);
  const groupPointOffsets = new Uint32Array(groupCount + 1);
  const lineOffsets = new Uint32Array(lineCount + 1);
  const groupLineOffsets = new Uint32Array(groupCount + 1);

  let gi = 0;
  let li = 0;
  let p = 0;
  for (const f of features) {
    const g = f.geometry;
    let lines: GeoJSON.Position[][];
    if (g.type === 'LineString') lines = [g.coordinates];
    else if (g.type === 'MultiLineString') lines = g.coordinates;
    else continue;
    ids[gi] = idOf(f);
    props[gi] = propsOf(f);
    groupPointOffsets[gi] = p;
    groupLineOffsets[gi] = li;
    for (const line of lines) {
      lineOffsets[li++] = p;
      for (const pos of line) {
        const [mx, my] = lngLatToMercator(pos[0]!, pos[1]!);
        coords[p * 2] = mx;
        coords[p * 2 + 1] = my;
        p++;
      }
    }
    gi++;
  }
  groupPointOffsets[groupCount] = p;
  lineOffsets[lineCount] = p;
  groupLineOffsets[groupCount] = li;
  return { kind: 'line', ids, props, coords, groupPointOffsets, lineOffsets, groupLineOffsets };
}

/**
 * Build a point-kind VtLayerData from Point/MultiPoint features (merged
 * station groups, per-feature stations, label points). Non-point features
 * are skipped.
 */
export function vtPointsFromFeatures(features: GeoJSON.Feature[]): VtLayerData {
  let groupCount = 0;
  let pointCount = 0;
  for (const f of features) {
    const g = f.geometry;
    if (g.type === 'Point') {
      groupCount++;
      pointCount += 1;
    } else if (g.type === 'MultiPoint') {
      groupCount++;
      pointCount += g.coordinates.length;
    }
  }
  const ids = new Float64Array(groupCount);
  const props: Array<Record<string, VtPropValue>> = new Array(groupCount);
  const coords = new Float64Array(pointCount * 2);
  const groupPointOffsets = new Uint32Array(groupCount + 1);

  let gi = 0;
  let p = 0;
  for (const f of features) {
    const g = f.geometry;
    let points: GeoJSON.Position[];
    if (g.type === 'Point') points = [g.coordinates];
    else if (g.type === 'MultiPoint') points = g.coordinates;
    else continue;
    ids[gi] = idOf(f);
    props[gi] = propsOf(f);
    groupPointOffsets[gi] = p;
    for (const pos of points) {
      const [mx, my] = lngLatToMercator(pos[0]!, pos[1]!);
      coords[p * 2] = mx;
      coords[p * 2 + 1] = my;
      p++;
    }
    gi++;
  }
  groupPointOffsets[groupCount] = p;
  return { kind: 'point', ids, props, coords, groupPointOffsets };
}

// ─── Tile cutting ─────────────────────────────────────────────────────────

/**
 * Cut one tile from a layer: bbox filter + clip into tile-local integer
 * coordinates, encoded as a complete MVT tile with one layer named
 * `VT_SOURCE_LAYER`. Returns null when nothing intersects the buffered tile.
 */
export function cutTile(layer: VtLayerData, z: number, x: number, y: number): Uint8Array | null {
  const s = 1 / 2 ** z; // tile span in mercator [0,1]
  const ox = x * s;
  const oy = y * s;
  const scale = VT_EXTENT / s; // mercator -> tile units
  const min = -VT_BUFFER;
  const max = VT_EXTENT + VT_BUFFER;

  const features: EncodedFeature[] = [];
  const groupCount = vtGroupCount(layer);
  for (let gi = 0; gi < groupCount; gi++) {
    const geom =
      layer.kind === 'line'
        ? clipGroupLines(layer, gi, ox, oy, scale, min, max)
        : clipGroupPoints(layer, gi, ox, oy, scale, min, max);
    if (geom) {
      features.push({
        id: layer.ids[gi]!,
        props: layer.props[gi]!,
        type: layer.kind === 'line' ? 2 : 1,
        geometry: geom,
      });
    }
  }
  if (features.length === 0) return null;
  return encodeMvtLayer(VT_SOURCE_LAYER, features);
}

/** Clip one line group. Returns tile-local multi-line geometry or null. */
function clipGroupLines(
  layer: VtLayerData,
  gi: number,
  ox: number,
  oy: number,
  scale: number,
  min: number,
  max: number,
): number[][] | null {
  const { coords, lineOffsets, groupLineOffsets } = layer;
  if (!lineOffsets || !groupLineOffsets) return null;
  const outLines: number[][] = [];
  const lineStart = groupLineOffsets[gi]!;
  const lineEnd = groupLineOffsets[gi + 1]!;
  for (let li = lineStart; li < lineEnd; li++) {
    const start = lineOffsets[li]!;
    const end = lineOffsets[li + 1]!;
    let current: number[] | null = null;
    for (let p = start; p + 1 < end; p++) {
      const x0 = (coords[p * 2]! - ox) * scale;
      const y0 = (coords[p * 2 + 1]! - oy) * scale;
      const x1 = (coords[(p + 1) * 2]! - ox) * scale;
      const y1 = (coords[(p + 1) * 2 + 1]! - oy) * scale;
      // Cheap reject before the exact clip.
      if (
        (x0 < min && x1 < min) || (x0 > max && x1 > max) ||
        (y0 < min && y1 < min) || (y0 > max && y1 > max)
      ) {
        current = null;
        continue;
      }
      const clipped = clipSegment(x0, y0, x1, y1, min, max);
      if (!clipped) {
        current = null;
        continue;
      }
      const [cx0, cy0, cx1, cy1, startMoved] = clipped;
      const rx0 = Math.round(cx0);
      const ry0 = Math.round(cy0);
      const rx1 = Math.round(cx1);
      const ry1 = Math.round(cy1);
      if (current === null || startMoved) {
        current = [rx0, ry0, rx1, ry1];
        outLines.push(current);
      } else {
        current.push(rx1, ry1);
      }
      // A clipped end breaks continuity into the next segment.
      if (cx1 !== x1 || cy1 !== y1) current = null;
    }
  }
  // Drop lines degenerate after rounding (all points identical).
  const filtered = outLines.filter((l) => {
    for (let i = 2; i < l.length; i += 2) {
      if (l[i] !== l[0] || l[i + 1] !== l[1]) return true;
    }
    return false;
  });
  return filtered.length > 0 ? filtered : null;
}

/** Liang-Barsky clip of a segment to [min,max]^2.
 *  Returns [x0,y0,x1,y1,startMoved] or null when fully outside. */
function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  min: number,
  max: number,
): [number, number, number, number, boolean] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - min, max - x0, y0 - min, max - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return null;
    } else {
      const r = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy, t0 > 0];
}

/** Clip one point group to the buffered tile. Returns a single flat
 *  [x,y,...] list wrapped in an array, or null. */
function clipGroupPoints(
  layer: VtLayerData,
  gi: number,
  ox: number,
  oy: number,
  scale: number,
  min: number,
  max: number,
): number[][] | null {
  const { coords, groupPointOffsets } = layer;
  const start = groupPointOffsets[gi]!;
  const end = groupPointOffsets[gi + 1]!;
  const pts: number[] = [];
  for (let p = start; p < end; p++) {
    const tx = (coords[p * 2]! - ox) * scale;
    const ty = (coords[p * 2 + 1]! - oy) * scale;
    if (tx >= min && tx <= max && ty >= min && ty <= max) {
      pts.push(Math.round(tx), Math.round(ty));
    }
  }
  return pts.length > 0 ? [pts] : null;
}

// ─── Minimal MVT (Mapbox Vector Tile v2) encoder ──────────────────────────

const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;

interface EncodedFeature {
  id: number;
  props: Record<string, VtPropValue>;
  /** 1 = point, 2 = line. */
  type: 1 | 2;
  /** Lines: one flat [x,y,...] array per line. Points: a single flat
   *  [x,y,...] array holding every point. */
  geometry: number[][];
}

const textEncoder = new TextEncoder();

/** Growable byte writer with the protobuf primitives the encoder needs. */
class PbfWriter {
  buf = new Uint8Array(1 << 12);
  pos = 0;

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.pos + extra) next *= 2;
    const nb = new Uint8Array(next);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }

  varint(v: number): void {
    this.ensure(10);
    while (v > 0x7f) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.pos++] = v;
  }

  tag(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  bytes(b: Uint8Array): void {
    this.varint(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  string(field: number, s: string): void {
    this.tag(field, 2);
    this.bytes(textEncoder.encode(s));
  }

  message(field: number, m: PbfWriter): void {
    this.tag(field, 2);
    this.bytes(m.slice());
  }

  float64(v: number): void {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  slice(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

function zigzag(v: number): number {
  return v < 0 ? -v * 2 - 1 : v * 2;
}

function encodeValue(v: VtPropValue): PbfWriter {
  const w = new PbfWriter();
  if (typeof v === 'string') {
    w.string(1, v);
  } else if (typeof v === 'boolean') {
    w.tag(7, 0); // bool_value
    w.varint(v ? 1 : 0);
  } else if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) {
    if (v >= 0) {
      w.tag(5, 0); // uint_value
      w.varint(v);
    } else {
      w.tag(6, 0); // sint_value (zigzag)
      w.varint(zigzag(v));
    }
  } else {
    w.tag(3, 1); // double_value (fixed64)
    w.float64(v);
  }
  return w;
}

/** Encode a complete single-layer tile. */
function encodeMvtLayer(name: string, features: EncodedFeature[]): Uint8Array {
  const keys: string[] = [];
  const keyIdx = new Map<string, number>();
  const values: PbfWriter[] = [];
  const valueIdx = new Map<string, number>();

  const layer = new PbfWriter();
  layer.tag(15, 0); // version
  layer.varint(2);
  layer.string(1, name);
  layer.tag(5, 0); // extent
  layer.varint(VT_EXTENT);

  const featureWriters: PbfWriter[] = [];
  for (const f of features) {
    const fw = new PbfWriter();
    fw.tag(1, 0); // id
    fw.varint(f.id);
    const tagW = new PbfWriter();
    for (const [k, v] of Object.entries(f.props)) {
      let ki = keyIdx.get(k);
      if (ki === undefined) {
        ki = keys.length;
        keys.push(k);
        keyIdx.set(k, ki);
      }
      const vk = `${typeof v}:${v}`;
      let vi = valueIdx.get(vk);
      if (vi === undefined) {
        vi = values.length;
        values.push(encodeValue(v));
        valueIdx.set(vk, vi);
      }
      tagW.varint(ki);
      tagW.varint(vi);
    }
    fw.tag(2, 2); // tags
    fw.bytes(tagW.slice());
    fw.tag(3, 0); // type
    fw.varint(f.type);

    const geomW = new PbfWriter();
    if (f.type === 1) {
      const pts = f.geometry[0]!;
      const count = pts.length / 2;
      geomW.varint(CMD_MOVE_TO | (count << 3));
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < pts.length; i += 2) {
        geomW.varint(zigzag(pts[i]! - cx));
        geomW.varint(zigzag(pts[i + 1]! - cy));
        cx = pts[i]!;
        cy = pts[i + 1]!;
      }
    } else {
      let cx = 0;
      let cy = 0;
      for (const line of f.geometry) {
        geomW.varint(CMD_MOVE_TO | (1 << 3));
        geomW.varint(zigzag(line[0]! - cx));
        geomW.varint(zigzag(line[1]! - cy));
        cx = line[0]!;
        cy = line[1]!;
        const rest = line.length / 2 - 1;
        geomW.varint(CMD_LINE_TO | (rest << 3));
        for (let i = 2; i < line.length; i += 2) {
          geomW.varint(zigzag(line[i]! - cx));
          geomW.varint(zigzag(line[i + 1]! - cy));
          cx = line[i]!;
          cy = line[i + 1]!;
        }
      }
    }
    fw.tag(4, 2); // geometry
    fw.bytes(geomW.slice());
    featureWriters.push(fw);
  }

  for (const k of keys) layer.string(3, k);
  for (const v of values) layer.message(4, v);
  for (const fw of featureWriters) layer.message(2, fw);

  const tile = new PbfWriter();
  tile.message(3, layer);
  // Exact-size copy so the growable backing buffer isn't retained.
  return new Uint8Array(tile.slice());
}
