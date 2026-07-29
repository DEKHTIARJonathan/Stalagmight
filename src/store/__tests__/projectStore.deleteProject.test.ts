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
    useProjectStore.setState({ recentProjects: [], config: null });
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
