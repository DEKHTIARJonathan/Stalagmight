import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  openDmpSelectionDialog,
  proceedToDmpSectionConfig,
  placeAllSections,
} from './helpers/app';

/**
 * DMP Import Dialog E2E Tests
 *
 * Tests the core DMP file import functionality including:
 * - Context-aware import triggering (new project vs existing project)
 * - Parsing and displaying DMP file data in Step 1 (selection) and Step 2 (config)
 * - Section selection and configuration
 * - Cancel without importing
 * - Drag-drop DMP file handling
 */

/**
 * Helper to create a project and open the import dialog via Ctrl+I.
 * With the new context-aware flow:
 * - From existing project: Opens DmpSelectionDialog (Step 1) directly with parsed DMP
 * Returns when the DMP file is loaded and sections are visible in Step 1.
 */
async function createProjectAndOpenImportDialog(page: Page): Promise<void> {
  await createProject(page, 'DMP Import Test');
  await openDmpSelectionDialog(page);

  const dialog = page.getByTestId('dmp-selection-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });
  // Version is now shown in the filename line
  await expect(dialog.getByTestId('dmp-filename')).toContainText('(v5)');
}

/**
 * Helper to proceed from Step 1 (selection) to Step 2 (config).
 */
async function proceedToStep2(page: Page): Promise<void> {
  await proceedToDmpSectionConfig(page);
}

test.describe('DMP Import Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  /**
   * Test 6.1: should parse and display DMP file data in Step 1 dialog
   *
   * Verifies the DmpSelectionDialog (Step 1) correctly displays parsed DMP data
   * including section names, shot counts, and file metadata.
   */
  test('should parse and display DMP file data in import dialog', async ({
    page,
  }) => {
    await createProjectAndOpenImportDialog(page);

    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');

    // Verify dialog has correct ARIA role
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Verify section names displayed in Step 1
    await expect(dialog.locator('text=Main Passage')).toBeVisible();
    await expect(dialog.locator('text=Side Tunnel')).toBeVisible();

    // Step 1 shows a table with checkboxes, section names, dates, and shot counts
    // Verify the section table has expected structure
    const sectionRow0 = dialog.locator('[data-testid="section-row-0"]');
    await expect(sectionRow0).toBeVisible();
    await expect(sectionRow0).toContainText('Main Passage');

    const sectionRow1 = dialog.locator('[data-testid="section-row-1"]');
    await expect(sectionRow1).toBeVisible();
    await expect(sectionRow1).toContainText('Side Tunnel');

    // Verify section checkboxes are present
    const checkbox0 = dialog.locator('[data-testid="section-checkbox-0"]');
    await expect(checkbox0).toBeVisible();
    await expect(checkbox0).toBeChecked(); // Non-empty sections are selected by default

    // Verify file metadata header (version is in filename, stats are in selection-stats)
    const filename = dialog.locator('[data-testid="dmp-filename"]');
    await expect(filename).toContainText('(v5)');

    // Selection stats show shot count, total length, and depth range
    const stats = dialog.locator('[data-testid="selection-stats"]');
    await expect(stats.locator('[data-testid="stats-shot-count"]')).toContainText('shots');
    await expect(stats.locator('[data-testid="stats-total-length"]')).toBeVisible();
    await expect(stats.locator('[data-testid="stats-depth-range"]')).toContainText('Depth:');
  });

  /**
   * Test 6.2: should proceed from Step 1 to Step 2
   *
   * Verifies the import flow proceeds correctly from Step 1 (selection)
   * to Step 2 (configuration) when Continue is clicked.
   */
  test('should proceed from Step 1 to Step 2', async ({
    page,
  }) => {
    await createProjectAndOpenImportDialog(page);

    // Step 1 should show Continue button
    const continueButton = page.locator('[data-testid="continue-button"]');
    await expect(continueButton).toBeVisible();
    await expect(continueButton).toBeEnabled();

    // Click Continue to proceed to Step 2
    await continueButton.click();

    // Step 2 dialog should appear
    const step2Dialog = page.locator('[data-testid="dmp-section-config-dialog"]');
    await expect(step2Dialog).toBeVisible({ timeout: 5000 });

    // Step 2 should show section configuration UI - look for the Placement heading
    await expect(step2Dialog.locator('h3', { hasText: 'Placement' })).toBeVisible();

    // Should have "Place section" or "Place and finish" button
    const navButton = page.locator('[data-testid="place-section-button"], [data-testid="place-and-finish-button"]');
    await expect(navButton.first()).toBeVisible();
  });

  /**
   * Test 6.3: should allow toggling section selection in Step 1
   *
   * Verifies users can select/deselect sections in Step 1 (DmpSelectionDialog)
   * using checkboxes and bulk selection buttons.
   */
  test('should allow toggling section selection in Step 1', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Find section checkboxes
    const checkbox0 = page.locator('[data-testid="section-checkbox-0"]');
    const checkbox1 = page.locator('[data-testid="section-checkbox-1"]');
    await expect(checkbox0).toBeVisible();
    await expect(checkbox1).toBeVisible();

    // Both non-empty sections should be selected by default
    await expect(checkbox0).toBeChecked();
    await expect(checkbox1).toBeChecked();

    // Test deselecting a section
    await checkbox0.click();
    await expect(checkbox0).not.toBeChecked();
    await expect(checkbox1).toBeChecked(); // Other section still selected

    // Test reselecting the section
    await checkbox0.click();
    await expect(checkbox0).toBeChecked();

    // Test Select None button
    const selectNoneBtn = page.locator('[data-testid="select-none-button"]');
    await selectNoneBtn.click();
    await expect(checkbox0).not.toBeChecked();
    await expect(checkbox1).not.toBeChecked();

    // Test Select All button
    const selectAllBtn = page.locator('[data-testid="select-all-button"]');
    await selectAllBtn.click();
    await expect(checkbox0).toBeChecked();
    await expect(checkbox1).toBeChecked();
  });

  /**
   * Test 6.4: should handle multi-section DMP files in Step 1
   *
   * Verifies the Step 1 dialog handles DMP files with multiple sections,
   * showing all sections with checkboxes for selection.
   */
  test('should handle multi-section DMP files', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Verify multiple sections are listed (mock returns 6 sections)
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(dialog.locator('text=Main Passage')).toBeVisible();
    await expect(dialog.locator('text=Side Tunnel')).toBeVisible();
    await expect(dialog.locator('text=Mixed LRUD Section')).toBeVisible();
    await expect(dialog.locator('text=Undefined LRUD Section')).toBeVisible();
    await expect(dialog.locator('text=Empty Section')).toBeVisible();
    await expect(dialog.locator('text=Validation Test Section')).toBeVisible();

    // Step 1 shows section rows with checkboxes - no expand buttons in Step 1
    const sectionRow0 = dialog.locator('[data-testid="section-row-0"]');
    const sectionRow1 = dialog.locator('[data-testid="section-row-1"]');
    await expect(sectionRow0).toBeVisible();
    await expect(sectionRow1).toBeVisible();

    // Empty section should be displayed but with (empty) indicator and disabled checkbox
    const emptyRow = dialog.locator('[data-testid="section-row-4"]');
    await expect(emptyRow).toContainText('(empty)');
    const emptyCheckbox = dialog.locator('[data-testid="section-checkbox-4"]');
    await expect(emptyCheckbox).toBeDisabled();

    // Test section selection checkboxes
    // Click "Select None" to deselect all sections
    await dialog.locator('[data-testid="select-none-button"]').click();

    // The selection count should show 0 selected
    await expect(dialog.locator('text=/0 of \\d+ sections selected/')).toBeVisible();

    // Click "Select All" to select all non-empty sections
    await dialog.locator('[data-testid="select-all-button"]').click();

    // All non-empty sections should be selected
    await expect(dialog.locator('text=/5 of 5 sections selected/')).toBeVisible();

    // Select only specific sections
    await dialog.locator('[data-testid="select-none-button"]').click();

    // Select Main Passage and Side Tunnel only
    await dialog.locator('[data-testid="section-checkbox-0"]').click();
    await dialog.locator('[data-testid="section-checkbox-1"]').click();

    // Selection count should show 2 selected
    await expect(dialog.locator('text=/2 of 5 sections selected/')).toBeVisible();
  });

  /**
   * Test 6.5: should close Step 1 dialog on Cancel without importing
   *
   * Verifies Cancel button closes dialog without making changes.
   */
  test('should close dialog on Cancel without importing', async ({ page }) => {
    // Create a project first
    await createProject(page, 'Cancel Test Project');

    // Open import dialog with Ctrl+I
    // New flow opens Step 1 (DmpSelectionDialog) directly with parsed DMP
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]');
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(dialog).toBeVisible();

    // Dialog should show the parsed DMP sections
    await expect(page.locator('text=Main Passage')).toBeVisible();

    // Click Cancel button
    await dialog.locator('[data-testid="cancel-button"]').click();

    // Dialog should close
    await expect(dialog).not.toBeVisible({ timeout: 3000 });

    // Re-open - with hash-based duplicate detection, re-import goes directly
    // to DmpSelectionDialog (no session-based path tracking)
    await page.keyboard.press('Control+i');

    // Should go directly to the selection dialog again
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]');
    const dialogAfter = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(dialogAfter).toBeVisible();

    // Dialog should show sections (file is parsed each time)
    await expect(page.locator('text=Main Passage')).toBeVisible();
  });

  /**
   * Test 6.6: should show section list in Step 2
   *
   * Verifies Step 2 shows the section list panel with configured sections.
   */
  test('should show section list in Step 2', async ({
    page,
  }) => {
    await createProjectAndOpenImportDialog(page);

    // Proceed to Step 2
    await proceedToStep2(page);

    const dialog = page.locator('[data-testid="dmp-section-config-dialog"]');
    await expect(dialog).toBeVisible();

    // Verify section list panel is visible
    const sectionListPanel = page.locator('[data-testid="section-list-panel"]');
    await expect(sectionListPanel).toBeVisible();

    // Should show the first section as active
    const sectionItem0 = page.locator('[data-testid="section-list-item-0"]');
    await expect(sectionItem0).toBeVisible();
    await expect(sectionItem0).toContainText('Main Passage');
  });

  /**
   * Test 6.7: Re-importing same file goes directly to selection dialog
   *
   * Verifies that re-importing the same DMP file no longer shows a
   * session-based duplicate warning dialog. Hash-based duplicate detection
   * (inline warning banner in DmpSelectionDialog) replaces the old
   * session-based path tracking.
   */
  test('should allow re-importing same file without session-based duplicate warning', async ({ page }) => {
    // Create a project first
    await createProject(page, 'Duplicate Import Test');

    // First import
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]');
    await expect(page.locator('[data-testid="dmp-selection-dialog"]')).toBeVisible();
    await expect(page.locator('text=Main Passage')).toBeVisible();

    // Cancel the first import
    await page.locator('[data-testid="cancel-button"]').click();
    await expect(page.locator('[data-testid="dmp-selection-dialog"]')).not.toBeVisible({ timeout: 3000 });

    // Try to import the same file again - should go directly to selection dialog
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]');
    await expect(page.locator('[data-testid="dmp-selection-dialog"]')).toBeVisible();
    await expect(page.locator('text=Main Passage')).toBeVisible();
  });

  /**
   * Test 6.8: Context-aware import - from home screen creates new project
   *
   * Verifies that Ctrl+I from home screen (no project) shows the
   * NewProjectForImportDialog before proceeding to import.
   */
  test('should prompt for project name when importing from home screen', async ({
    page,
  }) => {
    // We're on the home screen (GlobalView) with no project open
    await expect(page.getByTestId('global-view')).toBeVisible();

    // Start import from GlobalView
    const importButton = page
      .locator('[data-testid="global-import-dmp-button"], [data-testid="empty-state-import-dmp"]')
      .first();
    await expect(importButton).toBeVisible();
    await importButton.click();

    // Should show NewProjectForImportDialog
    await page.waitForSelector('[data-testid="new-project-for-import-dialog"]', { timeout: 5000 });
    const projectDialog = page.locator('[data-testid="new-project-for-import-dialog"]');
    await expect(projectDialog).toBeVisible();

    // Should show DMP file info
    await expect(projectDialog.locator('text=Importing from DMP file')).toBeVisible();

    // Project name field should be pre-filled with filename
    const nameInput = projectDialog.locator('[data-testid="project-name-input"]');
    await expect(nameInput).toBeVisible();
    // Mock returns /mock/test-survey.dmp, so default name should be 'test-survey'
    await expect(nameInput).toHaveValue('test-survey');

    // Fill in project name and create
    await nameInput.fill('My Import Test Project');
    await projectDialog.locator('[data-testid="create-and-continue-button"]').click();

    // Should transition to Step 1 (DmpSelectionDialog)
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]', { timeout: 5000 });
    const selectionDialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(selectionDialog).toBeVisible();

    // Sections should be visible
    await expect(page.locator('text=Main Passage')).toBeVisible();
  });
});

