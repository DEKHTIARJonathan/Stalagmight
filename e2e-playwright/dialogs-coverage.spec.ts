import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
} from './helpers/app';

type StationRef = { section_id: number; station_index: number };

type ProjectDialogIds = {
  sectionId: number;
  shotId: number;
  midShotId: number;
  stationRef: StationRef;
};

function buildShot(index: number) {
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
  };
}

async function setupProjectWithShots(page: Page, shotCount: number): Promise<ProjectDialogIds> {
  await setupMockedPage(page);
  await createProject(page, 'Dialog Coverage');

  const shots = Array.from({ length: shotCount }, (_, idx) => buildShot(idx));
  await seedProjectWithSections(page, [
    {
      name: 'Dialog Section',
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
    const shots = section?.shots ?? [];
    const station = state.stations.find(
      (s) => s.station_ref.section_id === section?.id
    );

    return {
      sectionId: section?.id ?? null,
      shotId: shots[0]?.id ?? null,
      midShotId: shots[Math.floor(shots.length / 2)]?.id ?? null,
      stationRef: station?.station_ref ?? null,
    };
  });

  if (!ids || !ids.sectionId || !ids.shotId || !ids.midShotId || !ids.stationRef) {
    throw new Error('Failed to resolve project IDs for dialog tests.');
  }

  return ids as ProjectDialogIds;
}

async function openDialog(page: Page, name: string, data: Record<string, unknown>) {
  await page.evaluate(
    ({ dialogName, dialogData }) => {
      (window as any).__E2E_TEST__.uiStore.getState().openDialog(dialogName, dialogData);
    },
    { dialogName: name, dialogData: data }
  );
}

async function openSettingsDialog(page: Page) {
  const settingsButton = page.getByTestId('settings-button');
  await expect(settingsButton).toBeVisible({ timeout: 5000 });
  await settingsButton.click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5000 });
}

test.describe('Dialog Coverage - Edit Shot', () => {
  test('validates input and saves normalized values', async ({ page }) => {
    const { sectionId, shotId } = await setupProjectWithShots(page, 2);

    await openDialog(page, 'edit-shot', { sectionId, shotId });

    const dialog = page.getByTestId('edit-shot-dialog');
    await expect(dialog).toBeVisible();

    const lengthInput = dialog.locator('label:has-text("Length")').locator('..').locator('input');
    await lengthInput.fill('0');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.locator('text=Length must be greater than 0')).toBeVisible();

    await lengthInput.fill('12.5');
    const azInInput = dialog.locator('label:has-text("Azimuth In")').locator('..').locator('input');
    const azOutInput = dialog.locator('label:has-text("Azimuth Out")').locator('..').locator('input');
    await azInInput.fill('-10');
    await azOutInput.fill('-20');

    const pitchInInput = dialog.locator('label:has-text("Pitch In")').locator('..').locator('input');
    await pitchInInput.fill('5');

    const leftInput = dialog.locator('input[placeholder="L"]');
    await leftInput.fill('1.2');

    const commentInput = dialog.locator('textarea');
    await commentInput.fill('notes');

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    const updatedShot = await page.evaluate(({ sectionId: sId, shotId: shId }) => {
      const state = (window as any).__E2E_TEST__.projectStore.getState();
      const section = state.project.sections.find((s: any) => s.id === sId);
      return section?.shots.find((s: any) => s.id === shId);
    }, { sectionId, shotId });

    expect(updatedShot.azimuth_in).toBe(350);
    expect(updatedShot.azimuth_out).toBe(340);
    expect(updatedShot.length).toBe(12.5);
    expect(updatedShot.pitch_in).toBe(5);
    expect(updatedShot.left).toBe(1.2);
    expect(updatedShot.comment).toBe('notes');
  });
});

