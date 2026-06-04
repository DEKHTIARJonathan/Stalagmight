import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, waitForMapReady, type SectionSeed } from './helpers/app';

/**
 * E2E tests for visibility toggle behavior in the Display menu.
 * Tests visibility toggling, selection blocking, selection clearing,
 * toast notifications, toggle relationships, and tool operation interactions.
 */

interface StationPosition {
  x: number;
  y: number;
  sectionId: number;
  stationIndex: number;
}

/**
 * Helper to create a new project with mock sections/stations
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Visibility Main',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10.5, depth_in: -2, depth_out: -2.5, left: 1.5, right: 2.3, up: 3.0, down: 0.8 },
      { azimuth_in: 90, azimuth_out: 270, length: 15.2, depth_in: -2.5, depth_out: -5.0, left: 0.5, right: 0.7, up: 1.2, down: 1.5 },
    ],
  },
  {
    name: 'Visibility Side',
    direction: 'out',
    shots: [
      { azimuth_in: 270, azimuth_out: 90, length: 5.0, depth_in: -3.0, depth_out: -4.0, left: 0, right: 0, up: 0, down: 0 },
    ],
  },
];

/**
 * Helper to open the Display menu
 */
async function openDisplayMenu(page: Page): Promise<void> {
  const displayButton = page.locator('button:has-text("Display")');
  await displayButton.click();
  await expect(page.locator('[data-testid="display-toggle-showStations"]')).toBeVisible({ timeout: 2000 });
}

/**
 * Helper to get the toggle checkbox state
 */
async function isToggleOn(page: Page, toggleKey: string): Promise<boolean> {
  const toggle = page.locator(`[data-testid="display-toggle-${toggleKey}"]`);
  const checkbox = toggle.locator('div.rounded').last();
  const classes = await checkbox.getAttribute('class');
  return classes?.includes('bg-accent') ?? false;
}

/**
 * Helper to toggle a display option and wait for state change
 */
async function toggleDisplayOption(page: Page, toggleKey: string): Promise<void> {
  const toggle = page.locator(`[data-testid="display-toggle-${toggleKey}"]`);
  const currentState = await isToggleOn(page, toggleKey);
  await toggle.click();
  await expect.poll(async () => isToggleOn(page, toggleKey), { timeout: 2000 }).not.toBe(currentState);
}

/**
 * Helper to get map layer visibility via MapLibre API
 */
async function getLayerVisibility(page: Page, layerId: string): Promise<string | undefined> {
  return page.evaluate((id) => {
    const map = (window as unknown as { __stalagmight_map__?: { getLayoutProperty: (l: string, p: string) => string } }).__stalagmight_map__;
    if (!map) return undefined;
    try {
      return map.getLayoutProperty(id, 'visibility');
    } catch {
      return undefined;
    }
  }, layerId);
}

/**
 * Helper to wait for map layer to exist and be visible
 */
async function waitForLayerVisible(page: Page, layerId: string): Promise<void> {
  await expect.poll(async () => getLayerVisibility(page, layerId), { timeout: 5000 }).toBe('visible');
}

/**
 * Helper to get station screen positions via queryRenderedFeatures
 */
async function getStationScreenPositions(page: Page): Promise<StationPosition[]> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        queryRenderedFeatures: (opts: { layers: string[] }) => Array<{
          geometry: { coordinates: [number, number] };
          properties: { sectionId: number; stationIndex: number };
        }>;
        project: (coords: [number, number]) => { x: number; y: number };
      };
    }).__stalagmight_map__;
    if (!map) return [];

    try {
      const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
      return features.map((f) => {
        const coords = f.geometry.coordinates;
        const screenPos = map.project(coords);
        return {
          x: screenPos.x,
          y: screenPos.y,
          sectionId: f.properties.sectionId,
          stationIndex: f.properties.stationIndex,
        };
      });
    } catch {
      return [];
    }
  });
}

