use super::AppState;
use crate::core::{CommandResult, UndoStack};
use crate::models::{Project, SectionId};
use crate::persistence::Database;
use anyhow::Result;
use std::path::PathBuf;

/// Build a save-failure `CommandResult`, tagging filesystem permission
/// denials with `PERMISSION_DENIED_CODE` so the frontend can surface
/// folder-access guidance instead of a misleading message. macOS drops
/// previously-granted folder access after OS/app updates, which otherwise
/// reaches the user as a bogus "corrupted database"/raw-OS error.
///
/// `target` is the destination file. We only treat the failure as a
/// permission problem when its parent directory still exists: a
/// deleted/renamed save folder yields SQLite's same generic "unable to open
/// database file", but that's a vanished-location error, not a denial, and
/// should stay an ordinary failure rather than show Privacy & Security steps.
pub(super) fn save_failure(
    context: &str,
    target: &std::path::Path,
    err: &anyhow::Error,
) -> CommandResult {
    let detail = format!("{context}: {err}");
    let dir_present = target
        .parent()
        .is_none_or(|p| p.try_exists().unwrap_or(true));
    if dir_present && crate::core::loading::is_permission_denied(err) {
        CommandResult::failure(format!(
            "{}: {detail}",
            crate::core::loading::PERMISSION_DENIED_CODE
        ))
    } else {
        CommandResult::failure(detail)
    }
}

