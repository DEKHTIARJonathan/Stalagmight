//! AppState methods for collaboration mode: enabling, change detection, and
//! applying a collaborator's reconciled `.tml` edits as one undoable operation.

use std::path::PathBuf;

use chrono::Utc;

use crate::core::reconcile::{diff, CollabChangeSet};
use crate::core::CommandResult;
use crate::models::{CollabState, Project, SectionData, SectionId, ShotId};

use super::AppState;

impl AppState {
    /// Enable or disable collaboration mode on the open project. The companion
    /// `.tml` is always `<stalx-stem>.tml`. Persisted on the next save.
    pub fn set_collab_enabled(&self, enabled: bool) -> CommandResult {
        // Read-only edit gate (#191, D-B6): a collab toggle mutates the open
        // project (project.collab + touch()), so it is treated as a gated
        // mutation. This method has NO command_lock; gating reads the transient
        // edit_enabled state, not the project, so it is sufficient.
        if let Err(f) = self.guard_mutation("Toggle collaboration") {
            return f;
        }
        let mut guard = match self.project.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let Some(project) = guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // No-op guard (#241): toggling to the value already in effect must not
        // touch()/mark_remote_dirty() - that would spuriously flag a remote
        // project as having unpushed edits and bump last_edit_at for a call that
        // changes nothing. Note: this means a redundant enable(true) call no
        // longer refreshes sibling_tml_relative the way the old unconditional
        // path did; the only live caller pre-gates on an actual value change,
        // so that's inert today.
        let already_enabled = project.collab.as_ref().is_some_and(|c| c.enabled);
        if already_enabled == enabled {
            return CommandResult::success();
        }

        if enabled {
            let sibling = default_sibling_name(project);
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
        drop(guard);
        // Dirty-bit flip (#191, D-B16): a collab toggle mutated a remote project.
        // Set-only; no-op for local-only.
        self.mark_remote_dirty();
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

        // No-op guard (#241): mirror set_collab_enabled's early return above - a call
        // that toggles to the value already stored on disk for this path must not
        // rewrite collab_state or mark_remote_dirty() the open project (it may not
        // even be the open project). `project.collab` here is what db.load_project()
        // just read, so this is the current on-disk state for `path`.
        let already_enabled = project.collab.as_ref().is_some_and(|c| c.enabled);
        if already_enabled == enabled {
            return CommandResult::success();
        }

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

        // Read-only edit gate (#191, D-B6): this method mutates a `.stalx` BY PATH
        // - usually NOT the open AppState project - so the transient edit_enabled
        // flag (which describes the *open* project) can only speak for it when the
        // path IS the currently open project. So compute the open-project identity
        // FIRST, BEFORE the disk write, and gate only on a match. The identity
        // check is deliberately reordered ABOVE `db.save_collab_state` (the disk
        // write) so guard_mutation can abort before ANY mutation. A *closed*
        // remote file is NOT gated here: cross-file remote-gating of a closed file
        // is deferred to the issue that owns closed-file remote state.
        let is_open_project = {
            let guard = match self.project.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            guard
                .as_ref()
                .is_some_and(|open| open.file_path.as_deref() == Some(path.as_path()))
        };
        if is_open_project {
            if let Err(f) = self.guard_mutation("Toggle collaboration") {
                return f;
            }
        }

        if let Err(e) = db.save_collab_state(project.collab.as_ref()) {
            return CommandResult::failure(format!("Failed to save collaboration state: {e}"));
        }

        // Keep the open project's in-memory state consistent if it's the same file.
        if is_open_project {
            let mut guard = match self.project.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if let Some(open) = guard.as_mut() {
                if open.file_path.as_deref() == Some(path.as_path()) {
                    open.collab = project.collab.clone();
                }
            }
            // Dirty-bit flip (#191, D-B16): only when the gated open project was
            // mutated (a closed file's link is not the open project's link).
            // Set-only; no-op for local-only.
            self.mark_remote_dirty();
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

    /// When collaboration was turned OFF on a project that previously had it on,
    /// return the name of the companion `.tml` if it still exists, so the UI can
    /// warn it will no longer be kept in sync. Gated on provenance - a project
    /// that never had collaboration (`project.collab` is `None`) returns `None`,
    /// so an unrelated `.tml` sharing the basename (e.g. an import source) does
    /// not trigger a false warning. Also `None` when collaboration is on, no
    /// project/file is open, or the companion no longer exists.
    pub fn collab_sibling_when_disabled(&self) -> Option<String> {
        let guard = self.project.lock().ok()?;
        let project = guard.as_ref()?;
        let collab = project.collab.as_ref()?;
        if collab.enabled {
            return None;
        }
        // Provenance guard: only warn when a baseline sha exists,
        // meaning Stalagmight actually exported the sibling at some
        // point.  Without this, a user who toggled collaboration on
        // then off before any successful export - or whose first
        // sibling write failed - would still get warned about any
        // same-basename `.tml` the user dropped next to the project
        // (e.g. an Ariane import source).
        collab.last_export_tml_sha256.as_ref()?;
        let file_path = project.file_path.as_ref()?;
        let sibling_name = collab.sibling_tml_relative.clone();
        let sibling = match file_path.parent() {
            Some(dir) => dir.join(&sibling_name),
            None => PathBuf::from(&sibling_name),
        };
        sibling.exists().then_some(sibling_name)
    }

    /// Apply the collaborator's changes as a single undoable operation.
    /// Apply the collaborator's changes as a single undoable operation.
    ///
    /// TODO(v2): this re-runs `compute_collab` (fresh hash + diff) at apply
    /// time rather than applying the changeset that the review dialog was
    /// populated with.  Under the v1 external-edit-lock that's fine - only
    /// one person edits at a time, so the `.tml` can't change between the
    /// preview and the apply.  Without the lock (true concurrent edit
    /// support), the user could silently apply a different change set than
    /// the one they previewed.  Plumb the previewed changeset (or its hash)
    /// in alongside `Command::ApplyCollabChanges` and reject if the current
    /// state has drifted from it.
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
        // Capture critical state BEFORE the apply so the guard below only rejects
        // corruption this apply INTRODUCED, not pre-existing corruption the project
        // was already opened with (matching execute()'s guard_introduced_corruption).
        let pre_had_critical = self.project_has_critical();

        let skipped = {
            let mut guard = match self.project.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let Some(project) = guard.as_mut() else {
                return CommandResult::failure("No project open".to_string());
            };
            let warnings = apply_changeset(project, &changeset);
            // Mark the returned file as consumed so open-detect won't re-fire
            // before the next save re-exports a fresh baseline.
            if let Some(c) = project.collab.as_mut() {
                c.last_export_tml_sha256 = Some(sha);
                c.last_reconcile_at = Some(Utc::now());
            }
            project.touch();
            warnings
        };

        // Same structural epilogue + corruption guard the standard command path
        // gets in execute(): convert sole-bridge closures the reconcile stranded,
        // reconcile derived offsets, and reject (roll back) if applying the
        // collaborator's changes introduced critical corruption. apply_changeset
        // writes foreign TML geometry directly, so this is the first gate it sees.
        // A collaborator's changeset can REMOVE shots/sections and strand a
        // section behind a closure, so it must run the sole-bridge conversion.
        if self.finalize_structural_edit(pre_had_critical, true) {
            self.rollback_project(&before);
            tracing::error!(
                purpose = "block corruption at the source",
                "Collab apply introduced critical corruption; rolled back, no changes made"
            );
            return CommandResult::failure(
                "Blocked: applying the collaborator's changes would corrupt the survey \
                 structure (dangling references or invalid geometry). No changes were made."
                    .to_string(),
            );
        }

        let after = match self.capture_after_snapshot_or_rollback(&before) {
            Ok(s) => s,
            Err(r) => return r,
        };
        self.push_snapshot_undo(crate::core::Command::ApplyCollabChanges, before, after);
        // Dirty-bit flip (#191, D-B16): applying a collaborator's changes mutated
        // a remote project. apply_collab_changes is reached via execute(
        // ApplyCollabChanges) - already guarded by execute()'s chokepoint - so the
        // gate is inherited; here we only flip the dirty bit. Set-only; no-op for
        // local-only.
        self.mark_remote_dirty();

        let mut result = CommandResult::success();
        result.warnings = skipped
            .into_iter()
            .map(|message| crate::core::ValidationWarning {
                code: "COLLAB_APPLY_SKIPPED".to_string(),
                message,
                severity: crate::core::WarningSeverity::Warning,
            })
            .collect();
        result
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
        let guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
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
        let guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let Some(project) = guard.as_ref() else {
            return Ok(None);
        };
        let Some(collab) = project.collab.as_ref() else {
            return Ok(None);
        };
        // Require collab to be on AND a recorded export - the sha is set in
        // `write_collab_sibling` and is the only proof that the sibling
        // `.tml` next to us came from Stalagmight (not an unrelated TML the
        // user happened to drop in the same dir).  Note: an empty baseline
        // would currently fall through to `diff()`'s own empty-baseline
        // guard, which still short-circuits to an empty change set - so
        // the "enable collab on an empty project, then Ariane adds first
        // shots" workflow is unsupported until the diff guard can be
        // removed safely (it currently regresses real-Ariane corpus
        // replay; see reconcile.rs around the guard).  Workaround: save at
        // least one real shot before handing the .tml off.
        if !collab.enabled || collab.last_export_tml_sha256.is_none() {
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
pub(crate) fn apply_changeset(project: &mut Project, cs: &CollabChangeSet) -> Vec<String> {
    let mut skipped: Vec<String> = Vec::new();
    // Edits in place, preserving Stalagmight-only fields.
    for e in &cs.shots_edited {
        let Some(section) = project.get_section_mut(e.section_id) else {
            skipped.push(format!(
                "Skipped edit on '{}' (section gone - baseline drifted from current project)",
                e.section_name
            ));
            continue;
        };
        let Some(shot) = section.shots.get_mut(e.shot_index as usize) else {
            skipped.push(format!(
                "Skipped edit on '{}' shot #{} (index out of range - Stalagmight edited the section after the baseline was captured)",
                e.section_name,
                e.shot_index + 1,
            ));
            continue;
        };
        let d = &e.new_data;
        // Reject non-finite (NaN/±inf) geometry from the collaborator's TML before
        // it poisons coordinate computation - the collab path writes foreign data
        // directly, so this is its ingest gate (mirrors the command-boundary checks).
        if !d.all_finite() {
            skipped.push(format!(
                "Skipped edit on '{}' shot #{} (non-finite geometry in collaborator data)",
                e.section_name,
                e.shot_index + 1,
            ));
            continue;
        }
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

        // The shot's `to` station picks up the station-portion of the
        // returned Comment. `None` clears any prior entry so a round-trip
        // that deletes the unmarked lines also clears the station comment.
        let to = crate::models::StationRef::new(e.section_id, e.shot_index + 1);
        if let Some(key) = project.key_for_ref(to) {
            match e.new_station_comment.as_deref().filter(|s| !s.is_empty()) {
                Some(text) => {
                    project.station_comments.insert(key, text.to_string());
                }
                None => {
                    project.station_comments.remove(&key);
                }
            }
        }
    }

    // Removes - descending shot index so earlier indices stay valid.
    let mut removals: Vec<(SectionId, u32, String)> = cs
        .shots_removed
        .iter()
        .map(|r| (r.section_id, r.shot_index, r.section_name.clone()))
        .collect();
    removals.sort_by(|a, b| b.1.cmp(&a.1));
    for (sid, idx, section_name) in removals {
        let shot_id = project
            .get_section(sid)
            .and_then(|s| s.shots.get(idx as usize))
            .map(|s| s.id);
        match shot_id {
            Some(shot_id) => {
                let _ = project.remove_shot_with_rewire(sid, shot_id);
            }
            None => skipped.push(format!(
                "Skipped removal on '{}' shot #{} (index out of range - Stalagmight already removed this shot, or the section is missing)",
                section_name,
                idx + 1,
            )),
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
        // Reject non-finite geometry before inserting (see edit-phase note).
        if !a.data.all_finite() {
            skipped.push(format!(
                "Skipped added shot in section {sid} (non-finite geometry in collaborator data)"
            ));
            continue;
        }
        let chained = match last_add {
            Some((lsid, lafter, lnew)) if lsid == sid && lafter == a.after_shot_id => Some(lnew),
            _ => None,
        };
        // Adopt the collaborator's UUID on the inserted shot so the next Ariane
        // round-trip still matches via tier-1 - but only if it's free in this
        // section. A duplicate would make AfterShot anchors mis-resolve (resolve_key
        // takes the first match), and stamping it could even displace an EXISTING
        // shot's identity if the new shot sorts ahead of it; on collision keep the
        // fresh UUID the insert mints.
        //
        // Compute it BEFORE inserting and plumb it INTO the insert rather than
        // post-patching: the prepend path (insert_shot_before, pos == 0) re-anchors
        // this section's `SectionStart` refs to the new first shot's UUID, so
        // overwriting the UUID *after* the insert would leave those refs pointing at
        // the discarded fresh UUID - orphaning a start-station datum/merge/closure
        // (critical → the whole collab apply rolls back) or offset/comment (a
        // dangling ref that later blocks saving). Passing forced_uuid makes the
        // re-anchor use the final UUID, so no orphan is ever created.
        let uuid_to_adopt = a.uuid.as_ref().and_then(|u| {
            let free = project.get_section(sid).map_or(true, |s| {
                s.shots
                    .iter()
                    .all(|sh| sh.uuid.as_deref() != Some(u.as_str()))
            });
            free.then(|| u.clone())
        });
        let new_id = if let Some(anchor) = chained.or(a.after_shot_id) {
            project
                .insert_shot_after(sid, anchor, a.data.clone(), None, uuid_to_adopt.clone())
                .map(|s| s.id)
        } else {
            let first = project
                .get_section(sid)
                .and_then(|s| s.shots.first().map(|sh| sh.id));
            match first {
                Some(fid) => project
                    .insert_shot_before(sid, fid, a.data.clone(), None, uuid_to_adopt.clone())
                    .map(|s| s.id),
                // Empty section: add_shot takes no forced-uuid param, but an empty
                // section has no SectionStart re-anchor either, so stamping the UUID
                // after the add can't orphan anything.
                None => {
                    let id = project.add_shot(sid, a.data.clone()).map(|s| s.id);
                    if let (Some(nid), Some(u)) = (id, uuid_to_adopt.clone()) {
                        if let Some(section) = project.get_section_mut(sid) {
                            if let Some(shot) = section.shots.iter_mut().find(|s| s.id == nid) {
                                shot.uuid = Some(u);
                            }
                        }
                    }
                    id
                }
            }
        };
        if let Some(nid) = new_id {
            let shot_pos = project
                .get_section(sid)
                .and_then(|s| s.shots.iter().position(|sh| sh.id == nid))
                .map(|i| i as u32);
            // Attach the inserted shot's station-portion of Comment to its
            // `to` station - the same shot+1 convention used at export time.
            if let Some(idx) = shot_pos {
                if let Some(text) = a.station_comment.as_deref().filter(|s| !s.is_empty()) {
                    let to = crate::models::StationRef::new(sid, idx + 1);
                    if let Some(key) = project.key_for_ref(to) {
                        project.station_comments.insert(key, text.to_string());
                    }
                }
            }
            last_add = Some((sid, a.after_shot_id, nid));
        }
    }

    // Whole new sections.  Preserve per-shot UUIDs that came back from
    // the collaborator (parallel to `s.shots`) by patching them onto
    // the newly-added section's shots after add_section runs.  Shots
    // without a returned UUID (Ariane ≤25 or shot lacked `<UUID>`)
    // keep the fresh UUID `Shot::new` minted.
    for s in &cs.sections_added {
        let new_sid = project
            .add_section(SectionData {
                name: Some(s.name.clone()),
                surveyor: s.surveyor.clone(),
                date: s.date,
                color: s.color.clone(),
                direction: None,
                quality: 1.0,
                shots: s.shots.clone(),
            })
            .id;
        if !s.shot_uuids.is_empty() {
            if let Some(section) = project.get_section_mut(new_sid) {
                // Adopt each collaborator UUID only if it has not already been
                // adopted by an earlier shot in THIS section. A repeated UUID would
                // make AfterShot anchors mis-resolve (resolve_key takes the first
                // match), so the station comment attached below would silently snap
                // to the wrong station; keep the unique fresh mint add_section gave
                // the shot in that case. (Mirrors the per-stamp guard the
                // `shots_added` path already applies above.)
                let mut adopted: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                for (shot, uuid_opt) in section.shots.iter_mut().zip(s.shot_uuids.iter()) {
                    if let Some(u) = uuid_opt.as_ref() {
                        if adopted.insert(u.clone()) {
                            shot.uuid = Some(u.clone());
                        }
                    }
                }
            }
        }
        // Station-portion comments parallel to s.shots - each entry, if
        // present, attaches to the new shot's `to` station (shot_index + 1).
        for (shot_idx, sc_opt) in s.shot_station_comments.iter().enumerate() {
            if let Some(text) = sc_opt.as_deref().filter(|s| !s.is_empty()) {
                let to = crate::models::StationRef::new(new_sid, shot_idx as u32 + 1);
                if let Some(key) = project.key_for_ref(to) {
                    project.station_comments.insert(key, text.to_string());
                }
            }
        }
    }

    // Section metadata.
    for m in &cs.section_meta_changed {
        if let Some(section) = project.get_section_mut(m.section_id) {
            for ch in &m.changes {
                match ch.field.as_str() {
                    "name" => {
                        section.name = (!ch.new.is_empty()).then(|| ch.new.clone());
                    }
                    "color" => section.color = ch.new.clone(),
                    "surveyor" => {
                        section.surveyor = (!ch.new.is_empty()).then(|| ch.new.clone());
                    }
                    "date" => {
                        // Distinguish "clear the date" (Ariane sent the
                        // empty string) from "malformed date" (Ariane
                        // sent a non-ISO format).  Silently clearing on
                        // a parse error wipes the user's date without
                        // warning; preserve the previous value and
                        // surface a skip warning instead.
                        if ch.new.is_empty() {
                            section.date = None;
                        } else {
                            match chrono::NaiveDate::parse_from_str(&ch.new, "%Y-%m-%d") {
                                Ok(d) => section.date = Some(d),
                                Err(_) => skipped.push(format!(
                                    "Skipped date change on section: '{}' is not a valid YYYY-MM-DD date (kept previous value)",
                                    ch.new
                                )),
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Defense-in-depth: a hostile/corrupt .tml could repeat a UUID across the
    // shots it adds (e.g. within sections_added, where the per-stamp guard above
    // does not apply). Re-mint any in-section duplicate so resolve_key's
    // first-match cannot silently mis-anchor a cross-reference.
    project.ensure_unique_shot_uuids();

    skipped
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::core::reconcile::{
        AddedShot, CollabChangeSet, CollabFieldChange, EditedShot, SectionMetaChange,
    };
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
            shots: vec![
                shot(10.0, 5.0),
                shot(20.0, 6.0),
                shot(30.0, 7.0),
                shot(40.0, 8.0),
            ],
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
            uuid: None,
            data: shot(az, 6.5),
            station_comment: None,
        }
    }

    #[test]
    fn apply_insert_preserves_collaborator_uuid() {
        // Regression for the AddedShot-loses-uuid bug: when Ariane adds
        // a brand-new shot and returns the .tml with a <UUID>, apply
        // must store that UUID on the inserted shot.  Previously
        // `AddedShot` only carried `ShotData` (no uuid field), so apply
        // called `add_shot(data)` → `Shot::new` minted a fresh UUID and
        // Ariane's identity for the new shot was lost on the very
        // first round-trip.
        let mut p = proj_abcd();
        let sid = p.sections[0].id;
        let b_id = p.sections[0].shots[1].id;

        let mut cs = CollabChangeSet::empty();
        let mut entry = added(sid, 2, Some(b_id), 25.0);
        entry.uuid = Some("ariane-uuid-X".into());
        cs.shots_added.push(entry);
        apply_changeset(&mut p, &cs);

        // X landed between B and C with Ariane's UUID intact.
        assert_eq!(azimuths(&p), vec![10.0, 20.0, 25.0, 30.0, 40.0]);
        let inserted = p.sections[0]
            .shots
            .iter()
            .find(|s| (s.azimuth_in - 25.0).abs() < f64::EPSILON)
            .expect("inserted shot present");
        assert_eq!(
            inserted.uuid.as_deref(),
            Some("ariane-uuid-X"),
            "apply must preserve the collaborator's UUID on the inserted shot"
        );
    }

    #[test]
    fn apply_insert_with_colliding_uuid_stays_unique() {
        // A hostile/corrupt .tml whose added shot carries a UUID that already
        // exists in the section must NOT make two shots share it - that would
        // make AfterShot anchors mis-resolve (resolve_key takes the first
        // match). The collaborator UUID is rejected in favour of a fresh one,
        // and the pre-existing shot keeps its identity.
        let mut p = proj_abcd();
        p.ensure_shot_uuids();
        let sid = p.sections[0].id;
        let b_id = p.sections[0].shots[1].id;
        let existing_uuid = p.sections[0].shots[0].uuid.clone().unwrap();

        let mut cs = CollabChangeSet::empty();
        let mut entry = added(sid, 2, Some(b_id), 25.0);
        entry.uuid = Some(existing_uuid.clone()); // collides with shot A
        cs.shots_added.push(entry);
        apply_changeset(&mut p, &cs);

        // No two shots in the section share a UUID.
        let uuids: Vec<&str> = p.sections[0]
            .shots
            .iter()
            .filter_map(|s| s.uuid.as_deref())
            .collect();
        let mut deduped = uuids.clone();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(
            uuids.len(),
            deduped.len(),
            "no duplicate shot UUIDs after apply"
        );
        // The original shot kept its UUID; the inserted one did not steal it.
        assert_eq!(
            p.sections[0].shots[0].uuid.as_deref(),
            Some(existing_uuid.as_str())
        );
        assert!(!p.has_critical_integrity_violations());
    }

    #[test]
    fn apply_front_insert_preserves_section_start_datum() {
        // Regression for the collab-prepend UUID-orphan bug. A front-insert
        // (after_shot_id == None) of a new first shot carrying a collaborator UUID
        // used to: (1) mint a FRESH UUID inside insert_shot_before and re-anchor the
        // section's SectionStart refs to AfterShot(fresh_uuid), then (2) overwrite
        // the shot's UUID with the collaborator UUID - orphaning the just-re-anchored
        // refs. With a station-0 zero datum that made the entire apply roll back as
        // critical corruption (and with a start offset/comment it left a dangling ref
        // that blocked the next save). The collaborator UUID is now plumbed INTO the
        // insert, so the SectionStart re-anchor uses the final UUID and nothing dangles.
        let mut p = proj_abcd();
        p.ensure_shot_uuids();
        let sid = p.sections[0].id;
        // Zero datum on station 0 → stored as a SectionStart anchor.
        assert!(p
            .set_zero_datum(
                crate::models::StationRef::new(sid, 0),
                crate::models::GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
            )
            .unwrap());

        let mut cs = CollabChangeSet::empty();
        // position 0, after_shot_id None ⇒ front-insert; UUID free in section.
        let mut entry = added(sid, 0, None, 5.0);
        entry.uuid = Some("ariane-front-uuid".into());
        cs.shots_added.push(entry);
        let warnings = apply_changeset(&mut p, &cs);

        // The new first shot adopted the collaborator UUID...
        assert_eq!(
            p.sections[0].shots[0].uuid.as_deref(),
            Some("ariane-front-uuid"),
        );
        // ...and the start-station datum is NOT orphaned: no critical violation and
        // no unresolvable cross-reference that would later block saving.
        assert!(
            !p.has_critical_integrity_violations(),
            "front-insert must not orphan the SectionStart datum: {warnings:?}"
        );
        assert!(!p.has_unresolvable_cross_references());
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

    #[test]
    fn apply_edit_preserves_stalagmight_only_fields() {
        // An edit overwrites TML-expressible fields but must preserve fields Ariane
        // can't represent (azimuth_out, pitch_out, marker_index, temperature).
        let mut p = Project::new("Cave".into(), None);
        p.add_section(SectionData {
            name: Some("Main".into()),
            surveyor: None,
            date: None,
            color: "#000000".into(),
            direction: None,
            quality: 1.0,
            shots: vec![ShotData {
                azimuth_in: 10.0,
                azimuth_out: 200.0,
                length: 5.0,
                depth_in: 0.0,
                depth_out: 1.0,
                pitch_in: Some(1.0),
                pitch_out: Some(5.0),
                marker_index: Some(7),
                temperature: Some(12.5),
                ..Default::default()
            }],
        });
        let sid = p.sections[0].id;

        let mut cs = CollabChangeSet::empty();
        cs.shots_edited.push(EditedShot {
            section_id: sid,
            shot_index: 0,
            section_name: "Main".into(),
            changes: vec![CollabFieldChange {
                field: "length".into(),
                old: "5.000".into(),
                new: "99.000".into(),
            }],
            // What a returned Ariane shot carries - no azimuth_out/pitch_out/marker/temp.
            new_data: ShotData {
                azimuth_in: 10.0,
                length: 99.0,
                depth_in: 0.0,
                depth_out: 1.0,
                pitch_in: Some(1.0),
                ..Default::default()
            },
            new_station_comment: None,
        });
        apply_changeset(&mut p, &cs);

        let shot = &p.sections[0].shots[0];
        assert_eq!(shot.length, 99.0, "TML field applied");
        assert_eq!(shot.azimuth_out, 200.0, "azimuth_out preserved");
        assert_eq!(shot.pitch_out, Some(5.0), "pitch_out preserved");
        assert_eq!(shot.marker_index, Some(7), "marker_index preserved");
        assert_eq!(shot.temperature, Some(12.5), "temperature preserved");
    }

    #[test]
    fn apply_sections_added_dedups_uuids_so_comments_anchor_correctly() {
        // A corrupt/hostile .tml can hand `sections_added` two shots sharing a
        // UUID. The old code adopted both, so a station comment attached to the
        // SECOND station (keyed AfterShot(U)) silently snapped to the FIRST
        // (resolve_key takes the first match). The adopt-only-if-free guard must
        // keep the second shot's UUID unique so its comment anchors correctly.
        let mut p = Project::new("Cave".into(), None);

        let mut cs = CollabChangeSet::empty();
        cs.sections_added
            .push(crate::core::reconcile::AddedSection {
                name: "New".into(),
                color: "#000000".into(),
                surveyor: None,
                date: None,
                shots: vec![shot(10.0, 5.0), shot(20.0, 6.0)],
                shot_uuids: vec![Some("dup".into()), Some("dup".into())],
                shot_station_comments: vec![None, Some("second station note".into())],
            });
        apply_changeset(&mut p, &cs);

        let sec = &p.sections[0];
        let u0 = sec.shots[0].uuid.clone().unwrap();
        let u1 = sec.shots[1].uuid.clone().unwrap();
        assert_ne!(
            u0, u1,
            "duplicate collaborator UUIDs must not both be adopted"
        );
        assert_eq!(
            u0, "dup",
            "the first occurrence keeps the collaborator UUID"
        );

        let sid = sec.id;
        // The comment was attached to the SECOND station (after shot index 1 = 2).
        assert_eq!(
            p.station_comment_for_ref(crate::models::StationRef::new(sid, 2))
                .map(String::as_str),
            Some("second station note"),
            "the comment must anchor to the second station, not collapse onto the first"
        );
        // The FIRST station (index 1, after shot 0) carries no comment.
        assert_eq!(
            p.station_comment_for_ref(crate::models::StationRef::new(sid, 1)),
            None
        );
    }

    #[test]
    fn apply_section_name_change_renames_section() {
        let mut p = proj_abcd();
        let sid = p.sections[0].id;

        let mut cs = CollabChangeSet::empty();
        cs.section_meta_changed.push(SectionMetaChange {
            section_id: sid,
            section_name: "Hallway".into(),
            changes: vec![CollabFieldChange {
                field: "name".into(),
                old: "Main".into(),
                new: "Hallway".into(),
            }],
        });
        apply_changeset(&mut p, &cs);

        assert_eq!(p.sections[0].name.as_deref(), Some("Hallway"));
    }
}
