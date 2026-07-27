import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { invokeIpc } from '../utils/ipc';
import { speleoErrorAction, humanizeSpeleoError, unpushedLocalEdits } from '../utils/speleoError';
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
 * - `unpushed_local` - the cached copy still holds edits SpeleoDB has never seen, so
 *   the backend refused to overwrite it; the keep-local / take-remote prompt has
 *   already been raised (see `speleodb-unpushed-local`). The caller only clears its
 *   own busy flag - it must NOT surface this as an error.
 * - `error` - the open/adopt call itself failed; `message` is humanized for display
 *   and `reLogin` is set when a dead token means the caller should drop the session.
 */
export type OpenRemoteOutcome =
  | { status: 'opened' }
  | {
      status: 'adopt';
      /**
       * [#270] The user has ALREADY confirmed discarding the local copy - this
       * adopt was reached through "take the server copy and discard my local
       * changes", not through a plain open. The adopt must carry that waiver or
       * its own un-pushed-edits guard refuses a question the user just answered,
       * with nothing behind it (re-adopting is the only way to open an Ariane
       * project at all). Absent on the ordinary open->adopt route.
       */
      discardLocal?: boolean;
    }
  | { status: 'load_failed' }
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
 * The shared "pull a remote SpeleoDB project and open it" flow (#218), extracted
 * from the Open-from-SpeleoDB browser so GlobalView's remote rows reuse the exact
 * same behavior: `speleodb_open_project` -> concurrent-session notice -> optimistic
 * link seed -> loadProject -> rollback on failure, with the #214 Ariane-adopt route
 * folded in. UI-agnostic: it returns an outcome and never surfaces errors itself
 * (beyond the shared toasts), so each host renders errors/adopt-confirm its own way.
 */
export function useOpenRemoteProject(opts: UseOpenRemoteProjectOpts = {}) {
  const { t } = useTranslation();
  const { onBeforeLoad, cancelReturnsTo } = opts;
  const showToast = useUIStore((s) => s.showToast);
  const openDialog = useUIStore((s) => s.openDialog);
  const loadProject = useProjectStore((s) => s.loadProject);
  const setLinkOnOpen = useSpeleoStore((s) => s.setLinkOnOpen);

  // Shared tail: a pull (open or adopt) produced a local .stalx - seed the link
  // optimistically from the summary permission, then load. Roll the seed back if the
  // load fails (loadProject shows its own error), so the shell never keeps a remote
  // read-only link for a project that never opened.
  const finishOpen = useCallback(
    async (
      result: { local_path: string; concurrent_session: boolean },
      permission: SpeleoProjectSummary['permission'],
      opts: {
        successToast?: { message: string; key: string };
        /**
         * [#270] Seed the link's dirty bit as TRUE. The seed's default is a fresh
         * pull (nothing local the server has not seen); "keep the local copy" is
         * the opposite by construction, and seeding it clean disarmed the quit
         * guard for the one project we have proof is dirty.
         */
        hasUnpushedEdits?: boolean;
        /**
         * [#270] Do not touch the link AT ALL - the file being "opened" is the one
         * already on screen, whose live link is the authoritative state (lock held,
         * permission, dirty bit, all resolved). The optimistic seed is for a project
         * arriving from the server; applied to the open one it OVERWRITES resolved
         * truth with a pessimistic guess, and `loadProject` then short-circuits on
         * ALREADY_OPEN so nothing re-resolves it synchronously.
         */
        skipSeed?: boolean;
      } = {},
    ): Promise<OpenRemoteOutcome> => {
      const { successToast, hasUnpushedEdits, skipSeed } = opts;
      // #270: what to put back if the load fails. Captured BEFORE the seed, so the
      // rollback below is a true undo rather than a clear-and-hope.
      const priorLink = useSpeleoStore.getState().snapshotLink();
      // #193 b8: a lock held by THIS account at open time = a second same-account
      // session; warn (keyed so repeat opens don't stack duplicate toasts).
      if (result.concurrent_session) {
        showToast(t('speleodb.browser.concurrentSession'), 'speleodb-concurrent-session', 'warning');
      }
      // `forPath` is the exact string handed to `loadProject` below, so the
      // `syncProjectLink` inside that load recognises this seed as belonging to
      // the project being opened rather than to whatever was open before.
      if (!skipSeed) {
        setLinkOnOpen({
          permission,
          forPath: result.local_path,
          hasUnpushedEdits: hasUnpushedEdits === true,
        });
      }
      onBeforeLoad?.();
      const loaded = await loadProject(result.local_path);
      if (!loaded.success) {
        // Nothing to roll back when we never seeded: the link on screen is still
        // the open project's own, resolved state, and clearing it would be the very
        // downgrade this branch exists to undo.
        if (skipSeed) return { status: 'load_failed' };
        // #270: the failed load left the PREVIOUS project on screen and still open
        // backend-side, so put its link state back exactly as it was.
        //
        // This used to be `clearLink()`, which sets `projectLinkKind: 'unknown'` -
        // read-only under the fail-closed gate - leaving the repair entirely to the
        // unawaited `refreshLinkStatus` below. That call swallows its errors by
        // design, and the conditions that break a load (offline, a bad disk) are the
        // same ones that break a status call; `SpeleoStatusButton`'s recovery poll
        // is gated on `link !== null`, which `clearLink` had just falsified. So a
        // local project the user was editing could go read-only for the rest of the
        // session because an unrelated remote open failed, with nothing on screen
        // explaining it. The restore needs no network and cannot fail.
        useSpeleoStore.getState().restoreLink(priorLink);
        // Still worth re-resolving from the backend - the snapshot is as fresh as
        // the moment before the attempt, not as fresh as now. Opportunistic, not
        // load-bearing: unawaited, and the restore above already stands on its own.
        void useSpeleoStore.getState().refreshLinkStatus();
        return { status: 'load_failed' };
      }
      if (successToast) showToast(successToast.message, successToast.key);
      return { status: 'opened' };
    },
    [showToast, setLinkOnOpen, loadProject, onBeforeLoad, t],
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
        // #270: re-opening would have overwritten a cached .stalx that still holds
        // edits the server has never seen, so the backend refused. Raise the binary
        // keep-local / take-remote prompt HERE rather than at each call site, so both
        // entry points (the browser dialog and the GlobalView remote rows) get the
        // choice instead of a dead-end error. Every other failure falls through.
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
      return finishOpen(result, summary.permission);
    },
    [finishOpen, openDialog, cancelReturnsTo, t],
  );

  /**
   * [#270] "Keep the local copy" - the safe branch of the refused-open prompt.
   *
   * Deliberately calls NO SpeleoDB command: nothing is downloaded and nothing is
   * overwritten. The local `.stalx` named by the refusal is opened through the
   * SAME tail every successful pull uses (`finishOpen` -> loadProject, with the
   * link seed + rollback), so the two branches can never drift apart.
   *
   * Two things the shared tail must be told, because this branch is NOT a pull:
   *
   * 1. The copy is DIRTY, and we know it: this branch is reachable only because
   *    the backend refused the open over edits the server has never seen. The
   *    tail's default seed says `hasUnpushedEdits: false`, and that value is
   *    exactly what `guardQuit` and the status button's warning read - so seeding
   *    it clean disarmed the quit guard for the one project proven to have work
   *    at risk, until some later status poll (30 s to a user-configurable 24 h)
   *    happened to correct it.
   * 2. If the refusal names the project ALREADY OPEN, seed nothing. "Open from
   *    SpeleoDB" sits in the in-project menu, so re-opening the current project is
   *    an ordinary mis-step; the refusal fires, the user keeps local, and the seed
   *    would replace a fully-resolved link (lock held, permission, remote state)
   *    with a pessimistic guess. `loadProject` then short-circuits on ALREADY_OPEN,
   *    so nothing re-resolves it synchronously and the survey UI drops to read-only
   *    for a project we hold the lock on. Skipping the seed is correct even when
   *    the network is down, which a status-refresh repair would not be.
   */
  const keepLocalCopy = useCallback(
    async (summary: SpeleoProjectSummary, localPath: string): Promise<OpenRemoteOutcome> => {
      const alreadyOpen = useProjectStore.getState().project?.file_path === localPath;
      return finishOpen({ local_path: localPath, concurrent_session: false }, summary.permission, {
        hasUnpushedEdits: true,
        skipSeed: alreadyOpen,
      });
    },
    [finishOpen],
  );

  /**
   * [#270] "Take the server copy and discard my local changes" - the destructive
   * branch. Re-issues the refused open through the discarding command with exactly
   * the arguments it was given, then runs the same post-open follow-up.
   */
  const takeRemoteDiscardingLocal = useCallback(
    async (summary: SpeleoProjectSummary): Promise<OpenRemoteOutcome> => {
      let result: SpeleoOpenResult;
      try {
        result = await invokeIpc<SpeleoOpenResult>('speleodb_open_project_discarding_local', {
          projectId: summary.id,
          projectName: summary.name,
          latestCommitSha: summary.latest_commit_sha ?? null,
        });
      } catch (e) {
        // #214/#270: the same Ariane route `openRemote` has. It is not hypothetical
        // here - an adopt stamps the cache copy un-pushed and the server `type` flip
        // is best-effort, so an adopt without write access leaves a project that is
        // BOTH dirty locally and still classified Ariane. That is exactly the
        // project this branch is reached for. Dropping the route sent the user who
        // had just confirmed discarding their local copy to a flat "this project is
        // an Ariane project" error with nothing opened and nowhere to go. The
        // classify happens before any replace, so nothing has been destroyed yet -
        // but the confirmation carries forward, so the adopt it leads to does not
        // re-ask.
        if (speleoErrorAction(e) === 'Adopt') return { status: 'adopt', discardLocal: true };
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
    async (
      summary: SpeleoProjectSummary,
      opts: { discardLocal?: boolean } = {},
    ): Promise<OpenRemoteOutcome> => {
      let result: SpeleoAdoptResult;
      try {
        result = await invokeIpc<SpeleoAdoptResult>('speleodb_adopt_ariane', {
          projectId: summary.id,
          projectName: summary.name,
          latestCommitSha: summary.latest_commit_sha ?? null,
          // Only ever true on the take-remote route, where the loss is confirmed.
          discardLocal: opts.discardLocal === true,
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
        successToast: {
          message: result.type_flipped
            ? t('speleodb.adopt.doneToast')
            : t('speleodb.adopt.doneToastNoWrite'),
          key: 'speleodb-adopted',
        },
      });
    },
    [finishOpen, t],
  );

  return { openRemote, adoptRemote, keepLocalCopy, takeRemoteDiscardingLocal };
}
