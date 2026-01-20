import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * E2E tests for hitbox detection functionality.
 *
 * These tests verify that stations and shots are detected at their configured
 * hitArea boundaries, using deterministic screen coordinates via map.project().
 */

/**
 * Helper to wait for the map to be fully loaded.
 */
async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __cavechef_map__?: { loaded: () => boolean } }).__cavechef_map__;
      return map && map.loaded();
    },
    { timeout: 10000 }
  );
}

/**
 * Helper to wait for the app to be ready (canvas visible and map loaded).
 */
async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 10000 });
  await waitForMapReady(page);
}

/**
 * Helper to create a new project with the given name.
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await waitForAppReady(page);
}

/**
 * Helper to get a station's screen position using map.queryRenderedFeatures + map.project().
 * This avoids re-implementing coordinate conversion logic and uses the actual rendered feature coords.
 */
async function getStationScreenPosition(
  page: Page,
  sectionId: number,
  stationIndex: number
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ sectionId, stationIndex }) => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          project: (coords: [number, number]) => { x: number; y: number };
          queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
            geometry: { type: string; coordinates: [number, number] };
            properties: { sectionId: number; stationIndex: number };
          }>;
        };
      }).__cavechef_map__;

      if (!map) throw new Error('Map not available');

      // Query actual rendered features to get their coordinates
      const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
      const feature = features.find(
        (f) =>
          f.properties.sectionId === sectionId &&
          f.properties.stationIndex === stationIndex
      );

      if (!feature) {
        throw new Error(`Station feature not found: ${sectionId}:${stationIndex}`);
      }

      // Project the actual feature coordinates to screen space
      const coords = feature.geometry.coordinates as [number, number];
      const screenPos = map.project(coords);
      return { x: screenPos.x, y: screenPos.y };
    },
    { sectionId, stationIndex }
  );
}

/**
 * Helper to get the current selection state using expect.poll for stability.
 */
async function getSelectionState(page: Page): Promise<{
  type: string;
  stationRef?: { section_id: number; station_index: number };
  sectionId?: number;
  shotId?: number;
} | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { selection: unknown } };
      };
    }).__E2E_TEST__;

    if (!stores) return null;
    return stores.uiStore.getState().selection as {
      type: string;
      stationRef?: { section_id: number; station_index: number };
      sectionId?: number;
      shotId?: number;
    } | null;
  });
}

/**
 * Helper to poll for selection state changes (more stable than waitForTimeout).
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
 * Helper to get the canvas bounding box for click coordinate calculation.
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

/**
 * Helper to get the hit_area value from config.
 */
async function getStationHitArea(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { config: { map: { station: { hit_area: number } } } | null } };
      };
    }).__E2E_TEST__;

    if (!stores) return 10; // Default fallback
    const config = stores.projectStore.getState().config;
    return config?.map?.station?.hit_area ?? 10;
  });
}

/**
 * Helper to check if debug.map.show_hitboxes changes layer opacity.
 */
async function getHitboxLayerOpacity(page: Page, layerId: string): Promise<number> {
  return page.evaluate(
    ({ layerId }) => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          getPaintProperty: (layer: string, prop: string) => number;
        };
      }).__cavechef_map__;

      if (!map) return 0;
      return map.getPaintProperty(layerId, layerId.includes('shots') ? 'line-opacity' : 'circle-opacity') ?? 0;
    },
    { layerId }
  );
}

/**
 * Helper to verify layer order in the map style.
 * Returns the index of each layer in the style's layers array.
 */
async function getLayerOrder(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __cavechef_map__?: {
        getStyle: () => { layers: Array<{ id: string }> };
      };
    }).__cavechef_map__;

    if (!map) return {};

    const layers = map.getStyle().layers;
    const order: Record<string, number> = {};

    layers.forEach((layer, index) => {
      order[layer.id] = index;
    });

    return order;
  });
}

