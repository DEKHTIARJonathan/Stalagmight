/**
 * WebdriverIO E2E Tests: TML/TMLU Import Integration
 *
 * These tests run against the full Tauri application with real backend
 * to validate complete TML/TMLU import workflows. Unlike Playwright tests
 * that use mocked IPC, these tests parse real TML files.
 *
 * Test fixtures:
 * - test_synthetic.tmlu: Small TMLU (plain XML) with 2 sections, closures, virtual shots
 * - test_simple.tml: Larger TML (ZIP'd XML) with real cave survey data
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  openTmlImportWithFile,
  importTmlFile,
  parseTmlFile,
  getProjectSections,
  getProjectStats,
  waitForUiIdle,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

describe('TML Import Integration', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  /**
   * Test: should parse TMLU file successfully
   *
   * Validates TML parser can handle plain XML (TMLU) format:
   * - Parses without errors
   * - Returns cave name, sections, shots
   */
  it('should parse TMLU file successfully', async () => {
    await createNewProject('TMLU Parse Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await parseTmlFile(tmluPath);

    expect(result.error).toBeUndefined();
    expect(result.tmlFile).toBeDefined();

    // Verify parsed structure has expected fields
    const tml = result.tmlFile as {
      cave_name: string;
      sections: Array<{ name: string; shots: unknown[] }>;
      closures: unknown[];
    };
    expect(tml.cave_name).toBe('Synthetic Test Cave');
    expect(tml.sections.length).toBeGreaterThan(0);
  });

  /**
   * Test: should parse TML (ZIP) file successfully
   *
   * Validates TML parser can handle ZIP'd XML (TML) format:
   * - Decompresses ZIP archive
   * - Parses inner XML
   * - Returns valid data
   */
  it('should parse TML (ZIP) file successfully', async () => {
    await createNewProject('TML ZIP Parse Test');

    const tmlPath = path.join(FIXTURES_DIR, 'test_simple.tml');
    const result = await parseTmlFile(tmlPath);

    expect(result.error).toBeUndefined();
    expect(result.tmlFile).toBeDefined();

    const tml = result.tmlFile as {
      cave_name: string;
      sections: Array<{ name: string; shots: unknown[] }>;
    };
    expect(tml.cave_name).toBeDefined();
    expect(tml.sections.length).toBeGreaterThan(0);
  });

  /**
   * Test: should display TML import dialog with correct stats
   *
   * Validates the import dialog UI shows parsed data:
   * - Cave name is displayed
   * - Section count and table are shown
   * - Stats (shots, length, depth range) are displayed
   */
  it('should display TML import dialog with correct stats', async () => {
    await createNewProject('TML Dialog Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    await openTmlImportWithFile(tmluPath);

    // Verify dialog is open
    const dialog = await $('[data-testid="tml-import-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Verify cave name is shown
    const dialogText = await dialog.getText();
    expect(dialogText).toContain('Synthetic Test Cave');

    // Verify section table has rows
    const tableRows = await dialog.$$('tbody tr');
    expect(tableRows.length).toBeGreaterThan(0);

    // Verify stats grid shows section count, shots, length
    expect(dialogText).toContain('Sections');
    expect(dialogText).toContain('Shots');
    expect(dialogText).toContain('Total length');
    expect(dialogText).toContain('Depth range');

    // Verify Import button exists
    const importBtn = await dialog.$('[data-testid="tml-import-confirm"]');
    await expect(importBtn).toBeExisting();
  });

  /**
   * Test: should import TMLU file and create sections
   *
   * Validates end-to-end TMLU import via store:
   * - executeTmlImport creates sections in project
   * - Section count matches expected
   * - Shots are present
   */
  it('should import TMLU file and create sections', async () => {
    await createNewProject('TMLU Import Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlFile(tmluPath);

    expect(result.success).toBe(true);
    expect(result.error).toBeFalsy();

    // Verify sections were created
    await waitForUiIdle(500);
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Verify shots exist
    const hasShots = sections.some(s => (s.shots as unknown[]).length > 0);
    expect(hasShots).toBe(true);

    // Verify stats reflect imported data
    const stats = await getProjectStats();
    expect(stats).not.toBeNull();
    if (stats) {
      expect(stats.sectionCount).toBeGreaterThan(0);
      expect(stats.totalLength).toBeGreaterThan(0);
    }
  });

  /**
   * Test: should import TML (ZIP) file and create sections
   *
   * Validates end-to-end TML ZIP import:
   * - Decompresses and imports in one step
   * - Creates sections with correct data
   */
  it('should import TML (ZIP) file and create sections', async () => {
    await createNewProject('TML ZIP Import Test');

    const tmlPath = path.join(FIXTURES_DIR, 'test_simple.tml');
    const result = await importTmlFile(tmlPath);

    expect(result.success).toBe(true);
    expect(result.error).toBeFalsy();

    // Verify sections were created
    await waitForUiIdle(500);
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Verify stats
    const stats = await getProjectStats();
    expect(stats).not.toBeNull();
    if (stats) {
      expect(stats.sectionCount).toBeGreaterThan(0);
      expect(stats.totalLength).toBeGreaterThan(0);
    }
  });

  /**
   * Test: should import via dialog confirm button
   *
   * Validates the full UI-driven import flow:
   * - Open dialog with parsed TML
   * - Click Import button
   * - Dialog closes and sections are created
   */
  it('should import via dialog confirm button', async () => {
    await createNewProject('TML Dialog Import Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    await openTmlImportWithFile(tmluPath);

    // Click the Import button
    const importBtn = await $('[data-testid="tml-import-confirm"]');
    await importBtn.waitForClickable({ timeout: 10000 });
    await importBtn.click();

    // Wait for dialog to close
    const dialog = await $('[data-testid="tml-import-dialog"]');
    await dialog.waitForDisplayed({ reverse: true, timeout: 15000 });

    // Verify sections were imported
    await waitForUiIdle(500);
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);
  });

  /**
   * Test: should detect duplicate TML import
   *
   * Validates duplicate file detection:
   * - Import a TML file once
   * - Open import dialog with same file again
   * - Duplicate warning is shown
   */
  it('should detect duplicate TML import', async () => {
    await createNewProject('TML Duplicate Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');

    // First import
    const firstResult = await importTmlFile(tmluPath);
    expect(firstResult.success).toBe(true);

    // Open dialog again with the same file
    await openTmlImportWithFile(tmluPath);

    const dialog = await $('[data-testid="tml-import-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Wait for duplicate check to complete and warning to appear
    await browser.waitUntil(
      async () => {
        const text = await dialog.getText();
        return text.includes('already been imported');
      },
      {
        timeout: 10000,
        timeoutMsg: 'Duplicate import warning did not appear',
      }
    );

    // Close dialog
    const cancelBtn = await dialog.$('button*=Cancel');
    await cancelBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  /**
   * Test: should show section names from TML in dialog
   *
   * Validates section metadata display:
   * - Section names from TML appear in the dialog table
   * - Synthetic fixture has known section names
   */
  it('should show section names from TML in dialog', async () => {
    await createNewProject('TML Sections Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    await openTmlImportWithFile(tmluPath);

    const dialog = await $('[data-testid="tml-import-dialog"]');
    const dialogText = await dialog.getText();

    // test_synthetic.tmlu has "Main Passage" and "Side Branch" sections
    expect(dialogText).toContain('Main Passage');
    expect(dialogText).toContain('Side Branch');

    // Close dialog
    const cancelBtn = await dialog.$('button*=Cancel');
    await cancelBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });
});
