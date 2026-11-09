import { expect, type Page } from '@playwright/test';
import { openAppMenu } from './app';

/**
 * Open the left panel's SpeleoDB tab - the SpeleoDB entry point since the toolbar
 * SpeleoDB button was removed - by clicking the tab itself.
 */
export async function openSpeleoTab(page: Page): Promise<void> {
  const tab = page.getByTestId('workspace-tab-speleodb');
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * Reach the SpeleoDB tab through the hamburger's SpeleoDB row: the route where
 * the tab is not on screen (Plan/Export before the panel is opened, the
 * fullscreen table, a narrow window that squeezed the panel away).
 */
export async function openSpeleoFromMenu(page: Page): Promise<void> {
  await openAppMenu(page);
  await page.getByTestId('project-menu-speleodb').click();
  await expect(page.getByTestId('workspace-tab-speleodb')).toHaveAttribute('aria-selected', 'true');
}
