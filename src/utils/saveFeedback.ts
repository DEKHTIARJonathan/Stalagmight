import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { isPermissionError } from './saveErrors';
import { trackDialogComplete } from './telemetry';
import { getErrorMessage } from './ipc';
import i18n from '../i18n';
import { importReceiptSummaryParts, isEmptyImportReceipt } from './importReceipt';
import { TOAST_KEYS } from './toastKeys';
import type { ValidationWarning } from '../types/ipc/ValidationWarning';
import type { ImportReceipt } from '../types/ipc/ImportReceipt';
import type { ToastKind } from '../store/uiStore';

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
  showToast: (message: string, key: string, kind: ToastKind) => void;
}

/**
 * The surface for a post-import receipt (docs/notifications.md, #411/#420): a
 * receipt with no decision in it - no warnings, and something actually
 * landed - is a toast, not a modal (there's nothing to acknowledge, just a
 * click to continue). A receipt that carries a warning, OR reports zero
 * sections and zero shots (#442 - nothing landing IS a decision the user
 * needs to see), keeps the modal.
 */
export function presentImportReceipt(
  receipt: ImportReceipt,
  ui: Pick<ImportDialogUi, 'openDialog' | 'showToast'>,
): void {
  if (receipt.warnings.length > 0 || isEmptyImportReceipt(receipt)) {
    ui.openDialog('import-receipt', { receipt });
    return;
  }
  const summary = importReceiptSummaryParts(receipt, i18n.t).join(' - ');
  ui.showToast(
    i18n.t('dialogs.importReceipt.toast', { source: receipt.source_format, summary }),
    TOAST_KEYS.IMPORT_RECEIPT,
    'success',
  );
}

/**
 * A failed import, classified by where it failed:
 * - `command`: the backend returned `success: false` - the dialog's work is
 *   over, so it closes (with its completion telemetry) before the error dialog.
 *   It does NOT run the rest of the exit sequence: `setView`/fit dropped the
 *   user into the empty project the import had just created, fitted the map to
 *   nothing, and only THEN said why (#411 C2).
 * - `empty`: the backend succeeded but imported nothing (e.g. a `.wpj` whose
 *   `.srv` files are missing) - closes the dialog and says why, because a
 *   silent "success" with an empty map reads as breakage.
 * - `transport`: the IPC call itself threw - unlike the other two, the dialog is
 *   not closed and no completion telemetry is stamped; the error dialog takes
 *   the single dialog slot, so dismissing it returns the user to where they
 *   were. `format` names the source format in the fallback message.
 */
export type ImportFailure =
  | { phase: 'command'; error: string | null | undefined }
  | { phase: 'empty'; message: string }
  | { phase: 'transport'; error: unknown; format: string };

/**
 * The user-facing message for a failed import. Exported so a dialog that reports
 * the failure on a surface of its own (TmlImportDialog's empty-project prompt,
 * which has to ask about the project the failed import created) words it exactly
 * as this router would, instead of minting a second set of strings.
 */
export function importFailureMessage(failure: ImportFailure): string {
  switch (failure.phase) {
    case 'transport':
      return getErrorMessage(
        failure.error,
        i18n.t('dialogs.importFailure.transportFallback', { format: failure.format }),
      );
    case 'empty':
      return failure.message;
    case 'command':
      return failure.error ?? i18n.t('dialogs.importFailure.unknown');
  }
}

/**
 * The one router for the TML/Compass/Walls/GPX import dialogs' failure paths
 * (docs/notifications.md) - bespoke `openDialog('error', ...)` calls in import
 * dialogs are a policy defect.
 *
 * Every caller returns straight after calling this, in every phase, so reaching
 * here ends the import flow - which is why `importContext` is dropped here too
 * (see `completeImportToSingleView` for what a stale one costs).
 */
export function surfaceImportFailure(
  dialogName: string,
  ui: ImportDialogUi,
  failure: ImportFailure,
): void {
  const message = importFailureMessage(failure);
  useUIStore.getState().setImportContext(null);
  switch (failure.phase) {
    case 'transport':
      ui.openDialog('error', {
        title: i18n.t('dialogs.importFailure.transportTitle'),
        message,
      });
      return;
    case 'empty':
      trackDialogComplete(dialogName);
      ui.closeDialog();
      ui.openDialog('error', {
        title: i18n.t('dialogs.importFailure.emptyTitle'),
        message,
      });
      return;
    case 'command':
      // Report BEFORE anything moves: no setView, no fit-to-bounds.
      trackDialogComplete(dialogName);
      ui.closeDialog();
      ui.openDialog('error', {
        title: i18n.t('dialogs.importFailure.commandTitle'),
        message,
      });
  }
}

/**
 * Close the import dialog and return to the fitted single-system view, stamping
 * the dialog-complete telemetry event first. Shared exit sequence for the TML,
 * Compass, Walls and GPX new-project import dialogs.
 *
 * When `receipt` is present (a successful import that produced one), surfaces
 * the post-import receipt (#391) right after so the user sees what landed
 * without having to open the data table - as a toast when it carries no
 * decision, or the modal when it does (#411/#420, `presentImportReceipt`).
 *
 * This is also where the import flow ENDS, so it is where `importContext` is
 * dropped. Left set, it outlives its flow: `saveAfterImport` reads it, and a
 * later import whose own route sets no context (GPX/Compass/Walls) would inherit
 * a stale 'new-project' and take the full-save branch, committing the user's
 * unrelated pending edits.
 */
export function completeImportToSingleView(
  dialogName: string,
  ui: ImportDialogUi,
  receipt?: ImportReceipt,
): void {
  trackDialogComplete(dialogName);
  useUIStore.getState().setImportContext(null);
  ui.closeDialog();
  ui.setView('single');
  ui.triggerFitToBounds();
  if (receipt) {
    presentImportReceipt(receipt, ui);
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
