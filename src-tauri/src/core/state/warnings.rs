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
        // Key the lookup sets by borrowed slices into `resolved` so the
        // per-warning probe below allocates nothing. `resolved` outlives this
        // closure, so the &str borrows stay valid.
        // Key UUID-suppression by (section_id, uuid): `ensure_unique_shot_uuids`
        // only de-dups WITHIN a section, so two sections can legitimately carry the
        // same shot UUID. Keying by UUID alone would let an ignore on one cross-
        // suppress the same code on the other section's shot (issue #57 / Codex).
        // section_id is stable per shot (it doesn't change when shot_id renumbers),
        // so this keeps the position-independence the UUID keying was added for.
        let mut resolved_by_uuid: std::collections::HashMap<(u32, &str), HashSet<&str>> =
            std::collections::HashMap::new();
        let mut resolved_by_position: HashSet<(u32, u32, &str)> = HashSet::new();
        for r in &resolved {
            match &r.shot_uuid {
                Some(uuid) => {
                    resolved_by_uuid
                        .entry((r.section_id, uuid.as_str()))
                        .or_default()
                        .insert(r.warning_code.as_str());
                }
                None => {
                    resolved_by_position.insert((r.section_id, r.shot_id, r.warning_code.as_str()));
                }
            }
        }
        // A warning is suppressed if its shot's UUID was ignored, or (legacy
        // only) if its (section_id, shot_id) position was ignored. The resolve
        // command now REFUSES a no-UUID ignore (commands/validation.rs), and
        // load-time backfill upgrades legacy NULL-uuid rows to UUID keying when
        // the shot still maps to a live position (issue #57). The position
        // fallback is what lets a pre-v8 file's ignores survive the first load.
        // A residual edge remains (issue #57 finding #8): a legacy NULL-uuid row
        // whose position is dead at load - the ignored shot was already gone, so
        // the backfill cannot upgrade it (or, rarely, the backfill DB write
        // failed) - can later suppress an unrelated shot if an in-session insert
        // renumbers a different shot onto that stale id. It only affects pre-v8
        // NULL-uuid rows (every fresh ignore is UUID-keyed) and clears once the
        // position is upgraded. We keep the fallback because dropping it would
        // silently lose every legacy ignore for the still-live shots it protects.
        let is_resolved_for =
            |shot_uuid: &Option<String>, section_id: u32, shot_id: u32, code: &str| -> bool {
                if let Some(uuid) = shot_uuid {
                    if resolved_by_uuid
                        .get(&(section_id, uuid.as_str()))
                        .is_some_and(|codes| codes.contains(code))
                    {
                        return true;
                    }
                }
                resolved_by_position.contains(&(section_id, shot_id, code))
            };

        // Per-project validation thresholds (#57): stored in the .stalx, seeded
        // from the global config at project creation, authoritative thereafter.
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
                    kind: shot.kind,
                    marker_index: shot.marker_index,
                    temperature: shot.temperature,
                };

                let warnings = Validator::validate_shot(
                    &shot_data,
                    &project.validation,
                    section.id,
                    shot_index,
                );
                for warning in warnings {
                    // Errors are never ignorable (issue #57): force is_resolved
                    // false so a stray resolved row (legacy/bulk) can't hide a
                    // blocking problem. Only advisory warnings honor a suppression.
                    let is_resolved = warning.severity != WarningSeverity::Error
                        && is_resolved_for(&shot.uuid, section.id, shot.id, &warning.code);
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
                        datum_refs: None,
                    });
                }
            }
        }

        // Project-level: two or more zero datums in one merge-connected component
        // over-constrain the rigid group, so the offset cascade tears a merge edge
        // apart. Emit ONE error per component (not one per datum, which collided on
        // the (section, shot, code) key - issue #57, finding #4), attached to the
        // first datum's adjacent shot, carrying the FULL datum list so the Resolve
        // view can offer "keep this one, remove the others". (Per-shot
        // ProjectWarning shape: anchor station 0 -> shot 0; station i -> shot i-1.)
        for component in project.over_anchored_merge_components() {
            // Attach the warning to the first datum that maps to a real shot. The
            // first datum may sit at station 0 of an empty section (no shot there);
            // skipping on it alone would silently drop the whole component's error
            // even when another datum in the component IS attachable (Codex). Fall
            // through the component to the first datum with a shot.
            let representative = component.iter().find_map(|d| {
                let section = project.get_section(d.section_id)?;
                let shot_index = if d.station_index == 0 {
                    0
                } else {
                    (d.station_index - 1) as usize
                };
                let shot = section.shots.get(shot_index)?;
                Some((d, section, shot_index, shot))
            });
            let Some((first, section, shot_index, shot)) = representative else {
                continue;
            };
            let anchors = component
                .iter()
                .map(|r| format!("{}:{}", r.section_id, r.station_index))
                .collect::<Vec<_>>()
                .join(", ");
            all_warnings.push(ProjectWarning {
                section_id: section.id,
                shot_id: shot.id,
                shot_index,
                message: format!(
                    "This merge group is anchored by {} zero datums ({anchors}). Two or more GPS anchors over-constrain one rigid group; keep one and remove the others.",
                    component.len()
                ),
                code: MULTIPLE_DATUMS_PER_MERGE_COMPONENT.to_string(),
                // An error (severity_for_code), so it is never ignorable and the
                // generic error force-false above also covers it: it clears only
                // when a datum is actually removed (then this warning is no longer
                // generated at all), never via a stray resolved row.
                severity: crate::models::severity_for_code(MULTIPLE_DATUMS_PER_MERGE_COMPONENT),
                is_resolved: false,
                shot_uuid: shot.uuid.clone(),
                datum_station_index: Some(first.station_index),
                datum_refs: Some(component.clone()),
            });
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
        let db_guard = self
            .database
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.load_resolved_warnings()
    }

    /// Save a resolved warning to database
    pub fn save_resolved_warning(
        &self,
        warning: &crate::persistence::ResolvedWarning,
    ) -> Result<()> {
        let db_guard = self
            .database
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.save_resolved_warning(warning)
    }

    /// Whether a shot UUID is already persisted on disk (see
    /// `Database::shot_uuid_is_persisted`). Returns false when no database is open
    /// or the lookup fails - the safe default, which keeps a new ignore
    /// position-keyed rather than binding it to an unpersisted UUID (issue #57).
    pub fn shot_uuid_is_persisted(&self, uuid: &str) -> bool {
        let Ok(db_guard) = self.database.lock() else {
            return false;
        };
        let Some(db) = db_guard.as_ref() else {
            return false;
        };
        db.shot_uuid_is_persisted(uuid).unwrap_or(false)
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
        let db_guard = self
            .database
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        let db = db_guard
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No database open"))?;
        db.delete_resolved_warning(section_id, shot_id, warning_code, shot_uuid)
    }

    /// User-facing **resolve** (the `resolve_warning` command's persistence step):
    /// the gated + dirtying counterpart of [`Self::save_resolved_warning`]. A resolved
    /// warning PROLIFERATES to the server (`resolved_warnings` is NOT stripped from the
    /// push snapshot - #197), so it is a real remote-dirtying edit, not local-only view
    /// state: a read-only remote project must reject it (`guard_mutation`), and a
    /// successful resolve in an edit session must mark the project dirty so `Done`
    /// pushes it - otherwise it is silently dropped on the next pull. The low-level
    /// [`Self::save_resolved_warning`] accessor stays ungated for the load-time backfill
    /// and tests.
    pub(crate) fn save_resolved_warning_gated(
        &self,
        warning: &crate::persistence::ResolvedWarning,
    ) -> Result<(), String> {
        self.guard_mutation("Resolve warning")
            .map_err(|f| f.error.unwrap_or_default())?;
        self.save_resolved_warning(warning)
            .map_err(|e| e.to_string())?;
        // Dirty-bit flip (#191/#197): set-only; no-op for local-only (no speleo_link).
        self.mark_remote_dirty();
        Ok(())
    }

    /// User-facing **unresolve** (the `unresolve_warning` command's persistence step):
    /// the gated + dirtying counterpart of [`Self::delete_resolved_warning`], for the
    /// same reason as [`Self::save_resolved_warning_gated`].
    pub(crate) fn delete_resolved_warning_gated(
        &self,
        section_id: u32,
        shot_id: u32,
        warning_code: &str,
        shot_uuid: Option<&str>,
    ) -> Result<(), String> {
        self.guard_mutation("Unresolve warning")
            .map_err(|f| f.error.unwrap_or_default())?;
        self.delete_resolved_warning(section_id, shot_id, warning_code, shot_uuid)
            .map_err(|e| e.to_string())?;
        self.mark_remote_dirty();
        Ok(())
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
}
