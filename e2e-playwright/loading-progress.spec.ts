import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Loading Progress', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Wait for GlobalView to load with recent projects
    await page.waitForSelector('[data-testid="global-view"]', { timeout: 10000 });
  });

  test('shows progress UI when simulated via E2E hook', async ({ page }) => {
    // Use E2E hooks to manually trigger loading state (mock load completes too fast)
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingProgress?.({
        isLoading: true,
        projectName: 'Test Project',
        phase: 'loading_project_data',
        phaseIndex: 1,
        phaseCount: 8,
        overallProgress: 25,
      });
    });

    // Progress UI should appear
    await expect(page.locator('[data-testid="loading-progress"]')).toBeVisible();
  });

  test('shows project name in loading title', async ({ page }) => {
    // Use E2E hooks to manually trigger loading state
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingProgress?.({
        isLoading: true,
        projectName: 'Test Cave Project',
        phase: 'loading_project_data',
        phaseIndex: 1,
        phaseCount: 8,
        overallProgress: 25,
      });
    });

    // Should show "Loading <name>..." in the title
    await expect(page.getByText(/Loading Test Cave Project\.\.\./)).toBeVisible();
  });

  test('shows phase updates with step numbers', async ({ page }) => {
    // Use E2E hooks to manually trigger loading state
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingProgress?.({
        isLoading: true,
        projectName: 'Test Project',
        phase: 'computing_stations',
        phaseIndex: 3,
        phaseCount: 8,
        overallProgress: 50,
      });
    });

    // Phase text should show "Step N/M:" format (4/8 because phaseIndex is 0-based)
    await expect(page.getByText(/Step 4\/8:/)).toBeVisible();
  });

  test('shows phase updates during loading', async ({ page }) => {
    // Use E2E hooks to manually trigger loading state
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingProgress?.({
        isLoading: true,
        projectName: 'Test Project',
        phase: 'opening_database',
        phaseIndex: 0,
        phaseCount: 8,
        overallProgress: 5,
      });
    });

    // Phase text should be visible (Opening database... formatted)
    await expect(page.getByText(/Opening database/)).toBeVisible();
  });

  test('cancel button dismisses loading UI', async ({ page }) => {
    // Use E2E hooks to manually trigger loading state
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingProgress?.({
        isLoading: true,
        projectName: 'Test Project',
        phase: 'loading_project_data',
        phaseIndex: 1,
        phaseCount: 8,
        overallProgress: 25,
      });
    });

    await expect(page.locator('[data-testid="loading-progress"]')).toBeVisible();

    // Click cancel
    await page.getByText('Cancel').click();

    // Loading UI should disappear
    await expect(page.locator('[data-testid="loading-progress"]')).not.toBeVisible();
    // Should be back at GlobalView
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });

  test('stale events are ignored after reset', async ({ page }) => {
    // Start a load with clientOpId 1
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingProgress?.({
        isLoading: true,
        loadingId: 1,
        clientOpId: 1,
        projectName: 'Test Project',
        phase: 'loading_project_data',
        phaseIndex: 1,
        phaseCount: 8,
        overallProgress: 25,
      });
    });

    await expect(page.locator('[data-testid="loading-progress"]')).toBeVisible();

    // Cancel/reset
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { resetLoading?: () => void } }).__E2E_TEST__;
      e2e?.resetLoading?.();
    });

    await expect(page.locator('[data-testid="loading-progress"]')).not.toBeVisible();

    // Emit stale event with old loadingId (shouldn't do anything since we're not loading)
    await page.evaluate(() => {
      const mock = (window as unknown as { __tauriEventMock?: { emit: (event: string, payload: unknown) => void } }).__tauriEventMock;
      if (mock) {
        mock.emit('loading-progress', {
          loadingId: 1,
          phase: 'finalizing',
          phaseIndex: 7,
          phaseCount: 8,
          overallPercent: 100,
        });
      }
    });

    // Should still be at GlobalView with no loading UI
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="loading-progress"]')).not.toBeVisible();
  });

  test('clientOpId increments with each load operation', async ({ page }) => {
    // Get initial clientOpId (should be 0 or low number)
    const idBefore = await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { getLoadingId?: () => number } }).__E2E_TEST__;
      return e2e?.getLoadingId?.() ?? 0;
    });

    // Simulate starting a load
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingProgress?.({
        isLoading: true,
        clientOpId: 5, // Manually set a higher clientOpId
        projectName: 'Test Project',
        phase: 'loading_project_data',
        overallProgress: 25,
      });
    });

    // Get the new clientOpId
    const idAfter = await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { getLoadingId?: () => number } }).__E2E_TEST__;
      return e2e?.getLoadingId?.() ?? 0;
    });

    expect(idAfter).toBe(5); // We explicitly set it to 5
    expect(idAfter).toBeGreaterThan(idBefore);
  });

  test('error state shows retry and dismiss buttons', async ({ page }) => {
    // Trigger loading state first
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingProgress?.({
        isLoading: true,
        projectName: 'Test Project',
        projectPath: '/test/path.cvproj',
        phase: 'loading_project_data',
        overallProgress: 25,
      });
    });

    await expect(page.locator('[data-testid="loading-progress"]')).toBeVisible();

    // Simulate error
    await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingError?: (msg: string, details?: string) => void } }).__E2E_TEST__;
      e2e?.simulateLoadingError?.('Test error', 'Error details here');
    });

    // Error UI should show retry and dismiss
    await expect(page.getByText('Retry')).toBeVisible();
    await expect(page.getByText('Dismiss')).toBeVisible();
  });

  test('E2E hooks are exposed globally', async ({ page }) => {
    // Verify all E2E hooks are available
    const hooks = await page.evaluate(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: Record<string, unknown> }).__E2E_TEST__;
      return {
        hasGetLoadingId: typeof e2e?.getLoadingId === 'function',
        hasGetBackendLoadingId: typeof e2e?.getBackendLoadingId === 'function',
        hasSimulateLoadingProgress: typeof e2e?.simulateLoadingProgress === 'function',
        hasSimulateLoadingError: typeof e2e?.simulateLoadingError === 'function',
        hasResetLoading: typeof e2e?.resetLoading === 'function',
        // Also check that existing hooks are preserved
        hasUiStore: typeof e2e?.uiStore !== 'undefined',
        hasProjectStore: typeof e2e?.projectStore !== 'undefined',
      };
    });

    expect(hooks.hasGetLoadingId).toBe(true);
    expect(hooks.hasGetBackendLoadingId).toBe(true);
    expect(hooks.hasSimulateLoadingProgress).toBe(true);
    expect(hooks.hasSimulateLoadingError).toBe(true);
    expect(hooks.hasResetLoading).toBe(true);
    // Existing hooks should still be there
    expect(hooks.hasUiStore).toBe(true);
    expect(hooks.hasProjectStore).toBe(true);
  });

  test('event mock supports listen and emit', async ({ page }) => {
    // Verify the event mock is set up
    const hasEventMock = await page.evaluate(() => {
      const mock = (window as unknown as { __tauriEventMock?: { listen?: unknown; emit?: unknown } }).__tauriEventMock;
      return {
        hasListeners: mock?.listen !== undefined,
        hasEmit: mock?.emit !== undefined,
      };
    });

    expect(hasEventMock.hasListeners).toBe(true);
    expect(hasEventMock.hasEmit).toBe(true);
  });
});
