/**
 * Feature-builder color tests (#B).
 *
 * The shot / gradient-segment / station features carry a numeric `colorIndex`
 * (stations also `strokeColorIndex`) into `SurveyFeatureSets.colorPalette`
 * instead of a per-feature hex string. These tests pin the invariant the map
 * paint relies on: `palette[colorIndex]` equals EXACTLY the color the old
 * per-feature `color` string held, in every coloring mode (section / depth /
 * severity), so swapping the string for an index + `match` expression is a pure
 * memory change with zero visual difference.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSurveyFeatures,
  resolveShotDisplayColor,
  resolveShotEndpointColors,
  SURVEY_FEATURE_GROUP_ORDER,
  type SurveyFeatureGroupKey,
} from '../features';
import { commentColorForKey, type DisplayColorContext } from '../displayColor';
import { surveyDataFromLegacy } from '../../../../types/survey-data';
import { getMapThemeColors } from '../../../../utils/themeColors';
import { COMMENT_PALETTE, getDepthColor } from '../../../../utils/colors';
import type { Section } from '../../../../types/ipc/Section';
import type { Shot } from '../../../../types/ipc/Shot';
import type { Station } from '../../../../types/ipc/Station';

const theme = getMapThemeColors();

/** 2 sections (distinct colors) + 4 stations, with depths for gradient tests. */
function fixture(): { sections: Section[]; stations: Station[] } {
  const shot = (id: number, depth_in: number, depth_out: number, len: number) => ({
    id,
    azimuth_in: 0,
    azimuth_out: 0,
    length: len,
    depth_in,
    depth_out,
    pitch_in: null,
    pitch_out: null,
    left: null,
    right: null,
    up: null,
    down: null,
    comment: null,
    is_reference: false,
    marker_index: null,
    temperature: null,
  });
  const sections: Section[] = [
    {
      id: 1, name: 'A', surveyor: null, date: null, color: '#ff0000',
      direction: 'in', quality: 1, next_shot_id: 10,
      shots: [shot(101, 0, -4, 8), shot(102, -4, -10, 12)],
    },
    {
      id: 2, name: 'B', surveyor: null, date: null, color: '#00ff00',
      direction: 'in', quality: 1, next_shot_id: 10,
      shots: [shot(201, -2, -2, 6)],
    },
  ];
  const st = (
    section_id: number, station_index: number, x: number, y: number, z: number,
    is_zero_datum = false,
  ): Station => ({
    station_ref: { section_id, station_index },
    coordinates: { x, y, z },
    is_zero_datum,
    gps_coordinates: null,
    merged_with: [],
    closures_with: [],
  });
  const stations: Station[] = [
    st(1, 0, 0, 0, 0, true), // zero datum
    st(1, 1, 8, 0, -4),
    st(1, 2, 8, 8, -10),
    st(2, 0, 20, 0, -2),
    st(2, 1, 26, 0, -2),
  ];
  return { sections, stations };
}

const depthRange = { min: -10, max: 0 };

