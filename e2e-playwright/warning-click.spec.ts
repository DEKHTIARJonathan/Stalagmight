/**
 * E2E tests for warning click navigation.
 *
 * Verifies that clicking a warning in the Warnings tab navigates to the
 * corresponding shot's details (not "Selection not found").
 * Also covers DMP-imported projects (simulated via multiple seeded sections).
 */

import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapIdle,
  type SectionSeed,
} from './helpers/app';

/** Seed data: one section with shots. */
const sectionSeeds: SectionSeed[] = [
  {
    name: 'Main Tunnel',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 270, length: 12, depth_in: -3, depth_out: -6 },
      { azimuth_in: 120, azimuth_out: 300, length: 8, depth_in: -6, depth_out: -8 },
    ],
  },
];

/** Seed data simulating a DMP import: multiple sections. */
const dmpSectionSeeds: SectionSeed[] = [
  {
    name: 'Main Passage',
    direction: 'in',
    shots: [
      { azimuth_in: 30, azimuth_out: 210, length: 15, depth_in: -2, depth_out: -5 },
      { azimuth_in: 60, azimuth_out: 240, length: 10, depth_in: -5, depth_out: -9 },
    ],
  },
  {
    name: 'Side Tunnel',
    direction: 'out',
    shots: [
      { azimuth_in: 180, azimuth_out: 0, length: 7, depth_in: -3, depth_out: -6 },
    ],
  },
];

/**
 * Inject mock warnings into the project store.
 * Warnings use camelCase field names matching the Rust #[serde(rename_all = "camelCase")] convention.
 */
async function injectWarnings(
  page: Page,
  warnings: Array<{
    sectionId: number;
    shotId: number;
    shotIndex: number;
    code: string;
    message: string;
    severity: 'warning' | 'error';
    isResolved: boolean;
  }>
): Promise<void> {
  await page.evaluate((w) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          setState: (state: { warnings: unknown[] }) => void;
        };
      };
    }).__E2E_TEST__;
    if (stores) {
      stores.projectStore.setState({ warnings: w });
    }
  }, warnings);
}

/** Get section IDs from the project store. */
async function getSectionIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => { project: { sections: Array<{ id: number }> } | null };
        };
      };
    }).__E2E_TEST__;
    return stores?.projectStore.getState().project?.sections.map((s) => s.id) ?? [];
  });
}

/** Get shot IDs for a section. */
async function getShotIdsForSection(page: Page, sectionId: number): Promise<number[]> {
  return page.evaluate(
    (secId) => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: Array<{ id: number; shots: Array<{ id: number }> }> } | null;
            };
          };
        };
      }).__E2E_TEST__;
      const section = stores?.projectStore.getState().project?.sections.find((s) => s.id === secId);
      return section?.shots.map((shot) => shot.id) ?? [];
    },
    sectionId
  );
}

/** Get the current selection state. */
async function getSelectionState(page: Page): Promise<{
  type: string;
  sectionId?: number;
  shotId?: number;
} | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { selection: unknown } };
      };
    }).__E2E_TEST__;
    return stores?.uiStore.getState().selection as {
      type: string;
      sectionId?: number;
      shotId?: number;
    } | null;
  });
}

/** Poll for selection state changes. */
async function pollSelectionState(
  page: Page,
  predicate: (sel: Awaited<ReturnType<typeof getSelectionState>>) => boolean,
  timeout = 5000
): Promise<Awaited<ReturnType<typeof getSelectionState>>> {
  let result: Awaited<ReturnType<typeof getSelectionState>> = null;
  await expect
    .poll(
      async () => {
        const sel = await getSelectionState(page);
        if (predicate(sel)) {
          result = sel;
          return true;
        }
        return false;
      },
      { timeout }
    )
    .toBe(true);
  return result;
}

test.describe('Warning Click Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('clicking a warning navigates to shot details', async ({ page }) => {
    // Create project with sections
    await createProject(page, 'Warning Click Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapIdle(page);

    // Get section and shot IDs
    const sectionIds = await getSectionIds(page);
    const mainSectionId = sectionIds[0]!;
    const shotIds = await getShotIdsForSection(page, mainSectionId);
    const targetShotId = shotIds[1]!; // Second shot

    // Inject a warning for the second shot
    await injectWarnings(page, [
      {
        sectionId: mainSectionId,
        shotId: targetShotId,
        shotIndex: 1,
        code: 'AZIMUTH_DIFF',
        message: `Shot ${mainSectionId}:2 azimuth difference exceeds threshold`,
        severity: 'warning',
        isResolved: false,
      },
    ]);

    // Switch to Warnings tab
    const warningsTab = page.getByTestId('detail-tab-warnings');
    await warningsTab.click();

    // Verify the warning is displayed
    const warningText = page.locator('text=azimuth difference exceeds threshold');
    await expect(warningText).toBeVisible();

    // Click the warning message button (the clickable area)
    const warningButton = warningText.locator('xpath=ancestor::button');
    await warningButton.click();

    // Wait for selection to be updated
    const selection = await pollSelectionState(
      page,
      (sel) => sel?.type === 'shot' && sel?.shotId === targetShotId
    );
    expect(selection?.type).toBe('shot');
    expect(selection?.sectionId).toBe(mainSectionId);
    expect(selection?.shotId).toBe(targetShotId);

    // Verify "Selection not found" is NOT displayed
    const selectionNotFound = page.locator('text=Selection not found');
    await expect(selectionNotFound).toBeHidden();

    // Verify shot detail heading is shown
    const shotHeading = page.locator('h3:has-text("Shot")');
    await expect(shotHeading).toBeVisible();
  });

  test('clicking a warning on a DMP-imported project navigates to shot details', async ({
    page,
  }) => {
    // Create project with multiple sections (simulating a DMP import)
    await createProject(page, 'DMP Warning Test');
    await seedProjectWithSections(page, dmpSectionSeeds);
    await waitForMapIdle(page);

    // Get section and shot IDs
    const sectionIds = await getSectionIds(page);
    expect(sectionIds.length).toBe(2);
    const firstSectionId = sectionIds[0]!;
    const shotIds = await getShotIdsForSection(page, firstSectionId);
    expect(shotIds.length).toBeGreaterThanOrEqual(1);
    const targetShotId = shotIds[0]!;

    // Inject a warning for the first shot of the first section
    await injectWarnings(page, [
      {
        sectionId: firstSectionId,
        shotId: targetShotId,
        shotIndex: 0,
        code: 'LENGTH_ZERO',
        message: `Shot ${firstSectionId}:1 length is zero`,
        severity: 'error',
        isResolved: false,
      },
    ]);

    // Switch to Warnings tab
    const warningsTab = page.getByTestId('detail-tab-warnings');
    await warningsTab.click();

    // Verify the warning is displayed
    const warningText = page.locator('text=length is zero');
    await expect(warningText).toBeVisible();

    // Click the warning
    const warningButton = warningText.locator('xpath=ancestor::button');
    await warningButton.click();

    // Verify navigation works
    const selection = await pollSelectionState(
      page,
      (sel) => sel?.type === 'shot' && sel?.shotId === targetShotId
    );
    expect(selection?.type).toBe('shot');
    expect(selection?.sectionId).toBe(firstSectionId);
    expect(selection?.shotId).toBe(targetShotId);

    // Verify "Selection not found" is NOT displayed
    const selectionNotFound = page.locator('text=Selection not found');
    await expect(selectionNotFound).toBeHidden();

    // Verify shot detail heading is shown
    const shotHeading = page.locator('h3:has-text("Shot")');
    await expect(shotHeading).toBeVisible();
  });
});
