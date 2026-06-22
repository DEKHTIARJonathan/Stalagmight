use tauri::State;

use crate::config::Config;
use crate::core::AppState;

/// Get the current configuration
#[tauri::command]
pub fn get_config(state: State<AppState>) -> Config {
    get_config_impl(state.inner())
}

pub(crate) fn get_config_impl(state: &AppState) -> Config {
    state.get_config()
}

/// Update the configuration
#[tauri::command]
pub fn update_config(state: State<AppState>, config: Config) -> Result<(), String> {
    update_config_impl(state.inner(), config)
}

pub(crate) fn update_config_impl(state: &AppState, config: Config) -> Result<(), String> {
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
    update_panel_sizes_impl(
        state.inner(),
        sections_panel_width,
        detail_panel_width,
        data_table_height,
    )
}

/// Update the data-table view state (shot/station column order and
/// visibility, angle display modes) in configuration (efficient partial update)
#[tauri::command]
pub fn update_data_table_view(
    state: State<AppState>,
    column_order: Option<Vec<String>>,
    hidden_columns: Option<Vec<String>>,
    azimuth_mode: Option<String>,
    inclination_mode: Option<String>,
    station_column_order: Option<Vec<String>>,
    station_hidden_columns: Option<Vec<String>>,
) -> Result<(), String> {
    update_data_table_view_impl(
        state.inner(),
        column_order,
        hidden_columns,
        azimuth_mode,
        inclination_mode,
        station_column_order,
        station_hidden_columns,
    )
}

pub(crate) fn update_data_table_view_impl(
    state: &AppState,
    column_order: Option<Vec<String>>,
    hidden_columns: Option<Vec<String>>,
    azimuth_mode: Option<String>,
    inclination_mode: Option<String>,
    station_column_order: Option<Vec<String>>,
    station_hidden_columns: Option<Vec<String>>,
) -> Result<(), String> {
    const MODES: [&str; 3] = ["avg", "inout", "off"];
    let mut config = state.get_config();
    if let Some(order) = column_order {
        config.panels.data_table_shot_column_order = order;
    }
    if let Some(hidden) = hidden_columns {
        config.panels.data_table_shot_hidden_columns = hidden;
    }
    if let Some(mode) = azimuth_mode {
        if !MODES.contains(&mode.as_str()) {
            return Err(format!("Invalid azimuth mode '{mode}'"));
        }
        config.panels.data_table_azimuth_mode = mode;
    }
    if let Some(mode) = inclination_mode {
        if !MODES.contains(&mode.as_str()) {
            return Err(format!("Invalid inclination mode '{mode}'"));
        }
        config.panels.data_table_inclination_mode = mode;
    }
    if let Some(order) = station_column_order {
        config.panels.data_table_station_column_order = order;
    }
    if let Some(hidden) = station_hidden_columns {
        config.panels.data_table_station_hidden_columns = hidden;
    }
    state.update_config(config).map_err(|e| e.to_string())
}

pub(crate) fn update_panel_sizes_impl(
    state: &AppState,
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

/// Update per-panel reveal layout (open state + hover/pin mode) in configuration
/// (efficient partial update). Only provided fields are written.
#[tauri::command]
pub fn update_panel_layout(
    state: State<AppState>,
    sections_panel_open: Option<bool>,
    sections_panel_mode: Option<String>,
    detail_panel_open: Option<bool>,
    detail_panel_mode: Option<String>,
    data_table_open: Option<bool>,
    data_table_mode: Option<String>,
) -> Result<(), String> {
    update_panel_layout_impl(
        state.inner(),
        sections_panel_open,
        sections_panel_mode,
        detail_panel_open,
        detail_panel_mode,
        data_table_open,
        data_table_mode,
    )
}

pub(crate) fn update_panel_layout_impl(
    state: &AppState,
    sections_panel_open: Option<bool>,
    sections_panel_mode: Option<String>,
    detail_panel_open: Option<bool>,
    detail_panel_mode: Option<String>,
    data_table_open: Option<bool>,
    data_table_mode: Option<String>,
) -> Result<(), String> {
    const MODES: [&str; 2] = ["pin", "hover"];
    let validate = |m: &str| -> Result<(), String> {
        if MODES.contains(&m) {
            Ok(())
        } else {
            Err(format!("Invalid panel mode '{m}'"))
        }
    };
    let mut config = state.get_config();
    if let Some(open) = sections_panel_open {
        config.panels.sections_panel_open = open;
    }
    if let Some(mode) = sections_panel_mode {
        validate(&mode)?;
        config.panels.sections_panel_mode = mode;
    }
    if let Some(open) = detail_panel_open {
        config.panels.detail_panel_open = open;
    }
    if let Some(mode) = detail_panel_mode {
        validate(&mode)?;
        config.panels.detail_panel_mode = mode;
    }
    if let Some(open) = data_table_open {
        config.panels.data_table_open = open;
    }
    if let Some(mode) = data_table_mode {
        validate(&mode)?;
        config.panels.data_table_mode = mode;
    }
    state.update_config(config).map_err(|e| e.to_string())
}

/// Load all display settings from the current project database
#[tauri::command]
pub fn load_display_settings(
    state: State<AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    load_display_settings_impl(state.inner())
}

pub(crate) fn load_display_settings_impl(
    state: &AppState,
) -> Result<std::collections::HashMap<String, String>, String> {
    state.load_display_settings().map_err(|e| e.to_string())
}

/// Save a display setting to the current project database
#[tauri::command]
pub fn save_display_setting(
    state: State<AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    save_display_setting_impl(state.inner(), key, value)
}

pub(crate) fn save_display_setting_impl(
    state: &AppState,
    key: String,
    value: String,
) -> Result<(), String> {
    state
        .save_display_setting(&key, &value)
        .map_err(|e| e.to_string())
}

/// Get a single display setting from the current project database
#[tauri::command]
pub fn get_display_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    get_display_setting_impl(state.inner(), key)
}

pub(crate) fn get_display_setting_impl(
    state: &AppState,
    key: String,
) -> Result<Option<String>, String> {
    state.get_display_setting(&key).map_err(|e| e.to_string())
}
