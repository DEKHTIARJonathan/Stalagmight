import { test, expect } from '@playwright/test';
import { setupMockedPage, createProject } from './helpers/app';

test.describe('Debug Tests', () => {
  test('check project creation', async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Test Project');
    await expect(page.getByTestId('map-canvas')).toBeVisible();
  });
});
