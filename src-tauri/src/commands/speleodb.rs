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
// [Track A] #186/D-B2: commands now return the structured SpeleoErrorDto (carrying
// the typed SpeleoDbAction) instead of a flattened String, so the FE branches on
// `err.action`. The orchestration `AppState::speleodb_*` methods build the DTO at
// the call site where the endpoint is known.
use crate::speleodb::{
    DoneResult, PushResult, SpeleoDbAction, SpeleoErrorDto, SpeleoLinkStatus, SpeleoLoginResult,
    SpeleoOpenResult, SpeleoProjectSummary, SpeleoSessionStatus, StartEditingResult, UpdateResult,
};

/// Run a blocking SpeleoDB orchestration call off the main thread. The
/// orchestration already returns the typed [`SpeleoErrorDto`]; a task panic is
/// the only error this layer originates, surfaced as a `Fatal` DTO.
async fn run_blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppState) -> Result<T, SpeleoErrorDto> + Send + 'static,
) -> Result<T, SpeleoErrorDto> {
    tauri::async_runtime::spawn_blocking(move || f(app.state::<AppState>().inner()))
        .await
        .map_err(|e| SpeleoErrorDto {
            message: format!("SpeleoDB task panicked: {e}"),
            action: SpeleoDbAction::Fatal,
            status: None,
        })?
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
) -> Result<SpeleoLoginResult, SpeleoErrorDto> {
    run_blocking(app, move |s| {
        s.speleodb_login(endpoint, email, password, token)
    })
    .await
}

/// List the projects visible to the logged-in user (display summaries).
#[tauri::command]
pub async fn speleodb_list_projects(
    app: AppHandle,
) -> Result<Vec<SpeleoProjectSummary>, SpeleoErrorDto> {
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
) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
    run_blocking(app, move |s| {
        s.speleodb_open_project(project_id, project_name, latest_commit_sha)
    })
    .await
}

/// Forget the locally stored token and clear the session (no server call).
#[tauri::command]
pub async fn speleodb_logout(app: AppHandle) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_logout).await
}

/// Acquire the write lock on the open remote project and reconcile it against the
/// server (#194). Enables editing on a clean reconcile; reports divergence,
/// contention (locked-by), or an error otherwise.
#[tauri::command]
pub async fn speleodb_start_editing(app: AppHandle) -> Result<StartEditingResult, SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_start_editing).await
}

/// Push the open project's edits (if any) and release the lock, returning to
/// read-only (#197). `message` is the commit message (a default is used when
/// blank). On divergence / an ambiguous push the lock + dirty bit are retained.
#[tauri::command]
pub async fn speleodb_done(
    app: AppHandle,
    message: Option<String>,
) -> Result<DoneResult, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_done(message)).await
}

/// Read-only refresh of the open project against the server (#197): no lock is
/// taken (UpToDate / FastForward / DivergenceNeeded).
#[tauri::command]
pub async fn speleodb_update(app: AppHandle) -> Result<UpdateResult, SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_update).await
}

/// Push the open project's edits to SpeleoDB WITHOUT releasing the lock (T2d):
/// like `speleodb_done` but the lock is retained so editing continues. `message`
/// is the commit message (a default is used when blank).
#[tauri::command]
pub async fn speleodb_push(
    app: AppHandle,
    message: Option<String>,
) -> Result<PushResult, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_push_only(message)).await
}

/// Report whether the backend already holds a usable token (and for whom). The
/// dialog calls this on open to restore the project list instead of re-prompting
/// for credentials — the in-memory token outlives the dialog's React state.
#[tauri::command]
pub async fn speleodb_session(app: AppHandle) -> Result<SpeleoSessionStatus, SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_session_status).await
}

/// Report the open project's SpeleoDB link/edit status (#204) so the action shell
/// can render the read-only/editing indicator and gate its controls. The local
/// fields are cheap; `permission`/`lock_holder` are best-effort (`None` when
/// logged out / offline). Called after every project load (and after edit-verb
/// results) to seed the frontend edit-state.
#[tauri::command]
pub async fn speleodb_link_status(app: AppHandle) -> Result<SpeleoLinkStatus, SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_link_status).await
}
