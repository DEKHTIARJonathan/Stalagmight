import { test, expect } from './fixtures/coverage';
import { setupMockedPage } from './helpers/app';

test.describe('GlobalView Metadata Panel', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await expect(page.getByTestId('global-view')).toBeVisible({ timeout: 10000 });
  });

  test.describe('Panel Visibility', () => {
    test('should display metadata panel when projects exist', async ({ page }) => {
      // The metadata panel should be visible (may be showing "Select a project" message)
      const panel = page.locator('[data-testid="metadata-panel"]');
      await expect(panel).toBeVisible({ timeout: 5000 });
    });

    test('should show empty state when no project is selected', async ({ page }) => {
      const emptyState = page.locator('[data-testid="metadata-panel-empty"]');
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toContainText('Select a project to see details');
    });
  });

  test.describe('Project Selection from List', () => {
    test('should show project details when card is clicked', async ({ page }) => {
      // Click on a system card to select it
      const card = page.locator('[data-testid="system-card-/projects/cave-alpha.stalx"]');
      await card.click();

      // Wait for metadata to appear
      const metadataName = page.locator('[data-testid="metadata-name"]');
      await expect(metadataName).toBeVisible({ timeout: 5000 });
      await expect(metadataName).toContainText('Cave System Alpha');
    });

    test('should display all metadata fields for selected project', async ({ page }) => {
      // Select the first project
      const card = page.locator('[data-testid="system-card-/projects/cave-alpha.stalx"]');
      await card.click();

      // Check all metadata fields
      await expect(page.locator('[data-testid="metadata-name"]')).toContainText('Cave System Alpha');
      await expect(page.locator('[data-testid="metadata-location"]')).toContainText('Yucatan, Mexico');
      await expect(page.locator('[data-testid="metadata-file-path"]')).toContainText('/projects/cave-alpha.stalx');
      await expect(page.locator('[data-testid="metadata-sections"]')).toContainText('5');
      await expect(page.locator('[data-testid="metadata-length"]')).toBeVisible();
      await expect(page.locator('[data-testid="metadata-gps"]')).toBeVisible();
    });

    test('should show selected state on card', async ({ page }) => {
      const card = page.locator('[data-testid="system-card-/projects/cave-alpha.stalx"]');
      await card.click();

      // Card should have ring class indicating selection
      await expect(card).toHaveClass(/ring-accent/);
    });

    test('should update metadata when different card is selected', async ({ page }) => {
      // Select first project
      const alphaCard = page.locator('[data-testid="system-card-/projects/cave-alpha.stalx"]');
      await alphaCard.click();
      await expect(page.locator('[data-testid="metadata-name"]')).toContainText('Cave System Alpha');

      // Select second project
      const betaCard = page.locator('[data-testid="system-card-/projects/cave-beta.stalx"]');
      await betaCard.click();
      await expect(page.locator('[data-testid="metadata-name"]')).toContainText('Underwater Cave Beta');
      await expect(page.locator('[data-testid="metadata-location"]')).toContainText('Florida, USA');
    });
  });

  test.describe('Project Selection from Map', () => {
    test.beforeEach(async ({ page }) => {
      // Switch to Map tab
      const mapTab = page.locator('[data-testid="globalview-map-tab"]');
      await mapTab.click();
      await expect(page.getByTestId('globalview-map')).toBeVisible({ timeout: 5000 });

      // Switch to markers mode so markers stay visible (survey mode hides
      // markers once geometry loads, which can cause flaky click failures)
      const toggle = page.getByTestId('view-mode-toggle');
      await expect(toggle).toBeVisible({ timeout: 5000 });
      await toggle.click();

      await expect(page.locator('.globalview-system-marker')).toHaveCount(3, { timeout: 5000 });
    });

    test('should show project details when map marker is clicked', async ({ page }) => {
      // Click on a marker (in markers mode, all markers are reliably visible)
      const marker = page.locator('[data-testid="system-marker-/projects/cave-alpha.stalx"]');
      await marker.click();

      // Wait for metadata to appear
      const metadataName = page.locator('[data-testid="metadata-name"]');
      await expect(metadataName).toBeVisible({ timeout: 5000 });
      await expect(metadataName).toContainText('Cave System Alpha');
    });
  });

  test.describe('Panel Actions', () => {
    test.beforeEach(async ({ page }) => {
      // Select a project first
      const card = page.locator('[data-testid="system-card-/projects/cave-alpha.stalx"]');
      await card.click();
      await page.waitForSelector('[data-testid="metadata-name"]', { timeout: 5000 });
    });

    test('should have Open Project button', async ({ page }) => {
      const openButton = page.locator('[data-testid="metadata-open-button"]');
      await expect(openButton).toBeVisible();
      await expect(openButton).toContainText('Open project');
    });

    test('should have Show in Folder button', async ({ page }) => {
      const folderButton = page.locator('[data-testid="metadata-show-folder-button"]');
      await expect(folderButton).toBeVisible();
      await expect(folderButton).toContainText('Show in folder');
    });

    test('should have Remove from Recent button', async ({ page }) => {
      const removeButton = page.locator('[data-testid="metadata-remove-button"]');
      await expect(removeButton).toBeVisible();
      await expect(removeButton).toContainText('Remove from recent');
    });

    test('should open project when Open Project button is clicked', async ({ page }) => {
      const openButton = page.locator('[data-testid="metadata-open-button"]');
      await openButton.click();

      // Should transition to SingleSystemView (indicated by canvas being visible)
      await expect(page.getByTestId('map-canvas')).toBeVisible({ timeout: 10000 });
    });

    test('should have correct aria-label on action buttons', async ({ page }) => {
      const openButton = page.locator('[data-testid="metadata-open-button"]');
      await expect(openButton).toHaveAttribute('aria-label', /Open Cave System Alpha/);

      const folderButton = page.locator('[data-testid="metadata-show-folder-button"]');
      await expect(folderButton).toHaveAttribute('aria-label', /Show Cave System Alpha in folder/);

      const removeButton = page.locator('[data-testid="metadata-remove-button"]');
      await expect(removeButton).toHaveAttribute('aria-label', /Remove Cave System Alpha from recent/);
    });
  });

  test.describe('Panel Collapse/Expand', () => {
    test('should collapse panel when collapse button is clicked', async ({ page }) => {
      // Panel should start expanded
      const panel = page.locator('[data-testid="metadata-panel"]');
      await expect(panel).toBeVisible();

      // Click collapse button
      const collapseButton = page.locator('[data-testid="metadata-panel-collapse-button"]');
      await collapseButton.click();

      // Panel should be collapsed (showing collapsed variant)
      const collapsedPanel = page.locator('[data-testid="metadata-panel-collapsed"]');
      await expect(collapsedPanel).toBeVisible();
      await expect(panel).not.toBeVisible();
    });

    test('should expand panel when expand button is clicked', async ({ page }) => {
      // Collapse first
      const collapseButton = page.locator('[data-testid="metadata-panel-collapse-button"]');
      await collapseButton.click();

      // Click expand button
      const expandButton = page.locator('[data-testid="metadata-panel-expand-button"]');
      await expect(expandButton).toBeVisible();
      await expandButton.click();

      // Panel should be expanded again
      const panel = page.locator('[data-testid="metadata-panel"]');
      await expect(panel).toBeVisible();
    });

    test('should have correct aria-expanded state', async ({ page }) => {
      const collapseButton = page.locator('[data-testid="metadata-panel-collapse-button"]');
      await expect(collapseButton).toHaveAttribute('aria-expanded', 'true');

      await collapseButton.click();

      const expandButton = page.locator('[data-testid="metadata-panel-expand-button"]');
      await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    });
  });

  test.describe('Panel Accessibility', () => {
    test('should have complementary role', async ({ page }) => {
      const panel = page.locator('[data-testid="metadata-panel"]');
      await expect(panel).toHaveAttribute('role', 'complementary');
    });

    test('should have accessible label', async ({ page }) => {
      const panel = page.locator('[data-testid="metadata-panel"]');
      await expect(panel).toHaveAttribute('aria-label', 'Project metadata panel');
    });

    test('should have heading for the panel', async ({ page }) => {
      const heading = page.locator('#metadata-panel-title');
      await expect(heading).toBeVisible();
      await expect(heading).toContainText('Project details');
    });
  });

  test.describe('GPS Display', () => {
    test('should display GPS coordinates when project has GPS', async ({ page }) => {
      // Select a project with GPS
      const card = page.locator('[data-testid="system-card-/projects/cave-alpha.stalx"]');
      await card.click();

      const gpsField = page.locator('[data-testid="metadata-gps"]');
      await expect(gpsField).toBeVisible();
      // Should show formatted GPS (not "Not set")
      await expect(gpsField).not.toContainText('Not specified');
    });

    test('should display "Not set" when project has no GPS', async ({ page }) => {
      // Select the project without GPS
      const card = page.locator('[data-testid="system-card-/projects/local-survey.stalx"]');
      await card.click();

      const gpsField = page.locator('[data-testid="metadata-gps"]');
      await expect(gpsField).toBeVisible();
      await expect(gpsField).toContainText('Not specified');
    });
  });

  test.describe('Formatting', () => {
    test('should format length in km for large values', async ({ page }) => {
      // Select a project with large length
      const card = page.locator('[data-testid="system-card-/projects/cave-alpha.stalx"]');
      await card.click();

      const lengthField = page.locator('[data-testid="metadata-length"]');
      await expect(lengthField).toBeVisible();
      // 1250.5m should be formatted as km
      await expect(lengthField).toContainText('km');
    });
  });
});
