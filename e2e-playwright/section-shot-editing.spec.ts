import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForMapIdle,
  waitForNoDialogs,
  type SectionSeed,
} from './helpers/app';

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Main Passage',
    direction: 'in',
    shots: [
      {
        azimuth_in: 45,
        azimuth_out: 225,
        length: 10.5,
        depth_in: -2,
        depth_out: -2.5,
        left: 1.5,
        right: 2.3,
        up: 3.0,
        down: 0.8,
        comment: 'Entrance point with good visibility',
      },
      {
        azimuth_in: 90,
        azimuth_out: 270,
        length: 15.2,
        depth_in: -2.5,
        depth_out: -5.0,
        left: 0.5,
        right: 0.7,
        up: 1.2,
        down: 1.5,
        comment: null,
      },
    ],
  },
  {
    name: 'Side Tunnel',
    direction: 'out',
    shots: [
      {
        azimuth_in: 270,
        azimuth_out: 90,
        length: 5.0,
        depth_in: -3.0,
        depth_out: -4.0,
        left: 0,
        right: 0,
        up: 0,
        down: 0,
        comment: 'Narrow restriction',
      },
    ],
  },
];

async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Edit Test Project');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapReady(page);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
}

async function getShotInfo(
  page: Page,
  sectionName: string,
  shotIndex: number
): Promise<{ sectionId: number; shotId: number }> {
  const result = await page.evaluate(
    ({ targetName, targetIndex }) => {
      const project = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: { getState: () => { project: { sections: Array<{ id: number; name: string; shots: Array<{ id: number; length: number }> }> } | null } };
        };
      }).__E2E_TEST__?.projectStore.getState().project;

      const section = project?.sections.find((s) => s.name === targetName);
      const shot = section?.shots?.[targetIndex];

      if (!section || !shot) return null;

      return { sectionId: section.id, shotId: shot.id };
    },
    { targetName: sectionName, targetIndex: shotIndex }
  );

  if (!result) {
    throw new Error(`Shot not found: ${sectionName} index ${shotIndex}`);
  }

  return result;
}

async function selectShotInStore(page: Page, sectionName: string, shotIndex: number): Promise<void> {
  const shotInfo = await getShotInfo(page, sectionName, shotIndex);

  await page.evaluate(({ sectionId, shotId }) => {
    const uiStore = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { setSelection: (selection: unknown) => void; setDetailPanelTab: (tab: string) => void } } };
    }).__E2E_TEST__?.uiStore;

    if (!uiStore) return;

    uiStore.getState().setDetailPanelTab('details');
    uiStore.getState().setSelection({ type: 'shot', sectionId, shotId });
  }, shotInfo);
}

async function selectSectionInStore(page: Page, sectionName: string): Promise<number> {
  const sectionId = await page.evaluate((targetName) => {
    const project = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: { sections: Array<{ id: number; name: string }> } | null } };
      };
    }).__E2E_TEST__?.projectStore.getState().project;

    return project?.sections.find((s) => s.name === targetName)?.id ?? null;
  }, sectionName);

  if (sectionId === null) {
    throw new Error(`Section not found: ${sectionName}`);
  }

  await page.evaluate((id) => {
    const uiStore = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { setSelection: (selection: unknown) => void; setDetailPanelTab: (tab: string) => void } } };
    }).__E2E_TEST__?.uiStore;

    if (!uiStore) return;

    uiStore.getState().setDetailPanelTab('details');
    uiStore.getState().setSelection({ type: 'section', sectionId: id });
  }, sectionId);

  return sectionId;
}

async function openEditSectionDialog(page: Page, sectionName: string): Promise<void> {
  const sectionId = await selectSectionInStore(page, sectionName);

  await page.evaluate((id) => {
    const uiStore = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { openDialog: (dialog: string, data?: Record<string, unknown>) => void } } };
    }).__E2E_TEST__?.uiStore;

    if (!uiStore) return;

    uiStore.getState().openDialog('edit-section', { sectionId: id });
  }, sectionId);

  await expect(page.getByTestId('edit-section-dialog')).toBeVisible({ timeout: 5000 });
}

