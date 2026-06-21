//! Tauri commands for collaboration mode (Ariane `.tml` round-trip).

use tauri::State;

use crate::core::reconcile::CollabChangeSet;
use crate::core::{AppState, Command, CommandResult};
use crate::models::CollabState;

/// Enable or disable collaboration mode for the open project. The companion file
/// is always `<stalx-stem>.tml`.
#[tauri::command]
pub fn set_collab_enabled(state: State<AppState>, enabled: bool) -> CommandResult {
    state.set_collab_enabled(enabled)
}

/// Enable or disable collaboration for a project by path, without requiring it
/// to be open. Used by the recent-projects panel in the global view.
#[tauri::command]
pub fn set_collab_enabled_for_path(
    state: State<AppState>,
    path: std::path::PathBuf,
    enabled: bool,
) -> CommandResult {
    state.set_collab_enabled_for_path(path, enabled)
}

/// Current collaboration state for the open project (None if off / no project).
#[tauri::command]
pub fn get_collab_state(state: State<AppState>) -> Option<CollabState> {
    state.get_collab_state()
}

/// Preview the changes a collaborator made in the sibling `.tml`, without
/// applying them. Returns `None` when there is nothing to reconcile.
#[tauri::command]
pub fn detect_collab_changes(state: State<AppState>) -> Result<Option<CollabChangeSet>, String> {
    state.detect_collab_changes()
}

/// Apply the collaborator's changes into the project (single undoable op).
#[tauri::command]
pub fn apply_collab_changes(state: State<AppState>) -> CommandResult {
    state.execute(Command::ApplyCollabChanges)
}

/// When collaboration is OFF, the name of an existing sibling `.tml` (if any),
/// so the UI can warn the user it will not be kept in sync. `None` otherwise.
#[tauri::command]
pub fn collab_sibling_when_disabled(state: State<AppState>) -> Option<String> {
    state.collab_sibling_when_disabled()
}