test.describe('Hitbox Detection', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('station click at hitArea-1 hits, hitArea+1 misses with detail panel visible', async ({ page }) => {
    await createProject(page, 'Hitbox Test Project');

    // Mock data provides stations 50 units apart, so we have isolated stations for boundary testing
    // Get first station and verify hitArea boundaries
    const testData = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          project: (coords: [number, number]) => { x: number; y: number };
          queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
            geometry: { type: string; coordinates: [number, number] };
            properties: { sectionId: number; stationIndex: number };
          }>;
        };
      }).__cavechef_map__;

      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: { getState: () => { config: { map: { station: { hit_area: number } } } | null } };
        };
      }).__E2E_TEST__;

      if (!map || !stores) throw new Error('Map or stores not available');

      const hitArea = stores.projectStore.getState().config?.map?.station?.hit_area ?? 10;
      const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
      if (features.length === 0) throw new Error('No stations found');

      // Get first station from section 1 (isolated due to 50-unit spacing)
      const f = features.find(feat => feat.properties.sectionId === 1 && feat.properties.stationIndex === 0);
      if (!f) throw new Error('Station 1:0 not found');

      const screenPos = map.project(f.geometry.coordinates as [number, number]);

      return {
        sectionId: f.properties.sectionId,
        stationIndex: f.properties.stationIndex,
        screenPos,
        hitArea,
      };
    });

    const { sectionId, stationIndex, screenPos, hitArea } = testData;
    const canvasBox = await getCanvasBoundingBox(page);

    // Ensure select tool is active
    await page.keyboard.press('s');

    // Click at hitArea - 1 pixels from station center (should hit)
    // Use positive X direction (away from other stations in this section)
    const hitX = canvasBox.x + screenPos.x + (hitArea - 1);
    const hitY = canvasBox.y + screenPos.y;
    await page.mouse.click(hitX, hitY);

    // Poll for selection to appear
    const selectionAfterHit = await pollSelectionState(page, (sel) => sel !== null);
    expect(selectionAfterHit).not.toBeNull();
    expect(selectionAfterHit?.type).toBe('station');
    expect(selectionAfterHit?.stationRef?.section_id).toBe(sectionId);
    expect(selectionAfterHit?.stationRef?.station_index).toBe(stationIndex);

    // Verify the Detail Panel shows station details
    const detailPanel = page.locator('[data-testid="detail-panel"]');
    await expect(detailPanel).toBeVisible();

    // Verify station detail panel is shown
    const stationDetail = page.locator('[data-testid="station-detail"]');
    await expect(stationDetail).toBeVisible();

    // Clear selection with Escape
    await page.keyboard.press('Escape');
    await pollSelectionState(page, (sel) => sel === null);

    // Click at hitArea + 1 pixels from station center (should miss)
    // Use negative Y direction (perpendicular to section layout, guaranteed empty)
    const missX = canvasBox.x + screenPos.x;
    const missY = canvasBox.y + screenPos.y - (hitArea + 1);
    await page.mouse.click(missX, missY);

    // Wait briefly then verify miss
    await page.waitForTimeout(100);
    const selectionAfterMiss = await getSelectionState(page);
    expect(selectionAfterMiss).toBeNull();

    // Verify station detail is not visible (panel may stay visible but shows no selection)
    await expect(page.locator('[data-testid="station-detail"]')).not.toBeVisible();
  });

  test('overlapping hitboxes select nearest to click', async ({ page }) => {
    await createProject(page, 'Overlap Test Project');

    // Mock data provides section 999 with two overlapping stations (15 units apart, < 2*hitArea=20)
    const overlapData = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          project: (coords: [number, number]) => { x: number; y: number };
          queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
            geometry: { type: string; coordinates: [number, number] };
            properties: { sectionId: number; stationIndex: number };
          }>;
        };
      }).__cavechef_map__;

      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: { getState: () => { config: { map: { station: { hit_area: number } } } | null } };
        };
      }).__E2E_TEST__;

      if (!map || !stores) throw new Error('Map or stores not available');

      const hitArea = stores.projectStore.getState().config?.map?.station?.hit_area ?? 10;
      const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });

      // Find the overlapping test stations (section 999)
      const stationA = features.find(f => f.properties.sectionId === 999 && f.properties.stationIndex === 0);
      const stationB = features.find(f => f.properties.sectionId === 999 && f.properties.stationIndex === 1);

      if (!stationA || !stationB) {
        throw new Error('Overlapping test stations (section 999) not found');
      }

      const screenPosA = map.project(stationA.geometry.coordinates as [number, number]);
      const screenPosB = map.project(stationB.geometry.coordinates as [number, number]);

      const dx = screenPosB.x - screenPosA.x;
      const dy = screenPosB.y - screenPosA.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      return {
        stationA: { sectionId: 999, stationIndex: 0, screenPos: screenPosA },
        stationB: { sectionId: 999, stationIndex: 1, screenPos: screenPosB },
        distance,
        hitArea,
      };
    });

    const { stationA, stationB, distance, hitArea } = overlapData;
    const canvasBox = await getCanvasBoundingBox(page);

    // Verify overlap exists (distance < 2 * hitArea)
    expect(distance).toBeLessThan(2 * hitArea);
    expect(distance).toBeGreaterThan(0);

    // Ensure select tool is active
    await page.keyboard.press('s');

    // Click 2 pixels toward stationA from midpoint (guaranteed to be closer to A)
    const midX = (stationA.screenPos.x + stationB.screenPos.x) / 2;
    const midY = (stationA.screenPos.y + stationB.screenPos.y) / 2;
    const dx = stationA.screenPos.x - midX;
    const dy = stationA.screenPos.y - midY;
    const dirLen = Math.sqrt(dx * dx + dy * dy);
    const offsetX = dirLen > 0 ? (dx / dirLen) * 2 : 0;
    const offsetY = dirLen > 0 ? (dy / dirLen) * 2 : 0;
    const clickX = midX + offsetX;
    const clickY = midY + offsetY;

    await page.mouse.click(canvasBox.x + clickX, canvasBox.y + clickY);

    // Poll for selection - should select stationA (the nearer one)
    const selection = await pollSelectionState(page, (sel) => sel !== null);
    expect(selection).not.toBeNull();
    expect(selection?.type).toBe('station');
    expect(selection?.stationRef?.section_id).toBe(stationA.sectionId);
    expect(selection?.stationRef?.station_index).toBe(stationA.stationIndex);
  });

  test('layer order has station-hitbox above shot-hitbox', async ({ page }) => {
    await createProject(page, 'Layer Order Test');

    // Poll for layers to be ready
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-stations-hitbox'];
    }).toBeDefined();

    // Get layer order from the map style
    const layerOrder = await getLayerOrder(page);

    // Verify station hitbox layer exists
    expect(layerOrder['survey-stations-hitbox']).toBeDefined();

    // Verify shot hitbox layer exists
    expect(layerOrder['survey-shots-hitbox']).toBeDefined();

    // Station hitbox should be ABOVE shot hitbox (higher index = rendered later = on top)
    expect(layerOrder['survey-stations-hitbox']).toBeGreaterThan(layerOrder['survey-shots-hitbox']);
  });

  test('hitbox layers have correct opacity for click detection', async ({ page }) => {
    await createProject(page, 'Opacity Test');

    // Poll for layers to be ready
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-stations-hitbox'];
    }).toBeDefined();

    // Verify hitbox layers have tiny non-zero opacity (required for queryRenderedFeatures)
    const stationOpacity = await getHitboxLayerOpacity(page, 'survey-stations-hitbox');
    const shotOpacity = await getHitboxLayerOpacity(page, 'survey-shots-hitbox');

    // Should be very small but > 0 (0.001 per implementation)
    expect(stationOpacity).toBeGreaterThan(0);
    expect(stationOpacity).toBeLessThan(0.01);
    expect(shotOpacity).toBeGreaterThan(0);
    expect(shotOpacity).toBeLessThan(0.01);
  });

  test('shot click detection at hitArea boundaries', async ({ page }) => {
    await createProject(page, 'Shot Hitbox Test');

    // Mock data provides stations 50 units apart, so shot midpoints are 25 units from stations
    // This is far enough from station hitArea (10) for clean shot boundary testing
    const shotInfo = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          project: (coords: [number, number]) => { x: number; y: number };
          queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
            geometry: { type: string; coordinates: [number, number] | [number, number][] };
            properties: Record<string, unknown>;
          }>;
        };
      }).__cavechef_map__;

      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              config: { map: { shot: { hit_area: number } } } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!map || !stores) throw new Error('Map or stores not available');

      const shotHitArea = stores.projectStore.getState().config?.map?.shot?.hit_area ?? 8;
      const shots = map.queryRenderedFeatures({ layers: ['survey-shots'] });

      if (shots.length === 0) throw new Error('No shots found');

      // Use first shot from section 1 (guaranteed to exist)
      const shot = shots.find(s => s.properties.sectionId === 1 && s.properties.shotId === 1);
      if (!shot || shot.geometry.type !== 'LineString') throw new Error('Shot 1:1 not found');

      const coords = shot.geometry.coordinates as [number, number][];
      const start = map.project(coords[0]!);
      const end = map.project(coords[1]!);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.sqrt(dx * dx + dy * dy);

      // Use midpoint (25 units from each station endpoint with 50-unit spacing)
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;

      // Perpendicular vector (normalized)
      const perpX = len > 0 ? -dy / len : 0;
      const perpY = len > 0 ? dx / len : -1;

      return {
        sectionId: shot.properties.sectionId as number,
        shotId: shot.properties.shotId as number,
        clickPoint: { x: midX, y: midY },
        perpendicular: { x: perpX, y: perpY },
        shotHitArea,
      };
    });

    const { sectionId, shotId, clickPoint, perpendicular, shotHitArea } = shotInfo;
    const canvasBox = await getCanvasBoundingBox(page);

    // Ensure select tool is active
    await page.keyboard.press('s');

    // Click at shotHitArea/2 - 1 perpendicular from shot line (should hit)
    const hitOffset = shotHitArea / 2 - 1;
    const hitX = canvasBox.x + clickPoint.x + perpendicular.x * hitOffset;
    const hitY = canvasBox.y + clickPoint.y + perpendicular.y * hitOffset;

    await page.mouse.click(hitX, hitY);

    // Poll for selection - should select the shot
    const selectionAfterHit = await pollSelectionState(page, (sel) => sel !== null);
    expect(selectionAfterHit).not.toBeNull();
    expect(selectionAfterHit?.type).toBe('shot');
    expect(selectionAfterHit?.sectionId).toBe(sectionId);
    expect(selectionAfterHit?.shotId).toBe(shotId);

    // Clear selection
    await page.keyboard.press('Escape');
    await pollSelectionState(page, (sel) => sel === null);

    // Click at shotHitArea/2 + 1 perpendicular from shot line (should miss)
    const missOffset = shotHitArea / 2 + 1;
    const missX = canvasBox.x + clickPoint.x + perpendicular.x * missOffset;
    const missY = canvasBox.y + clickPoint.y + perpendicular.y * missOffset;

    await page.mouse.click(missX, missY);

    // Wait and verify miss - selection should be null
    await page.waitForTimeout(100);
    const selectionAfterMiss = await getSelectionState(page);
    expect(selectionAfterMiss).toBeNull();
  });
});

