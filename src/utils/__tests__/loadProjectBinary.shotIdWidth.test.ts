/**
 * #555 - the binary decode path keeps u32 shot ids intact.
 *
 * Rust mints shot ids as `section_id * 100_000 + sequence_order` in `u32`, so
 * the id space reaches 4_294_899_999 at the highest permitted section id
 * (42_948) and crosses i32's 2_147_483_647 from section 21_474 up. The decoder
 * used to store those columns as `Int32Array` with a `| 0` coercion, which
 * wrapped every such id to a NEGATIVE number in `surveyData.shotIds` while the
 * lazy `section.shots` materializer - reading the *same* `shots_uints` slot -
 * kept it unsigned. One id, two disagreeing representations, no error anywhere.
 *
 * These drive the real decoder (`buildResult`) rather than a stand-in, so both
 * representations come out of the same envelope bytes.
 */
import { describe, it, expect } from 'vitest';

import { buildResult, type BinaryEnvelope } from '../loadProjectBinary';
import { getShot, surveyDataFromLegacy } from '../../types/survey-data';

const SHOT_FLOAT_FIELDS = 12;
const SHOT_UINT_FIELDS = 3;
const STATION_FLOAT_FIELDS = 3;
const STATION_UINT_FIELDS = 2;
const MARKER_NULL_WIRE = 0xffffffff;

/** Mirror of Rust's shot-id stride. */
const SHOT_ID_STRIDE = 100_000;
/** Highest section id the backend can mint (42_949 sections, 0-based). */
const MAX_SECTION_ID = 42_948;
const I32_MAX = 2_147_483_647;

/** One section at `sectionId` carrying the minted ids for `seqs`, with
 *  `seqs.length + 1` stations. Values other than the ids are arbitrary. */
function makeEnvelope(sectionId: number, seqs: number[]): BinaryEnvelope {
  const shotCount = seqs.length;
  const stationCount = shotCount + 1;

  const shotsF32 = new Float32Array(shotCount * SHOT_FLOAT_FIELDS);
  const shotsU32 = new Uint32Array(shotCount * SHOT_UINT_FIELDS);
  const shotsFlags = new Uint8Array(shotCount);
  seqs.forEach((seq, g) => {
    shotsF32[g * SHOT_FLOAT_FIELDS + 2] = g + 1; // length
    shotsU32[g * SHOT_UINT_FIELDS] = sectionId; // section_id
    shotsU32[g * SHOT_UINT_FIELDS + 1] = sectionId * SHOT_ID_STRIDE + seq; // shot.id
    shotsU32[g * SHOT_UINT_FIELDS + 2] = MARKER_NULL_WIRE;
  });

  const stationsF64 = new Float64Array(stationCount * STATION_FLOAT_FIELDS);
  const stationsU32 = new Uint32Array(stationCount * STATION_UINT_FIELDS);
  const stationsFlags = new Uint8Array(stationCount);
  for (let i = 0; i < stationCount; i++) {
    stationsF64[i * STATION_FLOAT_FIELDS] = i;
    stationsF64[i * STATION_FLOAT_FIELDS + 1] = 0;
    stationsF64[i * STATION_FLOAT_FIELDS + 2] = -i;
    stationsU32[i * STATION_UINT_FIELDS] = sectionId;
    stationsU32[i * STATION_UINT_FIELDS + 1] = i;
  }

  const u8 = (a: Float32Array | Float64Array | Uint32Array): Uint8Array =>
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

  return {
    // Keep in sync with BINARY_FORMAT_VERSION / EXPECTED_VERSION. This fixture
    // feeds buildResult() directly, bypassing the envelope-version gate.
    version: 6,
    loading_id: 1,
    is_remote: false,
    project_header: {
      name: 'high-section-ids',
      location: null,
      created_at: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-01T00:00:00Z',
      file_path: null,
      next_section_id: sectionId + 1,
      next_closure_id: 1,
      sections: [
        {
          id: sectionId,
          name: 'Deep',
          surveyor: null,
          date: null,
          color: '#0000ff',
          direction: 'in',
          quality: 1.0,
          shot_offset: 0,
          shot_count: shotCount,
          next_shot_id: sectionId * SHOT_ID_STRIDE + shotCount,
        },
      ] as unknown as BinaryEnvelope['project_header']['sections'],
      station_merges: [],
      zero_datums: [],
      loop_closures: [],
      section_offsets: [],
      station_offsets: [],
      station_comments_map: [],
      imported_file_hashes: [],
      imported_section_hashes: [],
      validation: {} as BinaryEnvelope['project_header']['validation'],
      surface_elevation: null,
    },
    shot_count: shotCount,
    shots_floats: u8(shotsF32),
    shots_uints: u8(shotsU32),
    shots_flags: shotsFlags,
    shot_comments: [],
    station_count: stationCount,
    stations_floats: u8(stationsF64),
    stations_uints: u8(stationsU32),
    stations_flags: stationsFlags,
    station_gps: [],
    station_merged_with: [],
    station_closures_with: [],
    station_comments: [],
    station_names: [],
    stats: {} as BinaryEnvelope['stats'],
    warnings: [],
    display_settings: {} as BinaryEnvelope['display_settings'],
    frozen_shots: [],
  };
}

