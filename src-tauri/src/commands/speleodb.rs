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
    DoneResult, Permission, PushResult, SpeleoCollaborators, SpeleoDbAction, SpeleoErrorDto,
    SpeleoLinkStatus, SpeleoLoginResult, SpeleoOpenResult, SpeleoProjectMetadata,
    SpeleoProjectMetadataPatch, SpeleoProjectSummary, SpeleoPublishParams, SpeleoPublishResult,
    SpeleoSessionStatus, SpeleoTeamOption, StartEditingResult, UpdateResult,
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

/// Take the SpeleoDB version, DISCARDING local unpushed edits (#198 "Take
/// remote"): re-pull the server tip and reset the local project to it, returning
/// the reloaded `.stalx` path so the frontend reloads the view. The frontend
/// gates this behind a second destroy-confirmation - it is the only irreversible
/// choice in the divergence prompt, so there is no single-click path to it.
#[tauri::command]
pub async fn speleodb_take_remote(app: AppHandle) -> Result<String, SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_take_remote).await
}

/// Release EVERY write lock this user currently holds (#201 "Release all"): the
/// held-lock resume prompt's resolution for locks a crashed/abandoned session
/// left behind. No-op server-side when none are held.
#[tauri::command]
pub async fn speleodb_release_all_locks(app: AppHandle) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_release_all_locks).await
}

/// Release the write lock on ONE project by id (#201 per-project "Release" in the
/// held-lock resume prompt). Targets an arbitrary held project, not necessarily
/// the open one; on success the caller re-scans to refresh the recents badges.
#[tauri::command]
pub async fn speleodb_release_lock(
    app: AppHandle,
    project_id: String,
) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_release_lock(project_id)).await
}

/// Set the open project's server-side `exclude_geojson` flag (#200
/// Enable-rendering): `PATCH /projects/{id}/`, permission-gated, no lock. Passing
/// `false` re-enables web-viewer GeoJSON, effective on the next push.
#[tauri::command]
pub async fn speleodb_set_exclude_geojson(
    app: AppHandle,
    exclude: bool,
) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_set_exclude_geojson(exclude)).await
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

/// Detach the open project from SpeleoDB, turning it into a plain unmanaged
/// `.stalx` (T2/#204): drop the `speleo_link` row and open the edit gate. Used to
/// keep a copy the server refuses us access to, or locally-edited work after a
/// divergence. Nothing is pushed or released - the managed copy is abandoned (a
/// later Open-from-SpeleoDB re-pulls the server tip). The caller typically saves
/// the project to a new path first so the user's edits land somewhere permanent.
#[tauri::command]
pub async fn speleodb_unlink(app: AppHandle) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_unlink).await
}

/// GET the open remote project's editable metadata so the Project Settings tab can
/// prefill the current server truth (#206). No lock; permission-free read.
#[tauri::command]
pub async fn speleodb_get_project_metadata(
    app: AppHandle,
) -> Result<SpeleoProjectMetadata, SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_get_project_metadata).await
}

/// PATCH the open remote project's metadata with only the changed fields (#206):
/// `PATCH /projects/{id}/`, permission-gated (READ_AND_WRITE), no lock. On a name
/// change the SDB-authoritative name is folded into the local `.stalx` without
/// dirtying. Returns the post-edit server truth.
#[tauri::command]
pub async fn speleodb_patch_project(
    app: AppHandle,
    patch: SpeleoProjectMetadataPatch,
) -> Result<SpeleoProjectMetadata, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_patch_project(patch)).await
}

/// Create the open local project on SpeleoDB and push its first revision (#207):
/// `POST /projects/` → relocate into the cache → acquire → upload → release. Returns
/// the new project id, endpoint, and cache `local_path` the frontend reloads.
#[tauri::command]
pub async fn speleodb_publish(
    app: AppHandle,
    params: SpeleoPublishParams,
) -> Result<SpeleoPublishResult, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_publish(params)).await
}

// [#215] Full Project Settings: collaborator management (per-user + per-team), in-app
// lock release, and project delete. All operate on the OPEN linked project and are
// permission-gated only in the UI; the server 401/403 is the real enforcement.

/// List the linked project's collaborator roster (individual users + teams). No
/// lock; requires READ_ONLY+ server-side.
#[tauri::command]
pub async fn speleodb_list_collaborators(
    app: AppHandle,
) -> Result<SpeleoCollaborators, SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_list_collaborators).await
}

/// Grant a collaborator (by email) a permission level on the linked project
/// (ADMIN). Returns the refreshed roster (server truth).
#[tauri::command]
pub async fn speleodb_add_collaborator(
    app: AppHandle,
    email: String,
    permission: Permission,
) -> Result<SpeleoCollaborators, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_add_collaborator(email, permission)).await
}

/// Change an existing collaborator's permission level (ADMIN).
#[tauri::command]
pub async fn speleodb_set_collaborator(
    app: AppHandle,
    email: String,
    permission: Permission,
) -> Result<SpeleoCollaborators, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_set_collaborator(email, permission)).await
}

/// Remove a collaborator from the linked project (ADMIN; soft-delete server-side).
#[tauri::command]
pub async fn speleodb_remove_collaborator(
    app: AppHandle,
    email: String,
) -> Result<SpeleoCollaborators, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_remove_collaborator(email)).await
}

/// Grant a team a permission level on the linked project (ADMIN; teams cannot hold
/// ADMIN). Returns the refreshed roster.
#[tauri::command]
pub async fn speleodb_add_team(
    app: AppHandle,
    team_id: String,
    permission: Permission,
) -> Result<SpeleoCollaborators, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_add_team(team_id, permission)).await
}

/// Change a team's permission level on the linked project (ADMIN).
#[tauri::command]
pub async fn speleodb_set_team(
    app: AppHandle,
    team_id: String,
    permission: Permission,
) -> Result<SpeleoCollaborators, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_set_team(team_id, permission)).await
}

/// Revoke a team's access to the linked project (ADMIN; soft-delete server-side).
#[tauri::command]
pub async fn speleodb_remove_team(
    app: AppHandle,
    team_id: String,
) -> Result<SpeleoCollaborators, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_remove_team(team_id)).await
}

/// List the teams the signed-in user belongs to, for the add-team picker.
#[tauri::command]
pub async fn speleodb_list_teams(app: AppHandle) -> Result<Vec<SpeleoTeamOption>, SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_list_teams).await
}

/// Release the lock on the linked project (own lock, or an ADMIN force-release of
/// another user's lock). Does not push; a recovery action for a stuck lock.
#[tauri::command]
pub async fn speleodb_release_current_lock(app: AppHandle) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_release_current_lock).await
}

/// Delete the linked project on SpeleoDB (ADMIN; soft-delete), then unlink locally
/// so the app stops treating it as remote.
#[tauri::command]
pub async fn speleodb_delete_project(app: AppHandle) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_delete_project).await
}
