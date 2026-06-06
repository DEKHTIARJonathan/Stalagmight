import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, waitForMapReady, createProject, type SectionSeed } from './helpers/app';

/**
 * E2E tests for Syntactic Highlighting: the colored duotone toolbar, the
 * removal of the draw/delete tools, the Full-mode entity blobs, and the
 * settings panel (level / preset / per-color overrides) with live preview.
 */

const seeds: SectionSeed[] = [
  {
    name: 'SH Main',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10.5, depth_in: -2, depth_out: -2.5, left: 1.5, right: 2.3, up: 3.0, down: 0.8 },
      { azimuth_in: 90, azimuth_out: 270, length: 15.2, depth_in: -2.5, depth_out: -5.0, left: 0.5, right: 0.7, up: 1.2, down: 1.5 },
    ],
  },
];

function shLevel(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset.shLevel);
}

function shVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

function activeTool(page: Page): Promise<string> {
  return page.evaluate(() => {
    const e2e = (window as unknown as { __E2E_TEST__: { uiStore: { getState: () => { activeTool: string } } } }).__E2E_TEST__;
    return e2e.uiStore.getState().activeTool;
  });
}

async function openSyntacticSettings(page: Page): Promise<void> {
  // The highlighting controls live in the Appearance settings tab.
  await page.evaluate(() => {
    const e2e = (window as unknown as { __E2E_TEST__: { uiStore: { getState: () => { openDialog: (d: string) => void } } } }).__E2E_TEST__;
    e2e.uiStore.getState().openDialog('settings');
  });
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('settings-tab-appearance').click();
  await expect(page.getByTestId('settings-panel-appearance')).toBeVisible();
  await expect(page.getByTestId('settings-syntactic')).toBeVisible();
}

async function pickOption(page: Page, selectTestId: string, optionName: string): Promise<void> {
  await page.getByTestId(selectTestId).click();
  await page.getByRole('option', { name: optionName }).click();
}

test.describe('Syntactic Highlighting', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'SH Test');
    await seedProjectWithSections(page, seeds);
    await waitForMapReady(page);
  });

  test('toolbar omits draw/delete and renders duotone icons; D/X are unbound @smoke', async ({ page }) => {
    await expect(page.getByTestId('tool-draw')).toHaveCount(0);
    await expect(page.getByTestId('tool-delete')).toHaveCount(0);
    await expect(page.getByTestId('tool-select')).toBeVisible();
    await expect(page.getByTestId('tool-merge')).toBeVisible();

    // Duotone glyphs are present in the toolbar.
    await expect(page.locator('[data-testid="toolbar-tools-group"] svg.duotone').first()).toBeVisible();

    // Tool buttons have a per-tool tinted background ("back-color"), not the
    // default transparent ghost background.
    const selectBg = await page
      .getByTestId('tool-select')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(selectBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(selectBg).not.toBe('transparent');

    // Pressing the old draw/delete shortcuts does nothing.
    await page.getByTestId('tool-select').click();
    await page.keyboard.press('d');
    await page.keyboard.press('x');
    const tool = await activeTool(page);
    expect(['draw', 'delete']).not.toContain(tool);
  });

  test('default highlighting level is Full', async ({ page }) => {
    await expect.poll(() => shLevel(page)).toBe('full');
  });

  test('settings: changing Level live-previews data-sh-level', async ({ page }) => {
    await openSyntacticSettings(page);

    await pickOption(page, 'select-syntactic-level', 'Off');
    await expect.poll(() => shLevel(page)).toBe('off');

    await pickOption(page, 'select-syntactic-level', 'Toolbar only');
    await expect.poll(() => shLevel(page)).toBe('toolbar_only');

    await pickOption(page, 'select-syntactic-level', 'Full');
    await expect.poll(() => shLevel(page)).toBe('full');
  });

  test('settings: changing preset repaints role colors', async ({ page }) => {
    const before = await shVar(page, '--sh-station'); // default green
    await openSyntacticSettings(page);
    await pickOption(page, 'select-syntactic-preset', 'Deuteranopia');
    await expect.poll(() => shVar(page, '--sh-station')).not.toBe(before);
  });

  test('settings: per-color override applies and resets', async ({ page }) => {
    await openSyntacticSettings(page);

    const input = page.getByTestId('input-syntactic-color-shot');
    await input.evaluate((el) => {
      const i = el as HTMLInputElement;
      // Use React's native value setter so its onChange fires (a plain
      // assignment is swallowed by React's input value tracker).
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(i, '#123456');
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(() => shVar(page, '--sh-shot')).toBe('#123456');

    // Per-row reset returns to the preset base color.
    await page.getByTestId('setting-syntactic-color-shot-reset').click();
    await expect.poll(() => shVar(page, '--sh-shot')).not.toBe('#123456');
  });

  test('Full mode shows entity blobs in the data table; Off hides them', async ({ page }) => {
    // Select the first section and open the data table.
    await page.evaluate(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__: { uiStore: { getState: () => { setSelection: (s: unknown) => void } } };
      }).__E2E_TEST__;
      e2e.uiStore.getState().setSelection({ type: 'section', sectionId: 0 });
    });
    await page.keyboard.press('Control+3');
    await expect(page.getByTestId('data-table')).toBeVisible();

    // Full (default): entity blobs render.
    await expect(page.locator('[data-entity]').first()).toBeVisible({ timeout: 5000 });

    // Switch to Off via the store preview: blobs disappear.
    await page.evaluate(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__: { uiStore: { getState: () => { setSyntacticHighlightPreview: (c: unknown) => void } } };
      }).__E2E_TEST__;
      e2e.uiStore.getState().setSyntacticHighlightPreview({ level: 'off', preset: 'default', overrides: {} });
    });
    await expect(page.locator('[data-entity]')).toHaveCount(0);
  });
});
