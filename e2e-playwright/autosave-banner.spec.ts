import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage, createProject } from './helpers/app';

/**
 * E2E for the autosave-failure banner (docs/notifications.md: a failing
 * background autosave is an ongoing condition - banner-class, not a modal and
 * not a toast). The debounced autosave hook is just `saveProject(path?, true)`,
 * so the specs drive that store call directly and assert the surface.
 */

async function setIpcOverrides(page: Page, overrides: Record<string, unknown>): Promise<void> {
  await page.evaluate((nextOverrides) => {
    const current = (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ as
      | Record<string, unknown>
      | undefined;
    (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ = {
      ...(current ?? {}),
      ...nextOverrides,
    };
  }, overrides);
}

async function clearIpcOverrideKeys(page: Page, commands: string[]): Promise<void> {
  await page.evaluate((keys) => {
    const current = (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ as
      | Record<string, unknown>
      | undefined;
    if (!current) return;
    for (const key of keys) delete current[key];
  }, commands);
}

async function runAutosave(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as unknown as {
      __E2E_TEST__: {
        projectStore: {
          getState: () => { saveProject: (path?: string, isAutosave?: boolean) => Promise<unknown> };
        };
      };
    }).__E2E_TEST__.projectStore.getState().saveProject(undefined, true);
  });
}

test.describe('Autosave-failure banner', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Autosave Banner Test');
  });

  test('a failing autosave raises the banner; a manual save is not required to see it', async ({ page }) => {
    await setIpcOverrides(page, {
      save_project: { success: false, error: 'Disk full: no space left on device' },
    });
    await runAutosave(page);

    const banner = page.getByTestId('autosave-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Autosave is failing');
    await expect(banner).toContainText('Disk full');
    // Banner-class, not modal: no error dialog for a background failure.
    await expect(page.getByTestId('error-dialog')).toHaveCount(0);
  });

  test('Dismiss hides the banner until the next failing autosave', async ({ page }) => {
    await setIpcOverrides(page, {
      save_project: { success: false, error: 'Disk full: no space left on device' },
    });
    await runAutosave(page);
    await expect(page.getByTestId('autosave-banner')).toBeVisible();

    await page.getByTestId('autosave-dismiss-button').click();
    await expect(page.getByTestId('autosave-banner')).toHaveCount(0);

    await runAutosave(page);
    await expect(page.getByTestId('autosave-banner')).toBeVisible();
  });

  test('Save now retries; a successful save clears the banner', async ({ page }) => {
    await setIpcOverrides(page, {
      save_project: { success: false, error: 'Disk full: no space left on device' },
    });
    await runAutosave(page);
    await expect(page.getByTestId('autosave-banner')).toBeVisible();

    // Space freed up: the retry succeeds and the condition clears.
    await clearIpcOverrideKeys(page, ['save_project']);
    await page.getByTestId('autosave-save-button').click();
    await expect(page.getByTestId('autosave-banner')).toHaveCount(0);
  });

  test('the raw FS_PERMISSION_DENIED marker never renders; the friendly line does', async ({ page }) => {
    await setIpcOverrides(page, {
      save_project: { success: false, error: 'FS_PERMISSION_DENIED: operation not permitted' },
    });
    await runAutosave(page);

    const banner = page.getByTestId('autosave-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Folder access denied');
    await expect(banner).not.toContainText('FS_PERMISSION_DENIED');
    // The save-permission dialog stays user-initiated-only - not on autosave.
    await expect(page.getByTestId('save-permission-dialog')).toHaveCount(0);
  });
});
