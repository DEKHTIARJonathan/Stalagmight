/**
 * Merged-group feature parity tests (#mem).
 *
 * `buildSurveyFeatures` with `mergeFeatures: true` collapses per-shot
 * LineStrings / per-station Points into one MultiLineString / MultiPoint per
 * (sectionId + paint-affecting properties) group. These tests pin the
 * invariants the map rendering relies on:
 *
 *   - the union of merged coordinates equals the per-feature coordinate set
 *     (same order, nothing dropped or duplicated),
 *   - every group is homogeneous: its shared properties equal the properties
 *     each member carried in the per-feature build,
 *   - the color palette is identical between the two builds (same interning
 *     order), so `colorIndex` values are directly comparable,
 *   - the shared resolve*DisplayColor helpers reproduce the exact per-feature
 *     colors (the interact overlay depends on this),
 *   - non-merged groups (labels, gradients, loop closures) are unaffected.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSurveyFeatures,
  resolveShotDisplayColor,
  resolveStationDisplayColor,
  resolveStationStrokeColor,
  type DisplayColorContext,
} from '../features';
import { surveyDataFromLegacy, SHOT_FLAG_IS_REFERENCE } from '../../../../types/survey-data';
import { getMapThemeColors } from '../../../../utils/themeColors';
import type { Section } from '../../../../types/ipc/Section';
import type { Station } from '../../../../types/ipc/Station';

const theme = getMapThemeColors();
const depthRange = { min: -12, max: 0 };

function fixture(): { sections: Section[]; stations: Station[] } {
  const shot = (id: number, depth_in: number, depth_out: number, is_reference = false) => ({
    id,
    azimuth_in: 0,
    azimuth_out: 0,
    length: 8,
    depth_in,
    depth_out,
    pitch_in: null,
    pitch_out: null,
    left: null,
    right: null,
    up: null,
    down: null,
    comment: null,
    is_reference,
    marker_index: null,
    temperature: null,
  });
  const sections: Section[] = [
    {
      id: 1, name: 'A', surveyor: null, date: null, color: '#ff0000',
      direction: 'in', quality: 1, next_shot_id: 10,
      // Mixed reference/non-reference: expect 2 shot groups in section mode.
      shots: [shot(101, 0, -4), shot(102, -4, -10), shot(103, -10, -10, true)],
    },
    {
      id: 2, name: 'B', surveyor: null, date: null, color: '#00ff00',
      direction: 'in', quality: 1, next_shot_id: 10,
      shots: [shot(201, -2, -2)],
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
    st(1, 3, 8, 16, -10), // endpoint of the reference shot only
    st(2, 0, 20, 0, -2),
    st(2, 1, 26, 0, -2),
  ];
  return { sections, stations };
}

interface Mode {
  name: string;
  showDepthGradient: boolean;
  options: { showIssueSeverity?: boolean; issueSeverity?: { shotSeverity: Uint8Array; stationSeverity: Uint8Array } };
}

function modes(shotCount: number, stationCount: number): Mode[] {
  // Alternate severities so severity mode produces multiple groups per section.
  const shotSeverity = new Uint8Array(shotCount).map((_, i) => (i % 3) as number);
  const stationSeverity = new Uint8Array(stationCount).map((_, i) => ((i + 1) % 3) as number);
  return [
    { name: 'section-color', showDepthGradient: false, options: {} },
    { name: 'depth', showDepthGradient: true, options: {} },
    {
      name: 'severity',
      showDepthGradient: false,
      options: { showIssueSeverity: true, issueSeverity: { shotSeverity, stationSeverity } },
    },
  ];
}

function buildBoth(mode: Mode) {
  const { sections, stations } = fixture();
  const data = surveyDataFromLegacy(sections, stations);
  const args = [data, undefined, null, mode.showDepthGradient, depthRange, theme, undefined] as const;
  const perFeature = buildSurveyFeatures(...args, { ...mode.options, mergeFeatures: false });
  const merged = buildSurveyFeatures(...args, { ...mode.options, mergeFeatures: true });
  return { data, perFeature, merged };
}

/** All [lng,lat] positions of a shot/station feature list, flattened in order. */
function flattenPositions(features: GeoJSON.Feature[]): GeoJSON.Position[] {
  const out: GeoJSON.Position[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (g.type === 'LineString') out.push(...g.coordinates);
    else if (g.type === 'MultiLineString') for (const line of g.coordinates) out.push(...line);
    else if (g.type === 'Point') out.push(g.coordinates);
    else if (g.type === 'MultiPoint') out.push(...g.coordinates);
  }
  return out;
}

