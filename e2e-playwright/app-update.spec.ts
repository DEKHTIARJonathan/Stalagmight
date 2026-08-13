import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject, createSectionViaStore } from './helpers/app';
import { setIpcOverrides } from './helpers/ipcOverrides';

/**
 * E2E for the in-app updater (#579): the banner's three states, and the
 * restart button threading through the unsaved-changes exit guard.
 *
 * The automatic launch check fires ~10s after mount, which is too slow for a
 * unit-of-behavior test - these specs drive `updateStore` directly (the same
 * additive `__E2E_TEST__` pattern every other store-seeded spec uses), so the
 * banner/download/restart wiring is exercised without waiting on the timer.
 */

interface UpdateStoreApi {
  getState: () => {
    setAvailable: (info: { version: string; notesUrl: string }) => void;
    startDownloading: () => void;
    setReady: () => void;
  };
}

async function getUpdateStore(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __E2E_TEST__?: { updateStore?: unknown } }).__E2E_TEST__?.updateStore != null,
  );
}

async function seedAvailable(page: import('@playwright/test').Page, version = '9.9.9'): Promise<void> {
  await getUpdateStore(page);
  await page.evaluate((v) => {
    const store = (window as unknown as { __E2E_TEST__: { updateStore: UpdateStoreApi } }).__E2E_TEST__.updateStore;
    store.getState().setAvailable({ version: v, notesUrl: 'https://example.com/notes' });
  }, version);
}

/**
 * The mocked `plugin:window|close` command only counts the call - unlike the
 * real backend's `on_window_event` handler, it does not itself prevent the
 * close and re-emit `tauri://close-requested`. Every close-guard spec
 * (window-close-protection.spec.ts) simulates that re-emission explicitly;
 * `requestUpdateRestart`'s `getCurrentWindow().close()` needs the same nudge
 * before `useBeforeUnload`'s guard chain runs.
 */
async function simulateCloseRequested(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__?.invoke('plugin:event|emit', {
      event: 'tauri://close-requested',
      payload: null,
    });
  });
}

test.describe('In-app update banner', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Update Banner Test');
  });

  test('an available update shows the banner with its version', async ({ page }) => {
    await seedAvailable(page, '9.9.9');
    const banner = page.getByTestId('update-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('9.9.9');
    await expect(page.getByTestId('update-banner-download')).toBeVisible();
    await expect(page.getByTestId('update-banner-notes')).toBeVisible();
    await expect(page.getByTestId('update-banner-dismiss')).toBeVisible();
  });

  test('a download-progress event updates the progress bar while downloading', async ({ page }) => {
    await seedAvailable(page, '9.9.9');
    await page.evaluate(() => {
      const store = (window as unknown as { __E2E_TEST__: { updateStore: UpdateStoreApi } }).__E2E_TEST__.updateStore;
      store.getState().startDownloading();
    });
    await expect(page.getByTestId('update-banner-progress')).toBeVisible();

    await page.evaluate(() => {
      const mock = (window as unknown as { __tauriEventMock?: { emit: (event: string, payload: unknown) => void } }).__tauriEventMock;
      mock?.emit('app-update:download-progress', { downloaded: 50, total: 100 });
    });

    const bar = page.getByTestId('update-banner-progress').locator('[role="progressbar"]');
    await expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  test('Download invokes the download command, then Restart is offered', async ({ page }) => {
    await setIpcOverrides(page, { download_app_update: null });
    await seedAvailable(page, '9.9.9');
    await page.getByTestId('update-banner-download').click();

    await expect(page.getByTestId('update-banner-restart')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('update-banner-download')).toHaveCount(0);
  });

  test('Restart with a dirty project raises the unsaved-changes guard instead of restarting', async ({ page }) => {
    await createSectionViaStore(page, {
      name: 'Update Restart Dirty Section',
      shots: [{ azimuth_in: 0, azimuth_out: 0, length: 5, depth_in: 0, depth_out: 0 }],
    });
    await page.waitForFunction(
      () =>
        (window as unknown as {
          __E2E_TEST__: { projectStore: { getState: () => { isDirty: boolean } } };
        }).__E2E_TEST__.projectStore.getState().isDirty === true,
    );

    await seedAvailable(page, '9.9.9');
    await page.evaluate(() => {
      const store = (window as unknown as { __E2E_TEST__: { updateStore: UpdateStoreApi } }).__E2E_TEST__.updateStore;
      store.getState().startDownloading();
      store.getState().setReady();
    });
    await expect(page.getByTestId('update-banner-restart')).toBeVisible();

    await page.getByTestId('update-banner-restart').click();
    await simulateCloseRequested(page);
    await expect(page.getByTestId('unsaved-changes-dialog')).toBeVisible();

    // Cancelling leaves the app running with the banner intact - no restart happened.
    await page.getByTestId('unsaved-changes-cancel').click();
    await expect(page.getByTestId('unsaved-changes-dialog')).toHaveCount(0);
    await expect(page.getByTestId('update-banner-restart')).toBeVisible();
  });

  test('Dismiss hides the banner for the session, for that version only', async ({ page }) => {
    await seedAvailable(page, '9.9.9');
    await expect(page.getByTestId('update-banner')).toBeVisible();

    await page.getByTestId('update-banner-dismiss').click();
    await expect(page.getByTestId('update-banner')).toHaveCount(0);

    // A DIFFERENT version is not covered by the same dismissal.
    await seedAvailable(page, '10.0.0');
    await expect(page.getByTestId('update-banner')).toBeVisible();
    await expect(page.getByTestId('update-banner')).toContainText('10.0.0');
  });
});
