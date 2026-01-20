import { waitForAppReady, resetAppState, createNewProject, selectTool, getMapZoom, waitForMapReady } from '../helpers/app';

describe('Zoom Tool E2E', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    await createNewProject('Zoom Tool Test Project');
    await waitForMapReady();
  });

  describe('Toolbar Interaction', () => {
    it('clicking zoom button in toolbar activates zoom tool', async () => {
      // Find zoom button by its title attribute
      const zoomBtn = await $('button[title="Zoom (Z)"]');
      await zoomBtn.click();
      await browser.pause(200);

      // Verify the button has the active ring class
      const classes = await zoomBtn.getAttribute('class');
      expect(classes).toContain('ring-accent');
    });

    it('Z key shortcut activates zoom tool', async () => {
      await browser.keys('z');
      await browser.pause(200);

      const zoomBtn = await $('button[title="Zoom (Z)"]');
      const classes = await zoomBtn.getAttribute('class');
      expect(classes).toContain('ring-accent');
    });
  });

  describe('Click Zoom', () => {
    it('left click on map zooms in', async () => {
      await selectTool('zoom');

      const initialZoom = await getMapZoom();
      expect(initialZoom).not.toBeNull();

      const mapCanvas = await $('canvas');
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

      // Wait for animation
      await browser.pause(400);

      const newZoom = await getMapZoom();
      expect(newZoom).not.toBeNull();
      expect(newZoom).toBeGreaterThan(initialZoom!);
    });

    it('right click on map zooms out', async () => {
      await selectTool('zoom');

      // First zoom in so we have room to zoom out
      const mapCanvas = await $('canvas');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();
      const centerX = Math.round(location.x + size.width / 2);
      const centerY = Math.round(location.y + size.height / 2);

      // Left click to zoom in first
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
      await browser.pause(400);

      const initialZoom = await getMapZoom();
      expect(initialZoom).not.toBeNull();

      // Right click to zoom out
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: centerX, y: centerY },
            { type: 'pointerDown', button: 2 }, // button: 2 is right click
            { type: 'pointerUp', button: 2 },
          ],
        },
      ]);
      await browser.releaseActions();

      // Wait for animation
      await browser.pause(400);

      const newZoom = await getMapZoom();
      expect(newZoom).not.toBeNull();
      expect(newZoom).toBeLessThan(initialZoom!);
    });
  });

  describe('Box Zoom', () => {
    it('drag rectangle zooms to fit area', async () => {
      await selectTool('zoom');

      const initialZoom = await getMapZoom();
      expect(initialZoom).not.toBeNull();

      const mapCanvas = await $('canvas');
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

      // Wait for animation
      await browser.pause(400);

      const newZoom = await getMapZoom();
      expect(newZoom).not.toBeNull();
      // Box zoom should increase zoom level
      expect(newZoom).toBeGreaterThan(initialZoom!);
    });

    it('box zoom overlay is visible during drag', async () => {
      await selectTool('zoom');

      const mapCanvas = await $('canvas');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();

      const startX = Math.round(location.x + 100);
      const startY = Math.round(location.y + 100);
      const endX = Math.round(location.x + 300);
      const endY = Math.round(location.y + 300);

      // Start drag
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: startX, y: startY },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: endX, y: endY, duration: 100 },
            // Keep the mouse down to check for overlay
          ],
        },
      ]);

      // Check that zoom box overlay is visible
      const overlay = await $('[data-testid="zoom-box-overlay"]');
      await expect(overlay).toBeDisplayed();

      // Release and cleanup
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

      // Overlay should be gone after release
      await browser.pause(100);
      await expect(overlay).not.toBeDisplayed();
    });
  });

  describe('Spring-Loaded Z Key', () => {
    it('hold Z then release restores previous tool', async () => {
      // Start with merge tool
      await selectTool('merge');
      await browser.pause(100);

      // Verify merge tool is active
      const mergeBtn = await $('button[title="Merge (M)"]');
      const mergeClasses = await mergeBtn.getAttribute('class');
      expect(mergeClasses).toContain('ring-accent');

      // Hold Z key
      await browser.performActions([
        {
          type: 'key',
          id: 'keyboard',
          actions: [{ type: 'keyDown', value: 'z' }],
        },
      ]);

      // Wait > 200ms for spring-loaded mode
      await browser.pause(300);

      // Verify zoom tool is active while holding
      const zoomBtn = await $('button[title="Zoom (Z)"]');
      const zoomClasses = await zoomBtn.getAttribute('class');
      expect(zoomClasses).toContain('ring-accent');

      // Release Z key
      await browser.performActions([
        {
          type: 'key',
          id: 'keyboard',
          actions: [{ type: 'keyUp', value: 'z' }],
        },
      ]);
      await browser.releaseActions();
      await browser.pause(100);

      // Verify merge tool is restored
      const mergeClassesAfter = await mergeBtn.getAttribute('class');
      expect(mergeClassesAfter).toContain('ring-accent');
    });

    it('quick tap Z keeps zoom tool', async () => {
      // Start with select tool
      await selectTool('select');
      await browser.pause(100);

      // Verify select tool is active
      const selectBtn = await $('button[title="Select (S)"]');
      const selectClasses = await selectBtn.getAttribute('class');
      expect(selectClasses).toContain('ring-accent');

      // Quick tap Z (well under 200ms threshold)
      await browser.keys('z');
      await browser.pause(100);

      // Verify zoom tool is now active (tap keeps the new tool)
      const zoomBtn = await $('button[title="Zoom (Z)"]');
      const zoomClasses = await zoomBtn.getAttribute('class');
      expect(zoomClasses).toContain('ring-accent');
    });
  });

  describe('Config Integration', () => {
    it('uses zoom_step from config', async () => {
      // This test verifies the Rust config is properly loaded
      // Default zoom_step is 1.0, so zoom should change by ~1 level
      await selectTool('zoom');

      const initialZoom = await getMapZoom();
      expect(initialZoom).not.toBeNull();

      const mapCanvas = await $('canvas');
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
      await browser.pause(400);

      const newZoom = await getMapZoom();
      expect(newZoom).not.toBeNull();
      const diff = newZoom! - initialZoom!;
      // Zoom step should be approximately 1.0 (allow for animation/rounding)
      expect(diff).toBeGreaterThan(0.5);
      expect(diff).toBeLessThan(1.5);
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('= key zooms in regardless of active tool', async () => {
      // Start with select tool
      await selectTool('select');

      const initialZoom = await getMapZoom();
      expect(initialZoom).not.toBeNull();

      // Press = to zoom in
      await browser.keys('=');
      await browser.pause(400);

      const newZoom = await getMapZoom();
      expect(newZoom).not.toBeNull();
      expect(newZoom).toBeGreaterThan(initialZoom!);
    });

    it('- key zooms out regardless of active tool', async () => {
      // Start with select tool and zoom in first
      await selectTool('select');

      // Zoom in
      await browser.keys('=');
      await browser.pause(400);

      const initialZoom = await getMapZoom();
      expect(initialZoom).not.toBeNull();

      // Press - to zoom out
      await browser.keys('-');
      await browser.pause(400);

      const newZoom = await getMapZoom();
      expect(newZoom).not.toBeNull();
      expect(newZoom).toBeLessThan(initialZoom!);
    });
  });
});
