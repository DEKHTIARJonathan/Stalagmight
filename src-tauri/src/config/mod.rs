pub mod defaults;

use anyhow::{Context, Result};
use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};

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

    // Legacy fields for backwards compatibility (deserialize only, never serialize)
    // Uses alias to match old TOML key name while keeping internal field name distinct
    #[serde(default, skip_serializing, alias = "snap")]
    legacy_snap: Option<LegacySnapConfig>,
}

/// Legacy snap config for migration from old [snap] section
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LegacySnapConfig {
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Animation configuration for map focus transitions
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Shortcut feedback preference for toast notifications
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutFeedback {
    /// No toasts for any shortcuts
    None,
    /// Toast for view/panel toggles only (default)
    #[default]
    NonObvious,
    /// Toast for all shortcut actions
    All,
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
    /// Shortcut feedback preference: none, non_obvious (default), or all
    #[serde(default)]
    pub shortcut_feedback: ShortcutFeedback,
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
    /// Animation settings for map focus transitions
    #[serde(default)]
    pub animation: MapAnimationConfig,
}

impl MapConfig {
    /// Normalize zoom_step and nested config values (station, shot, snap) to valid ranges
    /// Handles NaN/inf by falling back to defaults
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

/// Maximum number of bindings per action
const MAX_BINDINGS_PER_ACTION: usize = 2;

/// Keyboard shortcuts configuration
/// Supports multiple bindings per action (max 2) with backward-compatible deserialization
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub move_section: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub move_station: Vec<String>,

    // Edit
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub undo: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub redo: Vec<String>,
    #[serde(deserialize_with = "deserialize_shortcut_vec")]
    pub save: Vec<String>,

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

    // Legacy field for migration (accepts old "delete" key, maps to delete_tool)
    #[serde(default, skip_serializing, rename = "delete")]
    legacy_delete: Option<LegacyShortcut>,
}

/// Helper enum to deserialize legacy single-string shortcut for migration
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum LegacyShortcut {
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

        // Normalize each field
        normalize_shortcut_field(&mut self.select, &defaults.select, "select");
        normalize_shortcut_field(&mut self.pan, &defaults.pan, "pan");
        normalize_shortcut_field(&mut self.zoom, &defaults.zoom, "zoom");
        normalize_shortcut_field(&mut self.draw, &defaults.draw, "draw");
        normalize_shortcut_field(&mut self.delete_tool, &defaults.delete_tool, "delete_tool");
        normalize_shortcut_field(&mut self.merge, &defaults.merge, "merge");
        normalize_shortcut_field(&mut self.measure, &defaults.measure, "measure");
        normalize_shortcut_field(&mut self.move_section, &defaults.move_section, "move_section");
        normalize_shortcut_field(&mut self.move_station, &defaults.move_station, "move_station");
        normalize_shortcut_field(&mut self.undo, &defaults.undo, "undo");
        normalize_shortcut_field(&mut self.redo, &defaults.redo, "redo");
        normalize_shortcut_field(&mut self.save, &defaults.save, "save");
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
        match normalize_shortcut(shortcut) {
            Some(n) => normalized.push(n),
            None => {
                tracing::warn!(
                    "Invalid shortcut '{}' for '{}', falling back to default",
                    shortcut,
                    field_name
                );
                *field = defaults.to_vec();
                return;
            }
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
fn normalize_shortcut(shortcut: &str) -> Option<String> {
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
    let parts: Vec<&str> = shortcut.split('+').map(|s| s.trim()).collect();
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
        k if k.len() == 1 && k.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) => {
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
    #[derive(Deserialize)]
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

    /// Normalize all config values to valid ranges
    /// Handles NaN/inf by falling back to defaults
    pub fn normalize(&mut self) {
        self.map.normalize();
        self.shortcuts.normalize();
    }

    /// Migrate legacy config fields to new structure
    /// Called during load() before normalize()
    ///
    /// Note: Migration only occurs when map.snap has default values.
    /// If a user explicitly sets map.snap to defaults AND has a legacy [snap] section,
    /// the legacy values will override. This edge case is accepted as the user likely
    /// wants to migrate their old settings.
    fn migrate_legacy(&mut self) {
        // Migrate old [snap] section to new map.snap
        if let Some(legacy) = self.legacy_snap.take() {
            // Only migrate if map.snap appears to be at defaults (not explicitly set)
            // Limitation: Cannot distinguish explicit defaults from missing section
            let snap_is_default = self.map.snap.threshold == default_snap_threshold()
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

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Default Values Tests
    // ========================================================================

    #[test]
    fn test_station_config_defaults() {
        let config = StationConfig::default();
        assert_eq!(config.radius, 4.0);
        assert_eq!(config.hit_area, 10.0);
    }

    #[test]
    fn test_shot_config_defaults() {
        let config = ShotConfig::default();
        assert_eq!(config.width, 2.0);
        assert_eq!(config.hit_area, 8.0);
    }

    #[test]
    fn test_map_snap_config_defaults() {
        let config = MapSnapConfig::default();
        assert_eq!(config.threshold, 10.0);
        assert!(config.enabled_draw);
        assert!(config.enabled_merge);
        assert!(config.enabled_measure);
    }

    #[test]
    fn test_map_config_defaults() {
        let config = MapConfig::default();
        assert_eq!(config.station.radius, 4.0);
        assert_eq!(config.station.hit_area, 10.0);
        assert_eq!(config.shot.width, 2.0);
        assert_eq!(config.shot.hit_area, 8.0);
        assert_eq!(config.snap.threshold, 10.0);
        assert_eq!(config.zoom_step, 1.0);
    }

    #[test]
    fn test_debug_config_defaults() {
        let config = DebugConfig::default();
        assert!(!config.map.show_hitboxes);
        assert!(!config.map.log_hit_detection);
    }

    // ========================================================================
    // Station Config Validation Tests
    // ========================================================================

    #[test]
    fn test_station_validation_accepts_minimum_bound() {
        let mut config = StationConfig { radius: 1.0, hit_area: 1.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 1.0);
        assert_eq!(config.hit_area, 1.0);
    }

    #[test]
    fn test_station_validation_accepts_mid_range() {
        let mut config = StationConfig { radius: 25.0, hit_area: 25.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 25.0);
        assert_eq!(config.hit_area, 25.0);
    }

    #[test]
    fn test_station_validation_accepts_maximum_bound() {
        let mut config = StationConfig { radius: 50.0, hit_area: 50.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 50.0);
        assert_eq!(config.hit_area, 50.0);
    }

    #[test]
    fn test_station_validation_rejects_zero() {
        let mut config = StationConfig { radius: 0.0, hit_area: 0.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 1.0); // clamped to min
        assert_eq!(config.hit_area, 1.0); // clamped to min
    }

    #[test]
    fn test_station_validation_rejects_negative() {
        let mut config = StationConfig { radius: -1.0, hit_area: -1.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 1.0); // clamped to min
        assert_eq!(config.hit_area, 1.0); // clamped to min
    }

    #[test]
    fn test_station_validation_rejects_above_max() {
        let mut config = StationConfig { radius: 51.0, hit_area: 51.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 50.0); // clamped to max
        assert_eq!(config.hit_area, 50.0); // clamped to max
    }

    #[test]
    fn test_station_validation_rejects_large_values() {
        let mut config = StationConfig { radius: 100.0, hit_area: 100.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 50.0); // clamped to max
        assert_eq!(config.hit_area, 50.0); // clamped to max
    }

    #[test]
    fn test_station_validation_handles_nan() {
        let mut config = StationConfig { radius: f64::NAN, hit_area: f64::NAN, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 4.0); // default
        assert_eq!(config.hit_area, 10.0); // default
    }

    #[test]
    fn test_station_validation_handles_infinity() {
        let mut config = StationConfig { radius: f64::INFINITY, hit_area: f64::INFINITY, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 4.0); // default
        assert_eq!(config.hit_area, 10.0); // default
    }

    #[test]
    fn test_station_validation_handles_neg_infinity() {
        let mut config = StationConfig { radius: f64::NEG_INFINITY, hit_area: f64::NEG_INFINITY, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 4.0); // default
        assert_eq!(config.hit_area, 10.0); // default
    }

    #[test]
    fn test_station_hit_area_enforced_gte_radius() {
        let mut config = StationConfig { radius: 20.0, hit_area: 10.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.radius, 20.0);
        assert_eq!(config.hit_area, 20.0); // enforced >= radius
    }

    // ========================================================================
    // Shot Config Validation Tests
    // ========================================================================

    #[test]
    fn test_shot_validation_accepts_minimum_bound() {
        let mut config = ShotConfig { width: 0.5, hit_area: 0.5, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 0.5);
        assert_eq!(config.hit_area, 0.5);
    }

    #[test]
    fn test_shot_validation_accepts_mid_range() {
        let mut config = ShotConfig { width: 10.0, hit_area: 10.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 10.0);
        assert_eq!(config.hit_area, 10.0);
    }

    #[test]
    fn test_shot_validation_accepts_maximum_bound() {
        let mut config = ShotConfig { width: 20.0, hit_area: 20.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 20.0);
        assert_eq!(config.hit_area, 20.0);
    }

    #[test]
    fn test_shot_validation_rejects_zero() {
        let mut config = ShotConfig { width: 0.0, hit_area: 0.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 0.5); // clamped to min
        assert_eq!(config.hit_area, 0.5); // clamped to min
    }

    #[test]
    fn test_shot_validation_rejects_negative() {
        let mut config = ShotConfig { width: -1.0, hit_area: -1.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 0.5); // clamped to min
        assert_eq!(config.hit_area, 0.5); // clamped to min
    }

    #[test]
    fn test_shot_validation_rejects_above_max() {
        let mut config = ShotConfig { width: 21.0, hit_area: 21.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 20.0); // clamped to max
        assert_eq!(config.hit_area, 20.0); // clamped to max
    }

    #[test]
    fn test_shot_validation_rejects_large_values() {
        let mut config = ShotConfig { width: 100.0, hit_area: 100.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 20.0); // clamped to max
        assert_eq!(config.hit_area, 20.0); // clamped to max
    }

    #[test]
    fn test_shot_validation_handles_nan() {
        let mut config = ShotConfig { width: f64::NAN, hit_area: f64::NAN, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 2.0); // default
        assert_eq!(config.hit_area, 8.0); // default
    }

    #[test]
    fn test_shot_validation_handles_infinity() {
        let mut config = ShotConfig { width: f64::INFINITY, hit_area: f64::INFINITY, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 2.0); // default
        assert_eq!(config.hit_area, 8.0); // default
    }

    #[test]
    fn test_shot_hit_area_enforced_gte_width() {
        let mut config = ShotConfig { width: 15.0, hit_area: 5.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.width, 15.0);
        assert_eq!(config.hit_area, 15.0); // enforced >= width
    }

    // ========================================================================
    // Snap Config Validation Tests
    // ========================================================================

    #[test]
    fn test_snap_validation_accepts_minimum_bound() {
        let mut config = MapSnapConfig { threshold: 1.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.threshold, 1.0);
    }

    #[test]
    fn test_snap_validation_accepts_mid_range() {
        let mut config = MapSnapConfig { threshold: 25.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.threshold, 25.0);
    }

    #[test]
    fn test_snap_validation_accepts_maximum_bound() {
        let mut config = MapSnapConfig { threshold: 50.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.threshold, 50.0);
    }

    #[test]
    fn test_snap_validation_rejects_zero() {
        let mut config = MapSnapConfig { threshold: 0.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.threshold, 1.0); // clamped to min
    }

    #[test]
    fn test_snap_validation_rejects_negative() {
        let mut config = MapSnapConfig { threshold: -1.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.threshold, 1.0); // clamped to min
    }

    #[test]
    fn test_snap_validation_rejects_above_max() {
        let mut config = MapSnapConfig { threshold: 51.0, ..Default::default() };
        config.normalize();
        assert_eq!(config.threshold, 50.0); // clamped to max
    }

    #[test]
    fn test_snap_validation_handles_nan() {
        let mut config = MapSnapConfig { threshold: f64::NAN, ..Default::default() };
        config.normalize();
        assert_eq!(config.threshold, 10.0); // default
    }

    #[test]
    fn test_snap_validation_handles_infinity() {
        let mut config = MapSnapConfig { threshold: f64::INFINITY, ..Default::default() };
        config.normalize();
        assert_eq!(config.threshold, 10.0); // default
    }

    // ========================================================================
    // Config Parsing Tests
    // ========================================================================

    #[test]
    fn test_config_parsing_complete() {
        let toml_str = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22
zoom_step = 1.5

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[map.station]
radius = 6.0
hit_area = 12.0

[map.shot]
width = 3.0
hit_area = 10.0

[map.snap]
threshold = 15.0
enabled_draw = true
enabled_merge = false
enabled_measure = true

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_section = "V"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"

[debug.map]
show_hitboxes = true
log_hit_detection = true
"##;

        let config: Config = toml::from_str(toml_str).expect("Complete config should parse");

        // Verify map section values
        assert_eq!(config.map.station.radius, 6.0);
        assert_eq!(config.map.station.hit_area, 12.0);
        assert_eq!(config.map.shot.width, 3.0);
        assert_eq!(config.map.shot.hit_area, 10.0);
        assert_eq!(config.map.snap.threshold, 15.0);
        assert!(config.map.snap.enabled_draw);
        assert!(!config.map.snap.enabled_merge);
        assert!(config.map.snap.enabled_measure);
        assert_eq!(config.map.zoom_step, 1.5);

        // Verify debug values
        assert!(config.debug.map.show_hitboxes);
        assert!(config.debug.map.log_hit_detection);
    }

    #[test]
    fn test_config_parsing_partial_uses_defaults() {
        // Config with only required sections, missing optional nested configs
        let toml_str = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_section = "V"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"
"##;

        let config: Config = toml::from_str(toml_str).expect("Partial config should parse");

        // Missing sections should use defaults
        assert_eq!(config.map.station.radius, 4.0); // default
        assert_eq!(config.map.station.hit_area, 10.0); // default
        assert_eq!(config.map.shot.width, 2.0); // default
        assert_eq!(config.map.shot.hit_area, 8.0); // default
        assert_eq!(config.map.snap.threshold, 10.0); // default
        assert!(config.map.snap.enabled_draw); // default
        assert!(config.map.snap.enabled_merge); // default
        assert!(config.map.snap.enabled_measure); // default
        assert_eq!(config.map.zoom_step, 1.0); // default

        // Debug section defaults
        assert!(!config.debug.map.show_hitboxes);
        assert!(!config.debug.map.log_hit_detection);
    }

    #[test]
    fn test_config_parsing_partial_station_uses_field_defaults() {
        // Config with partial station config (only radius, missing hit_area)
        let toml_str = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[map.station]
radius = 8.0

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_section = "V"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"
"##;

        let config: Config = toml::from_str(toml_str).expect("Config with partial station should parse");

        // Explicit value
        assert_eq!(config.map.station.radius, 8.0);
        // Missing field uses default
        assert_eq!(config.map.station.hit_area, 10.0);
    }

    // ========================================================================
    // Config Serialization Tests
    // ========================================================================

    #[test]
    fn test_config_serialization_roundtrip() {
        let original = Config::default();
        let serialized = toml::to_string_pretty(&original).expect("Config should serialize");
        let deserialized: Config = toml::from_str(&serialized).expect("Serialized config should parse");

        // Verify key values survived roundtrip
        assert_eq!(deserialized.map.station.radius, original.map.station.radius);
        assert_eq!(deserialized.map.station.hit_area, original.map.station.hit_area);
        assert_eq!(deserialized.map.shot.width, original.map.shot.width);
        assert_eq!(deserialized.map.shot.hit_area, original.map.shot.hit_area);
        assert_eq!(deserialized.map.snap.threshold, original.map.snap.threshold);
        assert_eq!(deserialized.debug.map.show_hitboxes, original.debug.map.show_hitboxes);
    }

    #[test]
    fn test_config_serialization_preserves_custom_values() {
        let mut config = Config::default();
        config.map.station.radius = 8.0;
        config.map.station.hit_area = 16.0;
        config.map.shot.width = 4.0;
        config.map.shot.hit_area = 12.0;
        config.map.snap.threshold = 20.0;
        config.map.snap.enabled_draw = false;
        config.debug.map.show_hitboxes = true;

        let serialized = toml::to_string_pretty(&config).expect("Config should serialize");
        let deserialized: Config = toml::from_str(&serialized).expect("Serialized config should parse");

        assert_eq!(deserialized.map.station.radius, 8.0);
        assert_eq!(deserialized.map.station.hit_area, 16.0);
        assert_eq!(deserialized.map.shot.width, 4.0);
        assert_eq!(deserialized.map.shot.hit_area, 12.0);
        assert_eq!(deserialized.map.snap.threshold, 20.0);
        assert!(!deserialized.map.snap.enabled_draw);
        assert!(deserialized.debug.map.show_hitboxes);
    }

    #[test]
    fn test_config_serialization_includes_map_section() {
        let config = Config::default();
        let serialized = toml::to_string_pretty(&config).expect("Config should serialize");

        assert!(serialized.contains("[map.station]"));
        assert!(serialized.contains("radius"));
        assert!(serialized.contains("hit_area"));
        assert!(serialized.contains("[map.shot]"));
        assert!(serialized.contains("width"));
        assert!(serialized.contains("[map.snap]"));
        assert!(serialized.contains("threshold"));
        assert!(serialized.contains("[debug.map]"));
        assert!(serialized.contains("show_hitboxes"));
    }

    // ========================================================================
    // Legacy Migration Tests (existing)
    // ========================================================================

    #[test]
    fn test_legacy_snap_migration() {
        let old_config_toml = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_section = "V"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"

[snap]
enabled_draw = false
enabled_merge = true
enabled_measure = false
threshold_pixels = 25
"##;

        let mut config: Config = toml::from_str(old_config_toml)
            .expect("Config with legacy [snap] should parse");

        // Before migration, map.snap has defaults
        assert_eq!(config.map.snap.threshold, 10.0);
        assert!(config.map.snap.enabled_draw);
        assert!(config.map.snap.enabled_merge);
        assert!(config.map.snap.enabled_measure);

        // legacy_snap should have the old values
        assert!(config.legacy_snap.is_some());

        // Run migration (simulating what Config::load does)
        config.migrate_legacy();
        config.normalize();

        // After migration, map.snap should have the legacy values
        assert_eq!(config.map.snap.threshold, 25.0);
        assert!(!config.map.snap.enabled_draw);
        assert!(config.map.snap.enabled_merge);
        assert!(!config.map.snap.enabled_measure);

        // legacy_snap should be consumed (taken)
        assert!(config.legacy_snap.is_none());
    }

    #[test]
    fn test_legacy_snap_not_migrated_when_new_config_present() {
        // If user has both old [snap] and new [map.snap], prefer new values
        let mixed_config_toml = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[map.snap]
threshold = 30.0
enabled_draw = true
enabled_merge = false
enabled_measure = true

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_section = "V"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"

[snap]
enabled_draw = false
enabled_merge = true
enabled_measure = false
threshold_pixels = 25
"##;

        let mut config: Config = toml::from_str(mixed_config_toml)
            .expect("Config with both snap configs should parse");

        // map.snap has explicit values (not defaults)
        assert_eq!(config.map.snap.threshold, 30.0);
        assert!(config.map.snap.enabled_draw);
        assert!(!config.map.snap.enabled_merge);
        assert!(config.map.snap.enabled_measure);

        // Run migration
        config.migrate_legacy();
        config.normalize();

        // map.snap should NOT be overwritten by legacy values
        // (because map.snap was explicitly set, not defaults)
        assert_eq!(config.map.snap.threshold, 30.0);
        assert!(config.map.snap.enabled_draw);
        assert!(!config.map.snap.enabled_merge);
        assert!(config.map.snap.enabled_measure);
    }

    // ========================================================================
    // Shortcut Deserializer Tests
    // ========================================================================

    #[test]
    fn test_shortcut_deserialize_legacy_string() {
        // Test deserializing old format (single string)
        let toml_str = r#"
select = "S"
pan = "P"
"#;
        let config: ShortcutsConfig = toml::from_str(toml_str).expect("Legacy string should parse");
        assert_eq!(config.select, vec!["S".to_string()]);
        assert_eq!(config.pan, vec!["P".to_string()]);
    }

    #[test]
    fn test_shortcut_deserialize_new_array() {
        // Test deserializing new format (array)
        let toml_str = r#"
select = ["S", "Shift+S"]
pan = ["P"]
"#;
        let config: ShortcutsConfig = toml::from_str(toml_str).expect("Array format should parse");
        assert_eq!(config.select, vec!["S".to_string(), "Shift+S".to_string()]);
        assert_eq!(config.pan, vec!["P".to_string()]);
    }

    #[test]
    fn test_shortcut_deserialize_mixed_formats() {
        // Test deserializing mix of old and new formats
        let toml_str = r#"
select = "S"
pan = ["P", "Shift+P"]
zoom = "Z"
"#;
        let config: ShortcutsConfig = toml::from_str(toml_str).expect("Mixed format should parse");
        assert_eq!(config.select, vec!["S".to_string()]);
        assert_eq!(config.pan, vec!["P".to_string(), "Shift+P".to_string()]);
        assert_eq!(config.zoom, vec!["Z".to_string()]);
    }

    #[test]
    fn test_shortcut_missing_fields_use_defaults() {
        // Test that missing fields get defaults via #[serde(default)]
        let toml_str = r#"
select = "S"
"#;
        let mut config: ShortcutsConfig = toml::from_str(toml_str).expect("Partial config should parse");
        config.normalize();

        // Explicit value
        assert_eq!(config.select, vec!["S".to_string()]);
        // Missing fields should have defaults after normalize
        assert_eq!(config.pan, vec!["P".to_string()]);
        assert_eq!(config.undo, vec!["Ctrl+Z".to_string()]);
        assert_eq!(config.zoom_in, vec!["Equal".to_string(), "Plus".to_string()]);
    }

    // ========================================================================
    // Shortcut Normalization Tests
    // ========================================================================

    #[test]
    fn test_normalize_shortcut_simple_key() {
        assert_eq!(normalize_shortcut("S"), Some("S".to_string()));
        assert_eq!(normalize_shortcut("s"), Some("S".to_string()));
        assert_eq!(normalize_shortcut("1"), Some("1".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_with_modifiers() {
        assert_eq!(normalize_shortcut("Ctrl+S"), Some("Ctrl+S".to_string()));
        assert_eq!(normalize_shortcut("ctrl+s"), Some("Ctrl+S".to_string()));
        assert_eq!(normalize_shortcut("CTRL+S"), Some("Ctrl+S".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_modifier_order() {
        // Modifiers should always be Ctrl+Alt+Shift+Key
        assert_eq!(normalize_shortcut("Shift+Ctrl+S"), Some("Ctrl+Shift+S".to_string()));
        assert_eq!(normalize_shortcut("Alt+Ctrl+S"), Some("Ctrl+Alt+S".to_string()));
        assert_eq!(normalize_shortcut("Shift+Alt+Ctrl+S"), Some("Ctrl+Alt+Shift+S".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_platform_aliases() {
        // Meta/Cmd/Command should normalize to Ctrl
        assert_eq!(normalize_shortcut("Meta+S"), Some("Ctrl+S".to_string()));
        assert_eq!(normalize_shortcut("Cmd+S"), Some("Ctrl+S".to_string()));
        assert_eq!(normalize_shortcut("Command+S"), Some("Ctrl+S".to_string()));
        assert_eq!(normalize_shortcut("Option+S"), Some("Alt+S".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_special_keys() {
        assert_eq!(normalize_shortcut("Space"), Some("Space".to_string()));
        assert_eq!(normalize_shortcut("space"), Some("Space".to_string()));
        assert_eq!(normalize_shortcut("Enter"), Some("Enter".to_string()));
        assert_eq!(normalize_shortcut("Return"), Some("Enter".to_string()));
        assert_eq!(normalize_shortcut("Escape"), Some("Escape".to_string()));
        assert_eq!(normalize_shortcut("Esc"), Some("Escape".to_string()));
        assert_eq!(normalize_shortcut("ArrowUp"), Some("ArrowUp".to_string()));
        assert_eq!(normalize_shortcut("Up"), Some("ArrowUp".to_string()));
        assert_eq!(normalize_shortcut("ArrowDown"), Some("ArrowDown".to_string()));
        assert_eq!(normalize_shortcut("Down"), Some("ArrowDown".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_plus_minus_equal() {
        assert_eq!(normalize_shortcut("+"), Some("Plus".to_string()));
        assert_eq!(normalize_shortcut("Plus"), Some("Plus".to_string()));
        assert_eq!(normalize_shortcut("-"), Some("Minus".to_string()));
        assert_eq!(normalize_shortcut("Minus"), Some("Minus".to_string()));
        assert_eq!(normalize_shortcut("="), Some("Equal".to_string()));
        assert_eq!(normalize_shortcut("Equal"), Some("Equal".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_function_keys() {
        assert_eq!(normalize_shortcut("F1"), Some("F1".to_string()));
        assert_eq!(normalize_shortcut("f1"), Some("F1".to_string()));
        assert_eq!(normalize_shortcut("F12"), Some("F12".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_invalid() {
        // Empty string
        assert_eq!(normalize_shortcut(""), None);
        // Only whitespace
        assert_eq!(normalize_shortcut("   "), None);
        // Multiple non-modifier keys
        assert_eq!(normalize_shortcut("A+B"), None);
        // Empty parts in middle
        assert_eq!(normalize_shortcut("Ctrl++S"), None);
    }

    #[test]
    fn test_normalize_shortcut_trailing_plus() {
        // "Ctrl+" is valid and means Ctrl+Plus
        assert_eq!(normalize_shortcut("Ctrl+"), Some("Ctrl+Plus".to_string()));
        assert_eq!(normalize_shortcut("Shift+"), Some("Shift+Plus".to_string()));
        // "Ctrl++" is also valid and means Ctrl+Plus (common representation)
        assert_eq!(normalize_shortcut("Ctrl++"), Some("Ctrl+Plus".to_string()));
        assert_eq!(normalize_shortcut("Shift++"), Some("Shift+Plus".to_string()));
        // Multiple modifiers with trailing +
        assert_eq!(normalize_shortcut("Ctrl+Shift+"), Some("Ctrl+Shift+Plus".to_string()));
        assert_eq!(normalize_shortcut("Ctrl+Shift++"), Some("Ctrl+Shift+Plus".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_remaining_special_keys() {
        // Arrow keys (all directions)
        assert_eq!(normalize_shortcut("ArrowLeft"), Some("ArrowLeft".to_string()));
        assert_eq!(normalize_shortcut("arrowleft"), Some("ArrowLeft".to_string()));
        assert_eq!(normalize_shortcut("Left"), Some("ArrowLeft".to_string()));
        assert_eq!(normalize_shortcut("ArrowRight"), Some("ArrowRight".to_string()));
        assert_eq!(normalize_shortcut("arrowright"), Some("ArrowRight".to_string()));
        assert_eq!(normalize_shortcut("Right"), Some("ArrowRight".to_string()));

        // Backspace
        assert_eq!(normalize_shortcut("Backspace"), Some("Backspace".to_string()));
        assert_eq!(normalize_shortcut("backspace"), Some("Backspace".to_string()));
        assert_eq!(normalize_shortcut("Back"), Some("Backspace".to_string()));

        // Delete
        assert_eq!(normalize_shortcut("Delete"), Some("Delete".to_string()));
        assert_eq!(normalize_shortcut("delete"), Some("Delete".to_string()));
        assert_eq!(normalize_shortcut("Del"), Some("Delete".to_string()));

        // Tab
        assert_eq!(normalize_shortcut("Tab"), Some("Tab".to_string()));
        assert_eq!(normalize_shortcut("tab"), Some("Tab".to_string()));

        // Home/End
        assert_eq!(normalize_shortcut("Home"), Some("Home".to_string()));
        assert_eq!(normalize_shortcut("End"), Some("End".to_string()));

        // Page Up/Down
        assert_eq!(normalize_shortcut("PageUp"), Some("PageUp".to_string()));
        assert_eq!(normalize_shortcut("pgup"), Some("PageUp".to_string()));
        assert_eq!(normalize_shortcut("PageDown"), Some("PageDown".to_string()));
        assert_eq!(normalize_shortcut("pgdn"), Some("PageDown".to_string()));

        // Insert
        assert_eq!(normalize_shortcut("Insert"), Some("Insert".to_string()));
        assert_eq!(normalize_shortcut("Ins"), Some("Insert".to_string()));
    }

    #[test]
    fn test_normalize_shortcut_special_keys_with_modifiers() {
        assert_eq!(normalize_shortcut("Ctrl+ArrowLeft"), Some("Ctrl+ArrowLeft".to_string()));
        assert_eq!(normalize_shortcut("Shift+Delete"), Some("Shift+Delete".to_string()));
        assert_eq!(normalize_shortcut("Ctrl+Backspace"), Some("Ctrl+Backspace".to_string()));
        assert_eq!(normalize_shortcut("Alt+Tab"), Some("Alt+Tab".to_string()));
        assert_eq!(normalize_shortcut("Ctrl+Home"), Some("Ctrl+Home".to_string()));
        assert_eq!(normalize_shortcut("Ctrl+End"), Some("Ctrl+End".to_string()));
    }

    #[test]
    fn test_shortcut_config_normalize_truncates() {
        let mut config = ShortcutsConfig::default();
        config.select = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        config.normalize();
        // Should truncate to 2
        assert_eq!(config.select.len(), 2);
        assert_eq!(config.select, vec!["A".to_string(), "B".to_string()]);
    }

    #[test]
    fn test_shortcut_config_normalize_removes_empty() {
        let mut config = ShortcutsConfig::default();
        config.select = vec!["".to_string(), "S".to_string(), "  ".to_string()];
        config.normalize();
        // Should remove empty and only keep "S"
        assert_eq!(config.select, vec!["S".to_string()]);
    }

    #[test]
    fn test_shortcut_config_normalize_empty_uses_default() {
        let mut config = ShortcutsConfig::default();
        config.select = vec![];
        config.normalize();
        // Should use default
        assert_eq!(config.select, vec!["S".to_string()]);
    }

    #[test]
    fn test_shortcut_config_normalize_invalid_falls_back() {
        let mut config = ShortcutsConfig::default();
        config.select = vec!["A+B".to_string()]; // Invalid (two non-modifier keys)
        config.normalize();
        // Should fall back to default
        assert_eq!(config.select, vec!["S".to_string()]);
    }

    // ========================================================================
    // Legacy Delete Migration Tests
    // ========================================================================

    #[test]
    fn test_shortcut_legacy_delete_migration() {
        // Old config with "delete" field should migrate to "delete_tool"
        let toml_str = r#"
select = "S"
delete = "X"
"#;
        let mut config: ShortcutsConfig = toml::from_str(toml_str).expect("Legacy delete should parse");
        config.normalize();

        // delete_tool should have the migrated value
        assert_eq!(config.delete_tool, vec!["X".to_string()]);
    }

    #[test]
    fn test_shortcut_legacy_delete_array_migration() {
        // Legacy delete as array
        let toml_str = r#"
select = "S"
delete = ["X", "Shift+X"]
"#;
        let mut config: ShortcutsConfig = toml::from_str(toml_str).expect("Legacy delete array should parse");
        config.normalize();

        assert_eq!(config.delete_tool, vec!["X".to_string(), "Shift+X".to_string()]);
    }

    #[test]
    fn test_shortcut_new_delete_tool_takes_precedence() {
        // If both delete and delete_tool present, delete_tool wins
        let toml_str = r#"
delete_tool = ["Y"]
delete = "X"
"#;
        let mut config: ShortcutsConfig = toml::from_str(toml_str).expect("Config should parse");
        config.normalize();

        // delete_tool should keep its value, not be overwritten by legacy delete
        assert_eq!(config.delete_tool, vec!["Y".to_string()]);
    }

    // ========================================================================
    // New Actions Tests
    // ========================================================================

    #[test]
    fn test_shortcut_new_actions_defaults() {
        let config = ShortcutsConfig::default();

        // Verify new actions have defaults
        assert_eq!(config.delete_tool, vec!["X".to_string()]);
        assert_eq!(config.toggle_station_labels, vec!["L".to_string()]);
        assert_eq!(config.toggle_shot_labels, vec!["Shift+L".to_string()]);
        assert_eq!(config.toggle_section_labels, vec!["Ctrl+L".to_string()]);
        assert_eq!(config.zoom_in, vec!["Equal".to_string(), "Plus".to_string()]);
        assert_eq!(config.zoom_out, vec!["Minus".to_string()]);
        assert_eq!(config.toggle_depth_gradient, vec!["G".to_string()]);
        assert_eq!(config.toggle_grid, vec!["Shift+G".to_string()]);
        assert_eq!(config.toggle_satellite, vec!["B".to_string()]);
        assert_eq!(config.fit_to_bounds, vec!["F".to_string()]);
        assert_eq!(config.toggle_sections_panel, vec!["Ctrl+1".to_string()]);
        assert_eq!(config.toggle_detail_panel, vec!["Ctrl+2".to_string()]);
        assert_eq!(config.toggle_data_table, vec!["Ctrl+3".to_string()]);
    }

    #[test]
    fn test_shortcut_config_serialization_roundtrip() {
        let original = ShortcutsConfig::default();
        let serialized = toml::to_string_pretty(&original).expect("Should serialize");
        let deserialized: ShortcutsConfig = toml::from_str(&serialized).expect("Should deserialize");

        assert_eq!(deserialized.select, original.select);
        assert_eq!(deserialized.delete_tool, original.delete_tool);
        assert_eq!(deserialized.zoom_in, original.zoom_in);
        assert_eq!(deserialized.toggle_station_labels, original.toggle_station_labels);
    }

    // ========================================================================
    // ShortcutFeedback Enum Tests
    // ========================================================================

    #[test]
    fn test_shortcut_feedback_default() {
        // Default should be NonObvious
        let feedback = ShortcutFeedback::default();
        assert_eq!(feedback, ShortcutFeedback::NonObvious);
    }

    #[test]
    fn test_shortcut_feedback_serialize_none() {
        // TOML requires key-value pairs, so use wrapper struct
        #[derive(Serialize)]
        struct Wrapper { value: ShortcutFeedback }
        let w = Wrapper { value: ShortcutFeedback::None };
        let serialized = toml::to_string(&w).expect("Should serialize");
        assert!(serialized.contains("value = \"none\""));
    }

    #[test]
    fn test_shortcut_feedback_serialize_non_obvious() {
        #[derive(Serialize)]
        struct Wrapper { value: ShortcutFeedback }
        let w = Wrapper { value: ShortcutFeedback::NonObvious };
        let serialized = toml::to_string(&w).expect("Should serialize");
        assert!(serialized.contains("value = \"non_obvious\""));
    }

    #[test]
    fn test_shortcut_feedback_serialize_all() {
        #[derive(Serialize)]
        struct Wrapper { value: ShortcutFeedback }
        let w = Wrapper { value: ShortcutFeedback::All };
        let serialized = toml::to_string(&w).expect("Should serialize");
        assert!(serialized.contains("value = \"all\""));
    }

    #[test]
    fn test_shortcut_feedback_deserialize_none() {
        #[derive(Deserialize)]
        struct Wrapper { value: ShortcutFeedback }
        let w: Wrapper = toml::from_str("value = \"none\"").expect("Should deserialize");
        assert_eq!(w.value, ShortcutFeedback::None);
    }

    #[test]
    fn test_shortcut_feedback_deserialize_non_obvious() {
        #[derive(Deserialize)]
        struct Wrapper { value: ShortcutFeedback }
        let w: Wrapper = toml::from_str("value = \"non_obvious\"").expect("Should deserialize");
        assert_eq!(w.value, ShortcutFeedback::NonObvious);
    }

    #[test]
    fn test_shortcut_feedback_deserialize_all() {
        #[derive(Deserialize)]
        struct Wrapper { value: ShortcutFeedback }
        let w: Wrapper = toml::from_str("value = \"all\"").expect("Should deserialize");
        assert_eq!(w.value, ShortcutFeedback::All);
    }

    #[test]
    fn test_general_config_shortcut_feedback_default() {
        // When shortcut_feedback is missing from TOML, should use default
        let toml_str = r#"
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20
"#;
        let config: GeneralConfig = toml::from_str(toml_str).expect("Should deserialize");
        assert_eq!(config.shortcut_feedback, ShortcutFeedback::NonObvious);
    }

    #[test]
    fn test_general_config_shortcut_feedback_explicit() {
        let toml_str = r#"
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20
shortcut_feedback = "all"
"#;
        let config: GeneralConfig = toml::from_str(toml_str).expect("Should deserialize");
        assert_eq!(config.shortcut_feedback, ShortcutFeedback::All);
    }

    #[test]
    fn test_general_config_shortcut_feedback_roundtrip() {
        let mut config = GeneralConfig::default();
        config.shortcut_feedback = ShortcutFeedback::None;

        let serialized = toml::to_string_pretty(&config).expect("Should serialize");
        let deserialized: GeneralConfig = toml::from_str(&serialized).expect("Should deserialize");

        assert_eq!(deserialized.shortcut_feedback, ShortcutFeedback::None);
    }

    // ========================================================================
    // File I/O Tests
    // ========================================================================

    #[test]
    fn test_load_from_path_missing_returns_default() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let config = Config::load_from_path(&path).unwrap();
        assert_eq!(config.general.auto_save_interval_seconds, 30);
        assert_eq!(config.validation.warn_shot_length_max, 50.0);
    }

    #[test]
    fn test_save_to_path_and_load_roundtrip() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");

        let mut config = Config::default();
        config.general.auto_save = false;
        config.general.undo_history_limit = 42;
        config.display.grid_spacing = 7.5;

        config.save_to_path(&path).unwrap();
        let loaded = Config::load_from_path(&path).unwrap();

        assert!(!loaded.general.auto_save);
        assert_eq!(loaded.general.undo_history_limit, 42);
        assert_eq!(loaded.display.grid_spacing, 7.5);
    }

    #[test]
    fn test_load_from_path_invalid_toml_errors() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "not = [valid").unwrap();
        assert!(Config::load_from_path(&path).is_err());
    }
}
