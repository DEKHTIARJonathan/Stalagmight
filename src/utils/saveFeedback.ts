import { useProjectStore } from '../store/projectStore';
import { isPermissionError } from './saveErrors';
import { trackDialogComplete } from './telemetry';
import { getErrorMessage } from './ipc';
import i18n from '../i18n';
import type { ValidationWarning } from '../types/ipc/ValidationWarning';
import type { ImportReceipt } from '../types/ipc/ImportReceipt';

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
 * failure, so it is current by the time this runs. On an IPC-transport reject
 * that re-check never ran, so `integritySaveBlocked` may be stale - pass
 * `skipIntegrityRouting` there to go straight to the error dialog instead of
 * wrongly opening Review & Repair. `title` overrides the dialog title (e.g.
 * "Detach Failed") without leaving the router.
 */
export function surfaceSaveFailure(
  error: string | null | undefined,
  openDialog: (dialog: string, data?: Record<string, unknown>) => void,
  opts?: { skipIntegrityRouting?: boolean; title?: string },
): void {
  if (!opts?.skipIntegrityRouting && useProjectStore.getState().integritySaveBlocked) {
    useProjectStore.getState().openIntegrityDialog();
    return;
  }
  if (error && !isPermissionError(error)) {
    openDialog('error', {
      message: error,
      title: opts?.title ?? i18n.t('dialogs.saveFailure.title'),
    });
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

/** The UI store actions a new-project import dialog uses to finish: close the
 *  dialog, return to the fitted single-system view, and surface follow-ups. */
export interface ImportDialogUi {
  closeDialog: () => void;
  setView: (view: 'single') => void;
  triggerFitToBounds: () => void;
  openDialog: (dialog: string, data?: Record<string, unknown>) => void;
}

/**
 * A failed import, classified by where it failed:
 * - `command`: the backend returned `success: false` - the dialog's work is
 *   over, so it closes via the shared exit sequence before the error dialog.
 * - `empty`: the backend succeeded but imported nothing (e.g. a `.wpj` whose
 *   `.srv` files are missing) - closes the dialog and says why, because a
 *   silent "success" with an empty map reads as breakage.
 * - `transport`: the IPC call itself threw - unlike `command`, the shared
 *   exit sequence does NOT run (no dialog-complete telemetry, no view switch);
 *   the error dialog takes the single dialog slot, so dismissing it returns
 *   the user to where they were. `format` names the source format in the
 *   fallback message.
 */
export type ImportFailure =
  | { phase: 'command'; error: string | null | undefined }
  | { phase: 'empty'; message: string }
  | { phase: 'transport'; error: unknown; format: string };

/**
 * The one router for the TML/Compass/Walls/GPX import dialogs' failure paths
 * (docs/notifications.md) - bespoke `openDialog('error', ...)` calls in import
 * dialogs are a policy defect.
 */
export function surfaceImportFailure(
  dialogName: string,
  ui: ImportDialogUi,
  failure: ImportFailure,
): void {
  switch (failure.phase) {
    case 'transport':
      ui.openDialog('error', {
        title: i18n.t('dialogs.importFailure.transportTitle'),
        message: getErrorMessage(
          failure.error,
          i18n.t('dialogs.importFailure.transportFallback', { format: failure.format }),
        ),
      });
      return;
    case 'empty':
      trackDialogComplete(dialogName);
      ui.closeDialog();
      ui.openDialog('error', {
        title: i18n.t('dialogs.importFailure.emptyTitle'),
        message: failure.message,
      });
      return;
    case 'command':
      completeImportToSingleView(dialogName, ui);
      ui.openDialog('error', {
        title: i18n.t('dialogs.importFailure.commandTitle'),
        message: failure.error ?? i18n.t('dialogs.importFailure.unknown'),
      });
  }
}

/**
 * Close the import dialog and return to the fitted single-system view, stamping
 * the dialog-complete telemetry event first. Shared exit sequence for the TML,
 * Compass, Walls and GPX new-project import dialogs.
 *
 * When `receipt` is present (a successful import that produced one), opens the
 * post-import receipt dialog (#391) right after so the user sees what landed
 * without having to open the data table.
 */
export function completeImportToSingleView(
  dialogName: string,
  ui: ImportDialogUi,
  receipt?: ImportReceipt,
): void {
  trackDialogComplete(dialogName);
  ui.closeDialog();
  ui.setView('single');
  ui.triggerFitToBounds();
  if (receipt) {
    ui.openDialog('import-receipt', { receipt });
  }
}

/**
 * Handle the deferred-save partial-success case shared by the import dialogs:
 * when a new-project import couldn't be saved to disk, it lives only in
 * memory. Close the dialog, return to the fitted view, and surface the "save
 * manually" warning as the LEADING row of the import receipt ("unsaved"
 * outranks format caveats) - returning true so the caller bails before the
 * orphan-placement step. Returns false (and does nothing) for a fully-saved
 * import, even one carrying routine per-shot validation warnings. (#110)
 *
 * Every import command attaches a receipt on success, so the no-receipt
 * fallback (a plain warning dialog) is defensive only.
 */
export function finalizeDeferredSaveWarnings(
  warnings: ValidationWarning[] | undefined,
  dialogName: string,
  ui: ImportDialogUi,
  receipt?: ImportReceipt,
): boolean {
  const saveWarnings = deferredSaveWarnings(warnings);
  if (saveWarnings.length === 0) return false;
  const messages = saveWarnings.map((w) => w.message);
  if (receipt) {
    completeImportToSingleView(dialogName, ui, {
      ...receipt,
      warnings: [...messages, ...receipt.warnings],
    });
  } else {
    completeImportToSingleView(dialogName, ui);
    ui.openDialog('error', {
      title: i18n.t('dialogs.importFailure.deferredSaveTitle'),
      message: messages.join('\n\n'),
      hideReportHint: true,
    });
  }
  return true;
}
