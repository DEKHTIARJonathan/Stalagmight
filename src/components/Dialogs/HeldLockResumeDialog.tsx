import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { humanizeSpeleoError } from '../../utils/speleoError';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Held-lock resume/release prompt (#201, B1). SpeleoDB has no server-side lock
 * TTL, so a crashed/abandoned session leaves its write locks held. On login /
 * app-open a single `list_projects` scan finds the locks THIS user holds; if any,
 * this prompt offers to resolve them:
 * - **Release** (per project) - `POST /projects/{id}/release/`, freeing that one
 *   lock; releasing the last one auto-closes the prompt.
 * - **Release all locks** - `DELETE /user/release_all_locks/`, freeing them all.
 * - **Keep working** - dismiss and leave the locks held (the user is still using
 *   them; the open project, if held, is already resumed into its editing state).
 * - Closing the dialog (X) is the "do nothing" exit - same as Keep working.
 */
export default function HeldLockResumeDialog() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const heldLocks = useSpeleoStore((s) => s.heldLocks);
  const releaseAllLocks = useSpeleoStore((s) => s.releaseAllLocks);
  const releaseLock = useSpeleoStore((s) => s.releaseLock);
  const clearHeldLocks = useSpeleoStore((s) => s.clearHeldLocks);
  // Close this OVERLAY only (not the shared `closeDialog`, which would close the
  // dialog this prompt is layered over - e.g. Settings during an inline login).
  const closeHeldLockPrompt = useSpeleoStore((s) => s.closeHeldLockPrompt);
  // Which project id is being released one-off, or 'all' for the Release-all path.
  const [releasing, setReleasing] = useState<string | null>(null);

  const locks = heldLocks ?? [];
  const busy = releasing !== null;

  // Auto-close once the last lock is gone - releasing them one by one shrinks
  // `heldLocks` in the store, and when it empties there is nothing left to resolve.
  useEffect(() => {
    if (locks.length === 0) closeHeldLockPrompt();
  }, [locks.length, closeHeldLockPrompt]);

  // Keep / Do-nothing: leave the locks held and just dismiss the prompt.
  const keep = () => {
    clearHeldLocks();
    closeHeldLockPrompt();
  };

  const releaseAll = async () => {
    setReleasing('all');
    try {
      await releaseAllLocks();
      closeHeldLockPrompt();
    } catch (e) {
      // Release failed: keep the prompt open so the user can retry.
      showToast(
        humanizeSpeleoError(e, t('speleodb.heldLocks.releaseFailed')),
        'speleodb-release-all-error',
      );
    } finally {
      setReleasing(null);
    }
  };

  const releaseOne = async (projectId: string) => {
    setReleasing(projectId);
    try {
      // On success the store drops this lock from `heldLocks`; the effect above
      // closes the dialog when the last one goes.
      await releaseLock(projectId);
    } catch (e) {
      showToast(
        humanizeSpeleoError(e, t('speleodb.heldLocks.releaseFailed')),
        'speleodb-release-one-error',
      );
    } finally {
      setReleasing(null);
    }
  };

  return (
    <DialogWrapper
      title={t('speleodb.heldLocks.title')}
      onClose={keep}
      size="md"
      data-testid="speleodb-held-lock-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {t('speleodb.heldLocks.description', { count: locks.length })}
        </p>

        <ul className="max-h-40 overflow-y-auto rounded border border-border divide-y divide-border">
          {locks.map((lock) => (
            <li
              key={lock.projectId}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-text-primary"
              data-testid={`speleodb-held-lock-${lock.projectId}`}
            >
              <span className="min-w-0 truncate">{lock.projectName}</span>
              <button
                type="button"
                onClick={() => void releaseOne(lock.projectId)}
                disabled={busy}
                className="shrink-0 text-xs text-danger hover:underline disabled:opacity-50 disabled:no-underline"
                aria-label={t('speleodb.heldLocks.releaseOneAria', { name: lock.projectName })}
                data-testid={`speleodb-held-lock-release-${lock.projectId}`}
              >
                {releasing === lock.projectId
                  ? t('speleodb.heldLocks.releasing')
                  : t('speleodb.heldLocks.release')}
              </button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={keep} disabled={busy} data-testid="speleodb-held-lock-keep">
            {t('speleodb.heldLocks.keep')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void releaseAll()}
            disabled={busy}
            data-testid="speleodb-held-lock-release-all"
          >
            {releasing === 'all'
              ? t('speleodb.heldLocks.releasing')
              : t('speleodb.heldLocks.releaseAll')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
