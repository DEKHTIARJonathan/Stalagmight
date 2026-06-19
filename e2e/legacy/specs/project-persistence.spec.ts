/**
 * WebdriverIO E2E Tests: Project Persistence
 *
 * These tests run against the full Tauri application with real backend
 * to validate save/load cycles, data integrity, and file operations.
 *
 * Test fixtures:
 * - test_v2.dmp: DMP version 2 format with multiple sections
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  saveProject,
  importDmpViaStore,
  getProjectSections,
  getProjectStats,
  waitForUiIdle,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

// Temp directory for test files
let tempDir: string;

describe('Project Persistence', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    // Create unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-e2e-'));
  });

  afterEach(async () => {
    // Cleanup temp directory
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Test 14.1: should save and reload project data
   *
   * Validates full save/load cycle:
   * - Create project with imported data
   * - Save to temp file
   * - Close project
   * - Reload saved file
   * - Verify data integrity
   */
  it('should save and reload project data', async () => {
    // Create a new project
    await createNewProject('Persistence Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(0);

    // Get sections before save
    const sectionsBeforeSave = await getProjectSections();
    const statsBeforeSave = await getProjectStats();

    // Save project to temp location
    const projectPath = path.join(tempDir, 'test-project.stalx');
    await browser.executeAsync(
      async (savePath: string, done: (result: { success: boolean; error?: string }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                saveProject: (path?: string) => Promise<{ success: boolean; error?: string }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          const result = await e2e.projectStore.getState().saveProject(savePath);
          done(result);
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      projectPath
    );

    // Verify file was created
    await waitForUiIdle(1000);
    expect(fs.existsSync(projectPath)).toBe(true);

    // Close the project
    await resetAppState();

    // Reopen the saved project
    const openResult = await browser.executeAsync(
      async (openPath: string, done: (result: { success: boolean; error?: string }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                openProject: (path: string) => Promise<{ success: boolean; error?: string }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          const result = await e2e.projectStore.getState().openProject(openPath);
          done(result);
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      projectPath
    );
    expect(openResult.success).toBe(true);

    // Wait for project to load
    await waitForUiIdle(1000);

    // Verify sections were preserved
    const sectionsAfterLoad = await getProjectSections();
    expect(sectionsAfterLoad.length).toBe(sectionsBeforeSave.length);

    // Verify stats were preserved
    const statsAfterLoad = await getProjectStats();
    expect(statsAfterLoad).not.toBeNull();
    if (statsAfterLoad && statsBeforeSave) {
      expect(statsAfterLoad.sectionCount).toBe(statsBeforeSave.sectionCount);
      expect(statsAfterLoad.totalLength).toBeCloseTo(statsBeforeSave.totalLength, 2);
    }
  });

  /**
   * Test 14.2: should preserve station merges across save/load
   *
   * Validates merge persistence:
   * - Create project with multiple sections
   * - Merge two stations
   * - Save and reload
   * - Verify merge is preserved
   */
  it('should preserve station merges across save/load', async () => {
    await createNewProject('Merge Persistence Test');

    // Import data with multiple sections
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(1);

    // Perform a station merge via store
    const mergeResult = await browser.executeAsync(
      async (done: (result: { success: boolean; error?: string; mergeCount?: number }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                project: {
                  sections: Array<{ id: number }>;
                  station_merges: unknown[];
                };
                mergeStations: (
                  a: { section_id: number; station_index: number },
                  b: { section_id: number; station_index: number },
                  strategy: string
                ) => Promise<{ success: boolean; error?: string }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          const state = e2e.projectStore.getState();
          if (!state.project || state.project.sections.length < 2) {
            done({ success: false, error: 'Need at least 2 sections for merge' });
            return;
          }

          // Merge station 0 of section 0 with station 0 of section 1
          const stationA = { section_id: state.project.sections[0].id, station_index: 0 };
          const stationB = { section_id: state.project.sections[1].id, station_index: 0 };

          const result = await state.mergeStations(stationA, stationB);
          if (result.success) {
            // Re-fetch project state to get updated merges
            const updatedState = e2e.projectStore.getState();
            done({
              success: true,
              mergeCount: updatedState.project?.station_merges.length ?? 0,
            });
          } else {
            done(result);
          }
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      }
    );
    expect(mergeResult.success).toBe(true);
    expect(mergeResult.mergeCount).toBeGreaterThan(0);

    const mergeCountBeforeSave = mergeResult.mergeCount;

    // Save project
    const projectPath = path.join(tempDir, 'merge-test.stalx');
    await browser.executeAsync(
      async (savePath: string, done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                saveProject: (path?: string) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const result = await e2e.projectStore.getState().saveProject(savePath);
        done(result);
      },
      projectPath
    );
    await waitForUiIdle(1000);

    // Close and reopen
    await resetAppState();

    await browser.executeAsync(
      async (openPath: string, done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                openProject: (path: string) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const result = await e2e.projectStore.getState().openProject(openPath);
        done(result);
      },
      projectPath
    );
    await waitForUiIdle(1000);

    // Verify merges were preserved
    const mergesAfterLoad = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { station_merges: unknown[] } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().project) return 0;
      return e2e.projectStore.getState().project?.station_merges.length ?? 0;
    });

    expect(mergesAfterLoad).toBe(mergeCountBeforeSave);
  });

  /**
   * Test 14.3: should preserve zero datums across save/load
   *
   * Validates GPS precision (8+ decimals):
   * - Set a zero datum with precise GPS coordinates
   * - Save and reload
   * - Verify GPS coordinates are preserved with full precision
   */
  it('should preserve zero datums across save/load', async () => {
    await createNewProject('Zero Datum Test');

    // Import data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);

    // Set a zero datum with precise GPS coordinates (8+ decimal places)
    const preciseLatitude = 47.12345678;
    const preciseLongitude = -122.87654321;
    const depthRef = 100.5;

    const zeroDatumResult = await browser.executeAsync(
      async (
        lat: number,
        lon: number,
        depth: number,
        done: (result: { success: boolean; error?: string }) => void
      ) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                project: { sections: Array<{ id: number }> } | null;
                setZeroDatum: (
                  stationRef: { section_id: number; station_index: number },
                  coordinates: { latitude: number; longitude: number; depth_reference: number }
                ) => Promise<{ success: boolean; error?: string }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          const state = e2e.projectStore.getState();
          if (!state.project || state.project.sections.length === 0) {
            done({ success: false, error: 'No sections available' });
            return;
          }

          const stationRef = { section_id: state.project.sections[0].id, station_index: 0 };
          const gps = { latitude: lat, longitude: lon, depth_reference: depth };
          const result = await state.setZeroDatum(stationRef, gps);
          done(result);
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      preciseLatitude,
      preciseLongitude,
      depthRef
    );
    expect(zeroDatumResult.success).toBe(true);

    // Get zero datums before save
    const datumsBeforeSave = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: {
                zero_datums: Array<{ gps: { latitude: number; longitude: number; depth_reference: number } }>;
              } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().project) return [];
      return e2e.projectStore.getState().project?.zero_datums ?? [];
    });
    expect(datumsBeforeSave.length).toBeGreaterThan(0);

    // Save project
    const projectPath = path.join(tempDir, 'zero-datum-test.stalx');
    await browser.executeAsync(
      async (savePath: string, done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                saveProject: (path?: string) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const result = await e2e.projectStore.getState().saveProject(savePath);
        done(result);
      },
      projectPath
    );
    await waitForUiIdle(1000);

    // Close and reopen
    await resetAppState();

    await browser.executeAsync(
      async (openPath: string, done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                openProject: (path: string) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const result = await e2e.projectStore.getState().openProject(openPath);
        done(result);
      },
      projectPath
    );
    await waitForUiIdle(1000);

    // Verify zero datums were preserved with full precision
    const datumsAfterLoad = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: {
                zero_datums: Array<{ gps: { latitude: number; longitude: number; depth_reference: number } }>;
              } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().project) return [];
      return e2e.projectStore.getState().project?.zero_datums ?? [];
    });

    expect(datumsAfterLoad.length).toBe(datumsBeforeSave.length);

    // Verify GPS precision (8+ decimals)
    const loadedDatum = datumsAfterLoad[0];
    expect(loadedDatum.gps.latitude).toBeCloseTo(preciseLatitude, 8);
    expect(loadedDatum.gps.longitude).toBeCloseTo(preciseLongitude, 8);
    expect(loadedDatum.gps.depth_reference).toBeCloseTo(depthRef, 2);
  });

  /**
   * Test 14.4: should handle save to read-only location
   *
   * Validates permission error handling:
   * - Attempt to save to a read-only directory
   * - Verify error is returned gracefully
   * - Application remains stable
   */
  it('should handle save to read-only location', async () => {
    await createNewProject('Permission Test');

    // Import some data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    await importDmpViaStore(dmpPath);

    // Create a read-only directory
    const readOnlyDir = path.join(tempDir, 'readonly');
    fs.mkdirSync(readOnlyDir);
    fs.chmodSync(readOnlyDir, 0o444); // Read-only

    // Attempt to save to read-only location
    const readOnlyPath = path.join(readOnlyDir, 'test.stalx');
    let saveResult: { success: boolean; error?: string };
    try {
      saveResult = await browser.executeAsync(
        async (savePath: string, done: (result: { success: boolean; error?: string }) => void) => {
          const e2e = (window as unknown as {
            __E2E_TEST__?: {
              projectStore: {
                getState: () => {
                  saveProject: (path?: string) => Promise<{ success: boolean; error?: string }>;
                };
              };
            };
          }).__E2E_TEST__;

          if (!e2e) {
            done({ success: false, error: 'E2E helpers not found' });
            return;
          }

          try {
            const result = await e2e.projectStore.getState().saveProject(savePath);
            done(result);
          } catch (err) {
            done({ success: false, error: String(err) });
          }
        },
        readOnlyPath
      );
    } catch (err) {
      // Handle case where the error propagates through WebDriver
      saveResult = { success: false, error: String(err) };
    }

    // Restore permissions for cleanup
    try {
      fs.chmodSync(readOnlyDir, 0o755);
    } catch {
      // Ignore
    }

    // Verify save failed with an error
    expect(saveResult.success).toBe(false);
    expect(saveResult.error).toBeDefined();

    // Application should still be functional
    const mapCanvas = await $('[data-testid="map-canvas"]');
    await expect(mapCanvas).toBeExisting();

    // Can still save to a valid location
    const validPath = path.join(tempDir, 'valid-save.stalx');
    const validResult = await browser.executeAsync(
      async (savePath: string, done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                saveProject: (path?: string) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const result = await e2e.projectStore.getState().saveProject(savePath);
        done(result);
      },
      validPath
    );
    expect(validResult.success).toBe(true);
  });

  /**
   * Test 14.5: should update recent projects list
   *
   * Validates recent projects tracking:
   * - Save a project
   * - Close and check recent projects list
   * - Project should appear in recent list
   */
  it('should update recent projects list', async () => {
    await createNewProject('Recent Test');

    // Import some data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    await importDmpViaStore(dmpPath);

    // Save project
    const projectPath = path.join(tempDir, 'recent-test.stalx');
    await browser.executeAsync(
      async (savePath: string, done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                saveProject: (path?: string) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const result = await e2e.projectStore.getState().saveProject(savePath);
        done(result);
      },
      projectPath
    );
    await waitForUiIdle(1000);

    // Close project
    await resetAppState();

    // Load recent projects
    await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              loadRecentProjects: () => Promise<void>;
            };
          };
        };
      }).__E2E_TEST__;

      if (e2e) {
        e2e.projectStore.getState().loadRecentProjects();
      }
    });
    await waitForUiIdle(500);

    // Get recent projects
    const recentProjects = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              recentProjects: Array<{ path?: string; file_path?: string; name: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return [];
      return e2e.projectStore.getState().recentProjects;
    });

    // Verify our saved file is present in recents (match by path/filename, not transient project name)
    const expectedFileName = path.basename(projectPath);
    const foundProject = recentProjects.find((p) => {
      const candidatePath = p.path || p.file_path || '';
      return candidatePath.includes(expectedFileName);
    });
    expect(foundProject).toBeDefined();
    expect((foundProject?.path || foundProject?.file_path) ?? '').toContain(expectedFileName);
  });

  /**
   * Test 14.6: should show dirty indicator for unsaved changes
   *
   * Validates window title asterisk:
   * - Create project
   * - Make changes (isDirty becomes true)
   * - Verify isDirty state
   * - Save project
   * - Verify isDirty becomes false
   */
  it('should show dirty indicator for unsaved changes', async () => {
    await createNewProject('Dirty Test');

    // Initially, project should not be dirty
    let isDirty = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              isDirty: boolean;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return false;
      return e2e.projectStore.getState().isDirty;
    });
    expect(isDirty).toBe(false);

    // Import DMP file to make changes
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    await importDmpViaStore(dmpPath);
    await waitForUiIdle(500);

    // After import, project should be dirty (createSection sets isDirty)
    isDirty = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              isDirty: boolean;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return false;
      return e2e.projectStore.getState().isDirty;
    });
    expect(isDirty).toBe(true);

    // Save the project
    const projectPath = path.join(tempDir, 'dirty-test.stalx');
    await browser.executeAsync(
      async (savePath: string, done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                saveProject: (path?: string) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const result = await e2e.projectStore.getState().saveProject(savePath);
        done(result);
      },
      projectPath
    );
    await waitForUiIdle(500);

    // After save, project should not be dirty
    isDirty = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              isDirty: boolean;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return false;
      return e2e.projectStore.getState().isDirty;
    });
    expect(isDirty).toBe(false);

    // Make another change - update a section
    const updateResult = await browser.executeAsync(
      async (done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                project: { sections: Array<{ id: number }> } | null;
                updateSection: (
                  sectionId: number,
                  updates: { name: string }
                ) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const state = e2e.projectStore.getState();
        if (!state.project || state.project.sections.length === 0) {
          done({ success: false });
          return;
        }

        const result = await state.updateSection(state.project.sections[0].id, { name: 'Modified Section' });
        done(result);
      }
    );
    expect(updateResult.success).toBe(true);
    await waitForUiIdle(300);

    // After modification, isDirty should be true again
    isDirty = await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              isDirty: boolean;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) return false;
      return e2e.projectStore.getState().isDirty;
    });
    expect(isDirty).toBe(true);
  });

  /**
   * Test 14.7: should zoom to fit when opening a project
   *
   * Validates auto-fit behavior:
   * - Save a project with data
   * - Close and reopen it
   * - Verify triggerFitToBounds was called
   *
   * Regression test: Project view not zooming to fit after open
   */
  it('should trigger fit-to-view when opening a project', async () => {
    await createNewProject('Fit To View Test');

    // Import survey data to have something to zoom to
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);

    // Save project
    const projectPath = path.join(tempDir, 'fit-to-view-test.stalx');
    await browser.executeAsync(
      async (savePath: string, done: (result: { success: boolean }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                saveProject: (path?: string) => Promise<{ success: boolean }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false });
          return;
        }

        const result = await e2e.projectStore.getState().saveProject(savePath);
        done(result);
      },
      projectPath
    );
    await waitForUiIdle(1000);

    // Close project
    await resetAppState();

    // Clear any previous fit-to-bounds request
    await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              clearFitToBoundsRequest: () => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (e2e) {
        e2e.uiStore.getState().clearFitToBoundsRequest();
      }
    });

    // Open the project
    const openResult = await browser.executeAsync(
      async (openPath: string, done: (result: { success: boolean; error?: string }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                openProject: (path: string) => Promise<{ success: boolean; error?: string }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          const result = await e2e.projectStore.getState().openProject(openPath);
          done(result);
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      projectPath
    );
    expect(openResult.success).toBe(true);

    // Wait for the map to settle and fit-to-bounds to be processed
    await waitForUiIdle(500);

    // Verify fit-to-bounds occurred by checking that stations are visible on the map.
    // The requestFitToBounds flag is transient (cleared immediately after being consumed),
    // so we verify the outcome: the map should have zoomed to show the data.
    const zoomResult = await browser.execute(() => {
      const mapRef = (window as unknown as { __stalagmight_map__?: { getZoom: () => number } })
        .__stalagmight_map__;
      if (!mapRef) return { hasMap: false, zoom: 0 };
      return { hasMap: true, zoom: mapRef.getZoom() };
    });

    // Map should exist and have a reasonable zoom level (fit-to-bounds was triggered)
    expect(zoomResult.hasMap).toBe(true);
    // After fit-to-bounds, zoom should be greater than the default initial zoom (typically 1-2)
    // A reasonable zoom after fitting survey data is typically 10-20
    expect(zoomResult.zoom).toBeGreaterThan(5);
  });
});
