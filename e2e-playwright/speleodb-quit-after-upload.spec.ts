import { test, expect, type Page } from './fixtures/coverage';
import { createProject, setupMockedPage } from './helpers/app';
import { openSpeleoTab } from './helpers/speleoWorkspace';
import type { useSpeleoStore } from '../src/store/speleoStore';

/**
 * lock#6 / frontend#4: quitting while a SpeleoDB upload is running never cuts it.
 *
 * The window X (like menu Quit, Ctrl+Q and an OS close) reaches the app as
 * `tauri://close-requested`. While the upload is in flight the app keeps the
 * window, toasts that it will close when the upload finishes, shows a waiting
 * prompt above the upload progress, and closes once the upload has landed.
 * "Quit now" is an explicit choice behind a warning.
 */
type QuitWindow = Window & {
  __E2E_TEST__: { speleoStore: typeof useSpeleoStore };
  __MOCK_IPC_OVERRIDES__: Record<string, unknown>;
  __MOCK_SET_PROJECT_IS_REMOTE__: (remote: boolean) => void;
  __MOCK_GET_WINDOW_TEARDOWN_COUNTS__: () => { destroy: number; close: number };
  __finishUpload: () => void;
  __forcedExitArmed?: number;
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
};

async function startSlowUpload(page: Page): Promise<void> {
  await setupMockedPage(page);
  await createProject(page, 'Synthetic quit during upload');
  await page.evaluate(() => {
    const w = window as unknown as QuitWindow;
    w.__MOCK_SET_PROJECT_IS_REMOTE__(true);
    const pending = new Promise((resolve) => { w.__finishUpload = () => resolve({ kind: 'pushed' }); });
    const overrides: Record<string, unknown> = {
      speleodb_link_status: { is_remote: true, project_id: 'quit-upload', edit_enabled: true,
        permission: 'READ_AND_WRITE', has_unpushed_edits: false, unwound: false,
        remote_state: 'up_to_date', lock_holder: 'test@example.com', access_denied: false,
        server_error: null, exclude_geojson: false, undo_mode: 'full' },
    };
    Object.defineProperty(overrides, 'speleodb_push', { get: () => pending });
    w.__MOCK_IPC_OVERRIDES__ = overrides;
    w.__E2E_TEST__.speleoStore.setState({
      session: { loggedIn: true, userEmail: 'test@example.com', endpoint: 'https://speleodb.example' },
      projectLinkKind: 'remote', remoteProjectId: 'quit-upload',
      link: { permission: 'READ_AND_WRITE', editState: 'editing', hasUnpushedEdits: true,
        lockHolder: 'test@example.com', lockedByOther: false, unwound: false, undoMode: 'full',
        remoteState: 'up_to_date', noAccess: false, serverError: null },
    });
  });
  await page.keyboard.press('Control+s');
  await page.getByTestId('speleodb-done-message').fill('Synthetic survey update');
  await page.getByTestId('speleodb-done-confirm').click();
  await expect(page.getByTestId('speleodb-upload-progress')).toBeVisible();
}

/** What the native backend does after preventing a window close. */
async function deliverCloseRequested(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as unknown as QuitWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'tauri://close-requested', payload: null,
    });
  });
}

const teardown = (page: Page) => page.evaluate(() => (window as unknown as QuitWindow).__MOCK_GET_WINDOW_TEARDOWN_COUNTS__());

