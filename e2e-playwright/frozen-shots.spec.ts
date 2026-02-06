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
 * E2E tests for frozen shot display and edit enforcement.
 *
 * Frozen shots have their geometry locked (length, azimuth, depth) and
 * display a lock icon with a warning background. Non-geometry fields
 * (like comment) remain editable.
 *
 * Strategy: After seeding sections, open the DataTable, then inject
 * frozenShots into the store so the DataTable re-renders with frozen state.
 */

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Frozen Test Section',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: 0, depth_out: -2, comment: 'First shot' },
      { azimuth_in: 90, azimuth_out: 270, length: 12, depth_in: -2, depth_out: -4, comment: 'Second shot' },
      { azimuth_in: 135, azimuth_out: 315, length: 8, depth_in: -4, depth_out: -6, comment: 'Third shot' },
    ],
  },
];

/** Get section and shot IDs. */
async function getProjectIds(page: Page): Promise<{
  sectionId: number;
  shotIds: number[];
}> {
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
  if (!ids) throw new Error('Could not retrieve section/shot IDs');
  return ids;
}

/**
 * Inject frozen shots into the project store directly.
 * The DataTable subscribes to this state and re-renders accordingly.
 */
async function injectFrozenShots(
  page: Page,
  frozenShots: Array<{ section_id: number; shot_index: number }>,
): Promise<void> {
  await page.evaluate(
    (frozen) => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return;
      e2e.projectStore.setState({ frozenShots: frozen });
    },
    frozenShots,
  );
  // Wait for React to re-render with new frozen state
  await page.waitForTimeout(300);
}

/** Open the DataTable via keyboard shortcut. */
async function openDataTable(page: Page): Promise<void> {
  await page.keyboard.press('Control+3');
  await expect(page.getByTestId('data-table')).toBeVisible({ timeout: 3000 });
  // Wait for table rows to render (auto-selects first section)
  await page.waitForSelector('[data-testid^="table-row-"]', { timeout: 5000 });
}

test.describe('Frozen Shots', () => {
  let sectionId: number;
  let shotIds: number[];

  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Frozen Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await waitForNoDialogs(page);

    const ids = await getProjectIds(page);
    sectionId = ids.sectionId;
    shotIds = ids.shotIds;

    // Open DataTable first so it subscribes to store
    await openDataTable(page);

    // Then inject frozen shots - DataTable will re-render
    await injectFrozenShots(page, [{ section_id: sectionId, shot_index: 0 }]);
  });

  test('lock icon visible for frozen shot in warnings column', async ({ page }) => {
    const frozenIndicator = page.getByTestId(`frozen-${sectionId}-${shotIds[0]}`);
    await expect(frozenIndicator).toBeVisible();
  });

  test('frozen shot row has bg-warning-5 class', async ({ page }) => {
    const row = page.getByTestId(`table-row-${shotIds[0]}`);
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/bg-warning-5/);
  });

  test('non-frozen shots do not show lock icon', async ({ page }) => {
    // Shot at index 1 is not frozen - should not have a frozen-* testid
    const frozenIndicator = page.getByTestId(`frozen-${sectionId}-${shotIds[1]}`);
    await expect(frozenIndicator).toHaveCount(0);
  });

  test('geometry field (length) not editable on frozen shot', async ({ page }) => {
    // For frozen rows, isRowEditable returns false, so EditableCell is not rendered.
    // The cell renders as a plain <span> instead of an <input>.
    // Verify the table-cell testid (which is on the <input>) does NOT exist for frozen row.
    const frozenLengthInput = page.getByTestId(`table-cell-${shotIds[0]}-length`);
    await expect(frozenLengthInput).toHaveCount(0);

    // Also verify clicking the row's length td does not produce an input
    const row = page.getByTestId(`table-row-${shotIds[0]}`);
    const lengthTd = row.locator('td').nth(2); // length column (after warnings + id)
    await lengthTd.click();
    await page.waitForTimeout(300);

    // No editable input should appear in the frozen row
    const inputs = row.locator('input');
    await expect(inputs).toHaveCount(0);
  });

  test('non-frozen shot geometry fields remain editable', async ({ page }) => {
    // Non-frozen row should have EditableCell with table-cell testid
    const cell = page.getByTestId(`table-cell-${shotIds[1]}-length`);
    await expect(cell).toBeVisible();

    // Click to focus the input
    await cell.click();
    await expect(cell).toBeFocused();
  });

  test('multiple frozen shots in same section all display lock icons', async ({ page }) => {
    // Freeze both shot 0 and shot 2
    await injectFrozenShots(page, [
      { section_id: sectionId, shot_index: 0 },
      { section_id: sectionId, shot_index: 2 },
    ]);

    const frozen0 = page.getByTestId(`frozen-${sectionId}-${shotIds[0]}`);
    const frozen2 = page.getByTestId(`frozen-${sectionId}-${shotIds[2]}`);

    await expect(frozen0).toBeVisible();
    await expect(frozen2).toBeVisible();
  });

  test('frozen shot tooltip contains frozen text', async ({ page }) => {
    const frozenIndicator = page.getByTestId(`frozen-${sectionId}-${shotIds[0]}`);
    const title = await frozenIndicator.getAttribute('title');
    // The tooltip should contain the i18n frozen message: "Geometry locked — part of adjusted network"
    expect(title).toContain('locked');
  });
});
