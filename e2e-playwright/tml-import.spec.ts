import { test, expect, Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

/**
 * First mocked-tier coverage for the Ariane (.tml/.tmlu) import journey (#411).
 *
 * Drives the whole route the way a user does - unified picker (Ctrl+I) ->
 * routeOpenedFile -> parse_tml -> new-project-for-import -> TmlImportDialog ->
 * execute_tml_import -> import receipt - against the synthetic TML the shared
 * IPC mock serves (no .tml fixture is read anywhere).
 *
 * The mocked file is 2 sections / 5 shots, one of them excluded, one virtual,
 * with 1 loop closure, so the dialog's optional controls and the receipt's
 * counts are all observable.
 */

const TML_PATH = '/mock/synthetic-cavern.tml';
const IMPERIAL_TML_PATH = '/mock/synthetic-imperial-cavern.tmlu';

async function setImportPath(page: Page, path: string): Promise<void> {
  await page.evaluate((selectedPath) => {
    const overrides = (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ as
      | Record<string, unknown>
      | undefined;
    const next = overrides ?? {};
    next['plugin:dialog|open'] = selectedPath;
    (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ = next;
  }, path);
}

/** Picker -> new-project-for-import -> TmlImportDialog, ready to confirm. */
async function openTmlImportDialog(page: Page, path: string, projectName: string): Promise<void> {
  await setImportPath(page, path);
  await page.keyboard.press('Control+i');

  await expect(page.getByTestId('new-project-for-import-dialog')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('project-name-input').fill(projectName);
  await page.getByTestId('create-and-continue-button').click();

  await expect(page.getByTestId('tml-import-dialog')).toBeVisible({ timeout: 10000 });
  // The Import button is gated on the hash-check effect SETTLING, not
  // succeeding: hashChecked goes true even when calculate_file_hash /
  // check_duplicate_import throw (TmlImportDialog.tsx catches and proceeds
  // without duplicate detection). Waiting for enabled here only guarantees
  // the effect ran, so the click below cannot race it.
  await expect(page.getByTestId('tml-import-confirm')).toBeEnabled();
}

async function getTmlImportCalls(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    () =>
      (window as unknown as { __MOCK_GET_TML_IMPORT_CALLS__?: () => Array<Record<string, unknown>> })
        .__MOCK_GET_TML_IMPORT_CALLS__?.() ?? []
  );
}

async function getImportedSections(
  page: Page
): Promise<Array<{ name: string; kinds: string[] }>> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: Array<{ name: string; shots: Array<{ kind: string }> }> } | null;
            };
          };
        };
      }
    ).__E2E_TEST__?.projectStore.getState();
    return (state?.project?.sections ?? []).map((section) => ({
      name: section.name,
      kinds: section.shots.map((shot) => shot.kind),
    }));
  });
}

