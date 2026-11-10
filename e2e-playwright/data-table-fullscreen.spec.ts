import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
  openDebugFromMenu,
  type SectionSeed,
} from './helpers/app';

/** Full-screen DATA navigation, keyboard guards and read-only database inspection. */

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Fullscreen Test Section',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 45, length: 10, depth_in: 0, depth_out: -1 },
      { azimuth_in: 90, azimuth_out: 90, length: 20, depth_in: -1, depth_out: -2 },
      { azimuth_in: 135, azimuth_out: 135, length: 30, depth_in: -2, depth_out: -3 },
    ],
  },
];

async function getIsDirty(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const e2e = (window as any).__E2E_TEST__;
    return e2e.projectStore.getState().isDirty as boolean;
  });
}

async function getActiveTool(page: Page): Promise<string> {
  return page.evaluate(() => {
    const e2e = (window as any).__E2E_TEST__;
    return e2e.uiStore.getState().activeTool as string;
  });
}

/** Open the DataTable via keyboard shortcut (auto-selects the first section). */
async function openDataTable(page: Page): Promise<void> {
  await page.keyboard.press('Control+3');
  await expect(page.getByTestId('data-table')).toBeVisible({ timeout: 3000 });
  await expect(page.getByTestId('grid-row-0')).toBeVisible({ timeout: 5000 });
}

/** Click the sub-header expand button and wait for the fullscreen overlay. */
async function enterFullScreen(page: Page): Promise<void> {
  await page.getByTestId('data-table-expand-button').click();
  await expect(page.getByTestId('data-table')).toHaveAttribute('data-fullscreen', 'true');
  await expect(page.getByTestId('mode-data')).toHaveAttribute('aria-pressed', 'true');
}

/** Assert the table is back to its windowed (non-fullscreen) state and open. */
async function expectWindowed(page: Page): Promise<void> {
  await expect(page.getByTestId('data-table')).toHaveAttribute('data-fullscreen', 'false');
  // The Dock only mounts the table when the panel is revealed, so its presence
  // == open (the table no longer carries a redundant data-open attribute).
  await expect(page.getByTestId('data-table')).toBeVisible();
  await expect(page.getByTestId('mode-survey')).toHaveAttribute('aria-pressed', 'true');
}

/** Double-click a cell, type a value, commit with Enter. */
async function fillCell(page: Page, row: number, colKey: string, value: string): Promise<void> {
  await page.getByTestId(`grid-cell-${row}-${colKey}`).dblclick();
  const editor = page.getByTestId('grid-cell-editor');
  await expect(editor).toBeVisible();
  await editor.fill(value);
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
}

