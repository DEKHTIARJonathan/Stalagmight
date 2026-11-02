import type { MockCommandFamily } from './types';

/**
 * Config commands of the Playwright IPC mock: `get_config` / `reload_config`, and the
 * writes they overlay - saved config, the three grid views and the import-shots view,
 * the `[gas]` block - with the per-spec seeds and override hooks those read.
 *
 * Split out of `../tauri-ipc.ts` unchanged (#576 E8). Runs IN THE PAGE: `setupTauriMocks`
 * serializes this factory with `Function.prototype.toString` into its init script, so it
 * may use only `ctx` and browser globals - never an import (type-only imports are erased).
 */
export const configCommands: MockCommandFamily = (ctx) => {
  // Config override for testing config reload effects
  interface MockConfigOverrides {
    debug?: { map?: { show_hitboxes?: boolean; log_hit_detection?: boolean } };
    map?: {
      station?: { hit_area?: number };
      shot?: { hit_area?: number };
      animation?: { enabled?: boolean; duration?: number; point_zoom?: number };
    };
  }
  let mockConfigOverrides: MockConfigOverrides = {};

  // Expose config override for testing config reload
  (window as unknown as Record<string, unknown>).__MOCK_SET_CONFIG_OVERRIDES__ = (overrides: MockConfigOverrides) => {
    mockConfigOverrides = overrides;
  };
  (window as unknown as Record<string, unknown>).__MOCK_RESET_CONFIG_OVERRIDES__ = () => {
    mockConfigOverrides = {};
  };

  // Store saved config for persistence testing
  let savedConfig: Record<string, unknown> | null = null;
  (window as unknown as Record<string, unknown>).__MOCK_GET_SAVED_CONFIG__ = () => savedConfig;
  (window as unknown as Record<string, unknown>).__MOCK_RESET_SAVED_CONFIG__ = () => {
    savedConfig = null;
  };

  // Data-table view state persisted via update_data_table_view, merged
  // back into get_config's panels: the frontend re-syncs its in-memory
  // config via loadConfig() after each save, so without the merge a
  // saved view change would silently revert on the next remount.
  //
  // Seeded from `window.__E2E_SEED_DATA_TABLE_VIEW__`, set by a test's OWN
  // `page.addInitScript` call registered before `setupMockedPage` (init
  // scripts run in registration order, before any app JS) - this is the
  // only way to have a seeded value present for the app's FIRST
  // `get_config` call at boot, which `update_data_table_view` (an
  // in-page IPC call, necessarily after boot) cannot reach in time.
  const mockDataTableView: Record<string, unknown> = {
    ...(((window as unknown as Record<string, unknown>).__E2E_SEED_DATA_TABLE_VIEW__ as
      | Record<string, unknown>
      | undefined) ?? {}),
  };

  // The new-section dialog's grid layout, persisted via
  // update_new_section_view. Its own store rather than more keys in
  // mockDataTableView, mirroring the Rust side where the two are separate
  // commands writing disjoint `panels` fields - a shared object would let one
  // view's partial write appear to carry the other's keys. Overlaid onto
  // get_config / reload_config alongside it, and seedable the same way via
  // `window.__E2E_SEED_NEW_SECTION_VIEW__`.
  const mockNewSectionView: Record<string, unknown> = {
    ...(((window as unknown as Record<string, unknown>).__E2E_SEED_NEW_SECTION_VIEW__ as
      | Record<string, unknown>
      | undefined) ?? {}),
  };

  // The edit-section dialog's shot grid, persisted via
  // update_edit_section_view. Third store for the third grid, matching the
  // Rust side's three disjoint `panels` field sets.
  const mockEditSectionView: Record<string, unknown> = {
    ...(((window as unknown as Record<string, unknown>).__E2E_SEED_EDIT_SECTION_VIEW__ as
      | Record<string, unknown>
      | undefined) ?? {}),
  };
  // Its OWN seed, deliberately not derived from the edit-section one. The
  // production change gave the import-time grids separate `import_shots_*`
  // fields precisely so reshaping columns mid-import cannot rewrite the
  // edit-section layout; seeding both from one hook would let a regression
  // that reads or writes the wrong slice look identical to correct
  // behaviour, in the mock that exists to prove they stay apart.
  const mockImportShotsView: Record<string, unknown> = {
    ...(((window as unknown as Record<string, unknown>).__E2E_SEED_IMPORT_SHOTS_VIEW__ as
      | Record<string, unknown>
      | undefined) ?? {}),
  };

  // `map.controls.show_navigation_tools` (#409): the Pan/Zoom toolbar group is
  // hidden unless the user opts in, so the mock's config reports false and a
  // spec that needs the tools seeds `window.__E2E_SEED_SHOW_NAVIGATION_TOOLS__`
  // via its OWN `page.addInitScript` before `setupMockedPage` (see
  // `seedNavigationTools` in helpers/app.ts) - same reason as the view seeds
  // above: the toolbar reads the value from the FIRST `get_config` at boot.
  const mockShowNavigationTools =
    (window as unknown as Record<string, unknown>).__E2E_SEED_SHOW_NAVIGATION_TOOLS__ === true;

  // The `[gas]` block persisted via update_gas_config, overlaid onto
  // get_config the same way. Null until something writes it, so an untouched
  // run keeps whatever gas config get_config would otherwise return.
  let mockGasConfig: Record<string, unknown> | null = null;

  return (cmd, args) => {
    switch (cmd) {
      case 'get_config':
        // Return saved config if available (for testing persistence),
        // overlaying any view state stored via update_data_table_view and any
        // `[gas]` block stored via update_gas_config.
        if (savedConfig) {
          return {
            ...savedConfig,
            panels: {
              ...((savedConfig.panels as Record<string, unknown> | undefined) ?? {}),
              ...mockDataTableView,
              ...mockNewSectionView,
              ...mockEditSectionView,
              ...mockImportShotsView,
            ...mockImportShotsView,
            },
            ...(mockGasConfig ? { gas: mockGasConfig } : {}),
          };
        }
        return {
          general: {
            auto_save: true,
            auto_save_interval_seconds: 30,
            recent_projects_max: 20,
            recent_projects: [],
            undo_history_limit: 100,
            undo_persist_limit: 20,
            shortcut_feedback: 'non_obvious',
            locale: 'system',
            number_format: 'locale',
            date_format: 'locale',
            splash_screen: false,
            // Keep onboarding disabled in E2E to avoid overlay interception.
            onboarding_enabled: false,
            onboarding_completed_flows: [],
          },
          units: {
            length: 'meters',
            depth: 'meters',
            angle: 'degrees',
            decimal_precision: { length: 1, coordinates: 2, depth: 1, azimuth: 1, inclination: 1, gps: 6 },
          },
          gas: {
            units: 'metric',
            default_reserve: 'all_thirds',
            reserve_profile: {
              stage_reserve_bar: 30,
              all_thirds_safety_margin_bar: 0,
              recalc_hold_stage2_bar: 100,
              recalc_hold_stage1_bar: 70,
            },
            swim_speed_m_per_min: 10,
            survey_speed_m_per_min: null,
            survey_rmv_multiplier: 1,
            stressed_rmv_multiplier: 1.5,
            jump_rmv_multiplier: 1.5,
            conservative_tank_gas: true,
            dpv: null,
          },
          display: {
            grid_color: '#333366',
            grid_spacing: 10,
            font_size: 12,
            font_color: '#f5f5f5',
            depth_gradient: {
              enabled: false,
              shallow_color: '#00bfff',
              deep_color: '#ff4444',
              shallow_depth: 0.0,
              deep_depth: 50.0,
            },
          },
          section_colors: {
            palette: ['#4ecdc4', '#ff6b6b', '#95e1d3', '#f38181', '#aa96da', '#fcbad3', '#a8d8ea', '#ffcb77'],
          },
          map: {
            satellite_provider: 'esri',
            satellite_enabled: false,
            satellite_gps_origin: {
              latitude: 24.55,
              longitude: -81.78,
            },
            zoom_default: 15,
            zoom_min: 1,
            zoom_max: 22,
            zoom_step: 1.0,
            controls: {
              pan_speed: 1.0,
              zoom_speed: 0.55,
              invert_scroll: false,
              show_navigation_tools: mockShowNavigationTools,
            },
            station: {
              radius: 4.0,
              hit_area: 10.0,
              hover_radius: 6.0,
              selection_radius: 5.0,
            },
            shot: {
              width: 2.0,
              hit_area: 8.0,
              hover_width: 4.0,
              selection_width: 3.0,
            },
            snap: {
              threshold: 10.0,
              enabled_draw: true,
              enabled_merge: true,
              enabled_measure: true,
            },
            animation: {
              enabled: true,
              duration: 300,
              point_zoom: 18,
            },
          },
          validation: {
            warn_shot_length_min: 0.1,
            warn_shot_length_max: 50.0,
            warn_depth_change_per_shot_max: 10.0,
            warn_azimuth_deviation_max: 30.0,
            azimuth_diff_threshold: 20.0,
            pitch_diff_threshold: 5.0,
          },
          closure_adjustment: {
            base_sigma_length_m: 0.05,
            base_sigma_azimuth_deg: 1.0,
            base_sigma_depth_m: 0.05,
            transit_vertical_mode: 'ignore',
            sequential_distribution_default: 'ProportionalByLength',
          },
          export: {
            default_image_format: 'png',
            default_dpi: 300,
            default_include_satellite: true,
            default_include_grid: false,
            default_include_labels: true,
          },
          logging: {
            level: 'info',
            max_directory_size_mb: 128,
          },
          shortcuts: {
            // File
            import_dmp: ['Ctrl+I'],
            export: ['Ctrl+E'],
            new_file: ['Ctrl+N'],
            open_file: ['Ctrl+O'],
            save: ['Ctrl+S'],
            save_as: ['Ctrl+Shift+S'],
            // Tools
            select: ['S'],
            pan: ['P'],
            zoom: ['Z'],
            merge: ['M'],
            measure: ['R'],
            move_segment: ['V'],
            move_shot: ['G'],
            move_station: ['T'],
            // Edit
            undo: ['Ctrl+Z'],
            redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
            // View
            toggle_depth_gradient: ['Shift+D'],
            toggle_grid: ['Shift+G'],
            toggle_satellite: ['B'],
            toggle_station_labels: ['L'],
            toggle_shot_labels: ['Shift+L'],
            toggle_section_labels: ['Ctrl+L'],
            fit_to_bounds: ['F'],
            zoom_in: ['Equal', 'Plus'],
            zoom_out: ['Minus'],
            // Panels (tests use Ctrl+ prefix)
            toggle_sections_panel: ['Ctrl+1'],
            toggle_detail_panel: ['Ctrl+2'],
            toggle_data_table: ['Ctrl+3'],
          },
          panels: {
            sections_panel_width: 250,
            detail_panel_width: 300,
            data_table_height: 200,
            wizard_map_panel_width: 480,
            data_table_shot_column_order: [],
            data_table_shot_hidden_columns: ['section_id', 'shot_id'],
            data_table_shot_column_widths: {},
            data_table_azimuth_mode: 'avg',
            data_table_inclination_mode: 'off',
            data_table_station_column_order: [],
            data_table_station_hidden_columns: ['_x', '_y', '_lat', '_long'],
            data_table_station_column_widths: {},
            // The new-section dialog's grid layout. Present (not omitted) for
            // the same reason as the reveal state below: get_config on a real
            // backend always serializes these, and the dialog treats an ABSENT
            // hidden list as "never stored, use the built-in defaults" but a
            // present empty one as "the user unhid everything".
            new_section_column_order: [],
            new_section_hidden_columns: [
              'azimuth_in',
              'azimuth_out',
              '_pitch_avg',
              'pitch_in',
              'pitch_out',
              'left',
              'right',
              'up',
              'down',
            ],
            new_section_column_widths: {},
            edit_section_column_order: [],
            edit_section_hidden_columns: [
              'azimuth_in',
              'azimuth_out',
              '_pitch_avg',
              'pitch_in',
              'pitch_out',
            ],
            import_shots_column_order: [],
            import_shots_hidden_columns: [
              'azimuth_in',
              'azimuth_out',
              '_pitch_avg',
              'pitch_in',
              'pitch_out',
            ],
            import_shots_column_widths: {},
            edit_section_column_widths: {},
            // Concrete reveal state so initPanels never falls back to its
            // defaults. Deliberately NOT the shipped default any more: a fresh
            // install opens the data table, but most specs want the map
            // unobstructed, so the fixture keeps it closed and the specs that
            // care about it open it themselves. The shipped default is pinned
            // in Rust (config::tests) and in uiStore.initPanels.test.ts.
            sections_panel_open: true,
            sections_panel_mode: 'pin',
            detail_panel_open: true,
            detail_panel_mode: 'pin',
            data_table_open: false,
            data_table_mode: 'pin',
            ...mockDataTableView,
            ...mockNewSectionView,
            ...mockEditSectionView,
            ...mockImportShotsView,
          },
          cache: {
            tile_cache_enabled: true,
            tile_cache_max_mb: 500,
            tile_ttl_days: 30,
          },
          debug: {
            map: {
              show_hitboxes: false,
              log_hit_detection: false,
            },
          },
          global_view: {
            fps_threshold: 30,
            tolerance: 0.5,
            throttle_tolerance: 1.0,
          },
          appearance: {
            theme: 'dark',
            day_color_theme: 'light',
            night_color_theme: 'cave',
          },
          syntactic_highlighting: {
            level: 'full',
            preset: 'default',
            overrides: {},
          },
          // SpeleoDB config block: the real get_config always returns this
          // (Rust SpeleoDbConfig::default), and SpeleoStatusButton reads
          // config.speleodb.poll_interval_seconds on every project-view mount -
          // omitting it here makes config.speleodb undefined and crashes the view.
          speleodb: {
            endpoint: null,
            email: null,
            token_fallback: 'session_only',
            insecure_http: false,
            poll_interval_seconds: 60,
          },
          // Spread LAST so a stored `[gas]` block wins over the literal's own.
          ...(mockGasConfig ? { gas: mockGasConfig } : {}),
        };

      case 'update_config':
        // Mock update_config - store config and return the real command's shape:
        // a ConfigSaveReport whose only field is the keyring residue a "never use
        // the OS keychain" save could not evict. `null` is the ordinary answer.
        console.log('[Mock IPC] update_config called with:', args);
        savedConfig = args?.config as Record<string, unknown> | undefined ?? null;
        return { keychain_residue: null };

      case 'update_gas_config': {
        // Partial update of the `[gas]` block only, mirroring the Rust impl.
        // Overlaid in get_config the same way mockDataTableView is, rather
        // than written into savedConfig: savedConfig is null until something
        // posts a whole Config, and assigning a lone `{ gas }` to it would
        // make get_config return a config with no general/display/panels at
        // all. Keeping the two separate is also what lets a test assert that
        // a gas write left the OTHER fields untouched (#357 item 2).
        console.log('[Mock IPC] update_gas_config called with:', args);
        const gas = args?.gas as Record<string, unknown> | undefined;
        if (gas) mockGasConfig = gas;
        return null;
      }

      case 'update_data_table_view': {
        console.log('[Mock IPC] update_data_table_view called with:', args);
        // Record calls for assertions (debounced view-persistence payloads).
        const win = window as unknown as Record<string, unknown>;
        const existing = win.__MOCK_DATA_TABLE_VIEW_CALLS__ as unknown[] | undefined;
        const calls = Array.isArray(existing) ? existing : [];
        calls.push(args ?? null);
        win.__MOCK_DATA_TABLE_VIEW_CALLS__ = calls;
        // Mirror the Rust impl's partial-update semantics: only provided
        // fields overwrite the stored view state (merged into get_config's
        // panels above).
        const columnOrder = (args?.columnOrder ?? args?.column_order) as string[] | undefined;
        if (columnOrder != null) mockDataTableView.data_table_shot_column_order = columnOrder;
        const hiddenColumns = (args?.hiddenColumns ?? args?.hidden_columns) as string[] | undefined;
        if (hiddenColumns != null) mockDataTableView.data_table_shot_hidden_columns = hiddenColumns;
        const azimuthMode = (args?.azimuthMode ?? args?.azimuth_mode) as string | undefined;
        if (azimuthMode != null) mockDataTableView.data_table_azimuth_mode = azimuthMode;
        const inclinationMode = (args?.inclinationMode ?? args?.inclination_mode) as string | undefined;
        if (inclinationMode != null) mockDataTableView.data_table_inclination_mode = inclinationMode;
        const stationColumnOrder = (args?.stationColumnOrder ?? args?.station_column_order) as string[] | undefined;
        if (stationColumnOrder != null) mockDataTableView.data_table_station_column_order = stationColumnOrder;
        const stationHiddenColumns = (args?.stationHiddenColumns ?? args?.station_hidden_columns) as string[] | undefined;
        if (stationHiddenColumns != null) mockDataTableView.data_table_station_hidden_columns = stationHiddenColumns;
        const columnWidths = (args?.columnWidths ?? args?.column_widths) as
          | Record<string, number>
          | undefined;
        if (columnWidths != null) mockDataTableView.data_table_shot_column_widths = columnWidths;
        const stationColumnWidths = (args?.stationColumnWidths ?? args?.station_column_widths) as
          | Record<string, number>
          | undefined;
        if (stationColumnWidths != null) {
          mockDataTableView.data_table_station_column_widths = stationColumnWidths;
        }
        return null; // Tauri serializes () as null
      }

      case 'update_new_section_view': {
        console.log('[Mock IPC] update_new_section_view called with:', args);
        // Record calls for assertions, same shape as the data-table one.
        const win = window as unknown as Record<string, unknown>;
        const existing = win.__MOCK_NEW_SECTION_VIEW_CALLS__ as unknown[] | undefined;
        const calls = Array.isArray(existing) ? existing : [];
        calls.push(args ?? null);
        win.__MOCK_NEW_SECTION_VIEW_CALLS__ = calls;
        // Partial-update semantics, mirroring update_new_section_view_impl:
        // only provided fields overwrite the stored layout.
        const columnOrder = (args?.columnOrder ?? args?.column_order) as string[] | undefined;
        if (columnOrder != null) mockNewSectionView.new_section_column_order = columnOrder;
        const hiddenColumns = (args?.hiddenColumns ?? args?.hidden_columns) as
          | string[]
          | undefined;
        if (hiddenColumns != null) mockNewSectionView.new_section_hidden_columns = hiddenColumns;
        const columnWidths = (args?.columnWidths ?? args?.column_widths) as
          | Record<string, number>
          | undefined;
        if (columnWidths != null) mockNewSectionView.new_section_column_widths = columnWidths;
        return null; // Tauri serializes () as null
      }

      case 'update_edit_section_view': {
        console.log('[Mock IPC] update_edit_section_view called with:', args);
        const win = window as unknown as Record<string, unknown>;
        const existing = win.__MOCK_EDIT_SECTION_VIEW_CALLS__ as unknown[] | undefined;
        const calls = Array.isArray(existing) ? existing : [];
        calls.push(args ?? null);
        win.__MOCK_EDIT_SECTION_VIEW_CALLS__ = calls;
        const columnOrder = (args?.columnOrder ?? args?.column_order) as string[] | undefined;
        if (columnOrder != null) mockEditSectionView.edit_section_column_order = columnOrder;
        const hiddenColumns = (args?.hiddenColumns ?? args?.hidden_columns) as
          | string[]
          | undefined;
        if (hiddenColumns != null) {
          mockEditSectionView.edit_section_hidden_columns = hiddenColumns;
        }
        const columnWidths = (args?.columnWidths ?? args?.column_widths) as
          | Record<string, number>
          | undefined;
        if (columnWidths != null) mockEditSectionView.edit_section_column_widths = columnWidths;
        return null; // Tauri serializes () as null
      }
      case 'update_import_shots_view': {
        console.log('[Mock IPC] update_import_shots_view called with:', args);
        const win = window as unknown as Record<string, unknown>;
        // Its OWN call list. Recording import saves under the edit-section key
        // made an import-grid save indistinguishable from an edit-section one,
        // so no spec could assert that either slice wrote only its own fields -
        // which is the whole point of the separate `import_shots_*` config.
        const existing = win.__MOCK_IMPORT_SHOTS_VIEW_CALLS__ as unknown[] | undefined;
        const calls = Array.isArray(existing) ? existing : [];
        calls.push(args ?? null);
        win.__MOCK_IMPORT_SHOTS_VIEW_CALLS__ = calls;
        const columnOrder = (args?.columnOrder ?? args?.column_order) as string[] | undefined;
        if (columnOrder != null) mockImportShotsView.import_shots_column_order = columnOrder;
        const hiddenColumns = (args?.hiddenColumns ?? args?.hidden_columns) as
          | string[]
          | undefined;
        if (hiddenColumns != null) {
          mockImportShotsView.import_shots_hidden_columns = hiddenColumns;
        }
        const columnWidths = (args?.columnWidths ?? args?.column_widths) as
          | Record<string, number>
          | undefined;
        if (columnWidths != null) mockImportShotsView.import_shots_column_widths = columnWidths;
        return null; // Tauri serializes () as null
      }

      case 'reload_config': {
        // Return saved config if available (for testing persistence),
        // overlaying the same two stores get_config does. Without the
        // overlay, Settings > Advanced "Reload from disk" handed back a
        // config with neither the view state stored via
        // update_data_table_view nor the `[gas]` block stored via
        // update_gas_config - so a reload discarded state the mock
        // otherwise treats as persisted, and a reload-after-save test would
        // have asserted against the wrong baseline.
        if (savedConfig) {
          return {
            ...savedConfig,
            panels: {
              ...((savedConfig.panels as Record<string, unknown> | undefined) ?? {}),
              ...mockDataTableView,
              ...mockNewSectionView,
              ...mockEditSectionView,
              ...mockImportShotsView,
            ...mockImportShotsView,
            },
            ...(mockGasConfig ? { gas: mockGasConfig } : {}),
          };
        }
        // Return mock config with any test overrides applied
        // This allows tests to modify config values via __MOCK_SET_CONFIG_OVERRIDES__
        const baseConfig = {
          general: {
            auto_save: true,
            auto_save_interval_seconds: 30,
            recent_projects_max: 20,
            recent_projects: [],
            undo_history_limit: 100,
            undo_persist_limit: 20,
            shortcut_feedback: 'non_obvious',
            locale: 'system',
            number_format: 'locale',
            date_format: 'locale',
            splash_screen: false,
            // Keep onboarding disabled in E2E to avoid overlay interception.
            onboarding_enabled: false,
            onboarding_completed_flows: [],
          },
          units: {
            length: 'meters',
            depth: 'meters',
            angle: 'degrees',
            decimal_precision: { length: 1, coordinates: 2, depth: 1, azimuth: 1, inclination: 1, gps: 6 },
          },
          gas: {
            units: 'metric',
            default_reserve: 'all_thirds',
            reserve_profile: {
              stage_reserve_bar: 30,
              all_thirds_safety_margin_bar: 0,
              recalc_hold_stage2_bar: 100,
              recalc_hold_stage1_bar: 70,
            },
            swim_speed_m_per_min: 10,
            survey_speed_m_per_min: null,
            survey_rmv_multiplier: 1,
            stressed_rmv_multiplier: 1.5,
            jump_rmv_multiplier: 1.5,
            conservative_tank_gas: true,
            dpv: null,
          },
          display: {
            grid_color: '#333366',
            grid_spacing: 10,
            font_size: 12,
            font_color: '#f5f5f5',
            depth_gradient: {
              enabled: false,
              shallow_color: '#00bfff',
              deep_color: '#ff4444',
              shallow_depth: 0.0,
              deep_depth: 50.0,
            },
          },
          section_colors: {
            palette: ['#4ecdc4', '#ff6b6b', '#95e1d3', '#f38181', '#aa96da', '#fcbad3', '#a8d8ea', '#ffcb77'],
          },
          map: {
            satellite_provider: 'esri',
            satellite_enabled: false,
            satellite_gps_origin: {
              latitude: 24.55,
              longitude: -81.78,
            },
            zoom_default: 15,
            zoom_min: 1,
            zoom_max: 22,
            zoom_step: 1.0,
            controls: {
              pan_speed: 1.0,
              zoom_speed: 0.55,
              invert_scroll: false,
              show_navigation_tools: mockShowNavigationTools,
            },
            station: {
              radius: 4.0,
              hit_area: mockConfigOverrides.map?.station?.hit_area ?? 10.0,
              hover_radius: 6.0,
              selection_radius: 5.0,
            },
            shot: {
              width: 2.0,
              hit_area: mockConfigOverrides.map?.shot?.hit_area ?? 8.0,
              hover_width: 4.0,
              selection_width: 3.0,
            },
            snap: {
              threshold: 10.0,
              enabled_draw: true,
              enabled_merge: true,
              enabled_measure: true,
            },
            animation: {
              enabled: mockConfigOverrides.map?.animation?.enabled ?? true,
              duration: mockConfigOverrides.map?.animation?.duration ?? 300,
              point_zoom: mockConfigOverrides.map?.animation?.point_zoom ?? 18,
            },
          },
          validation: {
            warn_shot_length_min: 0.1,
            warn_shot_length_max: 50.0,
            warn_depth_change_per_shot_max: 10.0,
            warn_azimuth_deviation_max: 30.0,
            azimuth_diff_threshold: 20.0,
            pitch_diff_threshold: 5.0,
          },
          closure_adjustment: {
            base_sigma_length_m: 0.05,
            base_sigma_azimuth_deg: 1.0,
            base_sigma_depth_m: 0.05,
            transit_vertical_mode: 'ignore',
            sequential_distribution_default: 'ProportionalByLength',
          },
          export: {
            default_image_format: 'png',
            default_dpi: 300,
            default_include_satellite: true,
            default_include_grid: false,
            default_include_labels: true,
          },
          logging: {
            level: 'info',
            max_directory_size_mb: 128,
          },
          shortcuts: {
            // File
            import_dmp: ['Ctrl+I'],
            export: ['Ctrl+E'],
            new_file: ['Ctrl+N'],
            open_file: ['Ctrl+O'],
            save: ['Ctrl+S'],
            save_as: ['Ctrl+Shift+S'],
            // Tools
            select: ['S'],
            pan: ['P'],
            zoom: ['Z'],
            merge: ['M'],
            measure: ['R'],
            move_segment: ['V'],
            move_shot: ['G'],
            move_station: ['T'],
            // Edit
            undo: ['Ctrl+Z'],
            redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
            // View
            toggle_depth_gradient: ['Shift+D'],
            toggle_grid: ['Shift+G'],
            toggle_satellite: ['B'],
            toggle_station_labels: ['L'],
            toggle_shot_labels: ['Shift+L'],
            toggle_section_labels: ['Ctrl+L'],
            fit_to_bounds: ['F'],
            zoom_in: ['Equal', 'Plus'],
            zoom_out: ['Minus'],
            // Panels (tests use Ctrl+ prefix)
            toggle_sections_panel: ['Ctrl+1'],
            toggle_detail_panel: ['Ctrl+2'],
            toggle_data_table: ['Ctrl+3'],
          },
          panels: {
            sections_panel_width: 250,
            detail_panel_width: 300,
            data_table_height: 200,
            wizard_map_panel_width: 480,
            data_table_shot_column_order: [],
            data_table_shot_hidden_columns: ['section_id', 'shot_id'],
            data_table_shot_column_widths: {},
            data_table_azimuth_mode: 'avg',
            data_table_inclination_mode: 'off',
            data_table_station_column_order: [],
            data_table_station_hidden_columns: ['_x', '_y', '_lat', '_long'],
            data_table_station_column_widths: {},
            // The new-section dialog's grid layout. Present (not omitted) for
            // the same reason as the reveal state below: get_config on a real
            // backend always serializes these, and the dialog treats an ABSENT
            // hidden list as "never stored, use the built-in defaults" but a
            // present empty one as "the user unhid everything".
            new_section_column_order: [],
            new_section_hidden_columns: [
              'azimuth_in',
              'azimuth_out',
              '_pitch_avg',
              'pitch_in',
              'pitch_out',
              'left',
              'right',
              'up',
              'down',
            ],
            new_section_column_widths: {},
            edit_section_column_order: [],
            edit_section_hidden_columns: [
              'azimuth_in',
              'azimuth_out',
              '_pitch_avg',
              'pitch_in',
              'pitch_out',
            ],
            import_shots_column_order: [],
            import_shots_hidden_columns: [
              'azimuth_in',
              'azimuth_out',
              '_pitch_avg',
              'pitch_in',
              'pitch_out',
            ],
            import_shots_column_widths: {},
            edit_section_column_widths: {},
            // Concrete reveal state so initPanels never falls back to its
            // defaults. Deliberately NOT the shipped default any more: a fresh
            // install opens the data table, but most specs want the map
            // unobstructed, so the fixture keeps it closed and the specs that
            // care about it open it themselves. The shipped default is pinned
            // in Rust (config::tests) and in uiStore.initPanels.test.ts.
            sections_panel_open: true,
            sections_panel_mode: 'pin',
            detail_panel_open: true,
            detail_panel_mode: 'pin',
            data_table_open: false,
            data_table_mode: 'pin',
            ...mockDataTableView,
            ...mockNewSectionView,
            ...mockEditSectionView,
            ...mockImportShotsView,
          },
          cache: {
            tile_cache_enabled: true,
            tile_cache_max_mb: 500,
            tile_ttl_days: 30,
          },
          debug: {
            map: {
              show_hitboxes: mockConfigOverrides.debug?.map?.show_hitboxes ?? false,
              log_hit_detection: mockConfigOverrides.debug?.map?.log_hit_detection ?? false,
            },
          },
          global_view: {
            fps_threshold: 30,
            tolerance: 0.5,
            throttle_tolerance: 1.0,
          },
          appearance: {
            theme: 'dark',
            day_color_theme: 'light',
            night_color_theme: 'cave',
          },
          syntactic_highlighting: {
            level: 'full',
            preset: 'default',
            overrides: {},
          },
          // Spread LAST so a stored `[gas]` block wins over the literal's
          // own, exactly as in get_config. (`panels` already picks up
          // mockDataTableView above.)
          ...(mockGasConfig ? { gas: mockGasConfig } : {}),
        };
        return baseConfig;
      }

      default:
        return ctx.unhandled;
    }
  };
};
