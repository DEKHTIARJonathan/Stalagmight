/**
 * What a Delete over a selection rectangle should do, decided before any state
 * moves. Pure so the rule is readable and testable on its own, and so the grid
 * component - which sits at its size ratchet - only has to apply the result.
 */
import type { GridColumn } from './types';

export interface ClearPlan {
  /** Cells that take a real empty value (nullable number -> null, text -> ''). */
  edits: { row: number; colKey: string; value: unknown }[];
  /** Missing-cell keys to add: a required cell cleared to nothing. */
  missing: string[];
  /** Missing-cell keys to remove: Delete on an already-missing cell restores it,
   *  because the model still holds the value and unmarking re-reveals it. */
  restored: string[];
  /** The present -> missing transitions only, for a provisional host to drop the
   *  field. Never a restore. */
  cleared: { row: number; colKey: string }[];
}

export function planClear<Row>(opts: {
  rect: { r0: number; r1: number; c0: number; c1: number };
  colAt: (c: number) => GridColumn<Row> | undefined;
  cellEditable: (row: number, col: GridColumn<Row>) => boolean;
  /** Route through the column's coercion: a required number yields `undefined`
   *  (mark missing - NEVER write 0), nullable yields null, text its empty. */
  parseForColumn: (col: GridColumn<Row>, raw: string, row: number) => unknown;
  missKey: (row: number, colKey: string) => string | null;
  missingCells: ReadonlySet<string>;
}): ClearPlan {
  const { rect, colAt, cellEditable, parseForColumn, missKey, missingCells } = opts;
  const plan: ClearPlan = { edits: [], missing: [], restored: [], cleared: [] };
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      const col = colAt(c);
      if (!col || !cellEditable(r, col)) continue;
      const value = parseForColumn(col, '', r);
      if (value === undefined) {
        const k = missKey(r, col.key);
        if (k === null) continue;
        if (missingCells.has(k)) plan.restored.push(k);
        else {
          plan.missing.push(k);
          plan.cleared.push({ row: r, colKey: col.key });
        }
        continue;
      }
      plan.edits.push({ row: r, colKey: col.key, value });
    }
  }
  return plan;
}
