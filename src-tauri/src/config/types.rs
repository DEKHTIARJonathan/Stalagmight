use anyhow::{Context, Result};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use ts_rs::TS;


/// Application configuration
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Config {
    pub general: GeneralConfig,
    pub units: UnitsConfig,
    pub display: DisplayConfig,
    pub section_colors: SectionColorsConfig,
    pub map: MapConfig,
    pub validation: ValidationConfig,
    #[serde(default)]
    pub closure_adjustment: ClosureAdjustmentConfig,
    pub export: ExportConfig,
    pub logging: LoggingConfig,
    pub shortcuts: ShortcutsConfig,
    #[serde(default)]
    pub panels: PanelsConfig,
    #[serde(default)]
    pub cache: CacheConfig,
    #[serde(default)]
    pub debug: DebugConfig,
    #[serde(default)]
    pub global_view: GlobalViewConfig,
    #[serde(default)]
    pub appearance: AppearanceConfig,
    #[serde(default)]
    pub import: ImportConfig,
    #[serde(default)]
    pub placement_suggestion: PlacementSuggestionConfig,

    // Legacy fields for backwards compatibility (deserialize only, never serialize)
    // Uses alias to match old TOML key name while keeping internal field name distinct
    #[serde(default, skip_serializing, alias = "snap")]
    #[ts(skip)]
    pub(super) legacy_snap: Option<LegacySnapConfig>,
}

/// Legacy snap config for migration from old [snap] section
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub(super) struct LegacySnapConfig {
    #[serde(default)]
    enabled_draw: Option<bool>,
    #[serde(default)]
    enabled_merge: Option<bool>,
    #[serde(default)]
    enabled_measure: Option<bool>,
    /// Old threshold was u32, but accept f64 for forward compatibility
    #[serde(default)]
    threshold_pixels: Option<f64>,
}

/// Station visual and interaction configuration
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct StationConfig {
    /// Visual radius in pixels (1.0-50.0)
    #[serde(default = "default_station_radius")]
    pub radius: f64,
    /// Clickable area radius in pixels (1.0-50.0, >= radius)
    #[serde(default = "default_station_hit_area")]
    pub hit_area: f64,
    /// Radius when hovered (1.0-50.0, typically > radius)
    #[serde(default = "default_station_hover_radius")]
    pub hover_radius: f64,
    /// Radius when selected (1.0-50.0, typically > radius)
    #[serde(default = "default_station_selection_radius")]
    pub selection_radius: f64,
}

impl StationConfig {
    pub fn normalize(&mut self) {
        if !self.radius.is_finite() {
            self.radius = default_station_radius();
        }
        if !self.hit_area.is_finite() {
            self.hit_area = default_station_hit_area();
        }
        if !self.hover_radius.is_finite() {
            self.hover_radius = default_station_hover_radius();
        }
        if !self.selection_radius.is_finite() {
            self.selection_radius = default_station_selection_radius();
        }
        self.radius = self.radius.clamp(1.0, 50.0);
        self.hit_area = self.hit_area.clamp(1.0, 50.0).max(self.radius);
        self.hover_radius = self.hover_radius.clamp(1.0, 50.0);
        self.selection_radius = self.selection_radius.clamp(1.0, 50.0);
    }
}

impl Default for StationConfig {
    fn default() -> Self {
        Self {
            radius: default_station_radius(),
            hit_area: default_station_hit_area(),
            hover_radius: default_station_hover_radius(),
            selection_radius: default_station_selection_radius(),
        }
    }
}

fn default_station_radius() -> f64 {
    4.0
}

fn default_station_hit_area() -> f64 {
    10.0
}

fn default_station_hover_radius() -> f64 {
    6.0
}

fn default_station_selection_radius() -> f64 {
    5.0
}

/// Shot visual and interaction configuration
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ShotConfig {
    /// Visual line width in pixels (0.5-20.0)
    #[serde(default = "default_shot_width")]
    pub width: f64,
    /// Clickable area width in pixels (0.5-20.0, >= width)
    #[serde(default = "default_shot_hit_area")]
    pub hit_area: f64,
    /// Width when hovered (0.5-20.0, typically > width)
    #[serde(default = "default_shot_hover_width")]
    pub hover_width: f64,
    /// Width when selected (0.5-20.0, typically > width)
    #[serde(default = "default_shot_selection_width")]
    pub selection_width: f64,
}

impl ShotConfig {
    pub fn normalize(&mut self) {
        if !self.width.is_finite() {
            self.width = default_shot_width();
        }
        if !self.hit_area.is_finite() {
            self.hit_area = default_shot_hit_area();
        }
        if !self.hover_width.is_finite() {
            self.hover_width = default_shot_hover_width();
        }
        if !self.selection_width.is_finite() {
            self.selection_width = default_shot_selection_width();
        }
        self.width = self.width.clamp(0.5, 20.0);
        self.hit_area = self.hit_area.clamp(0.5, 20.0).max(self.width);
        self.hover_width = self.hover_width.clamp(0.5, 20.0);
        self.selection_width = self.selection_width.clamp(0.5, 20.0);
    }
}

impl Default for ShotConfig {
    fn default() -> Self {
        Self {
            width: default_shot_width(),
            hit_area: default_shot_hit_area(),
            hover_width: default_shot_hover_width(),
            selection_width: default_shot_selection_width(),
        }
    }
}

fn default_shot_width() -> f64 {
    2.0
}

fn default_shot_hit_area() -> f64 {
    8.0
}

fn default_shot_hover_width() -> f64 {
    4.0
}

fn default_shot_selection_width() -> f64 {
    3.0
}

