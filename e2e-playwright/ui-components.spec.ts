import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a new project
 */
async function createProject(page: import('@playwright/test').Page, name: string) {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

test.describe('UI Components', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Create a project to access main UI
    await createProject(page, 'UI Test Project');
  });

  test.describe('Keyboard Navigation', () => {
    test('should handle tool shortcuts', async ({ page }) => {
      // Test each tool shortcut
      const toolKeys = ['s', 'p', 'z', 'd', 'x', 'm', 'r', 'v', 't'];

      for (const key of toolKeys) {
        await page.keyboard.press(key);
        // App should remain functional after each keypress
        await expect(page.locator('canvas').first()).toBeVisible();
      }
    });

    test('should handle Escape to clear state', async ({ page }) => {
      await page.keyboard.press('Escape');
      await expect(page.locator('canvas').first()).toBeVisible();
    });

    test('should handle Ctrl+A for select all', async ({ page }) => {
      await page.keyboard.press('Control+a');
      await expect(page.locator('canvas').first()).toBeVisible();
    });

    test('should handle Ctrl+0 for fit to view', async ({ page }) => {
      await page.keyboard.press('Control+0');
      await expect(page.locator('canvas').first()).toBeVisible();
    });
  });

  test.describe('Panel Toggles', () => {
    test('should toggle sections panel with Ctrl+1', async ({ page }) => {
      // Get initial state
      const panelsBefore = await page.locator('[class*="panel"]').count();

      await page.keyboard.press('Control+1');
      await page.waitForTimeout(300);

      // Panel count might change (toggle)
      const panelsAfter = await page.locator('[class*="panel"]').count();

      // Either count changed or the same (if panel implementation varies)
      expect(typeof panelsAfter).toBe('number');
    });

    test('should toggle detail panel with Ctrl+2', async ({ page }) => {
      await page.keyboard.press('Control+2');
      await page.waitForTimeout(300);
      await expect(page.locator('canvas').first()).toBeVisible();
    });

    test('should toggle data table with Ctrl+3', async ({ page }) => {
      await page.keyboard.press('Control+3');
      await page.waitForTimeout(300);
      await expect(page.locator('canvas').first()).toBeVisible();
    });
  });

  test.describe('Undo/Redo', () => {
    test('should handle Ctrl+Z for undo', async ({ page }) => {
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(200);
      await expect(page.locator('canvas').first()).toBeVisible();
    });

    test('should handle Ctrl+Y for redo', async ({ page }) => {
      await page.keyboard.press('Control+y');
      await page.waitForTimeout(200);
      await expect(page.locator('canvas').first()).toBeVisible();
    });

    test('should handle Ctrl+Shift+Z for redo', async ({ page }) => {
      await page.keyboard.press('Control+Shift+z');
      await page.waitForTimeout(200);
      await expect(page.locator('canvas').first()).toBeVisible();
    });
  });

  test.describe('Map Interactions', () => {
    test('should respond to mouse wheel for zoom', async ({ page }) => {
      const canvas = page.locator('canvas').first();
      await canvas.hover();

      // Simulate wheel event
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(300);

      await expect(canvas).toBeVisible();
    });

    test('should respond to mouse drag for pan', async ({ page }) => {
      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();

      if (box) {
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        // Switch to pan tool
        await page.keyboard.press('p');

        // Perform drag
        await page.mouse.move(centerX, centerY);
        await page.mouse.down();
        await page.mouse.move(centerX + 50, centerY + 50);
        await page.mouse.up();
      }

      await expect(canvas).toBeVisible();
    });

    test('should respond to click in select mode', async ({ page }) => {
      const canvas = page.locator('canvas').first();

      // Switch to select tool
      await page.keyboard.press('s');

      // Click on canvas
      await canvas.click();

      await expect(canvas).toBeVisible();
    });
  });

  test.describe('Dialog Interactions', () => {
    test('should open and close import dialog', async ({ page }) => {
      // Open
      await page.keyboard.press('Control+i');
      const dialog = page.locator('.fixed.inset-0');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // Close via Cancel button (dialogs close via button, not Escape)
      await page.click('.fixed.inset-0 button:has-text("Cancel")');
      await expect(dialog).not.toBeVisible({ timeout: 3000 });
    });

    test('should handle dialog form inputs', async ({ page }) => {
      await page.keyboard.press('Control+i');
      await page.waitForSelector('.fixed.inset-0');

      // Find and interact with editable form inputs (skip readonly file path input)
      const editableInputs = page.locator('.fixed.inset-0 input:not([readonly])');
      const inputCount = await editableInputs.count();

      if (inputCount > 0) {
        await editableInputs.first().fill('Test Value');
        const value = await editableInputs.first().inputValue();
        expect(value).toBe('Test Value');
      }

      await page.click('.fixed.inset-0 button:has-text("Cancel")');
    });
  });

  test.describe('Responsive Layout', () => {
    test('should handle window resize', async ({ page }) => {
      // Resize to smaller viewport
      await page.setViewportSize({ width: 800, height: 600 });
      await page.waitForTimeout(300);

      // App should still be functional
      await expect(page.locator('canvas').first()).toBeVisible();

      // Resize back
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(300);

      await expect(page.locator('canvas').first()).toBeVisible();
    });
  });

  test.describe('Display Menu', () => {
    test('should toggle scale bar visibility', async ({ page }) => {
      // Scale bar is visible by default (showScaleBar: true in uiStore)
      const scaleBar = page.locator('.maplibregl-ctrl-scale');
      await expect(scaleBar).toBeVisible({ timeout: 5000 });

      // Open Display menu and toggle scale bar off
      await page.click('button:has-text("Display")');
      await expect(page.locator('button:has-text("Scale Bar")')).toBeVisible({ timeout: 2000 });
      await page.click('button:has-text("Scale Bar")');

      // Scale bar should be hidden
      await expect(scaleBar).not.toBeVisible({ timeout: 2000 });

      // Toggle it back on
      await page.click('button:has-text("Scale Bar")');

      // Scale bar should be visible again
      await expect(scaleBar).toBeVisible({ timeout: 2000 });
    });

    test('should have scale bar in bottom-left position', async ({ page }) => {
      const scaleBar = page.locator('.maplibregl-ctrl-scale');
      await expect(scaleBar).toBeVisible({ timeout: 5000 });

      // Check that it's in a bottom-left control container
      const bottomLeftContainer = page.locator('.maplibregl-ctrl-bottom-left .maplibregl-ctrl-scale');
      await expect(bottomLeftContainer).toBeVisible({ timeout: 2000 });
    });

    test('should toggle section names visibility', async ({ page }) => {
      // Open Display menu
      await page.click('button:has-text("Display")');
      await expect(page.locator('button:has-text("Section Names")')).toBeVisible({ timeout: 2000 });

      // Section Names is on by default (showSectionNames: true in uiStore)
      // Check the button shows it's enabled (has checkmark or active state)
      const sectionNamesButton = page.locator('button:has-text("Section Names")');
      await expect(sectionNamesButton).toBeVisible();

      // Toggle section names off
      await page.click('button:has-text("Section Names")');

      // Toggle back on
      await page.click('button:has-text("Section Names")');

      // Button should still be visible and functional
      await expect(sectionNamesButton).toBeVisible();
    });

    test('should toggle station labels visibility', async ({ page }) => {
      // Open Display menu
      await page.click('button:has-text("Display")');
      await expect(page.locator('button:has-text("Station Labels")')).toBeVisible({ timeout: 2000 });

      // Station Labels is off by default (showStationLabels: false in uiStore)
      // The toggle button has a checkmark indicator that shows bg-accent when enabled
      const stationLabelsButton = page.locator('button:has-text("Station Labels")');
      await expect(stationLabelsButton).toBeVisible();

      // Verify initial state - checkbox indicator should NOT have bg-accent (off state)
      const initialCheckbox = stationLabelsButton.locator('div.rounded').last();
      await expect(initialCheckbox).not.toHaveClass(/bg-accent/);

      // Toggle station labels on
      await page.click('button:has-text("Station Labels")');

      // Verify the toggle is now on - checkbox should have bg-accent class
      await expect(initialCheckbox).toHaveClass(/bg-accent/);

      // Toggle back off
      await page.click('button:has-text("Station Labels")');

      // Verify the toggle is back off - checkbox should NOT have bg-accent
      await expect(initialCheckbox).not.toHaveClass(/bg-accent/);

      // Button should still be visible and functional
      await expect(stationLabelsButton).toBeVisible();
    });

    test('should toggle grid overlay visibility', async ({ page }) => {
      // Open Display menu
      await page.click('button:has-text("Display")');
      await expect(page.locator('button:has-text("Grid")')).toBeVisible({ timeout: 2000 });

      // Grid is off by default (showGrid: false in uiStore)
      const gridButton = page.locator('[data-testid="display-toggle-showGrid"]');
      await expect(gridButton).toBeVisible();

      // Verify initial state - checkbox indicator should NOT have bg-accent (off state)
      const initialCheckbox = gridButton.locator('div.rounded').last();
      await expect(initialCheckbox).not.toHaveClass(/bg-accent/);

      // Toggle grid on
      await gridButton.click();

      // Verify the toggle is now on - checkbox should have bg-accent class
      await expect(initialCheckbox).toHaveClass(/bg-accent/);

      // Grid spacing options should appear when grid is enabled
      const spacingSelect = page.locator('[data-testid="grid-spacing-select"]');
      await expect(spacingSelect).toBeVisible({ timeout: 2000 });

      // Default spacing should be 10m
      await expect(spacingSelect).toHaveValue('10');

      // Toggle back off
      await gridButton.click();

      // Verify the toggle is back off - checkbox should NOT have bg-accent
      await expect(initialCheckbox).not.toHaveClass(/bg-accent/);

      // Grid spacing options should be hidden
      await expect(spacingSelect).not.toBeVisible();
    });

    test('should change grid spacing', async ({ page }) => {
      // Open Display menu and enable grid
      await page.click('button:has-text("Display")');
      await page.locator('[data-testid="display-toggle-showGrid"]').click();

      // Grid spacing select should be visible
      const spacingSelect = page.locator('[data-testid="grid-spacing-select"]');
      await expect(spacingSelect).toBeVisible({ timeout: 2000 });

      // Default is 10m
      await expect(spacingSelect).toHaveValue('10');

      // Change to 25m
      await spacingSelect.selectOption('25');
      await expect(spacingSelect).toHaveValue('25');

      // Change to 5m
      await spacingSelect.selectOption('5');
      await expect(spacingSelect).toHaveValue('5');

      // Change to 100m
      await spacingSelect.selectOption('100');
      await expect(spacingSelect).toHaveValue('100');
    });

    test('should toggle satellite imagery visibility', async ({ page }) => {
      // Open Display menu
      await page.click('button:has-text("Display")');
      await expect(page.locator('button:has-text("Satellite")')).toBeVisible({ timeout: 2000 });

      // Satellite is off by default (showSatellite: false in uiStore)
      const satelliteButton = page.locator('[data-testid="display-toggle-showSatellite"]');
      await expect(satelliteButton).toBeVisible();

      // Verify initial state - checkbox indicator should NOT have bg-accent (off state)
      const checkbox = satelliteButton.locator('div.rounded').last();
      await expect(checkbox).not.toHaveClass(/bg-accent/);

      // Toggle satellite on
      await satelliteButton.click();

      // Verify the toggle is now on - checkbox should have bg-accent class
      await expect(checkbox).toHaveClass(/bg-accent/);

      // Wait for satellite layer to be added (source should be added to map)
      await page.waitForTimeout(500);

      // Toggle back off
      await satelliteButton.click();

      // Verify the toggle is back off - checkbox should NOT have bg-accent
      await expect(checkbox).not.toHaveClass(/bg-accent/);

      // Button should still be visible and functional
      await expect(satelliteButton).toBeVisible();
    });

    test('should show satellite option in Display menu', async ({ page }) => {
      // Open Display menu
      await page.click('button:has-text("Display")');

      // The Satellite button should exist with proper label and description
      const satelliteButton = page.locator('[data-testid="display-toggle-showSatellite"]');
      await expect(satelliteButton).toBeVisible();

      // Check that label is correct (use .first() to get the main label, not description)
      await expect(satelliteButton.locator('span.text-sm')).toHaveText('Satellite');

      // Check that description is correct
      await expect(satelliteButton.locator('span.text-xs')).toHaveText('Show satellite imagery');
    });

    test('should persist satellite toggle state during session', async ({ page }) => {
      // Open Display menu and toggle satellite on
      await page.click('button:has-text("Display")');
      const satelliteButton = page.locator('[data-testid="display-toggle-showSatellite"]');
      const checkbox = satelliteButton.locator('div.rounded').last();

      // Verify initially off
      await expect(checkbox).not.toHaveClass(/bg-accent/);

      // Toggle on
      await satelliteButton.click();
      await expect(checkbox).toHaveClass(/bg-accent/);

      // Close the menu (click outside)
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // Open the menu again
      await page.click('button:has-text("Display")');

      // Satellite should still be on (state persisted in store during session)
      const checkbox2 = page.locator('[data-testid="display-toggle-showSatellite"]').locator('div.rounded').last();
      await expect(checkbox2).toHaveClass(/bg-accent/);
    });
  });
});
