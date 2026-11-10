import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject, seedProjectWithSections, waitForMapReady } from './helpers/app';

test('DATA edits live shots and returns to Survey', async ({ page }) => {
  await setupMockedPage(page);
  await page.goto('/');
  await createProject(page, 'Synthetic DATA project');
  await seedProjectWithSections(page, [{ name: 'Synthetic section', shots: [
    { length: 10, azimuth_in: 90, azimuth_out: 90, depth_in: 0, depth_out: 1 },
  ] }]);
  await waitForMapReady(page);
  await page.getByTestId('mode-data').click();
  await expect(page.getByTestId('mode-data')).toHaveAttribute('aria-pressed', 'true');
  const table = page.getByTestId('project-data-table');
  await table.getByTestId('grid-cell-0-length').dblclick();
  const editor = table.getByTestId('grid-cell-editor');
  await editor.fill('12');
  await editor.press('Enter');
  await expect(table.getByTestId('grid-cell-0-length')).toContainText('12');
  await page.getByTestId('mode-survey').click();
  await expect(page.getByTestId('mode-survey')).toHaveAttribute('aria-pressed', 'true');
  await expect(table).toHaveCount(0);
  await page.keyboard.press('Control+3');
  const shotId = await page.evaluate(() => (window as any).__E2E_TEST__.projectStore.getState().project.sections[0].shots[0].id as number);
  await expect(page.getByTestId('grid-cell-0-shot_id')).toHaveText('1');
  await expect(page.getByTestId(`shot-row-1-${shotId}`)).toHaveText('1');
  await page.getByTestId('data-table-columns-menu').click();
  await expect(page.getByTestId('col-vis-section_id')).toHaveCount(0);

});

test('DATA creates an empty section without map placement', async ({ page }) => {
  await setupMockedPage(page);
  await page.goto('/');
  await createProject(page, 'Synthetic DATA project');
  await page.getByTestId('mode-data').click();
  await page.getByTestId('data-create-section').click();
  await page.getByTestId('section-name-input').fill('Synthetic new section');
  await page.getByTestId('data-save-section').click();
  await expect(page.getByTestId('section-name-input')).toHaveCount(0);
  await expect(page.getByTestId('data-section--1')).toContainText('Synthetic new section');
  await expect(page.getByTestId('mode-data')).toHaveAttribute('aria-pressed', 'true');
});

test('DATA section dropdown moves a shot and creates a destination on save', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Synthetic transfer project');
  await seedProjectWithSections(page, [
    { name: 'Source', shots: [{ length: 10, azimuth_in: 90, azimuth_out: 90, depth_in: 0, depth_out: 1 }] },
    { name: 'Destination', shots: [] },
  ]);
  await page.getByTestId('mode-data').click();
  const picker = page.locator('[data-testid^="data-section-"]').first();
  await picker.click();
  await page.getByRole('option', { name: 'Destination', exact: true }).click();
  await expect(picker).toContainText('Destination');
  await picker.click();
  await page.getByRole('option', { name: 'Create a New Section', exact: true }).click();
  await page.getByTestId('section-name-input').fill('Created destination');
  await page.getByTestId('data-save-section').click();
  await expect(page.getByTestId('section-name-input')).toHaveCount(0);
  await expect(page.locator('[data-testid^="data-section-"]').first()).toContainText('Created destination');
});


test('Shot IDs start at one across sections and remain unchanged after a transfer', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Synthetic shot numbering');
  const measurement = { length: 10, azimuth_in: 90, azimuth_out: 90, depth_in: 0, depth_out: 1 };
  await seedProjectWithSections(page, [
    { name: 'First section', shots: [measurement, measurement] },
    { name: 'Second section', shots: [measurement] },
  ]);
  await page.getByTestId('mode-data').click();
  await expect(page.getByTestId('mode-data')).toHaveText('Data');
  for (let row = 0; row < 3; row++) {
    await expect(page.getByTestId(`grid-cell-${row}-shot_id`)).toHaveText(String(row + 1));
  }
  await page.locator('[data-testid^="data-section-"]').first().click();
  await page.getByRole('option', { name: 'Second section', exact: true }).click();
  for (const [row, number] of [2, 3, 1].entries()) {
    await expect(page.getByTestId(`grid-cell-${row}-shot_id`)).toHaveText(String(number));
  }
  await page.evaluate(async data => {
    const store = (window as any).__E2E_TEST__.projectStore.getState();
    const section = store.project.sections[0];
    await store.deleteShot(section.id, section.shots[0].id);
    await store.createShot(section.id, data);
  }, measurement);
  await expect(page.getByTestId('grid-cell-0-shot_id')).toHaveText('4');
  await expect(page.getByTestId('grid-cell-1-shot_id')).toHaveText('3');
  await expect(page.getByTestId('grid-cell-2-shot_id')).toHaveText('1');
});

test('Data columns and Section menu follow the requested layout and viewport margin', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Synthetic dropdown sizing');
  const longName = 'A sufficiently long section name that needs a wider dropdown';
  await seedProjectWithSections(page, [{ name: longName, shots: [
    { length: 10, azimuth_in: 90, azimuth_out: 90, depth_in: 0, depth_out: 1 },
  ] }]);
  await page.getByTestId('mode-data').click();
  const table = page.getByTestId('project-data-table');
  const keys = await table.locator('[data-testid^="grid-cell-0-"]').evaluateAll(cells => cells.map(cell => cell.getAttribute('data-testid')));
  expect(keys.slice(0, 3)).toEqual(['grid-cell-0-_warnings', 'grid-cell-0-shot_id', 'grid-cell-0-section']);
  await expect(table.getByTestId('grid-cell-0-marker_index')).toHaveCount(0);
  await expect(table.getByTestId('grid-cell-0-temperature')).toHaveCount(0);
  const picker = table.getByRole('combobox', { name: 'Section', exact: true }).first();
  await picker.click();
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option').first()).toHaveText('Create a New Section');
  const popup = await list.boundingBox();
  const trigger = await picker.boundingBox();
  expect(popup!.width).toBeGreaterThan(trigger!.width);
  expect(popup!.x + popup!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 100);
  const label = list.getByRole('option', { name: longName, exact: true }).locator('span').last();
  expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(list).not.toBeVisible();
  await page.evaluate(async () => {
    const store = (window as any).__E2E_TEST__.projectStore.getState();
    await store.updateSection(store.project.sections[0].id, { name: 'Very long section '.repeat(100) });
  });
  await picker.click();
  const capped = await page.getByRole('listbox').boundingBox();
  expect(capped!.x).toBeGreaterThanOrEqual(8);
  expect(capped!.x + capped!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 100);
  await expect(page.getByRole('listbox').getByRole('option').nth(1).locator('span').last()).toHaveCSS('white-space', 'nowrap');
  expect(await page.getByRole('listbox').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 640, height: 720 });
  await picker.click();
  const narrow = await page.getByRole('listbox').boundingBox();
  expect(narrow!.x).toBeGreaterThanOrEqual(8);
  expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(540);

});
