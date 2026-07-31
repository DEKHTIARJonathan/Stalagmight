import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore, isUnwoundNotEdited } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * [#303] Confirmation for the explicit "Discard changes" action.
 *
 * Throwing the local copy away is one decision; what happens to the write lock afterwards
 * is a separate one, and neither answer is the odd one out. Someone resetting to start
 * again wants to KEEP editing; someone abandoning a session wants to hand the project back
 * so a colleague can pick it up. Folding the two together - as an action called "discard
 * and lock" did - forces the second user to discard and then go hunting for Release.
 *
 * The wording branches on whether there is anything of the user's to lose. Telling someone
 * "your changes will be lost" when all they did was step back through history is how the
 * close prompt got this wrong in the first place, just pointed the other way.
 */
export default function SpeleoDiscardChangesDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);
  const showToast = useUIStore((s) => s.showToast);
  const link = useSpeleoStore((s) => s.link);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);
  const refreshProjectState = useProjectStore((s) => s.refreshProjectState);

  const unwound = isUnwoundNotEdited(link);
  const [busy, setBusy] = useState(false);

  const run = async (keepLock: boolean) => {
    setBusy(true);
    try {
      await invokeIpc('speleodb_discard_changes', { keepLock });
      // The backend replaced the working copy and reloaded it in place; pull the new
      // geometry and link state in, the same way the revision swap does.
      await refreshProjectState();
      useProjectStore.setState({ isDirty: false });
      await refreshLinkStatus();
      showToast(
        keepLock
          ? t('speleodb.discardChanges.doneKeptToast')
          : t('speleodb.discardChanges.doneReleasedToast'),
        'speleodb-discarded',
        'success',
      );
      closeDialog();
    } catch (e) {
      openDialog('error', {
        title: t('speleodb.discardChanges.failedTitle'),
        message: getErrorMessage(e, t('speleodb.discardChanges.failedMessage')),
      });
      setBusy(false);
    }
  };

  return (
    <DialogWrapper
      title={t('speleodb.discardChanges.title')}
      onClose={busy ? () => {} : closeDialog}
      size="md"
      data-testid="speleodb-discard-changes-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary" data-testid="speleodb-discard-changes-body">
          {unwound
            ? t('speleodb.discardChanges.bodyUnwound')
            : t('speleodb.discardChanges.bodyEdited')}
        </p>
        <p className="text-xs text-text-secondary">{t('speleodb.discardChanges.lockQuestion')}</p>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button
            onClick={closeDialog}
            disabled={busy}
            data-testid="speleodb-discard-changes-cancel"
          >
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void run(false)}
            disabled={busy}
            data-testid="speleodb-discard-changes-release"
          >
            {t('speleodb.discardChanges.discardAndRelease')}
          </Button>
          {/* Primary because it is the reversible one: still holding the lock, the user can
              release at any time, whereas a released lock is a colleague's to take. */}
          <Button
            variant="primary"
            onClick={() => void run(true)}
            disabled={busy}
            data-primary-action=""
            data-testid="speleodb-discard-changes-keep"
          >
            {busy
              ? t('speleodb.discardChanges.working')
              : t('speleodb.discardChanges.discardAndKeep')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
