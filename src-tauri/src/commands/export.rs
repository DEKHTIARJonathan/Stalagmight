use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::core::loading::{LoadingPhase, ProgressEmitter};
use crate::core::AppState;
use crate::export::ExportImageOptions;
use crate::models::Project;

/// True when `target` resolves to the same file on disk as the open project's
/// `.stalx` at `existing`. Image export writes raw bytes (`std::fs::write` /
/// `pixmap.save_png`), so exporting over the live project database would corrupt
/// it. `existing` always exists (it is the open DB); `target` may not exist yet
/// (a fresh export destination), so when it can't be canonicalized directly,
/// compare its canonicalized parent directory + file name against the
/// canonicalized project path. Errs toward catching the exact open-DB path
/// rather than rejecting unrelated destinations.
fn is_open_project_file(target: &Path, existing: &Path) -> bool {
    let Ok(existing_canon) = std::fs::canonicalize(existing) else {
        return false;
    };
    // Fast path: `target` exists and canonicalizes to the same file.
    if std::fs::canonicalize(target).is_ok_and(|t| t == existing_canon) {
        return true;
    }
    // `target` may not exist yet: canonicalize its parent (which does) and
    // rejoin the file name.
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
        return false;
    };
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    std::fs::canonicalize(parent).is_ok_and(|p| p.join(name) == existing_canon)
}

/// Generic helper that handles the shared export logic for all text-based formats.
fn export_format_impl(
    state: &AppState,
    path: PathBuf,
    format: &str,
    export_fn: fn(&Project, &Path) -> Result<(), anyhow::Error>,
) -> Result<(), String> {
    let project = state.get_project_state().ok_or_else(|| {
        tracing::warn!(
            path = ?path,
            purpose = "export project for sharing",
            format = format,
            "Export requested with no project open"
        );
        "No project open".to_string()
    })?;

    // Never clobber the open project `.stalx` (same guard as the image export):
    // a text export named to the open DB would overwrite it with CSV/JSON/TML.
    if let Some(open_path) = project.file_path.as_deref() {
        if is_open_project_file(&path, open_path) {
            tracing::warn!(
                path = ?path,
                open_project = ?open_path,
                format = format,
                "Refused to export over the open project file"
            );
            return Err("Cannot export over the open project file".to_string());
        }
    }

    tracing::info!(
        path = ?path,
        purpose = "export project for sharing",
        format = format,
        "Exporting project to {}", format.to_uppercase()
    );
    match export_fn(&project, &path) {
        Ok(()) => {
            tracing::info!(
                path = ?path,
                purpose = "export project for sharing",
                format = format,
                "{} export completed", format.to_uppercase()
            );
            Ok(())
        }
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "export project for sharing",
                format = format,
                reason = %e,
                "{} export failed", format.to_uppercase()
            );
            Err(e.to_string())
        }
    }
}

/// Export project data to CSV
#[tauri::command]
pub fn export_csv(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    export_csv_impl(state.inner(), path)
}

pub(crate) fn export_csv_impl(state: &AppState, path: PathBuf) -> Result<(), String> {
    export_format_impl(state, path, "csv", crate::export::export_csv)
}

/// Export project data to JSON
#[tauri::command]
pub fn export_json(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    export_json_impl(state.inner(), path)
}

pub(crate) fn export_json_impl(state: &AppState, path: PathBuf) -> Result<(), String> {
    export_format_impl(state, path, "json", crate::export::export_json)
}

/// Export project data to Ariane TML/TMLU
#[tauri::command]
pub fn export_tml(state: State<AppState>, path: PathBuf) -> Result<(), String> {
    export_tml_impl(state.inner(), path)
}

