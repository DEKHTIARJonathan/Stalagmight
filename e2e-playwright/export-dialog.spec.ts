import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a project so export dialog can be accessed.
 * Export requires an open project.
 */
async function createProject(page: Page): Promise<void> {
  // Click New Project
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');

  // Fill in project name and create
  await page.locator('.fixed.inset-0 input').first().fill('Export Dialog Test Project');
  await page.click('.fixed.inset-0 button:has-text("Create")');

  // Wait for project view to load
  await page.waitForSelector('canvas', { timeout: 10000 });
}

test.describe('Export Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should open export dialog with Ctrl+E', async ({ page }) => {
    // Create a project first (export requires open project)
    await createProject(page);

    // Open export dialog with keyboard shortcut
    await page.keyboard.press('Control+e');

    // Verify export dialog appears with proper ARIA attributes
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Verify dialog has correct role and aria attributes
    const dialogWrapper = page.locator('[role="dialog"]');
    await expect(dialogWrapper).toBeVisible();
    await expect(dialogWrapper).toHaveAttribute('aria-modal', 'true');

    // Verify dialog title is present (use specific h2 within dialog)
    const dialogTitle = exportDialog.locator('h2');
    await expect(dialogTitle).toContainText('Export');
  });

  test('should show CSV format options and preview', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // By default, data export type should be selected
    const dataRadio = page.locator('[data-testid="export-type-data"]');
    await expect(dataRadio).toBeChecked();

    // Format dropdown should be visible
    const formatSelect = page.locator('[data-testid="data-format-select"]');
    await expect(formatSelect).toBeVisible();

    // CSV should be the default selection
    await expect(formatSelect).toHaveValue('csv');

    // Verify CSV option is available
    const csvOption = formatSelect.locator('option[value="csv"]');
    await expect(csvOption).toHaveText('CSV');

    // Preview should not be visible for data export (only for image export)
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).not.toBeVisible();
  });

  test('should show JSON format options and preview', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Select data export type (should already be selected)
    const dataRadio = page.locator('[data-testid="export-type-data"]');
    await expect(dataRadio).toBeChecked();

    // Change format to JSON
    const formatSelect = page.locator('[data-testid="data-format-select"]');
    await formatSelect.selectOption('json');

    // Verify JSON is now selected
    await expect(formatSelect).toHaveValue('json');

    // Verify JSON option text
    const jsonOption = formatSelect.locator('option[value="json"]');
    await expect(jsonOption).toHaveText('JSON');

    // Preview should not be visible for data export
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).not.toBeVisible();
  });

  test('should show image export options', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export type
    await page.click('[data-testid="export-type-image"]');

    // Verify image export is now selected
    const imageRadio = page.locator('[data-testid="export-type-image"]');
    await expect(imageRadio).toBeChecked();

    // Image format select should be visible
    const imageFormatSelect = page.locator('[data-testid="image-format-select"]');
    await expect(imageFormatSelect).toBeVisible();

    // Verify available image formats
    await expect(imageFormatSelect.locator('option[value="png"]')).toHaveText('PNG');
    await expect(imageFormatSelect.locator('option[value="svg"]')).toHaveText('SVG');
    await expect(imageFormatSelect.locator('option[value="pdf"]')).toHaveText('PDF');

    // Image options checkboxes should be visible
    await expect(page.locator('[data-testid="option-include-labels"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-include-section-names"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-include-grid"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-include-shot-data"]')).toBeVisible();

    // Default checkbox states
    await expect(page.locator('[data-testid="option-include-labels"]')).toBeChecked();
    await expect(page.locator('[data-testid="option-include-section-names"]')).toBeChecked();
    await expect(page.locator('[data-testid="option-include-grid"]')).not.toBeChecked();
    await expect(page.locator('[data-testid="option-include-shot-data"]')).not.toBeChecked();

    // Resolution select should be visible for PNG format
    const resolutionSelect = page.locator('[data-testid="resolution-select"]');
    await expect(resolutionSelect).toBeVisible();

    // Preview should be visible for image export
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Theme toggle should be visible
    const themeToggle = page.locator('[data-testid="export-theme-toggle"]');
    await expect(themeToggle).toBeVisible();
  });

  test('should execute export and show success', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Data export is selected by default (CSV)
    const exportButton = page.locator('[data-testid="export-button"]');
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toHaveText('Export');

    // Click export button - this triggers the save dialog (mocked)
    // The mock returns a path, triggering the export flow
    await exportButton.click();

    // After successful export, dialog should close
    await expect(exportDialog).not.toBeVisible({ timeout: 5000 });
  });

  test('should close dialog on Cancel', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Click Cancel button
    const cancelButton = page.locator('button:has-text("Cancel")');
    await cancelButton.click();

    // Dialog should be closed
    await expect(exportDialog).not.toBeVisible({ timeout: 3000 });
  });
});
