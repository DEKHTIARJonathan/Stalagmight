use std::path::PathBuf;
use tauri::{Manager, State};
use ts_rs::TS;

use crate::core::{AppState, Command, CommandResult};
use crate::core::loading::{CreateProjectFullResult, LoadError, LoadProjectFullResult};
use crate::models::{Project, ProjectMetadata, ProjectStats, Station};

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

    Some(ProjectState {
        project,
        stations,
        stats,
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
    // Use AppHandle to access state inside spawn_blocking
    // (State<'_, T> cannot be moved due to lifetime constraints)
    let result: Result<Result<LoadProjectFullResult, LoadError>, _> =
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            state.do_load_project_full(path)
        })
        .await;

    match result {
        Ok(Ok(load_result)) => Ok(load_result),
        Ok(Err(load_error)) => Err(load_error),
        Err(join_error) => {
            // Task panicked or was cancelled
            Err(LoadError::internal(join_error.to_string()))
        }
    }
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
/// Unlike `create_project` which creates an in-memory project, this command:
/// - Creates and persists the database file immediately
/// - Emits "loading-progress" events for UI feedback
/// - Returns the project with display settings
///
/// # Arguments
/// * `name` - Project name (used for both filename and project metadata)
/// * `location` - Optional directory path to save the project in.
///   If None, uses user's documents directory.
///   NOTE: This is a FILE SYSTEM directory path, not cave location metadata.
///   Cave location metadata can be set later via project settings.
///
/// # Technical Note
/// Uses AppHandle instead of State<'_, AppState> because Tauri's State<'_, T>
/// wraps a reference (&'r Arc<T>) that cannot outlive the function body. For spawn_blocking,
/// we need 'static ownership, which AppHandle provides via app_handle.state::<T>().
#[tauri::command]
pub async fn create_project_full(
    app_handle: tauri::AppHandle,
    name: String,
    location: Option<PathBuf>,
) -> Result<CreateProjectFullResult, LoadError> {
    // Use AppHandle to access state inside spawn_blocking
    // (State<'_, T> cannot be moved due to lifetime constraints)
    let result: Result<Result<CreateProjectFullResult, LoadError>, _> =
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            state.do_create_project_full(name, location)
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
