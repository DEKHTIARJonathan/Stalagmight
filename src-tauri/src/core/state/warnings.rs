use anyhow::Result;
use std::collections::HashSet;

use crate::core::{Validator, WarningSeverity};
use crate::models::{
    Project, ProjectWarning, SectionId, ShotData, ShotId, MULTIPLE_DATUMS_PER_MERGE_COMPONENT,
};
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
        // Load resolved (ignored) warnings. Suppression is keyed by the shot's
        // stable UUID (issue #57): an ignore stays bound to the same shot even
        // after inserts/deletes/reorders renumber `shot_id`. Pre-v8 rows that
        // carry no UUID fall back to the legacy (section_id, shot_id) position.
        let resolved = if let Some(db) = db {
            // Use provided database reference (pre-finalization)
            db.load_resolved_warnings().unwrap_or_default()
        } else {
            // Fall back to self.database (post-finalization)
            self.load_resolved_warnings().unwrap_or_default()
        };
        let mut resolved_by_uuid: HashSet<(String, String)> = HashSet::new();
        let mut resolved_by_position: HashSet<(u32, u32, String)> = HashSet::new();
        for r in &resolved {
            match &r.shot_uuid {
                Some(uuid) => {
                    resolved_by_uuid.insert((uuid.clone(), r.warning_code.clone()));
                }
                None => {
                    resolved_by_position.insert((r.section_id, r.shot_id, r.warning_code.clone()));
                }
            }
        }
        // A warning is suppressed if its shot's UUID was ignored, or if its
        // legacy (section_id, shot_id) position was ignored. The position
        // fallback is what keeps pre-UUID suppressions alive: a pre-v8 row, or a
        // pre-v6 .stalx whose shots only get a UUID minted in-memory on load
        // (so the v8 backfill saw a NULL `shots.uuid` and left the row
        // position-keyed), is still honored even though the in-memory shot now
        // carries a fresh UUID. Only NULL-uuid rows ever enter
        // `resolved_by_position`, and every v8+ ignore stores a UUID, so a fresh
        // ignore is never position-keyed and cannot suppress an unrelated shot
        // that later reuses a stale shot_id.
        let is_resolved_for =
            |shot_uuid: &Option<String>, section_id: u32, shot_id: u32, code: &str| -> bool {
                if let Some(uuid) = shot_uuid {
                    if resolved_by_uuid.contains(&(uuid.clone(), code.to_string())) {
                        return true;
                    }
                }
                resolved_by_position.contains(&(section_id, shot_id, code.to_string()))
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
                    let is_resolved = is_resolved_for(&shot.uuid, section.id, shot.id, &warning.code);
                    all_warnings.push(ProjectWarning {
                        section_id: section.id,
                        shot_id: shot.id,
                        shot_index,
                        code: warning.code,
                        message: warning.message,
                        severity: warning.severity,
                        is_resolved,
                        shot_uuid: shot.uuid.clone(),
                        datum_station_index: None,
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
                all_warnings.push(ProjectWarning {
                    section_id: section.id,
                    shot_id: shot.id,
                    shot_index,
                    message: format!(
                        "Station {}:{} has a zero datum, but its merge group is also anchored at {others}. Two GPS anchors over-constrain one rigid group; remove all but one zero datum.",
                        datum.section_id, datum.station_index
                    ),
                    code: MULTIPLE_DATUMS_PER_MERGE_COMPONENT.to_string(),
                    severity: WarningSeverity::Warning,
                    // Over-anchoring is a structural error, not a suppressible
                    // nuisance: it is never "resolved" via an ignore — it clears
                    // only when a datum is actually removed (at which point the
                    // component is no longer over-anchored and this warning is
                    // simply not generated). Force false so no stray resolved row
                    // (legacy, bulk, or otherwise) can hide it.
                    is_resolved: false,
                    shot_uuid: shot.uuid.clone(),
                    datum_station_index: Some(datum.station_index),
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

    /// Delete a resolved warning from database (un-ignore). `shot_uuid` keys the
    /// deletion by stable identity when present; the legacy position is also
    /// cleared so a pre-v8 row is removed regardless.
    pub fn delete_resolved_warning(
        &self,
        section_id: u32,
        shot_id: u32,
        warning_code: &str,
        shot_uuid: Option<&str>,
    ) -> Result<()> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.delete_resolved_warning(section_id, shot_id, warning_code, shot_uuid)
    }

    /// Look up a shot's stable UUID by its `(section_id, shot_id)` identity in
    /// the open project. Used by the resolve/unresolve commands to key an
    /// "Ignore" by UUID (issue #57). After `do_load_project_full` every shot
    /// has a UUID, so this is `Some` for any shot the user can act on; returns
    /// `None` only if no project is open or the shot is gone.
    pub fn shot_uuid_for(&self, section_id: SectionId, shot_id: ShotId) -> Option<String> {
        let guard = self.project.lock().ok()?;
        let project = guard.as_ref()?;
        let section = project.sections.iter().find(|s| s.id == section_id)?;
        let shot = section.shots.iter().find(|s| s.id == shot_id)?;
        shot.uuid.clone()
    }

    /// Save multiple resolved warnings to database in bulk
    pub fn save_resolved_warnings_bulk(&self, warnings: &[crate::persistence::ResolvedWarning]) -> Result<()> {
        let db_guard = self.database.lock().map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard.as_ref().ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.save_resolved_warnings_bulk(warnings)
    }
}
