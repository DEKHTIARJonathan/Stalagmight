import { confirmWorkspaceDrafts } from '../utils/workspaceDrafts';
import { isProjectRequestCurrent, beginProjectMutation, isProjectMutationCurrent, reserveProjectRequest } from '../utils/projectTransition';
import { useCallback } from 'react';
import { confirmSpeleoOpen } from '../utils/confirmSpeleoOpen';
import { useTranslation } from 'react-i18next';
import { useUIStore, type ToastKind } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import {
  useSpeleoStore,
  speleoProjectSessionIssuedFor,
} from '../store/speleoStore';
import { invokeIpc } from '../utils/ipc';
import { applySpeleoTreeReplacement } from '../utils/speleoTreeReplacement';
import {
  speleoErrorAction,
  humanizeSpeleoError,
  unpushedLocalEdits,
} from '../utils/speleoError';
import { confirm } from '@tauri-apps/plugin-dialog';
import { askSpeleoExit, openProjectNeedsSpeleoExitPrompt } from '../utils/speleoExit';
import type {
  SpeleoProjectSummary,
  SpeleoOpenResult,
  UnpushedLocalEdits,
} from '../types/ipc.generated';

/** Result shared by the project browser, remote rows and local-cache recovery. */
export type OpenRemoteOutcome =
  | { status: 'opened' }
  | { status: 'cancelled' }

  | { status: 'load_failed'; localPath: string }
  | { status: 'unpushed_local' }
  | { status: 'error'; message: string; reLogin: boolean };

interface UseOpenRemoteProjectOpts {
  /** Run right before loadProject (e.g. closeDialog so the load progress shows). */
  onBeforeLoad?: () => void;
  /**
   * [#270] The dialog to hand the user back to if they cancel the refused-open
   * prompt this hook raises. The prompt replaces the host in the single
   * `activeDialog` slot, so without this a Cancel left `activeDialog: null` - the
   * browser gone, nothing opened, and no way back except re-opening the menu.
   * Omitted by hosts that are not dialogs (GlobalView's remote rows), where
   * cancelling correctly just returns to the view underneath.
   */
  cancelReturnsTo?: string;
}

/**
 * Leaving a SpeleoDB project we hold the lock on, with work SpeleoDB has not seen,
 * goes through the exit prompt first - BEFORE the open reserves its ownership,
 * because the prompt's own close reserves a project request of its own and would
 * otherwise supersede this open. Reopening the project already on screen is not
 * leaving it, so it asks nothing. `false` = the user cancelled; nothing happened.
 */
async function leaveOpenProjectFor(targetProjectId: string): Promise<boolean> {
  if (!openProjectNeedsSpeleoExitPrompt()) return true;
  if (useSpeleoStore.getState().remoteProjectId === targetProjectId) return true;
  return askSpeleoExit('switch');
}

/** One ownership token covers the warning, download, seed, and file load. */
function reserveRemoteOpen() {
  const request = reserveProjectRequest();
  const sessionGeneration = useSpeleoStore.getState().sessionGeneration;
  let dispatched = false;
  return { request,
    latest: () => isProjectRequestCurrent(request) && useSpeleoStore.getState().sessionGeneration === sessionGeneration,
    dispatch: () => { dispatched = beginProjectMutation(request); return dispatched; },
    current: () => (dispatched ? isProjectMutationCurrent(request) : isProjectRequestCurrent(request)) &&
      useSpeleoStore.getState().sessionGeneration === sessionGeneration };

}