test.describe('DMP Import Dialog - Step 2 Error Blocking', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  /**
   * Test: Step 2 shows error count badges for sections with invalid data
   */
  test('should show error count badges in section list', async ({ page }) => {
    // Create project and open import dialog
    await createProject(page, 'Error Blocking Test');
    await openDmpSelectionDialog(page);

    // Select only the Validation Test Section which has errors
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-5"]').click();

    // Proceed to Step 2
    const continueButton = page.locator('[data-testid="continue-button"]');
    await continueButton.click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', { timeout: 5000 });

    // Check that the section has error indicator and badge
    const sectionStatus = page.locator('[data-testid="section-status-0"]');
    await expect(sectionStatus).toBeVisible();
    await expect(sectionStatus).toHaveAttribute('data-status', 'errors');
    // The section has azimuth error (400 degrees out of range)
    // Status icon should show error
    await expect(sectionStatus).toHaveClass(/text-error/);
    const errorBadge = page.locator('[data-testid="section-error-count-0"]');
    await expect(errorBadge).toBeVisible();
    await expect(errorBadge).toHaveText('1');
  });

  /**
   * Test: Import button disabled when section has invalid shot data
   */
  test('should disable Import button when section has errors', async ({ page }) => {
    await createProject(page, 'Error Blocking Test 2');
    await openDmpSelectionDialog(page);

    // Select only the Validation Test Section which has an invalid azimuth
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-5"]').click();

    // Proceed to Step 2
    await page.locator('[data-testid="continue-button"]').click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', { timeout: 5000 });

    // Place button should be disabled due to validation errors
    const placeButton = page.locator('[data-testid="place-section-button"], [data-testid="place-and-finish-button"]');
    await expect(placeButton.first()).toBeDisabled();
  });

  /**
   * Test: Navigation via left panel works with sections that have errors
   */
  test('should allow navigation between sections via left panel', async ({ page }) => {
    await createProject(page, 'Navigation With Errors Test');
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]');

    // Select Main Passage (no errors) and Validation Test Section (has errors)
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click();
    await page.locator('[data-testid="section-checkbox-5"]').click();

    // Proceed to Step 2
    await page.locator('[data-testid="continue-button"]').click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', { timeout: 5000 });

    // Should start on first section (Main Passage)
    await expect(page.getByRole('heading', { name: /Section: Main Passage/ })).toBeVisible();

    // Navigate to second section using left panel
    await page.locator('[data-testid="section-list-item-1"]').click();

    // Now we should be on the second section
    await expect(page.getByRole('heading', { name: /Section: Validation Test Section/ })).toBeVisible();

    // Navigate back to first section using left panel
    await page.locator('[data-testid="section-list-item-0"]').click();

    // Back to first section
    await expect(page.getByRole('heading', { name: /Section: Main Passage/ })).toBeVisible();
  });

  /**
   * Test: Error summary shows in left panel when sections have errors
   */
  test('should show error summary in left panel', async ({ page }) => {
    await createProject(page, 'Error Summary Test');
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]');

    // Select Main Passage (no errors) and Validation Test Section (has errors)
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click();
    await page.locator('[data-testid="section-checkbox-5"]').click();

    // Proceed to Step 2
    await page.locator('[data-testid="continue-button"]').click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', { timeout: 5000 });

    // Navigate to the section with errors
    await page.locator('[data-testid="section-list-item-1"]').click();

    // Error summary should appear in left panel
    const errorSummary = page.locator('[data-testid="error-summary"]');
    await expect(errorSummary).toBeVisible();
    await expect(errorSummary).toContainText('section');
    await expect(errorSummary).toContainText('error');
  });

  /**
   * Test: Place button is enabled for section without errors
   *
   * This test verifies that sections without validation errors can be placed.
   */
  test('should enable Place button for section without errors', async ({ page }) => {
    await createProject(page, 'Fix Error Test');
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]');

    // Select only Main Passage (no errors)
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click();

    // Proceed to Step 2
    await page.locator('[data-testid="continue-button"]').click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', { timeout: 5000 });

    // With only Main Passage selected (no errors), the Place button should be enabled
    // Since it's the only section and it's not placed yet, it shows "Place and finish"
    const placeButton = page.locator('[data-testid="place-and-finish-button"]');
    await expect(placeButton).toBeEnabled();
  });

  /**
   * Test: Section status icon shows error state vs not placed state
   */
  test('should show error icon in section list for invalid data', async ({ page }) => {
    await createProject(page, 'Error Icon Test');
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[data-testid="dmp-selection-dialog"]');

    // Select both sections - one with errors and one without
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click(); // Main Passage - ok
    await page.locator('[data-testid="section-checkbox-5"]').click(); // Validation Test - errors

    // Proceed to Step 2
    await page.locator('[data-testid="continue-button"]').click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', { timeout: 5000 });

    // First section (Main Passage) is NOT placed yet - no warnings/errors, shows default icon
    const status0 = page.locator('[data-testid="section-status-0"]');
    await expect(status0).toHaveAttribute('data-status', 'not_placed');
    await expect(status0).toHaveClass(/text-text-secondary/);

    // Second section (Validation Test) should show error icon
    const status1 = page.locator('[data-testid="section-status-1"]');
    await expect(status1).toHaveAttribute('data-status', 'errors');
    await expect(status1).toHaveClass(/text-error/);
  });
});

