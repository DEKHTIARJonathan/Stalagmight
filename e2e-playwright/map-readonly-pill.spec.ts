/**
 * E2E: the Closures Computed View read-only pill offers "Resume editing", which
 * switches back to the Raw Data View (the same write the Display menu toggle
 * makes). The SpeleoDB pill's Resume editing is covered in
 * speleodb-auto-lock.spec.ts, next to the lock flow it drives.
 *
 * Parallel-safe: all state is per-page (mocked IPC + `window.__E2E_TEST__` stores).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage, createProject, seedProjectWithSections, waitForMapIdle } from './helpers/app';

type Stores = {
  __E2E_TEST__: {
    projectStore: { getState: () => { project: { sections: Array<{ id: number }>; loop_closures: unknown[] } | null }; setState: (s: unknown) => void };
    uiStore: { getState: () => { geometryMode: string; setGeometryMode: (m: string, source?: string) => void; setAppMode: (m: string) => void } };
  };
};

/** One closure the solve would actually move: without it MapCanvas reverts the view to measured. */
async function enterClosureView(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { projectStore, uiStore } = (window as unknown as Stores).__E2E_TEST__;
    const project = projectStore.getState().project!;
    const secId = project.sections[0]!.id;
    projectStore.setState({ project: { ...project, loop_closures: [...project.loop_closures, {
      id: 1, station_a: { section_id: secId, station_index: 0 }, station_b: { section_id: secId, station_index: 2 },
      path_length: 22, misclosure_distance: 0.3, error_percentage: 1.4, horizontal_misclosure: 0.25,
      vertical_misclosure: 0.15, strategy: 'Batch', is_aligned: false,
    }] } });
    uiStore.getState().setGeometryMode('closureAdjusted', 'e2e');
  });
}

const geometryMode = (page: Page) => page.evaluate(() => (window as unknown as Stores).__E2E_TEST__.uiStore.getState().geometryMode);

test.describe('Closures Computed View pill', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Synthetic closure pill');
    await seedProjectWithSections(page, [{
      name: 'Synthetic loop', direction: 'in',
      shots: [
        { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 },
        { azimuth_in: 90, azimuth_out: 270, length: 12, depth_in: -3, depth_out: -6 },
      ],
    }]);
    await waitForMapIdle(page);
  });

  test('Resume editing switches back to the Raw Data View', async ({ page }) => {
    await enterClosureView(page);
    const pill = page.getByTestId('geometry-readonly-banner');
    await expect(pill).toBeVisible();
    const resume = pill.getByTestId('geometry-readonly-resume');
    await expect(resume).toHaveText('Resume editing');
    await resume.click();
    await expect.poll(() => geometryMode(page)).toBe('measured');
    await expect(pill).toHaveCount(0);
  });

  test('no Resume where the computed view is forced (Plan)', async ({ page }) => {
    await enterClosureView(page);
    await expect(page.getByTestId('geometry-readonly-resume')).toBeVisible();
    await page.evaluate(() => (window as unknown as Stores).__E2E_TEST__.uiStore.getState().setAppMode('plan'));
    await expect(page.getByTestId('geometry-readonly-banner')).toHaveCount(0);
    await expect(page.getByTestId('geometry-readonly-resume')).toHaveCount(0);
  });
});
