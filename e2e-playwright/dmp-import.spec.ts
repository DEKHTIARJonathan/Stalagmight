import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * DMP Import Dialog E2E Tests
 *
 * Tests the core DMP file import functionality including:
 * - Parsing and displaying DMP file data
 * - Validation warnings for problematic shots
 * - Editing shot values before import
 * - Multi-section DMP file handling
 * - Cancel without importing
 * - Statistics footer display
 */

/**
 * Helper to create a project and open the import dialog.
 * Returns when the DMP file is loaded and sections are visible.
 */
async function createProjectAndOpenImportDialog(page: Page): Promise<void> {
  // Create a new project
  const newProjectBtn = page
    .locator('button:has-text("New Project"), h3:has-text("New Project")')
    .first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('DMP Import Test');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Open import dialog with Ctrl+I
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

  // The dialog is now open. Click Browse to trigger file dialog.
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  // Click Browse button to open file dialog (mock returns a path and auto-loads)
  const browseButton = dialog.locator('button:has-text("Browse...")');
  await browseButton.click();

  // Wait for sections to load - the data loads automatically after Browse returns a path
  await page.waitForSelector('text=Main Passage', { timeout: 5000 });

  // Verify the version info is shown (confirms data is loaded)
  await expect(dialog.locator('text=Version 5')).toBeVisible();
}

