import { useProjectStore } from '../store/projectStore';
import { isPermissionError } from './saveErrors';
import { trackDialogComplete } from './telemetry';
import type { ValidationWarning } from '../types/ipc/ValidationWarning';

/**
 * Surface a failed (non-throwing) save to the user.
 *
 * Three classes of failure, in priority order:
 *  1. Unresolvable cross-references - NOT an error, an integrity problem the
 *     user can fix. Route them straight to the Review & Repair dialog instead
 *     of a scary "Save Failed" error window.
 *  2. Filesystem permission denial (e.g. macOS forgot folder access) - already
 *     surfaced by `saveProject` itself via the folder-access guidance dialog,
 *     so don't double up with a generic error window.
 *  3. Anything else (a real I/O error) - show the error dialog as before.
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
 * The backend stamps the deferred-save partial-success warning
 * (`finalize_deferred_import` → `CommandResult::with_warning`, src-tauri) with the
 * generic "SYSTEM" code, and `with_warning` is the ONLY caller of that code in the
 * crate. So this reliably distinguishes "imported but couldn't save to disk" from
 * ordinary per-shot validation warnings (LONG_SHOT, AZIMUTH_DEVIATION, …): those
 * carry their own codes, ride along on a *successful, fully-saved* import, and are
 * already surfaced through the data-table warning UI - they must NOT pop a modal
 * here (nor suppress the orphan-placement step). (#110)
 */
const DEFERRED_SAVE_WARNING_CODE = 'SYSTEM';

/**
 * The subset of an import's `CommandResult.warnings` that mean "the import is only
 * in memory - the save failed". Empty for a fully-persisted import, even one that
 * carries routine validation warnings. (#110)
 */
export function deferredSaveWarnings(
  warnings: ValidationWarning[] | undefined,
): ValidationWarning[] {
  return (warnings ?? []).filter((w) => w.code === DEFERRED_SAVE_WARNING_CODE);
}

/**
 * Surface deferred-save warning(s) so the user learns their import is only in
 * memory and must be saved manually (#110). Pass the result of
 * `deferredSaveWarnings()`; no-op when empty. Reuses the generic error dialog but
 * suppresses its "report this as a bug" footer - a failed save is an actionable
 * disk/permission condition, not a bug to report.
 */
export function surfaceImportWarnings(
  warnings: ValidationWarning[],
  openDialog: (dialog: string, data?: Record<string, unknown>) => void,
): void {
  if (warnings.length === 0) return;
  openDialog('error', {
    title: 'Import Warning',
    message: warnings.map((w) => w.message).join('\n\n'),
    hideReportHint: true,
  });
}

/** The UI store actions a new-project import dialog uses to finish: close the
 *  dialog, return to the fitted single-system view, and surface follow-ups. */
export interface ImportDialogUi {
  closeDialog: () => void;
  setView: (view: 'single') => void;
  triggerFitToBounds: () => void;
  openDialog: (dialog: string, data?: Record<string, unknown>) => void;
}

/**
 * Close the import dialog and return to the fitted single-system view, stamping
 * the dialog-complete telemetry event first. Shared exit sequence for the TML and
 * Compass new-project import dialogs.
 */
export function completeImportToSingleView(dialogName: string, ui: ImportDialogUi): void {
  trackDialogComplete(dialogName);
  ui.closeDialog();
  ui.setView('single');
  ui.triggerFitToBounds();
}

/**
 * Handle the deferred-save partial-success case shared by the TML and Compass
 * import dialogs: when a new-project import couldn't be saved to disk, it lives
 * only in memory. Close the dialog, return to the fitted view, and surface the
 * "save manually" warning - returning true so the caller bails before the
 * orphan-placement step. Returns false (and does nothing) for a fully-saved
 * import, even one carrying routine per-shot validation warnings. (#110)
 */
export function finalizeDeferredSaveWarnings(
  warnings: ValidationWarning[] | undefined,
  dialogName: string,
  ui: ImportDialogUi,
): boolean {
  const saveWarnings = deferredSaveWarnings(warnings);
  if (saveWarnings.length === 0) return false;
  completeImportToSingleView(dialogName, ui);
  surfaceImportWarnings(saveWarnings, ui.openDialog);
  return true;
}
