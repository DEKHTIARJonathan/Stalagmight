import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * E2E tests for theme switching: data-theme attribute, CSS variable resolution,
 * and Settings Appearance tab functionality.
 */

/**
 * Helper to create a new project using stable data-testid selectors.
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('[data-testid="new-project-button"]');
  await expect(newProjectBtn).toBeVisible({ timeout: 5000 });
  await newProjectBtn.click();

  // Wait for the New Project dialog to appear
  await expect(
    page.locator('[data-testid="new-project-dialog"]')
  ).toBeVisible({ timeout: 5000 });

  // Fill in the project name via its stable test ID
  await page.locator('[data-testid="new-project-name-input"]').fill(name);

  // Click Create via its stable test ID
  await page.locator('[data-testid="new-project-create-button"]').click();
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Wait for map to be fully initialized (per memory pitfall)
  await page.waitForFunction(
    () =>
      (window as unknown as { __cavechef_map__?: unknown }).__cavechef_map__ !==
      undefined,
    { timeout: 10000 }
  );
}

/**
 * Helper to go back to GlobalView from a project view
 */
async function goBackToGlobalView(page: Page): Promise<void> {
  const backButton = page.locator('[data-testid="back-button"]');
  if (await backButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await backButton.click();
    await expect(
      page.locator('[data-testid="global-view"]')
    ).toBeVisible({ timeout: 5000 });
  }
}

/**
 * Helper to open Settings dialog from GlobalView
 */
async function openSettingsDialog(page: Page): Promise<void> {
  await goBackToGlobalView(page);

  const settingsButton = page.locator('[data-testid="settings-button"]');
  await expect(settingsButton).toBeVisible({ timeout: 5000 });
  await settingsButton.click();
  await expect(
    page.locator('[data-testid="settings-dialog"]')
  ).toBeVisible({ timeout: 5000 });
}

/**
 * Helper to navigate to the Appearance tab in Settings
 */
async function navigateToAppearance(page: Page): Promise<void> {
  const appearanceTab = page.locator(
    '[data-testid="settings-tab-appearance"]'
  );
  await expect(appearanceTab).toBeVisible();
  await appearanceTab.click();
  await expect(
    page.locator('[data-testid="settings-panel-appearance"]')
  ).toBeVisible({ timeout: 3000 });
}

/**
 * Parse a CSS color string into { r, g, b } components.
 * Handles both comma-separated (CSS Color 3) and space-separated (CSS Color 4)
 * rgb/rgba forms, as well as hex #rrggbb notation.
 */
function parseColor(color: string): { r: number; g: number; b: number } {
  // Handle comma-separated rgb(r, g, b) and rgba(r, g, b, a)
  const commaMatch = color.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/
  );
  if (commaMatch) {
    return {
      r: parseInt(commaMatch[1]!, 10),
      g: parseInt(commaMatch[2]!, 10),
      b: parseInt(commaMatch[3]!, 10),
    };
  }
  // Handle space-separated rgb(r g b) and rgb(r g b / a) (CSS Color 4)
  const spaceMatch = color.match(
    /rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)/
  );
  if (spaceMatch) {
    return {
      r: parseInt(spaceMatch[1]!, 10),
      g: parseInt(spaceMatch[2]!, 10),
      b: parseInt(spaceMatch[3]!, 10),
    };
  }
  // Handle hex #rrggbb
  const hexMatch = color.match(
    /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
  );
  if (hexMatch) {
    return {
      r: parseInt(hexMatch[1]!, 16),
      g: parseInt(hexMatch[2]!, 16),
      b: parseInt(hexMatch[3]!, 16),
    };
  }
  throw new Error(`Cannot parse color: ${color}`);
}

/**
 * Assert two colors are approximately equal (within tolerance).
 * Uses numeric comparison for cross-engine stability per pitfall guidance.
 */
function assertColorsApproximatelyEqual(
  actual: string,
  expected: { r: number; g: number; b: number },
  tolerance = 2
) {
  const parsed = parseColor(actual);
  expect(Math.abs(parsed.r - expected.r)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(parsed.g - expected.g)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(parsed.b - expected.b)).toBeLessThanOrEqual(tolerance);
}

