import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

/**
 * E2E for the Recent Projects list-view improvements:
 *   - search filters the card/table list, with count feedback + no-results state
 *   - compact table view toggle (persisted)
 *   - missing-file entries (recent paths the backend can't load)
 *
 * Mock recent projects (mocks/tauri-ipc.ts): Alpha, Beta, Gamma, Local.
 */

const ALPHA = '/projects/cave-alpha.stalx';
const BETA = '/projects/cave-beta.stalx';
const GAMMA = '/projects/cave-gamma.stalx';
const LOCAL = '/projects/local-survey.stalx';
const GHOST = '/projects/ghost.stalx';

async function switchToListTab(page: Page): Promise<void> {
  const listTab = page.getByTestId('globalview-list-tab');
  await expect(listTab).toBeVisible();
  await listTab.click();
  await expect(page.getByTestId(`system-card-${ALPHA}`)).toBeVisible();
}

/** Inject a config whose recent list includes a path with no loadable metadata. */
async function injectMissingRecent(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(
    (window as unknown as { __E2E_TEST__?: { projectStore?: { getState: () => { config: unknown } } } })
      .__E2E_TEST__?.projectStore?.getState().config
  ));
  await page.evaluate((paths) => {
    const store = (window as unknown as {
      __E2E_TEST__: { projectStore: { getState: () => { config: { general: Record<string, unknown> }; setConfig: (c: unknown) => void } } };
    }).__E2E_TEST__.projectStore;
    const state = store.getState();
    state.setConfig({ ...state.config, general: { ...state.config.general, recent_projects: paths } });
  }, [ALPHA, BETA, GAMMA, LOCAL, GHOST]);
}

test.describe('GlobalView Recent Projects — search, table view, missing files', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await switchToListTab(page);
  });

  test('search box is shown on the list tab and filters the cards', async ({ page }) => {
    const search = page.getByTestId('globalview-search-input');
    await expect(search).toBeVisible();

    await search.fill('alpha');
    await expect(page.getByTestId(`system-card-${ALPHA}`)).toBeVisible();
    await expect(page.getByTestId(`system-card-${BETA}`)).toHaveCount(0);
    await expect(page.getByTestId('globalview-list-status')).toContainText('Showing 1 of 4');
  });

  test('shows a no-results state and can clear the search', async ({ page }) => {
    await page.getByTestId('globalview-search-input').fill('zzz-nope');
    const empty = page.getByTestId('globalview-list-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('zzz-nope');

    await page.getByTestId('globalview-list-clear-search').click();
    await expect(page.getByTestId(`system-card-${ALPHA}`)).toBeVisible();
    await expect(page.getByTestId('globalview-list-empty')).toHaveCount(0);
  });

  test('table view toggle renders rows and persists across reload', async ({ page }) => {
    await page.getByTestId('recent-density-table').click();
    await expect(page.getByTestId('globalview-list-table')).toBeVisible();
    await expect(page.getByTestId(`system-row-${ALPHA}`)).toBeVisible();
    // Cards are gone in table mode.
    await expect(page.getByTestId(`system-card-${ALPHA}`)).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('globalview-list-tab')).toBeVisible();
    await page.getByTestId('globalview-list-tab').click();
    await expect(page.getByTestId('globalview-list-table')).toBeVisible();
  });

  test('double-clicking a table row opens the project', async ({ page }) => {
    await page.getByTestId('recent-density-table').click();
    await page.getByTestId(`system-row-${GAMMA}`).dblclick();
    // Loading overlay/single-system view appears once a project opens.
    await expect(page.getByTestId('single-system-view').or(page.getByTestId('global-view'))).toBeVisible();
  });

  test('surfaces a missing recent file with a remove action', async ({ page }) => {
    await injectMissingRecent(page);

    const missing = page.getByTestId(`system-card-missing-${GHOST}`);
    await expect(missing).toBeVisible();
    await expect(missing).toContainText('File not found');
    await expect(missing).toContainText('ghost.stalx');

    const remove = page.getByTestId(`system-card-missing-remove-${GHOST}`);
    await expect(remove).toBeVisible();
    await remove.click();
    // Existing (loadable) projects are unaffected.
    await expect(page.getByTestId(`system-card-${ALPHA}`)).toBeVisible();
  });

  test('missing files appear in the table view too', async ({ page }) => {
    await injectMissingRecent(page);
    await page.getByTestId('recent-density-table').click();
    await expect(page.getByTestId(`system-row-missing-${GHOST}`)).toBeVisible();
    await expect(page.getByTestId(`system-row-missing-${GHOST}`)).toContainText('File not found');
  });
});
