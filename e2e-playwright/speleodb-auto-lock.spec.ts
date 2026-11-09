import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';
import { openSpeleoFromMenu, openSpeleoTab } from './helpers/speleoWorkspace';
import { LEFT_WORKSPACE_MIN_WIDTH } from '../src/components/SingleSystemView/layoutConstants';
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
  await openSpeleoTab(page);
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Switch to Read Only Mode');
  await expect(page.getByTestId('speleodb-read-only-dialog')).toHaveCount(0);
  await page.getByTestId('speleodb-workspace-editing').click();
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Resume editing');
  await expect(page.getByTestId('single-system-view')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire', 'release']);
  await openSpeleoTab(page);
  await page.getByTestId('speleodb-workspace-editing').click();
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Switch to Read Only Mode');
});

test('contended open shows one read-only modal naming the actual editor', async ({ page }) => {
  await openRemote(page, true);
  const notice = page.getByTestId('speleodb-read-only-dialog');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('editor@example.com is currently editing');
  await page.getByTestId('speleodb-read-only-continue').click();
  await expect(notice).toHaveCount(0);
  await openSpeleoTab(page);
  await expect(page.getByTestId('speleodb-workspace-project-header')).toContainText('editor@example.com');
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire']);
});


test('workspace contains everyday controls and History without project or settings tabs', async ({ page }) => {
  await openRemote(page, false);
  await openSpeleoTab(page);
  await expect(page.getByTestId('speleodb-workspace-upload')).toHaveText('Save Changes');
  await expect(page.getByTestId('speleodb-workspace-latest')).toHaveText('Reload Project');
  await expect(page.getByTestId('speleodb-workspace-section-history')).toBeVisible();
  await expect(page.getByTestId('speleodb-workspace-section-projects')).toHaveCount(0);
  await expect(page.getByTestId('speleodb-workspace-close')).toHaveText('Close Project');
  await expect(page.getByTestId('speleodb-workspace-section-settings')).toHaveCount(0);
  await expect(page.getByTestId('speleodb-workspace-section-account')).toHaveCount(0);
  await expect(page.getByTestId('speleodb-settings-name')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire']);
});

test('all-mode navigation preserves the Survey tab and exits fullscreen', async ({ page }) => {
  await openRemote(page, false);
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().setAppMode('plan'));
  // Plan shows no left panel until asked: the hamburger's SpeleoDB row brings it in.
  await openSpeleoFromMenu(page);
  await expect(page.getByTestId('speleodb-workspace')).toBeVisible();
  await expect(page.getByTestId('workspace-tab-sections')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().setAppMode('export'));
  await expect(page.getByTestId('speleodb-workspace')).toBeVisible();
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().setAppMode('survey'));
  await expect(page.getByTestId('workspace-tab-sections')).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().enterDataTableFullScreen());
  await openSpeleoFromMenu(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().dataTableFullScreen)).toBe(false);
  await expect(page.getByTestId('speleodb-workspace')).toBeVisible();
});

test('a narrow window reaches the SpeleoDB tab from the menu, and a narrow saved panel resizes immediately', async ({ page }) => {
  await page.setViewportSize({ width: 540, height: 720 });
  await openRemote(page, false);
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.setState({ sectionsPanelWidth: 200 }));
  await expect(page.getByTestId('speleodb-status-button')).toHaveCount(0);
  await openSpeleoFromMenu(page);
  const panel = page.getByTestId('sections-panel-bar');
  const handle = page.getByTestId('sections-resize-handle');
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(LEFT_WORKSPACE_MIN_WIDTH - 0.5);
  const initial = await panel.boundingBox();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(initial!.width + 20);
});

test('upload saves locally, retains the lock, and a released lock blocks a subsequent upload', async ({ page }) => {
  await openRemote(page, false);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__MOCK_IPC_OVERRIDES__.speleodb_push = { kind: 'pushed' };
    const store = w.__E2E_TEST__.speleoStore;
    store.setState({ link: { ...store.getState().link!, hasUnpushedEdits: true } });
  });
  await openSpeleoTab(page);
  await page.getByTestId('speleodb-workspace-upload').click();
  await page.getByTestId('speleodb-done-message').fill('Synthetic survey update');
  await page.getByTestId('speleodb-done-confirm').click();
  await expect(page.getByTestId('speleodb-done-dialog')).toHaveCount(0);
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Switch to Read Only Mode');
  await page.getByTestId('speleodb-workspace-editing').click();
  await page.getByTestId('speleodb-workspace-upload').click();
  await expect(page.getByTestId('speleodb-upload-blocked')).toBeVisible();
  await expect(page.getByTestId('speleodb-done-confirm')).toBeDisabled();
});

test('read-only switching refuses unuploaded work and sign-in opens application Settings', async ({ page }) => {
  await openRemote(page, false);
  await page.evaluate(() => {
    const store = (window as unknown as TestWindow).__E2E_TEST__.speleoStore;
    store.setState({ link: { ...store.getState().link!, hasUnpushedEdits: true } });
  });
  await openSpeleoTab(page);
  await page.getByTestId('speleodb-workspace-editing').click();
  await expect(page.getByTestId('error-dialog')).toContainText('Save your changes using Save Changes');
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire']);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__E2E_TEST__.uiStore.getState().closeDialog();
    w.__MOCK_IPC_OVERRIDES__.speleodb_session = { logged_in: false, user_email: null, endpoint: 'https://example.com' };
    w.__E2E_TEST__.speleoStore.setState({ session: null, link: { ...w.__E2E_TEST__.speleoStore.getState().link!, editState: 'read-only' } });
  });
  await page.getByTestId('speleodb-workspace-editing').click();
  await expect(page.getByTestId('settings-panel-speleodb')).toBeVisible();
  await expect(page.getByTestId('speleodb-account-login-form')).toBeVisible();
});


