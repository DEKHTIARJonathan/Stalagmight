/**
 * E2E tests for DetailLink hover/focus highlighting.
 *
 * Tests verify that focusing DetailLink elements in the DetailPanel
 * highlights the corresponding elements on the map via uiStore state changes.
 *
 * IMPORTANT: These tests use focus() instead of hover() because:
 * 1. Playwright's hover() doesn't reliably trigger React's onMouseEnter handlers
 * 2. The DetailLink component treats focus and hover identically for highlighting
 * 3. Focus-based testing is more reliable in headless browsers
 *
 * The tests verify uiStore state rather than visual map styling because:
 * 1. The map styling is driven by uiStore state (verified in other tests)
 * 2. State verification is more reliable and faster than visual assertions
 * 3. MapLibre feature-state changes are not easily observable in Playwright
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
];

/**
 * Helper to create a project with test sections.
 */
async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Detail Link Hover Test');
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
 * Helper to get the current hover state from uiStore.
 */
async function getHoverState(page: Page): Promise<{
  hoveredStation: { section_id: number; station_index: number } | null;
  hoveredShot: { sectionId: number; shotId: number } | null;
  hoveredSectionId: number | null;
}> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            hoveredStation: { section_id: number; station_index: number } | null;
            hoveredShot: { sectionId: number; shotId: number } | null;
            hoveredSectionId: number | null;
          };
        };
      };
    }).__E2E_TEST__;
    const state = stores?.uiStore.getState();
    return {
      hoveredStation: state?.hoveredStation ?? null,
      hoveredShot: state?.hoveredShot ?? null,
      hoveredSectionId: state?.hoveredSectionId ?? null,
    };
  });
}

/**
 * Helper to poll for hover state changes.
 */
async function pollHoverState(
  page: Page,
  predicate: (state: Awaited<ReturnType<typeof getHoverState>>) => boolean,
  timeout = 5000
): Promise<Awaited<ReturnType<typeof getHoverState>>> {
  let result: Awaited<ReturnType<typeof getHoverState>> = {
    hoveredStation: null,
    hoveredShot: null,
    hoveredSectionId: null,
  };
  await expect.poll(
    async () => {
      const state = await getHoverState(page);
      if (predicate(state)) {
        result = state;
        return true;
      }
      return false;
    },
    { timeout }
  ).toBe(true);
  return result;
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
 * Helper to select a station via store.
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

  // Wait for selection to be set
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

  // Wait for selection to be set
  await pollSelectionState(
    page,
    (sel) => sel?.type === 'shot' && sel?.sectionId === sectionId && sel?.shotId === shotId
  );
}

/**
 * Helper to select a section by clicking its row.
 */
async function selectSectionById(page: Page, sectionId: number): Promise<void> {
  const sectionRow = page.locator(`[data-testid="section-row-${sectionId}"]`);
  await expect(sectionRow).toBeVisible();
  await sectionRow.click();

  // Wait for selection to be set
  await pollSelectionState(page, (sel) => sel?.type === 'section' && sel?.sectionId === sectionId);
}

