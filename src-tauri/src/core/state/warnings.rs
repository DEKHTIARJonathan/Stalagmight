use anyhow::Result;
use std::collections::HashSet;

use crate::core::{Validator, WarningSeverity};
use crate::models::{Project, ProjectWarning, ShotData};
use crate::persistence::Database;

use super::AppState;

impl AppState {
    /// Compute project warnings from the given project.
    /// Used by both get_project_warnings command and load_project_full for validation phase.
    ///
    /// If `db` is provided, uses it for resolved warnings lookup (for pre-finalization loading).
    /// Otherwise falls back to self.database (normal operation after project is loaded).
    pub fn compute_project_warnings(
        &self,
        project: &Project,
        db: Option<&Database>,
    ) -> Vec<ProjectWarning> {
        // Load resolved warnings from database
        let resolved_set: HashSet<String> = if let Some(db) = db {
            // Use provided database reference (pre-finalization)
            db.load_resolved_warnings()
                .unwrap_or_default()
                .iter()
                .map(|r| format!("{}:{}:{}", r.section_id, r.shot_id, r.warning_code))
                .collect()
        } else {
            // Fall back to self.database (post-finalization)
            self.load_resolved_warnings()
                .unwrap_or_default()
                .iter()
                .map(|r| format!("{}:{}:{}", r.section_id, r.shot_id, r.warning_code))
                .collect()
        };

        let config = self.get_config();
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
                    is_reference: shot.is_reference,
                    marker_index: shot.marker_index,
                    temperature: shot.temperature,
                };

                let warnings = Validator::validate_shot(&shot_data, &config.validation, section.id, shot_index);
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

        // Project-level: two or more zero datums in one merge-connected component
        // over-constrain the rigid group, so the offset cascade tears a merge edge
        // apart. Surface one warning on each datum's adjacent shot so it appears in
        // the table next to the offending anchor. (Per-shot ProjectWarning shape:
        // anchor station 0 -> shot 0; station i -> shot i-1.)
        for component in project.over_anchored_merge_components() {
            for datum in &component {
                let Some(section) = project.get_section(datum.section_id) else {
                    continue;
                };
                let shot_index = if datum.station_index == 0 {
                    0
                } else {
                    (datum.station_index - 1) as usize
                };
                let Some(shot) = section.shots.get(shot_index) else {
                    continue;
                };
                let others = component
                    .iter()
                    .filter(|other| *other != datum)
                    .map(|other| format!("{}:{}", other.section_id, other.station_index))
                    .collect::<Vec<_>>()
                    .join(", ");
                let code = "multiple_datums_per_merge_component".to_string();
                let key = format!("{}:{}:{}", section.id, shot.id, code);
                let is_resolved = resolved_set.contains(&key);
                all_warnings.push(ProjectWarning {
                    section_id: section.id,
                    shot_id: shot.id,
                    shot_index,
                    message: format!(
                        "Station {}:{} has a zero datum, but its merge group is also anchored at {others}. Two GPS anchors over-constrain one rigid group; remove all but one zero datum.",
                        datum.section_id, datum.station_index
                    ),
                    code,
                    severity: WarningSeverity::Warning,
                    is_resolved,
                });
            }
        }

        // Sort by resolved (unresolved first), then severity (errors first), then by section and shot
        all_warnings.sort_by(|a, b| {
            let resolved_order = |r: bool| i32::from(r);
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

    /// Load resolved warnings from database
    pub fn load_resolved_warnings(&self) -> Result<Vec<crate::persistence::ResolvedWarning>> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.load_resolved_warnings()
    }

    /// Save a resolved warning to database
    pub fn save_resolved_warning(&self, warning: &crate::persistence::ResolvedWarning) -> Result<()> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.save_resolved_warning(warning)
    }

    /// Delete a resolved warning from database
    pub fn delete_resolved_warning(&self, section_id: u32, shot_id: u32, warning_code: &str) -> Result<()> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.delete_resolved_warning(section_id, shot_id, warning_code)
    }

    /// Save multiple resolved warnings to database in bulk
    pub fn save_resolved_warnings_bulk(&self, warnings: &[crate::persistence::ResolvedWarning]) -> Result<()> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.save_resolved_warnings_bulk(warnings)
    }
}
