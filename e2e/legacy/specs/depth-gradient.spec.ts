/**
 * WebdriverIO E2E Tests: Depth Gradient Display
 *
 * These tests run against the full Tauri application with real backend
 * to validate depth gradient functionality including:
 * - Toggle enables depth coloring on map
 * - Depth legend shows/hides correctly
 * - Legend displays correct depth range labels
 * - Setting persists across sessions
 *
 * Test requirements:
 * - Real backend (not mocked) for actual display settings persistence
 * - Uses window.__stalagmight_map__ for map state verification
 * - Access window.__E2E_TEST__ for store state verification
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

/**
 * Helper to open the Display menu
 */
async function openDisplayMenu(): Promise<void> {
  const displayButton = await $('[data-testid="display-menu-button"]');
  await displayButton.waitForDisplayed({ timeout: 5000 });
  try {
    await displayButton.waitForClickable({ timeout: 2000 });
    await displayButton.click();
  } catch {
    await browser.execute((el) => (el as HTMLElement).click(), displayButton);
  }
  // Wait for menu to open
  const toggle = await $('[data-testid="display-toggle-showStations"]');
  await toggle.waitForDisplayed({ timeout: 5000 });
}

/**
 * Helper to check if depth legend is visible
 */
async function isDepthLegendVisible(): Promise<boolean> {
  const legend = await $('[data-testid="depth-legend"]');
  return await legend.isDisplayed();
}

describe('Depth Gradient Display', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    await createNewProject('Depth Gradient Test');
    // Import survey data so depth legend can be rendered (requires stats from survey data)
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    await importDmpViaStore(dmpPath);
    await waitForMapReady();
  });

  afterEach(async () => {
    await resetAppState();
  });

  describe('Toggle Behavior', () => {
    it('should enable depth coloring when toggle is turned on', async () => {
      // Verify depth gradient is OFF by default
      const stateBefore = await getDepthGradientState();
      expect(stateBefore).toBe(false);

      // Toggle depth gradient ON
      await toggleDepthGradient();

      // Verify state changed
      const stateAfter = await getDepthGradientState();
      expect(stateAfter).toBe(true);

      // Verify depth legend is visible (rendering indicator)
      const legendVisible = await isDepthLegendVisible();
      expect(legendVisible).toBe(true);
    });

    it('should disable depth coloring when toggle is turned off', async () => {
      // Enable depth gradient first
      await toggleDepthGradient();
      expect(await getDepthGradientState()).toBe(true);

      // Disable depth gradient
      await toggleDepthGradient();
      expect(await getDepthGradientState()).toBe(false);

      // Verify legend is hidden
      const legendVisible = await isDepthLegendVisible();
      expect(legendVisible).toBe(false);
    });
  });

  describe('Depth Legend', () => {
    it('should show legend when depth gradient is enabled', async () => {
      // Verify legend is hidden initially
      expect(await isDepthLegendVisible()).toBe(false);

      // Enable depth gradient
      await toggleDepthGradient();

      // Verify legend is visible
      expect(await isDepthLegendVisible()).toBe(true);
    });

    it('should display depth range labels with correct format', async () => {
      // Enable depth gradient
      await toggleDepthGradient();

      // Wait for legend to be visible
      const legend = await $('[data-testid="depth-legend"]');
      await legend.waitForDisplayed({ timeout: 2000 });

      // Get min and max labels
      const minLabel = await $('[data-testid="depth-legend-min"]');
      const maxLabel = await $('[data-testid="depth-legend-max"]');

      const minText = await minLabel.getText();
      const maxText = await maxLabel.getText();

      // Verify format: optional negative, number, optional decimal, 'm' unit
      expect(minText).toMatch(/-?\d+(\.\d+)?m/);
      expect(maxText).toMatch(/-?\d+(\.\d+)?m/);
    });

    it('should have proper accessibility attributes', async () => {
      // Enable depth gradient
      await toggleDepthGradient();

      // Get legend SVG
      const legendSvg = await $('[data-testid="depth-legend"] svg');
      await legendSvg.waitForDisplayed({ timeout: 2000 });

      // Verify role attribute
      const role = await legendSvg.getAttribute('role');
      expect(role).toBe('img');

      // Verify aria-label
      const ariaLabel = await legendSvg.getAttribute('aria-label');
      expect(ariaLabel).toMatch(/Depth scale/i);
      expect(ariaLabel).toMatch(/shallow/i);
      expect(ariaLabel).toMatch(/deep/i);
    });
  });

  describe('Display Menu Integration', () => {
    it('should show Depth Gradient option in Display menu', async () => {
      await openDisplayMenu();

      const toggle = await $('[data-testid="display-toggle-showDepthGradient"]');
      await toggle.waitForDisplayed({ timeout: 2000 });

      const toggleText = await toggle.getText();
      expect(toggleText).toContain('Depth Gradient');
      expect(toggleText).toContain('Color by depth');
    });

    it('should toggle via Display menu', async () => {
      // Open menu and click toggle
      await openDisplayMenu();
      const toggle = await $('[data-testid="display-toggle-showDepthGradient"]');
      await toggle.click();

      // Verify state changed
      expect(await getDepthGradientState()).toBe(true);
      expect(await isDepthLegendVisible()).toBe(true);

      // Toggle off
      await toggle.click();
      expect(await getDepthGradientState()).toBe(false);
      expect(await isDepthLegendVisible()).toBe(false);
    });
  });

  describe('Toggle Independence', () => {
    it('should be independent of other display toggles', async () => {
      // Enable depth gradient
      await toggleDepthGradient();
      expect(await getDepthGradientState()).toBe(true);

      // Toggle stations off via store
      await browser.execute(() => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { toggleDisplay: (key: string) => void } };
          };
        }).__E2E_TEST__;
        e2e?.uiStore?.getState()?.toggleDisplay('showStations');
      });

      // Depth gradient should still be on
      expect(await getDepthGradientState()).toBe(true);
      expect(await isDepthLegendVisible()).toBe(true);
    });
  });
});

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
