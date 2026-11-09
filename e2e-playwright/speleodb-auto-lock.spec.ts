import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

async function openRemote(page: Page, lockedByOther: boolean) {
  await setupMockedPage(page);
  await page.evaluate(async (contended) => {
    const w = window as unknown as {
      __MOCK_SET_PROJECT_IS_REMOTE__: (remote: boolean) => void;
      __MOCK_IPC_OVERRIDES__: Record<string, unknown>;
      __lockCalls: string[];
      __E2E_TEST__: {
        projectStore: { getState: () => { loadProject: (path: string) => Promise<unknown>; closeProject: () => Promise<unknown> } };
      };
    };
    w.__MOCK_SET_PROJECT_IS_REMOTE__(true);
    w.__lockCalls = [];
    let editing = false;
    const overrides: Record<string, unknown> = {
      speleodb_session: { logged_in: true, user_email: 'me@example.com', endpoint: 'https://example.com' },
      speleodb_project_access_at: { release_context: { project_id: 'remote', endpoint: 'https://example.com' } },
    };
    Object.defineProperty(overrides, 'speleodb_start_editing', { get: () => {
      w.__lockCalls.push('acquire');
      editing = !contended;
      return contended ? { kind: 'locked_by', email: 'editor@example.com' } : { kind: 'editing' };
    } });
    Object.defineProperty(overrides, 'speleodb_release_current_lock', { get: () => {
      w.__lockCalls.push('release'); editing = false; return null;
    } });
    Object.defineProperty(overrides, 'speleodb_link_status', { get: () => ({
      is_remote: true, edit_enabled: editing, force_editing: false,
      permission: 'READ_AND_WRITE', lock_holder: contended ? 'editor@example.com' : editing ? 'me@example.com' : null,
      has_unpushed_edits: false, unwound: false, remote_state: 'up_to_date',
      access_denied: false, server_error: null, exclude_geojson: false, undo_mode: 'full',
      allow_force_edit: false, project_id: 'remote',
    }) });
    w.__MOCK_IPC_OVERRIDES__ = overrides;
    await w.__E2E_TEST__.projectStore.getState().loadProject('/projects/cave-alpha.stalx');
  }, lockedByOther);
}

test('opening acquires silently; explicit menu release stays open and does not reacquire', async ({ page }) => {
  await openRemote(page, false);
  const status = page.getByTestId('speleodb-status-button');
  await expect(status).toHaveAttribute('data-kind', 'editing');
  await expect(page.getByTestId('speleodb-read-only-dialog')).toHaveCount(0);
  await status.click();
  await expect(page.getByTestId('speleodb-status-menu')).toBeVisible();
  await page.getByTestId('speleodb-menu-unlock').click();
  await expect(status).toHaveAttribute('data-kind', 'unlocked');
  await expect(page.getByTestId('single-system-view')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire', 'release']);
  await status.click();
  await page.getByTestId('speleodb-menu-lock').click();
  await expect(status).toHaveAttribute('data-kind', 'editing');
});

test('contended open shows one read-only modal naming the actual editor', async ({ page }) => {
  await openRemote(page, true);
  const notice = page.getByTestId('speleodb-read-only-dialog');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('editor@example.com is currently editing');
  await page.getByTestId('speleodb-read-only-continue').click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId('speleodb-status-button')).toHaveAttribute('data-kind', 'locked_by_other');
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire']);
});
