import { useProjectStore } from '../store/projectStore';
import { isPermissionError } from './saveErrors';
import type { ValidationWarning } from '../types/ipc/ValidationWarning';

/**
 * Surface a failed (non-throwing) save to the user.
 *
 * Three classes of failure, in priority order:
 *  1. Unresolvable cross-references — NOT an error, an integrity problem the
 *     user can fix. Route them straight to the Review & Repair dialog instead
 *     of a scary "Save Failed" error window.
 *  2. Filesystem permission denial (e.g. macOS forgot folder access) — already
 *     surfaced by `saveProject` itself via the folder-access guidance dialog,
 *     so don't double up with a generic error window.
 *  3. Anything else (a real I/O error) — show the error dialog as before.
 *
 * Reads `integritySaveBlocked`, which `saveProject` refreshes (awaited) on
 * failure, so it is current by the time this runs.
 */
export function surfaceSaveFailure(
  error: string | null | undefined,
  openDialog: (dialog: string, data?: Record<string, unknown>) => void,
): void {
  if (useProjectStore.getState().integritySaveBlocked) {
    useProjectStore.getState().openIntegrityDialog();
    return;
  }
  if (error && !isPermissionError(error)) {
    openDialog('error', { message: error, title: 'Save Failed' });
  }
}

/**
 * Surface non-fatal warnings the backend attaches to an otherwise *successful*
 * import (`CommandResult.warnings`) — most importantly the partial-success
 * deferred-save failure ("Imported, but could not save the new project to disk
 * … please save manually."). The import dialogs branch only on `success` /
 * `error`, so without this they close as if fully successful and the user never
 * learns the import is only in memory (#110). No-op when there are no warnings.
 */
export function surfaceImportWarnings(
  warnings: ValidationWarning[] | undefined,
  openDialog: (dialog: string, data?: Record<string, unknown>) => void,
): void {
  if (!warnings || warnings.length === 0) return;
  openDialog('error', {
    title: 'Import Warning',
    message: warnings.map((w) => w.message).join('\n\n'),
  });
}
