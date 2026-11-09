import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';
import type { useUIStore } from '../src/store/uiStore';
import type { useSpeleoStore } from '../src/store/speleoStore';
import type { useProjectStore } from '../src/store/projectStore';
type TestWindow = Window & { __E2E_TEST__: { uiStore: typeof useUIStore; speleoStore: typeof useSpeleoStore; projectStore: typeof useProjectStore }; __MOCK_IPC_OVERRIDES__: Record<string, unknown> };


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
      speleodb_get_project_metadata: { name: 'Synthetic cave', description: 'Synthetic metadata', country: 'US', visibility: 'PRIVATE', latitude: null, longitude: null, exclude_geojson: false },
      speleodb_get_revisions: [],
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
      is_remote: true, edit_enabled: editing,
      permission: 'READ_AND_WRITE', lock_holder: contended ? 'editor@example.com' : editing ? 'me@example.com' : null,
      has_unpushed_edits: false, unwound: false, remote_state: 'up_to_date',
      access_denied: false, server_error: null, exclude_geojson: false, undo_mode: 'full',
      project_id: 'remote',
    }) });
    w.__MOCK_IPC_OVERRIDES__ = overrides;
    await (window as unknown as TestWindow).__E2E_TEST__.speleoStore.getState().refreshSession();
    await w.__E2E_TEST__.projectStore.getState().loadProject('/projects/cave-alpha.stalx');
  }, lockedByOther);
}

test('opening acquires silently; workspace release stays open and does not reacquire', async ({ page }) => {
  await openRemote(page, false);
  const status = page.getByTestId('speleodb-status-button');
  await status.click();
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Release editing lock');
  await expect(page.getByTestId('speleodb-read-only-dialog')).toHaveCount(0);
  await page.getByTestId('speleodb-workspace-editing').click();
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Resume editing');
  await expect(page.getByTestId('single-system-view')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire', 'release']);
  await status.click();
  await page.getByTestId('speleodb-workspace-editing').click();
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Release editing lock');
});

test('contended open shows one read-only modal naming the actual editor', async ({ page }) => {
  await openRemote(page, true);
  const notice = page.getByTestId('speleodb-read-only-dialog');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('editor@example.com is currently editing');
  await page.getByTestId('speleodb-read-only-continue').click();
  await expect(notice).toHaveCount(0);
  await page.getByTestId('speleodb-status-button').click();
  await expect(page.getByTestId('speleodb-workspace-project-header')).toContainText('editor@example.com');
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire']);
});


test('Sections-first tabs preserve metadata drafts and keyboard navigation without taking locks', async ({ page }) => {
  await openRemote(page, false);
  await expect(page.getByTestId('workspace-tab-sections')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('speleodb-status-button').click();
  await expect(page.getByTestId('workspace-tab-speleodb')).toBeFocused();
  await page.getByTestId('speleodb-workspace-section-settings').click();
  const name = page.getByTestId('speleodb-settings-name');
  await name.fill('Unfinished synthetic draft');
  await page.getByTestId('workspace-tab-sections').click();
  await page.getByTestId('workspace-tab-sections').press('ArrowRight');
  await expect(name).toHaveValue('Unfinished synthetic draft');
  await page.getByTestId('speleodb-workspace-section-settings').click();
  await page.getByTestId('speleodb-workspace-section-settings').click();
  await expect(name).toHaveValue('Unfinished synthetic draft');
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire']);
});

test('all-mode navigation preserves the Survey tab and exits fullscreen', async ({ page }) => {
  await openRemote(page, false);
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().setAppMode('plan'));
  await page.getByTestId('speleodb-status-button').click();
  await expect(page.getByTestId('speleodb-workspace')).toBeVisible();
  await expect(page.getByTestId('workspace-tab-sections')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().setAppMode('export'));
  await expect(page.getByTestId('speleodb-workspace')).toBeVisible();
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().setAppMode('survey'));
  await expect(page.getByTestId('workspace-tab-sections')).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().enterDataTableFullScreen());
  await page.getByTestId('speleodb-status-button').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().dataTableFullScreen)).toBe(false);
  await expect(page.getByTestId('speleodb-workspace')).toBeVisible();
});

test('narrow toolbar keeps the full button, and a narrow saved panel resizes immediately', async ({ page }) => {
  await page.setViewportSize({ width: 540, height: 720 });
  await openRemote(page, false);
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.setState({ sectionsPanelWidth: 200 }));
  const button = page.getByTestId('speleodb-status-button');
  await expect(button).toHaveText('SpeleoDB');
  await button.click();
  const panel = page.getByTestId('sections-panel-bar');
  const handle = page.getByTestId('sections-resize-handle');
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(319.5);
  const initial = await panel.boundingBox();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(initial!.width + 20);
  const bounds = await button.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(540);
});

test('upload saves locally, retains the lock, and a released lock blocks a subsequent upload', async ({ page }) => {
  await openRemote(page, false);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__MOCK_IPC_OVERRIDES__.speleodb_push = { kind: 'pushed' };
    const store = w.__E2E_TEST__.speleoStore;
    store.setState({ link: { ...store.getState().link!, hasUnpushedEdits: true } });
  });
  await page.getByTestId('speleodb-status-button').click();
  await page.getByTestId('speleodb-workspace-upload').click();
  await page.getByTestId('speleodb-done-message').fill('Synthetic survey update');
  await page.getByTestId('speleodb-done-confirm').click();
  await expect(page.getByTestId('speleodb-done-dialog')).toHaveCount(0);
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Release editing lock');
  await page.getByTestId('speleodb-workspace-editing').click();
  await page.getByTestId('speleodb-workspace-upload').click();
  await expect(page.getByTestId('speleodb-upload-blocked')).toBeVisible();
  await expect(page.getByTestId('speleodb-done-confirm')).toBeDisabled();
});
