import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ipc');

import { confirmOverwrite, resolveSavePath, useOverwritePromptStore } from '../overwriteGuard';
import { invokeIpcMock } from '../../test/factories/ipc';

/**
 * [#576 HFI-2] The existence probe is the backend's `save_target_exists`: the
 * webview's fs plugin has no scope for user paths, so its `exists()` threw for
 * every path in the real app and every rewritten name asked "could not check".
 * `answer` scripts the backend's reply to that one command.
 */
function backendSays(answer: boolean | Error): void {
  invokeIpcMock.mockImplementation(async (cmd: string) => {
    if (cmd !== 'save_target_exists') throw new Error(`unexpected command ${cmd}`);
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

/** The paths the probe was asked about. */
function probedPaths(): unknown[] {
  return invokeIpcMock.mock.calls
    .filter(([cmd]) => cmd === 'save_target_exists')
    .map(([, args]) => (args as { path: string }).path);
}

/** Let the probe settle, then answer the prompt that is (or is not) showing. */
async function answerPrompt(replace: boolean): Promise<void> {
  await vi.waitFor(() => expect(useOverwritePromptStore.getState().request).not.toBeNull());
  useOverwritePromptStore.getState().request!.resolve(replace);
}

/**
 * [#576 D35] The OS save dialog asks "replace?" for the name the user typed; the
 * app then fixes the extension and writes a DIFFERENT name. `resolveSavePath`
 * is the check for the name actually written.
 */
describe('resolveSavePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeIpcMock.mockReset();
    useOverwritePromptStore.setState({ request: null });
  });

  it('does not probe or ask when the name is written as the dialog returned it', async () => {
    backendSays(true);
    expect(await resolveSavePath('/mock/map.png', 'png')).toBe('/mock/map.png');
    expect(invokeIpcMock).not.toHaveBeenCalled();
    expect(useOverwritePromptStore.getState().request).toBeNull();
  });

  it('writes a rewritten name that does not exist without asking', async () => {
    backendSays(false);
    expect(await resolveSavePath('/mock/CaveA 1.5', 'csv')).toBe('/mock/CaveA 1.5.csv');
    expect(probedPaths()).toEqual(['/mock/CaveA 1.5.csv']);
    expect(useOverwritePromptStore.getState().request).toBeNull();
  });

  it('asks before replacing an existing file under the rewritten name; Cancel writes nothing', async () => {
    backendSays(true);
    const pending = resolveSavePath('/mock/map.svg', 'png');

    await vi.waitFor(() => expect(useOverwritePromptStore.getState().request).not.toBeNull());
    const request = useOverwritePromptStore.getState().request!;
    expect(request).toMatchObject({
      path: '/mock/map.png',
      fileName: 'map.png',
      extension: '.png',
      existenceUnknown: false,
    });
    request.resolve(false);

    expect(await pending).toBeNull();
    expect(useOverwritePromptStore.getState().request).toBeNull();
  });

  it('returns the rewritten name once the user agrees to replace it', async () => {
    backendSays(true);
    const pending = resolveSavePath('/mock/map.svg', 'png');
    await answerPrompt(true);
    expect(await pending).toBe('/mock/map.png');
  });

  it('asks (fail closed) when the backend check fails', async () => {
    backendSays(new Error('permission denied'));
    const pending = resolveSavePath('/mock/OtherCave', 'stalx');

    await vi.waitFor(() => expect(useOverwritePromptStore.getState().request).not.toBeNull());
    expect(useOverwritePromptStore.getState().request).toMatchObject({
      path: '/mock/OtherCave.stalx',
      existenceUnknown: true,
    });
    useOverwritePromptStore.getState().request!.resolve(false);
    expect(await pending).toBeNull();
  });
});

describe('confirmOverwrite', () => {
  beforeEach(() => {
    useOverwritePromptStore.setState({ request: null });
  });

  it('a second question cancels the first rather than stranding it', async () => {
    const first = confirmOverwrite('/mock/a.png', 'png', false);
    const second = confirmOverwrite('/mock/b.png', 'png', false);

    expect(await first).toBe(false);
    expect(useOverwritePromptStore.getState().request?.path).toBe('/mock/b.png');
    useOverwritePromptStore.getState().request!.resolve(true);
    expect(await second).toBe(true);
    expect(useOverwritePromptStore.getState().request).toBeNull();
  });
});
