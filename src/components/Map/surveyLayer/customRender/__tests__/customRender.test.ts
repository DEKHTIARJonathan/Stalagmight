import { afterEach, describe, expect, it, vi } from 'vitest';
import { packCssColor, writeCssColor } from '../colorPack';
import { SurveyCustomLayer, type CustomRenderData } from '../surveyCustomLayer';
import { mat4Multiply, composeAnchorMatrix, computeMercatorAnchor } from '../mercator';
import {
  buildStationLookup,
  projectStationsRel,
  countValidShots,
  buildLineBuffers,
  buildCircleBuffers,
} from '../tessellate';
import type { Rgba8 } from '../colorPack';
import {
  emptySurveyData,
  STATION_FLAG_IS_ZERO_DATUM,
  type SurveyData,
} from '../../../../../types/survey-data';
import { lngLatToMercator } from '../../vectorTileData';
import { metersToMapCoords } from '../../../../../utils/coordinates';

/**
 * Minimal fixture: two sections.
 *  - Section 1: 3 stations (idx 0,1,2) + 2 shots -> both shots valid (2 segments).
 *  - Section 2: 1 station (idx 0) + 1 shot -> missing endpoint (idx 1) -> 0 segments.
 * Station 0 of section 1 is a zero-datum. Total stations = 4.
 */
function makeFixture(): SurveyData {
  const d = emptySurveyData();
  d.sections = [
    { id: 1, name: 'A', surveyor: null, date: null, color: '#ff0000', direction: 'in' as never, quality: 0, next_shot_id: 2, shotOffset: 0, shotCount: 2 },
    { id: 2, name: 'B', surveyor: null, date: null, color: '#00ff00', direction: 'in' as never, quality: 0, next_shot_id: 1, shotOffset: 2, shotCount: 1 },
  ];
  d.shotCount = 3;
  d.shotIds = new Int32Array([0, 1, 0]);
  d.shotSectionIds = new Int32Array([1, 1, 2]);
  d.shotFlags = new Uint8Array([0, 0, 0]);

  d.stationCount = 4;
  d.stationSectionIds = new Int32Array([1, 1, 1, 2]);
  d.stationIndices = new Uint32Array([0, 1, 2, 0]);
  d.stationCoords = new Float64Array([
    0, 0, 0,
    10, 0, -1,
    10, 10, -2,
    100, 100, 0,
  ]);
  d.stationFlags = new Uint8Array([STATION_FLAG_IS_ZERO_DATUM, 0, 0, 0]);
  return d;
}

const colorCtxNoop = { showDepthGradient: false } as never;

describe('colorPack', () => {
  it('parses #rgb / #rrggbb / #rrggbbaa', () => {
    expect(packCssColor('#f00')).toEqual([255, 0, 0, 255]);
    expect(packCssColor('#ff0000')).toEqual([255, 0, 0, 255]);
    expect(packCssColor('#0000ff80')).toEqual([0, 0, 255, 128]);
    expect(packCssColor('#4ecdc4')).toEqual([78, 205, 196, 255]);
  });

  it('parses rgb() / rgba()', () => {
    expect(packCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 255]);
    expect(packCssColor('rgba(255, 0, 0, 0.5)')).toEqual([255, 0, 0, 128]);
  });

  it('returns a visible fallback for garbage', () => {
    expect(packCssColor('not-a-color')).toEqual([255, 0, 255, 255]);
    expect(packCssColor('#12345')).toEqual([255, 0, 255, 255]);
  });

  it('writes into a Uint8Array at an offset', () => {
    const out = new Uint8Array(8);
    writeCssColor(out, 4, '#010203');
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 1, 2, 3, 255]);
  });
});

