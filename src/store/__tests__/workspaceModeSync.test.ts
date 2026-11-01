import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUIStore } from '../uiStore';
import { sendWorkspaceMode, startWorkspaceModeSync } from '../workspaceModeSync';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

/**
 * #576 C5: the backend refuses survey edits while the workspace is Plan or Export,
 * which only works if it is told the mode. Every `appMode` change is sent, in order,
 * whichever path made it - the mode switcher, and the load reset in
 * `applyDisplaySettings` that puts a newly opened project back in Survey.
 */
const sentModes = () =>
  invokeIpcMock.mock.calls
    .filter(([command]) => command === 'set_workspace_mode')
    .map(([, args]) => (args as { mode: string }).mode);

/** Let the chained sends drain. */
const settle = () => sendWorkspaceMode(useUIStore.getState().appMode);

describe('workspace mode sync', () => {
  let stop: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    invokeIpcMock.mockResolvedValue(null);
    useUIStore.setState({ appMode: 'survey' });
  });

  afterEach(() => {
    stop?.();
  });

  it('sends the current mode at start, then every change, in order', async () => {
    stop = startWorkspaceModeSync();
    useUIStore.getState().setAppMode('plan');
    useUIStore.getState().setAppMode('export');
    useUIStore.getState().setAppMode('survey');
    await settle();

    // The trailing 'survey' is `settle`'s own send.
    expect(sentModes()).toEqual(['survey', 'plan', 'export', 'survey', 'survey']);
  });

  it('sends Survey when a project load resets the mode', async () => {
    useUIStore.setState({ appMode: 'plan' });
    stop = startWorkspaceModeSync();
    // A load hands over the project's saved settings; none matter here.
    useUIStore.getState().applyDisplaySettings({} as never);
    await settle();

    expect(useUIStore.getState().appMode).toBe('survey');
    expect(sentModes().slice(0, 2)).toEqual(['plan', 'survey']);
  });

  it('a failed send does not wedge the next one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeIpcMock.mockRejectedValueOnce('ipc down');
    stop = startWorkspaceModeSync();
    useUIStore.getState().setAppMode('plan');
    await settle();

    expect(sentModes()).toEqual(['survey', 'plan', 'plan']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('stops sending once unsubscribed', async () => {
    stop = startWorkspaceModeSync();
    stop();
    useUIStore.getState().setAppMode('plan');
    await sendWorkspaceMode('survey');

    expect(sentModes()).toEqual(['survey', 'survey']);
  });
});
