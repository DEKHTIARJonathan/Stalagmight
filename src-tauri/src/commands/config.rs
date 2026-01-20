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

/// Reload configuration from disk without persisting any changes
/// This re-reads the config file and updates the in-memory state
#[tauri::command]
pub fn reload_config(state: State<AppState>) -> Result<Config, String> {
    state.reload_config().map_err(|e| e.to_string())
}

/// Update panel sizes in configuration (efficient partial update)
#[tauri::command]
pub fn update_panel_sizes(
    state: State<AppState>,
    sections_panel_width: Option<u32>,
    detail_panel_width: Option<u32>,
    data_table_height: Option<u32>,
) -> Result<(), String> {
    let mut config = state.get_config();
    if let Some(w) = sections_panel_width {
        config.panels.sections_panel_width = w;
    }
    if let Some(w) = detail_panel_width {
        config.panels.detail_panel_width = w;
    }
    if let Some(h) = data_table_height {
        config.panels.data_table_height = h;
    }
    state.update_config(config).map_err(|e| e.to_string())
}

/// Load all display settings from the current project database
#[tauri::command]
pub fn load_display_settings(state: State<AppState>) -> Result<std::collections::HashMap<String, String>, String> {
    state.load_display_settings().map_err(|e| e.to_string())
}

/// Save a display setting to the current project database
#[tauri::command]
pub fn save_display_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    state.save_display_setting(&key, &value).map_err(|e| e.to_string())
}

/// Get a single display setting from the current project database
#[tauri::command]
pub fn get_display_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    state.get_display_setting(&key).map_err(|e| e.to_string())
}
