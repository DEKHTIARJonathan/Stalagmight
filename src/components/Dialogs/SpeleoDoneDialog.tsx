import { permissionAtLeast } from '../../utils/speleoPermission';
import { captureUploadOwner, getUploadContinuation, setUploadContinuation, uploadOwnerStillCurrent } from '../../utils/uploadContinuation';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { getErrorMessage } from '../../utils/ipc';
import { surfaceSaveFailure } from '../../utils/saveFeedback';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { SpeleoPushFailureNotice } from './SpeleoPushFailureNotice';
import { SpeleoProgressOverlay } from './SpeleoProgressOverlay';
import { CommitMessageLimit } from './CommitMessageLimit';
import { commitMessageTooLong } from '../../utils/commitMessage';

/**
 * Commit-message confirm for the action shell (#204), in two modes read off
 * `dialogData.mode`:
 * - **release** (default): `speleodb_done` - render + VACUUM snapshot + push +
 *   release the lock, returning to read-only.
 * - **push** (T2d, fix 8): `speleodb_push` - the same push WITHOUT releasing the
 *   lock, so editing continues.
 *
 * Both collect a required message when uploading changes then route through `useSpeleoActions`. Closes
 * only when the verb actually LANDED (released / pushed). A `divergence_needed`
 * keeps the dialog's typed message alive and lets the App-level effect open the
 * resolution dialog over it (fix 3); a `push_unconfirmed` keeps it open for a retry
 * (the #200 banner surfaces the ambiguity); a thrown (network) error likewise keeps
 * it open so the message and a retry survive.
 *
 * [#260] A thrown error is ALSO rendered INLINE here (`SpeleoPushFailureNotice`):
 * the shell's push-failure banner sits behind this dialog's modal scrim, so it was
 * unreadable and unclickable exactly when it mattered. The retry is this dialog's
 * own primary button; the standalone banner takes over only once the dialog is
 * dismissed with the failure unresolved.
 */