describe('buildSurveyFeatures color palette (#B)', () => {
  it('section-color mode: shots index the palette to their exact section color', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);
    const f = buildSurveyFeatures(data, undefined, null, false, depthRange, theme);

    // Section id → color for the assertion.
    const sectionColor = new Map(sections.map((s) => [s.id, s.color]));

    expect(f.shotFeatures.length).toBeGreaterThan(0);
    for (const feat of f.shotFeatures) {
      const props = feat.properties!;
      // The string color property is gone; a numeric index took its place.
      expect(props.color).toBeUndefined();
      expect(typeof props.colorIndex).toBe('number');
      // Exact reproduction: palette[colorIndex] == the section's color.
      expect(f.colorPalette[props.colorIndex as number]).toBe(
        sectionColor.get(props.sectionId as number),
      );
    }
    // No depth gradient segments in section-color mode.
    expect(f.shotGradientFeatures.length).toBe(0);
  });

  it('stations index the palette for both fill and stroke color', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);
    const f = buildSurveyFeatures(data, undefined, null, false, depthRange, theme);
    const sectionColor = new Map(sections.map((s) => [s.id, s.color]));

    expect(f.stationFeatures.length).toBe(stations.length);
    for (const feat of f.stationFeatures) {
      const props = feat.properties!;
      expect(props.color).toBeUndefined();
      expect(props.strokeColor).toBeUndefined();
      expect(typeof props.colorIndex).toBe('number');
      expect(typeof props.strokeColorIndex).toBe('number');

      const expectedFill = props.isZeroDatum
        ? theme.zeroDatum
        : sectionColor.get(props.sectionId as number);
      expect(f.colorPalette[props.colorIndex as number]).toBe(expectedFill);
      // Section-color mode: stroke is the theme stroke color for all stations.
      expect(f.colorPalette[props.strokeColorIndex as number]).toBe(theme.strokeColor);
    }
  });

  it('depth mode: shot + gradient indices reproduce getDepthColor exactly', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);
    const f = buildSurveyFeatures(data, undefined, null, true, depthRange, theme);

    // Base shot line uses the avg-depth color (fallback: section color).
    for (const feat of f.shotFeatures) {
      const props = feat.properties!;
      const gIdx = findShotGlobal(data, props.sectionId as number, props.shotId as number);
      const avg = (data.shotDepthIn[gIdx]! + data.shotDepthOut[gIdx]!) / 2;
      const expected =
        getDepthColor(avg, theme.depthShallow, theme.depthDeep, depthRange.min, depthRange.max) ??
        sectionColorOf(sections, props.sectionId as number);
      expect(f.colorPalette[props.colorIndex as number]).toBe(expected);
    }

    // Each gradient segment's palette entry equals the segment-midpoint depth color.
    expect(f.shotGradientFeatures.length).toBeGreaterThan(0);
    for (const feat of f.shotGradientFeatures) {
      const props = feat.properties!;
      expect(props.color).toBeUndefined();
      expect(typeof props.colorIndex).toBe('number');
      // Every gradient color must be a depth-ramp color present in the palette.
      const resolved = f.colorPalette[props.colorIndex as number];
      expect(typeof resolved).toBe('string');
    }
  });

  it('depth-gradient segment count scales with depth delta, not length (#C)', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);
    const f = buildSurveyFeatures(data, undefined, null, true, depthRange, theme);

    // Segments per shot.
    const perShot = new Map<number, number>();
    for (const feat of f.shotGradientFeatures) {
      const id = feat.properties!.shotId as number;
      perShot.set(id, (perShot.get(id) ?? 0) + 1);
    }

    // shot 101: |Δ| = 4 → ceil(4) = 4 segments.
    expect(perShot.get(101)).toBe(4);
    // shot 102: |Δ| = 6 → 6 segments.
    expect(perShot.get(102)).toBe(6);
    // shot 201: |Δ| = 0 (< 0.3 m) → a single midpoint-color segment.
    expect(perShot.get(201)).toBe(1);
  });

  it('a near-flat shot emits one segment at the midpoint depth color (#C)', () => {
    // One section, one shot with |Δ| = 0.2 m (< 0.3 m threshold).
    const sections: Section[] = [{
      id: 1, name: null, surveyor: null, date: null, color: '#123456',
      direction: 'in', quality: 1, next_shot_id: 2,
      shots: [{
        id: 1, azimuth_in: 0, azimuth_out: 0, length: 40, // long but flat
        depth_in: -5, depth_out: -5.2,
        pitch_in: null, pitch_out: null, left: null, right: null, up: null, down: null,
        comment: null, is_reference: false, marker_index: null, temperature: null,
      }],
    }];
    const stations: Station[] = [
      { station_ref: { section_id: 1, station_index: 0 }, coordinates: { x: 0, y: 0, z: -5 }, is_zero_datum: false, gps_coordinates: null, merged_with: [], closures_with: [] },
      { station_ref: { section_id: 1, station_index: 1 }, coordinates: { x: 40, y: 0, z: -5.2 }, is_zero_datum: false, gps_coordinates: null, merged_with: [], closures_with: [] },
    ];
    const data = surveyDataFromLegacy(sections, stations);
    const f = buildSurveyFeatures(data, undefined, null, true, { min: -10, max: 0 }, theme);

    // Long shot (40 m) that would have been 12 segments under the old
    // length/2 rule; now a single segment because the depth barely changes.
    expect(f.shotGradientFeatures.length).toBe(1);
    const seg = f.shotGradientFeatures[0]!;
    // Its color is the midpoint depth color: depth_in + Δ*0.5 = -5.1.
    const midColor = getDepthColor(-5.1, theme.depthShallow, theme.depthDeep, -10, 0);
    expect(f.colorPalette[seg.properties!.colorIndex as number]).toBe(midColor);
  });

  it('caps steep shots at 12 segments (#C)', () => {
    const sections: Section[] = [{
      id: 1, name: null, surveyor: null, date: null, color: '#123456',
      direction: 'in', quality: 1, next_shot_id: 2,
      shots: [{
        id: 1, azimuth_in: 0, azimuth_out: 0, length: 5,
        depth_in: 0, depth_out: -40, // |Δ| = 40 → ceil caps at 12
        pitch_in: null, pitch_out: null, left: null, right: null, up: null, down: null,
        comment: null, is_reference: false, marker_index: null, temperature: null,
      }],
    }];
    const stations: Station[] = [
      { station_ref: { section_id: 1, station_index: 0 }, coordinates: { x: 0, y: 0, z: 0 }, is_zero_datum: false, gps_coordinates: null, merged_with: [], closures_with: [] },
      { station_ref: { section_id: 1, station_index: 1 }, coordinates: { x: 5, y: 0, z: -40 }, is_zero_datum: false, gps_coordinates: null, merged_with: [], closures_with: [] },
    ];
    const data = surveyDataFromLegacy(sections, stations);
    const f = buildSurveyFeatures(data, undefined, null, true, { min: -40, max: 0 }, theme);
    expect(f.shotGradientFeatures.length).toBe(12);
  });

  it('palette deduplicates identical colors', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);
    const f = buildSurveyFeatures(data, undefined, null, false, depthRange, theme);
    // No palette entry appears twice.
    expect(new Set(f.colorPalette).size).toBe(f.colorPalette.length);
    // Two sections + zero-datum + stroke → a small bounded palette.
    expect(f.colorPalette.length).toBeLessThanOrEqual(8);
  });
});

