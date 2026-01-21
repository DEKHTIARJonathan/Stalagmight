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

    // Format dropdown (custom Select component) should be visible
    const formatSelect = page.locator('[data-testid="data-format-select"]');
    await expect(formatSelect).toBeVisible();

    // CSV should be the default selection (check button text)
    await expect(formatSelect.locator('button').first()).toHaveText('CSV');

    // Click to open dropdown and verify CSV option is available
    await formatSelect.locator('button').first().click();
    // The dropdown options are in a div with class 'absolute'
    const dropdown = formatSelect.locator('.absolute');
    await expect(dropdown.locator('button:has-text("CSV")')).toBeVisible();
    // Click CSV to close dropdown (selecting default value)
    await dropdown.locator('button:has-text("CSV")').click();

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

    // Change format to JSON using custom Select component
    const formatSelect = page.locator('[data-testid="data-format-select"]');
    // Click to open dropdown
    await formatSelect.locator('button').first().click();
    // Click JSON option
    await formatSelect.locator('button:has-text("JSON")').click();

    // Verify JSON is now selected (check button text)
    await expect(formatSelect.locator('button').first()).toHaveText('JSON');

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

    // Image format select (custom Select component) should be visible
    const imageFormatSelect = page.locator('[data-testid="image-format-select"]');
    await expect(imageFormatSelect).toBeVisible();

    // Verify available image formats by opening dropdown
    await imageFormatSelect.locator('button').first().click();
    // The dropdown options are in a div with class 'absolute'
    const imageDropdown = imageFormatSelect.locator('.absolute');
    await expect(imageDropdown.locator('button:has-text("PNG")')).toBeVisible();
    await expect(imageDropdown.locator('button:has-text("SVG")')).toBeVisible();
    await expect(imageDropdown.locator('button:has-text("PDF")')).toBeVisible();
    // Click PNG to close dropdown (selecting default value)
    await imageDropdown.locator('button:has-text("PNG")').click();

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

    // Resolution select (custom Select component) should be visible for PNG format
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

  test('should show color mode options for image export', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    // Color mode radio buttons should be visible
    const sectionModeRadio = page.locator('[data-testid="color-mode-section"]');
    const depthModeRadio = page.locator('[data-testid="color-mode-depth"]');
    await expect(sectionModeRadio).toBeVisible();
    await expect(depthModeRadio).toBeVisible();

    // Section mode should be selected by default
    await expect(sectionModeRadio).toBeChecked();
    await expect(depthModeRadio).not.toBeChecked();
  });

  test('should show depth preset dropdown when depth mode selected', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    // Depth preset should NOT be visible initially (section mode is default)
    const depthPresetSelect = page.locator('[data-testid="depth-preset-select"]');
    await expect(depthPresetSelect).not.toBeVisible();

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Depth preset dropdown should now be visible
    await expect(depthPresetSelect).toBeVisible();
  });

  test('should show include legend checkbox when depth mode selected', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    // Include legend should NOT be visible initially (section mode is default)
    const includeLegendCheckbox = page.locator('[data-testid="option-include-legend"]');
    await expect(includeLegendCheckbox).not.toBeVisible();

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Include legend checkbox should now be visible and checked by default
    await expect(includeLegendCheckbox).toBeVisible();
    await expect(includeLegendCheckbox).toBeChecked();
  });

  test('should include 600 DPI option in resolution selector', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export (PNG is default, which shows resolution selector)
    await page.click('[data-testid="export-type-image"]');

    // Resolution select should be visible
    const resolutionSelect = page.locator('[data-testid="resolution-select"]');
    await expect(resolutionSelect).toBeVisible();

    // Open the dropdown
    await resolutionSelect.locator('button').first().click();

    // Verify 600 DPI option is available
    const dropdown = resolutionSelect.locator('.absolute');
    await expect(dropdown.locator('button:has-text("600")')).toBeVisible();
  });

  test('should hide depth options when switching from depth to section mode', async ({ page }) => {
    await createProject(page);

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Depth options should be visible
    const depthPresetSelect = page.locator('[data-testid="depth-preset-select"]');
    const includeLegendCheckbox = page.locator('[data-testid="option-include-legend"]');
    await expect(depthPresetSelect).toBeVisible();
    await expect(includeLegendCheckbox).toBeVisible();

    // Switch back to section mode
    await page.click('[data-testid="color-mode-section"]');

    // Depth options should be hidden
    await expect(depthPresetSelect).not.toBeVisible();
    await expect(includeLegendCheckbox).not.toBeVisible();
  });
});