test.describe('Detail Link Focus Highlighting', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test.describe('Station Link Focus', () => {
    test('focusing station link sets hoveredStation in uiStore', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select a shot to show its detail panel with station links
      await selectShot(page, mainSectionId, firstShotId);

      // Find the Start Station link (station index 0, position 1)
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await expect(startStationLink).toBeVisible();

      // Check initial hover state
      const initialHoverState = await getHoverState(page);
      expect(initialHoverState.hoveredStation).toBeNull();

      // Focus the station link (triggers onFocus which calls onHoverStart)
      await startStationLink.focus();

      // Verify link is focused
      await expect(startStationLink).toBeFocused();

      // Verify hoveredStation is set correctly
      const hoverState = await pollHoverState(
        page,
        (state) =>
          state.hoveredStation !== null &&
          state.hoveredStation.section_id === mainSectionId &&
          state.hoveredStation.station_index === 0
      );
      expect(hoverState.hoveredStation?.section_id).toBe(mainSectionId);
      expect(hoverState.hoveredStation?.station_index).toBe(0);
    });

    test('blur clears hoveredStation', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select a shot to show its detail panel
      await selectShot(page, mainSectionId, firstShotId);

      // Focus the Start Station link
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await startStationLink.focus();

      // Wait for hover state to be set
      await pollHoverState(page, (state) => state.hoveredStation !== null);

      // Blur by focusing a non-DetailLink element (the center button)
      const centerButton = page.getByTestId('center-shot-button');
      await centerButton.focus();

      // Verify the link is no longer focused
      await expect(startStationLink).not.toBeFocused();

      // Verify hoveredStation is cleared (center button doesn't trigger hover state)
      const clearedState = await pollHoverState(page, (state) => state.hoveredStation === null);
      expect(clearedState.hoveredStation).toBeNull();
    });

    test('focusing different station links updates hoveredStation', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select first shot to show detail panel
      await selectShot(page, mainSectionId, firstShotId);

      // Focus Start Station link (index 0)
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await startStationLink.focus();

      await pollHoverState(page, (state) => state.hoveredStation?.station_index === 0);

      // Now focus End Station link (index 1)
      const endStationLink = page.getByTestId(`station-${mainSectionId}-2-link`);
      await endStationLink.focus();

      // Verify hoveredStation updated to the new station
      const hoverState = await pollHoverState(
        page,
        (state) => state.hoveredStation?.station_index === 1
      );
      expect(hoverState.hoveredStation?.section_id).toBe(mainSectionId);
      expect(hoverState.hoveredStation?.station_index).toBe(1);
    });
  });

  test.describe('Shot Link Focus', () => {
    test('focusing shot link sets hoveredShot in uiStore', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);

      // Select station at index 1 (has both Previous and Next shots)
      await selectStation(page, mainSectionId, 1);

      // Find the Next Shot link (shot at index 1, position 2)
      const nextShotLink = page.getByTestId(`shot-${mainSectionId}-2-link`);
      await expect(nextShotLink).toBeVisible();

      // Focus the shot link
      await nextShotLink.focus();

      // Verify link is focused
      await expect(nextShotLink).toBeFocused();

      // Verify hoveredShot is set correctly
      const expectedShotId = shotIds[1]!;
      const hoverState = await pollHoverState(
        page,
        (state) =>
          state.hoveredShot !== null &&
          state.hoveredShot.sectionId === mainSectionId &&
          state.hoveredShot.shotId === expectedShotId
      );
      expect(hoverState.hoveredShot?.sectionId).toBe(mainSectionId);
      expect(hoverState.hoveredShot?.shotId).toBe(expectedShotId);
    });

    test('blur clears hoveredShot', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select station at index 1
      await selectStation(page, mainSectionId, 1);

      // Focus the shot link
      const shotLink = page.getByTestId(`shot-${mainSectionId}-2-link`);
      await shotLink.focus();

      // Wait for hover state to be set
      await pollHoverState(page, (state) => state.hoveredShot !== null);

      // Blur by focusing a non-DetailLink element (the center button)
      const centerButton = page.getByTestId('center-station-button');
      await centerButton.focus();

      // Verify hoveredShot is cleared
      const clearedState = await pollHoverState(page, (state) => state.hoveredShot === null);
      expect(clearedState.hoveredShot).toBeNull();
    });
  });

  test.describe('Section Link Focus', () => {
    test('focusing section link sets hoveredSectionId in uiStore', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select a shot to show its detail panel with section link
      await selectShot(page, mainSectionId, firstShotId);

      // Find the Section link
      const sectionLink = page.getByTestId(`section-${mainSectionId}-link`);
      await expect(sectionLink).toBeVisible();

      // Focus the section link
      await sectionLink.focus();

      // Verify link is focused
      await expect(sectionLink).toBeFocused();

      // Verify hoveredSectionId is set correctly
      const hoverState = await pollHoverState(
        page,
        (state) => state.hoveredSectionId === mainSectionId
      );
      expect(hoverState.hoveredSectionId).toBe(mainSectionId);
    });

    test('blur clears hoveredSectionId', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select a shot to show detail panel
      await selectShot(page, mainSectionId, firstShotId);

      // Focus the section link
      const sectionLink = page.getByTestId(`section-${mainSectionId}-link`);
      await sectionLink.focus();

      // Wait for hover state to be set
      await pollHoverState(page, (state) => state.hoveredSectionId !== null);

      // Blur by focusing a non-DetailLink element (the center button)
      const centerButton = page.getByTestId('center-shot-button');
      await centerButton.focus();

      // Verify hoveredSectionId is cleared
      const clearedState = await pollHoverState(page, (state) => state.hoveredSectionId === null);
      expect(clearedState.hoveredSectionId).toBeNull();
    });
  });

  test.describe('Focus Does Not Interfere with Selection', () => {
    test('focusing link does not change selection state', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select a shot
      await selectShot(page, mainSectionId, firstShotId);

      // Focus a station link
      const startStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await startStationLink.focus();

      // Verify hover state is set
      await pollHoverState(page, (state) => state.hoveredStation !== null);

      // Verify the shot is still selected (focus doesn't change selection)
      const selection = await getSelectionState(page);
      expect(selection).toEqual({
        type: 'shot',
        sectionId: mainSectionId,
        shotId: firstShotId,
      });
    });
  });

  test.describe('Section Detail Station Links', () => {
    test('focusing First Station link in section detail sets hover state', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select the section to show section detail
      await selectSectionById(page, mainSectionId);

      // Find the First Station link (station index 0, position 1)
      const firstStationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await expect(firstStationLink).toBeVisible();

      // Focus the link
      await firstStationLink.focus();

      // Verify link is focused
      await expect(firstStationLink).toBeFocused();

      // Verify hoveredStation is set
      const hoverState = await pollHoverState(page, (state) => state.hoveredStation !== null);
      expect(hoverState.hoveredStation?.section_id).toBe(mainSectionId);
      expect(hoverState.hoveredStation?.station_index).toBe(0);
    });

    test('focusing Last Station link in section detail sets hover state', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;

      // Select the section to show section detail
      await selectSectionById(page, mainSectionId);

      // Main section has 3 shots, so 4 stations (indices 0-3)
      // Last Station is at index 3, position 4
      const lastStationLink = page.getByTestId(`station-${mainSectionId}-4-link`);
      await expect(lastStationLink).toBeVisible();

      // Focus the link
      await lastStationLink.focus();

      // Verify link is focused
      await expect(lastStationLink).toBeFocused();

      // Verify hoveredStation is set to the last station
      const hoverState = await pollHoverState(page, (state) => state.hoveredStation !== null);
      expect(hoverState.hoveredStation?.section_id).toBe(mainSectionId);
      expect(hoverState.hoveredStation?.station_index).toBe(3);
    });
  });

  test.describe('Focus Transitions', () => {
    test('focusing from station to section link updates hover state correctly', async ({ page }) => {
      await createProjectWithSections(page);

      const sectionIds = await getSectionIds(page);
      const mainSectionId = sectionIds[0]!;
      const shotIds = await getShotIdsForSection(page, mainSectionId);
      const firstShotId = shotIds[0]!;

      // Select a shot to show detail panel with multiple links
      await selectShot(page, mainSectionId, firstShotId);

      // Focus station link first
      const stationLink = page.getByTestId(`station-${mainSectionId}-1-link`);
      await stationLink.focus();

      // Verify station hover state
      await pollHoverState(page, (state) => state.hoveredStation !== null);
      let hoverState = await getHoverState(page);
      expect(hoverState.hoveredStation).not.toBeNull();
      expect(hoverState.hoveredSectionId).toBeNull();

      // Now focus section link
      const sectionLink = page.getByTestId(`section-${mainSectionId}-link`);
      await sectionLink.focus();

      // Verify section hover state - station should clear, section should set
      await pollHoverState(page, (state) => state.hoveredSectionId !== null);
      hoverState = await getHoverState(page);
      expect(hoverState.hoveredStation).toBeNull();
      expect(hoverState.hoveredSectionId).toBe(mainSectionId);
    });
  });
});
