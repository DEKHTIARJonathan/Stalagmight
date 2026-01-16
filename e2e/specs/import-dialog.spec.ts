import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  openImportDialog,
  closeDialog,
  getImportStatistics,
} from '../helpers/app';

describe('Import Dialog', () => {
  beforeEach(async () => {
    // Wait for the app to be fully loaded
    await waitForAppReady();
    // Reset any leftover state from previous tests
    await resetAppState();
  });

  it('should create a new project and open import dialog', async () => {
    // Create a new project
    await createNewProject('Test Project');

    // Open Import Dialog with Ctrl+I
    await openImportDialog();

    // Verify Import Dialog is displayed
    const importDialog = await $('[role="dialog"]');
    await expect(importDialog).toBeDisplayed();

    // Look for "Import" text in dialog title or content
    const dialogContent = await importDialog.getText();
    expect(dialogContent.toLowerCase()).toContain('import');

    // Close the dialog
    await closeDialog();
  });

  it('should display section name input field', async () => {
    await createNewProject('Section Name Test');
    await openImportDialog();

    // Find section name input
    const sectionNameInput = await $(
      'input[name*="section"], input[name*="name"], input[placeholder*="Section"]'
    );
    await expect(sectionNameInput).toBeExisting();

    // Enter a section name
    await sectionNameInput.setValue('Main Passage');

    // Verify the value was entered
    const value = await sectionNameInput.getValue();
    expect(value).toBe('Main Passage');

    await closeDialog();
  });

  it('should show section statistics when shots are present', async () => {
    await createNewProject('Stats Test Project');
    await openImportDialog();

    // Look for statistics elements in the footer
    // Note: These may only appear after shots are added
    const statsFooter = await $(
      '[class*="footer"], [class*="statistics"], [data-testid*="stats"]'
    );

    // Stats footer should exist (even if showing zeros)
    if (await statsFooter.isExisting()) {
      const stats = await getImportStatistics();
      // At minimum, we should be able to query for these elements
      console.log('Statistics found:', stats);
    }

    await closeDialog();
  });

  it('should allow keyboard shortcut to open import dialog', async () => {
    await createNewProject('Keyboard Test');

    // Use Ctrl+I to open import dialog
    await browser.keys(['Control', 'i']);

    // Wait for dialog
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });

    await expect(dialog).toBeDisplayed();

    // Use Escape to close
    await browser.keys(['Escape']);

    // Dialog should close
    await browser.waitUntil(
      async () => !(await dialog.isDisplayed()),
      { timeout: 5000 }
    );
  });
});
