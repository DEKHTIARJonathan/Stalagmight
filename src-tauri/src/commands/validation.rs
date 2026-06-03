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

/// Structural-integrity violation messages for the open project (critical
/// first). Empty when the project is sound. The frontend uses a non-empty
/// result after load to warn the user and offer a repair.
#[tauri::command]
pub fn check_project_integrity(state: State<AppState>) -> Vec<String> {
    state.integrity_violation_messages()
}

/// Repair the open project's structural integrity, returning the number of
/// violations fixed. The project is left dirty so the user can save the repair.
#[tauri::command]
pub fn repair_project_integrity(state: State<AppState>) -> usize {
    state.repair_open_project_integrity()
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

/// Resolve all unresolved warnings at once
#[tauri::command]
pub fn resolve_all_warnings(state: State<AppState>) -> Result<u32, String> {
    resolve_all_warnings_impl(state.inner())
}

pub(crate) fn resolve_all_warnings_impl(state: &AppState) -> Result<u32, String> {
    let project = match state.get_project_state() {
        Some(p) => p,
        None => return Ok(0),
    };

    // Compute current warnings to find unresolved ones
    let warnings = state.compute_project_warnings(&project, None);
    let unresolved: Vec<_> = warnings.iter().filter(|w| !w.is_resolved).collect();
    let count = unresolved.len() as u32;

    if count == 0 {
        return Ok(0);
    }

    tracing::info!(
        count = count,
        purpose = "bulk acknowledge all validation warnings",
        "Resolving all warnings"
    );

    let now = Utc::now();
    let resolved_warnings: Vec<_> = unresolved
        .iter()
        .map(|w| ResolvedWarning {
            section_id: w.section_id,
            shot_id: w.shot_id,
            warning_code: w.code.clone(),
            resolved_at: now,
            resolved_comment: None,
        })
        .collect();

    state.save_resolved_warnings_bulk(&resolved_warnings).map_err(|e| {
        tracing::error!(
            count = count,
            purpose = "bulk acknowledge all validation warnings",
            reason = %e,
            "Failed to resolve all warnings"
        );
        e.to_string()
    })?;

    Ok(count)
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
