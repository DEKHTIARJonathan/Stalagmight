import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { invokeIpc } from '../utils/ipc';
import { speleoErrorAction, humanizeSpeleoError } from '../utils/speleoError';
import type {
  DoneResult,
  PushResult,
  StartEditingResult,
  UpdateResult,
} from '../types/ipc.generated';

/**
 * The single-writer hand-off verbs (#204), with backend-result routing. Keeps
 * the SpeleoEditBar / SpeleoDoneDialog presentational: each verb invokes the IPC,
 * feeds the result to the shared `speleoStore` (which owns the edit-state
 * transitions + #198 divergence / #200 banner seams), reloads the project on a
 * fast-forward (the backend swapped the tree in place), and surfaces outcomes as
 * toasts. A `ReLogin` error drops the session so the bar collapses to read-only.
 */
export interface SpeleoActions {
  busy: boolean;
  startEditing: () => Promise<void>;
  update: () => Promise<void>;
  /** Push edits without releasing the lock (T2d) — collects an optional message. */
  push: (message?: string | null) => Promise<void>;
  /** The backend outcome, or `null` if the call threw. Callers key off `.kind`
      (e.g. the close flow only leaves once the lock is actually `released`). */
  done: (message?: string | null) => Promise<DoneResult | null>;
}

export function useSpeleoActions(): SpeleoActions {
  const { t } = useTranslation();
  // Shared busy so the status button and the hamburger submenu gate on the same
  // in-flight lock and can't double-issue a verb (fix 12).
  const busy = useSpeleoStore((s) => s.busy);
  const setBusy = useSpeleoStore((s) => s.setBusy);
  const showToast = useUIStore((s) => s.showToast);
  const loadProject = useProjectStore((s) => s.loadProject);
  const applyStartEditing = useSpeleoStore((s) => s.applyStartEditing);
  const applyUpdate = useSpeleoStore((s) => s.applyUpdate);
  const applyDone = useSpeleoStore((s) => s.applyDone);
  const applyPush = useSpeleoStore((s) => s.applyPush);
  const bumpPoll = useSpeleoStore((s) => s.bumpPoll);
  const clearSession = useSpeleoStore((s) => s.clearSession);

  const handleError = useCallback(
    (e: unknown, prefixKey: string) => {
      // A dead token collapses the shell to read-only (mirrors the backend gate
      // drop); other errors are transient — surface and let the user retry.
      if (speleoErrorAction(e) === 'ReLogin') clearSession();
      showToast(humanizeSpeleoError(e, t(prefixKey)), 'speleodb-action-error');
    },
    [clearSession, showToast, t],
  );

  const startEditing = useCallback(async () => {
    setBusy(true);
    try {
      const result = await invokeIpc<StartEditingResult>('speleodb_start_editing');
      applyStartEditing(result);
      switch (result.kind) {
        case 'editing':
          showToast(t('speleodb.editBar.toasts.editing'), 'speleodb-editing');
          break;
        case 'fast_forwarded':
          // Backend swapped the tree; reload so the view matches (loadProject
          // re-seeds the link status → editing).
          await loadProject(result.local_path);
          break;
        case 'locked_by':
          showToast(
            t('speleodb.editBar.toasts.lockedBy', {
              email: result.email ?? t('speleodb.editBar.someone'),
            }),
            'speleodb-locked-by',
          );
          break;
        case 'divergence_needed':
          // #198 seam: applyStartEditing recorded the divergence origin.
          break;
      }
    } catch (e) {
      handleError(e, 'speleodb.editBar.toasts.startFailed');
    } finally {
      // Reset the poll timer so the next poll is a full interval out — a buffer
      // past the just-issued lock change the server mutex may not yet reflect (1b).
      bumpPoll();
      setBusy(false);
    }
  }, [applyStartEditing, loadProject, showToast, t, handleError, setBusy, bumpPoll]);

  const update = useCallback(async () => {
    setBusy(true);
    try {
      const result = await invokeIpc<UpdateResult>('speleodb_update');
      applyUpdate(result);
      switch (result.kind) {
        case 'up_to_date':
          showToast(t('speleodb.editBar.toasts.upToDate'), 'speleodb-up-to-date');
          break;
        case 'fast_forwarded':
          await loadProject(result.local_path);
          break;
        case 'divergence_needed':
          break;
      }
    } catch (e) {
      handleError(e, 'speleodb.editBar.toasts.updateFailed');
    } finally {
      bumpPoll();
      setBusy(false);
    }
  }, [applyUpdate, loadProject, showToast, t, handleError, setBusy, bumpPoll]);

  const push = useCallback(
    async (message?: string | null) => {
      setBusy(true);
      try {
        const result = await invokeIpc<PushResult>('speleodb_push', { message: message ?? null });
        applyPush(result);
        if (result.kind === 'pushed') {
          showToast(t('speleodb.editBar.toasts.pushed'), 'speleodb-pushed');
        }
        // divergence_needed / push_unconfirmed surface via the store (#198/#200 seams).
      } catch (e) {
        handleError(e, 'speleodb.editBar.toasts.pushFailed');
      } finally {
        bumpPoll();
        setBusy(false);
      }
    },
    [applyPush, showToast, t, handleError, setBusy, bumpPoll],
  );

  const done = useCallback(
    async (message?: string | null): Promise<DoneResult | null> => {
      setBusy(true);
      try {
        const result = await invokeIpc<DoneResult>('speleodb_done', { message: message ?? null });
        applyDone(result);
        switch (result.kind) {
          case 'released':
            showToast(t('speleodb.editBar.toasts.released'), 'speleodb-released');
            break;
          case 'push_unconfirmed':
            // #200 seam: applyDone raised the push_unconfirmed banner.
            break;
          case 'divergence_needed':
            // #198 seam: applyDone recorded the divergence origin.
            break;
        }
        return result;
      } catch (e) {
        handleError(e, 'speleodb.editBar.toasts.doneFailed');
        return null;
      } finally {
        bumpPoll();
        setBusy(false);
      }
    },
    [applyDone, showToast, t, handleError, setBusy, bumpPoll],
  );

  return { busy, startEditing, update, push, done };
}
