/**
 * Pure edit-dispatch helpers for the data-table grid integration.
 *
 * The grid emits edits as `{ row, colKey, value }` with values already coerced by
 * each column's parser. These helpers turn those into shot `ShotUpdates` patches
 * and `update_shot` batch commands, expanding the virtual "average azimuth"
 * column into an in/out pair via the same delta-offset rule the old inline editor
 * used (so editing the displayed mean rotates both legs by the same amount).
 *
 * Kept free of React/store imports so it is unit-testable in the node vitest env.
 */
import type { CellEdit } from '../common/SpreadsheetGrid/types';
import type { Shot, ShotUpdates, SectionId } from '../../types/project';
import type { BatchCommand } from '../../types/commands';
import { circularMeanDegrees, normalizeAngle } from '../../utils/angles';

/** Virtual column key for the displayed average azimuth (not a real shot field). */
export const AZIMUTH_AVG_KEY = '_azimuth_avg';

/** Build a ShotUpdates patch for one shot from its edits. The azimuth-average
 *  column rotates both legs by (newMean - currentMean); a non-finite new mean is
 *  skipped. All other column keys are real shot fields, assigned directly. */
export function buildShotUpdates(
  shot: Shot,
  edits: { colKey: string; value: unknown }[],
): ShotUpdates {
  const updates: ShotUpdates = {};
  for (const { colKey, value } of edits) {
    if (colKey === AZIMUTH_AVG_KEY) {
      const newMean = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(newMean)) continue;
      const delta = newMean - circularMeanDegrees(shot.azimuth_in, shot.azimuth_out);
      updates.azimuth_in = normalizeAngle(shot.azimuth_in + delta);
      updates.azimuth_out = normalizeAngle(shot.azimuth_out + delta);
    } else {
      (updates as Record<string, unknown>)[colKey] = value;
    }
  }
  return updates;
}

/** Group a flat list of grid edits into one `update_shot` command per shot, so a
 *  multi-cell paste/fill commits as a single undo unit via execute_batch. Edits
 *  on rows outside `shots` are dropped; shots with no net change are skipped. */
export function buildShotUpdateBatch(
  edits: CellEdit[],
  shots: Shot[],
  sectionId: SectionId,
): BatchCommand[] {
  const byRow = new Map<number, CellEdit[]>();
  for (const e of edits) {
    const arr = byRow.get(e.row);
    if (arr) arr.push(e);
    else byRow.set(e.row, [e]);
  }
  const commands: BatchCommand[] = [];
  for (const [row, rowEdits] of byRow) {
    const shot = shots[row];
    if (!shot) continue;
    const updates = buildShotUpdates(shot, rowEdits);
    if (Object.keys(updates).length === 0) continue;
    commands.push({ type: 'update_shot', section_id: sectionId, shot_id: shot.id, updates });
  }
  return commands;
}