/// Snap-to-station configuration for precision tools
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

/// Animation configuration for map focus transitions
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct MapAnimationConfig {
    /// Whether animations are enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Animation duration in milliseconds
    #[serde(default = "default_animation_duration")]
    pub duration: u32,
    /// Zoom level for single-point focus
    #[serde(default = "default_point_zoom")]
    pub point_zoom: u8,
}

impl Default for MapAnimationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            duration: default_animation_duration(),
            point_zoom: default_point_zoom(),
        }
    }
}

fn default_animation_duration() -> u32 {
    300
}

fn default_point_zoom() -> u8 {
    18
}

/// Debug configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct DebugConfig {
    #[serde(default)]
    pub map: MapDebugConfig,
    /// Show the on-screen memory probe overlay (Ctrl+Shift+M toggles).
    /// Polls /proc for backend + WebKit child RSS and shows in-process
    /// counters for the JS heap retention sinks (geometryData, MapLibre
    /// feature counts, etc).
    #[serde(default)]
    pub memory_probe: bool,
}

/// Map-specific debug options
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct MapDebugConfig {
    /// Show hitbox visualization for debugging
    #[serde(default)]
    pub show_hitboxes: bool,
    /// Log hit detection events to console
    #[serde(default)]
    pub log_hit_detection: bool,
}

/// Panel sizes configuration (persisted across sessions)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PanelsConfig {
    /// Sections panel width in pixels
    pub sections_panel_width: u32,
    /// Detail panel width in pixels
    pub detail_panel_width: u32,
    /// Data table height in pixels
    pub data_table_height: u32,
}

/// Per-provider cache override
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProviderCacheConfig {
    /// Whether offline caching is enabled for this provider
    #[serde(default = "default_true")]
    pub offline_caching: bool,
}

/// Tile cache configuration for offline satellite imagery
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
    /// Per-provider cache overrides (providers not listed default to enabled)
    #[serde(default)]
    pub providers: HashMap<String, ProviderCacheConfig>,
}

impl CacheConfig {
    /// Check whether caching is enabled for a specific provider.
    /// Returns false if the global toggle is off, or if the provider
    /// has explicitly disabled offline caching.
    pub fn is_provider_cache_enabled(&self, provider: &str) -> bool {
        if !self.tile_cache_enabled {
            return false;
        }
        self.providers
            .get(provider)
            .map_or(true, |p| p.offline_caching)
    }
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

/// Global view configuration for multi-system map rendering
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GlobalViewConfig {
    /// FPS threshold below which auto-throttle activates
    #[serde(default = "default_fps_threshold")]
    pub fps_threshold: u32,
    /// GeoJSON simplification tolerance at normal FPS
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
    /// GeoJSON simplification tolerance when throttled (higher = more simplification)
    #[serde(default = "default_throttle_tolerance")]
    pub throttle_tolerance: f64,
}

impl GlobalViewConfig {
    /// Normalize values to valid ranges
    pub fn normalize(&mut self) {
        if !self.tolerance.is_finite() {
            self.tolerance = default_tolerance();
        }
        if !self.throttle_tolerance.is_finite() {
            self.throttle_tolerance = default_throttle_tolerance();
        }
        // Ensure tolerance values are positive
        self.tolerance = self.tolerance.max(0.0);
        self.throttle_tolerance = self.throttle_tolerance.max(0.0);
        // Ensure throttle_tolerance >= tolerance
        if self.throttle_tolerance < self.tolerance {
            self.throttle_tolerance = self.tolerance;
        }
    }
}

impl Default for GlobalViewConfig {
    fn default() -> Self {
        Self {
            fps_threshold: default_fps_threshold(),
            tolerance: default_tolerance(),
            throttle_tolerance: default_throttle_tolerance(),
        }
    }
}

/// Theme mode for the application.
/// Uses `#[serde(other)]` on Unknown variant so that invalid/unrecognized
/// theme values in TOML don't prevent config loading; they are coerced to
/// Dark during normalize().
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    Dark,
    Light,
    Auto,
    /// Catch-all for unrecognized theme values; normalized to Dark
    #[serde(other, rename = "unknown")]
    Unknown,
}

/// Color theme (palette) for a given mode.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ColorTheme {
    Dark,
    Light,
    Cave,
    Dracula,
    OneDark,
    SolarizedLight,
    CatppuccinLatte,
    Nord,
    CatppuccinMocha,
    KaleidoEink,
}

/// Appearance configuration
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AppearanceConfig {
    #[serde(default)]
    pub theme: ThemeMode,
    /// Color palette used when day (light) mode is active
    #[serde(default = "default_day_color_theme")]
    pub day_color_theme: ColorTheme,
    /// Color palette used when night (dark) mode is active
    #[serde(default = "default_night_color_theme")]
    pub night_color_theme: ColorTheme,
}

fn default_day_color_theme() -> ColorTheme {
    ColorTheme::Light
}

fn default_night_color_theme() -> ColorTheme {
    ColorTheme::Cave
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: ThemeMode::default(),
            day_color_theme: default_day_color_theme(),
            night_color_theme: default_night_color_theme(),
        }
    }
}

impl AppearanceConfig {
    /// Normalize appearance values: invalid/unknown theme resets to "dark"
    pub fn normalize(&mut self) {
        if self.theme == ThemeMode::Unknown {
            tracing::warn!("Unknown theme value in config, normalizing to \"dark\"");
            self.theme = ThemeMode::Dark;
        }
    }
}

/// How overlap shots are handled during import connection
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OverlapMode {
    #[default]
    ImportData,
    ExistingData,
    Interpolate,
    KeepBoth,
}

