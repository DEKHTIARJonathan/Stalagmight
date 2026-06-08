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

/**
 * Cycle the active cell WITHIN a fixed selection rectangle (Google-Sheets
 * Tab/Enter-in-selection). `horizontal` = Tab order (row-major, left→right then
 * wrap to next row); `!horizontal` = Enter order (column-major, top→bottom then
 * wrap to next column). Wraps around the whole rectangle. `reverse` for
 * Shift+Tab / Shift+Enter.
 */
export function cycleActiveInRect(
  rect: Rect,
  activeRow: number,
  activeColIdx: number,
  horizontal: boolean,
  reverse: boolean,
): { row: number; colIdx: number } {
  const w = rect.c1 - rect.c0 + 1;
  const h = rect.r1 - rect.r0 + 1;
  const n = w * h;
  const dr = clamp(activeRow, rect.r0, rect.r1) - rect.r0;
  const dc = clamp(activeColIdx, rect.c0, rect.c1) - rect.c0;
  let pos = horizontal ? dr * w + dc : dc * h + dr;
  pos = (pos + (reverse ? -1 : 1) + n) % n;
  return horizontal
    ? { row: rect.r0 + Math.floor(pos / w), colIdx: rect.c0 + (pos % w) }
    : { row: rect.r0 + (pos % h), colIdx: rect.c0 + Math.floor(pos / h) };
}

/**
 * Continue a fill series from `seed` values, producing `count` new string values.
 * Google-Sheets semantics: a single seed COPIES; two or more seeds establish a
 * pattern that is extrapolated:
 *  - all-numeric → linear (constant delta of the last two), e.g. 1,2 → 3,4,5
 *  - trailing-integer text with a shared prefix → increment, e.g. A1,A2 → A3,A4
 *  - otherwise → tile/repeat the seed.
 * `parseNum` is the (locale-aware) numeric parser. Caller feeds the result back
 * through the column's own coercion.
 */
export function extendSeries(
  seed: string[],
  count: number,
  parseNum: (s: string) => number | undefined,
): string[] {
  if (count <= 0) return [];
  if (seed.length === 0) return new Array(count).fill('');
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const out: string[] = [];

  // 1) Numeric linear (single seed → delta 0 → copy).
  const nums = seed.map(parseNum);
  if (nums.every((x) => x !== undefined)) {
    const a = nums as number[];
    const delta = a.length >= 2 ? a[a.length - 1]! - a[a.length - 2]! : 0;
    let last = a[a.length - 1]!;
    for (let i = 0; i < count; i++) {
      last = round(last + delta);
      out.push(String(last));
    }
    return out;
  }

  // 2) Trailing-integer text with a shared prefix (needs ≥2 seeds).
  const re = /^(.*?)(-?\d+)$/;
  const parts = seed.map((s) => {
    const m = re.exec(s);
    return m ? { prefix: m[1] ?? '', n: parseInt(m[2]!, 10), width: m[2]!.replace('-', '').length } : null;
  });
  if (parts.length >= 2 && parts.every((p) => p !== null)) {
    const ps = parts as { prefix: string; n: number; width: number }[];
    if (ps.every((p) => p.prefix === ps[0]!.prefix)) {
      const delta = ps[ps.length - 1]!.n - ps[ps.length - 2]!.n;
      const prefix = ps[0]!.prefix;
      const width = ps[ps.length - 1]!.width;
      let last = ps[ps.length - 1]!.n;
      for (let i = 0; i < count; i++) {
        last += delta;
        const sign = last < 0 ? '-' : '';
        out.push(prefix + sign + String(Math.abs(last)).padStart(width, '0'));
      }
      return out;
    }
  }

  // 3) Copy / tile.
  for (let i = 0; i < count; i++) out.push(seed[i % seed.length]!);
  return out;
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
