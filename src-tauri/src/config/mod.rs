pub mod defaults;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Application configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub general: GeneralConfig,
    pub units: UnitsConfig,
    pub display: DisplayConfig,
    pub section_colors: SectionColorsConfig,
    pub map: MapConfig,
    pub validation: ValidationConfig,
    pub export: ExportConfig,
    pub logging: LoggingConfig,
    pub shortcuts: ShortcutsConfig,
    #[serde(default)]
    pub panels: PanelsConfig,
    #[serde(default)]
    pub cache: CacheConfig,
    #[serde(default)]
    pub debug: DebugConfig,
}

/// Station visual and interaction configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationConfig {
    /// Visual radius in pixels (1.0-50.0)
    #[serde(default = "default_station_radius")]
    pub radius: f64,
    /// Clickable area radius in pixels (1.0-50.0, >= radius)
    #[serde(default = "default_station_hit_area")]
    pub hit_area: f64,
}

impl StationConfig {
    pub fn normalize(&mut self) {
        if !self.radius.is_finite() {
            self.radius = default_station_radius();
        }
        if !self.hit_area.is_finite() {
            self.hit_area = default_station_hit_area();
        }
        self.radius = self.radius.clamp(1.0, 50.0);
        self.hit_area = self.hit_area.clamp(1.0, 50.0).max(self.radius);
    }
}

impl Default for StationConfig {
    fn default() -> Self {
        Self {
            radius: default_station_radius(),
            hit_area: default_station_hit_area(),
        }
    }
}

fn default_station_radius() -> f64 {
    4.0
}

fn default_station_hit_area() -> f64 {
    10.0
}

/// Shot visual and interaction configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShotConfig {
    /// Visual line width in pixels (0.5-20.0)
    #[serde(default = "default_shot_width")]
    pub width: f64,
    /// Clickable area width in pixels (0.5-20.0, >= width)
    #[serde(default = "default_shot_hit_area")]
    pub hit_area: f64,
}

impl ShotConfig {
    pub fn normalize(&mut self) {
        if !self.width.is_finite() {
            self.width = default_shot_width();
        }
        if !self.hit_area.is_finite() {
            self.hit_area = default_shot_hit_area();
        }
        self.width = self.width.clamp(0.5, 20.0);
        self.hit_area = self.hit_area.clamp(0.5, 20.0).max(self.width);
    }
}

impl Default for ShotConfig {
    fn default() -> Self {
        Self {
            width: default_shot_width(),
            hit_area: default_shot_hit_area(),
        }
    }
}

fn default_shot_width() -> f64 {
    2.0
}

fn default_shot_hit_area() -> f64 {
    8.0
}

/// Snap-to-station configuration for precision tools
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapSnapConfig {
    /// Snap threshold in pixels (1.0-50.0)
    #[serde(default = "default_snap_threshold")]
    pub threshold: f64,
    /// Enable snap for draw tool
    #[serde(default = "default_true")]
    pub enabled_draw: bool,
    /// Enable snap for merge tool
    #[serde(default = "default_true")]
    pub enabled_merge: bool,
    /// Enable snap for measure tool
    #[serde(default = "default_true")]
    pub enabled_measure: bool,
}

impl MapSnapConfig {
    pub fn normalize(&mut self) {
        if !self.threshold.is_finite() {
            self.threshold = default_snap_threshold();
        }
        self.threshold = self.threshold.clamp(1.0, 50.0);
    }
}

impl Default for MapSnapConfig {
    fn default() -> Self {
        Self {
            threshold: default_snap_threshold(),
            enabled_draw: true,
            enabled_merge: true,
            enabled_measure: true,
        }
    }
}

fn default_snap_threshold() -> f64 {
    10.0
}

fn default_true() -> bool {
    true
}

/// Debug configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DebugConfig {
    #[serde(default)]
    pub map: MapDebugConfig,
}

/// Map-specific debug options
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MapDebugConfig {
    /// Show hitbox visualization for debugging
    #[serde(default)]
    pub show_hitboxes: bool,
    /// Log hit detection events to console
    #[serde(default)]
    pub log_hit_detection: bool,
}

/// Panel sizes configuration (persisted across sessions)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelsConfig {
    /// Sections panel width in pixels
    pub sections_panel_width: u32,
    /// Detail panel width in pixels
    pub detail_panel_width: u32,
    /// Data table height in pixels
    pub data_table_height: u32,
}

/// Tile cache configuration for offline satellite imagery
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    /// Enable tile caching for offline access
    #[serde(default = "default_tile_cache_enabled")]
    pub tile_cache_enabled: bool,
    /// Maximum cache size in megabytes
    #[serde(default = "default_tile_cache_max_mb")]
    pub tile_cache_max_mb: u32,
    /// Time-to-live for cached tiles in days
    #[serde(default = "default_tile_ttl_days")]
    pub tile_ttl_days: u32,
}

fn default_tile_cache_enabled() -> bool {
    true
}

fn default_tile_cache_max_mb() -> u32 {
    500
}

fn default_tile_ttl_days() -> u32 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralConfig {
    pub auto_save: bool,
    pub auto_save_interval_seconds: u32,
    pub recent_projects_max: usize,
    #[serde(default)]
    pub recent_projects: Vec<PathBuf>,
    /// Maximum undo history entries to keep in memory (default: 100)
    #[serde(default = "default_undo_history_limit")]
    pub undo_history_limit: usize,
    /// Maximum undo entries to persist to project file (default: 20)
    #[serde(default = "default_undo_persist_limit")]
    pub undo_persist_limit: usize,
}