/**
 * Helper to create a project without opening the import dialog.
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page
    .locator('button:has-text("New Project"), h3:has-text("New Project")')
    .first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

test.describe('DMP Import Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  /**
   * Test 6.1: should parse and display DMP file data in import dialog
   *
   * Verifies the import dialog correctly displays parsed DMP data
   * including section names, shots, azimuths, lengths, and depths.
   */
  test('should parse and display DMP file data in import dialog', async ({
    page,
  }) => {
    await createProjectAndOpenImportDialog(page);

    const dialog = page.locator('[role="dialog"]');

    // Verify dialog has correct ARIA role
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Verify section names displayed
    await expect(page.locator('text=Main Passage')).toBeVisible();
    await expect(page.locator('text=Side Tunnel')).toBeVisible();

    // Expand first section to see shot details
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Verify shot rows are visible
    const shotRow0 = page.locator('[data-testid="shot-row-0-0"]');
    await expect(shotRow0).toBeVisible();
    const shotRow1 = page.locator('[data-testid="shot-row-0-1"]');
    await expect(shotRow1).toBeVisible();
    const shotRow2 = page.locator('[data-testid="shot-row-0-2"]');
    await expect(shotRow2).toBeVisible();

    // Verify shot data is displayed (from mock data)
    // Verify LRUD values are present in the shot row
    // The shot row displays LRUD values: left=1.5, right=2.3, up=3.0, down=0.8
    await expect(page.locator('[data-testid="lrud-left-0-0"]')).toHaveText('1.5');
    await expect(page.locator('[data-testid="lrud-right-0-0"]')).toHaveText('2.3');
    await expect(page.locator('[data-testid="lrud-up-0-0"]')).toHaveText('3.0');
    await expect(page.locator('[data-testid="lrud-down-0-0"]')).toHaveText('0.8');

    // Verify LRUD columns are present
    await expect(
      dialog.locator('th', { hasText: /^L$/ })
    ).toBeVisible();
    await expect(
      dialog.locator('th', { hasText: /^R$/ })
    ).toBeVisible();
    await expect(
      dialog.locator('th', { hasText: /^U$/ })
    ).toBeVisible();
    await expect(
      dialog.locator('th', { hasText: /^D$/ })
    ).toBeVisible();

    // Verify LRUD values displayed correctly
    await expect(page.locator('[data-testid="lrud-left-0-0"]')).toHaveText(
      '1.5'
    );
    await expect(page.locator('[data-testid="lrud-right-0-0"]')).toHaveText(
      '2.3'
    );
  });

  /**
   * Test 6.2: should show validation warnings for problematic shots
   *
   * Verifies inline validation warnings appear for shots with unusual values
   * such as excessive length, invalid azimuth, or large LRUD values.
   */
  test('should show validation warnings for problematic shots', async ({
    page,
  }) => {
    await createProjectAndOpenImportDialog(page);

    // The mock data includes "Validation Test Section" (index 5) with validation issues

    // Verify validation summary shows error and warning counts
    const validationSummary = page.locator('[data-testid="validation-summary"]');
    await expect(validationSummary).toBeVisible({ timeout: 2000 });

    // Should show error count (1 error from invalid azimuth)
    const errorCount = page.locator('[data-testid="validation-error-count"]');
    await expect(errorCount).toBeVisible();
    await expect(errorCount).toContainText('1 error');

    // Should show warning count
    const warningCount = page.locator('[data-testid="validation-warning-count"]');
    await expect(warningCount).toBeVisible();
    const warningText = await warningCount.textContent();
    expect(warningText).toMatch(/\d+ warnings?/);

    // Expand the "Validation Test Section" (index 5) to see validation icons
    const expandButton = page.locator('[data-testid="section-expand-5"]');
    await expandButton.click();

    // Check for warning icon on shot with length exceeding max
    const warningIcon0 = page.locator('[data-testid="validation-icon-5-0"]');
    await expect(warningIcon0).toBeVisible();
    await expect(warningIcon0).toHaveAttribute('aria-label', 'Warning');

    // Check for error icon on shot with invalid azimuth
    const errorIcon1 = page.locator('[data-testid="validation-icon-5-1"]');
    await expect(errorIcon1).toBeVisible();
    await expect(errorIcon1).toHaveAttribute('aria-label', 'Error');

    // Verify tooltip shows validation message
    const title = await warningIcon0.getAttribute('title');
    expect(title).toContain('Shot length');
    expect(title).toContain('exceeds maximum');

    // Verify import button is disabled when errors exist
    const importButton = page.locator('[data-testid="import-button"]');
    await expect(importButton).toBeDisabled();

    // Verify error message is shown
    const errorMessage = page.locator(
      '[data-testid="validation-error-message"]'
    );
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('Errors must be resolved');
  });

  /**
   * Test 6.3: should allow editing shot values before import
   *
   * Verifies users can modify section direction (and potentially other
   * editable values) in the import dialog before confirming import.
   */
  test('should allow editing shot values before import', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // The current implementation allows editing section direction via dropdown
    // Find the direction dropdown for the first section
    const directionSelect = page.locator('[data-testid="direction-select-0"]');
    await expect(directionSelect).toBeVisible();

    // Verify initial value from mock (Main Passage has direction 'in')
    await expect(directionSelect).toHaveValue('in');

    // Change direction to 'out'
    await directionSelect.selectOption('out');
    await expect(directionSelect).toHaveValue('out');

    // Verify change persists - check by selecting and deselecting section
    const checkbox = page
      .locator('tr')
      .filter({ hasText: 'Main Passage' })
      .locator('input[type="checkbox"]');
    await checkbox.click(); // Deselect
    await checkbox.click(); // Reselect

    // Direction should still be 'out' after reselecting
    await expect(directionSelect).toHaveValue('out');

    // Change back to 'in' for a clean test
    await directionSelect.selectOption('in');
    await expect(directionSelect).toHaveValue('in');

    // Test editing a different section
    const directionSelect1 = page.locator('[data-testid="direction-select-1"]');
    await expect(directionSelect1).toHaveValue('out'); // Side Tunnel is 'out'
    await directionSelect1.selectOption('in');
    await expect(directionSelect1).toHaveValue('in');
  });

  /**
   * Test 6.4: should handle multi-section DMP files
   *
   * Verifies the import dialog handles DMP files with multiple sections,
   * showing all sections with checkboxes for selection.
   */
  test('should handle multi-section DMP files', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Verify multiple sections are listed (mock returns 6 sections)
    await expect(page.locator('text=Main Passage')).toBeVisible();
    await expect(page.locator('text=Side Tunnel')).toBeVisible();
    await expect(page.locator('text=Mixed LRUD Section')).toBeVisible();
    await expect(page.locator('text=Undefined LRUD Section')).toBeVisible();
    await expect(page.locator('text=Empty Section')).toBeVisible();
    await expect(page.locator('text=Validation Test Section')).toBeVisible();

    // Each section has an expand button (except empty section)
    const expandButton0 = page.locator('[data-testid="section-expand-0"]');
    const expandButton1 = page.locator('[data-testid="section-expand-1"]');
    await expect(expandButton0).toBeVisible();
    await expect(expandButton1).toBeVisible();

    // Empty section should not have expand button
    const expandButton4 = page.locator('[data-testid="section-expand-4"]');
    await expect(expandButton4).toHaveCount(0);

    // Expand multiple sections simultaneously
    await expandButton0.click();
    await expect(page.locator('[data-testid="shot-row-0-0"]')).toBeVisible();

    await expandButton1.click();
    await expect(page.locator('[data-testid="shot-row-1-0"]')).toBeVisible();

    // Both should remain expanded
    await expect(expandButton0).toHaveText('▼');
    await expect(expandButton1).toHaveText('▼');

    // Test section selection checkboxes
    const dialog = page.locator('[role="dialog"]');

    // Click "None" to deselect all sections
    await dialog.locator('button:has-text("None")').click();

    // Stats should show zero
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toContainText('0.0m', { timeout: 2000 });

    // Click "All" to select all sections
    await dialog.locator('button:has-text("All")').click();

    // Stats should show total from all sections
    await expect(totalLength).toContainText('210.7m', { timeout: 2000 });

    // Select only specific sections
    await dialog.locator('button:has-text("None")').click();

    // Select Main Passage and Side Tunnel only
    const mainPassageRow = page.locator('tr').filter({ hasText: 'Main Passage' });
    await mainPassageRow.locator('input[type="checkbox"]').click();
    const sideTunnelRow = page.locator('tr').filter({ hasText: 'Side Tunnel' });
    await sideTunnelRow.locator('input[type="checkbox"]').click();

    // Stats should reflect only selected sections
    // Main Passage: 33.7m, Side Tunnel: 12.5m = 46.2m
    await expect(totalLength).toContainText('46.2m', { timeout: 2000 });
  });

  /**
   * Test 6.5: should close dialog on Cancel without importing
   *
   * Verifies Cancel button closes dialog without making changes.
   */
  test('should close dialog on Cancel without importing', async ({ page }) => {
    // Create a project first
    await createProject(page, 'Cancel Test Project');

    // Open import dialog
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[role="dialog"]');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    // Dialog should be open - check for Browse button
    await expect(dialog.locator('button:has-text("Browse...")')).toBeVisible();

    // Click Cancel button
    await dialog.locator('button:has-text("Cancel")').click();

    // Dialog should close
    await expect(dialog).not.toBeVisible({ timeout: 3000 });

    // Re-open and verify state is fresh
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[role="dialog"]');
    const dialogAfter = page.locator('[role="dialog"]');
    await expect(dialogAfter).toBeVisible();

    // Dialog should be in initial state (no file loaded yet)
    await expect(dialogAfter.locator('button:has-text("Browse...")')).toBeVisible();
  });

  /**
   * Test 6.6: should display statistics footer during import preview
   *
   * Verifies the import dialog shows live statistics (shot count,
   * total length, depth range) that update based on selection.
   */
  test('should display statistics footer during import preview', async ({
    page,
  }) => {
    await createProjectAndOpenImportDialog(page);

    // Verify statistics footer is visible
    const statsFooter = page.locator('[data-testid="stats-footer"]');
    await expect(statsFooter).toBeVisible();

    // Verify all stat elements exist
    await expect(page.locator('[data-testid="stats-total-length"]')).toBeVisible();
    await expect(page.locator('[data-testid="stats-shot-count"]')).toBeVisible();
    await expect(page.locator('[data-testid="stats-depth-range"]')).toBeVisible();

    // Verify initial values (all non-empty sections selected by default)
    // Total length: 33.7 + 12.5 + 71.5 + 14.0 + 79.0 = 210.7m
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toContainText('210.7m', { timeout: 2000 });

    // Shot count: 3 + 2 + 3 + 2 + 4 = 14
    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toContainText('14', { timeout: 2000 });

    // Depth range should show min to max
    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('-16.0m to -1.0m', { timeout: 2000 });

    // Verify stats update when selection changes
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('button:has-text("None")').click();

    // Stats should show zero/placeholder values
    await expect(totalLength).toContainText('0.0m', { timeout: 2000 });
    await expect(shotCount).toContainText('0', { timeout: 2000 });
    await expect(depthRange).toContainText('--', { timeout: 2000 });

    // Select only Main Passage
    const mainPassageRow = page.locator('tr').filter({ hasText: 'Main Passage' });
    await mainPassageRow.locator('input[type="checkbox"]').click();

    // Stats should update for Main Passage only
    // Main Passage: 3 shots, 33.7m total, depths -2.0 to -5.0
    await expect(totalLength).toContainText('33.7m', { timeout: 2000 });
    await expect(shotCount).toContainText('3', { timeout: 2000 });
    await expect(depthRange).toContainText('-5.0m to -2.0m', { timeout: 2000 });

    // Verify text is selectable (for copy/paste)
    await expect(statsFooter).toHaveClass(/select-text/);
  });
});
