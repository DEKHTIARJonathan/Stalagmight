//! IPC command surface for the SpeleoDB read-only spike (#183).
//!
//! Thin wrappers over the `AppState::speleodb_*` orchestration (which lives in
//! `core::state::speleodb`, over the `crate::speleodb` client primitives).
//! Errors are flattened to `String` at the IPC boundary — the structured
//! status→action contract is #186. The auth token is never returned to the
//! webview (login yields only the email + keychain flag).
//!
//! Each command runs its blocking work (HTTP + OS-keychain I/O) off the main
//! thread via `spawn_blocking`: Tauri executes synchronous commands on the main
//! thread, so doing the network/keychain round-trips inline would freeze the UI.
//!
//! The full `speleodb_*` surface (push / lock / release / create / settings)
//! lands with later issues; this spike ships only login / list / open / logout.

use tauri::{AppHandle, Manager};

use crate::core::AppState;
use crate::speleodb::{
    SpeleoDbError, SpeleoLoginResult, SpeleoOpenResult, SpeleoProjectSummary, SpeleoSessionStatus,
};

/// Run a blocking SpeleoDB orchestration call off the main thread, mapping the
/// structured error to a string at the boundary.
async fn run_blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppState) -> Result<T, SpeleoDbError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(app.state::<AppState>().inner()))
        .await
        .map_err(|e| format!("SpeleoDB task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Log in to SpeleoDB. Either email+`password` (exchanged for a token) or a
/// pasted `token` must be supplied; with a pasted token the `email` is ignored
/// and derived from the API instead. `endpoint` overrides the configured/env
/// endpoint for this session. Returns the (authoritative) user email + whether
/// the token was stored in the OS keychain — never the token itself.
#[tauri::command]
pub async fn speleodb_login(
    app: AppHandle,
    endpoint: Option<String>,
    email: Option<String>,
    password: Option<String>,
    token: Option<String>,
) -> Result<SpeleoLoginResult, String> {
    run_blocking(app, move |s| {
        s.speleodb_login(endpoint, email, password, token)
    })
    .await
}

/// List the projects visible to the logged-in user (display summaries).
#[tauri::command]
pub async fn speleodb_list_projects(app: AppHandle) -> Result<Vec<SpeleoProjectSummary>, String> {
    run_blocking(app, AppState::speleodb_list_projects).await
}

/// Pull a project from SpeleoDB and extract its `.stalx` into the app cache,
/// returning the local path. The frontend then opens it via `open_project`.
///
/// [Track B] (#189, D-B9) `project_name` + `latest_commit_sha` are extra args
/// (NOT a new command name → EVENT_NAMES stays 418) used to stamp the
/// `speleo_link` row so the pulled project is `is_remote == true` end-to-end.
#[tauri::command]
pub async fn speleodb_open_project(
    app: AppHandle,
    project_id: String,
    project_name: String,
    latest_commit_sha: Option<String>,
) -> Result<SpeleoOpenResult, String> {
    run_blocking(app, move |s| {
        s.speleodb_open_project(project_id, project_name, latest_commit_sha)
    })
    .await
}

/// Forget the locally stored token and clear the session (no server call).
#[tauri::command]
pub async fn speleodb_logout(app: AppHandle) -> Result<(), String> {
    run_blocking(app, AppState::speleodb_logout).await
}

/// Report whether the backend already holds a usable token (and for whom). The
/// dialog calls this on open to restore the project list instead of re-prompting
/// for credentials — the in-memory token outlives the dialog's React state.
#[tauri::command]
pub async fn speleodb_session(app: AppHandle) -> Result<SpeleoSessionStatus, String> {
    run_blocking(app, AppState::speleodb_session_status).await
}
