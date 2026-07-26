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

import { useOpenRemoteProject } from './useOpenRemoteProject';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import type { SpeleoProjectSummary } from '../types/ipc.generated';

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
let clearLinkMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  loadProjectMock = vi.fn(async () => ({ success: true }));
  setLinkOnOpenMock = vi.fn();
  clearLinkMock = vi.fn();
  useProjectStore.setState({ loadProject: loadProjectMock });
  useSpeleoStore.setState({ setLinkOnOpen: setLinkOnOpenMock, clearLink: clearLinkMock });
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

  it('rolls the link back when the pulled project fails to load', async () => {
    loadProjectMock.mockResolvedValue({ success: false });
    invokeIpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'speleodb_open_project')
        return Promise.resolve({ local_path: '/cache/p1.stalx', concurrent_session: false });
      return Promise.resolve(null);
    });
    const outcome = await hook().openRemote(SUMMARY);
    expect(outcome).toEqual({ status: 'load_failed' });
    expect(clearLinkMock).toHaveBeenCalled();
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
    });
    expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1.stalx');
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
    expect(call?.[1]).toEqual({ projectId: 'p1', projectName: 'Cave A', latestCommitSha: 'abc123' });
  });
});
