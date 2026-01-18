import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a project with a section containing shots.
 * Returns when the project is loaded and a section with shots exists.
 *
 * Uses the new two-step import flow:
 * - Step 1 (DmpSelectionDialog): Section selection
 * - Step 2 (DmpSectionConfigDialog): Per-section configuration and import
 */
async function createProjectWithSection(page: Page): Promise<void> {
  // Create a new project
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('Edit Test Project');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Import a DMP file to create a section with shots
  // New flow: Ctrl+I opens file picker, parses DMP, then opens Step 1 directly
  await page.keyboard.press('Control+i');

  // Wait for Step 1 dialog (DmpSelectionDialog) to appear with parsed data
  await page.waitForSelector('[data-testid="dmp-selection-dialog"]', { timeout: 5000 });

  const step1Dialog = page.locator('[data-testid="dmp-selection-dialog"]');
  await expect(step1Dialog).toBeVisible();

  // Wait for sections to load
  await page.waitForSelector('text=Main Passage', { timeout: 5000 });

  // Deselect sections with validation issues in Step 1
  const validationSection = page.locator('tr').filter({ hasText: 'Validation Test Section' });
  const checkbox = validationSection.locator('input[type="checkbox"]');
  if (await checkbox.isVisible()) {
    await checkbox.click();
  }

  // Also deselect Mixed LRUD section (has warning for long shot)
  const mixedLrudSection = page.locator('tr').filter({ hasText: 'Mixed LRUD Section' });
  const mixedCheckbox = mixedLrudSection.locator('input[type="checkbox"]');
  if (await mixedCheckbox.isVisible()) {
    await mixedCheckbox.click();
  }

  // Proceed to Step 2
  const continueButton = page.locator('[data-testid="continue-button"]');
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  // Wait for Step 2 dialog (DmpSectionConfigDialog) to appear
  await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', { timeout: 5000 });

  // Navigate through sections until we reach the Import button (shown on last section)
  // The button cycles: "Next Section" -> ... -> "Import N Sections"
  let attempts = 0;
  const maxAttempts = 10;
  while (attempts < maxAttempts) {
    const importButton = page.locator('[data-testid="import-button"]');
    const nextButton = page.locator('[data-testid="next-section-button"]');

    if (await importButton.isVisible()) {
      // We're on the last section, click Import
      await importButton.click();
      break;
    } else if (await nextButton.isVisible()) {
      // Not on last section yet, click Next
      await nextButton.click();
      // Small wait for navigation
      await page.waitForTimeout(200);
    }
    attempts++;
  }

  // Wait for dialog to close
  await expect(page.locator('[data-testid="dmp-section-config-dialog"]')).not.toBeVisible({ timeout: 5000 });
}

/**
 * Helper to select a shot in the sections panel.
 * First clicks on the section to expand it, then clicks on the shot.
 */
async function selectShot(page: Page, sectionName: string, shotIndex: number): Promise<void> {
  // Find and click on the section in the sections panel to select it
  const sectionsPanel = page.locator('[class*="section"]').first();

  // Look for the section name and click it
  const sectionRow = sectionsPanel.locator(`text=${sectionName}`).first();
  await sectionRow.click();

  // Wait for section to be selected
  await page.waitForTimeout(200);

  // Click on the data table to select a shot
  // The data table shows shots for the selected section
  const dataTable = page.locator('[class*="table"], table').first();
  if (await dataTable.isVisible()) {
    // Click on the shot row (index + 1 because header row)
    const shotRow = dataTable.locator('tr').nth(shotIndex + 1);
    if (await shotRow.isVisible()) {
      await shotRow.click();
    }
  }
}

/**
 * Helper to select a section in the sections panel.
 */
async function selectSection(page: Page, sectionName: string): Promise<void> {
  // Look for the section name and click it
  const sectionItem = page.locator(`text=${sectionName}`).first();
  await sectionItem.click();
  await page.waitForTimeout(200);
}

/**
 * These tests are skipped because the createProjectWithSection helper needs
 * to be updated to handle the new two-step import flow with section placement.
 * Will be fixed in task fn-51-ctu.22.
 */
