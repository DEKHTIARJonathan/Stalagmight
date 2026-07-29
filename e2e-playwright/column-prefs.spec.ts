import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
  type SectionSeed,
} from './helpers/app';

/**
 * E2E tests for data-table column preferences (hide / reorder) and their
 * persistence through the debounced `update_data_table_view` call.
 *
 * Honesty note: the mock stores the view state in memory and folds it back
 * into get_config's panels, so these tests pin (a) the exact IPC payload the
 * debounce sends and (b) the config re-sync round trip the frontend performs
 * after saving - NOT real on-disk persistence (that's the Rust
 * update_data_table_view_impl tests).
 *
 * Calls are recorded in __MOCK_DATA_TABLE_VIEW_CALLS__ (camelCase payloads).
 * Default panels config hides section_id + shot_id and shows azimuth as avg /
 * inclination off, so the visible shot columns start as: _warnings, length,
 * _azimuth_avg, depth_in, depth_out, left, right, up, down, kind,
 * comment.
 */

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Column Prefs Section',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 45, length: 10, depth_in: 0, depth_out: -1 },
      { azimuth_in: 90, azimuth_out: 90, length: 20, depth_in: -1, depth_out: -2 },
      { azimuth_in: 135, azimuth_out: 135, length: 30, depth_in: -2, depth_out: -3 },
    ],
  },
];

async function getViewCalls(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => ((window as any).__MOCK_DATA_TABLE_VIEW_CALLS__ ?? []) as Array<Record<string, unknown>>);
}

/** panels section of the in-memory config (re-synced via get_config after a save). */
async function getPanelsConfig(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as any).__E2E_TEST__?.projectStore.getState().config?.panels ?? {});
}

/** Visible grid column keys, in DOM order. */
async function visibleHeaderKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="grid-header-"]')).map((el) =>
      ((el as HTMLElement).dataset.testid ?? '').replace('grid-header-', ''),
    ),
  );
}

/** Open the DataTable via keyboard shortcut. */
async function openDataTable(page: Page): Promise<void> {
  await page.keyboard.press('Control+3');
  await expect(page.getByTestId('data-table')).toBeVisible({ timeout: 3000 });
  await expect(page.getByTestId('grid-header-length')).toBeVisible({ timeout: 5000 });
}

