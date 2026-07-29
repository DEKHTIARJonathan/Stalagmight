import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

/**
 * Manual column-width overrides for SpreadsheetGrid.
 *
 * Split out of SpreadsheetGrid.tsx at the ratchet's hard 2000-prod-LOC budget
 * (#157-style split). The state deliberately lives here rather than being fully
 * controlled by the host: a resize drag fires on every mousemove, so lifting it
 * would re-render the host per pixel and, where the host persists to disk, write
 * per pixel too. Instead the grid owns the live value and hands it over once the
 * drag lands.
 */

/** Widest column a manual drag will persist. Mirrors MAX_COLUMN_WIDTH in
 *  src-tauri/src/config/types.rs, which clamps the same value on load. */
export const MAX_COL_WIDTH = 2000;

/** Cap for double-click autofit, which is automatic and so should not be able to
 *  produce a monster column from a single long cell. */
export const AUTOFIT_MAX_COL_WIDTH = 600;

export type ColumnWidths = Record<string, number>;

/** Shallow equality, so an unchanged host prop doesn't clobber a drag in
 *  progress (React hands us a fresh object identity on every render). */
function sameWidths(a: ColumnWidths, b: ColumnWidths): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
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
}

export function useColumnWidths(
  columnWidths: ColumnWidths | undefined,
  onColumnWidthsChange: ((widths: ColumnWidths) => void) | undefined,
): ColumnWidthsController {
  const [widths, setWidths] = useState<ColumnWidths>(() => columnWidths ?? {});
  const widthsRef = useRef<ColumnWidths>(widths);
  // The last map handed to the host, so its echo back through the prop can be
  // told apart from a genuine outside change.
  const emittedRef = useRef<ColumnWidths>(widths);

  const applyWidths = useCallback((next: ColumnWidths) => {
    widthsRef.current = next;
    setWidths(next);
  }, []);

  const commitWidths = useCallback(
    (next: ColumnWidths) => {
      // Round before handing over: the persisted config stores integers.
      const rounded = Object.fromEntries(
        Object.entries(next).map(([k, w]) => [k, Math.round(w)]),
      );
      applyWidths(rounded);
      emittedRef.current = rounded;
      onColumnWidthsChange?.(rounded);
    },
    [applyWidths, onColumnWidthsChange],
  );

  // Adopt host widths that did not originate here, e.g. hydrated from config
  // after mount. Skipping our own echo keeps the grid from fighting the host.
  useEffect(() => {
    const next = columnWidths ?? {};
    if (sameWidths(next, emittedRef.current)) return;
    emittedRef.current = next;
    applyWidths(next);
  }, [columnWidths, applyWidths]);

  return { widths, widthsRef, applyWidths, commitWidths };
}
