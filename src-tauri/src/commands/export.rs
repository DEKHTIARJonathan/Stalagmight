use std::path::PathBuf;
use tauri::State;

use crate::core::AppState;
use crate::export::ExportImageOptions;

/// Export project data to CSV
#[tauri::command]
pub fn export_csv(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    export_csv_impl(state.inner(), path)
}

pub(crate) fn export_csv_impl(state: &AppState, path: PathBuf) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| "No project open".to_string())?;

    crate::export::export_csv(&project, &path).map_err(|e| e.to_string())
}

/// Export project data to JSON
#[tauri::command]
pub fn export_json(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    export_json_impl(state.inner(), path)
}

pub(crate) fn export_json_impl(state: &AppState, path: PathBuf) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| "No project open".to_string())?;

    crate::export::export_json(&project, &path).map_err(|e| e.to_string())
}

/// Export map image
#[tauri::command]
pub fn export_image(
    state: State<AppState>,
    path: PathBuf,
    options: ExportImageOptions,
) -> Result<(), String> {
    export_image_impl(state.inner(), path, options)
}

pub(crate) fn export_image_impl(
    state: &AppState,
    path: PathBuf,
    options: ExportImageOptions,
) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| "No project open".to_string())?;

    crate::export::export_image(&project, &path, &options).map_err(|e| e.to_string())
}
