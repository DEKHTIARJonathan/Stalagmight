import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { isProjectRequestCurrent, reserveProjectRequest } from '../../utils/projectTransition';
import { getErrorMessage } from '../../utils/ipc';
import { abandonUpdateRestart, performQuit } from '../../utils/quit';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/** Quit discards only unsaved memory changes; closing releases the remote lock. */
export default function SpeleoQuitDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const busy = useSpeleoStore((s) => s.busy);
  const [operating, setOperating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(false);
  const busyAny = busy || operating;
  const dismiss = () => {
    if (attempt.current || busyAny) return;
    abandonUpdateRestart();
    if (typeof dialogData.cancelReturnsTo === 'string') {
      openDialog(dialogData.cancelReturnsTo,
        typeof dialogData.cancelReturnsData === 'object' && dialogData.cancelReturnsData !== null
          ? dialogData.cancelReturnsData as Record<string, unknown> : undefined);
    } else closeDialog();
  };

  const discardAndQuit = async () => {
    if (attempt.current || busyAny) return;
    attempt.current = true;
    setOperating(true);
    setError(null);
    const request = reserveProjectRequest();
    const generation = useSpeleoStore.getState().sessionGeneration;
    const current = () => isProjectRequestCurrent(request) &&
      useSpeleoStore.getState().sessionGeneration === generation &&
      useUIStore.getState().activeDialog === 'speleodb-quit' &&
      useUIStore.getState().dialogData === dialogData;
    try {
      // Close without saving or uploading. The backend releases the captured lock
      // and the store clears the project, so exit cannot autosave discarded edits.
      const result = await useProjectStore.getState().closeProject({ request });
      if (!current()) return;
      if (!result.success) {
        setError(result.error || 'Could not close the project. Your project is still open.');
        return;
      }
      if (useProjectStore.getState().project !== null) return;
      closeDialog();
      performQuit();
    } catch (error) {
      if (current()) setError(getErrorMessage(error));
    } finally {
      attempt.current = false;
      setOperating(false);
    }
  };

  return (
    <DialogWrapper title={t('speleodb.exit.unsavedTitle')} onClose={dismiss} size="md" data-testid="speleodb-quit-dialog">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t('speleodb.exit.unsavedMessage')}</p>
        {error && <p role="alert" className="text-sm text-error" data-testid="speleodb-quit-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={dismiss} disabled={busyAny} data-primary-action="" data-testid="speleodb-quit-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button variant="danger" onClick={() => void discardAndQuit()} disabled={busyAny} data-testid="speleodb-quit-discard">
            {t('speleodb.exit.discardChanges')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
