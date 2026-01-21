use tauri::State;

use crate::core::{AppState, CommandResult};

/// Undo the last command
#[tauri::command]
pub fn undo(state: State<AppState>) -> CommandResult {
    undo_impl(state.inner())
}

pub(crate) fn undo_impl(state: &AppState) -> CommandResult {
    state.undo()
}

/// Redo the last undone command
#[tauri::command]
pub fn redo(state: State<AppState>) -> CommandResult {
    redo_impl(state.inner())
}

pub(crate) fn redo_impl(state: &AppState) -> CommandResult {
    state.redo()
}

/// Check if undo is available
#[tauri::command]
pub fn can_undo(state: State<AppState>) -> bool {
    can_undo_impl(state.inner())
}

pub(crate) fn can_undo_impl(state: &AppState) -> bool {
    state.can_undo()
}

/// Check if redo is available
#[tauri::command]
pub fn can_redo(state: State<AppState>) -> bool {
    can_redo_impl(state.inner())
}

pub(crate) fn can_redo_impl(state: &AppState) -> bool {
    state.can_redo()
}