test('window X during an upload waits for it, with a toast and progress, then closes', async ({ page }) => {
  await startSlowUpload(page);
  await deliverCloseRequested(page);
  await expect(page.getByTestId('toast').filter({ hasText: 'will close when it finishes' })).toBeVisible();
  const wait = page.getByTestId('quit-wait-dialog');
  await expect(wait).toBeVisible();
  // Layered over the upload progress, and the one that takes input.
  await expect(page.getByTestId('speleodb-upload-progress')).toBeVisible();
  await expect(wait.getByTestId('quit-wait-cancel')).toBeEnabled();
  expect(await teardown(page)).toEqual({ destroy: 0, close: 0 });

  await page.evaluate(() => (window as unknown as QuitWindow).__finishUpload());
  await expect(page.getByTestId('speleodb-upload-progress')).toHaveCount(0);
  // The quit is re-issued once the upload has landed...
  await expect.poll(async () => (await teardown(page)).close).toBe(1);
  await expect(wait).toHaveCount(0);
  // ...and, with the work uploaded, nothing else stands in the way.
  await deliverCloseRequested(page);
  await expect.poll(async () => (await teardown(page)).destroy).toBe(1);
  expect(await page.evaluate(() => (window as unknown as QuitWindow).__forcedExitArmed ?? 0)).toBe(0);
});

test('Keep Stalagmight open calls the quit off and lets the upload finish', async ({ page }) => {
  await startSlowUpload(page);
  await deliverCloseRequested(page);
  await page.getByTestId('quit-wait-cancel').click();
  await expect(page.getByTestId('quit-wait-dialog')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as QuitWindow).__finishUpload());
  await expect(page.getByTestId('speleodb-done-dialog')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await teardown(page)).toEqual({ destroy: 0, close: 0 });
});

test('Quit now cuts the upload only after a warning, and tells the backend so', async ({ page }) => {
  await startSlowUpload(page);
  await deliverCloseRequested(page);
  await page.getByTestId('quit-wait-force').click();
  await expect(page.getByTestId('quit-wait-force-warning')).toContainText('cut off');
  await page.getByTestId('quit-wait-force-confirm').click();
  await expect.poll(async () => (await teardown(page)).close).toBe(1);
  await deliverCloseRequested(page);
  await expect.poll(async () => (await teardown(page)).destroy).toBe(1);
  expect(await page.evaluate(() => (window as unknown as QuitWindow).__forcedExitArmed ?? 0)).toBe(1);
});

test('window X during the Publishing overlay waits for the publish, then closes', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Synthetic quit during publish');
  await page.evaluate(() => {
    const w = window as unknown as QuitWindow & { __finishPublish: () => void };
    w.__E2E_TEST__.speleoStore.setState({ session: { loggedIn: true, userEmail: 'test@example.com', endpoint: 'https://speleodb.example' } });
    w.__MOCK_IPC_OVERRIDES__ = {
      speleodb_publish: new Promise((resolve) => {
        w.__finishPublish = () => resolve({ project_id: 'pending', endpoint: 'https://speleodb.example', local_path: '/cache/pending/project.stalx' });
      }),
      speleodb_link_status: { is_remote: true, project_id: 'pending', edit_enabled: false, has_unpushed_edits: false, permission: 'ADMIN', remote_state: 'up_to_date' },
    };
  });
  await openSpeleoTab(page);
  await page.getByTestId('speleodb-workspace-convert').click();
  await page.getByTestId('publish-to-speleodb-dialog-description').fill('Team survey');
  await page.getByTestId('publish-to-speleodb-dialog-country').click();
  await page.getByTestId('publish-to-speleodb-dialog-country-option-US').click();
  await page.getByTestId('publish-to-speleodb-dialog-submit').click();
  await expect(page.getByTestId('speleodb-publish-progress')).toBeVisible();

  await deliverCloseRequested(page);
  await expect(page.getByTestId('toast').filter({ hasText: 'will close when it finishes' })).toBeVisible();
  await expect(page.getByTestId('quit-wait-dialog')).toBeVisible();
  expect(await teardown(page)).toEqual({ destroy: 0, close: 0 });

  await page.evaluate(() => (window as unknown as { __finishPublish: () => void }).__finishPublish());
  await expect(page.getByTestId('speleodb-publish-progress')).toHaveCount(0);
  await expect.poll(async () => (await teardown(page)).close).toBe(1);
});
