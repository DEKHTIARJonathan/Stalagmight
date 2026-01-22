import { test, expect, Page } from '@playwright/test';

/**
 * E2E tests for Undo/Redo History Dropdown feature.
 * Tests hover behavior, click actions, keyboard navigation, detail preview, and edge cases.
 */

/** Mock undo history items for testing */
function getMockUndoStack() {
  return [
    {
      index: 0,
      description: 'Update shot length to 15.5m',
      timestamp: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
      commandType: 'update_shot',
      previewData: {
        changes: [
          { field: 'length', oldValue: '10.0', newValue: '15.5' },
          { field: 'azimuth', oldValue: '45', newValue: '48' },
        ],
        additionalChanges: 0,
      },
    },
    {
      index: 1,
      description: 'Create section "Main Tunnel"',
      timestamp: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
      commandType: 'create_section',
      previewData: {
        changes: [{ field: 'name', oldValue: '', newValue: 'Main Tunnel' }],
        additionalChanges: 0,
      },
    },
    {
      index: 2,
      description: 'Delete shot in Side Passage',
      timestamp: new Date(Date.now() - 180000).toISOString(), // 3 minutes ago
      commandType: 'delete_shot',
      previewData: null,
    },
    {
      index: 3,
      description: 'Merge stations A1 and B2',
      timestamp: null, // Legacy entry without timestamp
      commandType: 'merge_stations',
      previewData: null,
    },
  ];
}

function getMockRedoStack() {
  return [
    {
      index: 0,
      description: 'Delete section "Old Tunnel"',
      timestamp: new Date(Date.now() - 300000).toISOString(),
      commandType: 'delete_section',
      previewData: {
        changes: [{ field: 'name', oldValue: 'Old Tunnel', newValue: '' }],
        additionalChanges: 2,
      },
    },
  ];
}

interface MockConfig {
  canUndo: boolean;
  canRedo: boolean;
  undoStack: ReturnType<typeof getMockUndoStack>;
  redoStack: ReturnType<typeof getMockRedoStack>;
}

/**
 * Helper to set up Tauri mocks with undo/redo stack support.
 * This sets up all mocks in a single addInitScript before page load.
 */
