import { describe, it, expect } from 'vitest';
import type { DmpShot } from '../../types/commands';
import { convertToEditableShots } from '../shotConversion';

function makeDmpShot(overrides?: Partial<DmpShot>): DmpShot {
  return {
    shot_type: 'Standard',
    heading_in: 0,
    heading_out: 0,
    length: 2,
    depth_in: 0,
    depth_out: 0,
    pitch_in: 0,
    pitch_out: 0,
    left: 0,
    right: 0,
    up: 0,
    down: 0,
    temperature: 0,
    hour: 0,
    minute: 0,
    second: 0,
    marker_index: 0,
    ...overrides,
  };
}

describe('convertToEditableShots', () => {
  it('excludes standard shots with length 1 by default', () => {
    const editableShots = convertToEditableShots([
      makeDmpShot({ length: 1 }),
      makeDmpShot({ length: 2.5 }),
    ]);

    expect(editableShots).toHaveLength(1);
    expect(editableShots[0]?.length).toBe(2.5);
    expect(editableShots[0]?.id).toBe(0);
  });

  it('keeps non-length-1 standard shots and reindexes IDs', () => {
    const editableShots = convertToEditableShots([
      makeDmpShot({ length: 3 }),
      makeDmpShot({ length: 1 }),
      makeDmpShot({ length: 4 }),
    ]);

    expect(editableShots).toHaveLength(2);
    expect(editableShots[0]?.id).toBe(0);
    expect(editableShots[1]?.id).toBe(1);
    expect(editableShots[0]?.length).toBe(3);
    expect(editableShots[1]?.length).toBe(4);
  });
});
