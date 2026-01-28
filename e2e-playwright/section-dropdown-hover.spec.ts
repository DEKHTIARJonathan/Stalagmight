/**
 * E2E tests for section dropdown hover highlighting.
 *
 * Tests verify that hovering or keyboard-navigating options in the DataTable
 * section Select dropdown highlights the corresponding section on the map
 * via `hoveredSectionId` in uiStore, and that all close paths clear the highlight.
 *
 * The Select component fires `onOptionHover(value)` on mouse enter and keyboard
 * navigation, and `onOptionHover(null)` on every close path. DataTable converts
 * the string value to a section ID and calls `setHoveredSectionId`.
 */

import { test, expect, Page, Locator } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapIdle,
  waitForNoDialogs,
  type SectionSeed,
} from './helpers/app';

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Alpha Passage',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 270, length: 12, depth_in: -3, depth_out: -6 },
    ],
  },
  {
    name: 'Beta Tunnel',
    direction: 'out',
    shots: [
      { azimuth_in: 180, azimuth_out: 0, length: 7, depth_in: -2, depth_out: -4 },
    ],
  },
  {
    name: 'Gamma Gallery',
    direction: 'in',
    shots: [
      { azimuth_in: 270, azimuth_out: 90, length: 5, depth_in: -1, depth_out: -2 },
      { azimuth_in: 300, azimuth_out: 120, length: 8, depth_in: -2, depth_out: -5 },
      { azimuth_in: 330, azimuth_out: 150, length: 6, depth_in: -5, depth_out: -7 },
    ],
  },
];

/**
 * Setup: create project with sections for all tests.
 */
async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Dropdown Hover Test');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
}

/**
 * Open the DataTable via Ctrl+3.
 */
async function openDataTable(page: Page): Promise<void> {
  await page.keyboard.press('Control+3');
  await expect(page.getByTestId('data-table')).toBeVisible({ timeout: 3000 });
}

/**
 * Get the section select trigger button.
 */
function getSectionSelectTrigger(page: Page): Locator {
  const sectionSelect = page.getByTestId('data-table-section-select');
  return sectionSelect.locator('button').first();
}

/**
 * Get the portaled Select listbox from a trigger using aria-controls.
 */
async function getSelectListbox(page: Page, trigger: Locator): Promise<Locator> {
  await expect(trigger).toHaveAttribute('aria-controls', /.+/);
  const listboxId = await trigger.getAttribute('aria-controls');
  return page.locator(`[id="${listboxId}"]`);
}

/**
 * Get the current hoveredSectionId from uiStore.
 */
async function getHoveredSectionId(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { hoveredSectionId: number | null } };
      };
    }).__E2E_TEST__;
    return stores?.uiStore.getState().hoveredSectionId ?? null;
  });
}

/**
 * Poll for hoveredSectionId to satisfy a predicate.
 */
async function pollHoveredSectionId(
  page: Page,
  predicate: (id: number | null) => boolean,
  timeout = 5000,
): Promise<number | null> {
  let result: number | null = null;
  await expect.poll(
    async () => {
      const id = await getHoveredSectionId(page);
      if (predicate(id)) {
        result = id;
        return true;
      }
      return false;
    },
    { timeout },
  ).toBe(true);
  return result;
}

/**
 * Get section ID by name from the project store.
 */
async function getSectionIdByName(page: Page, name: string): Promise<number> {
  const id = await page.evaluate((sectionName) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => { project: { sections: Array<{ id: number; name: string }> } | null };
        };
      };
    }).__E2E_TEST__;
    const section = stores?.projectStore.getState().project?.sections.find(s => s.name === sectionName);
    return section?.id ?? -1;
  }, name);
  expect(id).toBeGreaterThan(0);
  return id;
}

/**
 * Open dropdown and hover an option by text, returning its section ID.
 * Helper used by multiple close-path tests.
 */
async function openDropdownAndHoverOption(
  page: Page,
  trigger: Locator,
  optionText: string,
): Promise<{ listbox: Locator; sectionId: number }> {
  // Open dropdown
  await trigger.click();
  const listbox = await getSelectListbox(page, trigger);
  await expect(listbox).toBeVisible();

  // Hover an option via mouse
  const option = listbox.locator(`[role="option"]:has-text("${optionText}")`);
  await expect(option).toBeVisible();
  await option.hover();

  // Get the section ID
  const sectionId = await getSectionIdByName(page, optionText);

  // Wait for hover state
  await pollHoveredSectionId(page, (id) => id === sectionId);

  return { listbox, sectionId };
}

