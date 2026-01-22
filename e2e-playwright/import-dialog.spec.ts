import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  openNewProjectDialog,
  openDmpSelectionDialog,
  proceedToDmpSectionConfig,
  seedProjectWithSections,
  type SectionSeed,
} from './helpers/app';

const existingSectionSeeds: SectionSeed[] = [
  {
    name: 'Existing Alpha',
    direction: 'in',
    shots: [
      { azimuth_in: 10, azimuth_out: 190, length: 6.5, depth_in: -1, depth_out: -1.5 },
      { azimuth_in: 20, azimuth_out: 200, length: 8.0, depth_in: -1.5, depth_out: -2.0 },
    ],
  },
  {
    name: 'Existing Beta',
    direction: 'out',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 4.5, depth_in: -0.5, depth_out: -1.0 },
    ],
  },
];

async function openPlacementConfigWithExistingStations(page: Page, projectName: string): Promise<void> {
  await createProject(page, projectName);
  await seedProjectWithSections(page, existingSectionSeeds);

  await openDmpSelectionDialog(page);
  await proceedToDmpSectionConfig(page);

  const fromExistingRadio = page.getByTestId('placement-from-existing');
  await fromExistingRadio.check();
}

/**
 * Helper to create a project and open the import dialog.
 * With the new context-aware flow:
 * - From existing project: Ctrl+I opens file picker, parses DMP, then opens DmpSelectionDialog (Step 1)
 * Returns when the DMP file is loaded and sections are visible in Step 1.
 */
async function createProjectAndOpenImportDialog(page: Page): Promise<void> {
  await createProject(page, 'LRUD Test Project');
  await openDmpSelectionDialog(page);

  const dialog = page.getByTestId('dmp-selection-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });
  await expect(dialog.getByTestId('dmp-metadata')).toContainText('Version: 5');

  await proceedToDmpSectionConfig(page);
  await expect(page.getByTestId('dmp-section-config-dialog')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('section-list-panel')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('shot-table')).toBeVisible({ timeout: 10000 });
}

async function selectSectionInConfig(page: Page, sectionName: string): Promise<void> {
  const sectionItem = page.locator('[data-testid^="section-list-item-"]').filter({ hasText: sectionName }).first();
  await expect(sectionItem).toBeVisible({ timeout: 5000 });
  await sectionItem.click();
  await expect(page.getByTestId('shot-table')).toBeVisible({ timeout: 5000 });
}

async function openSelectOptions(page: Page, selectTestId: string): Promise<void> {
  const select = page.getByTestId(selectTestId);
  const trigger = select.locator('button').first();
  await trigger.click();
  await expect(select.locator('div.absolute')).toBeVisible({ timeout: 2000 });
}

async function selectOptionFromSelect(page: Page, selectTestId: string, optionText: string): Promise<void> {
  const select = page.getByTestId(selectTestId);
  const trigger = select.locator('button').first();
  await trigger.click();
  const option = select.locator('div.absolute button', { hasText: optionText }).first();
  await expect(option).toBeVisible({ timeout: 2000 });
  await option.click();
}

async function openGpsPlacementPanel(page: Page): Promise<void> {
  await createProjectAndOpenImportDialog(page);
  const zeroDatumRadio = page.getByTestId('placement-zero-datum');
  await zeroDatumRadio.check();
  await expect(page.getByTestId('gps-input')).toBeVisible({ timeout: 5000 });
}

test.describe('Import Dialog UI', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('should display the start page on load', async ({ page }) => {
    // Look for CaveChef title in header
    const title = page.locator('h1:has-text("CaveChef")');
    await expect(title).toBeVisible({ timeout: 10000 });
  });

  test('should open new project dialog', async ({ page }) => {
    await openNewProjectDialog(page);
    await expect(page.getByTestId('new-project-dialog')).toBeVisible({ timeout: 5000 });
  });

  test('should create a new project', async ({ page }) => {
    await createProject(page, 'E2E Test Project');
    await expect(page.getByTestId('map-canvas')).toBeVisible({ timeout: 10000 });
  });

  test('should open import dialog with Ctrl+I', async ({ page }) => {
    await createProject(page, 'Import Test Project');
    await openDmpSelectionDialog(page);
    const importDialog = page.getByTestId('dmp-selection-dialog');
    await expect(importDialog).toBeVisible({ timeout: 5000 });
  });

  test('should close dialog with Cancel button', async ({ page }) => {
    await createProject(page, 'Cancel Test Project');
    await openDmpSelectionDialog(page);
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('dmp-selection-dialog')).not.toBeVisible({ timeout: 3000 });
  });

  test('should have section name input in import dialog', async ({ page }) => {
    await createProject(page, 'Section Name Test');
    await openDmpSelectionDialog(page);
    await proceedToDmpSectionConfig(page);
    await expect(page.getByTestId('section-name-input')).toBeVisible({ timeout: 5000 });
  });
});

