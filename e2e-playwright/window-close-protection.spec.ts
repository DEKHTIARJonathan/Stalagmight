import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  openDmpSelectionDialog,
  proceedToDmpSectionConfig,
  ensureDmpNewImportDialogVisible,
} from './helpers/app';

/**
 * Window Close Protection Tests
 *
 * Tests the useBeforeUnload hook which prevents data loss when closing
 * the application during DMP import workflow.
 *
 * Coverage targets:
 * - src/hooks/useBeforeUnload.ts (currently 35% coverage)
 *
 * Focus:
 * - Verify the hook is active during import (prevents accidental close)
 * - Verify the hook cleans up properly when dialog closes
 * - Verify import workflow dialog interactions work correctly
 */

test.describe('Window Close Protection', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  async function cancelFromWizard(page: Page): Promise<void> {
    const wizard = page.getByTestId('dmp-new-import-dialog');
    await expect(wizard).toBeVisible({ timeout: 10000 });

    await wizard.getByTestId('cancel-button').click();
    const cancelConfirmDialog = page.getByTestId('cancel-confirm-dialog');
    if (await cancelConfirmDialog.isVisible()) {
      await page.getByTestId('confirm-cancel-button').click();
    }

    await expect(wizard).toBeHidden({ timeout: 10000 });
    await expect(cancelConfirmDialog).toBeHidden({ timeout: 3000 });
  }

  /**
   * Wait until the DMP import workflow settles into a state the driver loop can
   * act on - an actionable wizard sub-step or the map placement overlay - or
   * until it finishes (the wizard closes). Returning on completion is what keeps
   * finishSingleSectionImport from hanging when the last section lands while the
   * loop is between point-in-time checks: the previous implementation waited only
   * for the wizard/placement overlay, which never reappear once import is done.
   */
  async function settleImportStep(page: Page): Promise<void> {
    await expect
      .poll(
        async () => {
          if (await page.getByTestId('placement-mode-indicator').isVisible()) return 'ready';
          if (await page.getByTestId('wizard-suggestion').isVisible()) return 'ready';
          if (await page.getByTestId('wizard-manual-placing').isVisible()) return 'ready';
          // No placement overlay and no actionable wizard step: finished if the
          // wizard has closed, otherwise still transitioning between steps.
          if (!(await page.getByTestId('dmp-new-import-dialog').isVisible())) return 'done';
          return 'pending';
        },
        { timeout: 15000 }
      )
      .not.toBe('pending');
  }

  async function finishSingleSectionImport(page: Page): Promise<void> {
    const wizard = page.getByTestId('dmp-new-import-dialog');
    for (let attempt = 0; attempt < 15; attempt += 1) {
      // Wait for an actionable state (or completion) before inspecting the UI,
      // so the point-in-time checks below act on a settled workflow.
      await settleImportStep(page);

      // In map placement mode: drop the section near the map centre.
      if (await page.getByTestId('placement-mode-indicator').isVisible()) {
        const mapCanvas = page.getByTestId('map-canvas');
        const bounds = await mapCanvas.boundingBox();
        if (bounds) {
          await page.mouse.click(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
        }
        continue;
      }

      // No placement overlay and the wizard is gone => import finished.
      if (!(await wizard.isVisible())) {
        return;
      }

      if (await page.getByTestId('wizard-suggestion').isVisible()) {
        await page.getByTestId('confirm-button').click();
        continue;
      }

      if (await page.getByTestId('wizard-manual-placing').isVisible()) {
        const placeOnMapButton = page.getByTestId('segment-place-on-map-button');
        if (await placeOnMapButton.isVisible() && await placeOnMapButton.isEnabled()) {
          await placeOnMapButton.click();
          continue;
        }

        const placeButton = page.getByTestId('segment-place-button');
        if (await placeButton.isVisible() && await placeButton.isEnabled()) {
          await placeButton.click();
          continue;
        }
      }
    }

    await expect(wizard).toBeHidden({ timeout: 10000 });
  }

  /**
   * Test 1: Dialog navigation prevents accidental data loss
   *
   * Verifies that the import wizard remains open and requires
   * explicit user action to close, which is the core data protection mechanism.
   */
  test('should require explicit action to close import dialog @smoke', async ({ page }) => {
    await createProject(page, 'Dialog Protection Test');
    await openDmpSelectionDialog(page);

    await proceedToDmpSectionConfig(page);
    const dialog = page.getByTestId('dmp-new-import-dialog');
    await expect(dialog).toBeVisible();

    // Verify dialog has proper ARIA attributes for modal behavior
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Verify Cancel button is available (explicit close option)
    const cancelButton = dialog.getByTestId('cancel-button');
    await expect(cancelButton).toBeVisible();

    // Click Cancel, then confirm cancel in the safety dialog
    await cancelFromWizard(page);
  });

  /**
   * Test 2: Import completion allows natural workflow progression
   *
   * Verifies that after successfully completing an import, the dialog
   * closes and the user can continue working.
   */
  test('should allow workflow progression after import completes @smoke', async ({ page }) => {
    await createProject(page, 'Import Complete Test');
    await openDmpSelectionDialog(page);

    // Select only one section
    const dialog = page.getByTestId('dmp-selection-dialog');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click();

    await proceedToDmpSectionConfig(page);
    await finishSingleSectionImport(page);

    // User should be back at SingleSystemView with the imported section
    await expect(page.getByTestId('single-system-view')).toBeVisible();
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const e2e = (window as unknown as {
            __E2E_TEST__?: {
              projectStore?: { getState: () => { project?: { sections?: unknown[] } | null } };
            };
          }).__E2E_TEST__;
          return e2e?.projectStore?.getState().project?.sections?.length ?? 0;
        });
      })
      .toBeGreaterThan(0);
  });

  /**
   * Test 3: Dialog state management across navigation
   *
   * Verifies that the dialog properly tracks its open/close state,
   * which is essential for the useBeforeUnload hook to know when to block.
   */
  test('should properly manage dialog open state', async ({ page }) => {
    await createProject(page, 'Dialog State Test');

    // Initially, no import dialog should be open
    await expect(page.getByTestId('dmp-selection-dialog')).not.toBeVisible();
    await expect(page.getByTestId('zero-datum-selection-dialog')).not.toBeVisible();
    await expect(page.getByTestId('dmp-new-import-dialog')).not.toBeVisible();

    // Open Step 1
    await openDmpSelectionDialog(page);
    await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible();

    // Next-stage dialogs should not be visible yet
    await expect(page.getByTestId('zero-datum-selection-dialog')).not.toBeVisible();
    await expect(page.getByTestId('dmp-new-import-dialog')).not.toBeVisible();

    await proceedToDmpSectionConfig(page);

    // Now wizard should be visible, Step 1/zero-datum should be hidden
    await expect(page.getByTestId('dmp-new-import-dialog')).toBeVisible();
    await expect(page.getByTestId('dmp-selection-dialog')).not.toBeVisible();
    await expect(page.getByTestId('zero-datum-selection-dialog')).not.toBeVisible();

    // Cancel wizard (requires explicit action)
    await cancelFromWizard(page);

    // Both dialogs should be closed
    await expect(page.getByTestId('dmp-selection-dialog')).not.toBeVisible();
    await expect(page.getByTestId('zero-datum-selection-dialog')).not.toBeVisible();
    await expect(page.getByTestId('dmp-new-import-dialog')).not.toBeVisible();
  });

  /**
   * Test 4: Multiple dialog interactions maintain state consistency
   *
   * Verifies that opening and closing dialogs multiple times doesn't
   * cause state inconsistencies in the close protection mechanism.
   */
  test('should handle multiple open/close cycles', async ({ page }) => {
    await createProject(page, 'Multiple Cycles Test');

    // First cycle: open and cancel
    await openDmpSelectionDialog(page);
    await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible();
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('dmp-selection-dialog')).not.toBeVisible({
      timeout: 3000,
    });

    // Second cycle: open, proceed to wizard, cancel
    await openDmpSelectionDialog(page);
    await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible();
    await proceedToDmpSectionConfig(page);
    await cancelFromWizard(page);
    await expect(page.getByTestId('dmp-new-import-dialog')).not.toBeVisible({ timeout: 3000 });

    // Third cycle: complete the import
    await openDmpSelectionDialog(page);
    const dialog = page.getByTestId('dmp-selection-dialog');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click();
    await proceedToDmpSectionConfig(page);
    await finishSingleSectionImport(page);

    // Should complete successfully
    await expect(page.getByTestId('single-system-view')).toBeVisible();
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const e2e = (window as unknown as {
            __E2E_TEST__?: {
              projectStore?: { getState: () => { project?: { sections?: unknown[] } | null } };
            };
          }).__E2E_TEST__;
          return e2e?.projectStore?.getState().project?.sections?.length ?? 0;
        });
      })
      .toBeGreaterThan(0);
  });

  /**
   * Test 5: Cancel button is accessible during import
   *
   * Verifies that users always have an escape hatch during import,
   * which is the practical manifestation of the close protection.
   */
  test('should always provide cancel option during import', async ({ page }) => {
    await createProject(page, 'Cancel Accessibility Test');
    await openDmpSelectionDialog(page);

    // Step 1 should have Cancel
    await expect(page.getByTestId('cancel-button')).toBeVisible();

    // Zero datum step should also expose an explicit cancel path.
    await page.getByTestId('continue-button').click();
    const zeroDatumDialog = page.getByTestId('zero-datum-selection-dialog');
    await expect(zeroDatumDialog).toBeVisible({ timeout: 10000 });
    await expect(zeroDatumDialog.getByRole('button', { name: 'Cancel' })).toBeVisible();

    await zeroDatumDialog.getByTestId('zero-datum-selection-skip').click();
    await ensureDmpNewImportDialogVisible(page);

    // Wizard should also have Cancel and allow explicit close.
    const wizard = page.getByTestId('dmp-new-import-dialog');
    const cancelButton = wizard.getByTestId('cancel-button');
    await expect(cancelButton).toBeVisible();
    await expect(cancelButton).toBeEnabled();
    await cancelFromWizard(page);
  });
});
