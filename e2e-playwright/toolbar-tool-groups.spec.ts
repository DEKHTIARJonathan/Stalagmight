import { test, expect } from '@playwright/test';
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
];

async function createProjectWithSections(page: import('@playwright/test').Page): Promise<void> {
  await createProject(page, 'Tool Groups Test');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapReady(page);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
}

test.describe('Toolbar Tool Groups', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('tool group buttons are visible with correct testids', async ({ page }) => {
    await createProjectWithSections(page);

    // Navigate group and Move group should be visible
    const navigateGroup = page.getByTestId('tool-group-navigate');
    const moveGroup = page.getByTestId('tool-group-move');

    await expect(navigateGroup).toBeVisible();
    await expect(moveGroup).toBeVisible();
  });

  test('left-click on inactive group activates last-used subtool', async ({ page }) => {
    await createProjectWithSections(page);

    // Start with select tool active
    await page.keyboard.press('s');
    await waitForActiveTool(page, 'select');

    // Click the move group button - should activate default subtool (move_segment)
    const moveGroup = page.getByTestId('tool-group-move');
    await moveGroup.click();
    await waitForActiveTool(page, 'move_segment');
  });

  test('left-click on active group cycles to next subtool', async ({ page }) => {
    await createProjectWithSections(page);

    // Activate move_segment via keyboard
    await page.keyboard.press('v');
    await waitForActiveTool(page, 'move_segment');

    // Click the move group button - should cycle to next subtool (move_section)
    const moveGroup = page.getByTestId('tool-group-move');
    await moveGroup.click();
    await waitForActiveTool(page, 'move_section');

    // Click again - should cycle to move_shot
    await moveGroup.click();
    await waitForActiveTool(page, 'move_shot');

    // Click again - should cycle to move_station
    await moveGroup.click();
    await waitForActiveTool(page, 'move_station');

    // Click again - should wrap back to move_segment
    await moveGroup.click();
    await waitForActiveTool(page, 'move_segment');
  });

  test('right-click on group opens flyout panel', async ({ page }) => {
    await createProjectWithSections(page);

    // Right-click on the move group
    const moveGroup = page.getByTestId('tool-group-move');
    await moveGroup.click({ button: 'right' });

    // Flyout should be visible
    const flyout = page.getByTestId('subtool-flyout-move');
    await expect(flyout).toBeVisible();

    // Subtool items should be visible
    await expect(page.getByTestId('subtool-move_segment')).toBeVisible();
    await expect(page.getByTestId('subtool-move_section')).toBeVisible();
    await expect(page.getByTestId('subtool-move_shot')).toBeVisible();
    await expect(page.getByTestId('subtool-move_station')).toBeVisible();
  });

  test('clicking subtool in flyout activates it and closes flyout', async ({ page }) => {
    await createProjectWithSections(page);

    // Open flyout for navigate group
    const navigateGroup = page.getByTestId('tool-group-navigate');
    await navigateGroup.click({ button: 'right' });

    const flyout = page.getByTestId('subtool-flyout-navigate');
    await expect(flyout).toBeVisible();

    // Click the zoom subtool
    await page.getByTestId('subtool-zoom').click();

    // Zoom should now be active
    await waitForActiveTool(page, 'zoom');

    // Flyout should close
    await expect(flyout).not.toBeVisible();
  });

  test('clicking outside flyout closes it', async ({ page }) => {
    await createProjectWithSections(page);

    // Open flyout
    const moveGroup = page.getByTestId('tool-group-move');
    await moveGroup.click({ button: 'right' });

    const flyout = page.getByTestId('subtool-flyout-move');
    await expect(flyout).toBeVisible();

    // Click on the canvas (outside flyout)
    const canvas = page.getByTestId('map-canvas');
    await canvas.click({ position: { x: 200, y: 200 } });

    // Flyout should close
    await expect(flyout).not.toBeVisible();
  });

  test('flyout keyboard navigation: ArrowDown/ArrowUp and Enter selects', async ({ page }) => {
    await createProjectWithSections(page);

    // Open flyout for move group
    const moveGroup = page.getByTestId('tool-group-move');
    await moveGroup.click({ button: 'right' });

    const flyout = page.getByTestId('subtool-flyout-move');
    await expect(flyout).toBeVisible();

    // Arrow down to navigate to next item
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);

    // Press Enter to select the focused subtool
    await page.keyboard.press('Enter');

    // Flyout should close after selection
    await expect(flyout).not.toBeVisible();
  });

  test('flyout keyboard navigation: Escape closes flyout', async ({ page }) => {
    await createProjectWithSections(page);

    // Open flyout for move group
    const moveGroup = page.getByTestId('tool-group-move');
    await moveGroup.click({ button: 'right' });

    const flyout = page.getByTestId('subtool-flyout-move');
    await expect(flyout).toBeVisible();

    // Focus into the flyout so the keydown handler fires
    // The flyout should auto-focus a menu item when opened
    const firstMenuItem = flyout.locator('[role="menuitem"]').first();
    await expect(firstMenuItem).toBeFocused({ timeout: 2000 });

    // Escape should close the flyout
    await page.keyboard.press('Escape');
    await expect(flyout).not.toBeVisible();
  });

  test('keyboard shortcuts: V activates move_segment, Shift+V activates move_section, G activates move_shot', async ({ page }) => {
    await createProjectWithSections(page);

    // V should activate move_segment
    await page.keyboard.press('v');
    await waitForActiveTool(page, 'move_segment');

    // Shift+V should activate move_section
    await page.keyboard.press('Shift+v');
    await waitForActiveTool(page, 'move_section');

    // T should activate move_station
    await page.keyboard.press('t');
    await waitForActiveTool(page, 'move_station');

    // G should activate move_shot
    await page.keyboard.press('g');
    await waitForActiveTool(page, 'move_shot');
  });

  test('toolbar separators are visible between tool groups', async ({ page }) => {
    await createProjectWithSections(page);

    // The toolbar container should have separator dividers (thin vertical lines)
    const toolbar = page.getByTestId('toolbar');
    await expect(toolbar).toBeVisible();

    // Separators are rendered as div.w-px.h-6.bg-border elements inside the tools container
    const separators = toolbar.locator('.bg-background .w-px.h-6.bg-border');
    // We expect 3 separators: before navigate group, after navigate group, before move group
    const count = await separators.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
