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
 * Wait for MapLibre controls to appear in the DOM.
 * Controls are added asynchronously after the map initializes.
 */
async function waitForMapControls(timeout = 15000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const exists = await browser.execute(() => {
        return !!document.querySelector('.maplibregl-ctrl-group');
      });
      return exists;
    },
    {
      timeout,
      timeoutMsg: `MapLibre control group did not appear within ${timeout}ms`,
      interval: 500,
    }
  );
}

/**
 * Wait for MapLibre scale control to appear in the DOM.
 */
async function waitForScaleControl(timeout = 10000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const exists = await browser.execute(() => {
        return !!document.querySelector('.maplibregl-ctrl-scale');
      });
      return exists;
    },
    {
      timeout,
      timeoutMsg: `MapLibre scale control did not appear within ${timeout}ms`,
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
        const path = `/tmp/map-controls-test-${Date.now()}.cvproj`;
        const result = await e2e.projectStore.getState().saveProject(path);
        done(result);
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    }
  );
}

/**
 * Navigate to global view by closing the current project.
 */
async function navigateToGlobalView(): Promise<void> {
  await browser.execute(() => {
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

    if (e2e) {
      e2e.uiStore.getState().closeDialog();
      e2e.uiStore.getState().setView('global');
    }
  });

  // Wait for global view to appear
  const globalView = await $('[data-testid="global-view"]');
  await globalView.waitForExist({ timeout: 10000 });
  await waitForUiIdle(300);
}

/**
 * Toggle the scale bar display setting.
 */
async function toggleScaleBar(enabled: boolean): Promise<void> {
  await browser.execute((show: boolean) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            showScaleBar: boolean;
            toggleDisplay: (key: string) => void;
          };
        };
      };
    }).__E2E_TEST__;

    if (e2e) {
      const currentState = e2e.uiStore.getState().showScaleBar;
      if (currentState !== show) {
        e2e.uiStore.getState().toggleDisplay('showScaleBar');
      }
    }
  }, enabled);
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

