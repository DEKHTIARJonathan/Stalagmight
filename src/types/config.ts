// Configuration types matching Rust config

export type LengthUnit = 'meters' | 'feet';
export type AngleUnit = 'degrees' | 'gradians';

/**
 * Shortcut feedback preference for toast notifications.
 * - 'none': No toasts for any shortcuts
 * - 'non_obvious': Toast for view/panel toggles only (default)
 * - 'all': Toast for all shortcut actions
 */
export type ShortcutFeedback = 'none' | 'non_obvious' | 'all';

export interface Config {
  general: GeneralConfig;
  units: UnitsConfig;
  display: DisplayConfig;
  section_colors: SectionColorsConfig;
  map: MapConfig;
  validation: ValidationConfig;
  export: ExportConfig;
  logging: LoggingConfig;
  shortcuts: ShortcutsConfig;
  panels: PanelsConfig;
  cache: CacheConfig;
  debug: DebugConfig;
  global_view: GlobalViewConfig;
}

export interface GeneralConfig {
  auto_save: boolean;
  auto_save_interval_seconds: number;
  recent_projects_max: number;
  undo_history_limit: number;
  undo_persist_limit: number;
  /** Shortcut feedback preference: none, non_obvious (default), or all */
  shortcut_feedback: ShortcutFeedback;
}

export interface UnitsConfig {
  length: LengthUnit;
  depth: LengthUnit;
  angle: AngleUnit;
  decimal_precision: number;
}

export interface DisplayConfig {
  default_background: string;
  grid_color: string;
  /** Grid spacing in meters (e.g., 1, 5, 10, 25, 50) */
  grid_spacing: number;
  font_size: number;
  font_color: string;
  depth_gradient: DepthGradientConfig;
}

export interface DepthGradientConfig {
  enabled: boolean;
  shallow_color: string;
  deep_color: string;
  shallow_depth: number;
  deep_depth: number;
}

export interface SectionColorsConfig {
  palette: string[];
}

export interface GpsOrigin {
  latitude: number;
  longitude: number;
}

/** Station visual and interaction configuration */
export interface StationConfig {
  /** Visual radius in pixels (1.0-50.0) */
  radius: number;
  /** Clickable area radius in pixels (1.0-50.0, >= radius) */
  hit_area: number;
  /** Radius when hovered (1.0-50.0, typically > radius) */
  hover_radius: number;
  /** Radius when selected (1.0-50.0, typically > radius) */
  selection_radius: number;
}

/** Shot visual and interaction configuration */
export interface ShotConfig {
  /** Visual line width in pixels (0.5-20.0) */
  width: number;
  /** Clickable area width in pixels (0.5-20.0, >= width) */
  hit_area: number;
  /** Width when hovered (0.5-20.0, typically > width) */
  hover_width: number;
  /** Width when selected (0.5-20.0, typically > width) */
  selection_width: number;
}

/** Snap-to-station configuration for precision tools */
export interface MapSnapConfig {
  /** Snap threshold in pixels (1.0-50.0) */
  threshold: number;
  /** Enable snap for draw tool */
  enabled_draw: boolean;
  /** Enable snap for merge tool */
  enabled_merge: boolean;
  /** Enable snap for measure tool */
  enabled_measure: boolean;
}

/** Animation configuration for map focus transitions */
export interface MapAnimationConfig {
  /** Whether animations are enabled */
  enabled: boolean;
  /** Animation duration in milliseconds */
  duration: number;
  /** Zoom level for single-point focus */
  point_zoom: number;
}

/** Debug configuration */
export interface DebugConfig {
  map: MapDebugConfig;
}

/** Map-specific debug options */
export interface MapDebugConfig {
  /** Show hitbox visualization for debugging */
  show_hitboxes: boolean;
  /** Log hit detection events to console */
  log_hit_detection: boolean;
}

