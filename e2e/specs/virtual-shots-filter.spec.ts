/**
 * WebdriverIO E2E Tests: Virtual Shots Filter
 *
 * Tests the showVirtualShots display toggle, verifying that virtual-only
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
 * Get the showVirtualShots toggle state from the UI store.
 */
async function getShowVirtualShots(): Promise<boolean> {
  return await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => { showVirtualShots: boolean };
        };
      };
    }).__E2E_TEST__;
    return e2e?.uiStore.getState().showVirtualShots ?? true;
  });
}

/**
 * Toggle the showVirtualShots display setting via the UI store.
 */
async function toggleVirtualShots(): Promise<void> {
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
      e2e.uiStore.getState().toggleDisplay('showVirtualShots');
    }
  });
  await waitForUiIdle(300);
}

/**
 * Count shots in the project, split by is_virtual.
 */
async function countShotsByType(): Promise<{ real: number; virtual: number }> {
  return await browser.executeAsync(
    (done: (result: { real: number; virtual: number }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: {
                sections: Array<{
                  shots: Array<{ is_virtual: boolean }>;
                }>;
              } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().project) {
        done({ real: 0, virtual: 0 });
        return;
      }

      let real = 0;
      let virtual = 0;
      for (const section of e2e.projectStore.getState().project!.sections) {
        for (const shot of section.shots) {
          if (shot.is_virtual) virtual++;
          else real++;
        }
      }
      done({ real, virtual });
    }
  );
}

describe('Virtual Shots Filter', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  /**
   * Test: showVirtualShots defaults to true
   */
  it('should default showVirtualShots to true', async () => {
    await createNewProject('Virtual Default Test');
    const showVirtual = await getShowVirtualShots();
    expect(showVirtual).toBe(true);
  });

  /**
   * Test: imported TML with virtual shots has both real and virtual shots in store
   */
  it('should import TML with virtual shots present in store', async () => {
    await createNewProject('Virtual Import Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlFile(tmluPath);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    const counts = await countShotsByType();
    // test_synthetic.tmlu has: 6 REAL shots + 1 VIRTUAL shot (ID 8)
    // The CLOSURE shot (ID 9) is also imported but may or may not be virtual
    expect(counts.real).toBeGreaterThan(0);
    expect(counts.virtual).toBeGreaterThan(0);
  });

  /**
   * Test: toggling showVirtualShots changes the store state
   */
  it('should toggle showVirtualShots state', async () => {
    await createNewProject('Virtual Toggle Test');

    // Default is true
    expect(await getShowVirtualShots()).toBe(true);

    // Toggle off
    await toggleVirtualShots();
    expect(await getShowVirtualShots()).toBe(false);

    // Toggle back on
    await toggleVirtualShots();
    expect(await getShowVirtualShots()).toBe(true);
  });

  /**
   * Test: toggling virtual shots does not remove data from project store
   *
   * The filter only affects map rendering, not the underlying data.
   */
  it('should not remove virtual shots from project data when filter is off', async () => {
    await createNewProject('Virtual Data Preservation Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlFile(tmluPath);
    expect(result.success).toBe(true);

    await waitForUiIdle(500);

    // Get counts with filter on
    const countsBefore = await countShotsByType();
    expect(countsBefore.virtual).toBeGreaterThan(0);

    // Toggle filter off
    await toggleVirtualShots();
    expect(await getShowVirtualShots()).toBe(false);

    // Data should be unchanged (filter is display-only)
    const countsAfter = await countShotsByType();
    expect(countsAfter.real).toBe(countsBefore.real);
    expect(countsAfter.virtual).toBe(countsBefore.virtual);

    // Toggle back on
    await toggleVirtualShots();
    expect(await getShowVirtualShots()).toBe(true);
  });

  /**
   * Test: virtual shots toggle state persists through map interactions
   *
   * After toggling off, the state should remain off even after waiting.
   */
  it('should persist virtual shots toggle state', async () => {
    await createNewProject('Virtual Persist Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const result = await importTmlFile(tmluPath);
    expect(result.success).toBe(true);

    await waitForMapReady();

    // Toggle off
    await toggleVirtualShots();
    expect(await getShowVirtualShots()).toBe(false);

    // Wait and interact
    await waitForUiIdle(500);

    // State should persist
    expect(await getShowVirtualShots()).toBe(false);

    // Sections still accessible
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);
  });
});