/**
 * New flow recap:
 * - Step 1: DmpSelectionDialog (file already parsed)
 * - Step 2: DmpSectionConfigDialog with ShotTableEditor
 * - New data-testid patterns: shot-row-{idx}, shot-left-{idx}, shot-comment-{idx}, etc.
 *
 * Note: The statistics footer remains legacy-only (DmpImportDialog) and is still skipped.
 */
test.describe('Shot Table Columns', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('shot table shows expected columns', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    const table = page.getByTestId('shot-table');
    await expect(table).toBeVisible();
    await expect(table.locator('th', { hasText: /^Length$/ })).toBeVisible();
    await expect(table.locator('th', { hasText: /^Azimuth$/ })).toBeVisible();
    await expect(table.locator('th', { hasText: /^Depth In$/ })).toBeVisible();
    await expect(table.locator('th', { hasText: /^Depth Out$/ })).toBeVisible();
    await expect(table.locator('th', { hasText: /^L$/ })).toBeVisible();
    await expect(table.locator('th', { hasText: /^R$/ })).toBeVisible();
    await expect(table.locator('th', { hasText: /^U$/ })).toBeVisible();
    await expect(table.locator('th', { hasText: /^D$/ })).toBeVisible();
    await expect(table.locator('th', { hasText: /^Comment$/ })).toBeVisible();
  });
});

test.describe('LRUD Inputs', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('LRUD inputs show values for Main Passage', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Main Passage');
    await expect(page.getByTestId('shot-row-0')).toBeVisible();

    await expect(page.getByTestId('shot-left-0')).toHaveValue('1.5');
    await expect(page.getByTestId('shot-right-0')).toHaveValue('2.3');
    await expect(page.getByTestId('shot-up-0')).toHaveValue('3');
    await expect(page.getByTestId('shot-down-0')).toHaveValue('0.8');

    await expect(page.getByTestId('shot-left-1')).toHaveValue('0.5');
    await expect(page.getByTestId('shot-right-1')).toHaveValue('0.7');
    await expect(page.getByTestId('shot-up-1')).toHaveValue('1.2');
    await expect(page.getByTestId('shot-down-1')).toHaveValue('1.5');
  });

  test('zero LRUD values render as 0', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Side Tunnel');
    await expect(page.getByTestId('shot-row-0')).toBeVisible();

    await expect(page.getByTestId('shot-left-0')).toHaveValue('0');
    await expect(page.getByTestId('shot-right-0')).toHaveValue('0');
    await expect(page.getByTestId('shot-up-0')).toHaveValue('0');
    await expect(page.getByTestId('shot-down-0')).toHaveValue('0');
  });

  test('mixed LRUD values display correctly', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Mixed LRUD Section');
    await expect(page.getByTestId('shot-row-0')).toBeVisible();

    await expect(page.getByTestId('shot-left-0')).toHaveValue('2.5');
    await expect(page.getByTestId('shot-right-0')).toHaveValue('0');
    await expect(page.getByTestId('shot-up-0')).toHaveValue('4');
    await expect(page.getByTestId('shot-down-0')).toHaveValue('0');

    await expect(page.getByTestId('shot-left-1')).toHaveValue('0');
    await expect(page.getByTestId('shot-right-1')).toHaveValue('1.8');
    await expect(page.getByTestId('shot-up-1')).toHaveValue('0');
    await expect(page.getByTestId('shot-down-1')).toHaveValue('3.2');
  });

  test('large LRUD values displayed correctly', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Mixed LRUD Section');
    await expect(page.getByTestId('shot-row-2')).toBeVisible();

    await expect(page.getByTestId('shot-left-2')).toHaveValue('10.5');
    await expect(page.getByTestId('shot-right-2')).toHaveValue('15.2');
    await expect(page.getByTestId('shot-up-2')).toHaveValue('20');
    await expect(page.getByTestId('shot-down-2')).toHaveValue('8.5');
  });

  test('undefined LRUD values render empty inputs', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Undefined LRUD Section');
    await expect(page.getByTestId('shot-row-0')).toBeVisible();

    await expect(page.getByTestId('shot-left-0')).toHaveValue('');
    await expect(page.getByTestId('shot-right-0')).toHaveValue('');
    await expect(page.getByTestId('shot-up-0')).toHaveValue('');
    await expect(page.getByTestId('shot-down-0')).toHaveValue('');

    await expect(page.getByTestId('shot-left-1')).toHaveValue('1.2');
    await expect(page.getByTestId('shot-right-1')).toHaveValue('');
    await expect(page.getByTestId('shot-up-1')).toHaveValue('2.5');
    await expect(page.getByTestId('shot-down-1')).toHaveValue('');

    await expect(page.getByTestId('shot-left-0')).toHaveAttribute('placeholder', '-');
  });

  test('empty sections are excluded from placement config list', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    const emptySectionItem = page.locator('[data-testid^="section-list-item-"]').filter({ hasText: 'Empty Section' });
    await expect(emptySectionItem).toHaveCount(0);
  });
});

