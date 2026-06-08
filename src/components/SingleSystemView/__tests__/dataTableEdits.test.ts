import { describe, it, expect } from 'vitest';
import { buildShotUpdates, buildShotUpdateBatch, AZIMUTH_AVG_KEY } from '../dataTableEdits';
import type { Shot } from '../../../types/project';

const shot = (over: Partial<Shot> = {}): Shot => ({
  id: 1,
  azimuth_in: 90,
  azimuth_out: 90,
  length: 10,
  depth_in: 0,
  depth_out: 1,
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
  ...over,
});

describe('buildShotUpdates', () => {
  it('maps real column keys straight through', () => {
    const u = buildShotUpdates(shot(), [
      { colKey: 'length', value: 12.5 },
      { colKey: 'depth_out', value: 2 },
      { colKey: 'left', value: null },
      { colKey: 'comment', value: 'note' },
    ]);
    expect(u).toEqual({ length: 12.5, depth_out: 2, left: null, comment: 'note' });
  });

  it('expands the azimuth-average column into both legs via the delta', () => {
    // mean of (80,100) = 90; new mean 95 → +5 to each leg.
    const u = buildShotUpdates(shot({ azimuth_in: 80, azimuth_out: 100 }), [
      { colKey: AZIMUTH_AVG_KEY, value: 95 },
    ]);
    expect(u.azimuth_in).toBeCloseTo(85, 6);
    expect(u.azimuth_out).toBeCloseTo(105, 6);
  });

  it('skips a non-finite azimuth average', () => {
    expect(buildShotUpdates(shot(), [{ colKey: AZIMUTH_AVG_KEY, value: NaN }])).toEqual({});
  });

  it('wraps azimuths across 0/360', () => {
    // mean of (350,10) = 0; new mean 5 → +5 → in 355, out 15.
    const u = buildShotUpdates(shot({ azimuth_in: 350, azimuth_out: 10 }), [
      { colKey: AZIMUTH_AVG_KEY, value: 5 },
    ]);
    expect(u.azimuth_in).toBeCloseTo(355, 6);
    expect(u.azimuth_out).toBeCloseTo(15, 6);
  });
});

describe('buildShotUpdateBatch', () => {
  const shots = [shot({ id: 10 }), shot({ id: 11 }), shot({ id: 12 })];

  it('groups edits into one update_shot per row, keyed by shot id', () => {
    const cmds = buildShotUpdateBatch(
      [
        { row: 0, colKey: 'length', value: 5 },
        { row: 0, colKey: 'depth_in', value: 1 },
        { row: 2, colKey: 'comment', value: 'x' },
      ],
      shots,
      7,
    );
    expect(cmds).toEqual([
      { type: 'update_shot', section_id: 7, shot_id: 10, updates: { length: 5, depth_in: 1 } },
      { type: 'update_shot', section_id: 7, shot_id: 12, updates: { comment: 'x' } },
    ]);
  });

  it('drops edits on rows outside the shot list and shots with no net change', () => {
    const cmds = buildShotUpdateBatch(
      [
        { row: 99, colKey: 'length', value: 5 },
        { row: 1, colKey: AZIMUTH_AVG_KEY, value: NaN },
      ],
      shots,
      7,
    );
    expect(cmds).toEqual([]);
  });
});
