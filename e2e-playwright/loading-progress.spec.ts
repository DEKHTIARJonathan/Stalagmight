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

  test.describe('Event System Tests', () => {
    test('plugin:event|listen is called when app starts listening', async ({ page }) => {
      // Verify plugin:event|listen is called when useLoadingProgress registers
      const consoleLogs: string[] = [];
      page.on('console', (msg) => {
        if (msg.text().includes('[Mock IPC] plugin:event|listen')) {
          consoleLogs.push(msg.text());
        }
      });

      // Trigger a loading state which activates useLoadingProgress hook
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

      // Wait for React to register the listener
      await page.waitForTimeout(100);

      // Verify plugin:event|listen was called for loading-progress
      const loadingProgressListen = consoleLogs.some(log =>
        log.includes('loading-progress')
      );
      expect(loadingProgressListen).toBe(true);
    });

    test('event system correctly routes loading-progress events', async ({ page }) => {
      // Verify the event mock emit function works with the plugin:event system
      const eventResult = await page.evaluate(() => {
        return new Promise<{ received: boolean; payload: unknown }>((resolve) => {
          // Register a listener using the plugin:event|listen pathway
          const handler = (event: { payload: unknown }) => {
            resolve({ received: true, payload: event.payload });
          };

          // Store callback for transformCallback
          const callbackId = Math.random().toString(36).substring(7);
          (window as unknown as Record<string, unknown>)[`_${callbackId}`] = handler;

          // Simulate plugin:event|listen
          const tauriInternals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
          tauriInternals.invoke('plugin:event|listen', { event: 'test-event', handler: callbackId });

          // Emit via __tauriEventMock
          setTimeout(() => {
            const mock = (window as unknown as { __tauriEventMock?: { emit: (event: string, payload: unknown) => void } }).__tauriEventMock;
            if (mock) {
              mock.emit('test-event', { test: 'data' });
            }
          }, 50);

          // Timeout fallback
          setTimeout(() => resolve({ received: false, payload: null }), 500);
        });
      });

      expect(eventResult.received).toBe(true);
      expect(eventResult.payload).toEqual({ test: 'data' });
    });
  });

  test.describe('Direct State Manipulation Tests', () => {
    test('shows progress UI when simulated via E2E hook', async ({ page }) => {
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

      // Progress UI should appear
      await expect(page.locator('[data-testid="loading-progress"]')).toBeVisible();
    });

    test('shows project name in loading title', async ({ page }) => {
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

      await expect(page.getByText(/Loading Test Cave Project\.\.\./)).toBeVisible();
    });

    test('shows phase updates with step numbers', async ({ page }) => {
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

    test('shows phase label during loading', async ({ page }) => {
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
      await page.getByText('Cancel').click();

      await expect(page.locator('[data-testid="loading-progress"]')).not.toBeVisible();
      await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
    });

    test('stale events are ignored after cancel', async ({ page }) => {
      // Start a load with a specific loadingId
      const loadingId = Date.now();
      await page.evaluate((id) => {
        const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
        e2e?.simulateLoadingProgress?.({
          isLoading: true,
          loadingId: id,
          clientOpId: 1,
          projectName: 'Test Project',
          phase: 'loading_project_data',
          phaseIndex: 1,
          phaseCount: 8,
          overallProgress: 25,
        });
      }, loadingId);

      await expect(page.locator('[data-testid="loading-progress"]')).toBeVisible();

      // Cancel/reset loading
      await page.evaluate(() => {
        const e2e = (window as unknown as { __E2E_TEST__?: { resetLoading?: () => void } }).__E2E_TEST__;
        e2e?.resetLoading?.();
      });

      await expect(page.locator('[data-testid="loading-progress"]')).not.toBeVisible();

      // Emit stale event with the old loadingId - should be ignored since not loading
      await page.evaluate((id) => {
        const mock = (window as unknown as { __tauriEventMock?: { emit: (event: string, payload: unknown) => void } }).__tauriEventMock;
        if (mock) {
          mock.emit('loading-progress', {
            loadingId: id,
            phase: 'finalizing',
            phaseIndex: 7,
            phaseCount: 8,
            current: null,
            total: null,
            overallPercent: 100,
            isIndeterminate: true,
          });
        }
      }, loadingId);

      // Should still be at GlobalView with no loading UI
      await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
      await expect(page.locator('[data-testid="loading-progress"]')).not.toBeVisible();
    });

    test('clientOpId can be set via simulateLoadingProgress', async ({ page }) => {
      const idBefore = await page.evaluate(() => {
        const e2e = (window as unknown as { __E2E_TEST__?: { getLoadingId?: () => number } }).__E2E_TEST__;
        return e2e?.getLoadingId?.() ?? 0;
      });

      await page.evaluate(() => {
        const e2e = (window as unknown as { __E2E_TEST__?: { simulateLoadingProgress?: (payload: Record<string, unknown>) => void } }).__E2E_TEST__;
        e2e?.simulateLoadingProgress?.({
          isLoading: true,
          clientOpId: 42,
          projectName: 'Test Project',
          phase: 'loading_project_data',
          overallProgress: 25,
        });
      });

      const idAfter = await page.evaluate(() => {
        const e2e = (window as unknown as { __E2E_TEST__?: { getLoadingId?: () => number } }).__E2E_TEST__;
        return e2e?.getLoadingId?.() ?? 0;
      });

      expect(idAfter).toBe(42);
      expect(idAfter).toBeGreaterThan(idBefore);
    });

    test('error state shows retry and dismiss buttons', async ({ page }) => {
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

      await expect(page.getByText('Retry')).toBeVisible();
      await expect(page.getByText('Dismiss')).toBeVisible();
    });
  });

  test.describe('E2E Hook Availability', () => {
    test('E2E hooks are exposed globally', async ({ page }) => {
      const hooks = await page.evaluate(() => {
        const e2e = (window as unknown as { __E2E_TEST__?: Record<string, unknown> }).__E2E_TEST__;
        return {
          hasGetLoadingId: typeof e2e?.getLoadingId === 'function',
          hasGetBackendLoadingId: typeof e2e?.getBackendLoadingId === 'function',
          hasSimulateLoadingProgress: typeof e2e?.simulateLoadingProgress === 'function',
          hasSimulateLoadingError: typeof e2e?.simulateLoadingError === 'function',
          hasResetLoading: typeof e2e?.resetLoading === 'function',
          hasUiStore: typeof e2e?.uiStore !== 'undefined',
          hasProjectStore: typeof e2e?.projectStore !== 'undefined',
        };
      });

      expect(hooks.hasGetLoadingId).toBe(true);
      expect(hooks.hasGetBackendLoadingId).toBe(true);
      expect(hooks.hasSimulateLoadingProgress).toBe(true);
      expect(hooks.hasSimulateLoadingError).toBe(true);
      expect(hooks.hasResetLoading).toBe(true);
      expect(hooks.hasUiStore).toBe(true);
      expect(hooks.hasProjectStore).toBe(true);
    });

    test('event mock emit function is available', async ({ page }) => {
      const hasEventMock = await page.evaluate(() => {
        const mock = (window as unknown as { __tauriEventMock?: { emit?: unknown } }).__tauriEventMock;
        return {
          hasEmit: typeof mock?.emit === 'function',
        };
      });

      expect(hasEventMock.hasEmit).toBe(true);
    });

    test('plugin:event|listen/emit/unlisten commands are handled', async ({ page }) => {
      const result = await page.evaluate(async () => {
        const tauriInternals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;

        // Test listen returns a listener ID
        const listenerId = await tauriInternals.invoke('plugin:event|listen', { event: 'test', handler: 'cb1' });

        // Test unlisten doesn't throw
        await tauriInternals.invoke('plugin:event|unlisten', { event: listenerId });

        return { listenerId: typeof listenerId === 'number' };
      });

      expect(result.listenerId).toBe(true);
    });
  });
});
