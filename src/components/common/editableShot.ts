/**
 * The row type for shots that have not been committed yet.
 *
 * Its own module so the column definitions and the editor component can both
 * import it without a cycle. `ShotTableEditor` re-exports it, because half a
 * dozen call sites (useImportState, batchImportHelpers, shotConversion, several
 * tests) have always imported it from there.
 */
import type { Shot } from '../../types/project';

export interface EditableShot extends Omit<Shot, 'marker_index' | 'temperature'> {
  /** Added in this editing session, not yet persisted. */
  isNew?: boolean;
  /** Soft-deleted: kept in the array so indices stay stable, hidden from view. */
  isDeleted?: boolean;
  /** Identity for a row that has no server id yet. */
  tempId?: number;
}
