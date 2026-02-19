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
 * E2E tests for the DataTable with large datasets.
 *
 * The EditableTable uses @tanstack/react-virtual with:
 *   ROW_HEIGHT = 33px
 *   overscan = 5
 *
 * Tests verify that the DataTable correctly loads and renders a large number
 * of shots, supports row selection, and displays correct shot data.
 */

const SHOT_COUNT = 120;

/** Generate a section with many shots. */
function buildLargeSection(): SectionSeed {
  const shots = Array.from({ length: SHOT_COUNT }, (_, i) => ({
    azimuth_in: (i * 3) % 360,
    azimuth_out: ((i * 3) + 180) % 360,
    length: 5 + (i % 10),
    depth_in: -(i * 0.5),
    depth_out: -((i + 1) * 0.5),
  }));

  return {
    name: 'Long Passage',
    direction: 'in' as const,
    shots,
  };
}

/** Open the DataTable via keyboard shortcut. */
async function openDataTable(page: Page): Promise<void> {
  await page.keyboard.press('Control+3');
  await expect(page.getByTestId('data-table')).toBeVisible({ timeout: 3000 });
  // Wait for table rows to render (auto-selects first section)
  await page.waitForSelector('[data-testid^="table-row-"]', { timeout: 10000 });
}

test.describe('Virtual Scrolling in DataTable', () => {
  // Seeding 120 shots can be slow; extend test timeout
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Virtual Scroll Test');
    await seedProjectWithSections(page, [buildLargeSection()]);
    await waitForMapReady(page);
    await waitForNoDialogs(page);
    await openDataTable(page);
  });

  test('DataTable virtualizes rows while preserving full section data', async ({ page }) => {
    const totalShots = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return 0;
      return e2e.projectStore.getState().project?.sections?.[0]?.shots?.length ?? 0;
    });
    expect(totalShots).toBe(SHOT_COUNT);

    const renderedRows = page.locator('[data-testid^="table-row-"]');
    const rowCount = await renderedRows.count();
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThan(SHOT_COUNT);
  });

  test('first row is visible and has correct shot ID', async ({ page }) => {
    const firstShotId = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return null;
      const state = e2e.projectStore.getState();
      const section = state.project?.sections?.[0];
      return section?.shots?.[0]?.id ?? null;
    });
    expect(firstShotId).not.toBeNull();

    const firstRow = page.getByTestId(`table-row-${firstShotId}`);
    await expect(firstRow).toBeVisible();
  });

  test('last row exists in the DOM', async ({ page }) => {
    const lastShotId = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return null;
      const state = e2e.projectStore.getState();
      const section = state.project?.sections?.[0];
      const shots = section?.shots ?? [];
      return shots[shots.length - 1]?.id ?? null;
    });
    expect(lastShotId).not.toBeNull();

    await page.evaluate((shotId) => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return;
      const section = e2e.projectStore.getState().project?.sections?.[0];
      if (!section || shotId == null) return;
      e2e.uiStore.getState().setSelection({ type: 'shot', sectionId: section.id, shotId });
    }, lastShotId);

    const lastRow = page.getByTestId(`table-row-${lastShotId}`);
    await expect(lastRow).toBeVisible({ timeout: 5000 });
  });

  test('selection via store updates row highlight', async ({ page }) => {
    const ids = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return null;
      const state = e2e.projectStore.getState();
      const section = state.project?.sections?.[0];
      return {
        sectionId: section?.id ?? 0,
        shotIds: (section?.shots ?? []).map((s: any) => s.id),
      };
    });
    if (!ids) throw new Error('No project IDs');

    // Select a shot near the end (index 100) via store
    const targetShotId = ids.shotIds[100];
    await page.evaluate(
      ({ sectionId, shotId }) => {
        const e2e = (window as any).__E2E_TEST__;
        if (!e2e) return;
        e2e.uiStore.getState().setSelection({ type: 'shot', sectionId, shotId });
      },
      { sectionId: ids.sectionId, shotId: targetShotId },
    );

    await page.waitForTimeout(300);

    // The target row should have data-selected attribute
    const targetRow = page.getByTestId(`table-row-${targetShotId}`);
    await expect(targetRow).toHaveAttribute('data-selected', 'true');
  });

  test('row click selects shot in large table', async ({ page }) => {
    const firstRow = page.locator('[data-testid^="table-row-"]').first();
    await firstRow.click();

    // Row should have selected state
    await expect(firstRow).toHaveAttribute('data-selected', 'true');
  });

  test('selected row has visual highlight class', async ({ page }) => {
    const firstRow = page.locator('[data-testid^="table-row-"]').first();
    await firstRow.click();

    // Selected row gets bg-accent-20 class
    await expect(firstRow).toHaveClass(/bg-accent-20/);
  });

  test('DataTable section selector shows section name', async ({ page }) => {
    const sectionSelect = page.getByTestId('data-table-section-select');
    await expect(sectionSelect).toBeVisible();
    await expect(sectionSelect).toContainText('Long Passage');
  });
});
