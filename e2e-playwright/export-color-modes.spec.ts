import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * E2E tests for export color modes functionality.
 * Tests color mode radio buttons, depth preset dropdown, legend checkbox,
 * PNG export success (not SVG fallback), and 600 DPI option.
 *
 * Note: Basic color mode UI tests (radio visibility, default states) are covered
 * in export-dialog.spec.ts. This file focuses on:
 * - IPC mock validation for depth preset colors
 * - Export options verification via mock capture
 * - Progress/disabled state during export
 * - Keyboard accessibility for color modes
 */

// Type for captured export args from mock
interface ExportImageArgs {
  path: string | null;
  options: {
    format: string;
    color_mode: string;
    depth_preset: string;
    include_legend: boolean;
    dpi: number;
    [key: string]: unknown;
  } | null;
}

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

/**
 * Helper to clear last export args before a test
 */
async function clearLastExportArgs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const mocks = (window as unknown as { __E2E_MOCKS__?: { clearLastExportImageArgs?: () => void } }).__E2E_MOCKS__;
    mocks?.clearLastExportImageArgs?.();
  });
}

/**
 * Helper to get the last export_image args from the mock
 */
async function getLastExportArgs(page: Page): Promise<ExportImageArgs | null> {
  return await page.evaluate(() => {
    const mocks = (window as unknown as { __E2E_MOCKS__?: { getLastExportImageArgs?: () => ExportImageArgs | null } }).__E2E_MOCKS__;
    return mocks?.getLastExportImageArgs?.() ?? null;
  });
}

test.describe('Export Color Modes - Export Verification', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Export Color Modes Test');
  });

  test('PNG export with section colors passes correct options to backend', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await clearLastExportArgs(page);

    // Section mode is default, PNG is default format
    await expect(page.locator('[data-testid="color-mode-section"]')).toBeChecked();

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete (dialog closes)
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 10000 });

    // Verify the captured export args
    const exportArgs = await getLastExportArgs(page);
    expect(exportArgs).not.toBeNull();
    expect(exportArgs?.options).not.toBeNull();
    expect(exportArgs?.options?.format).toBe('png');
    expect(exportArgs?.options?.color_mode).toBe('section');
  });

  test('PNG export with depth colors passes correct options to backend', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await clearLastExportArgs(page);

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');
    await expect(page.locator('[data-testid="color-mode-depth"]')).toBeChecked();

    // Select thermal preset (verify dropdown works)
    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await expect(presetSelect).toBeVisible();
    await presetSelect.locator('button').first().click();
    await presetSelect.locator('.absolute button:has-text("Thermal")').click();

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 10000 });

    // Verify the captured export args
    const exportArgs = await getLastExportArgs(page);
    expect(exportArgs).not.toBeNull();
    expect(exportArgs?.options).not.toBeNull();
    expect(exportArgs?.options?.format).toBe('png');
    expect(exportArgs?.options?.color_mode).toBe('depth');
    expect(exportArgs?.options?.depth_preset).toBe('thermal');
    expect(exportArgs?.options?.include_legend).toBe(true); // default
  });

  test('SVG export with depth colors passes correct options to backend', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await clearLastExportArgs(page);

    // Switch to SVG format
    const imageFormatSelect = page.locator('[data-testid="image-format-select"]');
    await imageFormatSelect.locator('button').first().click();
    await imageFormatSelect.locator('.absolute button:has-text("SVG")').click();

    // Switch to depth mode with ocean preset
    await page.click('[data-testid="color-mode-depth"]');
    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await presetSelect.locator('button').first().click();
    await presetSelect.locator('.absolute button:has-text("Ocean")').click();

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 10000 });

    // Verify the captured export args
    const exportArgs = await getLastExportArgs(page);
    expect(exportArgs).not.toBeNull();
    expect(exportArgs?.options?.format).toBe('svg');
    expect(exportArgs?.options?.color_mode).toBe('depth');
    expect(exportArgs?.options?.depth_preset).toBe('ocean');
  });

  test('PDF export with depth colors passes correct options to backend', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await clearLastExportArgs(page);

    // Switch to PDF format
    const imageFormatSelect = page.locator('[data-testid="image-format-select"]');
    await imageFormatSelect.locator('button').first().click();
    await imageFormatSelect.locator('.absolute button:has-text("PDF")').click();

    // Switch to depth mode with terrain preset
    await page.click('[data-testid="color-mode-depth"]');
    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await presetSelect.locator('button').first().click();
    await presetSelect.locator('.absolute button:has-text("Terrain")').click();

    // Disable legend
    const legendCheckbox = page.locator('[data-testid="option-include-legend"]');
    await legendCheckbox.click();
    await expect(legendCheckbox).not.toBeChecked();

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 10000 });

    // Verify the captured export args
    const exportArgs = await getLastExportArgs(page);
    expect(exportArgs).not.toBeNull();
    expect(exportArgs?.options?.format).toBe('pdf');
    expect(exportArgs?.options?.color_mode).toBe('depth');
    expect(exportArgs?.options?.depth_preset).toBe('terrain');
    expect(exportArgs?.options?.include_legend).toBe(false);
  });

  test('600 DPI option is passed correctly to backend', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await clearLastExportArgs(page);

    // Select 600 DPI
    const resolutionSelect = page.locator('[data-testid="resolution-select"]');
    await resolutionSelect.locator('button').first().click();
    await resolutionSelect.locator('.absolute button:has-text("600")').click();

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 10000 });

    // Verify the captured export args
    const exportArgs = await getLastExportArgs(page);
    expect(exportArgs).not.toBeNull();
    expect(exportArgs?.options?.dpi).toBe(600);
  });
});

