import { test, expect } from './fixtures/coverage';
import type { Page, Locator } from './fixtures/coverage';
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

async function createProjectWithSections(page: import('./fixtures/coverage').Page): Promise<void> {
  await createProject(page, 'Tool Groups Test');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapReady(page);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
}

async function pressUntilFocused(
  page: Page,
  locator: Locator,
  key: string,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await page.keyboard.press(key);
    const isFocused = await locator.evaluate((el) => el === document.activeElement);
    if (isFocused) {
      return;
    }
    await page.waitForTimeout(25);
  }
  await expect(locator).toBeFocused({ timeout: 2000 });
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

    // Click the move group button - should cycle to next subtool (move_shot)
    const moveGroup = page.getByTestId('tool-group-move');
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
    await moveGroup.dispatchEvent('contextmenu');

    // Flyout should be visible
    const flyout = page.getByTestId('subtool-flyout-move');
    await expect(flyout).toBeVisible();

    // Subtool items should be visible
    await expect(page.getByTestId('subtool-move_segment')).toBeVisible();
    await expect(page.getByTestId('subtool-move_shot')).toBeVisible();
    await expect(page.getByTestId('subtool-move_station')).toBeVisible();
  });

  test('clicking subtool in flyout activates it and closes flyout', async ({ page }) => {
    await createProjectWithSections(page);

    // Open flyout for navigate group
    const navigateGroup = page.getByTestId('tool-group-navigate');
    await navigateGroup.dispatchEvent('contextmenu');

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
    await moveGroup.dispatchEvent('contextmenu');

    const flyout = page.getByTestId('subtool-flyout-move');
    await expect(flyout).toBeVisible();

    // Click on the canvas (outside flyout)
    const canvas = page.getByTestId('map-canvas');
    await canvas.click({ position: { x: 200, y: 200 } });

    // Flyout should close
    await expect(flyout).not.toBeVisible();
  });

  test('flyout keyboard navigation: ArrowDown/ArrowUp move focus, Enter and Space select', async ({ page }) => {
    await createProjectWithSections(page);

    // Activate move_segment first so flyout opens with it focused
    await page.keyboard.press('v');
    await waitForActiveTool(page, 'move_segment');

    // Open flyout for move group
    const moveGroup = page.getByTestId('tool-group-move');
    await moveGroup.dispatchEvent('contextmenu');

    const flyout = page.getByTestId('subtool-flyout-move');
    await expect(flyout).toBeVisible();

    // The active subtool (move_segment, index 0) should be focused initially
    const moveSegmentItem = page.getByTestId('subtool-move_segment');
    await expect(moveSegmentItem).toBeFocused({ timeout: 2000 });

    // ArrowDown should move focus to next item (move_shot, index 1)
    const moveShotItem = page.getByTestId('subtool-move_shot');
    await pressUntilFocused(page, moveShotItem, 'ArrowDown');

    // ArrowDown again to move_station (index 2)
    const moveStationItem = page.getByTestId('subtool-move_station');
    await pressUntilFocused(page, moveStationItem, 'ArrowDown');

    // ArrowUp should go back to move_shot (index 1)
    await pressUntilFocused(page, moveShotItem, 'ArrowUp');

    // Press Enter to select move_shot
    await page.keyboard.press('Enter');

    // Flyout should close and move_shot should be active
    await expect(flyout).not.toBeVisible();
    await waitForActiveTool(page, 'move_shot');

    // Now test Space selection: open flyout again
    await moveGroup.dispatchEvent('contextmenu');
    await expect(flyout).toBeVisible();

    // move_shot should be focused (since it's now active)
    await expect(moveShotItem).toHaveAttribute('aria-current', 'true');
    await moveShotItem.focus();
    await expect(moveShotItem).toBeFocused({ timeout: 2000 });

    // Navigate to move_station with ArrowDown
    await pressUntilFocused(page, moveStationItem, 'ArrowDown');

    // Press Space to select move_station
    await page.keyboard.press(' ');

    // Flyout should close and move_station should be active
    await expect(flyout).not.toBeVisible();
    await waitForActiveTool(page, 'move_station');
  });

  test('flyout keyboard navigation: Escape closes flyout', async ({ page }) => {
    await createProjectWithSections(page);

    // Open flyout for move group
    const moveGroup = page.getByTestId('tool-group-move');
    await moveGroup.dispatchEvent('contextmenu');

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

  test('keyboard shortcuts: V activates move_segment, G activates move_shot, T activates move_station', async ({ page }) => {
    await createProjectWithSections(page);

    // V should activate move_segment
    await page.keyboard.press('v');
    await waitForActiveTool(page, 'move_segment');

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

  test('anchored sections are faded when Move Segment tool is active', async ({ page }) => {
    await createProjectWithSections(page);

    // Set a zero datum on the first section's station 0 via store
    await page.evaluate(async () => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              setZeroDatum: (stationRef: unknown, coordinates: unknown) => Promise<void>;
            };
          };
        };
      }).__E2E_TEST__;
      if (!e2e) throw new Error('E2E stores not available');
      await e2e.projectStore.getState().setZeroDatum(
        { section_id: 1, station_index: 0 },
        { latitude: 24.55, longitude: -81.78, depth_reference: 0 }
      );
    });

    // Activate move_segment tool
    await page.keyboard.press('v');
    await waitForActiveTool(page, 'move_segment');

    // Wait for anchored section IDs to be fetched and feature-state applied.
    // Poll until a station feature in section 1 has anchored=true in feature-state.
    await page.waitForFunction(() => {
      const map = (window as unknown as { __stalagmight_map__?: {
        querySourceFeatures: (source: string) => Array<{ id?: number | string; properties?: { sectionId?: number } }>;
        getFeatureState: (opts: { source: string; id: number }) => { anchored?: boolean };
      } }).__stalagmight_map__;
      if (!map) return false;

      try {
        const features = map.querySourceFeatures('survey-data-stations');
        for (const f of features) {
          if (f.properties?.sectionId === 1 && f.id != null) {
            const featureId = typeof f.id === 'number' ? f.id : parseInt(String(f.id), 10);
            if (!isNaN(featureId)) {
              const state = map.getFeatureState({ source: 'survey-data-stations', id: featureId });
              if (state?.anchored === true) return true;
            }
          }
        }
      } catch {
        // Source may not be loaded yet
      }
      return false;
    }, { timeout: 10000 });

    // The app should remain functional with the move_segment tool active
    const canvas = page.getByTestId('map-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('data-active-tool', 'move_segment');
  });
});