test.describe('section dropdown hover highlighting', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProjectWithSections(page);
    await openDataTable(page);
  });

  test('mouse hover on option sets hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    await trigger.click();
    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Hover "Beta Tunnel" option
    const betaOption = listbox.locator('[role="option"]:has-text("Beta Tunnel")');
    await expect(betaOption).toBeVisible();
    await betaOption.hover();

    const betaId = await getSectionIdByName(page, 'Beta Tunnel');
    const hoveredId = await pollHoveredSectionId(page, (id) => id === betaId);
    expect(hoveredId).toBe(betaId);
  });

  test('ArrowDown keyboard nav updates hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    await trigger.focus();

    // Open dropdown with ArrowDown (highlights current selection = Alpha Passage at index 0)
    await page.keyboard.press('ArrowDown');
    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    const alphaId = await getSectionIdByName(page, 'Alpha Passage');

    // Initial highlight should be on Alpha Passage (currently selected value)
    await pollHoveredSectionId(page, (id) => id === alphaId);

    // Press ArrowDown to move to Beta Tunnel
    await page.keyboard.press('ArrowDown');
    const betaId = await getSectionIdByName(page, 'Beta Tunnel');
    const hoveredId = await pollHoveredSectionId(page, (id) => id === betaId);
    expect(hoveredId).toBe(betaId);
  });

  test('ArrowUp keyboard nav updates hoveredSectionId to previous option', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);

    const alphaId = await getSectionIdByName(page, 'Alpha Passage');
    const betaId = await getSectionIdByName(page, 'Beta Tunnel');

    // Open dropdown via mouse hover on Beta, then switch to keyboard for ArrowUp.
    // Using mouse hover avoids keyboard state-batching issues under load.
    await trigger.click();
    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Mouse hover on Beta Tunnel to position highlight at index 1
    const betaOption = listbox.locator('[role="option"]:has-text("Beta Tunnel")');
    await betaOption.hover();
    await pollHoveredSectionId(page, (id) => id === betaId);

    // Press ArrowUp from Beta (index 1) — should go to Alpha (index 0)
    // Re-dispatch keyboard event on the trigger element directly
    await page.evaluate(() => {
      const trigger = document.querySelector('[data-testid="data-table-section-select"] button');
      if (trigger) {
        trigger.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
          cancelable: true,
        }));
      }
    });

    const hoveredId = await pollHoveredSectionId(page, (id) => id === alphaId);
    expect(hoveredId).toBe(alphaId);
  });

  test('Home key jumps to first option and updates hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    await trigger.focus();

    // Open dropdown and navigate to last option
    await page.keyboard.press('ArrowDown');
    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Go to last with End
    await page.keyboard.press('End');
    const gammaId = await getSectionIdByName(page, 'Gamma Gallery');
    await pollHoveredSectionId(page, (id) => id === gammaId);

    // Press Home to jump to first
    await page.keyboard.press('Home');
    const alphaId = await getSectionIdByName(page, 'Alpha Passage');
    const hoveredId = await pollHoveredSectionId(page, (id) => id === alphaId);
    expect(hoveredId).toBe(alphaId);
  });

  test('End key jumps to last option and updates hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    await trigger.focus();

    // Open dropdown
    await page.keyboard.press('ArrowDown');
    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Press End to jump to last option (Gamma Gallery)
    await page.keyboard.press('End');
    const gammaId = await getSectionIdByName(page, 'Gamma Gallery');
    const hoveredId = await pollHoveredSectionId(page, (id) => id === gammaId);
    expect(hoveredId).toBe(gammaId);
  });

  test('Escape closes dropdown and clears hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    const { listbox } = await openDropdownAndHoverOption(page, trigger, 'Beta Tunnel');

    // Verify highlight is set
    const betaId = await getSectionIdByName(page, 'Beta Tunnel');
    expect(await getHoveredSectionId(page)).toBe(betaId);

    // Press Escape
    await page.keyboard.press('Escape');

    // Dropdown closes
    await expect(listbox).not.toBeVisible({ timeout: 2000 });

    // hoveredSectionId cleared
    const clearedId = await pollHoveredSectionId(page, (id) => id === null);
    expect(clearedId).toBeNull();
  });

  test('click outside closes dropdown and clears hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    const { listbox } = await openDropdownAndHoverOption(page, trigger, 'Beta Tunnel');

    // Click outside the dropdown (on map canvas)
    await page.getByTestId('map-canvas').dispatchEvent('mousedown');

    // Dropdown closes
    await expect(listbox).not.toBeVisible({ timeout: 2000 });

    // hoveredSectionId cleared
    const clearedId = await pollHoveredSectionId(page, (id) => id === null);
    expect(clearedId).toBeNull();
  });

  test('selecting an option clears hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    await trigger.click();
    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Hover Beta Tunnel
    const betaOption = listbox.locator('[role="option"]:has-text("Beta Tunnel")');
    await betaOption.hover();

    const betaId = await getSectionIdByName(page, 'Beta Tunnel');
    await pollHoveredSectionId(page, (id) => id === betaId);

    // Click to select it
    await betaOption.click();

    // Dropdown closes
    await expect(listbox).not.toBeVisible({ timeout: 2000 });

    // hoveredSectionId cleared
    const clearedId = await pollHoveredSectionId(page, (id) => id === null);
    expect(clearedId).toBeNull();
  });

  test('Tab closes dropdown and clears hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    const { listbox } = await openDropdownAndHoverOption(page, trigger, 'Beta Tunnel');

    // Focus trigger to send Tab key (hover moved pointer but trigger keeps focus after click-open)
    await trigger.focus();

    // Press Tab
    await page.keyboard.press('Tab');

    // Dropdown closes
    await expect(listbox).not.toBeVisible({ timeout: 2000 });

    // hoveredSectionId cleared
    const clearedId = await pollHoveredSectionId(page, (id) => id === null);
    expect(clearedId).toBeNull();
  });

  test('trigger-toggle-to-close clears hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    const { listbox } = await openDropdownAndHoverOption(page, trigger, 'Beta Tunnel');

    // Click trigger button again to close (toggle)
    await trigger.click();

    // Dropdown closes
    await expect(listbox).not.toBeVisible({ timeout: 2000 });

    // hoveredSectionId cleared
    const clearedId = await pollHoveredSectionId(page, (id) => id === null);
    expect(clearedId).toBeNull();
  });

  test('external scroll closes dropdown and clears hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    const { listbox } = await openDropdownAndHoverOption(page, trigger, 'Beta Tunnel');

    // Dispatch scroll on window (external scroll, not inside dropdown)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    // Dropdown closes
    await expect(listbox).not.toBeVisible({ timeout: 2000 });

    // hoveredSectionId cleared
    const clearedId = await pollHoveredSectionId(page, (id) => id === null);
    expect(clearedId).toBeNull();
  });

  test('window resize closes dropdown and clears hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    const { listbox } = await openDropdownAndHoverOption(page, trigger, 'Beta Tunnel');

    // Dispatch resize on window
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
    });

    // Dropdown closes
    await expect(listbox).not.toBeVisible({ timeout: 2000 });

    // hoveredSectionId cleared
    const clearedId = await pollHoveredSectionId(page, (id) => id === null);
    expect(clearedId).toBeNull();
  });

  test('component unmount clears hoveredSectionId', async ({ page }) => {
    const trigger = getSectionSelectTrigger(page);
    await trigger.click();
    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Hover Beta Tunnel option
    const betaOption = listbox.locator('[role="option"]:has-text("Beta Tunnel")');
    await betaOption.hover();

    const betaId = await getSectionIdByName(page, 'Beta Tunnel');
    await pollHoveredSectionId(page, (id) => id === betaId);

    // Collapse the DataTable via Ctrl+3, which unmounts the Select component.
    // Select's useEffect cleanup fires onOptionHover(null) when open.
    await page.keyboard.press('Control+3');

    // The Select is unmounted — hoveredSectionId should be cleared
    const clearedId = await pollHoveredSectionId(page, (id) => id === null);
    expect(clearedId).toBeNull();
  });
});