async function setupTauriMocksWithUndoRedo(page: Page, options: Partial<MockConfig> = {}): Promise<void> {
  const config = {
    canUndo: options.canUndo ?? true,
    canRedo: options.canRedo ?? true,
    undoStack: options.undoStack ?? getMockUndoStack(),
    redoStack: options.redoStack ?? getMockRedoStack(),
  };

  await page.addInitScript((mockConfig) => {
    // Track undo/redo calls for verification
    (window as unknown as Record<string, unknown>).__UNDO_REDO_CALLS__ = [];

    // Store the mock config for later modification if needed
    (window as unknown as Record<string, unknown>).__UNDO_REDO_MOCK_CONFIG__ = mockConfig;

    // Create the mock command handler that handles ALL commands including undo/redo
    const mockHandler = (() => {
      let currentProject: {
        id: number;
        name: string;
        location: string | null;
        created_at: string;
        modified_at: string;
        file_path: string | null;
        sections: unknown[];
        station_merges: unknown[];
        zero_datums: unknown[];
        loop_closures: unknown[];
        section_offsets: Record<string, unknown>;
      } | null = null;
      let projectPath: string | null = null;
      let sectionCounter = 0;

      return function mockCommand(
        cmd: string,
        args?: Record<string, unknown>
      ): unknown {
        console.log(`[Mock IPC] Command: ${cmd}`, args);
        const config = (window as unknown as { __UNDO_REDO_MOCK_CONFIG__: typeof mockConfig }).__UNDO_REDO_MOCK_CONFIG__;

        switch (cmd) {
          // Undo/Redo commands - these are the key commands for this test
          case 'can_undo':
            return config.canUndo;
          case 'can_redo':
            return config.canRedo;
          case 'get_undo_state':
            return { can_undo: config.canUndo, can_redo: config.canRedo };
          case 'get_undo_stack':
            return config.undoStack;
          case 'get_redo_stack':
            return config.redoStack;
          case 'undo':
          case 'redo':
            return { success: true };
          case 'undo_to': {
            const calls = (window as unknown as { __UNDO_REDO_CALLS__: Array<{ cmd: string; index: number }> }).__UNDO_REDO_CALLS__;
            calls.push({ cmd: 'undo_to', index: args?.index as number });
            return { success: true, warnings: [], error: null };
          }
          case 'redo_to': {
            const calls = (window as unknown as { __UNDO_REDO_CALLS__: Array<{ cmd: string; index: number }> }).__UNDO_REDO_CALLS__;
            calls.push({ cmd: 'redo_to', index: args?.index as number });
            return { success: true, warnings: [], error: null };
          }

          // Project commands
          case 'create_project': {
            const name = (args?.name as string) ?? 'Untitled Project';
            const now = new Date().toISOString();
            sectionCounter = 0;
            currentProject = {
              id: 1,
              name,
              location: null,
              created_at: now,
              modified_at: now,
              file_path: null,
              sections: [],
              station_merges: [],
              zero_datums: [],
              loop_closures: [],
              section_offsets: {},
            };
            return { success: true, project: currentProject };
          }

          case 'create_project_full': {
            const name = (args?.name as string) ?? 'Untitled Project';
            const now = new Date().toISOString();
            sectionCounter = 0;
            currentProject = {
              id: 1,
              name,
              location: null,
              created_at: now,
              modified_at: now,
              file_path: null,
              sections: [],
              station_merges: [],
              zero_datums: [],
              loop_closures: [],
              section_offsets: {},
            };
            return {
              loadingId: Date.now(),
              project: currentProject,
              displaySettings: {
                showStations: true,
                showSectionNames: true,
                showStationLabels: false,
                showShotData: false,
                showVirtualShots: true,
                showZeroDatum: true,
                showGrid: false,
                showScaleBar: true,
                showSatellite: false,
                showDepthGradient: false,
                gridSpacing: 10,
              },
            };
          }

          case 'load_project':
          case 'open_project': {
            projectPath = (args?.path as string) ?? null;
            if (!currentProject) {
              const now = new Date().toISOString();
              currentProject = {
                id: 1,
                name: 'Test Project',
                location: null,
                created_at: now,
                modified_at: now,
                file_path: projectPath,
                sections: [],
                station_merges: [],
                zero_datums: [],
                loop_closures: [],
                section_offsets: {},
              };
            }
            return { success: true, project: currentProject };
          }

          case 'get_project':
          case 'get_project_state': {
            const mockStations: Array<{
              station_ref: { section_id: number; station_index: number };
              coordinates: { x: number; y: number; z: number };
              is_zero_datum: boolean;
              gps_coordinates: null;
              merged_with: never[];
            }> = [];

            return {
              project: currentProject,
              stations: mockStations,
              stats: {
                section_count: 0,
                shot_count: 0,
                total_length: 0,
                min_depth: 0,
                max_depth: 0,
                station_count: 0,
                loop_count: 0,
                penetration_distance: 0,
              },
            };
          }

          case 'save_project':
            return { success: true, path: projectPath };

          case 'close_project':
            currentProject = null;
            projectPath = null;
            return { success: true };

          case 'cancel_loading':
            return undefined;

          case 'create_section': {
            sectionCounter++;
            const section = {
              id: sectionCounter,
              name: (args?.name as string) ?? `Section ${sectionCounter}`,
              surveyor: 'Test Surveyor',
              date: new Date().toISOString().split('T')[0],
              color: '#3b82f6',
              shots: [],
            };
            currentProject?.sections.push(section);
            return { success: true, section };
          }

          // Config commands
          case 'get_config':
            return {
              general: { auto_save: true, auto_save_interval_seconds: 30, recent_projects_max: 20, undo_history_limit: 100, undo_persist_limit: 20 },
              units: { length: 'meters', depth: 'meters', angle: 'degrees', decimal_precision: 1 },
              display: { default_background: '#1a1a2e', grid_color: '#333366', grid_spacing: 10, font_size: 12, font_color: '#f5f5f5', depth_gradient: { enabled: false, shallow_color: '#00bfff', deep_color: '#ff4444', shallow_depth: 0.0, deep_depth: 50.0 } },
              section_colors: { palette: ['#4ecdc4', '#ff6b6b', '#95e1d3', '#f38181', '#aa96da', '#fcbad3', '#a8d8ea', '#ffcb77'] },
              map: { satellite_provider: 'esri', satellite_enabled: false, satellite_gps_origin: { latitude: 24.55, longitude: -81.78 }, zoom_default: 15, zoom_min: 1, zoom_max: 22, zoom_step: 1.0, controls: { pan_speed: 1.0, zoom_speed: 1.0, invert_scroll: false }, station: { radius: 4.0, hit_area: 10.0 }, shot: { width: 2.0, hit_area: 8.0 }, snap: { threshold: 10.0, enabled_draw: true, enabled_merge: true, enabled_measure: true } },
              validation: { warn_shot_length_min: 0.1, warn_shot_length_max: 50.0, warn_depth_change_per_shot_max: 10.0, warn_azimuth_deviation_max: 30.0, azimuth_diff_threshold: 10.0, pitch_diff_threshold: 5.0 },
              export: { default_image_format: 'png', default_dpi: 300, default_include_satellite: true, default_include_grid: false, default_include_labels: true },
              logging: { level: 'info', max_directory_size_mb: 128 },
              shortcuts: { select: ['S'], pan: ['P'], zoom: ['Z'], draw: ['D'], delete_tool: ['X'], merge: ['M'], measure: ['R'], move_section: ['V'], move_station: ['T'], undo: ['Ctrl+Z'], redo: ['Ctrl+Y', 'Ctrl+Shift+Z'], save: ['Ctrl+S'], toggle_depth_gradient: ['G'], toggle_grid: ['Shift+G'], toggle_satellite: ['B'], toggle_station_labels: ['L'], toggle_shot_labels: ['Shift+L'], toggle_section_labels: ['Ctrl+L'], fit_to_bounds: ['F'], zoom_in: ['Equal', 'Plus'], zoom_out: ['Minus'], toggle_sections_panel: ['Ctrl+1'], toggle_detail_panel: ['Ctrl+2'], toggle_data_table: ['Ctrl+3'] },
              panels: { sections_panel_width: 250, detail_panel_width: 300, data_table_height: 200 },
              cache: { tile_cache_enabled: true, tile_cache_max_mb: 500, tile_ttl_days: 30 },
              debug: { map: { show_hitboxes: false, log_hit_detection: false } },
            };

          case 'update_config':
          case 'reload_config':
            return null;

          case 'get_recent_projects':
          case 'list_recent_projects':
            return [];

          case 'get_warnings':
          case 'get_project_warnings':
            return [];

          // Plugin commands
          case 'plugin:dialog|open':
            return '/mock/test-survey.dmp';
          case 'plugin:dialog|save':
            return '/mock/saved-project.cvproj';
          case 'plugin:window|set_title':
          case 'plugin:window|current':
            return { label: 'main' };
          case 'plugin:event|listen':
            return Date.now();
          case 'plugin:event|unlisten':
          case 'plugin:event|emit':
            return undefined;

          default:
            console.warn(`[Mock IPC] Unhandled command: ${cmd}`);
            return null;
        }
      };
    })();

    // Mock Tauri internals
    const tauriInternals = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        return mockHandler(cmd, args);
      },
      transformCallback: (callback: () => void) => {
        const id = Math.random().toString(36).substring(7);
        (window as unknown as Record<string, unknown>)[`_${id}`] = callback;
        return id;
      },
      convertFileSrc: (filePath: string) => {
        return `asset://localhost/${filePath}`;
      },
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
    };

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = tauriInternals;
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      invoke: tauriInternals.invoke,
      convertFileSrc: tauriInternals.convertFileSrc,
      transformCallback: tauriInternals.transformCallback,
    };

    console.log('[Mock IPC] Tauri mocks with undo/redo support installed');
  }, config);
}

