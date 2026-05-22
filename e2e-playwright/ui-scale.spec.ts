import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

/**
 * UI scale (whole-interface zoom) via the Settings → Display slider and the
 * Ctrl+= / Ctrl+- / Ctrl+0 shortcuts. The two stay in sync through the
 * `ui-scale-change` window event.
 */
test.describe('UI Scale', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  async function openDisplaySettings(page: Page): Promise<void> {
    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('settings-tab-display').click();
    await expect(page.getByTestId('settings-panel-display')).toBeVisible({ timeout: 5000 });
  }

  test('Ctrl shortcuts adjust scale and keep the slider in sync', async ({ page }) => {
    await openDisplaySettings(page);

    const value = page.getByTestId('ui-scale-value');
    const slider = page.getByTestId('input-ui-scale');

    await expect(value).toHaveText('100%');
    await expect(slider).toHaveValue('1');

    await page.keyboard.press('Control+Equal');
    await page.keyboard.press('Control+Equal');
    await expect(value).toHaveText('120%');
    await expect(slider).toHaveValue('1.2');

    await page.keyboard.press('Control+Minus');
    await expect(value).toHaveText('110%');

    // Ctrl+0 resets to 100%.
    await page.keyboard.press('Control+0');
    await expect(value).toHaveText('100%');
    await expect(slider).toHaveValue('1');
  });

  test('reset button returns scale to 100%', async ({ page }) => {
    await openDisplaySettings(page);

    const value = page.getByTestId('ui-scale-value');
    const reset = page.getByTestId('setting-ui-scale-reset');

    // Reset is disabled at the default value.
    await expect(reset).toBeDisabled();

    await page.keyboard.press('Control+Equal');
    await expect(value).toHaveText('110%');
    await expect(reset).toBeEnabled();

    await reset.click();
    await expect(value).toHaveText('100%');
    await expect(reset).toBeDisabled();
  });
});