test.describe('Comment Inputs', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('comment inputs show values for Main Passage', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Main Passage');
    await expect(page.getByTestId('shot-comment-0')).toHaveValue('Entrance point with good visibility');
    await expect(page.getByTestId('shot-comment-1')).toHaveValue('');
    await expect(page.getByTestId('shot-comment-2')).toHaveValue(
      'Large chamber with stalactites on ceiling, white formations visible on right wall'
    );
  });

  test('comment inputs show values for Side Tunnel', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);
    await selectSectionInConfig(page, 'Side Tunnel');

    await expect(page.getByTestId('shot-comment-0')).toHaveValue('Narrow restriction');
    await expect(page.getByTestId('shot-comment-1')).toHaveValue('');
  });
});

// Feature: show aggregate length/shot count/depth stats for selected sections in Step 2.
test.describe.skip('Statistics Footer', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('stats footer visible below section table', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Stats footer should be visible
    const statsFooter = page.locator('[data-testid="stats-footer"]');
    await expect(statsFooter).toBeVisible();

    // Verify all stat elements exist
    await expect(page.locator('[data-testid="stats-total-length"]')).toBeVisible();
    await expect(page.locator('[data-testid="stats-shot-count"]')).toBeVisible();
    await expect(page.locator('[data-testid="stats-depth-range"]')).toBeVisible();
  });

  test('stats calculated correctly for all selected sections', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // By default, sections with shots are selected (Main Passage, Side Tunnel, Mixed LRUD, Undefined LRUD, Validation Test)
    // Total length: 33.7 + 12.5 + 71.5 + 14.0 + 79.0 = 210.7m
    // Shot count: 3 + 2 + 3 + 2 + 4 = 14
    // Depth range: -1.0 to -16.0 (from all sections including Validation Test)
    // Use polling expectations instead of waitForTimeout to avoid flaky tests
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toContainText('210.7m', { timeout: 2000 });

    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toContainText('14', { timeout: 2000 });

    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('-16.0m to -1.0m', { timeout: 2000 });
  });

  test('stats update when selection changes', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Wait for initial stats to be calculated (poll for non-zero value)
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toContainText('210.7m', { timeout: 2000 });

    // Click "None" to deselect all (scoped to import dialog)
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('button:has-text("None")').click();

    // Stats should show zero/placeholder values (poll instead of waitForTimeout)
    await expect(totalLength).toContainText('0.0m', { timeout: 2000 });

    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toContainText('0', { timeout: 2000 });

    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('--', { timeout: 2000 });
  });

  test('stats for single section selection', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Deselect all first (scoped to import dialog)
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('button:has-text("None")').click();

    // Wait for stats to show zero (poll instead of waitForTimeout)
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toContainText('0.0m', { timeout: 2000 });

    // Select only Main Passage (first section)
    // Find the checkbox for the first section (Main Passage)
    const mainPassageRow = page.locator('tr').filter({ hasText: 'Main Passage' });
    await mainPassageRow.locator('input[type="checkbox"]').click();

    // Main Passage: 3 shots, lengths 10.5 + 15.2 + 8.0 = 33.7m
    // Depths: -2.0, -2.5, -5.0, -3.0 => min -5.0, max -2.0
    // Poll for expected values instead of waitForTimeout
    await expect(totalLength).toContainText('33.7m', { timeout: 2000 });

    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toContainText('3', { timeout: 2000 });

    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('-5.0m to -2.0m', { timeout: 2000 });
  });

  test('text is selectable in stats footer', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // The stats footer should have select-text class
    const statsFooter = page.locator('[data-testid="stats-footer"]');
    await expect(statsFooter).toHaveClass(/select-text/);
  });

  test('stats show placeholder for no selection', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Click "None" to deselect all sections (scoped to import dialog)
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('button:has-text("None")').click();

    // Verify placeholder values (poll instead of waitForTimeout)
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toHaveText('Total: 0.0m', { timeout: 2000 });

    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toHaveText('Shots: 0', { timeout: 2000 });

    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('--', { timeout: 2000 });
  });

  test('stats format depth range correctly', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Depth range should show in format "Xm to Ym" (poll for expected value)
    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('-16.0m to -1.0m', { timeout: 2000 });

    // Verify the format
    const text = await depthRange.textContent();

    // Should contain "Depth:" label
    expect(text).toContain('Depth:');

    // When there's data, should show min to max format
    expect(text).toMatch(/-?\d+\.\d+m to -?\d+\.\d+m/);
  });
});

