/**
 * WebdriverIO E2E Tests: Detail Panel Center Button Functionality
 *
 * Tests the center/zoom buttons in detail panels that center the map on:
 * - Stations (centerOnStation)
 * - Shots (centerOnShot)
 * - Sections (zoomToSection / fitBounds)
 *
 * These tests run against the real Tauri application to validate
 * that clicking center buttons actually triggers map movement.
 */

import {
  waitForAppReady,
  resetAppState,
  loadProjectFixture,
  waitForMapReady,
  waitForUiIdle,
  waitForMapIdle,
  getMapZoom,
} from '../helpers/app';

/**
 * Get the current map center coordinates.
 * @returns The map center as { lng, lat } or null if map not available.
 */
async function getMapCenter(): Promise<{ lng: number; lat: number } | null> {
  return browser.execute(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: { getCenter: () => { lng: number; lat: number } };
    }).__stalagmight_map__;
    if (!map) return null;
    const center = map.getCenter();
    return { lng: center.lng, lat: center.lat };
  });
}

/**
 * Pan the map by a pixel offset to ensure it's not already centered on target.
 * This prevents false negatives when testing center button functionality.
 * @throws Error if map instance is not available.
 */
async function panMapOffTarget(): Promise<void> {
  await browser.execute(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: { panBy: (offset: [number, number], options?: { animate: boolean }) => void };
    }).__stalagmight_map__;
    if (!map) {
      throw new Error('Map instance not available - __stalagmight_map__ is not defined');
    }
    map.panBy([200, 100], { animate: false });
  });
  await waitForMapIdle(200);
}

/**
 * Select a station by section ID and station position (1-indexed).
 * @throws Error if E2E test helpers are not available.
 */
async function selectStation(sectionId: number, stationPosition: number): Promise<void> {
  const stationIndex = stationPosition - 1;
  await browser.execute(
    (secId: number, stIdx: number) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              setSelection: (selection: {
                type: string;
                stationRef: { section_id: number; station_index: number };
              }) => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        throw new Error('E2E test helpers not available - __E2E_TEST__ is not defined');
      }
      e2e.uiStore.getState().setSelection({
        type: 'station',
        stationRef: { section_id: secId, station_index: stIdx },
      });
    },
    sectionId,
    stationIndex
  );
  await waitForUiIdle(200);
}

/**
 * Select a shot by section ID and shot ID.
 * @throws Error if E2E test helpers are not available.
 */
async function selectShot(sectionId: number, shotId: number): Promise<void> {
  await browser.execute(
    (secId: number, shId: number) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              setSelection: (selection: {
                type: string;
                sectionId: number;
                shotId: number;
              }) => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        throw new Error('E2E test helpers not available - __E2E_TEST__ is not defined');
      }
      e2e.uiStore.getState().setSelection({
        type: 'shot',
        sectionId: secId,
        shotId: shId,
      });
    },
    sectionId,
    shotId
  );
  await waitForUiIdle(200);
}

/**
 * Select a section by section ID.
 * @throws Error if E2E test helpers are not available.
 */
async function selectSection(sectionId: number): Promise<void> {
  await browser.execute((secId: number) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            setSelection: (selection: { type: string; sectionId: number }) => void;
          };
        };
      };
    }).__E2E_TEST__;

    if (!e2e) {
      throw new Error('E2E test helpers not available - __E2E_TEST__ is not defined');
    }
    e2e.uiStore.getState().setSelection({
      type: 'section',
      sectionId: secId,
    });
  }, sectionId);
  await waitForUiIdle(200);
}

/**
 * Get section IDs from the current project.
 * @throws Error if E2E test helpers are not available.
 */
async function getSectionIds(): Promise<number[]> {
  return browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            project: { sections: Array<{ id: number }> } | null;
          };
        };
      };
    }).__E2E_TEST__;

    if (!e2e) {
      throw new Error('E2E test helpers not available - __E2E_TEST__ is not defined');
    }
    if (!e2e.projectStore.getState().project) return [];
    return e2e.projectStore.getState().project?.sections.map((s) => s.id) ?? [];
  });
}

/**
 * Get shot IDs for a specific section.
 * @throws Error if E2E test helpers are not available.
 */
async function getShotIdsForSection(sectionId: number): Promise<number[]> {
  return browser.execute((secId: number) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            project: {
              sections: Array<{
                id: number;
                shots: Array<{ id: number }>;
              }>;
            } | null;
          };
        };
      };
    }).__E2E_TEST__;

    if (!e2e) {
      throw new Error('E2E test helpers not available - __E2E_TEST__ is not defined');
    }
    if (!e2e.projectStore.getState().project) return [];
    const section = e2e.projectStore.getState().project?.sections.find((s) => s.id === secId);
    return section?.shots.map((s) => s.id) ?? [];
  }, sectionId);
}

