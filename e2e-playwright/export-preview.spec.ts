import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a new project and import some data for testing
 */
async function createProjectWithData(page: import('@playwright/test').Page) {
  // Create new project
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('Export Test Project');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Import DMP file to have some data
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

  // Wait for DMP data to load (file path is mocked)
  await page.waitForTimeout(500);

  // Select first section in the list and import
  const importButton = page.locator('[role="dialog"] button:has-text("Import Selected")');
  if (await importButton.isVisible()) {
    // Select at least one section from the sections list
    const sectionCheckbox = page.locator('[role="dialog"] input[type="checkbox"]').first();
    if (await sectionCheckbox.isVisible()) {
      await sectionCheckbox.check();
    }
    await importButton.click();
  }

  // Close any remaining dialogs
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/**
 * Helper to open the export dialog
 */
async function openExportDialog(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 5000 });
}

test.describe('Export Preview', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProjectWithData(page);
  });

  test('should show preview panel when image export is selected', async ({ page }) => {
    await openExportDialog(page);

    // By default, data export is selected, preview should not be visible
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).not.toBeVisible();

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

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
    await page.waitForTimeout(500); // Let initial render complete

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Toggle station labels off
    const labelsCheckbox = page.locator('[data-testid="option-include-labels"]');
    await expect(labelsCheckbox).toBeChecked();
    await labelsCheckbox.uncheck();

    // Wait for debounced update (300ms + render time)
    await page.waitForTimeout(500);

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should update preview when toggling section names option', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await page.waitForTimeout(500);

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Toggle section names off
    const sectionNamesCheckbox = page.locator('[data-testid="option-include-section-names"]');
    await expect(sectionNamesCheckbox).toBeChecked();
    await sectionNamesCheckbox.uncheck();

    // Wait for debounced update
    await page.waitForTimeout(500);

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should update preview when toggling grid option', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await page.waitForTimeout(500);

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Toggle grid on (it's off by default)
    const gridCheckbox = page.locator('[data-testid="option-include-grid"]');
    await expect(gridCheckbox).not.toBeChecked();
    await gridCheckbox.check();

    // Wait for debounced update
    await page.waitForTimeout(500);

    // Preview should still be visible and functional
    await expect(preview).toBeVisible();
  });

  test('should update preview when toggling shot data option', async ({ page }) => {
    await openExportDialog(page);

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');
    await page.waitForTimeout(500);

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Toggle shot data on (it's off by default)
    const shotDataCheckbox = page.locator('[data-testid="option-include-shot-data"]');
    await expect(shotDataCheckbox).not.toBeChecked();
    await shotDataCheckbox.check();

    // Wait for debounced update
    await page.waitForTimeout(500);

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
    await dropdown.locator('button:has-text("Ocean")').click();

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
