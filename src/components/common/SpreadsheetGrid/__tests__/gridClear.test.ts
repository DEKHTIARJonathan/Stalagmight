/**
 * A Delete that would write back what the cell already holds must emit nothing.
 *
 * Every OPTIONAL column parses '' to a real value - a comment to null, LRUD and
 * pitch to null, the shot-kind badge to 'Normal' - so the plan used to emit an
 * edit for each of them regardless of what was there. On a host's trailing blank
 * row (rendered, never stored, materialized by the first edit to land in it)
 * that turned a Delete keystroke, or a column-wide clear that swept the blank,
 * into a brand-new empty shot. On a real row it put a no-op on the undo stack.
 */
import { describe, expect, it } from 'vitest';
import { planClear } from '../gridClear';
import type { GridColumn } from '../types';

interface Row {
  comment: string | null;
  left: number | null;
  length: number;
  kind: string;
}

const columns: GridColumn<Row>[] = [
  // Text, but nullable in the model: '' parses to null, so the parsed empty and
  // the displayed empty are two different spellings of the same nothing.
  {
    key: 'comment',
    header: 'Comment',
    kind: 'text',
    getValue: (r) => r.comment ?? '',
    editable: true,
    parse: (raw) => (raw.trim() === '' ? null : raw),
  },
  { key: 'left', header: 'L', kind: 'number-nullable', getValue: (r) => r.left, editable: true },
  // Required: '' parses to undefined, so it takes the missing-mark route.
  { key: 'length', header: 'Len', kind: 'number', getValue: (r) => r.length, editable: true },
  // A click-only badge whose empty parse is a real value, not a blank.
  {
    key: 'kind',
    header: 'J/R',
    kind: 'text',
    getValue: (r) => r.kind,
    editable: true,
    noInlineEdit: true,
    parse: (raw) => (raw.trim() === '' ? 'Normal' : raw),
  },
];

/** Row 0 is filled; row 1 is the host's phantom (blank, unset numbers as NaN). */
const rows: Row[] = [
  { comment: 'sump', left: 2, length: 10, kind: 'Jump' },
  { comment: null, left: null, length: NaN, kind: 'Normal' },
];

const run = (
  rect: { r0: number; r1: number; c0: number; c1: number },
  missingCells: ReadonlySet<string> = new Set()
) =>
  planClear<Row>({
    rect,
    colAt: (c) => columns[c],
    cellEditable: () => true,
    parseForColumn: (col, raw, row) => {
      if (col.parse) return col.parse(raw, rows[row]!);
      if (col.kind === 'number' || col.kind === 'number-nullable') {
        return col.kind === 'number-nullable' ? null : undefined;
      }
      return raw;
    },
    valueAt: (row, col) => {
      const data = rows[row];
      return data === undefined ? undefined : col.getValue(data, row);
    },
    missKey: (row, colKey) => `${row}:${colKey}`,
    missingCells,
  });

const cols = (plan: { edits: { colKey: string }[] }) => plan.edits.map((e) => e.colKey);

describe('planClear no-op suppression', () => {
  it('emits nothing for any cell of an already-blank row', () => {
    const plan = run({ r0: 1, r1: 1, c0: 0, c1: 3 });
    expect(plan.edits).toEqual([]);
  });

  it('emits nothing for a single blank comment cell (the Delete that grew a row)', () => {
    expect(run({ r0: 1, r1: 1, c0: 0, c1: 0 }).edits).toEqual([]);
  });

  it('emits nothing for a kind cell that is already the parsed empty', () => {
    expect(run({ r0: 1, r1: 1, c0: 3, c1: 3 }).edits).toEqual([]);
  });

  it('still clears every filled cell on a real row', () => {
    const plan = run({ r0: 0, r1: 0, c0: 0, c1: 3 });
    expect(cols(plan)).toEqual(['comment', 'left', 'kind']);
    expect(plan.edits.map((e) => e.value)).toEqual([null, null, 'Normal']);
  });

  it('a column-wide clear that includes the blank row clears only the real one', () => {
    const plan = run({ r0: 0, r1: 1, c0: 0, c1: 0 });
    expect(plan.edits).toEqual([{ row: 0, colKey: 'comment', value: null }]);
  });

  it('leaves the required-cell missing route alone on a real row', () => {
    const plan = run({ r0: 0, r1: 0, c0: 2, c1: 2 });
    expect(plan.edits).toEqual([]);
    expect(plan.missing).toEqual(['0:length']);
    expect(plan.cleared).toEqual([{ row: 0, colKey: 'length' }]);
  });

  it('still restores a required cell that is already marked missing', () => {
    const plan = run({ r0: 0, r1: 0, c0: 2, c1: 2 }, new Set(['0:length']));
    expect(plan.restored).toEqual(['0:length']);
    expect(plan.missing).toEqual([]);
  });
});
