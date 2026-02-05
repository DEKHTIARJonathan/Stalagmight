import { test, expect, Page, Locator } from './fixtures/coverage';
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

async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Select Dropdown Test Project');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
}

async function openDataTable(page: Page): Promise<void> {
  await page.keyboard.press('Control+3');
  await expect(page.getByTestId('data-table')).toBeVisible({ timeout: 3000 });
}

async function pressUntilActiveDescendant(
  page: Page,
  trigger: Locator,
  key: string,
  expectedId: string,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press(key);
    const active = await trigger.getAttribute('aria-activedescendant');
    if (active === expectedId) {
      return;
    }
    await page.waitForTimeout(25);
  }
  await expect.poll(async () => trigger.getAttribute('aria-activedescendant')).toBe(expectedId);
}

/**
 * Get the portaled Select listbox from a trigger button using aria-controls.
 * Waits for the attribute to be set (React state update) before reading it.
 * This avoids ambiguity with other listbox elements on the page
 * (e.g. the sections panel listbox).
 */
async function getSelectListbox(page: Page, trigger: Locator): Promise<Locator> {
  // Wait for aria-controls to be set (React may need a render cycle after open)
  await expect(trigger).toHaveAttribute('aria-controls', /.+/);
  const listboxId = await trigger.getAttribute('aria-controls');
  // Use attribute selector to avoid CSS escaping issues with React useId() colons
  return page.locator(`[id="${listboxId}"]`);
}

test.describe('Select Dropdown (Portal)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProjectWithSections(page);
  });

  test('dropdown visible above sticky header (z-order proof)', async ({ page }) => {
    // Open data table to get a sticky header context
    await openDataTable(page);

    // Open the section selector dropdown
    const sectionSelect = page.getByTestId('data-table-section-select');
    await expect(sectionSelect).toBeVisible();
    const trigger = sectionSelect.locator('button').first();
    await trigger.click();

    // Verify the listbox is visible via aria-controls
    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Get the bounding box of an option in the dropdown
    const firstOption = listbox.locator('[role="option"]').first();
    await expect(firstOption).toBeVisible();
    const optionBox = await firstOption.boundingBox();
    expect(optionBox).not.toBeNull();

    // Use elementFromPoint at the center of the option to verify it's the topmost element,
    // not hidden behind a sticky header
    const isOptionTopmost = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      return el.closest('[role="listbox"]') !== null || el.closest('[role="option"]') !== null;
    }, {
      x: optionBox!.x + optionBox!.width / 2,
      y: optionBox!.y + optionBox!.height / 2,
    });

    expect(isOptionTopmost).toBe(true);
  });

  test('dropdown closes on external scroll', async ({ page }) => {
    // Open data table
    await openDataTable(page);

    // Open the section selector dropdown
    const sectionSelect = page.getByTestId('data-table-section-select');
    const trigger = sectionSelect.locator('button').first();
    await trigger.click();

    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Dispatch scroll on window (Select listens via window.addEventListener('scroll', ..., { capture: true }))
    await page.evaluate(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    // Dropdown should close
    await expect(listbox).not.toBeVisible({ timeout: 2000 });
  });

  test('keyboard navigation works (ArrowDown/Up, Enter, Escape)', async ({ page }) => {
    // Open data table
    await openDataTable(page);

    // Focus the section selector trigger
    const sectionSelect = page.getByTestId('data-table-section-select');
    const trigger = sectionSelect.locator('button').first();
    await trigger.focus();
    await expect(trigger).toBeFocused();

    // Open dropdown via ArrowDown (highlights the current selection)
    await page.keyboard.press('ArrowDown');
    let listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // Verify aria-activedescendant is set on the trigger (wait for React state update)
    await expect(trigger).toHaveAttribute('aria-activedescendant', /.+/);

    const initialActive = await trigger.getAttribute('aria-activedescendant');
    if (!initialActive) {
      throw new Error('Expected aria-activedescendant to be set on the trigger.');
    }

    const options = listbox.locator('[role="option"]');
    await expect(options).toHaveCount(2);
    const sideOption = options.nth(1);
    const sideOptionId = await sideOption.getAttribute('id');
    if (!sideOptionId) {
      throw new Error('Expected Side Tunnel option to have an id for aria-activedescendant.');
    }

    // ArrowDown should move to Side Tunnel
    await pressUntilActiveDescendant(page, trigger, 'ArrowDown', sideOptionId);

    // ArrowUp should return to initial item
    await pressUntilActiveDescendant(page, trigger, 'ArrowUp', initialActive);

    // Move back to Side Tunnel and select with Enter
    await pressUntilActiveDescendant(page, trigger, 'ArrowDown', sideOptionId);
    await page.keyboard.press('Enter');

    // Dropdown should close after selection
    await expect(listbox).not.toBeVisible({ timeout: 2000 });

    // Verify the selected value changed
    await expect(trigger).toContainText('Side Tunnel');

    // Re-open and close with Escape
    await expect(trigger).toBeFocused();
    await page.keyboard.press('ArrowDown');
    listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(listbox).not.toBeVisible({ timeout: 2000 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('internal scroll does not close dropdown', async ({ page }) => {
    // Open data table
    await openDataTable(page);

    // Open the section selector dropdown
    const sectionSelect = page.getByTestId('data-table-section-select');
    const trigger = sectionSelect.locator('button').first();
    await trigger.click();

    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Dispatch a scroll event originating from inside the listbox.
    // Select.tsx ignores scroll events where event.target is inside dropdownRef
    // (covers user scrolling through options and scrollIntoView from keyboard nav).
    await listbox.evaluate((el) => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    // Dropdown should remain open -- internal scroll is not treated as external
    await expect(listbox).toBeVisible();

    // Verify we can still interact with the dropdown (select an option)
    const firstOption = listbox.locator('[role="option"]').first();
    await expect(firstOption).toBeVisible();
  });

  test('click outside closes dropdown', async ({ page }) => {
    // Open data table
    await openDataTable(page);

    // Open the section selector dropdown
    const sectionSelect = page.getByTestId('data-table-section-select');
    const trigger = sectionSelect.locator('button').first();
    await trigger.click();

    const listbox = await getSelectListbox(page, trigger);
    await expect(listbox).toBeVisible();

    // Click elsewhere on the page (outside the dropdown and trigger)
    // Use mousedown on a known element to avoid hitting the dropdown
    await page.getByTestId('map-canvas').dispatchEvent('mousedown');

    // Dropdown should close
    await expect(listbox).not.toBeVisible({ timeout: 2000 });
  });
});
