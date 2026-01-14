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
