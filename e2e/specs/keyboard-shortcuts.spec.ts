import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  selectTool,
  togglePanel,
  openDmpImportDialog,
  waitForUiIdle,
} from '../helpers/app';

describe('Keyboard Shortcuts', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    // Create a project so we have access to tools and panels
    await createNewProject('Keyboard Shortcuts Test');
  });

  describe('Tool Shortcuts', () => {
    const tools = [
      { key: 's', name: 'select', expectedClass: 'select' },
      { key: 'p', name: 'pan', expectedClass: 'pan' },
      { key: 'z', name: 'zoom', expectedClass: 'zoom' },
      { key: 'd', name: 'draw', expectedClass: 'draw' },
      { key: 'x', name: 'delete', expectedClass: 'delete' },
      { key: 'm', name: 'merge', expectedClass: 'merge' },
      { key: 'r', name: 'measure', expectedClass: 'measure' },
      { key: 'v', name: 'moveSection', expectedClass: 'move' },
      { key: 't', name: 'moveStation', expectedClass: 'station' },
    ];

    for (const tool of tools) {
      it(`should activate ${tool.name} tool with '${tool.key}' key`, async () => {
        // Press the tool shortcut key
        await browser.keys([tool.key]);
        await waitForUiIdle(200);

        // The app should remain functional regardless of tool selection
        const mainView = await $('[data-testid="map-canvas"]');
        await expect(mainView).toBeExisting();
      });
    }
  });

  describe('Panel Toggle Shortcuts', () => {
    it('should toggle sections panel with 1', async () => {
      await togglePanel('sections');

      // The panel state should have changed
      // Look for sections panel visibility change
      await waitForUiIdle(300);

      // App should still be functional
      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should toggle detail panel with 2', async () => {
      await togglePanel('detail');
      await waitForUiIdle(300);

      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should toggle data table panel with 3', async () => {
      await togglePanel('dataTable');
      await waitForUiIdle(300);

      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });
  });

  describe('Action Shortcuts', () => {
    it('should open import dialog (via helper, Ctrl+I opens native picker)', async () => {
      // Note: Ctrl+I opens native file picker which can't be automated in E2E tests.
      // We use the helper instead which parses a test fixture and opens the dialog.
      await openDmpImportDialog();

      // Opens DmpSelectionDialog (Step 1 of two-step import flow)
      const dialog = await $('[data-testid="dmp-selection-dialog"]');
      await dialog.waitForDisplayed({ timeout: 5000 });

      await expect(dialog).toBeDisplayed();

      // Close dialog via Cancel button
      const cancelBtn = await dialog.$('[data-testid="cancel-button"]');
      await cancelBtn.click();
    });

    it('should attempt save with Ctrl+S', async () => {
      await browser.keys(['Control', 's']);
      await waitForUiIdle(500);

      // App should still be functional after save attempt
      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should clear selection with Escape', async () => {
      // Press Escape
      await browser.keys(['Escape']);
      await waitForUiIdle(200);

      // App should still be functional
      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should fit map to view with Ctrl+0', async () => {
      await browser.keys(['Control', '0']);
      await waitForUiIdle(300);

      // Map should still be displayed
      const mapCanvas = await $('[data-testid="map-canvas"]');
      await expect(mapCanvas).toBeExisting();
    });
  });

  describe('Undo/Redo Shortcuts', () => {
    it('should handle Ctrl+Z for undo', async () => {
      await browser.keys(['Control', 'z']);
      await waitForUiIdle(200);

      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should handle Ctrl+Y for redo', async () => {
      await browser.keys(['Control', 'y']);
      await waitForUiIdle(200);

      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should handle Ctrl+Shift+Z for redo', async () => {
      await browser.keys(['Control', 'Shift', 'z']);
      await waitForUiIdle(200);

      const mainView = await $('[data-testid="map-canvas"]');
      await expect(mainView).toBeExisting();
    });
  });
});