/** Pull a native project, seed its access state, load it, and roll back a failed load. */
export function useOpenRemoteProject(opts: UseOpenRemoteProjectOpts = {}) {
  const { t } = useTranslation();
  const { onBeforeLoad, cancelReturnsTo } = opts;
  const showToast = useUIStore((s) => s.showToast);
  const openDialog = useUIStore((s) => s.openDialog);
  const loadProject = useProjectStore((s) => s.loadProject);
  const setLinkOnOpen = useSpeleoStore((s) => s.setLinkOnOpen);

  // Shared tail: a native pull produced a local .stalx - seed the link
  // optimistically from the summary permission, then load. Roll the seed back if the
  // load fails (loadProject shows its own error), so the shell never keeps a remote
  // read-only link for a project that never opened.
  const finishOpen = useCallback(
    async (
      result: SpeleoOpenResult,
      permission: SpeleoProjectSummary['permission'],
      /** The project this open is FOR, so the seed names it rather than waiting for a refresh. */
      projectId: string,
      ownership: ReturnType<typeof reserveRemoteOpen>,
      opts: {
        /**
         * `kind` defaults to `info` for an ordinary successful open; callers can
         * provide another severity when the result needs attention.
         */
        successToast?: { message: string; key: string; kind: ToastKind };
        /** Preserve the cached dirty bit when opening offline. */
        hasUnpushedEdits?: boolean;
      } = {},
    ): Promise<OpenRemoteOutcome> => {
      const { successToast, hasUnpushedEdits } = opts;
      if (!ownership.current()) return { status: 'cancelled' };
      // #270: what to put back if the load fails. Captured BEFORE the seed, so the
      // rollback below is a true undo rather than a clear-and-hope. `priorPath` is
      // the project the snapshot describes, so the rollback can tell "the load
      // failed and we are still here" from "the ground moved" (see below).
      const priorLink = useSpeleoStore.getState().snapshotLink();
      const priorPath = useProjectStore.getState().project?.file_path ?? null;

      const alreadyOpen = priorPath === result.local_path;
      // `forPath` is the exact string handed to `loadProject` below, so the
      // `syncProjectLink` inside that load recognises this seed as belonging to
      // the project being opened rather than to whatever was open before.
      if (alreadyOpen) {
        // The seed is skipped here on purpose - the link on screen is this project's
        // own RESOLVED state and replacing it with an optimistic one is the downgrade
        // this branch exists to avoid. But the project ID is not part of that state,
        // it is just which project this is, and skipping the whole seed took it with
        // the rest: reopening from SpeleoDB a project already on screen from recents
        // left `remoteProjectId` stale until a status request happened to land. The
        // revision history is keyed on it, and the identity guards compare against it,
        // so the window showed no history and could refuse actions as
        // `project_changed`. One field, without touching the link.
        useSpeleoStore.setState({ remoteProjectId: projectId });
      } else {
        setLinkOnOpen({
          permission,
          forPath: result.local_path,
          hasUnpushedEdits: hasUnpushedEdits === true,
          ...(result.offline ? { offline: true } : {}),
          projectId,
        });
      }
      onBeforeLoad?.();
      const loaded = await loadProject(result.local_path, { accessConfirmed: true, request: ownership.request });
      if (!ownership.current()) return { status: 'load_failed', localPath: result.local_path };
      if (!loaded.success) {
        // Nothing to roll back when we never seeded: the link on screen is still
        // the open project's own, resolved state, and clearing it would be the very
        // downgrade this branch exists to undo.
        if (alreadyOpen) return { status: 'load_failed', localPath: result.local_path };
        // #270: the snapshot describes a project that is no longer the one on
        // screen, so putting it back would overwrite the link of whatever the user
        // actually opened. `loadProject` reports `success: false` for two different
        // things, and only one of them is "the load failed and we are still where
        // we were": a SUPERSEDED load lost its slot to a newer open, which commits
        // its own project and link. (The path check covers the other way to move
        // the ground - a close landing mid-flight, which does not bump the load
        // id.) Restoring here put the pre-attempt snapshot - `projectLinkKind:
        // 'unknown'`, read-only under the fail-closed gate - over a freshly-opened
        // LOCAL project. GlobalView guards its remote rows with `remoteBusyRef`,
        // but `handleOpenFromList` and `handlePublishToSpeleoDb` do not, so a
        // second open during a slow pull is reachable.
        const groundMoved =
          loaded.superseded === true ||
          (useProjectStore.getState().project?.file_path ?? null) !== priorPath;
        if (groundMoved) return { status: 'load_failed', localPath: result.local_path };
        // #270: the failed load left the PREVIOUS project on screen and still open
        // backend-side, so put its link state back exactly as it was.
        //
        // This used to be `clearLink()`, which sets `projectLinkKind: 'unknown'` -
        // read-only under the fail-closed gate - leaving the repair entirely to the
        // unawaited `refreshLinkStatus` below. That call swallows its errors by
        // design, and the conditions that break a load (offline, a bad disk) are the
        // same ones that break a status call; the next manual status refresh
        // is gated on `link !== null`, which `clearLink` had just falsified. So a
        // local project the user was editing could go read-only for the rest of the
        // session because an unrelated remote open failed, with nothing on screen
        // explaining it. The restore needs no network and cannot fail.
        useSpeleoStore.getState().restoreLink(priorLink);
        // Still worth re-resolving from the backend - the snapshot is as fresh as
        // the moment before the attempt, not as fresh as now. Opportunistic, not
        // load-bearing: unawaited, and the restore above already stands on its own.
        void useSpeleoStore.getState().refreshLinkStatus();
        return { status: 'load_failed', localPath: result.local_path };
      }
      // Reopening the file already on screen makes loadProject take its intentional
      // already-open fast path. The backend may still have replaced the whole tree, so
      // run the same post-replacement cleanup as fast-forward, discard, and restore.
      if (
        alreadyOpen && !result.offline &&
        !(await applySpeleoTreeReplacement(speleoProjectSessionIssuedFor(projectId), true))
      ) {
        return { status: 'load_failed', localPath: result.local_path };
      }
      if (!ownership.current()) return { status: 'load_failed', localPath: result.local_path };
      if (successToast) showToast(successToast.message, successToast.key, successToast.kind);
      return { status: 'opened' };
    },
    [showToast, setLinkOnOpen, loadProject, onBeforeLoad, t],
  );

  // Only unsaved memory changes need confirmation before a remote open. Saved
  // local edits remain on disk, and the backend releases the old project's lock.
  // The acknowledgement belongs to this exact project snapshot and request.
  const confirmUnsavedHandBack = useCallback(async (current: () => boolean) => {
    if (!await confirmWorkspaceDrafts(current) || !current()) return null;
    const { project, isDirty } = useProjectStore.getState();
    if (!project || !isDirty) return { project: null };
    const accepted = await confirm(t('speleodb.exit.unsavedMessage'), {
      title: t('speleodb.exit.unsavedTitle'),
      kind: 'warning',
      okLabel: t('speleodb.exit.discardChanges'),
      cancelLabel: t('common.actions.cancel'),
    });
    if (!accepted || !current() || useProjectStore.getState().project !== project) return null;
    return { project };
  }, [t]);

  const handBackRefusal = useCallback(
    (summary: SpeleoProjectSummary, acknowledgedProject: ReturnType<typeof useProjectStore.getState>['project'] = null): string | null => {
      const { project, isDirty } = useProjectStore.getState();
      if (project && isDirty && project !== acknowledgedProject) {
        return t('speleodb.errors.openBlockedUnsaved', { name: summary.name });
      }
      return null;
    },
    [t],
  );

  // Recheck after downloading: edits made since the acknowledgement must not be
  // discarded. When the download replaced the currently open cache file, the
  // backend already closed that session, so finish its UI reconciliation instead.
  const handBackRefusalAfterPull = useCallback(
    (summary: SpeleoProjectSummary, localPath: string, acknowledgedProject: ReturnType<typeof useProjectStore.getState>['project']): string | null => {
      if ((useProjectStore.getState().project?.file_path ?? null) === localPath) return null;
      return handBackRefusal(summary, acknowledgedProject);
    },
    [handBackRefusal],
  );

  const openRemote = useCallback(
    async (
      summary: SpeleoProjectSummary,
    ): Promise<OpenRemoteOutcome> => {
      // Before the pull, the seed and the load: nothing about the open project may be
      // given up silently (see `handBackRefusal`).
      if (!await leaveOpenProjectFor(summary.id)) return { status: 'cancelled' };
      const ownership = reserveRemoteOpen();
      let acknowledged: Awaited<ReturnType<typeof confirmUnsavedHandBack>>;
      try {
        acknowledged = await confirmUnsavedHandBack(ownership.current);
      } catch (error) {
        if (!ownership.current()) return { status: 'cancelled' };
        return { status: 'error', message: humanizeSpeleoError(error, t('speleodb.errors.openFailed')), reLogin: false };
      }
      if (!acknowledged || !ownership.current()) return { status: 'cancelled' };
      try {
        if (!await confirmSpeleoOpen(summary) || !ownership.current()) return { status: 'cancelled' };
      } catch (e) {
        if (!ownership.latest()) return { status: 'cancelled' };
        return { status: 'error', message: humanizeSpeleoError(e, t('speleodb.errors.openFailed')), reLogin: false };
      }
      const afterWarning = handBackRefusal(summary, acknowledged.project);
      if (afterWarning) return { status: 'error', message: afterWarning, reLogin: false };
      let result: SpeleoOpenResult;
      try {
        if (!ownership.dispatch()) return { status: 'cancelled' };
        result = await invokeIpc<SpeleoOpenResult>('speleodb_open_project', {
          // [Track B] (#189) pass name + latest SHA so the backend stamps the
          // speleo_link row (is_remote) on the pulled .stalx.
          projectId: summary.id,
          projectName: summary.name,
          latestCommitSha: summary.latest_commit_sha ?? null,
        });
      } catch (e) {
        if (!ownership.latest()) return { status: 'cancelled' };
        const unpushed = unpushedLocalEdits(e);
        if (unpushed) {
          openDialog('speleodb-unpushed-local', {
            summary,
            unpushedLocal: unpushed,
            // Where Cancel goes, so the prompt is not a dead end for a host it
            // displaced in the single dialog slot (#270).
            ...(cancelReturnsTo ? { cancelReturnsTo } : {}),
          });
          return { status: 'unpushed_local' };
        }
        return {
          status: 'error',
          message: humanizeSpeleoError(e, t('speleodb.errors.openFailed')),
          reLogin: speleoErrorAction(e) === 'ReLogin',
        };
      }
      // A new edit during the download invalidates the earlier discard consent.
      if (!ownership.current()) return { status: 'cancelled' };
      const landed = handBackRefusalAfterPull(summary, result.local_path, acknowledged.project);
      if (landed) return { status: 'error', message: landed, reLogin: false };
      return finishOpen(result, summary.permission, summary.id, ownership, {
        hasUnpushedEdits: result.has_unpushed_edits === true,
        ...(result.offline ? { successToast: {
          message: t('speleodb.projectListing.offlineCopy'),
          key: 'speleodb-offline-open',
          kind: 'warning' as const,
        } } : {}),
      });
    },
    [
      finishOpen,
      confirmUnsavedHandBack,
      handBackRefusal,
      handBackRefusalAfterPull,
      openDialog,
      cancelReturnsTo,
      t,
    ],
  );

  /**
   * [#270] "Take the server copy and discard my local changes" - the destructive
   * branch. Re-issues the refused open through the discarding command with exactly
   * the arguments it was given, then runs the same post-open follow-up.
   */
  const takeRemoteDiscardingLocal = useCallback(
    async (
      summary: SpeleoProjectSummary,
    ): Promise<OpenRemoteOutcome> => {
      // Discarding the target's cached copy does not authorize discarding newly
      // unsaved work in the project currently on screen. Ask separately if needed.
      if (!await leaveOpenProjectFor(summary.id)) return { status: 'cancelled' };
      const ownership = reserveRemoteOpen();
      let acknowledged: Awaited<ReturnType<typeof confirmUnsavedHandBack>>;
      try {
        acknowledged = await confirmUnsavedHandBack(ownership.current);
      } catch (error) {
        if (!ownership.current()) return { status: 'cancelled' };
        return { status: 'error', message: humanizeSpeleoError(error, t('speleodb.errors.openFailed')), reLogin: false };
      }
      if (!acknowledged || !ownership.current()) return { status: 'cancelled' };
      let result: SpeleoOpenResult;
      try {
        if (!ownership.dispatch()) return { status: 'cancelled' };
        result = await invokeIpc<SpeleoOpenResult>('speleodb_open_project_discarding_local', {
          projectId: summary.id,
          projectName: summary.name,
          latestCommitSha: summary.latest_commit_sha ?? null,
        });
      } catch (e) {
        if (!ownership.latest()) return { status: 'cancelled' };
        return {
          status: 'error',
          message: humanizeSpeleoError(e, t('speleodb.errors.openFailed')),
          reLogin: speleoErrorAction(e) === 'ReLogin',
        };
      }
      // Recheck current unsaved work before replacing the open project.
      if (!ownership.current()) return { status: 'cancelled' };
      const landed = handBackRefusalAfterPull(summary, result.local_path, acknowledged.project);
      if (landed) return { status: 'error', message: landed, reLogin: false };
      return finishOpen(result, summary.permission, summary.id, ownership);
    },
    [
      finishOpen,
      confirmUnsavedHandBack,
      handBackRefusal,
      handBackRefusalAfterPull,
      t,
    ],
  );

  /**
   * "Open my local copy" - the refused-open prompt's non-destructive answer. Loads
   * the copy already on this computer without downloading anything, keeping its
   * un-uploaded edits and base. The load's own Start Editing then takes it from
   * there: it re-acquires the lock if it can and runs the divergence check, so
   * SpeleoDB having moved on is reported by the existing divergence dialog rather
   * than resolved by throwing either copy away.
   */
  const openLocalCopy = useCallback(
    async (
      summary: SpeleoProjectSummary,
      local: UnpushedLocalEdits,
    ): Promise<OpenRemoteOutcome> => {
      if (!await leaveOpenProjectFor(summary.id)) return { status: 'cancelled' };
      const ownership = reserveRemoteOpen();
      let acknowledged: Awaited<ReturnType<typeof confirmUnsavedHandBack>>;
      try {
        acknowledged = await confirmUnsavedHandBack(ownership.current);
      } catch (error) {
        if (!ownership.current()) return { status: 'cancelled' };
        return { status: 'error', message: humanizeSpeleoError(error, t('speleodb.errors.openFailed')), reLogin: false };
      }
      if (!acknowledged || !ownership.current()) return { status: 'cancelled' };
      if (!ownership.dispatch()) return { status: 'cancelled' };
      const landed = handBackRefusalAfterPull(summary, local.local_path, acknowledged.project);
      if (landed) return { status: 'error', message: landed, reLogin: false };
      // `offline` keeps finishOpen from treating an already-open copy as a tree the
      // backend just replaced: nothing was downloaded, so there is nothing to re-read.
      return finishOpen({ local_path: local.local_path, offline: true, has_unpushed_edits: true },
        summary.permission, summary.id, ownership, { hasUnpushedEdits: true });
    },
    [finishOpen, confirmUnsavedHandBack, handBackRefusalAfterPull, t],
  );

  return { openRemote, takeRemoteDiscardingLocal, openLocalCopy };
}