impl AppState {
    /// True when the open project's initial save is still deferred - it was created
    /// with no save path and has never been written to disk, so it has no `.stalx`
    /// file and no Recent Projects entry yet. Used to durably persist a brand-new
    /// project on its first import (#92), at the command every import path funnels
    /// through, so the fix survives changes to the import UI. Backed by an explicit
    /// flag (set at deferred creation, cleared on save/open/load) rather than
    /// inferred from the DB handle or file existence, both of which are ambiguous.
    pub(crate) fn initial_save_deferred(&self) -> bool {
        self.initial_save_deferred
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub(super) fn save_project(&self, path: Option<PathBuf>, is_autosave: bool) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Refuse to persist a project with unresolvable cross-references (a station an
        // endpoint anchors on was deleted) BEFORE the heals below mutate the live
        // project. The heals (UUID mint/dedup, orphan-offset drop, and the DESTRUCTIVE
        // non-finite sanitize) do NOT affect this predicate - it depends only on
        // section existence and anchor resolution - so checking first is equivalent
        // for the block decision but guarantees a REFUSED save leaves the open project
        // byte-for-byte unchanged (the non-finite sanitize rewrites shot values to
        // finite defaults with no undo entry, so mutating on a refused save would
        // silently lose the user's data).
        //
        // This applies to AUTO-SAVE as well as manual saves: AUTO-SAVE MUST NEVER
        // PERSIST A BROKEN PROJECT. When the project is broken the save is refused (no
        // file written) and the caller surfaces that auto-save did not run (the
        // auto-save indicator + the integrity banner); the user restores integrity via
        // Repair, after which saves resume. This is the single chokepoint that
        // guarantees only sound projects reach disk.
        if project.has_unresolvable_cross_references() {
            let count = project
                .check_structural_integrity()
                .iter()
                .filter(|v| {
                    matches!(
                        v.category.as_str(),
                        "dangling_merge_ref"
                            | "dangling_closure_ref"
                            | "dangling_zero_datum_ref"
                            | "orphan_station_offset"
                            | "orphan_station_comment"
                    )
                })
                .count();
            tracing::error!(
                count,
                is_autosave,
                purpose = "block persisting unresolvable cross-references",
                "Refused to save project with dangling cross-references"
            );
            return CommandResult::failure(format!(
                "Can't save: the project has {count} unresolved cross-reference{} \
                 (a station they point to was deleted). Use \"Repair\" in the \
                 integrity banner, then save.",
                if count == 1 { "" } else { "s" }
            ));
        }

        // Mint UUIDs for any shot still missing one (pre-v6 .stalx
        // files loaded today come back with NULL uuid columns).
        // Doing this BEFORE the SQLite write and BEFORE the sibling
        // .tml export guarantees both sides receive the same UUIDs -
        // without it, db.save_project's INSERT path would mint one set
        // of fresh UUIDs and `write_collab_sibling`'s export would mint
        // a different set, leaving the .stalx and the .tml disagreeing
        // about every shot's identity until the next reload.
        project.ensure_shot_uuids();
        // Re-mint any within-section duplicate shot UUID before refs are resolved
        // to positional form for persistence. resolve_key snaps AfterShot(uuid) to
        // the FIRST matching shot, so a ref anchored on a later duplicate would be
        // written to the wrong station - duplicate_shot_uuid is a Critical violation
        // that the unresolvable-cross-reference save gate below does NOT catch (the
        // ref still resolves, just to the wrong shot). Re-minting is lossless and
        // non-destructive: the kept (first) occurrence keeps its UUID so refs
        // anchored on it stay faithful, and it clears the Critical so the heal isn't
        // re-detected on the next load. (Mirrors the load-path dedup in
        // redrive_offsets_after_load; non-destructive, unlike dropping a dangling
        // ref, so unlike those it is safe to auto-heal on save rather than block.)
        project.ensure_unique_shot_uuids();

        // Drop section_offsets for sections that no longer exist. An orphan entry
        // (a section removed via a path that bypassed cleanup) is dead data, and the
        // SQLite section_offsets row carries a FOREIGN KEY to sections(id) - writing
        // it aborts the ENTIRE save with a generic FK error rather than routing the
        // user to Repair. Lossless (matches repair_structural_integrity), so heal on
        // save. (orphan_section_offset is Critical but the save gate below only sees
        // station cross-refs, not section_offsets.)
        let existing_sections: std::collections::HashSet<SectionId> =
            project.sections.iter().map(|s| s.id).collect();
        project
            .section_offsets
            .retain(|sid, _| existing_sections.contains(sid));

        // Sanitize non-finite (NaN/inf) section offsets before persisting, mirroring
        // the load-boundary guard and the shot sanitize below. section_offsets has no
        // other finite guard, and a non-finite offset would either be coerced to NULL
        // by SQLite (a NaN, aborting the save) or persist (an inf) and poison every
        // world coordinate for that component on the next load.
        for offset in project.section_offsets.values_mut() {
            if !offset.0.is_finite() {
                offset.0 = 0.0;
            }
            if !offset.1.is_finite() {
                offset.1 = 0.0;
            }
        }

        // Sanitize non-finite (NaN/inf) shot geometry before binding. A NaN cannot
        // be stored in a `REAL NOT NULL` column (SQLite coerces it to NULL → the
        // INSERT aborts the whole save), and an inf would persist and only be
        // neutralized on the next load. The load path already sanitizes, so mirror
        // it here so a save can neither abort nor write unusable geometry.
        // (non_finite_geometry is a detect-only Critical that Repair can't auto-fix,
        // so blocking the save would strand the user; neutralizing matches the load
        // round-trip - the value was already unusable.)
        for section in &mut project.sections {
            for shot in &mut section.shots {
                shot.sanitize_non_finite();
            }
        }

        // Don't let geometric corruption persist silently: a release-mode warning
        // when drifted merges are about to be written. (The frontend re-checks
        // after save and offers a repair via the integrity banner.)
        let misaligned = project.check_merge_alignment();
        if !misaligned.is_empty() {
            tracing::warn!(
                count = misaligned.len(),
                purpose = "flag misaligned merges before persisting",
                "Saving a project with drifted station merges"
            );
            for violation in &misaligned {
                tracing::warn!(category = %violation.category, "{}", violation.message);
            }
        }

        // Determine save path and ensure .stalx extension
        let is_implicit_save = path.is_none();
        let save_path = path.or_else(|| project.file_path.clone());
        let mut save_path = match save_path {
            Some(p) => {
                // Ensure .stalx extension
                if p.extension().is_none_or(|ext| ext != "stalx") {
                    p.with_extension("stalx")
                } else {
                    p
                }
            }
            None => return CommandResult::failure("No save path specified".to_string()),
        };

        // On the first implicit save (path omitted), avoid overwriting an existing file.
        // Deferred new projects can reserve a canonical path; if it now exists, auto-rename.
        let has_open_database = self.database.lock().map(|db| db.is_some()).unwrap_or(false);
        if is_implicit_save && !has_open_database {
            let candidate_path = Self::next_available_project_path(&save_path);
            if candidate_path != save_path {
                tracing::warn!(
                    requested_path = ?save_path,
                    selected_path = ?candidate_path,
                    purpose = "avoid overwriting existing project on first implicit save",
                    "Implicit first save path already exists; using auto-renamed path"
                );
                save_path = candidate_path;
            }
        }

        // Create a temporary file path in the same directory (for atomic rename)
        let temp_path = save_path.with_extension("stalx.tmp");
        tracing::info!(
            final_path = ?save_path,
            temp_path = ?temp_path,
            purpose = "persist edits safely",
            "Starting safe save operation"
        );

        // Load display settings from current database or in-memory cache
        let display_settings = {
            let db_guard = self.database.lock().ok();
            let from_db = db_guard
                .as_ref()
                .and_then(|db| db.as_ref())
                .and_then(|db| db.load_display_settings().ok())
                .unwrap_or_default();

            // If DB had settings, use those; otherwise use the in-memory cache
            if from_db.is_empty() {
                self.display_settings_cache
                    .lock()
                    .map(|cache| cache.clone())
                    .unwrap_or_default()
            } else {
                from_db
            }
        };

        // Resolved (ignored) warnings live in their own table, not in the Project
        // model, so save_project() won't carry them. Snapshot them from the
        // current database and re-apply to the fresh save file below, otherwise
        // every save would drop the user's "Ignore" acknowledgements (issue #57).
        let resolved_warnings = {
            // Recover a poisoned lock rather than silently dropping every ignore.
            let db_guard = self.database.lock().unwrap_or_else(|e| e.into_inner());
            let loaded = db_guard.as_ref().map(|db| db.load_resolved_warnings());
            match loaded {
                Some(Ok(rows)) => {
                    // Drop rows whose section no longer exists. resolved_warnings has
                    // a FOREIGN KEY on section_id and the carry-over re-inserts in a
                    // single transaction - one orphaned row (e.g. a section deleted
                    // after a warning on it was ignored; delete_section is in-memory
                    // only and never prunes this table) would abort the whole
                    // transaction and silently drop EVERY still-valid ignore.
                    let section_ids: std::collections::HashSet<_> =
                        project.sections.iter().map(|s| s.id).collect();
                    // Re-derive each UUID-keyed row's stored (section_id, shot_id)
                    // from the live shot's CURRENT position so two distinct live
                    // shots never share a (section_id, shot_id) in the fresh save
                    // file (issue #57). save_project writes shot_id =
                    // section_id*FEATURE_ID_STRIDE + sequence_order, so we derive
                    // the same value from the in-memory project; load regenerates
                    // ids with this identical formula. Without this, a renumber that
                    // lands a different shot on a stale UUID-keyed row's old position
                    // would let INSERT OR REPLACE (against UNIQUE(section_id, shot_id,
                    // warning_code)) silently delete the older shot's still-valid
                    // ignore.
                    // Key by (section_id, uuid), not uuid alone: ensure_unique_shot_uuids
                    // only de-dups within a section, so two sections can share a shot
                    // UUID and a uuid-only key would collapse both live shots into one
                    // entry - remapping section A's ignore to whichever section won the
                    // collect, losing A's ignore and mis-suppressing B (issue #57 / Codex).
                    let live_positions: std::collections::HashMap<
                        (SectionId, &str),
                        (SectionId, u32),
                    > = project
                        .sections
                        .iter()
                        .flat_map(|s| {
                            s.shots.iter().enumerate().filter_map(move |(seq, sh)| {
                                sh.uuid.as_deref().map(|u| {
                                    (
                                        (s.id, u),
                                        (
                                            s.id,
                                            s.id * crate::models::FEATURE_ID_STRIDE + seq as u32,
                                        ),
                                    )
                                })
                            })
                        })
                        .collect();
                    // Index live shots by their CURRENT (section_id, shot_id) → (uuid,
                    // saved position). A position-keyed (NULL-uuid) row written before
                    // its shot's UUID was persisted (resolve_warning on a pre-v6 or
                    // not-yet-saved shot) is upgraded here: THIS save persists every
                    // shot's UUID, so we re-key such a row to the shot's saved position
                    // AND its now-persisted UUID. Without this, its stale in-memory
                    // shot_id could point at a different shot (or none) after an
                    // insert/delete on the next load (issue #57 / Codex).
                    let live_by_id: std::collections::HashMap<
                        (SectionId, u32),
                        (&str, (SectionId, u32)),
                    > = project
                        .sections
                        .iter()
                        .flat_map(|s| {
                            s.shots.iter().enumerate().filter_map(move |(seq, sh)| {
                                sh.uuid.as_deref().map(|u| {
                                    (
                                        (s.id, sh.id),
                                        (
                                            u,
                                            (
                                                s.id,
                                                s.id * crate::models::FEATURE_ID_STRIDE
                                                    + seq as u32,
                                            ),
                                        ),
                                    )
                                })
                            })
                        })
                        .collect();
                    // Remap each UUID-keyed row to its shot's live position; DROP a
                    // UUID-keyed row whose shot was deleted (UUID no longer live) - it
                    // can never match a live shot by UUID on reload, so it is dead.
                    // Keeping it with its stale id would let it collide (under
                    // UNIQUE(section_id, shot_id, warning_code) + INSERT OR REPLACE)
                    // with a live shot that a renumber moved onto that position, and
                    // REPLACE could drop either row depending on insert order - i.e.
                    // silently lose the live shot's still-valid ignore. Dropping dead
                    // rows here also stops them accumulating across saves. NULL-uuid
                    // (legacy, position-keyed) rows are kept and matched by position
                    // (the load-time backfill upgrades the ones that map to a shot).
                    rows.into_iter()
                        .filter_map(|mut r| {
                            match r.shot_uuid.as_deref() {
                                Some(uuid) => {
                                    // Look up by (section_id, uuid): a UUID-keyed row's
                                    // section_id is its shot's section, so this targets the
                                    // right shot even when another section shares the UUID.
                                    let &(sec, shot) = live_positions.get(&(r.section_id, uuid))?;
                                    r.section_id = sec;
                                    r.shot_id = shot;
                                    Some(r)
                                }
                                None => {
                                    // Upgrade a position-keyed row to its shot's saved
                                    // position + now-persisted UUID when its (section_id,
                                    // shot_id) still maps to a live shot. A row that maps
                                    // to NO live shot is DEAD (its shot was deleted) - DROP
                                    // it: carrying it forward would let the load-time
                                    // position backfill re-attach it to whatever shot now
                                    // occupies that saved position, suppressing an
                                    // unrelated shot's warning (issue #57 / Codex).
                                    let &(uuid, (sec, shot)) =
                                        live_by_id.get(&(r.section_id, r.shot_id))?;
                                    r.shot_uuid = Some(uuid.to_string());
                                    r.section_id = sec;
                                    r.shot_id = shot;
                                    Some(r)
                                }
                            }
                        })
                        // Then drop any (legacy) row whose section no longer exists so
                        // the FK on section_id holds for every carried-over row.
                        .filter(|r| section_ids.contains(&r.section_id))
                        .collect()
                }
                Some(Err(e)) => {
                    tracing::warn!(
                        error = %e,
                        purpose = "carry resolved warnings across save",
                        "Failed to read resolved warnings; ignores may not be preserved on this save"
                    );
                    Vec::new()
                }
                None => Vec::new(),
            }
        };

        // [Track B] (#191, D-B13c) The SpeleoDB hand-off link (speleo_link) lives
        // in its own table, not the Project model, so save_project() won't carry
        // it. The save pipeline writes a FRESH temp .stalx and atomically renames
        // it over the destination, so without this snapshot+re-apply a local save
        // would DROP the link entirely - silently un-remoting the project and
        // clearing has_unpushed_edits (exactly the "local save NEVER clears the
        // dirty bit" invariant). Snapshot it here and re-apply to the fresh file
        // below. base_commit_sha + the dirty bit are carried verbatim.
        let speleo_link = {
            let db_guard = self.database.lock().unwrap_or_else(|e| e.into_inner());
            db_guard
                .as_ref()
                .and_then(|db| db.load_speleo_link().ok().flatten())
        };

        // Remove any leftover temp file from previous failed saves
        if temp_path.exists() {
            let _ = std::fs::remove_file(&temp_path);
        }

        // Save to temporary file first
        let mut db = match Database::open(&temp_path) {
            Ok(db) => db,
            Err(e) => {
                // Clean up temp file on failure
                let _ = std::fs::remove_file(&temp_path);
                return save_failure("Failed to create save file", &save_path, &e);
            }
        };

        if let Err(e) = db.save_project(project) {
            // Clean up temp file on failure
            drop(db);
            let _ = std::fs::remove_file(&temp_path);
            tracing::error!(
                error = %e,
                purpose = "persist edits safely",
                "Save failed; temp file cleaned up"
            );
            return save_failure("Failed to save project", &save_path, &e);
        }

        // Copy display settings to the new database
        for (key, value) in &display_settings {
            if let Err(e) = db.save_display_setting(key, value) {
                tracing::warn!(
                    key = %key,
                    error = %e,
                    purpose = "preserve display settings on save",
                    "Failed to copy display setting"
                );
            }
        }

        // Carry over resolved (ignored) warnings so they survive the save.
        if !resolved_warnings.is_empty() {
            if let Err(e) = db.save_resolved_warnings_bulk(&resolved_warnings) {
                tracing::warn!(
                    error = %e,
                    purpose = "preserve resolved warnings on save",
                    "Failed to copy resolved warnings"
                );
            }
        }

        // [Track B] (#191, D-B13c) Carry the SpeleoDB hand-off link forward so a
        // local save never un-remotes the project or clears the dirty bit. The
        // dirty bit is set-only here - only a later server push clears it.
        if let Some(link) = &speleo_link {
            if let Err(e) = db.save_speleo_link(Some(link)) {
                tracing::warn!(
                    error = %e,
                    purpose = "preserve SpeleoDB hand-off link on save",
                    "Failed to copy speleo_link onto the fresh save file"
                );
            }
        }

        // Close the temp database before renaming
        drop(db);

        // Close our own persistent connection to the destination BEFORE the
        // rename. Windows refuses to rename a file over a destination that
        // still has an open handle: SQLite's Connection opens the file without
        // FILE_SHARE_DELETE, so MoveFileEx(REPLACE_EXISTING) fails with
        // "Access is denied" (os error 5). Unix renames over an open file fine
        // (the live handle keeps pointing at the old inode), which is why this
        // only bit Windows. We reopen below - at save_path on success (existing
        // logic), or at the prior path here if the rename fails - so the
        // session keeps a working connection either way.
        let closed_open_db = self
            .database
            .lock()
            .map(|mut db| db.take().is_some())
            .unwrap_or(false);

        // Atomically rename temp file to final destination
        // This is safe: if rename fails, original file is untouched
        if let Err(e) = std::fs::rename(&temp_path, &save_path) {
            let _ = std::fs::remove_file(&temp_path);
            // The destination is untouched. If we just closed our live
            // connection, reopen the previously-open project so subsequent
            // saves, undo persistence, and the implicit-save overwrite guard
            // keep working instead of operating with no open database.
            if closed_open_db {
                if let Some(prev_path) = project.file_path.clone() {
                    if let Ok(reopened) = Database::open(&prev_path) {
                        if let Ok(mut database) = self.database.lock() {
                            *database = Some(reopened);
                        }
                    }
                }
            }
            let e = anyhow::Error::from(e);
            tracing::error!(
                error = %e,
                purpose = "persist edits safely",
                "Failed to rename temp file to final destination"
            );
            return save_failure("Failed to finalize save", &save_path, &e);
        }

        // The `.stalx` is now written, so the initial save is no longer deferred.
        // Set this BEFORE the reopen below: that path returns early on failure, and
        // the project is persisted regardless of whether the handle reopens.
        self.initial_save_deferred
            .store(false, std::sync::atomic::Ordering::Relaxed);

        // Reopen the database at the final path
        let db = match Database::open(&save_path) {
            Ok(db) => db,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    purpose = "reopen saved project for continued editing",
                    "Failed to reopen saved database (file was saved successfully)"
                );
                // File was saved but can't be reopened - subsequent operations
                // (undo persistence, display settings) will fail. Clear the stale
                // database handle so callers don't use it.
                project.file_path = Some(save_path.clone());
                drop(proj_guard);
                if let Ok(mut database) = self.database.lock() {
                    *database = None;
                }
                // Distinct code (not the generic "SYSTEM") so the frontend can keep
                // databaseOpen=false and leave DB-backed actions (e.g. Ignore)
                // disabled until the project is reopened (issue #57 / Codex).
                let mut result = CommandResult::success();
                result.warnings.push(crate::core::ValidationWarning {
                    code: "DATABASE_NOT_REOPENED".to_string(),
                    message: "File saved, but database could not be reopened. Some features may not work until the project is reopened.".to_string(),
                    severity: crate::core::WarningSeverity::Warning,
                });
                return result;
            }
        };

