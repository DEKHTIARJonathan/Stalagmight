/**
 * The toast stack's geometry, as pure arithmetic: how many toasts fit, where
 * each one sits, and how tall the column is.
 *
 * This is the half of the stack that can be tested exactly. jsdom has no layout
 * engine, so the component can only be asked "did you recompute?"; the numbers
 * themselves are pinned here.
 */
import { describe, it, expect } from 'vitest';

import {
  ESTIMATED_TOAST_HEIGHT_PX,
  MAX_VISIBLE_TOASTS,
  MIN_VISIBLE_TOASTS,
  TOAST_GAP_PX,
  clampToastCapacity,
  fitToastCapacity,
  toastStackHeight,
  toastStackOffsets,
} from './toastCapacity';

/** `n` toasts of `height` px each, as the newest-first array the fitter wants. */
const rows = (n: number, height: number) => Array.from({ length: n }, () => height);

/** Exact viewport height whose 20% budget is `px`. */
const viewportFor = (px: number) => px * 5;

describe('fitToastCapacity - the 20% budget', () => {
  it('admits toasts while they fit inside 20% of the window', () => {
    // 3 x 40 + 2 gaps = 136. Budget 140 (a 700px window) fits three, not four.
    expect(fitToastCapacity(700, rows(6, 40))).toBe(3);
  });

  it('counts the gap between toasts, not just their heights', () => {
    // Exactly three 40px toasts with no gaps would be 120: budget 120 admits
    // only two once the 8px gaps are paid for (40 + 8 + 40 = 88, next is 136).
    expect(fitToastCapacity(viewportFor(120), rows(6, 40))).toBe(2);
    expect(fitToastCapacity(viewportFor(136), rows(6, 40))).toBe(3);
  });

  it('admits a toast that fills the budget exactly', () => {
    expect(fitToastCapacity(viewportFor(88), rows(6, 40))).toBe(2);
  });

  it('fits fewer tall toasts than short ones in the same window', () => {
    const tall = fitToastCapacity(1000, rows(6, 90));
    const short = fitToastCapacity(1000, rows(6, 30));
    expect(tall).toBeLessThan(short);
  });

  it('measures each toast individually rather than assuming a row height', () => {
    // Budget 200. One 150px toast eats most of it: the next one takes it to 198
    // and a third would not fit.
    expect(fitToastCapacity(viewportFor(200), [150, 40, 40, 40])).toBe(2);
    // The same budget with short ones fits four (40+8+40+8+40+8+40 = 184).
    expect(fitToastCapacity(viewportFor(200), [40, 40, 40, 40])).toBe(4);
  });

  it('costs the not-yet-arrived slots at the estimated height', () => {
    // Nothing measured yet: the answer is still a capacity, not zero.
    const budget = ESTIMATED_TOAST_HEIGHT_PX * 3 + TOAST_GAP_PX * 2;
    expect(fitToastCapacity(viewportFor(budget), [])).toBe(3);
  });
});

describe('fitToastCapacity - the ceiling of five', () => {
  it('never exceeds five however tall the window', () => {
    expect(fitToastCapacity(20000, rows(20, 40))).toBe(MAX_VISIBLE_TOASTS);
    expect(MAX_VISIBLE_TOASTS).toBe(5);
  });

  it('stops at five even when the budget would allow more', () => {
    // 20% of 10000 is 2000px - room for dozens of 40px toasts.
    expect(fitToastCapacity(10000, rows(50, 40))).toBe(5);
  });
});

describe('fitToastCapacity - the floor of two', () => {
  it('always allows two, even when two do not fit the budget', () => {
    // 20% of 200 is 40px: one 40px toast fits, two never could.
    expect(fitToastCapacity(200, rows(6, 40))).toBe(MIN_VISIBLE_TOASTS);
    expect(MIN_VISIBLE_TOASTS).toBe(2);
  });

  it('allows two when not even one fits', () => {
    expect(fitToastCapacity(100, rows(6, 200))).toBe(2);
  });

  it('treats an unmeasured viewport as NO constraint, not as no room', () => {
    // A non-positive height means the window has not reported a size yet, which
    // is not the same as a window with no room in it. Flooring here was a real
    // bug: a webview whose innerHeight reads 0 on first paint stranded the stack
    // at two forever, because nothing re-triggers the measurement on a window
    // that is never resized. A genuinely SMALL viewport still floors at two -
    // that is the two cases above.
    expect(fitToastCapacity(0, rows(6, 40))).toBe(MAX_VISIBLE_TOASTS);
    expect(fitToastCapacity(Number.NaN, rows(6, 40))).toBe(MAX_VISIBLE_TOASTS);
    expect(fitToastCapacity(-500, rows(6, 40))).toBe(MAX_VISIBLE_TOASTS);
  });

  it('ignores unmeasured or nonsense heights and falls back to the estimate', () => {
    const budget = ESTIMATED_TOAST_HEIGHT_PX * 3 + TOAST_GAP_PX * 2;
    expect(fitToastCapacity(viewportFor(budget), [0, Number.NaN, -10, 0])).toBe(3);
  });
});

describe('fitToastCapacity - resizing changes the answer', () => {
  it('shrinks as the window shrinks and grows back', () => {
    const heights = rows(5, 40);
    expect(fitToastCapacity(2000, heights)).toBe(5);
    expect(fitToastCapacity(700, heights)).toBe(3);
    expect(fitToastCapacity(300, heights)).toBe(2);
    expect(fitToastCapacity(2000, heights)).toBe(5);
  });

  it('is monotonic in the window height', () => {
    const heights = rows(5, 40);
    let previous = 0;
    for (const viewport of [100, 300, 500, 700, 900, 1200, 2000]) {
      const capacity = fitToastCapacity(viewport, heights);
      expect(capacity).toBeGreaterThanOrEqual(previous);
      previous = capacity;
    }
  });
});

describe('clampToastCapacity', () => {
  it.each([
    [-3, 2],
    [0, 2],
    [1, 2],
    [2, 2],
    [4, 4],
    [5, 5],
    [9, 5],
    [3.9, 3],
  ])('clamps %s to %s', (input, expected) => {
    expect(clampToastCapacity(input)).toBe(expected);
  });

  it('falls back to the ceiling for a nonsense number', () => {
    expect(clampToastCapacity(Number.NaN)).toBe(MAX_VISIBLE_TOASTS);
  });
});

describe('toastStackOffsets', () => {
  it('puts the newest toast on the anchor and pushes older ones up', () => {
    // Oldest-first, matching UIStore.toasts.
    expect(toastStackOffsets([40, 40, 40])).toEqual([96, 48, 0]);
  });

  it('uses the measured height of each toast, so a wrapped message pushes further', () => {
    expect(toastStackOffsets([40, 80, 40])).toEqual([136, 48, 0]);
  });

  it('is empty for an empty stack and zero for a single toast', () => {
    expect(toastStackOffsets([])).toEqual([]);
    expect(toastStackOffsets([40])).toEqual([0]);
  });
});

describe('toastStackHeight', () => {
  it('sums the heights plus the gaps between them', () => {
    expect(toastStackHeight([40, 40, 40])).toBe(136);
    expect(toastStackHeight([40])).toBe(40);
    expect(toastStackHeight([])).toBe(0);
  });
});
