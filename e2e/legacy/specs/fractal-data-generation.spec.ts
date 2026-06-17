/**
 * Fractal Data Generation Tests
 *
 * Generates complex cave survey data following an L-system fractal plant pattern.
 * Creates fixture files for use in other tests:
 *   - fractal_plant_iter2.stalx (medium complexity, ~25 sections)
 *   - fractal_plant_iter3.stalx (large complexity, ~85 sections)
 *   - fractal_plant_iter4.stalx (stress test, ~300+ sections)
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  getProjectStats,
  getProjectMerges,
  createSectionViaStore,
  mergeStationsViaStore,
  saveProjectToPath,
  waitForUiIdle,
} from '../helpers/app';
import {
  generateLSystem,
  executeLSystem,
  buildExpectedMergeSet,
  buildActualMergeSet,
  compareMergeSets,
  type MergeData,
  type SectionData,
} from '../helpers/fractal';

const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

describe('Fractal Data Generation', function () {
  // Set default timeout for all tests (5 minutes)
  this.timeout(300000);

  before(async function () {
    await waitForAppReady();
  });

  afterEach(async function () {
    await resetAppState();
  });

  /**
   * Common function to generate fractal survey data with specified iterations.
   * Creates project, sections, merges, and saves to fixture file.
   *
   * @param iterations - Number of L-system iterations
   * @returns Stats about what was created
   */
  async function generateFractalProject(iterations: number): Promise<{
    sectionCount: number;
    mergeCount: number;
    totalShots: number;
  }> {
    const projectName = `Fractal Plant (${iterations} iterations)`;
    const fixturePath = path.join(FIXTURES_DIR, `fractal_plant_iter${iterations}.stalx`);

    // 1. Create new project
    await createNewProject(projectName);
    console.log(`[Fractal] Created project: ${projectName}`);

    // 2. Generate L-system string
    const lSystem = generateLSystem(iterations);
    console.log(`[Fractal] Generated L-system: ${lSystem.length} characters`);

    // 3. Execute L-system to get sections and merges
    const { sections, merges } = executeLSystem(lSystem);
    const totalShots = sections.reduce((sum, s) => sum + s.shots.length, 0);
    console.log(
      `[Fractal] Parsed: ${sections.length} sections, ${totalShots} shots, ${merges.length} merges`
    );

    // 4. Create all sections and track their actual backend IDs
    const sectionIdMap = await createAllSections(sections, iterations);

    // 5. Perform all station merges
    await performAllMerges(merges, sectionIdMap);

    // 6. Verify merge relationships
    await verifyMerges(merges, sectionIdMap);

    // 7. Save project to fixtures directory
    const saveResult = await saveProjectToPath(fixturePath);
    if (!saveResult.success) {
      throw new Error(`Failed to save project: ${saveResult.error}`);
    }

    // Wait for filesystem sync, then verify file exists
    await waitForUiIdle(500);
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Fixture file not created: ${fixturePath}`);
    }

    // 8. Get final stats
    const stats = await getProjectStats();
    if (!stats) {
      throw new Error('Failed to get project stats after save');
    }

    console.log(
      `[Fractal] Saved to ${fixturePath}: ${stats.sectionCount} sections, ${stats.stationCount} stations, ${stats.totalLength.toFixed(1)}m total length`
    );

    return {
      sectionCount: sections.length,
      mergeCount: merges.length,
      totalShots,
    };
  }

  /**
   * Create all sections and return a map of local index to backend ID.
   */
  async function createAllSections(
    sections: SectionData[],
    iterations: number
  ): Promise<Map<number, number>> {
    const sectionIdMap = new Map<number, number>();
    const logInterval = 50;

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const result = await createSectionViaStore(section);

      if (!result.success) {
        throw new Error(
          `Failed to create section ${section.name} (index ${i}): ${result.error}`
        );
      }

      if (result.sectionId === undefined) {
        throw new Error(
          `Section ${section.name} created but no ID returned`
        );
      }

      sectionIdMap.set(i, result.sectionId);

      // Log progress for large datasets
      if (iterations >= 4 && (i + 1) % logInterval === 0) {
        console.log(`[Fractal] Created ${i + 1}/${sections.length} sections...`);
      }
    }

    return sectionIdMap;
  }

  /**
   * Perform all station merges using actual backend section IDs.
   */
  async function performAllMerges(
    merges: MergeData[],
    sectionIdMap: Map<number, number>
  ): Promise<void> {
    for (let i = 0; i < merges.length; i++) {
      const merge = merges[i];
      const actualSectionA = sectionIdMap.get(merge.stationA.section_id);
      const actualSectionB = sectionIdMap.get(merge.stationB.section_id);

      if (actualSectionA === undefined || actualSectionB === undefined) {
        throw new Error(
          `Merge ${i} references invalid section IDs: A=${merge.stationA.section_id}, B=${merge.stationB.section_id}`
        );
      }

      const result = await mergeStationsViaStore(
        { section_id: actualSectionA, station_index: merge.stationA.station_index },
        { section_id: actualSectionB, station_index: merge.stationB.station_index }
      );

      if (!result.success) {
        throw new Error(
          `Failed to merge stations (A: section ${actualSectionA} station ${merge.stationA.station_index}, ` +
            `B: section ${actualSectionB} station ${merge.stationB.station_index}): ${result.error}`
        );
      }
    }
  }

  /**
   * Verify that merge relationships in the backend match expected.
   */
  async function verifyMerges(
    expectedMerges: MergeData[],
    sectionIdMap: Map<number, number>
  ): Promise<void> {
    const actualMerges = await getProjectMerges();

    const expectedSet = buildExpectedMergeSet(expectedMerges, sectionIdMap);
    const actualSet = buildActualMergeSet(actualMerges);

    const { missing, extra } = compareMergeSets(expectedSet, actualSet);

    if (missing.length > 0 || extra.length > 0) {
      const details = [];
      if (missing.length > 0) {
        details.push(`Missing merges: ${JSON.stringify(missing)}`);
      }
      if (extra.length > 0) {
        details.push(`Extra merges: ${JSON.stringify(extra)}`);
      }
      throw new Error(`Merge verification failed:\n${details.join('\n')}`);
    }
  }

  // ============================================================================
  // Test Cases
  // ============================================================================

  it('should generate 2-iteration fractal (medium complexity)', async function () {
    this.timeout(300000);

    const result = await generateFractalProject(2);

    // Verify we got a reasonable structure
    // L-system iter 2 produces ~8 sections, ~18 shots, ~7 merges
    expect(result.sectionCount).toBeGreaterThanOrEqual(5);
    expect(result.totalShots).toBeGreaterThanOrEqual(15);
    expect(result.mergeCount).toBeGreaterThan(0);

    // Verify stats from backend
    const stats = await getProjectStats();
    expect(stats).not.toBeNull();
    expect(stats!.sectionCount).toBe(result.sectionCount);
  });

  it('should generate 3-iteration fractal (large complexity)', async function () {
    this.timeout(300000);

    const result = await generateFractalProject(3);

    // Verify larger structure
    // L-system iter 3 produces ~32 sections, ~84 shots, ~31 merges
    expect(result.sectionCount).toBeGreaterThanOrEqual(25);
    expect(result.totalShots).toBeGreaterThanOrEqual(80);
    expect(result.mergeCount).toBeGreaterThan(0);

    // Verify stats from backend
    const stats = await getProjectStats();
    expect(stats).not.toBeNull();
    expect(stats!.sectionCount).toBe(result.sectionCount);
  });

  it('should generate 4-iteration fractal (stress test)', async function () {
    this.timeout(300000);

    const result = await generateFractalProject(4);

    // Verify large structure
    // L-system iter 4 produces ~128 sections, ~360 shots, ~127 merges
    expect(result.sectionCount).toBeGreaterThanOrEqual(100);
    expect(result.totalShots).toBeGreaterThanOrEqual(300);
    expect(result.mergeCount).toBeGreaterThan(0);

    // Verify stats from backend
    const stats = await getProjectStats();
    expect(stats).not.toBeNull();
    expect(stats!.sectionCount).toBe(result.sectionCount);
  });
});
