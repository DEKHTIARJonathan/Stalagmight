import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type HeldLock } from '../../store/speleoStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { useSpeleoLocalStates } from '../../hooks/useSpeleoLocalStates';
import { hasUnpushedEdits, UNPUSHED_ACCENT } from '../../utils/speleoLocalState';
import { humanizeSpeleoError } from '../../utils/speleoError';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Held-lock resume/release prompt (#201, B1). SpeleoDB has no server-side lock
 * TTL, so a crashed/abandoned session leaves its write locks held. On login /
 * app-open a single `list_projects` scan finds the locks THIS user holds; if any,
 * this prompt offers to resolve them.
 *
 * That scan is server-only, so on its own it cannot tell a lock over an abandoned
 * empty session from a lock over hours of work that never reached the server.
 * #270 joins in the LOCAL half (`speleodb_local_project_states`, one call for every
 * listed id) and lets it pick the row's action:
 * - **no un-pushed edits** -> **Release** (`POST /projects/{id}/release/`), as before;
 *   releasing the last one auto-closes the prompt.
 * - **un-pushed edits** -> **Continue editing** INSTEAD: open that project and keep
 *   the lock (`speleodb_start_editing`, the app's open-and-hold verb). Release is not
 *   offered at all for such a row - it is the one action that would strand the work
 *   behind a lock the user no longer holds.
 *
 * Dialog-wide:
 * - **Keep working** - dismiss and leave the locks held.
 *
 * There is deliberately NO bulk release. The server verb is all-or-nothing and this
 * prompt is exactly where locks sitting over un-pushed work show up, so a single
 * button that frees every lock is the one action most likely to strand the work the
 * per-row rules exist to protect. Releasing is per project, and only where there is
 * nothing local to lose.
 * - Closing the dialog (X) is the "do nothing" exit - same as Keep working.
 */
export default function HeldLockResumeDialog() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const heldLocks = useSpeleoStore((s) => s.heldLocks);
  const releaseLock = useSpeleoStore((s) => s.releaseLock);
  const clearHeldLocks = useSpeleoStore((s) => s.clearHeldLocks);
  // Close this OVERLAY only (not the shared `closeDialog`, which would close the
  // dialog this prompt is layered over - e.g. Settings during an inline login).
  const closeHeldLockPrompt = useSpeleoStore((s) => s.closeHeldLockPrompt);
  const recentProjects = useProjectStore((s) => s.recentProjects);
  const loadProject = useProjectStore((s) => s.loadProject);
  const { startEditing } = useSpeleoActions();
  // Which project id is being acted on, or 'all' for the Release-all path.
  const [busyId, setBusyId] = useState<string | null>(null);

  const locks = useMemo(() => heldLocks ?? [], [heldLocks]);
  const busy = busyId !== null;

  // The local half of the join, fetched once for every listed lock (#270).
  const lockIds = useMemo(() => locks.map((l) => l.projectId), [locks]);
  const { states, failed } = useSpeleoLocalStates(lockIds);

  // A row's action is "Continue editing" only on a POSITIVE local-edit report. While
  // the call is in flight, or after it failed, nothing is claimed either way and the
  // row keeps its Release - the `failed` note below says so rather than implying the
  // project is known to be clean.
  const dirty = (projectId: string) => hasUnpushedEdits(states, projectId);

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



  const releaseOne = async (projectId: string) => {
    setBusyId(projectId);
    try {
      // On success the store drops this lock from `heldLocks`; the effect above
      // closes the dialog when the last one goes.
      await releaseLock(projectId);
    } catch (e) {
      showToast(
        humanizeSpeleoError(e, t('speleodb.heldLocks.releaseFailed')),
        'speleodb-release-one-error',
        'error',
      );
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Resume the session this lock belongs to: open the project (unless it already is
   * the open one) and re-acquire, keeping the lock. `speleodb_start_editing` is the
   * app's open-and-hold verb and acts on the OPEN project, so the load comes first.
   * Re-acquiring a lock we already hold is a no-op server-side - the acquire simply
   * succeeds (only ANOTHER holder produces the 400 that reports contention) - and the
   * reconcile that follows is exactly what a resumed session needs.
   */
  const continueEditing = async (lock: HeldLock) => {
    setBusyId(lock.projectId);
    try {
      if (states[lock.projectId]?.is_open !== true) {
        const path = recentProjects.find(
          (p) => p.speleodb_project_id === lock.projectId,
        )?.file_path;
        if (path === undefined) {
          // A local copy exists (that is why this row offers Continue editing) but we
          // cannot name its file. Say so and change nothing - releasing the lock here
          // is exactly the outcome this row exists to prevent.
          showToast(
            t('speleodb.localEdits.heldLocks.openFailed', { name: lock.projectName }),
            'speleodb-continue-editing-error',
            'warning',
          );
          return;
        }
        const result = await loadProject(path);
        // loadProject surfaces its own failure; leave the prompt up so the lock is
        // still resolvable.
        if (!result.success) return;
      }
      // Acquire + reconcile, with its own toasts / divergence routing.
      await startEditing();
      // The lock stays held on purpose: hand the shell over to the project.
      clearHeldLocks();
      closeHeldLockPrompt();
    } finally {
      setBusyId(null);
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
          {locks.map((lock) => {
            const hasEdits = dirty(lock.projectId);
            return (
              <li
                key={lock.projectId}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-text-primary"
                data-testid={`speleodb-held-lock-${lock.projectId}`}
                data-local-edits={hasEdits ? 'true' : 'false'}
              >
                <span className="min-w-0 truncate">
                  {lock.projectName}
                  {hasEdits && (
                    <span
                      className="block text-xs"
                      style={{ color: UNPUSHED_ACCENT }}
                      data-testid={`speleodb-held-lock-local-edits-${lock.projectId}`}
                    >
                      {t('speleodb.localEdits.heldLocks.hasLocalChanges')}
                    </span>
                  )}
                </span>
                {hasEdits ? (
                  <button
                    type="button"
                    onClick={() => void continueEditing(lock)}
                    disabled={busy}
                    className="shrink-0 text-xs text-accent hover:underline disabled:opacity-50 disabled:no-underline"
                    aria-label={t('speleodb.localEdits.heldLocks.continueEditingAria', {
                      name: lock.projectName,
                    })}
                    data-testid={`speleodb-held-lock-continue-${lock.projectId}`}
                  >
                    {busyId === lock.projectId
                      ? t('speleodb.localEdits.heldLocks.opening')
                      : t('speleodb.localEdits.heldLocks.continueEditing')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void releaseOne(lock.projectId)}
                    disabled={busy}
                    className="shrink-0 text-xs text-danger hover:underline disabled:opacity-50 disabled:no-underline"
                    aria-label={t('speleodb.heldLocks.releaseOneAria', { name: lock.projectName })}
                    data-testid={`speleodb-held-lock-release-${lock.projectId}`}
                  >
                    {busyId === lock.projectId
                      ? t('speleodb.heldLocks.releasing')
                      : t('speleodb.heldLocks.release')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {failed && (
          <p
            className="text-xs"
            style={{ color: UNPUSHED_ACCENT }}
            data-testid="speleodb-held-lock-local-unknown"
          >
            {t('speleodb.localEdits.heldLocks.unknown')}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={keep} disabled={busy} data-testid="speleodb-held-lock-keep">
            {t('speleodb.heldLocks.keep')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
