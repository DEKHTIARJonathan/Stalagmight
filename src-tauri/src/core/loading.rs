//! Loading progress module for project open/create operations.
//!
//! This module provides types for tracking loading progress, error handling,
//! and display settings during project load operations.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ============================================================================
// LoadError
// ============================================================================

/// Error type for load/create operations with guaranteed valid JSON in Display impl.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl LoadError {
    /// Create a new LoadError with the given code and message.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// Create a new LoadError with details.
    pub fn with_details(code: &str, message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details.into()),
        }
    }

    /// Error when a project is already open.
    pub fn already_open() -> Self {
        Self::new("ALREADY_OPEN", "Project already open")
    }

    /// Error when the operation was cancelled.
    pub fn cancelled() -> Self {
        Self::new("CANCELLED", "Operation cancelled")
    }

    /// Error when a file is not found.
    pub fn not_found(path: &str) -> Self {
        Self::new("NOT_FOUND", format!("File not found: {}", path))
    }

    /// Internal error with a message.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }

    /// Error when the database file is corrupted.
    /// The `path` is stored in `details` so the frontend can offer recovery options.
    pub fn corrupt(message: impl Into<String>, path: &str) -> Self {
        Self::with_details("CORRUPT", message, path)
    }
}

/// Escape a string for JSON, handling quotes, backslashes, and control characters.
fn escape_json_string(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if c.is_control() => {
                // Escape other control characters as \uXXXX
                escaped.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => escaped.push(c),
        }
    }
    escaped
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // ALWAYS produce valid JSON - use serde_json with fallback
        match serde_json::to_string(self) {
            Ok(json) => write!(f, "{}", json),
            Err(_) => {
                // Fallback: manually construct valid JSON with fully escaped strings
                let escaped_code = escape_json_string(&self.code);
                let escaped_msg = escape_json_string(&self.message);
                match &self.details {
                    Some(details) => {
                        let escaped_details = escape_json_string(details);
                        write!(
                            f,
                            r#"{{"code":"{}","message":"{}","details":"{}"}}"#,
                            escaped_code, escaped_msg, escaped_details
                        )
                    }
                    None => {
                        write!(
                            f,
                            r#"{{"code":"{}","message":"{}","details":null}}"#,
                            escaped_code, escaped_msg
                        )
                    }
                }
            }
        }
    }
}

impl std::error::Error for LoadError {}

// ============================================================================
// DisplaySettings
// ============================================================================

/// Display settings for API payloads (used in load_project_full response).
///
/// This struct contains the 11 display settings that are persisted per-project.
/// It is used ONLY for the consolidated load API response, not for storage.
///
/// NOTE: showShots is intentionally excluded per spec - the frontend's showShots
/// toggle exists but this API struct matches the 11 persisted settings only.
/// Frontend showShots state is managed separately (session-based, always defaults true).
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DisplaySettings {
    pub show_stations: bool,
    pub show_section_names: bool,
    pub show_station_labels: bool,
    pub show_shot_data: bool,
    pub show_virtual_shots: bool,
    pub show_zero_datum: bool,
    pub show_grid: bool,
    pub show_scale_bar: bool,
    pub show_satellite: bool,
    pub show_depth_gradient: bool,
    pub grid_spacing: f64,
}

impl Default for DisplaySettings {
    /// Default values matching uiStore/DISPLAY_DEFAULTS exactly.
    fn default() -> Self {
        Self {
            show_stations: true,
            show_section_names: true,
            show_station_labels: false,
            show_shot_data: false,
            show_virtual_shots: true,
            show_zero_datum: true,
            show_grid: false,
            show_scale_bar: true,
            show_satellite: false,
            show_depth_gradient: false,
            grid_spacing: 10.0,
        }
    }
}

