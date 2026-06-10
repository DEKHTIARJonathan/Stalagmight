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
 * after saving — NOT real on-disk persistence (that's the Rust
 * update_data_table_view_impl tests).
 *
 * Calls are recorded in __MOCK_DATA_TABLE_VIEW_CALLS__ (camelCase payloads).
 * Default panels config hides section_id + shot_id and shows azimuth as avg /
 * inclination off, so the visible shot columns start as: _warnings, length,
 * _azimuth_avg, depth_in, depth_out, left, right, up, down, is_reference,
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

    // Hide Comment, show Shot ID — two quick toggles, one debounced save.
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

    // The persisted order is the FULL key list (hidden columns keep their
    // slots so they reappear in place when re-shown).
    const call = await waitForSingleViewCall(page);
    const order = call.columnOrder as string[];
    expect(order.indexOf('depth_out')).toBe(order.indexOf('length') - 1);
    expect(order).toContain('section_id');
    expect(order).toContain('shot_id');

    await page.waitForFunction(
      () => {
        const stored = ((window as any).__E2E_TEST__?.projectStore.getState().config?.panels
          ?.data_table_shot_column_order ?? []) as string[];
        return stored.length > 0;
      },
      undefined,
      { timeout: 5000 },
    );
    expect((await getPanelsConfig(page)).data_table_shot_column_order).toEqual(order);
  });

  test('header right-click hide entry hides the column and persists', async ({ page }) => {
    expect(await getViewCalls(page)).toHaveLength(0);

    await page.getByTestId('grid-header-comment').click({ button: 'right' });
    const menu = page.getByTestId('data-table-header-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'Hide Comment' }).click();

    await expect(page.getByTestId('grid-header-comment')).toHaveCount(0);

    const call = await waitForSingleViewCall(page);
    expect(call.hiddenColumns).toEqual(['comment', 'section_id', 'shot_id']);

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
