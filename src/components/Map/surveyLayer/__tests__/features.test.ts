/**
 * Move-comment palette coverage (#52).
 *
 * `buildSurveyFeatures` assigns each comment an ordinal in build order
 * (shots first, then stations) and embeds `commentColor` = `COMMENT_PALETTE[
 * ordinal % 8]` on the comment label feature AND the shot/station it
 * belongs to, so the map can tint a comment and its owning feature the
 * same color while the move-comment tool is active.
 */
import { describe, expect, it } from 'vitest';
import { buildSurveyFeatures } from '../features';
import { surveyDataFromLegacy } from '../../../../types/survey-data';
import { getMapThemeColors } from '../../../../utils/themeColors';
import { COMMENT_PALETTE } from '../../../../utils/colors';
import type { Section } from '../../../../types/ipc/Section';
import type { Shot } from '../../../../types/ipc/Shot';
import type { Station } from '../../../../types/ipc/Station';

const THEME = getMapThemeColors();
const DEPTH_RANGE = { min: 0, max: 50 };

function makeShot(id: number, comment: string | null): Shot {
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

function makeStation(stationIndex: number, comment: string | undefined): Station {
  return {
    station_ref: { section_id: 1, station_index: stationIndex },
    coordinates: { x: stationIndex * 10, y: 0, z: 0 },
    is_zero_datum: false,
    gps_coordinates: null,
    merged_with: [],
    closures_with: [],
    ...(comment !== undefined ? { comment } : {}),
  };
}

/**
 * A single section chained station 0 -> 1 -> ... -> shotCommentedIndices
 * length. `shotComments`/`stationComments` map a station/shot index to a
 * comment string; everything else has no comment.
 */
function fixture(
  shotCount: number,
  shotComments: Record<number, string>,
  stationComments: Record<number, string> = {}
): { sections: Section[]; stations: Station[] } {
  const shots: Shot[] = [];
  for (let i = 0; i < shotCount; i++) {
    shots.push(makeShot(100 + i, shotComments[i] ?? null));
  }
  const sections: Section[] = [
    {
      id: 1,
      name: 'Main',
      surveyor: null,
      date: null,
      color: '#4ecdc4',
      direction: 'in',
      quality: 1.0,
      next_shot_id: 100 + shotCount,
      shots,
    },
  ];

  const stations: Station[] = [];
  for (let i = 0; i <= shotCount; i++) {
    stations.push(makeStation(i, stationComments[i]));
  }

  return { sections, stations };
}

function build(sections: Section[], stations: Station[]) {
  const data = surveyDataFromLegacy(sections, stations);
  return buildSurveyFeatures(data, undefined, null, false, DEPTH_RANGE, THEME);
}

describe('buildSurveyFeatures - move-comment palette (#52)', () => {
  it('assigns no commentColor to shots/stations without a comment', () => {
    const { sections, stations } = fixture(3, { 1: 'mid shot' });
    const { shotFeatures, stationFeatures, shotLabelFeatures, stationLabelFeatures } = build(
      sections,
      stations
    );

    const uncommentedShot = shotFeatures.find((f) => f.properties?.shotId === 100);
    expect(uncommentedShot?.properties?.commentColor).toBeUndefined();

    const uncommentedShotLabel = shotLabelFeatures.find((f) => f.properties?.shotId === 100);
    expect(uncommentedShotLabel?.properties?.commentColor).toBeUndefined();

    for (const f of stationFeatures) {
      expect(f.properties?.commentColor).toBeUndefined();
    }
    for (const f of stationLabelFeatures) {
      expect(f.properties?.commentColor).toBeUndefined();
    }
  });

  it('tints the comment label and its owning shot the same palette color', () => {
    const { sections, stations } = fixture(3, { 1: 'mid shot' });
    const { shotFeatures, shotLabelFeatures } = build(sections, stations);

    const shotFeature = shotFeatures.find((f) => f.properties?.shotId === 101);
    const shotLabel = shotLabelFeatures.find((f) => f.properties?.shotId === 101);

    expect(shotFeature?.properties?.commentColor).toBeDefined();
    expect(shotLabel?.properties?.commentColor).toBe(shotFeature?.properties?.commentColor);
    expect(shotLabel?.properties?.comment).toBe('mid shot');
    expect(COMMENT_PALETTE).toContain(shotFeature?.properties?.commentColor);
  });

  it('tints the comment label and its owning station the same palette color', () => {
    const { sections, stations } = fixture(3, {}, { 2: 'junction note' });
    const { stationFeatures, stationLabelFeatures } = build(sections, stations);

    const stationFeature = stationFeatures.find((f) => f.properties?.stationIndex === 2);
    const stationLabel = stationLabelFeatures.find((f) => f.properties?.stationIndex === 2);

    expect(stationFeature?.properties?.commentColor).toBeDefined();
    expect(stationLabel?.properties?.commentColor).toBe(stationFeature?.properties?.commentColor);
    expect(stationLabel?.properties?.comment).toBe('junction note');
    expect(COMMENT_PALETTE).toContain(stationFeature?.properties?.commentColor);
  });

  it('is deterministic: rebuilding the same survey yields the same colors', () => {
    const shotComments = { 0: 'a', 2: 'b', 4: 'c' };
    const stationComments = { 1: 'd', 3: 'e' };

    const first = fixture(5, shotComments, stationComments);
    const second = fixture(5, shotComments, stationComments);

    const a = build(first.sections, first.stations);
    const b = build(second.sections, second.stations);

    const colorsOf = (feats: GeoJSON.Feature[], key: string) =>
      feats
        .map((f) => [f.properties?.[key], f.properties?.commentColor])
        .filter(([, c]) => c !== undefined);

    expect(colorsOf(a.shotFeatures, 'shotId')).toEqual(colorsOf(b.shotFeatures, 'shotId'));
    expect(colorsOf(a.stationFeatures, 'stationIndex')).toEqual(
      colorsOf(b.stationFeatures, 'stationIndex')
    );
  });

  it('assigns ordinals in build order (shots then stations) and wraps past 8 comments', () => {
    // 9 shot comments consume ordinals 0-8 (palette index 0..7 then wraps to 0);
    // the following station comment picks up at ordinal 9 (palette index 1).
    const shotComments: Record<number, string> = {};
    for (let i = 0; i < 9; i++) shotComments[i] = `shot-${i}`;
    const { sections, stations } = fixture(9, shotComments, { 0: 'station-0' });

    const { shotFeatures, stationFeatures } = build(sections, stations);

    const colorFor = (shotIndex: number) =>
      shotFeatures.find((f) => f.properties?.shotId === 100 + shotIndex)?.properties
        ?.commentColor;

    expect(colorFor(0)).toBe(COMMENT_PALETTE[0]);
    expect(colorFor(1)).toBe(COMMENT_PALETTE[1]);
    expect(colorFor(7)).toBe(COMMENT_PALETTE[7]);
    // 9th comment (ordinal 8) wraps back to palette[0], matching the 1st.
    expect(colorFor(8)).toBe(COMMENT_PALETTE[0]);
    expect(colorFor(8)).toBe(colorFor(0));

    // Station comment is the 10th comment overall (ordinal 9 -> palette[1]).
    const stationColor = stationFeatures.find((f) => f.properties?.stationIndex === 0)
      ?.properties?.commentColor;
    expect(stationColor).toBe(COMMENT_PALETTE[1]);
  });
});
