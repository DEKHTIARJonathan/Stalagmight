/**
 * WebdriverIO E2E Tests: MapLibre Control Dark Theme Styling
 *
 * Verifies that MapLibre GL JS built-in controls (NavigationControl, ScaleControl)
 * have the correct dark theme CSS overrides applied in both MapCanvas and GlobalViewMap.
 *
 * Uses browser.execute(getComputedStyle) pattern consistent with:
 * - section-highlighting-a11y.spec.ts:301-304
 * - shortcuts-accessibility.spec.ts:766-772
 * - export-accessibility.spec.ts:388-397
 */

import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  waitForMapReady,
  waitForUiIdle,
  loadProjectFixture,
} from '../helpers/app';

/**
 * Parse an RGB/RGBA color string into numeric components.
 * Handles both "rgb(r, g, b)" and "rgba(r, g, b, a)" formats,
 * as well as the keyword "transparent".
 * Returns { r, g, b, a } with a defaulting to 1 for opaque.
 */
function parseColor(color: string): { r: number; g: number; b: number; a: number } {
  if (color === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const rgbaMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (!rgbaMatch) throw new Error(`Cannot parse color: ${color}`);
  return {
    r: parseInt(rgbaMatch[1]!, 10),
    g: parseInt(rgbaMatch[2]!, 10),
    b: parseInt(rgbaMatch[3]!, 10),
    a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
  };
}

/**
 * Assert two color strings represent the same color (tolerance for rounding).
 */
function expectColorEqual(actual: string, expectedR: number, expectedG: number, expectedB: number): void {
  const parsed = parseColor(actual);
  expect(parsed.r).toBe(expectedR);
  expect(parsed.g).toBe(expectedG);
  expect(parsed.b).toBe(expectedB);
}

/**
 * Assert a color is fully transparent (alpha=0 or the keyword "transparent").
 */
function expectTransparent(color: string): void {
  const parsed = parseColor(color);
  expect(parsed.a).toBe(0);
}

/**
 * Wait for MapLibre controls to appear within a scoped container.
 * @param containerSelector - CSS selector for the parent container (e.g. '[data-testid="map-canvas"]')
 * @param timeout - Max wait time in ms
 */
async function waitForMapControls(containerSelector: string, timeout = 15000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const exists = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) return false;
        return !!container.querySelector('.maplibregl-ctrl-group');
      }, containerSelector);
      return exists;
    },
    {
      timeout,
      timeoutMsg: `MapLibre control group did not appear within ${containerSelector} within ${timeout}ms`,
      interval: 500,
    }
  );
}

/**
 * Wait for MapLibre scale control to appear within a scoped container.
 * @param containerSelector - CSS selector for the parent container
 * @param timeout - Max wait time in ms
 */
async function waitForScaleControl(containerSelector: string, timeout = 10000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const exists = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) return false;
        return !!container.querySelector('.maplibregl-ctrl-scale');
      }, containerSelector);
      return exists;
    },
    {
      timeout,
      timeoutMsg: `MapLibre scale control did not appear within ${containerSelector} within ${timeout}ms`,
      interval: 500,
    }
  );
}

/**
 * Set a zero datum (GPS coordinates) on the first station of the first section.
 * This enables the project to appear on the GlobalViewMap.
 */
async function setGpsOnFirstStation(
  lat: number,
  lon: number,
  depthRef: number
): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (
      latitude: number,
      longitude: number,
      depth: number,
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: Array<{ id: number }> } | null;
              setZeroDatum: (
                stationRef: { section_id: number; station_index: number },
                coordinates: { latitude: number; longitude: number; depth_reference: number }
              ) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const state = e2e.projectStore.getState();
        if (!state.project || state.project.sections.length === 0) {
          done({ success: false, error: 'No sections available for GPS assignment' });
          return;
        }

        const stationRef = { section_id: state.project.sections[0].id, station_index: 0 };
        const gps = { latitude, longitude, depth_reference: depth };
        const result = await state.setZeroDatum(stationRef, gps);
        done(result);
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    lat,
    lon,
    depthRef
  );
}

/**
 * Save the current project to /tmp with a unique name.
 */
async function saveCurrentProject(): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (done: (result: { success: boolean; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              saveProject: (path: string) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const path = `/tmp/map-controls-test-${Date.now()}.stalx`;
        const result = await e2e.projectStore.getState().saveProject(path);
        done(result);
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    }
  );
}

