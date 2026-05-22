import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject, seedProjectWithSections, type SectionSeed } from './helpers/app';

/**
 * Regression: the sections sidebar must scroll when its content overflows.
 *
 * The list lives in a `flex-1 overflow-auto` container, but its wrapper in
 * SingleSystemView was missing `h-full`, breaking the height chain so the panel
 * grew to fit all sections and got clipped by an `overflow-hidden` ancestor —
 * i.e. nothing scrolled (two-finger / wheel scroll did nothing).
 */
test.describe('Sections panel scrolling', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('sections list is scrollable when content overflows', async ({ page }) => {
    await createProject(page, 'Scroll Test');

    // Seed enough sections to overflow the sidebar at the default viewport.
    const seeds: SectionSeed[] = Array.from({ length: 40 }, (_, i) => ({
      name: `Section ${i + 1}`,
      shots: [],
    }));
    await seedProjectWithSections(page, seeds);

    const list = page.getByTestId('sections-list');
    await expect(list).toBeVisible();

    // The container must have a bounded height with overflowing content. If the
    // height chain is broken, clientHeight == scrollHeight (no overflow → no scroll).
    const { clientHeight, scrollHeight } = await list.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    // And it must actually scroll.
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const scrolledTop = await list.evaluate((el) => el.scrollTop);
    expect(scrolledTop).toBeGreaterThan(0);
  });
});
