import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TokenStorage } from '../../types/ipc.generated';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * The tier each button is ASKING for, so "did they get what they clicked?" is one
 * comparison instead of a second copy of the vocabulary. The two names differ
 * because a request is a preference (`TokenFallback`) while the answer is a place
 * (`TokenStorage`): "this session only" is the preference whose place is memory.
 */
const STORAGE_FOR: Record<'session_only' | 'plaintext', TokenStorage> = {
  session_only: 'memory',
  plaintext: 'plaintext',
};

/**
 * "Where should your SpeleoDB API key be kept?" - raised by a login whose OS
 * keychain write failed (`needs_storage_choice`), at the moment the failure
 * happened rather than buried in Settings later.
 *
 * Asking here is what makes it answerable for free: the key is already in memory,
 * so both answers are a re-store away - no sign-out, no re-typed password. The
 * copy leads on that, because "this session only" otherwise reads as "you will
 * have to log in with your password again", and someone avoiding that
 * (non-existent) cost picks the less safe option for the wrong reason.
 *
 * An INDEPENDENT top-layer overlay (`storageChoiceOpen`), not the shared
 * `activeDialog` slot, for the reason the held-lock prompt is (#201): the login
 * that raises it is usually made from inside the Settings account panel, and
 * taking that slot would unmount Settings along with every other setting staged
 * but not yet saved.
 *
 * Dismissing without choosing is deliberately SAFE and deliberately silent: the
 * session keeps working in memory and nothing is persisted, so the next login
 * asks again. Recording a refusal for someone who pressed Escape would settle a
 * question they never answered.
 *
 * Dismissing AFTER picking an option is a different question, answered in `choose`:
 * the dismissal routes stay live while the move is in flight (see there for why
 * they must), so a failure re-raises this overlay instead of assuming it is still
 * mounted. The invariant is that a choice the user actually made never ends up both
 * unsettled and un-asked.
 */
export default function SpeleoStorageChoiceDialog() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const setTokenStorage = useSpeleoStore((s) => s.setTokenStorage);
  // Close this OVERLAY only - the shared `closeDialog` would close whatever this
  // is layered over (Settings, during an inline login).
  const closeStorageChoice = useSpeleoStore((s) => s.closeStorageChoice);
  const [busy, setBusy] = useState(false);

  const choose = async (mode: 'session_only' | 'plaintext') => {
    setBusy(true);
    try {
      // On failure the prompt STAYS OPEN. Closing it would look like the choice
      // landed while the key sits wherever the failed login left it.
      const landed = await setTokenStorage(mode);
      if (landed === null) {
        showToast(t('speleodb.storageChoice.failed'), 'speleodb-storage-choice', 'error');
        // "Stays open" has to be RE-ASSERTED, not merely left un-closed. The option
        // buttons are disabled for the length of the await above, but Escape, the
        // title-bar close and the backdrop are not - all three reach `onClose`, which
        // unmounts this overlay. A dismissal landing mid-move therefore left the
        // failure with nothing to retry in: one transient toast, no prompt, and the
        // key still wherever the failed login put it until the NEXT login asks again
        // (`storageChoiceOpen` is raised nowhere else). Re-raising here is what makes
        // the sentence above true no matter which of those happened.
        //
        // Deliberately NOT done with the `onClose={busy ? () => {} : ...}` idiom
        // SpeleoQuitDialog uses, even though the shape looks identical. There the
        // escaped dismissal drops a window's edits, and the verb it waits on is not the
        // subsystem that just failed. Here every user who sees this prompt is on a
        // machine whose keychain just failed; the move being awaited ends in a keyring
        // call on that same keychain (a session-only answer sweeps the persistent tiers,
        // and on Linux a locked keyring turns any such access into a desktop unlock
        // prompt that BLOCKS); and nothing on the path - `invokeIpc`, `spawn_blocking`,
        // keyring-rs - carries a timeout. A no-op close would turn a wedged secret
        // service into a modal with every control dead, over an app the dialog stack has
        // made inert, escapable only by killing the process. The worst case being
        // defended against here is merely an unsettled preference, which is not worth
        // that. So dismissal always works, and the retry is what comes back.
        //
        // Only while a session still holds a key. `clearSession` shuts this overlay on
        // purpose when the session ends underneath it, and that same ending is one of
        // the things that makes the move fail (the backend refuses when no token is
        // held) - re-raising there would ask where to put a key that no longer exists.
        // Same staleness guard `scanLocksOnOpen` applies before re-raising its prompt.
        if (useSpeleoStore.getState().session?.loggedIn === true) {
          useSpeleoStore.setState({ storageChoiceOpen: true });
        }
        return;
      }
      // Report the tier that TOOK the key, never the button that was pressed. Asking
      // for a file on a full or read-only filesystem falls back to session-only
      // memory, and the backend says so truthfully - so echoing `mode` here promised
      // a saved file to someone who will be signed out at the next exit and has no
      // idea why.
      //
      // The mismatch gets its OWN sentence rather than just the landed tier's,
      // because "kept for this session only" on its own, right after clicking "Save
      // it to a file", reads as the app ignoring them or as a misclick. It has to say
      // the file could not be written, or the toast is true and still useless.
      const asAsked = landed === STORAGE_FOR[mode];
      showToast(
        asAsked
          ? t(`speleodb.storageChoice.toasts.${mode}`)
          : t(`speleodb.storageChoice.landedElsewhere.${landed}`),
        'speleodb-storage-choice',
        asAsked ? 'success' : 'warning',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogWrapper
      title={t('speleodb.storageChoice.title')}
      onClose={closeStorageChoice}
      size="md"
      data-testid="speleodb-storage-choice-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-primary">{t('speleodb.storageChoice.intro')}</p>
        <p
          className="p-3 rounded bg-surface border border-border text-xs text-text-secondary"
          data-testid="speleodb-storage-choice-key-only"
        >
          {t('speleodb.storageChoice.keyOnly')}
        </p>

        <div className="space-y-3">
          <div className="p-3 rounded border border-border">
            <p className="text-sm font-medium text-text-primary">
              {t('speleodb.storageChoice.session.title')}
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              {t('speleodb.storageChoice.session.detail')}
            </p>
            <Button
              variant="primary"
              className="mt-2"
              onClick={() => void choose('session_only')}
              disabled={busy}
              data-testid="speleodb-storage-choice-session"
            >
              {t('speleodb.storageChoice.session.action')}
            </Button>
          </div>

          <div className="p-3 rounded border border-border">
            <p className="text-sm font-medium text-text-primary">
              {t('speleodb.storageChoice.file.title')}
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              {t('speleodb.storageChoice.file.detail')}
            </p>
            <Button
              className="mt-2"
              onClick={() => void choose('plaintext')}
              disabled={busy}
              data-testid="speleodb-storage-choice-file"
            >
              {t('speleodb.storageChoice.file.action')}
            </Button>
          </div>
        </div>

        <div className="flex justify-end pt-2 border-t border-border">
          <Button
            onClick={closeStorageChoice}
            disabled={busy}
            data-testid="speleodb-storage-choice-dismiss"
          >
            {t('speleodb.storageChoice.decideLater')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
