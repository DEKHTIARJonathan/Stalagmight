import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * E2E tests for keyboard shortcuts configuration in Settings dialog.
 * Tests recording, conflict detection, reset functionality, search filtering,
 * save/cancel behavior, and shortcut functionality after save.
 */

/**
 * Helper to create a new project with mock sections/stations
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Wait for map to be fully initialized (per memory pitfall)
  await page.waitForFunction(() => (window as unknown as { __cavechef_map__?: unknown }).__cavechef_map__ !== undefined, { timeout: 10000 });
}

/**
 * Helper to go back to GlobalView from a project view
 */
async function goBackToGlobalView(page: Page): Promise<void> {
  const backButton = page.locator('[data-testid="back-button"]');
  if (await backButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await backButton.click();
    // Wait for GlobalView to appear
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible({ timeout: 5000 });
  }
}

/**
 * Helper to open Settings dialog
 * Settings is only accessible from GlobalView, so we need to navigate there first
 */
async function openSettingsDialog(page: Page): Promise<void> {
  // Go back to GlobalView if we're in a project
  await goBackToGlobalView(page);

  // Settings button is in GlobalView header
  const settingsButton = page.locator('[data-testid="settings-button"]');
  await expect(settingsButton).toBeVisible({ timeout: 5000 });
  await settingsButton.click();
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeVisible({ timeout: 5000 });
}

/**
 * Helper to navigate to the Shortcuts category via sidebar
 * Updated for new sidebar layout (was tab-based, now sidebar-based)
 */
async function navigateToShortcutsCategory(page: Page): Promise<void> {
  // Click on the Shortcuts item in the settings sidebar
  await page.locator('[data-testid="settings-tab-shortcuts"]').click();
  // Wait for the shortcuts panel to become visible
  await expect(page.locator('[data-testid="settings-panel-shortcuts"]')).toBeVisible({ timeout: 2000 });
}

/**
 * Helper to wait for ShortcutRecorder recording state
 */
async function waitForRecording(page: Page, testId: string, isRecording: boolean): Promise<void> {
  const recorder = page.locator(`[data-testid="${testId}"]`);
  await expect(recorder).toHaveAttribute('data-recording', String(isRecording), { timeout: 2000 });
}

