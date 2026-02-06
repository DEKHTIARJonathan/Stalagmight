import { themeTokens } from '../theme/tokens';
import type { Config, DisplayConfig, SectionColorsConfig } from './ipc.generated';

export type {
  LengthUnit,
  AngleUnit,
  ShortcutFeedback,
  ThemeMode,
  AppearanceConfig,
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
  ExportConfig,
  LoggingConfig,
  ShortcutsConfig,
  PanelsConfig,
  CacheConfig,
  GlobalViewConfig,
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
  },
  units: {
    length: 'meters',
    depth: 'meters',
    angle: 'degrees',
    decimal_precision: 1,
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
    draw: ['D'],
    delete_tool: ['X'],
    merge: ['M'],
    measure: ['R'],
    move_station: ['T'],
    move_segment: ['V'],
    move_shot: ['G'],

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
  },
  panels: {
    sections_panel_width: 250,
    detail_panel_width: 300,
    data_table_height: 200,
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

/**
 * Get theme-appropriate display defaults.
 * Returns dark-theme defaults for 'dark', light-theme defaults for 'light'.
 */
export function getThemedDisplayDefaults(resolvedTheme: 'dark' | 'light'): DisplayConfig {
  if (resolvedTheme === 'light') {
    return { ...lightDisplayDefaults, depth_gradient: { ...lightDisplayDefaults.depth_gradient } };
  }
  return {
    ...defaultConfig.display,
    depth_gradient: { ...defaultConfig.display.depth_gradient },
  };
}

/**
 * Get theme-appropriate section color defaults.
 * Returns dark-theme palette for 'dark', light-theme palette for 'light'.
 */
export function getThemedSectionColorDefaults(resolvedTheme: 'dark' | 'light'): SectionColorsConfig {
  if (resolvedTheme === 'light') {
    return { palette: [...lightSectionColorDefaults.palette] };
  }
  return { palette: [...defaultConfig.section_colors.palette] };
}
