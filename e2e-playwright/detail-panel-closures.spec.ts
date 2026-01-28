/**
 * E2E tests for Loop Closures section in the Detail Panel.
 *
 * Tests verify:
 * - Closure section appears in station details when closures_with is populated
 * - Closure section is hidden when station has no closures
 * - Direct and transitive closures displayed with correct formatting
 * - Metrics displayed for each closure group
 * - Navigation via closure station links works
 * - Collapsible toggle works
 */

import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapIdle,
  type SectionSeed,
} from './helpers/app';

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Main Tunnel',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 270, length: 12, depth_in: -3, depth_out: -6 },
    ],
  },
  {
    name: 'Side Passage',
    direction: 'out',
    shots: [
      { azimuth_in: 180, azimuth_out: 0, length: 7, depth_in: -2, depth_out: -4 },
    ],
  },
];

async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Closure Detail Test');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapIdle(page);
}

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

  await expect.poll(
    async () => {
      const sel = await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { selection: unknown } };
          };
        }).__E2E_TEST__;
        return stores?.uiStore.getState().selection as {
          type: string;
          stationRef?: { section_id: number; station_index: number };
        } | null;
      });
      return sel?.type === 'station' &&
        sel?.stationRef?.section_id === sectionId &&
        sel?.stationRef?.station_index === stationIndex;
    },
    { timeout: 5000 }
  ).toBe(true);
}

/**
 * Set up closures_with on a station and loop_closures on the project.
 */
async function setupClosures(
  page: Page,
  sectionId: number,
  stationIndex: number,
  targetSectionId: number,
  targetStationIndex: number,
): Promise<void> {
  await page.evaluate(
    ({ secId, stIdx, targetSecId, targetStIdx }) => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: {
                loop_closures: Array<unknown>;
              } | null;
              stations: Array<{
                station_ref: { section_id: number; station_index: number };
                closures_with?: Array<unknown>;
              }>;
            };
            setState: (state: unknown) => void;
          };
        };
      }).__E2E_TEST__;

      if (!stores) return;

      const state = stores.projectStore.getState();
      if (!state.project) return;

      // Add a loop closure to the project
      const closureId = 1;
      const updatedProject = {
        ...state.project,
        loop_closures: [
          ...state.project.loop_closures,
          {
            id: closureId,
            station_a: { section_id: secId, station_index: stIdx },
            station_b: { section_id: targetSecId, station_index: targetStIdx },
            path_length: 15.2,
            misclosure_distance: 0.3,
            error_percentage: 1.97,
            horizontal_misclosure: 0.25,
            vertical_misclosure: 0.15,
          },
        ],
      };

      // Add closures_with to the station
      const updatedStations = state.stations.map((station) => {
        if (
          station.station_ref.section_id === secId &&
          station.station_ref.station_index === stIdx
        ) {
          return {
            ...station,
            closures_with: [
              {
                closure_id: closureId,
                station_ref: { section_id: targetSecId, station_index: targetStIdx },
                via_station: null,
                is_transitive: false,
              },
            ],
          };
        }
        return station;
      });

      stores.projectStore.setState({
        project: updatedProject,
        stations: updatedStations,
      });
    },
    { secId: sectionId, stIdx: stationIndex, targetSecId: targetSectionId, targetStIdx: targetStationIndex }
  );
}

/**
 * Set up closures_with including transitive closures.
 */
async function setupClosuresWithTransitive(
  page: Page,
  sectionId: number,
  stationIndex: number,
  directTargetSecId: number,
  directTargetStIdx: number,
  transitiveTargetSecId: number,
  transitiveTargetStIdx: number,
  viaSecId: number,
  viaStIdx: number,
): Promise<void> {
  await page.evaluate(
    ({ secId, stIdx, dTargetSecId, dTargetStIdx, tTargetSecId, tTargetStIdx, vSecId, vStIdx }) => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: {
                loop_closures: Array<unknown>;
              } | null;
              stations: Array<{
                station_ref: { section_id: number; station_index: number };
                closures_with?: Array<unknown>;
              }>;
            };
            setState: (state: unknown) => void;
          };
        };
      }).__E2E_TEST__;

      if (!stores) return;

      const state = stores.projectStore.getState();
      if (!state.project) return;

      const closureId1 = 10;
      const closureId2 = 20;

      const updatedProject = {
        ...state.project,
        loop_closures: [
          ...state.project.loop_closures,
          {
            id: closureId1,
            station_a: { section_id: secId, station_index: stIdx },
            station_b: { section_id: dTargetSecId, station_index: dTargetStIdx },
            path_length: 15.2,
            misclosure_distance: 0.3,
            error_percentage: 1.97,
            horizontal_misclosure: 0.25,
            vertical_misclosure: 0.15,
          },
          {
            id: closureId2,
            station_a: { section_id: secId, station_index: stIdx },
            station_b: { section_id: tTargetSecId, station_index: tTargetStIdx },
            path_length: 42.1,
            misclosure_distance: 0.85,
            error_percentage: 2.02,
            horizontal_misclosure: 0.6,
            vertical_misclosure: 0.55,
          },
        ],
      };

      const updatedStations = state.stations.map((station) => {
        if (
          station.station_ref.section_id === secId &&
          station.station_ref.station_index === stIdx
        ) {
          return {
            ...station,
            closures_with: [
              {
                closure_id: closureId1,
                station_ref: { section_id: dTargetSecId, station_index: dTargetStIdx },
                via_station: null,
                is_transitive: false,
              },
              {
                closure_id: closureId2,
                station_ref: { section_id: tTargetSecId, station_index: tTargetStIdx },
                via_station: { section_id: vSecId, station_index: vStIdx },
                is_transitive: true,
              },
            ],
          };
        }
        return station;
      });

      stores.projectStore.setState({
        project: updatedProject,
        stations: updatedStations,
      });
    },
    {
      secId: sectionId, stIdx: stationIndex,
      dTargetSecId: directTargetSecId, dTargetStIdx: directTargetStIdx,
      tTargetSecId: transitiveTargetSecId, tTargetStIdx: transitiveTargetStIdx,
      vSecId: viaSecId, vStIdx: viaStIdx,
    }
  );
}

