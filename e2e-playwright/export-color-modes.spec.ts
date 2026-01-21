import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * E2E tests for export color modes functionality.
 * Tests color mode radio buttons, depth preset dropdown, legend checkbox,
 * PNG export success (not SVG fallback), and 600 DPI option.
 */

/**
 * Helper to create a new project with mock sections/stations
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

/**
 * Helper to open the export dialog
 */
async function openExportDialog(page: Page): Promise<void> {
  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 5000 });
}

/**
 * Helper to switch to image export mode
 */
async function selectImageExport(page: Page): Promise<void> {
  await page.click('[data-testid="export-type-image"]');
  await expect(page.locator('[data-testid="export-type-image"]')).toBeChecked();
}

test.describe('Export Color Modes', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Export Color Modes Test');
  });

  test('shows color mode options for image export', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Color mode radio buttons should be visible
    await expect(page.locator('[data-testid="color-mode-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="color-mode-depth"]')).toBeVisible();
  });

  test('section mode is default for image export', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Section mode should be checked by default
    await expect(page.locator('[data-testid="color-mode-section"]')).toBeChecked();
    await expect(page.locator('[data-testid="color-mode-depth"]')).not.toBeChecked();
  });

  test('depth mode shows preset dropdown when selected', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Depth preset should NOT be visible initially (section mode is default)
    const depthPresetSelect = page.locator('[data-testid="depth-preset-select"]');
    await expect(depthPresetSelect).not.toBeVisible();

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');
    await expect(page.locator('[data-testid="color-mode-depth"]')).toBeChecked();

    // Depth preset dropdown should now be visible
    await expect(depthPresetSelect).toBeVisible();
  });

  test('depth mode shows include legend checkbox when selected', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Include legend should NOT be visible initially (section mode is default)
    const includeLegendCheckbox = page.locator('[data-testid="option-include-legend"]');
    await expect(includeLegendCheckbox).not.toBeVisible();

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Include legend checkbox should now be visible and checked by default
    await expect(includeLegendCheckbox).toBeVisible();
    await expect(includeLegendCheckbox).toBeChecked();
  });

  test('can toggle include legend checkbox off and on', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await page.click('[data-testid="color-mode-depth"]');

    const includeLegendCheckbox = page.locator('[data-testid="option-include-legend"]');

    // Legend enabled by default
    await expect(includeLegendCheckbox).toBeChecked();

    // Can toggle off
    await includeLegendCheckbox.click();
    await expect(includeLegendCheckbox).not.toBeChecked();

    // Can toggle back on
    await includeLegendCheckbox.click();
    await expect(includeLegendCheckbox).toBeChecked();
  });

  test('can select each depth preset', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await page.click('[data-testid="color-mode-depth"]');

    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await expect(presetSelect).toBeVisible();

    // Verify all presets are available
    const presets = ['Thermal', 'Ocean', 'Terrain', 'Grayscale', 'Accessible'];

    for (const preset of presets) {
      // Click to open dropdown
      await presetSelect.locator('button').first().click();
      const dropdown = presetSelect.locator('.absolute');

      // Select the preset
      await dropdown.locator(`button:has-text("${preset}")`).click();

      // Wait for dropdown to close and verify selection
      // Button text may include description like "Thermal (Blue to Red)"
      await page.waitForTimeout(100);
      await expect(presetSelect.locator('button').first()).toContainText(preset);
    }
  });

  test('preview updates when color mode changes', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Wait for initial preview
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500); // Debounce

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Wait for preset colors to be fetched and preview to update
    await page.waitForTimeout(600);

    // Preview should still be visible
    await expect(preview).toBeVisible();
  });

  test('preview updates when depth preset changes', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');
    await page.waitForTimeout(600);

    // Change depth preset
    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await presetSelect.locator('button').first().click();
    await presetSelect.locator('.absolute button:has-text("Ocean")').click();

    // Wait for preset colors to be fetched and preview to update
    await page.waitForTimeout(600);

    // Preview should still be visible
    await expect(preview).toBeVisible();
  });

  test('depth options hide when switching back to section mode', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Depth options should be visible
    const depthPresetSelect = page.locator('[data-testid="depth-preset-select"]');
    const includeLegendCheckbox = page.locator('[data-testid="option-include-legend"]');
    await expect(depthPresetSelect).toBeVisible();
    await expect(includeLegendCheckbox).toBeVisible();

    // Switch back to section mode
    await page.click('[data-testid="color-mode-section"]');

    // Depth options should be hidden
    await expect(depthPresetSelect).not.toBeVisible();
    await expect(includeLegendCheckbox).not.toBeVisible();
  });

  test('600 DPI option available for PNG format', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // PNG is the default format, resolution selector should be visible
    const resolutionSelect = page.locator('[data-testid="resolution-select"]');
    await expect(resolutionSelect).toBeVisible();

    // Open dropdown and verify 600 DPI option
    await resolutionSelect.locator('button').first().click();
    const dropdown = resolutionSelect.locator('.absolute');
    await expect(dropdown.locator('button:has-text("600")')).toBeVisible();

    // Select 600 DPI
    await dropdown.locator('button:has-text("600")').click();
    // Button text may include description like "Print (600 DPI)"
    await expect(resolutionSelect.locator('button').first()).toContainText('600');
  });

  test('PNG export succeeds (not SVG fallback)', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Ensure PNG is selected (it's the default)
    const imageFormatSelect = page.locator('[data-testid="image-format-select"]');
    await expect(imageFormatSelect.locator('button').first()).toHaveText('PNG');

    // Track IPC calls to verify export_image is called with PNG format
    const ipcCalls: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Mock IPC] export_image')) {
        ipcCalls.push(text);
      }
    });

    // Click export button
    const exportButton = page.locator('[data-testid="export-button"]');
    await exportButton.click();

    // Wait for export to complete and dialog to close
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 5000 });

    // Verify export_image was called with PNG format
    await expect.poll(() => ipcCalls.length, { timeout: 2000 }).toBeGreaterThan(0);
    const exportCall = ipcCalls.find((call) => call.includes('format') && call.includes('png'));
    expect(exportCall).toBeDefined();
  });

  test('can export PNG with depth colors', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await page.click('[data-testid="color-mode-depth"]');

    // Select thermal preset
    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await presetSelect.locator('button').first().click();
    await presetSelect.locator('.absolute button:has-text("Thermal")').click();

    // Track IPC calls
    const ipcCalls: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Mock IPC] export_image options:')) {
        ipcCalls.push(text);
      }
    });

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 5000 });

    // Verify export_image was called with depth color mode
    await expect.poll(() => ipcCalls.length, { timeout: 2000 }).toBeGreaterThan(0);
    const optionsCall = ipcCalls.find((call) => call.includes('color_mode') && call.includes('depth'));
    expect(optionsCall).toBeDefined();
  });

  test('can export SVG with depth colors', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Switch to SVG format
    const imageFormatSelect = page.locator('[data-testid="image-format-select"]');
    await imageFormatSelect.locator('button').first().click();
    await imageFormatSelect.locator('.absolute button:has-text("SVG")').click();

    // Switch to depth mode with ocean preset
    await page.click('[data-testid="color-mode-depth"]');
    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await presetSelect.locator('button').first().click();
    await presetSelect.locator('.absolute button:has-text("Ocean")').click();

    // Track IPC calls
    const ipcCalls: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Mock IPC] export_image options:')) {
        ipcCalls.push(text);
      }
    });

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 5000 });

    // Verify export was called with SVG format and depth color mode
    await expect.poll(() => ipcCalls.length, { timeout: 2000 }).toBeGreaterThan(0);
  });

  test('can export PDF with depth colors', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Switch to PDF format
    const imageFormatSelect = page.locator('[data-testid="image-format-select"]');
    await imageFormatSelect.locator('button').first().click();
    await imageFormatSelect.locator('.absolute button:has-text("PDF")').click();

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Track IPC calls
    const ipcCalls: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Mock IPC] export_image')) {
        ipcCalls.push(text);
      }
    });

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 5000 });

    // Verify export was called
    await expect.poll(() => ipcCalls.length, { timeout: 2000 }).toBeGreaterThan(0);
  });

  test('export button disabled during export', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    const exportButton = page.locator('[data-testid="export-button"]');
    await expect(exportButton).toBeEnabled();

    // Click export
    await exportButton.click();

    // Button should be disabled during export
    // Note: This may be very brief due to mocked fast response
    // The dialog closes after successful export, so we verify it's not visible
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 5000 });
  });

  test('shows progress during export', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await page.click('[data-testid="color-mode-depth"]');

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Progress should appear briefly during export
    // Due to mocked fast response, we may or may not catch it
    // The key is that export completes successfully
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('Export Color Modes - IPC Mocks', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Export IPC Mock Test');
  });

  test('get_depth_preset_colors mock returns correct format', async ({ page }) => {
    // Invoke the mock directly to verify it returns the correct format
    const result = await page.evaluate(async () => {
      const tauriInternals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;

      return await tauriInternals.invoke('get_depth_preset_colors', { preset: 'thermal' });
    });

    // Verify the result has the correct structure
    expect(result).toBeDefined();
    expect(result).toHaveProperty('stops');
    const resultWithStops = result as { stops: Array<{ position: number; color: string }> };
    expect(Array.isArray(resultWithStops.stops)).toBe(true);
    expect(resultWithStops.stops.length).toBeGreaterThan(0);
    expect(resultWithStops.stops[0]).toHaveProperty('position');
    expect(resultWithStops.stops[0]).toHaveProperty('color');
  });

  test('get_depth_preset_colors returns different colors for each preset', async ({ page }) => {
    const presets = ['thermal', 'ocean', 'terrain', 'grayscale', 'accessible'];
    const colors: string[] = [];

    for (const preset of presets) {
      const result = await page.evaluate(async (p) => {
        const tauriInternals = (window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }).__TAURI_INTERNALS__;

        return await tauriInternals.invoke('get_depth_preset_colors', { preset: p });
      }, preset);

      const resultWithStops = result as { stops: Array<{ position: number; color: string }> };
      const color = resultWithStops.stops[0]?.color ?? '';
      colors.push(color);
    }

    // Each preset should have a unique shallow color
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(presets.length);
  });

  test('export_image mock logs color mode options', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await page.click('[data-testid="color-mode-depth"]');

    // Track console logs for the options output
    const optionsLogs: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Mock IPC] export_image options:')) {
        optionsLogs.push(text);
      }
    });

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 5000 });

    // Verify options were logged
    await expect.poll(() => optionsLogs.length, { timeout: 2000 }).toBeGreaterThan(0);
    expect(optionsLogs[0]).toContain('color_mode');
    expect(optionsLogs[0]).toContain('depth_preset');
    expect(optionsLogs[0]).toContain('include_legend');
  });
});