test.describe('Display Toggle Visibility', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Display Toggle Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await expect.poll(async () => (await getStationScreenPositions(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('geometry mode control renders; closure-adjusted disabled without closures', async ({ page }) => {
    await openDisplayMenu(page);

    // Both segmented-control buttons render.
    await expect(page.locator('[data-testid="geometry-mode-measured"]')).toBeVisible();
    const adjusted = page.locator('[data-testid="geometry-mode-closureAdjusted"]');
    await expect(adjusted).toBeVisible();

    // Measured is the default selected mode...
    await expect(page.locator('[data-testid="geometry-mode-measured"]')).toHaveAttribute('aria-pressed', 'true');
    // ...and the adjusted option is disabled while the project has no loop closures.
    await expect(adjusted).toBeDisabled();
  });

  test('toggle stations hides and shows station markers on canvas @smoke', async ({ page }) => {
    // Wait for station layer to be visible before testing
    await waitForLayerVisible(page, 'survey-stations');

    // Open Display menu
    await openDisplayMenu(page);

    // Verify stations are visible by default
    expect(await isToggleOn(page, 'showStations')).toBe(true);

    // Verify store state matches
    const stationsVisibleBefore = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showStations: boolean } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.showStations ?? true;
    });
    expect(stationsVisibleBefore).toBe(true);

    // Verify actual map layer is visible
    expect(await getLayerVisibility(page, 'survey-stations')).toBe('visible');

    // Toggle stations off
    await toggleDisplayOption(page, 'showStations');

    // Verify toggle state changed
    expect(await isToggleOn(page, 'showStations')).toBe(false);

    // Verify store state changed
    const stationsVisibleAfter = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showStations: boolean } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.showStations ?? true;
    });
    expect(stationsVisibleAfter).toBe(false);

    // Verify actual map layer is now hidden
    await expect.poll(async () => getLayerVisibility(page, 'survey-stations'), { timeout: 2000 }).toBe('none');

    // Toggle stations back on
    await toggleDisplayOption(page, 'showStations');
    expect(await isToggleOn(page, 'showStations')).toBe(true);

    // Verify layer is visible again
    await expect.poll(async () => getLayerVisibility(page, 'survey-stations'), { timeout: 2000 }).toBe('visible');
  });

  test('toggle shots hides and shows shot lines on canvas @smoke', async ({ page }) => {
    // Wait for shot layer to be visible
    await waitForLayerVisible(page, 'survey-shots');

    await openDisplayMenu(page);

    // Verify shots are visible by default
    expect(await isToggleOn(page, 'showShots')).toBe(true);

    // Verify actual map layer visibility
    expect(await getLayerVisibility(page, 'survey-shots')).toBe('visible');

    // Toggle shots off
    await toggleDisplayOption(page, 'showShots');
    expect(await isToggleOn(page, 'showShots')).toBe(false);

    // Verify store state
    const shotsVisible = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showShots: boolean } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.showShots ?? true;
    });
    expect(shotsVisible).toBe(false);

    // Verify actual map layer is hidden
    await expect.poll(async () => getLayerVisibility(page, 'survey-shots'), { timeout: 2000 }).toBe('none');

    // Toggle shots back on
    await toggleDisplayOption(page, 'showShots');
    expect(await isToggleOn(page, 'showShots')).toBe(true);

    // Verify layer is visible again
    await expect.poll(async () => getLayerVisibility(page, 'survey-shots'), { timeout: 2000 }).toBe('visible');
  });
});

