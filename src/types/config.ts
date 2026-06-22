import { themeTokens } from '../theme/tokens';
import type { Config, DisplayConfig, SectionColorsConfig } from './ipc.generated';

export type {
  LengthUnit,
  AngleUnit,
  DecimalPrecision,
  ShortcutFeedback,
  ThemeMode,
  ColorTheme,
  AppearanceConfig,
  ImportConfig,
  OverlapMode,
  Config,
  GeneralConfig,
  UnitsConfig,
  DisplayConfig,
  DepthGradientConfig,
  SectionColorsConfig,
  GpsOrigin,
  StationConfig,
  ShotConfig,
  MapSnapConfig,
  MapAnimationConfig,
  DebugConfig,
  MapDebugConfig,
  MapConfig,
  MapControlsConfig,
  ValidationConfig,
  ClosureAdjustmentConfig,
  PlacementSuggestionConfig,
  ExportConfig,
  LoggingConfig,
  ShortcutsConfig,
  PanelsConfig,
  CacheConfig,
  GlobalViewConfig,
  SyntacticHighlightingConfig,
  SyntacticHighlightLevel,
  SyntacticHighlightPreset,
} from './ipc.generated';

export const defaultConfig: Config = {
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
    onboarding_enabled: true,
    onboarding_completed_flows: [],
    telemetry_enabled: false,
    telemetry_opt_in_shown: false,
  },
  units: {
    length: 'meters',
    depth: 'meters',
    angle: 'degrees',
    decimal_precision: { length: 1, coordinates: 2, depth: 1, azimuth: 1, inclination: 1, gps: 6 },
  },
  display: {
    default_background: themeTokens.dark['--cc-map-background'],
    grid_color: themeTokens.dark['--cc-grid-default'],
    grid_spacing: 10,
    font_size: 12,
    font_color: themeTokens.dark['--cc-depth-text'],
    depth_gradient: {
      enabled: false,
      shallow_color: '#00bfff',
      deep_color: '#ff4444',
      shallow_depth: 0.0,
      deep_depth: 50.0,
    },
    measure_path_color: '#22d3ee',
  },
  section_colors: {
    palette: [
      '#4ecdc4',
      '#ff6b6b',
      '#95e1d3',
      '#f38181',
      '#aa96da',
      '#fcbad3',
      '#a8d8ea',
      '#ffcb77',
    ],
  },
  map: {
    satellite_provider: 'esri',
    satellite_enabled: false,
    // Default to Florida Keys area - popular cave diving location
    satellite_gps_origin: { latitude: 24.55, longitude: -81.78 },
    zoom_default: 15,
    zoom_min: 0,
    zoom_max: 22,
    zoom_step: 1.0,
    controls: {
      pan_speed: 1.0,
      zoom_speed: 1.0,
      invert_scroll: false,
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
      enabled_merge: true,
      enabled_measure: true,
    },
    animation: {
      enabled: true,
      duration: 300,
      point_zoom: 18,
    },
    highlight_warnings_on_tab_switch: true,
  },
  validation: {
    // Keep in sync with the Rust ValidationConfig default
    // (src-tauri/src/config/defaults.rs): flag shots under 0.3 m.
    warn_shot_length_min: 0.3,
    warn_shot_length_max: 50.0,
    warn_depth_change_per_shot_max: 10.0,
    warn_azimuth_deviation_max: 30.0,
    azimuth_diff_threshold: 20.0,
    pitch_diff_threshold: 10.0,
    inclination_depth_diff_threshold: 15.0,
  },
  closure_adjustment: {
    base_sigma_length_m: 0.05,
    base_sigma_azimuth_deg: 1.0,
    base_sigma_depth_m: 0.05,
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
    // Tools
    select: ['S'],
    pan: ['P'],
    zoom: ['Z'],
    merge: ['M'],
    measure: ['R'],
    move_station: ['T'],
    move_segment: ['V'],
    move_shot: ['G'],
    comment_tool: ['C'],
    move_comment_tool: ['Shift+C'],

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

    // Panels
    toggle_sections_panel: ['1'],
    toggle_detail_panel: ['2'],
    toggle_data_table: ['3'],

    // File
    new_file: ['Ctrl+N'],
    open_file: ['Ctrl+O'],
    save: ['Ctrl+S'],
    save_as: ['Ctrl+Shift+S'],
    import_dmp: ['Ctrl+I'],
    export: ['Ctrl+E'],
    quit: ['Ctrl+Q'],
  },
  panels: {
    sections_panel_width: 250,
    detail_panel_width: 300,
    data_table_height: 200,
    data_table_shot_column_order: [],
    data_table_shot_hidden_columns: ['section_id', 'shot_id'],
    data_table_azimuth_mode: 'avg',
    data_table_inclination_mode: 'off',
    data_table_station_column_order: [],
    data_table_station_hidden_columns: ['_x', '_y', '_lat', '_long'],
    sections_panel_open: true,
    sections_panel_mode: 'pin',
    detail_panel_open: true,
    detail_panel_mode: 'pin',
    data_table_open: false,
    data_table_mode: 'pin',
  },
  cache: {
    tile_cache_enabled: true,
    tile_cache_max_mb: 500,
    tile_ttl_days: 30,
    providers: { esri: { offline_caching: false } },
  },
  debug: {
    map: {
      show_hitboxes: false,
      log_hit_detection: false,
    },
    memory_probe: false,
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
  import: {
    overlap_mode: 'import_data' as const,
  },
  syntactic_highlighting: {
    level: 'full',
    preset: 'default',
    overrides: {},
  },
  placement_suggestion: {
    azimuth_sigma: 18.0,
    length_sigma: 0.8,
    depth_sigma: 0.35,
    azimuth_weight: 0.35,
    length_weight: 0.25,
    depth_in_weight: 0.20,
    depth_out_weight: 0.20,
    min_shot_score: 0.15,
    min_aggregate_score: 0.45,
    max_reference_shots: 5,
    max_suggestions: 10,
    min_partial_ratio: 0.15,
    short_shot_threshold: 0.5,
    single_shot_penalty: 0.6,
    max_azimuth_error_full: 25.0,
    max_azimuth_error_partial: 35.0,
    max_depth_error: 0.30,
    max_length_error_fraction: 0.03,
    max_length_error_floor: 0.4,
  },
};

