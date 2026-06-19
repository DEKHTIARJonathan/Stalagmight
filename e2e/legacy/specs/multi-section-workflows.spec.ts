/**
 * WebdriverIO E2E Tests: Multi-Section Workflows
 *
 * These tests run against the full Tauri application with real backend
 * to validate importing multiple sections, merging, deleting, and maintaining
 * relationships between sections.
 *
 * Test fixtures:
 * - test_v2.dmp: DMP version 2 format with multiple sections
 * - test_v5.dmp: DMP version 5 format with LRUD data
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importDmpViaStore,
  getProjectSections,
  waitForUiIdle,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

/**
 * Helper to delete a section via store
 */
async function deleteSection(sectionId: number): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (
      id: number,
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              deleteSection: (sectionId: number) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const result = await e2e.projectStore.getState().deleteSection(id);
        done({ success: result.success, error: result.error });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    sectionId
  );
}

/**
 * Helper to create a section via store
 */
async function createTestSection(name: string): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (
      sectionName: string,
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              createSection: (data: {
                name: string;
                surveyor: string;
                date: string;
                color: string;
                shots: Array<{
                  azimuth_in: number;
                  azimuth_out: number;
                  length: number;
                  depth_in: number;
                  depth_out: number;
                }>;
              }) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const result = await e2e.projectStore.getState().createSection({
          name: sectionName,
          surveyor: 'Test Surveyor',
          date: '2026-01-01',
          color: '#FF0000',
          shots: [
            { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: 0, depth_out: -2 },
            { azimuth_in: 90, azimuth_out: 270, length: 15, depth_in: -2, depth_out: -5 },
          ],
        });
        done({ success: result.success, error: result.error });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    name
  );
}

/**
 * Helper to update a section via store
 */
async function updateSection(
  sectionId: number,
  updates: { name?: string; color?: string }
): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (
      id: number,
      updateData: { name?: string; color?: string },
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              updateSection: (
                sectionId: number,
                updates: { name?: string; color?: string }
              ) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const result = await e2e.projectStore.getState().updateSection(id, updateData);
        done({ success: result.success, error: result.error });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    sectionId,
    updates
  );
}

/**
 * Helper to merge stations via store
 */
async function mergeStations(
  sectionA: number,
  stationA: number,
  sectionB: number,
  stationB: number
): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (
      secA: number,
      staA: number,
      secB: number,
      staB: number,
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              mergeStations: (
                stationA: { section_id: number; station_index: number },
                stationB: { section_id: number; station_index: number },
              ) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const result = await e2e.projectStore.getState().mergeStations(
          { section_id: secA, station_index: staA },
          { section_id: secB, station_index: staB },
        );
        done({ success: result.success, error: result.error });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    sectionA,
    stationA,
    sectionB,
    stationB
  );
}

/**
 * Helper to get station merges from project
 */
async function getStationMerges(): Promise<
  Array<{
    station_a: { section_id: number; station_index: number };
    station_b: { section_id: number; station_index: number };
  }>
> {
  return await browser.executeAsync(
    (
      done: (
        merges: Array<{
          station_a: { section_id: number; station_index: number };
          station_b: { section_id: number; station_index: number };
        }>
      ) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: {
                station_merges?: Array<{
                  station_a: { section_id: number; station_index: number };
                  station_b: { section_id: number; station_index: number };
                }>;
              } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().project) {
        done([]);
        return;
      }

      done(e2e.projectStore.getState().project?.station_merges ?? []);
    }
  );
}