test.describe('Debug Hitbox Visualization', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('hitbox layers exist with correct initial opacity', async ({ page }) => {
    // This test verifies the initial state where hitboxes are nearly invisible
    await createProject(page, 'Debug Hitbox Test');

    // Poll for layers to be ready
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-stations-hitbox'];
    }).toBeDefined();

    // Verify initial state: hitbox layers have tiny opacity (not fully visible)
    const stationOpacity = await getHitboxLayerOpacity(page, 'survey-stations-hitbox');
    expect(stationOpacity).toBeGreaterThan(0);
    expect(stationOpacity).toBeLessThan(0.01);

    // Verify the layers exist and are queryable (essential for click detection)
    const layerOrder = await getLayerOrder(page);
    expect(layerOrder['survey-stations-hitbox']).toBeDefined();
    expect(layerOrder['survey-shots-hitbox']).toBeDefined();
  });

  test('hitbox opacity changes when debug.map.show_hitboxes config changes', async ({ page }) => {
    await createProject(page, 'Hitbox Visibility Toggle');

    // Poll for layers to be ready
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-stations-hitbox'];
    }).toBeDefined();

    // Verify initial opacity is near-invisible
    const initialOpacity = await getHitboxLayerOpacity(page, 'survey-stations-hitbox');
    expect(initialOpacity).toBeLessThan(0.01);

    // Simulate config reload with show_hitboxes: true via store update
    // This tests the SurveyLayer's response to config changes
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              config: { debug: { map: { show_hitboxes: boolean } } } | null;
            };
            setState: (update: Partial<{
              config: { debug: { map: { show_hitboxes: boolean } } } | null;
            }>) => void;
          };
        };
      }).__E2E_TEST__;

      if (stores) {
        const state = stores.projectStore.getState();
        if (state.config) {
          // Update config with show_hitboxes: true
          stores.projectStore.setState({
            config: {
              ...state.config,
              debug: {
                ...state.config.debug,
                map: {
                  ...state.config.debug.map,
                  show_hitboxes: true,
                },
              },
            } as typeof state.config,
          });
        }
      }
    });

    // Wait for layers to update (SurveyLayer watches config changes)
    await expect.poll(
      async () => getHitboxLayerOpacity(page, 'survey-stations-hitbox'),
      { timeout: 5000 }
    ).toBe(1);

    // Verify opacity is now 1 (fully visible)
    const enabledOpacity = await getHitboxLayerOpacity(page, 'survey-stations-hitbox');
    expect(enabledOpacity).toBe(1);

    // Reset config to show_hitboxes: false
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              config: { debug: { map: { show_hitboxes: boolean } } } | null;
            };
            setState: (update: Partial<{
              config: { debug: { map: { show_hitboxes: boolean } } } | null;
            }>) => void;
          };
        };
      }).__E2E_TEST__;

      if (stores) {
        const state = stores.projectStore.getState();
        if (state.config) {
          stores.projectStore.setState({
            config: {
              ...state.config,
              debug: {
                ...state.config.debug,
                map: {
                  ...state.config.debug.map,
                  show_hitboxes: false,
                },
              },
            } as typeof state.config,
          });
        }
      }
    });

    // Wait for opacity to return to near-invisible
    await expect.poll(
      async () => getHitboxLayerOpacity(page, 'survey-stations-hitbox'),
      { timeout: 5000 }
    ).toBeLessThan(0.01);
  });
});

