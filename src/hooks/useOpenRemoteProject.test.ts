// @vitest-environment jsdom
/**
 * Hook test (#218) - the shared pull+open flow for remote SpeleoDB projects.
 * Covers the outcome routing GlobalView + the browser dialog both depend on: a
 * normal open, the Ariane-adopt route, a load failure that rolls the link back, and
 * an open error that reports a re-login.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) }),
}));

import { useOpenRemoteProject } from './useOpenRemoteProject';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore, selectSpeleoReadOnly, type SpeleoLinkState } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import { guardQuit } from '../utils/quit';
import type { SpeleoProjectSummary } from '../types/ipc.generated';

// The genuine store action, captured before `beforeEach` swaps in the spy - so one
// case can exercise the real seed end to end (seed -> guardQuit).
const realSetLinkOnOpen = useSpeleoStore.getState().setLinkOnOpen;

const SUMMARY: SpeleoProjectSummary = {
  id: 'p1',
  name: 'Cave A',
  permission: 'READ_AND_WRITE',
  lock_holder: null,
  type_tag: 'stalx',
  latest_commit_sha: 'abc123',
};

/** A settled link for whatever project is OPEN, for the entry-guard cases below. */
const openLink = (o: Partial<SpeleoLinkState> = {}): SpeleoLinkState => ({
  permission: 'READ_AND_WRITE',
  editState: 'read-only',
  lockHolder: null,
  lockedByOther: false,
  hasUnpushedEdits: false,
  forceEditing: false,
  forceEditAllowed: false,
  remoteState: 'up_to_date',
  noAccess: false,
  serverError: null,
  ...o,
});

let loadProjectMock: ReturnType<typeof vi.fn>;
let setLinkOnOpenMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  loadProjectMock = vi.fn(async () => ({ success: true }));
  setLinkOnOpenMock = vi.fn();
  // `keepLocalCopy` compares the refused path against the LIVE open project, so the
  // "nothing open" baseline has to be explicit.
  useProjectStore.setState({ loadProject: loadProjectMock, project: null, isDirty: false });
  useSpeleoStore.setState({
    setLinkOnOpen: setLinkOnOpenMock,
    link: null,
    // The open remote project's id, which the entry guard reads to tell "the target
    // IS what is on screen" from a swap. Reset explicitly - the store is shared.
    remoteProjectId: null,
  });
  useUIStore.setState({ showToast: vi.fn(), openDialog: vi.fn() });
});

const hook = () => renderHook(() => useOpenRemoteProject()).result.current;

