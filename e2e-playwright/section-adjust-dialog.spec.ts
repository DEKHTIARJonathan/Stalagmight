import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
} from './helpers/app';

test.describe('Section Adjust Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);

    // Create a project
    await createProject(page, 'Section Adjust Test');

    await seedProjectWithSections(page, [
      {
        name: 'Main Passage',
        direction: 'in',
        shots: [
          { azimuth_in: 45, azimuth_out: 225, length: 10.5, depth_in: -2, depth_out: -2.5, left: 1.5, right: 2.3, up: 3.0, down: 0.8 },
          { azimuth_in: 90, azimuth_out: 270, length: 15.2, depth_in: -2.5, depth_out: -5.0, left: 0.5, right: 0.7, up: 1.2, down: 1.5 },
        ],
      },
      {
        name: 'Side Tunnel',
        direction: 'out',
        shots: [
          { azimuth_in: 270, azimuth_out: 90, length: 5.0, depth_in: -3.0, depth_out: -4.0, left: 0, right: 0, up: 0, down: 0 },
        ],
      },
    ]);

    await waitForMapReady(page);
    await waitForNoDialogs(page);

    await expect(page.getByTestId('sections-panel')).toBeVisible({ timeout: 5000 });
  });

  test('should open section adjust dialog from context menu', async ({ page }) => {
    // Wait for the sections panel to be visible
    await expect(page.getByTestId('sections-panel')).toBeVisible({ timeout: 5000 });

    // Find a section item in the sections panel
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
    await expect(sectionItem).toBeVisible({ timeout: 5000 });

    // Right-click on section to open context menu
    await sectionItem.click({ button: 'right' });

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
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
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
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
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
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
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
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
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
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
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
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
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
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: /Section|Main Passage|Side Tunnel/ }).first();
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
