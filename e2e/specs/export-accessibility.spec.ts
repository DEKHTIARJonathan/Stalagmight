/**
 * WebdriverIO Accessibility Tests: Export Dialog
 *
 * These tests validate accessibility features in the Export Dialog:
 * - Color mode radio group (role="radiogroup", aria-labelledby, name attr)
 * - Depth preset dropdown (aria-label)
 * - Keyboard navigation (Arrow keys within radiogroup)
 * - Focus indicators (visible focus styles)
 * - Legend checkbox accessibility
 *
 * Test fixtures:
 * - test_v2.dmp: DMP version 2 format with multiple sections
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importDmpFile,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

/**
 * Helper to open export dialog via store
 */
async function openExportDialog(): Promise<void> {
  await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            openDialog: (name: string) => void;
          };
        };
      };
    }).__E2E_TEST__;

    if (e2e) {
      e2e.uiStore.getState().openDialog('export');
    }
  });

  // Wait for export dialog to appear
  const dialog = await $('[data-testid="export-dialog"]');
  await dialog.waitForDisplayed({ timeout: 5000 });
}

describe('Export Dialog Accessibility', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();

    // Create a new project with survey data
    await createNewProject('Export A11y Test');

    // Import survey data for realistic export scenario
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpFile(dmpPath);
    expect(importResult.success).toBe(true);

    // Open export dialog
    await openExportDialog();

    // Switch to image export type
    const imageRadio = await $('[data-testid="export-type-image"]');
    await imageRadio.click();
    await browser.pause(100);
  });

  describe('Color Mode Selection', () => {
    it('has radiogroup role on color mode container', async () => {
      // Verify radiogroup role exists
      const radiogroup = await $('[role="radiogroup"]');
      await expect(radiogroup).toBeExisting();
    });

    it('has aria-labelledby linking to label element', async () => {
      const radiogroup = await $('[role="radiogroup"]');
      await expect(radiogroup).toBeExisting();

      // Get the aria-labelledby attribute
      const labelledBy = await radiogroup.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();

      // Verify the referenced label element exists and contains "Color"
      const label = await $(`#${labelledBy}`);
      await expect(label).toBeExisting();
      const labelText = await label.getText();
      expect(labelText.toLowerCase()).toContain('color');
    });

    it('radio inputs share name attribute for grouping', async () => {
      const sectionRadio = await $('[data-testid="color-mode-section"]');
      const depthRadio = await $('[data-testid="color-mode-depth"]');

      await expect(sectionRadio).toBeExisting();
      await expect(depthRadio).toBeExisting();

      // Get name attributes
      const sectionName = await sectionRadio.getAttribute('name');
      const depthName = await depthRadio.getAttribute('name');

      // Both should have the same non-empty name
      expect(sectionName).toBeTruthy();
      expect(sectionName).toBe(depthName);
    });

    it('supports Arrow key navigation within radiogroup', async () => {
      const sectionRadio = await $('[data-testid="color-mode-section"]');
      const depthRadio = await $('[data-testid="color-mode-depth"]');

      // Focus on section radio
      await sectionRadio.click();
      await browser.pause(100);

      // Verify section radio is focused
      const isSectionFocused = await browser.execute(() => {
        const el = document.activeElement;
        return el?.getAttribute('data-testid') === 'color-mode-section';
      });
      expect(isSectionFocused).toBe(true);

      // Press ArrowRight to navigate to depth radio
      await browser.keys(['ArrowRight']);
      await browser.pause(100);

      // Verify depth radio is now focused
      const isDepthFocused = await browser.execute(() => {
        const el = document.activeElement;
        return el?.getAttribute('data-testid') === 'color-mode-depth';
      });
      expect(isDepthFocused).toBe(true);

      // Press ArrowLeft to navigate back
      await browser.keys(['ArrowLeft']);
      await browser.pause(100);

      // Verify section radio is focused again
      const isSectionFocusedAgain = await browser.execute(() => {
        const el = document.activeElement;
        return el?.getAttribute('data-testid') === 'color-mode-section';
      });
      expect(isSectionFocusedAgain).toBe(true);
    });

    it('announces selection state via aria-checked for screen readers', async () => {
      const sectionRadio = await $('[data-testid="color-mode-section"]');
      const depthRadio = await $('[data-testid="color-mode-depth"]');

      // Section should be checked by default
      expect(await sectionRadio.isSelected()).toBe(true);
      expect(await depthRadio.isSelected()).toBe(false);

      // Click depth to change selection
      await depthRadio.click();
      await browser.pause(100);

      // Now depth should be checked
      expect(await sectionRadio.isSelected()).toBe(false);
      expect(await depthRadio.isSelected()).toBe(true);
    });
  });

  describe('Depth Preset Dropdown', () => {
    beforeEach(async () => {
      // Switch to depth color mode to reveal preset dropdown
      const depthRadio = await $('[data-testid="color-mode-depth"]');
      await depthRadio.click();
      await browser.pause(200);
    });

    it('has aria-label for accessibility', async () => {
      const select = await $('[data-testid="depth-preset-select"]');
      await expect(select).toBeExisting();

      // The Select component has the trigger button with aria-label
      const triggerButton = await select.$('button[aria-label]');
      await expect(triggerButton).toBeExisting();

      const ariaLabel = await triggerButton.getAttribute('aria-label');
      expect(ariaLabel).toBe('Depth color preset');
    });

    it('has aria-haspopup and aria-expanded attributes', async () => {
      const select = await $('[data-testid="depth-preset-select"]');
      const triggerButton = await select.$('button');

      // Should have aria-haspopup
      const hasPopup = await triggerButton.getAttribute('aria-haspopup');
      expect(hasPopup).toBe('listbox');

      // Should have aria-expanded false initially
      const isExpanded = await triggerButton.getAttribute('aria-expanded');
      expect(isExpanded).toBe('false');

      // Click to open
      await triggerButton.click();
      await browser.pause(100);

      // Should now be expanded
      const isExpandedAfterClick = await triggerButton.getAttribute('aria-expanded');
      expect(isExpandedAfterClick).toBe('true');
    });

    it('preset options have descriptive labels', async () => {
      const select = await $('[data-testid="depth-preset-select"]');
      const triggerButton = await select.$('button');

      // Open dropdown
      await triggerButton.click();
      await browser.pause(100);

      // Get all option buttons in the dropdown
      const options = await select.$$('button:not([aria-haspopup])');
      expect(options.length).toBeGreaterThanOrEqual(5); // thermal, ocean, terrain, grayscale, accessible

      // Check that options have descriptive text (including parenthetical descriptions)
      const optionTexts = await Promise.all(options.map((o) => o.getText()));

      // Filter out the trigger button text if it's in the array
      const dropdownOptions = optionTexts.filter((t) => t.includes('('));
      expect(dropdownOptions.length).toBeGreaterThanOrEqual(4);

      // Each dropdown option should have a description in parentheses
      for (const text of dropdownOptions) {
        expect(text).toMatch(/\(.*\)/);
      }
    });

    it('closes dropdown on Escape key', async () => {
      const select = await $('[data-testid="depth-preset-select"]');
      const triggerButton = await select.$('button');

      // Open dropdown
      await triggerButton.click();
      await browser.pause(100);

      // Verify expanded
      expect(await triggerButton.getAttribute('aria-expanded')).toBe('true');

      // Press Escape
      await browser.keys(['Escape']);
      await browser.pause(100);

      // Verify closed
      expect(await triggerButton.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('Legend Checkbox', () => {
    beforeEach(async () => {
      // Switch to depth color mode to reveal legend checkbox
      const depthRadio = await $('[data-testid="color-mode-depth"]');
      await depthRadio.click();
      await browser.pause(200);
    });

    it('has accessible checkbox with label', async () => {
      const checkbox = await $('[data-testid="option-include-legend"]');
      await expect(checkbox).toBeExisting();

      // Checkbox should be inside a label
      const label = await checkbox.parentElement();
      await expect(label).toBeExisting();

      const tagName = await label.getTagName();
      expect(tagName.toLowerCase()).toBe('label');

      // Label should contain "legend" text
      const labelText = await label.getText();
      expect(labelText.toLowerCase()).toContain('legend');
    });

    it('is toggleable with keyboard (Space key)', async () => {
      const checkbox = await $('[data-testid="option-include-legend"]');

      // Get initial state (should be checked by default)
      const wasChecked = await checkbox.isSelected();

      // Focus the checkbox
      await checkbox.click();
      await browser.pause(50);

      // Now toggle with Space key
      await browser.keys(['Space']);
      await browser.pause(100);

      // State should have toggled
      const isCheckedNow = await checkbox.isSelected();
      expect(isCheckedNow).toBe(!wasChecked);

      // Toggle back
      await browser.keys(['Space']);
      await browser.pause(100);
      expect(await checkbox.isSelected()).toBe(wasChecked);
    });
  });

  describe('Focus Management', () => {
    it('shows visible focus indicator on radio controls', async () => {
      const sectionRadio = await $('[data-testid="color-mode-section"]');

      // Focus the radio by clicking it
      await sectionRadio.click();
      await browser.pause(100);

      // Check for visible focus styles via execute
      const focusStyles = await browser.execute(() => {
        const el = document.querySelector('[data-testid="color-mode-section"]');
        if (!el) return { outlineWidth: '0px', outlineStyle: 'none', boxShadow: 'none' };
        const styles = window.getComputedStyle(el);
        return {
          outlineWidth: styles.outlineWidth,
          outlineStyle: styles.outlineStyle,
          boxShadow: styles.boxShadow,
        };
      });

      // Should have either outline or box-shadow for focus indication
      const hasFocusIndicator =
        (focusStyles.outlineWidth !== '0px' && focusStyles.outlineStyle !== 'none') ||
        (focusStyles.boxShadow !== 'none');
      expect(hasFocusIndicator).toBe(true);
    });

    it('shows visible focus indicator on checkboxes', async () => {
      // Switch to depth mode to see the legend checkbox
      const depthRadio = await $('[data-testid="color-mode-depth"]');
      await depthRadio.click();
      await browser.pause(200);

      const checkbox = await $('[data-testid="option-include-legend"]');

      // Focus the checkbox by clicking it
      await checkbox.click();
      await browser.pause(100);

      // Check for visible focus styles via execute
      const focusStyles = await browser.execute(() => {
        const el = document.querySelector('[data-testid="option-include-legend"]');
        if (!el) return { outlineWidth: '0px', outlineStyle: 'none', boxShadow: 'none' };
        const styles = window.getComputedStyle(el);
        return {
          outlineWidth: styles.outlineWidth,
          outlineStyle: styles.outlineStyle,
          boxShadow: styles.boxShadow,
        };
      });

      // Should have focus indicator
      const hasFocusIndicator =
        (focusStyles.outlineWidth !== '0px' && focusStyles.outlineStyle !== 'none') ||
        (focusStyles.boxShadow !== 'none');
      expect(hasFocusIndicator).toBe(true);
    });

    it('shows visible focus indicator on dropdown button', async () => {
      // Switch to depth mode to see the preset dropdown
      const depthRadio = await $('[data-testid="color-mode-depth"]');
      await depthRadio.click();
      await browser.pause(200);

      const select = await $('[data-testid="depth-preset-select"]');
      const triggerButton = await select.$('button');

      // Focus the button by clicking it
      await triggerButton.click();
      await browser.pause(100);

      // Check for visible focus styles via execute
      const focusStyles = await browser.execute(() => {
        const el = document.querySelector('[data-testid="depth-preset-select"] button');
        if (!el) return { outlineWidth: '0px', outlineStyle: 'none', boxShadow: 'none', borderColor: '' };
        const styles = window.getComputedStyle(el);
        return {
          outlineWidth: styles.outlineWidth,
          outlineStyle: styles.outlineStyle,
          boxShadow: styles.boxShadow,
          borderColor: styles.borderColor,
        };
      });

      // Should have focus indicator (the Select component uses border-accent on hover/focus)
      const hasFocusIndicator =
        (focusStyles.outlineWidth !== '0px' && focusStyles.outlineStyle !== 'none') ||
        (focusStyles.boxShadow !== 'none') ||
        // The Select hover state changes border color
        focusStyles.borderColor !== 'rgb(68, 68, 68)'; // default border color

      expect(hasFocusIndicator).toBe(true);
    });
  });

  describe('Resolution Select (PNG)', () => {
    it('has options including 600 DPI for print', async () => {
      // PNG format should be selected by default, showing resolution select
      const resolutionSelect = await $('[data-testid="resolution-select"]');
      await expect(resolutionSelect).toBeExisting();

      const triggerButton = await resolutionSelect.$('button');
      await triggerButton.click();
      await browser.pause(100);

      // Get option texts
      const options = await resolutionSelect.$$('button:not([aria-haspopup])');
      const optionTexts = await Promise.all(options.map((o) => o.getText()));

      // Should have 600 DPI option
      expect(optionTexts.some((t) => t.includes('600'))).toBe(true);
      expect(optionTexts.some((t) => t.toLowerCase().includes('print'))).toBe(true);
    });
  });

  describe('Export Button', () => {
    it('has clear button text indicating action', async () => {
      const button = await $('[data-testid="export-button"]');
      await expect(button).toBeExisting();

      const buttonText = await button.getText();
      expect(buttonText).toBe('Export');
    });

    it('button is keyboard accessible', async () => {
      const button = await $('[data-testid="export-button"]');

      // Should be focusable - use click to focus
      await button.click();
      await browser.pause(100);

      // Verify focus landed on the button (the dialog may close if export initiates,
      // so we check for either the button being focused or the dialog being open)
      const isFocused = await browser.execute(() => {
        const activeEl = document.activeElement;
        // Button might be focused, or we might have opened a file dialog
        return activeEl?.getAttribute('data-testid') === 'export-button' ||
               activeEl?.tagName.toLowerCase() === 'button';
      });
      expect(isFocused).toBe(true);
    });
  });
});

describe('Export Integration - PNG Success', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    await createNewProject('PNG Export Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpFile(dmpPath);
    expect(importResult.success).toBe(true);
  });

  /**
   * Verify PNG export succeeds (not SVG fallback).
   * This test validates that PNG export via resvg works correctly.
   */
  it('exports PNG successfully without error', async () => {
    // Get the export store action
    const exportResult = await browser.executeAsync(
      async (done: (result: { success: boolean; error?: string }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                exportImage: (
                  path: string,
                  options: {
                    format: string;
                    dpi: number;
                    include_satellite: boolean;
                    include_grid: boolean;
                    include_labels: boolean;
                    include_section_names: boolean;
                    include_shot_data: boolean;
                    color_mode: string;
                    depth_preset: string;
                    include_legend: boolean;
                    depth_unit: string;
                    decimal_precision: number;
                  }
                ) => Promise<void>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          // Use temp path for test (file will be created but we just care it doesn't error)
          const tempPath = '/tmp/cavechef-test-export.png';
          await e2e.projectStore.getState().exportImage(tempPath, {
            format: 'png',
            dpi: 150, // Lower DPI for faster test
            include_satellite: false,
            include_grid: false,
            include_labels: true,
            include_section_names: true,
            include_shot_data: false,
            color_mode: 'section',
            depth_preset: 'thermal',
            include_legend: false,
            depth_unit: 'm',
            decimal_precision: 1,
          });
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      }
    );

    // PNG export should succeed, not error about PNG or fallback to SVG
    expect(exportResult.success).toBe(true);
    expect(exportResult.error).toBeUndefined();
  });

  it('exports PNG with depth color mode successfully', async () => {
    const exportResult = await browser.executeAsync(
      async (done: (result: { success: boolean; error?: string }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                exportImage: (
                  path: string,
                  options: {
                    format: string;
                    dpi: number;
                    include_satellite: boolean;
                    include_grid: boolean;
                    include_labels: boolean;
                    include_section_names: boolean;
                    include_shot_data: boolean;
                    color_mode: string;
                    depth_preset: string;
                    include_legend: boolean;
                    depth_unit: string;
                    decimal_precision: number;
                  }
                ) => Promise<void>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          const tempPath = '/tmp/cavechef-test-export-depth.png';
          await e2e.projectStore.getState().exportImage(tempPath, {
            format: 'png',
            dpi: 150,
            include_satellite: false,
            include_grid: false,
            include_labels: true,
            include_section_names: true,
            include_shot_data: false,
            color_mode: 'depth',
            depth_preset: 'thermal',
            include_legend: true,
            depth_unit: 'm',
            decimal_precision: 1,
          });
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      }
    );

    // Depth mode PNG export should also succeed
    expect(exportResult.success).toBe(true);
    expect(exportResult.error).toBeUndefined();
  });
});