describe('MapLibre Control Dark Theme Styling', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  describe('MapCanvas view', () => {
    it('should apply dark background to control group', async () => {
      await createNewProject('Map Controls BG Test');
      await waitForMapReady();
      await waitForMapControls();

      const bgColor = await browser.execute(() => {
        const el = document.querySelector('.maplibregl-ctrl-group');
        if (!el) throw new Error('MapLibre control group not found');
        return window.getComputedStyle(el as Element).backgroundColor;
      });

      // #16213e => rgb(22, 33, 62)
      expect(bgColor).toBe('rgb(22, 33, 62)');
    });

    it('should apply dark border-top color to button dividers', async () => {
      await createNewProject('Map Controls Divider Test');
      await waitForMapReady();
      await waitForMapControls();

      const borderTopColor = await browser.execute(() => {
        const el = document.querySelector('.maplibregl-ctrl-group button + button');
        if (!el) throw new Error('MapLibre button divider not found');
        return window.getComputedStyle(el as Element).borderTopColor;
      });

      // #0f3460 => rgb(15, 52, 96)
      expect(borderTopColor).toBe('rgb(15, 52, 96)');
    });

    it('should apply invert filter to control icons', async () => {
      await createNewProject('Map Controls Icon Test');
      await waitForMapReady();
      await waitForMapControls();

      const filterValue = await browser.execute(() => {
        const el = document.querySelector('.maplibregl-ctrl-icon');
        if (!el) throw new Error('MapLibre control icon not found');
        return window.getComputedStyle(el as Element).filter;
      });

      // filter: brightness(0) invert(1) should contain 'invert'
      expect(filterValue).toContain('invert');
    });

    it('should apply dark border to control group', async () => {
      await createNewProject('Map Controls Border Test');
      await waitForMapReady();
      await waitForMapControls();

      const styles = await browser.execute(() => {
        const el = document.querySelector('.maplibregl-ctrl-group');
        if (!el) throw new Error('MapLibre control group not found');
        const cs = window.getComputedStyle(el as Element);
        return {
          borderColor: cs.borderColor,
          borderRadius: cs.borderRadius,
          boxShadow: cs.boxShadow,
        };
      });

      // Border color should be #0f3460 => rgb(15, 52, 96)
      expect(styles.borderColor).toBe('rgb(15, 52, 96)');
      // Border radius should be 4px
      expect(styles.borderRadius).toBe('4px');
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

      // Navigate back to global view
      await navigateToGlobalView();

      // Switch to map tab (should be default if GPS projects exist)
      const mapTab = await $('[data-testid="globalview-map-tab"]');
      if (await mapTab.isExisting()) {
        await mapTab.click();
        await waitForUiIdle(500);
      }

      // Wait for GlobalViewMap to render with actual map controls
      await waitForMapControls(20000);

      const bgColor = await browser.execute(() => {
        const el = document.querySelector('.maplibregl-ctrl-group');
        if (!el) throw new Error('MapLibre control group not found in GlobalViewMap');
        return window.getComputedStyle(el as Element).backgroundColor;
      });

      // Same dark theme color as MapCanvas: #16213e => rgb(22, 33, 62)
      expect(bgColor).toBe('rgb(22, 33, 62)');
    });

    it('should apply dark theme to scale control in global view', async () => {
      // Create project with GPS data
      await loadProjectFixture('basic-survey');
      await waitForMapReady();

      const gpsResult = await setGpsOnFirstStation(43.7, 7.27, 0);
      expect(gpsResult.success).toBe(true);

      const saveResult = await saveCurrentProject();
      expect(saveResult.success).toBe(true);

      // Navigate to global view
      await navigateToGlobalView();

      const mapTab = await $('[data-testid="globalview-map-tab"]');
      if (await mapTab.isExisting()) {
        await mapTab.click();
        await waitForUiIdle(500);
      }

      // GlobalViewMap always has ScaleControl added
      await waitForScaleControl(20000);

      const scaleStyles = await browser.execute(() => {
        const el = document.querySelector('.maplibregl-ctrl-scale');
        if (!el) throw new Error('MapLibre scale control not found in GlobalViewMap');
        const cs = window.getComputedStyle(el as Element);
        return {
          backgroundColor: cs.backgroundColor,
          borderColor: cs.borderColor,
          color: cs.color,
        };
      });

      // Background should be transparent
      expect(
        scaleStyles.backgroundColor === 'transparent' ||
        scaleStyles.backgroundColor === 'rgba(0, 0, 0, 0)'
      ).toBe(true);

      // Border color: #0f3460 => rgb(15, 52, 96)
      expect(scaleStyles.borderColor).toBe('rgb(15, 52, 96)');

      // Text color: #f5f5f5 => rgb(245, 245, 245)
      expect(scaleStyles.color).toBe('rgb(245, 245, 245)');
    });
  });

  describe('Scale bar toggle (MapCanvas)', () => {
    it('should apply correct styles when scale bar is toggled on', async () => {
      await createNewProject('Scale Bar Toggle Test');
      await waitForMapReady();
      await waitForMapControls();

      // Scale bar is on by default (showScaleBar: true in DISPLAY_DEFAULTS)
      const initialEnabled = await isScaleBarEnabled();
      expect(initialEnabled).toBe(true);

      // Scale control should be present
      await waitForScaleControl();

      const scaleStyles = await browser.execute(() => {
        const el = document.querySelector('.maplibregl-ctrl-scale');
        if (!el) throw new Error('MapLibre scale control not found');
        const cs = window.getComputedStyle(el as Element);
        return {
          backgroundColor: cs.backgroundColor,
          borderColor: cs.borderColor,
          color: cs.color,
        };
      });

      // Verify dark theme styles on scale control
      expect(
        scaleStyles.backgroundColor === 'transparent' ||
        scaleStyles.backgroundColor === 'rgba(0, 0, 0, 0)'
      ).toBe(true);
      expect(scaleStyles.borderColor).toBe('rgb(15, 52, 96)');
      expect(scaleStyles.color).toBe('rgb(245, 245, 245)');
    });

    it('should remove scale control when toggled off', async () => {
      await createNewProject('Scale Bar Remove Test');
      await waitForMapReady();
      await waitForMapControls();

      // Scale bar should be on by default
      await waitForScaleControl();

      // Toggle scale bar off
      await toggleScaleBar(false);

      // Scale control element should be removed from DOM
      await browser.waitUntil(
        async () => {
          const exists = await browser.execute(() => {
            return !!document.querySelector('.maplibregl-ctrl-scale');
          });
          return !exists;
        },
        {
          timeout: 5000,
          timeoutMsg: 'Scale control was not removed after toggling off',
        }
      );
    });

    it('should re-apply correct styles when scale bar is toggled back on', async () => {
      await createNewProject('Scale Bar Re-add Test');
      await waitForMapReady();
      await waitForMapControls();

      // Start with scale bar on
      await waitForScaleControl();

      // Toggle off
      await toggleScaleBar(false);

      // Wait for removal
      await browser.waitUntil(
        async () => {
          const exists = await browser.execute(() => {
            return !!document.querySelector('.maplibregl-ctrl-scale');
          });
          return !exists;
        },
        { timeout: 5000, timeoutMsg: 'Scale control not removed' }
      );

      // Toggle back on
      await toggleScaleBar(true);

      // Wait for scale control to reappear
      await waitForScaleControl();

      // Verify dark theme styles are applied on the re-added control
      const scaleStyles = await browser.execute(() => {
        const el = document.querySelector('.maplibregl-ctrl-scale');
        if (!el) throw new Error('MapLibre scale control not found after re-add');
        const cs = window.getComputedStyle(el as Element);
        return {
          backgroundColor: cs.backgroundColor,
          borderColor: cs.borderColor,
          color: cs.color,
        };
      });

      expect(
        scaleStyles.backgroundColor === 'transparent' ||
        scaleStyles.backgroundColor === 'rgba(0, 0, 0, 0)'
      ).toBe(true);
      expect(scaleStyles.borderColor).toBe('rgb(15, 52, 96)');
      expect(scaleStyles.color).toBe('rgb(245, 245, 245)');
    });
  });
});