test.describe('Config Reload Effects', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('hitbox layer radius reflects config hit_area value', async ({ page }) => {
    await createProject(page, 'Config Hitbox Test');

    // Poll for layers to be ready
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-stations-hitbox'];
    }).toBeDefined();

    // Get the current hitArea from config
    const hitArea = await getStationHitArea(page);
    expect(hitArea).toBe(10); // Mock config default

    // Verify the hitbox layer circle-radius matches the config
    const layerRadius = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          getPaintProperty: (layer: string, prop: string) => number;
        };
      }).__cavechef_map__;

      if (!map) return 0;
      return map.getPaintProperty('survey-stations-hitbox', 'circle-radius') ?? 0;
    });

    // The hitbox layer radius should equal the config hit_area
    expect(layerRadius).toBe(hitArea);
  });

  test('hitbox layer sizes update when config hit_area changes', async ({ page }) => {
    await createProject(page, 'Config Reload Hitbox Test');

    // Poll for layers to be ready
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-stations-hitbox'];
    }).toBeDefined();

    // Verify initial hitbox radius is 10 (default)
    const initialRadius = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          getPaintProperty: (layer: string, prop: string) => number;
        };
      }).__cavechef_map__;
      return map?.getPaintProperty('survey-stations-hitbox', 'circle-radius') ?? 0;
    });
    expect(initialRadius).toBe(10);

    // Update config via store to simulate config reload
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              config: { map: { station: { hit_area: number }; shot: { hit_area: number } } } | null;
            };
            setState: (update: Partial<{
              config: { map: { station: { hit_area: number }; shot: { hit_area: number } } } | null;
            }>) => void;
          };
        };
      }).__E2E_TEST__;

      if (stores) {
        const state = stores.projectStore.getState();
        if (state.config) {
          stores.projectStore.setState({
            config: {
              ...state.config,
              map: {
                ...state.config.map,
                station: {
                  ...state.config.map.station,
                  hit_area: 15,
                },
                shot: {
                  ...state.config.map.shot,
                  hit_area: 12,
                },
              },
            } as typeof state.config,
          });
        }
      }
    });

    // Wait for layers to update (SurveyLayer watches config changes)
    await expect.poll(
      async () => {
        return page.evaluate(() => {
          const map = (window as unknown as {
            __cavechef_map__?: {
              getPaintProperty: (layer: string, prop: string) => number;
            };
          }).__cavechef_map__;
          return map?.getPaintProperty('survey-stations-hitbox', 'circle-radius') ?? 0;
        });
      },
      { timeout: 5000 }
    ).toBe(15);

    // Verify station hitbox radius updated
    const updatedStationRadius = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          getPaintProperty: (layer: string, prop: string) => number;
        };
      }).__cavechef_map__;
      return map?.getPaintProperty('survey-stations-hitbox', 'circle-radius') ?? 0;
    });
    expect(updatedStationRadius).toBe(15);

    // Verify shot hitbox width updated
    const updatedShotWidth = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          getPaintProperty: (layer: string, prop: string) => number;
        };
      }).__cavechef_map__;
      return map?.getPaintProperty('survey-shots-hitbox', 'line-width') ?? 0;
    });
    expect(updatedShotWidth).toBe(12);
  });

  test('config hit_area change affects actual hit detection behavior', async ({ page }) => {
    await createProject(page, 'Config Hit Detection Behavior Test');

    // Test that increasing hit_area allows clicks that previously missed to hit.
    // Use an isolated station from section 1 (stations are 50 units apart)
    const testData = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          project: (coords: [number, number]) => { x: number; y: number };
          queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
            geometry: { type: string; coordinates: [number, number] };
            properties: { sectionId: number; stationIndex: number };
          }>;
        };
      }).__cavechef_map__;

      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: { getState: () => { config: { map: { station: { hit_area: number } } } | null } };
        };
      }).__E2E_TEST__;

      if (!map || !stores) throw new Error('Map or stores not available');

      const hitArea = stores.projectStore.getState().config?.map?.station?.hit_area ?? 10;
      const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
      if (features.length === 0) throw new Error('No stations found');

      // Find station 1:0 (isolated, 50 units from other stations in same section)
      const targetFeature = features.find(f =>
        f.properties.sectionId === 1 && f.properties.stationIndex === 0
      );
      if (!targetFeature) throw new Error('Station 1:0 not found');

      const target = {
        sectionId: targetFeature.properties.sectionId,
        stationIndex: targetFeature.properties.stationIndex,
        screenPos: map.project(targetFeature.geometry.coordinates as [number, number]),
      };

      // Use negative Y direction (guaranteed safe with 50-unit spacing)
      const safeDirection = { x: 0, y: -1 };

      return { target, hitArea, safeDirection };
    });

    const { target, hitArea, safeDirection } = testData;
    const canvasBox = await getCanvasBoundingBox(page);

    // Ensure select tool is active
    await page.keyboard.press('s');

    // Click at hitArea + 5 (should miss with default hitArea=10)
    const missOffset = hitArea + 5;
    await page.mouse.click(
      canvasBox.x + target.screenPos.x + safeDirection.x * missOffset,
      canvasBox.y + target.screenPos.y + safeDirection.y * missOffset
    );

    // Verify miss
    await page.waitForTimeout(100);
    const selectionAfterMiss = await getSelectionState(page);
    expect(selectionAfterMiss).toBeNull();

    // Now increase hit_area to 20 (so clicking at offset 15 should now hit)
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              config: { map: { station: { hit_area: number; radius: number } } } | null;
            };
            setState: (update: Partial<{
              config: { map: { station: { hit_area: number } } } | null;
            }>) => void;
          };
        };
      }).__E2E_TEST__;

      if (stores) {
        const state = stores.projectStore.getState();
        if (state.config) {
          stores.projectStore.setState({
            config: {
              ...state.config,
              map: {
                ...state.config.map,
                station: {
                  ...state.config.map.station,
                  hit_area: 20,
                },
              },
            } as typeof state.config,
          });
        }
      }
    });

    // Wait for hitbox layer to update
    await expect.poll(
      async () => {
        return page.evaluate(() => {
          const map = (window as unknown as {
            __cavechef_map__?: {
              getPaintProperty: (layer: string, prop: string) => number;
            };
          }).__cavechef_map__;
          return map?.getPaintProperty('survey-stations-hitbox', 'circle-radius') ?? 0;
        });
      },
      { timeout: 5000 }
    ).toBe(20);

    // Small wait for maplibre to fully process the layer update
    await page.waitForTimeout(200);

    // Debug: Check what features exist at the click point
    const debugInfo = await page.evaluate(
      ({ screenX, screenY }) => {
        const map = (window as unknown as {
          __cavechef_map__?: {
            queryRenderedFeatures: (
              point: { x: number; y: number },
              options?: { layers?: string[] }
            ) => Array<{ properties: Record<string, unknown> }>;
            getPaintProperty: (layer: string, prop: string) => number;
          };
        }).__cavechef_map__;

        if (!map) return { error: 'no map' };

        const currentRadius = map.getPaintProperty('survey-stations-hitbox', 'circle-radius');
        const features = map.queryRenderedFeatures(
          { x: screenX, y: screenY },
          { layers: ['survey-stations-hitbox'] }
        );

        return {
          currentRadius,
          featuresAtPoint: features.map((f) => f.properties),
          clickPoint: { x: screenX, y: screenY },
        };
      },
      {
        screenX: target.screenPos.x + safeDirection.x * missOffset,
        screenY: target.screenPos.y + safeDirection.y * missOffset,
      }
    );
    console.log('DEBUG: Features at click point after hitArea=20:', debugInfo);

    // Click at same offset (15) - should now HIT since hitArea is 20
    await page.mouse.click(
      canvasBox.x + target.screenPos.x + safeDirection.x * missOffset,
      canvasBox.y + target.screenPos.y + safeDirection.y * missOffset
    );

    // Verify hit - the click that missed before should now select our target station
    const selectionAfterHit = await pollSelectionState(page, (sel) => sel !== null);
    expect(selectionAfterHit).not.toBeNull();
    expect(selectionAfterHit?.type).toBe('station');
    expect(selectionAfterHit?.stationRef?.section_id).toBe(target.sectionId);
    expect(selectionAfterHit?.stationRef?.station_index).toBe(target.stationIndex);
  });
});