/**
 * Switch the UI view to global without closing the project.
 * The project stays in the store so recent projects list is populated.
 */
async function switchToGlobalView(): Promise<void> {
  await browser.executeAsync(
    async (done: (result: { ok: boolean; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              closeDialog: () => void;
              setView: (view: string) => void;
            };
          };
          projectStore: {
            getState: () => {
              closeProject: () => Promise<void>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ ok: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        e2e.uiStore.getState().closeDialog();
        await e2e.projectStore.getState().closeProject();
        e2e.uiStore.getState().setView('global');
        done({ ok: true });
      } catch (err) {
        done({ ok: false, error: String(err) });
      }
    }
  );

  // Wait for global view to appear
  const globalView = await $('[data-testid="global-view"]');
  await globalView.waitForExist({ timeout: 10000 });
  await waitForUiIdle(300);
}

/**
 * Toggle scale bar via the Display menu UI (click menu button, click scale bar toggle).
 * This exercises the actual user flow rather than mutating the store directly.
 */
async function toggleScaleBarViaMenu(): Promise<void> {
  // Open display menu
  const menuButton = await $('[data-testid="display-menu-button"]');
  await menuButton.waitForClickable({ timeout: 5000 });
  await menuButton.click();

  // Wait for menu to appear
  const menu = await $('[data-testid="display-menu"]');
  await menu.waitForDisplayed({ timeout: 3000 });

  // Click scale bar toggle
  const scaleToggle = await $('[data-testid="display-toggle-showScaleBar"]');
  await scaleToggle.waitForClickable({ timeout: 3000 });
  await scaleToggle.click();

  // Close the menu by clicking the button again
  await menuButton.click();

  // Wait for menu to close and UI to settle
  await browser.waitUntil(
    async () => !(await menu.isDisplayed().catch(() => false)),
    { timeout: 3000 }
  ).catch(() => {
    // Menu may already be closed
  });
  await waitForUiIdle(300);
}

/**
 * Check if scale bar is currently enabled in the store.
 */
async function isScaleBarEnabled(): Promise<boolean> {
  return await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            showScaleBar: boolean;
          };
        };
      };
    }).__E2E_TEST__;

    return e2e?.uiStore.getState().showScaleBar ?? false;
  });
}

/** Container selector for MapCanvas (single-system view). */
const MAP_CANVAS_CONTAINER = '[data-testid="map-canvas"]';

/** Container selector for GlobalViewMap. */
const GLOBAL_MAP_CONTAINER = '[data-testid="globalview-map"]';