/**
 * Ensure the detail panel is open by setting state directly.
 * Note: uiStore has toggleDetailPanel but no setDetailPanelOpen,
 * so we use setState directly for idempotent behavior.
 * @throws Error if E2E test helpers are not available.
 */
async function ensureDetailPanelOpen(): Promise<void> {
  await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          setState: (state: { detailPanelOpen: boolean }) => void;
        };
      };
    }).__E2E_TEST__;

    if (!e2e) {
      throw new Error('E2E test helpers not available - __E2E_TEST__ is not defined');
    }
    e2e.uiStore.setState({ detailPanelOpen: true });
  });
  await waitForUiIdle(200);
}

describe('Detail Panel Center Button', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();

    // Load basic-survey fixture which creates sections programmatically
    await loadProjectFixture('basic-survey');

    // Wait for map to be ready (loadProjectFixture already switches to single view)
    await waitForMapReady();
    await waitForMapIdle(500);
    await ensureDetailPanelOpen();
  });

  describe('Center on Station', () => {
    it('should center map when station center button is clicked', async () => {
      const sectionIds = await getSectionIds();
      expect(sectionIds.length).toBeGreaterThan(0);
      const sectionId = sectionIds[0]!;

      // Select a station (station 2, which is station_index 1)
      await selectStation(sectionId, 2);

      // Wait for detail panel to show station detail
      const stationDetail = await $('[data-testid="station-detail"]');
      await stationDetail.waitForExist({ timeout: 5000 });

      // Pan map off-target to ensure center button will cause visible change
      await panMapOffTarget();

      // Get map center after panning off-target
      const initialCenter = await getMapCenter();
      expect(initialCenter).not.toBeNull();

      // Find and click the center button
      const centerButton = await $('[data-testid="center-station-button"]');
      await expect(centerButton).toBeExisting();
      await expect(centerButton).toBeDisplayed();

      // Verify aria-label
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).toContain('Center map on station');

      // Click the center button
      await centerButton.click();

      // Wait for map center to change (use epsilon for float comparison)
      const EPSILON = 0.0001;
      await browser.waitUntil(
        async () => {
          const newCenter = await getMapCenter();
          if (!newCenter || !initialCenter) return false;
          return (
            Math.abs(newCenter.lng - initialCenter.lng) > EPSILON ||
            Math.abs(newCenter.lat - initialCenter.lat) > EPSILON
          );
        },
        { timeout: 5000, timeoutMsg: 'Map did not center on station' }
      );
    });

    it('should have accessible center button with proper attributes', async () => {
      const sectionIds = await getSectionIds();
      const sectionId = sectionIds[0]!;

      // Select a station
      await selectStation(sectionId, 1);

      // Wait for detail panel
      const stationDetail = await $('[data-testid="station-detail"]');
      await stationDetail.waitForExist({ timeout: 5000 });

      // Verify center button accessibility
      const centerButton = await $('[data-testid="center-station-button"]');
      await expect(centerButton).toBeExisting();

      // Verify button type for proper keyboard semantics
      const buttonType = await centerButton.getAttribute('type');
      expect(buttonType).toBe('button');

      // Verify aria-label exists and is descriptive
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).not.toBeNull();
      expect(ariaLabel!.length).toBeGreaterThan(10);
    });
  });

  describe('Center on Shot', () => {
    it('should center map when shot center button is clicked', async () => {
      const sectionIds = await getSectionIds();
      expect(sectionIds.length).toBeGreaterThan(0);
      const sectionId = sectionIds[0]!;

      const shotIds = await getShotIdsForSection(sectionId);
      expect(shotIds.length).toBeGreaterThan(0);
      const shotId = shotIds[0]!;

      // Select a shot
      await selectShot(sectionId, shotId);

      // Wait for shot detail panel (no specific testid, just wait for center button)
      await waitForUiIdle(300);

      // Pan map off-target to ensure center button will cause visible change
      await panMapOffTarget();

      // Get map center after panning off-target
      const initialCenter = await getMapCenter();
      expect(initialCenter).not.toBeNull();

      // Find and click the center button
      const centerButton = await $('[data-testid="center-shot-button"]');
      await expect(centerButton).toBeExisting();
      await expect(centerButton).toBeDisplayed();

      // Verify aria-label
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).toContain('Center map on shot');

      // Click the center button
      await centerButton.click();

      // Wait for map center to change (use epsilon for float comparison)
      const EPSILON = 0.0001;
      await browser.waitUntil(
        async () => {
          const newCenter = await getMapCenter();
          if (!newCenter || !initialCenter) return false;
          return (
            Math.abs(newCenter.lng - initialCenter.lng) > EPSILON ||
            Math.abs(newCenter.lat - initialCenter.lat) > EPSILON
          );
        },
        { timeout: 5000, timeoutMsg: 'Map did not center on shot' }
      );
    });

    it('should have accessible center button with proper attributes', async () => {
      const sectionIds = await getSectionIds();
      const sectionId = sectionIds[0]!;

      const shotIds = await getShotIdsForSection(sectionId);
      const shotId = shotIds[0]!;

      // Select a shot
      await selectShot(sectionId, shotId);
      await waitForUiIdle(300);

      // Verify center button accessibility
      const centerButton = await $('[data-testid="center-shot-button"]');
      await expect(centerButton).toBeExisting();

      // Verify button type for proper keyboard semantics
      const buttonType = await centerButton.getAttribute('type');
      expect(buttonType).toBe('button');

      // Verify aria-label exists and is descriptive
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).not.toBeNull();
      expect(ariaLabel!.length).toBeGreaterThan(10);
    });
  });

  describe('Center on Section', () => {
    it('should zoom map to fit section when center button is clicked', async () => {
      const sectionIds = await getSectionIds();
      expect(sectionIds.length).toBeGreaterThan(0);
      const sectionId = sectionIds[0]!;

      // Select a section
      await selectSection(sectionId);

      // Wait for section detail panel
      const sectionDetail = await $('[data-testid="section-detail"]');
      await sectionDetail.waitForExist({ timeout: 5000 });

      // Pan map off-target to ensure center button will cause visible change
      await panMapOffTarget();

      // Get map state after panning off-target
      const initialCenter = await getMapCenter();
      const initialZoom = await getMapZoom();
      expect(initialCenter).not.toBeNull();

      // Find and click the center button
      const centerButton = await $('[data-testid="center-section-button"]');
      await expect(centerButton).toBeExisting();
      await expect(centerButton).toBeDisplayed();

      // Verify aria-label
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).toContain('Center map on section');

      // Click the center button
      await centerButton.click();

      // Wait for map state to change (use epsilon for float comparison)
      // Section zoom uses fitBounds which adjusts both center and zoom
      const EPSILON = 0.0001;
      await browser.waitUntil(
        async () => {
          const newCenter = await getMapCenter();
          const newZoom = await getMapZoom();
          if (!newCenter || !initialCenter) return false;
          const centerChanged =
            Math.abs(newCenter.lng - initialCenter.lng) > EPSILON ||
            Math.abs(newCenter.lat - initialCenter.lat) > EPSILON;
          const zoomChanged = Math.abs(newZoom - initialZoom) > EPSILON;
          return centerChanged || zoomChanged;
        },
        { timeout: 5000, timeoutMsg: 'Map did not zoom to fit section' }
      );
    });

    it('should have accessible center button with proper attributes', async () => {
      const sectionIds = await getSectionIds();
      const sectionId = sectionIds[0]!;

      // Select a section
      await selectSection(sectionId);

      // Wait for section detail panel
      const sectionDetail = await $('[data-testid="section-detail"]');
      await sectionDetail.waitForExist({ timeout: 5000 });

      // Verify center button accessibility
      const centerButton = await $('[data-testid="center-section-button"]');
      await expect(centerButton).toBeExisting();

      // Verify button type for proper keyboard semantics
      const buttonType = await centerButton.getAttribute('type');
      expect(buttonType).toBe('button');

      // Verify aria-label exists and is descriptive
      const ariaLabel = await centerButton.getAttribute('aria-label');
      expect(ariaLabel).not.toBeNull();
      expect(ariaLabel!.length).toBeGreaterThan(10);
    });
  });

  describe('Center Button Keyboard Interaction', () => {
    it('should be focusable and activatable via keyboard', async () => {
      const sectionIds = await getSectionIds();
      const sectionId = sectionIds[0]!;

      // Select a section
      await selectSection(sectionId);

      // Wait for section detail panel
      const sectionDetail = await $('[data-testid="section-detail"]');
      await sectionDetail.waitForExist({ timeout: 5000 });

      // Pan map off-target to ensure keyboard activation will cause visible change
      await panMapOffTarget();

      // Get map center after panning off-target
      const initialCenter = await getMapCenter();
      expect(initialCenter).not.toBeNull();

      // Find the center button
      const centerButton = await $('[data-testid="center-section-button"]');
      await expect(centerButton).toBeExisting();

      // Focus the button via JavaScript
      await browser.execute(() => {
        const btn = document.querySelector('[data-testid="center-section-button"]') as HTMLElement;
        if (btn) btn.focus();
      });

      // Wait for focus
      await waitForUiIdle(100);

      // Press Enter to activate the button
      await browser.keys(['Enter']);

      // Wait for map center to change (use epsilon for float comparison)
      const EPSILON = 0.0001;
      await browser.waitUntil(
        async () => {
          const newCenter = await getMapCenter();
          if (!newCenter || !initialCenter) return false;
          return (
            Math.abs(newCenter.lng - initialCenter.lng) > EPSILON ||
            Math.abs(newCenter.lat - initialCenter.lat) > EPSILON
          );
        },
        { timeout: 5000, timeoutMsg: 'Map did not center after keyboard activation' }
      );
    });
  });
});
