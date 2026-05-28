/**
 * Round-trip and view-shape tests for SurveyData.
 *
 * Coverage goals:
 *   - `getShot(soaFromLegacy(shots), i)` deep-equals the original shot,
 *     for every field including the null sentinels and the sparse
 *     comment map.
 *   - Same for `getStation` / station_ref / gps / merged_with / etc.
 *   - `findShotGlobalIndex` / `findStationGlobalIndex` return correct
 *     indices, including the "not found" path.
 *   - `emptySurveyData()` is consistent (lengths zero, accessors
 *     refuse out-of-range without crashing).
 */
import { describe, expect, it } from 'vitest';
import {
  emptySurveyData,
  findShotGlobalIndex,
  findStationGlobalIndex,
  getShot,
  getStation,
  surveyDataFromLegacy as soaFromLegacy,
  SHOT_MARKER_NULL,
} from '../survey-data';
import type { Shot } from '../ipc/Shot';
import type { Station } from '../ipc/Station';
import type { Section } from '../ipc/Section';

/** Minimal fixture: 2 sections, 3 shots, 4 stations.
 *  Covers nullable fields, reference shots, comments. */
function fixture(): { sections: Section[]; stations: Station[] } {
  const sections: Section[] = [
    {
      id: 1,
      name: 'Main',
      surveyor: 'Alice',
      date: '2024-01-15',
      color: '#ff0000',
      direction: 'in',
      quality: 1.0,
      next_shot_id: 103,
      shots: [
        {
          id: 101,
          azimuth_in: 0.0,
          azimuth_out: 0.0,
          length: 10.0,
          depth_in: 0.0,
          depth_out: -1.0,
          pitch_in: 5.0,
          pitch_out: 5.5,
          left: 1.0,
          right: 1.2,
          up: 2.0,
          down: 0.5,
          comment: 'start of survey',
          is_reference: false,
          marker_index: 1,
          temperature: 12.0,
        },
        {
          id: 102,
          azimuth_in: 90.0,
          azimuth_out: 91.0,
          length: 5.0,
          depth_in: -1.0,
          depth_out: -2.0,
          pitch_in: null,
          pitch_out: null,
          left: null,
          right: null,
          up: null,
          down: null,
          comment: null,
          is_reference: true,
          marker_index: null,
          temperature: null,
        },
      ],
    },
    {
      id: 2,
      name: null,
      surveyor: null,
      date: null,
      color: '#00ff00',
      direction: 'out',
      quality: 0.5,
      next_shot_id: 202,
      shots: [
        {
          id: 201,
          azimuth_in: 45.0,
          azimuth_out: 45.0,
          length: 7.07,
          depth_in: 0.0,
          depth_out: 0.0,
          pitch_in: null,
          pitch_out: null,
          left: null,
          right: null,
          up: null,
          down: null,
          comment: '',  // empty string → should NOT round-trip as a comment
          is_reference: false,
          marker_index: null,
          temperature: null,
        },
      ],
    },
  ];

  const stations: Station[] = [
    {
      station_ref: { section_id: 1, station_index: 0 },
      coordinates: { x: 0, y: 0, z: 0 },
      is_zero_datum: true,
      gps_coordinates: { latitude: 20.5, longitude: -87.3, depth_reference: 0 },
      merged_with: [],
      closures_with: [],
    },
    {
      station_ref: { section_id: 1, station_index: 1 },
      coordinates: { x: 10, y: 0, z: -1 },
      is_zero_datum: false,
      gps_coordinates: null,
      merged_with: [{ section_id: 2, station_index: 0 }],
      closures_with: [],
      comment: 'junction',
    },
    {
      station_ref: { section_id: 1, station_index: 2 },
      coordinates: { x: 10, y: 5, z: -2 },
      is_zero_datum: false,
      gps_coordinates: null,
      merged_with: [],
      closures_with: [],
    },
    {
      station_ref: { section_id: 2, station_index: 0 },
      coordinates: { x: 10, y: 0, z: -1 },  // merged with section 1, index 1
      is_zero_datum: false,
      gps_coordinates: null,
      merged_with: [{ section_id: 1, station_index: 1 }],
      closures_with: [],
    },
  ];

  return { sections, stations };
}

