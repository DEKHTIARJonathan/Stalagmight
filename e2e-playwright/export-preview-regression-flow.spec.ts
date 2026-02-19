import { test, expect } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
} from './helpers/app';

test.describe('Export Preview Regression Flow', () => {
  test('renders and updates image preview using a seeded real project state', async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Export Regression Scenario');

    await seedProjectWithSections(page, [
      {
        name: 'Mainline',
        shots: [
          { azimuth_in: 45, azimuth_out: 45, length: 10, depth_in: -1, depth_out: -2 },
          { azimuth_in: 55, azimuth_out: 55, length: 8, depth_in: -2, depth_out: -2.8 },
        ],
      },
      {
        name: 'Sidebranch',
        shots: [
          { azimuth_in: 120, azimuth_out: 120, length: 6, depth_in: -2.8, depth_out: -3.1 },
          { azimuth_in: 135, azimuth_out: 135, length: 5, depth_in: -3.1, depth_out: -3.6 },
        ],
      },
    ]);

    await page.keyboard.press('Control+e');
    await expect(page.getByTestId('export-dialog')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('export-type-image').click();
    await expect(page.getByTestId('export-preview')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('option-include-grid').check();
    await page.getByTestId('option-include-section-names').uncheck();

    const themeToggle = page.getByTestId('export-theme-toggle');
    await themeToggle.click();
    await expect(themeToggle).toContainText('Light');
    await themeToggle.click();
    await expect(themeToggle).toContainText('Dark');

    await page.getByTestId('export-button').click();

    await page.waitForFunction(() => {
      const mocks = (window as unknown as {
        __E2E_MOCKS__?: {
          getLastExportImageArgs: () => { options?: { include_grid?: boolean; include_section_names?: boolean } } | null;
        };
      }).__E2E_MOCKS__;

      const args = mocks?.getLastExportImageArgs?.();
      return Boolean(args && args.options);
    });

    const exportArgs = await page.evaluate(() => {
      const mocks = (window as unknown as {
        __E2E_MOCKS__?: {
          getLastExportImageArgs: () => { options?: { include_grid?: boolean; include_section_names?: boolean } } | null;
        };
      }).__E2E_MOCKS__;
      return mocks?.getLastExportImageArgs?.() ?? null;
    });

    expect(exportArgs).not.toBeNull();
    expect(exportArgs?.options?.include_grid).toBe(true);
    expect(exportArgs?.options?.include_section_names).toBe(false);
  });
});
