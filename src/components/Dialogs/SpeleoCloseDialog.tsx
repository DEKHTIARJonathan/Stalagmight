import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { surfaceSaveFailure } from '../../utils/saveFeedback';
import { getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Close-flow guard (T2d): shown when closing a SpeleoDB project while you still
 * hold the write lock. This path bypasses the normal unsaved-changes prompt, so
 * it handles both dirty states itself:
 * - **unsaved local changes** (`projectStore.isDirty`) → a "Save changes locally"
 *   checkbox (default on) so closing can't silently drop them;
 * - **saved locally but not pushed** (`link.hasUnpushedEdits`) → a note that the
 *   work is safe on disk, it just isn't on SpeleoDB yet.
 * Then it encourages pushing + releasing the lock before leaving.
 */
export default function SpeleoCloseDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);
  const link = useSpeleoStore((s) => s.link);
  const closeProject = useProjectStore((s) => s.closeProject);
  const saveProject = useProjectStore((s) => s.saveProject);
  const isDirtyLocal = useProjectStore((s) => s.isDirty);
  const { busy, done } = useSpeleoActions();

  const sdbDirty = link?.hasUnpushedEdits ?? false;
  const [saveLocally, setSaveLocally] = useState(isDirtyLocal);
  const [saving, setSaving] = useState(false);
  const busyAny = busy || saving;

  // Persist the local .stalx first when there are unsaved changes and the user
  // left the checkbox on (so neither the push nor the close loses them). Returns
  // false when a requested save FAILED (or was cancelled) so the caller aborts and
  // the dialog stays open - closing anyway would drop the unsaved work (fix 3).
  const maybeSaveLocally = async (): Promise<boolean> => {
    if (!(isDirtyLocal && saveLocally)) return true;
    setSaving(true);
    try {
      const result = await saveProject();
      if (!result?.success) {
        // Surface WHY the save failed (integrity block -> Review & Repair, a real
        // IO error -> error dialog; a permission denial is already surfaced by
        // saveProject) instead of silently keeping this dialog open with no
        // feedback - matches every other save path (fix S4). The abort below still
        // keeps the project open so unsaved work is never dropped.
        surfaceSaveFailure(result?.error ?? null, openDialog);
        return false;
      }
      return true;
    } catch (e) {
      // A thrown save (rare - real failures resolve as {success:false}) must not be
      // treated as success; surface it and keep the project open over unsaved work.
      openDialog('error', {
        title: 'Save Failed',
        message: getErrorMessage(e, 'Failed to save project'),
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const pushReleaseThenClose = async () => {
    if (!(await maybeSaveLocally())) return;
    // done(null) pushes (when dirty) and releases the lock. Only leave once the
    // lock is actually RELEASED - a divergence / unconfirmed push keeps us here so
    // the user resolves it rather than walking away still holding the lock (fix 2).
    const resolved = await done(null);
    if (resolved?.kind === 'released') {
      closeDialog();
      await closeProject();
    }
  };

  const closeKeepingLock = async () => {
    if (!(await maybeSaveLocally())) return;
    closeDialog();
    // Explicitly retain the server lock: this is the one close path that opts out of
    // the default lock-release (fix 1), so the user keeps their editing claim.
    await closeProject({ releaseLock: false });
  };

  return (
    <DialogWrapper
      title={t('speleodb.close.title')}
      onClose={closeDialog}
      size="md"
      data-testid="speleodb-close-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {sdbDirty ? t('speleodb.close.dirtyMessage') : t('speleodb.close.message')}
        </p>

        {isDirtyLocal ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={saveLocally}
              onChange={(e) => setSaveLocally(e.target.checked)}
              className="rounded"
              data-testid="speleodb-close-save-locally"
            />
            {t('speleodb.close.saveLocally')}
          </label>
        ) : sdbDirty ? (
          <p className="text-xs text-text-secondary" data-testid="speleodb-close-saved-locally-note">
            {t('speleodb.close.savedLocallyNote')}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={closeDialog} disabled={busyAny} data-testid="speleodb-close-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void closeKeepingLock()}
            disabled={busyAny}
            data-testid="speleodb-close-keep-lock"
          >
            {t('speleodb.close.keepLock')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void pushReleaseThenClose()}
            disabled={busyAny}
            data-testid="speleodb-close-push-release"
          >
            {sdbDirty ? t('speleodb.close.pushRelease') : t('speleodb.close.release')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
