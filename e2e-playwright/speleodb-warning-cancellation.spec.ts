import { test, expect } from './fixtures/coverage';
import { createProject, setupMockedPage } from './helpers/app';

// Synthetic projects only. Exercise the real native-confirm IPC seam.
for (const dialog of ['open-from-speleodb', 'speleodb-managed-file'] as const) {
  for (const warning of ['read-only', 'locked'] as const) {
    test(`${dialog} recovers after cancelling the ${warning} warning`, async ({ page }) => {
      await setupMockedPage(page);
      await page.evaluate(({ dialog, warning }) => {
        const w = window as unknown as {
          __MOCK_IPC_OVERRIDES__: Record<string, unknown>;
          __E2E_TEST__: {
            speleoStore: { setState: (state: unknown) => void };
            uiStore: { getState: () => { openDialog: (name: string, data?: unknown) => void } };
          };
        };
        w.__MOCK_IPC_OVERRIDES__ = {
          speleodb_session: { logged_in: true, endpoint: 'https://synthetic.example', user_email: 'test@example.com' },
          speleodb_list_projects: [{ id: 'synthetic', name: 'Synthetic cave', type_tag: 'stalx',
            latest_commit_sha: null, permission: warning === 'read-only' ? 'READ_ONLY' : 'READ_AND_WRITE',
            lock_holder: warning === 'locked' ? 'other@example.com' : null }],
          'plugin:dialog|confirm': false,
        };
        w.__E2E_TEST__.speleoStore.setState({ session: {
          loggedIn: true, endpoint: 'https://synthetic.example', userEmail: 'test@example.com',
        } });
        w.__E2E_TEST__.uiStore.getState().openDialog(dialog, dialog === 'speleodb-managed-file' ? {
          managed: { path: '/synthetic/copy.stalx', projectId: 'synthetic', projectName: 'Synthetic cave',
            endpoint: 'https://synthetic.example', canOpenRemote: true },
        } : {});
      }, { dialog, warning });
      const managed = dialog === 'speleodb-managed-file';
      const open = page.getByTestId(managed ? 'speleodb-managed-file-open-remote' : 'open-from-speleodb-open-synthetic');
      await expect(open).toBeEnabled();
      await open.click();
      await expect(open).toBeEnabled();
      await open.click();
      await expect(open).toBeEnabled();
      await page.getByTestId(managed ? 'speleodb-managed-file-cancel' : 'open-from-speleodb-close').click();
      await expect(page.getByTestId(managed ? 'speleodb-managed-file-dialog' : 'open-from-speleodb-dialog')).toBeHidden();
      await expect(page.getByTestId('global-view')).toBeVisible();
    });
  }
}


for (const button of ['speleodb-close-release', 'speleodb-close-push-release']) {
  test(`close protects the destination probe for ${button}`, async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Synthetic close protection');
    await page.evaluate(() => {
      const w = window as unknown as {
        __MOCK_IPC_OVERRIDES__: Record<string, unknown>;
        __finishProbe: () => void;
        __sideEffects: string[];
        __E2E_TEST__: {
          projectStore: { setState: (state: unknown) => void };
          speleoStore: { setState: (state: unknown) => void };
          uiStore: { getState: () => { openDialog: (name: string, data?: unknown) => void } };
        };
      };
      w.__sideEffects = [];
      w.__MOCK_IPC_OVERRIDES__ = {
        'plugin:dialog|confirm': false,
        speleodb_project_access_at: new Promise((resolve) => {
          w.__finishProbe = () => resolve({ project: { name: 'Synthetic destination', permission: 'READ_ONLY', lock_holder: null }, endpoint: 'https://example.com', verification: 'verified' });
        }),
      };
      for (const command of ['save_project', 'speleodb_done', 'speleodb_release_current_lock', 'close_project', 'load_project_full_binary']) {
        Object.defineProperty(w.__MOCK_IPC_OVERRIDES__, command, {
          get: () => { w.__sideEffects.push(command); return null; },
        });
      }
      w.__E2E_TEST__.projectStore.setState({ isDirty: true });
      w.__E2E_TEST__.speleoStore.setState({ busy: false, link: {
        permission: 'READ_AND_WRITE', editState: 'editing', lockedByOther: false,
        lockHolder: null, hasUnpushedEdits: true, unwound: false, forceEditing: false,
        forceEditAllowed: false, remoteState: 'up_to_date', noAccess: false, serverError: null,
      } });
      w.__E2E_TEST__.uiStore.getState().openDialog('speleodb-close', { pendingOpenPath: '/synthetic/destination.stalx' });
    });
    await page.getByRole('textbox', { name: 'Commit message' }).fill('Synthetic update');
    await page.getByTestId(button).click();
    await expect(page.getByTestId('speleodb-close-cancel')).toBeDisabled();
    await expect(page.getByTestId('speleodb-close-save-locally')).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.getByTestId('speleodb-close-dialog-close').click();
    await expect(page.getByTestId('speleodb-close-dialog')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __finishProbe: () => void }).__finishProbe());
    await expect(page.getByTestId(button)).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { __sideEffects: string[] }).__sideEffects)).toEqual([]);
    await page.getByTestId('speleodb-close-cancel').click();
    await expect(page.getByTestId('speleodb-close-dialog')).toBeHidden();
  });
}
