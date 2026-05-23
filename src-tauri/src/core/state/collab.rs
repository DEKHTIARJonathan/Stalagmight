//! AppState methods for collaboration mode: enabling, change detection, and
//! applying a collaborator's reconciled `.tml` edits as one undoable operation.

use std::path::PathBuf;

use chrono::Utc;

use crate::core::reconcile::{diff, CollabChangeSet};
use crate::core::CommandResult;
use crate::models::{CollabState, Project, SectionData, SectionId, ShotId};

use super::AppState;

impl AppState {
    /// Enable or disable collaboration mode on the open project. When enabling,
    /// sets the sibling `.tml` path (default `<stalx-stem>.tml`). Persisted on
    /// the next save.
    pub fn set_collab_enabled(
        &self,
        enabled: bool,
        sibling_tml_relative: Option<String>,
    ) -> CommandResult {
        let mut guard = match self.project.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let Some(project) = guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        if enabled {
            let sibling = sibling_tml_relative
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| default_sibling_name(project));
            match project.collab.as_mut() {
                Some(c) => {
                    c.enabled = true;
                    c.sibling_tml_relative = sibling;
                }
                None => project.collab = Some(CollabState::new(sibling)),
            }
        } else if let Some(c) = project.collab.as_mut() {
            c.enabled = false;
        }
        project.touch();
        CommandResult::success()
    }

    /// Enable or disable collaboration for a project on disk by path, without
    /// requiring it to be the open project. Used by the recent-projects panel,
    /// where the selected project usually isn't loaded into memory.
    ///
    /// Mutates the `collab_state` row in the `.stalx` directly (preserving any
    /// existing baseline) and, if the same project happens to be open, keeps the
    /// in-memory copy in sync so a later save won't clobber the change.
    pub fn set_collab_enabled_for_path(&self, path: PathBuf, enabled: bool) -> CommandResult {
        let db = match crate::persistence::Database::open_existing(&path) {
            Ok(db) => db,
            Err(e) => return CommandResult::failure(format!("Failed to open project: {e}")),
        };
        let mut project = match db.load_project() {
            Ok(p) => p,
            Err(e) => return CommandResult::failure(format!("Failed to load project: {e}")),
        };
        project.file_path = Some(path.clone());

        if enabled {
            let sibling = default_sibling_name(&project);
            match project.collab.as_mut() {
                Some(c) => {
                    c.enabled = true;
                    c.sibling_tml_relative = sibling;
                }
                None => project.collab = Some(CollabState::new(sibling)),
            }
        } else if let Some(c) = project.collab.as_mut() {
            c.enabled = false;
        }

        if let Err(e) = db.save_collab_state(project.collab.as_ref()) {
            return CommandResult::failure(format!("Failed to save collaboration state: {e}"));
        }

        // Keep the open project's in-memory state consistent if it's the same file.
        let mut guard = match self.project.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(open) = guard.as_mut() {
            if open.file_path.as_deref() == Some(path.as_path()) {
                open.collab = project.collab.clone();
            }
        }

        CommandResult::success()
    }

    /// Clone of the open project's collaboration state, if any.
    pub fn get_collab_state(&self) -> Option<CollabState> {
        let guard = self.project.lock().ok()?;
        guard.as_ref()?.collab.clone()
    }

    /// Cheap check (hash compare) of whether the sibling `.tml` was edited
    /// externally since Stalagmight last wrote it. Used by open-detect.
    pub fn collab_changes_available(&self) -> bool {
        self.sibling_changed().unwrap_or(false)
    }

    /// Preview the collaborator's changes without mutating anything.
    pub fn detect_collab_changes(&self) -> Result<Option<CollabChangeSet>, String> {
        Ok(self.compute_collab()?.map(|(cs, _)| cs))
    }

    /// When collaboration is OFF, return the name of an existing sibling `.tml`
    /// (if any) so the UI can warn that it will not be kept in sync. Returns
    /// `None` when collaboration is on, no project/file is open, or no sibling
    /// `.tml` is present next to the `.stalx`.
    pub fn collab_sibling_when_disabled(&self) -> Option<String> {
        let guard = self.project.lock().ok()?;
        let project = guard.as_ref()?;
        if project.collab.as_ref().is_some_and(|c| c.enabled) {
            return None;
        }
        let file_path = project.file_path.as_ref()?;
        let sibling_name = format!("{}.tml", file_path.file_stem()?.to_string_lossy());
        let sibling = match file_path.parent() {
            Some(dir) => dir.join(&sibling_name),
            None => PathBuf::from(&sibling_name),
        };
        sibling.exists().then_some(sibling_name)
    }

    /// Apply the collaborator's changes as a single undoable operation.
    pub(super) fn apply_collab_changes(&self) -> CommandResult {
        let (changeset, sha) = match self.compute_collab() {
            Ok(Some(v)) => v,
            Ok(None) => return CommandResult::success(),
            Err(e) => return CommandResult::failure(e),
        };
        if changeset.is_empty() {
            return CommandResult::success();
        }

        let before = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(r) => return r,
        };

        {
            let mut guard = match self.project.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let Some(project) = guard.as_mut() else {
                return CommandResult::failure("No project open".to_string());
            };
            apply_changeset(project, &changeset);
            // Mark the returned file as consumed so open-detect won't re-fire
            // before the next save re-exports a fresh baseline.
            if let Some(c) = project.collab.as_mut() {
                c.last_export_tml_sha256 = Some(sha);
                c.last_reconcile_at = Some(Utc::now());
            }
            project.touch();
        }

        let after = match self.capture_after_snapshot_or_rollback(&before) {
            Ok(s) => s,
            Err(r) => return r,
        };
        self.push_snapshot_undo(crate::core::Command::ApplyCollabChanges, before, after);

        CommandResult::success()
    }

    // --- internals ---

    fn sibling_path(project: &Project) -> Option<PathBuf> {
        let collab = project.collab.as_ref()?;
        if !collab.enabled {
            return None;
        }
        let file_path = project.file_path.as_ref()?;
        Some(match file_path.parent() {
            Some(dir) => dir.join(&collab.sibling_tml_relative),
            None => PathBuf::from(&collab.sibling_tml_relative),
        })
    }

    fn sibling_changed(&self) -> Result<bool, String> {
        let guard = self.project.lock().map_err(|_| "Failed to lock project".to_string())?;
        let Some(project) = guard.as_ref() else {
            return Ok(false);
        };
        let Some(collab) = project.collab.as_ref() else {
            return Ok(false);
        };
        let Some(path) = Self::sibling_path(project) else {
            return Ok(false);
        };
        if !path.exists() {
            return Ok(false);
        }
        let sha = crate::parsers::tml::tml_content_sha256(&path).map_err(|e| e.to_string())?;
        Ok(collab.last_export_tml_sha256.as_deref() != Some(sha.as_str()))
    }

    /// Compute the change set plus the returned file's content hash, if the
    /// sibling `.tml` differs from what we last wrote.
    fn compute_collab(&self) -> Result<Option<(CollabChangeSet, String)>, String> {
        let guard = self.project.lock().map_err(|_| "Failed to lock project".to_string())?;
        let Some(project) = guard.as_ref() else {
            return Ok(None);
        };
        let Some(collab) = project.collab.as_ref() else {
            return Ok(None);
        };
        if !collab.enabled || collab.shot_baseline.is_empty() {
            return Ok(None);
        }
        let Some(path) = Self::sibling_path(project) else {
            return Ok(None);
        };
        if !path.exists() {
            return Ok(None);
        }
        let sha = crate::parsers::tml::tml_content_sha256(&path).map_err(|e| e.to_string())?;
        if collab.last_export_tml_sha256.as_deref() == Some(sha.as_str()) {
            return Ok(None);
        }
        let tml = crate::parsers::tml::parse_tml(&path).map_err(|e| e.to_string())?;
        let cs = diff(project, &tml);
        Ok(Some((cs, sha)))
    }
}