describe('buildSurveyFeatures mergeFeatures (#mem)', () => {
  const { sections, stations } = fixture();
  const shotCount = sections.reduce((s, sec) => s + sec.shots.length, 0);

  for (const mode of modes(shotCount, stations.length)) {
    describe(`mode: ${mode.name}`, () => {
      it('merged shot coordinates equal the per-shot coordinate set, in order', () => {
        const { perFeature, merged } = buildBoth(mode);
        // Grouping preserves per-section iteration order; flattening group
        // lines in emit order must yield a permutation of the per-shot pairs.
        // Compare as sorted JSON (order within a section can interleave
        // between groups when colors alternate).
        const a = flattenPositions(perFeature.shotFeatures).map((p) => JSON.stringify(p)).sort();
        const b = flattenPositions(merged.shotFeatures).map((p) => JSON.stringify(p)).sort();
        expect(b).toEqual(a);
        // And pairs stay intact: every merged line is exactly one shot's pair.
        const perShotPairs = new Set(
          perFeature.shotFeatures.map((f) =>
            JSON.stringify((f.geometry as GeoJSON.LineString).coordinates)),
        );
        for (const f of merged.shotFeatures) {
          const lines = (f.geometry as GeoJSON.MultiLineString).coordinates;
          for (const line of lines) {
            expect(perShotPairs.has(JSON.stringify(line))).toBe(true);
          }
        }
      });

      it('merged station coordinates equal the per-station coordinate set', () => {
        const { perFeature, merged } = buildBoth(mode);
        const a = flattenPositions(perFeature.stationFeatures).map((p) => JSON.stringify(p)).sort();
        const b = flattenPositions(merged.stationFeatures).map((p) => JSON.stringify(p)).sort();
        expect(b).toEqual(a);
      });

      it('palettes are identical between per-feature and merged builds', () => {
        const { perFeature, merged } = buildBoth(mode);
        expect(merged.colorPalette).toEqual(perFeature.colorPalette);
      });

      it('every shot group carries exactly its members\' shared properties', () => {
        const { perFeature, merged } = buildBoth(mode);
        // Index per-shot features by their line coordinates.
        const byLine = new Map<string, GeoJSON.Feature>();
        for (const f of perFeature.shotFeatures) {
          byLine.set(JSON.stringify((f.geometry as GeoJSON.LineString).coordinates), f);
        }
        const seenGroupIds = new Set<number>();
        for (const f of merged.shotFeatures) {
          const props = f.properties!;
          expect(typeof props.featureId).toBe('number');
          expect(seenGroupIds.has(props.featureId as number)).toBe(false);
          seenGroupIds.add(props.featureId as number);
          for (const line of (f.geometry as GeoJSON.MultiLineString).coordinates) {
            const member = byLine.get(JSON.stringify(line))!;
            expect(member).toBeDefined();
            expect(props.sectionId).toBe(member.properties!.sectionId);
            expect(props.colorIndex).toBe(member.properties!.colorIndex);
            expect(props.isReference).toBe(member.properties!.isReference);
          }
        }
      });

      it('every station group carries exactly its members\' shared properties', () => {
        const { perFeature, merged } = buildBoth(mode);
        const byPoint = new Map<string, GeoJSON.Feature>();
        for (const f of perFeature.stationFeatures) {
          byPoint.set(JSON.stringify((f.geometry as GeoJSON.Point).coordinates), f);
        }
        const seenGroupIds = new Set<number>();
        for (const f of merged.stationFeatures) {
          const props = f.properties!;
          expect(seenGroupIds.has(props.featureId as number)).toBe(false);
          seenGroupIds.add(props.featureId as number);
          for (const point of (f.geometry as GeoJSON.MultiPoint).coordinates) {
            const member = byPoint.get(JSON.stringify(point))!;
            expect(member).toBeDefined();
            expect(props.sectionId).toBe(member.properties!.sectionId);
            expect(props.colorIndex).toBe(member.properties!.colorIndex);
            expect(props.strokeColorIndex).toBe(member.properties!.strokeColorIndex);
            expect(props.isZeroDatum).toBe(member.properties!.isZeroDatum);
            expect(props.allShotsReference).toBe(member.properties!.allShotsReference);
          }
        }
      });

      it('labels / gradients / closures are unaffected by merging', () => {
        const { perFeature, merged } = buildBoth(mode);
        expect(merged.shotLabelFeatures).toEqual(perFeature.shotLabelFeatures);
        expect(merged.stationLabelFeatures).toEqual(perFeature.stationLabelFeatures);
        expect(merged.sectionLabelFeatures).toEqual(perFeature.sectionLabelFeatures);
        expect(merged.shotGradientFeatures).toEqual(perFeature.shotGradientFeatures);
        expect(merged.loopClosureFeatures).toEqual(perFeature.loopClosureFeatures);
      });

      it('resolve*DisplayColor reproduces the per-feature colors exactly', () => {
        const { data, perFeature } = buildBoth(mode);
        const ctx: DisplayColorContext = {
          showDepthGradient: mode.showDepthGradient,
          depthRange,
          themeColors: theme,
          showIssueSeverity: mode.options.showIssueSeverity ?? false,
          issueSeverity: mode.options.issueSeverity,
        };
        // Shots: walk global shot order (mirrors the builder's iteration).
        let shotOrdinal = 0;
        for (const section of data.sections) {
          for (let i = 0; i < section.shotCount; i++) {
            const f = perFeature.shotFeatures[shotOrdinal]!;
            const globalIdx = section.shotOffset + i;
            expect(
              resolveShotDisplayColor(data, section.color, globalIdx, ctx),
            ).toBe(perFeature.colorPalette[f.properties!.colorIndex as number]);
            shotOrdinal++;
          }
        }
        // Stations: global index order matches the per-feature emission order.
        const sectionById = new Map(data.sections.map((s) => [s.id, s]));
        for (let g = 0; g < data.stationCount; g++) {
          const f = perFeature.stationFeatures[g]!;
          const sectionColor = sectionById.get(data.stationSectionIds[g]!)!.color;
          expect(
            resolveStationDisplayColor(data, sectionColor, g, ctx),
          ).toBe(perFeature.colorPalette[f.properties!.colorIndex as number]);
          const isZeroDatum = f.properties!.isZeroDatum as boolean;
          expect(
            resolveStationStrokeColor(isZeroDatum, ctx),
          ).toBe(perFeature.colorPalette[f.properties!.strokeColorIndex as number]);
        }
      });
    });
  }

  it('section-color mode: group counts collapse to per-(section, ref-flag)', () => {
    const { merged } = buildBoth({ name: 'section-color', showDepthGradient: false, options: {} });
    // Section 1: non-reference group + reference group; section 2: one group.
    expect(merged.shotFeatures).toHaveLength(3);
    // Station groups: section 1 has a zero-datum station (own group), stations
    // with non-reference shots, and one reference-only station (allShotsReference
    // differs -> own group); section 2 one group.
    const bySection = new Map<number, number>();
    for (const f of merged.stationFeatures) {
      const sid = f.properties!.sectionId as number;
      bySection.set(sid, (bySection.get(sid) ?? 0) + 1);
    }
    expect(bySection.get(1)).toBe(3);
    expect(bySection.get(2)).toBe(1);
  });

  it('reference flag drives grouping (data sanity)', () => {
    const { data } = buildBoth({ name: 'section-color', showDepthGradient: false, options: {} });
    expect((data.shotFlags[2]! & SHOT_FLAG_IS_REFERENCE) !== 0).toBe(true);
  });
});
