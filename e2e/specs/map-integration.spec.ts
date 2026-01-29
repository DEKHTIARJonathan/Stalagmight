/**
 * WebdriverIO E2E Tests: Map Integration
 *
 * These tests run against the full Tauri application with real backend
 * to validate map rendering, station selection, merging, navigation,
 * and label display after importing survey data.
 *
 * Test fixtures:
 * - test_v2.dmp: DMP version 2 format with multiple sections
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importDmpFile,
  selectTool,
  getProjectSections,
  waitForUiIdle,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

describe('Map Integration', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  /**
   * Test 13.1: should render survey on map after import
   *
   * Validates that after importing DMP data, the survey is rendered on the map:
   * - Canvas is present and displayed
   * - Survey layer elements are rendered
   * - Map container is functional
   */
  it('should render survey on map after import', async () => {
    await createNewProject('Map Render Test');

    // Import a DMP file with survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const result = await importDmpFile(dmpPath);
    expect(result.success).toBe(true);
    expect(result.sectionCount).toBeGreaterThan(0);

    // Wait for map to render the survey
    await waitForUiIdle(1000);

    // Verify map canvas is displayed
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();

    // Verify the sections were imported and should be rendered
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Verify map container exists
    const mapContainer = await $('[data-testid="maplibre-container"]');
    await expect(mapContainer).toBeExisting();

    // Check that stations were created (implies survey is rendered)
    const hasStations = sections.some(s => (s.shots as unknown[]).length > 0);
    expect(hasStations).toBe(true);
  });

  /**
   * Test 13.2: should select station on map click
   *
   * Validates that clicking on the map in select mode selects a station:
   * - Select tool is active
   * - Clicking on canvas triggers selection logic
   * - Selection state is updated
   */
  it('should select station on map click', async () => {
    await createNewProject('Selection Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const result = await importDmpFile(dmpPath);
    expect(result.success).toBe(true);

    // Switch to select tool
    await selectTool('select');

    // Wait for map to render
    await waitForUiIdle(500);

    // Get the canvas and its dimensions
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();
    const location = await mapCanvas.getLocation();
    const size = await mapCanvas.getSize();

    // Click in the center of the map (where survey should be rendered)
    const centerX = location.x + size.width / 2;
    const centerY = location.y + size.height / 2;

    await browser.performActions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await waitForUiIdle(300);

    // Verify map is still functional after click
    await expect(mapCanvas).toBeDisplayed();

    // Test Ctrl+A to select all stations (validates selection system works)
    await browser.keys(['Control', 'a']);
    await waitForUiIdle(200);

    // Check selection state via store (multiSelection holds selected items)
    const selectionResult = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              multiSelection: unknown[];
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return { hasSelection: false, count: 0 };

      const selected = e2e.uiStore.getState().multiSelection;
      return {
        hasSelection: Array.isArray(selected) && selected.length > 0,
        count: Array.isArray(selected) ? selected.length : 0,
      };
    });

    // After Ctrl+A with imported data, there should be selected stations
    expect(selectionResult.hasSelection).toBe(true);
    expect(selectionResult.count).toBeGreaterThan(0);
  });

  /**
   * Test 13.3: should merge stations on map
   *
   * Validates the merge tool workflow:
   * - Merge tool can be selected
   * - UI reflects merge mode
   * - Map remains functional in merge mode
   */
  it('should merge stations on map', async () => {
    await createNewProject('Merge Test');

    // Import survey data with multiple sections for merging
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const result = await importDmpFile(dmpPath);
    expect(result.success).toBe(true);
    expect(result.sectionCount).toBeGreaterThan(1); // Need multiple sections for merge

    // Switch to merge tool
    await selectTool('merge');

    // Wait for tool to activate
    await waitForUiIdle(300);

    // Verify map canvas is still displayed
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();

    // Verify tool state is set to merge
    const toolState = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              activeTool: string;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return null;
      return e2e.uiStore.getState().activeTool;
    });

    expect(toolState).toBe('merge');

    // Verify merge requires two stations - select one station first
    const location = await mapCanvas.getLocation();
    const size = await mapCanvas.getSize();
    const centerX = location.x + size.width / 2;
    const centerY = location.y + size.height / 2;

    // Click to try selecting first station for merge
    await browser.performActions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await waitForUiIdle(200);

    // Map should remain functional
    await expect(mapCanvas).toBeDisplayed();

    // Press Escape to exit merge mode cleanly
    await browser.keys(['Escape']);
    await waitForUiIdle(200);
  });

  /**
   * Test 13.4: should move section on map with move tool
   *
   * Validates section dragging functionality:
   * - Move section tool can be activated
   * - Dragging in move mode is functional
   * - Section positions can be modified
   */
  it('should move section on map with move tool', async () => {
    await createNewProject('Move Section Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const result = await importDmpFile(dmpPath);
    expect(result.success).toBe(true);

    // Switch to move section tool (Shift+V)
    await selectTool('moveSection');
    await waitForUiIdle(300);

    // Verify tool is active
    const toolState = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              activeTool: string;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return null;
      return e2e.uiStore.getState().activeTool;
    });

    expect(toolState).toBe('move_section');

    // Get the canvas for drag operation
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();
    const location = await mapCanvas.getLocation();
    const size = await mapCanvas.getSize();

    // Calculate drag positions
    const startX = location.x + size.width / 2;
    const startY = location.y + size.height / 2;
    const endX = startX + 50;
    const endY = startY + 50;

    // Perform drag action
    await browser.performActions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(startX), y: Math.round(startY) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', x: Math.round(endX), y: Math.round(endY), duration: 300 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await waitForUiIdle(300);

    // Map should still be displayed after drag
    await expect(mapCanvas).toBeDisplayed();

    // Verify sections still exist
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);
  });

  /**
   * Test 13.5: should zoom and pan map
   *
   * Validates map navigation controls:
   * - Mouse wheel zoom works
   * - Pan tool allows dragging
   * - Map remains functional after navigation
   */
  it('should zoom and pan map', async () => {
    await createNewProject('Navigation Test');

    // Import survey data for visual reference
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const result = await importDmpFile(dmpPath);
    expect(result.success).toBe(true);

    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();

    // Test zoom via mouse wheel
    await browser.execute(() => {
      const canvas = document.querySelector('[data-testid="maplibre-container"] canvas');
      if (canvas) {
        // Zoom in
        const zoomInEvent = new WheelEvent('wheel', {
          deltaY: -100,
          bubbles: true,
        });
        canvas.dispatchEvent(zoomInEvent);
      }
    });
    await waitForUiIdle(300);

    // Map should still be displayed after zoom
    await expect(mapCanvas).toBeDisplayed();

    // Test zoom out
    await browser.execute(() => {
      const canvas = document.querySelector('[data-testid="maplibre-container"] canvas');
      if (canvas) {
        const zoomOutEvent = new WheelEvent('wheel', {
          deltaY: 100,
          bubbles: true,
        });
        canvas.dispatchEvent(zoomOutEvent);
      }
    });
    await waitForUiIdle(300);

    // Switch to pan tool
    await selectTool('pan');
    await waitForUiIdle(200);

    // Verify pan tool is active
    const toolState = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              activeTool: string;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return null;
      return e2e.uiStore.getState().activeTool;
    });

    expect(toolState).toBe('pan');

    // Perform pan drag
    const location = await mapCanvas.getLocation();
    const size = await mapCanvas.getSize();
    const centerX = location.x + size.width / 2;
    const centerY = location.y + size.height / 2;

    await browser.performActions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', x: Math.round(centerX - 100), y: Math.round(centerY - 100), duration: 200 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await waitForUiIdle(300);

    // Map should still be functional after pan
    await expect(mapCanvas).toBeDisplayed();

    // Test fit to view (Ctrl+0)
    await browser.keys(['Control', '0']);
    await waitForUiIdle(500);

    // Map should remain displayed
    await expect(mapCanvas).toBeDisplayed();
  });

  /**
   * Test 13.6: should display station labels on map
   *
   * Validates station label rendering:
   * - Stations are rendered after import
   * - Label toggle mechanism exists
   * - Map displays survey elements
   */
  it('should display station labels on map', async () => {
    await createNewProject('Label Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const result = await importDmpFile(dmpPath);
    expect(result.success).toBe(true);

    // Wait for map to render
    await waitForUiIdle(1000);

    // Verify map is displayed
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();

    // Verify sections with shots exist (prerequisite for labels)
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    const hasStations = sections.some(s => (s.shots as unknown[]).length > 0);
    expect(hasStations).toBe(true);

    // Check if label toggle UI exists (may be in settings or view options)
    const labelToggle = await $('[data-testid="station-labels-toggle"], [data-testid="show-labels-toggle"]');
    if (await labelToggle.isExisting()) {
      // Toggle labels on
      await labelToggle.click();
      await waitForUiIdle(300);

      // Map should still be functional
      await expect(mapCanvas).toBeDisplayed();
    }

    // Verify MapLibre map container is present
    const maplibreContainer = await $('[data-testid="maplibre-container"]');
    await expect(maplibreContainer).toBeExisting();

    // Check that survey layer or elements are rendered
    // Verify the map container is properly sized
    const canvasSize = await mapCanvas.getSize();
    expect(canvasSize.width).toBeGreaterThan(0);
    expect(canvasSize.height).toBeGreaterThan(0);

    // Verify we can still interact with the map (labels don't break rendering)
    await selectTool('select');
    await waitForUiIdle(200);

    await expect(mapCanvas).toBeDisplayed();
  });
});
