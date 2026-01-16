import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  openDmpImportDialog,
} from '../helpers/app';

describe('DMP Import Dialog', () => {
  beforeEach(async () => {
    // Wait for the app to be fully loaded
    await waitForAppReady();
    // Reset any leftover state from previous tests
    await resetAppState();
  });

  it('should create a new project and open DMP import dialog', async () => {
    // Create a new project
    await createNewProject('Test Project');

    // Open DMP Import Dialog with Ctrl+I
    await openDmpImportDialog();

    // Verify DMP Import Dialog is displayed using data-testid
    const importDialog = await $('[data-testid="import-dmp-dialog"]');
    await expect(importDialog).toBeDisplayed();

    // Look for "Import DMP" text in dialog title or content
    const dialogContent = await importDialog.getText();
    expect(dialogContent.toLowerCase()).toContain('dmp');

    // Close the dialog using Cancel button (Escape not implemented)
    const cancelBtn = await importDialog.$('button*=Cancel');
    await cancelBtn.click();

    // Verify dialog closed
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should display file path input field', async () => {
    await createNewProject('DMP Path Test');
    await openDmpImportDialog();

    // Find file path input (DMP Import Dialog has file path field)
    const importDialog = await $('[data-testid="import-dmp-dialog"]');
    const filePathInput = await importDialog.$('input[type="text"]');
    await expect(filePathInput).toBeExisting();

    // Close the dialog using Cancel button
    const cancelBtn = await importDialog.$('button*=Cancel');
    await cancelBtn.click();
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should allow keyboard shortcut to open DMP import dialog', async () => {
    await createNewProject('Keyboard Test');

    // Use Ctrl+I to open DMP import dialog
    await browser.keys(['Control', 'i']);

    // Wait for dialog using specific data-testid
    const dialog = await $('[data-testid="import-dmp-dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });

    await expect(dialog).toBeDisplayed();

    // Close using Cancel button
    const cancelBtn = await dialog.$('button*=Cancel');
    await cancelBtn.click();

    // Dialog should close
    await dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });
});
