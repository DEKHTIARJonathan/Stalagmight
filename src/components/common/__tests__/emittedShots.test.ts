/**
 * The predicate and translations that keep the UI's station numbering and the
 * payload's in step.
 *
 * Dropping blank new rows from the payloads created two pictures of a section -
 * the one on screen, which counts a blank row, and the one sent, which does not.
 * Three separate sites converted between them wrongly (zero-datum reanchoring,
 * the DMP station adjustment, the manual segment anchor), each able to land a
 * GPS anchor or merge point on the wrong station. These pin the shared answer.
 */
import { describe, it, expect } from 'vitest';
import { isEmittedShot, emittedBefore, toEmittedStationIndex } from '../emittedShots';
import type { EditableShot } from '../editableShot';

const measured = (id: number): EditableShot =>
  ({
    id,
    length: 5,
    azimuth_in: 10,
    azimuth_out: 10,
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
  }) as unknown as EditableShot;

const blank = (id: number): EditableShot =>
  ({
    ...measured(id),
    isNew: true,
    length: NaN,
    azimuth_in: NaN,
    azimuth_out: NaN,
    depth_in: NaN,
    depth_out: NaN,
  }) as unknown as EditableShot;

const deleted = (id: number): EditableShot =>
  ({ ...measured(id), isDeleted: true }) as unknown as EditableShot;

describe('isEmittedShot', () => {
  it('keeps a measured row', () => {
    expect(isEmittedShot(measured(0))).toBe(true);
  });

  it('drops deleted and wholly blank rows', () => {
    expect(isEmittedShot(deleted(0))).toBe(false);
    expect(isEmittedShot(blank(0))).toBe(false);
  });

  it('keeps a partly filled row - not blank, and the gate blocks it elsewhere', () => {
    expect(isEmittedShot({ ...blank(0), length: 7 } as EditableShot)).toBe(true);
  });

  it('is false for a missing row rather than throwing', () => {
    expect(isEmittedShot(undefined)).toBe(false);
  });
});

describe('emittedBefore', () => {
  const rows = [measured(0), blank(1), deleted(2), measured(3)];

  it('counts only rows that reach the backend', () => {
    expect(emittedBefore(rows, 4)).toBe(2);
    expect(emittedBefore(rows, 1)).toBe(1);
    expect(emittedBefore(rows, 3)).toBe(1); // blank and deleted both skipped
  });

  it('is 0 at the start and clamps past the end', () => {
    expect(emittedBefore(rows, 0)).toBe(0);
    expect(emittedBefore(rows, 99)).toBe(2);
  });
});

describe('toEmittedStationIndex', () => {
  it('pulls a pick back by the blanks that precede it', () => {
    // Visible order (blanks included) vs emitted: picking visible station 2
    // means "after two visible rows", of which only one is emitted.
    const rows = [measured(0), blank(1), measured(2), measured(3)];
    expect(toEmittedStationIndex(rows, 2)).toBe(1);
  });

  it('leaves a pick alone when no blank precedes it', () => {
    const rows = [measured(0), measured(1), blank(2)];
    expect(toEmittedStationIndex(rows, 2)).toBe(2);
  });

  it('clamps a pick past the end of the shortened section', () => {
    // Every row blank: the emitted section has no shots, so the only station
    // left is 0 - never an out-of-range index the backend would reject.
    const rows = [blank(0), blank(1)];
    expect(toEmittedStationIndex(rows, 2)).toBe(0);
  });

  it('ignores deleted rows on both sides of the count', () => {
    const rows = [deleted(0), measured(1), blank(2), measured(3)];
    expect(toEmittedStationIndex(rows, 2)).toBe(1);
  });
});