test.describe('DMP Import Dialog - Hash Tracking', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  /**
   * Test: duplicate-hash-warning banner NOT visible on first import
   *
   * When check_duplicate_import returns false (default), the warning
   * banner should not appear in the DmpSelectionDialog.
   */
  test('should not show duplicate-hash-warning banner on first import', async ({ page }) => {
    await createProject(page, 'Hash Test No Banner');
    await openDmpSelectionDialog(page);

    // Wait for hash computation to settle before asserting banner absence.
    // The Continue button being enabled indicates hash check has completed
    // and the dialog is fully ready (avoids false positive from checking too early).
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(dialog.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="continue-button"]')).toBeEnabled({ timeout: 5000 });

    // The duplicate-hash-warning banner should NOT be visible
    // since check_duplicate_import returns false by default
    await expect(page.locator('[data-testid="duplicate-hash-warning"]')).not.toBeVisible();
  });

  /**
   * Test: duplicate-hash-warning banner IS visible when check returns true
   *
   * When check_duplicate_import returns true, the warning banner
   * should appear in the DmpSelectionDialog.
   */
  test('should show duplicate-hash-warning banner when file was previously imported', async ({ page }) => {
    // Set mock to return true for check_duplicate_import
    await page.evaluate(() => {
      const setter = (window as unknown as Record<string, unknown>).__MOCK_SET_CHECK_DUPLICATE_RESULT__ as
        | ((result: boolean) => void)
        | undefined;
      if (setter) setter(true);
    });

    await createProject(page, 'Hash Test With Banner');
    await openDmpSelectionDialog(page);

    // Wait for sections to load (hash check runs on mount)
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(dialog.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });

    // The duplicate-hash-warning banner should be visible
    const warning = page.locator('[data-testid="duplicate-hash-warning"]');
    await expect(warning).toBeVisible({ timeout: 5000 });
    await expect(warning).toContainText('File may have been imported before');
  });

  /**
   * Test: file hash passed to import_sections after successful import
   *
   * After a successful import (no errors), the file hash should be
   * included in the import_sections call for backend tracking.
   */
  test('should pass file hash to import_sections after successful import', async ({ page }) => {
    await createProject(page, 'Hash Track Success');

    // Reset tracking call counter
    await page.evaluate(() => {
      const reset = (window as unknown as Record<string, unknown>).__MOCK_RESET_TRACK_IMPORTED_FILE_CALLS__ as
        | (() => void)
        | undefined;
      if (reset) reset();
    });

    // Capture import_sections arguments for fileHash verification
    await page.evaluate(() => {
      const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const originalInvoke = tauri.invoke;
      (window as unknown as { __CAPTURED_IMPORT_SECTIONS_ARGS__?: Array<Record<string, unknown>> }).__CAPTURED_IMPORT_SECTIONS_ARGS__ = [];
      tauri.invoke = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'import_sections') {
          (window as unknown as { __CAPTURED_IMPORT_SECTIONS_ARGS__?: Array<Record<string, unknown>> }).__CAPTURED_IMPORT_SECTIONS_ARGS__?.push(args ?? {});
        }
        return originalInvoke(cmd, args);
      };
    });

    // Open import dialog and select only Main Passage (no errors)
    await openDmpSelectionDialog(page);
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(dialog.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });

    // Select only Main Passage
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click();

    // Proceed to Step 2
    await proceedToDmpSectionConfig(page);

    // Place the section (single section = Place and finish)
    await placeAllSections(page);

    // Wait for import_sections call and verify fileHash passed for tracking
    await expect.poll(async () => {
      return page.evaluate(() => {
        const calls = (window as unknown as { __CAPTURED_IMPORT_SECTIONS_ARGS__?: Array<Record<string, unknown>> }).__CAPTURED_IMPORT_SECTIONS_ARGS__ ?? [];
        return calls.length;
      });
    }).toBeGreaterThan(0);

    const lastArgs = await page.evaluate(() => {
      const calls = (window as unknown as { __CAPTURED_IMPORT_SECTIONS_ARGS__?: Array<Record<string, unknown>> }).__CAPTURED_IMPORT_SECTIONS_ARGS__ ?? [];
      return calls[calls.length - 1] ?? null;
    });
    expect(lastArgs).not.toBeNull();
    expect((lastArgs as { fileHash?: string | null }).fileHash ?? '').toContain('mock_hash_');
  });

  /**
   * Test: import_sections NOT called when import has errors
   *
   * When importing a section with validation errors, the import cannot proceed,
   * so import_sections should not be called.
   */
  test('should not call track_imported_file when import has errors', async ({ page }) => {
    await createProject(page, 'Hash Track Error');

    // Reset tracking call counter
    await page.evaluate(() => {
      const reset = (window as unknown as Record<string, unknown>).__MOCK_RESET_TRACK_IMPORTED_FILE_CALLS__ as
        | (() => void)
        | undefined;
      if (reset) reset();
    });

    // Capture import_sections arguments to confirm no import occurs
    await page.evaluate(() => {
      const tauri = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const originalInvoke = tauri.invoke;
      (window as unknown as { __CAPTURED_IMPORT_SECTIONS_ARGS__?: Array<Record<string, unknown>> }).__CAPTURED_IMPORT_SECTIONS_ARGS__ = [];
      tauri.invoke = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'import_sections') {
          (window as unknown as { __CAPTURED_IMPORT_SECTIONS_ARGS__?: Array<Record<string, unknown>> }).__CAPTURED_IMPORT_SECTIONS_ARGS__?.push(args ?? {});
        }
        return originalInvoke(cmd, args);
      };
    });

    // Open import dialog and select only the Validation Test Section (has errors)
    await openDmpSelectionDialog(page);
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(dialog.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });

    // Select only Validation Test Section (index 5)
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-5"]').click();

    // Proceed to Step 2
    await proceedToDmpSectionConfig(page);

    // The Place button should be disabled because the section has errors
    // (azimuth 400 is out of range), so we can't actually place it.
    // Verify the button is disabled.
    const placeButton = page.locator('[data-testid="place-section-button"], [data-testid="place-and-finish-button"]');
    await expect(placeButton.first()).toBeDisabled();

    // Verify import_sections was NOT called (can't even import)
    const calls = await page.evaluate(() => {
      return (window as unknown as { __CAPTURED_IMPORT_SECTIONS_ARGS__?: Array<Record<string, unknown>> }).__CAPTURED_IMPORT_SECTIONS_ARGS__ ?? [];
    });
    expect(calls.length).toBe(0);
  });
});
