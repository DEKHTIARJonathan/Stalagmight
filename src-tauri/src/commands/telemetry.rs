use std::collections::HashMap;

use tauri::State;

use crate::telemetry::TelemetryCollector;

/// Receive a batch of event counts from the frontend.
#[tauri::command]
pub fn track_events(
    state: State<'_, TelemetryCollector>,
    events: HashMap<String, u64>,
    project_seq: u32,
) -> Result<(), String> {
    state.track_batch(&events, project_seq);
    Ok(())
}

/// Hand the pending telemetry to the offline buffer - the app-close path.
///
/// No network: sending here made quitting wait on the server, one request per
/// open project bucket (#576 B17). The next launch's background drain sends
/// what this writes.
#[tauri::command]
pub fn flush_telemetry(state: State<'_, TelemetryCollector>) -> Result<(), String> {
    state.buffer_pending();
    Ok(())
}

/// Returns true when the telemetry feature is compiled in.
/// The frontend uses this to detect feature availability.
#[tauri::command]
pub fn is_telemetry_available() -> bool {
    cfg!(feature = "telemetry")
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
