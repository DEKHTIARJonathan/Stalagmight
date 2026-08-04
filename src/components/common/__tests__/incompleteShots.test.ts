import { describe, it, expect } from 'vitest';
import { countIncompleteShots } from '../incompleteShots';
import type { EditableShot } from '../editableShot';

/**
 * The gate that keeps a NaN out of an import. `NaN` is how the grid spells "no
 * measurement" when a required cell is cleared, so every host that can send rows
 * onward has to refuse while one is half-filled.
 */
const shot = (over: Partial<EditableShot> = {}): EditableShot => ({
  id: 1, length: 10, azimuth_in: 90, azimuth_out: 270, depth_in: -1, depth_out: -2,
  pitch_in: null, pitch_out: null, left: null, right: null, up: null, down: null,
  comment: null, kind: 'Normal', ...over,
});

describe('countIncompleteShots', () => {
  it('counts nothing for a complete row', () => {
    expect(countIncompleteShots([shot()])).toBe(0);
  });

  it('counts a row whose required cell was cleared to NaN', () => {
    expect(countIncompleteShots([shot({ length: NaN })])).toBe(1);
    expect(countIncompleteShots([shot({ depth_out: NaN })])).toBe(1);
  });

  it('counts a row with both azimuth legs gone', () => {
    expect(countIncompleteShots([shot({ azimuth_in: NaN, azimuth_out: NaN })])).toBe(1);
  });

  it('does NOT count a row added and left entirely blank', () => {
    // An invitation, not an obligation - the hosts drop it rather than block on it.
    expect(countIncompleteShots([shot({
      isNew: true, length: NaN, azimuth_in: NaN, azimuth_out: NaN,
      depth_in: NaN, depth_out: NaN,
    })])).toBe(0);
  });

  it('does NOT count a soft-deleted row', () => {
    expect(countIncompleteShots([shot({ length: NaN, isDeleted: true })])).toBe(0);
  });

  it('counts each offending row', () => {
    expect(countIncompleteShots([shot(), shot({ length: NaN }), shot({ depth_in: NaN })])).toBe(2);
  });
});
