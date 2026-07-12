import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject, waitForMapReady } from './helpers/app';

test.describe('UI Components', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);

    // Create a project to access main UI
    await createProject(page, 'UI Test Project');
    await waitForMapReady(page);
  });

  test.describe('Keyboard Navigation', () => {
    test('should handle tool shortcuts', async ({ page }) => {
      // Test each tool shortcut
      const toolKeys = ['s', 'p', 'z', 'd', 'x', 'm', 'r', 'v', 't'];

      for (const key of toolKeys) {
        await page.keyboard.press(key);
        // App should remain functional after each keypress
        await expect(page.getByTestId('map-canvas')).toBeVisible();
      }
    });

    test('should handle Escape to clear state', async ({ page }) => {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('map-canvas')).toBeVisible();
    });

    test('should handle Ctrl+A for select all', async ({ page }) => {
      await page.keyboard.press('Control+a');
      await expect(page.getByTestId('map-canvas')).toBeVisible();
    });
  });

  test.describe('Map Interactions', () => {
    test('should respond to mouse wheel for zoom', async ({ page }) => {
      const canvas = page.getByTestId('map-canvas');
      await canvas.hover();

      // Simulate wheel event
      await page.mouse.wheel(0, -100);
      await expect(canvas).toBeVisible();
    });

    test('should respond to mouse drag for pan', async ({ page }) => {
      const canvas = page.getByTestId('map-canvas');
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
      const canvas = page.getByTestId('map-canvas');

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
      const dialog = page.getByTestId('dmp-selection-dialog');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await page.getByTestId('cancel-button').click();
      await expect(dialog).not.toBeVisible({ timeout: 3000 });
    });

    test('should handle dialog form inputs', async ({ page }) => {
      await page.keyboard.press('Control+i');
      await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible();

      // Find and interact with editable form inputs (skip readonly file path input)
      const editableInputs = page.locator('[data-testid="dmp-selection-dialog"] input:not([readonly])');
      const inputCount = await editableInputs.count();

      if (inputCount > 0) {
        await editableInputs.first().fill('Test Value');
        const value = await editableInputs.first().inputValue();
        expect(value).toBe('Test Value');
      }

      await page.getByTestId('cancel-button').click();
    });
  });

  test.describe('Responsive Layout', () => {
    test('should handle window resize', async ({ page }) => {
      // Resize to smaller viewport
      await page.setViewportSize({ width: 800, height: 600 });

      // App should still be functional
      await expect(page.getByTestId('map-canvas')).toBeVisible();

      // Resize back
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(page.getByTestId('map-canvas')).toBeVisible();
    });
  });

  test.describe('Display Menu', () => {
    test('scale bar is always visible (no toggle)', async ({ page }) => {
      // The scale bar is always shown; its toggle was removed.
      const scaleBar = page.locator('.maplibregl-ctrl-scale');
      await expect(scaleBar).toBeVisible({ timeout: 5000 });

      // The Display menu no longer offers a Scale Bar toggle.
      await page.getByTestId('display-menu-button').click();
      await expect(page.getByTestId('display-menu')).toBeVisible({ timeout: 2000 });
      await expect(page.locator('button:has-text("Scale Bar")')).toHaveCount(0);

      // Scale bar stays visible.
      await expect(scaleBar).toBeVisible();
    });

    test('should have scale bar in bottom-left position', async ({ page }) => {
      const scaleBar = page.locator('.maplibregl-ctrl-scale');
      await expect(scaleBar).toBeVisible({ timeout: 5000 });

      // Check that it's in a bottom-left control container
      const bottomLeftContainer = page.locator('.maplibregl-ctrl-bottom-left .maplibregl-ctrl-scale');
      await expect(bottomLeftContainer).toBeVisible({ timeout: 2000 });
    });

    test('should toggle grid overlay visibility', async ({ page }) => {
      // Open Display menu
      await page.getByTestId('display-menu-button').click();
      await expect(page.locator('button:has-text("Grid")')).toBeVisible({ timeout: 2000 });

      // Grid is off by default (showGrid: false in uiStore)
      const gridButton = page.locator('[data-testid="display-toggle-showGrid"]');
      await expect(gridButton).toBeVisible();

      // Verify initial state - checkbox indicator should NOT have bg-accent (off state)
      const initialCheckbox = gridButton;
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
      await page.getByTestId('display-menu-button').click();
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

    test('should show satellite option in Display menu', async ({ page }) => {
      // Open Display menu
      await page.getByTestId('display-menu-button').click();

      // The Satellite pill should exist with its label + descriptive tooltip
      const satelliteButton = page.locator('[data-testid="display-toggle-showSatellite"]');
      await expect(satelliteButton).toBeVisible();
      await expect(satelliteButton).toHaveText('Satellite');
      await expect(satelliteButton).toHaveAttribute('title', 'Show satellite imagery');
    });
  });
});