test.describe('Settings Dialog - Shortcuts Tab', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Shortcuts Test Project');
  });

  test.describe('Navigation', () => {
    test('opens Settings dialog and navigates to Shortcuts tab', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Verify shortcuts panel content is visible
      await expect(page.locator('[data-testid="settings-panel-shortcuts"]')).toBeVisible();

      // Verify search input exists
      await expect(page.locator('[data-testid="shortcuts-search"]')).toBeVisible();

      // Verify reserved shortcuts section exists
      await expect(page.locator('[data-testid="reserved-shortcuts"]')).toBeVisible();

      // Verify categories are visible (File is now the first category)
      await expect(page.locator('[data-testid="shortcut-category-file"]')).toBeVisible();
      await expect(page.locator('[data-testid="shortcut-category-tools"]')).toBeVisible();
    });
  });

  test.describe('Search Filtering', () => {
    test('search filters actions by name', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Verify Select action is visible initially
      await expect(page.locator('[data-testid="shortcut-row-select"]')).toBeVisible();

      // Search for "zoom"
      await page.locator('[data-testid="shortcuts-search"]').fill('zoom');
      await page.waitForTimeout(100);

      // Zoom-related actions should be visible
      await expect(page.locator('[data-testid="shortcut-row-zoom"]')).toBeVisible();
      await expect(page.locator('[data-testid="shortcut-row-zoom_in"]')).toBeVisible();
      await expect(page.locator('[data-testid="shortcut-row-zoom_out"]')).toBeVisible();

      // Non-matching actions should be hidden
      await expect(page.locator('[data-testid="shortcut-row-select"]')).not.toBeVisible();
      await expect(page.locator('[data-testid="shortcut-row-pan"]')).not.toBeVisible();
    });

    test('search filters by key binding', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Search for "Ctrl+Z" (undo binding)
      await page.locator('[data-testid="shortcuts-search"]').fill('Ctrl+Z');
      await page.waitForTimeout(100);

      // Undo action (which has Ctrl+Z) should be visible
      await expect(page.locator('[data-testid="shortcut-row-undo"]')).toBeVisible();

      // Unrelated actions should be hidden
      await expect(page.locator('[data-testid="shortcut-row-select"]')).not.toBeVisible();
    });

    test('clearing search shows all actions', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Search for something specific
      await page.locator('[data-testid="shortcuts-search"]').fill('undo');
      await page.waitForTimeout(100);

      // Clear search
      await page.locator('[data-testid="shortcuts-search"]').fill('');
      await page.waitForTimeout(100);

      // All categories and actions should be visible again
      await expect(page.locator('[data-testid="shortcut-category-tools"]')).toBeVisible();
      await expect(page.locator('[data-testid="shortcut-row-select"]')).toBeVisible();
      await expect(page.locator('[data-testid="shortcut-row-undo"]')).toBeVisible();
    });
  });

  test.describe('Shortcut Recording', () => {
    test('records new shortcut via keyboard', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Click on the primary shortcut recorder for "select" action
      const recorder = page.locator('[data-testid="shortcut-primary-select"]');

      // Verify original shortcut is S
      await expect(recorder).toContainText('S');

      await recorder.click();

      // Verify recording state is active
      await waitForRecording(page, 'shortcut-primary-select', true);

      // Press a new key combination
      await page.keyboard.press('Q');

      // Recording should complete and show the new shortcut
      await waitForRecording(page, 'shortcut-primary-select', false);

      // Verify the shortcut was recorded (should show Q in key badge)
      // Note: The ARIA status says "Shortcut set to Q" so we check for the key badge specifically
      await expect(recorder.locator('span').filter({ hasText: 'Q' }).first()).toBeVisible();
    });

    test('Escape cancels recording', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      const recorder = page.locator('[data-testid="shortcut-primary-select"]');

      // Verify original shortcut is S
      await expect(recorder).toContainText('S');

      // Start recording
      await recorder.click();
      await waitForRecording(page, 'shortcut-primary-select', true);

      // Cancel with Escape
      await page.keyboard.press('Escape');

      // Recording should be canceled
      await waitForRecording(page, 'shortcut-primary-select', false);

      // Original value should be preserved (S)
      await expect(recorder).toContainText('S');
    });

    test('records modifier combinations', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Record a modifier combination for the secondary slot of "select"
      const recorder = page.locator('[data-testid="shortcut-secondary-select"]');
      await recorder.click();
      await waitForRecording(page, 'shortcut-secondary-select', true);

      // Press Ctrl+Shift+W
      await page.keyboard.press('Control+Shift+W');

      await waitForRecording(page, 'shortcut-secondary-select', false);

      // Verify the modifier combination is shown
      await expect(recorder).toContainText('Ctrl');
      await expect(recorder).toContainText('Shift');
      await expect(recorder).toContainText('W');
    });
  });

  test.describe('Conflict Detection', () => {
    test('shows error when recording a reserved shortcut', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Try to assign a reserved shortcut (Escape)
      const recorder = page.locator('[data-testid="shortcut-primary-pan"]');
      await recorder.click();
      await waitForRecording(page, 'shortcut-primary-pan', true);

      // Press Escape - this should be blocked (reserved key)
      // Note: Escape cancels recording, so we try a different reserved one
      // Let's use Delete
      await page.keyboard.press('Delete');

      // Check for error message about reserved shortcut
      await expect(page.locator('[data-testid="shortcut-error"]')).toBeVisible({ timeout: 2000 });
      await expect(page.locator('[data-testid="shortcut-error"]')).toContainText('cannot be assigned');
    });

    test('shows error when recording a duplicate shortcut', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Try to assign "P" to select (P is already used by pan)
      const recorder = page.locator('[data-testid="shortcut-primary-select"]');
      await recorder.click();
      await waitForRecording(page, 'shortcut-primary-select', true);

      // Press P (which is already assigned to pan)
      await page.keyboard.press('P');
      await waitForRecording(page, 'shortcut-primary-select', false);

      // Check for conflict error message
      await expect(page.locator('[data-testid="shortcut-error"]')).toBeVisible({ timeout: 2000 });
      await expect(page.locator('[data-testid="shortcut-error"]')).toContainText('already used by');
    });

    test('shows error when assigning same shortcut to both slots of same action', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // First, set primary slot of draw to 'K'
      const primaryRecorder = page.locator('[data-testid="shortcut-primary-draw"]');
      await primaryRecorder.click();
      await waitForRecording(page, 'shortcut-primary-draw', true);
      await page.keyboard.press('K');
      await waitForRecording(page, 'shortcut-primary-draw', false);

      // Clear any previous error
      await page.waitForTimeout(100);

      // Try to assign same key to secondary slot
      const secondaryRecorder = page.locator('[data-testid="shortcut-secondary-draw"]');
      await secondaryRecorder.click();
      await waitForRecording(page, 'shortcut-secondary-draw', true);
      await page.keyboard.press('K');
      await waitForRecording(page, 'shortcut-secondary-draw', false);

      // Should show error about intra-action duplicate
      await expect(page.locator('[data-testid="shortcut-error"]')).toBeVisible({ timeout: 2000 });
      await expect(page.locator('[data-testid="shortcut-error"]')).toContainText('already assigned');
    });
  });

  test.describe('Reset Functionality', () => {
    test('reset single shortcut restores default', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Change the select shortcut
      const recorder = page.locator('[data-testid="shortcut-primary-select"]');
      await recorder.click();
      await waitForRecording(page, 'shortcut-primary-select', true);
      await page.keyboard.press('Q');
      await waitForRecording(page, 'shortcut-primary-select', false);

      // Verify shortcut changed
      await expect(recorder).toContainText('Q');

      // Click reset button for select action
      const resetButton = page.locator('[data-testid="shortcut-reset-select"]');
      await expect(resetButton).not.toBeDisabled(); // Should be enabled since we changed it
      await resetButton.click();

      // Verify shortcut is back to default (S)
      await expect(recorder).toContainText('S');
    });

    test('reset button is disabled when no changes', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Reset button should be disabled for unchanged shortcut
      const resetButton = page.locator('[data-testid="shortcut-reset-select"]');
      await expect(resetButton).toBeDisabled();
    });

    test('Reset All restores all shortcuts to defaults', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Change multiple shortcuts
      const selectRecorder = page.locator('[data-testid="shortcut-primary-select"]');
      await selectRecorder.click();
      await page.keyboard.press('Q');
      await waitForRecording(page, 'shortcut-primary-select', false);

      const panRecorder = page.locator('[data-testid="shortcut-primary-pan"]');
      await panRecorder.click();
      await page.keyboard.press('W');
      await waitForRecording(page, 'shortcut-primary-pan', false);

      // Click Reset All button
      const resetAllButton = page.locator('[data-testid="shortcuts-reset-all"]');
      await resetAllButton.click();

      // Verify all shortcuts are back to defaults
      await expect(selectRecorder).toContainText('S');
      await expect(panRecorder).toContainText('P');
    });
  });

  test.describe('Save and Cancel', () => {
    test('Save persists changes', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Change a shortcut
      const recorder = page.locator('[data-testid="shortcut-primary-select"]');
      await recorder.click();
      await page.keyboard.press('Q');
      await waitForRecording(page, 'shortcut-primary-select', false);

      // Verify change is shown
      await expect(recorder).toContainText('Q');

      // Save changes
      await page.locator('[data-testid="settings-save-button"]').click();

      // Dialog should close
      await expect(page.locator('[data-testid="settings-dialog"]')).not.toBeVisible({ timeout: 5000 });

      // Reopen settings and verify change persisted
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Re-find the recorder after dialog reopened
      const recorderAfter = page.locator('[data-testid="shortcut-primary-select"]');
      await expect(recorderAfter).toContainText('Q');
    });

    test('Cancel discards changes', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Change a shortcut
      const recorder = page.locator('[data-testid="shortcut-primary-select"]');
      await recorder.click();
      await page.keyboard.press('Q');
      await waitForRecording(page, 'shortcut-primary-select', false);

      // Verify change is shown locally
      await expect(recorder).toContainText('Q');

      // Cancel using testid
      await page.locator('[data-testid="settings-cancel-button"]').click();

      // Handle potential confirmation dialog for dirty state using testids
      const confirmDialog = page.locator('[data-testid="unsaved-changes-dialog"]');
      if (await confirmDialog.isVisible({ timeout: 1000 }).catch(() => false)) {
        await page.locator('[data-testid="unsaved-discard"]').click();
      }

      // Dialog should close
      await expect(page.locator('[data-testid="settings-dialog"]')).not.toBeVisible({ timeout: 5000 });

      // Reopen settings and verify change was NOT persisted
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Re-find the recorder after dialog reopened
      const recorderAfter = page.locator('[data-testid="shortcut-primary-select"]');
      // Should show original shortcut (S), not changed one (Q)
      await expect(recorderAfter).toContainText('S');
    });
  });

  test.describe('Shortcut Functionality After Save', () => {
    test('customized shortcut works after save', async ({ page }) => {
      // beforeEach has already created a project and we're in project view
      // Open settings from GlobalView (need to go back first)
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Change the pan tool shortcut from P to Q
      const recorder = page.locator('[data-testid="shortcut-primary-pan"]');
      await recorder.click();
      await page.keyboard.press('Q');
      await waitForRecording(page, 'shortcut-primary-pan', false);

      // Save
      await page.locator('[data-testid="settings-save-button"]').click();
      await expect(page.locator('[data-testid="settings-dialog"]')).not.toBeVisible({ timeout: 3000 });

      // Create a new project to test shortcut functionality
      // (we're now in GlobalView after Settings closed)
      await createProject(page, 'Shortcut Test Project');

      // Get the current tool from store
      const toolBefore = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { activeTool: string } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.activeTool ?? 'unknown';
      });

      // Press Q (new pan shortcut)
      await page.keyboard.press('Q');
      await page.waitForTimeout(200);

      // Verify pan tool is now active
      const toolAfter = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { activeTool: string } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.activeTool ?? 'unknown';
      });
      expect(toolAfter).toBe('pan');

      // Verify old shortcut (P) no longer activates pan
      // Switch to select first
      await page.keyboard.press('S');
      await page.waitForTimeout(100);

      await page.keyboard.press('P');
      await page.waitForTimeout(100);

      // Tool should NOT change to pan (P is now unassigned for pan)
      const toolAfterP = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { activeTool: string } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.activeTool ?? 'unknown';
      });
      expect(toolAfterP).toBe('select'); // Should stay as select
    });
  });

  test.describe('Category Collapse/Expand', () => {
    test('categories can be collapsed and expanded', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Verify Tools category is expanded by default
      const toolsToggle = page.locator('[data-testid="shortcut-category-toggle-tools"]');
      await expect(page.locator('[data-testid="shortcut-row-select"]')).toBeVisible();

      // Collapse Tools category
      await toolsToggle.click();
      await page.waitForTimeout(100);

      // Actions should be hidden
      await expect(page.locator('[data-testid="shortcut-row-select"]')).not.toBeVisible();

      // Expand again
      await toolsToggle.click();
      await page.waitForTimeout(100);

      // Actions should be visible again
      await expect(page.locator('[data-testid="shortcut-row-select"]')).toBeVisible();
    });
  });

  test.describe('Reserved Shortcuts Display', () => {
    test('reserved shortcuts are displayed correctly', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      const reserved = page.locator('[data-testid="reserved-shortcuts"]');
      await expect(reserved).toBeVisible();

      // Verify reserved shortcuts are shown (Ctrl+I and Ctrl+E are no longer reserved)
      await expect(reserved).toContainText('Escape');
      await expect(reserved).toContainText('Delete');
      await expect(reserved).toContainText('Ctrl+A');

      // Ctrl+I and Ctrl+E should NOT be in reserved section (they are now configurable)
      await expect(reserved).not.toContainText('Ctrl+I');
      await expect(reserved).not.toContainText('Ctrl+E');
    });

    test('reserved shortcuts section is positioned above search bar', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      const reserved = page.locator('[data-testid="reserved-shortcuts"]');
      const search = page.locator('[data-testid="shortcuts-search"]');

      await expect(reserved).toBeVisible();
      await expect(search).toBeVisible();

      // Verify reserved section precedes search bar in DOM order
      // compareDocumentPosition returns bitmask; bit 4 (DOCUMENT_POSITION_FOLLOWING) means search follows reserved
      const reservedPrecedesSearch = await page.evaluate(() => {
        const reservedEl = document.querySelector('[data-testid="reserved-shortcuts"]');
        const searchEl = document.querySelector('[data-testid="shortcuts-search"]');
        if (!reservedEl || !searchEl) return false;
        // Bit 4 = DOCUMENT_POSITION_FOLLOWING: searchEl follows reservedEl
        return (reservedEl.compareDocumentPosition(searchEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      expect(reservedPrecedesSearch).toBe(true);
    });
  });

  test.describe('File Category Shortcuts', () => {
    test('File category with Import DMP and Export shortcuts is visible', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Verify File category exists
      await expect(page.locator('[data-testid="shortcut-category-file"]')).toBeVisible();

      // Verify Import DMP and Export rows exist
      await expect(page.locator('[data-testid="shortcut-row-import_dmp"]')).toBeVisible();
      await expect(page.locator('[data-testid="shortcut-row-export"]')).toBeVisible();

      // Verify default bindings
      const importRecorder = page.locator('[data-testid="shortcut-primary-import_dmp"]');
      await expect(importRecorder).toContainText('Ctrl');
      await expect(importRecorder).toContainText('I');

      const exportRecorder = page.locator('[data-testid="shortcut-primary-export"]');
      await expect(exportRecorder).toContainText('Ctrl');
      await expect(exportRecorder).toContainText('E');
    });

    test('Ctrl+I and Ctrl+E can be reassigned without conflict error', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Reassign Import DMP from Ctrl+I to Ctrl+Shift+K (avoid Ctrl+Shift+I which opens browser DevTools)
      const importRecorder = page.locator('[data-testid="shortcut-primary-import_dmp"]');
      await importRecorder.click();
      await waitForRecording(page, 'shortcut-primary-import_dmp', true);
      await page.keyboard.press('Control+Shift+K');
      await waitForRecording(page, 'shortcut-primary-import_dmp', false);

      // Verify new binding is shown
      await expect(importRecorder).toContainText('Ctrl');
      await expect(importRecorder).toContainText('Shift');
      await expect(importRecorder).toContainText('K');

      // No error should appear
      await expect(page.locator('[data-testid="shortcut-error"]')).not.toBeVisible();

      // Now assign Ctrl+I to a different action (select) - should NOT conflict since it was freed
      const selectRecorder = page.locator('[data-testid="shortcut-primary-select"]');
      await selectRecorder.click();
      await waitForRecording(page, 'shortcut-primary-select', true);
      await page.keyboard.press('Control+I');
      await waitForRecording(page, 'shortcut-primary-select', false);

      // Should show Ctrl+I without error (it's no longer reserved or taken)
      await expect(selectRecorder).toContainText('Ctrl');
      await expect(selectRecorder).toContainText('I');
      await expect(page.locator('[data-testid="shortcut-error"]')).not.toBeVisible();

      // Also reassign Export from Ctrl+E to Ctrl+Shift+J
      const exportRecorder = page.locator('[data-testid="shortcut-primary-export"]');
      await exportRecorder.click();
      await waitForRecording(page, 'shortcut-primary-export', true);
      await page.keyboard.press('Control+Shift+J');
      await waitForRecording(page, 'shortcut-primary-export', false);

      // Verify new binding is shown
      await expect(exportRecorder).toContainText('Ctrl');
      await expect(exportRecorder).toContainText('Shift');
      await expect(exportRecorder).toContainText('J');

      // No error should appear
      await expect(page.locator('[data-testid="shortcut-error"]')).not.toBeVisible();

      // Assign freed Ctrl+E to pan - should NOT conflict since it was freed
      const panRecorder = page.locator('[data-testid="shortcut-primary-pan"]');
      await panRecorder.click();
      await waitForRecording(page, 'shortcut-primary-pan', true);
      await page.keyboard.press('Control+E');
      await waitForRecording(page, 'shortcut-primary-pan', false);

      // Should show Ctrl+E without error
      await expect(panRecorder).toContainText('Ctrl');
      await expect(panRecorder).toContainText('E');
      await expect(page.locator('[data-testid="shortcut-error"]')).not.toBeVisible();
    });

    test('customized Import DMP shortcut triggers import dialog', async ({ page }) => {
      // We start in project view from beforeEach
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      // Change Import DMP shortcut from Ctrl+I to Ctrl+Shift+M
      const importRecorder = page.locator('[data-testid="shortcut-primary-import_dmp"]');
      await importRecorder.click();
      await waitForRecording(page, 'shortcut-primary-import_dmp', true);
      await page.keyboard.press('Control+Shift+M');
      await waitForRecording(page, 'shortcut-primary-import_dmp', false);

      // Save settings
      await page.locator('[data-testid="settings-save-button"]').click();
      await expect(page.locator('[data-testid="settings-dialog"]')).not.toBeVisible({ timeout: 3000 });

      // Navigate to a project so import shortcut is handled
      await createProject(page, 'Import Shortcut Test');

      // Press the customized shortcut (Ctrl+Shift+M)
      await page.keyboard.press('Control+Shift+M');

      // The import flow should trigger - in mock context, the file dialog returns
      // a mock path and the dmp-selection dialog should appear
      await expect(page.locator('[data-testid="dmp-selection-dialog"]')).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Clear Shortcut', () => {
    test('clear button removes shortcut binding', async ({ page }) => {
      await openSettingsDialog(page);
      await navigateToShortcutsCategory(page);

      const recorder = page.locator('[data-testid="shortcut-primary-select"]');

      // Verify shortcut exists
      await expect(recorder).toContainText('S');

      // Click clear button
      const clearButton = page.locator('[data-testid="shortcut-primary-select-clear"]');
      await clearButton.click();

      // Shortcut should be cleared (placeholder text visible)
      await expect(recorder.locator('text=Click to record')).toBeVisible();
    });
  });
});

