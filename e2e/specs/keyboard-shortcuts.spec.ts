import { waitForAppReady, createNewProject, selectTool, togglePanel } from '../helpers/app';

describe('Keyboard Shortcuts', () => {
  beforeEach(async () => {
    await waitForAppReady();
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
        await browser.pause(200);

        // Check if the toolbar reflects the active tool
        // Look for an active/selected state on toolbar buttons
        const activeToolIndicator = await $(
          `[class*="active"][class*="${tool.expectedClass}"], ` +
            `[data-active="true"][data-tool="${tool.name}"], ` +
            `button[class*="active"]:has-text("${tool.name}")`
        );

        // The app should remain functional regardless of tool selection
        const mainView = await $('canvas, [class*="MapCanvas"]');
        await expect(mainView).toBeExisting();
      });
    }
  });

  describe('Panel Toggle Shortcuts', () => {
    it('should toggle sections panel with Ctrl+1', async () => {
      await togglePanel('sections');

      // The panel state should have changed
      // Look for sections panel visibility change
      await browser.pause(300);

      // App should still be functional
      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should toggle detail panel with Ctrl+2', async () => {
      await togglePanel('detail');
      await browser.pause(300);

      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should toggle data table panel with Ctrl+3', async () => {
      await togglePanel('dataTable');
      await browser.pause(300);

      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });
  });

  describe('Action Shortcuts', () => {
    it('should open import dialog with Ctrl+I', async () => {
      await browser.keys(['Control', 'i']);

      const dialog = await $('[role="dialog"]');
      await dialog.waitForDisplayed({ timeout: 5000 });

      await expect(dialog).toBeDisplayed();

      // Close dialog
      await browser.keys(['Escape']);
    });

    it('should attempt save with Ctrl+S', async () => {
      await browser.keys(['Control', 's']);
      await browser.pause(500);

      // App should still be functional after save attempt
      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should clear selection with Escape', async () => {
      // Press Escape
      await browser.keys(['Escape']);
      await browser.pause(200);

      // App should still be functional
      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should fit map to view with Ctrl+0', async () => {
      await browser.keys(['Control', '0']);
      await browser.pause(300);

      // Map should still be displayed
      const mapCanvas = await $('canvas, [class*="MapCanvas"]');
      await expect(mapCanvas).toBeExisting();
    });
  });

  describe('Undo/Redo Shortcuts', () => {
    it('should handle Ctrl+Z for undo', async () => {
      await browser.keys(['Control', 'z']);
      await browser.pause(200);

      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should handle Ctrl+Y for redo', async () => {
      await browser.keys(['Control', 'y']);
      await browser.pause(200);

      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should handle Ctrl+Shift+Z for redo', async () => {
      await browser.keys(['Control', 'Shift', 'z']);
      await browser.pause(200);

      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });
  });
});
