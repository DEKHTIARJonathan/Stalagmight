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
    get_project_warnings_impl(state.inner())
}

pub(crate) fn get_project_warnings_impl(state: &AppState) -> Vec<ProjectWarning> {
    let Some(project) = state.get_project_state() else {
        return Vec::new();
    };

    // Delegate to AppState method (uses self.database since project is already loaded)
    let warnings = state.compute_project_warnings(&project, None);
    tracing::debug!(
        count = warnings.len(),
        purpose = "surface validation issues",
        "Computed project validation warnings"
    );
    warnings
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
    resolve_warning_impl(state.inner(), section_id, shot_id, warning_code, comment)
}

pub(crate) fn resolve_warning_impl(
    state: &AppState,
    section_id: SectionId,
    shot_id: ShotId,
    warning_code: String,
    comment: Option<String>,
) -> Result<(), String> {
    tracing::info!(
        section_id = section_id,
        shot_id = shot_id,
        warning_code = %warning_code,
        purpose = "acknowledge validation warning",
        "Resolving warning"
    );
    let warning = ResolvedWarning {
        section_id,
        shot_id,
        warning_code,
        resolved_at: Utc::now(),
        resolved_comment: comment,
    };
    state.save_resolved_warning(&warning).map_err(|e| {
        tracing::error!(
            section_id = warning.section_id,
            shot_id = warning.shot_id,
            warning_code = %warning.warning_code,
            purpose = "acknowledge validation warning",
            reason = %e,
            "Failed to resolve warning"
        );
        e.to_string()
    })
}

/// Unresolve a warning (remove acknowledgment)
#[tauri::command]
pub fn unresolve_warning(
    state: State<AppState>,
    section_id: SectionId,
    shot_id: ShotId,
    warning_code: String,
) -> Result<(), String> {
    unresolve_warning_impl(state.inner(), section_id, shot_id, warning_code)
}

pub(crate) fn unresolve_warning_impl(
    state: &AppState,
    section_id: SectionId,
    shot_id: ShotId,
    warning_code: String,
) -> Result<(), String> {
    tracing::info!(
        section_id = section_id,
        shot_id = shot_id,
        warning_code = %warning_code,
        purpose = "reopen validation warning",
        "Unresolving warning"
    );
    state
        .delete_resolved_warning(section_id, shot_id, &warning_code)
        .map_err(|e| {
            tracing::error!(
                section_id = section_id,
                shot_id = shot_id,
                warning_code = %warning_code,
                purpose = "reopen validation warning",
                reason = %e,
                "Failed to unresolve warning"
            );
            e.to_string()
        })
}
