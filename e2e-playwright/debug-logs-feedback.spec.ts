import { test, expect } from './fixtures/coverage';
import { setupMockedPage, openDebugFromMenu } from './helpers/app';

/**
 * E2E for issue #49 - the Debug Logs window must give transient toast feedback on
 * Refresh and Copy (both were previously silent). The toast renders at the app
 * level via a portal (z above the modal) as role="status", so it's visible over
 * the dialog. Each test uses a fresh page, so the per-key toast throttle never
 * crosses tests.
 *
 * Assertions use a 2s deadline, comfortably under the toast's own 3s auto-clear
 * (uiStore showToast) so the visibility poll can't race the clear timer - the
 * toast appears within a few ms of the click, leaving a wide margin.
 */
const TOAST_TIMEOUT = 2000;
test.describe('Debug Logs - Copy/Refresh feedback (#49)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await openDebugFromMenu(page);
    await expect(page.getByTestId('debug-dialog')).toBeVisible({ timeout: 5000 });
  });

  test('Refresh shows a "Logs refreshed" toast', async ({ page }) => {
    await page.getByTestId('debug-refresh-button').click();
    await expect(page.getByText('Logs refreshed')).toBeVisible({ timeout: TOAST_TIMEOUT });
  });

  test('Copy shows a "Logs copied" toast when the clipboard write succeeds', async ({ page }) => {
    // Stub the clipboard to resolve (deterministic across browsers/headless),
    // mirroring the existing dialogs-coverage clipboard test.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async () => {} },
        configurable: true,
      });
    });

    await page.getByTestId('debug-copy-button').click();
    await expect(page.getByText('Logs copied')).toBeVisible({ timeout: TOAST_TIMEOUT });
  });

  test('Copy surfaces a failure toast when the clipboard is unavailable', async ({ page }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {
            throw new Error('clipboard blocked');
          },
        },
        configurable: true,
      });
    });

    await page.getByTestId('debug-copy-button').click();
    await expect(page.getByText('Copy failed')).toBeVisible({ timeout: TOAST_TIMEOUT });
  });
});
