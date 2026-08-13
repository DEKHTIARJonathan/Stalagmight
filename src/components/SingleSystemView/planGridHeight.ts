import { ROW_HEIGHT } from '../common/SpreadsheetGrid';

/** Mirrors the private `HEADER_HEIGHT` in
 *  `src/components/common/SpreadsheetGrid/SpreadsheetGrid.tsx` (the grid does not
 *  export it). Kept as a named constant so the arithmetic below reads as
 *  "header + rows" rather than as a magic 33. */
const HEADER_HEIGHT = 33;

/**
 * Height for a CONTENT-SIZED plan grid: the header plus however many rows there
 * are, capped at `maxRows` (past which the grid scrolls internally).
 *
 * The Plan-mode tables cannot claim full height the way the data table does -
 * the Cylinders grid stacks above the DPV rig editor inside one scroll
 * container, and a full-height grid pushed the editor below the fold (#317
 * feedback). An empty table still gets one row of body height so the header does
 * not sit on a zero-height void.
 */
export function planGridHeight(rowCount: number, maxRows: number): number {
  return HEADER_HEIGHT + Math.min(Math.max(rowCount, 1), maxRows) * ROW_HEIGHT;
}
