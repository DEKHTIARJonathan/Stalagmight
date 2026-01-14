use serde::{Deserialize, Serialize};
use tauri::State;

use crate::core::{AppState, ValidationWarning, WarningSeverity, Validator};
use crate::models::{SectionId, ShotId, ShotData};

/// A project-level warning with reference to the source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectWarning {
    pub section_id: SectionId,
    pub shot_id: ShotId,
    pub shot_index: usize,
    pub code: String,
    pub message: String,
    pub severity: WarningSeverity,
}

/// Get all validation warnings for the current project
#[tauri::command]
pub fn get_project_warnings(state: State<AppState>) -> Vec<ProjectWarning> {
    let project = match state.project.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return Vec::new(),
    };

    let project = match project {
        Some(p) => p,
        None => return Vec::new(),
    };

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
                is_virtual: Some(shot.is_virtual),
                marker_index: shot.marker_index,
                temperature: shot.temperature,
            };

            let warnings = Validator::validate_shot(&shot_data, &config.validation, shot_index);
            for warning in warnings {
                all_warnings.push(ProjectWarning {
                    section_id: section.id,
                    shot_id: shot.id,
                    shot_index,
                    code: warning.code,
                    message: warning.message,
                    severity: warning.severity,
                });
            }
        }
    }

    // Sort by severity (errors first), then by section and shot
    all_warnings.sort_by(|a, b| {
        let severity_order = |s: &WarningSeverity| match s {
            WarningSeverity::Error => 0,
            WarningSeverity::Warning => 1,
        };
        severity_order(&a.severity)
            .cmp(&severity_order(&b.severity))
            .then_with(|| a.section_id.cmp(&b.section_id))
            .then_with(|| a.shot_index.cmp(&b.shot_index))
    });

    all_warnings
}
