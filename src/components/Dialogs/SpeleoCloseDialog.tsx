import { isProjectRequestCurrent, reserveProjectRequest } from '../../utils/projectTransition';
import { confirmSpeleoFileOpen } from '../../utils/confirmSpeleoOpen';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { handBackProject } from '../../utils/quit';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/** Confirm discarding unsaved edits. Saved local work is never uploaded or deleted. */
export default function SpeleoCloseDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const busy = useSpeleoStore((s) => s.busy);
  const [operating, setOperating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pendingOpenPath = typeof dialogData.pendingOpenPath === 'string' ? dialogData.pendingOpenPath : null;
  const pendingNewProject = dialogData.pendingNewProject === true;
  const busyAny = busy || operating;
  const dismiss = () => { if (!attempt.current && !busyAny) closeDialog(); };

  const discardAndClose = async () => {
    if (attempt.current || busyAny) return;
    attempt.current = true;
    setOperating(true);
    setError(null);
    const state = useProjectStore.getState();
    const path = state.project?.file_path;
    const op = state.loading.clientOpId;
    const sessionGeneration = useSpeleoStore.getState().sessionGeneration;
    const request = reserveProjectRequest();
    const current = () => mounted.current && isProjectRequestCurrent(request) &&
      useUIStore.getState().activeDialog === 'speleodb-close' &&
      useUIStore.getState().dialogData === dialogData &&
      useProjectStore.getState().project?.file_path === path &&
      useProjectStore.getState().loading.clientOpId === op &&
      useSpeleoStore.getState().sessionGeneration === sessionGeneration;
    try {
      if (pendingOpenPath && !await confirmSpeleoFileOpen(pendingOpenPath, current)) return;
      if (!current()) return;
      await handBackProject(
        { pendingOpenPath, pendingNewProject, accessConfirmed: true, request, sessionGeneration },
        { onClosed: closeDialog, onFailure: setError },
      );
    } catch (error) {
      if (current()) setError(getErrorMessage(error));
    } finally {
      attempt.current = false;
      if (mounted.current) setOperating(false);
    }
  };

  return (
    <DialogWrapper title={t('speleodb.exit.unsavedTitle')} onClose={dismiss} size="md" data-testid="speleodb-close-dialog">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t('speleodb.exit.unsavedMessage')}</p>
        {(pendingOpenPath || pendingNewProject) && (
          <p className="text-xs text-text-secondary" data-testid="speleodb-close-pending-note">
            {pendingOpenPath ? t('speleodb.close.thenOpen') : t('speleodb.close.thenNew')}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-error" data-testid="speleodb-close-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={dismiss} disabled={busyAny} data-primary-action="" data-testid="speleodb-close-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button variant="danger" onClick={() => void discardAndClose()} disabled={busyAny} data-testid="speleodb-close-discard">
            {t('speleodb.exit.discardChanges')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