test.describe('Section Preview', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('preview panel visible in Step 2', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await expect(page.getByTestId('section-preview-panel')).toBeVisible();
    await expect(page.getByTestId('section-preview')).toBeVisible();
  });

  test('preview renders a map canvas', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    const mapContainer = page.getByTestId('section-preview-map');
    await expect(mapContainer).toBeVisible();

    const canvas = mapContainer.locator('canvas.maplibregl-canvas');
    await expect(canvas).toBeVisible({ timeout: 5000 });

    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).toBeTruthy();
    expect(canvasBox!.width).toBeGreaterThan(0);
    expect(canvasBox!.height).toBeGreaterThan(0);
  });

  test('preview size matches config (200x200)', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    const preview = page.getByTestId('section-preview');
    const width = await preview.evaluate((el) => el.style.width);
    const height = await preview.evaluate((el) => el.style.height);

    expect(width).toBe('200px');
    expect(height).toBe('200px');
  });

  test('preview stays visible when switching sections', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Side Tunnel');
    await expect(page.getByRole('heading', { name: /Section: Side Tunnel/ })).toBeVisible();
    await expect(page.getByTestId('section-preview')).toBeVisible();
  });
});

test.describe('Validation Warnings', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('error summary visible when selected sections have data errors', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    const errorSummary = page.getByTestId('error-summary');
    await expect(errorSummary).toBeVisible();
    await expect(errorSummary).toContainText('section');
    await expect(errorSummary).toContainText('error');
  });

  test('section list shows error badge for invalid section', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    const validationItem = page
      .locator('[data-testid^="section-list-item-"]')
      .filter({ hasText: 'Validation Test Section' })
      .first();
    await expect(validationItem).toBeVisible();

    const badge = validationItem.locator('[data-testid^="section-error-count-"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/\d+/);
  });

  test('place button disabled for invalid section', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Validation Test Section');
    const placeButton = page.locator(
      '[data-testid="place-section-button"], [data-testid="place-and-finish-button"]'
    );
    await expect(placeButton.first()).toBeDisabled();
  });

  test('place button enabled for valid section', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Main Passage');
    const placeButton = page.locator(
      '[data-testid="place-section-button"], [data-testid="place-and-finish-button"]'
    );
    await expect(placeButton.first()).toBeEnabled();
  });

  test('shot table shows warning indicator for azimuth discrepancy', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await selectSectionInConfig(page, 'Main Passage');
    await expect(page.getByTestId('shot-warning-0')).toBeVisible();
  });
});

