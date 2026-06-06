import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage, createProject, seedProjectWithSections, type SectionSeed } from './helpers/app';

/** Read every section id in project order. */
async function getSectionIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: { sections: Array<{ id: number }> } | null } };
      };
    }).__E2E_TEST__;
    return stores?.projectStore.getState().project?.sections.map((s) => s.id) ?? [];
  });
}

/** Simulate an external (map / data table / details) hover via the store setter. */
async function setExternalSectionHover(page: Page, sectionId: number | null): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { setHoveredSectionId: (id: number | null) => void } };
      };
    }).__E2E_TEST__;
    stores?.uiStore.getState().setHoveredSectionId(id);
  }, sectionId);
}

/** First shot id in a section, or -1. */
async function getFirstShotId(page: Page, sectionId: number): Promise<number> {
  return page.evaluate((secId) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            project: { sections: Array<{ id: number; shots: Array<{ id: number }> }> } | null;
          };
        };
      };
    }).__E2E_TEST__;
    const section = stores?.projectStore.getState().project?.sections.find((s) => s.id === secId);
    return section?.shots[0]?.id ?? -1;
  }, sectionId);
}

/** Set the selection via the store, as the map / data table / details panel do. */
async function setSelection(page: Page, selection: unknown): Promise<void> {
  await page.evaluate((sel) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { setSelection: (s: unknown) => void } } };
    }).__E2E_TEST__;
    stores?.uiStore.getState().setSelection(sel);
  }, selection);
}

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

  test('external hover auto-scrolls the list, then restores scroll on un-hover', async ({ page }) => {
    await createProject(page, 'Restore Test');
    const seeds: SectionSeed[] = Array.from({ length: 40 }, (_, i) => ({
      name: `Section ${i + 1}`,
      shots: [],
    }));
    await seedProjectWithSections(page, seeds);

    const list = page.getByTestId('sections-list');
    await expect(list).toBeVisible();

    const ids = await getSectionIds(page);
    expect(ids.length).toBe(40);
    const lastId = ids[ids.length - 1]!;

    // Park the list at the top — this is the position we expect restored.
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);

    // An external hover on the off-screen last section scrolls it into view.
    await setExternalSectionHover(page, lastId);
    await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // Clearing the hover (nothing hovered anywhere) restores the pre-hover scroll.
    await setExternalSectionHover(page, null);
    await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('restores to a non-zero manual scroll position after external hover', async ({ page }) => {
    await createProject(page, 'Restore Midscroll Test');
    const seeds: SectionSeed[] = Array.from({ length: 40 }, (_, i) => ({
      name: `Section ${i + 1}`,
      shots: [],
    }));
    await seedProjectWithSections(page, seeds);

    const list = page.getByTestId('sections-list');
    await expect(list).toBeVisible();

    const ids = await getSectionIds(page);
    const firstId = ids[0]!;
    const lastId = ids[ids.length - 1]!;

    // Manually scroll to the bottom, then back up a little so both directions of
    // auto-scroll (down to last, up to first) move away from this baseline.
    const baseline = await list.evaluate((el) => {
      el.scrollTop = Math.round(el.scrollHeight / 2);
      return el.scrollTop;
    });
    expect(baseline).toBeGreaterThan(0);

    // Hover the last (below) section, then the first (above) section.
    await setExternalSectionHover(page, lastId);
    await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(baseline);
    await setExternalSectionHover(page, firstId);
    await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBeLessThan(baseline);

    // Un-hover restores the original manual position, not either hovered extreme.
    await setExternalSectionHover(page, null);
    await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBe(baseline);
  });

  test('selecting a shot scrolls to and selects the owning section row', async ({ page }) => {
    await createProject(page, 'Select Shot Scroll Test');
    // Only the last (off-screen) section has a shot to select.
    const seeds: SectionSeed[] = Array.from({ length: 40 }, (_, i) => ({
      name: `Section ${i + 1}`,
      shots:
        i === 39
          ? [{ azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 }]
          : [],
    }));
    await seedProjectWithSections(page, seeds);

    const list = page.getByTestId('sections-list');
    await expect(list).toBeVisible();

    const ids = await getSectionIds(page);
    const lastId = ids[ids.length - 1]!;
    const lastRow = page.locator(`[data-testid="section-row-${lastId}"]`);

    // Park at top; the owning row starts unselected.
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(lastRow).toHaveAttribute('aria-selected', 'false');

    // Select a shot in the last section, as the map / data table / details would.
    const shotId = await getFirstShotId(page, lastId);
    expect(shotId).toBeGreaterThan(0);
    await setSelection(page, { type: 'shot', sectionId: lastId, shotId });

    // The owning section row is now selected and revealed.
    await expect(lastRow).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test('selecting a station scrolls to and selects the owning section row', async ({ page }) => {
    await createProject(page, 'Select Station Scroll Test');
    const seeds: SectionSeed[] = Array.from({ length: 40 }, (_, i) => ({
      name: `Section ${i + 1}`,
      shots:
        i === 39
          ? [{ azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 }]
          : [],
    }));
    await seedProjectWithSections(page, seeds);

    const list = page.getByTestId('sections-list');
    await expect(list).toBeVisible();

    const ids = await getSectionIds(page);
    const lastId = ids[ids.length - 1]!;
    const lastRow = page.locator(`[data-testid="section-row-${lastId}"]`);

    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(lastRow).toHaveAttribute('aria-selected', 'false');

    // Select the section's first station (station_index 0), as the map would.
    await setSelection(page, {
      type: 'station',
      stationRef: { section_id: lastId, station_index: 0 },
    });

    await expect(lastRow).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test('selecting during a hover anchors un-hover to the selection, not the pre-hover position', async ({ page }) => {
    await createProject(page, 'Hover Select Unhover Test');
    const seeds: SectionSeed[] = Array.from({ length: 40 }, (_, i) => ({
      name: `Section ${i + 1}`,
      shots:
        i === 39
          ? [{ azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 }]
          : [],
    }));
    await seedProjectWithSections(page, seeds);

    const list = page.getByTestId('sections-list');
    await expect(list).toBeVisible();

    const ids = await getSectionIds(page);
    const lastId = ids[ids.length - 1]!;

    // Park at top — this is the pre-hover position that must NOT be restored.
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);

    // Hover the off-screen last section (as a map shot hover would) → auto-scroll.
    await setExternalSectionHover(page, lastId);
    await expect.poll(async () => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // Click to select the shot while still hovering — selection becomes the anchor.
    const shotId = await getFirstShotId(page, lastId);
    await setSelection(page, { type: 'shot', sectionId: lastId, shotId });

    // Un-hover: the list stays at the selected section, not back at the top.
    await setExternalSectionHover(page, null);
    // Give the restore effect a chance to (wrongly) run, then assert it didn't.
    await page.waitForTimeout(150);
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});
