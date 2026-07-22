import { describe, expect, it } from 'vitest';
import type { MapThemeColors } from '../../../../../utils/themeColors';
import { LABEL_KIND } from '../labelShaders';
import { packCssColor } from '../colorPack';
import {
  interpolateStops,
  resolveHaloColors,
  computeLabelUniforms,
  LABEL_KIND_STYLE,
  type LabelStyleInputs,
} from '../labelStyle';

/**
 * Per-kind label style + per-frame uniform math (#customRender labels, Phase 2).
 * Pure, node env. Locks the size / opacity / decimation / minzoom / halo numbers
 * to the stock symbol layers and the DPR + reference-hide wiring the shader reads.
 */

const THEME = { textHalo: '#111111', textHaloAlt: '#222222' } as unknown as MapThemeColors;

const S = LABEL_KIND.STATION_LABEL;
const SEC = LABEL_KIND.SECTION_NAME;

/** All-enabled inputs at a given DPR with theme halo colors resolved. */
function inputs(over: Partial<LabelStyleInputs> = {}): LabelStyleInputs {
  return {
    dpr: 1,
    kindEnabled: [true, true, true, true, true],
    haloColors: resolveHaloColors(THEME),
    hideReference: false,
    ...over,
  };
}

describe('interpolateStops', () => {
  it('clamps below the first and above the last stop', () => {
    const stops = [[14, 9], [18, 11]] as const;
    expect(interpolateStops(10, stops)).toBe(9);
    expect(interpolateStops(14, stops)).toBe(9);
    expect(interpolateStops(18, stops)).toBe(11);
    expect(interpolateStops(30, stops)).toBe(11);
  });

  it('linearly interpolates between stops', () => {
    expect(interpolateStops(16, [[14, 9], [18, 11]])).toBeCloseTo(10, 6);
    expect(interpolateStops(15, [[14, 0.7], [18, 1]])).toBeCloseTo(0.775, 6);
  });

  it('treats a single stop as a constant', () => {
    expect(interpolateStops(0, [[0, 0.85]])).toBe(0.85);
    expect(interpolateStops(99, [[0, 0.85]])).toBe(0.85);
  });
});

describe('resolveHaloColors', () => {
  it('uses textHalo for section names and textHaloAlt for every other kind', () => {
    const halos = resolveHaloColors(THEME);
    expect(halos[SEC]).toEqual(packCssColor('#111111'));
    expect(halos[LABEL_KIND.STATION_LABEL]).toEqual(packCssColor('#222222'));
    expect(halos[LABEL_KIND.SHOT_LABEL]).toEqual(packCssColor('#222222'));
    expect(halos[LABEL_KIND.STATION_COMMENT]).toEqual(packCssColor('#222222'));
  });
});

describe('computeLabelUniforms', () => {
  it('interpolates station text size across the 14→9 / 18→11 band, scaled by DPR', () => {
    expect(computeLabelUniforms(14, inputs()).textSizePx[S]).toBeCloseTo(9, 6);
    expect(computeLabelUniforms(16, inputs()).textSizePx[S]).toBeCloseTo(10, 6);
    expect(computeLabelUniforms(18, inputs()).textSizePx[S]).toBeCloseTo(11, 6);
    // DPR 2 doubles the device-px size (viewport is device px too).
    expect(computeLabelUniforms(16, inputs({ dpr: 2 })).textSizePx[S]).toBeCloseTo(20, 6);
  });

  it('interpolates station opacity across 14→0.7 / 18→1', () => {
    expect(computeLabelUniforms(14, inputs()).opacity[S]).toBeCloseTo(0.7, 6);
    expect(computeLabelUniforms(18, inputs()).opacity[S]).toBeCloseTo(1, 6);
  });

  it('carries the zoom-band decimation modulus (station) and 1 for section names', () => {
    expect(computeLabelUniforms(15, inputs()).decimMod[S]).toBe(5);
    expect(computeLabelUniforms(17, inputs()).decimMod[S]).toBe(2);
    expect(computeLabelUniforms(19, inputs()).decimMod[S]).toBe(1);
    expect(computeLabelUniforms(19, inputs()).decimMod[SEC]).toBe(1);
  });

  it('gates kind visibility on the toggle AND the static minzoom', () => {
    // Station minzoom 14: hidden below, shown at/above when enabled.
    expect(computeLabelUniforms(13.9, inputs()).kindVisible[S]).toBe(0);
    expect(computeLabelUniforms(14, inputs()).kindVisible[S]).toBe(1);
    // Toggle off collapses it even above minzoom.
    const off = inputs({ kindEnabled: [false, false, false, false, false] });
    expect(computeLabelUniforms(16, off).kindVisible[S]).toBe(0);
    // Section names have minzoom 10.
    expect(computeLabelUniforms(11, inputs()).kindVisible[SEC]).toBe(1);
    expect(computeLabelUniforms(9, inputs()).kindVisible[SEC]).toBe(0);
  });

  it('scales halo width by DPR and packs halo colors to 0..1', () => {
    const u = computeLabelUniforms(16, inputs({ dpr: 2 }));
    expect(u.haloWidthPx[S]).toBeCloseTo(LABEL_KIND_STYLE[S].haloWidth * 2, 6);
    // textHaloAlt '#222222' -> 0x22/255 per channel.
    expect(u.haloColor[S * 4]).toBeCloseTo(0x22 / 255, 6);
    expect(u.haloColor[S * 4 + 3]).toBeCloseTo(1, 6);
  });

  it('passes the reference-hide scalar through', () => {
    expect(computeLabelUniforms(16, inputs()).hideReference).toBe(0);
    expect(computeLabelUniforms(16, inputs({ hideReference: true })).hideReference).toBe(1);
  });
});