impl DisplaySettings {
    /// Convert from stored HashMap<String, String> format.
    /// Keys MUST match what save_display_setting writes (camelCase keys).
    /// Default values match uiStore/DISPLAY_DEFAULTS.
    pub fn from_stored(map: &HashMap<String, String>) -> Self {
        Self {
            show_stations: map.get("showStations").map(|s| s == "true").unwrap_or(true),
            show_section_names: map.get("showSectionNames").map(|s| s == "true").unwrap_or(true),
            show_station_labels: map.get("showStationLabels").map(|s| s == "true").unwrap_or(false),
            show_shot_data: map.get("showShotData").map(|s| s == "true").unwrap_or(false),
            show_virtual_shots: map.get("showVirtualShots").map(|s| s == "true").unwrap_or(true),
            show_zero_datum: map.get("showZeroDatum").map(|s| s == "true").unwrap_or(true),
            show_grid: map.get("showGrid").map(|s| s == "true").unwrap_or(false),
            show_scale_bar: map.get("showScaleBar").map(|s| s == "true").unwrap_or(true),
            show_satellite: map.get("showSatellite").map(|s| s == "true").unwrap_or(false),
            show_depth_gradient: map.get("showDepthGradient").map(|s| s == "true").unwrap_or(false),
            grid_spacing: map.get("gridSpacing").and_then(|s| s.parse().ok()).unwrap_or(10.0),
        }
    }
}

// ============================================================================
// LoadingPhase
// ============================================================================

/// Loading phases for project open/create operations.
///
/// The `weight()` method on this enum is provided for convenience/reference.
/// The authoritative weights used for progress calculation are in ProgressEmitter's
/// phase_weights vec, which allows different weight distributions per flow type.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum LoadingPhase {
    // Project opening phases (8 total)
    OpeningDatabase,
    LoadingProjectData,
    LoadingSections,
    ComputingStations,
    ComputingStatistics,
    ValidatingData,
    LoadingSettings,
    Finalizing,
    // Project creation phases (3 total)
    CreatingDatabase,
    InitializingProject,
    SavingSettings,
    // Export phases (4 total)
    ExportPreparing,
    ExportGenerating,
    ExportWriting,
    ExportComplete,
}

impl LoadingPhase {
    /// Human-readable label for the phase.
    pub fn label(&self) -> &'static str {
        match self {
            Self::OpeningDatabase => "Opening database...",
            Self::LoadingProjectData => "Loading survey data...",
            Self::LoadingSections => "Loading sections...",
            Self::ComputingStations => "Calculating station positions...",
            Self::ComputingStatistics => "Computing statistics...",
            Self::ValidatingData => "Validating data...",
            Self::LoadingSettings => "Loading display settings...",
            Self::Finalizing => "Finalizing...",
            Self::CreatingDatabase => "Creating database...",
            Self::InitializingProject => "Initializing project...",
            Self::SavingSettings => "Saving settings...",
            Self::ExportPreparing => "Preparing export...",
            Self::ExportGenerating => "Generating...",
            Self::ExportWriting => "Writing file...",
            Self::ExportComplete => "Export complete",
        }
    }

    /// Reference weight for this phase (out of 100 within its flow).
    /// NOTE: ProgressEmitter uses its own phase_weights vec for actual calculations,
    /// which allows different weight distributions per flow type (open vs create vs export).
    pub fn weight(&self) -> f32 {
        match self {
            // Open phases sum to 100
            Self::OpeningDatabase => 5.0,
            Self::LoadingProjectData => 20.0,
            Self::LoadingSections => 15.0,
            Self::ComputingStations => 20.0,
            Self::ComputingStatistics => 15.0,
            Self::ValidatingData => 10.0,
            Self::LoadingSettings => 5.0,
            Self::Finalizing => 10.0,
            // Create phases sum to 100
            Self::CreatingDatabase => 40.0,
            Self::InitializingProject => 40.0,
            Self::SavingSettings => 20.0,
            // Export phases sum to 100
            Self::ExportPreparing => 10.0,
            Self::ExportGenerating => 60.0,
            Self::ExportWriting => 20.0,
            Self::ExportComplete => 10.0,
        }
    }
}

// ============================================================================
// LoadingProgress
// ============================================================================

/// Progress event payload sent to frontend.
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct LoadingProgress {
    pub loading_id: u64,
    pub phase: LoadingPhase,
    pub phase_index: u8,
    pub phase_count: u8,
    pub current: Option<u32>,
    pub total: Option<u32>,
    pub overall_percent: f32,
    pub is_indeterminate: bool,
}

