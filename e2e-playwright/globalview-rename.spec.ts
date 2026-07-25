import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

/**
 * E2E for renaming a project from the GlobalView metadata panel.
 * The mock's set_project_name_for_path records a per-path name override that
 * list_recent_projects then reflects, so the rename is observable end-to-end.
 */

const ALPHA = '/projects/cave-alpha.stalx';

async function selectAlpha(page: Page): Promise<void> {
  await page.getByTestId(`system-card-${ALPHA}`).click();
  await expect(page.getByTestId('metadata-name')).toContainText('Cave System Alpha');
}

test.describe('GlobalView - rename project', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await expect(page.getByTestId('global-view')).toBeVisible({ timeout: 10000 });
    await selectAlpha(page);
  });

  test('edits the name and reflects it in the panel and the card', async ({ page }) => {
    await page.getByTestId('metadata-name-edit').click();
    const input = page.getByTestId('metadata-name-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Cave System Alpha');

    await input.fill('Renamed Cave');
    await page.getByTestId('metadata-name-save').click();

    // Panel reflects the new name (after the recents list refreshes).
    await expect(page.getByTestId('metadata-name')).toContainText('Renamed Cave');
    // And the card in the list updates too.
    await expect(page.getByTestId(`system-card-${ALPHA}`)).toContainText('Renamed Cave');
  });

  test('saves on Enter', async ({ page }) => {
    await page.getByTestId('metadata-name-edit').click();
    await page.getByTestId('metadata-name-input').fill('Enter Named');
    await page.getByTestId('metadata-name-input').press('Enter');
    await expect(page.getByTestId('metadata-name')).toContainText('Enter Named');
  });

  test('Escape cancels without changing the name', async ({ page }) => {
    await page.getByTestId('metadata-name-edit').click();
    await page.getByTestId('metadata-name-input').fill('Should Not Stick');
    await page.getByTestId('metadata-name-input').press('Escape');
    await expect(page.getByTestId('metadata-name')).toContainText('Cave System Alpha');
    await expect(page.getByTestId('metadata-name-input')).toHaveCount(0);
  });

  test('disables save for an empty name', async ({ page }) => {
    await page.getByTestId('metadata-name-edit').click();
    await page.getByTestId('metadata-name-input').fill('   ');
    await expect(page.getByTestId('metadata-name-save')).toBeDisabled();
  });
});
