//! IPC command surface for the SpeleoDB integration (#182 epic).
//!
//! Thin wrappers over the `AppState::speleodb_*` orchestration (which lives in
//! `core::state::speleodb`, over the `crate::speleodb` client primitives). The
//! full surface is here: session (login / logout / session), pull (list / open /
//! adopt), the lock + edit gate (start-editing / force-edit / done / push /
//! update / take-remote / the release verbs), link status + unlink, revision
//! history and restore, and project admin (metadata / publish / collaborators /
//! teams / delete).
//!
//! Errors cross the boundary as the structured [`SpeleoErrorDto`] (#186), which
//! carries the typed [`SpeleoDbAction`] the frontend branches on - not a
//! flattened `String`. The auth token is never returned to the webview (login
//! yields only the email + keychain flag).
//!
//! Each command runs its blocking work (HTTP + OS-keychain I/O) off the main
//! thread via `spawn_blocking`: Tauri executes synchronous commands on the main
//! thread, so doing the network/keychain round-trips inline would freeze the UI.

use std::collections::HashMap;

use tauri::{AppHandle, Manager};

use crate::core::AppState;
// [Track A] #186/D-B2: commands now return the structured SpeleoErrorDto (carrying
// the typed SpeleoDbAction) instead of a flattened String, so the FE branches on
// `err.action`. The orchestration `AppState::speleodb_*` methods build the DTO at
// the call site where the endpoint is known.
use crate::speleodb::{
    DoneResult, Permission, PushResult, SpeleoAdoptResult, SpeleoCollaborators, SpeleoDbAction,
    SpeleoErrorDto, SpeleoLinkStatus, SpeleoLocalProjectState, SpeleoLoginResult, SpeleoOpenResult,
    SpeleoProjectMetadata, SpeleoProjectMetadataPatch, SpeleoProjectSummary, SpeleoPublishParams,
    SpeleoPublishResult, SpeleoRevision, SpeleoSessionStatus, SpeleoTeamOption,
    SpeleoUserSuggestion, StartEditingResult, UpdateResult,
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
            transport: None,
            unpushed_local: None,
        })?
}

/// Log in to SpeleoDB. Either email+`password` (exchanged for a token) or a
/// pasted `token` must be supplied; with a pasted token the `email` is ignored
/// and derived from the API instead. `endpoint` overrides the configured/env
/// endpoint for this session. Returns the (authoritative) user email + whether
/// the token was stored in the OS keychain - never the token itself.
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

/// Pull a project from SpeleoDB over a local copy that still holds UN-PUSHED
/// EDITS, destroying them. The "take remote and discard local" branch of the
/// prompt raised when [`speleodb_open_project`] refuses with
/// `SpeleoDbAction::UnpushedLocalEdits`; call it with the same arguments the
/// refused open was given, and only after the user has confirmed the loss.
///
/// The other branch, "keep local", calls NO SpeleoDB command: it opens the
/// `local_path` carried on the refusal through the normal `load_project_full`
/// flow, so nothing is downloaded and nothing is overwritten.
///
/// A separate command rather than a flag on [`speleodb_open_project`], for the
/// same reason `speleodb_take_remote` is its own verb: the irreversible pull must
/// be spelled out at the call site.
#[tauri::command]
pub async fn speleodb_open_project_discarding_local(
    app: AppHandle,
    project_id: String,
    project_name: String,
    latest_commit_sha: Option<String>,
) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
    run_blocking(app, move |s| {
        s.speleodb_open_project_discarding_local(project_id, project_name, latest_commit_sha)
    })
    .await
}

/// [#214] Adopt an Ariane (`.tml`-only) project: import its `ariane.tml`, save a
/// new `.stalx` into the cache, link it, and best-effort flip the server `type`
/// ariane→other. The frontend calls this (after a user confirm) when
/// `speleodb_open_project` reported `SpeleoDbAction::Adopt`, then reloads
/// `local_path` through the normal `open_project` flow (read-only-remote).
#[tauri::command]
pub async fn speleodb_adopt_ariane(
    app: AppHandle,
    project_id: String,
    project_name: String,
    latest_commit_sha: Option<String>,
) -> Result<SpeleoAdoptResult, SpeleoErrorDto> {
    run_blocking(app, move |s| {
        s.speleodb_adopt_ariane(project_id, project_name, latest_commit_sha)
    })
    .await
}