describe('mat4 + anchor matrix', () => {
  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  it('mat4Multiply is identity-neutral', () => {
    const m = new Float64Array([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53]);
    expect(Array.from(mat4Multiply(identity, m))).toEqual(Array.from(m));
    expect(Array.from(mat4Multiply(m, identity))).toEqual(Array.from(m));
  });

  it('composeAnchorMatrix == mvp * translate(anchor)', () => {
    const mvp = new Float64Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1]);
    const anchorX = 0.4;
    const anchorY = 0.6;
    const translate = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, anchorX, anchorY, 0, 1]);
    const expected = Float32Array.from(mat4Multiply(mvp, translate));
    const got = composeAnchorMatrix(mvp, anchorX, anchorY);
    expect(Array.from(got)).toEqual(Array.from(expected));
  });

  it('anchor-relative positions reconstruct absolute mercator via the composed matrix', () => {
    // A pure translation mvp: clip = mercator + [10, 20]. The composed matrix
    // applied to (mercator - anchor) must equal mvp applied to mercator.
    const mvp = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1]);
    const anchorX = 0.5;
    const anchorY = 0.5;
    const composed = composeAnchorMatrix(mvp, anchorX, anchorY);
    const merc = [0.5001, 0.4998];
    const local = [merc[0]! - anchorX, merc[1]! - anchorY];
    // composed * [local, 0, 1] -> x,y (column-major)
    const cx = composed[0]! * local[0]! + composed[4]! * local[1]! + composed[12]!;
    const cy = composed[1]! * local[0]! + composed[5]! * local[1]! + composed[13]!;
    expect(cx).toBeCloseTo(merc[0]! + 10, 6);
    expect(cy).toBeCloseTo(merc[1]! + 20, 6);
  });

  // Locks the input-matrix contract that MEM-92 regressed: composeAnchorMatrix
  // must be fed MapLibre's mercator [0,1] -> clip matrix
  // (defaultProjectionData.mainMatrix), NOT the world-pixel
  // modelViewProjectionMatrix. Pure math, no GL.
  it('projects the anchor point into clip with mainMatrix but off-screen with a world-pixel matrix', () => {
    // A mercator [0,1] -> clip matrix (what defaultProjectionData.mainMatrix
    // supplies): orthographic, centered on the survey's mercator center so that
    // center maps to the clip origin at a fixed scale.
    const cx = 0.512;
    const cy = 0.498;
    const s = 2000; // clip units per mercator unit for a zoomed-in view
    const mercatorMatrix = new Float64Array([
      s, 0, 0, 0,
      0, s, 0, 0,
      0, 0, 1, 0,
      -s * cx, -s * cy, 0, 1,
    ]);

    // Column-major homogeneous projection of an anchor-relative local point.
    const project = (m: Float32Array, px: number, py: number) => ({
      x: m[0]! * px + m[4]! * py + m[12]!,
      y: m[1]! * px + m[5]! * py + m[13]!,
      w: m[3]! * px + m[7]! * py + m[15]!,
    });

    // Anchor at the mercator center; the survey point sits AT the anchor, so its
    // anchor-relative local position is (0, 0). With the correct mainMatrix it
    // must land at the clip origin.
    const composed = composeAnchorMatrix(mercatorMatrix, cx, cy);
    const clip = project(composed, 0, 0);
    expect(clip.w).toBeGreaterThan(0);
    expect(Math.abs(clip.x)).toBeLessThan(1);
    expect(Math.abs(clip.y)).toBeLessThan(1);
    expect(clip.x).toBeCloseTo(0, 6);
    expect(clip.y).toBeCloseTo(0, 6);

    // The regression: MapLibre 5.16's modelViewProjectionMatrix maps world-pixel
    // space (0..worldSize, worldSize = 512 * 2^zoom) to clip, not mercator [0,1].
    // Model it by removing the 1/worldSize scaling from the projection's linear
    // block (scale it by 512 * 2^zoom) while leaving the translation. Feeding the
    // same anchor point through it lands millions of clip units off-screen.
    const worldSize = 512 * 2 ** 14; // ~8.4M px
    const worldMatrix = Float64Array.from(mercatorMatrix);
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) worldMatrix[i]! *= worldSize;
    const composedWorld = composeAnchorMatrix(worldMatrix, cx, cy);
    const clipWorld = project(composedWorld, 0, 0);
    expect(clipWorld.w).toBeGreaterThan(0);
    expect(Math.abs(clipWorld.x)).toBeGreaterThan(1e6);
  });
});

describe('anchor-relative station projection', () => {
  it('computeMercatorAnchor is the mercator bbox center', () => {
    const d = makeFixture();
    const [ax, ay] = computeMercatorAnchor(d, null);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let g = 0; g < d.stationCount; g++) {
      const ll = metersToMapCoords(d.stationCoords[g * 3]!, d.stationCoords[g * 3 + 1]!, null);
      const [mx, my] = lngLatToMercator(ll[0], ll[1]);
      minX = Math.min(minX, mx); minY = Math.min(minY, my);
      maxX = Math.max(maxX, mx); maxY = Math.max(maxY, my);
    }
    expect(ax).toBeCloseTo((minX + maxX) / 2, 12);
    expect(ay).toBeCloseTo((minY + maxY) / 2, 12);
  });

  it('projectStationsRel == mercator - anchor', () => {
    const d = makeFixture();
    const [ax, ay] = computeMercatorAnchor(d, null);
    const rel = projectStationsRel(d, null, ax, ay);
    expect(rel.length).toBe(d.stationCount * 2);
    for (let g = 0; g < d.stationCount; g++) {
      const ll = metersToMapCoords(d.stationCoords[g * 3]!, d.stationCoords[g * 3 + 1]!, null);
      const [mx, my] = lngLatToMercator(ll[0], ll[1]);
      expect(rel[g * 2]!).toBeCloseTo(mx - ax, 6);
      expect(rel[g * 2 + 1]!).toBeCloseTo(my - ay, 6);
    }
  });

  it('empty survey anchors at mercator world center', () => {
    expect(computeMercatorAnchor(emptySurveyData(), null)).toEqual([0.5, 0.5]);
  });
});

