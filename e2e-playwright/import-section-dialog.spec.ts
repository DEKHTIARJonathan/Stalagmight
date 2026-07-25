import { test, expect, Page } from './fixtures/coverage';
import { setupMockedPage, createProject } from './helpers/app';

/**
 * Coverage ported from the retired WDIO `import-section-dialog` spec (#120).
 *
 * The manual "Import / Create Section" dialog (`ImportDialog`, rendered for the
 * `import` dialog type - see App.tsx) has no other Playwright twin, so this is
 * its only mocked-tier coverage: it opens with the section-name field and the
 * Create / Cancel actions, the name field is wired, and Cancel closes it.
 */
async function openImportSectionDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { openDialog: (dialog: string) => void } } };
    }).__E2E_TEST__;
    if (!e2e) throw new Error('E2E stores not available on window');
    e2e.uiStore.getState().openDialog('import');
  });
  await expect(page.getByTestId('import-section-dialog')).toBeVisible({ timeout: 5000 });
}

test.describe('Import / Create Section dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Import Section Test');
  });

  test('opens with the section-name field and Create/Cancel actions', async ({ page }) => {
    await openImportSectionDialog(page);

    const dialog = page.getByTestId('import-section-dialog');
    await expect(dialog.getByTestId('section-name-input')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Create Section/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Cancel$/i })).toBeVisible();

    // Cancel from a clean form closes the dialog.
    await dialog.getByRole('button', { name: /^Cancel$/i }).click();
    await expect(page.getByTestId('import-section-dialog')).toBeHidden({ timeout: 5000 });
  });

  test('accepts a section name in the name field', async ({ page }) => {
    await openImportSectionDialog(page);

    const nameInput = page.getByTestId('import-section-dialog').getByTestId('section-name-input');
    await nameInput.fill('Main Line');
    await expect(nameInput).toHaveValue('Main Line');
  });
});
