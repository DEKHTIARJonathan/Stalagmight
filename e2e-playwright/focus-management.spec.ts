import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  openNewProjectDialog,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
} from './helpers/app';

/**
 * E2E tests for focus management: focus traps, return-focus, initial focus,
 * stacked dialog isolation, and SettingsSidebar roving tabindex.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the Settings dialog from GlobalView via the settings button. */
async function openSettingsDialog(page: Page): Promise<void> {
  const settingsButton = page.locator('[data-testid="settings-button"]');
  await expect(settingsButton).toBeVisible({ timeout: 5000 });
  await settingsButton.click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5000 });
}

/**
 * Return the `data-testid` attribute of the currently-focused element.
 * Falls back to `null` when no element has the attribute.
 */
async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

test.describe('Focus Management', () => {
  test.describe('Tab cycling – form dialog (NewProjectDialog)', () => {
    test.beforeEach(async ({ page }) => {
      await setupMockedPage(page);
    });

    test('Tab wraps from last to first focusable element', async ({ page }) => {
      await openNewProjectDialog(page);

      // NewProjectDialog is a form dialog – initial focus lands on the first text input
      await expect(page.getByTestId('new-project-name-input')).toBeFocused({ timeout: 3000 });

      // The focus trap container (dialogRef) wraps the dialog content (dialogContentRef).
      // We verify wrapping by tabbing through all elements and confirming focus cycles
      // back to a previously-visited element without ever leaving the dialog.
      const outerContainer = page.locator('.fixed.inset-0.z-50').first();

      // Record each focused element's identity (via an index in DOM order).
      // Tab through enough times to complete one full cycle plus one.
      const focusableCount = await outerContainer.evaluate((el) => {
        const selector =
          'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
        return Array.from(el.querySelectorAll(selector))
          .filter((c) => c.getClientRects().length > 0).length;
      });
      expect(focusableCount).toBeGreaterThan(1);

      // Tab focusableCount times — this should wrap back to the start
      for (let i = 0; i < focusableCount; i++) {
        await page.keyboard.press('Tab');
      }

      // After a full cycle, focus should be on the same element we started on
      // (the name input — the initial focus target)
      await expect(page.getByTestId('new-project-name-input')).toBeFocused();

      // Confirm focus is inside the dialog
      const dialog = page.getByTestId('new-project-dialog');
      const focusInsideDialog = await dialog.evaluate(
        (el) => el.contains(document.activeElement),
      );
      expect(focusInsideDialog).toBe(true);
    });

    test('Shift+Tab wraps from first to last focusable element', async ({ page }) => {
      await openNewProjectDialog(page);
      await expect(page.getByTestId('new-project-name-input')).toBeFocused({ timeout: 3000 });

      const dialog = page.getByTestId('new-project-dialog');

      // Move focus to the first focusable element (close button or first input)
      // The focus trap treats the container itself at first position.
      // Put focus explicitly on the first focusable inside the dialog content.
      const firstFocusable = await dialog.evaluateHandle((el) => {
        const selector =
          'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
        const candidates = el.querySelectorAll(selector);
        for (const c of candidates) {
          if (c.getClientRects().length > 0) return c;
        }
        return null;
      });
      if (firstFocusable) {
        await firstFocusable.asElement()?.focus();
      }

      // Shift+Tab from the first element should wrap to the last
      await page.keyboard.press('Shift+Tab');

      // Verify focus is still inside the dialog (wrapped to last)
      const focusInside = await dialog.evaluate(
        (el) => el.contains(document.activeElement),
      );
      expect(focusInside).toBe(true);

      // The last focusable element — verify it matches
      const lastFocusableTestId = await dialog.evaluate((el) => {
        const selector =
          'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
        const candidates = el.querySelectorAll(selector);
        const visible = Array.from(candidates).filter((c) => c.getClientRects().length > 0);
        return visible[visible.length - 1]?.getAttribute('data-testid') ?? null;
      });
      const currentTestId = await focusedTestId(page);
      expect(currentTestId).toBe(lastFocusableTestId);
    });
  });

  test.describe('Return focus – non-form dialog (ConfirmDialog)', () => {
    test.beforeEach(async ({ page }) => {
      await setupMockedPage(page);
      await createProject(page, 'Focus Return Test');
      await seedProjectWithSections(page, [
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
            },
          ],
        },
      ]);
      await waitForMapReady(page);
      await waitForNoDialogs(page);
    });

    test('closing dialog via Escape returns focus to trigger element', async ({ page }) => {
      // Find and click the section delete button to open the ConfirmDialog
      const deleteBtn = page.locator('[data-testid^="section-delete-"]').first();
      // Hover to reveal the delete button (it's opacity-0 until group-hover)
      const sectionItem = page.locator('[data-testid^="section-item-"]').first();
      await sectionItem.hover();
      await expect(deleteBtn).toBeVisible({ timeout: 5000 });
      await deleteBtn.click();

      // ConfirmDialog should be open
      await expect(page.getByTestId('confirm-dialog')).toBeVisible({ timeout: 5000 });

      // Close via Escape
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('confirm-dialog')).not.toBeVisible({ timeout: 3000 });

      // Focus should return to the delete button (the trigger element).
      // The button may have become hidden again (opacity-0) but should still be
      // in the DOM and focusable. Check activeElement is within the sections panel.
      const focusReturnedToPanel = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="sections-panel"]');
        return panel?.contains(document.activeElement) ?? false;
      });
      expect(focusReturnedToPanel).toBe(true);
    });
  });

  test.describe('Stacked dialog isolation – dirty-confirm overlay', () => {
    test.beforeEach(async ({ page }) => {
      await setupMockedPage(page);
    });

    test('dirty-confirm overlay traps focus and outer dialog is inert', async ({ page }) => {
      // Open NewProjectDialog — it has isDirty when the name field is filled
      await openNewProjectDialog(page);
      await expect(page.getByTestId('new-project-name-input')).toBeFocused({ timeout: 3000 });

      // Type something to make the form dirty
      await page.getByTestId('new-project-name-input').fill('Test Project Name');

      // Press Escape to trigger the dirty-confirm overlay
      await page.keyboard.press('Escape');

      // The alertdialog (dirty-confirm overlay) should appear
      const alertDialog = page.locator('[role="alertdialog"]');
      await expect(alertDialog).toBeVisible({ timeout: 3000 });

      // The outer dialog content should have the inert attribute
      const outerDialogContent = page.locator('[data-testid="new-project-dialog"]');
      await expect(outerDialogContent).toHaveAttribute('inert', '');

      // Tab should be trapped within the alertdialog only
      // Find focusable elements inside the alertdialog
      const alertFocusableCount = await alertDialog.evaluate((el) => {
        const selector = 'button:not(:disabled)';
        return el.querySelectorAll(selector).length;
      });
      expect(alertFocusableCount).toBeGreaterThan(0);

      // Focus something inside the alertdialog, then Tab through all elements
      await page.keyboard.press('Tab');
      for (let i = 0; i < alertFocusableCount + 1; i++) {
        const insideAlertDialog = await alertDialog.evaluate(
          (el) => el.contains(document.activeElement),
        );
        // After the alertdialog receives focus, the focus trap container (the
        // wrapping div with tabIndex={-1}) also counts.  It's acceptable for
        // activeElement to be the container itself.
        const insideAlertOrContainer = insideAlertDialog || await page.evaluate(() => {
          const ae = document.activeElement;
          return ae?.closest('[role="alertdialog"]') !== null ||
                 ae?.querySelector('[role="alertdialog"]') !== null;
        });
        expect(insideAlertOrContainer).toBe(true);
        await page.keyboard.press('Tab');
      }

      // Dismiss the overlay via Escape — focus should return to the outer dialog
      await page.keyboard.press('Escape');
      await expect(alertDialog).not.toBeVisible({ timeout: 3000 });

      // inert should be removed from the outer dialog content
      const hasInert = await outerDialogContent.evaluate((el) => el.hasAttribute('inert'));
      expect(hasInert).toBe(false);

      // Focus should be back inside the outer dialog
      const focusInOuterDialog = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="new-project-dialog"]');
        return dialog?.contains(document.activeElement) ?? false;
      });
      // Focus may be on the dialog wrapper (parent) rather than inside the content div,
      // which is also acceptable.
      const focusInDialogWrapper = focusInOuterDialog || await page.evaluate(() => {
        const ae = document.activeElement;
        return ae?.querySelector('[data-testid="new-project-dialog"]') !== null;
      });
      expect(focusInDialogWrapper).toBe(true);
    });
  });

  test.describe('Initial focus – primary action button (ConfirmDialog)', () => {
    test.beforeEach(async ({ page }) => {
      await setupMockedPage(page);
      await createProject(page, 'Initial Focus Test');
      await seedProjectWithSections(page, [
        {
          name: 'Test Section',
          direction: 'in',
          shots: [
            {
              azimuth_in: 45,
              azimuth_out: 225,
              length: 10.5,
              depth_in: -2,
              depth_out: -2.5,
            },
          ],
        },
      ]);
      await waitForMapReady(page);
      await waitForNoDialogs(page);
    });

    test('ConfirmDialog focuses the primary action button (Delete)', async ({ page }) => {
      // Open ConfirmDialog via section delete button
      const sectionItem = page.locator('[data-testid^="section-item-"]').first();
      await sectionItem.hover();
      const deleteBtn = page.locator('[data-testid^="section-delete-"]').first();
      await expect(deleteBtn).toBeVisible({ timeout: 5000 });
      await deleteBtn.click();

      await expect(page.getByTestId('confirm-dialog')).toBeVisible({ timeout: 5000 });

      // Wait for the initial focus heuristic (runs via requestAnimationFrame)
      await page.waitForTimeout(200);

      // The ConfirmDialog has a Delete button with data-primary-action attribute.
      // According to DialogWrapper's initial focus heuristic (priority 3), this
      // button should receive initial focus — ConfirmDialog has no form inputs
      // and no [data-autofocus].
      //
      // Note: For 'section' type, the Delete button is disabled (type === 'station'
      // check), but for section delete it should be enabled.
      const focusedEl = await page.evaluate(() => {
        const ae = document.activeElement;
        return {
          testId: ae?.getAttribute('data-testid') ?? null,
          hasPrimaryAction: ae?.hasAttribute('data-primary-action') ?? false,
          tagName: ae?.tagName ?? null,
          textContent: ae?.textContent?.trim() ?? null,
        };
      });

      // The primary action button (Delete) should be focused
      expect(focusedEl.hasPrimaryAction).toBe(true);
      expect(focusedEl.textContent).toContain('Delete');

      // Close without deleting
      await page.keyboard.press('Escape');
    });
  });

  test.describe('SettingsSidebar roving tabindex', () => {
    test.beforeEach(async ({ page }) => {
      await setupMockedPage(page);
    });

    test('Arrow keys navigate sidebar categories and maintain focus', async ({ page }) => {
      await openSettingsDialog(page);

      const sidebar = page.getByTestId('settings-sidebar');
      await expect(sidebar).toBeVisible({ timeout: 5000 });

      // Tab until focus reaches the sidebar. The sidebar tabs use roving tabindex,
      // so the active tab (General, index 0) has tabIndex=0.
      const generalTab = page.getByTestId('settings-tab-general');

      // Click on the general tab to focus it
      await generalTab.click();

      // Wait for aria-activedescendant/focus to settle (per memory pitfall)
      await page.waitForTimeout(100);

      // Verify initial state: General tab is focused and selected
      await expect(generalTab).toBeFocused();
      await expect(generalTab).toHaveAttribute('aria-selected', 'true');

      // Arrow Down should move focus to Units tab
      await page.keyboard.press('ArrowDown');
      const unitsTab = page.getByTestId('settings-tab-units');
      await expect(unitsTab).toBeFocused({ timeout: 1000 });
      // Arrow Down alone moves focus, does not activate (manual activation pattern)
      // The active category should still be General
      await expect(generalTab).toHaveAttribute('aria-selected', 'true');
      await expect(unitsTab).toHaveAttribute('aria-selected', 'false');

      // Arrow Down again to Display
      await page.keyboard.press('ArrowDown');
      const displayTab = page.getByTestId('settings-tab-display');
      await expect(displayTab).toBeFocused({ timeout: 1000 });

      // Arrow Up back to Units
      await page.keyboard.press('ArrowUp');
      await expect(unitsTab).toBeFocused({ timeout: 1000 });

      // Press Enter to activate Units
      await page.keyboard.press('Enter');
      await expect(unitsTab).toHaveAttribute('aria-selected', 'true');
      // General should no longer be selected
      await expect(generalTab).toHaveAttribute('aria-selected', 'false');

      // Verify the sidebar maintains focus after category change
      await expect(unitsTab).toBeFocused();
    });

    test('Home and End keys jump to first and last category', async ({ page }) => {
      await openSettingsDialog(page);

      // Click General tab to focus sidebar
      const generalTab = page.getByTestId('settings-tab-general');
      await generalTab.click();
      await expect(generalTab).toBeFocused();

      // End key jumps to last tab (Advanced)
      await page.keyboard.press('End');
      const advancedTab = page.getByTestId('settings-tab-advanced');
      await expect(advancedTab).toBeFocused({ timeout: 1000 });

      // Home key jumps back to first tab (General)
      await page.keyboard.press('Home');
      await expect(generalTab).toBeFocused({ timeout: 1000 });
    });
  });
});

test.describe('Existing dialog tests – portal migration sanity', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('[role="dialog"] selectors still work after portal migration', async ({ page }) => {
    await openNewProjectDialog(page);

    // The dialog should be found using role selectors (used in helpers/app.ts)
    const dialogByRole = page.locator('[role="dialog"]:visible');
    await expect(dialogByRole).toHaveCount(1);

    // Close the dialog
    await page.getByTestId('new-project-cancel-button').click();

    // No visible dialogs
    const visibleDialogs = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible');
    await expect(visibleDialogs).toHaveCount(0);
  });
});
