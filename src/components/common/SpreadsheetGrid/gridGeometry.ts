/**
 * Pure selection / navigation / paste / fill math for SpreadsheetGrid.
 *
 * All functions operate on the DATA MODEL (row indices + visible-column
 * indices), never the DOM — this is the keystone constraint: virtualized rows
 * unmount when scrolled off-screen, so selection, copy, paste and fill must be
 * computable for cells that aren't currently rendered. Unit-tested.
 */
import type { GridSelection } from './types';

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Inclusive, normalized rectangle in (row, visibleColumnIndex) space. */
export interface Rect {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** Normalize a selection to an inclusive rect, given a colKey→visible-index map. */
export function selectionRect(
  sel: GridSelection,
  colIndexOf: (colKey: string) => number,
): Rect {
  const ac = colIndexOf(sel.anchor.colKey);
  const fc = colIndexOf(sel.focus.colKey);
  return {
    r0: Math.min(sel.anchor.row, sel.focus.row),
    r1: Math.max(sel.anchor.row, sel.focus.row),
    c0: Math.min(ac, fc),
    c1: Math.max(ac, fc),
  };
}

export function isInRect(rect: Rect, row: number, colIdx: number): boolean {
  return row >= rect.r0 && row <= rect.r1 && colIdx >= rect.c0 && colIdx <= rect.c1;
}

export function rectIsSingleCell(rect: Rect): boolean {
  return rect.r0 === rect.r1 && rect.c0 === rect.c1;
}

/** Prefix-sum of column widths → left offsets. Returns length `widths.length + 1`
 *  so `offsets[i]` is the left edge of column i and `offsets[n]` the right edge. */
export function columnOffsets(widths: number[]): number[] {
  const offsets = [0];
  for (let i = 0; i < widths.length; i++) {
    offsets.push((offsets[i] ?? 0) + (widths[i] ?? 0));
  }
  return offsets;
}

/** Arrow-key target: move one cell, NO wrap, clamped to the grid. Lands on every
 *  visible column including read-only ones. */
export function arrowTarget(
  row: number,
  colIdx: number,
  dRow: number,
  dCol: number,
  rowCount: number,
  colCount: number,
): { row: number; colIdx: number } {
  return {
    row: clamp(row + dRow, 0, Math.max(0, rowCount - 1)),
    colIdx: clamp(colIdx + dCol, 0, Math.max(0, colCount - 1)),
  };
}

/** Tab / Shift+Tab target: move to the next WRITABLE column, wrapping to the
 *  next/prev row's first/last writable column; clamps at the grid extremes.
 *  `writableCols` is the sorted list of visible-column indices that accept edits.
 *  Returns null when there are no writable columns. */
export function tabTarget(
  row: number,
  colIdx: number,
  dir: 1 | -1,
  writableCols: number[],
  rowCount: number,
): { row: number; colIdx: number } | null {
  if (writableCols.length === 0) return null;
  const first = writableCols[0] as number;
  const lastCol = writableCols[writableCols.length - 1] as number;
  if (dir === 1) {
    const next = writableCols.find((c) => c > colIdx);
    if (next !== undefined) return { row, colIdx: next };
    if (row + 1 < rowCount) return { row: row + 1, colIdx: first };
    return { row, colIdx: lastCol }; // clamp at grid end
  }
  const prev = [...writableCols].reverse().find((c) => c < colIdx);
  if (prev !== undefined) return { row, colIdx: prev };
  if (row - 1 >= 0) return { row: row - 1, colIdx: lastCol };
  return { row, colIdx: first }; // clamp at grid start
}

export interface PasteTarget {
  row: number;
  colIdx: number;
  raw: string;
}

/**
 * Place a parsed clipboard matrix onto the grid at a selection rect.
 *
 * Rules (Google-Sheets semantics):
 *  - 1×1 clipboard onto a multi-cell selection → fill the whole selection.
 *  - Selection is an exact integer multiple of the clipboard (and larger) →
 *    tile/repeat the clipboard across the selection.
 *  - Otherwise → paste the R×C block anchored at the selection's top-left,
 *    auto-growing past the selection.
 *  - Cells past the last row / last visible column are clipped (counted, never
 *    create new rows/columns).
 */
export function placePaste(
  clip: string[][],
  rect: Rect,
  rowCount: number,
  colCount: number,
): { targets: PasteTarget[]; clipped: number } {
  const ch = clip.length;
  const cw = clip.reduce((m, r) => Math.max(m, r.length), 0);
  if (ch === 0 || cw === 0) return { targets: [], clipped: 0 };

  const selH = rect.r1 - rect.r0 + 1;
  const selW = rect.c1 - rect.c0 + 1;
  const single = ch === 1 && cw === 1;
  const tiles =
    !single &&
    selH % ch === 0 &&
    selW % cw === 0 &&
    (selH > ch || selW > cw);

  const destRows = single || tiles ? selH : ch;
  const destCols = single || tiles ? selW : cw;

  const targets: PasteTarget[] = [];
  let clipped = 0;
  for (let i = 0; i < destRows; i++) {
    for (let j = 0; j < destCols; j++) {
      const r = rect.r0 + i;
      const c = rect.c0 + j;
      const raw = single ? (clip[0]?.[0] ?? '') : (clip[i % ch]?.[j % cw] ?? '');
      if (r >= rowCount || c >= colCount) {
        clipped++;
        continue;
      }
      targets.push({ row: r, colIdx: c, raw });
    }
  }
  return { targets, clipped };
}

/**
 * Fill targets: copy the leading edge of the rect across the rest.
 * Copy-fill only (NO numeric auto-series — deliberate for survey data).
 * `down` fills each column's top row downward; otherwise fills each row's left
 * column rightward. Returns (destRow,destCol)→(srcRow,srcCol) pairs, excluding
 * the source edge itself.
 */
export function fillTargets(
  rect: Rect,
  down: boolean,
): { row: number; colIdx: number; srcRow: number; srcColIdx: number }[] {
  const out: { row: number; colIdx: number; srcRow: number; srcColIdx: number }[] = [];
  if (down) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      for (let r = rect.r0 + 1; r <= rect.r1; r++) {
        out.push({ row: r, colIdx: c, srcRow: rect.r0, srcColIdx: c });
      }
    }
  } else {
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0 + 1; c <= rect.c1; c++) {
        out.push({ row: r, colIdx: c, srcRow: r, srcColIdx: rect.c0 });
      }
    }
  }
  return out;
}
