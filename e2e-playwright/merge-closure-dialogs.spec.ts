import { test, expect } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
} from './helpers/app';
import type { SectionSeed } from './helpers/app';

/**
 * E2E tests for merge and closure dialog rendering and interaction flows.
 *
 * These tests verify the dialog UI renders correctly when opened via uiStore.
 * Backend actions (merge_stations, create_loop_closure) rely on mock IPC
 * which returns success without state changes; assertions focus on dialog
 * visibility, content, and button presence.
 */

const sectionA: SectionSeed = {
  name: 'Main Line',
  shots: [
    { azimuth_in: 0, azimuth_out: 0, length: 10, depth_in: 0, depth_out: 1 },
    { azimuth_in: 45, azimuth_out: 45, length: 8, depth_in: 1, depth_out: 2 },
  ],
};

const sectionB: SectionSeed = {
  name: 'Side Passage',
  shots: [
    { azimuth_in: 90, azimuth_out: 90, length: 5, depth_in: 0, depth_out: 0.5 },
  ],
};

test.describe('Merge and Closure Dialogs', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Merge Test');
    await seedProjectWithSections(page, [sectionA, sectionB]);
  });

  test('MergeDialog renders with station info when opened for unconnected stations', async ({ page }) => {
    // Get section IDs from project store
    const sectionIds = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return [];
      const project = e2e.projectStore.getState().project;
      if (!project) return [];
      return project.sections.map((s: any) => s.id);
    });

    expect(sectionIds.length).toBeGreaterThanOrEqual(2);

    // Open merge dialog via uiStore with station data
    await page.evaluate(
      ({ sectionA, sectionB }) => {
        const e2e = (window as any).__E2E_TEST__;
        if (!e2e) return;
        e2e.uiStore.getState().openDialog('merge', {
          stationA: { section_id: sectionA, station_index: 1 },
          stationB: { section_id: sectionB, station_index: 0 },
        });
      },
      { sectionA: sectionIds[0], sectionB: sectionIds[1] },
    );

    // Verify MergeDialog is visible
    const mergeDialog = page.getByTestId('merge-dialog');
    await expect(mergeDialog).toBeVisible({ timeout: 5000 });

    // Should show station info
    await expect(mergeDialog.getByText('Main Line')).toBeVisible();
    await expect(mergeDialog.getByText('Side Passage')).toBeVisible();

    // Should have Cancel and Merge buttons
    const cancelButton = mergeDialog.getByRole('button', { name: /Cancel/i });
    const mergeButton = mergeDialog.getByRole('button', { name: /Merge/i });
    await expect(cancelButton).toBeVisible();
    await expect(mergeButton).toBeVisible();

    // Cancel should close the dialog
    await cancelButton.click();
    await expect(mergeDialog).toBeHidden({ timeout: 3000 });
  });

  test('ClosureDialog renders with preview data and action buttons', async ({ page }) => {
    const sectionIds = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return [];
      const project = e2e.projectStore.getState().project;
      if (!project) return [];
      return project.sections.map((s: any) => s.id);
    });

    expect(sectionIds.length).toBeGreaterThanOrEqual(2);

    // Open closure dialog with preview data
    await page.evaluate(
      ({ sectionA, sectionB }) => {
        const e2e = (window as any).__E2E_TEST__;
        if (!e2e) return;
        e2e.uiStore.getState().openDialog('closure', {
          stationA: { section_id: sectionA, station_index: 0 },
          stationB: { section_id: sectionB, station_index: 1 },
          preview: {
            path_length: 23.0,
            misclosure_distance: 0.5,
            error_percentage: 2.2,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
          },
        });
      },
      { sectionA: sectionIds[0], sectionB: sectionIds[1] },
    );

    // Verify ClosureDialog is visible
    const closureDialog = page.getByTestId('closure-dialog');
    await expect(closureDialog).toBeVisible({ timeout: 5000 });

    // Should show station names
    await expect(closureDialog.getByText('Main Line')).toBeVisible();
    await expect(closureDialog.getByText('Side Passage')).toBeVisible();

    // Should show preview data
    await expect(closureDialog.getByText('2.2%')).toBeVisible();
    await expect(closureDialog.getByText('23.00m')).toBeVisible();
    await expect(closureDialog.getByText('0.50m').first()).toBeVisible();

    // Closure dialog no longer exposes strategy options (auto strategy is applied)
    await expect(closureDialog.locator('input[type="radio"]')).toHaveCount(0);

    // Should have Cancel and Create Closure buttons
    const cancelButton = closureDialog.getByRole('button', { name: /Cancel/i });
    const createButton = closureDialog.getByRole('button', { name: /Create Closure/i });
    await expect(cancelButton).toBeVisible();
    await expect(createButton).toBeVisible();

    // Cancel should close the dialog
    await cancelButton.click();
    await expect(closureDialog).toBeHidden({ timeout: 3000 });
  });

  test('MergeDialog Merge button triggers merge action and dialog closes', async ({ page }) => {
    const sectionIds = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return [];
      const project = e2e.projectStore.getState().project;
      if (!project) return [];
      return project.sections.map((s: any) => s.id);
    });

    expect(sectionIds.length).toBeGreaterThanOrEqual(2);

    // Open merge dialog
    await page.evaluate(
      ({ sectionA, sectionB }) => {
        const e2e = (window as any).__E2E_TEST__;
        if (!e2e) return;
        e2e.uiStore.getState().openDialog('merge', {
          stationA: { section_id: sectionA, station_index: 1 },
          stationB: { section_id: sectionB, station_index: 0 },
        });
      },
      { sectionA: sectionIds[0], sectionB: sectionIds[1] },
    );

    const mergeDialog = page.getByTestId('merge-dialog');
    await expect(mergeDialog).toBeVisible({ timeout: 5000 });

    // Click Merge button - mock IPC returns success
    const mergeButton = mergeDialog.getByRole('button', { name: /Merge/i });
    await mergeButton.click();

    // Dialog should close after merge (mock returns success)
    await expect(mergeDialog).toBeHidden({ timeout: 5000 });
  });

  test('ClosureDialog create button triggers closure and dialog closes', async ({ page }) => {
    const sectionIds = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return [];
      const project = e2e.projectStore.getState().project;
      if (!project) return [];
      return project.sections.map((s: any) => s.id);
    });

    expect(sectionIds.length).toBeGreaterThanOrEqual(2);

    // Open closure dialog
    await page.evaluate(
      ({ sectionA, sectionB }) => {
        const e2e = (window as any).__E2E_TEST__;
        if (!e2e) return;
        e2e.uiStore.getState().openDialog('closure', {
          stationA: { section_id: sectionA, station_index: 0 },
          stationB: { section_id: sectionB, station_index: 1 },
          preview: {
            path_length: 23.0,
            misclosure_distance: 0.5,
            error_percentage: 2.2,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
          },
        });
      },
      { sectionA: sectionIds[0], sectionB: sectionIds[1] },
    );

    const closureDialog = page.getByTestId('closure-dialog');
    await expect(closureDialog).toBeVisible({ timeout: 5000 });

    const createButton = closureDialog.getByRole('button', { name: /Create Closure/i });
    await createButton.click();
    await expect(closureDialog).toBeHidden({ timeout: 5000 });
  });

  test('Merge Tool opens MergeDialog when checkMergeConnectivity returns not connected', async ({ page }) => {
    const sectionIds = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return [];
      const project = e2e.projectStore.getState().project;
      if (!project) return [];
      return project.sections.map((s: any) => s.id);
    });
    expect(sectionIds.length).toBeGreaterThanOrEqual(2);

    // Set connectivity result to NOT connected (merge path)
    await page.evaluate(() => {
      (window as any).__MOCK_CONNECTIVITY_RESULT__ = { connected: false, preview: null };
    });

    // Simulate merge tool flow: call checkAndOpenMergeDialog via project store
    await page.evaluate(
      async ({ sectionA, sectionB }) => {
        const e2e = (window as any).__E2E_TEST__;
        if (!e2e) return;
        // Set merge tool active and set station A
        e2e.uiStore.getState().setActiveTool('merge');
        e2e.uiStore.getState().setMergeStationA({ section_id: sectionA, station_index: 1 });

        // Call connectivity check directly (simulates second station click)
        const result = await e2e.projectStore.getState().checkMergeConnectivity(
          { section_id: sectionA, station_index: 1 },
          { section_id: sectionB, station_index: 0 },
        );

        // Open dialog based on result (replicate merge tool logic)
        if (result.connected) {
          e2e.uiStore.getState().openDialog('closure', {
            stationA: { section_id: sectionA, station_index: 1 },
            stationB: { section_id: sectionB, station_index: 0 },
            preview: result.preview,
          });
        } else {
          e2e.uiStore.getState().openDialog('merge', {
            stationA: { section_id: sectionA, station_index: 1 },
            stationB: { section_id: sectionB, station_index: 0 },
          });
        }
      },
      { sectionA: sectionIds[0], sectionB: sectionIds[1] },
    );

    // Should open MergeDialog (not ClosureDialog)
    const mergeDialog = page.getByTestId('merge-dialog');
    await expect(mergeDialog).toBeVisible({ timeout: 5000 });
    const closureDialog = page.getByTestId('closure-dialog');
    await expect(closureDialog).toBeHidden();
  });

  test('Merge Tool opens ClosureDialog when checkMergeConnectivity returns connected', async ({ page }) => {
    const sectionIds = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return [];
      const project = e2e.projectStore.getState().project;
      if (!project) return [];
      return project.sections.map((s: any) => s.id);
    });
    expect(sectionIds.length).toBeGreaterThanOrEqual(2);

    // Set connectivity result to CONNECTED (closure path)
    await page.evaluate(() => {
      (window as any).__MOCK_CONNECTIVITY_RESULT__ = {
        connected: true,
        preview: {
          path_length: 15.0,
          misclosure_distance: 0.3,
          error_percentage: 2.0,
          horizontal_misclosure: 0.2,
          vertical_misclosure: 0.1,
        },
      };
    });

    // Simulate merge tool flow
    await page.evaluate(
      async ({ sectionA, sectionB }) => {
        const e2e = (window as any).__E2E_TEST__;
        if (!e2e) return;
        e2e.uiStore.getState().setActiveTool('merge');
        e2e.uiStore.getState().setMergeStationA({ section_id: sectionA, station_index: 1 });

        const result = await e2e.projectStore.getState().checkMergeConnectivity(
          { section_id: sectionA, station_index: 1 },
          { section_id: sectionB, station_index: 0 },
        );

        if (result.connected) {
          e2e.uiStore.getState().openDialog('closure', {
            stationA: { section_id: sectionA, station_index: 1 },
            stationB: { section_id: sectionB, station_index: 0 },
            preview: result.preview,
          });
        } else {
          e2e.uiStore.getState().openDialog('merge', {
            stationA: { section_id: sectionA, station_index: 1 },
            stationB: { section_id: sectionB, station_index: 0 },
          });
        }
      },
      { sectionA: sectionIds[0], sectionB: sectionIds[1] },
    );

    // Should open ClosureDialog (not MergeDialog)
    const closureDialog = page.getByTestId('closure-dialog');
    await expect(closureDialog).toBeVisible({ timeout: 5000 });
    const mergeDialog = page.getByTestId('merge-dialog');
    await expect(mergeDialog).toBeHidden();

    // Verify preview data is displayed
    await expect(closureDialog.getByText('2.0%')).toBeVisible();
    await expect(closureDialog.getByText('15.00m')).toBeVisible();
  });

  test('ClosureDialog shows reason subtitle when merge redirects to closure', async ({ page }) => {
    const sectionIds = await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (!e2e) return [];
      const project = e2e.projectStore.getState().project;
      if (!project) return [];
      return project.sections.map((s: any) => s.id);
    });

    expect(sectionIds.length).toBeGreaterThanOrEqual(2);

    // Open closure dialog with a reason (simulating merge-to-closure redirect)
    await page.evaluate(
      ({ sectionA, sectionB }) => {
        const e2e = (window as any).__E2E_TEST__;
        if (!e2e) return;
        e2e.uiStore.getState().openDialog('closure', {
          stationA: { section_id: sectionA, station_index: 0 },
          stationB: { section_id: sectionB, station_index: 1 },
          preview: {
            path_length: 23.0,
            misclosure_distance: 0.5,
            error_percentage: 2.2,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
          },
          reason: 'These stations are already connected. Creating a loop closure instead.',
        });
      },
      { sectionA: sectionIds[0], sectionB: sectionIds[1] },
    );

    const closureDialog = page.getByTestId('closure-dialog');
    await expect(closureDialog).toBeVisible({ timeout: 5000 });

    // Verify reason subtitle is displayed
    await expect(
      closureDialog.getByText('These stations are already connected. Creating a loop closure instead.')
    ).toBeVisible();
  });
});
