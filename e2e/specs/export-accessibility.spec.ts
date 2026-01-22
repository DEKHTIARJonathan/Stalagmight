/**
 * WebdriverIO Accessibility Tests: Export Dialog
 *
 * These tests validate accessibility features in the Export Dialog:
 * - Color mode radio group (role="radiogroup", aria-labelledby, name attr)
 * - Radio inputs are type="radio" with associated labels
 * - Depth preset dropdown (aria-label)
 * - Keyboard navigation (Arrow keys within radiogroup)
 * - Focus indicators (visible :focus-visible styles)
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

/**
 * Helper to wait for element to be displayed with proper timeout
 */
async function waitForElement(selector: string, timeout = 5000): Promise<WebdriverIO.Element> {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout });
  return element;
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

    // Switch to image export type and wait for it to be ready
    const imageRadio = await waitForElement('[data-testid="export-dialog"] [data-testid="export-type-image"]');
    await imageRadio.click();
    await browser.waitUntil(
      async () => (await imageRadio.isSelected()) === true,
      { timeout: 2000, timeoutMsg: 'Image radio should be selected' }
    );
  });

  describe('Color Mode Selection', () => {
    it('has radiogroup role on color mode container within export dialog', async () => {
      // Scope selector to export dialog to avoid false positives
      const radiogroup = await $('[data-testid="export-dialog"] [role="radiogroup"]');
      await expect(radiogroup).toBeExisting();
    });

    it('has aria-labelledby linking to label element', async () => {
      const radiogroup = await $('[data-testid="export-dialog"] [role="radiogroup"]');
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

    it('radio inputs are type="radio" with shared name attribute', async () => {
      const sectionRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-section"]');
      const depthRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-depth"]');

      await expect(sectionRadio).toBeExisting();
      await expect(depthRadio).toBeExisting();

      // Verify they are actual radio inputs
      const sectionType = await sectionRadio.getAttribute('type');
      const depthType = await depthRadio.getAttribute('type');
      expect(sectionType).toBe('radio');
      expect(depthType).toBe('radio');

      // Get name attributes - both should have the same non-empty name
      const sectionName = await sectionRadio.getAttribute('name');
      const depthName = await depthRadio.getAttribute('name');
      expect(sectionName).toBeTruthy();
      expect(sectionName).toBe(depthName);
    });

    it('radio inputs have associated labels', async () => {
      const sectionRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-section"]');
      const depthRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-depth"]');

      // Check that each radio is wrapped by a label element
      const sectionParent = await sectionRadio.parentElement();
      const depthParent = await depthRadio.parentElement();

      const sectionParentTag = await sectionParent.getTagName();
      const depthParentTag = await depthParent.getTagName();

      expect(sectionParentTag.toLowerCase()).toBe('label');
      expect(depthParentTag.toLowerCase()).toBe('label');
    });

    it('supports Arrow key navigation within radiogroup', async () => {
      const sectionRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-section"]');

      // Focus on section radio using keyboard (Tab into the group)
      await sectionRadio.click();
      await browser.waitUntil(
        async () => {
          const activeTestId = await browser.execute(() => document.activeElement?.getAttribute('data-testid'));
          return activeTestId === 'color-mode-section';
        },
        { timeout: 2000, timeoutMsg: 'Section radio should be focused' }
      );

      // Press ArrowRight to navigate to depth radio
      await browser.keys(['ArrowRight']);
      await browser.waitUntil(
        async () => {
          const activeTestId = await browser.execute(() => document.activeElement?.getAttribute('data-testid'));
          return activeTestId === 'color-mode-depth';
        },
        { timeout: 2000, timeoutMsg: 'Depth radio should be focused after ArrowRight' }
      );

      // Press ArrowLeft to navigate back
      await browser.keys(['ArrowLeft']);
      await browser.waitUntil(
        async () => {
          const activeTestId = await browser.execute(() => document.activeElement?.getAttribute('data-testid'));
          return activeTestId === 'color-mode-section';
        },
        { timeout: 2000, timeoutMsg: 'Section radio should be focused after ArrowLeft' }
      );
    });

    it('radio selection state is properly tracked via checked attribute', async () => {
      const sectionRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-section"]');
      const depthRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-depth"]');

      // Section should be checked by default
      expect(await sectionRadio.isSelected()).toBe(true);
      expect(await depthRadio.isSelected()).toBe(false);

      // Click depth to change selection
      await depthRadio.click();
      await browser.waitUntil(
        async () => (await depthRadio.isSelected()) === true,
        { timeout: 2000, timeoutMsg: 'Depth radio should be selected after click' }
      );

      // Now depth should be checked
      expect(await sectionRadio.isSelected()).toBe(false);
      expect(await depthRadio.isSelected()).toBe(true);
    });
  });

  describe('Depth Preset Dropdown', () => {
    beforeEach(async () => {
      // Switch to depth color mode to reveal preset dropdown
      const depthRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-depth"]');
      await depthRadio.click();
      await browser.waitUntil(
        async () => {
          const select = await $('[data-testid="export-dialog"] [data-testid="depth-preset-select"]');
          return await select.isDisplayed();
        },
        { timeout: 3000, timeoutMsg: 'Depth preset select should appear' }
      );
    });

    it('has aria-label for accessibility', async () => {
      const select = await $('[data-testid="export-dialog"] [data-testid="depth-preset-select"]');
      await expect(select).toBeExisting();

      // The Select component has the trigger button with aria-label
      const triggerButton = await select.$('button[aria-label]');
      await expect(triggerButton).toBeExisting();

      const ariaLabel = await triggerButton.getAttribute('aria-label');
      expect(ariaLabel).toBe('Depth color preset');
    });

    it('has aria-haspopup and aria-expanded attributes', async () => {
      const select = await $('[data-testid="export-dialog"] [data-testid="depth-preset-select"]');
      const triggerButton = await select.$('button');

      // Should have aria-haspopup
      const hasPopup = await triggerButton.getAttribute('aria-haspopup');
      expect(hasPopup).toBe('listbox');

      // Should have aria-expanded false initially
      const isExpanded = await triggerButton.getAttribute('aria-expanded');
      expect(isExpanded).toBe('false');

      // Click to open
      await triggerButton.click();
      await browser.waitUntil(
        async () => (await triggerButton.getAttribute('aria-expanded')) === 'true',
        { timeout: 2000, timeoutMsg: 'Dropdown should be expanded' }
      );
    });

    it('preset options have descriptive labels', async () => {
      const select = await $('[data-testid="export-dialog"] [data-testid="depth-preset-select"]');
      const triggerButton = await select.$('button');

      // Open dropdown
      await triggerButton.click();
      await browser.waitUntil(
        async () => (await triggerButton.getAttribute('aria-expanded')) === 'true',
        { timeout: 2000 }
      );

      // Get all option buttons in the dropdown
      const options = await select.$$('button:not([aria-haspopup])');
      expect(options.length).toBeGreaterThanOrEqual(5); // thermal, ocean, terrain, grayscale, accessible

      // Check that options have descriptive text (including parenthetical descriptions)
      const optionTexts: string[] = [];
      for (const opt of options) {
        optionTexts.push(await opt.getText());
      }

      // Filter out the trigger button text if it's in the array
      const dropdownOptions = optionTexts.filter((t) => t.includes('('));
      expect(dropdownOptions.length).toBeGreaterThanOrEqual(4);

      // Each dropdown option should have a description in parentheses
      for (const text of dropdownOptions) {
        expect(text).toMatch(/\(.*\)/);
      }
    });
  });

  describe('Legend Checkbox', () => {
    beforeEach(async () => {
      // Switch to depth color mode to reveal legend checkbox
      const depthRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-depth"]');
      await depthRadio.click();
      await browser.waitUntil(
        async () => {
          const checkbox = await $('[data-testid="export-dialog"] [data-testid="option-include-legend"]');
          return await checkbox.isDisplayed();
        },
        { timeout: 3000, timeoutMsg: 'Legend checkbox should appear' }
      );
    });

    it('has accessible checkbox with label', async () => {
      const checkbox = await $('[data-testid="export-dialog"] [data-testid="option-include-legend"]');
      await expect(checkbox).toBeExisting();

      // Verify it's a checkbox input
      const inputType = await checkbox.getAttribute('type');
      expect(inputType).toBe('checkbox');

      // Checkbox should be inside a label
      const label = await checkbox.parentElement();
      await expect(label).toBeExisting();

      const tagName = await label.getTagName();
      expect(tagName.toLowerCase()).toBe('label');

      // Label should contain "legend" text
      const labelText = await label.getText();
      expect(labelText.toLowerCase()).toContain('legend');
    });

    it('responds to Space key for toggling', async () => {
      const checkbox = await $('[data-testid="export-dialog"] [data-testid="option-include-legend"]');

      // Get initial state
      const initialState = await checkbox.isSelected();

      // Use Tab to navigate to the checkbox (keyboard focus)
      // First, focus on the depth radio (which is already selected from beforeEach)
      const depthRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-depth"]');
      await depthRadio.click();

      // Tab to get to the checkbox - use closest() to detect testid on parent containers
      await browser.keys(['Tab']);
      await browser.waitUntil(
        async () => {
          const testId = await browser.execute(() => {
            const el = document.activeElement;
            // Check direct testid or closest parent with testid
            return el?.getAttribute('data-testid') ||
                   el?.closest('[data-testid]')?.getAttribute('data-testid') ||
                   '';
          });
          // May land on preset select (button inside) or checkbox
          return testId === 'option-include-legend' || testId === 'depth-preset-select';
        },
        { timeout: 2000 }
      );

      // Check if we're on the checkbox or need to tab once more
      const currentTestId = await browser.execute(() => {
        const el = document.activeElement;
        return el?.getAttribute('data-testid') ||
               el?.closest('[data-testid]')?.getAttribute('data-testid') ||
               '';
      });

      if (currentTestId !== 'option-include-legend') {
        await browser.keys(['Tab']);
        await browser.waitUntil(
          async () => {
            const id = await browser.execute(() => document.activeElement?.getAttribute('data-testid'));
            return id === 'option-include-legend';
          },
          { timeout: 2000 }
        );
      }

      // Now toggle with Space key
      await browser.keys(['Space']);
      await browser.waitUntil(
        async () => (await checkbox.isSelected()) !== initialState,
        { timeout: 2000, timeoutMsg: 'Checkbox should toggle after Space' }
      );

      // Toggle back
      await browser.keys(['Space']);
      await browser.waitUntil(
        async () => (await checkbox.isSelected()) === initialState,
        { timeout: 2000, timeoutMsg: 'Checkbox should toggle back after second Space' }
      );
    });
  });

  describe('Focus Management', () => {
    it('shows visible focus indicator on radio controls via keyboard', async () => {
      // Use Tab key to navigate to radio group for :focus-visible
      const dialog = await $('[data-testid="export-dialog"]');
      await dialog.click(); // Ensure dialog has focus

      // Tab to the first focusable element (should be export type radios)
      await browser.keys(['Tab']);
      await browser.keys(['Tab']); // Navigate into color mode radios

      // Check for visible focus styles and :focus-visible match
      const focusResult = await browser.execute(() => {
        const el = document.activeElement as HTMLElement;
        if (!el) return { hasFocusVisible: false, hasStyles: false };

        const matchesFocusVisible = el.matches(':focus-visible');
        const styles = window.getComputedStyle(el);
        const hasOutline = styles.outlineWidth !== '0px' && styles.outlineStyle !== 'none';
        const hasBoxShadow = styles.boxShadow !== 'none';

        return {
          hasFocusVisible: matchesFocusVisible,
          hasStyles: hasOutline || hasBoxShadow,
          testId: el.getAttribute('data-testid'),
        };
      });

      // Element should have focus and visible styling
      expect(focusResult.hasStyles || focusResult.hasFocusVisible).toBe(true);
    });

    it('shows visible focus indicator on checkboxes via keyboard', async () => {
      // Switch to depth mode to see the legend checkbox
      const depthRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-depth"]');
      await depthRadio.click();
      await browser.waitUntil(
        async () => {
          const checkbox = await $('[data-testid="export-dialog"] [data-testid="option-include-legend"]');
          return await checkbox.isDisplayed();
        },
        { timeout: 3000 }
      );

      // Tab to navigate to checkbox
      await browser.keys(['Tab']); // preset select
      await browser.keys(['Tab']); // legend checkbox

      // Check for visible focus styles
      const focusResult = await browser.execute(() => {
        const el = document.activeElement as HTMLElement;
        if (!el) return { hasFocusVisible: false, hasStyles: false };

        const matchesFocusVisible = el.matches(':focus-visible');
        const styles = window.getComputedStyle(el);
        const hasOutline = styles.outlineWidth !== '0px' && styles.outlineStyle !== 'none';
        const hasBoxShadow = styles.boxShadow !== 'none';

        return {
          hasFocusVisible: matchesFocusVisible,
          hasStyles: hasOutline || hasBoxShadow,
          testId: el.getAttribute('data-testid'),
        };
      });

      expect(focusResult.hasStyles || focusResult.hasFocusVisible).toBe(true);
    });

    it('shows visible focus indicator on dropdown button via keyboard', async () => {
      // Switch to depth mode to see the preset dropdown
      const depthRadio = await $('[data-testid="export-dialog"] [data-testid="color-mode-depth"]');
      await depthRadio.click();
      await browser.waitUntil(
        async () => {
          const select = await $('[data-testid="export-dialog"] [data-testid="depth-preset-select"]');
          return await select.isDisplayed();
        },
        { timeout: 3000 }
      );

      // Tab to the preset dropdown button
      await browser.keys(['Tab']);

      // Get styles before and compare (avoiding hard-coded colors)
      const focusResult = await browser.execute(() => {
        const el = document.activeElement as HTMLElement;
        if (!el) return { hasFocusVisible: false, hasStyles: false };

        const matchesFocusVisible = el.matches(':focus-visible');
        const styles = window.getComputedStyle(el);
        const hasOutline = styles.outlineWidth !== '0px' && styles.outlineStyle !== 'none';
        const hasBoxShadow = styles.boxShadow !== 'none';

        return {
          hasFocusVisible: matchesFocusVisible,
          hasStyles: hasOutline || hasBoxShadow,
          tagName: el.tagName.toLowerCase(),
        };
      });

      // Should have focus indicator
      expect(focusResult.hasStyles || focusResult.hasFocusVisible).toBe(true);
    });
  });

  describe('Resolution Select (PNG)', () => {
    it('has options including 600 DPI for print', async () => {
      // PNG format should be selected by default, showing resolution select
      const resolutionSelect = await $('[data-testid="export-dialog"] [data-testid="resolution-select"]');
      await expect(resolutionSelect).toBeExisting();

      const triggerButton = await resolutionSelect.$('button');
      await triggerButton.click();
      await browser.waitUntil(
        async () => (await triggerButton.getAttribute('aria-expanded')) === 'true',
        { timeout: 2000 }
      );

      // Get option texts
      const options = await resolutionSelect.$$('button:not([aria-haspopup])');
      const optionTexts: string[] = [];
      for (const opt of options) {
        optionTexts.push(await opt.getText());
      }

      // Should have 600 DPI option
      expect(optionTexts.some((t) => t.includes('600'))).toBe(true);
      expect(optionTexts.some((t) => t.toLowerCase().includes('print'))).toBe(true);
    });
  });

  describe('Export Button', () => {
    it('has clear button text indicating action', async () => {
      const button = await $('[data-testid="export-dialog"] [data-testid="export-button"]');
      await expect(button).toBeExisting();

      const buttonText = await button.getText();
      expect(buttonText).toBe('Export');
    });

    it('button is keyboard accessible via Tab navigation', async () => {
      // Tab through the dialog to reach the export button
      const dialog = await $('[data-testid="export-dialog"]');
      await dialog.click();

      // Tab multiple times to reach export button (it's typically at the end)
      for (let i = 0; i < 10; i++) {
        await browser.keys(['Tab']);
        const activeTestId = await browser.execute(() => document.activeElement?.getAttribute('data-testid'));
        if (activeTestId === 'export-button') {
          break;
        }
      }

      // Verify we reached the button
      const isFocused = await browser.execute(() => {
        return document.activeElement?.getAttribute('data-testid') === 'export-button';
      });
      expect(isFocused).toBe(true);
    });
  });
});
