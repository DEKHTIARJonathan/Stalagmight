use std::collections::HashMap;

use tauri::State;

use crate::telemetry::TelemetryCollector;

/// Receive a batch of event counts from the frontend.
#[tauri::command]
pub fn track_events(
    state: State<'_, TelemetryCollector>,
    events: HashMap<String, u64>,
) -> Result<(), String> {
    state.track_batch(&events);
    Ok(())
}

/// Flush current telemetry buffer to the backend.
#[tauri::command]
pub fn flush_telemetry(state: State<'_, TelemetryCollector>) -> Result<(), String> {
    state.flush();
    Ok(())
}

/// Returns true when the telemetry feature is compiled in.
/// The frontend uses this to detect feature availability.
#[tauri::command]
pub fn is_telemetry_available() -> bool {
    true
}

/// Update the telemetry enabled state (called when user toggles in settings).
#[tauri::command]
pub fn set_telemetry_enabled(
    state: State<'_, TelemetryCollector>,
    enabled: bool,
) -> Result<(), String> {
    state.set_enabled(enabled);
    Ok(())
}