/**
 * Helper to update undo/redo mock config after page load.
 */
async function updateUndoRedoMockConfig(page: Page, config: Partial<MockConfig>): Promise<void> {
  await page.evaluate((newConfig) => {
    const existingConfig = (window as unknown as { __UNDO_REDO_MOCK_CONFIG__: MockConfig }).__UNDO_REDO_MOCK_CONFIG__;
    Object.assign(existingConfig, newConfig);
  }, config);
}

/**
 * Helper to create a new project with mock sections/stations.
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Wait for map to be fully initialized (per memory pitfall)
  await page.waitForFunction(
    () => (window as unknown as { __cavechef_map__?: unknown }).__cavechef_map__ !== undefined,
    { timeout: 10000 }
  );

  // Force a refresh of undo state to ensure store picks up mock values
  await page.evaluate(async () => {
    // Access the projectStore through E2E test exposure and refresh undo state
    const stores = (window as unknown as { __E2E_TEST__?: { projectStore: { getState: () => { refreshUndoState: () => Promise<void> } } } }).__E2E_TEST__;
    if (stores?.projectStore) {
      await stores.projectStore.getState().refreshUndoState();
    }
  });

  // Wait for React to re-render with new state
  await page.waitForTimeout(100);
}

/**
 * Helper to get undo/redo calls made during test.
 */
