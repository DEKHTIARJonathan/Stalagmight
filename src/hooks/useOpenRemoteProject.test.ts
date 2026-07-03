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
  useUIStore.setState({ showToast: vi.fn() });
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
    expect(setLinkOnOpenMock).toHaveBeenCalledWith({ permission: 'READ_AND_WRITE' });
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