test.describe('Ariane TML import journey', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await page.evaluate(() =>
      (window as unknown as { __MOCK_RESET_TML_IMPORT_CALLS__?: () => void }).__MOCK_RESET_TML_IMPORT_CALLS__?.()
    );
  });

  test('imports a TML from the unified picker through to the receipt @smoke', async ({ page }) => {
    await openTmlImportDialog(page, TML_PATH, 'Synthetic Cavern Import');

    const dialog = page.getByTestId('tml-import-dialog');
    await expect(dialog).toContainText('Synthetic Cavern');
    await expect(page.getByTestId('tml-section-count')).toHaveText('2');
    // 6 = every raw row, INCLUDING the Closure marker row - the dialog's
    // preview stats count the unfiltered file (a known #411 finding, pinned
    // as-is here; the receipt below shows the honest post-filter counts).
    await expect(page.getByTestId('tml-shot-count')).toHaveText('6');
    await expect(page.getByTestId('tml-section-row-0')).toContainText('Main Line');
    await expect(page.getByTestId('tml-section-row-1')).toContainText('Side Passage');
    // The branch-split marker rides on the second section.
    await expect(page.getByTestId('tml-section-row-1')).toContainText('branch');
    await expect(page.getByTestId('tml-closure-count')).toContainText('1 loop closure');

    await page.getByTestId('tml-import-confirm').click();
    await expect(dialog).toBeHidden({ timeout: 15000 });

    const receipt = page.getByTestId('import-receipt-dialog');
    await expect(receipt).toBeVisible({ timeout: 10000 });
    await expect(receipt).toContainText('Ariane TML');
    await expect(receipt).toContainText('synthetic-cavern.tml');
    // 2 of 2 sections and 4 shots - the excluded shot is left out by default -
    // plus the file's single loop closure.
    await expect(page.getByTestId('import-receipt-summary')).toHaveText(
      '2 sections - 4 shots - 1 loop reconstructed'
    );
    await expect(page.getByTestId('import-receipt-unit-conversion')).toBeHidden();

    await page.getByTestId('import-receipt-continue').click();
    await expect(receipt).toBeHidden();
    await expect(page.getByTestId('single-system-view')).toBeVisible();

    const sections = await getImportedSections(page);
    expect(sections.map((section) => section.name)).toEqual(['Main Line', 'Side Passage']);
    // Excluded shot dropped: 2 kept in Main Line, 2 in Side Passage.
    // No kind assertions here: the default Auto mode classifies virtual shots
    // via the backend's chain rule, which the IPC mock deliberately does not
    // model - kinds are only asserted under the override modes below.
    expect(sections.map((section) => section.kinds.length)).toEqual([2, 2]);

    const calls = await getTmlImportCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].includeExcluded).toBe(false);
    expect(calls[0].commentsOnStations).toBe(true);
    expect(calls[0].virtualShotMode).toBe('Auto');
  });

  test('the excluded-shot toggle sends includeExcluded and lands the extra shot', async ({ page }) => {
    await openTmlImportDialog(page, TML_PATH, 'Excluded Shot Import');

    await page.getByTestId('tml-include-excluded').check();
    await page.getByTestId('tml-import-confirm').click();

    const receipt = page.getByTestId('import-receipt-dialog');
    await expect(receipt).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('import-receipt-summary')).toHaveText(
      '2 sections - 5 shots - 1 loop reconstructed'
    );
    await page.getByTestId('import-receipt-continue').click();

    const calls = await getTmlImportCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].includeExcluded).toBe(true);

    const sections = await getImportedSections(page);
    expect(sections.map((section) => section.kinds.length)).toEqual([3, 2]);
  });

  test('the virtual-shot override imports references instead of jumps', async ({ page }) => {
    await openTmlImportDialog(page, TML_PATH, 'Virtual Shot Import');

    await page.getByTestId('tml-virtual-shot-mode').selectOption('AllReferences');
    await page.getByTestId('tml-import-confirm').click();

    const receipt = page.getByTestId('import-receipt-dialog');
    await expect(receipt).toBeVisible({ timeout: 15000 });
    await page.getByTestId('import-receipt-continue').click();

    const calls = await getTmlImportCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].virtualShotMode).toBe('AllReferences');

    const sections = await getImportedSections(page);
    expect(sections[1]?.kinds).toEqual(['Normal', 'Reference']);
  });

  test('the all-jumps override imports jumps regardless of topology', async ({ page }) => {
    await openTmlImportDialog(page, TML_PATH, 'All Jumps Import');

    await page.getByTestId('tml-virtual-shot-mode').selectOption('AllJumps');
    await page.getByTestId('tml-import-confirm').click();

    const receipt = page.getByTestId('import-receipt-dialog');
    await expect(receipt).toBeVisible({ timeout: 15000 });
    await page.getByTestId('import-receipt-continue').click();

    const calls = await getTmlImportCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].virtualShotMode).toBe('AllJumps');

    const sections = await getImportedSections(page);
    expect(sections[1]?.kinds).toEqual(['Normal', 'Jump']);
  });

  test('an imperial file reports the unit conversion in the dialog and the receipt', async ({ page }) => {
    await openTmlImportDialog(page, IMPERIAL_TML_PATH, 'Imperial Import');

    await expect(page.getByTestId('tml-import-dialog')).toContainText(
      'Converted from imperial to metric'
    );

    await page.getByTestId('tml-import-confirm').click();

    const receipt = page.getByTestId('import-receipt-dialog');
    await expect(receipt).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('import-receipt-unit-conversion')).toHaveText(
      'Lengths converted from feet to meters'
    );
    await page.getByTestId('import-receipt-continue').click();
    await expect(receipt).toBeHidden();
  });

  test('cancelling the TML dialog imports nothing into the fresh project', async ({ page }) => {
    await openTmlImportDialog(page, TML_PATH, 'Cancelled Import');

    await page.getByTestId('tml-import-cancel').click();
    await expect(page.getByTestId('tml-import-dialog')).toBeHidden();

    expect(await getTmlImportCalls(page)).toHaveLength(0);
    expect(await getImportedSections(page)).toEqual([]);
  });
});
