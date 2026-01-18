import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  openDmpImportDialog,
} from '../helpers/app';

/**
 * DMP Import Dialog E2E Tests (WebdriverIO)
 *
 * Tests the two-step DMP import flow:
 * - Step 1: DmpSelectionDialog - section selection with metadata
 * - Step 2: DmpSectionConfigDialog - per-section configuration and placement
 *
 * Note: These tests run against the full Tauri application.
 * For faster iteration, use the Playwright tests in e2e-playwright/.
 */
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
    // New flow: Opens file picker, parses DMP, then opens Step 1 (DmpSelectionDialog)
    await openDmpImportDialog();

    // Verify Step 1 dialog (DmpSelectionDialog) is displayed
    const importDialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(importDialog).toBeDisplayed();

    // Look for section-related content in dialog
    const dialogContent = await importDialog.getText();
    expect(dialogContent.toLowerCase()).toContain('section');

    // Close the dialog using Cancel button
    const cancelBtn = await importDialog.$('[data-testid="cancel-button"], button*=Cancel');
    await cancelBtn.click();

    // Verify dialog closed
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should display section list in Step 1', async () => {
    await createNewProject('DMP Section Test');
    await openDmpImportDialog();

    // Find Step 1 dialog (DmpSelectionDialog)
    const importDialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(importDialog).toBeDisplayed();

    // Step 1 shows section rows with checkboxes
    const sectionRow = await importDialog.$('[data-testid="section-row-0"]');
    await expect(sectionRow).toBeExisting();

    // Close the dialog using Cancel button
    const cancelBtn = await importDialog.$('[data-testid="cancel-button"], button*=Cancel');
    await cancelBtn.click();
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should allow keyboard shortcut to open DMP import dialog', async () => {
    await createNewProject('Keyboard Test');

    // Use Ctrl+I to open DMP import dialog
    await browser.keys(['Control', 'i']);

    // Wait for Step 1 dialog (DmpSelectionDialog) using data-testid
    const dialog = await $('[data-testid="dmp-selection-dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });

    await expect(dialog).toBeDisplayed();

    // Close using Cancel button
    const cancelBtn = await dialog.$('[data-testid="cancel-button"], button*=Cancel');
    await cancelBtn.click();

    // Dialog should close
    await dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should proceed from Step 1 to Step 2', async () => {
    await createNewProject('Step Navigation Test');
    await openDmpImportDialog();

    // Step 1 dialog should be visible
    const step1Dialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(step1Dialog).toBeDisplayed();

    // Click Continue to proceed to Step 2
    const continueBtn = await step1Dialog.$('[data-testid="continue-button"]');
    await continueBtn.click();

    // Wait for Step 2 dialog (DmpSectionConfigDialog)
    const step2Dialog = await $('[data-testid="dmp-section-config-dialog"]');
    await step2Dialog.waitForDisplayed({ timeout: 5000 });
    await expect(step2Dialog).toBeDisplayed();

    // Step 2 should show Placement options
    const placementHeading = await step2Dialog.$('h3*=Placement');
    await expect(placementHeading).toBeExisting();

    // Close the dialog
    const cancelBtn = await step2Dialog.$('[data-testid="cancel-button"], button*=Cancel');
    await cancelBtn.click();
    await step2Dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });
});
