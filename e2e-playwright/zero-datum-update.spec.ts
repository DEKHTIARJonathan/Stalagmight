import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * E2E tests for the zero datum update fix (fn-30-wcf).
 *
 * Verifies that updating GPS coordinates on an existing zero datum:
 * 1. Produces exactly ONE undo entry (not two from remove+set)
 * 2. No-change guard: saving without modifying lat/lon creates no undo entry
 */

/** Track IPC calls for set_zero_datum / remove_zero_datum */
interface IpcCallRecord {
  cmd: string;
  args: Record<string, unknown>;
}

/**
 * Create a new project and wait for map readiness.
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page
    .locator('button:has-text("New Project"), h3:has-text("New Project")')
    .first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

/**
 * Inject a section with a zero datum station into the project store.
 * Station 0 of this section will have is_zero_datum=true with GPS coordinates.
 */
async function injectZeroDatumFixture(
  page: Page,
  lat: number,
  lon: number
): Promise<void> {
  // Wait for the project store to have a project
  await page.waitForFunction(
    () => {
      const store = (window as unknown as Record<string, unknown>).__E2E_TEST__ as
        | { projectStore: { getState: () => { project: unknown } } }
        | undefined;
      return store && store.projectStore.getState().project !== null;
    },
    { timeout: 5000 }
  );

  await page.evaluate(
    ({ lat, lon }) => {
      const e2e = (window as unknown as Record<string, unknown>).__E2E_TEST__ as {
        projectStore: {
          getState: () => {
            project: Record<string, unknown> & {
              sections: Array<Record<string, unknown>>;
              zero_datums: Array<Record<string, unknown>>;
            };
            stations: Array<Record<string, unknown>>;
          };
          setState: (partial: Record<string, unknown>) => void;
        };
      };

      if (!e2e?.projectStore) {
        throw new Error('E2E projectStore not available');
      }

      const state = e2e.projectStore.getState();
      const existingProject = state.project;
      if (!existingProject) {
        throw new Error('Project is null');
      }

      // Create a test section with one shot
      const testSection = {
        id: 1,
        name: 'Datum Section',
        surveyor: 'Test Surveyor',
        date: '2026-01-28',
        color: '#4ecdc4',
        direction: 'in',
        shots: [
          {
            id: 1,
            azimuth_in: 90,
            azimuth_out: 270,
            length: 10,
            depth_in: 0,
            depth_out: -1,
            pitch_in: null,
            pitch_out: null,
            left: 1,
            right: 1,
            up: 2,
            down: 0.5,
            comment: null,
            is_virtual: false,
            marker_index: 0,
            temperature: null,
          },
        ],
      };

      const existingSections = existingProject.sections ?? [];

      // Update project with the datum section and zero datum entry
      const project = {
        ...existingProject,
        sections: [testSection, ...existingSections],
        zero_datums: [
          {
            station_ref: { section_id: 1, station_index: 0 },
            gps: { latitude: lat, longitude: lon, depth_reference: 0 },
          },
        ],
      };

      // Create mock stations for the new section
      const existingStations = state.stations ?? [];
      const newStations = [
        {
          station_ref: { section_id: 1, station_index: 0 },
          coordinates: { x: 0, y: 0, z: 0 },
          is_zero_datum: true,
          gps_coordinates: { latitude: lat, longitude: lon, depth_reference: 0 },
          merged_with: [],
        },
        {
          station_ref: { section_id: 1, station_index: 1 },
          coordinates: { x: 10, y: 0, z: -1 },
          is_zero_datum: false,
          gps_coordinates: null,
          merged_with: [],
        },
        ...existingStations,
      ];

      // Update store state atomically
      e2e.projectStore.setState({
        project,
        stations: newStations,
      });

      // Also update the mock backend so refresh returns updated data
      const mocks = (window as unknown as Record<string, unknown>).__E2E_MOCKS__ as
        | { setCurrentProject: (p: unknown) => void }
        | undefined;
      if (mocks?.setCurrentProject) {
        mocks.setCurrentProject(project);
      }
    },
    { lat, lon }
  );

  // Wait for React to re-render with the new state
  await page.waitForFunction(
    () => {
      const e2e = (window as unknown as Record<string, unknown>).__E2E_TEST__ as
        | {
            projectStore: {
              getState: () => {
                project: { sections: Array<{ id: number; name: string }> } | null;
              };
            };
          }
        | undefined;
      return e2e?.projectStore
        .getState()
        .project?.sections?.some(
          (s: { id: number; name: string }) => s.id === 1 && s.name === 'Datum Section'
        );
    },
    { timeout: 5000 }
  );

  // Wait for the section name to be visible in the UI
  await expect(page.locator('text=Datum Section')).toBeVisible({ timeout: 5000 });
}

/**
 * Extend mocks to track set_zero_datum / remove_zero_datum IPC calls.
 * MUST be called AFTER page.goto().
 */
