//! AppState methods for collaboration mode: enabling, change detection, and
//! applying a collaborator's reconciled `.tml` edits as one undoable operation.

use std::path::PathBuf;

use chrono::Utc;

use crate::core::reconcile::{diff, CollabChangeSet};
use crate::core::CommandResult;
use crate::models::{CollabState, Project, SectionData, SectionId};

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

    // Appended shots into existing sections.
    for a in &cs.shots_added {
        if let Some(sid) = a.section_id {
            project.add_shot(sid, a.data.clone());
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
