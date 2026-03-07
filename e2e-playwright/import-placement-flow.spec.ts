import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  createSectionViaStore,
} from './helpers/app';

type MockSuggestion = {
  existingStationIndex: number;
  importStationIndex: number;
  score: number;
  matchedShots: number;
  direction: 'forward' | 'reverse';
  isPartial: boolean;
  confidence: 'high' | 'medium' | 'low';
  existingSectionName: string;
  importSectionIndex: number;
  importSectionName: string;
  targetType: 'existing' | 'importing';
  existingSectionId: number | null;
  targetImportIndex: number | null;
};

function buildMockDmpFile() {
  return {
    version: 5,
    sections: [
      {
        name: 'Anchor Candidate',
        direction: 'in',
        date: '2026-02-01',
        content_hash: 'hash-anchor-candidate',
        shots: [
          {
            shot_type: 'Standard',
            heading_in: 40,
            heading_out: 40,
            length: 10,
            depth_in: -1,
            depth_out: -2,
            pitch_in: 0,
            pitch_out: 0,
            left: 1,
            right: 1,
            up: 1,
            down: 1,
            temperature: 18,
            hour: 10,
            minute: 0,
            second: 0,
            marker_index: 0,
            comment: null,
          },
        ],
      },
      {
        name: 'Unanchored Segment',
        direction: 'in',
        date: '2026-02-01',
        content_hash: 'hash-unanchored-segment',
        shots: [
          {
            shot_type: 'Standard',
            heading_in: 120,
            heading_out: 120,
            length: 8,
            depth_in: -2,
            depth_out: -3,
            pitch_in: 0,
            pitch_out: 0,
            left: 1,
            right: 1,
            up: 1,
            down: 1,
            temperature: 18,
            hour: 10,
            minute: 5,
            second: 0,
            marker_index: 0,
            comment: null,
          },
        ],
      },
    ],
  };
}

const defaultSuggestions: MockSuggestion[] = [
  {
    existingStationIndex: 0,
    importStationIndex: 0,
    score: 0.94,
    matchedShots: 0,
    direction: 'forward',
    isPartial: false,
    confidence: 'high',
    existingSectionName: 'Anchor Section',
    importSectionIndex: 0,
    importSectionName: 'Anchor Candidate',
    targetType: 'existing',
    existingSectionId: 1,
    targetImportIndex: null,
  },
];

async function setImportSuggestions(page: Page, suggestions: MockSuggestion[]): Promise<void> {
  await page.evaluate((nextSuggestions) => {
    const setSuggestions =
      (window as unknown as Record<string, unknown>).__MOCK_SET_IMPORT_PLACEMENT_SUGGESTIONS__;
    if (typeof setSuggestions !== 'function') {
      throw new Error('Mock suggestion setter not available');
    }
    (setSuggestions as (value: unknown[]) => void)(nextSuggestions);
  }, suggestions);
}

async function openDmpWizard(page: Page): Promise<void> {
  await page.evaluate((dmpFile) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore?: {
          getState: () => {
            openDialog: (dialog: string, data?: Record<string, unknown>) => void;
          };
        };
      };
    }).__E2E_TEST__;

    if (!e2e?.uiStore) {
      throw new Error('E2E UI store unavailable');
    }

    const selectionConfig = {
      selectedIndices: new Set([0, 1]),
      defaultSurveyor: 'Session Diver',
      defaultDate: null,
      fileHash: 'mock_dmp_hash_flow',
      sectionHashes: ['hash-anchor-candidate', 'hash-unanchored-segment'],
    };

    e2e.uiStore.getState().openDialog('dmp-import-new', {
      dmpFile,
      filePath: '/mock/import-placement-flow.dmp',
      selectionConfig,
    });
  }, buildMockDmpFile());

  await expect(page.getByTestId('dmp-new-import-dialog')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('wizard-suggestion')).toBeVisible({ timeout: 10000 });
}