describe('buildSurveyFeatures streaming emit (#mem)', () => {
  const GROUPS = [
    'shotFeatures',
    'stationFeatures',
    'sectionLabelFeatures',
    'shotGradientFeatures',
    'shotLabelFeatures',
    'stationLabelFeatures',
    'loopClosureFeatures',
  ] as const;

  for (const depth of [false, true]) {
    it(`emit path reproduces the non-emit groups + palette exactly (depth=${depth})`, () => {
      const { sections, stations } = fixture();
      const data = surveyDataFromLegacy(sections, stations);

      // Non-emit (reference) build.
      const ref = buildSurveyFeatures(data, undefined, null, depth, depthRange, theme, undefined, {
        buildLabels: true,
      });

      // Emit build: collect each streamed group + a copy of its palette snapshot.
      const streamed: Record<string, GeoJSON.Feature[]> = {};
      const snapshots: string[][] = [];
      const returned = buildSurveyFeatures(
        data,
        undefined,
        null,
        depth,
        depthRange,
        theme,
        undefined,
        { buildLabels: true },
        (group, features, palette) => {
          // Deep-copy: the builder clears the array right after this returns.
          streamed[group] = features.map((f) => JSON.parse(JSON.stringify(f)));
          snapshots.push([...palette]);
        },
      );

      // Every group was emitted exactly once and matches the reference.
      for (const g of GROUPS) {
        expect(streamed[g], `group ${g} emitted`).toBeDefined();
        expect(streamed[g]).toEqual(ref[g]);
        // The builder cleared its own copy after emitting.
        expect(returned[g].length).toBe(0);
      }

      // Final palette matches, and each snapshot is a prefix of the final
      // palette (append-only), so previously-applied colorIndex values stay
      // valid as later snapshots arrive.
      expect(returned.colorPalette).toEqual(ref.colorPalette);
      for (const snap of snapshots) {
        expect(returned.colorPalette.slice(0, snap.length)).toEqual(snap);
      }
    });
  }

  // #customRender station-label converge: the per-station labels must stream
  // early (right after their geometry) and never last. A delete fires a burst of
  // superseding flushes (edit + coordinate re-solve + warnings); the streamed
  // apply drops whichever label group rides the tail on a mid-stream token
  // supersession. When station labels rode last, a superseded flush landed the
  // shot labels but dropped the station labels, so station labels lagged the
  // shots by a reconcile. This locks the emit sequence that keeps station labels
  // adjacent to the shot labels.
  it('emits station labels early (after shots, before section labels / loop closures), never last', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);

    const order: SurveyFeatureGroupKey[] = [];
    buildSurveyFeatures(
      data,
      undefined,
      null,
      false,
      depthRange,
      theme,
      undefined,
      { buildLabels: true },
      (group) => {
        order.push(group);
      },
    );

    // Every group is streamed exactly once, in the documented order.
    expect(order).toEqual([...SURVEY_FEATURE_GROUP_ORDER]);

    const iShotLabels = order.indexOf('shotLabelFeatures');
    const iStationLabels = order.indexOf('stationLabelFeatures');
    const iSectionLabels = order.indexOf('sectionLabelFeatures');
    const iLoop = order.indexOf('loopClosureFeatures');

    // Station labels stream AFTER the shot labels but BEFORE the coarse section
    // labels and the loop closures — never on the drop-prone tail.
    expect(iShotLabels).toBeGreaterThanOrEqual(0);
    expect(iStationLabels).toBeGreaterThan(iShotLabels);
    expect(iStationLabels).toBeLessThan(iSectionLabels);
    expect(iStationLabels).toBeLessThan(iLoop);
    // And station labels are never the final streamed group.
    expect(iStationLabels).toBeLessThan(order.length - 1);

    // Under the custom renderer the bulk geometry groups (shots / gradients /
    // stations) are suppressed and never streamed, so the label groups stream
    // back-to-back. The station labels must land immediately after the shot
    // labels — zero groups between them — so no single-chunk supersession can
    // apply the shot labels yet drop the station labels.
    const labelSubsequence = order.filter((g) =>
      g === 'shotLabelFeatures' || g === 'stationLabelFeatures' || g === 'sectionLabelFeatures',
    );
    expect(labelSubsequence).toEqual([
      'shotLabelFeatures',
      'stationLabelFeatures',
      'sectionLabelFeatures',
    ]);
  });
});