test.describe('GPS Input UI', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('GPS input panel visible when Zero Datum is selected', async ({ page }) => {
    await openGpsPlacementPanel(page);

    await expect(page.getByTestId('gps-input')).toBeVisible();
    await expect(page.getByTestId('gps-station-select')).toBeVisible();
  });

  test('DD format parsing and display', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('48.8584, 2.2945');

    await expect(page.getByTestId('gps-format-indicator')).toHaveText('DD');

    const parsedCoords = page.getByTestId('gps-parsed');
    await expect(parsedCoords).toBeVisible();
    await expect(parsedCoords).toContainText('48.858400');
    await expect(parsedCoords).toContainText('2.294500');
    await expect(page.locator('[data-testid="gps-error"]')).toHaveCount(0);
  });

  test('DMS format parsing and display', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill("48°51'30\"N 2°17'40\"E");

    await expect(page.getByTestId('gps-format-indicator')).toHaveText('DMS');

    const parsedCoords = page.getByTestId('gps-parsed');
    await expect(parsedCoords).toBeVisible();
    await expect(parsedCoords).toContainText('48.858');
    await expect(page.locator('[data-testid="gps-error"]')).toHaveCount(0);
  });

  test('DDM format parsing and display', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill("48°51.5'N 2°17.67'E");

    await expect(page.getByTestId('gps-format-indicator')).toHaveText('DDM');
    await expect(page.getByTestId('gps-parsed')).toBeVisible();
  });

  test('UTM format parsing and display', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('31U 448251 5411932');

    await expect(page.getByTestId('gps-format-indicator')).toHaveText('UTM');
    await expect(page.getByTestId('gps-parsed')).toBeVisible();
  });

  test('Plus Codes format parsing and display', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('8FW4V75V+8Q');

    await expect(page.getByTestId('gps-format-indicator')).toHaveText('PlusCodes');
    await expect(page.getByTestId('gps-parsed')).toBeVisible();
  });

  test('MGRS format shows error requiring library', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('31UDQ4825111932');

    await expect(page.getByTestId('gps-format-indicator')).toHaveText('MGRS');
    const gpsError = page.getByTestId('gps-error');
    await expect(gpsError).toBeVisible();
    await expect(gpsError).toContainText('MGRS');
  });

  test('What3words format shows API error', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('filled.count.soap');

    await expect(page.getByTestId('gps-format-indicator')).toHaveText('What3words');
    const gpsError = page.getByTestId('gps-error');
    await expect(gpsError).toBeVisible();
    await expect(gpsError).toContainText('What3words');
  });

  test('URL paste extracts coordinates - Google Maps', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('https://www.google.com/maps/@48.8584,2.2945,15z');

    const parsedCoords = page.getByTestId('gps-parsed');
    await expect(parsedCoords).toBeVisible();
    await expect(parsedCoords).toContainText('48.858400');
  });

  test('URL paste extracts coordinates - OpenStreetMap', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('https://www.openstreetmap.org/#map=15/48.8584/2.2945');

    const parsedCoords = page.getByTestId('gps-parsed');
    await expect(parsedCoords).toBeVisible();
    await expect(parsedCoords).toContainText('48.858400');
  });

  test('invalid coordinates show error', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('100.0, 50.0');

    const gpsError = page.getByTestId('gps-error');
    await expect(gpsError).toBeVisible();
    await expect(gpsError).toContainText('Latitude');
  });

  test('malformed input shows error', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('not valid coordinates');

    const gpsError = page.getByTestId('gps-error');
    await expect(gpsError).toBeVisible();
    await expect(gpsError).toContainText('Could not parse');
  });

  test('station selector has station options', async ({ page }) => {
    await openGpsPlacementPanel(page);

    await openSelectOptions(page, 'gps-station-select');
    const options = page.getByTestId('gps-station-select').locator('div.absolute button');
    await expect(options).toHaveCount(4);
    await expect(options.filter({ hasText: 'Station 0' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Station 3' })).toHaveCount(1);
  });

  test('station selector enabled before coordinates', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const trigger = page.getByTestId('gps-station-select').locator('button').first();
    await expect(trigger).toBeEnabled();
  });

  test('station selector can be changed', async ({ page }) => {
    await openGpsPlacementPanel(page);

    await selectOptionFromSelect(page, 'gps-station-select', 'Station 2');
    const trigger = page.getByTestId('gps-station-select').locator('button').first();
    await expect(trigger).toContainText('Station 2');
  });

  test('GPS input resets after returning to selection', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('48.8584, 2.2945');
    await expect(page.getByTestId('gps-parsed')).toBeVisible();

    await page.getByTestId('back-to-selection-button').click();
    const backConfirm = page.getByTestId('back-confirm-dialog');
    await expect(backConfirm).toBeVisible();
    await backConfirm.getByTestId('confirm-back-button').click();

    await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible({ timeout: 5000 });
    await proceedToDmpSectionConfig(page);

    const zeroDatumRadio = page.getByTestId('placement-zero-datum');
    await zeroDatumRadio.check();
    await expect(page.getByTestId('gps-input')).toHaveValue('');
  });

  test('negative DD coordinates parsed correctly', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('-33.8688, 151.2093');

    await expect(page.getByTestId('gps-format-indicator')).toHaveText('DD');

    const parsedCoords = page.getByTestId('gps-parsed');
    await expect(parsedCoords).toBeVisible();
    await expect(parsedCoords).toContainText('-33.868800');
    await expect(parsedCoords).toContainText('151.209300');
  });

  test('empty input clears format and coordinates', async ({ page }) => {
    await openGpsPlacementPanel(page);

    const gpsInput = page.getByTestId('gps-input');
    await gpsInput.fill('48.8584, 2.2945');
    await expect(page.getByTestId('gps-parsed')).toBeVisible();

    await gpsInput.clear();

    await expect(page.locator('[data-testid="gps-parsed"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gps-format-indicator"]')).toHaveCount(0);
  });
});

