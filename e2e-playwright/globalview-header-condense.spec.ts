import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

/**
 * E2E for the GlobalView start-screen header progressive condensation. When the grid
 * header cannot fit, it drops labels in a fixed priority order to reclaim width:
 *   1. the "Stalagmight" brand text
 *   2. the New Project / Open+Import button labels (icon only)
 *   3. the Map / List toggle labels (icon only)
 *
 * jsdom can't exercise this (it needs real layout: scrollWidth vs clientWidth), so it
 * lives here. We assert the width-independent PRIORITY INVARIANT (a later stage never
 * fires before an earlier one) across a width sweep, plus the two endpoints.
 */

interface CondenseState {
  brandHidden: boolean;
  actionsHidden: boolean;
  tabsHidden: boolean;
}

async function readState(page: Page): Promise<CondenseState> {
  return page.evaluate(() => {
    const header = document.querySelector('[data-testid="global-view"] header');
    const text = (sel: string) => header?.querySelector(sel)?.textContent?.trim() ?? '';
    return {
      brandHidden: (header?.querySelector('h1')?.textContent ?? '') === '',
      actionsHidden: text('[data-testid="new-project-button"]') === '',
      tabsHidden: text('[data-testid="globalview-view-toggle-map"]') === '',
    };
  });
}

test.describe('GlobalView header - progressive condensation', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    // The Map|List toggle (stage 3) only renders with recent items; the mocked page
    // seeds them, so the toggle is present.
    await expect(page.getByTestId('globalview-view-toggle-map')).toBeVisible();
  });

  test('drops labels in priority order and restores them when space returns', async ({ page }) => {
    // Wide: nothing condensed.
    await page.setViewportSize({ width: 1400, height: 800 });
    await expect
      .poll(async () => JSON.stringify(await readState(page)))
      .toBe(JSON.stringify({ brandHidden: false, actionsHidden: false, tabsHidden: false }));

    // Sweep from wide to very narrow; at EVERY width the priority invariant must hold:
    // tabsHidden ⇒ actionsHidden ⇒ brandHidden (a later stage never precedes an earlier).
    for (const width of [1400, 900, 640, 520, 440, 380, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const s = await readState(page);
      if (s.tabsHidden) expect(s.actionsHidden, `w=${width}`).toBe(true);
      if (s.actionsHidden) expect(s.brandHidden, `w=${width}`).toBe(true);
    }

    // Very narrow: the brand text is dropped first (stage 1 always fires under pressure).
    await page.setViewportSize({ width: 320, height: 800 });
    await expect.poll(async () => (await readState(page)).brandHidden).toBe(true);
    // A condensed action button keeps an accessible name via aria-label (icon-only).
    if ((await readState(page)).actionsHidden) {
      await expect(page.getByTestId('new-project-button')).toHaveAttribute('aria-label', /.+/);
    }

    // Restore width: everything expands back (the reset-then-step-up path).
    await page.setViewportSize({ width: 1400, height: 800 });
    await expect
      .poll(async () => JSON.stringify(await readState(page)))
      .toBe(JSON.stringify({ brandHidden: false, actionsHidden: false, tabsHidden: false }));
  });
});
