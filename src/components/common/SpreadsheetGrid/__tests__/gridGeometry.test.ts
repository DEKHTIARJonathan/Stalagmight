import { describe, it, expect } from 'vitest';
import {
  clamp,
  selectionRect,
  isInRect,
  rectIsSingleCell,
  columnOffsets,
  arrowTarget,
  tabTarget,
  placePaste,
  fillTargets,
  type Rect,
} from '../gridGeometry';

const cols = ['id', 'a', 'b', 'c'];
const colIndexOf = (k: string) => cols.indexOf(k);

describe('clamp', () => {
  it('clamps to range', () => {
    expect(clamp(-1, 0, 5)).toBe(0);
    expect(clamp(9, 0, 5)).toBe(5);
    expect(clamp(3, 0, 5)).toBe(3);
  });
});

describe('selectionRect', () => {
  it('normalizes anchor/focus regardless of order', () => {
    const sel = { anchor: { row: 5, colKey: 'c' }, focus: { row: 2, colKey: 'a' } };
    expect(selectionRect(sel, colIndexOf)).toEqual({ r0: 2, r1: 5, c0: 1, c1: 3 });
  });
  it('single cell', () => {
    const sel = { anchor: { row: 1, colKey: 'b' }, focus: { row: 1, colKey: 'b' } };
    const rect = selectionRect(sel, colIndexOf);
    expect(rect).toEqual({ r0: 1, r1: 1, c0: 2, c1: 2 });
    expect(rectIsSingleCell(rect)).toBe(true);
  });
});

describe('isInRect', () => {
  const rect: Rect = { r0: 1, r1: 3, c0: 1, c1: 2 };
  it('includes interior + edges, excludes outside', () => {
    expect(isInRect(rect, 2, 1)).toBe(true);
    expect(isInRect(rect, 1, 2)).toBe(true);
    expect(isInRect(rect, 0, 1)).toBe(false);
    expect(isInRect(rect, 2, 3)).toBe(false);
  });
});

describe('columnOffsets', () => {
  it('prefix-sums widths with a leading 0 and trailing total', () => {
    expect(columnOffsets([100, 120, 80])).toEqual([0, 100, 220, 300]);
  });
});

describe('arrowTarget (no wrap, clamped)', () => {
  it('moves one cell', () => {
    expect(arrowTarget(2, 1, 1, 0, 10, 4)).toEqual({ row: 3, colIdx: 1 });
    expect(arrowTarget(2, 1, 0, 1, 10, 4)).toEqual({ row: 2, colIdx: 2 });
  });
  it('does not wrap at edges', () => {
    expect(arrowTarget(0, 0, -1, -1, 10, 4)).toEqual({ row: 0, colIdx: 0 });
    expect(arrowTarget(9, 3, 1, 1, 10, 4)).toEqual({ row: 9, colIdx: 3 });
  });
});

describe('tabTarget (skip read-only, wrap rows, clamp ends)', () => {
  // writable columns are indices 1 and 3 (0 and 2 are read-only)
  const writable = [1, 3];
  it('moves to next writable column in the row', () => {
    expect(tabTarget(2, 1, 1, writable, 10)).toEqual({ row: 2, colIdx: 3 });
  });
  it('wraps to next row first writable when past the last writable', () => {
    expect(tabTarget(2, 3, 1, writable, 10)).toEqual({ row: 3, colIdx: 1 });
  });
  it('shift-tab moves to previous writable / wraps to prev row last writable', () => {
    expect(tabTarget(2, 3, -1, writable, 10)).toEqual({ row: 2, colIdx: 1 });
    expect(tabTarget(2, 1, -1, writable, 10)).toEqual({ row: 1, colIdx: 3 });
  });
  it('clamps at the grid extremes', () => {
    expect(tabTarget(9, 3, 1, writable, 10)).toEqual({ row: 9, colIdx: 3 });
    expect(tabTarget(0, 1, -1, writable, 10)).toEqual({ row: 0, colIdx: 1 });
  });
  it('returns null when nothing is writable', () => {
    expect(tabTarget(0, 0, 1, [], 10)).toBeNull();
  });
});

describe('placePaste', () => {
  const rectAt = (r0: number, c0: number, r1 = r0, c1 = c0): Rect => ({ r0, r1, c0, c1 });

  it('1×1 clipboard fills the whole selection', () => {
    const { targets, clipped } = placePaste([['X']], rectAt(0, 0, 1, 1), 10, 4);
    expect(clipped).toBe(0);
    expect(targets).toHaveLength(4);
    expect(targets.every((t) => t.raw === 'X')).toBe(true);
  });

  it('pastes an R×C block anchored at the selection top-left (auto-grow)', () => {
    const clip = [['a', 'b'], ['c', 'd']];
    const { targets } = placePaste(clip, rectAt(2, 1), 10, 4); // single active cell
    expect(targets).toContainEqual({ row: 2, colIdx: 1, raw: 'a' });
    expect(targets).toContainEqual({ row: 2, colIdx: 2, raw: 'b' });
    expect(targets).toContainEqual({ row: 3, colIdx: 1, raw: 'c' });
    expect(targets).toContainEqual({ row: 3, colIdx: 2, raw: 'd' });
  });

  it('tiles when the selection is an exact integer multiple of the clipboard', () => {
    const clip = [['a', 'b']]; // 1×2
    const { targets } = placePaste(clip, rectAt(0, 0, 0, 3), 10, 4); // 1×4 selection
    expect(targets.map((t) => t.raw)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('clips cells past the last row / last column (never grows the grid)', () => {
    const clip = [['a', 'b'], ['c', 'd']];
    const { targets, clipped } = placePaste(clip, rectAt(9, 3), 10, 4); // bottom-right corner
    expect(targets).toEqual([{ row: 9, colIdx: 3, raw: 'a' }]);
    expect(clipped).toBe(3);
  });
});

describe('fillTargets', () => {
  it('fill-down copies the top row into the rows below', () => {
    const out = fillTargets({ r0: 0, r1: 2, c0: 1, c1: 1 }, true);
    expect(out).toEqual([
      { row: 1, colIdx: 1, srcRow: 0, srcColIdx: 1 },
      { row: 2, colIdx: 1, srcRow: 0, srcColIdx: 1 },
    ]);
  });
  it('fill-right copies the left column into the columns to the right', () => {
    const out = fillTargets({ r0: 0, r1: 0, c0: 1, c1: 3 }, false);
    expect(out).toEqual([
      { row: 0, colIdx: 2, srcRow: 0, srcColIdx: 1 },
      { row: 0, colIdx: 3, srcRow: 0, srcColIdx: 1 },
    ]);
  });
});