describe('MapLibre Control Dark Theme Styling', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  describe('MapCanvas view', () => {
    it('should apply dark background to control group', async () => {
      await createNewProject('Map Controls BG Test');
      await waitForMapReady();
      await waitForMapControls(MAP_CANVAS_CONTAINER);

      const bgColor = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) throw new Error('Map canvas container not found');
        const el = container.querySelector('.maplibregl-ctrl-group');
        if (!el) throw new Error('MapLibre control group not found in MapCanvas');
        return window.getComputedStyle(el as Element).backgroundColor;
      }, MAP_CANVAS_CONTAINER);

      // #16213e => rgb(22, 33, 62)
      expectColorEqual(bgColor, 22, 33, 62);
    });

    it('should apply dark border-top color to button dividers', async () => {
      await createNewProject('Map Controls Divider Test');
      await waitForMapReady();
      await waitForMapControls(MAP_CANVAS_CONTAINER);

      const borderTopColor = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) throw new Error('Map canvas container not found');
        const el = container.querySelector('.maplibregl-ctrl-group button + button');
        if (!el) throw new Error('MapLibre button divider not found in MapCanvas');
        return window.getComputedStyle(el as Element).borderTopColor;
      }, MAP_CANVAS_CONTAINER);

      // #0f3460 => rgb(15, 52, 96)
      expectColorEqual(borderTopColor, 15, 52, 96);
    });

    it('should apply invert filter to control icons', async () => {
      await createNewProject('Map Controls Icon Test');
      await waitForMapReady();
      await waitForMapControls(MAP_CANVAS_CONTAINER);

      const filterValue = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) throw new Error('Map canvas container not found');
        const el = container.querySelector('.maplibregl-ctrl-icon');
        if (!el) throw new Error('MapLibre control icon not found in MapCanvas');
        return window.getComputedStyle(el as Element).filter;
      }, MAP_CANVAS_CONTAINER);

      // filter: brightness(0) invert(1) should contain 'invert'
      expect(filterValue).toContain('invert');
    });

    it('should apply dark border and rounded corners to control group', async () => {
      await createNewProject('Map Controls Border Test');
      await waitForMapReady();
      await waitForMapControls(MAP_CANVAS_CONTAINER);

      const styles = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) throw new Error('Map canvas container not found');
        const el = container.querySelector('.maplibregl-ctrl-group');
        if (!el) throw new Error('MapLibre control group not found in MapCanvas');
        const cs = window.getComputedStyle(el as Element);
        return {
          // Use individual side colors for cross-engine stability
          borderTopColor: cs.borderTopColor,
          borderRadius: cs.borderRadius,
          boxShadow: cs.boxShadow,
        };
      }, MAP_CANVAS_CONTAINER);

      // Border color should be #0f3460 => rgb(15, 52, 96)
      expectColorEqual(styles.borderTopColor, 15, 52, 96);
      // Border radius should contain 4px (may return "4px" or "4px 4px 4px 4px")
      expect(styles.borderRadius).toContain('4px');
      // Should have a box-shadow
      expect(styles.boxShadow).not.toBe('none');
    });
  });

  describe('GlobalViewMap', () => {
    it('should apply dark background to control group in global view', async () => {
      // Create a project with GPS data so GlobalViewMap renders the actual map
      await loadProjectFixture('basic-survey');
      await waitForMapReady();

      // Set GPS coordinates on first station so the project shows on global map
      const gpsResult = await setGpsOnFirstStation(43.7, 7.27, 0);
      expect(gpsResult.success).toBe(true);

      // Save project so it appears in recent projects
      const saveResult = await saveCurrentProject();
      expect(saveResult.success).toBe(true);

      // Close project and switch to global view
      await switchToGlobalView();

      // Switch to map tab (should be default if GPS projects exist)
      const mapTab = await $('[data-testid="globalview-map-tab"]');
      if (await mapTab.isExisting()) {
        await mapTab.click();
        await waitForUiIdle(500);
      }

      // Wait for GlobalViewMap to render with actual map controls (scoped to global map container)
      await waitForMapControls(GLOBAL_MAP_CONTAINER, 20000);

      const bgColor = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) throw new Error('GlobalViewMap container not found');
        const el = container.querySelector('.maplibregl-ctrl-group');
        if (!el) throw new Error('MapLibre control group not found in GlobalViewMap');
        return window.getComputedStyle(el as Element).backgroundColor;
      }, GLOBAL_MAP_CONTAINER);

      // Same dark theme color as MapCanvas: #16213e => rgb(22, 33, 62)
      expectColorEqual(bgColor, 22, 33, 62);
    });

    it('should apply dark theme to scale control in global view', async () => {
      // Create project with GPS data
      await loadProjectFixture('basic-survey');
      await waitForMapReady();

      const gpsResult = await setGpsOnFirstStation(43.7, 7.27, 0);
      expect(gpsResult.success).toBe(true);

      const saveResult = await saveCurrentProject();
      expect(saveResult.success).toBe(true);

      // Close project and switch to global view
      await switchToGlobalView();

      const mapTab = await $('[data-testid="globalview-map-tab"]');
      if (await mapTab.isExisting()) {
        await mapTab.click();
        await waitForUiIdle(500);
      }

      // GlobalViewMap always has ScaleControl added (scoped to global map container)
      await waitForScaleControl(GLOBAL_MAP_CONTAINER, 20000);

      const scaleStyles = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) throw new Error('GlobalViewMap container not found');
        const el = container.querySelector('.maplibregl-ctrl-scale');
        if (!el) throw new Error('MapLibre scale control not found in GlobalViewMap');
        const cs = window.getComputedStyle(el as Element);
        return {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          // Use individual border side for cross-engine stability
          borderBottomColor: cs.borderBottomColor,
        };
      }, GLOBAL_MAP_CONTAINER);

      // Background should be transparent
      expectTransparent(scaleStyles.backgroundColor);

      // Border color: #0f3460 => rgb(15, 52, 96)
      expectColorEqual(scaleStyles.borderBottomColor, 15, 52, 96);

      // Text color: #f5f5f5 => rgb(245, 245, 245)
      expectColorEqual(scaleStyles.color, 245, 245, 245);
    });
  });

  describe('Scale bar toggle (MapCanvas)', () => {
    it('should apply correct styles when scale bar is present by default', async () => {
      await createNewProject('Scale Bar Default Test');
      await waitForMapReady();
      await waitForMapControls(MAP_CANVAS_CONTAINER);

      // Scale bar is on by default (showScaleBar: true in DISPLAY_DEFAULTS)
      const initialEnabled = await isScaleBarEnabled();
      expect(initialEnabled).toBe(true);

      // Scale control should be present within MapCanvas container
      await waitForScaleControl(MAP_CANVAS_CONTAINER);

      const scaleStyles = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) throw new Error('Map canvas container not found');
        const el = container.querySelector('.maplibregl-ctrl-scale');
        if (!el) throw new Error('MapLibre scale control not found in MapCanvas');
        const cs = window.getComputedStyle(el as Element);
        return {
          backgroundColor: cs.backgroundColor,
          borderBottomColor: cs.borderBottomColor,
          color: cs.color,
        };
      }, MAP_CANVAS_CONTAINER);

      // Verify dark theme styles on scale control
      expectTransparent(scaleStyles.backgroundColor);
      expectColorEqual(scaleStyles.borderBottomColor, 15, 52, 96);
      expectColorEqual(scaleStyles.color, 245, 245, 245);
    });

    it('should remove scale control when toggled off via Display menu', async () => {
      await createNewProject('Scale Bar Menu Remove Test');
      await waitForMapReady();
      await waitForMapControls(MAP_CANVAS_CONTAINER);

      // Scale bar should be on by default
      await waitForScaleControl(MAP_CANVAS_CONTAINER);

      // Toggle scale bar off via Display menu UI
      await toggleScaleBarViaMenu();

      // Scale control element should be removed from MapCanvas container
      await browser.waitUntil(
        async () => {
          const exists = await browser.execute((sel: string) => {
            const container = document.querySelector(sel);
            if (!container) return false;
            return !!container.querySelector('.maplibregl-ctrl-scale');
          }, MAP_CANVAS_CONTAINER);
          return !exists;
        },
        {
          timeout: 5000,
          timeoutMsg: 'Scale control was not removed from MapCanvas after toggling off via Display menu',
        }
      );
    });

    it('should re-apply correct styles when scale bar is toggled back on via Display menu', async () => {
      await createNewProject('Scale Bar Menu Re-add Test');
      await waitForMapReady();
      await waitForMapControls(MAP_CANVAS_CONTAINER);

      // Start with scale bar on
      await waitForScaleControl(MAP_CANVAS_CONTAINER);

      // Toggle off via Display menu
      await toggleScaleBarViaMenu();

      // Wait for removal within MapCanvas
      await browser.waitUntil(
        async () => {
          const exists = await browser.execute((sel: string) => {
            const container = document.querySelector(sel);
            if (!container) return false;
            return !!container.querySelector('.maplibregl-ctrl-scale');
          }, MAP_CANVAS_CONTAINER);
          return !exists;
        },
        { timeout: 5000, timeoutMsg: 'Scale control not removed from MapCanvas' }
      );

      // Toggle back on via Display menu
      await toggleScaleBarViaMenu();

      // Wait for scale control to reappear within MapCanvas
      await waitForScaleControl(MAP_CANVAS_CONTAINER);

      // Verify dark theme styles are applied on the re-added control
      const scaleStyles = await browser.execute((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) throw new Error('Map canvas container not found');
        const el = container.querySelector('.maplibregl-ctrl-scale');
        if (!el) throw new Error('MapLibre scale control not found after re-add in MapCanvas');
        const cs = window.getComputedStyle(el as Element);
        return {
          backgroundColor: cs.backgroundColor,
          borderBottomColor: cs.borderBottomColor,
          color: cs.color,
        };
      }, MAP_CANVAS_CONTAINER);

      expectTransparent(scaleStyles.backgroundColor);
      expectColorEqual(scaleStyles.borderBottomColor, 15, 52, 96);
      expectColorEqual(scaleStyles.color, 245, 245, 245);
    });
  });
});