        // Persist undo/redo stacks (best-effort, synchronous to avoid race with readers)
        let persist_limit = self
            .config
            .lock()
            .map(|c| c.general.undo_persist_limit)
            .unwrap_or(20);

        if let Ok(undo_stack) = self.undo_stack.lock() {
            let undo_entries: Vec<_> = undo_stack
                .entries_to_persist(persist_limit)
                .filter_map(UndoStack::serialize_entry_with_timestamp)
                .collect();
            let redo_entries: Vec<_> = undo_stack
                .redo_entries_to_persist(persist_limit)
                .filter_map(UndoStack::serialize_entry_with_timestamp)
                .collect();

            if let Err(e) = db.save_undo_stack_with_timestamps(undo_entries) {
                tracing::warn!(
                    error = %e,
                    purpose = "preserve undo history",
                    "Failed to persist undo stack"
                );
            }
            if let Err(e) = db.save_redo_stack_with_timestamps(redo_entries) {
                tracing::warn!(
                    error = %e,
                    purpose = "preserve redo history",
                    "Failed to persist redo stack"
                );
            }
        }

        // Update file path after successful save
        project.file_path = Some(save_path.clone());

        // Collaboration mode: also write the sibling .tml and refresh the
        // baseline. Best-effort - never fail the .stalx save if this
        // fails.  Autosaves honour `CollabState.write_tml_on_autosave`
        // - when that flag is `false` we skip the .tml rewrite on
        // background saves so the file Ariane is editing doesn't churn
        // every 30 seconds; manual / explicit saves always rewrite.
        let collab_writes_tml = project
            .collab
            .as_ref()
            .is_some_and(|c| c.enabled && (!is_autosave || c.write_tml_on_autosave));
        let mut collab_sibling_error: Option<String> = None;
        if collab_writes_tml {
            if let Err(e) = Self::write_collab_sibling(project, &save_path, &db) {
                tracing::warn!(
                    error = %e,
                    purpose = "write collaborator .tml on save",
                    "Saved .stalx but failed to write sibling .tml"
                );
                collab_sibling_error = Some(e.to_string());
            }
        }

