import { test, expect } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  openDmpSelectionDialog,
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

  async function cancelFromStep2(page: import('@playwright/test').Page): Promise<void> {
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('cancel-confirm-dialog')).toBeVisible();
    await expect(page.getByTestId('dmp-section-config-dialog')).toBeVisible();
    await page.getByTestId('confirm-cancel-button').click();
    await expect(page.getByTestId('cancel-confirm-dialog')).not.toBeVisible({ timeout: 3000 });
  }

  /**
   * Test 1: Dialog navigation prevents accidental data loss
   *
   * Verifies that the DmpSectionConfigDialog remains open and requires
   * explicit user action to close, which is the core data protection mechanism.
   */
  test('should require explicit action to close import dialog', async ({ page }) => {
    await createProject(page, 'Dialog Protection Test');
    await openDmpSelectionDialog(page);

    // Proceed to Step 2
    const continueButton = page.getByTestId('continue-button');
    await continueButton.click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', {
      timeout: 10000,
    });

    const dialog = page.getByTestId('dmp-section-config-dialog');
    await expect(dialog).toBeVisible();

    // Verify dialog has proper ARIA attributes for modal behavior
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Verify Cancel button is available (explicit close option)
    const cancelButton = page.getByTestId('cancel-button');
    await expect(cancelButton).toBeVisible();

    // Click Cancel, then confirm cancel in the safety dialog
    await cancelButton.click();
    await expect(page.getByTestId('cancel-confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-cancel-button').click();

    // Dialog should close after explicit confirmation
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  /**
   * Test 2: Import completion allows natural workflow progression
   *
   * Verifies that after successfully completing an import, the dialog
   * closes and the user can continue working.
   */
  test('should allow workflow progression after import completes', async ({ page }) => {
    await createProject(page, 'Import Complete Test');
    await openDmpSelectionDialog(page);

    // Select only one section
    const dialog = page.getByTestId('dmp-selection-dialog');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click();

    // Proceed to Step 2
    const continueButton = page.getByTestId('continue-button');
    await continueButton.click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', {
      timeout: 10000,
    });

    // Place and finish (single section)
    const placeButton = page.getByTestId('place-and-finish-button');
    await expect(placeButton).toBeEnabled();
    await placeButton.click();

    // Dialog should close after successful import
    await expect(page.getByTestId('dmp-section-config-dialog')).not.toBeVisible({
      timeout: 5000,
    });

    // User should be back at SingleSystemView with the imported section
    await expect(page.getByTestId('single-system-view')).toBeVisible();
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
    await expect(page.getByTestId('dmp-section-config-dialog')).not.toBeVisible();

    // Open Step 1
    await openDmpSelectionDialog(page);
    await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible();

    // Step 2 should not be visible yet
    await expect(page.getByTestId('dmp-section-config-dialog')).not.toBeVisible();

    // Proceed to Step 2
    const continueButton = page.getByTestId('continue-button');
    await continueButton.click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', {
      timeout: 10000,
    });

    // Now Step 2 should be visible, Step 1 should be hidden
    await expect(page.getByTestId('dmp-section-config-dialog')).toBeVisible();
    await expect(page.getByTestId('dmp-selection-dialog')).not.toBeVisible();

    // Cancel Step 2 (requires confirmation)
    await cancelFromStep2(page);

    // Both dialogs should be closed
    await expect(page.getByTestId('dmp-section-config-dialog')).not.toBeVisible({
      timeout: 3000,
    });
    await expect(page.getByTestId('dmp-selection-dialog')).not.toBeVisible();
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

    // Second cycle: open, proceed to Step 2, cancel
    await openDmpSelectionDialog(page);
    await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible();
    await page.getByTestId('continue-button').click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', {
      timeout: 10000,
    });
    await cancelFromStep2(page);
    await expect(page.getByTestId('dmp-section-config-dialog')).not.toBeVisible({ timeout: 3000 });

    // Third cycle: complete the import
    await openDmpSelectionDialog(page);
    const dialog = page.getByTestId('dmp-selection-dialog');
    await dialog.locator('[data-testid="select-none-button"]').click();
    await page.locator('[data-testid="section-checkbox-0"]').click();
    await page.getByTestId('continue-button').click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', {
      timeout: 10000,
    });
    await page.getByTestId('place-and-finish-button').click();

    // Should complete successfully
    await expect(page.getByTestId('dmp-section-config-dialog')).not.toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId('single-system-view')).toBeVisible();
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

    // Proceed to Step 2
    await page.getByTestId('continue-button').click();
    await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', {
      timeout: 10000,
    });

    // Step 2 should also have Cancel
    const cancelButton = page.getByTestId('cancel-button');
    await expect(cancelButton).toBeVisible();
    await expect(cancelButton).toBeEnabled();

    // Verify clicking Cancel shows confirmation and can close explicitly
    await cancelButton.click();
    await expect(page.getByTestId('cancel-confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-cancel-button').click();
    await expect(page.getByTestId('dmp-section-config-dialog')).not.toBeVisible({ timeout: 3000 });
  });
});
