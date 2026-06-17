use chrono::Utc;
use tauri::State;

use crate::core::{AppState, IntegrityCheckResult, IntegrityRepairResult};
use crate::models::{SectionId, ShotId, MULTIPLE_DATUMS_PER_MERGE_COMPONENT};
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
pub fn check_project_integrity(state: State<AppState>) -> IntegrityCheckResult {
    state.integrity_check()
}

/// Repair the open project's structural integrity, returning `{ fixed,
/// remaining }`. The project is left dirty so the user can save the repair.
/// `remaining > 0` means some issues are detect-only (drifted aligned loop
/// closures, non-finite geometry) and need manual attention.
#[tauri::command]
pub fn repair_project_integrity(state: State<AppState>) -> IntegrityRepairResult {
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
    // Over-anchoring is not ignorable (issue #57): refuse to persist a
    // suppression. Returning Ok keeps callers simple — and
    // compute_project_warnings never honors such a row regardless.
    if warning_code == MULTIPLE_DATUMS_PER_MERGE_COMPONENT {
        tracing::debug!(
            warning_code = %warning_code,
            purpose = "reject ignore of a non-ignorable warning",
            "Ignoring of over-anchoring warnings is not allowed; not persisting"
        );
        return Ok(());
    }

    // Key the suppression by the shot's stable UUID (issue #57) so it stays
    // bound to the same shot across inserts/deletes/reorders. After load every
    // shot has a UUID; None only if the shot vanished between the click and
    // here, in which case we still record the legacy position.
    let shot_uuid = state.shot_uuid_for(section_id, shot_id);
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
        shot_uuid,
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
    let shot_uuid = state.shot_uuid_for(section_id, shot_id);
    tracing::info!(
        section_id = section_id,
        shot_id = shot_id,
        warning_code = %warning_code,
        purpose = "reopen validation warning",
        "Unresolving warning"
    );
    state
        .delete_resolved_warning(section_id, shot_id, &warning_code, shot_uuid.as_deref())
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
