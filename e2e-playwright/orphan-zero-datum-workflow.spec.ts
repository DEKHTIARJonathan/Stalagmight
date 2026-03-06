import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  createSectionViaStore,
  openDmpSelectionDialog,
} from './helpers/app';

async function openOrphanDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            openDialog: (dialog: string, data?: Record<string, unknown>) => void;
          };
        };
      };
    }).__E2E_TEST__;

    if (!e2e?.uiStore) {
      throw new Error('E2E UI store unavailable');
    }

    e2e.uiStore.getState().openDialog('orphan-placement', {
      suggestions: [
        {
          orphanSectionId: 2,
          orphanSectionName: 'Orphan Branch',
          orphanStationIndex: 1,
          targetSectionId: 1,
          targetSectionName: 'Anchor Mainline',
          targetStationIndex: 1,
          score: 0.91,
          matchedShots: 0,
          direction: 'forward',
          isPartial: false,
          confidence: 'high',
        },
        {
          orphanSectionId: 2,
          orphanSectionName: 'Orphan Branch',
          orphanStationIndex: 1,
          targetSectionId: 1,
          targetSectionName: 'Anchor Mainline',
          targetStationIndex: 0,
          score: 0.74,
          matchedShots: 0,
          direction: 'forward',
          isPartial: false,
          confidence: 'medium',
        },
      ],
    });
  });
}

test.describe('Orphan + Zero Datum Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('accepts orphan placement suggestion and executes merge', async ({ page }) => {
    await createProject(page, 'Orphan Merge Scenario');

    await createSectionViaStore(page, {
      name: 'Anchor Mainline',
      shots: [
        { azimuth_in: 10, azimuth_out: 10, length: 10, depth_in: -1, depth_out: -1.5 },
        { azimuth_in: 20, azimuth_out: 20, length: 8, depth_in: -1.5, depth_out: -2 },
      ],
    });

    await createSectionViaStore(page, {
      name: 'Orphan Branch',
      shots: [
        { azimuth_in: 100, azimuth_out: 100, length: 6, depth_in: -2, depth_out: -2.2 },
        { azimuth_in: 110, azimuth_out: 110, length: 5, depth_in: -2.2, depth_out: -2.4 },
      ],
    });

    await openOrphanDialog(page);
    await expect(page.getByTestId('orphan-placement-dialog')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('toggle-alternatives').click();
    await expect(page.getByTestId('alternatives-list')).toBeVisible();
    await page.getByTestId('alternative-0').click();

    await page.getByTestId('orphan-accept').click();
    await expect(page.getByTestId('orphan-placement-dialog')).toBeHidden({ timeout: 10000 });

    const mergeCalls = await page.evaluate(() => {
      const getter = (window as unknown as Record<string, unknown>).__MOCK_GET_MERGE_STATION_CALLS__;
      if (typeof getter !== 'function') return [];
      return (getter as () => unknown[])();
    });

    expect(mergeCalls.length).toBeGreaterThan(0);
  });

  test('walks through zero datum selection into new import wizard', async ({ page }) => {
    await createProject(page, 'Zero Datum Calibration');
    await openDmpSelectionDialog(page);

    const selectionDialog = page.getByTestId('dmp-selection-dialog');
    await expect(selectionDialog.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });

    await selectionDialog.getByTestId('continue-button').click();
    await expect(page.getByTestId('zero-datum-selection-dialog')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('zero-datum-section-card-0').click();
    await expect(page.getByTestId('zero-datum-config-dialog')).toBeVisible({ timeout: 10000 });

    const gpsInput = page.getByTestId('zero-datum-gps-input');
    await gpsInput.fill('24.550123, -81.780456');
    await expect(page.getByTestId('zero-datum-gps-parsed')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('zero-datum-config-confirm').click();
    await expect(page.getByTestId('dmp-new-import-dialog')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('dmp-new-import-dialog')).toBeHidden({ timeout: 10000 });
  });
});
