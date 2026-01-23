/**
 * E2E tests for detail panel hyperlinks and center button functionality.
 *
 * Tests the bidirectional navigation between survey elements:
 * - Shot Detail: Start/End Station links, Section link
 * - Station Detail: Previous/Next Shot links, Section link, Merged station links
 * - Section Detail: First/Last Station links (Endpoints)
 * - Center buttons for all detail types
 * - Keyboard navigation (Tab + Enter)
 * - ARIA live announcements for selection changes
 */

import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapIdle,
  type SectionSeed,
} from './helpers/app';

/**
 * Test data with multiple sections, shots, and stations.
 * Includes a station that will be set up with merged_with references.
 */
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
  {
    name: 'Side Passage',
    direction: 'out',
    shots: [
      { azimuth_in: 180, azimuth_out: 0, length: 7, depth_in: -2, depth_out: -4 },
      { azimuth_in: 200, azimuth_out: 20, length: 5, depth_in: -4, depth_out: -5 },
    ],
  },
  {
    name: 'Single Station Section',
    direction: 'in',
    shots: [], // Empty section - single station only
  },
];

/**
 * Helper to create a project with test sections.
 */
async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Detail Links Test');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapIdle(page);
}

/**
 * Helper to get section IDs from the project store.
 */
async function getSectionIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: { sections: Array<{ id: number }> } | null } };
      };
    }).__E2E_TEST__;
    return stores?.projectStore.getState().project?.sections.map(s => s.id) ?? [];
  });
}

/**
 * Helper to get the current selection state.
 */
async function getSelectionState(page: Page): Promise<{
  type: string;
  sectionId?: number;
  stationRef?: { section_id: number; station_index: number };
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
      stationRef?: { section_id: number; station_index: number };
      shotId?: number;
    } | null;
  });
}

/**
 * Helper to poll for selection state changes.
 */
async function pollSelectionState(
  page: Page,
  predicate: (sel: Awaited<ReturnType<typeof getSelectionState>>) => boolean,
  timeout = 5000
): Promise<Awaited<ReturnType<typeof getSelectionState>>> {
  let result: Awaited<ReturnType<typeof getSelectionState>> = null;
  await expect.poll(
    async () => {
      const sel = await getSelectionState(page);
      if (predicate(sel)) {
        result = sel;
        return true;
      }
      return false;
    },
    { timeout }
  ).toBe(true);
  return result;
}

/**
 * Helper to select a section by clicking its row.
 */
async function selectSectionById(page: Page, sectionId: number): Promise<void> {
  const sectionRow = page.locator(`[data-testid="section-row-${sectionId}"]`);
  await expect(sectionRow).toBeVisible();
  await sectionRow.click();
  await pollSelectionState(page, (sel) => sel?.type === 'section' && sel?.sectionId === sectionId);
}

/**
 * Helper to select a station by clicking on the map or via store.
 */
async function selectStation(page: Page, sectionId: number, stationIndex: number): Promise<void> {
  await page.evaluate(({ secId, idx }) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { setSelection: (sel: unknown) => void } };
      };
    }).__E2E_TEST__;
    if (stores) {
      stores.uiStore.getState().setSelection({
        type: 'station',
        stationRef: { section_id: secId, station_index: idx },
      });
    }
  }, { secId: sectionId, idx: stationIndex });

  await pollSelectionState(
    page,
    (sel) =>
      sel?.type === 'station' &&
      sel?.stationRef?.section_id === sectionId &&
      sel?.stationRef?.station_index === stationIndex
  );
}

/**
 * Helper to select a shot via store.
 */
async function selectShot(page: Page, sectionId: number, shotId: number): Promise<void> {
  await page.evaluate(({ secId, sId }) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { setSelection: (sel: unknown) => void } };
      };
    }).__E2E_TEST__;
    if (stores) {
      stores.uiStore.getState().setSelection({
        type: 'shot',
        sectionId: secId,
        shotId: sId,
      });
    }
  }, { secId: sectionId, sId: shotId });

  await pollSelectionState(
    page,
    (sel) => sel?.type === 'shot' && sel?.sectionId === sectionId && sel?.shotId === shotId
  );
}

/**
 * Helper to get shot IDs for a section.
 */
