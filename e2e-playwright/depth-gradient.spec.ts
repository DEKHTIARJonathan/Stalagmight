import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, type SectionSeed } from './helpers/app';

/**
 * E2E tests for depth gradient functionality.
 * Tests toggle behavior, depth legend visibility, and settings persistence.
 */

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
    name: 'Depth Gradient A',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 12, depth_in: 0, depth_out: -6 },
      { azimuth_in: 90, azimuth_out: 270, length: 8, depth_in: -6, depth_out: -12 },
    ],
  },
  {
    name: 'Depth Gradient B',
    direction: 'out',
    shots: [
      { azimuth_in: 180, azimuth_out: 0, length: 6, depth_in: -12, depth_out: -3 },
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
 * Helper to wait for map to be loaded
 */
async function waitForMapLoaded(page: Page): Promise<void> {
  await expect.poll(async () => {
    const loaded = await page.evaluate(() => {
      const map = (window as unknown as { __stalagmight_map__?: { loaded: () => boolean } }).__stalagmight_map__;
      return map?.loaded() ?? false;
    });
    return loaded;
  }, { timeout: 10000 }).toBe(true);
}

test.describe('Depth Gradient', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Depth Gradient Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapLoaded(page);
  });

  test('toggle enables depth coloring on map', async ({ page }) => {
    // Open Display menu
    await openDisplayMenu(page);

    // Verify depth gradient is OFF by default
    expect(await isToggleOn(page, 'showDepthGradient')).toBe(false);

    // Verify store state matches
    const depthGradientBefore = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showDepthGradient: boolean } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.showDepthGradient ?? false;
    });
    expect(depthGradientBefore).toBe(false);

    // Wait for station features to be rendered before capturing colors
    await expect.poll(async () => {
      const count = await page.evaluate(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: {
            queryRenderedFeatures: (opts: { layers: string[] }) => Array<unknown>;
          };
        }).__stalagmight_map__;
        if (!map) return 0;
        try {
          return map.queryRenderedFeatures({ layers: ['survey-stations'] }).length;
        } catch {
          return 0;
        }
      });
      return count;
    }, { timeout: 5000 }).toBeGreaterThan(0);

    // Get station colors BEFORE enabling depth gradient
    const colorsBefore = await page.evaluate(() => {
      const map = (window as unknown as {
        __stalagmight_map__?: {
          queryRenderedFeatures: (opts: { layers: string[] }) => Array<{
            properties: { color?: string };
          }>;
        };
      }).__stalagmight_map__;
      if (!map) return [];
      try {
        const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
        return features.slice(0, 5).map((f) => f.properties?.color ?? 'none');
      } catch {
        return [];
      }
    });

    // Ensure we have features to compare
    expect(colorsBefore.length).toBeGreaterThan(0);

    // Toggle depth gradient ON
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify toggle state changed
    expect(await isToggleOn(page, 'showDepthGradient')).toBe(true);

    // Verify store state changed
    const depthGradientAfter = await page.evaluate(() => {
      const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { showDepthGradient: boolean } } } }).__E2E_TEST__;
      return stores?.uiStore?.getState()?.showDepthGradient ?? false;
    });
    expect(depthGradientAfter).toBe(true);

    // Verify the depth legend is visible (rendering indicator)
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();

    // Poll for station colors to change after enabling depth gradient
    // Features are guaranteed to exist from the check above
    await expect.poll(async () => {
      const colorsAfter = await page.evaluate(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: {
            queryRenderedFeatures: (opts: { layers: string[] }) => Array<{
              properties: { color?: string };
            }>;
          };
        }).__stalagmight_map__;
        if (!map) return [];
        try {
          const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
          return features.slice(0, 5).map((f) => f.properties?.color ?? 'none');
        } catch {
          return [];
        }
      });

      // Keep polling if features not yet available (map still loading)
      if (colorsAfter.length === 0) return 'waiting';
      // Check if colors changed from before
      const colorsChanged = !colorsBefore.every((c, i) => c === colorsAfter[i]);
      return colorsChanged ? 'changed' : 'waiting';
    }, { timeout: 3000 }).toBe('changed');
  });

  test('shots use endpoint depth colors for line gradients', async ({ page }) => {
    // Sanity check: shot lines are actually visible in default (non-depth) mode.
    await expect.poll(async () => {
      const count = await page.evaluate(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: {
            queryRenderedFeatures: (opts: { layers: string[] }) => Array<unknown>;
          };
        }).__stalagmight_map__;
        if (!map) return 0;
        try {
          return map.queryRenderedFeatures({ layers: ['survey-shots'] }).length;
        } catch {
          return 0;
        }
      });
      return count;
    }, { timeout: 5000 }).toBeGreaterThan(0);

    // Wait for shot source features before reading endpoint color metadata.
    await expect.poll(async () => {
      const count = await page.evaluate(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: {
            querySourceFeatures: (sourceId: string) => Array<unknown>;
          };
        }).__stalagmight_map__;
        if (!map) return 0;
        try {
          return map.querySourceFeatures('survey-data-shots').length;
        } catch {
          return 0;
        }
      });
      return count;
    }, { timeout: 5000 }).toBeGreaterThan(0);

    const baseline = await page.evaluate(() => {
      const map = (window as unknown as {
        __stalagmight_map__?: {
          getStyle: () => { sources?: Record<string, unknown> };
          querySourceFeatures: (sourceId: string) => Array<{
            properties?: {
              fromColor?: string;
              toColor?: string;
              sectionId?: number;
              shotId?: number;
              color?: string;
            };
          }>;
        };
      }).__stalagmight_map__;
      if (!map) return null;

      const style = map.getStyle();
      const shots = map.querySourceFeatures('survey-data-shots');
      const gradientSegments = map.querySourceFeatures('survey-data-shot-gradients');
      const flatShotFound = shots.some((feature) => {
        const fromColor = feature.properties?.fromColor;
        const toColor = feature.properties?.toColor;
        return typeof fromColor === 'string' && fromColor.length > 0 && fromColor === toColor;
      });

      return {
        flatShotFound,
        gradientSegmentCount: gradientSegments.length,
      };
    });

    expect(baseline).not.toBeNull();
    expect(baseline?.flatShotFound).toBe(true);
    expect(baseline?.gradientSegmentCount).toBe(0);

    const depthGradientBefore = await page.evaluate(() => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: { getState: () => { showDepthGradient: boolean } };
        };
      }).__E2E_TEST__;
      return stores?.uiStore.getState().showDepthGradient ?? null;
    });
    expect(depthGradientBefore).toBe(false);

    await page.evaluate(() => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: { getState: () => { toggleDisplay: (key: string) => void } };
        };
      }).__E2E_TEST__;
      if (!stores) throw new Error('__E2E_TEST__ stores not found');
      stores.uiStore.getState().toggleDisplay('showDepthGradient');
    });

    await expect.poll(async () => {
      const enabled = await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { showDepthGradient: boolean } };
          };
        }).__E2E_TEST__;
        return stores?.uiStore.getState().showDepthGradient ?? false;
      });
      return enabled;
    }, { timeout: 2000 }).toBe(true);

    await expect.poll(async () => {
      const hasPerShotGradientSegments = await page.evaluate(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: {
            querySourceFeatures: (sourceId: string) => Array<{
              properties?: {
                sectionId?: number;
                shotId?: number;
                color?: string;
              };
            }>;
          };
        }).__stalagmight_map__;
        if (!map) return false;
        try {
          const segments = map.querySourceFeatures('survey-data-shot-gradients');
          if (segments.length === 0) return false;

          const colorsByShot = new Map<string, Set<string>>();
          for (const segment of segments) {
            const sectionId = segment.properties?.sectionId;
            const shotId = segment.properties?.shotId;
            const color = segment.properties?.color;
            if (typeof sectionId !== 'number' || typeof shotId !== 'number' || typeof color !== 'string') {
              continue;
            }
            const key = `${sectionId}:${shotId}`;
            const colors = colorsByShot.get(key) ?? new Set<string>();
            colors.add(color);
            colorsByShot.set(key, colors);
          }

          for (const colors of colorsByShot.values()) {
            if (colors.size > 1) return true;
          }
          return false;
        } catch {
          return false;
        }
      });
      return hasPerShotGradientSegments;
    }, { timeout: 3000 }).toBe(true);
  });

  test('toggle shows depth legend when enabled', async ({ page }) => {
    // Verify legend is hidden initially
    await expect(page.locator('[data-testid="depth-legend"]')).not.toBeVisible();

    // Enable depth gradient
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend is now visible
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();
  });

  test('toggle hides depth legend when disabled', async ({ page }) => {
    // Enable depth gradient first
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend is visible
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();

    // Disable depth gradient
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend is now hidden
    await expect(page.locator('[data-testid="depth-legend"]')).not.toBeVisible();
  });

  test('legend shows correct depth range labels', async ({ page }) => {
    // Enable depth gradient
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend is visible
    const legend = page.locator('[data-testid="depth-legend"]');
    await expect(legend).toBeVisible();

    // Verify legend contains depth values with unit 'm'
    await expect(legend).toContainText('m');

    // Verify min and max labels exist
    await expect(page.locator('[data-testid="depth-legend-min"]')).toBeVisible();
    await expect(page.locator('[data-testid="depth-legend-max"]')).toBeVisible();

    // Verify min and max labels contain numeric values (allow negative depths)
    const minText = await page.locator('[data-testid="depth-legend-min"]').textContent();
    const maxText = await page.locator('[data-testid="depth-legend-max"]').textContent();

    // Regex allows optional negative sign for depth values like -8.0m
    expect(minText).toMatch(/-?\d+(\.\d+)?m/);
    expect(maxText).toMatch(/-?\d+(\.\d+)?m/);
  });

  test('depth gradient setting calls save_display_setting on toggle', async ({ page }) => {
    // Track IPC calls via console logs (mock logs them)
    const ipcCalls: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Mock IPC]')) {
        ipcCalls.push(text);
      }
    });

    // Enable depth gradient
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend is visible
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();

    // Wait for save_display_setting IPC call using poll instead of fixed timeout
    await expect.poll(
      () => ipcCalls.some((call) => call.includes('save_display_setting')),
      { timeout: 2000 }
    ).toBe(true);

    // Verify the setting was saved (checked via mock console)
    const saveCall = ipcCalls.find((call) => call.includes('save_display_setting'));
    expect(saveCall).toBeDefined();
  });

  test('depth gradient toggle updates immediately', async ({ page }) => {
    // Enable depth gradient
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend appears (use default timeout for reliability)
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();

    // Disable depth gradient
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend hides (use default timeout for reliability)
    await expect(page.locator('[data-testid="depth-legend"]')).not.toBeVisible();
  });

  test('depth gradient toggle is independent of other display toggles', async ({ page }) => {
    await openDisplayMenu(page);

    // Enable depth gradient
    await toggleDisplayOption(page, 'showDepthGradient');
    expect(await isToggleOn(page, 'showDepthGradient')).toBe(true);

    // Verify other toggles remain unchanged
    expect(await isToggleOn(page, 'showStations')).toBe(true);
    expect(await isToggleOn(page, 'showShots')).toBe(true);
    expect(await isToggleOn(page, 'showSatellite')).toBe(false);
    expect(await isToggleOn(page, 'showGrid')).toBe(false);

    // Toggle stations off
    await toggleDisplayOption(page, 'showStations');

    // Depth gradient should still be on
    expect(await isToggleOn(page, 'showDepthGradient')).toBe(true);
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();
  });

  test('legend has proper accessibility attributes', async ({ page }) => {
    // Enable depth gradient
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend SVG has role and aria-label
    const legendSvg = page.locator('[data-testid="depth-legend"] svg');
    await expect(legendSvg).toBeVisible();
    await expect(legendSvg).toHaveAttribute('role', 'img');

    const ariaLabel = await legendSvg.getAttribute('aria-label');
    expect(ariaLabel).toMatch(/Depth scale/i);
    expect(ariaLabel).toMatch(/to/i);
  });

  // Note: Reload persistence cannot be tested with mocks because the mock's
  // in-memory storage is re-initialized on page reload. The WebdriverIO test
  // in e2e/specs/depth-gradient.spec.ts tests persistence against the real backend.
  // This test verifies that the setting is correctly saved to the backend.
  test('depth gradient setting is saved to backend on toggle', async ({ page }) => {
    // Track IPC calls via console logs (mock logs them)
    const ipcCalls: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Mock IPC]') && text.includes('save_display_setting')) {
        ipcCalls.push(text);
      }
    });

    // Enable depth gradient
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDepthGradient');

    // Verify legend is visible
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();

    // Wait for save call
    await expect.poll(
      () => ipcCalls.some((call) => call.includes('showDepthGradient')),
      { timeout: 2000 }
    ).toBe(true);

    // Verify the setting value was saved as 'true'
    const saveCall = ipcCalls.find((call) => call.includes('showDepthGradient'));
    expect(saveCall).toContain('true');
  });
});

test.describe('Depth Gradient with Menu Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Depth Gradient Menu Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapLoaded(page);
  });

  test('toggle states persist when menu is closed and reopened', async ({ page }) => {
    // Open menu and enable depth gradient
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDepthGradient');
    expect(await isToggleOn(page, 'showDepthGradient')).toBe(true);

    // Close menu
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="display-toggle-showDepthGradient"]')).not.toBeVisible();

    // Reopen menu
    await openDisplayMenu(page);

    // Verify state is preserved
    expect(await isToggleOn(page, 'showDepthGradient')).toBe(true);
  });

  test('depth gradient label shows in Display menu', async ({ page }) => {
    await openDisplayMenu(page);

    // Verify the toggle has proper label
    const toggle = page.locator('[data-testid="display-toggle-showDepthGradient"]');
    await expect(toggle).toContainText('Depth Gradient');
    await expect(toggle).toContainText('Color by depth');
  });
});
