import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject, createSectionViaStore } from './helpers/app';

test.describe('Export Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('should open export dialog with Ctrl+E', async ({ page }) => {
    // Create a project first (export requires open project)
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog with keyboard shortcut
    await page.keyboard.press('Control+e');

    // Verify export dialog appears with proper ARIA attributes
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Verify dialog has correct role and aria attributes
    const dialogWrapper = page.locator('[role="dialog"]');
    await expect(dialogWrapper).toBeVisible();
    await expect(dialogWrapper).toHaveAttribute('aria-modal', 'true');

    // Verify dialog title is present (use specific h2 within dialog)
    const dialogTitle = exportDialog.locator('h2');
    await expect(dialogTitle).toContainText('Export');
  });

  test('should show CSV format options and preview', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // By default, data export type should be selected
    const dataRadio = page.locator('[data-testid="export-type-data"]');
    await expect(dataRadio).toBeChecked();

    // Format dropdown (custom Select component) should be visible
    const formatSelect = page.locator('[data-testid="data-format-select"]');
    await expect(formatSelect).toBeVisible();

    // CSV should be the default selection (check button text)
    await expect(formatSelect.locator('button').first()).toHaveText('CSV');

    // Click to open dropdown and verify CSV option is available
    await formatSelect.locator('button').first().click();
    // The dropdown renders via portal to document.body - locate by role
    const dropdown = page.getByRole('listbox');
    await expect(dropdown.locator('[role="option"]:has-text("CSV")')).toBeVisible();
    // Click CSV to close dropdown (selecting default value)
    await dropdown.locator('[role="option"]:has-text("CSV")').click();

    // Preview should not be visible for data export (only for image export)
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).not.toBeVisible();
  });

  test('should show JSON format options and preview', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Select data export type (should already be selected)
    const dataRadio = page.locator('[data-testid="export-type-data"]');
    await expect(dataRadio).toBeChecked();

    // Change format to JSON using custom Select component
    const formatSelect = page.locator('[data-testid="data-format-select"]');
    // Click to open dropdown
    await formatSelect.locator('button').first().click();
    // Click JSON option (portaled listbox - locate globally by role)
    await page.getByRole('listbox').locator('[role="option"]:has-text("JSON")').click();

    // Verify JSON is now selected (check button text)
    await expect(formatSelect.locator('button').first()).toHaveText('JSON');

    // Preview should not be visible for data export
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).not.toBeVisible();
  });

  test('should show image export options', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export type
    await page.click('[data-testid="export-type-image"]');

    // Verify image export is now selected
    const imageRadio = page.locator('[data-testid="export-type-image"]');
    await expect(imageRadio).toBeChecked();

    // Image format select (custom Select component) should be visible
    const imageFormatSelect = page.locator('[data-testid="image-format-select"]');
    await expect(imageFormatSelect).toBeVisible();

    // Verify available image formats by opening dropdown
    await imageFormatSelect.locator('button').first().click();
    // The dropdown renders via portal to document.body - locate by role
    const imageDropdown = page.getByRole('listbox');
    await expect(imageDropdown.locator('[role="option"]:has-text("PNG")')).toBeVisible();
    await expect(imageDropdown.locator('[role="option"]:has-text("SVG")')).toBeVisible();
    await expect(imageDropdown.locator('[role="option"]:has-text("PDF")')).toBeVisible();
    // Click PNG to close dropdown (selecting default value)
    await imageDropdown.locator('[role="option"]:has-text("PNG")').click();

    // Image options checkboxes should be visible
    await expect(page.locator('[data-testid="option-include-labels"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-include-section-names"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-include-grid"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-include-shot-data"]')).toBeVisible();

    // Default checkbox states
    await expect(page.locator('[data-testid="option-include-labels"]')).toBeChecked();
    await expect(page.locator('[data-testid="option-include-section-names"]')).toBeChecked();
    await expect(page.locator('[data-testid="option-include-grid"]')).not.toBeChecked();
    await expect(page.locator('[data-testid="option-include-shot-data"]')).not.toBeChecked();

    // Resolution select (custom Select component) should be visible for PNG format
    const resolutionSelect = page.locator('[data-testid="resolution-select"]');
    await expect(resolutionSelect).toBeVisible();

    // Preview should be visible for image export
    const preview = page.locator('[data-testid="export-preview"]');
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Theme toggle should be visible
    const themeToggle = page.locator('[data-testid="export-theme-toggle"]');
    await expect(themeToggle).toBeVisible();
  });

  test('should execute export and show success', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Data export is selected by default (CSV)
    const exportButton = page.locator('[data-testid="export-button"]');
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toHaveText('Export');

    // Click export button - this triggers the save dialog (mocked)
    // The mock returns a path, triggering the export flow
    await exportButton.click();

    // After successful export, dialog should close
    await expect(exportDialog).not.toBeVisible({ timeout: 5000 });
  });

  test('should warn for TML export when sections are not anchored and allow cancel', async ({ page }) => {
    await createProject(page, 'TML Warning Cancel Project');

    await createSectionViaStore(page, {
      name: 'Anchored Section',
      shots: [{
        azimuth_in: 45,
        azimuth_out: 45,
        length: 10,
        depth_in: 0,
        depth_out: 0,
      }],
    });
    await createSectionViaStore(page, {
      name: 'Floating Section',
      shots: [{
        azimuth_in: 120,
        azimuth_out: 120,
        length: 8,
        depth_in: 1,
        depth_out: 1,
      }],
    });

    await page.evaluate(async () => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              setZeroDatum: (
                stationRef: { section_id: number; station_index: number },
                coordinates: { latitude: number; longitude: number; depth_reference: number }
              ) => Promise<unknown>;
            };
          };
        };
      }).__E2E_TEST__;
      if (!e2e) throw new Error('E2E stores not available on window');
      await e2e.projectStore.getState().setZeroDatum(
        { section_id: 1, station_index: 0 },
        { latitude: 24.55, longitude: -81.78, depth_reference: 0 }
      );
    });

    await page.evaluate(() => {
      const win = window as unknown as Record<string, unknown>;
      win.__E2E_SAVE_CALLS__ = 0;
      const dialogMock = win.__TAURI_DIALOG_MOCK__ as { save?: () => Promise<string | null> } | undefined;
      if (dialogMock) {
        dialogMock.save = async () => {
          const previous = (win.__E2E_SAVE_CALLS__ as number) ?? 0;
          win.__E2E_SAVE_CALLS__ = previous + 1;
          return '/mock/export-warning.tml';
        };
      }
    });

    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    const formatSelect = page.locator('[data-testid="data-format-select"]');
    await formatSelect.locator('button').first().click();
    await page.getByRole('listbox').locator('[role="option"]:has-text("TML (Ariane)")').click();
    await expect(formatSelect.locator('button').first()).toHaveText('TML (Ariane)');

    await page.getByTestId('export-button').click();

    const warningDialog = page.getByTestId('tml-unanchored-warning-dialog');
    await expect(warningDialog).toBeVisible();
    await expect(warningDialog).toContainText('Ariane TML/TMLU exports only include sections connected to a zero datum.');
    await expect(warningDialog).toContainText('Floating Section (#2)');
    await expect(warningDialog).not.toContainText('Anchored Section');
    await expect(page.getByTestId('tml-unanchored-warning-continue')).toHaveAttribute('data-primary-action', '');

    await page.getByTestId('tml-unanchored-warning-cancel').click();
    await expect(warningDialog).not.toBeVisible({ timeout: 3000 });
    await expect(exportDialog).toBeVisible();

    const saveCalls = await page.evaluate(() => ((window as unknown as Record<string, unknown>).__E2E_SAVE_CALLS__ as number) ?? 0);
    expect(saveCalls).toBe(0);
  });

  test('should continue TML export after unanchored warning confirmation', async ({ page }) => {
    await createProject(page, 'TML Warning Continue Project');

    await createSectionViaStore(page, {
      name: 'Anchored Section',
      shots: [{
        azimuth_in: 30,
        azimuth_out: 30,
        length: 12,
        depth_in: 0,
        depth_out: 0,
      }],
    });
    await createSectionViaStore(page, {
      name: 'Unanchored Section',
      shots: [{
        azimuth_in: 210,
        azimuth_out: 210,
        length: 5,
        depth_in: 2,
        depth_out: 2,
      }],
    });

    await page.evaluate(async () => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              setZeroDatum: (
                stationRef: { section_id: number; station_index: number },
                coordinates: { latitude: number; longitude: number; depth_reference: number }
              ) => Promise<unknown>;
            };
          };
        };
      }).__E2E_TEST__;
      if (!e2e) throw new Error('E2E stores not available on window');
      await e2e.projectStore.getState().setZeroDatum(
        { section_id: 1, station_index: 0 },
        { latitude: 24.55, longitude: -81.78, depth_reference: 0 }
      );
    });

    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    const formatSelect = page.locator('[data-testid="data-format-select"]');
    await formatSelect.locator('button').first().click();
    await page.getByRole('listbox').locator('[role="option"]:has-text("TML (Ariane)")').click();

    await page.getByTestId('export-button').click();
    await expect(page.getByTestId('tml-unanchored-warning-dialog')).toBeVisible();

    await page.getByTestId('tml-unanchored-warning-continue').click();
    await expect(exportDialog).not.toBeVisible({ timeout: 5000 });
  });

  test('should close dialog on Cancel', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Click Cancel button
    const cancelButton = page.locator('button:has-text("Cancel")');
    await cancelButton.click();

    // Dialog should be closed
    await expect(exportDialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should show color mode options for image export', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    // Color mode radio buttons should be visible
    const sectionModeRadio = page.locator('[data-testid="color-mode-section"]');
    const depthModeRadio = page.locator('[data-testid="color-mode-depth"]');
    await expect(sectionModeRadio).toBeVisible();
    await expect(depthModeRadio).toBeVisible();

    // Section mode should be selected by default
    await expect(sectionModeRadio).toBeChecked();
    await expect(depthModeRadio).not.toBeChecked();
  });

  test('should show depth preset dropdown when depth mode selected', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    // Depth preset should NOT be visible initially (section mode is default)
    const depthPresetSelect = page.locator('[data-testid="depth-preset-select"]');
    await expect(depthPresetSelect).not.toBeVisible();

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Depth preset dropdown should now be visible
    await expect(depthPresetSelect).toBeVisible();
  });

  test('should show include legend checkbox when depth mode selected', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

    // Include legend should NOT be visible initially (section mode is default)
    const includeLegendCheckbox = page.locator('[data-testid="option-include-legend"]');
    await expect(includeLegendCheckbox).not.toBeVisible();

    // Switch to depth mode
    await page.click('[data-testid="color-mode-depth"]');

    // Include legend checkbox should now be visible and checked by default
    await expect(includeLegendCheckbox).toBeVisible();
    await expect(includeLegendCheckbox).toBeChecked();
  });

  test('should include 600 DPI option in resolution selector', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export (PNG is default, which shows resolution selector)
    await page.click('[data-testid="export-type-image"]');

    // Resolution select should be visible
    const resolutionSelect = page.locator('[data-testid="resolution-select"]');
    await expect(resolutionSelect).toBeVisible();

    // Open the dropdown
    await resolutionSelect.locator('button').first().click();

    // Verify 600 DPI option is available (portaled listbox)
    const dropdown = page.getByRole('listbox');
    await expect(dropdown.locator('[role="option"]:has-text("600")')).toBeVisible();
  });

  test('should hide depth options when switching from depth to section mode', async ({ page }) => {
    await createProject(page, 'Export Dialog Test Project');

    // Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    // Switch to image export
    await page.click('[data-testid="export-type-image"]');

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

  test('should show progress for image export and disable cancel', async ({ page }) => {
    await createProject(page, 'Export Dialog Progress Project');

    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    await page.click('[data-testid="export-type-image"]');
    await page.click('[data-testid="color-mode-depth"]');

    const exportButton = page.getByTestId('export-button');
    await exportButton.click();

    const progress = page.getByTestId('loading-progress');
    await expect(progress).toBeVisible({ timeout: 5000 });

    const cancelButton = exportDialog.getByRole('button', { name: 'Cancel' });
    await expect(cancelButton).toBeDisabled();

    await expect(exportDialog).not.toBeVisible({ timeout: 10000 });
  });

  test('should close dialog when save is canceled', async ({ page }) => {
    await createProject(page, 'Export Dialog Save Cancel');

    await page.keyboard.press('Control+e');
    const exportDialog = page.locator('[data-testid="export-dialog"]');
    await expect(exportDialog).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      const dialogMock = (window as unknown as Record<string, unknown>).__TAURI_DIALOG_MOCK__ as {
        save?: () => Promise<string | null>;
      } | undefined;
      if (dialogMock) {
        dialogMock.save = async () => null;
      }
    });

    await page.getByTestId('export-button').click();
    await expect(exportDialog).not.toBeVisible({ timeout: 5000 });
  });
});
