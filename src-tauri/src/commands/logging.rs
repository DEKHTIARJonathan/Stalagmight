use crate::logging;

#[tauri::command]
pub fn get_recent_logs() -> Vec<String> {
    logging::get_recent_logs()
}

#[tauri::command]
pub fn push_frontend_log(level: String, message: String) {
    let line = format!("{} [frontend]: {}", level.to_uppercase(), message);
    logging::push_to_buffer(line);
}
