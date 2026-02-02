import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
} from './helpers/app';

async function openEditSectionDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { openDialog: (dialog: string, data?: Record<string, unknown>) => void } };
        projectStore: { getState: () => { project: { sections: Array<{ id: number }> } | null } };
      };
    }).__E2E_TEST__;

    if (!e2e) {
      throw new Error('E2E stores not available on window');
    }

    const sectionId = e2e.projectStore.getState().project?.sections?.[0]?.id ?? 0;
    e2e.uiStore.getState().openDialog('edit-section', { sectionId });
  });

  await expect(page.getByTestId('edit-section-dialog')).toBeVisible({ timeout: 5000 });
}

test.describe('Dialog Shortcut Guards', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Shortcut Guard');
    await seedProjectWithSections(page, [
      {
        name: 'Main Passage',
        direction: 'in',
        shots: [
          {
            azimuth_in: 45,
            azimuth_out: 225,
            length: 10.5,
            depth_in: -2,
            depth_out: -2.5,
          },
        ],
      },
    ]);
  });

  test('tool shortcuts do not fire when a dialog is open', async ({ page }) => {
    await openEditSectionDialog(page);

    const mapCanvas = page.getByTestId('map-canvas');
    const beforeTool = await mapCanvas.getAttribute('data-active-tool');

    await page.keyboard.press('P');

    await expect(mapCanvas).toHaveAttribute('data-active-tool', beforeTool ?? 'select');
    await expect(page.getByTestId('edit-section-dialog')).toBeVisible();
  });

  test('file shortcuts do not replace the active dialog', async ({ page }) => {
    await openEditSectionDialog(page);

    await page.keyboard.press('Control+I');

    await expect(page.getByTestId('dmp-selection-dialog')).toHaveCount(0);
    await expect(page.getByTestId('edit-section-dialog')).toBeVisible();
  });
});
