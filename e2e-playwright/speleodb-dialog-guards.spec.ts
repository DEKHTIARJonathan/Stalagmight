import { test, expect, type Page } from './fixtures/coverage';
import { setupMockedPage, createProject } from './helpers/app';
import { setIpcOverrides } from './helpers/ipcOverrides';

/**
 * SpeleoDB dialog guards, end to end on the mocked IPC. Synthetic projects only.
 *
 * - The Open from SpeleoDB browser cannot be dismissed while an open is in flight,
 *   and the open's 401 is shown (frontend#3).
 * - Settings' "Log in now" uses the connection on screen and keeps Settings open
 *   while other tabs hold staged edits (security#4).
 * - Unsent SpeleoDB input is asked about in-app before the app closes (frontend#10).
 */

const ENDPOINT = 'https://synthetic.example';

type Call = { cmd: string; args: Record<string, unknown> | null };

async function calls(page: Page, cmd: string): Promise<Call[]> {
  const all = await page.evaluate(
    () => ((window as unknown as { __MOCK_EXIT_CALLS__?: Call[] }).__MOCK_EXIT_CALLS__ ?? []),
  );
  return all.filter((c) => c.cmd === cmd);
}

/** The OS window X: what the real backend emits after preventing the close. */
async function pressWindowCloseButton(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__?.invoke('plugin:event|emit', { event: 'tauri://close-requested', payload: null });
  });
}

async function windowDestroyCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as {
    __MOCK_GET_WINDOW_TEARDOWN_COUNTS__?: () => { destroy: number };
  }).__MOCK_GET_WINDOW_TEARDOWN_COUNTS__?.().destroy ?? -1);
}

test('the SpeleoDB browser stays open while an open is in flight, then shows its 401', async ({ page }) => {
  await setupMockedPage(page);
  await setIpcOverrides(page, {
    speleodb_session: { logged_in: true, endpoint: ENDPOINT, user_email: 'test@example.com' },
    speleodb_list_projects: [{ id: 'synthetic', name: 'Synthetic cave', type_tag: 'stalx',
      latest_commit_sha: null, permission: 'READ_AND_WRITE', lock_holder: null }],
  });
  await page.evaluate(() => {
    const w = window as unknown as {
      __MOCK_IPC_OVERRIDES__: Record<string, unknown>;
      __FAIL_OPEN__?: (error: unknown) => void;
      __E2E_TEST__: { uiStore: { getState: () => { openDialog: (name: string) => void } } };
    };
    w.__MOCK_IPC_OVERRIDES__.speleodb_open_project = new Promise((_resolve, reject) => { w.__FAIL_OPEN__ = reject; });
    w.__E2E_TEST__.uiStore.getState().openDialog('open-from-speleodb');
  });
  const dialog = page.getByTestId('open-from-speleodb-dialog');
  await page.getByTestId('open-from-speleodb-open-synthetic').click();
  await expect(page.getByTestId('open-from-speleodb-close')).toBeDisabled();

  await page.getByTestId('open-from-speleodb-filter').focus();
  await page.keyboard.press('Escape');
  await page.getByTestId('open-from-speleodb-dialog-close').click();
  await expect(dialog).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as {
      __MOCK_IPC_OVERRIDES__: Record<string, unknown>;
      __FAIL_OPEN__: (error: unknown) => void;
    };
    // The server ended the session: the next session check says so.
    w.__MOCK_IPC_OVERRIDES__.speleodb_session = { logged_in: false };
    w.__FAIL_OPEN__({ message: 'Your SpeleoDB session expired', action: 'ReLogin', status: 401 });
  });
  await expect(page.getByTestId('open-from-speleodb-logged-out')).toBeVisible();
  await expect(page.getByTestId('open-from-speleodb-error')).toContainText('Your SpeleoDB session expired');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

/**
 * The browser mock's default config omits sections the real backend always sends,
 * and Settings fills them in on the first edit - which would read as an edit in
 * another tab. Save the complete config (the generated defaults under the mock's
 * values) first, as the real backend would have it.
 */