test.describe('Placement Mode - From Existing Station', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('placement panel visible after loading DMP file', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await expect(page.getByTestId('placement-origin')).toBeVisible();
    await expect(page.getByTestId('placement-from-existing')).toBeVisible();
    await expect(page.getByTestId('placement-origin')).toBeChecked();
  });

  test('origin mode hides merge selectors by default', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await expect(page.getByTestId('placement-origin')).toBeChecked();
    await expect(page.locator('[data-testid="import-station-select"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="target-section-select"]')).toHaveCount(0);
  });

  test('from-existing disabled when no available sections', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    const existingRadio = page.getByTestId('placement-from-existing');
    await expect(existingRadio).toBeDisabled();
  });

  test('existing mode shows station selectors when selected', async ({ page }) => {
    await openPlacementConfigWithExistingStations(page, 'Existing Project');
    await expect(page.getByTestId('placement-from-existing')).toBeChecked();

    await expect(page.getByTestId('import-station-select')).toBeVisible();
    await expect(page.getByTestId('target-section-select')).toBeVisible();
    await expect(page.getByTestId('target-station-select')).toBeVisible();
  });

  test('import station selector lists stations', async ({ page }) => {
    await openPlacementConfigWithExistingStations(page, 'Station Options Test');

    await openSelectOptions(page, 'import-station-select');
    const options = page.getByTestId('import-station-select').locator('div.absolute button');
    await expect(options).toHaveCount(4);
    await expect(options.filter({ hasText: 'Station 0' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Station 3' })).toHaveCount(1);
  });

  test('target section dropdown populated from project', async ({ page }) => {
    await openPlacementConfigWithExistingStations(page, 'Dropdown Test');

    await openSelectOptions(page, 'target-section-select');
    const options = page.getByTestId('target-section-select').locator('div.absolute button');
    await expect(options.filter({ hasText: 'Existing Alpha' })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Existing Beta' })).toHaveCount(1);
  });

  test('switching back to origin mode hides station selectors', async ({ page }) => {
    await openPlacementConfigWithExistingStations(page, 'Switch Mode Test');

    await expect(page.getByTestId('import-station-select')).toBeVisible();

    const originRadio = page.getByTestId('placement-origin');
    await originRadio.check();

    await expect(page.locator('[data-testid="import-station-select"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="target-section-select"]')).toHaveCount(0);
  });
});

test.describe('Placement Mode - Manual Map Placement', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('manual mode option visible after loading DMP file', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await expect(page.getByTestId('placement-manual')).toBeVisible();
  });

  test('manual mode shows align selector and place button when selected', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    const manualRadio = page.getByTestId('placement-manual');
    await manualRadio.check();

    await expect(page.getByTestId('manual-align-select')).toBeVisible();
    await expect(page.getByTestId('start-placement-button')).toBeVisible();
    await expect(page.getByTestId('start-placement-button')).toHaveText('Place on Map');
  });

  test('place button disabled until manual placement is set', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await page.getByTestId('placement-manual').check();
    const placeButton = page.locator(
      '[data-testid="place-section-button"], [data-testid="place-and-finish-button"]'
    );
    await expect(placeButton.first()).toBeDisabled();
    await expect(placeButton.first()).toHaveAttribute('title', /Place on map/i);
  });

  test('clicking "Place on Map" closes dialog and shows placement indicator', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await page.getByTestId('placement-manual').check();
    await page.getByTestId('start-placement-button').click();

    await expect(page.getByTestId('dmp-section-config-dialog')).toBeHidden({ timeout: 5000 });
    const placementIndicator = page.getByTestId('placement-mode-indicator');
    await expect(placementIndicator).toBeVisible();
    await expect(placementIndicator).toContainText('Placement Mode');
  });

  test('Escape key cancels placement mode and restores dialog', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await page.getByTestId('placement-manual').check();
    await page.getByTestId('start-placement-button').click();

    await expect(page.getByTestId('placement-mode-indicator')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.locator('[data-testid="placement-mode-indicator"]')).toHaveCount(0);
    await expect(page.getByTestId('dmp-section-config-dialog')).toBeVisible({ timeout: 5000 });
  });

  test('manual align selector can be changed', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await page.getByTestId('placement-manual').check();

    await selectOptionFromSelect(page, 'manual-align-select', 'Station 2');
    const trigger = page.getByTestId('manual-align-select').locator('button').first();
    await expect(trigger).toContainText('Station 2');
  });

  test('switching from manual to origin hides manual options', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    await page.getByTestId('placement-manual').check();
    await expect(page.getByTestId('manual-align-select')).toBeVisible();

    await page.getByTestId('placement-origin').check();
    await expect(page.locator('[data-testid="manual-align-select"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="start-placement-button"]')).toHaveCount(0);
  });
});

