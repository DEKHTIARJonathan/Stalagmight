import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
const performQuit = vi.hoisted(() => vi.fn());
const abandonUpdateRestart = vi.hoisted(() => vi.fn());
vi.mock('../../utils/quit', () => ({ performQuit, abandonUpdateRestart }));
import SpeleoQuitDialog from './SpeleoQuitDialog';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

const closeProject = vi.fn(async (_options?: unknown) => {
  useProjectStore.setState({ project: null });
  return { success: true };
});
const saveProject = vi.fn();
const closeDialog = vi.fn();
const openDialog = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  closeProject.mockImplementation(async () => { useProjectStore.setState({ project: null }); return { success: true }; });
  useProjectStore.setState({ project: { file_path: '/synthetic/local.stalx' } as never,
    isDirty: true, closeProject: closeProject as never, saveProject });
  useSpeleoStore.setState({ busy: false });
  useUIStore.setState({ activeDialog: 'speleodb-quit', dialogData: {}, closeDialog, openDialog });
});

it('offers discard and cancel without uploading or keeping the lock', () => {
  render(<SpeleoQuitDialog />);
  expect(screen.getByTestId('speleodb-quit-discard')).toBeEnabled();
  expect(screen.getByTestId('speleodb-quit-cancel')).toBeEnabled();
  expect(screen.queryByTestId('speleodb-quit-keep-lock')).toBeNull();
  expect(screen.queryByTestId('speleodb-quit-push-release')).toBeNull();
});

it('discard closes without saving before requesting quit', async () => {
  render(<SpeleoQuitDialog />);
  fireEvent.click(screen.getByTestId('speleodb-quit-discard'));
  await waitFor(() => expect(performQuit).toHaveBeenCalledOnce());
  expect(closeProject).toHaveBeenCalledWith({ request: expect.any(Number) });
  expect(saveProject).not.toHaveBeenCalled();
});

it('cancel preserves the project and restores a displaced dialog', () => {
  const cancelReturnsData = { draft: 'kept' };
  useUIStore.setState({ dialogData: { cancelReturnsTo: 'settings', cancelReturnsData } });
  render(<SpeleoQuitDialog />);
  fireEvent.click(screen.getByTestId('speleodb-quit-cancel'));
  expect(openDialog).toHaveBeenCalledWith('settings', cancelReturnsData);
  expect(abandonUpdateRestart).toHaveBeenCalledOnce();
  expect(closeProject).not.toHaveBeenCalled();
  expect(performQuit).not.toHaveBeenCalled();
});

it('failed close never quits', async () => {
  closeProject.mockResolvedValue({ success: false });
  render(<SpeleoQuitDialog />);
  await act(async () => fireEvent.click(screen.getByTestId('speleodb-quit-discard')));
  expect(performQuit).not.toHaveBeenCalled();
  expect(screen.getByTestId('speleodb-quit-error')).toHaveTextContent('Could not close');
  expect(screen.getByTestId('speleodb-quit-cancel')).toBeEnabled();
  expect(closeDialog).not.toHaveBeenCalled();
});

it('ignores duplicate clicks and a stale close completion', async () => {
  let resolve!: (value: { success: boolean }) => void;
  closeProject.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<SpeleoQuitDialog />);
  fireEvent.click(screen.getByTestId('speleodb-quit-discard'));
  fireEvent.click(screen.getByTestId('speleodb-quit-discard'));
  expect(closeProject).toHaveBeenCalledOnce();
  useUIStore.setState({ dialogData: { replacement: true } });
  await act(async () => resolve({ success: true }));
  expect(performQuit).not.toHaveBeenCalled();
});
