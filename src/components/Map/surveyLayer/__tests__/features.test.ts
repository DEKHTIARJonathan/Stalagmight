/**
 * Move-comment palette coverage (#52).
 *
 * `buildSurveyFeatures` assigns each comment `commentColor` = `COMMENT_PALETTE[
 * hash(ownerKey) % 8]`, where `ownerKey` is a section-qualified identity of the
 * comment's owner (`${sectionId}:s${shotId}` for a shot comment, `${sectionId}
 * :st${stationIndex}` for a station comment) - see `commentColorForKey`. Colors
 * are keyed by identity, not build order, so a comment's color survives other
 * comments being added, removed, or moved elsewhere in the survey. The label
 * feature and its owning shot/station feature carry the same color so the map
 * can tint a comment and its target the same while the move-comment tool is
 * active.
 */
import { describe, expect, it } from 'vitest';
import { buildSurveyFeatures, commentColorForKey } from '../features';
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

function makeStation(
  sectionId: number,
  stationIndex: number,
  comment: string | undefined
): Station {
  return {
    station_ref: { section_id: sectionId, station_index: stationIndex },
    coordinates: { x: stationIndex * 10, y: 0, z: 0 },
    is_zero_datum: false,
    gps_coordinates: null,
    merged_with: [],
    closures_with: [],
    ...(comment !== undefined ? { comment } : {}),
  };
}

function makeSection(id: number, name: string, shots: Shot[]): Section {
  return {
    id,
    name,
    surveyor: null,
    date: null,
    color: '#4ecdc4',
    direction: 'in',
    quality: 1.0,
    next_shot_id: 100 + shots.length,
    shots,
  };
}

/**
 * A single section chained station 0 -> 1 -> ... -> shotCount, in section id
 * 1. `shotComments`/`stationComments` map a station/shot index to a comment
 * string; everything else has no comment.
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
  const sections: Section[] = [makeSection(1, 'Main', shots)];

  const stations: Station[] = [];
  for (let i = 0; i <= shotCount; i++) {
    stations.push(makeStation(1, i, stationComments[i]));
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

  it('is stable when a comment is added EARLIER in build order (would reshuffle under a build-order ordinal)', () => {
    // Shot 2 already has a comment. Adding a new comment to shot 0 - earlier
    // in build order - must NOT change shot 2's color: colors are keyed by
    // owner identity, not by "how many comments came before me".
    const before = fixture(4, { 2: 'existing shot comment' });
    const after = fixture(4, { 0: 'new earlier comment', 2: 'existing shot comment' });

    const beforeBuilt = build(before.sections, before.stations);
    const afterBuilt = build(after.sections, after.stations);

    const colorFor = (feats: GeoJSON.Feature[], shotId: number) =>
      feats.find((f) => f.properties?.shotId === shotId)?.properties?.commentColor;

    expect(colorFor(afterBuilt.shotFeatures, 102)).toBe(colorFor(beforeBuilt.shotFeatures, 102));
    expect(colorFor(afterBuilt.shotFeatures, 102)).toBeDefined();
  });

  it('assigns a color from COMMENT_PALETTE to every commented shot and station', () => {
    const shotComments: Record<number, string> = {};
    for (let i = 0; i < 9; i++) shotComments[i] = `shot-${i}`;
    const { sections, stations } = fixture(9, shotComments, { 0: 'station-0' });

    const { shotFeatures, stationFeatures } = build(sections, stations);

    for (const f of shotFeatures) {
      if (f.properties?.commentColor !== undefined) {
        expect(COMMENT_PALETTE).toContain(f.properties.commentColor);
      }
    }
    for (const f of stationFeatures) {
      if (f.properties?.commentColor !== undefined) {
        expect(COMMENT_PALETTE).toContain(f.properties.commentColor);
      }
    }
  });

  it('section-qualifies the owner identity so two sections can independently color their comments', () => {
    const shotsA = [makeShot(100, 'section A note')];
    const shotsB = [makeShot(200, 'section B note')];
    const sections: Section[] = [makeSection(1, 'A', shotsA), makeSection(2, 'B', shotsB)];
    const stations: Station[] = [
      makeStation(1, 0, undefined),
      makeStation(1, 1, undefined),
      makeStation(2, 0, undefined),
      makeStation(2, 1, undefined),
    ];

    const { shotFeatures } = build(sections, stations);

    const shotA = shotFeatures.find((f) => f.properties?.sectionId === 1 && f.properties?.shotId === 100);
    const shotB = shotFeatures.find((f) => f.properties?.sectionId === 2 && f.properties?.shotId === 200);

    expect(shotA?.properties?.commentColor).toBe(commentColorForKey('1:s100'));
    expect(shotB?.properties?.commentColor).toBe(commentColorForKey('2:s200'));
  });

  it('gives a station its own color independent of a commented shot ending at it', () => {
    const shots = [makeShot(100, 'shot note')];
    const sections: Section[] = [makeSection(1, 'Main', shots)];
    const stations: Station[] = [
      makeStation(1, 0, undefined),
      makeStation(1, 1, 'station note'),
    ];

    const { shotFeatures, stationFeatures } = build(sections, stations);

    const shotColor = shotFeatures.find((f) => f.properties?.shotId === 100)?.properties?.commentColor;
    const stationColor = stationFeatures.find((f) => f.properties?.stationIndex === 1)?.properties
      ?.commentColor;

    expect(shotColor).toBe(commentColorForKey('1:s100'));
    expect(stationColor).toBe(commentColorForKey('1:st1'));
  });

  it('builds clean with no commentColor anywhere on a zero-comment survey', () => {
    const { sections, stations } = fixture(4, {}, {});
    const { shotFeatures, stationFeatures, shotLabelFeatures, stationLabelFeatures } = build(
      sections,
      stations
    );

    for (const f of [...shotFeatures, ...stationFeatures, ...shotLabelFeatures, ...stationLabelFeatures]) {
      expect(f.properties?.commentColor).toBeUndefined();
    }
  });
});