test.describe('E2E Test Infrastructure', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('__E2E_TEST__ stores are exposed in dev mode', async ({ page }) => {
    await createProject(page, 'E2E Test Infrastructure');

    // Verify __E2E_TEST__ is available with required stores
    const hasTestAPI = await page.evaluate(() => {
      const testAPI = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: unknown;
          projectStore: unknown;
        };
      }).__E2E_TEST__;

      return {
        hasAPI: !!testAPI,
        hasUIStore: !!testAPI?.uiStore,
        hasProjectStore: !!testAPI?.projectStore,
      };
    });

    expect(hasTestAPI.hasAPI).toBe(true);
    expect(hasTestAPI.hasUIStore).toBe(true);
    expect(hasTestAPI.hasProjectStore).toBe(true);
  });

  test('__cavechef_map__ is exposed after map loads', async ({ page }) => {
    await createProject(page, 'Map Exposure Test');

    // Verify __cavechef_map__ is available with required methods
    const hasMapAPI = await page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: {
          loaded: () => boolean;
          project: (coords: [number, number]) => { x: number; y: number };
          getStyle: () => { layers: unknown[] };
          getPaintProperty: (layer: string, prop: string) => unknown;
          queryRenderedFeatures: (options?: unknown) => unknown[];
        };
      }).__cavechef_map__;

      return {
        hasMap: !!map,
        isLoaded: map?.loaded?.() ?? false,
        hasProject: typeof map?.project === 'function',
        hasGetStyle: typeof map?.getStyle === 'function',
        hasGetPaintProperty: typeof map?.getPaintProperty === 'function',
        hasQueryRenderedFeatures: typeof map?.queryRenderedFeatures === 'function',
      };
    });

    expect(hasMapAPI.hasMap).toBe(true);
    expect(hasMapAPI.isLoaded).toBe(true);
    expect(hasMapAPI.hasProject).toBe(true);
    expect(hasMapAPI.hasGetStyle).toBe(true);
    expect(hasMapAPI.hasGetPaintProperty).toBe(true);
    expect(hasMapAPI.hasQueryRenderedFeatures).toBe(true);
  });
});