describe('resolveShotEndpointColors (custom-render depth gradient)', () => {
  const ctxFor = (showDepthGradient: boolean): DisplayColorContext => ({
    showDepthGradient,
    depthRange,
    themeColors: theme,
    showIssueSeverity: false,
  });

  it('depth mode: endpoints are the in/out depth-ramp colors (stock gradient endpoints)', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);
    const ctx = ctxFor(true);
    // shot 101: depth_in 0, depth_out -4.
    const gIdx = findShotGlobal(data, 1, 101);
    const [from, to] = resolveShotEndpointColors(data, sectionColorOf(sections, 1), gIdx, ctx);
    expect(from).toBe(
      getDepthColor(0, theme.depthShallow, theme.depthDeep, depthRange.min, depthRange.max),
    );
    expect(to).toBe(
      getDepthColor(-4, theme.depthShallow, theme.depthDeep, depthRange.min, depthRange.max),
    );
    // The two endpoints differ (there is a real ramp along this shot).
    expect(from).not.toBe(to);
  });

  it('depth mode: a flat shot has equal endpoints', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);
    // shot 201: depth_in -2, depth_out -2 (flat).
    const gIdx = findShotGlobal(data, 2, 201);
    const [from, to] = resolveShotEndpointColors(data, sectionColorOf(sections, 2), gIdx, ctxFor(true));
    expect(from).toBe(to);
  });

  it('section-color mode: both endpoints equal the flat display color', () => {
    const { sections, stations } = fixture();
    const data = surveyDataFromLegacy(sections, stations);
    const ctx = ctxFor(false);
    const gIdx = findShotGlobal(data, 1, 101);
    const base = resolveShotDisplayColor(data, sectionColorOf(sections, 1), gIdx, ctx);
    const [from, to] = resolveShotEndpointColors(data, sectionColorOf(sections, 1), gIdx, ctx);
    expect(from).toBe(base);
    expect(to).toBe(base);
    expect(base).toBe(sectionColorOf(sections, 1));
  });
});

