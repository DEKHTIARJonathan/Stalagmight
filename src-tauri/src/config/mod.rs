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
    pub snap: SnapConfig,
    #[serde(default)]
    pub panels: PanelsConfig,
    #[serde(default)]
    pub cache: CacheConfig,
}

/// Snap-to-station configuration for precision tools
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapConfig {
    /// Enable snap for draw tool
    pub enabled_draw: bool,
    /// Enable snap for merge tool
    pub enabled_merge: bool,
    /// Enable snap for measure tool
    pub enabled_measure: bool,
    /// Snap threshold in pixels
    pub threshold_pixels: u32,
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
    pub tile_cache_enabled: bool,
    /// Maximum cache size in megabytes
    pub tile_cache_max_mb: u32,
    /// Time-to-live for cached tiles in days
    pub tile_ttl_days: u32,
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
    pub station_size: u32,
    pub line_thickness: u32,
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
pub struct MapConfig {
    pub satellite_provider: String,
    pub satellite_enabled: bool,
    pub snap_threshold_pixels: u32,
    pub zoom_default: u32,
    pub zoom_min: u32,
    pub zoom_max: u32,
    pub controls: MapControlsConfig,
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
            let config: Config = toml::from_str(&contents).context("Failed to parse config file")?;
            tracing::info!(?config_path, "Loaded config from file");
            Ok(config)
        } else {
            tracing::info!("Using default config");
            Ok(Self::default())
        }
    }

    /// Save config to file
    pub fn save(&self) -> Result<()> {
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
