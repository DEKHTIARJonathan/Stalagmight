import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useSpeleoStore } from '../speleoStore';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

describe('projectStore warning edits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'get_project_warnings') return [];
      return undefined;
    });
    useSpeleoStore.setState({
      link: {
        permission: 'write',
        editState: 'editing',
        lockHolder: null,
        lockedByOther: false,
        hasUnpushedEdits: true,
        unwound: true,
        forceEditing: false,
        undoMode: 'full',
        undoModeOverridden: true,
        forceEditAllowed: false,
        remoteState: 'dirty',
        noAccess: false,
        serverError: null,
      },
    });
  });

  it('mirrors a resolved warning as a forward edit immediately', async () => {
    await expect(
      useProjectStore.getState().resolveWarning(1, 2, 'distance', 'checked'),
    ).resolves.toBe(true);

    expect(useSpeleoStore.getState().link?.unwound).toBe(false);
  });

  it('mirrors an unresolved warning as a forward edit immediately', async () => {
    await useProjectStore.getState().unresolveWarning(1, 2, 'distance');

    expect(useSpeleoStore.getState().link?.unwound).toBe(false);
  });
});
