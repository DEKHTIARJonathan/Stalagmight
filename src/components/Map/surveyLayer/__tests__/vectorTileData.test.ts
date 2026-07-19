/**
 * Tests for the survey vector-tile data model, tile cutter and MVT encoder
 * (#mem). The decoder below is a minimal, independent MVT/protobuf reader so
 * the encoder is verified against the wire format, not against itself.
 */
import { describe, it, expect } from 'vitest';
import {
  vtLinesFromFeatures,
  vtPointsFromFeatures,
  vtGroupCount,
  vtTransferables,
  cutTile,
  isStructuralChange,
  lngLatToMercator,
  VT_EXTENT,
  VT_SOURCE_LAYER,
  type VtLayerData,
} from '../vectorTileData';

// ─── Minimal MVT decoder (independent of the encoder) ─────────────────────

interface DecodedFeature {
  id: number;
  type: number;
  props: Record<string, unknown>;
  /** Raw command-decoded geometry: array of [x,y] runs per MoveTo/LineTo block. */
  lines: Array<Array<[number, number]>>;
}

interface DecodedLayer {
  name: string;
  extent: number;
  version: number;
  features: DecodedFeature[];
}

class PbfReader {
  pos = 0;
  constructor(public buf: Uint8Array) {}

  varint(): number {
    let v = 0;
    let shift = 1;
    for (;;) {
      const b = this.buf[this.pos++]!;
      v += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return v;
      shift *= 128;
    }
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

function zigzagDecode(v: number): number {
  return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
}

function decodeValue(bytes: Uint8Array): unknown {
  const r = new PbfReader(bytes);
  while (r.pos < bytes.length) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 1) return new TextDecoder().decode(r.bytes());
    if (field === 3) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + r.pos, 8);
      return dv.getFloat64(0, true);
    }
    if (field === 5) return r.varint();
    if (field === 6) return zigzagDecode(r.varint());
    if (field === 7) return r.varint() !== 0;
    r.skip(wire);
  }
  return undefined;
}

function decodeGeometry(bytes: Uint8Array): Array<Array<[number, number]>> {
  const r = new PbfReader(bytes);
  const lines: Array<Array<[number, number]>> = [];
  let cx = 0;
  let cy = 0;
  let current: Array<[number, number]> | null = null;
  while (r.pos < bytes.length) {
    const cmdInt = r.varint();
    const cmd = cmdInt & 0x7;
    const count = cmdInt >> 3;
    if (cmd === 1) {
      // MoveTo(s)
      for (let i = 0; i < count; i++) {
        cx += zigzagDecode(r.varint());
        cy += zigzagDecode(r.varint());
        current = [[cx, cy]];
        lines.push(current);
      }
    } else if (cmd === 2) {
      for (let i = 0; i < count; i++) {
        cx += zigzagDecode(r.varint());
        cy += zigzagDecode(r.varint());
        current!.push([cx, cy]);
      }
    } else {
      throw new Error(`unexpected command ${cmd}`);
    }
  }
  return lines;
}

function decodeTile(buf: Uint8Array): DecodedLayer[] {
  const layers: DecodedLayer[] = [];
  const r = new PbfReader(buf);
  while (r.pos < buf.length) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field !== 3) {
      r.skip(wire);
      continue;
    }
    const layerBytes = r.bytes();
    const lr = new PbfReader(layerBytes);
    const layer: DecodedLayer = { name: '', extent: 0, version: 0, features: [] };
    const keys: string[] = [];
    const values: unknown[] = [];
    const rawFeatures: Uint8Array[] = [];
    while (lr.pos < layerBytes.length) {
      const lkey = lr.varint();
      const lfield = Math.floor(lkey / 8);
      const lwire = lkey % 8;
      if (lfield === 15) layer.version = lr.varint();
      else if (lfield === 1) layer.name = new TextDecoder().decode(lr.bytes());
      else if (lfield === 5) layer.extent = lr.varint();
      else if (lfield === 3) keys.push(new TextDecoder().decode(lr.bytes()));
      else if (lfield === 4) values.push(decodeValue(lr.bytes()));
      else if (lfield === 2) rawFeatures.push(lr.bytes());
      else lr.skip(lwire);
    }
    for (const fb of rawFeatures) {
      const fr = new PbfReader(fb);
      const f: DecodedFeature = { id: 0, type: 0, props: {}, lines: [] };
      while (fr.pos < fb.length) {
        const fkey = fr.varint();
        const ffield = Math.floor(fkey / 8);
        const fwire = fkey % 8;
        if (ffield === 1) f.id = fr.varint();
        else if (ffield === 2) {
          const tagBytes = fr.bytes();
          const tr = new PbfReader(tagBytes);
          while (tr.pos < tagBytes.length) {
            const ki = tr.varint();
            const vi = tr.varint();
            f.props[keys[ki]!] = values[vi];
          }
        } else if (ffield === 3) f.type = fr.varint();
        else if (ffield === 4) f.lines = decodeGeometry(fr.bytes());
        else fr.skip(fwire);
      }
      layer.features.push(f);
    }
    layers.push(layer);
  }
  return layers;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const lineFeature = (
  id: number,
  lines: GeoJSON.Position[][],
  props: Record<string, unknown> = {},
): GeoJSON.Feature => ({
  type: 'Feature',
  geometry: lines.length === 1
    ? { type: 'LineString', coordinates: lines[0]! }
    : { type: 'MultiLineString', coordinates: lines },
  properties: { featureId: id, ...props },
});

