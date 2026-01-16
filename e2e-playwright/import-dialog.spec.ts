import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

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
