/**
 * E2E tests for section-focus mode (#50).
 *
 * Double-clicking a section row dedicates the screen to that section:
 *  - both side panels (Sections, Detail) collapse,
 *  - the data table opens (~30% of the viewport),
 *  - the toolbar shows the section name (with a map icon) in place of the
 *    project name.
 * Double-clicking that name returns to the normal multi-section layout.
 */

import { test, expect, Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapIdle,
  waitForNoDialogs,
  type SectionSeed,
} from './helpers/app';

const SECTION_NAME = 'Focus Test Passage';

const sectionSeeds: SectionSeed[] = [
  {
    name: SECTION_NAME,
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 15, depth_in: -1, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 270, length: 20, depth_in: -3, depth_out: -6 },
    ],
  },
  {
    name: 'Other Gallery',
    direction: 'out',
    shots: [{ azimuth_in: 270, azimuth_out: 90, length: 8, depth_in: -2, depth_out: -4 }],
  },
];

async function getSectionIdByName(page: Page, name: string): Promise<number> {
  const id = await page.evaluate((sectionName) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => { project: { sections: Array<{ id: number; name: string }> } | null };
        };
      };
    }).__E2E_TEST__;
    const section = stores?.projectStore.getState().project?.sections.find(
      (s) => s.name === sectionName,
    );
    return section?.id ?? -1;
  }, name);
  expect(id).toBeGreaterThan(0);
  return id;
}

test.describe('Section focus mode', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Section Focus Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForNoDialogs(page);
    await waitForMapIdle(page);
  });

  test('double-clicking a section enters focus mode and the name double-click exits', async ({ page }) => {
    const sectionId = await getSectionIdByName(page, SECTION_NAME);

    // Baseline: project name shown, sections panel open, data table closed.
    await expect(page.getByTestId('toolbar-project-name')).toBeVisible();
    await expect(page.getByTestId('sections-panel')).toBeVisible();
    await expect(page.getByTestId('data-table-collapsed-toggle')).toBeVisible();

    // Enter focus mode by double-clicking the section row.
    const sectionRow = page.locator(`[data-testid="section-row-${sectionId}"]`);
    await expect(sectionRow).toBeVisible();
    await sectionRow.dblclick();

    // Toolbar swaps the project name for the focused section name.
    const focusName = page.getByTestId('toolbar-section-focus-name');
    await expect(focusName).toBeVisible();
    await expect(focusName).toContainText(SECTION_NAME);
    await expect(page.getByTestId('toolbar-project-name')).toHaveCount(0);

    // Both side panels collapse; the data table opens.
    await expect(page.getByTestId('sections-panel-collapsed-toggle')).toBeVisible();
    await expect(page.getByTestId('detail-panel-collapsed-toggle')).toBeVisible();
    await expect(page.getByTestId('data-table-open-collapse-toggle')).toBeVisible();

    // Exit by double-clicking the section name in the toolbar.
    await focusName.dblclick();

    // Layout restored: project name back, sections panel open, data table closed.
    await expect(page.getByTestId('toolbar-project-name')).toBeVisible();
    await expect(page.getByTestId('toolbar-section-focus-name')).toHaveCount(0);
    await expect(page.getByTestId('sections-panel')).toBeVisible();
    await expect(page.getByTestId('data-table-collapsed-toggle')).toBeVisible();
  });

  test('the per-row focus button enters focus mode', async ({ page }) => {
    const sectionId = await getSectionIdByName(page, SECTION_NAME);

    await expect(page.getByTestId('toolbar-project-name')).toBeVisible();

    // The focus button is revealed on row hover (opacity-0 otherwise).
    const sectionRow = page.locator(`[data-testid="section-row-${sectionId}"]`);
    await sectionRow.hover();
    const focusButton = page.getByTestId(`section-focus-${sectionId}`);
    await expect(focusButton).toBeVisible();
    await focusButton.click();

    // A single click on the button enters focus mode, just like double-clicking
    // the row: toolbar shows the section name, side panels collapse, table opens.
    const focusName = page.getByTestId('toolbar-section-focus-name');
    await expect(focusName).toBeVisible();
    await expect(focusName).toContainText(SECTION_NAME);
    await expect(page.getByTestId('toolbar-project-name')).toHaveCount(0);
    await expect(page.getByTestId('sections-panel-collapsed-toggle')).toBeVisible();
    await expect(page.getByTestId('detail-panel-collapsed-toggle')).toBeVisible();
    await expect(page.getByTestId('data-table-open-collapse-toggle')).toBeVisible();
  });

  test('deleting the focused section exits focus mode', async ({ page }) => {
    const sectionId = await getSectionIdByName(page, SECTION_NAME);

    // Enter focus mode.
    const sectionRow = page.locator(`[data-testid="section-row-${sectionId}"]`);
    await expect(sectionRow).toBeVisible();
    await sectionRow.dblclick();
    await expect(page.getByTestId('toolbar-section-focus-name')).toBeVisible();

    // Delete the focused section out from under focus mode (e.g. via undo, collab
    // sync, or a delete action). Focus must not linger on a section that's gone.
    await page.evaluate((secId) => {
      const store = (window as unknown as {
        __E2E_TEST__?: { projectStore?: { getState: () => { deleteSection: (id: number) => Promise<unknown> } } };
      }).__E2E_TEST__?.projectStore;
      return store?.getState().deleteSection(secId);
    }, sectionId);

    // Focus mode exits: project name returns, side panels restored.
    await expect(page.getByTestId('toolbar-project-name')).toBeVisible();
    await expect(page.getByTestId('toolbar-section-focus-name')).toHaveCount(0);
    await expect(page.getByTestId('sections-panel')).toBeVisible();
  });

  test('focused heading follows section selection (e.g. clicking another section on the map)', async ({ page }) => {
    const firstId = await getSectionIdByName(page, SECTION_NAME);

    // Enter focus on the first section.
    const sectionRow = page.locator(`[data-testid="section-row-${firstId}"]`);
    await expect(sectionRow).toBeVisible();
    await sectionRow.dblclick();
    const focusName = page.getByTestId('toolbar-section-focus-name');
    await expect(focusName).toContainText(SECTION_NAME);

    // Select another section while focused (simulating a map click into it). The
    // panel is collapsed, so drive the selection through the store as the map does.
    await page.evaluate(() => {
      const ui = (window as unknown as {
        __E2E_TEST__?: {
          projectStore?: { getState: () => { project: { sections: Array<{ id: number; name: string }> } | null } };
          uiStore?: { getState: () => { setSelection: (s: { type: string; sectionId: number }) => void } };
        };
      }).__E2E_TEST__;
      const other = ui?.projectStore?.getState().project?.sections.find((s) => s.name === 'Other Gallery');
      if (other) ui?.uiStore?.getState().setSelection({ type: 'section', sectionId: other.id });
    });

    // The heading must update to the newly selected section.
    await expect(focusName).toContainText('Other Gallery');
    await expect(focusName).not.toContainText(SECTION_NAME);
  });
});
