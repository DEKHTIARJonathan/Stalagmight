/**
 * Parity net for the direct SoA -> VtLayerData builder (#mem).
 *
 * `buildShotStationVt` must be functionally identical to composing the legacy
 * two-stage path for shots and stations:
 *   shots    = vtLinesFromFeatures(buildSurveyFeatures(...).shotFeatures)
 *   stations = vtPointsFromFeatures(buildSurveyFeatures(...).stationFeatures)
 *
 * We assert deep equality of ids / coords (===, same two functions composed) /
 * groupPointOffsets / lineOffsets / groupLineOffsets / group count / per-group
 * props, for BOTH mergeFeatures values and for section-color, depth-gradient and
 * issue-severity modes.
 *
 * Palette subtlety: a full build in depth-gradient mode interns gradient-segment
 * colors INTERLEAVED with shot colors, so its `colorPalette` index order is NOT
 * reproducible by a shots+stations-only build from an empty seed. The builder is
 * therefore SEEDED with the reference palette (as the runtime swap seeds with the
 * resident palette) so `colorIndex` values match exactly. In the non-depth modes
 * (no interleaving) an empty seed reproduces the reference palette verbatim, which
 * we also assert.
 */
import { describe, expect, it } from 'vitest';
import { buildSurveyFeatures } from '../features';
import type { DisplayColorContext } from '../displayColor';
import { vtLinesFromFeatures, vtPointsFromFeatures, type VtLayerData } from '../vectorTileData';
import { buildShotStationVt, makeVtPalette } from '../vtSurveyBuild';
import { surveyDataFromLegacy, type SurveyData } from '../../../../types/survey-data';
import { getMapThemeColors } from '../../../../utils/themeColors';
import type { GpsOrigin } from '../../../../types/config';
import type { Section } from '../../../../types/ipc/Section';
import type { Station } from '../../../../types/ipc/Station';

const theme = getMapThemeColors();
const depthRange = { min: -12, max: 0 };