        // Update database handle
        drop(proj_guard);
        if let Ok(mut database) = self.database.lock() {
            *database = Some(db);
        }

        // Clear in-memory cache since settings are now persisted to DB
        self.clear_display_settings_cache();
        self.invalidate_adjusted_cache();

        // Add to recent projects and persist to config
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != &save_path);
            recent.insert(0, save_path.clone());
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                config.general.recent_projects.clone_from(&recent);
                if let Err(e) = config.save() {
                    tracing::warn!(
                        error = %e,
                        purpose = "persist recent projects list",
                        "Failed to save config with recent projects"
                    );
                }
            }
        }

        let save_path_str = save_path.display().to_string();
        tracing::info!(
            path = ?save_path,
            purpose = "persist edits safely",
            "Project saved successfully"
        );
        let mut result = CommandResult::success().with_path(save_path_str);
        // Surface a partial-save warning when the .stalx persisted but the
        // sibling .tml didn't.  Without this the UI shows a green checkmark
        // even though the collaborator's copy is now stale, so they keep
        // editing data the Stalagmight user already replaced.
        if let Some(err) = collab_sibling_error {
            result.warnings.push(crate::core::ValidationWarning {
                code: "COLLAB_SIBLING_WRITE_FAILED".to_string(),
                message: format!(
                    "Saved the .stalx but the companion .tml could not be written ({err}); the file Ariane is editing is now out of date.",
                ),
                severity: crate::core::WarningSeverity::Warning,
            });
        }
        result
    }

    /// Write the sibling `.tml` for collaboration mode and refresh the stored
    /// baseline + content hash on the (already-open) project database.
    fn write_collab_sibling(
        project: &mut Project,
        save_path: &std::path::Path,
        db: &Database,
    ) -> Result<()> {
        // Always derive the sibling name from the current .stalx stem so the
        // companion .tml tracks the project file even if collaboration was
        // enabled before the project had a path (or the file was renamed).
        let sibling_name = save_path
            .file_stem()
            .map(|s| format!("{}.tml", s.to_string_lossy()))
            .unwrap_or_else(|| "collaboration.tml".to_string());
        let sibling = match save_path.parent() {
            Some(dir) => dir.join(&sibling_name),
            None => PathBuf::from(&sibling_name),
        };

        let (baseline, sha, synthetic_section_names) =
            crate::export::tml::export_tml_with_baseline(project, &sibling)?;

        // One (section_name -> id) entry per project section.  Includes
        // sections with NO baseline shots (e.g. an empty root section that
        // only had a START before any real measurements) so that if a
        // collaborator adds the first shots to such a section in Ariane,
        // the returned shots' section_name still matches the existing
        // SectionId via the name-map fallback, and reconcile fills the
        // existing section instead of creating a duplicate.  The exporter's
        // section_name string (used in the baseline) follows the same
        // fallback so the empty-section entries here use a matching key.
        let mut section_name_map = Vec::new();
        for section in &project.sections {
            let name = section
                .name
                .clone()
                .unwrap_or_else(|| format!("Section {}", section.id));
            section_name_map.push((name, section.id));
        }

        if let Some(c) = project.collab.as_mut() {
            c.sibling_tml_relative = sibling_name;
            c.last_export_tml_sha256 = Some(sha);
            c.shot_baseline = baseline;
            c.section_name_map = section_name_map;
            c.synthetic_section_names = synthetic_section_names;
        }

        db.save_collab_state(project.collab.as_ref())?;
        Ok(())
    }

    pub(super) fn close_project(&self) -> CommandResult {
        tracing::debug!("close_project: acquiring project lock");
        if let Ok(mut proj) = self.project.lock() {
            tracing::debug!("close_project: dropping project");
            *proj = None;
            tracing::debug!("close_project: project dropped");
        }

        tracing::debug!("close_project: acquiring database lock");
        if let Ok(mut db) = self.database.lock() {
            tracing::debug!("close_project: dropping database");
            *db = None;
            tracing::debug!("close_project: database dropped");
        }

        tracing::debug!("close_project: acquiring undo_stack lock");
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            tracing::debug!("close_project: clearing undo stack");
            undo_stack.clear();
            tracing::debug!("close_project: undo stack cleared");
        }

        // Clear display settings cache
        self.clear_display_settings_cache();
        self.invalidate_adjusted_cache();
        // [Track B] (#191) Reset the transient read-only edit gate so a previously
        // read-only remote project can't leave the flag stuck for the next open.
        self.set_edit_enabled(true);
        // #213: clear force-edit so it never leaks across a close into the next open.
        self.set_force_editing(false);

        tracing::info!(purpose = "release project resources", "Project closed");
        tracing::debug!("close_project: returning success");
        CommandResult::success()
    }
}