async function seedCompleteConfig(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<Record<string, unknown>> };
      __E2E_TEST__: { projectStore: { getState: () => { loadConfig: () => Promise<void> } } };
    };
    const url = '/src/types/ipc/defaultConfig.ts';
    const { defaultConfig } = await import(/* @vite-ignore */ url) as { defaultConfig: Record<string, unknown> };
    const current = await w.__TAURI_INTERNALS__.invoke('get_config');
    await w.__TAURI_INTERNALS__.invoke('update_config', { config: { ...defaultConfig, ...current } });
    await w.__E2E_TEST__.projectStore.getState().loadConfig();
  });
}

test.describe('Settings "Log in now"', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await seedCompleteConfig(page);
    await page.getByTestId('global-speleodb-button').click();
    await expect(page.getByTestId('settings-panel-speleodb')).toBeVisible();
  });

  async function logInNow(page: Page): Promise<void> {
    await page.getByTestId('speleodb-settings-email').fill('test@example.com');
    await page.getByTestId('speleodb-settings-password').fill('synthetic-secret');
    await page.getByTestId('speleodb-settings-try-login').click();
  }

  test('logs in over the endpoint and insecure-HTTP choice on screen, then closes', async ({ page }) => {
    await page.getByTestId('input-speleodb-endpoint').fill('http://lab.example/');
    await page.getByTestId('toggle-speleodb-insecure-http').click();
    await logInNow(page);
    await expect(page.getByTestId('settings-dialog')).toBeHidden();
    expect((await calls(page, 'speleodb_login')).map((c) => c.args)).toEqual([
      expect.objectContaining({ endpoint: 'http://lab.example/', insecureHttp: true }),
    ]);
  });

  test('stays open while another tab holds staged edits, which Save then writes', async ({ page }) => {
    await page.getByTestId('toggle-speleodb-insecure-http').click();
    await page.getByTestId('settings-tab-general').click();
    const autoSave = page.getByTestId('toggle-auto-save');
    const before = await autoSave.getAttribute('aria-checked');
    await autoSave.click();
    await page.getByTestId('settings-tab-speleodb').click();
    await logInNow(page);

    await expect(page.getByTestId('speleodb-account-signed-in')).toBeVisible();
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.getByTestId('settings-tab-general').click();
    await expect(page.getByTestId('toggle-auto-save')).not.toHaveAttribute('aria-checked', before ?? '');
    await page.getByTestId('settings-save-button').click();
    await expect(page.getByTestId('settings-dialog')).toBeHidden();
    const saved = await page.evaluate(async () => (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<{ general: { auto_save: boolean } }> };
    }).__TAURI_INTERNALS__.invoke('get_config'));
    expect(String(saved.general.auto_save)).not.toBe(before);
    expect(await calls(page, 'speleodb_login')).toHaveLength(1);
  });
});

test('closing the app asks in-app before dropping the SpeleoDB project form', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Synthetic draft');
  await page.evaluate(() => {
    (window as unknown as {
      __E2E_TEST__: { uiStore: { getState: () => { openDialog: (name: string) => void } } };
    }).__E2E_TEST__.uiStore.getState().openDialog('publish-to-speleodb');
  });
  const description = page.getByTestId('publish-to-speleodb-dialog-description');
  await description.fill('Synthetic system description');

  await pressWindowCloseButton(page);
  await expect(page.getByTestId('exit-confirm-dialog')).toBeVisible();
  await expect(page.getByTestId('exit-confirm-message')).toContainText('the SpeleoDB project form');
  await page.getByTestId('exit-confirm-cancel').click();
  await expect(page.getByTestId('exit-confirm-dialog')).toBeHidden();
  await expect(description).toHaveValue('Synthetic system description');
  expect(await windowDestroyCount(page)).toBe(0);

  await pressWindowCloseButton(page);
  await page.getByTestId('exit-confirm-ok').click();
  await expect(page.getByTestId('publish-to-speleodb-dialog')).toBeHidden();
});