describe('line tessellation', () => {
  const stubColor = (shotIdx: number, sectionId: number): Rgba8 => [shotIdx, sectionId, 7, 255];

  it('counts only valid shots (both endpoints present)', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    expect(countValidShots(d, lookup)).toBe(2); // section 2's shot is dropped
  });

  it('sizes buffers as 4 verts + 6 indices per segment', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildLineBuffers(d, rel, lookup, stubColor);
    expect(b.segmentCount).toBe(2);
    expect(b.vertexCount).toBe(8);
    expect(b.posA.length).toBe(16);
    expect(b.posB.length).toBe(16);
    expect(b.endpoint.length).toBe(8);
    expect(b.side.length).toBe(8);
    expect(b.color.length).toBe(32);
    expect(b.indices.length).toBe(12);
  });

  it('uses the A/B endpoint + side template and quad winding', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildLineBuffers(d, rel, lookup, stubColor);
    // Segment 0 vertices: v0 A-left, v1 A-right, v2 B-left, v3 B-right.
    expect(Array.from(b.endpoint.slice(0, 4))).toEqual([0, 0, 1, 1]);
    expect(Array.from(b.side.slice(0, 4))).toEqual([-1, 1, -1, 1]);
    // Two triangles covering the quad (0,1,2)+(2,1,3).
    expect(Array.from(b.indices.slice(0, 6))).toEqual([0, 1, 2, 2, 1, 3]);
    // Segment 1 indices are offset by 4 verts.
    expect(Array.from(b.indices.slice(6, 12))).toEqual([4, 5, 6, 6, 5, 7]);
  });

  it('posA/posB are the anchor-relative segment endpoints', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    const [ax, ay] = computeMercatorAnchor(d, null);
    const rel = projectStationsRel(d, null, ax, ay);
    const b = buildLineBuffers(d, rel, lookup, stubColor);
    // Segment 0 goes station idx0 -> idx1 (global 0 -> 1).
    expect(b.posA[0]).toBeCloseTo(rel[0]!, 6);
    expect(b.posA[1]).toBeCloseTo(rel[1]!, 6);
    expect(b.posB[0]).toBeCloseTo(rel[2]!, 6);
    expect(b.posB[1]).toBeCloseTo(rel[3]!, 6);
  });

  it('propagates the resolved color to all 4 vertices of a segment', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildLineBuffers(d, rel, lookup, stubColor);
    // Segment 0 = shot global 0, section 1 -> [0, 1, 7, 255].
    for (let v = 0; v < 4; v++) {
      expect(Array.from(b.color.slice(v * 4, v * 4 + 4))).toEqual([0, 1, 7, 255]);
    }
    // Segment 1 = shot global 1, section 1 -> [1, 1, 7, 255].
    expect(Array.from(b.color.slice(16, 20))).toEqual([1, 1, 7, 255]);
  });
});

