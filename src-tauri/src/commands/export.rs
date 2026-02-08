use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::core::loading::{LoadingPhase, ProgressEmitter};
use crate::core::AppState;
use crate::export::{DepthPreset, DepthPresetColors, ExportImageOptions};

/// Export project data to CSV
#[tauri::command]
pub fn export_csv(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    export_csv_impl(state.inner(), path)
}

pub(crate) fn export_csv_impl(state: &AppState, path: PathBuf) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| {
            tracing::warn!(
                path = ?path,
                purpose = "export project for sharing",
                format = "csv",
                "Export requested with no project open"
            );
            "No project open".to_string()
        })?;

    tracing::info!(
        path = ?path,
        purpose = "export project for sharing",
        format = "csv",
        "Exporting project to CSV"
    );
    match crate::export::export_csv(&project, &path) {
        Ok(()) => {
            tracing::info!(
                path = ?path,
                purpose = "export project for sharing",
                format = "csv",
                "CSV export completed"
            );
            Ok(())
        }
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "export project for sharing",
                format = "csv",
                reason = %e,
                "CSV export failed"
            );
            Err(e.to_string())
        }
    }
}

/// Export project data to JSON
#[tauri::command]
pub fn export_json(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    export_json_impl(state.inner(), path)
}

pub(crate) fn export_json_impl(state: &AppState, path: PathBuf) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| {
            tracing::warn!(
                path = ?path,
                purpose = "export project for sharing",
                format = "json",
                "Export requested with no project open"
            );
            "No project open".to_string()
        })?;

    tracing::info!(
        path = ?path,
        purpose = "export project for sharing",
        format = "json",
        "Exporting project to JSON"
    );
    match crate::export::export_json(&project, &path) {
        Ok(()) => {
            tracing::info!(
                path = ?path,
                purpose = "export project for sharing",
                format = "json",
                "JSON export completed"
            );
            Ok(())
        }
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "export project for sharing",
                format = "json",
                reason = %e,
                "JSON export failed"
            );
            Err(e.to_string())
        }
    }
}

/// Export project data to Ariane TML/TMLU
#[tauri::command]
pub fn export_tml(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    export_tml_impl(state.inner(), path)
}

pub(crate) fn export_tml_impl(state: &AppState, path: PathBuf) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| {
            tracing::warn!(
                path = ?path,
                purpose = "export project for sharing",
                format = "tml",
                "Export requested with no project open"
            );
            "No project open".to_string()
        })?;

    tracing::info!(
        path = ?path,
        purpose = "export project for sharing",
        format = "tml",
        "Exporting project to TML"
    );
    match crate::export::export_tml(&project, &path) {
        Ok(()) => {
            tracing::info!(
                path = ?path,
                purpose = "export project for sharing",
                format = "tml",
                "TML export completed"
            );
            Ok(())
        }
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "export project for sharing",
                format = "tml",
                reason = %e,
                "TML export failed"
            );
            Err(e.to_string())
        }
    }
}

/// Export map image with progress events via shared loading-progress infrastructure.
///
/// This command runs heavy export work (SVG generation, PNG rasterization, PDF conversion)
/// in a blocking thread pool to prevent freezing the UI and ensure progress events propagate.
/// Progress is emitted using the shared ProgressEmitter (loading-progress events) for
/// integration with the LoadingProgress component.
#[tauri::command]
pub async fn export_image(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    path: PathBuf,
    options: ExportImageOptions,
) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| {
            tracing::warn!(
                path = ?path,
                purpose = "export map image for sharing",
                format = ?options.format,
                "Export requested with no project open"
            );
            "No project open".to_string()
        })?;
    let format = options.format;
    let log_path = path.clone();

    // Run heavy export work in spawn_blocking to avoid freezing UI
    // and ensure progress events are delivered during processing
    tauri::async_runtime::spawn_blocking(move || {
        tracing::info!(
            path = ?path,
            purpose = "export map image for sharing",
            format = ?options.format,
            "Starting image export"
        );
        // Use shared ProgressEmitter for consistent progress events
        let mut emitter = ProgressEmitter::new_for_export(app_handle);

        // Start preparing phase
        emitter.start_phase(LoadingPhase::ExportPreparing);

        // Generate phase (SVG generation, rasterization)
        emitter.start_phase(LoadingPhase::ExportGenerating);

        // Perform the actual export
        let result = crate::export::export_image(&project, &path, &options);

        if result.is_ok() {
            // Writing phase
            emitter.start_phase(LoadingPhase::ExportWriting);
            emitter.complete_phase(LoadingPhase::ExportWriting);

            // Complete phase
            emitter.start_phase(LoadingPhase::ExportComplete);
            emitter.complete_phase(LoadingPhase::ExportComplete);
            tracing::info!(
                path = ?path,
                purpose = "export map image for sharing",
                format = ?options.format,
                "Image export completed"
            );
        } else if let Err(ref e) = result {
            tracing::error!(
                path = ?path,
                purpose = "export map image for sharing",
                format = ?options.format,
                reason = %e,
                "Image export failed"
            );
        }

        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| {
        tracing::error!(
            path = ?log_path,
            purpose = "export map image for sharing",
            format = ?format,
            reason = %e,
            "Image export task panicked"
        );
        format!("Export task panicked: {e}")
    })?
}

#[cfg(test)]
pub(crate) fn export_image_impl(
    state: &AppState,
    path: PathBuf,
    options: ExportImageOptions,
) -> Result<(), String> {
    let project = state
        .get_project_state()
        .ok_or_else(|| {
            tracing::warn!(
                path = ?path,
                purpose = "export map image for sharing",
                format = ?options.format,
                "Export requested with no project open"
            );
            "No project open".to_string()
        })?;

    tracing::info!(
        path = ?path,
        purpose = "export map image for sharing",
        format = ?options.format,
        "Exporting map image"
    );
    match crate::export::export_image(&project, &path, &options) {
        Ok(()) => {
            tracing::info!(
                path = ?path,
                purpose = "export map image for sharing",
                format = ?options.format,
                "Map image export completed"
            );
            Ok(())
        }
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "export map image for sharing",
                format = ?options.format,
                reason = %e,
                "Map image export failed"
            );
            Err(e.to_string())
        }
    }
}

/// Get depth color preset colors
#[tauri::command]
pub fn get_depth_preset_colors(preset: DepthPreset) -> DepthPresetColors {
    crate::export::get_depth_preset_colors(preset)
}