/**
 * Light-theme display defaults. Used when "Reset to defaults" is triggered
 * while the light theme is active. Colors are chosen for visibility on
 * light backgrounds.
 */
export const lightDisplayDefaults: DisplayConfig = {
  default_background: themeTokens.light['--cc-background'],
  grid_color: '#c1a07a',
  grid_spacing: 10,
  font_size: 12,
  font_color: themeTokens.light['--cc-text-primary'],
  depth_gradient: {
    enabled: false,
    shallow_color: '#0077b6',
    deep_color: '#c1121f',
    shallow_depth: 0.0,
    deep_depth: 50.0,
  },
  measure_path_color: '#22d3ee',
};

/**
 * Light-theme section color palette. Darker/more saturated colors that
 * are visually distinct on light backgrounds.
 */
export const lightSectionColorDefaults: SectionColorsConfig = {
  palette: [
    '#1a8a7d',
    '#c0392b',
    '#2e7d6e',
    '#b94a4a',
    '#6b4fa0',
    '#c4587a',
    '#2f7d9e',
    '#c7873a',
  ],
};

/** Themes that use light-mode display defaults (light backgrounds). */
const LIGHT_THEMES = new Set(['light', 'solarized_light', 'catppuccin_latte', 'kaleido_eink']);

/**
 * Get theme-appropriate display defaults.
 * Returns light-theme defaults for light-type themes, dark defaults otherwise.
 */
export function getThemedDisplayDefaults(resolvedTheme: string): DisplayConfig {
  if (LIGHT_THEMES.has(resolvedTheme)) {
    return { ...lightDisplayDefaults, depth_gradient: { ...lightDisplayDefaults.depth_gradient } };
  }
  return {
    ...defaultConfig.display,
    depth_gradient: { ...defaultConfig.display.depth_gradient },
  };
}

/**
 * Get theme-appropriate section color defaults.
 * Returns light-theme palette for light-type themes, dark palette otherwise.
 */
export function getThemedSectionColorDefaults(resolvedTheme: string): SectionColorsConfig {
  if (LIGHT_THEMES.has(resolvedTheme)) {
    return { palette: [...lightSectionColorDefaults.palette] };
  }
  return { palette: [...defaultConfig.section_colors.palette] };
}
