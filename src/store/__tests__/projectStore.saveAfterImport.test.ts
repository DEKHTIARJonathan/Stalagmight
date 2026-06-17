import { afterEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import type { CommandResult } from '../../types/commands';

/**
 * #92: a DMP import never marks the project dirty and a new project's initial
 * save is deferred, so the import is only persisted because the completion
 * handlers call `saveAfterImport`. These guard that action's contract: it saves,
 * and it never throws (so a save failure can't block post-import navigation).
 */
describe('projectStore.saveAfterImport (#92)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the imported project by calling saveProject (default = manual-save semantics)', async () => {
    const saveMock = vi.fn(async (): Promise<CommandResult> => ({ success: true } as CommandResult));
    useProjectStore.setState({ saveProject: saveMock });

    await useProjectStore.getState().saveAfterImport();

    expect(saveMock).toHaveBeenCalledTimes(1);
    // No args → a regular (non-autosave) save: writes the .stalx and adds it to
    // Recent Projects, mirroring the manual Save users hit today.
    expect(saveMock).toHaveBeenCalledWith();
  });

  it('swallows a save failure so post-import navigation is never blocked', async () => {
    const saveMock = vi.fn(async (): Promise<CommandResult> => {
      throw new Error('disk full');
    });
    useProjectStore.setState({ saveProject: saveMock });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(useProjectStore.getState().saveAfterImport()).resolves.toBeUndefined();

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });
});
