use crate::logging;

#[tauri::command]
pub fn get_recent_logs() -> Vec<String> {
    logging::get_recent_logs()
}
