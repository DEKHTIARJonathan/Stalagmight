/**
 * lock#6 / frontend#4: a quit never cuts a SpeleoDB transfer in flight.
 *
 * Every quit route requests a window close and lands in the close listener, whose
 * first gate is `deferQuitUntilWorkDone`: with work in flight it keeps the
 * window, toasts, shows the waiting prompt and quits once the work has finished,
 * re-running every guard. "Quit now" is an explicit choice that saves locally,
 * skips the wait and tells the backend it may cut the operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listeners = vi.hoisted(() => [] as Array<() => Promise<void> | void>);
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: () => Promise<void>) => {
    listeners.push(cb);
    return vi.fn();
  }),
}));

/** Fire the close-requested event, as the window X (or a re-issued quit) does. */
async function closeRequested(): Promise<void> {
  for (const cb of [...listeners]) await cb();
}

const destroyMock = vi.hoisted(() => vi.fn(async () => {}));
const closeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ destroy: destroyMock, close: closeMock }),
}));

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../utils/exitConfirm', () => ({ askExitConfirm: confirmMock }));

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock, getErrorMessage: String }));

import { useBeforeUnload } from '../useBeforeUnload';
import QuitWaitDialog from '../../components/Dialogs/QuitWaitDialog';
import { resetQuitConfirmationForTests, requestUpdateRestart, resetUpdateRestartForTests } from '../../utils/quit';
import { QUIT_SETTLE_MS, resetQuitWaitForTests, useQuitWait } from '../../utils/quitAfterWork';
import { useSpeleoNetworkStore } from '../../store/speleoNetworkStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoExitPrompt } from '../../utils/speleoExit';

function Harness({ guard, shouldBlock = false }: { guard: () => boolean; shouldBlock?: boolean }) {
  useBeforeUnload(shouldBlock, 'Import is in progress. Discard?', undefined, guard);
  return <QuitWaitDialog />;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, QUIT_SETTLE_MS + 60)));

let showToast: ReturnType<typeof vi.fn>;
let guard: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  listeners.length = 0;
  destroyMock.mockClear();
  // A requested close comes back as the close-requested event, as Tauri does.
  closeMock.mockReset().mockImplementation(async () => { await closeRequested(); });
  confirmMock.mockClear().mockResolvedValue(true);
  invokeIpcMock.mockReset().mockResolvedValue(null);
  resetQuitConfirmationForTests();
  resetUpdateRestartForTests();
  resetQuitWaitForTests();
  useSpeleoNetworkStore.getState().reset();
  useSpeleoStore.setState({ busy: false });
  useSpeleoExitPrompt.setState({ request: null, working: false });
  showToast = vi.fn();
  useUIStore.setState({ showToast: showToast as never, openDialog: vi.fn() as never });
  useProjectStore.setState({ project: null, isDirty: false });
  guard = vi.fn(() => false);
  render(<Harness guard={guard} />);
  await flush();
});

afterEach(() => resetQuitWaitForTests());

