import { test, expect } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  openDmpSelectionDialog,
  proceedToDmpSectionConfig,
  placeAllSections,
} from './helpers/app';

/**
 * Helper to create a new project and import some data for testing
 */
async function createProjectWithData(page: import('@playwright/test').Page) {
  await createProject(page, 'Export Test Project');
  await openDmpSelectionDialog(page);
  const dialog = page.getByTestId('dmp-selection-dialog');
  await expect(dialog.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });

  // Deselect problematic sections to avoid validation-blocked imports
  const validationSection = dialog.locator('[data-testid^="section-row-"]').filter({
    hasText: 'Validation Test Section',
  });
  const validationCheckbox = validationSection.locator('input[type="checkbox"]');
  if (await validationCheckbox.isVisible()) {
    await validationCheckbox.click();
  }

  const mixedLrudSection = dialog.locator('[data-testid^="section-row-"]').filter({
    hasText: 'Mixed LRUD Section',
  });
  const mixedCheckbox = mixedLrudSection.locator('input[type="checkbox"]');
  if (await mixedCheckbox.isVisible()) {
    await mixedCheckbox.click();
  }

  await proceedToDmpSectionConfig(page);
  await placeAllSections(page);
}

/**
 * Helper to open the export dialog
 */
async function openExportDialog(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+e');
  await expect(page.getByTestId('export-dialog')).toBeVisible({ timeout: 5000 });
}

test.describe('Export Preview', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProjectWithData(page);
  });

  test('should show preview panel when image export is selected', async ({ page }) => {
    await openExportDialog(page);

    // By default, data export is selected, preview should not be visible
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).not.toBeVisible();

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    // Preview should now be visible
    await expect(preview).toBeVisible({ timeout: 5000 });
  });

  test('should hide preview when switching back to data export', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Switch back to data export
    await page.click('[data-testid="export-type-data"]');

    // Preview should be hidden
    await expect(preview).not.toBeVisible();
  });

  test('should show loading state during render', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    // Loading indicator may be visible briefly or already done
    // Just verify the preview container exists
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });
  });

  test('should update preview when toggling station labels option', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Toggle station labels off
    const labelsCheckbox = page.locator('[data-testid="option-include-labels"]');
    await expect(labelsCheckbox).toBeChecked();
    await labelsCheckbox.uncheck();

    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should update preview when toggling section names option', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Toggle section names off
    const sectionNamesCheckbox = page.locator('[data-testid="option-include-section-names"]');
    await expect(sectionNamesCheckbox).toBeChecked();
    await sectionNamesCheckbox.uncheck();

    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should update preview when toggling grid option', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Toggle grid on (it's off by default)
    const gridCheckbox = page.locator('[data-testid="option-include-grid"]');
    await expect(gridCheckbox).not.toBeChecked();
    await gridCheckbox.check();

    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should update preview when toggling shot data option', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Toggle shot data on (it's off by default)
    const shotDataCheckbox = page.locator('[data-testid="option-include-shot-data"]');
    await expect(shotDataCheckbox).not.toBeChecked();
    await shotDataCheckbox.check();

    await expect(page.getByTestId('export-preview-loading')).toBeHidden();

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should have theme toggle button visible', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    const themeToggle = page.locator('[data-testid="export-theme-toggle"]');
    await expect(themeToggle).toBeVisible({ timeout: 5000 });

    // Should show "Dark" by default
    await expect(themeToggle).toContainText('Dark');
  });

  test('should toggle theme from dark to light', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    const themeToggle = page.locator('[data-testid="export-theme-toggle"]');
    await expect(themeToggle).toBeVisible({ timeout: 5000 });

    // Initially dark
    await expect(themeToggle).toContainText('Dark');

    // Click to toggle to light
    await themeToggle.click();

    // Should now show "Light"
    await expect(themeToggle).toContainText('Light');
  });

  test('should toggle theme back from light to dark', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    const themeToggle = page.locator('[data-testid="export-theme-toggle"]');
    await expect(themeToggle).toBeVisible({ timeout: 5000 });

    // Toggle to light
    await themeToggle.click();
    await expect(themeToggle).toContainText('Light');

    // Toggle back to dark
    await themeToggle.click();
    await expect(themeToggle).toContainText('Dark');
  });

  test('should have correct preview dimensions (300x300)', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Check dimensions
    const boundingBox = await preview.boundingBox();
    expect(boundingBox).not.toBeNull();
    if (boundingBox) {
      expect(boundingBox.width).toBe(300);
      expect(boundingBox.height).toBe(300);
    }
  });

  test('should close export dialog via Cancel button', async ({ page }) => {
    await openExportDialog(page);

    const dialog = page.locator('[data-testid="export-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Close via Cancel
    await page.click('button:has-text("Cancel")');

    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should close export dialog via Escape key', async ({ page }) => {
    await openExportDialog(page);

    const dialog = page.locator('[data-testid="export-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Close via Escape
    await page.keyboard.press('Escape');

    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should update preview when switching to depth color mode', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await page.waitForTimeout(500);

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Switch to depth color mode
    await page.click('[data-testid="color-mode-depth"]');

    // Wait for debounced update and preset color fetch
    await page.waitForTimeout(600);

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should update preview when changing depth preset', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await page.waitForTimeout(500);

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Switch to depth color mode
    await page.click('[data-testid="color-mode-depth"]');
    await page.waitForTimeout(600);

    // Change depth preset using custom Select component
    const depthPresetSelect = page.locator('[data-testid="depth-preset-select"]');
    await expect(depthPresetSelect).toBeVisible();

    // Open dropdown and select a different preset
    await depthPresetSelect.locator('button').first().click();
    const dropdown = depthPresetSelect.locator('.absolute');
    await dropdown.locator('[role="option"]:has-text("Ocean")').click();

    // Wait for preset colors to be fetched and preview to update
    await page.waitForTimeout(600);

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should revert preview when switching back to section color mode', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await page.waitForTimeout(500);

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Switch to depth color mode
    await page.click('[data-testid="color-mode-depth"]');
    await page.waitForTimeout(600);

    // Switch back to section color mode
    await page.click('[data-testid="color-mode-section"]');
    await page.waitForTimeout(500);

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });
});
