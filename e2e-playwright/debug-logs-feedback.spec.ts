import { test, expect } from './fixtures/coverage';
import { setupMockedPage, openDebugFromMenu } from './helpers/app';

/**
 * E2E for issue #49 - the Debug Logs window must give transient toast feedback on
 * Refresh and Copy (both were previously silent). The toast stack renders at the
 * app level via a portal (z above the modal), so it's visible over the dialog.
 * Each test uses a fresh page, so per-key de-duplication never crosses tests.
 *
 * Assertions are scoped to the visible toast (`data-testid="toast"`) rather than
 * bare text: the stack also mirrors each message into an off-screen live region
 * for screen readers, so a page-wide text lookup would match twice.
 *
 * The 2s deadline sits comfortably inside the toast's own dwell (5s before the
 * fade even starts), so the visibility poll can't race the lifecycle - the toast
 * appears within a few ms of the click, leaving a wide margin.
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
    await expect(page.getByTestId('toast')).toContainText('Logs refreshed', { timeout: TOAST_TIMEOUT });
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
    await expect(page.getByTestId('toast')).toContainText('Logs copied', { timeout: TOAST_TIMEOUT });
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
    await expect(page.getByTestId('toast')).toContainText('Copy failed', { timeout: TOAST_TIMEOUT });
  });
});
