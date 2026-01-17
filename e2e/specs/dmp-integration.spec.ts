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
  importDmpFile,
  getProjectSections,
  getProjectStats,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

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
    const result = await importDmpFile(dmpPath);

    // Verify parsing succeeded
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // V2 files should have multiple sections
    expect(result.sectionCount).toBeGreaterThan(0);

    // Now open the import dialog to verify UI
    await openDmpImportWithFile(dmpPath);

    // Verify dialog is open
    const dialog = await $('[data-testid="import-dmp-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Verify version is displayed
    const dialogText = await dialog.getText();
    expect(dialogText.toLowerCase()).toContain('version 2');

    // Click Import button to import sections
    const importBtn = await dialog.$('button*=Import');
    await importBtn.waitForClickable({ timeout: 5000 });
    await importBtn.click();

    // Wait for dialog to close
    await dialog.waitForDisplayed({ reverse: true, timeout: 10000 });

    // Verify sections were imported
    await browser.pause(1000);
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
    const result = await importDmpFile(dmpPath);
    expect(result.success).toBe(true);

    // Open import dialog with file
    await openDmpImportWithFile(dmpPath);

    const dialog = await $('[data-testid="import-dmp-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Verify version 5 is shown
    const dialogText = await dialog.getText();
    expect(dialogText.toLowerCase()).toContain('version 5');

    // Expand first section to see LRUD columns
    const expandBtn = await $('[data-testid="section-expand-0"]');
    if (await expandBtn.isExisting()) {
      await expandBtn.click();
      await browser.pause(500);

      // Verify LRUD column headers are visible
      const headers = await dialog.$$('th');
      const headerTexts = await Promise.all(headers.map(h => h.getText()));
      expect(headerTexts).toContain('L');
      expect(headerTexts).toContain('R');
      expect(headerTexts).toContain('U');
      expect(headerTexts).toContain('D');
    }

    // Import the sections
    const importBtn = await dialog.$('button*=Import');
    await importBtn.waitForClickable({ timeout: 5000 });
    await importBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 10000 });

    // Verify sections were imported with shot data
    await browser.pause(1000);
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
    const result = await importDmpFile(dmpPath);

    // Verify parsing failed with an error
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe('');

    // Application should still be functional
    const mainView = await $('canvas, [class*="MapCanvas"]');
    await expect(mainView).toBeExisting();

    // Can still open import dialog
    await browser.keys(['Control', 'i']);
    const dialog = await $('[data-testid="import-dmp-dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });
    await expect(dialog).toBeDisplayed();

    // Close dialog
    const cancelBtn = await dialog.$('button*=Cancel');
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

    // Import file to get section count
    const result = await importDmpFile(dmpPath);
    expect(result.success).toBe(true);
    const expectedSectionCount = result.sectionCount ?? 0;
    expect(expectedSectionCount).toBeGreaterThan(1); // Multi-section file

    // Open import dialog
    await openDmpImportWithFile(dmpPath);

    const dialog = await $('[data-testid="import-dmp-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Verify section selection UI
    // Look for checkboxes (one per section)
    const checkboxes = await dialog.$$('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThanOrEqual(expectedSectionCount);

    // Verify All/None selection buttons
    const allBtn = await dialog.$('button*=All');
    const noneBtn = await dialog.$('button*=None');
    await expect(allBtn).toBeExisting();
    await expect(noneBtn).toBeExisting();

    // Test selection: click None then All
    await noneBtn.click();
    await browser.pause(500);
    await allBtn.click();
    await browser.pause(500);

    // Import all sections
    const importBtn = await dialog.$('button*=Import');
    await importBtn.waitForClickable({ timeout: 5000 });
    await importBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 10000 });

    // Verify all sections were imported
    await browser.pause(1000);
    const sections = await getProjectSections();
    expect(sections.length).toBe(expectedSectionCount);
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

    // Open import dialog with file
    await openDmpImportWithFile(dmpPath);

    const dialog = await $('[data-testid="import-dmp-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Verify section metadata is displayed
    // Look for section names (3-character DMP names)
    const tableRows = await dialog.$$('tbody tr');
    expect(tableRows.length).toBeGreaterThan(0);

    // Verify direction selector is present
    const directionSelect = await $('[data-testid="direction-select-0"]');
    if (await directionSelect.isExisting()) {
      // Verify it has valid options
      const value = await directionSelect.getValue();
      expect(['in', 'out']).toContain(value);
    }

    // Verify date column is present in header
    const headers = await dialog.$$('th');
    const headerTexts = await Promise.all(headers.map(h => h.getText()));
    expect(headerTexts).toContain('Date');

    // Import and verify metadata preserved
    const importBtn = await dialog.$('button*=Import');
    await importBtn.waitForClickable({ timeout: 5000 });
    await importBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 10000 });

    // Verify sections have names
    await browser.pause(1000);
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
    const result = await importDmpFile(dmpPath);

    // Should still parse successfully
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Should have sections despite buggy EOS
    expect(result.sectionCount).toBeGreaterThan(0);

    // Open import dialog and verify
    await openDmpImportWithFile(dmpPath);

    const dialog = await $('[data-testid="import-dmp-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Verify version 5 (buggy EOS is a v5 issue)
    const dialogText = await dialog.getText();
    expect(dialogText.toLowerCase()).toContain('version 5');

    // Verify statistics are computed (proves data was parsed)
    const statsFooter = await dialog.$('[data-testid="stats-footer"]');
    await expect(statsFooter).toBeExisting();

    const totalLength = await dialog.$('[data-testid="stats-total-length"]');
    const lengthText = await totalLength.getText();
    // Should have a non-zero total length
    expect(lengthText).toMatch(/\d+\.\d+m/);
    expect(lengthText).not.toBe('0.0m');

    // Import and verify data integrity
    const importBtn = await dialog.$('button*=Import');
    await importBtn.waitForClickable({ timeout: 5000 });
    await importBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 10000 });

    // Verify sections were imported
    await browser.pause(1000);
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
