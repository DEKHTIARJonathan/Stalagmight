import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsMock = vi.hoisted(() => vi.fn());
const saveDialogMock = vi.hoisted(() => vi.fn());
const surfaceSaveFailureMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-fs', () => ({ exists: existsMock }));
vi.mock('../fileDialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fileDialogs')>()),
  saveDialog: saveDialogMock,
}));
vi.mock('../saveFeedback', () => ({
  surfaceSaveFailure: surfaceSaveFailureMock,
}));

import { saveProjectAs } from '../projectActions';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';

/**
 * [#576 E10 / NF-SAVEAS] The Save As overwrite guard is the only thing between
 * the user and replacing an existing survey file, and it had no test at any tier
 * (the Playwright mock answers every `exists` with false). The pins below fix
 * all three outcomes of the existence probe - including the one that used to
 * fail OPEN: a probe that throws (permissions, a sandbox scope, a network drive)
 * must ask exactly like a probe that says "it exists" (E10-D1, "Ask (fail
 * closed)"), never save over the path unasked.
 */
describe('saveProjectAs overwrite guard', () => {
  let openDialog: ReturnType<typeof vi.fn>;
  let saveProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    saveDialogMock.mockResolvedValue('/home/diver/CaveA.stalx');
    openDialog = vi.fn();
    saveProject = vi.fn(async () => ({ success: true, saved_path: '/home/diver/CaveA.stalx' }));
    useUIStore.setState({ openDialog } as never);
    useProjectStore.setState({ saveProject } as never);
  });

  it('asks before replacing a file that exists, and does not save', async () => {
    existsMock.mockResolvedValue(true);

    expect(await saveProjectAs()).toBeNull();

    expect(saveProject).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledWith('confirm-overwrite', {
      path: '/home/diver/CaveA.stalx',
      fileName: 'CaveA.stalx',
      closeAfterSave: false,
    });
  });

  it('saves straight away when the file does not exist', async () => {
    existsMock.mockResolvedValue(false);

    const result = await saveProjectAs();

    expect(result?.success).toBe(true);
    expect(saveProject).toHaveBeenCalledWith('/home/diver/CaveA.stalx');
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('asks (fail closed) when the existence check itself fails, and does not save', async () => {
    existsMock.mockRejectedValue(new Error('permission denied'));

    expect(await saveProjectAs()).toBeNull();

    expect(saveProject).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledWith('confirm-overwrite', {
      path: '/home/diver/CaveA.stalx',
      fileName: 'CaveA.stalx',
      closeAfterSave: false,
      existenceUnknown: true,
    });
  });

  it('carries Save and Close through the fail-closed prompt', async () => {
    existsMock.mockRejectedValue(new Error('network drive unreachable'));

    await saveProjectAs({ closeAfterSave: true });

    expect(saveProject).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledWith(
      'confirm-overwrite',
      expect.objectContaining({ closeAfterSave: true, existenceUnknown: true }),
    );
  });

  it('checks the name it will write, not the name the dialog returned', async () => {
    saveDialogMock.mockResolvedValue('/home/diver/CaveA');
    existsMock.mockResolvedValue(true);

    await saveProjectAs();

    expect(existsMock).toHaveBeenCalledWith('/home/diver/CaveA.stalx');
    expect(openDialog).toHaveBeenCalledWith(
      'confirm-overwrite',
      expect.objectContaining({ path: '/home/diver/CaveA.stalx' }),
    );
  });
});