// ============================================================================
// CancellationToken and CancelledError
// ============================================================================

/// Cancellation token using atomic bool.
#[derive(Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    /// Create a new cancellation token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Cancel the operation.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Check if the operation was cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Reset the cancellation state.
    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }
}

/// Error type for cancelled operations.
#[derive(Debug)]
pub struct CancelledError;

impl std::fmt::Display for CancelledError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Operation cancelled")
    }
}

impl std::error::Error for CancelledError {}

// ============================================================================
// ProgressEmitter
// ============================================================================

/// Global loading ID counter.
/// Starts at 1 because 0 is reserved as "unknown/awaiting handshake" on the frontend.
static LOADING_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Throttling constants.
const THROTTLE_ITEMS: u32 = 10;
const THROTTLE_MS: u64 = 50;
const HEARTBEAT_MS: u64 = 2000;

/// Emits loading progress events to the frontend.
pub struct ProgressEmitter {
    handle: AppHandle,
    loading_id: u64,
    cancelled: Arc<AtomicBool>,
    phase_weights: Vec<(LoadingPhase, f32)>,
    current_phase_idx: usize,
    last_emit: Instant,
    last_item: u32,
}

impl ProgressEmitter {
    /// Create a new emitter for project open operations (8 phases summing to 100%).
    pub fn new_for_open(handle: AppHandle, cancelled: Arc<AtomicBool>) -> Self {
        let weights = vec![
            (LoadingPhase::OpeningDatabase, 5.0),
            (LoadingPhase::LoadingProjectData, 20.0),
            (LoadingPhase::LoadingSections, 15.0),
            (LoadingPhase::ComputingStations, 20.0),
            (LoadingPhase::ComputingStatistics, 15.0),
            (LoadingPhase::ValidatingData, 10.0),
            (LoadingPhase::LoadingSettings, 5.0),
            (LoadingPhase::Finalizing, 10.0),
        ];
        debug_assert!(
            (weights.iter().map(|(_, w)| w).sum::<f32>() - 100.0).abs() < 0.01,
            "Open phase weights must sum to 100"
        );
        Self::new(handle, weights, cancelled)
    }

    /// Create a new emitter for project create operations (3 phases summing to 100%).
    pub fn new_for_create(handle: AppHandle, cancelled: Arc<AtomicBool>) -> Self {
        let weights = vec![
            (LoadingPhase::CreatingDatabase, 40.0),
            (LoadingPhase::InitializingProject, 40.0),
            (LoadingPhase::SavingSettings, 20.0),
        ];
        debug_assert!(
            (weights.iter().map(|(_, w)| w).sum::<f32>() - 100.0).abs() < 0.01,
            "Create phase weights must sum to 100"
        );
        Self::new(handle, weights, cancelled)
    }

    /// Create a new emitter for export operations (4 phases summing to 100%).
    ///
    /// Export operations don't support cancellation, so this uses a dummy token.
    pub fn new_for_export(handle: AppHandle) -> Self {
        let weights = vec![
            (LoadingPhase::ExportPreparing, 10.0),
            (LoadingPhase::ExportGenerating, 60.0),
            (LoadingPhase::ExportWriting, 20.0),
            (LoadingPhase::ExportComplete, 10.0),
        ];
        debug_assert!(
            (weights.iter().map(|(_, w)| w).sum::<f32>() - 100.0).abs() < 0.01,
            "Export phase weights must sum to 100"
        );
        // Export doesn't support cancellation - use a dummy token that's never cancelled
        let dummy_cancelled = Arc::new(AtomicBool::new(false));
        Self::new(handle, weights, dummy_cancelled)
    }

