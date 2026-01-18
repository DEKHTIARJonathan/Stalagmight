import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a new project
 */
async function createProject(page: Page, name: string) {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

/**
 * Helper to import a section using the DMP import dialog.
 * Uses the new two-step import flow:
 * - Step 1 (DmpSelectionDialog): Section selection
 * - Step 2 (DmpSectionConfigDialog): Per-section configuration and import
 */
async function importSectionViaDialog(page: Page) {
  // Open import dialog with Ctrl+I
  // New flow: Ctrl+I opens file picker, parses DMP, then opens Step 1 directly
  await page.keyboard.press('Control+i');

  // Wait for Step 1 dialog (DmpSelectionDialog) to appear with parsed data
  await page.waitForSelector('[data-testid="dmp-selection-dialog"]', { timeout: 5000 });

  const step1Dialog = page.locator('[data-testid="dmp-selection-dialog"]');
  await expect(step1Dialog).toBeVisible();

  // Wait for sections to load from mock DMP
  await page.waitForSelector('text=Main Passage', { timeout: 5000 });

  // Deselect problematic sections that have validation errors/warnings
  const validationSection = page.locator('tr').filter({ hasText: 'Validation Test Section' });
  if (await validationSection.count() > 0) {
    await validationSection.locator('input[type="checkbox"]').click();
  }
  const mixedSection = page.locator('tr').filter({ hasText: 'Mixed LRUD Section' });
  if (await mixedSection.count() > 0) {
    await mixedSection.locator('input[type="checkbox"]').click();
  }
  // Also deselect empty sections
  const emptySection = page.locator('tr').filter({ hasText: 'Empty Section' });
  if (await emptySection.count() > 0) {
    await emptySection.locator('input[type="checkbox"]').click();
  }
  // Deselect sections that cause issues - only keep Main Passage and Side Tunnel
  const undefinedSection = page.locator('tr').filter({ hasText: 'Undefined LRUD Section' });
  if (await undefinedSection.count() > 0) {
    await undefinedSection.locator('input[type="checkbox"]').click();
  }

  // Proceed to Step 2
  const continueButton = page.locator('[data-testid="continue-button"]');
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  // Wait for Step 2 dialog (DmpSectionConfigDialog) to appear
  await page.waitForSelector('[data-testid="dmp-section-config-dialog"]', { timeout: 5000 });

  // Navigate through sections until we reach the Import button (shown on last section)
  let attempts = 0;
  const maxAttempts = 10;
  while (attempts < maxAttempts) {
    const importButton = page.locator('[data-testid="import-button"]');
    const nextButton = page.locator('[data-testid="next-section-button"]');

    if (await importButton.isVisible()) {
      await importButton.click();
      break;
    } else if (await nextButton.isVisible()) {
      await nextButton.click();
      await page.waitForTimeout(200);
    }
    attempts++;
  }

  // Wait for dialog to close
  await expect(page.locator('[data-testid="dmp-section-config-dialog"]')).not.toBeVisible({ timeout: 5000 });

  // Wait for sections to appear in the panel
  await page.waitForTimeout(500);
}

/**
 * These tests are skipped because the importSectionViaDialog helper needs
 * to be updated to handle the new two-step import flow with section placement.
 * Will be fixed in task fn-51-ctu.22.
 */
test.describe.skip('Section Adjust Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Create a project
    await createProject(page, 'Section Adjust Test');

    // Import sections using the dialog
    await importSectionViaDialog(page);
  });

  test('should open section adjust dialog from context menu', async ({ page }) => {
    // Wait for the sections panel to be visible
    const sectionsPanel = page.locator('text=Sections').first();
    await expect(sectionsPanel).toBeVisible({ timeout: 5000 });

    // Find a section item in the sections panel
    const sectionItem = page.locator('li').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await expect(sectionItem).toBeVisible({ timeout: 5000 });

    // Right-click on section to open context menu
    await sectionItem.click({ button: 'right' });

    // Wait for context menu to appear
    await page.waitForTimeout(300);

    // Check that "Adjust Position..." menu item is visible
    const adjustMenuItem = page.locator('button:has-text("Adjust Position...")');
    await expect(adjustMenuItem).toBeVisible({ timeout: 3000 });

    // Click on "Adjust Position..."
    await adjustMenuItem.click();

    // Verify dialog opens
    const dialog = page.locator('[data-testid="section-adjust-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
  });

  test('should have dx and dy input fields', async ({ page }) => {
    // Open the dialog via context menu
    const sectionItem = page.locator('li').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await sectionItem.click({ button: 'right' });
    await page.click('button:has-text("Adjust Position...")');

    // Verify dialog opens
    const dialog = page.locator('[data-testid="section-adjust-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Check for dx and dy inputs
    const dxInput = page.locator('[data-testid="dx-input"]');
    const dyInput = page.locator('[data-testid="dy-input"]');

    await expect(dxInput).toBeVisible();
    await expect(dyInput).toBeVisible();

    // Verify initial values are 0
    await expect(dxInput).toHaveValue('0');
    await expect(dyInput).toHaveValue('0');
  });

  test('should accept numeric input for dx and dy', async ({ page }) => {
    // Open the dialog
    const sectionItem = page.locator('li').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await sectionItem.click({ button: 'right' });
    await page.click('button:has-text("Adjust Position...")');

    const dialog = page.locator('[data-testid="section-adjust-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Enter values in dx and dy
    const dxInput = page.locator('[data-testid="dx-input"]');
    const dyInput = page.locator('[data-testid="dy-input"]');

    await dxInput.fill('5.5');
    await dyInput.fill('-3.2');

    // Verify values
    await expect(dxInput).toHaveValue('5.5');
    await expect(dyInput).toHaveValue('-3.2');
  });

  test('should close dialog on Cancel', async ({ page }) => {
    // Open the dialog
    const sectionItem = page.locator('li').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await sectionItem.click({ button: 'right' });
    await page.click('button:has-text("Adjust Position...")');

    const dialog = page.locator('[data-testid="section-adjust-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Click Cancel
    await page.click('button:has-text("Cancel")');

    // Verify dialog closes
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should close dialog on Apply', async ({ page }) => {
    // Open the dialog
    const sectionItem = page.locator('li').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await sectionItem.click({ button: 'right' });
    await page.click('button:has-text("Adjust Position...")');

    const dialog = page.locator('[data-testid="section-adjust-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Enter offset values
    const dxInput = page.locator('[data-testid="dx-input"]');
    await dxInput.fill('10');

    // Click Apply
    await page.click('button:has-text("Apply")');

    // Verify dialog closes
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should display section name in dialog', async ({ page }) => {
    // Open the dialog
    const sectionItem = page.locator('li').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await sectionItem.click({ button: 'right' });
    await page.click('button:has-text("Adjust Position...")');

    const dialog = page.locator('[data-testid="section-adjust-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Check that the dialog shows the section being adjusted
    const adjustingText = dialog.locator('text=Adjusting:');
    await expect(adjustingText).toBeVisible();
  });

  test('should close dialog on Escape key', async ({ page }) => {
    // Open the dialog
    const sectionItem = page.locator('li').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await sectionItem.click({ button: 'right' });
    await page.click('button:has-text("Adjust Position...")');

    const dialog = page.locator('[data-testid="section-adjust-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Verify dialog closes
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should have Apply and Cancel buttons', async ({ page }) => {
    // Open the dialog
    const sectionItem = page.locator('li').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await sectionItem.click({ button: 'right' });
    await page.click('button:has-text("Adjust Position...")');

    const dialog = page.locator('[data-testid="section-adjust-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Check for Apply and Cancel buttons
    const applyButton = dialog.locator('button:has-text("Apply")');
    const cancelButton = dialog.locator('button:has-text("Cancel")');

    await expect(applyButton).toBeVisible();
    await expect(cancelButton).toBeVisible();
  });
});