fn default_sibling_name(project: &Project) -> String {
    project
        .file_path
        .as_ref()
        .and_then(|p| p.file_stem())
        .map(|s| format!("{}.tml", s.to_string_lossy()))
        .unwrap_or_else(|| "collaboration.tml".to_string())
}

/// Mutate the project in place to apply a reconciled change set. Order matters:
/// edits (no length change) → removes (descending index) → appends → new
/// sections → section metadata. Stalagmight-only shot fields are preserved.
fn apply_changeset(project: &mut Project, cs: &CollabChangeSet) {
    // Edits in place, preserving Stalagmight-only fields.
    for e in &cs.shots_edited {
        if let Some(section) = project.get_section_mut(e.section_id) {
            if let Some(shot) = section.shots.get_mut(e.shot_index as usize) {
                let d = &e.new_data;
                shot.azimuth_in = d.azimuth_in;
                shot.length = d.length;
                shot.depth_in = d.depth_in;
                shot.depth_out = d.depth_out;
                shot.pitch_in = d.pitch_in;
                shot.left = d.left;
                shot.right = d.right;
                shot.up = d.up;
                shot.down = d.down;
                shot.comment = d.comment.clone();
                shot.is_reference = d.is_reference;
                // Preserved (no TML equivalent): azimuth_out, pitch_out,
                // marker_index, temperature.
            }
        }
    }

    // Removes — descending shot index so earlier indices stay valid.
    let mut removals: Vec<(SectionId, u32)> = cs
        .shots_removed
        .iter()
        .map(|r| (r.section_id, r.shot_index))
        .collect();
    removals.sort_by(|a, b| b.1.cmp(&a.1));
    for (sid, idx) in removals {
        let shot_id = project
            .get_section(sid)
            .and_then(|s| s.shots.get(idx as usize))
            .map(|s| s.id);
        if let Some(shot_id) = shot_id {
            let _ = project.remove_shot_with_rewire(sid, shot_id);
        }
    }

    // Inserted shots into existing sections. Honor each shot's anchor (the id of
    // the matched shot it follows in document order) so mid-section inserts land
    // in the right place instead of being appended. Anchors are matched shots,
    // which are never removed in this same change set, so they survive the
    // edit/remove phases above. Consecutive adds that share an anchor (several
    // inserts in one gap) are chained after the previously inserted shot to keep
    // their order. `after_shot_id == None` inserts at the section front (or
    // appends when the section is empty).
    let mut last_add: Option<(SectionId, Option<ShotId>, ShotId)> = None;
    for a in &cs.shots_added {
        let Some(sid) = a.section_id else { continue };
        let chained = match last_add {
            Some((lsid, lafter, lnew)) if lsid == sid && lafter == a.after_shot_id => Some(lnew),
            _ => None,
        };
        let new_id = if let Some(anchor) = chained.or(a.after_shot_id) {
            project.insert_shot_after(sid, anchor, a.data.clone()).map(|s| s.id)
        } else {
            let first = project
                .get_section(sid)
                .and_then(|s| s.shots.first().map(|sh| sh.id));
            match first {
                Some(fid) => project.insert_shot_before(sid, fid, a.data.clone()).map(|s| s.id),
                None => project.add_shot(sid, a.data.clone()).map(|s| s.id),
            }
        };
        if let Some(nid) = new_id {
            last_add = Some((sid, a.after_shot_id, nid));
        }
    }

    // Whole new sections.
    for s in &cs.sections_added {
        project.add_section(SectionData {
            name: Some(s.name.clone()),
            surveyor: s.surveyor.clone(),
            date: s.date,
            color: s.color.clone(),
            direction: None,
            quality: 1.0,
            shots: s.shots.clone(),
        });
    }

    // Section metadata.
    for m in &cs.section_meta_changed {
        if let Some(section) = project.get_section_mut(m.section_id) {
            for ch in &m.changes {
                match ch.field.as_str() {
                    "color" => section.color = ch.new.clone(),
                    "surveyor" => {
                        section.surveyor = (!ch.new.is_empty()).then(|| ch.new.clone());
                    }
                    "date" => {
                        section.date =
                            chrono::NaiveDate::parse_from_str(&ch.new, "%Y-%m-%d").ok();
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::core::reconcile::{AddedShot, CollabChangeSet};
    use crate::models::ShotData;

    fn shot(az: f64, len: f64) -> ShotData {
        ShotData {
            azimuth_in: az,
            azimuth_out: az,
            length: len,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }
    }

    /// A section [A, B, C, D] with azimuths 10/20/30/40.
    fn proj_abcd() -> Project {
        let mut p = Project::new("Cave".into(), None);
        p.add_section(SectionData {
            name: Some("Main".into()),
            surveyor: None,
            date: None,
            color: "#000000".into(),
            direction: None,
            quality: 1.0,
            shots: vec![shot(10.0, 5.0), shot(20.0, 6.0), shot(30.0, 7.0), shot(40.0, 8.0)],
        });
        p
    }

    fn azimuths(p: &Project) -> Vec<f64> {
        p.sections[0].shots.iter().map(|s| s.azimuth_in).collect()
    }

    fn added(sid: SectionId, position: u32, after: Option<ShotId>, az: f64) -> AddedShot {
        AddedShot {
            section_id: Some(sid),
            section_name: "Main".into(),
            position,
            after_shot_id: after,
            data: shot(az, 6.5),
        }
    }

    #[test]
    fn apply_insert_honors_after_shot_id() {
        let mut p = proj_abcd();
        let sid = p.sections[0].id;
        let b_id = p.sections[0].shots[1].id; // B

        let mut cs = CollabChangeSet::empty();
        cs.shots_added.push(added(sid, 2, Some(b_id), 25.0)); // X between B and C
        apply_changeset(&mut p, &cs);

        assert_eq!(
            azimuths(&p),
            vec![10.0, 20.0, 25.0, 30.0, 40.0],
            "X must land between B and C, not be appended"
        );
    }

    #[test]
    fn apply_chained_inserts_keep_document_order() {
        // Two inserts in the same gap (both after B) must keep order X then Y.
        let mut p = proj_abcd();
        let sid = p.sections[0].id;
        let b_id = p.sections[0].shots[1].id;

        let mut cs = CollabChangeSet::empty();
        cs.shots_added.push(added(sid, 2, Some(b_id), 25.0)); // X
        cs.shots_added.push(added(sid, 3, Some(b_id), 26.0)); // Y
        apply_changeset(&mut p, &cs);

        assert_eq!(azimuths(&p), vec![10.0, 20.0, 25.0, 26.0, 30.0, 40.0]);
    }

    #[test]
    fn apply_front_insert_goes_to_section_start() {
        let mut p = proj_abcd();
        let sid = p.sections[0].id;

        let mut cs = CollabChangeSet::empty();
        cs.shots_added.push(added(sid, 0, None, 5.0)); // before A
        apply_changeset(&mut p, &cs);

        assert_eq!(azimuths(&p), vec![5.0, 10.0, 20.0, 30.0, 40.0]);
    }
}
