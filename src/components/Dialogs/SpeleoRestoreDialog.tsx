import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common/Button';
import { AlertDialog } from './AlertDialog';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { invokeIpc } from '../../utils/ipc';
import { humanizeSpeleoError } from '../../utils/speleoError';
import type { SpeleoOpenResult } from '../../types/ipc.generated';

/**
 * [#218] Restore-revision confirm. Opened from the Project Settings revision
 * history with `{ projectId, projectName, hexsha, shortSha }`. Carries the
 * disclaimer - a git-FORWARD restore: it replaces the working copy with the chosen
 * revision as UNPUSHED edits on top of the current server state, so the project's
 * history is never rewritten and the restore only becomes the server's latest once
 * you push - plus an unsaved-changes safeguard (a restore discards local edits that
 * have not been saved/pushed). On confirm it runs `speleodb_restore_revision` then
 * reloads the project so the restored tree is what the user sees, dirty and ready to
 * push. Gated upstream on holding the lock (the history Restore button).
 */
export default function SpeleoRestoreDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const showToast = useUIStore((s) => s.showToast);
  const setView = useUIStore((s) => s.setView);
  const dialogData = useUIStore((s) => s.dialogData);
  const refreshProjectState = useProjectStore((s) => s.refreshProjectState);
  const isDirty = useProjectStore((s) => s.isDirty);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);

  const projectId = typeof dialogData.projectId === 'string' ? dialogData.projectId : '';
  const projectName = typeof dialogData.projectName === 'string' ? dialogData.projectName : '';
  const hexsha = typeof dialogData.hexsha === 'string' ? dialogData.hexsha : '';
  const shortSha =
    typeof dialogData.shortSha === 'string' ? dialogData.shortSha : hexsha.slice(0, 8);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!projectId || !hexsha) return;
    setBusy(true);
    setError(null);
    try {
      await invokeIpc<SpeleoOpenResult>('speleodb_restore_revision', {
        projectId,
        projectName,
        hexsha,
      });
      closeDialog();
      // The backend closed, overwrote, and REOPENED the project at the restored tree
      // with editing re-enabled. Pull the swapped geometry + link state into the view
      // directly - loadProject would short-circuit on the already-open project and
      // leave the old tree on screen. The on-disk copy IS the restored tree (saved),
      // so it is clean until the user edits; the push affordance comes from the link's
      // unpushed-edits bit that refreshLinkStatus re-seeds.
      setView('single');
      await refreshProjectState();
      useProjectStore.setState({ isDirty: false });
      await refreshLinkStatus();
      showToast(t('speleodb.restore.doneToast', { sha: shortSha }), 'speleodb-restore');
    } catch (e) {
      setError(humanizeSpeleoError(e, t('speleodb.restore.failed')));
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open
      title={t('speleodb.restore.title', { sha: shortSha })}
      onClose={() => {
        if (!busy) closeDialog();
      }}
      data-testid="speleodb-restore-dialog"
      actions={
        <>
          <Button onClick={closeDialog} disabled={busy} data-testid="speleodb-restore-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleConfirm()}
            disabled={busy}
            data-primary-action=""
            data-testid="speleodb-restore-confirm-btn"
          >
            {busy ? t('speleodb.restore.restoring') : t('speleodb.restore.confirmButton')}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-text-secondary">
        <p>{t('speleodb.restore.body', { sha: shortSha, name: projectName })}</p>
        <p>{t('speleodb.restore.consequence')}</p>
        {isDirty && (
          <p className="text-warning" data-testid="speleodb-restore-unsaved-warning">
            {t('speleodb.restore.unsavedWarning')}
          </p>
        )}
        {error && (
          <p className="text-error" data-testid="speleodb-restore-error">
            {error}
          </p>
        )}
      </div>
    </AlertDialog>
  );
}
