/**
 * E2E: the Closures Computed View read-only pill offers "Resume editing", which
 * switches back to the Raw Data View (the same write the Display menu toggle
 * makes). The SpeleoDB pill's Resume editing is covered in
 * speleodb-auto-lock.spec.ts, next to the lock flow it drives.
 *
 * Parallel-safe: all state is per-page (mocked IPC + `window.__E2E_TEST__` stores).
 */
import { test, expect, type Locator, type Page } from './fixtures/coverage';
import { setupMockedPage, createProject, seedProjectWithSections, waitForMapIdle } from './helpers/app';
import { MAP_MIN_WIDTH } from '../src/components/SingleSystemView/layoutConstants';

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

/**
 * A narrow window with a wide pinned Sections panel: the panel yields until the map
 * column is exactly MAP_MIN_WIDTH.
 */
async function squeezeMapToMinimum(page: Page): Promise<void> {
  await page.setViewportSize({ width: 806, height: 551 });
  await page.evaluate(() => {
    (window as unknown as { __E2E_TEST__: { uiStore: { setState: (s: unknown) => void } } }).__E2E_TEST__.uiStore
      .setState({ sectionsPanelMode: 'pin', sectionsPanelOpen: true, sectionsPanelWidth: 700 });
  });
  await expect.poll(async () => Math.round((await page.getByTestId('map-canvas').boundingBox())!.width))
    .toBe(MAP_MIN_WIDTH);
}

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The pill does not overlap the +/- control, and its action is whole, inside the map and on top. */
async function expectClearOfZoomControl(page: Page, pill: Locator, action: Locator): Promise<void> {
  const zoom = (await page.getByTestId('map-canvas').locator('.maplibregl-ctrl-top-right .maplibregl-ctrl-group').boundingBox())!;
  const map = (await page.getByTestId('map-canvas').boundingBox())!;
  const pillBox = (await pill.boundingBox())!;
  const actionBox = (await action.boundingBox())!;
  expect(intersects(pillBox, zoom), `pill ${JSON.stringify(pillBox)} vs zoom ${JSON.stringify(zoom)}`).toBe(false);
  expect(actionBox.x).toBeGreaterThanOrEqual(map.x);
  expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(zoom.x);
  // Whole: as wide as its own content, not clipped by the pill.
  expect(await action.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  // On top at its centre (nothing covers it), so a click lands on it.
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('button')?.dataset.testid ?? null,
    [actionBox.x + actionBox.width / 2, actionBox.y + actionBox.height / 2]);
  expect(hit).toBe(await action.getAttribute('data-testid'));
}

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

  test('at the minimum map width the pills stay clear of the zoom control, actions whole', async ({ page }) => {
    // The map floor is in CSS px, so this one layout stands for every UI zoom: a
    // larger zoom only shrinks the CSS viewport, and the side panels yield until the
    // map is at MAP_MIN_WIDTH (what 1024x700 at 127% or 1280x720 at 150% produced).
    await squeezeMapToMinimum(page);
    await enterClosureView(page);
    const closure = page.getByTestId('geometry-readonly-banner');
    await expect(closure).toBeVisible();
    await expectClearOfZoomControl(page, closure, closure.getByTestId('geometry-readonly-resume'));

    // The SpeleoDB pill (signed out: the longest wording, with Sign in) in the same row.
    await page.evaluate(() => {
      const w = window as unknown as { __E2E_TEST__: { speleoStore: { setState: (s: unknown) => void } } };
      w.__E2E_TEST__.speleoStore.setState({ session: null, link: {
        permission: 'READ_AND_WRITE', editState: 'read-only', lockHolder: null, lockedByOther: false,
        hasUnpushedEdits: false, unwound: false, undoMode: 'full', remoteState: 'up_to_date',
        noAccess: false, serverError: null,
      } });
    });
    const speleo = page.getByTestId('speleodb-readonly-banner');
    await expect(speleo).toBeVisible();
    await expectClearOfZoomControl(page, speleo, speleo.getByTestId('speleodb-readonly-login'));

    // Back to the closure pill: its action is not just visible but the thing clicked.
    await page.evaluate(() => {
      const w = window as unknown as { __E2E_TEST__: { speleoStore: { setState: (s: unknown) => void } } };
      w.__E2E_TEST__.speleoStore.setState({ link: null, projectLinkKind: 'local' });
    });
    await closure.getByTestId('geometry-readonly-resume').click();
    await expect.poll(() => geometryMode(page)).toBe('measured');
  });

  test('no Resume where the computed view is forced (Plan)', async ({ page }) => {
    await enterClosureView(page);
    await expect(page.getByTestId('geometry-readonly-resume')).toBeVisible();
    await page.evaluate(() => (window as unknown as Stores).__E2E_TEST__.uiStore.getState().setAppMode('plan'));
    await expect(page.getByTestId('geometry-readonly-banner')).toHaveCount(0);
    await expect(page.getByTestId('geometry-readonly-resume')).toHaveCount(0);
  });
});