    fn new(handle: AppHandle, phase_weights: Vec<(LoadingPhase, f32)>, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            handle,
            loading_id: LOADING_ID_COUNTER.fetch_add(1, Ordering::SeqCst),
            cancelled,
            phase_weights,
            current_phase_idx: 0,
            last_emit: Instant::now() - Duration::from_secs(10), // Ensure first emit goes through
            last_item: 0,
        }
    }

    /// Get the loading ID for this emitter.
    pub fn loading_id(&self) -> u64 {
        self.loading_id
    }

    /// Check if the operation was cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Start a new phase - emits progress immediately.
    ///
    /// If the phase is not found in the emitter's phase list, logs a warning
    /// and keeps the current phase index to avoid misreporting progress.
    pub fn start_phase(&mut self, phase: LoadingPhase) {
        if let Some(idx) = self.phase_weights.iter().position(|(p, _)| *p == phase) {
            self.current_phase_idx = idx;
        } else {
            // Phase not in this emitter's flow - log warning but don't change index
            tracing::warn!(
                phase = ?phase,
                purpose = "report loading progress to UI",
                "start_phase called with phase not in emitter's phase_weights"
            );
        }
        self.last_item = 0;
        // Emit with indeterminate=true derived from having no current/total
        self.emit_progress(phase, None, None);
    }

    /// Update progress within a phase with throttling.
    /// Use 0-indexed current (0..total-1) or 1-indexed (1..total) - both work.
    pub fn update_phase(&mut self, phase: LoadingPhase, current: u32, total: u32) {
        let should_emit = current == 0
            || current == 1
            || current == total
            || current >= self.last_item + THROTTLE_ITEMS
            || self.last_emit.elapsed() >= Duration::from_millis(THROTTLE_MS);

        if should_emit {
            self.last_item = current;
            self.emit_progress(phase, Some(current), Some(total));
        }
    }

    /// Complete a phase - emits progress at 100% for this phase.
    pub fn complete_phase(&mut self, phase: LoadingPhase) {
        // Emit 100% completion for this phase (current=1, total=1 means 100%)
        self.emit_progress(phase, Some(1), Some(1));
    }

    /// Emit heartbeat for long-running indeterminate phases.
    pub fn heartbeat(&mut self, phase: LoadingPhase) {
        if self.last_emit.elapsed() >= Duration::from_millis(HEARTBEAT_MS) {
            self.emit_progress(phase, None, None);
        }
    }

    /// Emit a progress event. Derives is_indeterminate from current/total.
    fn emit_progress(&mut self, phase: LoadingPhase, current: Option<u32>, total: Option<u32>) {
        self.last_emit = Instant::now();

        let overall_percent = self.calculate_overall_percent(current, total);
        // Indeterminate when we don't have valid progress values
        let is_indeterminate = current.is_none() || total.is_none() || total == Some(0);

        let progress = LoadingProgress {
            loading_id: self.loading_id,
            phase,
            phase_index: self.current_phase_idx as u8,
            phase_count: self.phase_weights.len() as u8,
            current,
            total,
            overall_percent,
            is_indeterminate,
        };

        if let Err(e) = self.handle.emit("loading-progress", &progress) {
            tracing::warn!(
                error = %e,
                purpose = "report loading progress to UI",
                "Failed to emit loading progress event"
            );
        }
    }

    fn calculate_overall_percent(&self, current: Option<u32>, total: Option<u32>) -> f32 {
        let completed: f32 = self
            .phase_weights
            .iter()
            .take(self.current_phase_idx)
            .map(|(_, w)| w)
            .sum();

        let current_weight = self
            .phase_weights
            .get(self.current_phase_idx)
            .map(|(_, w)| *w)
            .unwrap_or(0.0);

        let phase_progress = match (current, total) {
            (Some(c), Some(t)) if t > 0 => (c as f32 / t as f32) * current_weight,
            _ => 0.0,
        };

        (completed + phase_progress).min(100.0)
    }
}

// ============================================================================
// LoadProjectFullResult
// ============================================================================

/// Result of a successful load_project_full operation.
/// Contains all data needed to initialize the frontend state.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct LoadProjectFullResult {
    /// Unique ID for this load operation (for filtering stale events)
    pub loading_id: u64,
    /// The loaded project
    pub project: crate::models::Project,
    /// Computed station coordinates
    pub stations: Vec<crate::models::Station>,
    /// Project statistics
    pub stats: crate::models::ProjectStats,
    /// Project warnings (validation results)
    pub warnings: Vec<crate::models::ProjectWarning>,
    /// Display settings from the project database
    pub display_settings: DisplaySettings,
}

// ============================================================================
// CreateProjectFullResult
// ============================================================================