describe('circle tessellation', () => {
  const fill = (g: number): Rgba8 => [g, 0, 0, 255];
  const stroke = (_g: number): Rgba8 => [9, 9, 9, 255];

  it('sizes buffers as 4 verts + 6 indices per station', () => {
    const d = makeFixture();
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildCircleBuffers(d, rel, fill, stroke);
    expect(b.stationCount).toBe(4);
    expect(b.vertexCount).toBe(16);
    expect(b.center.length).toBe(32);
    expect(b.corner.length).toBe(32);
    expect(b.fill.length).toBe(64);
    expect(b.stroke.length).toBe(64);
    expect(b.indices.length).toBe(24);
  });

  it('uses the unit-corner template + winding', () => {
    const d = makeFixture();
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildCircleBuffers(d, rel, fill, stroke);
    expect(Array.from(b.corner.slice(0, 8))).toEqual([-1, -1, 1, -1, 1, 1, -1, 1]);
    expect(Array.from(b.indices.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
    expect(Array.from(b.indices.slice(6, 12))).toEqual([4, 5, 6, 4, 6, 7]);
  });

  it('centers are the anchor-relative station positions; colors propagate', () => {
    const d = makeFixture();
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildCircleBuffers(d, rel, fill, stroke);
    // Station 2 (global idx 2) center at all 4 of its corners.
    for (let c = 0; c < 4; c++) {
      const v = 2 * 4 + c;
      expect(b.center[v * 2]).toBeCloseTo(rel[4]!, 6);
      expect(b.center[v * 2 + 1]).toBeCloseTo(rel[5]!, 6);
      expect(Array.from(b.fill.slice(v * 4, v * 4 + 4))).toEqual([2, 0, 0, 255]);
      expect(Array.from(b.stroke.slice(v * 4, v * 4 + 4))).toEqual([9, 9, 9, 255]);
    }
  });
});

describe('tessellation exclusion (move-drag hide semantics)', () => {
  const stubColor = (shotIdx: number, sectionId: number): Rgba8 => [shotIdx, sectionId, 7, 255];
  const fill = (g: number): Rgba8 => [g, 0, 0, 255];
  const stroke = (_g: number): Rgba8 => [9, 9, 9, 255];

  // Shared fixture handles: section 1 owns stations 0,1,2 + shots (global 0,1);
  // section 2 owns station 3 + an invalid shot (global 2, dropped).

  it('countValidShots drops excluded sections and shots, in lock-step', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    // Baseline.
    expect(countValidShots(d, lookup)).toBe(2);
    // Empty exclusion object == no exclusion.
    expect(countValidShots(d, lookup, {})).toBe(2);
    // Whole section 1 excluded -> both its shots gone.
    expect(countValidShots(d, lookup, { sectionIds: new Set([1]) })).toBe(0);
    // Single shot (global 0) excluded -> one valid shot remains.
    expect(countValidShots(d, lookup, { shotGlobalIndices: new Set([0]) })).toBe(1);
  });

  it('buildLineBuffers omits an excluded shot and keeps the rest intact', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildLineBuffers(d, rel, lookup, stubColor, { shotGlobalIndices: new Set([0]) });
    expect(b.segmentCount).toBe(1);
    expect(b.vertexCount).toBe(4);
    expect(b.indices.length).toBe(6);
    expect(Array.from(b.indices)).toEqual([0, 1, 2, 2, 1, 3]);
    // The surviving segment is shot global 1 (station idx1 -> idx2), color stub(1, 1).
    expect(Array.from(b.color.slice(0, 4))).toEqual([1, 1, 7, 255]);
    expect(b.posA[0]).toBeCloseTo(rel[2]!, 6); // station global 1
    expect(b.posB[0]).toBeCloseTo(rel[4]!, 6); // station global 2
  });

  it('buildLineBuffers with an excluded section yields zero segments', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildLineBuffers(d, rel, lookup, stubColor, { sectionIds: new Set([1]) });
    expect(b.segmentCount).toBe(0);
    expect(b.vertexCount).toBe(0);
    expect(b.indices.length).toBe(0);
  });

  it('buildCircleBuffers omits an excluded station and compacts output', () => {
    const d = makeFixture();
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildCircleBuffers(d, rel, fill, stroke, { stationGlobalIndices: new Set([1]) });
    expect(b.stationCount).toBe(3); // globals 0, 2, 3 survive
    expect(b.vertexCount).toBe(12);
    expect(b.indices.length).toBe(18);
    // Output slot 0 = global 0, slot 1 = global 2, slot 2 = global 3 (compacted).
    expect(Array.from(b.fill.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(b.fill.slice(4 * 4, 4 * 4 + 4))).toEqual([2, 0, 0, 255]);
    expect(Array.from(b.fill.slice(8 * 4, 8 * 4 + 4))).toEqual([3, 0, 0, 255]);
    // Slot 1 (out index 1) center is global 2's anchor-relative position.
    expect(b.center[4 * 2]).toBeCloseTo(rel[4]!, 6);
    expect(b.center[4 * 2 + 1]).toBeCloseTo(rel[5]!, 6);
    // Compacted indices reference the compacted vertex slots.
    expect(Array.from(b.indices.slice(6, 12))).toEqual([4, 5, 6, 4, 6, 7]);
  });

  it('buildCircleBuffers with an excluded section drops all its stations', () => {
    const d = makeFixture();
    const rel = projectStationsRel(d, null, 0, 0);
    const b = buildCircleBuffers(d, rel, fill, stroke, { sectionIds: new Set([1]) });
    expect(b.stationCount).toBe(1); // only section 2's station 3
    expect(Array.from(b.fill.slice(0, 4))).toEqual([3, 0, 0, 255]);
  });

  it('a station/shot move excludes both endpoint stations and the shot together', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    const rel = projectStationsRel(d, null, 0, 0);
    const exclude = { stationGlobalIndices: new Set([1, 2]), shotGlobalIndices: new Set([1]) };
    const line = buildLineBuffers(d, rel, lookup, stubColor, exclude);
    const circle = buildCircleBuffers(d, rel, fill, stroke, exclude);
    expect(line.segmentCount).toBe(1); // shot global 1 hidden; shot global 0 remains
    expect(circle.stationCount).toBe(2); // globals 0, 3 remain
  });

  it('no exclusion (undefined / {} ) is byte-identical to the plain build', () => {
    const d = makeFixture();
    const lookup = buildStationLookup(d);
    const rel = projectStationsRel(d, null, 0, 0);
    const baseLine = buildLineBuffers(d, rel, lookup, stubColor);
    const emptyLine = buildLineBuffers(d, rel, lookup, stubColor, {});
    expect(emptyLine.segmentCount).toBe(baseLine.segmentCount);
    expect(Array.from(emptyLine.indices)).toEqual(Array.from(baseLine.indices));
    expect(Array.from(emptyLine.color)).toEqual(Array.from(baseLine.color));
    expect(Array.from(emptyLine.posA)).toEqual(Array.from(baseLine.posA));

    const baseCircle = buildCircleBuffers(d, rel, fill, stroke);
    const emptyCircle = buildCircleBuffers(d, rel, fill, stroke, {});
    expect(emptyCircle.stationCount).toBe(baseCircle.stationCount);
    expect(Array.from(emptyCircle.indices)).toEqual(Array.from(baseCircle.indices));
    expect(Array.from(emptyCircle.fill)).toEqual(Array.from(baseCircle.fill));
    expect(Array.from(emptyCircle.center)).toEqual(Array.from(baseCircle.center));
  });
});

