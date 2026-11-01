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

#[cfg(test)]
#[expect(clippy::print_stderr)]
mod tests {
    use super::*;

    /// The frontend gates the opt-in dialog, the Settings privacy section and
    /// every telemetry IPC call on this answer, so a build without the
    /// `telemetry` feature must report false.
    #[test]
    fn is_telemetry_available_matches_compiled_feature() {
        let reported = is_telemetry_available();
        let compiled = cfg!(feature = "telemetry");
        eprintln!(
            "is_telemetry_available() = {reported}, cfg!(feature = \"telemetry\") = {compiled}"
        );
        assert_eq!(
            reported, compiled,
            "is_telemetry_available() must match the compiled telemetry feature"
        );
    }
}
