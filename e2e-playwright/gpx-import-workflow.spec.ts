import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject } from './helpers/app';

async function setImportPath(page: import('./fixtures/coverage').Page, path: string): Promise<void> {
  await page.evaluate((selectedPath) => {
    const overrides = (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ as
      | Record<string, unknown>
      | undefined;
    const next = overrides ?? {};
    next['plugin:dialog|open'] = selectedPath;
    (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ = next;
  }, path);
}

test.describe('GPX Import Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('imports GPX from home screen through create-project and placement flow', async ({ page }) => {
    await setImportPath(page, '/mock/reef-traverse.gpx');

    await page.keyboard.press('Control+i');
    await expect(page.getByTestId('new-project-for-import-dialog')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('project-name-input').fill('Reef Traverse Import');
    await page.getByTestId('create-and-continue-button').click();

    await expect(page.getByTestId('gpx-selection-dialog')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('gpx-import-waypoints')).toBeChecked();
    await expect(page.getByTestId('gpx-import-tracks')).toBeChecked();
    await expect(page.getByTestId('gpx-import-routes')).toBeChecked();

    await page.getByTestId('gpx-continue-button').click();
    await expect(page.getByTestId('gpx-placement-dialog')).toBeVisible({ timeout: 10000 });

    const firstStationSelect = page.locator('[data-testid="gpx-placement-dialog"] select').first();
    await firstStationSelect.selectOption('1');
    await page.getByTestId('gpx-import-confirm').click();

    await expect(page.getByTestId('gpx-placement-dialog')).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId('single-system-view')).toBeVisible();

    const projectSummary = await page.evaluate(() => {
      const state = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: unknown[]; zero_datums: unknown[] } | null;
            };
          };
        };
      }).__E2E_TEST__?.projectStore.getState();

      return {
        sectionCount: state?.project?.sections.length ?? 0,
        datumCount: state?.project?.zero_datums.length ?? 0,
      };
    });

    expect(projectSummary.sectionCount).toBeGreaterThan(0);
    expect(projectSummary.datumCount).toBeGreaterThan(0);
  });

  test('imports waypoints-only GPX directly into an existing project', async ({ page }) => {
    await createProject(page, 'Existing GPX Project');
    await setImportPath(page, '/mock/waypoints-only.gpx');

    await page.keyboard.press('Control+i');
    await expect(page.getByTestId('gpx-selection-dialog')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('gpx-import-confirm')).toBeVisible();

    await page.getByTestId('gpx-import-confirm').click();
    await expect(page.getByTestId('gpx-selection-dialog')).toBeHidden({ timeout: 15000 });

    const projectSummary = await page.evaluate(() => {
      const state = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: unknown[]; zero_datums: unknown[] } | null;
            };
          };
        };
      }).__E2E_TEST__?.projectStore.getState();

      return {
        sectionCount: state?.project?.sections.length ?? 0,
        datumCount: state?.project?.zero_datums.length ?? 0,
      };
    });

    expect(projectSummary.sectionCount).toBeGreaterThan(0);
    expect(projectSummary.datumCount).toBeGreaterThan(0);
  });
});