describe('SurveyData', () => {
  describe('emptySurveyData', () => {
    it('has zero counts and zero-length typed arrays', () => {
      const data = emptySurveyData();
      expect(data.shotCount).toBe(0);
      expect(data.stationCount).toBe(0);
      expect(data.shotIds.length).toBe(0);
      expect(data.stationCoords.length).toBe(0);
      expect(data.sections).toEqual([]);
      expect(data.shotComments.size).toBe(0);
    });

    it('getShot throws out-of-range', () => {
      const data = emptySurveyData();
      expect(() => getShot(data, 0)).toThrow(/out of range/);
    });

    it('getStation throws out-of-range', () => {
      const data = emptySurveyData();
      expect(() => getStation(data, 0)).toThrow(/out of range/);
    });

    it('findShotGlobalIndex returns null for empty data', () => {
      expect(findShotGlobalIndex(emptySurveyData(), 1, 1)).toBeNull();
    });
  });

  describe('soaFromLegacy + getShot round-trip', () => {
    it('preserves every shot field through the round trip', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);

      /** Compare two shots field-by-field. Numeric fields are checked
       *  with f32-precision tolerance (the SoA stores doubles as f32). */
      const expectShotsEqual = (actual: Shot, expected: Shot) => {
        // Integer / categorical fields — exact equality.
        expect(actual.id).toBe(expected.id);
        expect(actual.is_reference).toBe(expected.is_reference);
        expect(actual.marker_index).toBe(expected.marker_index);
        expect(actual.comment).toBe(expected.comment);
        // f32-stored doubles: ~7 decimal digits of precision; relative
        // tolerance of ~1e-6 is safely outside f32 quantization.
        const closeOrNull = (a: number | null, b: number | null) => {
          if (b === null) {
            expect(a).toBeNull();
          } else {
            expect(a).not.toBeNull();
            expect(a as number).toBeCloseTo(b, 4);
          }
        };
        closeOrNull(actual.azimuth_in, expected.azimuth_in);
        closeOrNull(actual.azimuth_out, expected.azimuth_out);
        closeOrNull(actual.length, expected.length);
        closeOrNull(actual.depth_in, expected.depth_in);
        closeOrNull(actual.depth_out, expected.depth_out);
        closeOrNull(actual.pitch_in, expected.pitch_in);
        closeOrNull(actual.pitch_out, expected.pitch_out);
        closeOrNull(actual.left, expected.left);
        closeOrNull(actual.right, expected.right);
        closeOrNull(actual.up, expected.up);
        closeOrNull(actual.down, expected.down);
        closeOrNull(actual.temperature, expected.temperature);
      };

      // Iterate over every shot in declaration order and compare.
      let cursor = 0;
      for (const section of sections) {
        for (const original of section.shots) {
          const viewed = getShot(data, cursor);
          // `comment` of empty string → null in SoA (we don't store empties).
          const expected: Shot = {
            ...original,
            comment: original.comment ? original.comment : null,
          };
          expectShotsEqual(viewed, expected);
          cursor++;
        }
      }
      expect(cursor).toBe(data.shotCount);
    });

    it('shotSectionIds matches the declaring section', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);
      // shot 0..1 → section 1; shot 2 → section 2
      expect(Array.from(data.shotSectionIds)).toEqual([1, 1, 2]);
    });

    it('section metadata records correct shotOffset/shotCount', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);
      expect(data.sections[0]!.shotOffset).toBe(0);
      expect(data.sections[0]!.shotCount).toBe(2);
      expect(data.sections[1]!.shotOffset).toBe(2);
      expect(data.sections[1]!.shotCount).toBe(1);
    });
  });

  describe('getStation round-trip', () => {
    it('preserves coordinates, refs, flags, GPS, merges, comments', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);

      stations.forEach((expected, i) => {
        const viewed = getStation(data, i);
        expect(viewed.station_ref).toEqual(expected.station_ref);
        expect(viewed.coordinates).toEqual(expected.coordinates);
        expect(viewed.is_zero_datum).toBe(expected.is_zero_datum);
        expect(viewed.gps_coordinates).toEqual(expected.gps_coordinates);
        expect(viewed.merged_with).toEqual(expected.merged_with);
        expect(viewed.closures_with).toEqual(expected.closures_with);
        // `comment` is an optional field on Station; treat both
        // `undefined` and "absent" as equivalent.
        expect(viewed.comment ?? undefined).toBe(expected.comment ?? undefined);
      });
    });
  });

  describe('findShotGlobalIndex', () => {
    it('finds shots by (section_id, shot_id)', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);
      expect(findShotGlobalIndex(data, 1, 101)).toBe(0);
      expect(findShotGlobalIndex(data, 1, 102)).toBe(1);
      expect(findShotGlobalIndex(data, 2, 201)).toBe(2);
    });

    it('returns null for nonexistent shot or section', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);
      expect(findShotGlobalIndex(data, 999, 1)).toBeNull();
      expect(findShotGlobalIndex(data, 1, 999)).toBeNull();
    });
  });

  describe('findStationGlobalIndex', () => {
    it('finds stations by (section_id, station_index)', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);
      expect(findStationGlobalIndex(data, 1, 0)).toBe(0);
      expect(findStationGlobalIndex(data, 1, 1)).toBe(1);
      expect(findStationGlobalIndex(data, 2, 0)).toBe(3);
    });

    it('returns null for nonexistent station', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);
      expect(findStationGlobalIndex(data, 99, 0)).toBeNull();
      expect(findStationGlobalIndex(data, 1, 99)).toBeNull();
    });
  });

  describe('null sentinel encoding', () => {
    it('NaN in the float arrays maps back to null', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);
      // shot 1 (the reference shot) has all nullable floats == null
      expect(Number.isNaN(data.shotPitchIn[1]!)).toBe(true);
      const shot1 = getShot(data, 1);
      expect(shot1.pitch_in).toBeNull();
      expect(shot1.pitch_out).toBeNull();
      expect(shot1.left).toBeNull();
      expect(shot1.right).toBeNull();
      expect(shot1.up).toBeNull();
      expect(shot1.down).toBeNull();
      expect(shot1.temperature).toBeNull();
    });

    it('marker_index = -1 maps back to null', () => {
      const { sections, stations } = fixture();
      const data = soaFromLegacy(sections, stations);
      expect(data.shotMarkerIndex[1]).toBe(SHOT_MARKER_NULL);
      expect(getShot(data, 1).marker_index).toBeNull();
      // shot 0 has marker_index = 1
      expect(data.shotMarkerIndex[0]).toBe(1);
      expect(getShot(data, 0).marker_index).toBe(1);
    });
  });
});
