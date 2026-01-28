/**
 * E2E tests for section zoom margin behavior.
 *
 * Verifies that zooming to a section leaves visible margin from viewport edges
 * and the zoom level stays within a reasonable range. Tests both the
 * double-click trigger (sections panel row) and the center button trigger
 * (detail panel header).
 *
 * Key pitfalls addressed:
 * - Pan map off-target before each zoom trigger to avoid false passes
 * - Wait for __cavechef_map__ after canvas appears
 * - Use map.project() for screen-space assertions
 * - Use expect.poll() for state change assertions (no waitForTimeout)
 */

import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapIdle,
  waitForNoDialogs,
  type SectionSeed,
} from './helpers/app';

/**
 * Multi-station section with distinct geometry to produce
 * a non-trivial bounding box on the map.
 */
const sectionSeeds: SectionSeed[] = [
  {
    name: 'Zoom Test Passage',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 15, depth_in: -1, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 270, length: 20, depth_in: -3, depth_out: -6 },
      { azimuth_in: 135, azimuth_out: 315, length: 12, depth_in: -6, depth_out: -8 },
    ],
  },
  {
    name: 'Side Gallery',
    direction: 'out',
    shots: [
      { azimuth_in: 270, azimuth_out: 90, length: 8, depth_in: -2, depth_out: -4 },
    ],
  },
];

/**
 * Margin check result from page.evaluate().
 */
interface MarginResult {
  points: Array<{ x: number; y: number }>;
  containerWidth: number;
  containerHeight: number;
  zoom: number;
  minMarginLeftPct: number;
  minMarginRightPct: number;
  minMarginTopPct: number;
  minMarginBottomPct: number;
}

/**
 * Setup: create project, seed sections, wait for map.
 */
async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Section Zoom Margin Test');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
}

/**
 * Get the ID of the first section by name from the project store.
 */
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

/**
 * Pan the map far off-target to avoid false passes from pre-centered state.
 * Memory pitfall: tests may pass falsely if map is already centered on the target section.
 */
async function panMapOffTarget(page: Page): Promise<void> {
  await page.evaluate(() => {
    const map = (window as unknown as {
      __cavechef_map__?: {
        jumpTo: (opts: { center: [number, number]; zoom: number }) => void;
        stop: () => void;
      };
    }).__cavechef_map__;
    if (map) {
      // Stop any running animation, then instantly jump to a far-away location
      map.stop();
      map.jumpTo({ center: [0, 0], zoom: 2 });
    }
  });
  // jumpTo is synchronous, but wait a tick for render
  await page.waitForTimeout(200);
}

/**
 * Project all station coordinates belonging to a section to screen pixels
 * using map.project(), and compute margin percentages from each viewport edge.
 * Returns null if data is not yet available or map is still moving (for use in polling).
 *
 * GPS origin comes from config.map.satellite_gps_origin in the project store.
 */
async function getStationScreenMargins(page: Page, sectionId: number): Promise<MarginResult | null> {
  return page.evaluate((secId) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            project: {
              sections: Array<{ id: number }>;
            } | null;
            stations: Array<{
              station_ref: { section_id: number };
              coordinates: { x: number; y: number };
            }>;
            config: {
              map: {
                satellite_gps_origin: { latitude: number; longitude: number };
              };
            } | null;
          };
        };
      };
    }).__E2E_TEST__;

    const map = (window as unknown as {
      __cavechef_map__?: {
        project: (lngLat: [number, number]) => { x: number; y: number };
        getContainer: () => HTMLElement;
        getZoom: () => number;
        isMoving: () => boolean;
      };
    }).__cavechef_map__;

    if (!stores || !map) return null;

    // Only measure when map is idle
    if (map.isMoving()) return null;

    const state = stores.projectStore.getState();
    const sectionStations = state.stations.filter(
      (s) => s.station_ref.section_id === secId,
    );

    if (sectionStations.length === 0) return null;

    // Get GPS origin from config (same source as MapCanvas.tsx line 74)
    const gpsOrigin = state.config?.map.satellite_gps_origin;
    if (!gpsOrigin) return null;

    // Replicate metersToMapCoords inline (same algorithm as utils/coordinates.ts)
    const METERS_PER_DEG_LAT = 111_320;
    function metersToMapCoords(
      east: number,
      north: number,
      originLat: number,
      originLng: number,
    ): [number, number] {
      const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
      const lng = originLng + east / metersPerDegLng;
      const lat = originLat + north / METERS_PER_DEG_LAT;
      return [lng, lat];
    }

    const container = map.getContainer();
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const zoom = map.getZoom();

    // Project all section stations to screen coordinates
    const points = sectionStations.map((station) => {
      const lngLat = metersToMapCoords(
        station.coordinates.x,
        station.coordinates.y,
        gpsOrigin.latitude,
        gpsOrigin.longitude,
      );
      return map.project(lngLat);
    });

    // Compute minimum margin from each edge as percentage
    let minLeft = Infinity;
    let minRight = Infinity;
    let minTop = Infinity;
    let minBottom = Infinity;

    for (const p of points) {
      minLeft = Math.min(minLeft, p.x);
      minRight = Math.min(minRight, containerWidth - p.x);
      minTop = Math.min(minTop, p.y);
      minBottom = Math.min(minBottom, containerHeight - p.y);
    }

    return {
      points: points.map((p) => ({ x: p.x, y: p.y })),
      containerWidth,
      containerHeight,
      zoom,
      minMarginLeftPct: (minLeft / containerWidth) * 100,
      minMarginRightPct: (minRight / containerWidth) * 100,
      minMarginTopPct: (minTop / containerHeight) * 100,
      minMarginBottomPct: (minBottom / containerHeight) * 100,
    };
  }, sectionId);
}