test.describe('Visual Regression - Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Visual Test Project');
  });

  test('empty shortcut slot state', async ({ page }) => {
    await openSettingsDialog(page);
    await navigateToShortcutsCategory(page);

    // Take screenshot of shortcuts tab (secondary slots are often empty)
    await page.screenshot({
      path: 'e2e-playwright/screenshots/shortcuts-empty-state.png',
      fullPage: false,
    });
  });

  test('recording state', async ({ page }) => {
    await openSettingsDialog(page);
    await navigateToShortcutsCategory(page);

    // Start recording
    const recorder = page.locator('[data-testid="shortcut-primary-select"]');
    await recorder.click();
    await waitForRecording(page, 'shortcut-primary-select', true);

    // Take screenshot showing recording state
    await page.screenshot({
      path: 'e2e-playwright/screenshots/shortcuts-recording-state.png',
      fullPage: false,
    });
  });

  test('conflict error state', async ({ page }) => {
    await openSettingsDialog(page);
    await navigateToShortcutsCategory(page);

    // Create a conflict
    const recorder = page.locator('[data-testid="shortcut-primary-select"]');
    await recorder.click();
    await page.keyboard.press('P'); // Conflicts with pan
    await waitForRecording(page, 'shortcut-primary-select', false);

    // Wait for error to appear
    await expect(page.locator('[data-testid="shortcut-error"]')).toBeVisible();

    // Take screenshot showing error state
    await page.screenshot({
      path: 'e2e-playwright/screenshots/shortcuts-conflict-state.png',
      fullPage: false,
    });
  });

  test('customized shortcuts state', async ({ page }) => {
    await openSettingsDialog(page);
    await navigateToShortcutsCategory(page);

    // Customize multiple shortcuts
    const selectRecorder = page.locator('[data-testid="shortcut-primary-select"]');
    await selectRecorder.click();
    await page.keyboard.press('Q');
    await waitForRecording(page, 'shortcut-primary-select', false);

    // Add secondary binding
    const secondaryRecorder = page.locator('[data-testid="shortcut-secondary-select"]');
    await secondaryRecorder.click();
    await page.keyboard.press('Control+Q');
    await waitForRecording(page, 'shortcut-secondary-select', false);

    // Take screenshot showing customized state
    await page.screenshot({
      path: 'e2e-playwright/screenshots/shortcuts-customized-state.png',
      fullPage: false,
    });
  });
});