test.describe('Dialog Coverage - Draw Shot', () => {
  test('auto-fills fields and creates a shot', async ({ page }) => {
    const { sectionId, stationRef } = await setupProjectWithShots(page, 2);

    await openDialog(page, 'draw-shot', { fromStation: stationRef });

    const dialog = page.getByTestId('draw-shot-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Create Shot' }).click();
    await expect(dialog.locator('text=Length must be greater than 0')).toBeVisible();

    const lengthInput = dialog.locator('label:has-text("Length")').locator('..').locator('input');
    await lengthInput.fill('5');

    const azInInput = dialog.locator('label:has-text("Azimuth In")').locator('..').locator('input');
    const azOutInput = dialog.locator('label:has-text("Azimuth Out")').locator('..').locator('input');
    await azInInput.fill('45');
    await expect(azOutInput).toHaveValue('45');

    const depthInInput = dialog.locator('label:has-text("Depth In")').locator('..').locator('input');
    const depthOutInput = dialog.locator('label:has-text("Depth Out")').locator('..').locator('input');
    await depthInInput.fill('3.2');
    await expect(depthOutInput).toHaveValue('3.2');

    await dialog.locator('summary:has-text("LRUD")').click();
    const leftInput = dialog.locator('label:has-text("Left")').locator('..').locator('input');
    await leftInput.fill('0.8');

    const virtualToggle = dialog.locator('input[type="checkbox"]');
    await virtualToggle.check();

    await dialog.getByRole('button', { name: 'Create Shot' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    const selection = await page.evaluate(() => {
      return (window as any).__E2E_TEST__.uiStore.getState().selection;
    });

    expect(selection?.type).toBe('shot');
    expect(selection?.sectionId).toBe(sectionId);
  });
});

test.describe('Dialog Coverage - Edit Section', () => {
  test('updates metadata, edits shots, adds and deletes rows', async ({ page }) => {
    const { sectionId } = await setupProjectWithShots(page, 2);

    await openDialog(page, 'edit-section', { sectionId });

    const dialog = page.getByTestId('edit-section-dialog');
    await expect(dialog).toBeVisible();

    const nameInput = dialog.getByTestId('section-name-input');
    const surveyorInput = dialog.getByTestId('section-surveyor-input');
    const qualityInput = dialog.getByTestId('section-quality-input');
    const colorHexInput = dialog.getByTestId('section-color-hex-input');
    const dateInput = dialog.getByTestId('section-date-input').locator('input');

    await nameInput.fill('Updated Section');
    await surveyorInput.fill('New Surveyor');
    await qualityInput.fill('2.5');
    await colorHexInput.fill('#123456');
    await dateInput.fill('2026-02-01');

    const lengthInput = dialog.getByTestId('shot-length-0');
    await lengthInput.fill('9.5');
    await lengthInput.press('Enter');

    await dialog.getByTestId('add-shot-button').click();

    const deleteButton = dialog.getByTestId('shot-delete-1');
    await deleteButton.click();

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    const updatedSection = await page.evaluate((sId) => {
      const state = (window as any).__E2E_TEST__.projectStore.getState();
      return state.project.sections.find((s: any) => s.id === sId);
    }, sectionId);

    expect(updatedSection.name).toBe('Updated Section');
    expect(updatedSection.surveyor).toBe('New Surveyor');
    expect(updatedSection.quality).toBe(2.5);
    expect(updatedSection.color).toBe('#123456');
    expect(updatedSection.date).toBe('2026-02-01');
    expect(updatedSection.shots[0]?.length).toBe(9.5);
  });

  test('shows mid-shot delete warning and applies shift delete', async ({ page }) => {
    const { sectionId } = await setupProjectWithShots(page, 3);

    await openDialog(page, 'edit-section', { sectionId });

    const dialog = page.getByTestId('edit-section-dialog');
    await expect(dialog).toBeVisible();

    const deleteButton = dialog.getByTestId('shot-delete-1');
    await deleteButton.click();

    const warning = dialog.locator('text=This is a mid-section shot.');
    await expect(warning).toBeVisible();

    const saveButton = dialog.getByRole('button', { name: 'Save' });
    await expect(saveButton).toBeDisabled();

    const shiftButton = dialog.getByRole('button', { name: 'Shift Geometry' });
    await shiftButton.click();

    await expect(warning).not.toBeVisible({ timeout: 3000 });
    await expect(saveButton).toBeEnabled();

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('Dialog Coverage - Confirm Delete', () => {
  test('renders station warning and disables delete', async ({ page }) => {
    await setupMockedPage(page);

    await openDialog(page, 'confirm-delete', { type: 'station' });

    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('text=delete all connected shots')).toBeVisible();

    const deleteButton = dialog.getByRole('button', { name: 'Delete' });
    await expect(deleteButton).toBeDisabled();
  });

  test('deletes a shot and clears selection', async ({ page }) => {
    const { sectionId, shotId } = await setupProjectWithShots(page, 2);

    await page.evaluate(({ sectionId: sId, shotId: shId }) => {
      (window as any).__E2E_TEST__.uiStore.getState().setSelection({
        type: 'shot',
        sectionId: sId,
        shotId: shId,
      });
    }, { sectionId, shotId });

    await openDialog(page, 'confirm-delete', {
      type: 'shot',
      sectionId,
      shotId,
      totalShots: 2,
    });

    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    const selection = await page.evaluate(() => {
      return (window as any).__E2E_TEST__.uiStore.getState().selection;
    });
    expect(selection).toBeNull();
  });

  test('shows split name inputs when split is required', async ({ page }) => {
    const { sectionId, shotId } = await setupProjectWithShots(page, 2);

    await openDialog(page, 'confirm-delete', {
      type: 'shot',
      sectionId,
      shotId,
      totalShots: 3,
      splitRequired: true,
      sectionName: 'SplitTarget',
    });

    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();

    const splitA = dialog.getByTestId('split-name-a');
    const splitB = dialog.getByTestId('split-name-b');

    await expect(splitA).toHaveValue('SplitTarget-A');
    await expect(splitB).toHaveValue('SplitTarget-B');
  });
});

test.describe('Dialog Coverage - Settings Advanced', () => {
  test('marks dirty state and validates advanced settings', async ({ page }) => {
    await setupMockedPage(page);
    await openSettingsDialog(page);

    const advancedTab = page.getByTestId('settings-tab-advanced');
    await advancedTab.click();

    const panel = page.getByTestId('settings-panel-advanced');
    await expect(panel).toBeVisible();

    const toggleHitboxes = panel.getByTestId('toggle-show-hitboxes');
    await toggleHitboxes.click();
    await expect(toggleHitboxes).toHaveAttribute('aria-checked', 'true');

    const logSizeInput = panel.getByTestId('input-max-log-size');
    await logSizeInput.fill('0');

    const saveButton = page.getByTestId('settings-save-button');
    await expect(saveButton).toBeDisabled();

    await logSizeInput.fill('500');
    await expect(saveButton).toBeEnabled();

    await saveButton.click();
    await expect(page.getByTestId('settings-dialog')).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('Dialog Coverage - Settings Map', () => {
  test('validates map settings and enables save after fixes', async ({ page }) => {
    await setupMockedPage(page);
    await openSettingsDialog(page);

    const mapTab = page.getByTestId('settings-tab-map');
    await mapTab.click();

    const panel = page.getByTestId('settings-panel-map');
    await expect(panel).toBeVisible();

    const zoomMinInput = panel.getByTestId('input-zoom-min');
    const zoomMaxInput = panel.getByTestId('input-zoom-max');

    await zoomMinInput.fill('15');
    await zoomMaxInput.fill('10');

    const saveButton = page.getByTestId('settings-save-button');
    await expect(saveButton).toBeDisabled();

    await zoomMinInput.fill('5');
    await zoomMaxInput.fill('15');

    const snapToggle = panel.getByTestId('toggle-snap-draw');
    await snapToggle.click();

    await expect(saveButton).toBeEnabled();
  });
});
