import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common/Button';
import { AlertDialog } from './AlertDialog';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useRevertRevision } from '../../hooks/useRevertRevision';

/**
 * Revert-to-revision confirm, opened from the revision history of a READ-ONLY
 * project with `{ projectId, projectName, hexsha, shortSha, message, returnTo? }`.
 *
 * Where Restore hands you an un-pushed working copy and expects you to push it,
 * Revert is the whole round trip: take the write lock, check the revision out,
 * upload it, release the lock again. The project is read-only when it finishes,
 * exactly as it was when it started - which is what makes it the right offer for
 * someone who never held the lock and does not want to.
 *
 * The destructive route (replacing un-pushed local work) reuses `SpeleoRestoreDialog`'s
 * armed two-press shape, including parking focus on Cancel the moment it appears.
 */
export default function SpeleoRevertDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const isDirty = useProjectStore((s) => s.isDirty);
  const revertRevision = useRevertRevision();

  const projectId = typeof dialogData.projectId === 'string' ? dialogData.projectId : '';
  const projectName = typeof dialogData.projectName === 'string' ? dialogData.projectName : '';
  const hexsha = typeof dialogData.hexsha === 'string' ? dialogData.hexsha : '';
  const shortSha =
    typeof dialogData.shortSha === 'string' ? dialogData.shortSha : hexsha.slice(0, 8);
  // The revision history lives INSIDE another dialog, and the single `activeDialog`
  // slot means opening this one evicted it. Put the user back where they pressed the
  // button rather than on a bare map.
  const returnTo = typeof dialogData.returnTo === 'string' ? dialogData.returnTo : null;

  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'locking' | 'restoring' | 'pushing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the revert cannot proceed without replacing un-pushed local work -
  // either refused up front (before any lock was taken) or by the backend mid-flight.
  const [needsDiscard, setNeedsDiscard] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);
  // True when the failure left us holding a lock we did not have before, so the
  // dialog can say so instead of leaving the user to discover it from the toolbar.
  const [lockHeld, setLockHeld] = useState(false);
  const [message, setMessage] = useState(() =>
    t('speleodb.revert.commitMessage', { sha: hexsha.slice(0, 8) }),
  );

  // React reconciles the swapped-in discard control into the same slot as the primary
  // Revert button, so it inherits that button's FOCUS - which would let two more
  // Enters (arm, then confirm) replace un-pushed survey work the user never looked at.
  // Park focus on Cancel the moment the destructive route appears.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (needsDiscard) cancelRef.current?.focus();
  }, [needsDiscard]);

  const dismiss = () => {
    if (returnTo) openDialog(returnTo);
    else closeDialog();
  };

  const run = async (discardLocal: boolean) => {
    if (!projectId || !hexsha) return;
    setBusy(true);
    setError(null);
    const outcome = await revertRevision({
      projectId,
      projectName,
      hexsha,
      shortSha,
      message: message.trim() || null,
      discardLocal,
      onStep: setStep,
    });
    setStep(null);
    switch (outcome.kind) {
      case 'reverted':
        dismiss();
        return;
      case 'diverged':
        // The remote moved on: the divergence dialog has already taken the dialog
        // slot from us. Touching it here would tear down the prompt that replaced us.
        return;
      case 'needs_discard':
        setNeedsDiscard(true);
        setLockHeld(outcome.lockHeld);
        setBusy(false);
        return;
      case 'locked_by':
        setError(
          t('speleodb.revert.errors.locked', {
            email: outcome.email ?? t('speleodb.editBar.someone'),
          }),
        );
        setBusy(false);
        return;
      case 'lock_failed':
        setError(t('speleodb.revert.errors.lockFailed'));
        setBusy(false);
        return;
      case 'restore_failed':
        setError(
          `${outcome.message}. ${
            outcome.lockHeld
              ? t('speleodb.revert.errors.restoreFailedLockHeld')
              : t('speleodb.revert.errors.restoreFailed')
          }`,
        );
        setBusy(false);
        return;
      case 'push_failed':
        // The revision IS in the working copy and the lock IS still held - the
        // #260 banner's Retry is the way on, so stay open and say that.
        setError(t('speleodb.revert.errors.pushFailed', { sha: shortSha }));
        setBusy(false);
        return;
      case 'not_editing':
        // Same dead end, different footing: the session was dropped mid-flight, so
        // there is no held lock and the banner's Retry cannot work. Saying "you are
        // holding the write lock" here - as pushFailed does - would send the user
        // at a button that fails.
        setError(t('speleodb.revert.errors.notEditing', { sha: shortSha }));
        setBusy(false);
        return;
      case 'push_unconfirmed':
        setError(t('speleodb.revert.errors.pushUnconfirmed'));
        setBusy(false);
        return;
    }
  };

  return (
    <AlertDialog
      open
      title={t('speleodb.revert.title', { sha: shortSha })}
      onClose={() => {
        if (!busy) dismiss();
      }}
      data-testid="speleodb-revert-dialog"
      actions={
        <>
          {/* Once the destructive route is on offer, Cancel is the safe landing spot
              for the focus heuristic and for a stray Enter. */}
          <Button
            ref={cancelRef}
            onClick={dismiss}
            disabled={busy}
            {...(needsDiscard ? { 'data-primary-action': '' } : {})}
            data-testid="speleodb-revert-cancel"
          >
            {t('common.actions.cancel')}
          </Button>
          {needsDiscard ? (
            // A DISTINCT control, rendered only after the refusal, that still needs its
            // own arming press. The plain retry is gone: it would be refused again.
            <Button
              variant="danger"
              onClick={() => {
                if (!discardArmed) {
                  setDiscardArmed(true);
                  return;
                }
                void run(true);
              }}
              disabled={busy}
              data-testid={
                discardArmed
                  ? 'speleodb-revert-discard-confirm-btn'
                  : 'speleodb-revert-discard-offer-btn'
              }
            >
              {busy
                ? t('speleodb.revert.reverting')
                : discardArmed
                  ? t('speleodb.revert.discardConfirm')
                  : t('speleodb.revert.discardOffer')}
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() => void run(false)}
              disabled={busy}
              data-primary-action=""
              data-testid="speleodb-revert-confirm-btn"
            >
              {busy ? t('speleodb.revert.reverting') : t('speleodb.revert.confirmButton')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-2 text-sm text-text-secondary">
        <p>{t('speleodb.revert.body', { sha: shortSha, name: projectName })}</p>
        <p>{t('speleodb.revert.consequence')}</p>
        <div>
          <label className="block mb-1" htmlFor="speleodb-revert-message">
            {t('speleodb.revert.messageLabel')}
          </label>
          <textarea
            id="speleodb-revert-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            disabled={busy}
            className="w-full px-2 py-1 bg-background border border-border rounded text-sm"
            data-testid="speleodb-revert-message"
          />
        </div>
        {isDirty && (
          <p className="text-warning" data-testid="speleodb-revert-unsaved-warning">
            {t('speleodb.revert.unsavedWarning')}
          </p>
        )}
        {needsDiscard && (
          <p
            className="rounded border border-error bg-error-20 text-error px-3 py-2"
            role="alert"
            data-testid="speleodb-revert-discard-warning"
          >
            {t('speleodb.revert.unpushedWarning')}
          </p>
        )}
        {needsDiscard && lockHeld && (
          <p className="text-warning" data-testid="speleodb-revert-lock-held">
            {t('speleodb.revert.errors.lockStillHeld')}
          </p>
        )}
        {/* A revert is three server round trips, so name the one in flight - a single
            "Reverting…" button label leaves a stalled acquire indistinguishable from a
            stalled upload, and only one of those has left a lock behind. */}
        {step && (
          <p className="text-text-secondary" data-testid="speleodb-revert-step">
            {t(`speleodb.revert.steps.${step}`, { sha: shortSha })}
          </p>
        )}
        {error && (
          <p className="text-error" data-testid="speleodb-revert-error">
            {error}
          </p>
        )}
      </div>
    </AlertDialog>
  );
}
