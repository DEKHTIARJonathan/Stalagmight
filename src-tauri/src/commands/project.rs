use std::path::PathBuf;
use tauri::{Manager, State};
use ts_rs::TS;

use crate::core::{AppState, Command, CommandResult};
use crate::core::loading::{CreateProjectFullResult, LoadError, LoadProjectFullResult};
use crate::models::{FrozenShotRef, Project, ProjectMetadata, ProjectStats, Station};

/// Create a new in-memory project (no database file created).
///
/// This is the legacy/quick-create path for creating an unsaved project.
/// The project exists only in memory until explicitly saved with `save_project`.
///
/// # Arguments
/// * `name` - Project name
/// * `location` - Optional cave location metadata (e.g., "Blue Spring Cave System")
///
/// For creating a persisted project with progress events, use `create_project_full` instead.
#[tauri::command]
pub fn create_project(
    state: State<AppState>,
    name: String,
    location: Option<String>,
) -> CommandResult {
    create_project_impl(state.inner(), name, location)
}

pub(crate) fn create_project_impl(
    state: &AppState,
    name: String,
    location: Option<String>,
) -> CommandResult {
    state.execute(Command::CreateProject { name, location })
}

/// Open an existing project
#[tauri::command]
pub fn open_project(state: State<AppState>, path: PathBuf) -> CommandResult {
    open_project_impl(state.inner(), path)
}

pub(crate) fn open_project_impl(state: &AppState, path: PathBuf) -> CommandResult {
    state.execute(Command::OpenProject { path })
}

/// Save the current project
#[tauri::command]
pub fn save_project(state: State<AppState>, path: Option<PathBuf>) -> CommandResult {
    save_project_impl(state.inner(), path)
}

pub(crate) fn save_project_impl(state: &AppState, path: Option<PathBuf>) -> CommandResult {
    state.execute(Command::SaveProject { path })
}

/// Close the current project
#[tauri::command]
pub fn close_project(state: State<AppState>) -> CommandResult {
    close_project_impl(state.inner())
}

pub(crate) fn close_project_impl(state: &AppState) -> CommandResult {
    state.execute(Command::CloseProject)
}

/// Get the full project state for the frontend
#[tauri::command]
pub fn get_project_state(state: State<AppState>) -> Option<ProjectState> {
    get_project_state_impl(state.inner())
}

pub(crate) fn get_project_state_impl(state: &AppState) -> Option<ProjectState> {
    let project = state.get_project_state()?;
    let stations = project.compute_station_coordinates();
    let mut stats = project.stats();

    // Calculate penetration distance with computed stations
    stats.penetration_distance = project.calculate_penetration(&stations);

    let frozen_shots = project.compute_frozen_shots();

    Some(ProjectState {
        project,
        stations,
        stats,
        frozen_shots,
    })
}

/// Get list of recent projects
#[tauri::command]
pub fn list_recent_projects(state: State<AppState>) -> Vec<ProjectMetadata> {
    list_recent_projects_impl(state.inner())
}

pub(crate) fn list_recent_projects_impl(state: &AppState) -> Vec<ProjectMetadata> {
    state.get_recent_projects()
}

/// Remove a project from the recent projects list
#[tauri::command]
pub fn remove_from_recent_projects(state: State<AppState>, path: PathBuf) -> CommandResult {
    remove_from_recent_projects_impl(state.inner(), path)
}

pub(crate) fn remove_from_recent_projects_impl(
    state: &AppState,
    path: PathBuf,
) -> CommandResult {
    state.remove_from_recent_projects(path)
}

/// Merge multiple projects into a new project file
/// This creates a NEW output file, appends all sections with renumbered IDs,
/// keeps all zero datums, and optionally archives the original files.
#[tauri::command]
pub fn merge_projects(
    state: State<AppState>,
    source_paths: Vec<PathBuf>,
    output_path: PathBuf,
    output_name: String,
    archive_originals: bool,
) -> CommandResult {
    merge_projects_impl(state.inner(), source_paths, output_path, output_name, archive_originals)
}

pub(crate) fn merge_projects_impl(
    state: &AppState,
    source_paths: Vec<PathBuf>,
    output_path: PathBuf,
    output_name: String,
    archive_originals: bool,
) -> CommandResult {
    state.execute(Command::MergeProjects {
        source_paths,
        output_path,
        output_name,
        archive_originals,
    })
}

/// Combined project state for frontend
#[derive(serde::Serialize, TS)]
pub struct ProjectState {
    pub project: Project,
    pub stations: Vec<Station>,
    pub stats: ProjectStats,
    pub frozen_shots: Vec<FrozenShotRef>,
}

