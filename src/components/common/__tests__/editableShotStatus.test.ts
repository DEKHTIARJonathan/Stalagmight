import { describe, it, expect } from 'vitest';
import { missingRequiredCells, isShotComplete } from '../editableShotStatus';
import type { EditableShot } from '../editableShot';

/**
 * The missing-cell mark has to land on a column the user can actually see. The
 * shot editor's azimuth can be shown as one average OR as two legs, so which key
 * is "the azimuth cell" depends on the eye menu - mark the wrong one and the row
 * blocks Save while pointing at a cell that is off screen.
 */

const AVG = '_azimuth_avg';

const shot = (over: Partial<EditableShot> = {}): EditableShot => ({
  id: 1,
  length: 10,
  azimuth_in: 90,
  azimuth_out: 270,
  depth_in: -1,
  depth_out: -2,
  pitch_in: null,
  pitch_out: null,
  left: null,
  right: null,
  up: null,
  down: null,
  comment: null,
  kind: 'Normal',
  ...over,
});

describe('missingRequiredCells azimuth targeting', () => {
  const noAzimuth = { azimuth_in: NaN, azimuth_out: NaN };

  it('marks the average when the average is showing', () => {
    const missing = missingRequiredCells(shot(noAzimuth), AVG, new Set());
    expect([...missing]).toContain(AVG);
    expect([...missing]).not.toContain('azimuth_in');
  });

  it('marks both legs when the average is hidden', () => {
    const missing = missingRequiredCells(shot(noAzimuth), AVG, new Set([AVG]));
    expect([...missing]).toEqual(expect.arrayContaining(['azimuth_in', 'azimuth_out']));
    expect([...missing]).not.toContain(AVG);
  });

  it('defaults to the average when the caller passes no hidden set', () => {
    expect([...missingRequiredCells(shot(noAzimuth), AVG)]).toContain(AVG);
  });

  it('marks nothing for a row that has an azimuth, whichever columns show', () => {
    expect(missingRequiredCells(shot(), AVG, new Set([AVG])).size).toBe(0);
  });

  it('still reports incomplete regardless of which cell got the mark', () => {
    expect(isShotComplete(shot(noAzimuth), AVG)).toBe(false);
    expect(isShotComplete(shot(), AVG)).toBe(true);
  });

  it('one present leg is enough - the other is derived on save', () => {
    expect(missingRequiredCells(shot({ azimuth_out: NaN }), AVG, new Set()).size).toBe(0);
  });
});
