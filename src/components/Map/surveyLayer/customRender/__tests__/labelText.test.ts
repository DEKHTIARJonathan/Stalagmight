import { describe, expect, it } from 'vitest';
import {
  formatShotLabel,
  formatStationLabel,
  formatSectionLabel,
  formatCommentLabel,
  resolveShotLabelColor,
  resolveStationLabelColor,
  resolveSectionLabelColor,
  type LabelColorContext,
} from '../labelText';
import { buildSurveyFeatures, type DepthRange } from '../../features';
import { emptySurveyData, type SurveyData } from '../../../../../types/survey-data';
import type { MapThemeColors } from '../../../../../utils/themeColors';

/**
 * Label TEXT + COLOR parity lock (#customRender labels, Phase 1). `features.ts`
 * now builds its shot/station label strings and colors via these helpers, so the
 * only way the custom path can drift is if `features.ts` stops calling them.
 * This runs the real feature builder and asserts every shot/station label's
 * `label` + `color` equals what the shared helpers produce from the same raw
 * inputs — the "run both, assert equal" lock from §11 of the design.
 */

const THEME = {
  stationDefault: '#ffffff',
  zeroDatum: '#00ffff',
  strokeColor: '#000000',
  depthShallow: '#00bfff',
  depthDeep: '#ff4444',
  labelColor: '#e0e0e0',
  severityError: '#ef4444',
  severityWarning: '#eab308',
  severityClear: '#22c55e',
  grayLine: '#808080',
} as unknown as MapThemeColors;

const DEPTH_RANGE: DepthRange = { min: -2, max: 0 };

/** One section, 2 shots (0,1), 3 stations (idx 0,1,2) at descending z. */
function fixture(): SurveyData {
  const d = emptySurveyData();
  d.sections = [
    { id: 1, name: 'Alpha', surveyor: null, date: null, color: '#4ecdc4', direction: 'in' as never, quality: 0, next_shot_id: 2, shotOffset: 0, shotCount: 2 },
  ];
  d.shotCount = 2;
  d.shotIds = new Int32Array([0, 1]);
  d.shotSectionIds = new Int32Array([1, 1]);
  d.shotFlags = new Uint8Array([0, 0]);
  d.shotAzimuthIn = new Float32Array([312, 45]);
  d.shotLength = new Float32Array([4.2, 3.1]);
  d.shotDepthIn = new Float32Array([1, 2]);
  d.shotDepthOut = new Float32Array([2, 4]);
  d.stationCount = 3;
  d.stationSectionIds = new Int32Array([1, 1, 1]);
  d.stationIndices = new Uint32Array([0, 1, 2]);
  d.stationCoords = new Float64Array([0, 0, 0, 10, 0, -1, 20, 0, -2]);
  d.stationFlags = new Uint8Array([0, 0, 0]);
  return d;
}

function ctxFor(showDepthGradient: boolean): LabelColorContext {
  return {
    showDepthGradient,
    depthShallow: THEME.depthShallow,
    depthDeep: THEME.depthDeep,
    depthMin: DEPTH_RANGE.min,
    depthMax: DEPTH_RANGE.max,
    labelColor: THEME.labelColor,
  };
}

describe('labelText helpers (units)', () => {
  it('formats a shot label as "az° len m depth m"', () => {
    // Defaults: azimuth 0 dp, length + depth 1 dp.
    expect(formatShotLabel(312, 4.2, 1.8)).toBe('312° 4.2m 1.8m');
    expect(formatShotLabel(312, 4.2, -0.5, { azimuth: 0, length: 1, depth: 1 } as never)).toBe('312° 4.2m -0.5m');
  });

  it('formats a station label as its index; section as its name (empty for null)', () => {
    expect(formatStationLabel(7)).toBe('7');
    expect(formatSectionLabel('Alpha')).toBe('Alpha');
    expect(formatSectionLabel(null)).toBe('');
    expect(formatCommentLabel('hi there')).toBe('hi there');
  });

  it('flat mode -> labelColor; section -> its own color', () => {
    const flat = ctxFor(false);
    expect(resolveShotLabelColor(1.5, flat)).toBe(THEME.labelColor);
    expect(resolveStationLabelColor(-1, flat)).toBe(THEME.labelColor);
    expect(resolveSectionLabelColor('#4ecdc4')).toBe('#4ecdc4');
  });

  it('depth mode -> the ramp color (a hex string), not labelColor', () => {
    const depth = ctxFor(true);
    const c = resolveShotLabelColor(-1, depth);
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    expect(c).not.toBe(THEME.labelColor);
  });
});

describe.each([
  ['flat', false],
  ['depth', true],
])('features.ts label parity (%s mode)', (_name, showDepth) => {
  it('every shot label matches formatShotLabel + resolveShotLabelColor', () => {
    const d = fixture();
    const built = buildSurveyFeatures(d, undefined, null, showDepth, DEPTH_RANGE, THEME, undefined, {
      buildLabels: true,
    });
    const ctx = ctxFor(showDepth);
    // Shot 0: stations z 0 -> -1 (labelDepth -0.5), depth 1..2 (avg 1.5).
    // Shot 1: stations z -1 -> -2 (labelDepth -1.5), depth 2..4 (avg 3).
    const expected = [
      { label: formatShotLabel(d.shotAzimuthIn[0]!, d.shotLength[0]!, -0.5, undefined), color: resolveShotLabelColor(1.5, ctx) },
      { label: formatShotLabel(d.shotAzimuthIn[1]!, d.shotLength[1]!, -1.5, undefined), color: resolveShotLabelColor(3, ctx) },
    ];
    expect(built.shotLabelFeatures).toHaveLength(2);
    for (let k = 0; k < 2; k++) {
      expect(built.shotLabelFeatures[k]!.properties!.label).toBe(expected[k]!.label);
      expect(built.shotLabelFeatures[k]!.properties!.color).toBe(expected[k]!.color);
    }
  });

  it('every station label matches formatStationLabel + resolveStationLabelColor', () => {
    const d = fixture();
    const built = buildSurveyFeatures(d, undefined, null, showDepth, DEPTH_RANGE, THEME, undefined, {
      buildLabels: true,
    });
    const ctx = ctxFor(showDepth);
    const z = [0, -1, -2];
    expect(built.stationLabelFeatures).toHaveLength(3);
    for (let g = 0; g < 3; g++) {
      const f = built.stationLabelFeatures.find((x) => x.properties!.globalOrdinal === g)!;
      expect(f.properties!.label).toBe(formatStationLabel(g)); // stationIndex === g here
      expect(f.properties!.color).toBe(resolveStationLabelColor(z[g]!, ctx));
    }
  });

  it('every section name matches its section color', () => {
    const d = fixture();
    const built = buildSurveyFeatures(d, undefined, null, showDepth, DEPTH_RANGE, THEME, undefined, {
      buildLabels: true,
    });
    expect(built.sectionLabelFeatures).toHaveLength(1);
    expect(built.sectionLabelFeatures[0]!.properties!.name).toBe(formatSectionLabel('Alpha'));
    expect(built.sectionLabelFeatures[0]!.properties!.color).toBe(resolveSectionLabelColor('#4ecdc4'));
  });
});
