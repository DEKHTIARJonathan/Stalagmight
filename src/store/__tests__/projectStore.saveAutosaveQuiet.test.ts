import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useUIStore } from '../uiStore';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

/**
 * `saveProject(path, isAutosave)`'s second argument is FRONTEND-ONLY - it never
 * crosses IPC, and the backend save is identical either way. It exists solely to
 * keep the 30-second debounced background save quiet:
 *
 *  1. a folder-access denial must NOT reopen the save-permission dialog on every
 *     retry (the user would be unable to do anything else while access is denied), and
 *  2. a clean autosave must NOT trigger a post-save integrity re-check, which on a
 *     large project is real churn for no new information.
 *
 * Neither guard had a test, which is how a refactor briefly removed both. This
 * pins them.
 */
describe('saveProject autosave quieting', () => {
  let openDialogSpy: ReturnType<typeof vi.fn>;
  let checkIntegritySpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    openDialogSpy = vi.fn();
    checkIntegritySpy = vi.fn().mockResolvedValue(undefined);
    useUIStore.setState({ openDialog: openDialogSpy } as never);
    useProjectStore.setState({
      project: { file_path: '/cave.stalx' } as never,
      integrityIssues: [],
      integritySaveBlocked: false,
      refreshUndoState: vi.fn().mockResolvedValue(undefined),
      refreshProjectState: vi.fn().mockResolvedValue(undefined),
      checkProjectIntegrity: checkIntegritySpy,
    } as never);
  });

  afterEach(() => {
    useProjectStore.setState({ project: null, isDirty: false } as never);
  });

  const resolveSave = () => {
    invokeIpcMock.mockImplementation(async (command: string) =>
      command === 'save_project' ? { success: true, saved_path: '/cave.stalx' } : undefined
    );
  };

  const denyPermission = () => {
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'save_project') {
        return { success: false, error: 'FS_PERMISSION_DENIED: folder access denied' };
      }
      return undefined;
    });
  };

  it('does not reopen the save-permission dialog on an autosave', async () => {
    denyPermission();

    await useProjectStore.getState().saveProject('/cave.stalx', true);

    expect(openDialogSpy).not.toHaveBeenCalledWith('save-permission', expect.anything());
    // The failure is not swallowed - it feeds the autosave-failure banner,
    // without leaking the raw FS_PERMISSION_DENIED marker.
    const banner = useProjectStore.getState().autosaveFailure;
    expect(banner).toBeTruthy();
    expect(banner).not.toContain('FS_PERMISSION_DENIED');
  });

  it('DOES open the save-permission dialog on a manual save', async () => {
    denyPermission();

    await useProjectStore.getState().saveProject('/cave.stalx');

    expect(openDialogSpy).toHaveBeenCalledWith('save-permission', expect.anything());
  });

  it('skips the post-save integrity re-check on a clean autosave', async () => {
    resolveSave();

    await useProjectStore.getState().saveProject('/cave.stalx', true);

    expect(checkIntegritySpy).not.toHaveBeenCalled();
  });

  it('still re-checks integrity on a manual save', async () => {
    resolveSave();

    await useProjectStore.getState().saveProject('/cave.stalx');

    expect(checkIntegritySpy).toHaveBeenCalled();
  });

  it('never sends isAutosave over IPC - the backend save is identical either way', async () => {
    resolveSave();

    await useProjectStore.getState().saveProject('/cave.stalx', true);

    const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'save_project');
    expect(call?.[1]).toEqual({ path: '/cave.stalx' });
  });
});