function fixture(): { sections: Section[]; stations: Station[] } {
  const shot = (id: number, depth_in: number, depth_out: number, is_reference = false) => ({
    id,
    azimuth_in: 12,
    azimuth_out: 15,
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
      // Mixed reference/non-reference -> multiple shot groups when merged.
      shots: [shot(101, 0, -4), shot(102, -4, -10), shot(103, -10, -10, true)],
    },
    {
      id: 2, name: 'B', surveyor: null, date: null, color: '#00ff00',
      direction: 'in', quality: 1, next_shot_id: 10,
      shots: [shot(201, -2, -2), shot(202, -2, -6)],
    },
    {
      id: 3, name: 'C', surveyor: null, date: null, color: '#ff0000', // same color as A
      direction: 'in', quality: 1, next_shot_id: 10,
      shots: [shot(301, -1, -3)],
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
    st(2, 2, 32, 0, -6),
    st(3, 0, 40, 0, -1),
    st(3, 1, 46, 0, -3),
  ];
  return { sections, stations };
}

interface Mode {
  name: string;
  showDepthGradient: boolean;
  showIssueSeverity: boolean;
  issueSeverity?: { shotSeverity: Uint8Array; stationSeverity: Uint8Array };
}

function modes(shotCount: number, stationCount: number): Mode[] {
  // Alternating severities so severity mode produces multiple groups per section.
  const shotSeverity = new Uint8Array(shotCount).map((_, i) => (i % 3) as number);
  const stationSeverity = new Uint8Array(stationCount).map((_, i) => ((i + 1) % 3) as number);
  return [
    { name: 'section-color', showDepthGradient: false, showIssueSeverity: false },
    { name: 'depth', showDepthGradient: true, showIssueSeverity: false },
    { name: 'severity', showDepthGradient: false, showIssueSeverity: true, issueSeverity: { shotSeverity, stationSeverity } },
  ];
}

/** Reduce a VtLayerData to plain JSON-comparable arrays/objects. */
function vtToPlain(vt: VtLayerData) {
  return {
    kind: vt.kind,
    ids: Array.from(vt.ids),
    props: vt.props,
    coords: Array.from(vt.coords),
    groupPointOffsets: Array.from(vt.groupPointOffsets),
    lineOffsets: vt.lineOffsets ? Array.from(vt.lineOffsets) : undefined,
    groupLineOffsets: vt.groupLineOffsets ? Array.from(vt.groupLineOffsets) : undefined,
  };
}

function assertVtEqual(actual: VtLayerData, expected: VtLayerData): void {
  expect(vtToPlain(actual)).toEqual(vtToPlain(expected));
}

/** Colors resolved through each build's own palette must match per group (proves
 *  color correctness even when index NUMBERING differs, e.g. empty-seed depth). */
function assertColorsMatch(actual: VtLayerData, actualPalette: string[], expected: VtLayerData, expectedPalette: string[]): void {
  expect(actual.props.length).toBe(expected.props.length);
  for (let i = 0; i < actual.props.length; i++) {
    const ap = actual.props[i]!;
    const ep = expected.props[i]!;
    expect(actualPalette[ap.colorIndex as number]).toBe(expectedPalette[ep.colorIndex as number]);
    if (ep.strokeColorIndex !== undefined) {
      expect(actualPalette[ap.strokeColorIndex as number]).toBe(expectedPalette[ep.strokeColorIndex as number]);
    }
  }
}

function ctxFor(mode: Mode): DisplayColorContext {
  // Mirror buildSurveyFeatures' internal colorCtx construction exactly.
  const showIssueSeverity = mode.showIssueSeverity && !!mode.issueSeverity;
  return {
    showDepthGradient: mode.showDepthGradient,
    depthRange,
    themeColors: theme,
    showIssueSeverity,
    issueSeverity: mode.issueSeverity,
  };
}

const origins: Array<{ name: string; origin: GpsOrigin | null }> = [
  { name: 'no gps origin', origin: null },
  { name: 'with gps origin', origin: { latitude: 20.2114, longitude: -87.4653 } },
];

describe('buildShotStationVt parity (#mem)', () => {
  const { sections, stations } = fixture();
  const shotCount = sections.reduce((s, sec) => s + sec.shots.length, 0);

  for (const { name: originName, origin } of origins) {
    for (const mode of modes(shotCount, stations.length)) {
      for (const mergeFeatures of [false, true]) {
        const label = `${originName} / ${mode.name} / mergeFeatures=${mergeFeatures}`;

        it(`matches the legacy two-stage build (seeded): ${label}`, () => {
          const data: SurveyData = surveyDataFromLegacy(sections, stations);
          const ref = buildSurveyFeatures(
            data, undefined, origin, mode.showDepthGradient, depthRange, theme, undefined,
            { mergeFeatures, showIssueSeverity: mode.showIssueSeverity, issueSeverity: mode.issueSeverity, buildLabels: false },
          );
          const refShots = vtLinesFromFeatures(ref.shotFeatures);
          const refStations = vtPointsFromFeatures(ref.stationFeatures);

          // Seed with the reference palette (== the runtime swap seeding with the
          // resident palette): colorIndex values then match in ALL modes.
          const out = buildShotStationVt(data, origin, ctxFor(mode), mergeFeatures, makeVtPalette(ref.colorPalette));
          assertVtEqual(out.shots, refShots);
          assertVtEqual(out.stations, refStations);
          // A pure toggle appends nothing, so the seeded palette is unchanged.
          expect(out.palette).toEqual(ref.colorPalette);
        });

        it(`empty-seed palette + colors are correct: ${label}`, () => {
          const data: SurveyData = surveyDataFromLegacy(sections, stations);
          const ref = buildSurveyFeatures(
            data, undefined, origin, mode.showDepthGradient, depthRange, theme, undefined,
            { mergeFeatures, showIssueSeverity: mode.showIssueSeverity, issueSeverity: mode.issueSeverity, buildLabels: false },
          );
          const refShots = vtLinesFromFeatures(ref.shotFeatures);
          const refStations = vtPointsFromFeatures(ref.stationFeatures);

          const out = buildShotStationVt(data, origin, ctxFor(mode), mergeFeatures, makeVtPalette());

          // Geometry / ids / offsets are palette-independent, so they match with
          // an empty seed regardless of mode.
          expect(Array.from(out.shots.ids)).toEqual(Array.from(refShots.ids));
          expect(Array.from(out.shots.coords)).toEqual(Array.from(refShots.coords));
          expect(Array.from(out.stations.coords)).toEqual(Array.from(refStations.coords));

          if (!mode.showDepthGradient) {
            // No interleaved gradient colors: an empty seed reproduces the exact
            // reference palette AND the full per-group output.
            expect(out.palette).toEqual(ref.colorPalette);
            assertVtEqual(out.shots, refShots);
            assertVtEqual(out.stations, refStations);
          } else {
            // Depth mode: index NUMBERING differs from the interleaved reference
            // palette, but the resolved colors must be identical per group.
            assertColorsMatch(out.shots, out.palette, refShots, ref.colorPalette);
            assertColorsMatch(out.stations, out.palette, refStations, ref.colorPalette);
          }
        });
      }
    }
  }

  it('seeding never shrinks the palette (superset preserved)', () => {
    const data: SurveyData = surveyDataFromLegacy(sections, stations);
    // A seed carrying colors no shot/station uses (mimics a resident
    // depth/gradient palette). The build must keep them at their seed indices.
    const seed = ['#0a0b0c', '#123456', '#abcdef'];
    const palette = makeVtPalette(seed);
    buildShotStationVt(data, null, ctxFor(modes(1, 1)[0]!), false, palette);
    // Append-only: the seed prefix stays at the same indices.
    expect(palette.colors.slice(0, seed.length)).toEqual(seed);
  });
});
