// @vitest-environment jsdom
/**
 * Launch-with-file (#424): the OS -> `routeOpenedFile` path.
 *
 * The cases that regress silently, and what makes each red:
 *
 * - Routing before the app is ready would run the router against a store that
 *   has not read its config.
 * - `routeOpenedFile` resolves at dialog HAND-OFF, not flow completion, so a
 *   plain `await` loop lets path 2 replace path 1's dialog in the single slot -
 *   path 1 is lost with no error anywhere. The mock below marks a dialog active
 *   on its first call, which is exactly what the real router does.
 * - Two nudges arriving together must not interleave two drains through that
 *   same single slot.
 * - A `.stalx` forwarded by a second process must not swap a clean project out
 *   from under the user without a click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('./ipc', () => ({ invokeIpc: invokeIpcMock }));

const routeOpenedFileMock = vi.hoisted(() =>
  vi.fn(async (_path: string, _title?: string) => {}),
);
vi.mock('./openOrImport', () => ({ routeOpenedFile: routeOpenedFileMock }));

const setProjectActionSourceMock = vi.hoisted(() => vi.fn());
// uiStore imports the tracking side of this module; stub the whole surface so
// `openDialog` works without pulling telemetry's IPC in.
vi.mock('./telemetry', () => ({
  setProjectActionSource: setProjectActionSourceMock,
  clearProjectActionSource: vi.fn(),
  trackAction: vi.fn(),
  trackDialogComplete: vi.fn(),
  checkDialogCancel: vi.fn(),
  trackDisplayState: vi.fn(),
  setDwellState: vi.fn(),
  advanceProjectSeq: vi.fn(),
  trackNav: vi.fn(),
  trackPanelToggle: vi.fn(),
  trackPanelMode: vi.fn(),
  trackSelect: vi.fn(),
  trackSelectAdd: vi.fn(),
  isPersistSuppressed: () => false,
}));

const listenMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import {
  useLaunchWithFile,
  drainLaunchFiles,
  needsLaunchConfirm,
  resetLaunchFileQueueForTest,
  LAUNCH_FILE_EVENT,
} from './launchWithFile';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';

/** Captured backend-event handler, so a test can fire the nudge itself. */
let emitToApp: (() => void) | null = null;
const unlisten = vi.fn();

/** Queue the backend will hand over on the next `take_pending_launch_files`. */
let queued: string[] = [];

