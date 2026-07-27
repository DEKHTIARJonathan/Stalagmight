/**
 * Zero-datum config building and the reverse rewrite it applies (#24).
 *
 * The regression these tests pin: the GPS station index is picked off the
 * section preview, which draws the file's ORIGINAL shots, while the shots
 * actually sent are post-deletion. Mirroring the raw index for a reversed
 * section landed the anchor on the wrong physical station, and for a pick near
 * the end produced a NEGATIVE index that serde rejects (`station_index` is
 * `u32`), failing the whole import with an opaque error.
 */
import { describe, it, expect } from 'vitest';
import { buildZeroDatumSectionConfig, finalizePlacementForReverse } from '../importSectionConfig';
import type { ZeroDatumConfigResult } from '../../components/Dialogs/ZeroDatumConfigDialog';
import type { EditableShot } from '../../components/common/ShotTableEditor';
import type { ImportPlacement } from '../../types/commands';
import type { SectionEditState } from '../batchImportHelpers';
import type { VirtualConnection } from '../segmentContext';

const GPS = { latitude: 20.2, longitude: -87.4, depth_reference: 0 };

/** `id` is the shot's 0-based index in the file - what a station index addresses. */
function shot(id: number, isDeleted = false): EditableShot {
  return {
    id,
    azimuth_in: 10,
    azimuth_out: 10,
    length: 5,
    depth_in: 0,
    depth_out: 0,
    pitch_in: null,
    pitch_out: null,
    left: null,
    right: null,
    up: null,
    down: null,
    comment: null,
    kind: 'Normal',
    isDeleted,
  } as unknown as EditableShot;
}

/** A 10-shot section with `deleted` shot ids removed and station `stationIndex` picked. */
function zeroDatum(
  stationIndex: number,
  reverse: boolean,
  deleted: number[] = [],
  shotCount = 10,
): ZeroDatumConfigResult {
  return {
    sectionIndex: 2,
    stationIndex,
    gps: GPS,
    metadata: {
      name: 'Anchor',
      surveyor: 'S',
      date: '2026-01-01',
      color: '#4ecdc4',
      direction: 'in',
      quality: 1,
      reverse,
    },
    shots: Array.from({ length: shotCount }, (_, i) => shot(i, deleted.includes(i))),
  };
}

function stationIndexOf(config: ReturnType<typeof buildZeroDatumSectionConfig>): number {
  expect(config.placement.type).toBe('zero_datum');
  return (config.placement as Extract<ImportPlacement, { type: 'zero_datum' }>).station_index;
}

describe('buildZeroDatumSectionConfig', () => {
  it('carries the section metadata and the surviving shots', () => {
    const config = buildZeroDatumSectionConfig(zeroDatum(0, false, [3]));
    expect(config.section_index).toBe(2);
    expect(config.name).toBe('Anchor');
    expect(config.surveyor).toBe('S');
    expect(config.color).toBe('#4ecdc4');
    expect(config.reverse).toBe(false);
    expect(config.shots).toHaveLength(9);
    expect(config.station_comments).toEqual([]);
  });

  it('adjusts the picked station for deleted shots when not reversed', () => {
    // Station 5 of the original order, with the leading shot deleted, is
    // station 4 of the 9 shots actually sent.
    expect(stationIndexOf(buildZeroDatumSectionConfig(zeroDatum(5, false, [0])))).toBe(4);
  });

  it('mirrors the ADJUSTED index when a leading shot was deleted', () => {
    // 9 shots survive, the pick sits at adjusted station 4, so the reversed
    // section numbers it 9 - 4 = 5. Mirroring the raw index gave 9 - 5 = 4,
    // one station off the one the user clicked.
    expect(stationIndexOf(buildZeroDatumSectionConfig(zeroDatum(5, true, [0])))).toBe(5);
  });

  it('never emits a negative index when a trailing shot was deleted', () => {
    // The last station of the original 10-shot order, with the last shot
    // deleted: adjusted to 9 of 9, mirrored to 0. Mirroring the raw index gave
    // 9 - 10 = -1, which serde rejects for a u32 - killing the whole import.
    expect(stationIndexOf(buildZeroDatumSectionConfig(zeroDatum(10, true, [9])))).toBe(0);
  });

  it('keeps a pick past the surviving shots inside the section', () => {
    // A pick the shot editor then deleted out from under: adjusting first caps
    // it at the last surviving station, so the mirror stays in range (the raw
    // index would have mirrored to 1 - 9 = -8).
    const config = buildZeroDatumSectionConfig(zeroDatum(9, true, [1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(config.shots).toHaveLength(1);
    expect(stationIndexOf(config)).toBe(0);
  });

  it('leaves an unreversed pick at the far end alone', () => {
    expect(stationIndexOf(buildZeroDatumSectionConfig(zeroDatum(10, false)))).toBe(10);
    expect(stationIndexOf(buildZeroDatumSectionConfig(zeroDatum(10, true)))).toBe(0);
  });
});

describe('finalizePlacementForReverse', () => {
  const placement: ImportPlacement = {
    type: 'from_importing',
    import_station: 1,
    target_section_index: 0,
    target_station_index: 2,
  };
  const connection: VirtualConnection = {
    importSectionIndex: 1,
    importStationIndex: 1,
    targetType: 'importing',
    targetImportIndex: 3,
    targetImportStationIndex: 2,
  };
  const sectionEdits = new Map<number, SectionEditState>([
    [3, { reverse: true, shots: Array.from({ length: 6 }, () => ({})) } as unknown as SectionEditState],
  ]);

  it('mirrors both sides when the connection reaches a reversed target', () => {
    expect(finalizePlacementForReverse(placement, true, 4, connection, sectionEdits)).toEqual({
      ...placement,
      import_station: 3,
      target_station_index: 4,
    });
  });

  it('leaves the target side alone without a connection (direct placement)', () => {
    expect(finalizePlacementForReverse(placement, true, 4, null, sectionEdits)).toEqual({
      ...placement,
      import_station: 3,
    });
  });
});