export default function SpeleoDoneDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const mode = dialogData.mode === 'push' ? 'push' : 'release';
  const { busy, push, done, startEditing } = useSpeleoActions();
  const path = useProjectStore((s) => s.project?.file_path);
  const [owner] = useState(captureUploadOwner);
  const sessionGeneration = useSpeleoStore((s) => s.sessionGeneration);
  const projectGeneration = useProjectStore((s) => s.projectTreeGeneration);
  const ownerCurrent = uploadOwnerStillCurrent(owner);
  const closeAfterSave = dialogData.closeAfterSave === true;
  const [message, setMessage] = useState(() => getUploadContinuation(path)?.message ?? '');
  useEffect(() => {
    if (!ownerCurrent) {
      if (useUIStore.getState().activeDialog === 'speleodb-done' && useUIStore.getState().dialogData === dialogData) closeDialog();
      return;
    }
    if (path) setUploadContinuation({ path, message, closeAfterSave }, owner);
  }, [path, message, closeAfterSave, owner, ownerCurrent, sessionGeneration, projectGeneration, dialogData, closeDialog]);
  const link = useSpeleoStore((s) => s.link);
  const loggedIn = useSpeleoStore((s) => s.session?.loggedIn);
  const uploadAllowed = link?.editState === 'editing' && !link.noAccess && loggedIn === true && permissionAtLeast(link.permission, 'READ_AND_WRITE');
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgressExpired, setUploadProgressExpired] = useState(false);
  useEffect(() => {
    if (!uploading) return;
    const timer = window.setTimeout(() => setUploadProgressExpired(true), 120_000);
    return () => window.clearTimeout(timer);
  }, [uploading]);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const attempt = useRef(false);
  const busyAny = busy || submitting;
  const canDismiss = !busyAny || (uploading && uploadProgressExpired);
  const unpushed = useSpeleoStore((s) => s.link?.hasUnpushedEdits);
  const unsaved = useProjectStore((s) => s.isDirty);
  const needsMessage = mode === 'push' || unpushed || unsaved;
  // sdk#2: a description SpeleoDB cannot store is never sent (the backend refuses it too).
  const messageTooLong = commitMessageTooLong(message);
  const dismiss = () => { if (!uploading) setUploadContinuation(null); closeDialog(); };

  const handleConfirm = async () => {
    const text = message.trim();
    if (!uploadOwnerStillCurrent(owner) || attempt.current || busy || !uploadAllowed || (needsMessage && !text) || messageTooLong) return;
    attempt.current = true;
    setSubmitting(true);
    setSaveFailure(null);
    const state = useProjectStore.getState();
    const path = state.project?.file_path;
    const op = state.loading.clientOpId;
    const generation = useSpeleoStore.getState().sessionGeneration;
    const current = () => uploadOwnerStillCurrent(owner) && useProjectStore.getState().project?.file_path === path &&
      useProjectStore.getState().loading.clientOpId === op &&
      useSpeleoStore.getState().sessionGeneration === generation &&
      useUIStore.getState().activeDialog === 'speleodb-done' &&
      useUIStore.getState().dialogData === dialogData;
    try {
      if (mode === 'push') {
        let saved;
        try { saved = await state.saveProject(); }
        catch (error) {
          if (current()) surfaceSaveFailure(getErrorMessage(error), useUIStore.getState().openDialog);
          return;
        }
        if (!current()) return;
        if (!saved?.success || saved.unlinked_copy_path) {
          surfaceSaveFailure(saved?.error ?? 'Could not save the linked project', useUIStore.getState().openDialog);
          return;
        }
        setUploadProgressExpired(false);
        setUploading(true);
        const resolved = closeAfterSave ? await done(text, { isCurrent: current, pendingExit: { kind: 'close', sessionGeneration: generation } }) : await push(text, { isCurrent: current });
        setUploading(false);
        if (!current()) return;
        if (resolved?.kind === 'released' && closeAfterSave) {
          const latest = useProjectStore.getState();
          if (latest.isDirty || useSpeleoStore.getState().link?.hasUnpushedEdits) {
            setSaveFailure('Newer changes remain on this computer. The project stays open.');
            return;
          }
          const treeGeneration = latest.projectTreeGeneration;
          const closeCurrent = () => current() &&
            useProjectStore.getState().projectTreeGeneration === treeGeneration &&
            !useProjectStore.getState().isDirty && !useSpeleoStore.getState().link?.hasUnpushedEdits;
          const closed = await latest.closeProject({ isCurrent: closeCurrent });
          if (closed.success) {
            const ui = useUIStore.getState();
            if (!useProjectStore.getState().project &&
                useSpeleoStore.getState().sessionGeneration === generation &&
                ui.activeDialog === 'speleodb-done' && ui.dialogData === dialogData) {
              setUploadContinuation(null); closeDialog(); ui.setView('global');
            }
          } else if (current()) setSaveFailure(closed.error ?? 'Could not close project');
        } else if (resolved?.kind === 'pushed') { setUploadContinuation(null); closeDialog(); }
        else if (useSpeleoStore.getState().banner?.kind === 'push_failed') setSaveFailure(null);
        else setSaveFailure(resolved === null || resolved.kind === 'push_unconfirmed'
          ? 'Saved locally; upload could not be confirmed.'
          : 'Saved locally, but not uploaded to SpeleoDB.');
      } else {
        if (unpushed || unsaved) {
          setUploadProgressExpired(false);
          setUploading(true);
        }
        const resolved = await done(text, { isCurrent: current });
        setUploading(false);
        if (current() && resolved?.kind === 'released') closeDialog();
      }
    } finally { attempt.current = false; setUploading(false); setSubmitting(false); }
  };

  if (!ownerCurrent) return null;

  return (
    <>
    <DialogWrapper
      title={mode === 'push' ? t('speleodb.done.pushTitle') : t('speleodb.done.title')}
      onClose={canDismiss ? dismiss : () => {}}
      size="md"
      data-testid="speleodb-done-dialog"
      data-mode={mode}
    >
      <div className="space-y-4">
        {uploading && uploadProgressExpired && <p role="alert" className="text-sm text-warning" data-testid="speleodb-upload-timeout">
          Upload has taken more than 120 seconds. It may still finish. Close this dialog to continue working.
        </p>}
        {!uploadAllowed && <div className="space-y-3" data-testid="speleodb-upload-blocked">
          <p role="status">Upload requires sign-in, write permission and the editing lock. Your work remains on this computer.</p>
          {!loggedIn ? <Button onClick={() => useUIStore.getState().openDialog('settings', { initialCategory: 'speleodb' })} data-testid="speleodb-upload-sign-in">Sign in in Settings</Button> : <Button onClick={() => void startEditing()} disabled={busyAny || link?.noAccess} data-testid="speleodb-upload-resume">Resume editing</Button>}
        </div>}
        <p className="text-sm text-text-secondary">
          {mode === 'push' ? t('speleodb.done.pushDescription') : t('speleodb.done.description')}
        </p>
        <div>
          <label htmlFor="speleodb-done-message" className="block text-sm text-text-secondary mb-1">
            {t('speleodb.done.messageLabel')}
          </label>
          <textarea
            id="speleodb-done-message"
            disabled={busyAny}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            rows={3}
            className="w-full px-2 py-1 bg-background border border-border rounded text-sm"
            placeholder={t('speleodb.done.messagePlaceholder')}
            data-testid="speleodb-done-message"
            aria-describedby="speleodb-done-message-limit"
          />
          <CommitMessageLimit message={message} id="speleodb-done-message-limit" testIdPrefix="speleodb-done-message" />
        </div>
        {/* #260: the failure of the LAST attempt, right above the button that made
            it - the shell banner is unreachable behind this dialog's scrim. The
            same button below is the retry; re-pressing it clears this first. */}
        {saveFailure && <p role="alert" data-testid="speleodb-save-upload-failure">{saveFailure}</p>}
        <SpeleoPushFailureNotice />
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={dismiss} disabled={!canDismiss} data-testid="speleodb-done-cancel">
            {uploading && uploadProgressExpired ? t('common.actions.close') : t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            disabled={busyAny || !uploadAllowed || (needsMessage && !message.trim()) || messageTooLong}
            data-testid="speleodb-done-confirm"
          >
            {busyAny
              ? t('speleodb.done.pushing')
              : mode === 'push'
                ? t('speleodb.done.pushConfirm')
                : t('speleodb.done.confirm')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
    {uploading && !uploadProgressExpired && <SpeleoProgressOverlay
      title="Saving changes to SpeleoDB" description="Uploading your survey's latest version." testId="speleodb-upload-progress" />}
    </>
  );
}
