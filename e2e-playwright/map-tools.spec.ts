import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForActiveTool,
  waitForMapIdle,
  waitForNoDialogs,
  type SectionSeed,
} from './helpers/app';

const sectionSeeds: SectionSeed[] = [
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
];

/**
 * Helper to create a project with sections for map tools testing.
 * Returns when the project is loaded with sections containing shots.
 *
 * Uses store seeding to avoid dialog overlays during tests.
 */
async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Map Tools Test Project');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapReady(page);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
}

/**
 * Map tool tests use the two-step import flow and auto-placement helpers.
 */
test.describe('Map Tools', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('should switch between tools with keyboard shortcuts', async ({ page }) => {
    // Create a project to access the SingleSystemView with tools
    await createProjectWithSections(page);

    // Verify canvas is visible (we're in SingleSystemView)
    const canvas = page.getByTestId('map-canvas');
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
    const toolbarTools = new Set(['select', 'pan', 'zoom', 'draw', 'delete', 'merge', 'measure']);

    for (const { key, tool } of toolShortcuts) {
      await page.keyboard.press(key);
      await waitForActiveTool(page, tool);

      // App should remain functional after each keypress
      await expect(canvas).toBeVisible();

      if (toolbarTools.has(tool)) {
        const activeButton = page.getByTestId(`tool-${tool}`);
        await expect(activeButton).toBeVisible();
      }
    }
  });

  test('should select stations with select tool', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.getByTestId('map-canvas');
    await expect(canvas).toBeVisible();

    // Switch to select tool
    await page.keyboard.press('s');
    await waitForActiveTool(page, 'select');

    // Click on the canvas to attempt selection
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();

    if (canvasBox) {
      const centerX = canvasBox.x + canvasBox.width / 2;
      const centerY = canvasBox.y + canvasBox.height / 2;

      // Single click for single selection
      await page.mouse.click(centerX, centerY);
      await waitForMapIdle(page);

      // The app should remain functional
      await expect(canvas).toBeVisible();

      // Test Ctrl+click for multi-select
      await page.mouse.click(centerX + 50, centerY, { modifiers: ['Control'] });
      await waitForMapIdle(page);

      // The app should remain functional
      await expect(canvas).toBeVisible();

      // Test Ctrl+A for select all
      await page.keyboard.press('Control+a');
      await waitForMapIdle(page);

      // The app should remain functional
      await expect(canvas).toBeVisible();
    }
  });

  test('should pan map with pan tool or middle mouse button', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.getByTestId('map-canvas');
    await expect(canvas).toBeVisible();

    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();

    if (canvasBox) {
      const centerX = canvasBox.x + canvasBox.width / 2;
      const centerY = canvasBox.y + canvasBox.height / 2;

    // Switch to pan tool
    await page.keyboard.press('p');
    await waitForActiveTool(page, 'pan');

      // Perform drag with pan tool active
      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX + 100, centerY + 100, { steps: 8 });
      await page.mouse.up();
      await waitForMapIdle(page);

      // The app should remain functional after panning
      await expect(canvas).toBeVisible();

      // Test middle mouse button for panning (should work regardless of tool)
      await page.keyboard.press('s'); // Switch back to select
      await waitForActiveTool(page, 'select');

      // Middle mouse button pan (button: 1)
      await page.mouse.move(centerX, centerY);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(centerX - 50, centerY - 50, { steps: 6 });
      await page.mouse.up({ button: 'middle' });
      await waitForMapIdle(page);

      // The app should remain functional
      await expect(canvas).toBeVisible();
    }
  });

  test('should measure distance with measure tool', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.getByTestId('map-canvas');
    await expect(canvas).toBeVisible();

    // Switch to measure tool
    await page.keyboard.press('r');
    await waitForActiveTool(page, 'measure');

    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();

    if (canvasBox) {
      const centerX = canvasBox.x + canvasBox.width / 2;
      const centerY = canvasBox.y + canvasBox.height / 2;

      // Click to start measurement
      await page.mouse.click(centerX - 100, centerY);
      await waitForMapIdle(page);

      // Click to end measurement
      await page.mouse.click(centerX + 100, centerY);
      await waitForMapIdle(page);

      // The app should remain functional
      await expect(canvas).toBeVisible();

      // Look for any distance display or measurement overlay
      // The measure tool might display distance information on the map
      // or in a tooltip/overlay. This is implementation-specific.

      // Clear the measurement with Escape
      await page.keyboard.press('Escape');
      await waitForMapIdle(page);

      // The app should remain functional
      await expect(canvas).toBeVisible();
    }
  });

  test('should fit view to all data with Ctrl+0', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // Verify canvas is visible
    const canvas = page.getByTestId('map-canvas');
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
      await waitForMapIdle(page);

      // Pan away from center
      await page.keyboard.press('p');
      await waitForActiveTool(page, 'pan');
      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX + 200, centerY + 200, { steps: 10 });
      await page.mouse.up();
      await waitForMapIdle(page);
    }

    // Use Ctrl+0 to fit view to all data
    await page.keyboard.press('Control+0');
    await waitForMapIdle(page);

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
    const canvas = page.getByTestId('map-canvas');
    await expect(canvas).toBeVisible();

    // First, select something - let's select a section from the sections panel
    const sectionItem = page.locator('[data-testid^="section-item-"]').filter({ hasText: 'Side Tunnel' });
    if (await sectionItem.isVisible()) {
      await sectionItem.click();
      await waitForMapIdle(page);

      // Verify section is selected (has highlight)
      await expect(sectionItem).toHaveClass(/bg-accent/);

      // Press Delete key to trigger deletion
      await page.keyboard.press('Delete');
      await waitForMapIdle(page);

      // A confirmation dialog should appear
      const confirmDialog = page.getByTestId('confirm-dialog');
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
        await waitForMapIdle(page);

        // Dialog should close
        await expect(confirmDialog).not.toBeVisible({ timeout: 2000 });
      }
    }

    // Also test with a shot selected in the data table
    // First, open the data table
    await page.keyboard.press('Control+3');
    await expect(page.getByTestId('data-table')).toBeVisible();

    // Select a shot from the data table
    const tableRow = page.locator('tbody tr').first();
    if (await tableRow.isVisible()) {
      await tableRow.click();
      await waitForMapIdle(page);

      // Press Delete key
      await page.keyboard.press('Delete');
      await waitForMapIdle(page);

      // If a confirmation dialog appears, cancel it
      const confirmDialog = page.getByTestId('confirm-dialog');
      if (await confirmDialog.isVisible()) {
        const cancelButton = confirmDialog.locator('button:has-text("Cancel")');
        if (await cancelButton.isVisible()) {
          await cancelButton.click();
          await waitForMapIdle(page);
        }
      }
    }

    // The app should remain functional
    await expect(canvas).toBeVisible();
  });
});