/// Forget the locally stored token, clear the session, and clear the persisted
/// account email (no server call). #270: an `Err` here does NOT mean the logout
/// failed - the session is always dropped; it means the credential could not be
/// removed from the OS keychain / plaintext store, so the frontend warns (and can
/// offer a retry) while treating the user as logged out.
#[tauri::command]
pub async fn speleodb_logout(app: AppHandle) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_logout).await
}

/// [#213] Enable optimistic force-edit: edit the open remote project WITHOUT the
/// server write lock (offline / contended), behind the FE's big-red warning. Opt-in
/// (gated on the `allow_force_edit` config). No acquire, no network, BASE unchanged;
/// the user later reconnects via `speleodb_start_editing`.
#[tauri::command]
pub async fn speleodb_force_edit(app: AppHandle) -> Result<(), SpeleoErrorDto> {
    run_blocking(app, AppState::speleodb_force_edit).await
}

/// Acquire the write lock on the open remote project and reconcile it against the
/// server (#194). Enables editing on a clean reconcile; reports divergence,
/// contention (locked-by), or an error otherwise. [#213] Also serves as the
/// force-edit "reconnect".
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

/// Per-project LOCAL state for a set of SpeleoDB projects: whether this machine
/// has a readable local copy and whether that copy has un-pushed edits. Joins the
/// local half onto the server-only scans (the held-lock resume prompt, the
/// GlobalView remote list), so the UI can offer "push and release" rather than a
/// bare "release" - and can say which listed projects are even present here.
///
/// `project_ids` limits the reply to those ids (each still gets a row, reporting
/// "nothing here" when absent); omitting it reports every project in the local
/// pull cache plus the open one. Keyed by project id for direct indexing. Purely
/// local: no token, no network, and an unreadable file costs only its own row.
#[tauri::command]
pub async fn speleodb_local_project_states(
    app: AppHandle,
    project_ids: Option<Vec<String>>,
) -> Result<HashMap<String, SpeleoLocalProjectState>, SpeleoErrorDto> {
    run_blocking(app, move |s| {
        Ok(s.speleodb_local_project_states(project_ids))
    })
    .await
}

/// [#218] Read a project's revision history for the Project Settings history view:
/// `GET /projects/{id}/revisions/`. Returns the commit chain projected to
/// [`SpeleoRevision`] DTOs. Permission-free read; no lock required.
#[tauri::command]
pub async fn speleodb_get_revisions(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<SpeleoRevision>, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_get_revisions(project_id)).await
}

/// [#218] Check the open remote project's working copy out to a past revision:
/// download the dump AT `hexsha`, replace the working copy, and reopen it. With
/// `restore == true` (the user holds the lock) it is stamped as an unpushed edit on
/// top of the current server HEAD (a git-forward restore; the user pushes to
/// persist); with `restore == false` it is a read-only View that a later Update
/// fast-forwards away. Returns the local path for the FE to refresh from.
///
/// `discard_local` waives the un-pushed-edits guard, and the FE may pass `true`
/// ONLY after a second, explicit confirmation naming what is being discarded. It
/// exists because a restore itself stamps the working copy as un-pushed, so without
/// it Restore was single-use: restoring a second revision refused over edits the
/// first restore had just created.
#[tauri::command]
pub async fn speleodb_restore_revision(
    app: AppHandle,
    project_id: String,
    project_name: String,
    hexsha: String,
    restore: bool,
    discard_local: Option<bool>,
) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
    let discard_local = discard_local.unwrap_or(false);
    run_blocking(app, move |s| {
        s.speleodb_restore_revision(project_id, project_name, hexsha, restore, discard_local)
    })
    .await
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
/// for credentials - the in-memory token outlives the dialog's React state.
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

/// Autocomplete users by email/name substring for the add-collaborator typeahead.
/// Returns [] below the server's 3-char minimum.
#[tauri::command]
pub async fn speleodb_search_users(
    app: AppHandle,
    query: String,
) -> Result<Vec<SpeleoUserSuggestion>, SpeleoErrorDto> {
    run_blocking(app, move |s| s.speleodb_search_users(query)).await
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