test.describe('Selection Blocking When Hidden', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Selection Blocking Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await expect.poll(async () => (await getStationScreenPositions(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('cannot select hidden stations - selection blocked', async ({ page }) => {
    // Wait for stations to be visible and get their positions
    await waitForLayerVisible(page, 'survey-stations');
    const stations = await getStationScreenPositions(page);

    // Skip if no stations available in test data
    if (stations.length === 0) {
      test.skip();
      return;
    }

    const targetStation = stations[0];

    // Hide stations
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showStations');
    await page.keyboard.press('Escape');

    // Switch to select tool
    await page.keyboard.press('s');

    // Get canvas position
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // Click on the known station location
    await page.mouse.click(box!.x + targetStation.x, box!.y + targetStation.y);

    // Verify selection is blocked (no station selected)
    await expect.poll(async () => {
      const selection = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { selection: { type: string } | null } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.selection ?? null;
      });
      return selection?.type ?? null;
    }, { timeout: 2000 }).not.toBe('station');
  });

  test('cannot select hidden shots - selection blocked', async ({ page }) => {
    // Wait for shot layer to be visible
    await waitForLayerVisible(page, 'survey-shots');

    // Hide shots
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showShots');
    await page.keyboard.press('Escape');

    // Switch to select tool
    await page.keyboard.press('s');

    // Get canvas and click in center
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // Click on canvas where shots might be
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

    // Verify no shot selection occurred
    await expect.poll(async () => {
      const selection = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { selection: { type: string } | null } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.selection ?? null;
      });
      return selection?.type ?? null;
    }, { timeout: 2000 }).not.toBe('shot');
  });

  test('no hover effect on hidden stations', async ({ page }) => {
    // Wait for stations to be visible and get their positions
    await waitForLayerVisible(page, 'survey-stations');
    const stations = await getStationScreenPositions(page);

    // Skip if no stations available in test data
    if (stations.length === 0) {
      test.skip();
      return;
    }

    const targetStation = stations[0];

    // Hide stations
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showStations');
    await page.keyboard.press('Escape');

    // Get canvas position
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // Move mouse to known station position
    await page.mouse.move(box!.x + targetStation.x, box!.y + targetStation.y);

    // Verify no hovered station
    await expect.poll(async () => {
      const hoveredStation = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { hoveredStation: unknown } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.hoveredStation ?? null;
      });
      return hoveredStation;
    }, { timeout: 1000 }).toBeNull();
  });
});

test.describe('Selection Clearing on Toggle', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Selection Clearing Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await expect.poll(async () => (await getStationScreenPositions(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('station selection cleared when stations hidden', async ({ page }) => {
    // Add a station selection via store
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { addToSelection: (s: unknown) => void } } } }).__E2E_TEST__;
      stores?.uiStore?.getState()?.addToSelection({
        type: 'station',
        stationRef: { section_id: 1, station_index: 0 },
      });
    });

    // Verify station is selected
    const selectionBefore = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { selection: { type: string } | null } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.selection ?? null;
    });
    expect(selectionBefore?.type).toBe('station');

    // Hide stations
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showStations');

    // Verify station selection is cleared
    await expect.poll(async () => {
      const selection = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { selection: { type: string } | null } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.selection ?? null;
      });
      return selection?.type ?? null;
    }, { timeout: 2000 }).not.toBe('station');
  });

  test('shot selection cleared when shots hidden', async ({ page }) => {
    // Add a shot selection via store
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { addToSelection: (s: unknown) => void } } } }).__E2E_TEST__;
      stores?.uiStore?.getState()?.addToSelection({
        type: 'shot',
        sectionId: 1,
        shotId: 0,
      });
    });

    // Verify shot is selected
    const selectionBefore = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { selection: { type: string } | null } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.selection ?? null;
    });
    expect(selectionBefore?.type).toBe('shot');

    // Hide shots
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showShots');

    // Verify shot selection is cleared
    await expect.poll(async () => {
      const selection = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { selection: { type: string } | null } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.selection ?? null;
      });
      return selection?.type ?? null;
    }, { timeout: 2000 }).not.toBe('shot');
  });

  test('mixed selection only clears hidden type', async ({ page }) => {
    // Add both station and shot selections
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { addToSelection: (s: unknown) => void } } } }).__E2E_TEST__;
      const state = stores?.uiStore?.getState();
      state?.addToSelection({
        type: 'station',
        stationRef: { section_id: 1, station_index: 0 },
      });
      state?.addToSelection({
        type: 'shot',
        sectionId: 1,
        shotId: 0,
      });
    });

    // Verify both are selected
    const multiBefore = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { multiSelection: Array<{ type: string }> } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.multiSelection ?? [];
    });
    expect(multiBefore.length).toBe(2);
    expect(multiBefore.some((s) => s.type === 'station')).toBe(true);
    expect(multiBefore.some((s) => s.type === 'shot')).toBe(true);

    // Hide stations
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showStations');

    // Verify only station is cleared, shot remains
    await expect.poll(async () => {
      const multi = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { multiSelection: Array<{ type: string }> } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.multiSelection ?? [];
      });
      return {
        hasStation: multi.some((s) => s.type === 'station'),
        hasShot: multi.some((s) => s.type === 'shot'),
      };
    }, { timeout: 2000 }).toEqual({ hasStation: false, hasShot: true });
  });
});

