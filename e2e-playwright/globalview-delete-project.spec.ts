import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

/**
 * E2E for the destructive "Delete project" action (#118) — distinct from the
 * non-destructive "Remove from recent". Covers the GlobalView context-menu item,
 * its single-selection gating, and the confirm-dialog flow.
 *
 * The mocked `delete_project` (mocks/tauri-ipc.ts) just returns success, so these
 * assert the UI wiring; the recents-removal side effect is covered by the store
 * (vitest) and Rust tests.
 */

const ALPHA = '/projects/cave-alpha.stalx';
const BETA = '/projects/cave-beta.stalx';

async function switchToListTab(page: Page): Promise<void> {
  const listTab = page.getByTestId('globalview-view-toggle-list');
  await expect(listTab).toBeVisible();
  await listTab.click();
  await expect(page.getByTestId(`system-card-${ALPHA}`)).toBeVisible();
}

test.describe('GlobalView — Delete project (destructive)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await switchToListTab(page);
  });

  test('context menu offers Delete project as a distinct item from Remove from recent', async ({ page }) => {
    await page.getByTestId(`system-card-${ALPHA}`).click({ button: 'right' });
    await expect(page.getByTestId('project-context-menu')).toBeVisible();
    await expect(page.getByTestId('context-menu-remove')).toBeVisible();
    await expect(page.getByTestId('context-menu-delete')).toBeVisible();
  });

  test('Delete project opens a confirm dialog naming the project, and confirming deletes', async ({ page }) => {
    await page.getByTestId(`system-card-${ALPHA}`).click({ button: 'right' });
    await page.getByTestId('context-menu-delete').click();

    const dialog = page.getByTestId('delete-project-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Cave System Alpha');
    // Names the actual files being removed by full path (Alpha is collab-enabled
    // → .stalx + .tml) and is unambiguous about permanence.
    await expect(dialog).toContainText('/projects/cave-alpha.stalx and /projects/cave-alpha.tml');
    await expect(dialog).toContainText('It cannot be undone');

    await page.getByTestId('delete-project-confirm').click();
    // A successful delete closes the dialog.
    await expect(dialog).toBeHidden();
    // Other loadable projects are unaffected.
    await expect(page.getByTestId(`system-card-${BETA}`)).toBeVisible();
  });

  test('Cancel closes the dialog without deleting', async ({ page }) => {
    await page.getByTestId(`system-card-${ALPHA}`).click({ button: 'right' });
    await page.getByTestId('context-menu-delete').click();

    const dialog = page.getByTestId('delete-project-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`system-card-${ALPHA}`)).toBeVisible();
  });

  test('Delete project is hidden when multiple projects are selected', async ({ page }) => {
    const cardAlpha = page.getByTestId(`system-card-${ALPHA}`);
    const cardBeta = page.getByTestId(`system-card-${BETA}`);
    await cardAlpha.click();
    await cardBeta.click({ modifiers: ['ControlOrMeta'] });
    await cardAlpha.click({ button: 'right' });

    await expect(page.getByTestId('project-context-menu')).toBeVisible();
    // Multi-select keeps batch Remove + Merge, but the single-target Delete is gated out.
    await expect(page.getByTestId('context-menu-merge')).toBeVisible();
    await expect(page.getByTestId('context-menu-delete')).toHaveCount(0);
  });
});
