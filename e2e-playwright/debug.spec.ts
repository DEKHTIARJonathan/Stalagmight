import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Debug Tests', () => {
  test('check project creation', async ({ page }) => {
    // Collect console messages
    const consoleLogs: string[] = [];
    const consoleErrors: string[] = [];

    page.on('console', (msg) => {
      const text = `[${msg.type()}] ${msg.text()}`;
      consoleLogs.push(text);
      if (msg.type() === 'error') {
        consoleErrors.push(text);
      }
    });

    // Setup mocks
    await setupTauriMocks(page);

    // Navigate
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Click New Project button
    console.log('\n=== Clicking New Project ===');
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForTimeout(300);

    // Fill in name
    console.log('\n=== Filling project name ===');
    const nameInput = page.locator('.fixed.inset-0 input').first();
    await nameInput.fill('Test Project');

    // Click Create
    console.log('\n=== Clicking Create ===');
    const createBtn = page.locator('.fixed.inset-0 button:has-text("Create")');
    await createBtn.click();

    // Wait a moment
    await page.waitForTimeout(1000);

    // Print console logs
    console.log('\n=== Console Logs ===');
    consoleLogs.forEach((log) => console.log(log));

    console.log('\n=== Console Errors ===');
    consoleErrors.forEach((err) => console.log(err));

    // Check for canvas
    const canvasCount = await page.locator('canvas').count();
    console.log(`\n=== Found ${canvasCount} canvas elements ===`);

    // Get body text to see what view we're on
    const bodyText = await page.locator('body').textContent();
    console.log('\n=== Body Text (first 500 chars) ===');
    console.log(bodyText?.substring(0, 500));

    expect(true).toBeTruthy();
  });
});
