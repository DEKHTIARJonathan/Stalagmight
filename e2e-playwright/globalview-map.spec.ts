import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('GlobalView Map', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Wait for the GlobalView to render with recent projects
    await page.waitForSelector('[data-testid="global-view"]', { timeout: 10000 });
  });

  test.describe('Tab Navigation', () => {
    test('should display Map and List tabs when projects exist', async ({ page }) => {
      // Both tabs should be visible
      const mapTab = page.locator('[data-testid="globalview-map-tab"]');
      const listTab = page.locator('[data-testid="globalview-list-tab"]');

      await expect(mapTab).toBeVisible({ timeout: 5000 });
      await expect(listTab).toBeVisible({ timeout: 5000 });
    });

    test('should show List tab as active by default', async ({ page }) => {
      const listTab = page.locator('[data-testid="globalview-list-tab"]');

      // List tab should have the active styling (border-accent class)
      await expect(listTab).toHaveClass(/border-accent/);
    });

    test('should switch to Map tab when clicked', async ({ page }) => {
      const mapTab = page.locator('[data-testid="globalview-map-tab"]');
      const listTab = page.locator('[data-testid="globalview-list-tab"]');

      // Click Map tab
      await mapTab.click();

      // Map tab should be active
      await expect(mapTab).toHaveClass(/border-accent/);
      // List tab should be inactive
      await expect(listTab).not.toHaveClass(/border-accent/);

      // Map container should be visible
      const mapContainer = page.locator('[data-testid="globalview-map"]');
      await expect(mapContainer).toBeVisible({ timeout: 5000 });
    });

    test('should switch back to List tab when clicked', async ({ page }) => {
      const mapTab = page.locator('[data-testid="globalview-map-tab"]');
      const listTab = page.locator('[data-testid="globalview-list-tab"]');

      // Switch to Map first
      await mapTab.click();
      await expect(mapTab).toHaveClass(/border-accent/);

      // Switch back to List
      await listTab.click();
      await expect(listTab).toHaveClass(/border-accent/);
      await expect(mapTab).not.toHaveClass(/border-accent/);

      // List content should be visible (Recent Projects heading)
      await expect(page.locator('h2:has-text("Recent Projects")')).toBeVisible();
    });

    test('should show count of GPS projects on Map tab', async ({ page }) => {
      const mapTab = page.locator('[data-testid="globalview-map-tab"]');

      // The tab text should include the count (3 GPS projects in mock data)
      await expect(mapTab).toContainText('3');
    });

    test('should show total count on List tab', async ({ page }) => {
      const listTab = page.locator('[data-testid="globalview-list-tab"]');

      // The tab text should include the count (4 total projects in mock data)
      await expect(listTab).toContainText('4');
    });
  });

  test.describe('Map Display', () => {
    test.beforeEach(async ({ page }) => {
      // Switch to Map tab for map-specific tests
      const mapTab = page.locator('[data-testid="globalview-map-tab"]');
      await mapTab.click();
      await page.waitForSelector('[data-testid="globalview-map"]', { timeout: 5000 });
    });

    test('should display the map container', async ({ page }) => {
      const mapContainer = page.locator('[data-testid="globalview-map"]');
      await expect(mapContainer).toBeVisible();
    });

    test('should show system markers on the map', async ({ page }) => {
      // Wait for markers to load (they are added after map loads)
      await page.waitForTimeout(1000);

      // Check for marker elements
      const markers = page.locator('.globalview-system-marker');
      await expect(markers).toHaveCount(3); // 3 GPS projects in mock data
    });

    test('should have data-testid on system markers', async ({ page }) => {
      await page.waitForTimeout(1000);

      // Check for specific project marker
      const alphaMarker = page.locator('[data-testid="system-marker-/projects/cave-alpha.cvproj"]');
      await expect(alphaMarker).toBeVisible();
    });

    test('should display project count indicator', async ({ page }) => {
      // Look for the system count indicator
      await expect(page.locator('text=3 systems on map')).toBeVisible({ timeout: 5000 });
    });

    test('should have Fit All button', async ({ page }) => {
      const fitButton = page.locator('button:has-text("Fit All")');
      await expect(fitButton).toBeVisible();
    });
  });

  test.describe('Map Interactions', () => {
    test.beforeEach(async ({ page }) => {
      const mapTab = page.locator('[data-testid="globalview-map-tab"]');
      await mapTab.click();
      await page.waitForSelector('[data-testid="globalview-map"]', { timeout: 5000 });
      await page.waitForTimeout(1000); // Wait for markers
    });

    test('should select project on marker click', async ({ page }) => {
      // Click on a marker
      const marker = page.locator('[data-testid="system-marker-/projects/cave-alpha.cvproj"]');
      await marker.click();

      // Marker should change to selected style (blue background)
      await expect(marker).toHaveCSS('background-color', 'rgb(59, 130, 246)'); // #3b82f6
    });

    test('should show popup on marker hover', async ({ page }) => {
      const marker = page.locator('[data-testid="system-marker-/projects/cave-alpha.cvproj"]');

      // Hover over marker
      await marker.hover();

      // Popup should appear with project name
      await expect(page.locator('.maplibregl-popup')).toBeVisible({ timeout: 2000 });
      await expect(page.locator('.maplibregl-popup')).toContainText('Cave System Alpha');
    });

    test('should open project on marker double-click', async ({ page }) => {
      const marker = page.locator('[data-testid="system-marker-/projects/cave-alpha.cvproj"]');

      // Double-click on marker
      await marker.dblclick();

      // Should transition to SingleSystemView (map canvas)
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('List View Content', () => {
    test('should display all projects in List view', async ({ page }) => {
      // Should show all 4 projects (including one without GPS)
      await expect(page.locator('h3:has-text("Cave System Alpha")')).toBeVisible();
      await expect(page.locator('h3:has-text("Underwater Cave Beta")')).toBeVisible();
      await expect(page.locator('h3:has-text("Deep Cave Gamma")')).toBeVisible();
      await expect(page.locator('h3:has-text("Local Survey (No GPS)")')).toBeVisible();
    });

    test('should open project when double-clicking on card', async ({ page }) => {
      // Double-click on a project card to open it
      await page.locator('h3:has-text("Cave System Alpha")').dblclick();

      // Should transition to SingleSystemView
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10000 });
    });

    test('should select project on single click (for metadata panel)', async ({ page }) => {
      // Single click on a project card to select it
      const card = page.locator('[data-testid="system-card-/projects/cave-alpha.cvproj"]');
      await card.click();

      // Card should show selected state
      await expect(card).toHaveClass(/ring-accent/);
    });
  });
});
