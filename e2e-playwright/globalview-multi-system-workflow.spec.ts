import { test, expect } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

const ALPHA = '/projects/cave-alpha.stalx';
const BETA = '/projects/cave-beta.stalx';
const GAMMA = '/projects/cave-gamma.stalx';

test.describe('GlobalView Multi-System Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('handles multi-select merge flow then opens a project and returns to global view', async ({ page }) => {
    await page.getByTestId('globalview-view-toggle-list').click();

    const alphaCard = page.getByTestId(`system-card-${ALPHA}`);
    const betaCard = page.getByTestId(`system-card-${BETA}`);
    const gammaCard = page.getByTestId(`system-card-${GAMMA}`);

    await alphaCard.click();
    await betaCard.click({ modifiers: ['ControlOrMeta'] });

    await expect(page.getByTestId('merge-projects-button')).toBeVisible();
    await page.getByTestId('merge-projects-button').click();

    const mergeDialog = page.getByTestId('merge-projects-dialog');
    await expect(mergeDialog).toBeVisible({ timeout: 5000 });
    await expect(mergeDialog).toContainText('Cave System Alpha');
    await expect(mergeDialog).toContainText('Underwater Cave Beta');

    await mergeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(mergeDialog).toBeHidden({ timeout: 5000 });

    await page.keyboard.press('Escape');

    await gammaCard.click();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('single-system-view')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('global-view')).toBeVisible({ timeout: 10000 });
  });
});