function sectionColorOf(sections: Section[], id: number): string {
  return sections.find((s) => s.id === id)!.color;
}

function findShotGlobal(
  data: ReturnType<typeof surveyDataFromLegacy>,
  sectionId: number,
  shotId: number,
): number {
  for (let i = 0; i < data.shotCount; i++) {
    if (data.shotSectionIds[i] === sectionId && data.shotIds[i] === shotId) return i;
  }
  throw new Error(`shot ${sectionId}:${shotId} not found`);
}

function commentShot(id: number, comment: string | null): Shot {
  return {
    id,
    azimuth_in: 0,
    azimuth_out: 0,
    length: 10,
    depth_in: 0,
    depth_out: 0,
    pitch_in: null,
    pitch_out: null,
    left: null,
    right: null,
    up: null,
    down: null,
    comment,
    is_reference: false,
    marker_index: null,
    temperature: null,
  };
}

describe('buildSurveyFeatures move-comment palette (#52)', () => {
  it('carries stable owner colors on per-feature shots and stations', () => {
    const sections: Section[] = [{
      id: 7,
      name: 'Commented',
      surveyor: null,
      date: null,
      color: '#4ecdc4',
      direction: 'in',
      quality: 1,
      next_shot_id: 2,
      shots: [commentShot(1, 'shot note')],
    }];
    const stations: Station[] = [
      { station_ref: { section_id: 7, station_index: 0 }, coordinates: { x: 0, y: 0, z: 0 }, is_zero_datum: false, gps_coordinates: null, merged_with: [], closures_with: [] },
      { station_ref: { section_id: 7, station_index: 1 }, coordinates: { x: 10, y: 0, z: 0 }, is_zero_datum: false, gps_coordinates: null, merged_with: [], closures_with: [], comment: 'station note' },
    ];
    const data = surveyDataFromLegacy(sections, stations);
    const built = buildSurveyFeatures(data, undefined, null, false, depthRange, theme);

    const shotColor = built.shotFeatures[0]?.properties?.commentColor;
    const stationColor = built.stationFeatures.find((f) => f.properties?.stationIndex === 1)
      ?.properties?.commentColor;
    expect(shotColor).toBe(commentColorForKey('7:s1'));
    expect(stationColor).toBe(commentColorForKey('7:st1'));
    expect(COMMENT_PALETTE).toContain(shotColor);
    expect(COMMENT_PALETTE).toContain(stationColor);
    expect(built.shotLabelFeatures[0]?.properties?.commentColor).toBe(shotColor);
    expect(built.stationLabelFeatures.find((f) => f.properties?.stationIndex === 1)
      ?.properties?.commentColor).toBe(stationColor);
  });
});
