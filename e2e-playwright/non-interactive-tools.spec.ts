import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  type SectionSeed,
} from './helpers/app';

/**
 * E2E tests for non-interactive tool behavior (pan, zoom).
 *
 * When pan or zoom tools are active, feature interactions should be disabled:
 * - No station/shot selection on click
 * - No hover effects
 * - No context menu on right-click (for pan)
 * - Ctrl+A does nothing
 */

/**
 * Helper to create a project with imported sections so stations/shots are visible.
 */
async function createProjectWithStations(page: Page): Promise<void> {
  await createProject(page, 'Non-Interactive Tool Test');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapReady(page);
  await expect.poll(
    async () => {
      return page.evaluate(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: {
            queryRenderedFeatures: (options?: { layers?: string[] }) => unknown[];
          };
        }).__stalagmight_map__;
        return map?.queryRenderedFeatures({ layers: ['survey-stations'] })?.length ?? 0;
      });
    },
    { timeout: 10000 }
  ).toBeGreaterThan(0);
}

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Non-Interactive Main',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10.5, depth_in: -2, depth_out: -2.5 },
      { azimuth_in: 90, azimuth_out: 270, length: 15.2, depth_in: -2.5, depth_out: -5.0 },
    ],
  },
  {
    name: 'Non-Interactive Side',
    direction: 'out',
    shots: [
      { azimuth_in: 270, azimuth_out: 90, length: 5.0, depth_in: -3.0, depth_out: -4.0 },
    ],
  },
];

/**
 * Helper to find station screen coordinates via queryRenderedFeatures.
 */
async function getStationPosition(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        project: (coords: [number, number]) => { x: number; y: number };
        queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
          geometry: { type: string; coordinates: [number, number] };
        }>;
      };
    }).__stalagmight_map__;

    if (!map) return null;
    const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
    if (features.length === 0) return null;
    const coords = features[0]!.geometry.coordinates as [number, number];
    return map.project(coords);
  });
}

/**
 * Helper to get canvas bounding box for calculating click coordinates.
 */
async function getCanvasBoundingBox(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const canvas = page.locator('canvas.maplibregl-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not found');
  return box;
}