test.describe('Detail Panel - Loop Closures', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('closure section appears when station has closures_with', async ({ page }) => {
    await createProjectWithSections(page);

    const sectionIds = await getSectionIds(page);
    const mainSectionId = sectionIds[0]!;
    const sideSectionId = sectionIds[1]!;

    // Set up closure data
    await setupClosures(page, mainSectionId, 1, sideSectionId, 0);

    // Select the station that has closures
    await selectStation(page, mainSectionId, 1);

    // Verify closures section is visible
    const closuresSection = page.getByTestId('closures-section');
    await expect(closuresSection).toBeVisible();

    // Should show "Loop Closures" label
    await expect(closuresSection.getByText('Loop Closures')).toBeVisible();
  });

  test('closure section hidden when station has no closures', async ({ page }) => {
    await createProjectWithSections(page);

    const sectionIds = await getSectionIds(page);
    const mainSectionId = sectionIds[0]!;

    // Select a station without closures
    await selectStation(page, mainSectionId, 0);

    // Verify closures section is not present
    const closuresSection = page.getByTestId('closures-section');
    await expect(closuresSection).toBeHidden();
  });

  test('closure displays metrics: path length, error distance, error percentage', async ({ page }) => {
    await createProjectWithSections(page);

    const sectionIds = await getSectionIds(page);
    const mainSectionId = sectionIds[0]!;
    const sideSectionId = sectionIds[1]!;

    await setupClosures(page, mainSectionId, 1, sideSectionId, 0);
    await selectStation(page, mainSectionId, 1);

    // Verify metrics are displayed
    const metricsEl = page.getByTestId('closure-metrics-1');
    await expect(metricsEl).toBeVisible();
    await expect(metricsEl).toContainText('Path: 15.2m');
    await expect(metricsEl).toContainText('Error: 0.30m');
    await expect(metricsEl).toContainText('1.97%');
  });

  test('closure navigation works - clicking station link changes selection', async ({ page }) => {
    await createProjectWithSections(page);

    const sectionIds = await getSectionIds(page);
    const mainSectionId = sectionIds[0]!;
    const sideSectionId = sectionIds[1]!;

    await setupClosures(page, mainSectionId, 1, sideSectionId, 0);
    await selectStation(page, mainSectionId, 1);

    // Click the closure station link
    const closureLink = page.getByTestId(`station-${sideSectionId}-0-link`);
    await expect(closureLink).toBeVisible();
    await closureLink.click();

    // Selection should change to the target station
    await expect.poll(
      async () => {
        const sel = await page.evaluate(() => {
          const stores = (window as unknown as {
            __E2E_TEST__?: {
              uiStore: { getState: () => { selection: unknown } };
            };
          }).__E2E_TEST__;
          return stores?.uiStore.getState().selection as {
            type: string;
            stationRef?: { section_id: number; station_index: number };
          } | null;
        });
        return sel?.type === 'station' &&
          sel?.stationRef?.section_id === sideSectionId &&
          sel?.stationRef?.station_index === 0;
      },
      { timeout: 5000 }
    ).toBe(true);
  });

  test('transitive closures shown with via station and muted text', async ({ page }) => {
    await createProjectWithSections(page);

    const sectionIds = await getSectionIds(page);
    const mainSectionId = sectionIds[0]!;
    const sideSectionId = sectionIds[1]!;

    await setupClosuresWithTransitive(
      page,
      mainSectionId, 1,           // source station
      sideSectionId, 0,            // direct target
      sideSectionId, 1,            // transitive target
      sideSectionId, 0,            // via station
    );
    await selectStation(page, mainSectionId, 1);

    // Verify direct closure is shown
    const directEl = page.getByTestId('closure-direct-10');
    await expect(directEl).toBeVisible();
    await expect(directEl).toContainText('Closure to');

    // Verify transitive closure is shown
    const transitiveEl = page.getByTestId('closure-transitive-20');
    await expect(transitiveEl).toBeVisible();
    await expect(transitiveEl).toContainText('Transitive closure to');
    await expect(transitiveEl).toContainText('via');
  });

  test('collapsible toggle hides and shows closure content', async ({ page }) => {
    await createProjectWithSections(page);

    const sectionIds = await getSectionIds(page);
    const mainSectionId = sectionIds[0]!;
    const sideSectionId = sectionIds[1]!;

    await setupClosures(page, mainSectionId, 1, sideSectionId, 0);
    await selectStation(page, mainSectionId, 1);

    // Content should be visible by default (expanded)
    const content = page.getByTestId('closures-section-content');
    await expect(content).toBeVisible();

    // Click toggle to collapse
    const toggle = page.getByTestId('closures-section-toggle');
    await toggle.click();

    // Content should be hidden
    await expect(content).toBeHidden();

    // Click again to expand
    await toggle.click();
    await expect(content).toBeVisible();
  });
});
