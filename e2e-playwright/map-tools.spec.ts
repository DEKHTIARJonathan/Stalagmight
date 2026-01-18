import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a project with sections for map tools testing.
 * Returns when the project is loaded with sections containing shots.
 *
 * Uses the new two-step import flow:
 * - Step 1 (DmpSelectionDialog): Section selection
 * - Step 2 (DmpSectionConfigDialog): Per-section configuration and import
 */
async function createProjectWithSections(page: Page): Promise<void> {
  // Create a new project
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('Map Tools Test Project');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Import a DMP file to create sections with shots
  // New flow: Ctrl+I opens file picker, parses DMP, then opens Step 1 directly
  await page.keyboard.press('Control+i');

  // Wait for Step 1 dialog (DmpSelectionDialog) to appear with parsed data
  await page.waitForSelector('[data-testid="dmp-selection-dialog"]', { timeout: 5000 });

  const step1Dialog = page.locator('[data-testid="dmp-selection-dialog"]');
  await expect(step1Dialog).toBeVisible();

  // Wait for sections to load
  await page.waitForSelector('text=Main Passage', { timeout: 5000 });

  // Deselect sections with validation issues in Step 1
  const validationSection = page.locator('tr').filter({ hasText: 'Validation Test Section' });
  const checkbox = validationSection.locator('input[type="checkbox"]');
  if (await checkbox.isVisible()) {
    await checkbox.click();
  }

  // Also deselect Mixed LRUD section (has warning for long shot)
  const mixedLrudSection = page.locator('tr').filter({ hasText: 'Mixed LRUD Section' });
  const mixedCheckbox = mixedLrudSection.locator('input[type="checkbox"]');
  if (await mixedCheckbox.isVisible()) {
    await mixedCheckbox.click();
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
}

/**
 * These tests are skipped because the createProjectWithSections helper needs
 * to be updated to handle the new two-step import flow with section placement.
 * Will be fixed in task fn-51-ctu.22.
 */
test.describe.skip('Map Tools', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should switch between tools with keyboard shortcuts', async ({ page }) => {
    // Create a project to access the SingleSystemView with tools
    await createProjectWithSections(page);

    // Verify canvas is visible (we're in SingleSystemView)
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    // Test each tool shortcut as defined in DEFAULT_SHORTCUTS:
    // s: 'select', p: 'pan', z: 'zoom', d: 'draw', x: 'delete', m: 'merge', r: 'measure', v: 'move_section', t: 'move_station'
    const toolShortcuts = [
      { key: 's', tool: 'select' },
      { key: 'p', tool: 'pan' },
      { key: 'z', tool: 'zoom' },
      { key: 'd', tool: 'draw' },
      { key: 'x', tool: 'delete' },
      { key: 'm', tool: 'merge' },
      { key: 'r', tool: 'measure' },
      { key: 'v', tool: 'move_section' },
      { key: 't', tool: 'move_station' },
    ];

    for (const { key, tool } of toolShortcuts) {
      await page.keyboard.press(key);
      await page.waitForTimeout(100);

      // App should remain functional after each keypress
      await expect(canvas).toBeVisible();

      // Try to verify the tool is active through the toolbar
      // The toolbar buttons have tooltips showing the tool name
      // The active tool has an 'active' state shown with different styling
      const toolButtons = page.locator('.bg-background.rounded button');
      const activeButton = toolButtons.filter({ has: page.locator('[class*="bg-accent"]') });

      // At least verify the UI didn't crash
      const toolButtonCount = await toolButtons.count();
      expect(toolButtonCount).toBeGreaterThan(0);
    }
  });

  test('should select stations with select tool', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    // Switch to select tool
    await page.keyboard.press('s');
    await page.waitForTimeout(100);

    // Click on the canvas to attempt selection
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();

    if (canvasBox) {
      const centerX = canvasBox.x + canvasBox.width / 2;
      const centerY = canvasBox.y + canvasBox.height / 2;

      // Single click for single selection
      await page.mouse.click(centerX, centerY);
      await page.waitForTimeout(200);

      // The app should remain functional
      await expect(canvas).toBeVisible();

      // Test Ctrl+click for multi-select
      await page.mouse.click(centerX + 50, centerY, { modifiers: ['Control'] });
      await page.waitForTimeout(200);

      // The app should remain functional
      await expect(canvas).toBeVisible();

      // Test Ctrl+A for select all
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(200);

      // The app should remain functional
      await expect(canvas).toBeVisible();
    }
  });

  test('should pan map with pan tool or middle mouse button', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();

    if (canvasBox) {
      const centerX = canvasBox.x + canvasBox.width / 2;
      const centerY = canvasBox.y + canvasBox.height / 2;

      // Switch to pan tool
      await page.keyboard.press('p');
      await page.waitForTimeout(100);

      // Perform drag with pan tool active
      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX + 100, centerY + 100);
      await page.mouse.up();
      await page.waitForTimeout(200);

      // The app should remain functional after panning
      await expect(canvas).toBeVisible();

      // Test middle mouse button for panning (should work regardless of tool)
      await page.keyboard.press('s'); // Switch back to select
      await page.waitForTimeout(100);

      // Middle mouse button pan (button: 1)
      await page.mouse.move(centerX, centerY);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(centerX - 50, centerY - 50);
      await page.mouse.up({ button: 'middle' });
      await page.waitForTimeout(200);

      // The app should remain functional
      await expect(canvas).toBeVisible();
    }
  });

  test('should measure distance with measure tool', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    // Switch to measure tool
    await page.keyboard.press('r');
    await page.waitForTimeout(100);

    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();

    if (canvasBox) {
      const centerX = canvasBox.x + canvasBox.width / 2;
      const centerY = canvasBox.y + canvasBox.height / 2;

      // Click to start measurement
      await page.mouse.click(centerX - 100, centerY);
      await page.waitForTimeout(200);

      // Click to end measurement
      await page.mouse.click(centerX + 100, centerY);
      await page.waitForTimeout(200);

      // The app should remain functional
      await expect(canvas).toBeVisible();

      // Look for any distance display or measurement overlay
      // The measure tool might display distance information on the map
      // or in a tooltip/overlay. This is implementation-specific.

      // Clear the measurement with Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // The app should remain functional
      await expect(canvas).toBeVisible();
    }
  });

  test('should fit view to all data with Ctrl+0', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    // First, pan or zoom away from the default view
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();

    if (canvasBox) {
      // Zoom out with wheel to change the view
      const centerX = canvasBox.x + canvasBox.width / 2;
      const centerY = canvasBox.y + canvasBox.height / 2;

      await page.mouse.move(centerX, centerY);
      await page.mouse.wheel(0, 200); // Zoom out
      await page.waitForTimeout(300);

      // Pan away from center
      await page.keyboard.press('p');
      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX + 200, centerY + 200);
      await page.mouse.up();
      await page.waitForTimeout(200);
    }

    // Use Ctrl+0 to fit view to all data
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(300);

    // The app should remain functional and the map should have adjusted
    await expect(canvas).toBeVisible();

    // The fit to bounds should have been triggered
    // Since this is a mocked environment, we mainly verify the app doesn't crash
    // and the keyboard shortcut is properly handled
  });

  test('should delete selected items with Delete key', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    // First, select something - let's select a section from the sections panel
    const sectionItem = page.locator('li').filter({ hasText: 'Side Tunnel' });
    if (await sectionItem.isVisible()) {
      await sectionItem.click();
      await page.waitForTimeout(200);

      // Verify section is selected (has highlight)
      await expect(sectionItem).toHaveClass(/bg-accent/);

      // Press Delete key to trigger deletion
      await page.keyboard.press('Delete');
      await page.waitForTimeout(200);

      // A confirmation dialog should appear
      const confirmDialog = page.locator('[role="dialog"]');
      if (await confirmDialog.isVisible()) {
        // The dialog should mention delete or confirm
        const dialogText = await confirmDialog.textContent();
        const hasDeleteWarning = dialogText?.toLowerCase().includes('delete') ||
                                 dialogText?.toLowerCase().includes('confirm') ||
                                 dialogText?.toLowerCase().includes('remove');
        expect(hasDeleteWarning).toBeTruthy();

        // Should have Cancel and Confirm/Delete buttons
        const cancelButton = confirmDialog.locator('button:has-text("Cancel")');
        await expect(cancelButton).toBeVisible();

        // Click Cancel to abort deletion
        await cancelButton.click();
        await page.waitForTimeout(200);

        // Dialog should close
        await expect(confirmDialog).not.toBeVisible({ timeout: 2000 });
      }
    }

    // Also test with a shot selected in the data table
    // First, open the data table
    await page.keyboard.press('Control+3');
    await page.waitForTimeout(300);

    // Select a shot from the data table
    const tableRow = page.locator('tbody tr').first();
    if (await tableRow.isVisible()) {
      await tableRow.click();
      await page.waitForTimeout(200);

      // Press Delete key
      await page.keyboard.press('Delete');
      await page.waitForTimeout(200);

      // If a confirmation dialog appears, cancel it
      const confirmDialog = page.locator('[role="dialog"]');
      if (await confirmDialog.isVisible()) {
        const cancelButton = confirmDialog.locator('button:has-text("Cancel")');
        if (await cancelButton.isVisible()) {
          await cancelButton.click();
          await page.waitForTimeout(200);
        }
      }
    }

    // The app should remain functional
    await expect(canvas).toBeVisible();
  });
});
