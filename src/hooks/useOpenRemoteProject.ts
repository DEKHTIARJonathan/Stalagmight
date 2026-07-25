import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { invokeIpc } from '../utils/ipc';
import { speleoErrorAction, humanizeSpeleoError } from '../utils/speleoError';
import type {
  SpeleoProjectSummary,
  SpeleoOpenResult,
  SpeleoAdoptResult,
} from '../types/ipc.generated';

/**
 * Outcome of an open/adopt attempt, so the caller can drive its own UI:
 * - `opened` - the project pulled and loaded (loadProject re-seeds the link).
 * - `adopt` - the project is an Ariane (.tml-only) project; the caller shows the
 *   adopt confirm (only `openRemote` returns this; `adoptRemote` never does).
 * - `load_failed` - the pull succeeded but loadProject failed; it already surfaced
 *   its own error and the optimistic link seed was rolled back. Caller does nothing.
 * - `error` - the open/adopt call itself failed; `message` is humanized for display
 *   and `reLogin` is set when a dead token means the caller should drop the session.
 */
export type OpenRemoteOutcome =
  | { status: 'opened' }
  | { status: 'adopt' }
  | { status: 'load_failed' }
  | { status: 'error'; message: string; reLogin: boolean };

interface UseOpenRemoteProjectOpts {
  /** Run right before loadProject (e.g. closeDialog so the load progress shows). */
  onBeforeLoad?: () => void;
}

/**
 * The shared "pull a remote SpeleoDB project and open it" flow (#218), extracted
 * from the Open-from-SpeleoDB browser so GlobalView's remote rows reuse the exact
 * same behavior: `speleodb_open_project` -> concurrent-session notice -> optimistic
 * link seed -> loadProject -> rollback on failure, with the #214 Ariane-adopt route
 * folded in. UI-agnostic: it returns an outcome and never surfaces errors itself
 * (beyond the shared toasts), so each host renders errors/adopt-confirm its own way.
 */
export function useOpenRemoteProject(opts: UseOpenRemoteProjectOpts = {}) {
  const { t } = useTranslation();
  const { onBeforeLoad } = opts;
  const showToast = useUIStore((s) => s.showToast);
  const loadProject = useProjectStore((s) => s.loadProject);
  const setLinkOnOpen = useSpeleoStore((s) => s.setLinkOnOpen);
  const clearLink = useSpeleoStore((s) => s.clearLink);

  // Shared tail: a pull (open or adopt) produced a local .stalx - seed the link
  // optimistically from the summary permission, then load. Roll the seed back if the
  // load fails (loadProject shows its own error), so the shell never keeps a remote
  // read-only link for a project that never opened.
  const finishOpen = useCallback(
    async (
      result: { local_path: string; concurrent_session: boolean },
      permission: SpeleoProjectSummary['permission'],
      successToast?: { message: string; key: string },
    ): Promise<OpenRemoteOutcome> => {
      // #193 b8: a lock held by THIS account at open time = a second same-account
      // session; warn (keyed so repeat opens don't stack duplicate toasts).
      if (result.concurrent_session) {
        showToast(t('speleodb.browser.concurrentSession'), 'speleodb-concurrent-session', 'warning');
      }
      setLinkOnOpen({ permission });
      onBeforeLoad?.();
      const loaded = await loadProject(result.local_path);
      if (!loaded.success) {
        clearLink();
        return { status: 'load_failed' };
      }
      if (successToast) showToast(successToast.message, successToast.key);
      return { status: 'opened' };
    },
    [showToast, setLinkOnOpen, loadProject, clearLink, onBeforeLoad, t],
  );

  const openRemote = useCallback(
    async (summary: SpeleoProjectSummary): Promise<OpenRemoteOutcome> => {
      let result: SpeleoOpenResult;
      try {
        result = await invokeIpc<SpeleoOpenResult>('speleodb_open_project', {
          // [Track B] (#189) pass name + latest SHA so the backend stamps the
          // speleo_link row (is_remote) on the pulled .stalx.
          projectId: summary.id,
          projectName: summary.name,
          latestCommitSha: summary.latest_commit_sha ?? null,
        });
      } catch (e) {
        // #214: an Ariane (.tml-only) project routes here (backend returns the typed
        // Adopt action, not a hard error). Signal the caller to offer adoption.
        if (speleoErrorAction(e) === 'Adopt') return { status: 'adopt' };
        return {
          status: 'error',
          message: humanizeSpeleoError(e, t('speleodb.errors.openFailed')),
          reLogin: speleoErrorAction(e) === 'ReLogin',
        };
      }
      return finishOpen(result, summary.permission);
    },
    [finishOpen, t],
  );

  const adoptRemote = useCallback(
    async (summary: SpeleoProjectSummary): Promise<OpenRemoteOutcome> => {
      let result: SpeleoAdoptResult;
      try {
        result = await invokeIpc<SpeleoAdoptResult>('speleodb_adopt_ariane', {
          projectId: summary.id,
          projectName: summary.name,
          latestCommitSha: summary.latest_commit_sha ?? null,
        });
      } catch (e) {
        return {
          status: 'error',
          message: humanizeSpeleoError(e, t('speleodb.errors.adoptFailed')),
          reLogin: speleoErrorAction(e) === 'ReLogin',
        };
      }
      // Post-adoption notice: Stalagmight now owns edits. When the server type could
      // not be flipped (no write access), say so - the user can still edit locally.
      return finishOpen(result, summary.permission, {
        message: result.type_flipped
          ? t('speleodb.adopt.doneToast')
          : t('speleodb.adopt.doneToastNoWrite'),
        key: 'speleodb-adopted',
      });
    },
    [finishOpen, t],
  );

  return { openRemote, adoptRemote };
}
