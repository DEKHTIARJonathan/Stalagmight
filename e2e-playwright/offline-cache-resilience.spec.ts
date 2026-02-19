import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject } from './helpers/app';

test.describe('Offline Cache Resilience', () => {
  test('shows offline status and maintains cache controls while connectivity changes', async ({ page }) => {
    test.setTimeout(60000);

    await setupMockedPage(page);
    await createProject(page, 'Offline Cache Scenario');

    await page.evaluate(() => {
      const setNetworkStatus = (window as unknown as Record<string, unknown>).__MOCK_SET_NETWORK_STATUS__;
      if (typeof setNetworkStatus !== 'function') {
        throw new Error('Network mock setter unavailable');
      }
      (setNetworkStatus as (status: boolean) => void)(false);
      window.dispatchEvent(new Event('offline'));
    });

    await expect(page.getByTestId('offline-indicator')).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: { getState: () => { openDialog: (dialog: string) => void } };
        };
      }).__E2E_TEST__;
      e2e?.uiStore.getState().openDialog('settings');
    });

    await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('settings-tab-cache').click();

    await expect(page.getByTestId('cache-stats')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('cache-tile-count')).not.toHaveText('0');

    await page.getByTestId('clear-cache-button').click();
    await expect(page.getByTestId('cache-tile-count')).toHaveText('0');

    await page.evaluate(() => {
      const setNetworkStatus = (window as unknown as Record<string, unknown>).__MOCK_SET_NETWORK_STATUS__;
      if (typeof setNetworkStatus !== 'function') {
        throw new Error('Network mock setter unavailable');
      }
      (setNetworkStatus as (status: boolean) => void)(true);
      window.dispatchEvent(new Event('online'));
    });

    await expect(page.getByTestId('offline-indicator')).toBeHidden({ timeout: 10000 });
  });
});
