/**
 * Reverse Section end-to-end (#24).
 *
 * Covers the three menu surfaces that expose the action, the confirm dialog's
 * left/right choice, the multi-select entry, and the Edit Section dialog's
 * disabled-while-dirty rule.
 */
import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
} from './helpers/app';

type StationRef = { section_id: number; station_index: number };

function buildShot(index: number) {
  const base = index + 1;
  return {
    azimuth_in: 10 * base,
    azimuth_out: 10 * base,
    length: 5 + base,
    depth_in: -1 * base,
    depth_out: -1.5 * base,
    left: 0.5 * base,
    right: 0.7 * base,
    up: 0.9 * base,
    down: 0.4 * base,
  };
}

async function setup(page: Page, sectionCount = 1) {
  await setupMockedPage(page);
  await createProject(page, 'Reverse Section');

  await seedProjectWithSections(
    page,
    Array.from({ length: sectionCount }, (_, s) => ({
      name: `Section ${s + 1}`,
      direction: 'in' as const,
      shots: Array.from({ length: 3 }, (_, idx) => buildShot(idx + s * 3)),
    }))
  );

  await waitForMapReady(page);
  await waitForNoDialogs(page);

  const ids = await page.evaluate(() => {
    const state = (window as any).__E2E_TEST__.projectStore.getState();
    return (state.project?.sections ?? []).map((s: any) => s.id) as number[];
  });
  if (ids.length !== sectionCount) {
    throw new Error(`Expected ${sectionCount} sections, got ${ids.length}`);
  }
  return ids;
}

async function openContextMenu(page: Page, target: Record<string, unknown>) {
  await page.evaluate(
    ({ target }) => {
      (window as any).__E2E_TEST__.uiStore.getState().openDialog('context-menu', {
        target,
        position: { x: 140, y: 140 },
      });
    },
    { target }
  );
}

type ShotSnapshot = {
  id: number;
  length: number;
  azimuth_in: number;
  left: number | null;
  right: number | null;
};

async function readShots(page: Page, sectionId: number): Promise<ShotSnapshot[]> {
  return page.evaluate((id) => {
    const state = (window as any).__E2E_TEST__.projectStore.getState();
    const section = state.project.sections.find((s: any) => s.id === id);
    return (section?.shots ?? []).map((s: any) => ({
      id: s.id,
      length: s.length,
      azimuth_in: s.azimuth_in,
      left: s.left,
      right: s.right,
    }));
  }, sectionId);
}

test.describe('Reverse Section', () => {
  test('is offered from the sections panel, map station and map shot menus', async ({ page }) => {
    const [sectionId] = await setup(page);
    const shotIds = await page.evaluate((id) => {
      const state = (window as any).__E2E_TEST__.projectStore.getState();
      return state.project.sections
        .find((s: any) => s.id === id)
        .shots.map((s: any) => s.id);
    }, sectionId);

    for (const target of [
      { type: 'section', sectionId },
      { type: 'station', ref: { section_id: sectionId, station_index: 0 } as StationRef },
      { type: 'shot', sectionId, shotId: shotIds[0] },
    ]) {
      await openContextMenu(page, target);
      await expect(page.getByRole('button', { name: 'Reverse Section' })).toBeVisible();
      await page.keyboard.press('Escape');
      await waitForNoDialogs(page);
    }
  });

  test('is absent from the shot-scoped datatable menu', async ({ page }) => {
    const [sectionId] = await setup(page);
    const shotIds = await page.evaluate((id) => {
      const state = (window as any).__E2E_TEST__.projectStore.getState();
      return state.project.sections.find((s: any) => s.id === id).shots.map((s: any) => s.id);
    }, sectionId);

    await openContextMenu(page, {
      type: 'datatable-shot',
      sectionId,
      shotId: shotIds[1],
      isFirst: false,
      isLast: false,
      totalShots: 3,
      sectionName: 'Section 1',
    });
    await expect(page.getByRole('button', { name: 'Reverse Section' })).toHaveCount(0);
  });

  test('reverses shot order and leaves left/right alone by default', async ({ page }) => {
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);

    await openContextMenu(page, { type: 'section', sectionId });
    await page.getByRole('button', { name: 'Reverse Section' }).click();

    const dialog = page.getByTestId('reverse-section-dialog');
    await expect(dialog).toBeVisible();
    // The left/right choice is present and starts unticked.
    await expect(page.getByTestId('reverse-swap-lr')).not.toBeChecked();
    await page.getByTestId('reverse-confirm').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    await expect.poll(async () => (await readShots(page, sectionId)).map((s) => s.length)).toEqual(
      before.map((s) => s.length).reverse()
    );

    const after = await readShots(page, sectionId);
    // Ids stay attached to positions; the records moved under them.
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    // Left/right untouched: the last shot's values are now on the first row.
    expect(after[0]!.left).toBe(before[before.length - 1]!.left);
    expect(after[0]!.right).toBe(before[before.length - 1]!.right);
  });

  test('swaps left/right when the user opts in', async ({ page }) => {
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);
    const lastBefore = before[before.length - 1]!;

    await openContextMenu(page, { type: 'section', sectionId });
    await page.getByRole('button', { name: 'Reverse Section' }).click();
    await page.getByTestId('reverse-swap-lr').check();
    await page.getByTestId('reverse-confirm').click();
    await expect(page.getByTestId('reverse-section-dialog')).not.toBeVisible({ timeout: 5000 });

    await expect.poll(async () => (await readShots(page, sectionId))[0]!.left).toBe(
      lastBefore.right
    );
    const after = await readShots(page, sectionId);
    expect(after[0]!.right).toBe(lastBefore.left);
  });

  test('offers a separate entry for a multi-section selection', async ({ page }) => {
    const ids = await setup(page, 2);

    await page.evaluate((sectionIds) => {
      const ui = (window as any).__E2E_TEST__.uiStore.getState();
      ui.setSelection({ type: 'section', sectionId: sectionIds[0] });
      ui.addToSelection({ type: 'section', sectionId: sectionIds[1] });
    }, ids);

    await openContextMenu(page, { type: 'section', sectionId: ids[0] });
    await expect(page.getByRole('button', { name: 'Reverse Section', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reverse 2 Sections' })).toBeVisible();

    await page.getByRole('button', { name: 'Reverse 2 Sections' }).click();
    const dialog = page.getByTestId('reverse-section-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('reverse-section-list').locator('li')).toHaveCount(2);
  });

  test('Edit Section dialog disables Reverse only while dirty', async ({ page }) => {
    const [sectionId] = await setup(page);

    await page.evaluate((id) => {
      (window as any).__E2E_TEST__.uiStore.getState().openDialog('edit-section', { sectionId: id });
    }, sectionId);
    await expect(page.getByTestId('edit-section-dialog')).toBeVisible();

    const reverseButton = page.getByTestId('edit-section-reverse');
    await expect(reverseButton).toBeEnabled();

    // Dirty the dialog via its section-name field.
    await page.getByTestId('section-name-input').fill('Renamed while editing');
    await expect(reverseButton).toBeDisabled();
    await expect(reverseButton).toHaveAttribute('title', /Save or discard/);
  });
});
