import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertDialog } from './AlertDialog';
import { Button } from '../common/Button';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useRestoreRevision } from '../../hooks/useRestoreRevision';
import { humanizeSpeleoError } from '../../utils/speleoError';

/**
 * [#303] Confirmation for "Unwind to previous SpeleoDB version" - the one action that
 * fetches a commit's undo history back so the user can keep undoing past a commit
 * boundary.
 *
 * It exists because the action is not a plain undo step: it downloads a revision and
 * REPLACES the working copy. Two shapes, worded differently because they promise
 * different things (`isCurrent`, from `speleodb_unwind_target`):
 *
 * - **the commit the copy already equals** (the first press after a push): nothing
 *   moves. What comes back is the history that produced this state, so the user can
 *   step back through the operations they just pushed.
 * - **an ancestor**: the working copy DOES move back, and a later push lands that older
 *   content as a new forward commit (SpeleoDB exposes no server-side revert).
 *
 * The backend re-checks every precondition (lock held, no force-edit session, an empty
 * undo stack, and any dirt being a previous Unwind's own doing), so this dialog is the
 * user-facing half of the gate, never the whole of it.
 */
export default function SpeleoUnwindDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  // The same two sources the revision-history tab uses for its Restore.
  const projectId = useSpeleoStore((s) => s.remoteProjectId);
  const projectName = useProjectStore((s) => s.project?.name ?? '');
  const restoreRevision = useRestoreRevision();

  const hexsha = typeof dialogData.hexsha === 'string' ? dialogData.hexsha : '';
  const isCurrent = dialogData.isCurrent === true;
  const shortSha = hexsha.slice(0, 8);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!projectId || !hexsha) return;
    setBusy(true);
    setError(null);
    try {
      await restoreRevision({
        projectId,
        projectName,
        hexsha,
        shortSha,
        restore: true,
        // From the second step onwards the copy is dirty because the PREVIOUS step made
        // it so, and the backend only honours the waiver when its chain pointer proves
        // that. Real un-pushed work with no pointer is refused there, not here.
        discardLocal: true,
        keepUndoHistory: true,
        // The toast would say "restored to revision X. Push to make it the latest",
        // which misreads the action: nothing is being restored FORWARD, the user is
        // stepping backwards through history.
        quiet: true,
      });
      closeDialog();
    } catch (e) {
      setError(humanizeSpeleoError(e, t('speleodb.unwind.failed')));
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open
      title={t('speleodb.unwind.title')}
      onClose={() => {
        if (!busy) closeDialog();
      }}
      data-testid="speleodb-unwind-dialog"
      actions={
        <>
          <Button onClick={closeDialog} disabled={busy} data-testid="speleodb-unwind-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void run()}
            disabled={busy}
            data-primary-action=""
            data-testid="speleodb-unwind-confirm-btn"
          >
            {busy ? t('speleodb.unwind.loading') : t('speleodb.unwind.confirmButton')}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-text-secondary">
        <p data-testid="speleodb-unwind-body">
          {isCurrent
            ? t('speleodb.unwind.bodyCurrent', { sha: shortSha })
            : t('speleodb.unwind.bodyAncestor', { sha: shortSha })}
        </p>
        <p>
          {isCurrent
            ? t('speleodb.unwind.consequenceCurrent')
            : t('speleodb.unwind.consequenceAncestor')}
        </p>
        {error && (
          <p className="text-error" data-testid="speleodb-unwind-error">
            {error}
          </p>
        )}
      </div>
    </AlertDialog>
  );
}
