/**
 * WebdriverIO E2E Test: Depth Gradient backend persistence
 *
 * The Depth Gradient toggle, legend, and menu-integration behavior are all
 * covered by the mocked e2e-playwright/depth-gradient.spec.ts. That spec's
 * own comment explains what it cannot cover: "Reload persistence cannot be
 * tested with mocks because the mock's in-memory storage is re-initialized
 * on page reload" - it defers real-backend persistence to this file. This
 * is the one scenario kept here: it runs against the full Tauri app with a
 * real backend database, so the setting actually round-trips through
 * `save_display_setting` / `load_display_settings`.
 *
 * Refs #275
 */

import path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  waitForMapReady,
  importDmpViaStore,
} from '../helpers/app';

const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

/**
 * Helper to invoke IPC command using window.__TAURI__.core.invoke
 */
async function invokeIPC<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const result = await browser.executeAsync(
    async (
      cmd: string,
      cmdArgs: Record<string, unknown> | undefined,
      done: (result: { ok: true; data: T } | { ok: false; error: string }) => void
    ) => {
      const { invoke } = (window as unknown as {
        __TAURI__?: { core: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> } };
      }).__TAURI__?.core ?? {};

      if (!invoke) {
        done({ ok: false, error: 'Tauri invoke not available' });
        return;
      }

      try {
        const data = await invoke<T>(cmd, cmdArgs);
        done({ ok: true, data });
      } catch (err) {
        done({ ok: false, error: `IPC ${cmd} failed: ${String(err)}` });
      }
    },
    command,
    args
  );

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.data;
}

/**
 * Helper to get showDepthGradient state from UI store
 */
async function getDepthGradientState(): Promise<boolean> {
  return browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { showDepthGradient: boolean } };
      };
    }).__E2E_TEST__;
    return e2e?.uiStore?.getState()?.showDepthGradient ?? false;
  });
}

/**
 * Helper to toggle depth gradient via store action
 */
async function toggleDepthGradient(): Promise<void> {
  await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { toggleDisplay: (key: string) => void } };
      };
    }).__E2E_TEST__;
    e2e?.uiStore?.getState()?.toggleDisplay('showDepthGradient');
  });
}

describe('Depth Gradient Persistence', () => {
  it('should save setting to backend database when toggled', async () => {
    await waitForAppReady();
    await resetAppState();
    await createNewProject('Persistence Test');
    // Import survey data so depth legend can render (requires stats)
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    await importDmpViaStore(dmpPath);
    await waitForMapReady();

    // Verify initial state - showDepthGradient should be false (default)
    const initialSettings = await invokeIPC<Record<string, string>>('load_display_settings');
    // Initial value may be undefined or 'false'
    expect(initialSettings.showDepthGradient ?? 'false').toBe('false');

    // Enable depth gradient
    await toggleDepthGradient();
    expect(await getDepthGradientState()).toBe(true);

    // Verify legend is visible (confirms UI updated)
    const legend = await $('[data-testid="depth-legend"]');
    await legend.waitForDisplayed({ timeout: 3000 });

    // Wait for setting to be persisted to backend database
    await browser.waitUntil(
      async () => {
        const settings = await invokeIPC<Record<string, string>>('load_display_settings');
        return settings.showDepthGradient === 'true';
      },
      {
        timeout: 3000,
        timeoutMsg: 'Setting was not saved to backend database',
        interval: 100,
      }
    );

    // Verify the saved value
    const savedSettings = await invokeIPC<Record<string, string>>('load_display_settings');
    expect(savedSettings.showDepthGradient).toBe('true');

    // Toggle off and verify it saves the new value
    await toggleDepthGradient();
    expect(await getDepthGradientState()).toBe(false);

    await browser.waitUntil(
      async () => {
        const settings = await invokeIPC<Record<string, string>>('load_display_settings');
        return settings.showDepthGradient === 'false';
      },
      {
        timeout: 3000,
        timeoutMsg: 'Setting was not updated in backend database',
        interval: 100,
      }
    );

    await resetAppState();
  });
});
