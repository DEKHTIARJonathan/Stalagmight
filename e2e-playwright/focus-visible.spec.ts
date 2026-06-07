import { test, expect } from './fixtures/coverage';
import { setupMockedPage, seedProjectWithSections, waitForMapReady, createProject } from './helpers/app';

/**
 * The keyboard focus ring (the Tailwind focus-visible:ring utilities) must only
 * appear during keyboard navigation, not on mouse clicks — while the element is
 * still focused. Verified via :focus-visible, which gates those utilities.
 */
test.describe('Focus ring (keyboard-only)', () => {
  test('clicking focuses without the focus ring; keyboard nav shows it', async ({ page }) => {
    await setupMockedPage(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Focus Test');
    await seedProjectWithSections(page, [
      { name: 'Main Line', direction: 'in', shots: [{ azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -2, depth_out: -3, left: 1, right: 1, up: 1, down: 1 }] },
      { name: 'Side Passage', direction: 'out', shots: [{ azimuth_in: 90, azimuth_out: 270, length: 8, depth_in: -3, depth_out: -4, left: 1, right: 1, up: 1, down: 1 }] },
    ]);
    await waitForMapReady(page);

    const ids: number[] = await page.evaluate(() =>
      (window as unknown as { __E2E_TEST__: { projectStore: { getState: () => { project: { sections: { id: number }[] } } } } })
        .__E2E_TEST__.projectStore.getState().project.sections.map((s) => s.id),
    );

    const row0 = page.locator(`[data-testid="section-row-${ids[0]}"]`);
    await row0.click();
    // Clicked: the element is focused, but NOT :focus-visible — so the
    // focus-visible:ring utilities don't paint (the focus ring is suppressed).
    expect(await row0.evaluate((el) => el.matches(':focus'))).toBe(true);
    expect(await row0.evaluate((el) => el.matches(':focus-visible'))).toBe(false);

    // Keyboard navigation (roving arrow keys) moves focus → :focus-visible → ring.
    await page.keyboard.press('ArrowDown');
    const row1 = page.locator(`[data-testid="section-row-${ids[1]}"]`);
    expect(await row1.evaluate((el) => el.matches(':focus'))).toBe(true);
    expect(await row1.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  });
});