const pointFeature = (
  id: number,
  points: GeoJSON.Position[],
  props: Record<string, unknown> = {},
): GeoJSON.Feature => ({
  type: 'Feature',
  geometry: points.length === 1
    ? { type: 'Point', coordinates: points[0]! }
    : { type: 'MultiPoint', coordinates: points },
  properties: { featureId: id, ...props },
});

/** Mercator midpoint of tile (z,x,y) expressed as lng/lat. */
function tileCenterLngLat(z: number, x: number, y: number): [number, number] {
  const s = 1 / 2 ** z;
  const mx = (x + 0.5) * s;
  const my = (y + 0.5) * s;
  const lng = (mx - 0.5) * 360;
  const n = Math.PI - 2 * Math.PI * my;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

// ─── Converter tests ───────────────────────────────────────────────────────

describe('vtLinesFromFeatures', () => {
  it('flattens LineString and MultiLineString features into shared arrays', () => {
    const data = vtLinesFromFeatures([
      lineFeature(7, [[[0, 0], [1, 1]]], { colorIndex: 2 }),
      lineFeature(9, [
        [[1, 1], [2, 2]],
        [[3, 3], [4, 4], [5, 5]],
      ]),
    ]);
    expect(data.kind).toBe('line');
    expect(vtGroupCount(data)).toBe(2);
    expect(Array.from(data.ids)).toEqual([7, 9]);
    expect(data.props[0]).toEqual({ featureId: 7, colorIndex: 2 });
    // 2 + (2 + 3) points
    expect(data.coords.length).toBe(7 * 2);
    expect(Array.from(data.groupPointOffsets)).toEqual([0, 2, 7]);
    expect(Array.from(data.groupLineOffsets!)).toEqual([0, 1, 3]);
    expect(Array.from(data.lineOffsets!)).toEqual([0, 2, 4, 7]);
  });

  it('skips non-line geometries', () => {
    const data = vtLinesFromFeatures([pointFeature(1, [[0, 0]])]);
    expect(vtGroupCount(data)).toBe(0);
  });

  it('exposes a transfer list covering every typed array', () => {
    const data = vtLinesFromFeatures([lineFeature(1, [[[0, 0], [1, 1]]])]);
    const transfers = vtTransferables(data);
    expect(transfers).toContain(data.ids.buffer);
    expect(transfers).toContain(data.coords.buffer);
    expect(transfers).toContain(data.lineOffsets!.buffer);
  });
});

describe('vtPointsFromFeatures', () => {
  it('flattens Point and MultiPoint features', () => {
    const data = vtPointsFromFeatures([
      pointFeature(3, [[10, 20]], { name: 'A' }),
      pointFeature(4, [[0, 0], [1, 1], [2, 2]]),
    ]);
    expect(data.kind).toBe('point');
    expect(vtGroupCount(data)).toBe(2);
    expect(Array.from(data.groupPointOffsets)).toEqual([0, 1, 4]);
    expect(data.props[0]?.name).toBe('A');
  });
});

// ─── Cutter + encoder tests ────────────────────────────────────────────────

describe('cutTile', () => {
  it('encodes a point group centered in the requested tile', () => {
    const [lng, lat] = tileCenterLngLat(10, 300, 400);
    const data = vtPointsFromFeatures([
      pointFeature(42, [[lng, lat]], { name: 'Sec 1', isZeroDatum: false, colorIndex: 3 }),
    ]);
    const bytes = cutTile(data, 10, 300, 400);
    expect(bytes).not.toBeNull();
    const layers = decodeTile(bytes!);
    expect(layers).toHaveLength(1);
    const layer = layers[0]!;
    expect(layer.name).toBe(VT_SOURCE_LAYER);
    expect(layer.version).toBe(2);
    expect(layer.extent).toBe(VT_EXTENT);
    expect(layer.features).toHaveLength(1);
    const f = layer.features[0]!;
    expect(f.id).toBe(42);
    expect(f.type).toBe(1); // point
    expect(f.props).toEqual({ featureId: 42, name: 'Sec 1', isZeroDatum: false, colorIndex: 3 });
    // Center of the tile in tile units.
    expect(f.lines[0]![0]![0]).toBeCloseTo(VT_EXTENT / 2, -1);
    expect(f.lines[0]![0]![1]).toBeCloseTo(VT_EXTENT / 2, -1);
  });

  it('returns null when nothing intersects the tile', () => {
    const [lng, lat] = tileCenterLngLat(10, 300, 400);
    const data = vtPointsFromFeatures([pointFeature(1, [[lng, lat]])]);
    expect(cutTile(data, 10, 0, 0)).toBeNull();
  });

  it('clips a line crossing the tile to the buffered bounds', () => {
    // A long horizontal line through the center of tile (5, 10, 10),
    // extending far past both edges.
    const [lngA, lat] = tileCenterLngLat(5, 8, 10);
    const [lngB] = tileCenterLngLat(5, 13, 10);
    const data = vtLinesFromFeatures([lineFeature(5, [[[lngA, lat], [lngB, lat]]])]);
    const bytes = cutTile(data, 5, 10, 10);
    expect(bytes).not.toBeNull();
    const f = decodeTile(bytes!)[0]!.features[0]!;
    expect(f.type).toBe(2); // line
    const line = f.lines[0]!;
    expect(line).toHaveLength(2);
    // Clipped endpoints sit exactly on the buffered bounds.
    expect(line[0]![0]).toBe(-512);
    expect(line[1]![0]).toBe(VT_EXTENT + 512);
    // Y stays the tile's vertical center.
    expect(line[0]![1]).toBeCloseTo(VT_EXTENT / 2, -1);
  });

  it('keeps multi-line groups as one feature and drops fully-outside lines', () => {
    const [lngIn, latIn] = tileCenterLngLat(8, 100, 100);
    const [lngOut, latOut] = tileCenterLngLat(8, 200, 200);
    const dIn = 0.0005; // small offset in degrees, stays within the tile
    const data = vtLinesFromFeatures([
      lineFeature(11, [
        [[lngIn, latIn], [lngIn + dIn, latIn]],
        [[lngOut, latOut], [lngOut + dIn, latOut]],
      ]),
    ]);
    const bytes = cutTile(data, 8, 100, 100);
    expect(bytes).not.toBeNull();
    const f = decodeTile(bytes!)[0]!.features[0]!;
    expect(f.id).toBe(11);
    expect(f.lines).toHaveLength(1);
  });

  it('preserves ids above 2^31 (encodeFeatureId composites)', () => {
    const [lng, lat] = tileCenterLngLat(3, 4, 3);
    const bigId = 14299 * 2 ** 20 + 12345;
    const data = vtPointsFromFeatures([pointFeature(bigId, [[lng, lat]])]);
    const f = decodeTile(cutTile(data, 3, 4, 3)!)[0]!.features[0]!;
    expect(f.id).toBe(bigId);
  });

  it('encodes negative integer and fractional number props', () => {
    const [lng, lat] = tileCenterLngLat(4, 8, 6);
    const data = vtPointsFromFeatures([
      pointFeature(1, [[lng, lat]], { m: -5, d: 1.25 }),
    ]);
    const f = decodeTile(cutTile(data, 4, 8, 6)!)[0]!.features[0]!;
    expect(f.props.m).toBe(-5);
    expect(f.props.d).toBe(1.25);
  });

  it('dedupes shared property values across features', () => {
    const [lng, lat] = tileCenterLngLat(4, 8, 6);
    const data = vtPointsFromFeatures([
      pointFeature(1, [[lng, lat]], { colorIndex: 7 }),
      pointFeature(2, [[lng, lat]], { colorIndex: 7 }),
    ]);
    const layer = decodeTile(cutTile(data, 4, 8, 6)!)[0]!;
    expect(layer.features).toHaveLength(2);
    expect(layer.features[0]!.props.colorIndex).toBe(7);
    expect(layer.features[1]!.props.colorIndex).toBe(7);
  });

  it('round-trips mercator projection at the equator', () => {
    const [x, y] = lngLatToMercator(0, 0);
    expect(x).toBeCloseTo(0.5, 10);
    expect(y).toBeCloseTo(0.5, 10);
  });

  it('splits a line at a gap into separate MVT line runs', () => {
    // Two segments of one logical line where the middle vertex jumps far away
    // and back: the far segment clips out, producing two runs.
    const [lng, lat] = tileCenterLngLat(6, 20, 20);
    const [farLng, farLat] = tileCenterLngLat(6, 40, 40);
    const d = 0.002;
    const data = vtLinesFromFeatures([
      lineFeature(2, [[[lng, lat], [lng + d, lat], [farLng, farLat], [lng, lat + d], [lng + d, lat + d]]]),
    ]);
    const f = decodeTile(cutTile(data, 6, 20, 20)!)[0]!.features[0]!;
    // Runs: [in..in->clipped], [clipped->in, in], with the wholly-out parts gone.
    expect(f.lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe('cutTile on empty data', () => {
  it('returns null for zero groups', () => {
    const data: VtLayerData = vtPointsFromFeatures([]);
    expect(cutTile(data, 0, 0, 0)).toBeNull();
  });
});

describe('isStructuralChange', () => {
  it('is false for a same-structure move (identical ids + sectionId, moved coords)', () => {
    const a = vtPointsFromFeatures([
      pointFeature(1, [[0, 0]], { sectionId: 5 }),
      pointFeature(2, [[10, 10]], { sectionId: 5 }),
    ]);
    const b = vtPointsFromFeatures([
      pointFeature(1, [[0, 0]], { sectionId: 5 }),
      pointFeature(2, [[10, 20]], { sectionId: 5 }),
    ]);
    expect(isStructuralChange(a, b)).toBe(false);
  });

  it('is false for an unchanged republish', () => {
    const mk = (): VtLayerData =>
      vtPointsFromFeatures([pointFeature(1, [[1, 1]], { sectionId: 3 })]);
    expect(isStructuralChange(mk(), mk())).toBe(false);
  });

  it('is true when a group is removed (count shrinks)', () => {
    const a = vtPointsFromFeatures([pointFeature(1, [[1, 1]]), pointFeature(2, [[2, 2]])]);
    const b = vtPointsFromFeatures([pointFeature(1, [[1, 1]])]);
    expect(isStructuralChange(a, b)).toBe(true);
  });

  it('is true when a group is added (count grows)', () => {
    const a = vtPointsFromFeatures([pointFeature(1, [[1, 1]])]);
    const b = vtPointsFromFeatures([pointFeature(1, [[1, 1]]), pointFeature(2, [[2, 2]])]);
    expect(isStructuralChange(a, b)).toBe(true);
  });

  it('is true when groups are reordered (same count, different id sequence)', () => {
    const a = vtPointsFromFeatures([pointFeature(1, [[1, 1]]), pointFeature(2, [[2, 2]])]);
    const b = vtPointsFromFeatures([pointFeature(2, [[2, 2]]), pointFeature(1, [[1, 1]])]);
    expect(isStructuralChange(a, b)).toBe(true);
  });

  it('is true when a group keeps its id but changes sectionId', () => {
    const a = vtPointsFromFeatures([pointFeature(1, [[1, 1]], { sectionId: 5 })]);
    const b = vtPointsFromFeatures([pointFeature(1, [[1, 1]], { sectionId: 6 })]);
    expect(isStructuralChange(a, b)).toBe(true);
  });

  it('is true when the layer kind changes', () => {
    const a = vtPointsFromFeatures([pointFeature(1, [[1, 1]])]);
    const b = vtLinesFromFeatures([lineFeature(1, [[[1, 1], [2, 2]]])]);
    expect(isStructuralChange(a, b)).toBe(true);
  });
});
