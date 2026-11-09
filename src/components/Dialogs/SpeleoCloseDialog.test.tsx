import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SpeleoCloseDialog from './SpeleoCloseDialog';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

const probe = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../utils/confirmSpeleoOpen', () => ({ confirmSpeleoFileOpen: probe }));
const closeProject = vi.fn(async (_options?: unknown) => ({ success: true }));
const loadProject = vi.fn(async () => ({ success: true }));
const saveProject = vi.fn();
const closeDialog = vi.fn();
const openDialog = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  probe.mockResolvedValue(true);
  closeProject.mockResolvedValue({ success: true });
  useProjectStore.setState({ project: { file_path: '/synthetic/local.stalx' } as never,
    isDirty: true, closeProject: closeProject as never, loadProject: loadProject as never, saveProject });
  useSpeleoStore.setState({ busy: false });
  useUIStore.setState({ activeDialog: 'speleodb-close', dialogData: {}, closeDialog, openDialog });
});

it('offers only discard and cancel without upload, save, or keep-lock controls', () => {
  render(<SpeleoCloseDialog />);
  expect(screen.getByTestId('speleodb-close-discard')).toBeEnabled();
  expect(screen.getByTestId('speleodb-close-cancel')).toBeEnabled();
  expect(screen.queryByTestId('speleodb-close-message')).toBeNull();
  expect(screen.queryByTestId('speleodb-close-keep-lock')).toBeNull();
  expect(screen.queryByTestId('speleodb-close-push-release')).toBeNull();
});

it('cancel leaves the project and lock alone', () => {
  render(<SpeleoCloseDialog />);
  fireEvent.click(screen.getByTestId('speleodb-close-cancel'));
  expect(closeDialog).toHaveBeenCalledOnce();
  expect(closeProject).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
});

it('discard closes without saving and uses the automatic release default', async () => {
  render(<SpeleoCloseDialog />);
  fireEvent.click(screen.getByTestId('speleodb-close-discard'));
  await waitFor(() => expect(closeProject).toHaveBeenCalledWith({ request: expect.any(Number), isCurrent: expect.any(Function) }));
  expect(saveProject).not.toHaveBeenCalled();
});

it('replays a pending open only after successful close', async () => {
  useUIStore.setState({ dialogData: { pendingOpenPath: '/synthetic/next.stalx' } });
  render(<SpeleoCloseDialog />);
  fireEvent.click(screen.getByTestId('speleodb-close-discard'));
  await waitFor(() => expect(loadProject).toHaveBeenCalledWith('/synthetic/next.stalx', expect.objectContaining({ accessConfirmed: true })));
  expect(probe).toHaveBeenCalledOnce();
});

it('failed close does not replay a pending open', async () => {
  closeProject.mockResolvedValue({ success: false });
  useUIStore.setState({ dialogData: { pendingOpenPath: '/synthetic/next.stalx' } });
  render(<SpeleoCloseDialog />);
  await act(async () => fireEvent.click(screen.getByTestId('speleodb-close-discard')));
  expect(closeProject).toHaveBeenCalledOnce();
  expect(loadProject).not.toHaveBeenCalled();
  expect(screen.getByTestId('speleodb-close-error')).toHaveTextContent('Could not close');
  expect(screen.getByTestId('speleodb-close-cancel')).toBeEnabled();
  expect(closeDialog).not.toHaveBeenCalled();
});

it('does not close a replacement project after a delayed destination probe', async () => {
  let resolve!: (value: boolean) => void;
  probe.mockImplementationOnce(() => new Promise<boolean>((done) => { resolve = done; }));
  useUIStore.setState({ dialogData: { pendingOpenPath: '/synthetic/next.stalx' } });
  render(<SpeleoCloseDialog />);
  fireEvent.click(screen.getByTestId('speleodb-close-discard'));
  fireEvent.click(screen.getByTestId('speleodb-close-discard'));
  expect(probe).toHaveBeenCalledOnce();
  useProjectStore.setState({ project: { file_path: '/synthetic/replacement.stalx' } as never });
  await act(async () => resolve(true));
  expect(closeProject).not.toHaveBeenCalled();
});
