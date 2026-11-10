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
