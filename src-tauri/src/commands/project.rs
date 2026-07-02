use std::path::PathBuf;
use tauri::{Manager, State};
use ts_rs::TS;

use crate::core::loading::{CreateProjectFullResult, LoadError, LoadProjectFullResult};
use crate::core::{AppState, Command, CommandResult};
use crate::models::{
    AlongLineResult, DistanceField, FrozenShotRef, Project, ProjectMetadata, ProjectStats,
    RulerEndpoint, Station, StationRef,
};

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

/// Update per-project settings (#57): project name + validation thresholds.
/// Stored in the .stalx so they travel with the file between collaborators.
#[tauri::command]
pub fn update_project_settings(
    state: State<AppState>,
    name: String,
    validation: crate::config::ValidationConfig,
) -> CommandResult {
    state.update_project_settings(name, validation)
}

/// Open an existing project
#[tauri::command]
pub fn open_project(state: State<AppState>, path: PathBuf) -> CommandResult {
    open_project_impl(state.inner(), path)
}

pub(crate) fn open_project_impl(state: &AppState, path: PathBuf) -> CommandResult {
    state.execute(Command::OpenProject { path })
}

/// Save the current project.
///
/// `is_autosave` is honoured by the collab-sibling write path: when
/// `true` and the project's `CollabState.write_tml_on_autosave` is
/// `false`, the sibling `.tml` is skipped so autosave doesn't churn
/// the file Ariane is editing.  Defaults to `false` so existing
/// frontend callers that don't supply the field get manual-save
/// semantics (always write the `.tml`).
#[tauri::command]
pub fn save_project(
    state: State<AppState>,
    path: Option<PathBuf>,
    is_autosave: Option<bool>,
) -> CommandResult {
    save_project_impl(state.inner(), path, is_autosave.unwrap_or(false))
}

pub(crate) fn save_project_impl(
    state: &AppState,
    path: Option<PathBuf>,
    is_autosave: bool,
) -> CommandResult {
    state.execute(Command::SaveProject { path, is_autosave })
}

/// Close the current project. `release_lock` (default `true`) best-effort releases
/// a held SpeleoDB write lock first so a close doesn't strand the server mutex
/// (fix 1); the close dialog's "Keep lock" path passes `false`.
#[tauri::command]
pub fn close_project(state: State<AppState>, release_lock: Option<bool>) -> CommandResult {
    close_project_impl(state.inner(), release_lock.unwrap_or(true))
}

pub(crate) fn close_project_impl(state: &AppState, release_lock: bool) -> CommandResult {
    // Release a held SpeleoDB lock BEFORE the close tears down the database (the
    // link row lives there). Best-effort + gated so the keep-lock path can opt out.
    if release_lock {
        state.speleodb_release_held_lock_best_effort();
    }
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

/// Per-station along-cave distance from a chosen origin station, or from the
/// zero-datum entrance(s) when `from` is null — backs the distance-gradient
/// overlay (#34). Distances are computed on the **closure-adjusted** geometry so
/// they match the corrected map (falls back to measured when there are no
/// eligible closures). `distances` are index-aligned with `station_refs`; `null`
/// entries are unreachable, and `max_reachable` scales the legend.
///
/// Async + `spawn_blocking` (mirrors `get_adjusted_stations`): the adjusted-coord
/// solve is memoized in `AppState`, and we keep the heavy work off the UI thread.
#[tauri::command]
pub async fn get_station_distances_from(
    app_handle: tauri::AppHandle,
    from: Option<StationRef>,
) -> Option<DistanceField> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        // AppState::distance_field takes one reconciled snapshot so topology and
        // adjusted coords are consistent (no two-read skew).
        state.inner().distance_field(from.as_ref())
    })
    .await
    .ok()
    .flatten()
}

/// Along-cave-line distance between two ruler endpoints (#26): the shortest path
/// through the survey graph (shots weighted by measured length; merges and loop
/// closures zero-cost), plus the ordered shots traversed so the frontend can
/// tint them. Each endpoint is a station or an exact point on a shot. Returns
/// `along_line: null` when the endpoints are in different connected components.
#[tauri::command]
pub async fn get_along_line_distance(
    app_handle: tauri::AppHandle,
    a: RulerEndpoint,
    b: RulerEndpoint,
) -> Option<AlongLineResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        state.inner().along_line_between(a, b)
    })
    .await
    .ok()
    .flatten()
}

/// Get closure-adjusted station coordinates for the current project.
///
/// This is the lazy counterpart to [`get_project_state`], whose `stations` are
/// always the raw *measured* geometry. The frontend calls this only when the
/// user switches the display to the closure-adjusted view. The adjustment is
/// derived non-destructively (the measured project is never mutated) and the
/// result is memoized in [`AppState`], so the heavy solve runs at most once per
/// data/config version. Runs on a blocking thread to keep the UI responsive on
/// large surveys.
///
/// Returns the measured coordinates verbatim when there are no eligible
/// closures, and an empty vec when no project is open.
#[tauri::command]
pub async fn get_adjusted_stations(app_handle: tauri::AppHandle) -> Vec<Station> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        state.inner().get_adjusted_stations().unwrap_or_default()
    })
    .await
    .unwrap_or_default()
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

pub(crate) fn remove_from_recent_projects_impl(state: &AppState, path: PathBuf) -> CommandResult {
    state.remove_from_recent_projects(path)
}

/// Permanently delete a project's files from disk and drop it from the recent
/// list. The destructive counterpart to `remove_from_recent_projects`; see
/// [`AppState::delete_project`] for the OS-trash / permanent-delete semantics.
#[tauri::command]
pub fn delete_project(
    state: State<AppState>,
    path: PathBuf,
    delete_collab_sibling: bool,
) -> CommandResult {
    delete_project_impl(state.inner(), path, delete_collab_sibling)
}

pub(crate) fn delete_project_impl(
    state: &AppState,
    path: PathBuf,
    delete_collab_sibling: bool,
) -> CommandResult {
    state.delete_project(path, delete_collab_sibling)
}

/// Rename a recent project's display name by path (project need not be open).
#[tauri::command]
pub fn set_project_name_for_path(
    state: State<AppState>,
    path: PathBuf,
    name: String,
) -> CommandResult {
    state.set_project_name_for_path(path, name)
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
    merge_projects_impl(
        state.inner(),
        source_paths,
        output_path,
        output_name,
        archive_originals,
    )
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
    /// Serialized through [`ProjectIpc`] so cross-references reach the frontend
    /// in positional wire form (the ts-rs `Project` shape), not the internal
    /// `StationKey` shape that derived serde would emit. ts-rs still reads the
    /// field type (`Project`) for the generated binding, so the TS contract is
    /// unchanged; only the runtime serde payload is corrected.
    #[serde(serialize_with = "crate::models::project::serialize_project_ipc")]
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