// 2_147_483_648 is exactly 2^31 - the first id an Int32Array turns into
// -2_147_483_648. 4_294_899_999 is the largest id the section bound allows.
const CASES: Array<{ label: string; sectionId: number; seqs: number[] }> = [
  { label: 'first id past i32 (section 21_474)', sectionId: 21_474, seqs: [83_648, 83_649] },
  { label: 'highest permitted section (42_948)', sectionId: MAX_SECTION_ID, seqs: [0, 1, 99_999] },
];

describe('loadProjectBinary keeps u32 shot ids exact (#555)', () => {
  for (const { label, sectionId, seqs } of CASES) {
    const expectedIds = seqs.map((seq) => sectionId * SHOT_ID_STRIDE + seq);

    it(`decodes the SoA columns unsigned - ${label}`, () => {
      // Guard the fixture: if these stop exceeding i32 the test proves nothing.
      for (const id of expectedIds) expect(id).toBeGreaterThan(I32_MAX);

      const { surveyData } = buildResult(makeEnvelope(sectionId, seqs), 0);

      expect(Array.from(surveyData.shotIds)).toEqual(expectedIds);
      expect(Array.from(surveyData.shotSectionIds)).toEqual(seqs.map(() => sectionId));
      // The exact i32 failure mode: nothing wrapped negative.
      expect(Array.from(surveyData.shotIds).filter((id) => id < 0)).toEqual([]);
    });

    it(`agrees with the lazy section.shots materializer - ${label}`, () => {
      const result = buildResult(makeEnvelope(sectionId, seqs), 0);
      // Reading `.shots` flips the lazy getter; both sides come from the same
      // `shots_uints` slot, so they must produce the same number.
      const shots = result.project.sections[0]!.shots;
      expect(shots.map((s) => s.id)).toEqual(expectedIds);
      shots.forEach((shot, j) => {
        expect(result.surveyData.shotIds[j]).toBe(shot.id);
      });
    });

    it(`keeps the station section ids unsigned - ${label}`, () => {
      const { surveyData } = buildResult(makeEnvelope(sectionId, seqs), 0);
      for (let g = 0; g < surveyData.stationCount; g++) {
        expect(surveyData.stationSectionIds[g]).toBe(sectionId);
      }
    });
  }
});


describe('immutable shot number binary sidecar', () => {
  it('preserves independent numbers through lazy and SoA materialization', () => {
    const envelope = makeEnvelope(9, [0, 1]);
    envelope.shot_numbers = [7, 12];
    const result = buildResult(envelope, 0);
    expect(result.project.sections[0]!.shots.map(shot => shot.number)).toEqual([7, 12]);
    expect(getShot(result.surveyData, 0).number).toBe(7);
    expect(getShot(result.surveyData, 1).number).toBe(12);
    const refreshed = surveyDataFromLegacy(result.project.sections, result.stations);
    expect(getShot(refreshed, 0).number).toBe(7);
  });
  it('rejects a truncated sidecar rather than losing shot identity', () => {
    const envelope = makeEnvelope(9, [0, 1]);
    envelope.shot_numbers = [7];
    expect(() => buildResult(envelope, 0)).toThrow('shot_numbers length mismatch');
  });
});


it('preserves independent Explorer and Surveyor metadata through binary load', () => {
  const envelope = makeEnvelope(9, [0]);
  envelope.project_header.sections[0]!.explorer = 'Explorer team';
  envelope.project_header.sections[0]!.surveyor = 'Survey team';
  const result = buildResult(envelope, 0);
  expect(result.project.sections[0]!.explorer).toBe('Explorer team');
  expect(result.project.sections[0]!.surveyor).toBe('Survey team');
  expect(result.surveyData.sections[0]!.explorer).toBe('Explorer team');
  expect(surveyDataFromLegacy(result.project.sections, result.stations).sections[0]!.explorer).toBe('Explorer team');
});


describe('explicit incoming origins in binary sidecars', () => {
  it('preserves null roots, global origins and independent START references', () => {
    const envelope = makeEnvelope(9, [0, 1]);
    envelope.version = 7;
    envelope.shot_numbers = [7, 12];
    envelope.shot_from_ids = [null, 304];
    envelope.shot_start_refs = [
      { section_id: 9, station_index: 0 },
      { section_id: 9, station_index: 0x80000001 },
    ];
    const result = buildResult(envelope, 0);
    expect(result.project.sections[0]!.shots.map(shot => shot.from_id)).toEqual([null, 304]);
    expect(getShot(result.surveyData, 0).from_id).toBeNull();
    expect(getShot(result.surveyData, 1).from_id).toBe(304);
    expect(Array.from(result.surveyData.shotStartIndices!)).toEqual([0, 0x80000001]);
    expect(Array.from(result.surveyData.shotStartSectionIds!)).toEqual([9, 9]);
  });

  it('rejects truncated graph sidecars', () => {
    const envelope = makeEnvelope(9, [0, 1]);
    envelope.shot_from_ids = [null];
    expect(() => buildResult(envelope, 0)).toThrow('shot_from_ids length mismatch');
    envelope.shot_from_ids = [null, 7];
    envelope.shot_start_refs = [];
    expect(() => buildResult(envelope, 0)).toThrow('shot_start_refs length mismatch');
  });
});
