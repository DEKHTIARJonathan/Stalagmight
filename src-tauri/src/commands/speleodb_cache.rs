//! IPC for the SpeleoDB copies cached on this machine: the home screen's listing
//! (with each copy's owner relative to the signed-in account), removing one copy,
//! and Settings' "Purge all cached files".
//!
//! All three are purely local (no token, no network), but walk and delete files, so
//! they run off the main thread like every other file operation.

use tauri::{AppHandle, Manager};

use crate::core::state::{SpeleoCachedProject, SpeleoPurgeReport};
use crate::core::{AppState, CommandResult};

/// Every cached SpeleoDB copy, classified against the current session. The home
/// screen lists the ones whose `ownership` is not `other_account`.
#[tauri::command]
pub async fn speleodb_cached_projects(app: AppHandle) -> Vec<SpeleoCachedProject> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().inner().speleodb_cached_projects()
    })
    .await
    .unwrap_or_default()
}

/// Remove one cached copy (not the open project). `discard_unpushed` is the user's
/// explicit consent to lose edits that were never uploaded; without it such a copy
/// is refused.
#[tauri::command]
pub async fn speleodb_remove_cached_copy(
    app: AppHandle,
    project_id: String,
    discard_unpushed: bool,
) -> CommandResult {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .inner()
            .speleodb_remove_cached_copy(&project_id, discard_unpushed)
    })
    .await
    .unwrap_or_else(|e| CommandResult::failure(format!("Removing the copy failed: {e}")))
}

/// Remove every cached copy except the open one, keeping copies with un-uploaded
/// (or unreadable) work unless `discard_unpushed` carries the user's consent.
#[tauri::command]
pub async fn speleodb_purge_cached_copies(
    app: AppHandle,
    discard_unpushed: bool,
) -> SpeleoPurgeReport {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .inner()
            .speleodb_purge_cached_copies(discard_unpushed)
    })
    .await
    .unwrap_or_else(|e| SpeleoPurgeReport {
        failed: vec![format!("The purge stopped unexpectedly: {e}")],
        ..SpeleoPurgeReport::default()
    })
}
