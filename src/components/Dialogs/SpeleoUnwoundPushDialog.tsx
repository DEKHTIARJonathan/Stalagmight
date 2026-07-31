import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * [#303] Raised when a push is attempted on a copy that is dirty ONLY because a chain step
 * walked it back to an older version.
 *
 * The dirty bit answers "does this differ from the server", and every push surface used to
 * read it as "you have work to save". Those agree right up until an Unwind, and then they
 * are opposites: the difference is that the copy is OLDER. Pushing it does not save
 * anyone's work - it records the old survey over the newer one for every collaborator.
 *
 * That is not hypothetical. The close prompt said "You have unpushed changes" and offered
 * "Push, release & close" as its primary action, so looking at history and then closing the
 * project published a revert in two clicks, with a reassurance underneath saying the work
 * was safe.
 *
 * So the choice is put plainly, and the safe way out is the default: discard the older copy
 * and come back at the latest, still holding the lock so the user can carry on. Pushing the
 * old version stays available - it IS how you deliberately roll a project back - but it is
 * named for what it does and it is not the primary.
 */
export default function SpeleoUnwoundPushDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);
  const showToast = useUIStore((s) => s.showToast);
  const dialogData = useUIStore((s) => s.dialogData);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);
  const refreshProjectState = useProjectStore((s) => s.refreshProjectState);
  const { done } = useSpeleoActions();

  const message = typeof dialogData.message === 'string' ? dialogData.message : null;
  const [busy, setBusy] = useState(false);

  const discardAndLock = async () => {
    setBusy(true);
    try {
      // Keeps the lock: this branch exists so the user can carry on from the latest.
      await invokeIpc('speleodb_discard_changes', { keepLock: true });
      // The backend replaced the working copy and reloaded it in place, so pull the new
      // geometry and link state in the same way the revision swap does.
      await refreshProjectState();
      useProjectStore.setState({ isDirty: false });
      await refreshLinkStatus();
      showToast(t('speleodb.unwoundPush.discardedToast'), 'speleodb-discarded', 'success');
      closeDialog();
    } catch (e) {
      openDialog('error', {
        title: t('speleodb.unwoundPush.discardFailedTitle'),
        message: getErrorMessage(e, t('speleodb.unwoundPush.discardFailedMessage')),
      });
      setBusy(false);
    }
  };

  const pushAnyway = async () => {
    setBusy(true);
    closeDialog();
    // The acknowledgement the guard in `useSpeleoActions.done` is waiting for - without it
    // this would raise this same dialog again.
    await done(message, { acceptOlderVersion: true });
  };

  return (
    <DialogWrapper
      title={t('speleodb.unwoundPush.title')}
      onClose={busy ? () => {} : closeDialog}
      size="md"
      data-testid="speleodb-unwound-push-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary" data-testid="speleodb-unwound-push-body">
          {t('speleodb.unwoundPush.body')}
        </p>
        <p className="text-sm text-error font-medium" data-testid="speleodb-unwound-push-warning">
          {t('speleodb.unwoundPush.warning')}
        </p>
        <p className="text-xs text-text-secondary">{t('speleodb.unwoundPush.discardHint')}</p>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button
            onClick={closeDialog}
            disabled={busy}
            data-testid="speleodb-unwound-push-cancel"
          >
            {t('common.actions.cancel')}
          </Button>
          {/* Not primary, and named for what it does. This is the deliberate roll-back,
              which is a real thing to want - just never the thing you want by accident. */}
          <Button
            variant="danger"
            onClick={() => void pushAnyway()}
            disabled={busy}
            data-testid="speleodb-unwound-push-push-anyway"
          >
            {t('speleodb.unwoundPush.pushAnyway')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void discardAndLock()}
            disabled={busy}
            data-primary-action=""
            data-testid="speleodb-unwound-push-discard"
          >
            {busy ? t('speleodb.unwoundPush.working') : t('speleodb.unwoundPush.discardAndLock')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
