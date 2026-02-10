/**
 * WebdriverIO E2E Tests: TML Excluded Shots
 *
 * Tests the "Include excluded shots" toggle in the TML import dialog.
 * Verifies that excluded shots are filtered by default and can be included.
 *
 * Test fixture:
 * - test_with_excluded.tmlu: Has 3 excluded shots (IDs 2, 4, 6) out of 6 real shots
 *   across 2 sections (Gallery A: 3 real + 2 excluded, Gallery B: 1 real + 1 excluded)
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
  waitForUiIdle,
} from '../helpers/app';

const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

describe('TML Excluded Shots', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  /**
   * Test: parseTml reports excluded shots in the parsed data
   */
  it('should report excluded shots in parsed TML data', async () => {
    await createNewProject('Excluded Parse Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_with_excluded.tmlu');
    const result = await parseTmlFile(tmluPath);

    expect(result.error).toBeUndefined();
    expect(result.tmlFile).toBeDefined();

    const tml = result.tmlFile as {
      sections: Array<{
        name: string;
        shots: Array<{ excluded: boolean }>;
      }>;
    };

    // Count excluded shots across all sections
    let excludedCount = 0;
    let totalShots = 0;
    for (const section of tml.sections) {
      for (const shot of section.shots) {
        totalShots++;
        if (shot.excluded) excludedCount++;
      }
    }

    expect(excludedCount).toBe(3); // IDs 2, 4, 6
    expect(totalShots).toBeGreaterThan(excludedCount);
  });

  /**
   * Test: import dialog shows excluded shots count and toggle
   */
  it('should show excluded shots count and toggle in import dialog', async () => {
    await createNewProject('Excluded Dialog Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_with_excluded.tmlu');
    await openTmlImportWithFile(tmluPath);

    const dialog = await $('[data-testid="tml-import-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Dialog should show excluded shots count
    const dialogText = await dialog.getText();
    expect(dialogText).toContain('excluded');

    // The checkbox should exist
    const excludedCheckbox = await dialog.$('[data-testid="tml-include-excluded"]');
    await expect(excludedCheckbox).toBeExisting();

    // Checkbox should be unchecked by default (excluded shots filtered out)
    const isChecked = await excludedCheckbox.isSelected();
    expect(isChecked).toBe(false);

    // Close dialog
    const cancelBtn = await dialog.$('button*=Cancel');
    await cancelBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  /**
   * Test: importing with excluded shots filtered (default) produces fewer shots
   */
  it('should filter excluded shots by default on import', async () => {
    await createNewProject('Excluded Default Import Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_with_excluded.tmlu');

    // Import with default (includeExcluded = false)
    const result = await importTmlFile(tmluPath, false);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Count total shots - should NOT include the 3 excluded shots
    let totalShots = 0;
    for (const section of sections) {
      totalShots += (section.shots as unknown[]).length;
    }

    // The fixture has 6 real shots, 3 excluded. With filter on, should have 3 real shots.
    expect(totalShots).toBe(3);
  });

  /**
   * Test: importing with includeExcluded=true includes all shots
   */
  it('should include excluded shots when toggle is enabled', async () => {
    await createNewProject('Excluded Include Import Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_with_excluded.tmlu');

    // Import with includeExcluded = true
    const result = await importTmlFile(tmluPath, true);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Count total shots - should include all 6 real shots
    let totalShots = 0;
    for (const section of sections) {
      totalShots += (section.shots as unknown[]).length;
    }

    // All 6 shots (3 real + 3 excluded) should be present
    expect(totalShots).toBe(6);
  });

  /**
   * Test: excluded shots toggle changes shot count difference
   *
   * Compare import with and without excluded to verify the delta.
   */
  it('should produce different shot counts with and without excluded', async () => {
    // First import WITHOUT excluded
    await createNewProject('Excluded Compare Test 1');
    const tmluPath = path.join(FIXTURES_DIR, 'test_with_excluded.tmlu');

    const result1 = await importTmlFile(tmluPath, false);
    expect(result1.success).toBe(true);
    await waitForUiIdle(500);

    const sections1 = await getProjectSections();
    let totalWithout = 0;
    for (const s of sections1) {
      totalWithout += (s.shots as unknown[]).length;
    }

    // Reset and import WITH excluded
    await resetAppState();
    await createNewProject('Excluded Compare Test 2');

    const result2 = await importTmlFile(tmluPath, true);
    expect(result2.success).toBe(true);
    await waitForUiIdle(500);

    const sections2 = await getProjectSections();
    let totalWith = 0;
    for (const s of sections2) {
      totalWith += (s.shots as unknown[]).length;
    }

    // Including excluded should have more shots
    expect(totalWith).toBeGreaterThan(totalWithout);
    expect(totalWith - totalWithout).toBe(3); // Exactly 3 excluded shots
  });

  /**
   * Test: importing via dialog with checkbox checked includes excluded shots
   */
  it('should include excluded shots when checkbox is checked in dialog', async () => {
    await createNewProject('Excluded Dialog Import Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_with_excluded.tmlu');
    await openTmlImportWithFile(tmluPath);

    const dialog = await $('[data-testid="tml-import-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Check the "Include excluded" checkbox
    const excludedCheckbox = await dialog.$('[data-testid="tml-include-excluded"]');
    await excludedCheckbox.click();
    await waitForUiIdle(200);

    // Click Import
    const importBtn = await dialog.$('[data-testid="tml-import-confirm"]');
    await importBtn.waitForClickable({ timeout: 10000 });
    await importBtn.click();

    // Wait for dialog to close
    await dialog.waitForDisplayed({ reverse: true, timeout: 15000 });

    await waitForUiIdle(500);

    const sections = await getProjectSections();
    let totalShots = 0;
    for (const section of sections) {
      totalShots += (section.shots as unknown[]).length;
    }

    // All 6 shots should be imported (checkbox was checked)
    expect(totalShots).toBe(6);
  });
});