async function extendMocksWithZeroDatumTracking(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Track IPC calls for zero datum operations
    (window as unknown as Record<string, unknown>).__ZERO_DATUM_CALLS__ = [] as Array<{
      cmd: string;
      args: Record<string, unknown>;
    }>;

    // Undo stack entries created by set_zero_datum / remove_zero_datum
    (window as unknown as Record<string, unknown>).__ZERO_DATUM_UNDO_COUNT__ = 0;

    const originalInvoke = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke;

    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'set_zero_datum' || cmd === 'remove_zero_datum') {
        const calls = (
          window as unknown as {
            __ZERO_DATUM_CALLS__: Array<{ cmd: string; args: Record<string, unknown> }>;
          }
        ).__ZERO_DATUM_CALLS__;
        calls.push({ cmd, args: args ?? {} });

        // Increment undo count
        (window as unknown as { __ZERO_DATUM_UNDO_COUNT__: number })
          .__ZERO_DATUM_UNDO_COUNT__++;
      }

      return originalInvoke(cmd, args);
    };

    console.log('[Mock IPC] Extended mocks with zero datum tracking');
  });
}

/**
 * Get the number of zero-datum-related IPC calls.
 */
async function getZeroDatumCalls(page: Page): Promise<IpcCallRecord[]> {
  return page.evaluate(() => {
    return (
      (
        window as unknown as {
          __ZERO_DATUM_CALLS__: Array<{ cmd: string; args: Record<string, unknown> }>;
        }
      ).__ZERO_DATUM_CALLS__ || []
    );
  });
}

/**
 * Get the count of undo entries from zero datum operations.
 */
async function getZeroDatumUndoCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (
      (window as unknown as { __ZERO_DATUM_UNDO_COUNT__: number }).__ZERO_DATUM_UNDO_COUNT__ ?? 0
    );
  });
}

/**
 * Open the EditStationDialog for a specific station via the store.
 */
async function openEditStationDialog(
  page: Page,
  sectionId: number,
  stationIndex: number
): Promise<void> {
  await page.evaluate(
    ({ sectionId, stationIndex }) => {
      const e2e = (window as unknown as Record<string, unknown>).__E2E_TEST__ as
        | {
            uiStore: {
              getState: () => {
                openDialog: (name: string, data: Record<string, unknown>) => void;
              };
            };
          }
        | undefined;

      if (!e2e?.uiStore) {
        throw new Error('E2E uiStore not available');
      }

      e2e.uiStore.getState().openDialog('edit-station', {
        stationRef: { section_id: sectionId, station_index: stationIndex },
      });
    },
    { sectionId, stationIndex }
  );

  // Wait for dialog to be visible
  await expect(page.getByTestId('edit-station-dialog')).toBeVisible({ timeout: 5000 });
}

test.describe('Zero Datum Update - Single Undo Entry', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Zero Datum Test');
    await injectZeroDatumFixture(page, 25.0, -80.0);
    await extendMocksWithZeroDatumTracking(page);
  });

  test('updating GPS on existing zero datum produces exactly one undo entry', async ({
    page,
  }) => {
    // Record baseline undo count
    const baselineCount = await getZeroDatumUndoCount(page);

    // Open EditStationDialog for station 0 of section 1 (the zero datum station)
    await openEditStationDialog(page, 1, 0);

    const dialog = page.getByTestId('edit-station-dialog');
    await expect(dialog).toBeVisible();

    // Verify the checkbox is checked (station is already a zero datum)
    const checkbox = dialog.locator('#zeroDatum');
    await expect(checkbox).toBeChecked();

    // Verify GPS fields are populated with initial values
    const latInput = dialog.locator('input[type="number"]').first();
    await expect(latInput).toHaveValue('25');

    // Change latitude from 25.0 to 26.0
    await latInput.fill('26');

    // Click Save
    const saveButton = dialog.locator('button:has-text("Save")');
    await saveButton.click();

    // Wait for dialog to close (indicates save completed)
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Verify exactly one set_zero_datum call was made (no remove_zero_datum)
    const calls = await getZeroDatumCalls(page);
    const setCallCount = calls.filter((c) => c.cmd === 'set_zero_datum').length;
    const removeCallCount = calls.filter((c) => c.cmd === 'remove_zero_datum').length;

    expect(removeCallCount).toBe(0);
    expect(setCallCount).toBe(1);

    // Verify undo count delta is exactly 1
    const finalCount = await getZeroDatumUndoCount(page);
    expect(finalCount - baselineCount).toBe(1);
  });

  test('saving without modifying lat/lon creates no new undo entry', async ({ page }) => {
    // Record baseline undo count
    const baselineCount = await getZeroDatumUndoCount(page);

    // Open EditStationDialog for station 0 of section 1
    await openEditStationDialog(page, 1, 0);

    const dialog = page.getByTestId('edit-station-dialog');
    await expect(dialog).toBeVisible();

    // Verify the checkbox is checked
    const checkbox = dialog.locator('#zeroDatum');
    await expect(checkbox).toBeChecked();

    // Do NOT change any values - just click Save
    const saveButton = dialog.locator('button:has-text("Save")');
    await saveButton.click();

    // Wait for dialog to close
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Verify no zero datum IPC calls were made at all (no-change guard)
    const calls = await getZeroDatumCalls(page);
    expect(calls.length).toBe(0);

    // Verify no new undo entries
    const finalCount = await getZeroDatumUndoCount(page);
    expect(finalCount - baselineCount).toBe(0);
  });
});