test.describe('Data table fullscreen mode', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Fullscreen Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await waitForNoDialogs(page);
    await openDataTable(page);
  });

  test('expand button enters; Map view button and Escape exit', async ({ page }) => {
    await expect(page.getByTestId('data-table')).toHaveAttribute('data-fullscreen', 'false');

    await enterFullScreen(page);
    // The grid keeps rendering inside the overlay; the windowed-only chrome
    // (expand button, collapse chevron) is hidden while fullscreen.
    await expect(page.getByTestId('grid-row-0')).toBeVisible();
    await expect(page.getByTestId('data-table-expand-button')).toHaveCount(0);
    // Fullscreen renders no opener tab, so the windowed close/collapse control is gone.
    await expect(page.getByTestId('panel-close-data')).toHaveCount(0);

    // Shrink back via the toolbar's "Map view" button.
    await page.getByTestId('toolbar-map-view-button').click();
    await expectWindowed(page);
    await expect(page.getByTestId('data-table-expand-button')).toBeVisible();
    // Back in the windowed (pinned-open) table, the collapse control returns.
    await expect(page.getByTestId('panel-close-data')).toBeVisible();

    // Re-enter, exit via Escape.
    await enterFullScreen(page);
    await page.keyboard.press('Escape');
    await expectWindowed(page);
  });

  test('Escape closes an open dialog before exiting fullscreen', async ({ page }) => {
    await enterFullScreen(page);

    // Open a dialog (Debug Logs, via the hamburger's Debug submenu, which stays
    // in the reduced toolbar) to verify Escape closes it before exiting fullscreen.
    await openDebugFromMenu(page);
    await expect(page.getByTestId('debug-dialog')).toBeVisible();

    // First Escape closes the dialog and stays fullscreen.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('debug-dialog')).toHaveCount(0);
    await expect(page.getByTestId('data-table')).toHaveAttribute('data-fullscreen', 'true');

    // Second Escape exits the mode.
    await page.keyboard.press('Escape');
    await expectWindowed(page);
  });

  test('toggle_data_table shortcut exits fullscreen but keeps the table open', async ({ page }) => {
    await enterFullScreen(page);

    // The toggle action exits the mode instead of closing the table.
    await page.keyboard.press('Control+3');
    await expectWindowed(page);

    // Outside fullscreen the same shortcut toggles the table again - closing
    // unmounts the DataTable in favor of the closed-state opener tab.
    await page.keyboard.press('Control+3');
    await expect(page.getByTestId('panel-tab-data')).toBeVisible();
    await expect(page.getByTestId('data-table')).toHaveCount(0);
  });

  test('reduced toolbar: tools give way to the table picker, Import button drops out', async ({ page }) => {
    await enterFullScreen(page);

    // The workspace carousel remains reachable in DATA.
    await expect(page.getByTestId('mode-data')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mode-carousel')).toBeVisible();

    // Map controls are hidden; the table picker lives inside DATA.
    await expect(page.getByTestId('toolbar-tools-group')).toHaveCount(0);
    await expect(page.getByTestId('display-menu-button')).toHaveCount(0);
    await expect(page.getByTestId('project-data-view')).toBeVisible();

    // The hamburger menu (Save/Export/Close/Debug live there) stays; the Import
    // button is replaced by the "Back to Map" button; Undo/Redo stay.
    await expect(page.getByTestId('app-menu-trigger')).toBeVisible();
    await expect(page.getByTestId('toolbar-undo-button')).toBeVisible();
    await expect(page.getByTestId('toolbar-redo-button')).toBeVisible();
    await expect(page.getByTestId('toolbar-import-button')).toHaveCount(0);
    // The "Back to Map" button lives on the left, in place of Import.
    await expect(page.getByTestId('toolbar-map-view-button')).toHaveText('Back to Map');
    await expect(
      page.getByTestId('toolbar-file-controls').getByTestId('toolbar-map-view-button'),
    ).toBeVisible();

    // Exiting restores the normal toolbar.
    await page.keyboard.press('Escape');
    await expectWindowed(page);
    await expect(page.getByTestId('toolbar-tools-group')).toBeVisible();
    await expect(page.getByTestId('display-menu-button')).toBeVisible();
    await expect(page.getByTestId('project-data-view')).toHaveCount(0);
    await expect(page.getByTestId('toolbar-map-view-button')).toHaveCount(0);
    await expect(page.getByTestId('app-menu-trigger')).toBeVisible();
    await expect(page.getByTestId('toolbar-import-button')).toBeEnabled();
  });

  test('blocks tool and import/export shortcuts but keeps save/undo alive', async ({ page }) => {
    await enterFullScreen(page);

    // Tool shortcuts are dead: M (merge) must not switch the active tool.
    // Deliberately not P: the pan tool is hidden by default (#409) and its
    // shortcut is inert everywhere, so a P probe would pass vacuously whether
    // or not fullscreen blocked anything.
    expect(await getActiveTool(page)).toBe('select');
    await page.keyboard.press('m');
    expect(await getActiveTool(page)).toBe('select');

    // Ctrl+I (import) and Ctrl+E (export) are dead: no dialog appears and
    // the mode stays active.
    await page.keyboard.press('Control+i');
    await expect(page.getByTestId('dmp-selection-dialog')).toHaveCount(0);
    await page.keyboard.press('Control+e');
    await expect(page.getByTestId('export-dialog')).toHaveCount(0);
    await expect(page.getByTestId('data-table')).toHaveAttribute('data-fullscreen', 'true');

    // The fullscreen Sections view stays editable - dirty the project.
    await fillCell(page, 0, 'length', '42');
    await expect.poll(() => getIsDirty(page)).toBe(true);

    // Ctrl+S is alive: the save clears the dirty flag.
    await page.keyboard.press('Control+s');
    await expect.poll(() => getIsDirty(page)).toBe(false);

    // Ctrl+Z is alive: a successful undo re-dirties the project.
    await page.keyboard.press('Control+z');
    await expect.poll(() => getIsDirty(page)).toBe(true);

    // Sanity for the dead-key assertions above: outside fullscreen the same
    // tool shortcut works.
    await page.keyboard.press('Escape');
    await expectWindowed(page);
    // Click a neutral, non-input toolbar element to move focus off the table so the
    // 'm' shortcut fires. The Survey carousel button is a no-op while already in Survey.
    await page.getByTestId('mode-survey').click();
    await page.keyboard.press('m');
    await expect.poll(() => getActiveTool(page)).toBe('merge');
  });

  test('centered table tabs edit section metadata and color without internal IDs or inspector', async ({ page }) => {
    await enterFullScreen(page);
    const tabs = page.getByTestId('project-data-view');
    const bounds = await tabs.boundingBox();
    expect(Math.abs(bounds!.x + bounds!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(1);
    await page.getByTestId('project-data-view-sections').click();
    await expect(page.getByTestId('grid-cell-0-id')).toHaveCount(0);
    await expect(page.getByTestId('grid-cell-0-explorer')).toBeVisible();
    await expect(page.getByTestId('grid-cell-0-surveyor')).toBeVisible();
    await fillCell(page, 0, 'explorer', 'Synthetic explorer');
    await expect(page.getByTestId('grid-cell-0-explorer')).toHaveText('Synthetic explorer');
    const color = page.getByTestId('data-section-color-1');
    await expect(color).toHaveAttribute('type', 'color');
    await color.evaluate((element: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '#123456');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.getByTestId('grid-cell-0-color')).toContainText('#123456');
    await expect(page.getByText('Database inspection (read-only)', { exact: true })).toHaveCount(0);
    await page.getByTestId('project-data-view-shots').click();
    await expect(page.getByTestId('grid-cell-0-length')).toBeVisible();
  });
});
