use tauri::State;

use crate::config::Config;
use crate::core::AppState;

/// Get the current configuration
#[tauri::command]
pub fn get_config(state: State<AppState>) -> Config {
    state.get_config()
}

/// Update the configuration
#[tauri::command]
pub fn update_config(state: State<AppState>, config: Config) -> Result<(), String> {
    state.update_config(config).map_err(|e| e.to_string())
}