test('workspace Close Project warns for unsaved work, cancels safely and closes to the listing', async ({ page }) => {
  await openRemote(page, false);
  await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.projectStore.setState({ isDirty: true }));
  await openSpeleoTab(page);
  await page.getByTestId('speleodb-workspace-close').click();
  await expect(page.getByTestId('speleodb-close-dialog')).toBeVisible();
  await page.getByTestId('speleodb-close-cancel').click();
  await expect(page.getByTestId('single-system-view')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.projectStore.getState().isDirty)).toBe(true);
  await page.getByTestId('speleodb-workspace-close').click();
  await page.getByTestId('speleodb-close-discard').click();
  await expect(page.getByTestId('global-view')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.projectStore.getState().project)).toBeNull();
});


test('Settings authentication returns the Save description and close intent without uploading', async ({ page }) => {
  await openRemote(page, false);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__MOCK_IPC_OVERRIDES__.speleodb_session = { logged_in: false, user_email: null, endpoint: 'https://example.com' };
    w.__MOCK_IPC_OVERRIDES__.speleodb_login = { user_email: 'me@example.com', endpoint: 'https://example.com' };
    for (const cmd of ['speleodb_push', 'speleodb_done', 'save_project']) {
      Object.defineProperty(w.__MOCK_IPC_OVERRIDES__, cmd, { get: () => { throw new Error('Authentication must not save or upload'); } });
    }
    w.__E2E_TEST__.speleoStore.setState({ session: null, link: { ...w.__E2E_TEST__.speleoStore.getState().link!, editState: 'read-only', hasUnpushedEdits: true } });
    w.__E2E_TEST__.uiStore.getState().openDialog('speleodb-done', { mode: 'push', closeAfterSave: true });
  });
  await page.getByTestId('speleodb-done-message').fill('Validated synthetic survey update');
  await page.getByTestId('speleodb-upload-sign-in').click();
  await expect(page.getByTestId('settings-panel-speleodb')).toBeVisible();
  await page.getByTestId('speleodb-settings-email').fill('me@example.com');
  await page.getByTestId('speleodb-settings-password').fill('synthetic-password');
  await page.getByTestId('speleodb-settings-try-login').click();
  await expect(page.getByTestId('speleodb-done-dialog')).toBeVisible();
  await expect(page.getByTestId('speleodb-done-message')).toHaveValue('Validated synthetic survey update');
  expect(await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.uiStore.getState().dialogData.closeAfterSave)).toBe(true);
  await expect(page.getByTestId('single-system-view')).toBeVisible();
});

test('the read-only map pill offers Resume editing, which retakes the lock', async ({ page }) => {
  await openRemote(page, false);
  await openSpeleoTab(page);
  await page.getByTestId('speleodb-workspace-editing').click();
  const pill = page.getByTestId('speleodb-readonly-banner');
  await expect(pill).toBeVisible();
  // No yellow read-only bar above the map any more: the pill and the tab's lock say it.
  await expect(page.getByTestId('speleodb-access-notice')).toHaveCount(0);
  await expect(page.getByTestId('workspace-tab-speleodb')).toHaveAttribute('data-state', 'read-only');
  await pill.getByTestId('speleodb-readonly-resume').click();
  await expect(pill).toHaveCount(0);
  await expect(page.getByTestId('speleodb-workspace-editing')).toHaveText('Switch to Read Only Mode');
  expect(await page.evaluate(() => (window as unknown as { __lockCalls: string[] }).__lockCalls)).toEqual(['acquire', 'release', 'acquire']);
});

test('the read-only pill hides Resume editing when it cannot apply', async ({ page }) => {
  await openRemote(page, false);
  await openSpeleoTab(page);
  await page.getByTestId('speleodb-workspace-editing').click();
  const pill = page.getByTestId('speleodb-readonly-banner');
  await expect(pill.getByTestId('speleodb-readonly-resume')).toBeVisible();
  await page.evaluate(() => {
    const store = (window as unknown as TestWindow).__E2E_TEST__.speleoStore;
    store.setState({ link: { ...store.getState().link!, permission: 'READ_ONLY' } });
  });
  await expect(pill).toBeVisible();
  await expect(pill.getByTestId('speleodb-readonly-resume')).toHaveCount(0);
  await page.evaluate(() => {
    const store = (window as unknown as TestWindow).__E2E_TEST__.speleoStore;
    store.setState({ session: null, link: { ...store.getState().link!, permission: 'READ_AND_WRITE' } });
  });
  await expect(pill).toBeVisible();
  await expect(pill.getByTestId('speleodb-readonly-resume')).toHaveCount(0);
});

test('Reload Project asks in the in-app dialog and Cancel keeps the work', async ({ page }) => {
  await openRemote(page, false);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow & { __updateCalls: number };
    w.__updateCalls = 0;
    Object.defineProperty(w.__MOCK_IPC_OVERRIDES__, 'speleodb_update', { get: () => { w.__updateCalls += 1; return { kind: 'up_to_date' }; } });
    w.__E2E_TEST__.projectStore.setState({ isDirty: true });
  });
  await openSpeleoTab(page);
  await page.getByTestId('speleodb-workspace-latest').click();
  const dialog = page.getByTestId('speleodb-reload-confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Discard changes removes unsaved and unuploaded modifications');
  await page.getByTestId('speleodb-reload-confirm-cancel').click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __updateCalls: number }).__updateCalls)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__E2E_TEST__.projectStore.getState().isDirty)).toBe(true);
  await page.getByTestId('speleodb-workspace-latest').click();
  await page.getByTestId('speleodb-reload-confirm-discard').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __updateCalls: number }).__updateCalls)).toBe(1);
});
