import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

/**
 * E2E for the structural-integrity warn + repair banner (#17). The mock's
 * check_project_integrity returns issues seeded via __MOCK_SET_INTEGRITY_ISSUES__;
 * repair_project_integrity clears them and returns the count.
 */

async function seedAndCheck(page: Page, issues: string[]): Promise<void> {
  await page.evaluate((seed) => {
    (window as unknown as { __MOCK_SET_INTEGRITY_ISSUES__: (i: string[]) => void })
      .__MOCK_SET_INTEGRITY_ISSUES__(seed);
  }, issues);
  await page.evaluate(async () => {
    await (window as unknown as {
      __E2E_TEST__: { projectStore: { getState: () => { checkProjectIntegrity: () => Promise<string[]> } } };
    }).__E2E_TEST__.projectStore.getState().checkProjectIntegrity();
  });
}

test.describe('Structural-integrity banner', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await expect(page.getByTestId('global-view')).toBeVisible({ timeout: 10000 });
  });

  test('no banner when the project is structurally sound', async ({ page }) => {
    await seedAndCheck(page, []);
    await expect(page.getByTestId('integrity-banner')).toHaveCount(0);
  });

  test('shows issue details in a dialog and repairs from there', async ({ page }) => {
    await seedAndCheck(page, [
      'Merged stations 1:0 and 0:13 are 30.03 m apart but should be the same point',
      'Station merge #0 station_a references missing section 42',
    ]);

    const banner = page.getByTestId('integrity-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('2 integrity issues');

    // Details are shown in a dialog on Review, not on hover.
    await page.getByTestId('integrity-review-button').click();
    const dialog = page.getByTestId('integrity-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('integrity-dialog-list')).toContainText('30.03 m apart');
    await expect(dialog.getByTestId('integrity-dialog-list')).toContainText('missing section 42');

    await page.getByTestId('integrity-dialog-repair').click();

    // Dialog and banner clear; a confirmation toast appears.
    await expect(page.getByTestId('integrity-dialog')).toHaveCount(0);
    await expect(page.getByTestId('integrity-banner')).toHaveCount(0);
    await expect(page.getByText(/Repaired 2 structural issues/)).toBeVisible();
  });

  test('review dialog can be cancelled without repairing', async ({ page }) => {
    await seedAndCheck(page, ['Zero datum #0 references missing section 7']);
    await expect(page.getByTestId('integrity-banner')).toContainText('1 integrity issue');
    await page.getByTestId('integrity-review-button').click();
    await expect(page.getByTestId('integrity-dialog')).toBeVisible();
    await page.getByTestId('integrity-dialog-cancel').click();
    await expect(page.getByTestId('integrity-dialog')).toHaveCount(0);
    // Banner stays — nothing was repaired.
    await expect(page.getByTestId('integrity-banner')).toBeVisible();
  });

  test('banner can be dismissed without opening the dialog', async ({ page }) => {
    await seedAndCheck(page, ['Zero datum #0 references missing section 7']);
    await expect(page.getByTestId('integrity-banner')).toContainText('1 integrity issue');
    await page.getByTestId('integrity-dismiss-button').click();
    await expect(page.getByTestId('integrity-banner')).toHaveCount(0);
  });
});
