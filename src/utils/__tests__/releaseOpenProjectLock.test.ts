import { beforeEach, expect, it, vi } from 'vitest';
import { releaseOpenProjectLock } from '../releaseOpenProjectLock';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

const ipc = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
const reconcile = vi.hoisted(() => vi.fn());
vi.mock('../speleoTreeReplacement', () => ({ applySpeleoTreeReplacement: reconcile }));
vi.mock('../ipc', () => ({ invokeIpc: ipc, getErrorMessage: (e: Error) => e.message }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: confirmMock }));
const path = '/synthetic/project.stalx';
const close = vi.fn();
const load = vi.fn();
const refresh = vi.fn();
const errorDialog = vi.fn();
const context = { session: 'synthetic' };

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
  reconcile.mockResolvedValue(true);
  ipc.mockImplementation(async (cmd) => cmd === 'speleodb_project_access_at' ? { release_context: context } : null);
  close.mockResolvedValue({ success: true });
  load.mockResolvedValue({ success: true });
  refresh.mockResolvedValue(undefined);
  useProjectStore.setState({ project: { file_path: path } as never, isDirty: false, closeProject: close, loadProject: load });
  useSpeleoStore.setState({ busy: false, sessionGeneration: 0, refreshLinkStatus: refresh });
  useUIStore.setState({ openDialog: errorDialog, showToast: vi.fn() });
});

it('releases saved unpushed work without uploading, confirmation, or closing', async () => {
  useSpeleoStore.setState({ link: { editState: 'editing', hasUnpushedEdits: true, lockHolder: 'me@example.com' } as never });
  await releaseOpenProjectLock();
  expect(useSpeleoStore.getState().link).toMatchObject({ editState: 'read-only', hasUnpushedEdits: true, lockHolder: null });
  expect(confirmMock).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(ipc.mock.calls.map(([cmd]) => cmd)).toEqual(['speleodb_project_access_at', 'speleodb_release_current_lock']);
  expect(ipc).toHaveBeenLastCalledWith('speleodb_release_current_lock', {
    ownOnly: true, allowUnpushed: true, expected: context, discardUnsaved: false,
  });
  expect(refresh).toHaveBeenCalledOnce();
});

it('cancelling discard leaves unsaved work and its lock untouched', async () => {
  useProjectStore.setState({ isDirty: true });
  confirmMock.mockResolvedValue(false);
  await releaseOpenProjectLock();
  expect(close).not.toHaveBeenCalled();
  expect(ipc).not.toHaveBeenCalled();
});

it('atomically discards unsaved changes and reconciles the local tree without reopening', async () => {
  useProjectStore.setState({ isDirty: true });
  await releaseOpenProjectLock();
  expect(close).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(ipc).toHaveBeenLastCalledWith('speleodb_release_current_lock', expect.objectContaining({ discardUnsaved: true }));
  expect(reconcile).toHaveBeenCalledWith(expect.anything(), true);
});

it('keeps the view intact when release fails and refreshes its lock status', async () => {
  useProjectStore.setState({ isDirty: true });
  ipc.mockImplementation(async (cmd) => {
    if (cmd === 'speleodb_project_access_at') return { release_context: context };
    throw new Error('Release failed');
  });
  await releaseOpenProjectLock();
  expect(reconcile).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledOnce();
  expect(errorDialog).toHaveBeenCalledWith('error', expect.anything());
});

it('does not release a replacement project after the discard prompt', async () => {
  useProjectStore.setState({ isDirty: true });
  confirmMock.mockImplementation(async () => {
    useProjectStore.setState({ project: { file_path: '/other.stalx' } as never });
    return true;
  });
  await releaseOpenProjectLock();
  expect(close).not.toHaveBeenCalled();
  expect(ipc).not.toHaveBeenCalled();
});
