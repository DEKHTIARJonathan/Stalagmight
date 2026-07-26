import { describe, it, expect } from 'vitest';
import {
  mirrorStationIndex,
  mirrorPlacementForReverse,
  targetShotCountForMirror,
} from '../reversePlacement';
import type { ImportPlacement } from '../../types/commands';
import type { SectionEditState } from '../batchImportHelpers';

describe('mirrorStationIndex', () => {
  it('maps i to N - i', () => {
    // 3 shots => stations 0..3
    expect(mirrorStationIndex(0, 3)).toBe(3);
    expect(mirrorStationIndex(1, 3)).toBe(2);
    expect(mirrorStationIndex(3, 3)).toBe(0);
  });

  it('is an involution', () => {
    for (let i = 0; i <= 5; i++) {
      expect(mirrorStationIndex(mirrorStationIndex(i, 5), 5)).toBe(i);
    }
  });
});

describe('mirrorPlacementForReverse', () => {
  const gps = { latitude: 20.2, longitude: -87.4, depth_reference: 0 };

  it('leaves placements untouched when nothing is reversed', () => {
    const p: ImportPlacement = { type: 'from_existing', import_station: 1, existing_station: { section_id: 7, station_index: 2 } };
    expect(mirrorPlacementForReverse(p, false, 3, null)).toEqual(p);
  });

  it('mirrors zero_datum station_index', () => {
    const p: ImportPlacement = { type: 'zero_datum', coordinates: gps, station_index: 0 };
    expect(mirrorPlacementForReverse(p, true, 4, null)).toEqual({ ...p, station_index: 4 });
  });

  it('mirrors import_station but never the existing section it connects to', () => {
    const p: ImportPlacement = {
      type: 'from_existing',
      import_station: 1,
      existing_station: { section_id: 7, station_index: 2 },
    };
    const out = mirrorPlacementForReverse(p, true, 3, null);
    expect(out).toEqual({ ...p, import_station: 2 });
    // The existing project section is not being reversed - its index must stand.
    expect((out as Extract<ImportPlacement, { type: 'from_existing' }>).existing_station.station_index).toBe(2);
  });

  it('mirrors align_station_index for manual placements', () => {
    const p: ImportPlacement = { type: 'manual', align_station_index: 1, offset: null };
    expect(mirrorPlacementForReverse(p, true, 5, null)).toEqual({ ...p, align_station_index: 4 });
  });

  it('mirrors each side of from_importing independently', () => {
    const p: ImportPlacement = {
      type: 'from_importing',
      import_station: 1,
      target_section_index: 2,
      target_station_index: 1,
    };
    // Only this section reversed.
    expect(mirrorPlacementForReverse(p, true, 3, null)).toEqual({ ...p, import_station: 2 });
    // Only the target reversed.
    expect(mirrorPlacementForReverse(p, false, 3, 6)).toEqual({ ...p, target_station_index: 5 });
    // Both, with different shot counts.
    expect(mirrorPlacementForReverse(p, true, 3, 6)).toEqual({
      ...p,
      import_station: 2,
      target_station_index: 5,
    });
  });

  it('mirrors the existing_station of an early-imported target that was reversed', () => {
    // The wizard rewrites a connection into from_existing once its target has
    // been created earlier in the same run. If that target was created reversed,
    // its stations were renumbered after the user picked this index, so the
    // index has to follow - otherwise the section merges onto the wrong end.
    const p: ImportPlacement = {
      type: 'from_existing',
      import_station: 1,
      existing_station: { section_id: 42, station_index: 2 },
    };

    expect(mirrorPlacementForReverse(p, false, 3, 6)).toEqual({
      ...p,
      existing_station: { section_id: 42, station_index: 4 },
    });

    // Both sides reversed, with different shot counts.
    expect(mirrorPlacementForReverse(p, true, 3, 6)).toEqual({
      import_station: 2,
      type: 'from_existing',
      existing_station: { section_id: 42, station_index: 4 },
    });
  });

  it('leaves origin alone', () => {
    const p: ImportPlacement = { type: 'origin' };
    expect(mirrorPlacementForReverse(p, true, 3, null)).toEqual(p);
  });
});

describe('targetShotCountForMirror', () => {
  const edits = (reverse: boolean, shots: number, deleted = 0): Map<number, SectionEditState> =>
    new Map([
      [
        3,
        {
          reverse,
          shots: Array.from({ length: shots + deleted }, (_, i) => ({
            isDeleted: i >= shots,
          })),
        } as unknown as SectionEditState,
      ],
    ]);

  const fromImporting: ImportPlacement = {
    type: 'from_importing',
    import_station: 0,
    target_section_index: 3,
    target_station_index: 1,
  };
  const fromExisting: ImportPlacement = {
    type: 'from_existing',
    import_station: 0,
    existing_station: { section_id: 9, station_index: 1 },
  };

  it('counts a reversed from_importing target, excluding deleted shots', () => {
    expect(targetShotCountForMirror(fromImporting, 3, edits(true, 5, 2))).toBe(5);
  });

  it('counts a reversed early-imported target reached through from_existing', () => {
    expect(targetShotCountForMirror(fromExisting, 3, edits(true, 5))).toBe(5);
  });

  it('returns null when the target is not being reversed', () => {
    expect(targetShotCountForMirror(fromImporting, 3, edits(false, 5))).toBeNull();
    expect(targetShotCountForMirror(fromExisting, 3, edits(false, 5))).toBeNull();
  });

  it('returns null without a target import index - a pre-existing project section', () => {
    // The caller passes null for a connection to a section already in the
    // project: its numbering is not decided by this batch.
    expect(targetShotCountForMirror(fromExisting, null, edits(true, 5))).toBeNull();
    expect(targetShotCountForMirror(fromExisting, undefined, edits(true, 5))).toBeNull();
  });

  it('returns null for placements with no target side', () => {
    expect(targetShotCountForMirror({ type: 'origin' }, 3, edits(true, 5))).toBeNull();
    expect(
      targetShotCountForMirror({ type: 'manual', align_station_index: 0, offset: null }, 3, edits(true, 5))
    ).toBeNull();
  });
});