describe('Multi-Section Workflows', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  /**
   * Test 17.1: should import and display multiple sections
   *
   * Validates multiple section import from a single DMP file:
   * - Import a multi-section DMP file
   * - Verify all sections are displayed
   * - Verify sections maintain their individual properties
   * - Verify section count matches expected
   */
  it('should import and display multiple sections', async () => {
    await createNewProject('Multi-Section Import Test');

    // Import a multi-section DMP file
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const result = await importDmpViaStore(dmpPath);

    // Verify import succeeded with multiple sections
    expect(result.success).toBe(true);
    expect(result.sectionCount).toBeGreaterThan(1);

    // Wait for state to update
    await waitForUiIdle(500);

    // Get all sections from the project
    const sections = await getProjectSections();

    // Verify all sections were imported
    expect(sections.length).toBe(result.sectionCount);

    // Verify each section has required properties
    for (const section of sections) {
      expect(section.id).toBeDefined();
      expect(section.name).toBeDefined();
      expect(section.name.length).toBeGreaterThan(0);
      expect(section.shots).toBeDefined();
      expect(Array.isArray(section.shots)).toBe(true);
    }

    // Verify sections have unique IDs
    const sectionIds = sections.map((s) => s.id);
    const uniqueIds = new Set(sectionIds);
    expect(uniqueIds.size).toBe(sections.length);

    // Import another DMP file to test cumulative importing
    const dmpPath2 = path.join(FIXTURES_DIR, 'test_v5.dmp');
    const result2 = await importDmpViaStore(dmpPath2);

    expect(result2.success).toBe(true);
    expect(result2.sectionCount).toBeGreaterThan(0);

    await waitForUiIdle(500);

    // Verify sections from both imports exist
    const allSections = await getProjectSections();
    const expectedTotal = (result.sectionCount ?? 0) + (result2.sectionCount ?? 0);
    expect(allSections.length).toBe(expectedTotal);

    // Verify map is displayed with sections
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();
  });

  /**
   * Test 17.2: should merge sections together
   *
   * Validates station merging workflow:
   * - Import multiple sections
   * - Merge stations from different sections
   * - Verify merge is recorded
   * - Verify sections remain linked
   */
  it('should merge sections together', async () => {
    await createNewProject('Section Merge Test');

    // Import multi-section DMP to get sections that can be merged
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const result = await importDmpViaStore(dmpPath);

    expect(result.success).toBe(true);
    expect(result.sectionCount).toBeGreaterThan(1);

    await waitForUiIdle(500);

    // Get sections
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(1);

    // Find two sections with shots to merge
    const sectionsWithShots = sections.filter((s) => (s.shots as unknown[]).length > 0);
    expect(sectionsWithShots.length).toBeGreaterThan(1);

    const sectionA = sectionsWithShots[0];
    const sectionB = sectionsWithShots[1];

    // Get initial merge count
    const initialMerges = await getStationMerges();
    const initialMergeCount = initialMerges.length;

    // Merge the first station of section A with the first station of section B
    const mergeResult = await mergeStations(sectionA.id, 0, sectionB.id, 0);

    expect(mergeResult.success).toBe(true);

    await waitForUiIdle(500);

    // Verify merge was recorded
    const mergesAfter = await getStationMerges();
    expect(mergesAfter.length).toBe(initialMergeCount + 1);

    // Verify the merge connects the correct sections
    const newMerge = mergesAfter[mergesAfter.length - 1];
    expect(newMerge).toBeDefined();
    expect(
      (newMerge.station_a.section_id === sectionA.id &&
        newMerge.station_b.section_id === sectionB.id) ||
        (newMerge.station_a.section_id === sectionB.id &&
          newMerge.station_b.section_id === sectionA.id)
    ).toBe(true);

    // Verify both sections still exist
    const sectionsAfterMerge = await getProjectSections();
    expect(sectionsAfterMerge.length).toBe(sections.length);

    // Verify map is still displayed
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();
  });

  /**
   * Test 17.3: should delete section without affecting others
   *
   * Validates isolated section deletion:
   * - Create/import multiple sections
   * - Delete one section
   * - Verify other sections remain intact
   * - Verify deleted section data is removed
   */
  it('should delete section without affecting others', async () => {
    await createNewProject('Section Delete Test');

    // Create multiple sections
    const createResult1 = await createTestSection('Section Alpha');
    expect(createResult1.success).toBe(true);

    const createResult2 = await createTestSection('Section Beta');
    expect(createResult2.success).toBe(true);

    const createResult3 = await createTestSection('Section Gamma');
    expect(createResult3.success).toBe(true);

    await waitForUiIdle(500);

    // Verify all three sections exist
    const sectionsBeforeDelete = await getProjectSections();
    expect(sectionsBeforeDelete.length).toBe(3);

    // Find Section Beta to delete
    const sectionBeta = sectionsBeforeDelete.find((s) => s.name === 'Section Beta');
    expect(sectionBeta).toBeDefined();

    // Capture details of other sections for verification
    const sectionAlpha = sectionsBeforeDelete.find((s) => s.name === 'Section Alpha');
    const sectionGamma = sectionsBeforeDelete.find((s) => s.name === 'Section Gamma');
    expect(sectionAlpha).toBeDefined();
    expect(sectionGamma).toBeDefined();

    const alphaId = sectionAlpha!.id;
    const gammaId = sectionGamma!.id;
    const alphaShotCount = (sectionAlpha!.shots as unknown[]).length;
    const gammaShotCount = (sectionGamma!.shots as unknown[]).length;

    // Delete Section Beta
    const deleteResult = await deleteSection(sectionBeta!.id);
    expect(deleteResult.success).toBe(true);

    await waitForUiIdle(500);

    // Verify only two sections remain
    const sectionsAfterDelete = await getProjectSections();
    expect(sectionsAfterDelete.length).toBe(2);

    // Verify Section Beta is gone
    const betaAfterDelete = sectionsAfterDelete.find((s) => s.name === 'Section Beta');
    expect(betaAfterDelete).toBeUndefined();

    // Verify Section Alpha is intact
    const alphaAfterDelete = sectionsAfterDelete.find((s) => s.id === alphaId);
    expect(alphaAfterDelete).toBeDefined();
    expect(alphaAfterDelete!.name).toBe('Section Alpha');
    expect((alphaAfterDelete!.shots as unknown[]).length).toBe(alphaShotCount);

    // Verify Section Gamma is intact
    const gammaAfterDelete = sectionsAfterDelete.find((s) => s.id === gammaId);
    expect(gammaAfterDelete).toBeDefined();
    expect(gammaAfterDelete!.name).toBe('Section Gamma');
    expect((gammaAfterDelete!.shots as unknown[]).length).toBe(gammaShotCount);

    // Verify map is still displayed
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();
  });

  /**
   * Test 17.4: should maintain section relationships through edits
   *
   * Validates relationship integrity during modifications:
   * - Create sections and merge stations
   * - Edit a section (rename, update properties)
   * - Verify merge relationship is preserved
   * - Verify other sections are not affected
   */
  it('should maintain section relationships through edits', async () => {
    await createNewProject('Relationship Integrity Test');

    // Create two sections
    const createResult1 = await createTestSection('Source Section');
    expect(createResult1.success).toBe(true);

    const createResult2 = await createTestSection('Target Section');
    expect(createResult2.success).toBe(true);

    await waitForUiIdle(500);

    // Get section info
    const sectionsBeforeMerge = await getProjectSections();
    expect(sectionsBeforeMerge.length).toBe(2);

    const sourceSection = sectionsBeforeMerge.find((s) => s.name === 'Source Section');
    const targetSection = sectionsBeforeMerge.find((s) => s.name === 'Target Section');
    expect(sourceSection).toBeDefined();
    expect(targetSection).toBeDefined();

    // Merge stations between sections to create a relationship
    const mergeResult = await mergeStations(sourceSection!.id, 0, targetSection!.id, 0);
    expect(mergeResult.success).toBe(true);

    await waitForUiIdle(500);

    // Verify merge exists
    const mergesBeforeEdit = await getStationMerges();
    expect(mergesBeforeEdit.length).toBe(1);

    // Edit Source Section (rename it)
    const updateResult = await updateSection(sourceSection!.id, {
      name: 'Renamed Source Section',
      color: '#00FF00',
    });
    expect(updateResult.success).toBe(true);

    await waitForUiIdle(500);

    // Verify the merge relationship is preserved after edit
    const mergesAfterEdit = await getStationMerges();
    expect(mergesAfterEdit.length).toBe(1);

    // Verify the merge still references the correct section IDs
    const mergeAfterEdit = mergesAfterEdit[0];
    expect(
      (mergeAfterEdit.station_a.section_id === sourceSection!.id &&
        mergeAfterEdit.station_b.section_id === targetSection!.id) ||
        (mergeAfterEdit.station_a.section_id === targetSection!.id &&
          mergeAfterEdit.station_b.section_id === sourceSection!.id)
    ).toBe(true);

    // Verify Source Section was renamed
    const sectionsAfterEdit = await getProjectSections();
    const renamedSource = sectionsAfterEdit.find((s) => s.id === sourceSection!.id);
    expect(renamedSource).toBeDefined();
    expect(renamedSource!.name).toBe('Renamed Source Section');

    // Verify Target Section was not affected
    const targetAfterEdit = sectionsAfterEdit.find((s) => s.id === targetSection!.id);
    expect(targetAfterEdit).toBeDefined();
    expect(targetAfterEdit!.name).toBe('Target Section');

    // Verify both sections still have their shots
    expect((renamedSource!.shots as unknown[]).length).toBe(2);
    expect((targetAfterEdit!.shots as unknown[]).length).toBe(2);

    // Verify map is still displayed
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeDisplayed();
  });
});