describe('quit after in-flight work', () => {
  it('nothing in flight: the quit goes straight on', async () => {
    await closeRequested();
    expect(destroyMock).toHaveBeenCalledOnce();
    expect(useQuitWait.getState().waiting).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('an upload in flight keeps the window, toasts, shows progress, then closes when it finishes', async () => {
    const endUpload = useSpeleoNetworkStore.getState().begin('exclusive');
    await act(closeRequested);
    expect(destroyMock).not.toHaveBeenCalled();
    // Nothing is asked against a state that is about to change.
    expect(guard).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('will close when it finishes'), 'quit-after-work', 'info');
    expect(screen.getByTestId('quit-wait-dialog')).toBeVisible();
    expect(screen.getByTestId('quit-wait-cancel')).toHaveAttribute('data-primary-action', '');

    // Pressing X again only says so again.
    await act(closeRequested);
    expect(showToast).toHaveBeenCalledTimes(2);

    act(() => endUpload());
    await settle();
    // Re-issued from the top: the guards run against the settled state.
    expect(closeMock).toHaveBeenCalled();
    expect(guard).toHaveBeenCalledOnce();
    expect(destroyMock).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('quit-wait-dialog')).toBeNull();
  });

  it('a step that starts right after the previous one (save, then upload) is not raced', async () => {
    const endSave = useSpeleoNetworkStore.getState().begin('exclusive');
    await act(closeRequested);
    let endUpload!: () => void;
    act(() => {
      endSave();
      endUpload = useSpeleoNetworkStore.getState().begin('exclusive');
    });
    await settle();
    expect(destroyMock).not.toHaveBeenCalled();
    act(() => endUpload());
    await settle();
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it('a hand-off verb or an exit-prompt answer being carried out counts as work too', async () => {
    useSpeleoStore.setState({ busy: true });
    await act(closeRequested);
    expect(useQuitWait.getState().waiting).toBe(true);
    act(() => useSpeleoStore.setState({ busy: false }));
    act(() => useSpeleoExitPrompt.setState({ working: true }));
    await settle();
    expect(destroyMock).not.toHaveBeenCalled();
    act(() => useSpeleoExitPrompt.setState({ working: false }));
    await settle();
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it('Keep Stalagmight open calls the quit off; the transfer carries on', async () => {
    const endUpload = useSpeleoNetworkStore.getState().begin('exclusive');
    await act(closeRequested);
    await userEvent.click(screen.getByTestId('quit-wait-cancel'));
    expect(screen.queryByTestId('quit-wait-dialog')).toBeNull();
    act(() => endUpload());
    await settle();
    expect(destroyMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('Quit now is behind a warning, saves unsaved edits locally, and tells the backend it may cut the transfer', async () => {
    const save = vi.fn(async () => {
      useProjectStore.setState({ isDirty: false });
      return { success: true };
    });
    useProjectStore.setState({ project: { file_path: '/synthetic/cache/project.stalx' } as never, isDirty: true, saveProject: save as never });
    useSpeleoNetworkStore.getState().begin('exclusive');
    await act(closeRequested);
    await userEvent.click(screen.getByTestId('quit-wait-force'));
    expect(screen.getByTestId('quit-wait-force-warning')).toHaveTextContent('cut off');
    // The warning's default action is Back, never the forced quit.
    expect(screen.getByTestId('quit-wait-back')).toHaveAttribute('data-primary-action', '');
    await userEvent.click(screen.getByTestId('quit-wait-force-confirm'));
    await act(flush);
    expect(save).toHaveBeenCalledOnce();
    expect(invokeIpcMock).toHaveBeenCalledWith('arm_forced_exit', undefined, expect.anything());
    expect(destroyMock).toHaveBeenCalledOnce();
    // The answered quit is not re-guarded.
    expect(guard).not.toHaveBeenCalled();
  });

  it('Quit now does not quit when the local save fails, and says why', async () => {
    useProjectStore.setState({
      project: { file_path: '/synthetic/cache/project.stalx' } as never,
      isDirty: true,
      saveProject: vi.fn(async () => ({ success: false, error: 'Synthetic disk failure' })) as never,
    });
    useSpeleoNetworkStore.getState().begin('exclusive');
    await act(closeRequested);
    await userEvent.click(screen.getByTestId('quit-wait-force'));
    await userEvent.click(screen.getByTestId('quit-wait-force-confirm'));
    expect(await screen.findByTestId('quit-wait-error')).toHaveTextContent('Synthetic disk failure');
    expect(destroyMock).not.toHaveBeenCalled();
    expect(invokeIpcMock).not.toHaveBeenCalledWith('arm_forced_exit', undefined, expect.anything());
  });

  it('an ordinary quit never arms the forced exit', async () => {
    const endUpload = useSpeleoNetworkStore.getState().begin('exclusive');
    await act(closeRequested);
    act(() => endUpload());
    await settle();
    expect(destroyMock).toHaveBeenCalledOnce();
    expect(invokeIpcMock).not.toHaveBeenCalledWith('arm_forced_exit', undefined, expect.anything());
  });

  it('restart-to-update waits the same way, then installs', async () => {
    const endUpload = useSpeleoNetworkStore.getState().begin('exclusive');
    await act(() => requestUpdateRestart());
    expect(invokeIpcMock).not.toHaveBeenCalledWith('install_app_update_and_restart', undefined, expect.anything());
    expect(useQuitWait.getState().waiting).toBe(true);
    act(() => endUpload());
    await settle();
    expect(invokeIpcMock).toHaveBeenCalledWith('install_app_update_and_restart', undefined, expect.anything());
  });

  it('cancelling the wait abandons a restart riding on it', async () => {
    useSpeleoNetworkStore.getState().begin('exclusive');
    await act(() => requestUpdateRestart());
    await userEvent.click(screen.getByTestId('quit-wait-cancel'));
    expect(invokeIpcMock).toHaveBeenCalledWith('unarm_app_update_restart', undefined, expect.anything());
  });
});