export interface MapConfig {
  satellite_provider: string;
  satellite_enabled: boolean;
  /** GPS origin for satellite tile alignment. Defaults to Florida Keys area. */
  satellite_gps_origin: GpsOrigin;
  zoom_default: number;
  zoom_min: number;
  zoom_max: number;
  /** Zoom step for click-to-zoom (default: 1.0, range: 0.1-5.0) */
  zoom_step: number;
  controls: MapControlsConfig;
  /** Station visual and interaction settings */
  station: StationConfig;
  /** Shot visual and interaction settings */
  shot: ShotConfig;
  /** Snap-to-station settings */
  snap: MapSnapConfig;
  /** Animation settings for map focus transitions */
  animation: MapAnimationConfig;
}

export interface MapControlsConfig {
  pan_speed: number;
  zoom_speed: number;
  invert_scroll: boolean;
}

export interface ValidationConfig {
  warn_shot_length_min: number;
  warn_shot_length_max: number;
  warn_depth_change_per_shot_max: number;
  warn_azimuth_deviation_max: number;
  /** Threshold for azimuth in/out difference warning (degrees). Default: 10 */
  azimuth_diff_threshold: number;
  /** Threshold for pitch in/out difference warning (degrees). Default: 5 */
  pitch_diff_threshold: number;
}

export interface ExportConfig {
  default_image_format: string;
  default_dpi: number;
  default_include_satellite: boolean;
  default_include_grid: boolean;
  default_include_labels: boolean;
}

export interface LoggingConfig {
  level: string;
  max_directory_size_mb: number;
}

export interface ShortcutsConfig {
  // Tools
  select: string[];
  pan: string[];
  zoom: string[];
  draw: string[];
  delete_tool: string[];
  merge: string[];
  measure: string[];
  move_section: string[];
  move_station: string[];

  // Edit
  undo: string[];
  redo: string[];

  // View
  toggle_depth_gradient: string[];
  toggle_grid: string[];
  toggle_satellite: string[];
  toggle_station_labels: string[];
  toggle_shot_labels: string[];
  toggle_section_labels: string[];
  fit_to_bounds: string[];
  zoom_in: string[];
  zoom_out: string[];

  // Panels
  toggle_sections_panel: string[];
  toggle_detail_panel: string[];
  toggle_data_table: string[];

  // File
  new_file: string[];
  open_file: string[];
  save: string[];
  save_as: string[];
  import_dmp: string[];
  export: string[];
}

export interface PanelsConfig {
  sections_panel_width: number;
  detail_panel_width: number;
  data_table_height: number;
}

export interface CacheConfig {
  /** Enable tile caching for offline access */
  tile_cache_enabled: boolean;
  /** Maximum cache size in megabytes */
  tile_cache_max_mb: number;
  /** Time-to-live for cached tiles in days */
  tile_ttl_days: number;
}

/** Global view (multi-system map) configuration */
export interface GlobalViewConfig {
  /** FPS threshold below which auto-throttle activates (default: 30) */
  fps_threshold: number;
  /** GeoJSON simplification tolerance at normal FPS (default: 0.5) */
  tolerance: number;
  /** GeoJSON simplification tolerance when throttled (default: 1.0) */
  throttle_tolerance: number;
}

export const defaultConfig: Config = {
  general: {
    auto_save: true,
    auto_save_interval_seconds: 30,
    recent_projects_max: 20,
    undo_history_limit: 100,
    undo_persist_limit: 20,
    shortcut_feedback: 'non_obvious',
  },
  units: {
    length: 'meters',
    depth: 'meters',
    angle: 'degrees',
    decimal_precision: 1,
  },
  display: {
    default_background: '#1a1a2e',
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
    azimuth_diff_threshold: 10.0,
    pitch_diff_threshold: 5.0,
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
    move_section: ['V'],
    move_station: ['T'],

    // Edit
    undo: ['Ctrl+Z'],
    redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],

    // View
    toggle_depth_gradient: ['G'],
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
};
