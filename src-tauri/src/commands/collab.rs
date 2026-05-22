//! Tauri commands for collaboration mode (Ariane `.tml` round-trip).

use tauri::State;

use crate::core::reconcile::CollabChangeSet;
use crate::core::{AppState, Command, CommandResult};
use crate::models::CollabState;

/// Enable or disable collaboration mode for the open project. When enabling,
/// `sibling_tml_relative` overrides the default (`<stalx-stem>.tml`).
#[tauri::command]
pub fn set_collab_enabled(
    state: State<AppState>,
    enabled: bool,
    sibling_tml_relative: Option<String>,
) -> CommandResult {
    state.set_collab_enabled(enabled, sibling_tml_relative)
}

/// Current collaboration state for the open project (None if off / no project).
#[tauri::command]
pub fn get_collab_state(state: State<AppState>) -> Option<CollabState> {
    state.get_collab_state()
}

/// Preview the changes a collaborator made in the sibling `.tml`, without
/// applying them. Returns `None` when there is nothing to reconcile.
#[tauri::command]
pub fn detect_collab_changes(
    state: State<AppState>,
) -> Result<Option<CollabChangeSet>, String> {
    state.detect_collab_changes()
}

/// Apply the collaborator's changes into the project (single undoable op).
#[tauri::command]
pub fn apply_collab_changes(state: State<AppState>) -> CommandResult {
    state.execute(Command::ApplyCollabChanges)
}
