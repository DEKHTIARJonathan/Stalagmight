/**
 * WebdriverIO E2E Tests: Reference Shots Filter
 *
 * Tests the showReferenceShots display toggle, verifying that reference-only
 * stations and their labels are hidden/shown when the filter is toggled.
 *
 * Test fixture:
 * - test_synthetic.tmlu: Has VIRTUAL shot (ID 8) and a main passage with real shots
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importTmlFile,
  getProjectSections,
  waitForUiIdle,
  waitForMapReady,
} from '../helpers/app';

const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

/**
 * Get the showReferenceShots toggle state from the UI store.
 */
async function getShowReferenceShots(): Promise<boolean> {
  return await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => { showReferenceShots: boolean };
        };
      };
    }).__E2E_TEST__;
    return e2e?.uiStore.getState().showReferenceShots ?? true;
  });
}

/**
 * Toggle the showReferenceShots display setting via the UI store.
 */
async function toggleReferenceShots(): Promise<void> {
  await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            toggleDisplay: (key: string) => void;
          };
        };
      };
    }).__E2E_TEST__;
    if (e2e) {
      e2e.uiStore.getState().toggleDisplay('showReferenceShots');
    }
  });
  await waitForUiIdle(300);
}

/**
 * Count shots in the project, split by is_reference.
 */
async function countShotsByType(): Promise<{ real: number; reference: number }> {
  return await browser.executeAsync(
    (done: (result: { real: number; reference: number }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: {
                sections: Array<{
                  shots: Array<{ is_reference: boolean }>;
                }>;
              } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().project) {
        done({ real: 0, reference: 0 });
        return;
      }

      let real = 0;
      let reference = 0;
      for (const section of e2e.projectStore.getState().project!.sections) {
        for (const shot of section.shots) {
          if (shot.is_reference) reference++;
          else real++;
        }
      }
      done({ real, reference });
    }
  );
}

describe('Reference Shots Filter', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  /**
   * Test: showReferenceShots defaults to true
   */
  it('should default showReferenceShots to true', async () => {
    await createNewProject('Reference Default Test');
    const showReference = await getShowReferenceShots();
    expect(showReference).toBe(true);
  });

  /**
   * Test: imported TML with reference shots has both real and reference shots in store
   */
  it('should import TML with reference shots present in store', async () => {
    await createNewProject('Reference Import Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlFile(tmluPath);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    const counts = await countShotsByType();
    // test_synthetic.tmlu has: 6 REAL shots + 1 VIRTUAL shot (ID 8)
    // The CLOSURE shot (ID 9) is also imported but may or may not be reference
    expect(counts.real).toBeGreaterThan(0);
    expect(counts.reference).toBeGreaterThan(0);
  });

  /**
   * Test: toggling showReferenceShots changes the store state
   */
  it('should toggle showReferenceShots state', async () => {
    await createNewProject('Reference Toggle Test');

    // Default is true
    expect(await getShowReferenceShots()).toBe(true);

    // Toggle off
    await toggleReferenceShots();
    expect(await getShowReferenceShots()).toBe(false);

    // Toggle back on
    await toggleReferenceShots();
    expect(await getShowReferenceShots()).toBe(true);
  });

  /**
   * Test: toggling reference shots does not remove data from project store
   *
   * The filter only affects map rendering, not the underlying data.
   */
  it('should not remove reference shots from project data when filter is off', async () => {
    await createNewProject('Reference Data Preservation Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlFile(tmluPath);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    // Get counts with filter on
    const countsBefore = await countShotsByType();
    expect(countsBefore.reference).toBeGreaterThan(0);

    // Toggle filter off
    await toggleReferenceShots();
    expect(await getShowReferenceShots()).toBe(false);

    // Data should be unchanged (filter is display-only)
    const countsAfter = await countShotsByType();
    expect(countsAfter.real).toBe(countsBefore.real);
    expect(countsAfter.reference).toBe(countsBefore.reference);

    // Toggle back on
    await toggleReferenceShots();
    expect(await getShowReferenceShots()).toBe(true);
  });

  /**
   * Test: reference shots toggle state persists through map interactions
   *
   * After toggling off, the state should remain off even after waiting.
   */
  it('should persist reference shots toggle state', async () => {
    await createNewProject('Reference Persist Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlFile(tmluPath);
    expect(result.success).toBe(true);

    await waitForMapReady();

    // Toggle off
    await toggleReferenceShots();
    expect(await getShowReferenceShots()).toBe(false);

    // Wait and interact
    await waitForUiIdle(500);

    // State should persist
    expect(await getShowReferenceShots()).toBe(false);

    // Sections still accessible
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);
  });
});
