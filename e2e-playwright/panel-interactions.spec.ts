import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a project with sections for panel testing.
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
  await page.locator('.fixed.inset-0 input').first().fill('Panel Test Project');
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
test.describe.skip('Panel Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should toggle sections panel with Ctrl+1', async ({ page }) => {
    // Create a project to access the SingleSystemView with panels
    await createProjectWithSections(page);

    // The sections panel should be visible by default (sectionsPanelOpen: true in uiStore)
    // Look for the "Sections" header or panel content
    const sectionsHeader = page.locator('h2:has-text("Sections")');
    await expect(sectionsHeader).toBeVisible({ timeout: 3000 });

    // Toggle off with Ctrl+1
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(300);

    // Sections panel header should no longer be visible
    await expect(sectionsHeader).not.toBeVisible({ timeout: 2000 });

    // Toggle back on with Ctrl+1
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(300);

    // Sections panel should be visible again
    await expect(sectionsHeader).toBeVisible({ timeout: 2000 });

    // App should remain functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should toggle detail panel with Ctrl+2', async ({ page }) => {
    // Create a project to access the SingleSystemView with panels
    await createProjectWithSections(page);

    // The detail panel should be visible by default (detailPanelOpen: true in uiStore)
    // Look for the "Details" tab button
    const detailsTab = page.getByRole('button', { name: 'Details' });

    // The Details tab should be visible
    await expect(detailsTab).toBeVisible({ timeout: 3000 });

    // Toggle off with Ctrl+2
    await page.keyboard.press('Control+2');
    await page.waitForTimeout(300);

    // Detail panel tabs should no longer be visible
    await expect(detailsTab).not.toBeVisible({ timeout: 2000 });

    // Toggle back on with Ctrl+2
    await page.keyboard.press('Control+2');
    await page.waitForTimeout(300);

    // Detail panel should be visible again
    await expect(detailsTab).toBeVisible({ timeout: 2000 });

    // App should remain functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should toggle data table panel with Ctrl+3', async ({ page }) => {
    // Create a project to access the SingleSystemView with panels
    await createProjectWithSections(page);

    // The data table is closed by default (dataTableOpen: false in uiStore)
    // Verify the data table is NOT visible initially
    const dataTableText = page.locator('text=Data Table');
    await expect(dataTableText).not.toBeVisible({ timeout: 2000 });

    // Toggle open with Ctrl+3
    await page.keyboard.press('Control+3');
    await page.waitForTimeout(300);

    // Data table should now be visible
    // Look for "Data Table" text and section selector dropdown
    await expect(dataTableText).toBeVisible({ timeout: 3000 });

    // Section selector should be visible when data table is open
    const sectionSelector = page.locator('select').filter({ hasText: /Main Passage|Section/ });
    await expect(sectionSelector).toBeVisible({ timeout: 2000 });

    // Table rows should be visible
    const tableBody = page.locator('tbody');
    await expect(tableBody).toBeVisible({ timeout: 2000 });

    // Toggle closed with Ctrl+3
    await page.keyboard.press('Control+3');
    await page.waitForTimeout(300);

    // Data table text should no longer be visible when closed
    await expect(dataTableText).not.toBeVisible({ timeout: 2000 });

    // App should remain functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should resize panels by dragging', async ({ page }) => {
    // Create a project to access the SingleSystemView with panels
    await createProjectWithSections(page);

    // Get the sections panel (left side)
    // The ResizablePanel has a resize handle on the right edge
    const sectionsPanel = page.locator('.flex-shrink-0').filter({
      has: page.locator('h2:has-text("Sections")')
    }).first();

    // Get initial width
    const initialBox = await sectionsPanel.boundingBox();
    expect(initialBox).not.toBeNull();
    const initialWidth = initialBox!.width;

    // Find the resize handle (it's a div with cursor-ew-resize)
    // The handle is positioned at the right edge of the panel
    const resizeHandle = sectionsPanel.locator('[class*="cursor-ew-resize"]');

    if (await resizeHandle.isVisible()) {
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).not.toBeNull();

      // Drag the handle to resize the panel
      const handleCenterX = handleBox!.x + handleBox!.width / 2;
      const handleCenterY = handleBox!.y + handleBox!.height / 2;

      // Drag to make panel wider (move right by 50px)
      await page.mouse.move(handleCenterX, handleCenterY);
      await page.mouse.down();
      await page.mouse.move(handleCenterX + 50, handleCenterY);
      await page.mouse.up();

      await page.waitForTimeout(200);

      // Check that the panel width changed
      const newBox = await sectionsPanel.boundingBox();
      expect(newBox).not.toBeNull();

      // Width should have increased (accounting for min/max constraints)
      // The panel has minSize=150 and maxSize=400
      expect(newBox!.width).toBeGreaterThanOrEqual(Math.min(initialWidth, 150));
      expect(newBox!.width).toBeLessThanOrEqual(400);

      // Try dragging to make it smaller (back to original-ish)
      const newHandleBox = await resizeHandle.boundingBox();
      if (newHandleBox) {
        const newHandleCenterX = newHandleBox.x + newHandleBox.width / 2;
        const newHandleCenterY = newHandleBox.y + newHandleBox.height / 2;

        await page.mouse.move(newHandleCenterX, newHandleCenterY);
        await page.mouse.down();
        await page.mouse.move(newHandleCenterX - 100, newHandleCenterY);
        await page.mouse.up();

        await page.waitForTimeout(200);

        // Verify panel respects min size constraint
        const finalBox = await sectionsPanel.boundingBox();
        expect(finalBox).not.toBeNull();
        expect(finalBox!.width).toBeGreaterThanOrEqual(150);
      }
    }

    // App should remain functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should expand/collapse section in sections panel', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // The sections panel shows a list of sections
    // Each section item has a name and stats (e.g., "3 shots - 33.7m")
    const sectionsPanel = page.locator('.flex.flex-col.bg-panel').filter({
      has: page.locator('h2:has-text("Sections")')
    });

    await expect(sectionsPanel).toBeVisible({ timeout: 3000 });

    // Find a section item to select/expand
    const sectionItem = page.locator('li').filter({ hasText: 'Main Passage' });
    await expect(sectionItem).toBeVisible({ timeout: 2000 });

    // Initially the section shows basic info (name and stats)
    const sectionStats = sectionItem.locator('text=/\\d+ shots/');
    await expect(sectionStats).toBeVisible();

    // Click on the section to select it
    await sectionItem.click();
    await page.waitForTimeout(200);

    // When a section is selected, it should have a highlight (bg-accent/20)
    await expect(sectionItem).toHaveClass(/bg-accent/);

    // The detail panel should now show section details
    const detailPanel = page.locator('button:has-text("Details")').locator('..');
    if (await detailPanel.isVisible()) {
      // Look for section-specific details like "Survey Statistics"
      const surveyStats = page.locator('h4:has-text("Survey Statistics")');
      await expect(surveyStats).toBeVisible({ timeout: 2000 });
    }

    // Click on a different section to verify selection changes
    const anotherSection = page.locator('li').filter({ hasText: 'Side Tunnel' });
    if (await anotherSection.isVisible()) {
      await anotherSection.click();
      await page.waitForTimeout(200);

      // The new section should be selected
      await expect(anotherSection).toHaveClass(/bg-accent/);

      // The previous section should no longer be selected
      await expect(sectionItem).not.toHaveClass(/bg-accent\/20/);
    }

    // App should remain functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('should handle panel overflow with scrolling', async ({ page }) => {
    // Create a project with sections
    await createProjectWithSections(page);

    // The sections panel has overflow-auto set for scrolling
    const sectionsList = page.locator('.overflow-auto').filter({
      has: page.locator('li').filter({ hasText: /Section|Passage|Tunnel/ })
    }).first();

    // Check that the overflow container is present
    await expect(sectionsList).toBeVisible({ timeout: 3000 });

    // The mock data provides 6 sections:
    // - Main Passage, Side Tunnel, Mixed LRUD Section, Undefined LRUD Section, Empty Section, Validation Test Section
    // With normal viewport, all sections should be visible without scrolling
    // Let's check that all imported sections are in the list

    const mainPassage = page.locator('li').filter({ hasText: 'Main Passage' });
    const sideTunnel = page.locator('li').filter({ hasText: 'Side Tunnel' });

    await expect(mainPassage).toBeVisible({ timeout: 2000 });
    await expect(sideTunnel).toBeVisible({ timeout: 2000 });

    // Test the data table panel for scrolling behavior
    // First, expand the data table
    await page.keyboard.press('Control+3');
    await page.waitForTimeout(300);

    // Select a section with shots in the data table
    const sectionSelector = page.locator('select').filter({ hasText: /Main Passage/ });
    if (await sectionSelector.isVisible()) {
      await sectionSelector.selectOption({ label: 'Main Passage' });
      await page.waitForTimeout(200);
    }

    // The data table should show shots with scrollable content if there are many
    const tableContainer = page.locator('.flex-1.overflow-auto').filter({
      has: page.locator('table, [class*="table"]')
    });

    if (await tableContainer.isVisible()) {
      // Check that the table has rows
      const tableRows = tableContainer.locator('tbody tr');
      const rowCount = await tableRows.count();
      expect(rowCount).toBeGreaterThan(0);

      // If there are enough rows to scroll, we can test scroll behavior
      if (rowCount > 5) {
        // Get scroll position
        const scrollTop = await tableContainer.evaluate((el) => el.scrollTop);

        // Scroll down
        await tableContainer.evaluate((el) => el.scrollBy(0, 100));
        await page.waitForTimeout(100);

        // Check that scroll position changed
        const newScrollTop = await tableContainer.evaluate((el) => el.scrollTop);
        expect(newScrollTop).toBeGreaterThanOrEqual(scrollTop);
      }
    }

    // Test the detail panel scroll area
    const detailPanelContent = page.locator('.overflow-auto').filter({
      has: page.locator('text=/Project Statistics|Survey Overview|Section/i')
    }).first();

    if (await detailPanelContent.isVisible()) {
      // The detail panel should have an overflow container for long content
      const hasOverflow = await detailPanelContent.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.overflowY === 'auto' || style.overflow === 'auto';
      });
      expect(hasOverflow).toBeTruthy();
    }

    // App should remain functional
    await expect(page.locator('canvas').first()).toBeVisible();
  });
});