test.describe('Section and Shot Editing', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProjectWithSections(page);
  });

  test('should show shot details in detail panel', async ({ page }) => {
    await selectShotInStore(page, 'Main Passage', 0);

    const detailPanel = page.getByTestId('detail-panel');
    await expect(detailPanel).toBeVisible();
    await expect(detailPanel.getByRole('heading', { name: 'Shot' })).toBeVisible();

    await expect(detailPanel).toContainText('Length');
    await expect(detailPanel).toContainText('10.50 m');
    await expect(detailPanel).toContainText('Azimuth In');
    await expect(detailPanel).toContainText('45.0°');
    await expect(detailPanel).toContainText('LRUD:');
    await expect(detailPanel).toContainText('Entrance point with good visibility');
  });

  test('should edit shot values in edit section dialog', async ({ page }) => {
    await openEditSectionDialog(page, 'Main Passage');

    const dialog = page.getByTestId('edit-section-dialog');
    await expect(dialog).toBeVisible();

    const lengthInput = dialog.getByTestId('shot-length-0');
    await lengthInput.fill('12.3');
    await expect(lengthInput).toHaveValue('12.3');

    const commentInput = dialog.getByTestId('shot-comment-0');
    await commentInput.fill('Updated comment');
    await expect(commentInput).toHaveValue('Updated comment');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should edit LRUD values', async ({ page }) => {
    await openEditSectionDialog(page, 'Main Passage');

    const dialog = page.getByTestId('edit-section-dialog');
    await expect(dialog).toBeVisible();

    const leftInput = dialog.getByTestId('shot-left-0');
    const rightInput = dialog.getByTestId('shot-right-0');
    const upInput = dialog.getByTestId('shot-up-0');
    const downInput = dialog.getByTestId('shot-down-0');

    await leftInput.fill('2.2');
    await rightInput.fill('3.1');
    await upInput.fill('4.4');
    await downInput.fill('1.7');

    await expect(leftInput).toHaveValue('2.2');
    await expect(rightInput).toHaveValue('3.1');
    await expect(upInput).toHaveValue('4.4');
    await expect(downInput).toHaveValue('1.7');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should delete shot with confirmation', async ({ page }) => {
    await selectShotInStore(page, 'Main Passage', 0);

    const detailPanel = page.getByTestId('detail-panel');
    await expect(detailPanel.getByRole('heading', { name: 'Shot' })).toBeVisible();

    await detailPanel.getByRole('button', { name: 'Delete' }).click();

    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 3000 });

    await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should edit section metadata', async ({ page }) => {
    await openEditSectionDialog(page, 'Main Passage');

    const dialog = page.getByTestId('edit-section-dialog');
    await expect(dialog).toBeVisible();

    await expect(dialog.getByTestId('section-name-input')).toHaveValue('Main Passage');
    await expect(dialog.getByTestId('section-surveyor-input')).toHaveValue('Test Surveyor');
    await expect(dialog.getByTestId('section-date-input')).toBeVisible();
    await expect(dialog.getByTestId('section-color-hex-input')).toHaveValue('#3b82f6');
    await expect(dialog.getByTestId('section-direction-select')).toContainText('In');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should change section direction in edit dialog', async ({ page }) => {
    await openEditSectionDialog(page, 'Main Passage');

    const dialog = page.getByTestId('edit-section-dialog');
    const directionSelect = dialog.getByTestId('section-direction-select');
    await expect(directionSelect).toContainText('In');

    const trigger = directionSelect.locator('button').first();
    await trigger.click();

    const outOption = directionSelect.locator('[role="option"]:has-text("Out")');
    await outOption.click();

    await expect(directionSelect).toContainText('Out');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should delete section with confirmation', async ({ page }) => {
    const sectionId = await selectSectionInStore(page, 'Side Tunnel');

    const sectionItem = page.getByTestId(`section-item-${sectionId}`);
    await sectionItem.hover();

    const deleteButton = page.getByTestId(`section-delete-${sectionId}`);
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 3000 });

    await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should add new shot to section', async ({ page }) => {
    await openEditSectionDialog(page, 'Main Passage');

    const dialog = page.getByTestId('edit-section-dialog');
    const shotRows = dialog.locator('[data-testid^="shot-row-"]');
    const initialCount = await shotRows.count();

    await dialog.getByTestId('add-shot-button').click();

    await expect(shotRows).toHaveCount(initialCount + 1);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });
});