test.describe('Non-interactive tools', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProjectWithStations(page);
  });

  test('Pan tool prevents station selection', async ({ page }) => {
    // Switch to pan tool
    await page.keyboard.press('p');
    await page.waitForTimeout(100);

    // Get station position
    const stationPos = await getStationPosition(page);
    expect(stationPos).not.toBeNull();

    const canvasBox = await getCanvasBoundingBox(page);

    // Click on station position
    await page.mouse.click(canvasBox.x + stationPos!.x, canvasBox.y + stationPos!.y);

    // Verify selection is empty
    const selection = await page.evaluate(() => {
      return (window as unknown as {
        __E2E_TEST__?: {
          uiStore: { getState: () => { selection: unknown } };
        };
      }).__E2E_TEST__?.uiStore?.getState()?.selection ?? null;
    });
    expect(selection).toBeNull();
  });

  test('Pan tool prevents context menu', async ({ page }) => {
    // NOTE: Use pan, not zoom (zoom right-click does zoom-out)
    await page.keyboard.press('p');
    await page.waitForTimeout(100);

    const canvasBox = await getCanvasBoundingBox(page);

    // Right-click on canvas
    await page.mouse.click(canvasBox.x + 200, canvasBox.y + 200, { button: 'right' });

    // Verify context menu dialog is NOT open (poll for a short window to catch async updates)
    // We check multiple times to ensure it never becomes 'context-menu'
    let sawContextMenu = false;
    for (let i = 0; i < 5; i++) {
      const activeDialog = await page.evaluate(() => {
        return (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { activeDialog: string | null } };
          };
        }).__E2E_TEST__?.uiStore?.getState()?.activeDialog;
      });
      if (activeDialog === 'context-menu') {
        sawContextMenu = true;
        break;
      }
      await page.waitForTimeout(50);
    }
    expect(sawContextMenu).toBe(false);
  });

  test('Switching to pan clears existing hover', async ({ page }) => {
    // This test verifies that switching to pan tool clears hoveredStation state.
    // The clearing is done by uiStore.setActiveTool when switching to a non-interactive tool.

    // Ensure select tool is active first
    await page.keyboard.press('s');
    await page.waitForTimeout(100);

    // Set hover state directly via uiStore (simulating what the SurveyLayer callback would do).
    // The MapCanvas useEffect syncs this to SurveyLayer.setHoveredStation automatically.
    const hoverSetup = await page.evaluate(() => {
      const map = (window as unknown as {
        __stalagmight_map__?: {
          queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
            properties: { sectionId: number; stationIndex: number };
          }>;
        };
      }).__stalagmight_map__;

      if (!map) return { success: false, error: 'No map' };

      // Get first station feature from hitbox layer to get a valid station ref
      const features = map.queryRenderedFeatures({ layers: ['survey-stations-hitbox'] });
      if (features.length === 0) {
        return { success: false, error: 'No station features in hitbox layer' };
      }

      const feature = features[0];
      const sectionId = feature?.properties?.sectionId;
      const stationIndex = feature?.properties?.stationIndex;

      if (sectionId === undefined || stationIndex === undefined) {
        return { success: false, error: 'Feature missing properties' };
      }

      const stores = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => { setHoveredStation: (ref: { section_id: number; station_index: number } | null) => void };
          };
        };
      }).__E2E_TEST__;

      if (!stores) return { success: false, error: 'No __E2E_TEST__' };

      // Set hovered station in uiStore
      stores.uiStore.getState().setHoveredStation({ section_id: sectionId, station_index: stationIndex });

      return { success: true, sectionId, stationIndex };
    });

    expect(hoverSetup.success).toBe(true);

    // Verify hover is set
    await expect.poll(
      async () => {
        return page.evaluate(() => {
          return (window as unknown as {
            __E2E_TEST__?: {
              uiStore: { getState: () => { hoveredStation: unknown } };
            };
          }).__E2E_TEST__?.uiStore?.getState()?.hoveredStation ?? null;
        });
      },
      { timeout: 2000, message: 'Hover state should be set' }
    ).not.toBeNull();

    // Switch to pan - this triggers setActiveTool
    // The setActiveTool function should clear hoveredStation via the callback chain
    await page.keyboard.press('p');

    // Poll until hover state is cleared
    await expect.poll(
      async () => {
        return page.evaluate(() => {
          return (window as unknown as {
            __E2E_TEST__?: {
              uiStore: { getState: () => { hoveredStation: unknown } };
            };
          }).__E2E_TEST__?.uiStore?.getState()?.hoveredStation ?? null;
        });
      },
      { timeout: 2000, message: 'Hover state should be cleared after switching to pan' }
    ).toBeNull();
  });

  test('Ctrl+A does nothing when pan active', async ({ page }) => {
    // Switch to pan tool
    await page.keyboard.press('p');
    await page.waitForTimeout(100);

    // Press Ctrl+A
    await page.keyboard.press('Control+a');

    // Verify selection is still empty
    const selection = await page.evaluate(() => {
      return (window as unknown as {
        __E2E_TEST__?: {
          uiStore: { getState: () => { selection: unknown } };
        };
      }).__E2E_TEST__?.uiStore?.getState()?.selection ?? null;
    });
    expect(selection).toBeNull();
  });

  test('Selection still works after switching back to select tool', async ({ page }) => {
    // Switch to pan tool, then back to select
    await page.keyboard.press('p');
    await page.keyboard.press('s');

    const pos = await getStationPosition(page);
    expect(pos).not.toBeNull();

    const canvasBox = await getCanvasBoundingBox(page);
    await page.mouse.click(canvasBox.x + pos!.x, canvasBox.y + pos!.y);

    await expect.poll(async () => {
      return page.evaluate(() => {
        return (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { selection: { type: string } | null } };
          };
        }).__E2E_TEST__?.uiStore?.getState()?.selection?.type ?? null;
      });
    }, { timeout: 2000 }).toBe('station');
  });
});
