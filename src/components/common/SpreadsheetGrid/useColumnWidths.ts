import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { clampRound } from '../../../utils/clamp';
import { DEFAULT_COL_WIDTH, type GridColumn } from './types';

/**
 * Column-width state and layout for SpreadsheetGrid: the manual overrides, the
 * leftover-width distribution that reads them, and the commit/revert lifecycle
 * that mutates them.
 *
 * Two reasons this is its own module rather than more of SpreadsheetGrid.tsx: it
 * keeps the width rules next to the constants the Rust side mirrors, and
 * SpreadsheetGrid.tsx sits close to the ratchet's hard 2000-prod-LOC cap, which no
 * baseline bump can raise.
 *
 * The state deliberately lives here rather than being fully controlled by the
 * host: a resize drag fires on every mousemove, so lifting it would re-render the
 * host per pixel and, where the host persists to disk, write per pixel too.
 * Instead the grid owns the live value and hands it over once the drag lands.
 */

/** Smallest width the grid can render legibly. */
export const MIN_COL_WIDTH = 40;

/** Widest column a manual drag will persist. */
export const MAX_COL_WIDTH = 2000;

/** Cap for double-click autofit, which is automatic and so should not be able to
 *  produce a monster column from a single long cell. */
export const AUTOFIT_MAX_COL_WIDTH = 600;

// MIN_COL_WIDTH / MAX_COL_WIDTH are mirrored by MIN_COLUMN_WIDTH /
// MAX_COLUMN_WIDTH in src-tauri/src/config/types.rs, which clamps the same range
// when a persisted width is read back. Nothing enforces the mirror, so change all
// four together.

export type ColumnWidths = Record<string, number>;

/** Shallow equality, so an unchanged host prop doesn't clobber a drag in
 *  progress (React hands us a fresh object identity on every render). */
function sameWidths(a: ColumnWidths, b: ColumnWidths): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/**
 * Rendered width per visible column: each column's own width, then any leftover
 * container space split across the `grow` columns so the grid fills its panel.
 *
 * A manual override raises a column's starting width but does NOT opt it out of
 * growing. Overrides used to be session-only, so a de-grown column healed on the
 * next remount; now that they persist, pinning would mean one resize of the
 * trailing grow column left a permanent empty right gutter, in every session, with
 * no UI to clear it. Treating the override as the grow FLOOR keeps the resize
 * meaningful without ever stranding the layout.
 */
export function computeColumnWidths<Row>(
  columns: GridColumn<Row>[],
  overrides: ColumnWidths,
  availWidth: number,
  gutterWidth: number,
): number[] {
  const base = columns.map((c) => overrides[c.key] ?? c.width ?? DEFAULT_COL_WIDTH);
  const growIdx = columns.map((c, i) => (c.grow ? i : -1)).filter((i) => i >= 0);
  if (growIdx.length === 0 || availWidth <= 0) return base;
  const leftover = availWidth - gutterWidth - base.reduce((sum, w) => sum + w, 0);
  if (leftover <= 0) return base;
  const add = Math.floor(leftover / growIdx.length);
  const rem = leftover - add * growIdx.length;
  const out = base.slice();
  growIdx.forEach((i, n) => {
    out[i] = (out[i] ?? 0) + add + (n < rem ? 1 : 0);
  });
  return out;
}

export interface ColumnWidthsController {
  /** Current overrides, for rendering. */
  widths: ColumnWidths;
  /** Latest overrides without waiting for a re-render - drag handlers build the
   *  next map from this, not from the state value they closed over. */
  widthsRef: MutableRefObject<ColumnWidths>;
  /** Update locally only. For continuous drag feedback. */
  applyWidths: (next: ColumnWidths) => void;
  /** Update and notify the host. For a resize that has landed. */
  commitWidths: (next: ColumnWidths) => void;
  /** Drop every uncommitted change, restoring the last map the host and grid
   *  agreed on. For a drag that was abandoned rather than released. */
  revertWidths: () => void;
}

export function useColumnWidths(
  columnWidths: ColumnWidths | undefined,
  onColumnWidthsChange: ((widths: ColumnWidths) => void) | undefined,
): ColumnWidthsController {
  const [widths, setWidths] = useState<ColumnWidths>(() => columnWidths ?? {});
  const widthsRef = useRef<ColumnWidths>(widths);
  // The last map the host and grid agreed on: what we handed the host, or what we
  // last adopted from it. Doubles as the echo filter and the revert target.
  const settledRef = useRef<ColumnWidths>(widths);

  const applyWidths = useCallback((next: ColumnWidths) => {
    widthsRef.current = next;
    setWidths(next);
  }, []);

  const commitWidths = useCallback(
    (next: ColumnWidths) => {
      // Whole integer pixels only: the persisted config stores u32, and clampRound
      // also absorbs a non-finite width rather than letting NaN reach the backend
      // and be silently rejected.
      const settled = Object.fromEntries(
        Object.entries(next).map(([k, w]) => [k, clampRound(w, MIN_COL_WIDTH, MAX_COL_WIDTH)]),
      );
      applyWidths(settled);
      settledRef.current = settled;
      onColumnWidthsChange?.(settled);
    },
    [applyWidths, onColumnWidthsChange],
  );

  // An abandoned drag has already written its in-progress width into the live map -
  // that is what makes the column follow the pointer - so clearing the drag flag is
  // not enough to undo it. Left in place it would both render a width that was
  // never saved AND ride along on the next commit, which spreads the whole map, so
  // an unrelated resize would persist it. Restore the settled map instead.
  const revertWidths = useCallback(() => {
    if (sameWidths(widthsRef.current, settledRef.current)) return;
    applyWidths(settledRef.current);
  }, [applyWidths]);

  // Adopt host widths that did not originate here, e.g. hydrated from config
  // after mount. Skipping our own echo keeps the grid from fighting the host.
  useEffect(() => {
    const next = columnWidths ?? {};
    if (sameWidths(next, settledRef.current)) return;
    settledRef.current = next;
    applyWidths(next);
  }, [columnWidths, applyWidths]);

  return { widths, widthsRef, applyWidths, commitWidths, revertWidths };
}
