import { waitForAppReady, resetAppState, loadProjectFixture, getMapZoom, waitForMapReady } from '../helpers/app';

describe('Zoom Tool E2E', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    await loadProjectFixture('basic-survey');
    await waitForMapReady();
  });

  describe('Toolbar Interaction', () => {
    it('clicking navigate group button activates zoom tool after cycling', async () => {
      // Navigate group defaults to pan; click once to activate pan, click again to cycle to zoom
      const navGroup = await $('[data-testid="tool-group-navigate"]');
      await navGroup.waitForExist({ timeout: 10000, timeoutMsg: 'Navigate group button did not appear' });
      await navGroup.click(); // activates pan (default)
      await navGroup.click(); // cycles to zoom

      // Wait for tool activation - navigate group should show active
      await browser.waitUntil(
        async () => {
          const classes = await navGroup.getAttribute('class');
          return classes?.includes('ring-accent') ?? false;
        },
        { timeout: 2000, timeoutMsg: 'Navigate group button did not become active' }
      );

      const classes = await navGroup.getAttribute('class');
      expect(classes).toContain('ring-accent');
    });

    it('Z key shortcut activates zoom tool', async () => {
      // Wait for toolbar to be ready
      const navGroup = await $('[data-testid="tool-group-navigate"]');
      await navGroup.waitForExist({ timeout: 10000, timeoutMsg: 'Navigate group button did not appear' });

      await browser.keys('z');

      await browser.waitUntil(
        async () => {
          const classes = await navGroup.getAttribute('class');
          return classes?.includes('ring-accent') ?? false;
        },
        { timeout: 2000, timeoutMsg: 'Navigate group button did not become active after Z key' }
      );

      const classes = await navGroup.getAttribute('class');
      expect(classes).toContain('ring-accent');
    });
  });

  describe('Click Zoom', () => {
    it('left click on map zooms in', async () => {
      // Activate zoom tool via keyboard shortcut (zoom is now in Navigate group)
      await browser.keys('z');
      const navGroup = await $('[data-testid="tool-group-navigate"]');
      await navGroup.waitForExist({ timeout: 10000 });
      await browser.waitUntil(
        async () => {
          const classes = await navGroup.getAttribute('class');
          return classes?.includes('ring-accent') ?? false;
        },
        { timeout: 2000 }
      );

      const initialZoom = await getMapZoom();
      expect(initialZoom).toBeGreaterThanOrEqual(0);

      const mapCanvas = await $('canvas.maplibregl-canvas');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();

      // Click in the center of the map
      const centerX = Math.round(location.x + size.width / 2);
      const centerY = Math.round(location.y + size.height / 2);
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: centerX, y: centerY },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();

      // Wait for zoom to change
      await browser.waitUntil(
        async () => {
          const newZoom = await getMapZoom();
          return newZoom > initialZoom;
        },
        { timeout: 5000, timeoutMsg: 'Zoom did not increase after left click' }
      );

      const newZoom = await getMapZoom();
      expect(newZoom).toBeGreaterThan(initialZoom);
    });

    it('right click on map zooms out', async () => {
      // Activate zoom tool via keyboard shortcut (zoom is now in Navigate group)
      await browser.keys('z');
      const navGroup = await $('[data-testid="tool-group-navigate"]');
      await navGroup.waitForExist({ timeout: 10000 });
      await browser.waitUntil(
        async () => {
          const classes = await navGroup.getAttribute('class');
          return classes?.includes('ring-accent') ?? false;
        },
        { timeout: 2000 }
      );

      const mapCanvas = await $('canvas.maplibregl-canvas');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();
      const centerX = Math.round(location.x + size.width / 2);
      const centerY = Math.round(location.y + size.height / 2);

      // Get zoom before any clicks
      const zoomBeforeFirstClick = await getMapZoom();

      // Left click to zoom in first so we have room to zoom out
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: centerX, y: centerY },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();

      // Wait for zoom in to complete (relative comparison, not absolute)
      await browser.waitUntil(
        async () => {
          const zoom = await getMapZoom();
          return zoom > zoomBeforeFirstClick;
        },
        { timeout: 5000, timeoutMsg: 'Zoom did not increase after first click' }
      );

      const initialZoom = await getMapZoom();
      expect(initialZoom).toBeGreaterThan(zoomBeforeFirstClick);

      // Right click to zoom out
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: centerX, y: centerY },
            { type: 'pointerDown', button: 2 },
            { type: 'pointerUp', button: 2 },
          ],
        },
      ]);
      await browser.releaseActions();

      // Wait for zoom to decrease
      await browser.waitUntil(
        async () => {
          const newZoom = await getMapZoom();
          return newZoom < initialZoom;
        },
        { timeout: 5000, timeoutMsg: 'Zoom did not decrease after right click' }
      );

      const newZoom = await getMapZoom();
      expect(newZoom).toBeLessThan(initialZoom);
    });
  });

  describe('Box Zoom', () => {
    it('drag rectangle zooms to fit area', async () => {
      // Activate zoom tool via keyboard shortcut (zoom is now in Navigate group)
      await browser.keys('z');
      const navGroup = await $('[data-testid="tool-group-navigate"]');
      await navGroup.waitForExist({ timeout: 10000 });
      await browser.waitUntil(
        async () => {
          const classes = await navGroup.getAttribute('class');
          return classes?.includes('ring-accent') ?? false;
        },
        { timeout: 2000 }
      );

      const initialZoom = await getMapZoom();
      expect(initialZoom).toBeGreaterThanOrEqual(0);

      const mapCanvas = await $('canvas.maplibregl-canvas');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();

      // Calculate drag coordinates (rectangle in the center of the map)
      const startX = Math.round(location.x + size.width / 4);
      const startY = Math.round(location.y + size.height / 4);
      const endX = Math.round(location.x + (size.width * 3) / 4);
      const endY = Math.round(location.y + (size.height * 3) / 4);

      // Perform drag action
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: startX, y: startY },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: endX, y: endY, duration: 100 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();

      // Wait for zoom to increase (box zoom should increase zoom level)
      await browser.waitUntil(
        async () => {
          const newZoom = await getMapZoom();
          return newZoom > initialZoom;
        },
        { timeout: 5000, timeoutMsg: 'Zoom did not increase after box zoom drag' }
      );

      const newZoom = await getMapZoom();
      expect(newZoom).toBeGreaterThan(initialZoom);
    });

    it('box zoom overlay visible during drag', async () => {
      // Activate zoom tool via keyboard shortcut (zoom is now in Navigate group)
      await browser.keys('z');
      const navGroup = await $('[data-testid="tool-group-navigate"]');
      await navGroup.waitForExist({ timeout: 10000 });
      await browser.waitUntil(
        async () => {
          const classes = await navGroup.getAttribute('class');
          return classes?.includes('ring-accent') ?? false;
        },
        { timeout: 2000 }
      );

      const mapCanvas = await $('canvas.maplibregl-canvas');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();

      const startX = Math.round(location.x + 100);
      const startY = Math.round(location.y + 100);
      const endX = Math.round(location.x + 300);
      const endY = Math.round(location.y + 300);

      // Start drag (hold mouse down)
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: startX, y: startY },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: endX, y: endY, duration: 100 },
          ],
        },
      ]);

      // Check that zoom box overlay is visible
      const overlay = await $('[data-testid="zoom-box-overlay"]');
      await expect(overlay).toBeDisplayed();

      // Release mouse
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();

      // Wait for overlay to be removed from DOM
      await $('[data-testid="zoom-box-overlay"]').waitForExist({ reverse: true, timeout: 2000 });
    });
  });

  describe('Config Integration', () => {
    it('uses zoom_step from config', async () => {
      // This test verifies that the Rust config is properly loaded and used by the frontend.
      // We read the zoom_step value that was loaded from Rust config and verify the
      // actual zoom delta matches it.

      // Wait for config to be loaded from Rust backend
      await browser.waitUntil(
        async () => {
          const hasConfig = await browser.execute(() => {
            const e2e = (window as unknown as {
              __E2E_TEST__?: {
                projectStore: {
                  getState: () => {
                    config: { map: { zoom_step: number } } | null;
                  };
                };
              };
            }).__E2E_TEST__;
            return e2e?.projectStore?.getState()?.config != null;
          });
          return hasConfig;
        },
        { timeout: 5000, timeoutMsg: 'Config was not loaded from Rust backend' }
      );

      // Read the zoom_step value that was loaded from Rust config
      const configuredZoomStep = await browser.execute(() => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                config: { map: { zoom_step: number } } | null;
              };
            };
          };
        }).__E2E_TEST__;
        return e2e?.projectStore?.getState()?.config?.map?.zoom_step ?? null;
      });

      // Verify config was loaded (should be a valid number, default is 1.0)
      expect(configuredZoomStep).not.toBeNull();
      expect(typeof configuredZoomStep).toBe('number');
      expect(configuredZoomStep).toBeGreaterThan(0);

      // Activate zoom tool via keyboard shortcut (zoom is now in Navigate group)
      await browser.keys('z');
      const navGroup = await $('[data-testid="tool-group-navigate"]');
      await navGroup.waitForExist({ timeout: 10000 });
      await browser.waitUntil(
        async () => {
          const classes = await navGroup.getAttribute('class');
          return classes?.includes('ring-accent') ?? false;
        },
        { timeout: 2000 }
      );

      const initialZoom = await getMapZoom();
      expect(initialZoom).toBeGreaterThanOrEqual(0);

      const mapCanvas = await $('canvas.maplibregl-canvas');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();
      const centerX = Math.round(location.x + size.width / 2);
      const centerY = Math.round(location.y + size.height / 2);

      // Click to zoom in
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: centerX, y: centerY },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();

      // Wait for zoom animation to complete (300ms animation + 200ms buffer)
      await browser.pause(500);

      // Wait for zoom to have changed (should already be done after animation)
      await browser.waitUntil(
        async () => {
          const newZoom = await getMapZoom();
          return newZoom > initialZoom;
        },
        { timeout: 5000, timeoutMsg: 'Zoom did not increase' }
      );

      const newZoom = await getMapZoom();
      const actualDiff = newZoom - initialZoom;

      // Verify the zoom delta matches the configured zoom_step from Rust config
      // Allow for animation/rounding variance (within 0.5 of configured value)
      expect(actualDiff).toBeGreaterThan(configuredZoomStep! - 0.5);
      expect(actualDiff).toBeLessThan(configuredZoomStep! + 0.5);
    });
  });
});