/// Import-related configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[ts(export)]
pub struct ImportConfig {
    #[serde(default)]
    pub overlap_mode: OverlapMode,
}

fn default_fps_threshold() -> u32 {
    30
}

fn default_tolerance() -> f64 {
    0.5
}

fn default_throttle_tolerance() -> f64 {
    1.0
}

/// Shortcut feedback preference for toast notifications
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ShortcutFeedback {
    /// No toasts for any shortcuts
    None,
    /// Toast for view/panel toggles only (default)
    #[default]
    NonObvious,
    /// Toast for all shortcut actions
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GeneralConfig {
    pub auto_save: bool,
    pub auto_save_interval_seconds: u32,
    pub recent_projects_max: usize,
    #[serde(default)]
    #[ts(type = "string[]")]
    pub recent_projects: Vec<PathBuf>,
    /// Maximum undo history entries to keep in memory (default: 100)
    #[serde(default = "default_undo_history_limit")]
    pub undo_history_limit: usize,
    /// Maximum undo entries to persist to project file (default: 20)
    #[serde(default = "default_undo_persist_limit")]
    pub undo_persist_limit: usize,
    /// Shortcut feedback preference: none, non_obvious (default), or all
    #[serde(default)]
    pub shortcut_feedback: ShortcutFeedback,
    /// Locale setting: 'system' or a specific locale tag (e.g., 'en-US')
    #[serde(default = "default_locale")]
    pub locale: String,
    /// Number format override: 'locale' (follow language setting) or a locale tag (e.g., 'de-DE')
    #[serde(default = "default_format_locale")]
    pub number_format: String,
    /// Date format override: 'locale' (follow language setting) or a locale tag (e.g., 'en-GB')
    #[serde(default = "default_format_locale")]
    pub date_format: String,
    /// Show splash screen with branding on startup
    #[serde(default)]
    pub splash_screen: bool,
    /// Global onboarding master switch
    #[serde(default = "default_onboarding_enabled")]
    pub onboarding_enabled: bool,
    /// Onboarding flow IDs already completed/skipped by the user
    #[serde(default)]
    pub onboarding_completed_flows: Vec<String>,
    /// Whether anonymous telemetry is enabled
    #[serde(default)]
    pub telemetry_enabled: bool,
    /// Whether the telemetry opt-in dialog has been shown
    #[serde(default)]
    pub telemetry_opt_in_shown: bool,
}

fn default_locale() -> String {
    "system".to_string()
}

fn default_format_locale() -> String {
    "locale".to_string()
}

fn default_onboarding_enabled() -> bool {
    true
}

fn default_undo_history_limit() -> usize {
    100
}

fn default_undo_persist_limit() -> usize {
    20
}

/// Per-category decimal precision settings.
/// Each field controls the number of decimal places for a specific measurement category.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DecimalPrecision {
    /// Shot lengths, path lengths, misclosure distances, LRUD
    #[serde(default = "default_precision_length")]
    pub length: u8,
    /// Station X, Y positions
    #[serde(default = "default_precision_coordinates")]
    pub coordinates: u8,
    /// Z coordinate, depth values
    #[serde(default = "default_precision_depth")]
    pub depth: u8,
    /// Compass bearings / azimuths
    #[serde(default = "default_precision_azimuth")]
    pub azimuth: u8,
    /// Pitch / dip angles
    #[serde(default = "default_precision_inclination")]
    pub inclination: u8,
    /// Latitude, longitude
    #[serde(default = "default_precision_gps")]
    pub gps: u8,
}

impl DecimalPrecision {
    /// Clamp all fields to the valid range 0-6
    pub fn normalize(&mut self) {
        self.length = self.length.min(6);
        self.coordinates = self.coordinates.min(6);
        self.depth = self.depth.min(6);
        self.azimuth = self.azimuth.min(6);
        self.inclination = self.inclination.min(6);
        self.gps = self.gps.min(6);
    }
}

fn default_precision_length() -> u8 { 1 }
fn default_precision_coordinates() -> u8 { 2 }
fn default_precision_depth() -> u8 { 1 }
fn default_precision_azimuth() -> u8 { 1 }
fn default_precision_inclination() -> u8 { 1 }
fn default_precision_gps() -> u8 { 6 }