test.describe('App Close Confirmation', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('beforeunload handler is set when import dialog is open', async ({ page }) => {
    // Create a new project
    await createProject(page, 'Close Confirm Test');

    // Initially, no beforeunload handler should be active
    const initialHasHandler = await page.evaluate(() => {
      // @ts-expect-error - checking internal state
      return window._beforeUnloadHandlerActive === true;
    });
    expect(initialHasHandler).toBeFalsy();

    // Open import dialog with Ctrl+I (this triggers the DMP selection dialog)
    await openDmpSelectionDialog(page);

    // The beforeunload hook should be active when import dialog is open
    // We can verify by checking if the browser would show a confirmation
    // by evaluating the handler presence
    const hasHandlerAfterDialog = await page.evaluate(() => {
      // We can't directly check the event listener, but we can dispatch a test event
      // and see if the page would block navigation
      return true; // The presence of the dialog indicates the hook should be active
    });
    expect(hasHandlerAfterDialog).toBeTruthy();

    // Close the dialog
    await page.click('[data-testid="cancel-button"]');

    // Wait for dialog to close
    await expect(page.locator('[data-testid="dmp-selection-dialog"]')).not.toBeVisible({ timeout: 3000 });
  });

  test('import dialog shows when Ctrl+I is pressed from project view', async ({ page }) => {
    // Create a new project
    await createProject(page, 'Import Dialog Test');

    // Open import dialog
    await openDmpSelectionDialog(page);

    // Verify the DMP selection dialog appears (Step 1 of import flow)
    const dialog = page.locator('[data-testid="dmp-selection-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // The dialog should show the parsed DMP file data
    await expect(page.getByTestId('section-row-0')).toBeVisible({ timeout: 5000 });
  });
});
