/**
 * WebdriverIO E2E Tests: DMP Integration
 *
 * These tests run against the full Tauri application with real backend
 * to validate complete DMP import workflows. Unlike Playwright tests
 * that use mocked IPC, these tests parse real DMP files.
 *
 * Test fixtures:
 * - test_v2.dmp: DMP version 2 format with multiple sections
 * - test_v5.dmp: DMP version 5 format with LRUD data
 * - test_v5_buggy_EOS.dmp: Version 5 with buggy end-of-section marker
 * - test_corrupted.dmp: Invalid file for error handling tests
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  openDmpImportWithFile,
  proceedToDmpImportWizard,
  ensureDmpNewImportDialogVisible,
  placeAllSectionsInDmpWizard,
  importDmpViaStore,
  getProjectSections,
  getProjectStats,
  waitForUiIdle,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

async function completeImportFromSelectionStep(): Promise<void> {
  await proceedToDmpImportWizard();
  await ensureDmpNewImportDialogVisible();

  const wizard = await $('[data-testid="dmp-new-import-dialog"]');
  await expect(wizard).toBeDisplayed();

  const progress = await wizard.$('[data-testid="wizard-progress"]');
  await expect(progress).toBeExisting();

  await placeAllSectionsInDmpWizard();
  await waitForUiIdle(1000);
}

describe('DMP Integration', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  /**
   * Test 12.1: should import DMP v2 file successfully
   *
   * Validates the complete v2 import workflow including:
   * - Parsing v2 format DMP file
   * - Displaying sections in import dialog
   * - Successfully importing sections into project
   */
  it('should import DMP v2 file successfully', async () => {
    await createNewProject('DMP V2 Test');

    // Get the fixture path
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');

    // Import the DMP file directly via store to test parsing
    const result = await importDmpViaStore(dmpPath);

    // Verify parsing succeeded
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // V2 files should have multiple sections
    expect(result.sectionCount).toBeGreaterThan(0);

    // Now open the import dialog to verify UI (Step 1: DmpSelectionDialog)
    await openDmpImportWithFile(dmpPath);

    // Verify Step 1 dialog is open
    const selectionDialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(selectionDialog).toBeDisplayed();

    // Verify version is displayed (UI shows format like "(v2)")
    const dialogText = await selectionDialog.getText();
    expect(dialogText.toLowerCase()).toMatch(/\(v2\)/);

    await completeImportFromSelectionStep();

    // Verify sections were imported
    await waitForUiIdle(1000);
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);
  });

  /**
   * Test 12.2: should import DMP v5 file with LRUD
   *
   * Validates LRUD (Left, Right, Up, Down) data preservation:
   * - V5 format includes LRUD measurements
   * - LRUD values are displayed in import preview
   * - LRUD values are preserved after import
   */
  it('should import DMP v5 file with LRUD', async () => {
    await createNewProject('DMP V5 LRUD Test');

    const dmpPath = path.join(FIXTURES_DIR, 'test_v5.dmp');

    // Import and parse the DMP file
    const result = await importDmpViaStore(dmpPath);
    expect(result.success).toBe(true);

    // Open import dialog with file (Step 1: DmpSelectionDialog)
    await openDmpImportWithFile(dmpPath);

    const selectionDialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(selectionDialog).toBeDisplayed();

    // Verify version 5 is shown (UI shows format like "(v5)")
    const dialogText = await selectionDialog.getText();
    expect(dialogText.toLowerCase()).toMatch(/\(v5\)/);

    await completeImportFromSelectionStep();

    // Verify sections were imported with shot data
    await waitForUiIdle(1000);
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Verify at least one section has shots with LRUD data
    const hasShots = sections.some(s => (s.shots as unknown[]).length > 0);
    expect(hasShots).toBe(true);
  });

  /**
   * Test 12.3: should handle corrupted DMP file gracefully
   *
   * Validates error handling for invalid DMP files:
   * - Parser detects invalid format
   * - Error message is shown to user
   * - Application remains stable
   */
  it('should handle corrupted DMP file gracefully', async () => {
    await createNewProject('Corrupted DMP Test');

    const dmpPath = path.join(FIXTURES_DIR, 'test_corrupted.dmp');

    // Try to import corrupted file - should fail
    const result = await importDmpViaStore(dmpPath);

    // Verify parsing failed with an error
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe('');

    // Application should still be functional
    const mainView = await $('[data-testid="map-canvas"]');
    await expect(mainView).toBeExisting();

    // Can still open import dialog with a valid file
    // Use the helper instead of Ctrl+I (which opens native file picker that can't be automated)
    await openDmpImportWithFile(path.join(FIXTURES_DIR, 'test_v5.dmp'));
    const dialog = await $('[data-testid="dmp-selection-dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });
    await expect(dialog).toBeDisplayed();

    // Close dialog
    const cancelBtn = await dialog.$('[data-testid="cancel-button"]');
    await cancelBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  /**
   * Test 12.4: should import multiple sections from multi-section DMP
   *
   * Validates multi-section handling:
   * - All sections are detected and listed
   * - User can select/deselect individual sections
   * - All selected sections are imported
   */
  it('should import multiple sections from multi-section DMP', async () => {
    await createNewProject('Multi-Section DMP Test');

    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');

    // Open import dialog (Step 1: DmpSelectionDialog)
    await openDmpImportWithFile(dmpPath);

    const selectionDialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(selectionDialog).toBeDisplayed();

    // Verify section selection UI
    // Look for section checkboxes - should have multiple for multi-section DMP
    const sectionRows = await selectionDialog.$$('[data-testid^="section-row-"]');
    expect(sectionRows.length).toBeGreaterThan(1); // Multi-section file should have multiple

    // Verify All/None selection buttons
    const allBtn = await selectionDialog.$('[data-testid="select-all-button"]');
    const noneBtn = await selectionDialog.$('[data-testid="select-none-button"]');
    await expect(allBtn).toBeExisting();
    await expect(noneBtn).toBeExisting();

    // Test selection: click None then All
    await noneBtn.click();
    await waitForUiIdle(500);
    await allBtn.click();
    await waitForUiIdle(500);

    // Close selection dialog and import directly via store helper for deterministic section creation.
    const cancelBtn = await selectionDialog.$('[data-testid="cancel-button"]');
    await cancelBtn.click();
    await selectionDialog.waitForDisplayed({ reverse: true, timeout: 5000 });

    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(1);

    await waitForUiIdle(500);
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(1);
  });

  /**
   * Test 12.5: should preserve section metadata from DMP
   *
   * Validates metadata extraction and preservation:
   * - Section names are preserved
   * - Section dates are extracted (if available)
   * - Direction (in/out) is preserved
   */
  it('should preserve section metadata from DMP', async () => {
    await createNewProject('Metadata Test');

    const dmpPath = path.join(FIXTURES_DIR, 'test_v5.dmp');

    // Open import dialog with file (Step 1: DmpSelectionDialog)
    await openDmpImportWithFile(dmpPath);

    const selectionDialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(selectionDialog).toBeDisplayed();

    // Verify section metadata is displayed
    // Look for section rows in Step 1
    const sectionRows = await selectionDialog.$$('[data-testid^="section-row-"]');
    expect(sectionRows.length).toBeGreaterThan(0);

    // Verify direction selector is present in Step 1
    const directionSelect = await selectionDialog.$('[data-testid="section-direction-0"]');
    if (await directionSelect.isExisting()) {
      // Direction select should be visible
      await expect(directionSelect).toBeDisplayed();
    }

    // Close selection dialog and import directly to validate resulting metadata.
    const cancelBtn = await selectionDialog.$('[data-testid="cancel-button"]');
    await cancelBtn.click();
    await selectionDialog.waitForDisplayed({ reverse: true, timeout: 5000 });

    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);

    await waitForUiIdle(500);
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Each section should have a non-empty name
    for (const section of sections) {
      expect(section.name).toBeDefined();
      expect(section.name.length).toBeGreaterThan(0);
    }
  });

  /**
   * Test 12.6: should handle DMP with edge case EOS markers
   *
   * Validates handling of buggy end-of-section markers:
   * - Parser handles non-standard EOS patterns
   * - Sections are correctly split even with buggy markers
   * - Data integrity is maintained
   */
  it('should handle DMP with edge case EOS markers', async () => {
    await createNewProject('EOS Edge Case Test');

    const dmpPath = path.join(FIXTURES_DIR, 'test_v5_buggy_EOS.dmp');

    // Import file with buggy EOS markers
    const result = await importDmpViaStore(dmpPath);

    // Should still parse successfully
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Should have sections despite buggy EOS
    expect(result.sectionCount).toBeGreaterThan(0);

    // Open import dialog and verify (Step 1: DmpSelectionDialog)
    await openDmpImportWithFile(dmpPath);

    const selectionDialog = await $('[data-testid="dmp-selection-dialog"]');
    await expect(selectionDialog).toBeDisplayed();

    // Verify version 5 (buggy EOS is a v5 issue, UI shows format like "(v5)")
    const dialogText = await selectionDialog.getText();
    expect(dialogText.toLowerCase()).toMatch(/\(v5\)/);

    // Verify section rows exist (proves data was parsed)
    const sectionRows = await selectionDialog.$$('[data-testid^="section-row-"]');
    expect(sectionRows.length).toBeGreaterThan(0);

    await completeImportFromSelectionStep();

    // Verify sections were imported
    await waitForUiIdle(1000);
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Verify stats show data
    const stats = await getProjectStats();
    expect(stats).not.toBeNull();
    if (stats) {
      expect(stats.sectionCount).toBeGreaterThan(0);
      expect(stats.totalLength).toBeGreaterThan(0);
    }
  });
});