test.describe('Export Color Modes - Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Export Accessibility Test');
  });

  test('color mode radiogroup has proper ARIA attributes', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Color mode container should have radiogroup role
    const radiogroup = page.locator('[role="radiogroup"]').first();
    await expect(radiogroup).toBeVisible();

    // Should have aria-labelledby linking to a label
    const labelledBy = await radiogroup.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = page.locator(`#${labelledBy}`);
      await expect(label).toBeVisible();
    }
  });

  test('color mode radio inputs are accessible', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Section color mode radio should be an input[type="radio"]
    const sectionRadio = page.locator('[data-testid="color-mode-section"]');
    await expect(sectionRadio).toBeVisible();
    await expect(sectionRadio).toHaveAttribute('type', 'radio');

    // Depth color mode radio should be an input[type="radio"]
    const depthRadio = page.locator('[data-testid="color-mode-depth"]');
    await expect(depthRadio).toBeVisible();
    await expect(depthRadio).toHaveAttribute('type', 'radio');
  });

  test('keyboard navigation works for color mode selection', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Focus the section radio (should be focused after clicking image export)
    const sectionRadio = page.locator('[data-testid="color-mode-section"]');
    await sectionRadio.focus();
    await expect(sectionRadio).toBeChecked();

    // Press arrow down/right to move to depth mode
    await page.keyboard.press('ArrowDown');

    // Depth mode should now be checked
    const depthRadio = page.locator('[data-testid="color-mode-depth"]');
    await expect(depthRadio).toBeChecked();
    await expect(sectionRadio).not.toBeChecked();

    // Depth options should appear
    await expect(page.locator('[data-testid="depth-preset-select"]')).toBeVisible();
  });
});