fn default_undo_history_limit() -> usize {
    100
}

fn default_undo_persist_limit() -> usize {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnitsConfig {
    pub length: LengthUnit,
    pub depth: LengthUnit,
    pub angle: AngleUnit,
    pub decimal_precision: u8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LengthUnit {
    Meters,
    Feet,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AngleUnit {
    Degrees,
    Gradians,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayConfig {
    pub default_background: String,
    pub grid_color: String,
    /// Grid spacing in meters (e.g., 1, 5, 10, 25, 50)
    #[serde(default = "default_grid_spacing")]
    pub grid_spacing: f64,
    pub font_size: u32,
    pub font_color: String,
    pub depth_gradient: DepthGradientConfig,
}

fn default_grid_spacing() -> f64 {
    10.0
}

fn default_azimuth_diff_threshold() -> f64 {
    10.0
}

fn default_pitch_diff_threshold() -> f64 {
    5.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthGradientConfig {
    pub enabled: bool,
    pub shallow_color: String,
    pub deep_color: String,
    pub shallow_depth: f64,
    pub deep_depth: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionColorsConfig {
    pub palette: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpsOrigin {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapConfig {
    pub satellite_provider: String,
    pub satellite_enabled: bool,
    /// GPS origin for satellite tile alignment
    #[serde(default = "default_satellite_gps_origin")]
    pub satellite_gps_origin: GpsOrigin,
    pub zoom_default: u32,
    pub zoom_min: u32,
    pub zoom_max: u32,
    /// Zoom step for click-to-zoom (default: 1.0, range: 0.1-5.0)
    #[serde(default = "default_zoom_step")]
    pub zoom_step: f64,
    pub controls: MapControlsConfig,
    /// Station visual and interaction settings
    #[serde(default)]
    pub station: StationConfig,
    /// Shot visual and interaction settings
    #[serde(default)]
    pub shot: ShotConfig,
    /// Snap-to-station settings
    #[serde(default)]
    pub snap: MapSnapConfig,
}

impl MapConfig {
    /// Normalize all float values to valid ranges
    /// Also handles NaN/inf by falling back to defaults
    pub fn normalize(&mut self) {
        if !self.zoom_step.is_finite() {
            self.zoom_step = default_zoom_step();
        } else {
            self.zoom_step = self.zoom_step.clamp(0.1, 5.0);
        }
        self.station.normalize();
        self.shot.normalize();
        self.snap.normalize();
    }
}

fn default_zoom_step() -> f64 {
    1.0
}

fn default_satellite_gps_origin() -> GpsOrigin {
    GpsOrigin {
        latitude: 24.55,
        longitude: -81.78,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapControlsConfig {
    pub pan_speed: f64,
    pub zoom_speed: f64,
    pub invert_scroll: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationConfig {
    pub warn_shot_length_min: f64,
    pub warn_shot_length_max: f64,
    pub warn_depth_change_per_shot_max: f64,
    pub warn_azimuth_deviation_max: f64,
    /// Threshold for azimuth in/out difference warning (degrees).
    /// If abs(diff - 180) > threshold, show warning.
    #[serde(default = "default_azimuth_diff_threshold")]
    pub azimuth_diff_threshold: f64,
    /// Threshold for pitch in/out difference warning (degrees).
    #[serde(default = "default_pitch_diff_threshold")]
    pub pitch_diff_threshold: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportConfig {
    pub default_image_format: String,
    pub default_dpi: u32,
    pub default_include_satellite: bool,
    pub default_include_grid: bool,
    pub default_include_labels: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    pub level: String,
    pub max_directory_size_mb: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutsConfig {
    pub select: String,
    pub pan: String,
    pub zoom: String,
    pub draw: String,
    pub delete: String,
    pub merge: String,
    pub measure: String,
    pub move_section: String,
    pub move_station: String,
    pub undo: String,
    pub redo: String,
    pub save: String,
}

impl Config {
    /// Load config from file, falling back to defaults
    pub fn load() -> Result<Self> {
        let config_path = Self::config_path()?;

        if config_path.exists() {
            let contents =
                std::fs::read_to_string(&config_path).context("Failed to read config file")?;
            let mut config: Config = toml::from_str(&contents).context("Failed to parse config file")?;
            config.map.normalize();
            tracing::info!(?config_path, "Loaded config from file");
            Ok(config)
        } else {
            tracing::info!("Using default config");
            Ok(Self::default())
        }
    }

    /// Save config to file
    pub fn save(&mut self) -> Result<()> {
        self.map.normalize();
        let config_path = Self::config_path()?;

        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).context("Failed to create config directory")?;
        }

        let contents = toml::to_string_pretty(self).context("Failed to serialize config")?;
        std::fs::write(&config_path, contents).context("Failed to write config file")?;
        tracing::info!(?config_path, "Saved config to file");
        Ok(())
    }

    /// Get the config file path
    pub fn config_path() -> Result<PathBuf> {
        let dirs =
            directories::ProjectDirs::from("com", "cavechef", "CaveChef").context("No home directory")?;
        Ok(dirs.config_dir().join("config.toml"))
    }

    /// Get the next section color from the palette
    pub fn next_section_color(&self, used_colors: &[String]) -> String {
        for color in &self.section_colors.palette {
            if !used_colors.contains(color) {
                return color.clone();
            }
        }
        // If all colors used, start from beginning
        self.section_colors
            .palette
            .first()
            .cloned()
            .unwrap_or_else(|| "#4ecdc4".to_string())
    }
}