test.describe('Toast Notifications', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Toast Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
  });

  test('toast is throttled - same key blocked within 5 seconds', async ({ page }) => {
    // Show a toast via store
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showToast: (msg: string, key: string) => void } } } }).__E2E_TEST__;
      stores?.uiStore?.getState()?.showToast('First toast', 'test-key');
    });

    // Verify first toast was shown
    await expect.poll(async () => {
      const toast = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { toast: { message: string } | null } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.toast?.message ?? null;
      });
      return toast;
    }, { timeout: 1000 }).toBe('First toast');

    // Record the timestamp
    const timestamp1 = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { toast: { timestamp: number } | null } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.toast?.timestamp ?? 0;
    });

    // Try to show another toast with same key immediately
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showToast: (msg: string, key: string) => void } } } }).__E2E_TEST__;
      stores?.uiStore?.getState()?.showToast('Second toast', 'test-key');
    });

    // First toast should still be shown (throttled) - timestamp unchanged
    const timestamp2 = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { toast: { timestamp: number } | null } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.toast?.timestamp ?? 0;
    });
    expect(timestamp2).toBe(timestamp1);

    const toast2 = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { toast: { message: string } | null } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.toast?.message ?? null;
    });
    expect(toast2).toBe('First toast');
  });

  test('toast throttle allows different keys immediately', async ({ page }) => {
    // Show first toast
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showToast: (msg: string, key: string) => void } } } }).__E2E_TEST__;
      stores?.uiStore?.getState()?.showToast('First toast', 'key-1');
    });

    // Verify first toast
    await expect.poll(async () => {
      const toast = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { toast: { message: string } | null } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.toast?.message ?? null;
      });
      return toast;
    }, { timeout: 1000 }).toBe('First toast');

    // Different key should show immediately
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showToast: (msg: string, key: string) => void } } } }).__E2E_TEST__;
      stores?.uiStore?.getState()?.showToast('Different key toast', 'key-2');
    });

    const toast = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { toast: { message: string } | null } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.toast?.message ?? null;
    });
    expect(toast).toBe('Different key toast');
  });
});

