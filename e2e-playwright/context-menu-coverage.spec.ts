import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
} from './helpers/app';

type StationRef = { section_id: number; station_index: number };

type MenuTargets = {
  sectionId: number;
  sectionName: string;
  shotIds: number[];
  stationRefs: StationRef[];
};

function buildShot(index: number, overrides?: Partial<Record<string, number>>) {
  const base = index + 1;
  return {
    azimuth_in: 10 * base,
    azimuth_out: 180 + 10 * base,
    length: 5 + base,
    depth_in: -1 * base,
    depth_out: -1.5 * base,
    left: 0.5 * base,
    right: 0.7 * base,
    up: 0.9 * base,
    down: 0.4 * base,
    ...overrides,
  };
}

async function setupProjectWithShots(page: Page, shotCount: number): Promise<MenuTargets> {
  await setupMockedPage(page);
  await createProject(page, 'Context Menu Coverage');

  const shots = Array.from({ length: shotCount }, (_, idx) => buildShot(idx));
  await seedProjectWithSections(page, [
    {
      name: 'Context Section',
      direction: 'in',
      shots,
    },
  ]);

  await waitForMapReady(page);
  await waitForNoDialogs(page);

  const ids = await page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: any; stations: any[] } };
      };
    }).__E2E_TEST__;

    if (!e2e) return null;

    const state = e2e.projectStore.getState();
    const section = state.project?.sections?.[0];
    const stations = (state.stations ?? [])
      .filter((s) => s.station_ref.section_id === section?.id)
      .sort((a, b) => a.station_ref.station_index - b.station_ref.station_index);

    return {
      sectionId: section?.id ?? null,
      sectionName: section?.name ?? `Section ${section?.id ?? 0}`,
      shotIds: (section?.shots ?? []).map((s: any) => s.id),
      stationRefs: stations.map((s) => s.station_ref),
    };
  });

  if (!ids || !ids.sectionId || ids.shotIds.length < 1 || ids.stationRefs.length < 1) {
    throw new Error('Failed to resolve IDs for context menu tests.');
  }

  return ids as MenuTargets;
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

test.describe('Context Menu Coverage', () => {
  test('shot menu toggles reference and routes delete dialogs', async ({ page }) => {
    const { sectionId, shotIds, sectionName } = await setupProjectWithShots(page, 3);

    const [firstShotId, midShotId] = shotIds;

    await openContextMenu(page, { type: 'shot', sectionId, shotId: firstShotId });
    await expect(page.getByRole('button', { name: 'Edit Shot' })).toBeVisible();

    await page.getByRole('button', { name: 'Mark as Reference' }).click();

    await expect.poll(async () => {
      return page.evaluate(({ sectionId, shotId }) => {
        const state = (window as any).__E2E_TEST__.projectStore.getState();
        const section = state.project.sections.find((s: any) => s.id === sectionId);
        const shot = section?.shots.find((s: any) => s.id === shotId);
        return shot?.is_reference ?? null;
      }, { sectionId, shotId: firstShotId });
    }).toBe(true);

    await openContextMenu(page, { type: 'shot', sectionId, shotId: midShotId });
    await page.getByRole('button', { name: 'Delete Shot' }).click();

    const deleteChoice = page.getByTestId('delete-shot-choice-dialog');
    await expect(deleteChoice).toBeVisible();
    await deleteChoice.getByRole('button', { name: 'Cancel' }).click();
    await expect(deleteChoice).not.toBeVisible({ timeout: 5000 });

    await openContextMenu(page, { type: 'shot', sectionId, shotId: firstShotId });
    await page.getByRole('button', { name: 'Delete Shot' }).click();

    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });

    await waitForNoDialogs(page);
  });

  test('datatable shot menu uses delete helper for mid-shot', async ({ page }) => {
    const { sectionId, shotIds, sectionName } = await setupProjectWithShots(page, 3);
    const midShotId = shotIds[1];

    await openContextMenu(page, {
      type: 'datatable-shot',
      sectionId,
      shotId: midShotId,
      isFirst: false,
      isLast: false,
      totalShots: 3,
      sectionName,
    });

    await page.getByRole('button', { name: 'Delete Shot' }).click();
    await expect(page.getByTestId('delete-shot-choice-dialog')).toBeVisible();
  });

  test('station menu exposes add-shot options and merge tool', async ({ page }) => {
    const { sectionId, stationRefs } = await setupProjectWithShots(page, 3);
    const firstStation = stationRefs[0];
    const lastStation = stationRefs[stationRefs.length - 1];

    await openContextMenu(page, { type: 'station', ref: firstStation });
    await expect(page.getByRole('button', { name: 'Add Shot Before' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Station' }).click();

    const editStation = page.getByTestId('edit-station-dialog');
    await expect(editStation).toBeVisible();
    await editStation.getByRole('button', { name: 'Cancel' }).click();
    await expect(editStation).not.toBeVisible({ timeout: 5000 });

    await openContextMenu(page, { type: 'station', ref: lastStation });
    await expect(page.getByRole('button', { name: 'Add Shot After' })).toBeVisible();
    await page.getByRole('button', { name: 'Add Shot After' }).click();

    const drawShot = page.getByTestId('draw-shot-dialog');
    await expect(drawShot).toBeVisible();
    await drawShot.getByRole('button', { name: 'Cancel' }).click();
    await expect(drawShot).not.toBeVisible({ timeout: 5000 });

    await openContextMenu(page, { type: 'station', ref: firstStation });
    await page.getByRole('button', { name: 'Merge With...' }).click();

    await expect.poll(async () => {
      return page.evaluate(() => {
        const uiState = (window as any).__E2E_TEST__.uiStore.getState();
        return {
          activeTool: uiState.activeTool,
          mergeStationA: uiState.mergeStationA,
        };
      });
    }).toEqual({
      activeTool: 'merge',
      mergeStationA: firstStation,
    });
  });

  test('section menu opens adjust position dialog', async ({ page }) => {
    const { sectionId } = await setupProjectWithShots(page, 2);

    await openContextMenu(page, { type: 'section', sectionId });
    await page.getByRole('button', { name: 'Adjust Position...' }).click();

    const dialog = page.getByTestId('section-adjust-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});