/// Load project with full progress reporting.
/// Uses spawn_blocking for UI responsiveness during computation phases.
///
/// Returns LoadProjectFullResult containing project, stations, stats, warnings, and display settings.
/// Emits "loading-progress" events during load for progress UI.
///
/// Note: Uses AppHandle instead of State<'_, AppState> because Tauri's State<'_, T>
/// wraps a reference (&'r Arc<T>) that cannot outlive the function body. For spawn_blocking,
/// we need 'static ownership, which AppHandle provides via app_handle.state::<T>().
#[tauri::command]
pub async fn load_project_full(
    app_handle: tauri::AppHandle,
    path: PathBuf,
) -> Result<LoadProjectFullResult, LoadError> {
    // [perf-debug] Log when the Rust handler is about to return so we can
    // subtract that from the JS-side IPC wait time and isolate IPC
    // transport + JS JSON.parse. The "load_project_full handler returning"
    // line lets us compute: js_total - rust_total ≈ serialize + parse.
    let t_start = std::time::Instant::now();
    let result: Result<Result<LoadProjectFullResult, LoadError>, _> =
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            state.do_load_project_full(path)
        })
        .await;
    let handler_elapsed = t_start.elapsed();

    let mapped = match result {
        Ok(Ok(load_result)) => Ok(load_result),
        Ok(Err(load_error)) => Err(load_error),
        Err(join_error) => Err(LoadError::internal(join_error.to_string())),
    };
    tracing::debug!(
        handler_ms = handler_elapsed.as_millis() as u64,
        ok = mapped.is_ok(),
        "load_project_full handler returning (serialize+transport+JSON.parse begins now)"
    );
    mapped
}

/// Binary variant of `load_project_full` that returns a msgpack-encoded
/// payload with shot/station bulk data packed into typed-array byte buffers.
///
/// Replaces ~25 MB of JSON with ~7 MB of binary on a 75k-shot project, and
/// removes the synchronous `serde_json::to_string` + `JSON.parse` cost from
/// both threads. See [`crate::core::load_binary`] for the wire format. The
/// JSON variant is kept for back-compat and tests; new callers should use
/// this one.
#[tauri::command]
pub async fn load_project_full_binary(
    app_handle: tauri::AppHandle,
    path: PathBuf,
) -> Result<tauri::ipc::Response, LoadError> {
    let t_start = std::time::Instant::now();
    let result: Result<Result<LoadProjectFullResult, LoadError>, _> =
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            state.do_load_project_full(path)
        })
        .await;
    let handler_elapsed = t_start.elapsed();

    let load_result = match result {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(e),
        Err(join_err) => return Err(LoadError::internal(join_err.to_string())),
    };

    let encode_start = std::time::Instant::now();
    let bytes = crate::core::load_binary::encode(load_result)
        .map_err(|e| LoadError::internal(format!("encode binary: {e}")))?;
    let encode_elapsed = encode_start.elapsed();

    tracing::debug!(
        handler_ms = handler_elapsed.as_millis() as u64,
        encode_ms = encode_elapsed.as_millis() as u64,
        bytes = bytes.len(),
        "load_project_full_binary returning"
    );

    Ok(tauri::ipc::Response::new(bytes))
}

/// Cancel any active loading operation.
/// Idempotent - safe to call anytime, even when no load is active.
#[tauri::command]
pub fn cancel_loading(state: State<AppState>) {
    state.cancel_loading();
}

/// Create a persisted project with full progress reporting.
///
/// This creates a new project database file immediately, emitting progress events
/// during creation phases (CreatingDatabase, InitializingProject, SavingSettings).
///
/// Unlike `create_project`, this command supports assigning a canonical save path
/// during project creation and can optionally defer the initial disk write.
/// It:
/// - Emits "loading-progress" events for UI feedback
/// - Returns the project with display settings
/// - Persists immediately unless `defer_initial_save` is true
///
/// # Arguments
/// * `name` - Project name (used for both filename and project metadata)
/// * `project_location` - Optional cave location metadata (free text).
/// * `save_directory` - Optional directory path to save the project in.
///   If omitted (and `save_path` is also omitted), uses user's documents
///   `stalagmight` subdirectory.
/// * `save_path` - Optional full file path to save the project to.
///   If provided, this takes precedence over `save_directory`.
/// * `defer_initial_save` - Optional flag to reserve `project.file_path` without
///   writing the file yet. First save/autosave creates the file.
///
/// # Technical Note
/// Uses AppHandle instead of State<'_, AppState> because Tauri's State<'_, T>
/// wraps a reference (&'r Arc<T>) that cannot outlive the function body. For spawn_blocking,
/// we need 'static ownership, which AppHandle provides via app_handle.state::<T>().
#[tauri::command]
pub async fn create_project_full(
    app_handle: tauri::AppHandle,
    name: String,
    project_location: Option<String>,
    save_directory: Option<PathBuf>,
    save_path: Option<PathBuf>,
    defer_initial_save: Option<bool>,
) -> Result<CreateProjectFullResult, LoadError> {
    // Use AppHandle to access state inside spawn_blocking
    // (State<'_, T> cannot be moved due to lifetime constraints)
    let result: Result<Result<CreateProjectFullResult, LoadError>, _> =
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            state.do_create_project_full(
                name,
                project_location,
                save_directory,
                save_path,
                defer_initial_save.unwrap_or(false),
            )
        })
        .await;

    match result {
        Ok(Ok(create_result)) => Ok(create_result),
        Ok(Err(load_error)) => Err(load_error),
        Err(join_error) => {
            // Task panicked or was cancelled
            Err(LoadError::internal(join_error.to_string()))
        }
    }
}