async function getUndoRedoCalls(page: Page): Promise<Array<{ cmd: string; index: number }>> {
  return await page.evaluate(() => {
    return (window as unknown as { __UNDO_REDO_CALLS__: Array<{ cmd: string; index: number }> }).__UNDO_REDO_CALLS__ || [];
  });
}

/**
 * Helper to clear undo/redo calls.
 */
async function clearUndoRedoCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __UNDO_REDO_CALLS__: Array<{ cmd: string; index: number }> }).__UNDO_REDO_CALLS__ = [];
  });
}

test.describe('Undo/Redo History Dropdown', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocksWithUndoRedo(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Dropdown Test Project');
  });

  test.describe('Hover Behavior', () => {
    test('dropdown appears after ~300ms hover on Undo button', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      await expect(undoButton).toBeVisible();

      // Verify dropdown is not visible initially
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');
      await expect(dropdown).not.toBeVisible();

      // Hover over undo button
      await undoButton.hover();

      // Dropdown should not appear immediately (before 300ms)
      await page.waitForTimeout(100);
      await expect(dropdown).not.toBeVisible();

      // Wait for hover delay plus buffer
      await page.waitForTimeout(350);

      // Now dropdown should be visible
      await expect(dropdown).toBeVisible({ timeout: 1000 });
    });

    test('dropdown appears after ~300ms hover on Redo button', async ({ page }) => {
      const redoButton = page.locator('[data-testid="toolbar-redo-button"]');
      await expect(redoButton).toBeVisible();

      // Verify dropdown is not visible initially
      const dropdown = page.locator('[data-testid="toolbar-redo-button-dropdown"]');
      await expect(dropdown).not.toBeVisible();

      // Hover over redo button
      await redoButton.hover();

      // Wait for hover delay plus buffer
      await page.waitForTimeout(350);

      // Now dropdown should be visible
      await expect(dropdown).toBeVisible({ timeout: 1000 });
    });

    test('dropdown closes when mouse leaves', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');

      // Hover to open dropdown
      await undoButton.hover();
      await page.waitForTimeout(400);
      await expect(dropdown).toBeVisible();

      // Move mouse away from dropdown
      await page.mouse.move(0, 0);

      // Wait for close delay buffer
      await page.waitForTimeout(200);

      // Dropdown should close
      await expect(dropdown).not.toBeVisible({ timeout: 1000 });
    });
  });

  test.describe('Item Click Behavior', () => {
    test('clicking item at index 2 executes 3 undos (indices 0,1,2)', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');

      // Hover to open dropdown
      await undoButton.hover();
      await page.waitForTimeout(400);

      // Click item at index 2
      const itemIndex2 = page.locator('[data-testid="toolbar-undo-button-item-2"]');
      await expect(itemIndex2).toBeVisible();
      await itemIndex2.click();

      // Verify undo_to was called with index 2
      const calls = await getUndoRedoCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ cmd: 'undo_to', index: 2 });

      // Dropdown should close after click
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');
      await expect(dropdown).not.toBeVisible({ timeout: 1000 });
    });

    test('clicking item in redo dropdown calls redo_to', async ({ page }) => {
      const redoButton = page.locator('[data-testid="toolbar-redo-button"]');

      // Hover to open dropdown
      await redoButton.hover();
      await page.waitForTimeout(400);

      // Click first item
      const item = page.locator('[data-testid="toolbar-redo-button-item-0"]');
      await expect(item).toBeVisible();
      await item.click();

      // Verify redo_to was called with index 0
      const calls = await getUndoRedoCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ cmd: 'redo_to', index: 0 });
    });
  });

  test.describe('Keyboard Navigation', () => {
    test('Arrow Down opens dropdown from focused button', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');

      // Focus the button
      await undoButton.focus();

      // Press Arrow Down
      await page.keyboard.press('ArrowDown');

      // Dropdown should open
      await expect(dropdown).toBeVisible({ timeout: 1000 });
    });

    test('Arrow keys navigate items in dropdown', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');

      // Focus and open with Arrow Down
      await undoButton.focus();
      await page.keyboard.press('ArrowDown');
      await expect(dropdown).toBeVisible();

      // First item should be highlighted initially
      // Navigate down
      await page.keyboard.press('ArrowDown');

      // Navigate up
      await page.keyboard.press('ArrowUp');

      // Use Home to go to first item
      await page.keyboard.press('Home');

      // Use End to go to last item
      await page.keyboard.press('End');

      // Dropdown should still be open
      await expect(dropdown).toBeVisible();
    });

    test('Enter selects item and closes dropdown', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');

      // Focus and open with Arrow Down
      await undoButton.focus();
      await page.keyboard.press('ArrowDown');
      await expect(dropdown).toBeVisible();

      // Wait for first item to be focused
      await page.waitForTimeout(50);

      // Press Enter to select first item (index 0)
      await page.keyboard.press('Enter');

      // Verify undo_to was called with index 0
      const calls = await getUndoRedoCalls(page);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ cmd: 'undo_to', index: 0 });

      // Dropdown should close
      await expect(dropdown).not.toBeVisible({ timeout: 1000 });
    });

    test('Escape closes dropdown', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');

      // Open dropdown via hover
      await undoButton.hover();
      await page.waitForTimeout(400);
      await expect(dropdown).toBeVisible();

      // Press Escape
      await page.keyboard.press('Escape');

      // Dropdown should close
      await expect(dropdown).not.toBeVisible({ timeout: 1000 });
    });
  });

  test.describe('Detail Preview', () => {
    test('detail preview appears on item hover', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');

      // Hover to open dropdown
      await undoButton.hover();
      await page.waitForTimeout(400);

      // Hover over first item (which has previewData)
      const firstItem = page.locator('[data-testid="toolbar-undo-button-item-0"]');
      await expect(firstItem).toBeVisible();
      await firstItem.hover();

      // Detail preview popup should appear
      const previewPopup = page.locator('[data-testid="detail-preview-popup"]');
      await expect(previewPopup).toBeVisible({ timeout: 1000 });

      // Verify preview shows field changes
      await expect(previewPopup).toContainText('length');
      await expect(previewPopup).toContainText('10.0');
      await expect(previewPopup).toContainText('15.5');
    });

    test('detail preview shows "No details" for items without previewData', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');

      // Hover to open dropdown
      await undoButton.hover();
      await page.waitForTimeout(400);

      // Hover over item at index 2 (which has null previewData)
      const item = page.locator('[data-testid="toolbar-undo-button-item-2"]');
      await expect(item).toBeVisible();
      await item.hover();

      // Detail preview popup should show "No details"
      const previewPopup = page.locator('[data-testid="detail-preview-popup"]');
      await expect(previewPopup).toBeVisible({ timeout: 1000 });
      await expect(previewPopup).toContainText('No details');
    });
  });

  test.describe('Edge Cases', () => {
    test('no dropdown when canUndo is false', async ({ page }) => {
      // Update mock config to disable undo
      await updateUndoRedoMockConfig(page, { canUndo: false, canRedo: false, undoStack: [], redoStack: [] });
      // Force a refresh of undo state in the store
      await page.evaluate(() => {
        // Trigger re-fetch of undo state - access the store through E2E test exposure
        const stores = (window as unknown as { __E2E_TEST__?: { projectStore: { getState: () => { refreshUndoState: () => Promise<void> } } } }).__E2E_TEST__;
        if (stores?.projectStore) {
          stores.projectStore.getState().refreshUndoState();
        }
      });
      await page.waitForTimeout(100);

      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      await expect(undoButton).toBeVisible();

      // Button should be disabled
      await expect(undoButton).toBeDisabled();

      // Hover should not open dropdown
      await undoButton.hover({ force: true });
      await page.waitForTimeout(400);

      // Dropdown should not appear
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');
      await expect(dropdown).not.toBeVisible();
    });

    test('dropdown closes on Ctrl+Z shortcut', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');

      // Open dropdown
      await undoButton.hover();
      await page.waitForTimeout(400);
      await expect(dropdown).toBeVisible();

      // Press Ctrl+Z
      await page.keyboard.press('Control+Z');

      // Dropdown should close
      await expect(dropdown).not.toBeVisible({ timeout: 1000 });
    });

    test('dropdown closes on Ctrl+Y shortcut', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');

      // Open dropdown
      await undoButton.hover();
      await page.waitForTimeout(400);
      await expect(dropdown).toBeVisible();

      // Press Ctrl+Y
      await page.keyboard.press('Control+Y');

      // Dropdown should close
      await expect(dropdown).not.toBeVisible({ timeout: 1000 });
    });

    test('dropdown shows timestamp as "Unknown" for legacy entries', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');

      // Open dropdown
      await undoButton.hover();
      await page.waitForTimeout(400);

      // Find item at index 3 which has null timestamp
      const item = page.locator('[data-testid="toolbar-undo-button-item-3"]');
      await expect(item).toBeVisible();

      // Verify "Unknown" is shown for timestamp
      await expect(item).toContainText('Unknown');
    });

    test('chevron indicator visible when canUndo is true', async ({ page }) => {
      // Verify undo chevron is visible
      const undoChevron = page.locator('[data-testid="undo-chevron"]');
      await expect(undoChevron).toBeVisible();
    });

    test('chevron indicator visible when canRedo is true', async ({ page }) => {
      // Verify redo chevron is visible
      const redoChevron = page.locator('[data-testid="redo-chevron"]');
      await expect(redoChevron).toBeVisible();
    });
  });

  test.describe('Dropdown Content', () => {
    test('dropdown displays items with correct content', async ({ page }) => {
      const undoButton = page.locator('[data-testid="toolbar-undo-button"]');

      // Open dropdown
      await undoButton.hover();
      await page.waitForTimeout(400);

      const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');
      await expect(dropdown).toBeVisible();

      // Verify header
      await expect(dropdown).toContainText('Undo History');

      // Verify items are displayed
      await expect(page.locator('[data-testid="toolbar-undo-button-item-0"]')).toBeVisible();
      await expect(page.locator('[data-testid="toolbar-undo-button-item-1"]')).toBeVisible();
      await expect(page.locator('[data-testid="toolbar-undo-button-item-2"]')).toBeVisible();
      await expect(page.locator('[data-testid="toolbar-undo-button-item-3"]')).toBeVisible();

      // Verify item descriptions are truncated appropriately and displayed
      const firstItem = page.locator('[data-testid="toolbar-undo-button-item-0"]');
      await expect(firstItem).toContainText('Update shot');
    });

    test('redo dropdown displays correct header', async ({ page }) => {
      const redoButton = page.locator('[data-testid="toolbar-redo-button"]');

      // Open dropdown
      await redoButton.hover();
      await page.waitForTimeout(400);

      const dropdown = page.locator('[data-testid="toolbar-redo-button-dropdown"]');
      await expect(dropdown).toBeVisible();

      // Verify header says "Redo History"
      await expect(dropdown).toContainText('Redo History');
    });
  });
});

test.describe('Undo/Redo Dropdown - Empty State', () => {
  test.beforeEach(async ({ page }) => {
    // Setup with empty stacks but canUndo/canRedo still true (edge case)
    await setupTauriMocksWithUndoRedo(page, { undoStack: [], redoStack: [] });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Empty Stack Project');
  });

  test('dropdown does not open when stack is empty', async ({ page }) => {
    const undoButton = page.locator('[data-testid="toolbar-undo-button"]');
    const dropdown = page.locator('[data-testid="toolbar-undo-button-dropdown"]');

    // Hover to try opening dropdown
    await undoButton.hover();
    await page.waitForTimeout(400);

    // Dropdown should not appear with empty stack
    await expect(dropdown).not.toBeVisible();
  });
});
