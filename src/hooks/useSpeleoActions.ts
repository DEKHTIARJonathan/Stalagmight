import { useCallback, useState } from 'react';
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
  /** Push edits without releasing the lock (T2d). */
  push: () => Promise<void>;
  /** Returns true if the call resolved (any outcome), false if it threw. */
  done: (message?: string | null) => Promise<boolean>;
}

export function useSpeleoActions(): SpeleoActions {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const showToast = useUIStore((s) => s.showToast);
  const loadProject = useProjectStore((s) => s.loadProject);
  const applyStartEditing = useSpeleoStore((s) => s.applyStartEditing);
  const applyUpdate = useSpeleoStore((s) => s.applyUpdate);
  const applyDone = useSpeleoStore((s) => s.applyDone);
  const applyPush = useSpeleoStore((s) => s.applyPush);
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
      setBusy(false);
    }
  }, [applyStartEditing, loadProject, showToast, t, handleError]);

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
      setBusy(false);
    }
  }, [applyUpdate, loadProject, showToast, t, handleError]);

  const push = useCallback(async () => {
    setBusy(true);
    try {
      const result = await invokeIpc<PushResult>('speleodb_push', { message: null });
      applyPush(result);
      if (result.kind === 'pushed') {
        showToast(t('speleodb.editBar.toasts.pushed'), 'speleodb-pushed');
      }
      // divergence_needed / push_unconfirmed surface via the store (#198/#200 seams).
    } catch (e) {
      handleError(e, 'speleodb.editBar.toasts.pushFailed');
    } finally {
      setBusy(false);
    }
  }, [applyPush, showToast, t, handleError]);

  const done = useCallback(
    async (message?: string | null) => {
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
        return true;
      } catch (e) {
        handleError(e, 'speleodb.editBar.toasts.doneFailed');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [applyDone, showToast, t, handleError],
  );

  return { busy, startEditing, update, push, done };
}
