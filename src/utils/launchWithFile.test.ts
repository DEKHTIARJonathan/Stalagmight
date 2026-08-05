// @vitest-environment jsdom
/**
 * Launch-with-file (#424): the OS -> `routeOpenedFile` path.
 *
 * The cases that can silently regress: routing before the app is ready (the
 * router would run against an unconfigured store), and dropping the cold-launch
 * file entirely (queued before any listener existed, so no event ever arrives
 * for it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('./ipc', () => ({ invokeIpc: invokeIpcMock }));

const routeOpenedFileMock = vi.hoisted(() => vi.fn(async (_path: string, _title?: string) => {}));
vi.mock('./openOrImport', () => ({ routeOpenedFile: routeOpenedFileMock }));

const setProjectActionSourceMock = vi.hoisted(() => vi.fn());
vi.mock('./telemetry', () => ({ setProjectActionSource: setProjectActionSourceMock }));

const listenMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { useLaunchWithFile, drainLaunchFiles, LAUNCH_FILE_EVENT } from './launchWithFile';

/** Captured backend-event handler, so a test can fire the nudge itself. */
let emitToApp: (() => void) | null = null;
const unlisten = vi.fn();

/** Queue the backend will hand over on the next `take_pending_launch_files`. */
let queued: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  emitToApp = null;
  queued = [];
  listenMock.mockImplementation(async (_event: string, handler: () => void) => {
    emitToApp = handler;
    return unlisten;
  });
  invokeIpcMock.mockImplementation(async (cmd: string) => {
    if (cmd !== 'take_pending_launch_files') throw new Error(`unexpected command ${cmd}`);
    const batch = queued;
    queued = [];
    return batch;
  });
});

describe('drainLaunchFiles', () => {
  it('routes every queued path through the unified router', async () => {
    queued = ['/dives/one.stalx', '/dives/two.tml'];

    await drainLaunchFiles();

    expect(routeOpenedFileMock.mock.calls.map((c) => c[0])).toEqual([
      '/dives/one.stalx',
      '/dives/two.tml',
    ]);
    expect(setProjectActionSourceMock).toHaveBeenCalledWith('os-file-association');
  });

  it('does not route when the queue is empty', async () => {
    await drainLaunchFiles();
    expect(routeOpenedFileMock).not.toHaveBeenCalled();
  });
});

describe('useLaunchWithFile', () => {
  it('drains the cold-launch queue as soon as the app is ready', async () => {
    queued = ['/dives/cold.stalx'];

    renderHook(() => useLaunchWithFile(true));

    await waitFor(() => expect(routeOpenedFileMock).toHaveBeenCalledWith('/dives/cold.stalx', 'Open Failed'));
  });

  it('subscribes to the backend nudge', async () => {
    renderHook(() => useLaunchWithFile(false));
    await waitFor(() => expect(listenMock).toHaveBeenCalledWith(LAUNCH_FILE_EVENT, expect.any(Function)));
  });

  it('holds a path queued until the app is ready, then routes it', async () => {
    queued = ['/dives/early.stalx'];

    const { rerender } = renderHook(({ ready }) => useLaunchWithFile(ready), {
      initialProps: { ready: false },
    });
    await waitFor(() => expect(emitToApp).not.toBeNull());

    // The OS hands us a file while the app is still starting.
    emitToApp?.();
    await Promise.resolve();
    expect(invokeIpcMock).not.toHaveBeenCalled();
    expect(routeOpenedFileMock).not.toHaveBeenCalled();

    rerender({ ready: true });

    await waitFor(() => expect(routeOpenedFileMock).toHaveBeenCalledWith('/dives/early.stalx', 'Open Failed'));
  });

  it('routes a nudge that arrives while the app is already running', async () => {
    renderHook(() => useLaunchWithFile(true));
    await waitFor(() => expect(emitToApp).not.toBeNull());
    routeOpenedFileMock.mockClear();

    queued = ['/dives/second-instance.dmp'];
    emitToApp?.();

    await waitFor(() =>
      expect(routeOpenedFileMock).toHaveBeenCalledWith('/dives/second-instance.dmp', 'Open Failed'),
    );
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useLaunchWithFile(true));
    await waitFor(() => expect(emitToApp).not.toBeNull());

    unmount();

    expect(unlisten).toHaveBeenCalled();
  });
});
