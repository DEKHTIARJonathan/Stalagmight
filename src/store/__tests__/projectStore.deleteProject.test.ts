import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

const PATH = '/projects/cave-alpha.stalx';

/**
 * A truthy `get_project_state` payload - the backend still HAS a project open.
 * `deleteProject` only tests it for truthiness (it does not adopt the state), so
 * the shape only has to be plausible, not complete.
 */
const backendStillHasAProject = { project: { file_path: PATH }, stations: [], stats: null, frozen_shots: [] };

describe('projectStore.deleteProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the delete succeeds and the backend reports NO open project - the
    // shape of every case where the deleted `.stalx` was the open one, since the
    // backend closes its session as part of the delete.
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'delete_project') return { success: true };
      if (command === 'get_project_state') return null;
      if (command === 'list_recent_projects') return [];
      if (command === 'get_config') return { general: { recent_projects: [] } };
      return undefined;
    });
    useProjectStore.setState({ recentProjects: [], config: null, project: null });
  });

  it('calls delete_project with the path and refreshes recents + config on success', async () => {
    const result = await useProjectStore.getState().deleteProject(PATH);

    expect(result.success).toBe(true);
    expect(invokeIpcMock).toHaveBeenCalledWith('delete_project', { path: PATH }, expect.any(Object));
    // The refresh (so the deleted project leaves both available and "missing" rows)
    // fires only on success.
    expect(invokeIpcMock).toHaveBeenCalledWith('list_recent_projects', undefined, expect.any(Object));
    expect(invokeIpcMock).toHaveBeenCalledWith('get_config', undefined, expect.any(Object));
    // Nothing was open, so there is nothing to reconcile: the "did that close the
    // open project?" round trip is skipped on the common global-view delete.
    expect(invokeIpcMock).not.toHaveBeenCalledWith('get_project_state', undefined, expect.any(Object));
  });

  it('does not refresh recents when the delete fails', async () => {
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'delete_project') return { success: false, error: 'boom' };
      return undefined;
    });

    const result = await useProjectStore.getState().deleteProject(PATH);

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(invokeIpcMock).not.toHaveBeenCalledWith('list_recent_projects', undefined, expect.any(Object));
  });

  it('closes the project when the deleted file is the OPEN one', async () => {
    // The backend tears its own session down (project, SQLite handle, undo stack)
    // before handing the `.stalx` to the OS delete, so the frontend has to follow.
    // Leaving `project` set kept the UI rendering a project whose file is gone -
    // and the next autosave tick failed with "No project open".
    useProjectStore.setState({
      project: { file_path: PATH } as never,
      databaseOpen: true,
      isDirty: true,
      stations: [{} as never],
      integrityIssues: ['something'],
    } as never);

    const result = await useProjectStore.getState().deleteProject(PATH);

    expect(result.success).toBe(true);
    const state = useProjectStore.getState();
    expect(state.project).toBeNull();
    expect(state.databaseOpen).toBe(false);
    expect(state.isDirty).toBe(false);
    expect(state.stations).toEqual([]);
    expect(state.integrityIssues).toEqual([]);
  });

  it('closes the project when the delete FAILS after the backend already closed it', async () => {
    // The backend closes BEFORE handing the file to the OS trash - it must, since
    // SQLite holds the file open without FILE_SHARE_DELETE and the Windows trash
    // would be denied while that handle lives. So a trash that is then denied for
    // some other reason returns FAILURE with the session already gone. Guarding
    // the frontend teardown on `result.success` left a phantom project behind,
    // and the next save or edit failed with "No project open".
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'delete_project') return { success: false, error: 'Access is denied' };
      if (command === 'get_project_state') return null;
      return undefined;
    });
    useProjectStore.setState({
      project: { file_path: PATH } as never,
      databaseOpen: true,
      isDirty: true,
      stations: [{} as never],
    } as never);

    const result = await useProjectStore.getState().deleteProject(PATH);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Access is denied');
    const state = useProjectStore.getState();
    expect(state.project).toBeNull();
    expect(state.databaseOpen).toBe(false);
    expect(state.stations).toEqual([]);
    // The file survives a failed delete, so recents must still NOT be refreshed.
    expect(invokeIpcMock).not.toHaveBeenCalledWith('list_recent_projects', undefined, expect.any(Object));
  });

  it('closes the project when the delete names it by a DIFFERENT path spelling', async () => {
    // The backend matches with `same_file`, which canonicalizes: a symlink, a `..`
    // segment or a Windows case / short-name variant of the open project's path
    // still tears the session down. A `===` on the raw strings does not see that,
    // and left the frontend rendering a project the backend no longer had.
    const open = '/projects/cave.stalx';
    const alias = '/projects/../projects/cave.stalx';
    useProjectStore.setState({
      project: { file_path: open } as never,
      databaseOpen: true,
      stations: [{} as never],
    } as never);

    const result = await useProjectStore.getState().deleteProject(alias);

    expect(result.success).toBe(true);
    const state = useProjectStore.getState();
    expect(state.project).toBeNull();
    expect(state.databaseOpen).toBe(false);
    expect(state.stations).toEqual([]);
  });

  it('leaves a DIFFERENT open project alone', async () => {
    // Deleting a recent that is not the open project must not close the one the
    // user is working in - that would throw away its undo history for nothing.
    // The backend still reporting a project is what proves the delete hit some
    // other file, so this is the case the reconciliation must NOT act on.
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'delete_project') return { success: true };
      if (command === 'get_project_state') return backendStillHasAProject;
      if (command === 'list_recent_projects') return [];
      if (command === 'get_config') return { general: { recent_projects: [] } };
      return undefined;
    });
    const project = { file_path: '/projects/other.stalx' } as never;
    useProjectStore.setState({ project, databaseOpen: true } as never);

    const result = await useProjectStore.getState().deleteProject(PATH);

    expect(result.success).toBe(true);
    expect(useProjectStore.getState().project).toBe(project);
    expect(useProjectStore.getState().databaseOpen).toBe(true);
  });

  it('reports the real delete result when the state check itself throws', async () => {
    // A throwing reconciliation must not be rewritten into `success: false`: that
    // skips the recents refresh and strands the "File not found" zombie row the
    // backend deliberately avoids. Unconfirmed means leave the state as it stands.
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'delete_project') return { success: true };
      if (command === 'get_project_state') throw new Error('ipc exploded');
      if (command === 'list_recent_projects') return [];
      if (command === 'get_config') return { general: { recent_projects: [] } };
      return undefined;
    });
    const project = { file_path: PATH } as never;
    useProjectStore.setState({ project, databaseOpen: true } as never);

    const result = await useProjectStore.getState().deleteProject(PATH);

    expect(result.success).toBe(true);
    expect(useProjectStore.getState().project).toBe(project);
    expect(invokeIpcMock).toHaveBeenCalledWith('list_recent_projects', undefined, expect.any(Object));
  });

  it('surfaces a thrown IPC error as a failed result', async () => {
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'delete_project') throw new Error('ipc exploded');
      return undefined;
    });

    const result = await useProjectStore.getState().deleteProject(PATH);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ipc exploded');
  });
});
