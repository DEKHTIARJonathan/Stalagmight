import { test, expect } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

test('successful login closes Settings and shows progress until the listing refresh finishes', async ({ page }) => {
  await setupMockedPage(page);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ = {
      speleodb_list_projects: new Promise((resolve) => {
        (window as unknown as Record<string, unknown>).__FINISH_REFRESH__ = () => resolve([{
          id: 'refresh-project', name: 'Synthetic refreshed cave',
          lock_holder: null, permission: 'READ_AND_WRITE',
        }]);
      }),
    };
  });
  // Signed out, the SpeleoDB button holds the Refresh slot (no header copy).
  await expect(page.getByTestId('global-speleodb-button')).toBeVisible();
  await expect(page.locator('header').getByTestId('global-speleodb-button')).toHaveCount(0);
  await expect(page.getByTestId('globalview-speleo-refresh')).toHaveCount(0);
  await page.getByTestId('global-speleodb-button').click();
  await expect(page.getByTestId('settings-panel-speleodb')).toBeVisible();
  await expect(page.getByText('Remote refresh interval', { exact: true })).toHaveCount(0);
  await page.getByTestId('speleodb-settings-email').fill('test@example.com');
  await page.getByTestId('speleodb-settings-password').fill('synthetic-password');
  await page.getByTestId('speleodb-settings-try-login').click();
  await expect(page.getByTestId('settings-panel-speleodb')).toHaveCount(0);
  await expect(page.getByTestId('globalview-list-spinner')).toBeVisible();
  await expect(page.getByTestId('globalview-speleo-refresh')).toBeDisabled();
  // Signed in, Refresh replaces the SpeleoDB button.
  await expect(page.getByTestId('global-speleodb-button')).toHaveCount(0);
  await page.evaluate(() => {
    ((window as unknown as Record<string, unknown>).__FINISH_REFRESH__ as () => void)();
  });
  await expect(page.getByTestId('global-view')).toContainText('Synthetic refreshed cave');
  await expect(page.getByTestId('globalview-list-spinner')).toHaveCount(0);
});

test('startup and manual refresh reload the project listing', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ = {
      speleodb_session: { logged_in: true, user_email: 'test@example.com', endpoint: 'https://speleodb.example' },
      speleodb_list_projects: new Promise((resolve) => {
        (window as unknown as Record<string, unknown>).__FINISH_REFRESH__ = () => resolve([{
          id: 'startup-project', name: 'Synthetic startup cave',
          lock_holder: null, permission: 'READ_AND_WRITE',
        }]);
      }),
    };
  });
  await setupMockedPage(page);
  await expect(page.getByTestId('globalview-list-spinner')).toBeVisible();
  await page.evaluate(() => {
    ((window as unknown as Record<string, unknown>).__FINISH_REFRESH__ as () => void)();
  });
  await expect(page.getByTestId('global-view')).toContainText('Synthetic startup cave');
  await page.evaluate(() => {
    const overrides = (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ as Record<string, unknown>;
    overrides.speleodb_list_projects = new Promise((resolve) => {
      (window as unknown as Record<string, unknown>).__FINISH_REFRESH__ = () => resolve([{
        id: 'manual-project', name: 'Synthetic manual cave',
        lock_holder: null, permission: 'READ_AND_WRITE',
      }]);
    });
  });
  await page.getByTestId('globalview-speleo-refresh').click();
  await expect(page.getByTestId('globalview-list-spinner')).toBeVisible();
  await expect(page.getByTestId('globalview-speleo-refresh-spinner')).toBeVisible();
  await page.evaluate(() => {
    ((window as unknown as Record<string, unknown>).__FINISH_REFRESH__ as () => void)();
  });
  await expect(page.getByTestId('globalview-list-spinner')).toHaveCount(0);
  await expect(page.getByTestId('global-view')).toContainText('Synthetic manual cave');
  await expect(page.getByTestId('global-view')).not.toContainText('Synthetic startup cave');
});


test('failed login keeps Settings open for correction', async ({ page }) => {
  await setupMockedPage(page);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ = {
      speleodb_login: { __throw: 'Invalid credentials' },
    };
  });
  await page.getByTestId('global-speleodb-button').click();
  await page.getByTestId('speleodb-settings-email').fill('test@example.com');
  await page.getByTestId('speleodb-settings-password').fill('synthetic-password');
  await page.getByTestId('speleodb-settings-try-login').click();
  await expect(page.getByTestId('speleodb-account-settings-error')).toBeVisible();
  await expect(page.getByTestId('settings-panel-speleodb')).toBeVisible();
  await expect(page.getByTestId('globalview-list-spinner')).toHaveCount(0);
});