async function getShotIdsForSection(page: Page, sectionId: number): Promise<number[]> {
  return page.evaluate((secId) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            project: { sections: Array<{ id: number; shots: Array<{ id: number }> }> } | null;
          };
        };
      };
    }).__E2E_TEST__;
    const section = stores?.projectStore.getState().project?.sections.find(s => s.id === secId);
    return section?.shots.map(shot => shot.id) ?? [];
  }, sectionId);
}

/**
 * Helper to get the text content of the ARIA live region.
 */
async function getAnnouncerText(page: Page): Promise<string> {
  const announcer = page.locator('#selection-announcer');
  return (await announcer.textContent()) ?? '';
}

/**
 * Helper to add merged station data to the mock project.
 * Uses zustand's setState directly to update the stations array.
 */
async function addMergedStationToProject(
  page: Page,
  targetSectionId: number,
  targetStationIndex: number,
  mergedWith: Array<{ section_id: number; station_index: number }>
): Promise<void> {
  await page.evaluate(
    ({ targetSecId, targetIdx, mergedRefs }) => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              stations: Array<{
                station_ref: { section_id: number; station_index: number };
                merged_with: Array<{ section_id: number; station_index: number }>;
              }>;
            };
            setState: (state: { stations: unknown[] }) => void;
          };
        };
      }).__E2E_TEST__;

      if (!stores) return;

      const state = stores.projectStore.getState();
      const updatedStations = state.stations.map((station) => {
        if (
          station.station_ref.section_id === targetSecId &&
          station.station_ref.station_index === targetIdx
        ) {
          return {
            ...station,
            merged_with: mergedRefs,
          };
        }
        return station;
      });

      stores.projectStore.setState({ stations: updatedStations });
    },
    { targetSecId: targetSectionId, targetIdx: targetStationIndex, mergedRefs: mergedWith }
  );
}

