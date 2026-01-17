import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a project and open the import dialog.
 * Returns when the DMP file is loaded and sections are visible.
 */
async function createProjectAndOpenImportDialog(page: Page): Promise<void> {
  // Create a new project
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('LRUD Test Project');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Open import dialog with Ctrl+I
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

  // The dialog is now open. Click Browse to trigger file dialog.
  // The mock returns '/mock/test-survey.dmp' and then import_dmp is called automatically.
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  // Click Browse button to open file dialog (mock returns a path and auto-loads)
  const browseButton = dialog.locator('button:has-text("Browse...")');
  await browseButton.click();

  // Wait for sections to load - the data loads automatically after Browse returns a path
  // The mock parse_dmp returns data including "Main Passage" section
  await page.waitForSelector('text=Main Passage', { timeout: 5000 });

  // Verify the version info is shown (confirms data is loaded)
  await expect(dialog.locator('text=Version 5')).toBeVisible();
}

test.describe('Import Dialog UI', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    // Wait for app to load
    await page.waitForLoadState('networkidle');
  });

  test('should display the start page on load', async ({ page }) => {
    // Look for CaveChef title in header
    const title = page.locator('h1:has-text("CaveChef")');
    await expect(title).toBeVisible({ timeout: 10000 });
  });

  test('should open new project dialog', async ({ page }) => {
    // Click New Project card or button (could be in header or empty state)
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();

    // Wait for dialog to appear (look for the dialog title h2)
    const dialogTitle = page.locator('h2:has-text("New Project")');
    await expect(dialogTitle).toBeVisible({ timeout: 5000 });
  });

  test('should create a new project', async ({ page }) => {
    // Click New Project (either button or card)
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();

    // Wait for dialog
    await page.waitForSelector('.fixed.inset-0');

    // Fill in project name
    const nameInput = page.locator('.fixed.inset-0 input').first();
    await nameInput.fill('E2E Test Project');

    // Click Create button
    await page.click('.fixed.inset-0 button:has-text("Create")');

    // Wait for SingleSystemView (map/canvas should appear)
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10000 });
  });

  test('should open import dialog with Ctrl+I', async ({ page }) => {
    // First create a project
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.locator('.fixed.inset-0 input').first().fill('Import Test Project');
    await page.click('.fixed.inset-0 button:has-text("Create")');

    // Wait for project view
    await page.waitForSelector('canvas', { timeout: 10000 });

    // Open import dialog with keyboard shortcut
    await page.keyboard.press('Control+i');

    // Verify import dialog appears
    const importDialog = page.locator('.fixed.inset-0');
    await expect(importDialog).toBeVisible({ timeout: 5000 });

    // Check for Import-related text in dialog
    const dialogText = await importDialog.textContent();
    expect(dialogText?.toLowerCase()).toContain('import');
  });

  test('should close dialog with Cancel button', async ({ page }) => {
    // Create project and open import dialog
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.locator('.fixed.inset-0 input').first().fill('Cancel Test Project');
    await page.click('.fixed.inset-0 button:has-text("Create")');
    await page.waitForSelector('canvas', { timeout: 10000 });

    // Open import dialog
    await page.keyboard.press('Control+i');
    await page.waitForSelector('.fixed.inset-0');

    // Close with Cancel button
    await page.click('.fixed.inset-0 button:has-text("Cancel")');

    // Dialog should be closed
    const dialog = page.locator('.fixed.inset-0');
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should have section name input in import dialog', async ({ page }) => {
    // Setup: create project and open import dialog
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.locator('.fixed.inset-0 input').first().fill('Section Name Test');
    await page.click('.fixed.inset-0 button:has-text("Create")');
    await page.waitForSelector('canvas', { timeout: 10000 });
    await page.keyboard.press('Control+i');

    // Find input field for section name
    const sectionInput = page.locator(
      '.fixed.inset-0 input'
    );

    // Should have at least one input field
    await expect(sectionInput.first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('LRUD Columns', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('section rows are expandable', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Find the expand button for the first section (Main Passage - index 0)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expect(expandButton).toBeVisible();

    // Initially collapsed (shows right arrow)
    await expect(expandButton).toHaveText('▶');

    // Click to expand
    await expandButton.click();

    // Now expanded (shows down arrow)
    await expect(expandButton).toHaveText('▼');

    // Shot rows should be visible
    const shotRow = page.locator('[data-testid="shot-row-0-0"]');
    await expect(shotRow).toBeVisible();
  });

  test('LRUD columns visible in shot preview', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Verify LRUD column headers are visible (use exact text match)
    const dialog = page.locator('[role="dialog"]');
    // These are in the nested table for shot details
    await expect(dialog.locator('th', { hasText: /^L$/ })).toBeVisible();
    await expect(dialog.locator('th', { hasText: /^R$/ })).toBeVisible();
    await expect(dialog.locator('th', { hasText: /^U$/ })).toBeVisible();
    await expect(dialog.locator('th', { hasText: /^D$/ })).toBeVisible();

    // Verify LRUD cells exist with data-testid
    await expect(page.locator('[data-testid="lrud-left-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="lrud-right-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="lrud-up-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="lrud-down-0-0"]')).toBeVisible();
  });

  test('correct LRUD values displayed', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // First shot has LRUD values: left=1.5, right=2.3, up=3.0, down=0.8
    await expect(page.locator('[data-testid="lrud-left-0-0"]')).toHaveText('1.5');
    await expect(page.locator('[data-testid="lrud-right-0-0"]')).toHaveText('2.3');
    await expect(page.locator('[data-testid="lrud-up-0-0"]')).toHaveText('3.0');
    await expect(page.locator('[data-testid="lrud-down-0-0"]')).toHaveText('0.8');

    // Second shot has LRUD values: left=0.5, right=0.7, up=1.2, down=1.5
    await expect(page.locator('[data-testid="lrud-left-0-1"]')).toHaveText('0.5');
    await expect(page.locator('[data-testid="lrud-right-0-1"]')).toHaveText('0.7');
    await expect(page.locator('[data-testid="lrud-up-0-1"]')).toHaveText('1.2');
    await expect(page.locator('[data-testid="lrud-down-0-1"]')).toHaveText('1.5');
  });

  test('zero LRUD shows as dash', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand second section (Side Tunnel - has all zero LRUD values)
    const expandButton = page.locator('[data-testid="section-expand-1"]');
    await expandButton.click();

    // All LRUD values should show as dash for zero values
    await expect(page.locator('[data-testid="lrud-left-1-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-right-1-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-up-1-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-down-1-0"]')).toHaveText('-');
  });

  test('mixed LRUD values - some with data, some without', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand third section (Mixed LRUD Section)
    const expandButton = page.locator('[data-testid="section-expand-2"]');
    await expandButton.click();

    // First shot: left=2.5, right=0, up=4.0, down=0
    await expect(page.locator('[data-testid="lrud-left-2-0"]')).toHaveText('2.5');
    await expect(page.locator('[data-testid="lrud-right-2-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-up-2-0"]')).toHaveText('4.0');
    await expect(page.locator('[data-testid="lrud-down-2-0"]')).toHaveText('-');

    // Second shot: left=0, right=1.8, up=0, down=3.2
    await expect(page.locator('[data-testid="lrud-left-2-1"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-right-2-1"]')).toHaveText('1.8');
    await expect(page.locator('[data-testid="lrud-up-2-1"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-down-2-1"]')).toHaveText('3.2');
  });

  test('large LRUD values displayed correctly', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand third section (Mixed LRUD Section)
    const expandButton = page.locator('[data-testid="section-expand-2"]');
    await expandButton.click();

    // Third shot has large LRUD values: left=10.5, right=15.2, up=20.0, down=8.5
    await expect(page.locator('[data-testid="lrud-left-2-2"]')).toHaveText('10.5');
    await expect(page.locator('[data-testid="lrud-right-2-2"]')).toHaveText('15.2');
    await expect(page.locator('[data-testid="lrud-up-2-2"]')).toHaveText('20.0');
    await expect(page.locator('[data-testid="lrud-down-2-2"]')).toHaveText('8.5');
  });

  test('multiple sections can be expanded simultaneously', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton0 = page.locator('[data-testid="section-expand-0"]');
    await expandButton0.click();
    await expect(page.locator('[data-testid="shot-row-0-0"]')).toBeVisible();

    // Expand second section as well
    const expandButton1 = page.locator('[data-testid="section-expand-1"]');
    await expandButton1.click();
    await expect(page.locator('[data-testid="shot-row-1-0"]')).toBeVisible();

    // Both should still be expanded
    await expect(expandButton0).toHaveText('▼');
    await expect(expandButton1).toHaveText('▼');
    await expect(page.locator('[data-testid="shot-row-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="shot-row-1-0"]')).toBeVisible();
  });

  test('undefined LRUD shows as dash', async ({ page }) => {
    // Per epic spec fn-4-qe3: "Show '-' for zero/null LRUD values (indicates 'not measured')"
    // Both zero and undefined/null should render as "-" - this is intentional design
    // to indicate the measurement was not taken, regardless of explicit 0 vs missing field
    await createProjectAndOpenImportDialog(page);

    // Expand "Undefined LRUD Section" (index 3) which has shots with missing LRUD fields
    const expandButton = page.locator('[data-testid="section-expand-3"]');
    await expandButton.click();

    // First shot has all LRUD fields undefined - should show "-" for all
    await expect(page.locator('[data-testid="lrud-left-3-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-right-3-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-up-3-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-down-3-0"]')).toHaveText('-');

    // Second shot has partial LRUD: left=1.2, up=2.5, right and down undefined
    await expect(page.locator('[data-testid="lrud-left-3-1"]')).toHaveText('1.2');
    await expect(page.locator('[data-testid="lrud-right-3-1"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-up-3-1"]')).toHaveText('2.5');
    await expect(page.locator('[data-testid="lrud-down-3-1"]')).toHaveText('-');
  });

  test('empty section has no expand button', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Empty Section (index 4) should not have an expand button
    // Use toHaveCount(0) since the element should not be rendered at all
    const expandButton = page.locator('[data-testid="section-expand-4"]');
    await expect(expandButton).toHaveCount(0);

    // Verify the section row still shows the name
    await expect(page.locator('text=Empty Section')).toBeVisible();
  });

  test('collapsing section hides shot rows', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Shot rows visible
    const shotRow = page.locator('[data-testid="shot-row-0-0"]');
    await expect(shotRow).toBeVisible();

    // Collapse section
    await expandButton.click();

    // Shot rows should be hidden
    await expect(shotRow).toHaveCount(0);
    await expect(expandButton).toHaveText('▶');
  });
});
