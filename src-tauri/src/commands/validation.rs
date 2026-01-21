use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

use crate::core::{AppState, WarningSeverity, Validator};
use crate::models::{SectionId, ShotId, ShotData};
use crate::persistence::ResolvedWarning;

/// A project-level warning with reference to the source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectWarning {
    pub section_id: SectionId,
    pub shot_id: ShotId,
    pub shot_index: usize,
    pub code: String,
    pub message: String,
    pub severity: WarningSeverity,
    pub is_resolved: bool,
}

/// Get all validation warnings for the current project
#[tauri::command]
pub fn get_project_warnings(state: State<AppState>) -> Vec<ProjectWarning> {
    get_project_warnings_impl(state.inner())
}

pub(crate) fn get_project_warnings_impl(state: &AppState) -> Vec<ProjectWarning> {
    let project = match state.get_project_state() {
        Some(p) => p,
        None => return Vec::new(),
    };

    // Load resolved warnings from database
    let resolved_set: HashSet<String> = state.load_resolved_warnings()
        .unwrap_or_default()
        .iter()
        .map(|r| format!("{}:{}:{}", r.section_id, r.shot_id, r.warning_code))
        .collect();

    let config = state.get_config();
    let mut all_warnings = Vec::new();

    for section in &project.sections {
        for (shot_index, shot) in section.shots.iter().enumerate() {
            // Convert Shot to ShotData for validation
            let shot_data = ShotData {
                azimuth_in: shot.azimuth_in,
                azimuth_out: shot.azimuth_out,
                length: shot.length,
                depth_in: shot.depth_in,
                depth_out: shot.depth_out,
                pitch_in: shot.pitch_in,
                pitch_out: shot.pitch_out,
                left: shot.left,
                right: shot.right,
                up: shot.up,
                down: shot.down,
                comment: shot.comment.clone(),
                is_virtual: shot.is_virtual,
                marker_index: shot.marker_index,
                temperature: shot.temperature,
            };

            let warnings = Validator::validate_shot(&shot_data, &config.validation, shot_index);
            for warning in warnings {
                let key = format!("{}:{}:{}", section.id, shot.id, warning.code);
                let is_resolved = resolved_set.contains(&key);
                all_warnings.push(ProjectWarning {
                    section_id: section.id,
                    shot_id: shot.id,
                    shot_index,
                    code: warning.code,
                    message: warning.message,
                    severity: warning.severity,
                    is_resolved,
                });
            }
        }
    }

    // Sort by resolved (unresolved first), then severity (errors first), then by section and shot
    all_warnings.sort_by(|a, b| {
        let resolved_order = |r: bool| if r { 1 } else { 0 };
        let severity_order = |s: &WarningSeverity| match s {
            WarningSeverity::Error => 0,
            WarningSeverity::Warning => 1,
        };
        resolved_order(a.is_resolved)
            .cmp(&resolved_order(b.is_resolved))
            .then_with(|| severity_order(&a.severity).cmp(&severity_order(&b.severity)))
            .then_with(|| a.section_id.cmp(&b.section_id))
            .then_with(|| a.shot_index.cmp(&b.shot_index))
    });

    all_warnings
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
    unresolve_warning_impl(state.inner(), section_id, shot_id, warning_code)
}

pub(crate) fn unresolve_warning_impl(
    state: &AppState,
    section_id: SectionId,
    shot_id: ShotId,
    warning_code: String,
) -> Result<(), String> {
    state.delete_resolved_warning(section_id, shot_id, &warning_code).map_err(|e| e.to_string())
}