/** Routed paths, in the order the module actually committed to them. */
const routed = () => routeOpenedFileMock.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` keeps implementations; a per-case router stub must not leak
  // into the next case (that is what made the confirm cases pass spuriously).
  routeOpenedFileMock.mockReset();
  routeOpenedFileMock.mockImplementation(async (_path: string, _title?: string) => {});
  resetLaunchFileQueueForTest();
  emitToApp = null;
  queued = [];
  useUIStore.setState({ activeDialog: null, dialogData: {}, placementMode: null });
  useProjectStore.setState({ project: null, isDirty: false });
  useSpeleoStore.setState({ link: null });
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

afterEach(() => {
  useUIStore.setState({ activeDialog: null, dialogData: {}, placementMode: null });
});

describe('drainLaunchFiles', () => {
  it('routes a single queued path through the unified router', async () => {
    queued = ['/dives/one.stalx'];

    await drainLaunchFiles();

    expect(routed()).toEqual(['/dives/one.stalx']);
    expect(setProjectActionSourceMock).toHaveBeenCalledWith('os-file-association');
  });

  it('does not route when the queue is empty', async () => {
    await drainLaunchFiles();
    expect(routeOpenedFileMock).not.toHaveBeenCalled();
  });

  it('routes the whole batch when no flow claims the dialog slot', async () => {
    queued = ['/dives/one.stalx', '/dives/two.tml'];

    await drainLaunchFiles();

    expect(routed()).toEqual(['/dives/one.stalx', '/dives/two.tml']);
  });

  /**
   * The blocker: the router resolves at HAND-OFF. Path 2 must wait for the
   * dialog path 1 opened, or it silently replaces it in the single slot.
   */
  it('routes one path per completed flow, holding the rest', async () => {
    routeOpenedFileMock.mockImplementation(async () => {
      useUIStore.setState({ activeDialog: 'unsaved-changes' });
    });
    queued = ['/dives/one.stalx', '/dives/two.tml', '/dives/three.tmlu'];

    await drainLaunchFiles();

    expect(routed()).toEqual(['/dives/one.stalx']);

    // A drain while the dialog is still up changes nothing.
    await drainLaunchFiles();
    expect(routed()).toEqual(['/dives/one.stalx']);
  });

  it('resumes the held paths once the dialog slot clears', async () => {
    routeOpenedFileMock.mockImplementationOnce(async () => {
      useUIStore.setState({ activeDialog: 'unsaved-changes' });
    });
    queued = ['/dives/one.stalx', '/dives/two.tml'];

    await drainLaunchFiles();
    expect(routed()).toEqual(['/dives/one.stalx']);

    useUIStore.setState({ activeDialog: null });
    await drainLaunchFiles();

    expect(routed()).toEqual(['/dives/one.stalx', '/dives/two.tml']);
  });

  it('holds everything when a dialog is already open before the file arrives', async () => {
    useUIStore.setState({ activeDialog: 'settings' });
    queued = ['/dives/one.stalx'];

    await drainLaunchFiles();

    expect(routeOpenedFileMock).not.toHaveBeenCalled();

    useUIStore.setState({ activeDialog: null });
    await drainLaunchFiles();
    expect(routed()).toEqual(['/dives/one.stalx']);
  });

  it('holds while a placement flow owns the screen', async () => {
    useUIStore.setState({
      placementMode: { active: true } as unknown as ReturnType<
        typeof useUIStore.getState
      >['placementMode'],
    });
    queued = ['/dives/one.stalx'];

    await drainLaunchFiles();

    expect(routeOpenedFileMock).not.toHaveBeenCalled();
  });

  /**
   * Two nudges landing together must not run two loops through one dialog slot.
   * Without the chain both drains fetch, both see an idle screen, and both
   * route - the second clobbering the first's dialog.
   */
  it('serializes concurrent drains', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    routeOpenedFileMock.mockImplementation(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      useUIStore.setState({ activeDialog: 'unsaved-changes' });
    });
    queued = ['/dives/one.stalx', '/dives/two.tml'];

    await Promise.all([drainLaunchFiles(), drainLaunchFiles(), drainLaunchFiles()]);

    expect(maxConcurrent).toBe(1);
    expect(routed()).toEqual(['/dives/one.stalx']);
  });

  it('a failing drain does not poison later drains', async () => {
    invokeIpcMock.mockRejectedValueOnce(new Error('ipc down'));

    await expect(drainLaunchFiles()).rejects.toThrow('ipc down');

    queued = ['/dives/after.stalx'];
    await drainLaunchFiles();
    expect(routed()).toEqual(['/dives/after.stalx']);
  });
});

describe('needsLaunchConfirm', () => {
  it('is false with no project open - nothing is displaced', () => {
    expect(needsLaunchConfirm('/dives/one.stalx')).toBe(false);
  });

  it('is true for a .stalx over a clean, locally-owned project', () => {
    useProjectStore.setState({ project: { name: 'Open' } as never, isDirty: false });
    expect(needsLaunchConfirm('/dives/one.stalx')).toBe(true);
  });

  it('is false when the router already prompts (dirty / SpeleoDB hand-back)', () => {
    useProjectStore.setState({ project: { name: 'Open' } as never, isDirty: true });
    expect(needsLaunchConfirm('/dives/one.stalx')).toBe(false);

    useProjectStore.setState({ isDirty: false });
    useSpeleoStore.setState({ link: { editState: 'editing' } as never });
    expect(needsLaunchConfirm('/dives/one.stalx')).toBe(false);
  });

  it('is false for Ariane files - the router raises import-as-new-project', () => {
    useProjectStore.setState({ project: { name: 'Open' } as never, isDirty: false });
    expect(needsLaunchConfirm('/dives/one.tml')).toBe(false);
    expect(needsLaunchConfirm('/dives/one.tmlu')).toBe(false);
  });
});

describe('the launch-open confirm', () => {
  it('asks before swapping a clean project, and does not route until answered', async () => {
    useProjectStore.setState({ project: { name: 'Open' } as never, isDirty: false });
    queued = ['/dives/one.stalx', '/dives/two.tml'];

    await drainLaunchFiles();

    expect(routeOpenedFileMock).not.toHaveBeenCalled();
    const ui = useUIStore.getState();
    expect(ui.activeDialog).toBe('launch-open-confirm');
    expect(ui.dialogData.path).toBe('/dives/one.stalx');
    expect(ui.dialogData.fileName).toBe('one.stalx');
  });

  it('does not ask when no project is open', async () => {
    queued = ['/dives/one.stalx'];

    await drainLaunchFiles();

    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(routed()).toEqual(['/dives/one.stalx']);
  });
});

describe('useLaunchWithFile', () => {
  it('drains the cold-launch queue as soon as the app is ready', async () => {
    queued = ['/dives/cold.stalx'];

    renderHook(() => useLaunchWithFile(true));

    await waitFor(() => expect(routed()).toEqual(['/dives/cold.stalx']));
  });

  it('subscribes to the backend nudge', async () => {
    renderHook(() => useLaunchWithFile(false));
    await waitFor(() =>
      expect(listenMock).toHaveBeenCalledWith(LAUNCH_FILE_EVENT, expect.any(Function)),
    );
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

    await waitFor(() => expect(routed()).toEqual(['/dives/early.stalx']));
  });

  it('routes a nudge that arrives while the app is already running', async () => {
    renderHook(() => useLaunchWithFile(true));
    await waitFor(() => expect(emitToApp).not.toBeNull());
    routeOpenedFileMock.mockClear();

    queued = ['/dives/second-instance.stalx'];
    emitToApp?.();

    await waitFor(() => expect(routed()).toEqual(['/dives/second-instance.stalx']));
  });

  /** Nothing else asks again once a held path's blocking flow ends. */
  it('re-drains by itself when the dialog slot clears', async () => {
    routeOpenedFileMock.mockImplementationOnce(async () => {
      useUIStore.setState({ activeDialog: 'unsaved-changes' });
    });
    queued = ['/dives/one.stalx', '/dives/two.tml'];

    renderHook(() => useLaunchWithFile(true));
    await waitFor(() => expect(routed()).toEqual(['/dives/one.stalx']));

    act(() => {
      useUIStore.setState({ activeDialog: null });
    });

    await waitFor(() => expect(routed()).toEqual(['/dives/one.stalx', '/dives/two.tml']));
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useLaunchWithFile(true));
    await waitFor(() => expect(emitToApp).not.toBeNull());

    unmount();

    expect(unlisten).toHaveBeenCalled();
  });
});
