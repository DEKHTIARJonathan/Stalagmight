use crate::commands::pool;
use crate::logging;
use crate::logging::LogsSince;

#[tauri::command]
pub async fn get_recent_logs() -> Vec<String> {
    pool::run_stateless_infallible(logging::get_recent_logs).await
}

/// Return ring-buffer entries newer than `after_seq`, plus the newest sequence
/// number and a `dropped` flag (true if the ring rotated past the checkpoint).
/// Pass `after_seq = 0` to get everything currently buffered.
#[tauri::command]
pub async fn get_recent_logs_since(after_seq: u64) -> LogsSince {
    pool::run_stateless_infallible(move || logging::get_recent_logs_since(after_seq)).await
}

#[tauri::command]
pub async fn push_frontend_log(level: String, message: String) {
    pool::run_stateless_infallible(move || {
        let line = format!("{} [frontend]: {}", level.to_uppercase(), message);
        logging::push_to_buffer(line);
    })
    .await;
}