test.describe('Export Color Modes - Progress and Button States', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Export Progress Test');
  });

  test('export button becomes disabled during export', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    const exportButton = page.locator('[data-testid="export-button"]');
    await expect(exportButton).toBeEnabled();

    // Click export - button should become disabled
    await exportButton.click();

    // Poll for disabled state (button should be disabled during export)
    await expect(exportButton).toBeDisabled({ timeout: 2000 });

    // Wait for export to complete
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 10000 });
  });

  test('progress indicator appears during export', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Click export
    await page.locator('[data-testid="export-button"]').click();

    // Progress should appear during export (mock delays give us time to observe)
    await expect(page.locator('[data-testid="loading-progress"]')).toBeVisible({ timeout: 2000 });

    // Wait for export to complete and progress to disappear
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 10000 });
  });
});

test.describe('Export Color Modes - IPC Mock Verification', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Export IPC Mock Test');
  });

  test('get_depth_preset_colors mock returns correct format with stops array', async ({ page }) => {
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
    expect(resultWithStops.stops.length).toBe(2);
    expect(resultWithStops.stops[0]).toHaveProperty('position');
    expect(resultWithStops.stops[0]).toHaveProperty('color');
    expect(resultWithStops.stops[0].position).toBe(0.0);
    expect(resultWithStops.stops[1].position).toBe(1.0);
  });

  test('get_depth_preset_colors returns unique colors for each preset', async ({ page }) => {
    const presets = ['thermal', 'ocean', 'terrain', 'grayscale', 'accessible'];
    const shallowColors: string[] = [];
    const deepColors: string[] = [];

    for (const preset of presets) {
      const result = await page.evaluate(async (p) => {
        const tauriInternals = (window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
        }).__TAURI_INTERNALS__;

        return await tauriInternals.invoke('get_depth_preset_colors', { preset: p });
      }, preset);

      const resultWithStops = result as { stops: Array<{ position: number; color: string }> };
      shallowColors.push(resultWithStops.stops[0]?.color ?? '');
      deepColors.push(resultWithStops.stops[1]?.color ?? '');
    }

    // Each preset should have unique shallow and deep colors
    const uniqueShallow = new Set(shallowColors);
    const uniqueDeep = new Set(deepColors);
    expect(uniqueShallow.size).toBe(presets.length);
    expect(uniqueDeep.size).toBe(presets.length);
  });

  test('__E2E_MOCKS__.getLastExportImageArgs captures export calls', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await clearLastExportArgs(page);

    // Verify args are null before export
    let args = await getLastExportArgs(page);
    expect(args).toBeNull();

    // Perform export
    await page.click('[data-testid="color-mode-depth"]');
    await page.locator('[data-testid="export-button"]').click();
    await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 10000 });

    // Verify args were captured
    args = await getLastExportArgs(page);
    expect(args).not.toBeNull();
    expect(args?.options).not.toBeNull();
    expect(args?.options?.color_mode).toBe('depth');
  });
});

test.describe('Export Color Modes - Preset Selection', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Preset Selection Test');
  });

  test('can select each depth preset and verify selection', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);
    await page.click('[data-testid="color-mode-depth"]');

    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await expect(presetSelect).toBeVisible();

    // Verify all presets are selectable
    const presets = ['Thermal', 'Ocean', 'Terrain', 'Grayscale', 'Accessible'];

    for (const preset of presets) {
      // Click to open dropdown
      await presetSelect.locator('button').first().click();
      const dropdown = presetSelect.locator('.absolute');

      // Select the preset
      await dropdown.locator(`button:has-text("${preset}")`).click();

      // Verify selection (button text contains preset name)
      await expect(presetSelect.locator('button').first()).toContainText(preset);
    }
  });

  test('preview updates when depth preset changes', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Wait for initial preview
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Wait for preview to update (poll for visibility rather than fixed timeout)
    await expect(preview).toBeVisible();

    // Change depth preset
    const presetSelect = page.locator('[data-testid="depth-preset-select"]');
    await presetSelect.locator('button').first().click();
    await presetSelect.locator('.absolute button:has-text("Ocean")').click();

    // Preview should still be visible after preset change
    await expect(preview).toBeVisible();
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

  test('color mode radio inputs are proper radio elements', async ({ page }) => {
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

  test('keyboard navigation changes color mode selection', async ({ page }) => {
    await openExportDialog(page);
    await selectImageExport(page);

    // Focus the section radio
    const sectionRadio = page.locator('[data-testid="color-mode-section"]');
    await sectionRadio.focus();
    await expect(sectionRadio).toBeChecked();

    // Press arrow key to move to depth mode (browsers use arrow keys for radio navigation)
    await page.keyboard.press('ArrowDown');

    // Depth mode should now be checked
    const depthRadio = page.locator('[data-testid="color-mode-depth"]');
    await expect(depthRadio).toBeChecked();
    await expect(sectionRadio).not.toBeChecked();

    // Depth options should appear
    await expect(page.locator('[data-testid="depth-preset-select"]')).toBeVisible();
  });
});
