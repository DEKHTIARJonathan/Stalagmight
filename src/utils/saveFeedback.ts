import { useProjectStore } from '../store/projectStore';

/**
 * Surface a failed (non-throwing) save to the user.
 *
 * A save refused because the project has unresolvable cross-references is NOT an
 * error — it's an integrity problem the user can fix. Route them straight to the
 * Review & Repair dialog instead of a scary "Save Failed" error window. Any other
 * failure (e.g. a real I/O error) shows the error dialog as before.
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
  if (error) {
    openDialog('error', { message: error, title: 'Save Failed' });
  }
}
