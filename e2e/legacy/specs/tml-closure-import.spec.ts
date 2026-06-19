/**
 * WebdriverIO E2E Tests: TML Loop Closure Import
 *
 * Tests that TML loop closures are correctly imported and preserved.
 *
 * Test fixtures:
 * - test_synthetic.tmlu: Has 1 CLOSURE shot (ID 9, CID=1) closing back to shot 1
 * - test_with_walls.tml: Has 1 CLOSURE and 1 VIRTUAL shot in a larger survey
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importTmlViaStore,
  parseTmlFile,
  getProjectSections,
  getProjectMerges,
  getProjectStats,
  waitForUiIdle,
} from '../helpers/app';

const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

describe('TML Closure Import', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  /**
   * Test: parseTml detects closures in TML data
   */
  it('should detect closures in parsed TML data', async () => {
    await createNewProject('Closure Parse Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await parseTmlFile(tmluPath);

    expect(result.error).toBeUndefined();
    expect(result.tmlFile).toBeDefined();

    const tml = result.tmlFile as {
      closures: Array<unknown>;
      sections: Array<{ name: string; shots: unknown[] }>;
    };

    // test_synthetic.tmlu has closure shot ID 9 with CID=1
    expect(tml.closures.length).toBeGreaterThan(0);
  });

  /**
   * Test: TML import dialog shows closure count
   *
   * The dialog displays "{N} loop closure(s) detected" when closures exist.
   */
  it('should show closure count in import dialog', async () => {
    await createNewProject('Closure Dialog Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');

    // Open the import dialog
    const { openTmlImportWithFile } = await import('../helpers/app');
    await openTmlImportWithFile(tmluPath);

    const dialog = await $('[data-testid="tml-import-dialog"]');
    await expect(dialog).toBeDisplayed();

    // Dialog should mention closures
    const dialogText = await dialog.getText();
    expect(dialogText.toLowerCase()).toContain('closure');

    // Close dialog
    const cancelBtn = await dialog.$('button*=Cancel');
    await cancelBtn.click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  /**
   * Test: importing TML with closures creates station merges
   *
   * Loop closures should result in station merges in the project.
   */
  it('should create station merges from TML closures', async () => {
    await createNewProject('Closure Import Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlViaStore(tmluPath);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    // Check that station merges were created
    const merges = await getProjectMerges();
    expect(merges.length).toBeGreaterThan(0);
  });

  /**
   * Test: closure import preserves section data integrity
   *
   * Sections and shots should be correctly imported even with closures.
   */
  it('should preserve section data with closures', async () => {
    await createNewProject('Closure Section Data Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlViaStore(tmluPath);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    // Verify sections were created
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Verify sections have shots
    const totalShots = sections.reduce(
      (sum, s) => sum + (s.shots as unknown[]).length,
      0
    );
    expect(totalShots).toBeGreaterThan(0);

    // Verify stats
    const stats = await getProjectStats();
    expect(stats).not.toBeNull();
    if (stats) {
      expect(stats.totalLength).toBeGreaterThan(0);
      expect(stats.sectionCount).toBeGreaterThan(0);
    }
  });

  /**
   * Test: TML with walls file (has CLOSURE + VIRTUAL) imports correctly
   *
   * The test_with_walls.tml is a larger real-world file with 1 CLOSURE
   * and 1 VIRTUAL shot among ~1800 real shots.
   */
  it('should import TML with walls file containing closures', async () => {
    await createNewProject('Walls Closure Test');

    const tmlPath = path.join(FIXTURES_DIR, 'test_with_walls.tml');
    const result = await importTmlViaStore(tmlPath);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    // Should have many sections from a large survey
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Should have substantial data
    const stats = await getProjectStats();
    expect(stats).not.toBeNull();
    if (stats) {
      expect(stats.totalLength).toBeGreaterThan(0);
      expect(stats.stationCount).toBeGreaterThan(0);
    }
  });

  /**
   * Test: closure shot creates correct merge topology
   *
   * The merge should connect two stations from the same or different sections.
   */
  it('should create correct merge topology from closure', async () => {
    await createNewProject('Closure Topology Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlViaStore(tmluPath);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    const merges = await getProjectMerges();
    expect(merges.length).toBeGreaterThan(0);

    // Each merge should have valid station references
    for (const merge of merges) {
      expect(merge.station_a).toBeDefined();
      expect(merge.station_b).toBeDefined();
      expect(merge.station_a.section_id).toBeDefined();
      expect(merge.station_a.station_index).toBeDefined();
      expect(merge.station_b.section_id).toBeDefined();
      expect(merge.station_b.station_index).toBeDefined();
    }
  });
});
