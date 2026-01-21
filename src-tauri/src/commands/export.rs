use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

use crate::core::AppState;
use crate::export::{DepthPreset, DepthPresetColors, ExportImageOptions, ExportProgress};

/// Export project data to CSV
#[tauri::command]
pub fn export_csv(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| "No project open".to_string())?;

    crate::export::export_csv(&project, &path).map_err(|e| e.to_string())
}

/// Export project data to JSON
#[tauri::command]
pub fn export_json(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| "No project open".to_string())?;

    crate::export::export_json(&project, &path).map_err(|e| e.to_string())
}

/// Export map image with progress events
///
/// This command runs heavy export work (SVG generation, PNG rasterization, PDF conversion)
/// in a blocking thread pool to prevent freezing the UI and ensure progress events propagate.
#[tauri::command]
pub async fn export_image(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    path: PathBuf,
    options: ExportImageOptions,
) -> Result<(), String> {
    // Clone project data before spawning blocking task
    let project = state
        .get_project_state()
        .ok_or_else(|| "No project open".to_string())?;

    // Run heavy export work in spawn_blocking to avoid freezing UI
    // and ensure progress events are delivered during processing
    tauri::async_runtime::spawn_blocking(move || {
        // Emit progress callback - captures app_handle by move
        let emit_progress = |progress: ExportProgress| {
            let _ = app_handle.emit("export-progress", &progress);
        };

        crate::export::export_image_with_progress(&project, &path, &options, emit_progress)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))?
}

/// Get depth color preset colors
#[tauri::command]
pub fn get_depth_preset_colors(preset: DepthPreset) -> DepthPresetColors {
    crate::export::get_depth_preset_colors(preset)
}