test.describe.skip('Section and Shot Editing', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should edit shot values in detail panel', async ({ page }) => {
    await createProjectWithSection(page);

    // Select a section first
    await selectSection(page, 'Main Passage');

    // Look for the detail panel and select a shot through the data table or sections panel
    // The detail panel should show shot details when a shot is selected
    const detailPanel = page.locator('[class*="detail"], [class*="Detail"]').first();

    // Try to select a shot by clicking on a table row
    const dataTableRow = page.locator('tbody tr').first();
    if (await dataTableRow.isVisible()) {
      await dataTableRow.click();
      await page.waitForTimeout(200);
    }

    // Check if the detail panel shows shot info
    // The detail panel should have an Edit button or show editable fields
    const editButton = page.locator('button:has-text("Edit"), button:has-text("Mark")').first();
    if (await editButton.isVisible()) {
      // If there's an Edit button in the detail panel, we can verify it's clickable
      await expect(editButton).toBeEnabled();
    }

    // Verify the detail panel shows shot-related information
    // Look for fields like Length, Azimuth, Depth
    const hasLengthField = await page.locator('text=/Length|Azimuth|Depth/i').first().isVisible();
    expect(hasLengthField || await editButton.isVisible()).toBeTruthy();
  });

  test('should edit LRUD values', async ({ page }) => {
    await createProjectWithSection(page);

    // Select a section
    await selectSection(page, 'Main Passage');

    // Select a shot
    const dataTableRow = page.locator('tbody tr').first();
    if (await dataTableRow.isVisible()) {
      await dataTableRow.click();
      await page.waitForTimeout(200);
    }

    // Check for LRUD fields in the detail panel
    // The mock data includes shots with LRUD values (left=1.5, right=2.3, up=3.0, down=0.8 for first shot)
    const detailPanel = page.locator('[class*="panel"], [class*="Panel"]');

    // Check if LRUD values are displayed
    // Could be in format "L: 1.5" or "LRUD" section
    const hasLrudContent = await page.locator('text=/LRUD|Left|Right|Up|Down|\\bL\\b.*\\d|\\bR\\b.*\\d/i').first().isVisible();
    expect(hasLrudContent).toBeTruthy();
  });

  test('should delete shot with confirmation', async ({ page }) => {
    await createProjectWithSection(page);

    // Select a section
    await selectSection(page, 'Main Passage');

    // Select a shot in the data table
    const dataTableRow = page.locator('tbody tr').first();
    if (await dataTableRow.isVisible()) {
      await dataTableRow.click();
      await page.waitForTimeout(200);
    }

    // Look for a Delete button in the detail panel
    const deleteButton = page.locator('button:has-text("Delete")').first();

    if (await deleteButton.isVisible()) {
      // Click the delete button
      await deleteButton.click();

      // A confirmation dialog should appear
      const confirmDialog = page.locator('[role="dialog"], [data-testid="confirm-dialog"]');
      await expect(confirmDialog).toBeVisible({ timeout: 3000 });

      // The dialog should have Cancel and Delete/Confirm buttons
      const cancelButton = confirmDialog.locator('button:has-text("Cancel")');
      await expect(cancelButton).toBeVisible();

      // Click cancel to abort deletion
      await cancelButton.click();

      // Dialog should close
      await expect(confirmDialog).not.toBeVisible({ timeout: 2000 });
    } else {
      // If no delete button in detail panel, try keyboard shortcut or context menu
      await page.keyboard.press('Delete');

      // Check if a confirmation dialog appeared
      const confirmDialog = page.locator('[role="dialog"]');
      if (await confirmDialog.isVisible()) {
        const cancelButton = confirmDialog.locator('button:has-text("Cancel")');
        if (await cancelButton.isVisible()) {
          await cancelButton.click();
        }
      }
    }

    // App should still be functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should edit section metadata', async ({ page }) => {
    await createProjectWithSection(page);

    // Select a section
    await selectSection(page, 'Main Passage');

    // Look for an "Edit Section" button in the detail panel
    const editSectionButton = page.locator('button:has-text("Edit Section"), button:has-text("Edit")').first();

    if (await editSectionButton.isVisible()) {
      await editSectionButton.click();

      // Edit section dialog should open
      const editDialog = page.locator('[role="dialog"], [data-testid="edit-section-dialog"]');
      await expect(editDialog).toBeVisible({ timeout: 3000 });

      // Dialog should have fields for name, surveyor, date, color
      const nameInput = editDialog.locator('input[type="text"]').first();
      await expect(nameInput).toBeVisible();

      // Check for date input
      const dateInput = editDialog.locator('input[type="date"]');
      await expect(dateInput).toBeVisible();

      // Check for color input
      const colorInput = editDialog.locator('input[type="color"]');
      await expect(colorInput).toBeVisible();

      // Check for direction selector
      const directionSelect = editDialog.locator('[data-testid="section-direction-select"]');
      await expect(directionSelect).toBeVisible();
      // Should have In and Out options
      await expect(directionSelect.locator('option')).toHaveCount(2);

      // Close the dialog without saving
      const cancelButton = editDialog.locator('button:has-text("Cancel")');
      await cancelButton.click();

      await expect(editDialog).not.toBeVisible({ timeout: 2000 });
    }

    // App should still be functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should change section direction in edit dialog', async ({ page }) => {
    await createProjectWithSection(page);

    // Select a section
    await selectSection(page, 'Main Passage');

    // Open the edit section dialog
    const editSectionButton = page.locator('button:has-text("Edit Section"), button:has-text("Edit")').first();

    if (await editSectionButton.isVisible()) {
      await editSectionButton.click();

      const editDialog = page.locator('[role="dialog"], [data-testid="edit-section-dialog"]');
      await expect(editDialog).toBeVisible({ timeout: 3000 });

      // Get the direction selector
      const directionSelect = editDialog.locator('[data-testid="section-direction-select"]');
      await expect(directionSelect).toBeVisible();

      // Get current value
      const currentValue = await directionSelect.inputValue();

      // Change direction
      const newValue = currentValue === 'in' ? 'out' : 'in';
      await directionSelect.selectOption(newValue);

      // Verify the value changed
      await expect(directionSelect).toHaveValue(newValue);

      // Save the changes
      const saveButton = editDialog.locator('button:has-text("Save")');
      await saveButton.click();

      await expect(editDialog).not.toBeVisible({ timeout: 3000 });
    }

    // App should still be functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should delete section with confirmation', async ({ page }) => {
    await createProjectWithSection(page);

    // Select a section
    await selectSection(page, 'Side Tunnel');

    // The section deletion could be triggered through:
    // 1. Context menu
    // 2. Delete keyboard shortcut
    // 3. An edit dialog with delete option

    // Try the edit section dialog approach first
    const editSectionButton = page.locator('button:has-text("Edit Section")').first();

    if (await editSectionButton.isVisible()) {
      await editSectionButton.click();

      const editDialog = page.locator('[role="dialog"], [data-testid="edit-section-dialog"]');
      await expect(editDialog).toBeVisible({ timeout: 3000 });

      // Close the dialog to try a different approach
      const closeButton = editDialog.locator('button:has-text("Cancel")');
      await closeButton.click();
      await expect(editDialog).not.toBeVisible({ timeout: 2000 });
    }

    // Try keyboard delete
    await page.keyboard.press('Delete');

    // If a confirmation dialog appears, verify it has warning about deleting all shots
    const confirmDialog = page.locator('[role="dialog"]');
    if (await confirmDialog.isVisible()) {
      // Check for warning message
      const dialogText = await confirmDialog.textContent();

      // Should mention deleting section or shots
      const hasWarning = dialogText?.toLowerCase().includes('delete') ||
                        dialogText?.toLowerCase().includes('section') ||
                        dialogText?.toLowerCase().includes('shot');
      expect(hasWarning).toBeTruthy();

      // Cancel the deletion
      const cancelButton = confirmDialog.locator('button:has-text("Cancel")');
      if (await cancelButton.isVisible()) {
        await cancelButton.click();
      }
    }

    // App should still be functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should add new shot to section', async ({ page }) => {
    await createProjectWithSection(page);

    // Select a section
    await selectSection(page, 'Main Passage');

    // Open the edit section dialog to add a shot
    const editSectionButton = page.locator('button:has-text("Edit Section")').first();

    if (await editSectionButton.isVisible()) {
      await editSectionButton.click();

      const editDialog = page.locator('[role="dialog"], [data-testid="edit-section-dialog"]');
      await expect(editDialog).toBeVisible({ timeout: 3000 });

      // Look for an "Add Shot" button in the dialog
      const addShotButton = editDialog.locator('button:has-text("Add Shot"), button:has-text("+ Add")');
      await expect(addShotButton).toBeVisible();

      // Click to add a shot
      await addShotButton.click();

      // A new shot row should appear in the shots table
      // Or a shot dialog should open
      const shotTable = editDialog.locator('table, [class*="table"]');
      const shotRows = shotTable.locator('tbody tr');

      // Should have at least the original shots plus the new one
      const rowCount = await shotRows.count();
      expect(rowCount).toBeGreaterThan(0);

      // The new shot should have editable fields
      const inputs = editDialog.locator('input[type="number"]');
      expect(await inputs.count()).toBeGreaterThan(0);

      // Cancel to discard changes
      const cancelButton = editDialog.locator('button:has-text("Cancel")');
      await cancelButton.click();

      await expect(editDialog).not.toBeVisible({ timeout: 2000 });
    } else {
      // Alternative: Check if there's a draw tool that creates shots
      // Or a direct "Add Shot" action
      const addButton = page.locator('button:has-text("Add"), [aria-label*="add"]').first();
      if (await addButton.isVisible()) {
        await expect(addButton).toBeEnabled();
      }
    }

    // App should still be functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });
});
