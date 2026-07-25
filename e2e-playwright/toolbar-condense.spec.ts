import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage, createProject, waitForNoDialogs } from './helpers/app';

/**
 * E2E for the SingleSystemView Toolbar progressive condensation. As the left
 * (file/history) and right (tools/display) clusters run out of room to clear the
 * absolutely-centered mode carousel, labels drop in a fixed priority order:
 *   1. "Display" text  -> eye + caret only
 *   2. "Import" text   -> yellow import icon only
 *   3. Undo/Redo text  -> undo/redo icons only
 *   4. tighten padding around the icon buttons
 *
 * The carousel is position:absolute (no CSS overflow), so this is measured by rects,
 * which jsdom can't do - hence an e2e. We assert the width-independent PRIORITY
 * INVARIANT (a later stage never precedes an earlier) across a width sweep, plus the
 * endpoints.
 */

interface CondenseState {
  displayHidden: boolean;
  importHidden: boolean;
  historyHidden: boolean;
}

async function readState(page: Page): Promise<CondenseState> {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="toolbar"]');
    const text = (sel: string) => bar?.querySelector(sel)?.textContent ?? '';
    return {
      displayHidden: !text('[data-testid="display-menu-button"]').includes('Display'),
      importHidden: !text('[data-testid="toolbar-import-button"]').includes('Import'),
      historyHidden: !text('[data-testid="toolbar-undo-button"]').includes('Undo'),
    };
  });
}

test.describe('SingleSystemView Toolbar - progressive condensation', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Toolbar Condense Test');
    await waitForNoDialogs(page);
    await expect(page.getByTestId('toolbar')).toBeVisible();
    await expect(page.getByTestId('display-menu-button')).toBeVisible();
  });

  test('drops labels in priority order and restores them when space returns', async ({ page }) => {
    // Wide: nothing condensed - all three labels present.
    await page.setViewportSize({ width: 1600, height: 800 });
    await expect
      .poll(async () => JSON.stringify(await readState(page)))
      .toBe(JSON.stringify({ displayHidden: false, importHidden: false, historyHidden: false }));

    // Sweep wide -> narrow; at EVERY width the priority invariant must hold:
    // historyHidden ⇒ importHidden ⇒ displayHidden.
    for (const width of [1600, 1100, 860, 720, 620, 540, 460]) {
      await page.setViewportSize({ width, height: 800 });
      const s = await readState(page);
      if (s.historyHidden) expect(s.importHidden, `w=${width}`).toBe(true);
      if (s.importHidden) expect(s.displayHidden, `w=${width}`).toBe(true);
    }

    // Narrow: the "Display" text is dropped first (stage 1 always fires under pressure).
    await page.setViewportSize({ width: 460, height: 800 });
    await expect.poll(async () => (await readState(page)).displayHidden).toBe(true);
    // The condensed Display button keeps an accessible name (eye + caret only).
    await expect(page.getByTestId('display-menu-button')).toHaveAttribute('aria-label', /.+/);

    // Restore width: everything expands back (reset-then-step-up).
    await page.setViewportSize({ width: 1600, height: 800 });
    await expect
      .poll(async () => JSON.stringify(await readState(page)))
      .toBe(JSON.stringify({ displayHidden: false, importHidden: false, historyHidden: false }));
  });
});