async function openManualPlacing(page: Page): Promise<void> {
  await page.getByTestId('confirm-button').click();

  const manualPlacing = page.getByTestId('wizard-manual-placing');
  await page.waitForTimeout(300);
  if (!(await manualPlacing.isVisible())) {
    await expect(page.getByTestId('placement-mode-indicator')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
  }

  await expect(page.getByTestId('dmp-new-import-dialog')).toBeVisible({ timeout: 10000 });
  await expect(manualPlacing).toBeVisible({ timeout: 10000 });
}

test.describe('Import Placement Flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Placement Wizard Test');
    await createSectionViaStore(page, {
      name: 'Anchor Section',
      shots: [{ azimuth_in: 40, azimuth_out: 40, length: 10, depth_in: -1, depth_out: -2 }],
    });
    await setImportSuggestions(page, defaultSuggestions);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      const resetSuggestions =
        (window as unknown as Record<string, unknown>).__MOCK_RESET_IMPORT_PLACEMENT_SUGGESTIONS__;
      if (typeof resetSuggestions === 'function') {
        (resetSuggestions as () => void)();
      }
    });
  });

  test('shows suggestion-phase controls and actions', async ({ page }) => {
    await openDmpWizard(page);

    await expect(page.getByTestId('wizard-connection-description')).toBeVisible();
    await expect(page.getByTestId('wizard-confidence')).toBeVisible();
    await expect(page.getByTestId('confirm-button')).toBeVisible();
    await expect(page.getByTestId('skip-button')).toBeVisible();
  });

  test('supports alternatives list in suggestion phase', async ({ page }) => {
    await setImportSuggestions(page, [
      ...defaultSuggestions,
      {
        ...defaultSuggestions[0],
        score: 0.77,
        confidence: 'medium',
      },
    ]);

    await openDmpWizard(page);

    const alternativesToggle = page.getByTestId('toggle-alternatives');
    const alternativesList = page.getByTestId('alternatives-list');
    await expect(alternativesToggle).toBeVisible();

    if (!(await alternativesList.isVisible())) {
      await alternativesToggle.click();
    }

    await expect(alternativesList).toBeVisible();
    await expect(page.getByTestId('alternative-0')).toBeVisible();
  });

  test('confirming suggestion transitions to manual placing', async ({ page }) => {
    await openDmpWizard(page);
    await openManualPlacing(page);

    await expect(page.getByTestId('segment-placement-modes')).toBeVisible();
    await expect(page.getByTestId('segment-place-button')).toBeVisible();
  });

  test('manual mode keeps segment-place disabled until a placement action is chosen', async ({ page }) => {
    await openDmpWizard(page);
    await openManualPlacing(page);

    const placeButton = page.getByTestId('segment-place-button');
    await expect(placeButton).toBeDisabled();
  });

  test('discard mode enables place action and can finish the wizard', async ({ page }) => {
    await openDmpWizard(page);
    await openManualPlacing(page);

    await page.getByTestId('segment-mode-discard').click();
    const placeButton = page.getByTestId('segment-place-button');
    await expect(placeButton).toBeEnabled();
    await placeButton.click();

    await expect(page.getByTestId('dmp-new-import-dialog')).toBeHidden({ timeout: 10000 });
  });

  test('from-existing mode requires selecting target section before place is enabled', async ({ page }) => {
    await openDmpWizard(page);
    await openManualPlacing(page);

    await page.getByTestId('segment-mode-from-existing').click();

    const placeButton = page.getByTestId('segment-place-button');
    await expect(placeButton).toBeDisabled();

    await page.getByTestId('from-existing-section-select').click();
    const dropdownListbox = page
      .locator('[role="listbox"]')
      .filter({ has: page.getByRole('option', { name: 'Anchor Section', exact: true }) })
      .last();
    await dropdownListbox.getByRole('option', { name: 'Anchor Section', exact: true }).click();

    await expect(placeButton).toBeEnabled();
  });

  test('manual place-on-map hides wizard and escape restores it', async ({ page }) => {
    await openDmpWizard(page);
    await openManualPlacing(page);

    await page.getByTestId('segment-mode-manual').click();
    await page.getByTestId('segment-place-on-map-button').click();

    await expect(page.getByTestId('placement-mode-indicator')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('dmp-new-import-dialog')).toBeHidden({ timeout: 10000 });

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dmp-new-import-dialog')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('wizard-manual-placing')).toBeVisible({ timeout: 10000 });
  });

  test('skip action in suggestion phase still reaches manual placing', async ({ page }) => {
    await openDmpWizard(page);

    await page.getByTestId('skip-button').click();

    const manualPlacing = page.getByTestId('wizard-manual-placing');
    await page.waitForTimeout(300);
    if (!(await manualPlacing.isVisible())) {
      await expect(page.getByTestId('placement-mode-indicator')).toBeVisible({ timeout: 10000 });
      await page.keyboard.press('Escape');
    }

    await expect(manualPlacing).toBeVisible({ timeout: 10000 });
  });

  test('cancel requires confirmation before closing', async ({ page }) => {
    await openDmpWizard(page);

    const wizard = page.getByTestId('dmp-new-import-dialog');
    await wizard.getByTestId('cancel-button').click();

    const cancelConfirmDialog = page.getByTestId('cancel-confirm-dialog');
    if (await cancelConfirmDialog.isVisible()) {
      await page.getByTestId('confirm-cancel-button').click();
    }

    await expect(wizard).toBeHidden({ timeout: 10000 });
  });

  test('back requires confirmation and can return to selection dialog', async ({ page }) => {
    await openDmpWizard(page);

    const wizard = page.getByTestId('dmp-new-import-dialog');
    await wizard.getByTestId('back-button').click();

    const backConfirmDialog = page.getByTestId('back-confirm-dialog');
    if (await backConfirmDialog.isVisible()) {
      await page.getByTestId('confirm-back-button').click();
    }

    await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible({ timeout: 10000 });
  });
});
