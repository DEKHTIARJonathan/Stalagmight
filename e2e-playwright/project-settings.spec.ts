/**
 * E2E for the per-project settings dialog (#57): General (name) + Validation
 * thresholds, stored in the .stalx. Opened from the project overview.
 */
import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject, seedProjectWithSections, waitForMapIdle, type SectionSeed } from './helpers/app';

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Main',
    direction: 'in',
    shots: [{ azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 }],
  },
];

test.describe('Project Settings', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('edits per-project name + validation thresholds', async ({ page }) => {
    await createProject(page, 'Proj Settings');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapIdle(page);

    // Project overview (no selection) on the Details tab carries the button.
    await page.getByTestId('detail-tab-details').click();
    await page.getByTestId('open-project-settings').click();
    await expect(page.getByTestId('project-settings-dialog')).toBeVisible();

    // General tab shows the project name.
    await expect(page.getByTestId('project-settings-name')).toHaveValue('Proj Settings');

    // Experimental tab hosts the Ariane collaboration toggle (moved here).
    await page.getByTestId('project-settings-tab-experimental').click();
    await expect(page.getByTestId('toggle-collaboration')).toBeVisible();

    // Validation tab exposes the same thresholds as the global settings.
    await page.getByTestId('project-settings-tab-validation').click();
    const minInput = page.getByTestId('input-shot-length-min');
    await expect(minInput).toBeVisible();
    await minInput.fill('2');

    await page.getByTestId('project-settings-save').click();
    await expect(page.getByTestId('project-settings-dialog')).toHaveCount(0);

    // The change is reflected in the project's per-project validation config.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __E2E_TEST__?: {
                  projectStore: {
                    getState: () => { project: { validation?: { warn_shot_length_min: number } } | null };
                  };
                };
              }
            ).__E2E_TEST__?.projectStore.getState().project?.validation?.warn_shot_length_min,
        ),
      )
      .toBe(2);
  });
});