describe('useOpenRemoteProject (#218)', () => {
  it('opens a project: seeds the link, loads, and reports opened', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false });
      return Promise.resolve(null);
    });
    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome).toEqual({ status: 'opened' });
    expect(setLinkOnOpenMock).toHaveBeenCalledWith({
      permission: 'READ_AND_WRITE',
      // The path the seed belongs to, so the `syncProjectLink` inside the load
      // that follows keeps THIS project's link instead of the previous one's.
      forPath: '/cache/p1.stalx',
      // A PULL has, by construction, nothing local the server has not seen.
      hasUnpushedEdits: false,
    });
    expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
  });

  it('routes an Ariane (.tml-only) project to adopt', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.reject({ message: 'ariane', action: 'Adopt', status: null });
      return Promise.resolve(null);
    });
    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome).toEqual({ status: 'adopt' });
    expect(loadProjectMock).not.toHaveBeenCalled();
  });

  /**
   * [#270] A failed load must leave the user exactly where they were - the PREVIOUS
   * project is still on screen and still open backend-side.
   *
   * The rollback used `clearLink`, which sets `projectLinkKind: 'unknown'` - read-only
   * under the fail-closed gate - and left the repair to an unawaited
   * `refreshLinkStatus` that swallows its errors, in the very conditions that break a
   * load. So a LOCAL project the user was editing could go read-only for the rest of
   * the session because an unrelated remote open failed. Driven through the REAL seed
   * and rollback, since the assertion is about the state the user is left in.
   */
  it('restores the previous link when the pulled project fails to load', async () => {
    useSpeleoStore.setState({
      setLinkOnOpen: realSetLinkOnOpen,
      link: null,
      projectLinkKind: 'local',
      linkPath: null,
    });
    expect(selectSpeleoReadOnly(useSpeleoStore.getState())).toBe(false);

    loadProjectMock.mockResolvedValue({ success: false });
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false });
      return Promise.resolve(null);
    });
    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome).toEqual({ status: 'load_failed' });

    // Back to 'local', NOT 'unknown' - and still editable, with no network involved.
    expect(useSpeleoStore.getState().projectLinkKind).toBe('local');
    expect(useSpeleoStore.getState().link).toBeNull();
    expect(selectSpeleoReadOnly(useSpeleoStore.getState())).toBe(false);
  });

  it('reports an open error and flags a re-login on a dead token', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.reject({ message: 'unauthorized', action: 'ReLogin', status: 401 });
      return Promise.resolve(null);
    });
    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.reLogin).toBe(true);
  });

  it('raises the keep-local prompt when the open is refused over unpushed edits', async () => {
    // GlobalView's shape: no onBeforeLoad, outcome routed straight to its toast/
    // busy handling. The refusal must NOT come back as `error` (that would toast a
    // dead-end message) - it raises the prompt and reports `unpushed_local`.
    const openDialogMock = vi.fn();
    useUIStore.setState({ openDialog: openDialogMock });
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.reject({
          message: 'refused',
          action: 'UnpushedLocalEdits',
          status: null,
          unpushed_local: {
            project_id: 'p1',
            local_path: '/cache/p1.stalx',
            last_edit_at: '2026-07-20T10:30:00Z',
          },
        });
      return Promise.resolve(null);
    });
    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome).toEqual({ status: 'unpushed_local' });
    expect(openDialogMock).toHaveBeenCalledWith('speleodb-unpushed-local', {
      summary: SUMMARY,
      unpushedLocal: {
        project_id: 'p1',
        local_path: '/cache/p1.stalx',
        last_edit_at: '2026-07-20T10:30:00Z',
      },
    });
    expect(loadProjectMock).not.toHaveBeenCalled();
  });

  it('does not swallow an unrelated failure into the prompt', async () => {
    const openDialogMock = vi.fn();
    useUIStore.setState({ openDialog: openDialogMock });
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.reject({ message: 'boom', action: 'None', status: 500 });
      return Promise.resolve(null);
    });
    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome.status).toBe('error');
    expect(openDialogMock).not.toHaveBeenCalled();
  });

  it('keepLocalCopy loads the local path without any SpeleoDB command', async () => {
    const outcome = await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx');
    expect(outcome).toEqual({ status: 'opened' });
    expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
    expect(invokeIpcMock.mock.calls.filter((c) => String(c[0]).startsWith('speleodb_'))).toEqual([]);
  });

  // The core of the #270 keep-local defect: this branch pulls NOTHING and is
  // reachable ONLY because the backend refused the open over un-pushed local edits,
  // so the copy is provably dirty. The shared seed defaults to `false`, and that
  // exact flag is what `guardQuit` and the status button's warning read.
  it('keepLocalCopy seeds the dirty bit TRUE - the refusal is proof the copy is dirty', async () => {
    await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx');
    expect(setLinkOnOpenMock).toHaveBeenCalledWith({
      permission: 'READ_AND_WRITE',
      forPath: '/cache/p1.stalx',
      hasUnpushedEdits: true,
    });
  });

  it('keepLocalCopy seeds NOTHING when the refusal names the already-open project', async () => {
    // "Open from SpeleoDB" is in the in-project menu, so re-opening the current
    // project is an ordinary mis-step. The live link is fully resolved (lock held,
    // permission, remote state); the optimistic seed would replace it with a
    // pessimistic guess, and `loadProject` then short-circuits on ALREADY_OPEN so
    // nothing re-resolves it synchronously - dropping the survey UI to read-only for
    // a project we hold the lock on. Skipping the seed is correct offline too.
    useProjectStore.setState({ project: { file_path: '/cache/p1.stalx' } as never });
    const outcome = await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx');
    expect(outcome).toEqual({ status: 'opened' });
    expect(setLinkOnOpenMock).not.toHaveBeenCalled();
    expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
  });

  it('does not touch the live link when the already-open keep-local load fails', async () => {
    // There was no seed to roll back, and the link on screen is the open project's
    // own resolved state - downgrading it is the very thing the rollback undoes.
    const live = {
      permission: 'READ_AND_WRITE' as const,
      editState: 'editing' as const,
      lockHolder: null,
      lockedByOther: false,
      hasUnpushedEdits: true,
      forceEditing: false,
      forceEditAllowed: false,
      remoteState: 'up_to_date' as const,
      noAccess: false,
      serverError: null,
    };
    useProjectStore.setState({ project: { file_path: '/cache/p1.stalx' } as never });
    useSpeleoStore.setState({ link: live, projectLinkKind: 'remote', linkPath: '/cache/p1.stalx' });
    loadProjectMock.mockResolvedValue({ success: false });
    const outcome = await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx');
    expect(outcome).toEqual({ status: 'load_failed' });
    expect(useSpeleoStore.getState().link).toEqual(live);
    expect(useSpeleoStore.getState().projectLinkKind).toBe('remote');
  });

  it('passes the refusal prompt a route back to the host dialog when given one', async () => {
    const openDialogMock = vi.fn();
    useUIStore.setState({ openDialog: openDialogMock });
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.reject({
          message: 'refused',
          action: 'UnpushedLocalEdits',
          status: null,
          unpushed_local: {
            project_id: 'p1',
            local_path: '/cache/p1.stalx',
            last_edit_at: null,
          },
        });
      return Promise.resolve(null);
    });
    const withReturn = renderHook(() =>
      useOpenRemoteProject({ cancelReturnsTo: 'open-from-speleodb' }),
    ).result.current;
    await withReturn.openRemote(SUMMARY);
    expect(openDialogMock).toHaveBeenCalledWith(
      'speleodb-unpushed-local',
      expect.objectContaining({ cancelReturnsTo: 'open-from-speleodb' }),
    );
  });

  it('takeRemoteDiscardingLocal re-issues the refused open with the same arguments', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project_discarding_local')
        return Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false });
      return Promise.resolve(null);
    });
    const outcome = await hook().takeRemoteDiscardingLocal(SUMMARY);
    expect(outcome).toEqual({ status: 'opened' });
    const call = invokeIpcMock.mock.calls.find(
      (c) => c[0] === 'speleodb_open_project_discarding_local',
    );
    expect(call?.[1]).toEqual({ projectId: 'p1', projectName: 'Cave A', latestCommitSha: 'abc123' });
    // The shared post-open tail ran, exactly as it does for a plain open.
    expect(setLinkOnOpenMock).toHaveBeenCalledWith({
      permission: 'READ_AND_WRITE',
      // The path the seed belongs to, so the `syncProjectLink` inside the load
      // that follows keeps THIS project's link instead of the previous one's.
      forPath: '/cache/p1.stalx',
      // A PULL has, by construction, nothing local the server has not seen.
      hasUnpushedEdits: false,
    });
    expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
  });

  // End to end through the REAL store action: the whole point of the dirty-bit seed
  // is that the app's exit guard is armed afterwards. Before this, "Keep the local
  // copy" produced a link claiming nothing outstanding, so menu Quit, Ctrl+Q and the
  // OS window X all walked straight past `SpeleoQuitDialog` and the edits that had
  // just refused an overwrite could be lost on the next quit.
  it('arms the quit guard after keepLocalCopy (real store seed)', async () => {
    useSpeleoStore.setState({ setLinkOnOpen: realSetLinkOnOpen });
    useUIStore.setState({ openDialog: vi.fn() as never, activeDialog: null, dialogData: {} });
    await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx');

    expect(useSpeleoStore.getState().link?.hasUnpushedEdits).toBe(true);
    // guardQuit needs a project open to guard.
    useProjectStore.setState({ project: { name: 'Cave A' } as never, isDirty: false });
    expect(guardQuit()).toBe(true);
    expect(useUIStore.getState().openDialog).toHaveBeenCalledWith('speleodb-quit');
  });

  /**
   * [#270] A superseded load is NOT a failure to roll back from.
   *
   * `loadProject` answers `success: false` for two different things, and only one
   * of them leaves the user where they were. When a newer open superseded this
   * one, the pre-attempt snapshot describes a project that is no longer on
   * screen - restoring it wrote `projectLinkKind: 'unknown'` (read-only under the
   * fail-closed gate) over the LOCAL project the user had just opened, with the
   * repair left to the unawaited, error-swallowing status refresh. Reachable:
   * GlobalView guards its remote rows with `remoteBusyRef`, but the recents-list
   * open and Publish-to-SpeleoDB have no such guard.
   */
  it('does NOT roll the link back when the load was superseded by a newer open', async () => {
    // What the newer open left behind: a local project, fully editable.
    const settled = () =>
      useSpeleoStore.setState({ link: null, projectLinkKind: 'local', linkPath: null });
    useSpeleoStore.setState({ setLinkOnOpen: realSetLinkOnOpen, projectLinkKind: 'unknown' });
    loadProjectMock.mockImplementation(async () => {
      settled();
      useProjectStore.setState({ project: { file_path: '/other/local.stalx' } as never });
      return { success: false, superseded: true };
    });
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false });
      return Promise.resolve(null);
    });

    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome).toEqual({ status: 'load_failed' });
    // The project the user actually has open is untouched - and still editable.
    expect(useSpeleoStore.getState().projectLinkKind).toBe('local');
    expect(selectSpeleoReadOnly(useSpeleoStore.getState())).toBe(false);
  });

  /**
   * [#270] `keepLocalCopy` skipped the seed for the already-open project; the two
   * other routes into the same tail did not. "Open from SpeleoDB" is in the
   * IN-PROJECT menu, so `openRemote` re-opening the current project is an ordinary
   * mis-step - and for a CLEAN open project the backend does not refuse it, so it
   * sails past the refusal prompt straight into the seed, which writes
   * `read-only` / nothing-unpushed / no-force-edit over a lock we hold.
   */
  it('openRemote seeds NOTHING when the pull names the already-open project', async () => {
    useProjectStore.setState({ project: { file_path: '/cache/p1.stalx' } as never });
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false });
      return Promise.resolve(null);
    });

    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome).toEqual({ status: 'opened' });
    expect(setLinkOnOpenMock).not.toHaveBeenCalled();
    expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
  });

  /**
   * [#270] "Open from SpeleoDB" is a way OUT of the open project - `finishOpen` ends
   * in `loadProject`, which replaces it backend-side - and it was the only one that
   * ran no guard whatsoever: not the shared `needsSpeleoHandBackPrompt` the other
   * five exits share, and not even the disk-dirty check the two file-open exits had
   * before that. It went straight to the seed and the load, so picking a DIFFERENT
   * project in the browser discarded unsaved edits with no prompt and walked away
   * from un-pushed work with the server lock still held.
   */
  describe('the entry guard - the open project is never swapped out silently', () => {
    // The pull SUCCEEDS throughout, so an ungarded open runs all the way to the load
    // that replaces the open project - i.e. these cases fail on the behavior they are
    // about, not on a half-mocked call.
    beforeEach(() => {
      invokeIpcMock.mockImplementation((cmd: string) =>
        cmd === 'speleodb_open_project'
          ? Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false })
          : Promise.resolve(null),
      );
    });

    /** Another remote project is open, its first status poll settled. */
    const anotherOpen = (link: SpeleoLinkState, isDirty = false) => {
      useProjectStore.setState({ project: { file_path: '/cache/p9.stalx' } as never, isDirty });
      useSpeleoStore.setState({ link, remoteProjectId: 'p9' });
    };

    /** The refusal message, or '' when the open went ahead. */
    const refusal = async (): Promise<string> => {
      const outcome = await hook().openRemote(SUMMARY);
      return outcome.status === 'error' ? outcome.message : '';
    };

    it('refuses over work SpeleoDB has never seen, before it fetches anything', async () => {
      anotherOpen(openLink({ hasUnpushedEdits: true }));
      const outcome = await hook().openRemote(SUMMARY);
      expect(outcome.status).toBe('error');
      // Not a dead token - there is nothing to re-login for.
      if (outcome.status === 'error') expect(outcome.reLogin).toBe(false);
      // Nothing pulled, nothing seeded, nothing loaded: the guard has to run BEFORE
      // the pull (the seed overwrites the very link it reads) and before the load
      // (which is what closes the open project backend-side).
      expect(invokeIpcMock).not.toHaveBeenCalled();
      expect(setLinkOnOpenMock).not.toHaveBeenCalled();
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    it('refuses while we still hold the write lock', async () => {
      // Nothing unpushed, but the app keeps running, so nothing else would ever
      // release it - the second half of `needsSpeleoHandBackPrompt`.
      anotherOpen(openLink({ editState: 'editing' }));
      expect(await refusal()).not.toBe('');
      expect(invokeIpcMock).not.toHaveBeenCalled();
    });

    it('refuses over unsaved-to-disk changes in a plain local project', async () => {
      useProjectStore.setState({ project: { file_path: '/cave/local.stalx' } as never, isDirty: true });
      expect(await refusal()).not.toBe('');
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    it('names the SpeleoDB side when the project is dirty in both senses', async () => {
      anotherOpen(openLink({ hasUnpushedEdits: true }), true);
      const both = await refusal();
      anotherOpen(openLink({ hasUnpushedEdits: true }));
      const speleoOnly = await refusal();
      useProjectStore.setState({ project: { file_path: '/cave/local.stalx' } as never, isDirty: true });
      useSpeleoStore.setState({ link: null, remoteProjectId: null });
      const diskOnly = await refusal();
      // Close resolves both (its prompt carries a "save changes locally" checkbox),
      // so pointing at it settles a doubly-dirty project in one hop, not two.
      expect(both).toBe(speleoOnly);
      expect(both).not.toBe(diskOnly);
    });

    it('lets a clean open project be swapped out', async () => {
      anotherOpen(openLink());
      expect(await hook().openRemote(SUMMARY)).toEqual({ status: 'opened' });
    });

    it('re-opening the project already on screen is exempt from the hand-back check', async () => {
      // Nothing is handed back to a project we are re-opening, and this is the route
      // "take the server copy and discard my local changes" reaches the hook by, over
      // a cache copy that is un-pushed BY DEFINITION. Refusing on un-pushed work here
      // would close the only door out of that state.
      useProjectStore.setState({ project: { file_path: '/cache/p1.stalx' } as never, isDirty: false });
      useSpeleoStore.setState({
        link: openLink({ hasUnpushedEdits: true, editState: 'editing' }),
        remoteProjectId: 'p1',
      });
      expect(await hook().openRemote(SUMMARY)).toEqual({ status: 'opened' });
    });

    it('still refuses re-opening the open project over unsaved-to-disk edits', async () => {
      // The exemption above covers the HAND-BACK question only. `speleodb_open_project`
      // replaces the cache `.stalx`, and `replace_cache_stalx_abandoning` closes the
      // live backend project without saving before the rename - so unsaved in-memory
      // survey is dropped. The persisted dirty bit usually makes the backend refuse
      // first, but writing it is best-effort (`mark_remote_dirty` swallows a failure)
      // and a frontend-only edit can leave `isDirty` as the only evidence.
      useProjectStore.setState({ project: { file_path: '/cache/p1.stalx' } as never, isDirty: true });
      useSpeleoStore.setState({ link: openLink(), remoteProjectId: 'p1' });

      const outcome = await hook().openRemote(SUMMARY);

      expect(outcome.status).toBe('error');
      expect(await refusal()).toMatch(/sav/i);
      // Refused BEFORE the pull, so the cache file it would have replaced is untouched.
      expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_open_project', expect.anything());
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    /**
     * [#270] The refused-open prompt's two branches are project-replacing exits of
     * their own, and they ran no guard - only whatever the `openRemote` that raised
     * the prompt had concluded, which by then is stale by an unbounded amount.
     * `SpeleoUnpushedLocalDialog` sits on screen for as long as the user takes to
     * decide, while `SpeleoStatusButton`'s interval keeps calling `refreshLinkStatus`
     * for the project underneath (30 s to a user-configurable 24 h) and its
     * `seedFromStatus` rewrites `link` wholesale - `hasUnpushedEdits`, `editState`,
     * `lockHolder`. So the project on screen can acquire un-pushed work, or have its
     * lock resolved, between the check and the load that closes it backend-side.
     *
     * The answer the user gave is no waiver: it is about the TARGET's cached copy,
     * not about the work in the project being swapped out. (This replaces a case that
     * asserted the opposite - "does not re-ask on the branches reached THROUGH a
     * guarded open" - which pinned the swap-away of an un-pushed, disk-dirty p9 as
     * correct. The half of its intent that IS correct is kept below: the same-project
     * routes must stay open.)
     */
    it('refuses keep-local when the open project goes unpushed while the prompt is up', async () => {
      // The real sequence rather than a synthetic one: the open IS guarded and the
      // project on screen is clean, so the backend's un-pushed refusal raises the
      // prompt; the status poll then lands and marks that project un-pushed while the
      // user is still reading it.
      invokeIpcMock.mockImplementation((cmd: string) =>
        cmd === 'speleodb_open_project'
          ? Promise.reject({
              message: 'refused',
              action: 'UnpushedLocalEdits',
              status: null,
              unpushed_local: {
                project_id: 'p1',
                local_path: '/cache/p1.stalx',
                last_edit_at: null,
              },
            })
          : Promise.resolve(null),
      );
      anotherOpen(openLink());
      expect(await hook().openRemote(SUMMARY)).toEqual({ status: 'unpushed_local' });

      useSpeleoStore.setState({ link: openLink({ hasUnpushedEdits: true }) });

      const outcome = await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx');
      expect(outcome.status).toBe('error');
      // Not a dead token - there is nothing to re-login for.
      if (outcome.status === 'error') expect(outcome.reLogin).toBe(false);
      // The load is what closes p9 backend-side, so it must not have run.
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    it('refuses keep-local over unsaved-to-disk changes in the project being swapped out', async () => {
      // Keeping the TARGET's local copy still ends in a `loadProject` for a different
      // file, which replaces the open project and drops its unsaved in-memory survey.
      useProjectStore.setState({
        project: { file_path: '/cave/local.stalx' } as never,
        isDirty: true,
      });
      const outcome = await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx');
      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') expect(outcome.message).toMatch(/sav/i);
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    it('keep-local still opens the path already on screen - that call replaces nothing', async () => {
      // Do-not-regress (passes before the guard was added too). This branch issues no
      // SpeleoDB command, and `loadProject` short-circuits on ALREADY_OPEN for its own
      // path - it flips the view and re-resolves the link, never re-reading the file -
      // so neither half of the guard has anything to protect, and a disk-dirty refusal
      // would raise "save your changes first" over an action that cannot lose them.
      // Driven with `remoteProjectId` deliberately UNSET: the skip is decided by path,
      // so it holds in the window before the first status poll records the open
      // project's id, where the guard's own id-based exemption does not.
      useProjectStore.setState({
        project: { file_path: '/cache/p1.stalx' } as never,
        isDirty: true,
      });
      useSpeleoStore.setState({
        link: openLink({ hasUnpushedEdits: true, editState: 'editing' }),
        remoteProjectId: null,
      });
      expect(await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx')).toEqual({ status: 'opened' });
      expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
    });

    /** The discarding re-open SUCCEEDS, so an unguarded branch runs all the way to the load. */
    const takeRemoteSucceeds = () => {
      invokeIpcMock.mockImplementation((cmd: string) =>
        cmd === 'speleodb_open_project_discarding_local'
          ? Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false })
          : Promise.resolve(null),
      );
    };

    it('refuses the take-remote when the open project goes unpushed while the prompt is up', async () => {
      takeRemoteSucceeds();
      anotherOpen(openLink({ hasUnpushedEdits: true }));
      const outcome = await hook().takeRemoteDiscardingLocal(SUMMARY);
      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') expect(outcome.reLogin).toBe(false);
      // Nothing pulled, nothing seeded, nothing loaded.
      expect(invokeIpcMock).not.toHaveBeenCalledWith(
        'speleodb_open_project_discarding_local',
        expect.anything(),
      );
      expect(setLinkOnOpenMock).not.toHaveBeenCalled();
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    it('refuses the take-remote while we still hold the write lock on the open project', async () => {
      takeRemoteSucceeds();
      anotherOpen(openLink({ editState: 'editing' }));
      const outcome = await hook().takeRemoteDiscardingLocal(SUMMARY);
      expect(outcome.status).toBe('error');
      expect(invokeIpcMock).not.toHaveBeenCalledWith(
        'speleodb_open_project_discarding_local',
        expect.anything(),
      );
    });

    it('still takes the server copy for the already-open project over its OWN un-pushed cache copy', async () => {
      // Do-not-regress (passes before the guard was added too), and the load-bearing
      // half of the case this block replaced: the hand-back exemption is the door this
      // branch exists to open, over a cache copy that is un-pushed BY DEFINITION - that
      // is why the prompt was up. Refusing here would shut the only way out of it.
      takeRemoteSucceeds();
      useProjectStore.setState({
        project: { file_path: '/cache/p1.stalx' } as never,
        isDirty: false,
      });
      useSpeleoStore.setState({
        link: openLink({ hasUnpushedEdits: true, editState: 'editing' }),
        remoteProjectId: 'p1',
      });
      expect(await hook().takeRemoteDiscardingLocal(SUMMARY)).toEqual({ status: 'opened' });
      expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
    });

    it('still refuses the take-remote for the open project over unsaved-to-disk edits', async () => {
      // Disk-dirty is NOT part of that exemption here either:
      // `speleodb_open_project_discarding_local` routes through
      // `replace_cache_stalx_abandoning`, which closes the live project WITHOUT saving
      // and renames the fresh dump over its `.stalx`. Nothing is stranded by refusing -
      // the user saves and presses it again.
      takeRemoteSucceeds();
      useProjectStore.setState({
        project: { file_path: '/cache/p1.stalx' } as never,
        isDirty: true,
      });
      useSpeleoStore.setState({ link: openLink(), remoteProjectId: 'p1' });
      const outcome = await hook().takeRemoteDiscardingLocal(SUMMARY);
      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') expect(outcome.message).toMatch(/sav/i);
      expect(invokeIpcMock).not.toHaveBeenCalledWith(
        'speleodb_open_project_discarding_local',
        expect.anything(),
      );
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    /**
     * [#270] The adopt route is the OTHER command that replaces the open project, and
     * it ran no guard of its own - only whatever `openRemote` had concluded, which by
     * then is stale by an unbounded amount. `openRemote` hands `adopt` back to the
     * HOST, which parks the summary in its own state and puts up a confirm the user
     * may sit on indefinitely, while the status poll (30 s to a user-configurable
     * 24 h) keeps writing to the very link the guard reads. `adoptRemote` is also an
     * exported entry point three components call from their own state, so its safety
     * rested on a call-site convention rather than on anything in the hook.
     *
     * Driven at the hook boundary, the way the entry-guard cases above drive
     * `openRemote`, with the adopt SUCCEEDING - so an unguarded adopt runs all the
     * way to the load that replaces the open project.
     */
    const arianeThenAdopts = () => {
      invokeIpcMock.mockImplementation((cmd: string) => {
        if (cmd === 'speleodb_open_project')
          return Promise.reject({ message: 'ariane', action: 'Adopt', status: null });
        if (cmd === 'speleodb_adopt_ariane')
          return Promise.resolve({
            local_path: '/cache/p1.stalx',
            type_flipped: true,
            concurrent_session: false,
          });
        return Promise.resolve(null);
      });
    };

    it('adoptRemote refuses over work SpeleoDB has never seen, before it adopts anything', async () => {
      arianeThenAdopts();
      anotherOpen(openLink({ hasUnpushedEdits: true }));
      const outcome = await hook().adoptRemote(SUMMARY);
      expect(outcome.status).toBe('error');
      // Not a dead token - there is nothing to re-login for.
      if (outcome.status === 'error') expect(outcome.reLogin).toBe(false);
      // Nothing adopted, nothing seeded, nothing loaded: `speleodb_adopt_ariane`
      // replaces the cache `.stalx` too, so the guard has to run before it.
      expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_adopt_ariane', expect.anything());
      expect(setLinkOnOpenMock).not.toHaveBeenCalled();
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    it('adoptRemote refuses while we still hold the write lock', async () => {
      arianeThenAdopts();
      anotherOpen(openLink({ editState: 'editing' }));
      const outcome = await hook().adoptRemote(SUMMARY);
      expect(outcome.status).toBe('error');
      expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_adopt_ariane', expect.anything());
    });

    it('adoptRemote refuses over unsaved-to-disk changes in a plain local project', async () => {
      arianeThenAdopts();
      useProjectStore.setState({ project: { file_path: '/cave/local.stalx' } as never, isDirty: true });
      const outcome = await hook().adoptRemote(SUMMARY);
      expect(outcome.status).toBe('error');
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    it('refuses the adopt when the open project goes unpushed while the confirm is up', async () => {
      // The real sequence rather than a synthetic one: the open IS guarded and the
      // project on screen is clean, so it routes to the host's adopt confirm; the
      // status poll then lands and marks that project un-pushed while the user is
      // still reading the confirm. The stale "clean" answer must not carry.
      arianeThenAdopts();
      anotherOpen(openLink());
      expect(await hook().openRemote(SUMMARY)).toEqual({ status: 'adopt' });

      useSpeleoStore.setState({ link: openLink({ hasUnpushedEdits: true }) });

      const outcome = await hook().adoptRemote(SUMMARY);
      expect(outcome.status).toBe('error');
      expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_adopt_ariane', expect.anything());
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    it('still adopts the already-open project over its OWN un-pushed cache copy', async () => {
      // The exemption is load-bearing on the adopt route too: the take-remote branch
      // routes to an adopt for a project that is un-pushed BY DEFINITION (that is why
      // the refused-open prompt was up), and it is the only way out of that state.
      // Nothing is handed back to a project we are re-adopting, so the hand-back half
      // must stay exempt - and the discard the user just confirmed is no waiver for
      // it, because it answers about the TARGET, not about the project on screen.
      arianeThenAdopts();
      useProjectStore.setState({
        project: { file_path: '/cache/p1.stalx' } as never,
        isDirty: false,
      });
      useSpeleoStore.setState({
        link: openLink({ hasUnpushedEdits: true, editState: 'editing' }),
        remoteProjectId: 'p1',
      });

      expect(await hook().adoptRemote(SUMMARY, { discardLocal: true })).toEqual({
        status: 'opened',
      });
      expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
    });

    it('still refuses re-adopting the open project over unsaved-to-disk edits', async () => {
      // Disk-dirty is NOT part of that exemption: `speleodb_adopt_ariane` replaces the
      // cache `.stalx` exactly as the open command does, dropping unsaved in-memory
      // survey with it.
      arianeThenAdopts();
      useProjectStore.setState({
        project: { file_path: '/cache/p1.stalx' } as never,
        isDirty: true,
      });
      useSpeleoStore.setState({ link: openLink(), remoteProjectId: 'p1' });

      const outcome = await hook().adoptRemote(SUMMARY);
      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') expect(outcome.message).toMatch(/sav/i);
      expect(invokeIpcMock).not.toHaveBeenCalledWith('speleodb_adopt_ariane', expect.anything());
      expect(loadProjectMock).not.toHaveBeenCalled();
    });

    /**
     * [#270] The entry check runs BEFORE the command, which is where it has to run -
     * it is the only place that can stop it. But the pull verbs' await is the
     * DOWNLOAD, and unlike the two prompt windows this branch already closed, that is
     * not a user sitting on a dialog: it is the network, on EVERY open.
     * `download_dump` gets 120 s per attempt (`DUMP_DOWNLOAD_TIMEOUT`, idempotent so
     * retried) against a 640 MB body ceiling, then the pull fetches the revision
     * history and extracts. The poll's floor is 30 s, and `SpeleoStatusButton` stays
     * MOUNTED throughout - `App` renders dialogs as siblings of `SingleSystemView`,
     * so raising the browser does not unmount the toolbar - so `refreshLinkStatus`
     * keeps landing and `seedFromStatus` rewrites `link` wholesale.
     *
     * `finishOpen` cannot be left to catch it: its first act is the optimistic seed,
     * which overwrites the very link the poll just wrote, so by the time
     * `loadProject` closes the open project the newly-discovered work is hidden and
     * the newly-discovered lock is silently released.
     */
    describe('the link changes while the pull is in flight', () => {
      /**
       * A pull that lands, with `during` standing in for the poll rewriting the store
       * WHILE the command is in flight - run synchronously inside the mock, before it
       * resolves, so the hook resumes on a link the entry check never saw.
       */
      const pullDuringWhich = (during: () => void, cmd = 'speleodb_open_project') => {
        invokeIpcMock.mockImplementation((c: string) => {
          if (c !== cmd) return Promise.resolve(null);
          during();
          return Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false });
        });
      };

      it('refuses when the open project goes unpushed during the download', async () => {
        anotherOpen(openLink());
        pullDuringWhich(() =>
          useSpeleoStore.setState({ link: openLink({ hasUnpushedEdits: true }) }),
        );

        const outcome = await hook().openRemote(SUMMARY);

        expect(outcome.status).toBe('error');
        // Not a dead token - there is nothing to re-login for.
        if (outcome.status === 'error') expect(outcome.reLogin).toBe(false);
        // The entry check DID pass, so the pull ran - this is the late half. What
        // must not run is the seed (which overwrites the link the poll just wrote)
        // and the load (which closes p9 backend-side).
        expect(invokeIpcMock).toHaveBeenCalledWith('speleodb_open_project', expect.anything());
        expect(setLinkOnOpenMock).not.toHaveBeenCalled();
        expect(loadProjectMock).not.toHaveBeenCalled();
      });

      it('refuses when the write lock on the open project resolves during the download', async () => {
        // The other disjunct of `needsSpeleoHandBackPrompt`: nothing unpushed, but we
        // now hold the lock, and the app keeps running so nothing else releases it.
        anotherOpen(openLink());
        pullDuringWhich(() => useSpeleoStore.setState({ link: openLink({ editState: 'editing' }) }));

        const outcome = await hook().openRemote(SUMMARY);

        expect(outcome.status).toBe('error');
        expect(setLinkOnOpenMock).not.toHaveBeenCalled();
        expect(loadProjectMock).not.toHaveBeenCalled();
      });

      it('still opens when nothing changed during the download', async () => {
        // Do-not-regress: the late re-check refuses on a genuine CHANGE only. A clean
        // open project that stays clean must still be swapped out, or every remote
        // open pays for the guard.
        anotherOpen(openLink());
        pullDuringWhich(() => {});

        expect(await hook().openRemote(SUMMARY)).toEqual({ status: 'opened' });
        expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
      });

      it('still opens when the pull names the project already on screen', async () => {
        // Do-not-regress, and the reason the late re-check is skipped by PATH rather
        // than run unconditionally. `replace_cache_stalx_abandoning` calls
        // `close_project_if_open_at(dest)` before the rename, so this pull has ALREADY
        // closed the open project backend-side; refusing now would leave the shell
        // rendering a project the backend does not have open, where auto-save and
        // every later command fail with "no project open". Nothing is protected by
        // refusing either - `finishOpen` skips the seed for this path, so the poll's
        // update survives, and the load re-resolves the same project's link.
        //
        // Driven through the half of the guard that is NOT exempt for the same
        // project - disk-dirty - so the path skip is the only thing that can let it
        // through.
        useProjectStore.setState({
          project: { file_path: '/cache/p1.stalx' } as never,
          isDirty: false,
        });
        useSpeleoStore.setState({ link: openLink(), remoteProjectId: 'p1' });
        pullDuringWhich(() => useProjectStore.setState({ isDirty: true }));

        expect(await hook().openRemote(SUMMARY)).toEqual({ status: 'opened' });
        expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
      });

      it('refuses the take-remote when the open project goes unpushed during ITS download', async () => {
        // Same command family, same window: `speleodb_open_project_discarding_local`
        // waives the guard for the TARGET's cache copy, which says nothing about the
        // work in the project being swapped out.
        anotherOpen(openLink());
        pullDuringWhich(
          () => useSpeleoStore.setState({ link: openLink({ hasUnpushedEdits: true }) }),
          'speleodb_open_project_discarding_local',
        );

        const outcome = await hook().takeRemoteDiscardingLocal(SUMMARY);

        expect(outcome.status).toBe('error');
        if (outcome.status === 'error') expect(outcome.reLogin).toBe(false);
        expect(setLinkOnOpenMock).not.toHaveBeenCalled();
        expect(loadProjectMock).not.toHaveBeenCalled();
      });

      it('does NOT refuse the adopt when the link changes during it', async () => {
        // DO-NOT-REGRESS on a deliberate asymmetry, so nobody "fixes the drift" by
        // adding the late re-check to the adopt as well. The window is identical, but
        // `speleodb_adopt_ariane` rebuilds its destination through
        // `adopt_import_and_save` -> `do_create_project_full`, which commits the new
        // project into `AppState` UNCONDITIONALLY - for every target, not only a
        // re-adopt of the open one. The swap has therefore already happened by the
        // time this resolves, and refusing would not undo it: it would leave the shell
        // rendering the old project while every edit and every auto-save landed on the
        // adopted one. Going through with the load is the lesser failure. Closing this
        // window has to start in `speleodb_adopt_ariane`.
        anotherOpen(openLink());
        invokeIpcMock.mockImplementation((c: string) => {
          if (c !== 'speleodb_adopt_ariane') return Promise.resolve(null);
          useSpeleoStore.setState({ link: openLink({ hasUnpushedEdits: true }) });
          return Promise.resolve({
            local_path: '/cache/p1.stalx',
            type_flipped: true,
            concurrent_session: false,
          });
        });

        expect(await hook().adoptRemote(SUMMARY)).toEqual({ status: 'opened' });
        expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
      });
    });
  });

  /**
   * DO-NOT-REGRESS. Both "is this the project already on screen?" tests in the hook
   * (`finishOpen`'s `alreadyOpen`, `keepLocalCopy`'s skip) compare paths as LITERAL
   * strings, and that is the point rather than an oversight: they predict whether
   * `loadProject` will short-circuit, and the backend decides that with the same
   * literal test (`do_load_project_full`: `project.file_path.as_ref() ==
   * Some(&path)`). An alias the backend cannot see through must therefore take the
   * NOT-already-open branch on this side too - the reload really does happen, so the
   * seed really is needed and the guard really does have something to protect.
   *
   * These cases fail the moment someone "fixes" either site with canonicalization or
   * a narrower normalization (collapsing `.`/`..`, case-folding): the first would
   * skip a seed the reload needs, the second would skip a guard that is standing in
   * front of unsaved in-memory survey. The webview has no filesystem to canonicalize
   * with in any case; alias tolerance would have to start in `do_load_project_full`
   * (`project_io::same_file`), with this side following.
   */
  describe('path spellings the backend would not match either', () => {
    it('openRemote still seeds when the open project is spelled differently', async () => {
      // Same file, dot-segment spelling. `do_load_project_full` compares literally,
      // so it reloads - and a reload with no seed resolves through `syncProjectLink`
      // to read-only / nothing-unpushed, dropping the permission on the floor.
      useProjectStore.setState({ project: { file_path: '/cache/./p1.stalx' } as never });
      invokeIpcMock.mockImplementation((cmd: string) =>
        cmd === 'speleodb_open_project'
          ? Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false })
          : Promise.resolve(null),
      );

      expect(await hook().openRemote(SUMMARY)).toEqual({ status: 'opened' });
      expect(setLinkOnOpenMock).toHaveBeenCalledWith({
        permission: 'READ_AND_WRITE',
        forPath: '/cache/p1.stalx',
        hasUnpushedEdits: false,
      });
    });

    it('keepLocalCopy still guards when the open project is spelled differently', async () => {
      // Case alias - the same file on Windows/macOS, and NOT what the backend's
      // literal check matches. So this ends in a full reload that drops the unsaved
      // in-memory survey, which is precisely what the disk-dirty refusal is for.
      useProjectStore.setState({
        project: { file_path: '/cache/P1.stalx' } as never,
        isDirty: true,
      });

      const outcome = await hook().keepLocalCopy(SUMMARY, '/cache/p1.stalx');

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') expect(outcome.message).toMatch(/sav/i);
      expect(loadProjectMock).not.toHaveBeenCalled();
    });
  });

  it('adoptRemote adopts, loads, and reports opened', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_adopt_ariane')
        return Promise.resolve({
          local_path: '/cache/p1.stalx',
          type_flipped: true,
          concurrent_session: false,
        });
      return Promise.resolve(null);
    });
    const outcome = await hook().adoptRemote(SUMMARY);
    expect(outcome).toEqual({ status: 'opened' });
    const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_adopt_ariane');
    expect(call?.[1]).toEqual({
      projectId: 'p1',
      projectName: 'Cave A',
      latestCommitSha: 'abc123',
      // The ordinary open->adopt route has confirmed no discard, so the backend's
      // un-pushed-edits guard stays armed for it.
      discardLocal: false,
    });
  });

  /**
   * [#270] An adopt is not a plain pull: the backend stamps the adopted `.stalx`
   * `has_unpushed_edits: true` (it has just converted an Ariane .tml into a
   * project the server has never been given). The shared seed defaults to the
   * pull's answer - nothing outstanding - which is the exact flag `guardQuit` and
   * `useProject`'s close guard read, so BOTH exit guards stayed disarmed over work
   * that exists only locally. The only repair was the unawaited, error-swallowing
   * status refresh: never, offline.
   */
  it('adoptRemote seeds the dirty bit TRUE - the adopted copy is unpushed by construction', async () => {
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_adopt_ariane')
        return Promise.resolve({
          local_path: '/cache/p1.stalx',
          type_flipped: true,
          concurrent_session: false,
        });
      return Promise.resolve(null);
    });

    await hook().adoptRemote(SUMMARY);

    expect(setLinkOnOpenMock).toHaveBeenCalledWith({
      permission: 'READ_AND_WRITE',
      forPath: '/cache/p1.stalx',
      hasUnpushedEdits: true,
    });
  });

  // End to end through the REAL seed, since the point is the state the exit guards
  // are left reading (mirrors the keepLocalCopy case above).
  it('arms the quit guard after adoptRemote (real store seed)', async () => {
    useSpeleoStore.setState({ setLinkOnOpen: realSetLinkOnOpen });
    useUIStore.setState({ openDialog: vi.fn() as never, activeDialog: null, dialogData: {} });
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_adopt_ariane')
        return Promise.resolve({
          local_path: '/cache/p1.stalx',
          type_flipped: false,
          concurrent_session: false,
        });
      return Promise.resolve(null);
    });

    await hook().adoptRemote(SUMMARY);

    expect(useSpeleoStore.getState().link?.hasUnpushedEdits).toBe(true);
    useProjectStore.setState({ project: { name: 'Cave A' } as never, isDirty: false });
    expect(guardQuit()).toBe(true);
    expect(useUIStore.getState().openDialog).toHaveBeenCalledWith('speleodb-quit');
  });

  /**
   * [#214/#270] The take-remote branch had to grow the Ariane route `openRemote`
   * already had, and to carry the discard the user just confirmed into the adopt.
   *
   * Both halves are needed and neither is hypothetical: an adopt stamps the cache
   * copy un-pushed and the server `type` flip is best-effort, so an adopt without
   * write access leaves a project that is BOTH dirty locally (raising the refused-
   * open prompt) and still classified Ariane (so taking the server copy lands on
   * AdoptAriane). Without the route the user hit a flat "this project is an Ariane
   * project" error with nothing opened; with the route but no waiver, the adopt's
   * own guard then refused the discard they had already confirmed.
   */
  describe('takeRemoteDiscardingLocal on a still-Ariane project', () => {
    const arianeRefusal = () => {
      invokeIpcMock.mockImplementation((cmd: string) => {
        if (cmd === 'speleodb_open_project_discarding_local')
          return Promise.reject({ message: 'ariane', action: 'Adopt' });
        if (cmd === 'speleodb_adopt_ariane')
          return Promise.resolve({
            local_path: '/cache/p1.stalx',
            type_flipped: false,
            concurrent_session: false,
          });
        return Promise.resolve(null);
      });
    };

    it('routes to adoption instead of dead-ending on the raw error', async () => {
      arianeRefusal();
      const outcome = await hook().takeRemoteDiscardingLocal(SUMMARY);
      expect(outcome).toEqual({ status: 'adopt', discardLocal: true });
    });

    it('and that adoption waives the guard the user already answered', async () => {
      arianeRefusal();
      await hook().adoptRemote(SUMMARY, { discardLocal: true });
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_adopt_ariane');
      expect(call?.[1]).toMatchObject({ discardLocal: true });
    });
  });
});