pub(crate) fn export_tml_impl(state: &AppState, path: PathBuf) -> Result<(), String> {
    export_format_impl(state, path, "tml", crate::export::export_tml)
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
    mut options: ExportImageOptions,
) -> Result<(), String> {
    // Server-populated (#27): the export must colour its distance ramp and
    // label its penetration with the same graph the app is showing, so this
    // comes from the live config, never from whatever the frontend sent.
    options.include_reference_legs = state.get_config().gas.include_reference_legs;
    let project = state.get_project_state().ok_or_else(|| {
        tracing::warn!(
            path = ?path,
            purpose = "export map image for sharing",
            format = ?options.format,
            "Export requested with no project open"
        );
        "No project open".to_string()
    })?;

    // Never let an image export clobber the open project's own `.stalx`: the
    // raw file write in `export/image.rs` would overwrite the live database.
    if let Some(open_path) = project.file_path.as_deref() {
        if is_open_project_file(&path, open_path) {
            tracing::warn!(
                path = ?path,
                open_project = ?open_path,
                purpose = "protect the open project database",
                "Refusing to export an image over the open project file"
            );
            return Err("Cannot export over the open project file".to_string());
        }
    }

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
        // Render from the memoized closure-adjusted solve so the saved image
        // matches the on-screen (adjusted) map; falls back to measured
        // coordinates when there are no eligible closures. Fetch before the
        // emitter consumes `app_handle`.
        let adjusted = app_handle
            .state::<AppState>()
            .inner()
            .get_adjusted_stations();

        // Use shared ProgressEmitter for consistent progress events
        let mut emitter = ProgressEmitter::new_for_export(app_handle);

        // Start preparing phase
        emitter.start_phase(LoadingPhase::ExportPreparing);

        // Generate phase (SVG generation, rasterization)
        emitter.start_phase(LoadingPhase::ExportGenerating);

        // Perform the actual export
        let result = match adjusted {
            Some(stations) => {
                crate::export::export_image_with_stations(&project, &path, &options, stations)
            }
            None => crate::export::export_image(&project, &path, &options),
        };

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
    mut options: ExportImageOptions,
) -> Result<(), String> {
    // See the `export_image` command: config wins over the wire (#27).
    options.include_reference_legs = state.get_config().gas.include_reference_legs;
    let project = state.get_project_state().ok_or_else(|| {
        tracing::warn!(
            path = ?path,
            purpose = "export map image for sharing",
            format = ?options.format,
            "Export requested with no project open"
        );
        "No project open".to_string()
    })?;

    // Mirror the live command's guard: never clobber the open project `.stalx`.
    if let Some(open_path) = project.file_path.as_deref() {
        if is_open_project_file(&path, open_path) {
            return Err("Cannot export over the open project file".to_string());
        }
    }

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

/// Generate the SVG markup that `export_image` would write, without
/// touching the filesystem. Used by the export dialog so the preview is
/// pixel-for-pixel identical to what export will produce.
///
/// Runs the (potentially heavy: bounds + Dijkstra + polyline emission)
/// work in `spawn_blocking` so the slider can drag without stalling the
/// Tauri main thread on large surveys - mirroring `export_image`.
#[tauri::command]
pub async fn preview_svg_export(
    app_handle: AppHandle,
    mut options: ExportImageOptions,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        // Same config-wins rule as the export itself, so the preview cannot
        // disagree with the file it is previewing (#27).
        options.include_reference_legs = state.get_config().gas.include_reference_legs;
        let project = state
            .get_project_state()
            .ok_or_else(|| "No project open".to_string())?;
        // Render from the memoized closure-adjusted solve so the preview matches
        // the on-screen (adjusted) map; falls back to measured coordinates when
        // there are no eligible closures.
        match state.inner().get_adjusted_stations() {
            Some(stations) => {
                crate::export::generate_svg_string_with_stations(&project, &options, stations)
            }
            None => crate::export::generate_svg_string(&project, &options),
        }
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Preview task panicked: {e}"))?
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn is_open_project_file_matches_same_path_and_rejects_others() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("cave.stalx");
        std::fs::write(&project, b"db").unwrap();

        // The exact open-project path (both exist) is caught.
        assert!(is_open_project_file(&project, &project));

        // A different, not-yet-existing export target in the same dir is allowed.
        let other = dir.path().join("export.svg");
        assert!(!is_open_project_file(&other, &project));

        // A not-yet-existing target that still resolves to the project file
        // (parent canonicalizes, file name matches) is caught via the fallback.
        std::fs::remove_file(&project).unwrap();
        let recreated = dir.path().join("cave.stalx");
        std::fs::write(&recreated, b"db").unwrap();
        let absent_same = dir.path().join("cave.stalx");
        assert!(is_open_project_file(&absent_same, &recreated));
    }
}
