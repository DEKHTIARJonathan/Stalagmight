import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  openDmpImportDialog,
  proceedToDmpImportWizard,
  ensureDmpNewImportDialogVisible,
} from '../helpers/app';

/**
 * DMP Import Dialog E2E Tests (WebdriverIO)
 *
 * Tests the two-step DMP import flow:
 * - Step 1: DmpSelectionDialog - section selection with metadata
 * - Step 2: Zero-datum selection (optional) + DmpNewImportDialog placement wizard
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
    const cancelBtn = await importDialog.$('[data-testid="cancel-button"]');
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
    const cancelBtn = await importDialog.$('[data-testid="cancel-button"]');
    await cancelBtn.click();
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should open DMP import dialog via helper (replaces Ctrl+I which opens native picker)', async () => {
    await createNewProject('Keyboard Test');

    // Note: Ctrl+I opens native file picker which can't be automated in E2E tests.
    // We use the helper instead which parses a test fixture and opens the dialog.
    await openDmpImportDialog();

    // Wait for Step 1 dialog (DmpSelectionDialog) using data-testid
    const dialog = await $('[data-testid="dmp-selection-dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });

    await expect(dialog).toBeDisplayed();

    // Close using Cancel button
    const cancelBtn = await dialog.$('[data-testid="cancel-button"]');
    await cancelBtn.click();

    // Dialog should close
    await dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should proceed from Step 1 to the import wizard', async () => {
    await createNewProject('Step Navigation Test');
    await openDmpImportDialog();

    // Step 1 dialog should be visible
    const step1Dialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(step1Dialog).toBeDisplayed();

    // Continue through optional zero-datum step into the wizard
    await proceedToDmpImportWizard();
    await ensureDmpNewImportDialogVisible();

    const wizard = await $('[data-testid="dmp-new-import-dialog"]');
    await expect(wizard).toBeDisplayed();

    // Wizard should expose progress text
    const progress = await wizard.$('[data-testid="wizard-progress"]');
    await expect(progress).toBeExisting();

    // Close the dialog - clicking Cancel shows a confirmation dialog
    const cancelBtn = await wizard.$('[data-testid="cancel-button"]');
    await cancelBtn.click();

    // Confirm dialog only appears when placements/changes exist in the wizard.
    const confirmCancelDialog = await $('[data-testid="cancel-confirm-dialog"]');
    const hasConfirmDialog = await confirmCancelDialog
      .waitForDisplayed({ timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (hasConfirmDialog) {
      const confirmCancelBtn = await confirmCancelDialog.$('[data-testid="confirm-cancel-button"]');
      await confirmCancelBtn.click();
    }

    await wizard.waitForDisplayed({ reverse: true, timeout: 5000 });
  });
});