test.describe('Detail Panel Links', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test.describe('Shot Detail Links', () => {
    test('clicking Start Station link changes selection to station', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Find and click the Start Station link
      // Shot at index 0 has Start Station at index 0 (position 1)
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await expect(startStationLink).toBeVisible();
      await startStationLink.click();

      // Selection should change to station
      const selection = await pollSelectionState(
        page,
        (sel) => sel?.type === 'station' && sel?.stationRef?.station_index === 0
      );
      expect(selection?.type).toBe('station');
      expect(selection?.stationRef?.section_id).toBe(mainSectionId);
      expect(selection?.stationRef?.station_index).toBe(0);
    });

    test('clicking End Station link changes selection to station', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Find and click the End Station link
      // Shot at index 0 has End Station at index 1 (position 2)
      const endStationLink = page.getByTestId(`station-${mainSectionId}-2-link`);
      await expect(endStationLink).toBeVisible();
      await endStationLink.click();

      // Selection should change to station
      const selection = await pollSelectionState(
        page,
        (sel) => sel?.type === 'station' && sel?.stationRef?.station_index === 1
      );
      expect(selection?.type).toBe('station');
      expect(selection?.stationRef?.section_id).toBe(mainSectionId);
      expect(selection?.stationRef?.station_index).toBe(1);
    });

    test('clicking Section link changes selection to section', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Find and click the Section link
      const sectionLink = page.getByTestId(`section-${mainSectionId}-link`);
      await expect(sectionLink).toBeVisible();
      await sectionLink.click();

      // Selection should change to section
      const selection = await pollSelectionState(
        page,
        (sel) => sel?.type === 'section' && sel?.sectionId === mainSectionId
      );
      expect(selection?.type).toBe('section');
      expect(selection?.sectionId).toBe(mainSectionId);
    });
  });

  test.describe('Station Detail Links', () => {
    test('clicking Previous Shot link changes selection to shot', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select station at index 2 (position 3) - has previous shot at index 1
      await selectStation(page, mainSectionId, 2);

      // Find and click the Previous Shot link
      // Station at index 2 has Previous Shot at index 1 (position 2)
      const prevShotLink = page.getByTestId(`shot-${mainSectionId}-2-link`);
      await expect(prevShotLink).toBeVisible();
      await prevShotLink.click();

      // Selection should change to shot
      const selection = await pollSelectionState(page, (sel) => sel?.type === 'shot');
      expect(selection?.type).toBe('shot');
      expect(selection?.sectionId).toBe(mainSectionId);
    });

    test('clicking Next Shot link changes selection to shot', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select station at index 1 (position 2) - has next shot at index 1
      await selectStation(page, mainSectionId, 1);

      // Find and click the Next Shot link
      // Station at index 1 has Next Shot at index 1 (position 2)
      const nextShotLink = page.getByTestId(`shot-${mainSectionId}-2-link`);
      await expect(nextShotLink).toBeVisible();
      await nextShotLink.click();

      // Selection should change to shot
      const selection = await pollSelectionState(page, (sel) => sel?.type === 'shot');
      expect(selection?.type).toBe('shot');
      expect(selection?.sectionId).toBe(mainSectionId);
    });

    test('first station does not show Previous Shot link', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select station at index 0 (first station)
      await selectStation(page, mainSectionId, 0);

      // Station detail should be visible
      const stationDetail = page.getByTestId('station-detail');
      await expect(stationDetail).toBeVisible();

      // Previous Shot label should not be visible
      const prevShotLabel = stationDetail.locator('text=Previous Shot');
      await expect(prevShotLabel).toBeHidden();

      // Next Shot should be visible since there are shots
      const nextShotLabel = stationDetail.locator('text=Next Shot');
      await expect(nextShotLabel).toBeVisible();
    });

    test('last station does not show Next Shot link', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Main section has 3 shots, so 4 stations (indices 0-3)
      // Last station is at index 3
      await selectStation(page, mainSectionId, 3);

      // Station detail should be visible
      const stationDetail = page.getByTestId('station-detail');
      await expect(stationDetail).toBeVisible();

      // Next Shot label should not be visible
      const nextShotLabel = stationDetail.locator('text=Next Shot');
      await expect(nextShotLabel).toBeHidden();

      // Previous Shot should be visible
      const prevShotLabel = stationDetail.locator('text=Previous Shot');
      await expect(prevShotLabel).toBeVisible();
    });

    test('clicking merged station link changes selection', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const sideSectionId = sectionIds[1]!;

      // Add merged station reference to station at index 3 in main section
      // Merge with station 0 in side section
      await addMergedStationToProject(page, mainSectionId, 3, [
        { section_id: sideSectionId, station_index: 0 },
      ]);

      // Select the station with merge
      await selectStation(page, mainSectionId, 3);

      // Station detail should show merged station link
      const stationDetail = page.getByTestId('station-detail');
      await expect(stationDetail).toBeVisible();

      // Find and click the merged station link
      const mergedLink = page.getByTestId(`station-${sideSectionId}-1-link`);
      await expect(mergedLink).toBeVisible();
      await mergedLink.click();

      // Selection should change to the merged station
      const selection = await pollSelectionState(
        page,
        (sel) =>
          sel?.type === 'station' &&
          sel?.stationRef?.section_id === sideSectionId &&
          sel?.stationRef?.station_index === 0
      );
      expect(selection?.type).toBe('station');
      expect(selection?.stationRef?.section_id).toBe(sideSectionId);
      expect(selection?.stationRef?.station_index).toBe(0);
    });
  });

  test.describe('Section Detail Links', () => {
    test('clicking First Station link changes selection', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select the section
      await selectSectionById(page, mainSectionId);

      // Section detail should be visible
      const sectionDetail = page.getByTestId('section-detail');
      await expect(sectionDetail).toBeVisible();

      // Find and click the First Station link
      const firstStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await expect(firstStationLink).toBeVisible();
      await firstStationLink.click();

      // Selection should change to station
      const selection = await pollSelectionState(
        page,
        (sel) =>
          sel?.type === 'station' &&
          sel?.stationRef?.section_id === mainSectionId &&
          sel?.stationRef?.station_index === 0
      );
      expect(selection?.type).toBe('station');
      expect(selection?.stationRef?.station_index).toBe(0);
    });

    test('clicking Last Station link changes selection', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select the section
      await selectSectionById(page, mainSectionId);

      // Section detail should be visible
      const sectionDetail = page.getByTestId('section-detail');
      await expect(sectionDetail).toBeVisible();

      // Main section has 3 shots, so last station is at index 3 (position 4)
      const lastStationLink = page.getByTestId(`station-${mainSectionId}-4-link`);
      await expect(lastStationLink).toBeVisible();
      await lastStationLink.click();

      // Selection should change to station
      const selection = await pollSelectionState(
        page,
        (sel) =>
          sel?.type === 'station' &&
          sel?.stationRef?.section_id === mainSectionId &&
          sel?.stationRef?.station_index === 3
      );
      expect(selection?.type).toBe('station');
      expect(selection?.stationRef?.station_index).toBe(3);
    });

    test('single-station section shows Only Station', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const singleStationSectionId = sectionIds[2]!; // Third section has no shots

      // Select the single-station section
      await selectSectionById(page, singleStationSectionId);

      // Section detail should be visible
      const sectionDetail = page.getByTestId('section-detail');
      await expect(sectionDetail).toBeVisible();

      // Should show "Only Station" instead of "First Station" / "Last Station"
      const onlyStationLabel = sectionDetail.locator('text=Only Station');
      await expect(onlyStationLabel).toBeVisible();

      // Should not show "First Station" or "Last Station"
      const firstStationLabel = sectionDetail.locator('text=First Station');
      const lastStationLabel = sectionDetail.locator('text=Last Station');
      await expect(firstStationLabel).toBeHidden();
      await expect(lastStationLabel).toBeHidden();
    });
  });

  test.describe('Center Buttons', () => {
    test('shot center button has correct aria-label', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Find the center button
      const centerButton = page.getByTestId('center-shot-button');
      await expect(centerButton).toBeVisible();

      // Verify aria-label
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).toContain('Center map on shot');
      expect(ariaLabel).toContain(`${mainSectionId}:1`);
    });

    test('station center button has correct aria-label', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select station at index 0
      await selectStation(page, mainSectionId, 0);

      // Find the center button
      const centerButton = page.getByTestId('center-station-button');
      await expect(centerButton).toBeVisible();

      // Verify aria-label
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).toContain('Center map on station');
      expect(ariaLabel).toContain(`${mainSectionId}:1`);
    });

    test('section center button has correct aria-label', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select the section
      await selectSectionById(page, mainSectionId);

      // Find the center button
      const centerButton = page.getByTestId('center-section-button');
      await expect(centerButton).toBeVisible();

      // Verify aria-label
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).toContain('Center map on section');
      expect(ariaLabel).toContain('Main Tunnel');
    });

    test('center button is keyboard accessible', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select the section
      await selectSectionById(page, mainSectionId);

      // Find the center button
      const centerButton = page.getByTestId('center-section-button');
      await expect(centerButton).toBeVisible();

      // Verify the button is focusable
      await centerButton.focus();
      await expect(centerButton).toBeFocused();

      // Verify the button is not disabled and can be activated
      await expect(centerButton).toBeEnabled();

      // Verify the button has type="button" (proper keyboard semantics)
      await expect(centerButton).toHaveAttribute('type', 'button');
    });
  });

  test.describe('Keyboard Navigation', () => {
    test('Tab navigates through links in detail panel', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Focus the Start Station link first
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await startStationLink.focus();
      await expect(startStationLink).toBeFocused();

      // Tab to next element (End Station link)
      await page.keyboard.press('Tab');

      const endStationLink = page.getByTestId(`station-${mainSectionId}-2-link`);
      await expect(endStationLink).toBeFocused();

      // Tab to next element (Section link)
      await page.keyboard.press('Tab');

      const sectionLink = page.getByTestId(`section-${mainSectionId}-link`);
      await expect(sectionLink).toBeFocused();
    });

    test('Enter activates focused link', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Focus the Start Station link
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await startStationLink.focus();
      await expect(startStationLink).toBeFocused();

      // Press Enter to activate
      await page.keyboard.press('Enter');

      // Selection should change to station
      const selection = await pollSelectionState(
        page,
        (sel) => sel?.type === 'station' && sel?.stationRef?.station_index === 0
      );
      expect(selection?.type).toBe('station');
    });

    test('links have visible focus ring', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Focus the Start Station link
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await startStationLink.focus();

      // Check that the element has focus styles applied
      // The component uses: focus:ring-2 focus:ring-accent focus:ring-inset
      const hasRingClass = await startStationLink.evaluate((el) => {
        const classes = el.className;
        return classes.includes('focus:ring-2') || classes.includes('focus:ring-accent');
      });
      expect(hasRingClass).toBe(true);
    });
  });

  test.describe('Accessibility', () => {
    test('all links have aria-labels', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Check Start Station link aria-label
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      const startAriaLabel = await startStationLink.getAttribute('aria-label');
      expect(startAriaLabel).toMatch(/Select station/i);

      // Check End Station link aria-label
      const endStationLink = page.getByTestId(`station-${mainSectionId}-2-link`);
      const endAriaLabel = await endStationLink.getAttribute('aria-label');
      expect(endAriaLabel).toMatch(/Select station/i);

      // Check Section link aria-label
      const sectionLink = page.getByTestId(`section-${mainSectionId}-link`);
      const sectionAriaLabel = await sectionLink.getAttribute('aria-label');
      expect(sectionAriaLabel).toMatch(/Select section/i);
    });

    test('ARIA live region announces selection changes', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select the first shot
      await selectShot(page, mainSectionId, firstShotId);

      // Click the Start Station link
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await startStationLink.click();

      // Check the ARIA live region for the announcement
      await expect.poll(async () => {
        const text = await getAnnouncerText(page);
        return text.toLowerCase().includes('selected') && text.toLowerCase().includes('station');
      }, { timeout: 5000 }).toBe(true);
    });

    test('ARIA live region exists and has correct attributes', async ({ page }) => {
      await createProjectWithSections(page);

      // Check that the ARIA live region exists
      const announcer = page.locator('#selection-announcer');
      await expect(announcer).toBeAttached();

      // Verify ARIA attributes
      await expect(announcer).toHaveAttribute('role', 'status');
      await expect(announcer).toHaveAttribute('aria-live', 'polite');
      await expect(announcer).toHaveAttribute('aria-atomic', 'true');
    });
  });

  test.describe('Edge Cases', () => {
    test('verifies shot at index 0 links to correct stations', async ({ page }) => {
      // Concrete example from spec:
      // Shot at index 0 (display "1") -> Start Station index 0 (display "1"), End Station index 1 (display "2")
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select shot at index 0
      await selectShot(page, mainSectionId, firstShotId);

      // Verify Start Station link shows position 1
      const startLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await expect(startLink).toBeVisible();
      await expect(startLink).toHaveText(`${mainSectionId}:1`);

      // Verify End Station link shows position 2
      const endLink = page.getByTestId(`station-${mainSectionId}-2-link`);
      await expect(endLink).toBeVisible();
      await expect(endLink).toHaveText(`${mainSectionId}:2`);
    });

    test('verifies station at index 0 has no previous shot', async ({ page }) => {
      // Station index 0: No previous shot, Next shot = shots[0] (display "1")
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select station at index 0
      await selectStation(page, mainSectionId, 0);

      const stationDetail = page.getByTestId('station-detail');
      await expect(stationDetail).toBeVisible();

      // Should not have Previous Shot
      await expect(stationDetail.locator('text=Previous Shot')).toBeHidden();

      // Should have Next Shot with position 1
      await expect(stationDetail.locator('text=Next Shot')).toBeVisible();
      const nextShotLink = page.getByTestId(`shot-${mainSectionId}-1-link`);
      await expect(nextShotLink).toBeVisible();
    });

    test('verifies station at middle index has both prev and next shots', async ({ page }) => {
      // Station index 1: Previous shot = shots[0] (display "1"), Next shot = shots[1] (display "2")
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select station at index 1
      await selectStation(page, mainSectionId, 1);

      const stationDetail = page.getByTestId('station-detail');
      await expect(stationDetail).toBeVisible();

      // Should have Previous Shot with position 1
      await expect(stationDetail.locator('text=Previous Shot')).toBeVisible();
      const prevShotLink = page.getByTestId(`shot-${mainSectionId}-1-link`);
      await expect(prevShotLink).toBeVisible();

      // Should have Next Shot with position 2
      await expect(stationDetail.locator('text=Next Shot')).toBeVisible();
      const nextShotLink = page.getByTestId(`shot-${mainSectionId}-2-link`);
      await expect(nextShotLink).toBeVisible();
    });
  });
});