test.describe('Toggle Relationship Tests', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Toggle Relationship Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await expect.poll(async () => (await getStationScreenPositions(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('Reference Shots toggle is disabled when Shots hidden', async ({ page }) => {
    await openDisplayMenu(page);

    // Reference Shots toggle should be enabled initially (Shots is on)
    const referenceShotsToggle = page.locator('[data-testid="display-toggle-showReferenceShots"]');
    await expect(referenceShotsToggle).toBeVisible();
    await expect(referenceShotsToggle).not.toBeDisabled();

    // Hide Shots
    await toggleDisplayOption(page, 'showShots');

    // Reference Shots toggle should now be disabled
    await expect(referenceShotsToggle).toBeDisabled();
  });

  test('Shot Data toggle is disabled when Shots hidden', async ({ page }) => {
    await openDisplayMenu(page);

    // Shot Data toggle should be enabled initially (Shots is on)
    const shotDataToggle = page.locator('[data-testid="display-toggle-showShotData"]');
    await expect(shotDataToggle).toBeVisible();
    await expect(shotDataToggle).not.toBeDisabled();

    // Hide Shots
    await toggleDisplayOption(page, 'showShots');

    // Shot Data toggle should now be disabled
    await expect(shotDataToggle).toBeDisabled();
  });

  test('dependent toggles re-enable when Shots shown', async ({ page }) => {
    await openDisplayMenu(page);

    // Hide shots
    await toggleDisplayOption(page, 'showShots');

    // Verify dependent toggles are disabled
    const referenceShotsToggle = page.locator('[data-testid="display-toggle-showReferenceShots"]');
    const shotDataToggle = page.locator('[data-testid="display-toggle-showShotData"]');
    await expect(referenceShotsToggle).toBeDisabled();
    await expect(shotDataToggle).toBeDisabled();

    // Show shots again
    await toggleDisplayOption(page, 'showShots');

    // Dependent toggles should be re-enabled
    await expect(referenceShotsToggle).not.toBeDisabled();
    await expect(shotDataToggle).not.toBeDisabled();
  });

  test('dependent toggle state is preserved through parent toggle cycle', async ({ page }) => {
    await openDisplayMenu(page);

    // Get initial showReferenceShots state (should be true by default)
    const initialState = await isToggleOn(page, 'showReferenceShots');
    expect(initialState).toBe(true);

    // Turn off Reference Shots
    await toggleDisplayOption(page, 'showReferenceShots');
    expect(await isToggleOn(page, 'showReferenceShots')).toBe(false);

    // Toggle parent (showShots) off then on
    await toggleDisplayOption(page, 'showShots');
    await toggleDisplayOption(page, 'showShots');

    // Reference Shots state should be preserved (still off)
    expect(await isToggleOn(page, 'showReferenceShots')).toBe(false);
  });
});

test.describe('Tool Operation Tests', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Tool Operation Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await expect.poll(async () => (await getStationScreenPositions(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('draw operation continues when stations hidden - highlight layer shows origin', async ({ page }) => {
    // This tests that draw operations continue to work even with hidden stations
    // The highlight layer makes the origin station visible during the operation
    // (Per MapCanvas.tsx: "Do NOT clear drawFromStation... These operations work with hidden stations")

    // Switch to draw tool
    await page.keyboard.press('d');

    // Set a draw from station via store (simulating start of draw)
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { setDrawFromStation: (ref: unknown) => void } } } }).__E2E_TEST__;
      stores?.uiStore?.getState()?.setDrawFromStation({
        section_id: 1,
        station_index: 0,
      });
    });

    // Verify draw is active
    await expect.poll(async () => {
      const drawFrom = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { drawFromStation: unknown } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.drawFromStation ?? null;
      });
      return drawFrom;
    }, { timeout: 1000 }).not.toBeNull();

    // Hide stations
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showStations');

    // Draw operation should PERSIST - highlight layer shows origin station
    const drawFromAfter = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { drawFromStation: unknown } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.drawFromStation ?? null;
    });
    expect(drawFromAfter).not.toBeNull();
  });

  test('merge operation canceled when stations hidden mid-merge', async ({ page }) => {
    // Unlike draw, merge requires visible stations to select targets

    // Switch to merge tool
    await page.keyboard.press('m');

    // Set a merge station A via store (simulating first station selected)
    await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { setMergeStationA: (ref: unknown) => void } } } }).__E2E_TEST__;
      stores?.uiStore?.getState()?.setMergeStationA({
        section_id: 1,
        station_index: 0,
      });
    });

    // Verify merge station A is set
    await expect.poll(async () => {
      const mergeA = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { mergeStationA: unknown } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.mergeStationA ?? null;
      });
      return mergeA;
    }, { timeout: 1000 }).not.toBeNull();

    // Hide stations
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showStations');

    // Merge should be canceled (mergeStationA should be null)
    await expect.poll(async () => {
      const mergeA = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { mergeStationA: unknown } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.mergeStationA ?? null;
      });
      return mergeA;
    }, { timeout: 2000 }).toBeNull();
  });

  test('snap detection is disabled when stations are hidden during Draw tool', async ({ page }) => {
    // Wait for stations to be visible and get their positions
    await waitForLayerVisible(page, 'survey-stations');
    const stations = await getStationScreenPositions(page);

    // Skip if no stations available
    if (stations.length === 0) {
      test.skip();
      return;
    }

    const targetStation = stations[0];

    // Hide stations
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showStations');
    await page.keyboard.press('Escape');

    // Switch to draw tool
    await page.keyboard.press('d');

    // Get canvas position
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // Move mouse near the known station position (with small offsets for stability)
    const offsets = [
      [0, 0],
      [4, 0],
      [-4, 0],
      [0, 4],
      [0, -4],
      [6, 6],
      [-6, -6],
    ] as const;

    let snappedStation: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      for (const [dx, dy] of offsets) {
        await page.mouse.move(box!.x + targetStation.x + dx, box!.y + targetStation.y + dy);
        // Let map pointer handlers process the latest move event
        await page.waitForTimeout(40);
        snappedStation = await page.evaluate(() => {
          const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { snappedStation: unknown } } } }).__E2E_TEST__;
          return stores?.uiStore?.getState()?.snappedStation ?? null;
        });
        if (snappedStation) break;
      }
      if (snappedStation) break;
    }

    // Stations hitbox layer is hidden alongside stations, so snapping must remain unavailable
    expect(snappedStation).toBeNull();
  });
});