/// Custom deserializer for backward compatibility: accepts either a bare integer
/// (old `decimal_precision = 1` format) or the new struct format.
fn deserialize_decimal_precision<'de, D>(deserializer: D) -> Result<DecimalPrecision, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum DecimalPrecisionOrU8 {
        Struct(DecimalPrecision),
        Bare(u8),
    }

    match DecimalPrecisionOrU8::deserialize(deserializer)? {
        DecimalPrecisionOrU8::Struct(dp) => Ok(dp),
        DecimalPrecisionOrU8::Bare(v) => Ok(DecimalPrecision {
            length: v,
            coordinates: v,
            depth: v,
            azimuth: v,
            inclination: v,
            gps: v,
        }),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UnitsConfig {
    pub length: LengthUnit,
    pub depth: LengthUnit,
    pub angle: AngleUnit,
    #[serde(deserialize_with = "deserialize_decimal_precision")]
    pub decimal_precision: DecimalPrecision,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum LengthUnit {
    Meters,
    Feet,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum AngleUnit {
    Degrees,
    Gradians,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
    20.0
}

fn default_pitch_diff_threshold() -> f64 {
    5.0
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DepthGradientConfig {
    pub enabled: bool,
    pub shallow_color: String,
    pub deep_color: String,
    pub shallow_depth: f64,
    pub deep_depth: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SectionColorsConfig {
    pub palette: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GpsOrigin {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
    /// Animation settings for map focus transitions
    #[serde(default)]
    pub animation: MapAnimationConfig,
}

impl MapConfig {
    /// Normalize zoom_step and nested config values (station, shot, snap) to valid ranges
    /// Handles NaN/inf by falling back to defaults
    /// Normalizes unknown satellite_provider to "esri" with a logged warning
    pub fn normalize(&mut self) {
        // Normalize satellite_provider: unknown providers fall back to "esri"
        if crate::tile_providers::get_provider(&self.satellite_provider).is_none() {
            tracing::warn!(
                provider = %self.satellite_provider,
                "Unknown satellite_provider in config, normalizing to \"esri\""
            );
            self.satellite_provider = "esri".to_string();
        }

        if self.zoom_step.is_finite() {
            self.zoom_step = self.zoom_step.clamp(0.1, 5.0);
        } else {
            self.zoom_step = default_zoom_step();
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct MapControlsConfig {
    pub pan_speed: f64,
    pub zoom_speed: f64,
    pub invert_scroll: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ClosureAdjustmentConfig {
    #[serde(default = "default_sigma_length_m")]
    pub base_sigma_length_m: f64,
    #[serde(default = "default_sigma_azimuth_deg")]
    pub base_sigma_azimuth_deg: f64,
    #[serde(default = "default_sigma_depth_m")]
    pub base_sigma_depth_m: f64,
}

impl ClosureAdjustmentConfig {
    pub fn normalize(&mut self) {
        if !self.base_sigma_length_m.is_finite() || self.base_sigma_length_m <= 0.0 {
            self.base_sigma_length_m = default_sigma_length_m();
        }
        if !self.base_sigma_azimuth_deg.is_finite() || self.base_sigma_azimuth_deg <= 0.0 {
            self.base_sigma_azimuth_deg = default_sigma_azimuth_deg();
        }
        if !self.base_sigma_depth_m.is_finite() || self.base_sigma_depth_m <= 0.0 {
            self.base_sigma_depth_m = default_sigma_depth_m();
        }
    }
}

pub fn default_sigma_length_m() -> f64 {
    0.05
}

pub fn default_sigma_azimuth_deg() -> f64 {
    1.0
}

pub fn default_sigma_depth_m() -> f64 {
    0.05
}

/// Placement suggestion algorithm configuration.
/// Controls how imported DMP sections are matched against existing project data.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PlacementSuggestionConfig {
    /// Sigma for azimuth error (degrees)
    #[serde(default = "default_ps_azimuth_sigma")]
    pub azimuth_sigma: f64,
    /// Sigma for length error (meters)
    #[serde(default = "default_ps_length_sigma")]
    pub length_sigma: f64,
    /// Sigma for depth error (meters)
    #[serde(default = "default_ps_depth_sigma")]
    pub depth_sigma: f64,
    /// Weight for azimuth score component
    #[serde(default = "default_ps_azimuth_weight")]
    pub azimuth_weight: f64,
    /// Weight for length score component
    #[serde(default = "default_ps_length_weight")]
    pub length_weight: f64,
    /// Weight for depth_in score component
    #[serde(default = "default_ps_depth_in_weight")]
    pub depth_in_weight: f64,
    /// Weight for depth_out score component
    #[serde(default = "default_ps_depth_out_weight")]
    pub depth_out_weight: f64,
    /// Minimum per-shot score to continue matching
    #[serde(default = "default_ps_min_shot_score")]
    pub min_shot_score: f64,
    /// Minimum aggregate score to include a suggestion
    #[serde(default = "default_ps_min_aggregate_score")]
    pub min_aggregate_score: f64,
    /// Maximum number of reference shots to try from each leaf
    #[serde(default = "default_ps_max_reference_shots")]
    pub max_reference_shots: u32,
    /// Maximum number of suggestions to return
    #[serde(default = "default_ps_max_suggestions")]
    pub max_suggestions: u32,
    /// Minimum partial shot length ratio
    #[serde(default = "default_ps_min_partial_ratio")]
    pub min_partial_ratio: f64,
    /// Short shot threshold (meters) — shots below this get reduced weight
    #[serde(default = "default_ps_short_shot_threshold")]
    pub short_shot_threshold: f64,
    /// Penalty multiplier for single-shot matches (0.0–1.0)
    #[serde(default = "default_ps_single_shot_penalty")]
    pub single_shot_penalty: f64,
    /// Hard cutoff: max azimuth error for full shots (degrees)
    #[serde(default = "default_ps_max_azimuth_error_full")]
    pub max_azimuth_error_full: f64,
    /// Hard cutoff: max azimuth error for partial shots (degrees)
    #[serde(default = "default_ps_max_azimuth_error_partial")]
    pub max_azimuth_error_partial: f64,
    /// Hard cutoff: max depth error per measurement point (meters)
    #[serde(default = "default_ps_max_depth_error")]
    pub max_depth_error: f64,
    /// Length error fraction for dynamic cutoff
    #[serde(default = "default_ps_max_length_error_fraction")]
    pub max_length_error_fraction: f64,
    /// Length error floor for dynamic cutoff (meters)
    #[serde(default = "default_ps_max_length_error_floor")]
    pub max_length_error_floor: f64,
}

impl PlacementSuggestionConfig {
    /// Normalize all values to valid ranges, resetting NaN/Inf to defaults.
    pub fn normalize(&mut self) {
        fn fix(val: &mut f64, default: f64, min: f64, max: f64) {
            if !val.is_finite() { *val = default; }
            *val = val.clamp(min, max);
        }

        fix(&mut self.azimuth_sigma, default_ps_azimuth_sigma(), 0.1, 180.0);
        fix(&mut self.length_sigma, default_ps_length_sigma(), 0.01, 100.0);
        fix(&mut self.depth_sigma, default_ps_depth_sigma(), 0.01, 100.0);
        fix(&mut self.azimuth_weight, default_ps_azimuth_weight(), 0.0, 1.0);
        fix(&mut self.length_weight, default_ps_length_weight(), 0.0, 1.0);
        fix(&mut self.depth_in_weight, default_ps_depth_in_weight(), 0.0, 1.0);
        fix(&mut self.depth_out_weight, default_ps_depth_out_weight(), 0.0, 1.0);
        fix(&mut self.min_shot_score, default_ps_min_shot_score(), 0.0, 1.0);
        fix(&mut self.min_aggregate_score, default_ps_min_aggregate_score(), 0.0, 1.0);
        self.max_reference_shots = self.max_reference_shots.clamp(1, 50);
        self.max_suggestions = self.max_suggestions.clamp(1, 100);
        fix(&mut self.min_partial_ratio, default_ps_min_partial_ratio(), 0.0, 1.0);
        fix(&mut self.short_shot_threshold, default_ps_short_shot_threshold(), 0.0, 100.0);
        fix(&mut self.single_shot_penalty, default_ps_single_shot_penalty(), 0.0, 1.0);
        fix(&mut self.max_azimuth_error_full, default_ps_max_azimuth_error_full(), 0.0, 180.0);
        fix(&mut self.max_azimuth_error_partial, default_ps_max_azimuth_error_partial(), 0.0, 180.0);
        fix(&mut self.max_depth_error, default_ps_max_depth_error(), 0.0, 100.0);
        fix(&mut self.max_length_error_fraction, default_ps_max_length_error_fraction(), 0.0, 1.0);
        fix(&mut self.max_length_error_floor, default_ps_max_length_error_floor(), 0.0, 100.0);
    }
}

impl Default for PlacementSuggestionConfig {
    fn default() -> Self {
        Self {
            azimuth_sigma: default_ps_azimuth_sigma(),
            length_sigma: default_ps_length_sigma(),
            depth_sigma: default_ps_depth_sigma(),
            azimuth_weight: default_ps_azimuth_weight(),
            length_weight: default_ps_length_weight(),
            depth_in_weight: default_ps_depth_in_weight(),
            depth_out_weight: default_ps_depth_out_weight(),
            min_shot_score: default_ps_min_shot_score(),
            min_aggregate_score: default_ps_min_aggregate_score(),
            max_reference_shots: default_ps_max_reference_shots(),
            max_suggestions: default_ps_max_suggestions(),
            min_partial_ratio: default_ps_min_partial_ratio(),
            short_shot_threshold: default_ps_short_shot_threshold(),
            single_shot_penalty: default_ps_single_shot_penalty(),
            max_azimuth_error_full: default_ps_max_azimuth_error_full(),
            max_azimuth_error_partial: default_ps_max_azimuth_error_partial(),
            max_depth_error: default_ps_max_depth_error(),
            max_length_error_fraction: default_ps_max_length_error_fraction(),
            max_length_error_floor: default_ps_max_length_error_floor(),
        }
    }
}

pub fn default_ps_azimuth_sigma() -> f64 { 18.0 }
pub fn default_ps_length_sigma() -> f64 { 0.8 }
pub fn default_ps_depth_sigma() -> f64 { 0.35 }
pub fn default_ps_azimuth_weight() -> f64 { 0.35 }
pub fn default_ps_length_weight() -> f64 { 0.25 }
pub fn default_ps_depth_in_weight() -> f64 { 0.20 }
pub fn default_ps_depth_out_weight() -> f64 { 0.20 }
pub fn default_ps_min_shot_score() -> f64 { 0.15 }
pub fn default_ps_min_aggregate_score() -> f64 { 0.45 }
pub fn default_ps_max_reference_shots() -> u32 { 5 }
pub fn default_ps_max_suggestions() -> u32 { 10 }
pub fn default_ps_min_partial_ratio() -> f64 { 0.15 }
pub fn default_ps_short_shot_threshold() -> f64 { 0.5 }
pub fn default_ps_single_shot_penalty() -> f64 { 0.6 }
pub fn default_ps_max_azimuth_error_full() -> f64 { 25.0 }
pub fn default_ps_max_azimuth_error_partial() -> f64 { 35.0 }
pub fn default_ps_max_depth_error() -> f64 { 0.50 }
pub fn default_ps_max_length_error_fraction() -> f64 { 0.15 }
pub fn default_ps_max_length_error_floor() -> f64 { 2.0 }

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExportConfig {
    pub default_image_format: String,
    pub default_dpi: u32,
    pub default_include_satellite: bool,
    pub default_include_grid: bool,
    pub default_include_labels: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct LoggingConfig {
    pub level: String,
    pub max_directory_size_mb: u32,
}

/// Maximum number of bindings per action
const MAX_BINDINGS_PER_ACTION: usize = 2;

/// Keyboard shortcuts configuration
/// Supports multiple bindings per action (max 2) with backward-compatible deserialization
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct ShortcutsConfig {
    // Tools
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub select: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub pan: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub zoom: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub draw: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub delete_tool: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub merge: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub measure: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub move_station: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub move_segment: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub move_shot: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub comment_tool: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub move_comment_tool: Vec<String>,

    // Edit
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub undo: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub redo: Vec<String>,

    // View
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_depth_gradient: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_grid: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_satellite: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_station_labels: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_shot_labels: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_section_labels: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub fit_to_bounds: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub zoom_in: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub zoom_out: Vec<String>,

    // Panels
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_sections_panel: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_detail_panel: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub toggle_data_table: Vec<String>,

    // File
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub save: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub new_file: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub open_file: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub save_as: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub import_dmp: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub export: Vec<String>,

    // Legacy field for migration (accepts old "delete" key, maps to delete_tool)
    #[serde(default, skip_serializing, rename = "delete")]
    pub(super) legacy_delete: Option<LegacyShortcut>,
}

/// Helper enum to deserialize legacy single-string shortcut for migration
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(untagged)]
pub(super) enum LegacyShortcut {
    Single(String),
    Multiple(Vec<String>),
}

impl ShortcutsConfig {
    /// Normalize all shortcuts to canonical form
    /// - Sorts modifiers: Ctrl -> Alt -> Shift -> Key
    /// - Maps special keys to canonical names
    /// - Truncates to max 2 bindings per action
    /// - Fills missing fields from defaults
    /// - Logs warnings for invalid shortcuts
    pub fn normalize(&mut self) {
        let defaults = ShortcutsConfig::default();

        // Migrate legacy "delete" field to delete_tool
        // Only migrate if delete_tool still has its default value (wasn't explicitly set)
        if let Some(legacy) = self.legacy_delete.take() {
            let delete_tool_is_default = self.delete_tool == defaults.delete_tool;
            if delete_tool_is_default {
                self.delete_tool = match legacy {
                    LegacyShortcut::Single(s) => vec![s],
                    LegacyShortcut::Multiple(v) => v,
                };
                tracing::info!("Migrated legacy 'delete' shortcut to 'delete_tool'");
            }
        }

        // Migrate shortcut reassignments from pre-move-segment era:
        // G was toggle_depth_gradient, now it's move_shot; toggle_depth_gradient moves to Shift+D
        if self.move_shot.is_empty() && self.toggle_depth_gradient == vec!["G".to_string()] {
            self.toggle_depth_gradient = vec!["Shift+D".to_string()];
            self.move_shot = vec!["G".to_string()];
            tracing::info!("Migrated toggle_depth_gradient shortcut: G -> Shift+D (G now used by move_shot)");
        }

        // Normalize each field
        normalize_shortcut_field(&mut self.select, &defaults.select, "select");
        normalize_shortcut_field(&mut self.pan, &defaults.pan, "pan");
        normalize_shortcut_field(&mut self.zoom, &defaults.zoom, "zoom");
        normalize_shortcut_field(&mut self.draw, &defaults.draw, "draw");
        normalize_shortcut_field(&mut self.delete_tool, &defaults.delete_tool, "delete_tool");
        normalize_shortcut_field(&mut self.merge, &defaults.merge, "merge");
        normalize_shortcut_field(&mut self.measure, &defaults.measure, "measure");
        normalize_shortcut_field(&mut self.move_station, &defaults.move_station, "move_station");
        normalize_shortcut_field(&mut self.move_segment, &defaults.move_segment, "move_segment");
        normalize_shortcut_field(&mut self.move_shot, &defaults.move_shot, "move_shot");
        normalize_shortcut_field(&mut self.comment_tool, &defaults.comment_tool, "comment_tool");
        normalize_shortcut_field(&mut self.move_comment_tool, &defaults.move_comment_tool, "move_comment_tool");
        normalize_shortcut_field(&mut self.undo, &defaults.undo, "undo");
        normalize_shortcut_field(&mut self.redo, &defaults.redo, "redo");
        normalize_shortcut_field(
            &mut self.toggle_depth_gradient,
            &defaults.toggle_depth_gradient,
            "toggle_depth_gradient",
        );
        normalize_shortcut_field(&mut self.toggle_grid, &defaults.toggle_grid, "toggle_grid");
        normalize_shortcut_field(
            &mut self.toggle_satellite,
            &defaults.toggle_satellite,
            "toggle_satellite",
        );
        normalize_shortcut_field(
            &mut self.toggle_station_labels,
            &defaults.toggle_station_labels,
            "toggle_station_labels",
        );
        normalize_shortcut_field(
            &mut self.toggle_shot_labels,
            &defaults.toggle_shot_labels,
            "toggle_shot_labels",
        );
        normalize_shortcut_field(
            &mut self.toggle_section_labels,
            &defaults.toggle_section_labels,
            "toggle_section_labels",
        );
        normalize_shortcut_field(
            &mut self.fit_to_bounds,
            &defaults.fit_to_bounds,
            "fit_to_bounds",
        );
        normalize_shortcut_field(&mut self.zoom_in, &defaults.zoom_in, "zoom_in");
        normalize_shortcut_field(&mut self.zoom_out, &defaults.zoom_out, "zoom_out");
        normalize_shortcut_field(
            &mut self.toggle_sections_panel,
            &defaults.toggle_sections_panel,
            "toggle_sections_panel",
        );
        normalize_shortcut_field(
            &mut self.toggle_detail_panel,
            &defaults.toggle_detail_panel,
            "toggle_detail_panel",
        );
        normalize_shortcut_field(
            &mut self.toggle_data_table,
            &defaults.toggle_data_table,
            "toggle_data_table",
        );
        normalize_shortcut_field(&mut self.save, &defaults.save, "save");
        normalize_shortcut_field(&mut self.new_file, &defaults.new_file, "new_file");
        normalize_shortcut_field(&mut self.open_file, &defaults.open_file, "open_file");
        normalize_shortcut_field(&mut self.save_as, &defaults.save_as, "save_as");
        normalize_shortcut_field(&mut self.import_dmp, &defaults.import_dmp, "import_dmp");
        normalize_shortcut_field(&mut self.export, &defaults.export, "export");
    }
}

/// Normalize a shortcut field:
/// - If empty, use defaults
/// - Remove empty strings
/// - Truncate to MAX_BINDINGS_PER_ACTION
/// - Normalize each shortcut string
fn normalize_shortcut_field(field: &mut Vec<String>, defaults: &[String], field_name: &str) {
    // Remove empty strings
    field.retain(|s| !s.trim().is_empty());

    // If empty after cleanup, use defaults
    if field.is_empty() {
        *field = defaults.to_vec();
        return;
    }

    // Truncate to max bindings
    if field.len() > MAX_BINDINGS_PER_ACTION {
        tracing::warn!(
            "Shortcut '{}' has {} bindings, truncating to {}",
            field_name,
            field.len(),
            MAX_BINDINGS_PER_ACTION
        );
        field.truncate(MAX_BINDINGS_PER_ACTION);
    }

    // Normalize each shortcut
    let mut normalized: Vec<String> = Vec::with_capacity(field.len());
    for shortcut in field.iter() {
        if let Some(n) = normalize_shortcut(shortcut) { normalized.push(n) } else {
            tracing::warn!(
                "Invalid shortcut '{}' for '{}', falling back to default",
                shortcut,
                field_name
            );
            *field = defaults.to_vec();
            return;
        }
    }
    *field = normalized;
}

/// Normalize a single shortcut string to canonical form
/// Returns None if the shortcut is invalid
///
/// Key normalization rules:
/// - Single letter keys are UPPERCASE (matches JavaScript KeyboardEvent.key)
/// - Special keys use PascalCase canonical names (Space, ArrowUp, etc.)
/// - Modifiers are sorted: Ctrl -> Alt -> Shift -> Key
pub(super) fn normalize_shortcut(shortcut: &str) -> Option<String> {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() {
        return None;
    }

    // Special case: single "+" key
    if shortcut == "+" {
        return Some("Plus".to_string());
    }

    // Special case: single "-" key
    if shortcut == "-" {
        return Some("Minus".to_string());
    }

    // Special case: single "=" key
    if shortcut == "=" {
        return Some("Equal".to_string());
    }

    // Split by + to get modifiers and key
    // Handle "Ctrl++" (Ctrl+Plus) by counting consecutive + at end
    let parts: Vec<&str> = shortcut.split('+').map(str::trim).collect();
    if parts.is_empty() {
        return None;
    }

    // Count trailing empty parts (consecutive + at end means Plus key)
    let trailing_empty_count = parts.iter().rev().take_while(|p| p.is_empty()).count();

    // Check for empty parts in the middle (not trailing)
    // e.g., "Ctrl++S" has empty in middle -> invalid
    // e.g., "Ctrl++" has trailing empties -> valid (means Ctrl+Plus)
    let non_trailing_parts = &parts[..parts.len().saturating_sub(trailing_empty_count)];
    if non_trailing_parts.iter().any(|p| p.is_empty()) {
        return None;
    }

    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut key: Option<String> = None;

    // Process non-empty parts
    for part in non_trailing_parts {
        let lower = part.to_lowercase();
        match lower.as_str() {
            "ctrl" | "control" | "meta" | "cmd" | "command" => ctrl = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            _ => {
                // This is the key (should be only one non-modifier)
                if key.is_some() {
                    // Multiple non-modifier keys is invalid
                    return None;
                }
                key = Some(normalize_key_name(part));
            }
        }
    }

    // Handle trailing empty parts as Plus key
    // "Ctrl++" -> trailing_empty_count=2, but we only need one Plus
    // "Ctrl+" -> trailing_empty_count=1
    if trailing_empty_count > 0 {
        if key.is_some() {
            // Already have a key, can't have Plus too
            return None;
        }
        key = Some("Plus".to_string());
    }

    // Must have exactly one key
    let key = key?;

    // Build canonical form: Ctrl+Alt+Shift+Key
    let mut result = String::new();
    if ctrl {
        result.push_str("Ctrl+");
    }
    if alt {
        result.push_str("Alt+");
    }
    if shift {
        result.push_str("Shift+");
    }
    result.push_str(&key);

    Some(result)
}

/// Map key names to canonical form (PascalCase for special keys, UPPERCASE for letters)
///
/// Canonical names match JavaScript KeyboardEvent.key values where possible.
/// Single letter keys are uppercase to match KeyboardEvent.key (e.g., "S" not "s").
fn normalize_key_name(key: &str) -> String {
    let lower = key.to_lowercase();
    if let Some(num) = lower
        .strip_prefix("digit")
        .or_else(|| lower.strip_prefix("numpad"))
    {
        if num.len() == 1 && num.chars().all(|c| c.is_ascii_digit()) {
            return num.to_string();
        }
    }
    match lower.as_str() {
        // Special keys - canonical names (PascalCase, matching KeyboardEvent.key)
        "space" | "spacebar" => "Space".to_string(),
        "enter" | "return" => "Enter".to_string(),
        "esc" | "escape" => "Escape".to_string(),
        "up" | "arrowup" => "ArrowUp".to_string(),
        "down" | "arrowdown" => "ArrowDown".to_string(),
        "left" | "arrowleft" => "ArrowLeft".to_string(),
        "right" | "arrowright" => "ArrowRight".to_string(),
        "+" | "plus" => "Plus".to_string(),
        "-" | "minus" => "Minus".to_string(),
        "=" | "equal" | "equals" => "Equal".to_string(),
        "backspace" | "back" => "Backspace".to_string(),
        "delete" | "del" => "Delete".to_string(),
        "tab" => "Tab".to_string(),
        "home" => "Home".to_string(),
        "end" => "End".to_string(),
        "pageup" | "pgup" => "PageUp".to_string(),
        "pagedown" | "pgdn" => "PageDown".to_string(),
        "insert" | "ins" => "Insert".to_string(),
        // Function keys (F1-F12)
        k if k.starts_with('f') && k.len() > 1 && k[1..].parse::<u8>().is_ok() => {
            format!("F{}", &k[1..])
        }
        // Single letter keys - UPPERCASE (matches KeyboardEvent.key)
        k if k.len() == 1 && k.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) => {
            k.to_uppercase()
        }
        // Numbers and other keys - preserve as-is
        _ => key.to_string(),
    }
}

/// Custom deserializer that accepts both single String and Vec<String>
/// for backward compatibility with legacy config format
fn deserialize_shortcut_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize, TS)]
    #[serde(untagged)]
    enum StringOrVec {
        Single(String),
        Multiple(Vec<String>),
    }

    match StringOrVec::deserialize(deserializer)? {
        StringOrVec::Single(s) => Ok(vec![s]),
        StringOrVec::Multiple(v) => Ok(v),
    }
}

impl Config {
    /// Load config from file, falling back to defaults
    pub fn load() -> Result<Self> {
        let config_path = Self::config_path()?;
        Self::load_from_path(&config_path)
    }

    /// Save config to file
    pub fn save(&mut self) -> Result<()> {
        // Note: We intentionally do NOT call normalize() here.
        // Normalization fills in defaults for missing fields and should only
        // happen when LOADING from file, not when SAVING. This allows users
        // to explicitly set shortcuts to empty (no shortcut).
        let config_path = Self::config_path()?;
        self.save_to_path(&config_path)
    }

    /// Load config from a specific path, falling back to defaults
    pub fn load_from_path(path: &Path) -> Result<Self> {
        if path.exists() {
            let contents = std::fs::read_to_string(path).context("Failed to read config file")?;
            let mut config: Config = toml::from_str(&contents).context("Failed to parse config file")?;
            config.migrate_legacy();
            config.normalize();
            tracing::info!(config_path = ?path, "Loaded config from file");
            Ok(config)
        } else {
            tracing::info!(config_path = ?path, "Using default config");
            Ok(Self::default())
        }
    }

    /// Save config to a specific path
    pub fn save_to_path(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("Failed to create config directory")?;
        }

        let contents = toml::to_string_pretty(self).context("Failed to serialize config")?;
        std::fs::write(path, contents).context("Failed to write config file")?;
        tracing::info!(config_path = ?path, "Saved config to file");
        Ok(())
    }

    /// Get the config file path
    pub fn config_path() -> Result<PathBuf> {
        // Tests redirect the config path to a temp dir (see
        // `crate::test_helpers::isolated_config`) so they never read or pollute
        // the developer's real `~/.config/stalagmight/config.toml`.
        #[cfg(test)]
        if let Some(dir) = crate::test_helpers::config_path_override() {
            return Ok(dir.join("config.toml"));
        }
        if let Some(dir) = crate::app_dirs::config_dir() {
            return Ok(dir.join("config.toml"));
        }
        // Fallback for pre-setup calls on desktop
        let dirs =
            directories::ProjectDirs::from("com", "stalagmight", "Stalagmight").context("No home directory")?;
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

    /// Normalize all config values to valid ranges
    /// Handles NaN/inf by falling back to defaults
    pub fn normalize(&mut self) {
        self.map.normalize();
        self.shortcuts.normalize();
        self.global_view.normalize();
        self.appearance.normalize();
        self.closure_adjustment.normalize();
        self.placement_suggestion.normalize();
        self.units.decimal_precision.normalize();
        if self.general.locale.trim().is_empty() {
            self.general.locale = default_locale();
        }
        let mut seen = HashSet::new();
        self.general.onboarding_completed_flows.retain(|flow_id| {
            let trimmed = flow_id.trim();
            !trimmed.is_empty() && seen.insert(trimmed.to_string())
        });
    }

    /// Migrate legacy config fields to new structure
    /// Called during load() before normalize()
    ///
    /// Note: Migration only occurs when map.snap has default values.
    /// If a user explicitly sets map.snap to defaults AND has a legacy [snap] section,
    /// the legacy values will override. This edge case is accepted as the user likely
    /// wants to migrate their old settings.
    pub(super) fn migrate_legacy(&mut self) {
        // Migrate old [snap] section to new map.snap
        if let Some(legacy) = self.legacy_snap.take() {
            // Only migrate if map.snap appears to be at defaults (not explicitly set)
            // Limitation: Cannot distinguish explicit defaults from missing section
            let snap_is_default = (self.map.snap.threshold - default_snap_threshold()).abs()
                < f64::EPSILON
                && self.map.snap.enabled_draw
                && self.map.snap.enabled_merge
                && self.map.snap.enabled_measure;

            if snap_is_default {
                if let Some(enabled_draw) = legacy.enabled_draw {
                    self.map.snap.enabled_draw = enabled_draw;
                }
                if let Some(enabled_merge) = legacy.enabled_merge {
                    self.map.snap.enabled_merge = enabled_merge;
                }
                if let Some(enabled_measure) = legacy.enabled_measure {
                    self.map.snap.enabled_measure = enabled_measure;
                }
                if let Some(threshold_pixels) = legacy.threshold_pixels {
                    self.map.snap.threshold = threshold_pixels;
                }
                tracing::info!("Migrated legacy [snap] config to map.snap");
            }
        }
    }
}