/** Wait for the debounced save to fire, then return its single recorded call. */
async function waitForSingleViewCall(page: Page): Promise<Record<string, unknown>> {
  await page.waitForFunction(
    () => (((window as any).__MOCK_DATA_TABLE_VIEW_CALLS__ ?? []) as unknown[]).length >= 1,
    undefined,
    { timeout: 5000 },
  );
  const calls = await getViewCalls(page);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

test.describe('Data table column preferences', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Column Prefs Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await waitForNoDialogs(page);
    await openDataTable(page);
  });

  test('eye-menu toggles coalesce into one debounced update_data_table_view call', async ({ page }) => {
    // The init from config must not re-save itself.
    expect(await getViewCalls(page)).toHaveLength(0);

    await page.getByTestId('data-table-columns-menu').click();
    const dropdown = page.getByTestId('data-table-columns-dropdown');
    await expect(dropdown).toBeVisible();

    // Hide Comment, show Shot ID - two quick toggles, one debounced save.
    await dropdown.getByTestId('col-vis-comment').click();
    await dropdown.getByTestId('col-vis-shot_id').click();
    await page.keyboard.press('Escape');

    // The grid follows immediately...
    await expect(page.getByTestId('grid-header-comment')).toHaveCount(0);
    await expect(page.getByTestId('grid-header-shot_id')).toBeVisible();
    // ...but the save is debounced, not per-toggle.
    expect(await getViewCalls(page)).toHaveLength(0);

    const call = await waitForSingleViewCall(page);
    expect(call.hiddenColumns).toEqual(['comment', 'section_id']);
    expect(call).toMatchObject({ azimuthMode: 'avg', inclinationMode: 'off' });

    // Round trip: the post-save loadConfig() re-reads get_config, whose panels
    // now carry the stored view state.
    await page.waitForFunction(
      () => {
        const hidden = ((window as any).__E2E_TEST__?.projectStore.getState().config?.panels
          ?.data_table_shot_hidden_columns ?? []) as string[];
        return hidden.includes('comment') && !hidden.includes('shot_id');
      },
      undefined,
      { timeout: 5000 },
    );
    expect((await getPanelsConfig(page)).data_table_shot_hidden_columns).toEqual(['comment', 'section_id']);
  });

  test('dragging a header reorders the columns and persists the new order', async ({ page }) => {
    expect(await getViewCalls(page)).toHaveLength(0);
    expect((await visibleHeaderKeys(page)).slice(0, 5)).toEqual([
      '_warnings',
      'length',
      '_azimuth_avg',
      'depth_in',
      'depth_out',
    ]);

    // Select the depth_out column, then drag its header before length (drop
    // on the target header's left half).
    const source = page.getByTestId('grid-header-depth_out');
    await source.click();
    const from = (await source.boundingBox())!;
    const to = (await page.getByTestId('grid-header-length').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width * 0.25, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();

    await expect(page.getByTestId('grid-selection-overlay')).toBeVisible();
    expect((await visibleHeaderKeys(page)).slice(0, 5)).toEqual([
      '_warnings',
      'depth_out',
      'length',
      '_azimuth_avg',
      'depth_in',
    ]);

    // The persisted order is the FULL key list (hidden columns keep their slots
    // so they reappear in place when re-shown). Assert on the LATEST recorded
    // `update_data_table_view` call - its order has depth_out immediately before
    // length - never an exact call count or the first call. Under slower /
    // contended CI timing the debounced save (DataTable.tsx) was observed to
    // record more than one call and/or an earlier call carrying a non-final
    // order, so the old "exactly one call, read calls[0]" assertion flaked two
    // ways on the self-hosted nightly runner. The trailing debounce always
    // wins, so the latest recorded call is authoritative. (The post-save
    // loadConfig() re-sync is NOT the cause - its re-seed effect is ref-guarded
    // against re-firing the save.)
    await page.waitForFunction(
      () => {
        const calls = ((window as any).__MOCK_DATA_TABLE_VIEW_CALLS__ ?? []) as Array<{
          columnOrder?: string[];
        }>;
        const order = (calls[calls.length - 1]?.columnOrder ?? []) as string[];
        return order.indexOf('depth_out') === order.indexOf('length') - 1;
      },
      undefined,
      { timeout: 5000 },
    );
    const recorded = await getViewCalls(page);
    const order = recorded[recorded.length - 1]!.columnOrder as string[];
    expect(order.indexOf('depth_out')).toBe(order.indexOf('length') - 1);
    expect(order).toContain('section_id');
    expect(order).toContain('shot_id');

    // The post-save config re-sync settles on that same persisted order.
    await expect
      .poll(async () => (await getPanelsConfig(page)).data_table_shot_column_order, { timeout: 5000 })
      .toEqual(order);
  });

  test('dragging a column edge persists the new width, and only on release', async ({ page }) => {
    // Count only calls that actually carry a width for `length`. A bare call
    // count races the table's own settling snapshot, which this file documents
    // above and which carries an EMPTY columnWidths - that flaked this test on
    // its first run.
    const widthCallCount = async (): Promise<number> =>
      (await getViewCalls(page)).filter(
        (c) => (c.columnWidths as Record<string, number> | undefined)?.length !== undefined,
      ).length;

    expect(await widthCallCount()).toBe(0);

    const header = page.getByTestId('grid-header-length');

    // Grab the resize edge and widen the column by ~60px, pausing mid-drag: the
    // width is committed on mouse-up, so nothing should be recorded yet.
    // hover() rather than a mouse.move to a captured boundingBox - the handle is
    // only a few px wide and straddles the column boundary, so a raw move landed
    // beside it under parallel load and the drag silently did nothing.
    const handle = page.getByTestId('grid-col-resize-length');
    await handle.hover();
    // Measure only once the pointer is settled on the handle, so `before` is the
    // laid-out width rather than a mid-settle one.
    const before = (await header.boundingBox())!;
    await page.mouse.down();
    const grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 8 });

    // The grid follows the pointer immediately...
    await expect.poll(async () => (await header.boundingBox())!.width).toBeGreaterThan(before.width + 40);
    // ...but no width has been persisted yet. Were the width lifted to the host
    // as controlled state, this would already be writing once per pixel.
    expect(await widthCallCount()).toBe(0);

    await page.mouse.up();

    // The debounce can emit an interim snapshot, so poll the LATEST call rather
    // than asserting a count or reading calls[0] (#171).
    await expect
      .poll(
        async () => {
          const calls = await getViewCalls(page);
          const widths = calls[calls.length - 1]?.columnWidths as Record<string, number> | undefined;
          return widths?.length;
        },
        { timeout: 5000 },
      )
      .toBeGreaterThan(before.width + 40);

    // Integers only - the persisted config stores u32.
    const calls = await getViewCalls(page);
    const persisted = calls[calls.length - 1]!.columnWidths as Record<string, number>;
    expect(Number.isInteger(persisted.length)).toBe(true);

    // The post-save loadConfig() re-sync settles on the same width.
    await expect
      .poll(
        async () =>
          ((await getPanelsConfig(page)).data_table_shot_column_widths as Record<string, number>)?.length,
        { timeout: 5000 },
      )
      .toBe(persisted.length);
  });

  test('header right-click hide entry hides the column and persists', async ({ page }) => {
    expect(await getViewCalls(page)).toHaveLength(0);

    const menu = page.getByTestId('data-table-header-menu');
    // The right-click → `contextmenu` → menu-open gesture intermittently does not
    // register under CPU load: the menu never mounts (confirmed by repro - the
    // element count is 0 at failure, i.e. NOT a slow paint, so a longer
    // `toBeVisible` timeout cannot help). Retry the whole GESTURE, re-resolving the
    // header locator each attempt, until the menu actually opens. This is a
    // deterministic fix for a flaky input, not a masked timeout. (#171)
    await expect(async () => {
      await page.getByTestId('grid-header-comment').click({ button: 'right' });
      await expect(menu).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await menu.getByRole('button', { name: 'Hide Comment' }).click();

    await expect(page.getByTestId('grid-header-comment')).toHaveCount(0);

    // The debounced view-save can emit an interim snapshot (e.g. the pre-hide
    // [section_id, shot_id] state from the table settling) before the Hide save
    // lands, so grabbing the *first* recorded call races. Poll the latest call
    // until it settles on the expected hidden set. #171.
    await expect
      .poll(
        async () => {
          const calls = await getViewCalls(page);
          return calls[calls.length - 1]?.hiddenColumns;
        },
        { timeout: 5000 },
      )
      .toEqual(['comment', 'section_id', 'shot_id']);

    await page.waitForFunction(
      () => {
        const hidden = ((window as any).__E2E_TEST__?.projectStore.getState().config?.panels
          ?.data_table_shot_hidden_columns ?? []) as string[];
        return hidden.includes('comment');
      },
      undefined,
      { timeout: 5000 },
    );
    expect((await getPanelsConfig(page)).data_table_shot_hidden_columns).toEqual([
      'comment',
      'section_id',
      'shot_id',
    ]);
  });
});
