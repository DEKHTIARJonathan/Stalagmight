use crate::logging;
use crate::logging::LogsSince;

#[tauri::command]
pub fn get_recent_logs() -> Vec<String> {
    logging::get_recent_logs()
}

/// Return ring-buffer entries newer than `after_seq`, plus the newest sequence
/// number and a `dropped` flag (true if the ring rotated past the checkpoint).
/// Pass `after_seq = 0` to get everything currently buffered.
#[tauri::command]
pub fn get_recent_logs_since(after_seq: u64) -> LogsSince {
    logging::get_recent_logs_since(after_seq)
}

#[tauri::command]
pub fn push_frontend_log(level: String, message: String) {
    let line = format!("{} [frontend]: {}", level.to_uppercase(), message);
    logging::push_to_buffer(line);
}