/// Result of a successful create_project_full operation.
/// Contains all data needed to initialize the frontend state for a new project.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CreateProjectFullResult {
    /// Unique ID for this load operation (for filtering stale events)
    pub loading_id: u64,
    /// The created project
    pub project: crate::models::Project,
    /// Display settings (defaults for new project)
    pub display_settings: DisplaySettings,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[expect(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_load_error_display_produces_valid_json() {
        let error = LoadError::new("TEST_ERROR", "Test message");
        let display = error.to_string();

        // Should be valid JSON
        let parsed: serde_json::Value = serde_json::from_str(&display).expect("Display should produce valid JSON");
        assert_eq!(parsed["code"], "TEST_ERROR");
        assert_eq!(parsed["message"], "Test message");
    }

    #[test]
    fn test_load_error_display_escapes_quotes() {
        let error = LoadError::new("TEST", r#"Message with "quotes""#);
        let display = error.to_string();

        // Should be valid JSON even with quotes in message
        let parsed: serde_json::Value = serde_json::from_str(&display).expect("Display should produce valid JSON");
        assert_eq!(parsed["message"], r#"Message with "quotes""#);
    }

    #[test]
    fn test_load_error_display_escapes_control_chars() {
        let error = LoadError::new("TEST", "Line1\nLine2\tTabbed");
        let display = error.to_string();

        // Should be valid JSON even with control characters
        let parsed: serde_json::Value = serde_json::from_str(&display).expect("Display should produce valid JSON");
        assert_eq!(parsed["message"], "Line1\nLine2\tTabbed");
    }

    #[test]
    fn test_load_error_constructors() {
        assert_eq!(LoadError::already_open().code, "ALREADY_OPEN");
        assert_eq!(LoadError::cancelled().code, "CANCELLED");
        assert_eq!(LoadError::not_found("/path/to/file").code, "NOT_FOUND");
        assert_eq!(LoadError::internal("error").code, "INTERNAL");
    }

    #[test]
    fn test_escape_json_string() {
        assert_eq!(escape_json_string("hello"), "hello");
        assert_eq!(escape_json_string(r#"say "hi""#), r#"say \"hi\""#);
        assert_eq!(escape_json_string("back\\slash"), "back\\\\slash");
        assert_eq!(escape_json_string("line\nbreak"), "line\\nbreak");
        assert_eq!(escape_json_string("tab\there"), "tab\\there");
    }

    #[test]
    fn test_display_settings_default_matches_ui_store() {
        let defaults = DisplaySettings::default();

        // Verify defaults match DISPLAY_DEFAULTS in uiStore
        assert!(defaults.show_stations);           // true
        assert!(defaults.show_section_names);      // true
        assert!(!defaults.show_station_labels);    // false
        assert!(!defaults.show_shot_data);         // false
        assert!(defaults.show_virtual_shots);      // true
        assert!(defaults.show_zero_datum);         // true
        assert!(!defaults.show_grid);              // false
        assert!(defaults.show_scale_bar);          // true
        assert!(!defaults.show_satellite);         // false
        assert!(!defaults.show_depth_gradient);    // false
        assert!((defaults.grid_spacing - 10.0).abs() < 0.001);  // 10.0
    }

    #[test]
    fn test_display_settings_from_stored_defaults() {
        let empty: HashMap<String, String> = HashMap::new();
        let settings = DisplaySettings::from_stored(&empty);

        // Verify defaults match DISPLAY_DEFAULTS in uiStore
        assert!(settings.show_stations);           // true
        assert!(settings.show_section_names);      // true
        assert!(!settings.show_station_labels);    // false
        assert!(!settings.show_shot_data);         // false
        assert!(settings.show_virtual_shots);      // true
        assert!(settings.show_zero_datum);         // true
        assert!(!settings.show_grid);              // false
        assert!(settings.show_scale_bar);          // true
        assert!(!settings.show_satellite);         // false
        assert!(!settings.show_depth_gradient);    // false
        assert!((settings.grid_spacing - 10.0).abs() < 0.001);  // 10.0
    }

    #[test]
    fn test_display_settings_from_stored_with_values() {
        let mut map = HashMap::new();
        map.insert("showStations".into(), "false".into());
        map.insert("showGrid".into(), "true".into());
        map.insert("gridSpacing".into(), "5.0".into());

        let settings = DisplaySettings::from_stored(&map);

        assert!(!settings.show_stations);
        assert!(settings.show_grid);
        assert!((settings.grid_spacing - 5.0).abs() < 0.001);
    }

    #[test]
    fn test_display_settings_from_stored_all_11_fields() {
        // Verify ALL 11 fields are mapped correctly from stored HashMap
        let mut stored = HashMap::new();
        stored.insert("showStations".to_string(), "false".to_string());
        stored.insert("showSectionNames".to_string(), "false".to_string());
        stored.insert("showStationLabels".to_string(), "true".to_string());
        stored.insert("showShotData".to_string(), "true".to_string());
        stored.insert("showVirtualShots".to_string(), "false".to_string());
        stored.insert("showZeroDatum".to_string(), "false".to_string());
        stored.insert("showGrid".to_string(), "true".to_string());
        stored.insert("showScaleBar".to_string(), "false".to_string());
        stored.insert("showSatellite".to_string(), "true".to_string());
        stored.insert("showDepthGradient".to_string(), "true".to_string());
        stored.insert("gridSpacing".to_string(), "25.5".to_string());

        let settings = DisplaySettings::from_stored(&stored);

        // Verify all 11 fields - each should be the opposite of the default
        assert!(!settings.show_stations, "showStations should be false");
        assert!(!settings.show_section_names, "showSectionNames should be false");
        assert!(settings.show_station_labels, "showStationLabels should be true");
        assert!(settings.show_shot_data, "showShotData should be true");
        assert!(!settings.show_virtual_shots, "showVirtualShots should be false");
        assert!(!settings.show_zero_datum, "showZeroDatum should be false");
        assert!(settings.show_grid, "showGrid should be true");
        assert!(!settings.show_scale_bar, "showScaleBar should be false");
        assert!(settings.show_satellite, "showSatellite should be true");
        assert!(settings.show_depth_gradient, "showDepthGradient should be true");
        assert!((settings.grid_spacing - 25.5).abs() < 0.001, "gridSpacing should be 25.5");
    }

    #[test]
    fn test_loading_phase_labels() {
        assert_eq!(LoadingPhase::OpeningDatabase.label(), "Opening database...");
        assert_eq!(LoadingPhase::ComputingStations.label(), "Calculating station positions...");
        assert_eq!(LoadingPhase::CreatingDatabase.label(), "Creating database...");
    }

    #[test]
    fn test_loading_phase_weights_sum_to_100_for_open() {
        let open_phases = [
            LoadingPhase::OpeningDatabase,
            LoadingPhase::LoadingProjectData,
            LoadingPhase::LoadingSections,
            LoadingPhase::ComputingStations,
            LoadingPhase::ComputingStatistics,
            LoadingPhase::ValidatingData,
            LoadingPhase::LoadingSettings,
            LoadingPhase::Finalizing,
        ];
        let sum: f32 = open_phases.iter().map(|p| p.weight()).sum();
        assert!((sum - 100.0).abs() < 0.01, "Open phases should sum to 100, got {}", sum);
    }

    #[test]
    fn test_loading_phase_weights_sum_to_100_for_create() {
        let create_phases = [
            LoadingPhase::CreatingDatabase,
            LoadingPhase::InitializingProject,
            LoadingPhase::SavingSettings,
        ];
        let sum: f32 = create_phases.iter().map(|p| p.weight()).sum();
        assert!((sum - 100.0).abs() < 0.01, "Create phases should sum to 100, got {}", sum);
    }

    #[test]
    fn test_cancellation_token() {
        let token = CancellationToken::new();
        assert!(!token.is_cancelled());

        token.cancel();
        assert!(token.is_cancelled());

        token.reset();
        assert!(!token.is_cancelled());
    }

    #[test]
    fn test_cancellation_token_clone() {
        let token1 = CancellationToken::new();
        let token2 = token1.clone();

        token1.cancel();
        assert!(token2.is_cancelled(), "Cloned token should see cancellation");
    }
}
