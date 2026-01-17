// Configuration types matching Rust config

export type LengthUnit = 'meters' | 'feet';
export type AngleUnit = 'degrees' | 'gradians';

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
  snap: SnapConfig;
  panels: PanelsConfig;
}

export interface GeneralConfig {
  auto_save: boolean;
  auto_save_interval_seconds: number;
  recent_projects_max: number;
  undo_history_limit: number;
  undo_persist_limit: number;
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
  station_size: number;
  line_thickness: number;
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

export interface MapConfig {
  satellite_provider: string;
  satellite_enabled: boolean;
  snap_threshold_pixels: number;
  zoom_default: number;
  zoom_min: number;
  zoom_max: number;
  controls: MapControlsConfig;
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
  select: string;
  pan: string;
  zoom: string;
  draw: string;
  delete: string;
  merge: string;
  measure: string;
  move_section: string;
  move_station: string;
  undo: string;
  redo: string;
  save: string;
}

export interface SnapConfig {
  enabled_draw: boolean;
  enabled_merge: boolean;
  enabled_measure: boolean;
  threshold_pixels: number;
}

export interface PanelsConfig {
  sections_panel_width: number;
  detail_panel_width: number;
  data_table_height: number;
}

export const defaultConfig: Config = {
  general: {
    auto_save: true,
    auto_save_interval_seconds: 30,
    recent_projects_max: 20,
    undo_history_limit: 100,
    undo_persist_limit: 20,
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
    station_size: 6,
    line_thickness: 2,
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
    satellite_provider: 'openstreetmap',
    satellite_enabled: false,
    snap_threshold_pixels: 10,
    zoom_default: 15,
    zoom_min: 1,
    zoom_max: 22,
    controls: {
      pan_speed: 1.0,
      zoom_speed: 1.0,
      invert_scroll: false,
    },
  },
  validation: {
    warn_shot_length_min: 0.1,
    warn_shot_length_max: 50.0,
    warn_depth_change_per_shot_max: 10.0,
    warn_azimuth_deviation_max: 30.0,
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
    select: 'S',
    pan: 'P',
    zoom: 'Z',
    draw: 'D',
    delete: 'X',
    merge: 'M',
    measure: 'R',
    move_section: 'V',
    move_station: 'T',
    undo: 'Ctrl+Z',
    redo: 'Ctrl+Y',
    save: 'Ctrl+S',
  },
  snap: {
    enabled_draw: true,
    enabled_merge: true,
    enabled_measure: true,
    threshold_pixels: 10,
  },
  panels: {
    sections_panel_width: 250,
    detail_panel_width: 300,
    data_table_height: 200,
  },
};
