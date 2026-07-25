import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

/**
 * E2E tests for the Recent Projects enhancements (#46, #47, #48):
 *   - file path shown under each card (full path on hover)
 *   - relative "Edited" time with the exact timestamp on hover
 *   - persisted "Sort by" control (field + direction)
 *
 * Mock recent projects (from mocks/tauri-ipc.ts), newest → oldest:
 *   Cave System Alpha   /projects/cave-alpha.stalx   5 sections  now
 *   Underwater Cave Beta /projects/cave-beta.stalx   3 sections  -1 day
 *   Deep Cave Gamma     /projects/cave-gamma.stalx   8 sections  -2 days
 *   Local Survey…       /projects/local-survey.stalx 2 sections  -3 days
 */

const ALPHA = 'system-card-/projects/cave-alpha.stalx';
const BETA = 'system-card-/projects/cave-beta.stalx';
const GAMMA = 'system-card-/projects/cave-gamma.stalx';
const LOCAL = 'system-card-/projects/local-survey.stalx';

async function switchToListTab(page: Page): Promise<void> {
  const listTab = page.getByTestId('globalview-view-toggle-list');
  await expect(listTab).toBeVisible();
  await listTab.click();
  await expect(page.getByTestId(ALPHA)).toBeVisible();
}

/** Document order of the rendered system cards (by their data-testid). */
async function cardOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="system-card-/"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
}

/** Pick a sort field from the custom Select. */
async function selectSortField(page: Page, label: string): Promise<void> {
  await page.getByTestId('recent-sort-field').click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test.describe('GlobalView Recent Projects - path, relative time, sort', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await switchToListTab(page);
  });

  test('shows the elided file path under each card, revealed in full on hover (no tooltip)', async ({ page }) => {
    const path = page.getByTestId(ALPHA).getByTestId('system-card-path');
    await expect(path).toBeVisible();
    await expect(path).toHaveAttribute('data-full-path', '/projects/cave-alpha.stalx');

    await path.hover();
    // No tooltip anymore - the full path is revealed in place (scrolls if it overflows).
    await expect(page.locator('[role="tooltip"]', { hasText: '/projects/cave-alpha.stalx' })).toHaveCount(0);
    await expect(path).toContainText('/projects/cave-alpha.stalx');
  });

  test('an overflowing path scrolls (marquee) in place on hover, not a tooltip', async ({ page }) => {
    // Force the path clip box narrow so the full path overflows regardless of length.
    await page.addStyleTag({ content: '[data-testid="system-card-path"]{max-width:60px !important}' });
    const path = page.getByTestId(ALPHA).getByTestId('system-card-path');
    await path.hover();
    const overlay = path.locator('[data-elided-overlay]');
    await expect(overlay).toHaveCount(1); // marquee overlay appears
    // Out of flow, so it can't widen the table column (the reported bug).
    expect(await overlay.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
    expect(await overlay.evaluate((el) => getComputedStyle(el).animationName)).toContain('elided-path-scroll');
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
  });

  test('table view: sticky header pins flush to the top when scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 280 }); // short → the list scrolls
    await page.getByTestId('recent-density-table').click();
    await page.getByTestId('globalview-list-table').waitFor({ state: 'visible' });
    const gap = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="globalview-list-table"]') as HTMLElement;
      let sc: HTMLElement | null = t.parentElement;
      while (sc) {
        const o = getComputedStyle(sc).overflowY;
        if (o === 'auto' || o === 'scroll') break;
        sc = sc.parentElement;
      }
      if (!sc) return -999;
      sc.scrollTop = 150;
      const th = t.querySelector('thead th') as HTMLElement;
      return Math.round(th.getBoundingClientRect().top - sc.getBoundingClientRect().top);
    });
    expect(Math.abs(gap)).toBeLessThanOrEqual(1); // no gap above the pinned header
  });

  test('shows relative edited time, with the exact timestamp on hover', async ({ page }) => {
    const betaModified = page.getByTestId(BETA).getByTestId('system-card-modified');
    await expect(betaModified).toBeVisible();
    // -1 day renders as "yesterday" in en locale (Intl.RelativeTimeFormat).
    await expect(betaModified).toContainText(/yesterday/i);

    await betaModified.hover();
    // Absolute tooltip includes a 4-digit year and a HH:MM time.
    const tooltip = page.locator('[role="tooltip"]').last();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(/\d{4}/);
    await expect(tooltip).toContainText(/\d{1,2}:\d{2}/);
  });

  test('sorts the list and persists field + direction across reloads', async ({ page }) => {
    // Default: last edited, newest first.
    expect(await cardOrder(page)).toEqual([ALPHA, BETA, GAMMA, LOCAL]);

    // Switch to Name; direction is still descending → reverse alphabetical.
    await selectSortField(page, 'Name');
    expect(await cardOrder(page)).toEqual([BETA, LOCAL, GAMMA, ALPHA]);

    // Flip to ascending → alphabetical by name.
    await page.getByTestId('recent-sort-direction').click();
    expect(await cardOrder(page)).toEqual([ALPHA, GAMMA, LOCAL, BETA]);

    // Preference survives a reload (persisted in localStorage).
    await page.reload();
    await switchToListTab(page);
    expect(await cardOrder(page)).toEqual([ALPHA, GAMMA, LOCAL, BETA]);
  });

  test('sorts by section count', async ({ page }) => {
    await selectSortField(page, 'Section count');
    // Descending by section_count: Gamma(8), Alpha(5), Beta(3), Local(2).
    expect(await cardOrder(page)).toEqual([GAMMA, ALPHA, BETA, LOCAL]);
  });

  test('sorts by last opened (backend recency order), reversible', async ({ page }) => {
    // Switch away first so the change back is observable.
    await selectSortField(page, 'Name');
    await selectSortField(page, 'Last opened');
    // Descending = most-recently-opened first = the order the backend returns.
    expect(await cardOrder(page)).toEqual([ALPHA, BETA, GAMMA, LOCAL]);

    // Ascending = oldest-opened first.
    await page.getByTestId('recent-sort-direction').click();
    expect(await cardOrder(page)).toEqual([LOCAL, GAMMA, BETA, ALPHA]);
  });
});