/**
 * Poll until map is idle and station screen positions satisfy margin requirements.
 * Combines idle wait + margin check in a single poll to avoid separate
 * waitForMapIdle that can hang if the map animation never fully settles.
 */
async function pollForMarginsSettled(
  page: Page,
  sectionId: number,
  minPct: number,
  maxZoom: number,
  timeout = 15000,
): Promise<MarginResult> {
  let lastResult: MarginResult | null = null;
  await expect.poll(
    async () => {
      const result = await getStationScreenMargins(page, sectionId);
      if (!result) return false;
      lastResult = result;
      return (
        result.minMarginLeftPct >= minPct &&
        result.minMarginRightPct >= minPct &&
        result.minMarginTopPct >= minPct &&
        result.minMarginBottomPct >= minPct &&
        result.zoom <= maxZoom
      );
    },
    {
      timeout,
      message: `Station screen positions did not settle with >= ${minPct}% margin and zoom <= ${maxZoom}`,
    },
  ).toBe(true);
  return lastResult!;
}

/**
 * Assert that all station screen positions have at least minPct% margin from
 * every viewport edge and zoom is within range.
 */
function assertMargins(result: MarginResult, minPct: number, maxZoom: number): void {
  expect(result.minMarginLeftPct).toBeGreaterThanOrEqual(minPct);
  expect(result.minMarginRightPct).toBeGreaterThanOrEqual(minPct);
  expect(result.minMarginTopPct).toBeGreaterThanOrEqual(minPct);
  expect(result.minMarginBottomPct).toBeGreaterThanOrEqual(minPct);
  expect(result.zoom).toBeLessThanOrEqual(maxZoom);
}

test.describe('Section zoom margin', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProjectWithSections(page);
  });

  test('double-click on section row zooms with margin from viewport edges', async ({ page }) => {
    const sectionId = await getSectionIdByName(page, 'Zoom Test Passage');

    // Pan off-target first (memory pitfall: avoid false passes from pre-centered state)
    await panMapOffTarget(page);

    // Find the section row and double-click it to trigger zoom-to-section
    const sectionRow = page.locator(`[data-testid="section-row-${sectionId}"]`);
    await expect(sectionRow).toBeVisible();
    await sectionRow.dblclick();

    // Poll until map is idle and margins are correct (combined to avoid hanging)
    const result = await pollForMarginsSettled(page, sectionId, 5, 22);
    assertMargins(result, 5, 22);
  });

  test('center button zooms with margin from viewport edges', async ({ page }) => {
    const sectionId = await getSectionIdByName(page, 'Zoom Test Passage');

    // First, select the section to open the detail panel
    const sectionRow = page.locator(`[data-testid="section-row-${sectionId}"]`);
    await expect(sectionRow).toBeVisible();
    await sectionRow.click();

    // Wait for section detail panel to appear
    const detailPanel = page.getByTestId('section-detail');
    await expect(detailPanel).toBeVisible({ timeout: 5000 });

    // Wait for center button to be visible
    const centerButton = page.getByTestId('center-section-button');
    await expect(centerButton).toBeVisible();

    // Pan off-target first (memory pitfall: avoid false passes from pre-centered state)
    await panMapOffTarget(page);

    // Click the center button to trigger zoom-to-section
    await centerButton.click();

    // Poll until map is idle and margins are correct
    const result = await pollForMarginsSettled(page, sectionId, 5, 22);
    assertMargins(result, 5, 22);
  });

  test('skip zoom-in when section already visible keeps section in viewport with margin', async ({ page }) => {
    const sectionId = await getSectionIdByName(page, 'Zoom Test Passage');

    // First, zoom to the section to get it visible and properly positioned
    const sectionRow = page.locator(`[data-testid="section-row-${sectionId}"]`);
    await expect(sectionRow).toBeVisible();
    await sectionRow.dblclick();

    // Wait for initial zoom to settle with margins
    await pollForMarginsSettled(page, sectionId, 5, 22);

    // Get the zoom level after first zoom
    const zoomBefore = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: { getZoom: () => number };
      }).__cavechef_map__;
      return map?.getZoom() ?? 0;
    });

    // Trigger zoom-to-section again (should skip zoom-in, only center)
    await sectionRow.dblclick();

    // Wait for second animation to complete
    await expect.poll(
      async () => {
        return page.evaluate(() => {
          const m = (window as unknown as {
            __cavechef_map__?: { isMoving: () => boolean };
          }).__cavechef_map__;
          return m ? !m.isMoving() : false;
        });
      },
      { timeout: 10000 },
    ).toBe(true);

    // Zoom level should not have changed significantly (only centering occurred)
    const zoomAfter = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: { getZoom: () => number };
      }).__cavechef_map__;
      return map?.getZoom() ?? 0;
    });
    expect(Math.abs(zoomAfter - zoomBefore)).toBeLessThan(0.5);

    // Section should still be within viewport with margin
    const finalResult = await getStationScreenMargins(page, sectionId);
    expect(finalResult).not.toBeNull();
    assertMargins(finalResult!, 5, 22);
  });
});
