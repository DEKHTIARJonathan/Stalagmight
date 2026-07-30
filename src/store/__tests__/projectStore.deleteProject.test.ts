import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

const PATH = '/projects/cave-alpha.stalx';

describe('projectStore.deleteProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'delete_project') return { success: true };
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

  it('leaves a DIFFERENT open project alone', async () => {
    // Deleting a recent that is not the open project must not close the one the
    // user is working in - that would throw away its undo history for nothing.
    const project = { file_path: '/projects/other.stalx' } as never;
    useProjectStore.setState({ project, databaseOpen: true } as never);

    const result = await useProjectStore.getState().deleteProject(PATH);

    expect(result.success).toBe(true);
    expect(useProjectStore.getState().project).toBe(project);
    expect(useProjectStore.getState().databaseOpen).toBe(true);
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
