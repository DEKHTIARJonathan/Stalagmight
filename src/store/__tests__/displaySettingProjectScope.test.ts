/**
 * [#576 RV6b-2] A display setting is written for the project it was made in.
 *
 * Grid spacing, the geometry mode and the display toggles are stored per project,
 * in whichever project database is open when `save_display_setting` runs. Since
 * SETTINGS-ORDER a write of one key waits for the previous write of that key to
 * settle, so a burst of clicks in project A followed by opening project B could
 * send A's queued writes after B opened - into B's file. Now:
 *  - a write carries the identity (`created_at`) of the project it was made for,
 *    and the backend refuses it with PROJECT_CHANGED when another one is open;
 *  - a write still queued when the project is replaced is dropped, never sent;
 *  - that refusal is the design working, so it is not logged as a failure.
 *
 * Store tier: the real stores and write chain; the IPC is mocked, and the first
 * write of a burst is held until the test releases it. All data is synthetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { invokeIpcMock, stubGetErrorMessage, stringOfError } from '../../test/factories/ipc';

vi.mock('../../utils/ipc');
stubGetErrorMessage(stringOfError);
vi.mock('@tauri-apps/api/core', async () => (await import('../../test/factories/tauri')).tauriCoreResolving(undefined));

import { useUIStore } from '../uiStore';
import { useProjectStore } from '../projectStore';
import type { Project } from '../../types/project';

const CAVE_A = '2026-01-01T10:00:00Z';

/** The display-setting writes sent, in send order. */
let sent: Array<Record<string, unknown>>;
/** Releases the held first write. */
let releaseFirst: (() => void) | null;

beforeEach(() => {
  sent = [];
  releaseFirst = null;
  invokeIpcMock.mockReset();
  invokeIpcMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'save_display_setting') {
      sent.push(args ?? {});
      if (sent.length === 1) {
        return new Promise<null>((resolve) => {
          releaseFirst = () => resolve(null);
        });
      }
      return Promise.resolve(null);
    }
    if (cmd === 'close_project') return Promise.resolve({ remote_link: null });
    return Promise.resolve(undefined);
  });
  useUIStore.setState({ appMode: 'survey', gridSpacing: 10, geometryMode: 'measured' });
  useProjectStore.setState({
    project: { name: 'CaveA', created_at: CAVE_A, sections: [] } as unknown as Project,
    isClosing: false,
  });
});

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}

describe('display settings are scoped to their project (#576 RV6b-2)', () => {
  it('a write carries the identity of the project it was made in', async () => {
    useUIStore.getState().setGridSpacing(20);
    await until(() => sent.length === 1);
    releaseFirst?.();
    console.log('[RV6b-2] save_display_setting args:', JSON.stringify(sent[0]));
    expect(sent[0]).toEqual({ key: 'gridSpacing', value: '20', projectCreatedAt: CAVE_A });
  });

  it('a write still queued when the project closes is dropped, not sent to the next one', async () => {
    const { setGridSpacing, saveDisplaySetting, setGeometryMode } = useUIStore.getState();
    setGridSpacing(20);
    await until(() => sent.length === 1);
    // Queued behind the held first write of the same key.
    setGridSpacing(50);
    setGeometryMode('closureAdjusted');
    const toggle = saveDisplaySetting('showGrid', true);

    const closed = await useProjectStore.getState().closeProject();
    releaseFirst?.();
    await toggle;
    await new Promise((resolve) => setTimeout(resolve, 20));

    console.log(
      `[RV6b-2] close: success=${closed.success}; writes sent: ${JSON.stringify(sent)} ` +
        '(expected: no second gridSpacing - the 50 queued behind the held 20 is dropped)',
    );
    expect(closed.success).toBe(true);
    // The geometry mode and the toggle had no write ahead of them, so they were
    // sent at once - with A's identity, for the backend to refuse once B is open.
    const queuedGrid = sent.filter((args) => args.key === 'gridSpacing');
    expect(queuedGrid).toEqual([{ key: 'gridSpacing', value: '20', projectCreatedAt: CAVE_A }]);
    expect(sent.every((args) => args.projectCreatedAt === CAVE_A)).toBe(true);
  });

  it("the backend's PROJECT_CHANGED refusal is not reported as a failure", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeIpcMock.mockImplementation((cmd: string) =>
      cmd === 'save_display_setting'
        ? Promise.reject({ code: 'PROJECT_CHANGED', message: 'another project is open' })
        : Promise.resolve(undefined),
    );
    await useUIStore.getState().saveDisplaySetting('showGrid', true);
    invokeIpcMock.mockImplementation((cmd: string) =>
      cmd === 'save_display_setting'
        ? Promise.reject({ code: 'FAILED', message: 'disk full' })
        : Promise.resolve(undefined),
    );
    await useUIStore.getState().saveDisplaySetting('showGrid', false);
    const warned = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();
    expect(warned).toEqual(['Failed to save display setting:']);
  });
});
