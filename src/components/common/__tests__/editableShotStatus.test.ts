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

  /**
   * This used to assert one leg was enough, on the belief that the other was
   * derived on save. Nothing derives it: the Rust boundary rejects any
   * non-finite geometry, so such a row passed every UI check and then failed at
   * Save. Both legs are required, and the mark lands on the empty one.
   */
  it('requires the second leg, marking the empty one', () => {
    expect([...missingRequiredCells(shot({ azimuth_out: NaN }), AVG, new Set())]).toEqual([
      'azimuth_out',
    ]);
    expect([...missingRequiredCells(shot({ azimuth_in: NaN }), AVG, new Set())]).toEqual([
      'azimuth_in',
    ]);
  });

  it('marks the empty leg even while the avg column is the visible one', () => {
    // The avg cell shows the lone reading, so marking IT would look wrong - the
    // user would see a red cell holding a perfectly good number.
    expect([...missingRequiredCells(shot({ azimuth_out: NaN }), AVG)]).toEqual(['azimuth_out']);
  });

  it('still marks the avg when NEITHER leg was measured', () => {
    expect([...missingRequiredCells(shot(noAzimuth), AVG)]).toEqual([AVG]);
  });

  it('reports a one-legged row incomplete', () => {
    expect(isShotComplete(shot({ azimuth_out: NaN }), AVG)).toBe(false);
  });
});