describe('SurveyCustomLayer first-frames GL-error probe', () => {
  /** Private-method accessor: the GL draw path stays untested, but the pure
   *  frame-accounting around gl.getError() is exercised with a fake context. */
  type Probe = { checkFrameError(gl: WebGL2RenderingContext, data: CustomRenderData): void };
  const probe = (l: SurveyCustomLayer): Probe => l as unknown as Probe;

  const fakeData = (): CustomRenderData =>
    ({
      line: { segmentCount: 2, byteLength: 100 },
      circle: { stationCount: 4, byteLength: 40 },
    }) as unknown as CustomRenderData;

  /** Minimal GL stub: only NO_ERROR + a scripted getError() are touched here. */
  const fakeGl = (getError: () => number): WebGL2RenderingContext =>
    ({ NO_ERROR: 0, getError }) as unknown as WebGL2RenderingContext;

  afterEach(() => vi.restoreAllMocks());

  it('checks getError() only until the first N clean frames, then stops', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const getError = vi.fn(() => 0);
    const layer = new SurveyCustomLayer('id', null);
    const gl = fakeGl(getError);
    const data = fakeData();
    for (let i = 0; i < 8; i++) probe(layer).checkFrameError(gl, data);
    // 5 clean frames validated, then it stops calling getError().
    expect(getError).toHaveBeenCalledTimes(5);
    expect(layer.isDisabled()).toBe(false);
    // The first clean frame logs 'first frame drawn OK' exactly once (ungated).
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('[customRender] first frame drawn OK');
  });

  it('self-disables and notifies the callback on a GL error', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSelfDisable = vi.fn();
    const layer = new SurveyCustomLayer('id', null, onSelfDisable);
    // First frame clean, second frame raises INVALID_OPERATION (0x502).
    let call = 0;
    const gl = fakeGl(() => (call++ === 0 ? 0 : 0x502));
    const data = fakeData();
    probe(layer).checkFrameError(gl, data);
    probe(layer).checkFrameError(gl, data);
    expect(layer.isDisabled()).toBe(true);
    expect(layer.getDisabledReason()).toBe('gl-error-0x502');
    expect(onSelfDisable).toHaveBeenCalledOnce();
    expect(onSelfDisable).toHaveBeenCalledWith('gl-error-0x502');
    const lastWarn = warn.mock.calls[warn.mock.calls.length - 1];
    expect(lastWarn?.[0]).toContain('[customRender] GL error 0x502');
  });
});

// colorCtxNoop referenced to keep the fixture's intent explicit for future
// color-mode tests; the resolvers are exercised via the controller elsewhere.
void colorCtxNoop;