test.describe('Display Menu State Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'State Persistence Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await expect.poll(async () => (await getStationScreenPositions(page)).length, { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('toggle states persist when menu is closed and reopened', async ({ page }) => {
    // Open menu and change some toggles
    await openDisplayMenu(page);

    // Toggle stations off
    await toggleDisplayOption(page, 'showStations');
    expect(await isToggleOn(page, 'showStations')).toBe(false);

    // Toggle grid on
    await toggleDisplayOption(page, 'showGrid');
    expect(await isToggleOn(page, 'showGrid')).toBe(true);

    // Close menu
    await page.keyboard.press('Escape');

    // Verify menu is closed
    await expect(page.locator('[data-testid="display-toggle-showStations"]')).not.toBeVisible();

    // Reopen menu
    await openDisplayMenu(page);

    // Verify states are preserved
    expect(await isToggleOn(page, 'showStations')).toBe(false);
    expect(await isToggleOn(page, 'showGrid')).toBe(true);
  });

  test('all display toggles have correct default states', async ({ page }) => {
    await openDisplayMenu(page);

    // Check default values from DISPLAY_DEFAULTS
    expect(await isToggleOn(page, 'showStations')).toBe(true);
    expect(await isToggleOn(page, 'showShots')).toBe(true);
    expect(await isToggleOn(page, 'showSectionNames')).toBe(true);
    expect(await isToggleOn(page, 'showStationLabels')).toBe(false);
    expect(await isToggleOn(page, 'showShotData')).toBe(false);
    expect(await isToggleOn(page, 'showReferenceShots')).toBe(true);
    expect(await isToggleOn(page, 'showZeroDatum')).toBe(true);
    expect(await isToggleOn(page, 'showGrid')).toBe(false);
    expect(await isToggleOn(page, 'showScaleBar')).toBe(true);
    expect(await isToggleOn(page, 'showSatellite')).toBe(false);
    expect(await isToggleOn(page, 'showDepthGradient')).toBe(false);
  });
});