// Dark theme --cc-background is #1a1a2e -> rgb(26, 26, 46)
const DARK_BG = { r: 26, g: 26, b: 46 };
// Light theme --cc-background is #f5f0e8 -> rgb(245, 240, 232)
const LIGHT_BG = { r: 245, g: 240, b: 232 };

test.describe('Theme Switching - Default Dark Theme', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Assert on GlobalView (app-ready signal) without creating a project.
    // This tests theme state truly "on app load" before any view transition.
    await expect(
      page.locator('[data-testid="global-view"]')
    ).toBeVisible({ timeout: 10000 });
  });

  test('default theme is dark on app load', async ({ page }) => {
    // Verify data-theme attribute on document root immediately after load
    const dataTheme = await page.evaluate(
      () => document.documentElement.dataset.theme
    );
    expect(dataTheme).toBe('dark');
  });

  test('CSS variables resolve correctly in dark theme', async ({
    page,
  }) => {
    // Read --cc-background via getComputedStyle
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.documentElement)
        .getPropertyValue('--cc-background')
        .trim();
    });

    // Parse numerically for cross-engine stability
    assertColorsApproximatelyEqual(bgColor, DARK_BG);
  });
});

test.describe('Theme Switching - Via Settings UI', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Theme Settings Test');
  });

  test('theme can be changed to light via Settings Appearance tab', async ({
    page,
  }) => {
    await openSettingsDialog(page);
    await navigateToAppearance(page);

    // Verify dark is currently selected
    const darkRadio = page.locator('[data-testid="theme-radio-dark"]');
    await expect(darkRadio).toBeChecked();

    // Select light theme
    const lightOption = page.locator('[data-testid="theme-option-light"]');
    await lightOption.click();

    // Verify light radio is now checked
    const lightRadio = page.locator('[data-testid="theme-radio-light"]');
    await expect(lightRadio).toBeChecked();

    // Save settings
    const saveButton = page.locator(
      '[data-testid="settings-save-button"]'
    );
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // Wait for dialog to close (save closes dialog)
    await expect(
      page.locator('[data-testid="settings-dialog"]')
    ).not.toBeVisible({ timeout: 5000 });

    // Verify data-theme attribute changed to light
    const dataTheme = await page.evaluate(
      () => document.documentElement.dataset.theme
    );
    expect(dataTheme).toBe('light');
  });

  test('CSS variables resolve to light values after switching theme', async ({
    page,
  }) => {
    await openSettingsDialog(page);
    await navigateToAppearance(page);

    // Select light theme
    const lightOption = page.locator('[data-testid="theme-option-light"]');
    await lightOption.click();

    // Save
    const saveButton = page.locator(
      '[data-testid="settings-save-button"]'
    );
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // Wait for dialog to close
    await expect(
      page.locator('[data-testid="settings-dialog"]')
    ).not.toBeVisible({ timeout: 5000 });

    // Verify --cc-background resolves to the light value
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.documentElement)
        .getPropertyValue('--cc-background')
        .trim();
    });

    assertColorsApproximatelyEqual(bgColor, LIGHT_BG);
  });

  test('theme persists across Settings dialog close and reopen', async ({
    page,
  }) => {
    // Switch to light theme
    await openSettingsDialog(page);
    await navigateToAppearance(page);

    const lightOption = page.locator('[data-testid="theme-option-light"]');
    await lightOption.click();

    // Save and close
    const saveButton = page.locator(
      '[data-testid="settings-save-button"]'
    );
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(
      page.locator('[data-testid="settings-dialog"]')
    ).not.toBeVisible({ timeout: 5000 });

    // Verify light theme is active
    const dataThemeBefore = await page.evaluate(
      () => document.documentElement.dataset.theme
    );
    expect(dataThemeBefore).toBe('light');

    // Reopen Settings and navigate to Appearance
    await openSettingsDialog(page);
    await navigateToAppearance(page);

    // Verify light is still selected
    const lightRadio = page.locator('[data-testid="theme-radio-light"]');
    await expect(lightRadio).toBeChecked();

    // Verify dark is NOT selected
    const darkRadio = page.locator('[data-testid="theme-radio-dark"]');
    await expect(darkRadio).not.toBeChecked();
  });
});
