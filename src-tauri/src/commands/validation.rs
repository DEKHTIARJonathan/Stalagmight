use chrono::Utc;
use tauri::State;

use crate::core::AppState;
use crate::models::{SectionId, ShotId};
use crate::persistence::ResolvedWarning;

// Re-export ProjectWarning from models for backward compatibility
pub use crate::models::warning::ProjectWarning;

/// Get all validation warnings for the current project
#[tauri::command]
pub fn get_project_warnings(state: State<AppState>) -> Vec<ProjectWarning> {
    let project = match state.get_project_state() {
        Some(p) => p,
        None => return Vec::new(),
    };

    // Delegate to AppState method (uses self.database since project is already loaded)
    state.compute_project_warnings(&project, None)
}

/// Resolve a warning (mark it as acknowledged)
#[tauri::command]
pub fn resolve_warning(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
    warning_code: String,
    comment: Option<String>,
) -> Result<(), String> {
    let warning = ResolvedWarning {
        section_id,
        shot_id,
        warning_code,
        resolved_at: Utc::now(),
        resolved_comment: comment,
    };
    state.save_resolved_warning(&warning).map_err(|e| e.to_string())
}

/// Unresolve a warning (remove acknowledgment)
#[tauri::command]
pub fn unresolve_warning(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
    warning_code: String,
) -> Result<(), String> {
    state.delete_resolved_warning(section_id, shot_id, &warning_code).map_err(|e| e.to_string())
}
