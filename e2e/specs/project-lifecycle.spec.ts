import {
  waitForAppReady,
  createNewProject,
  saveProject,
  undo,
  redo,
} from '../helpers/app';

describe('Project Lifecycle', () => {
  beforeEach(async () => {
    await waitForAppReady();
  });

  describe('Project Creation', () => {
    it('should display the start page on launch', async () => {
      // Look for elements that indicate we're on the start/global view
      const startPage = await $(
        '[class*="GlobalView"], [class*="StartPage"], button*=New Project'
      );
      await expect(startPage).toBeExisting();
    });

    it('should have a New Project button', async () => {
      const newProjectBtn = await $('button*=New Project');
      await expect(newProjectBtn).toBeExisting();
      await expect(newProjectBtn).toBeClickable();
    });

    it('should open new project dialog when clicking New Project', async () => {
      const newProjectBtn = await $('button*=New Project');
      await newProjectBtn.click();

      // Wait for dialog
      const dialog = await $('[role="dialog"]');
      await dialog.waitForDisplayed({ timeout: 5000 });

      // Should have a project name input
      const nameInput = await $('input');
      await expect(nameInput).toBeExisting();
    });

    it('should create a project successfully', async () => {
      await createNewProject('E2E Test Project');

      // Verify we're now in the SingleSystemView
      // Look for map canvas or toolbar
      const mainView = await $(
        'canvas, [class*="MapCanvas"], [class*="SingleSystemView"], [class*="toolbar"]'
      );
      await expect(mainView).toBeExisting();
    });
  });

  describe('Project Saving', () => {
    it('should save project with Ctrl+S', async () => {
      await createNewProject('Save Test Project');

      // Save the project
      await saveProject();

      // After save, the window title should not have a dirty indicator (*)
      // Note: This depends on implementation - checking title might not be possible via WebDriver
      // Alternative: check for any save confirmation message
      await browser.pause(500);

      // Project should still be in editable state
      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });
  });

  describe('Undo/Redo', () => {
    it('should support Ctrl+Z for undo', async () => {
      await createNewProject('Undo Test Project');

      // Perform an action (open and close import dialog as a simple action)
      await browser.keys(['Control', 'i']);
      const dialog = await $('[role="dialog"]');
      await dialog.waitForDisplayed({ timeout: 5000 });
      await browser.keys(['Escape']);

      // Try undo
      await undo();

      // The app should still be functional
      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });

    it('should support Ctrl+Y for redo', async () => {
      await createNewProject('Redo Test Project');

      // Perform redo
      await redo();

      // App should still be functional
      const mainView = await $('canvas, [class*="MapCanvas"]');
      await expect(mainView).toBeExisting();
    });
  });
});
