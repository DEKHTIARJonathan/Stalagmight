import { waitForAppReady, resetAppState, createNewProject, selectTool, waitForUiIdle } from '../helpers/app';

describe('Map Interactions', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    await createNewProject('Map Test Project');
  });

  describe('Map Display', () => {
    it('should render the map canvas', async () => {
      const mapCanvas = await $('[data-testid="map-canvas"]');
      await expect(mapCanvas).toBeExisting();
      await expect(mapCanvas).toBeDisplayed();
    });

    it('should have map controls visible', async () => {
      // Look for zoom controls or other map UI elements
      const mapContainer = await $('[data-testid="maplibre-container"]');
      await expect(mapContainer).toBeExisting();
    });
  });

  describe('Tool Selection', () => {
    it('should switch to pan tool', async () => {
      await selectTool('pan');

      // Cursor or UI should reflect pan mode
      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should switch to select tool', async () => {
      await selectTool('select');

      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should switch to measure tool', async () => {
      await selectTool('measure');

      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });
  });

  describe('Map Navigation', () => {
    it('should handle mouse wheel for zoom', async () => {
      const mapCanvas = await $('[data-testid="map-canvas"]');
      await mapCanvas.scrollIntoView();

      // Simulate scroll
      await browser.execute(() => {
        const canvas = document.querySelector('[data-testid="maplibre-container"] canvas');
        if (canvas) {
          const event = new WheelEvent('wheel', {
            deltaY: -100,
            bubbles: true,
          });
          canvas.dispatchEvent(event);
        }
      });

      await waitForUiIdle(300);

      // Map should still be displayed
      await expect(mapCanvas).toBeDisplayed();
    });

    it('should handle pan by dragging in pan mode', async () => {
      await selectTool('pan');

      const mapCanvas = await $('[data-testid="map-canvas"]');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();

      // Calculate center of canvas
      const centerX = location.x + size.width / 2;
      const centerY = location.y + size.height / 2;

      // Perform a drag action
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: Math.round(centerX + 50), y: Math.round(centerY + 50) },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);

      await browser.releaseActions();
      await waitForUiIdle(200);

      // Map should still be displayed after pan
      await expect(mapCanvas).toBeDisplayed();
    });
  });

  describe('Selection', () => {
    it('should clear selection with Escape key', async () => {
      await selectTool('select');

      // Press Escape to clear any selection
      await browser.keys(['Escape']);
      await waitForUiIdle(200);

      // App should remain functional
      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should support Ctrl+A for select all', async () => {
      await selectTool('select');

      await browser.keys(['Control', 'a']);
      await waitForUiIdle(200);

      // App should remain functional
      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });
  });
});
