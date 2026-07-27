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
import { useSpeleoStore, selectSpeleoReadOnly } from '../store/speleoStore';
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
