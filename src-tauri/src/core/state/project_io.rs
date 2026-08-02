use super::AppState;
use crate::core::{CommandResult, PersistStack, UndoStack};
use crate::models::{Project, SectionId};
use crate::persistence::Database;
use std::path::{Path, PathBuf};

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
pub(super) fn save_failure(context: &str, target: &Path, err: &anyhow::Error) -> CommandResult {
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

    pub(super) fn save_project(&self, path: Option<PathBuf>) -> CommandResult {
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
        // files loaded today come back with NULL uuid columns). The UUID
        // is the station identity every cross-reference anchors to
        // (`StationKey::AfterShot`), and it is what keeps the `.tml`
        // SpeleoDB renders byte-stable across re-exports, so it has to be
        // settled BEFORE the SQLite write rather than minted per-consumer.
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

        // Capture the least-squares gauge pair for any section that lacks one (#24), now that
        // every shot is guaranteed a UUID. Recording the station the section is ALREADY using
        // means capturing never moves anybody's coordinates; from here on the gauge is named by
        // a pair of shots rather than re-derived from an index that a later append can shift.
        project.capture_missing_gauge_anchors();

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

        // Save a Copy: an EXPLICIT destination on a SpeleoDB-managed project does
        // not relocate the session - it writes a detached copy WITHOUT the
        // `speleo_link` row and leaves the session on the managed file. A managed
        // project is usable at exactly one path (its cache slot - see
        // `speleodb_foreign`), so carrying the link to an arbitrary destination
        // would mint the second linked copy that module exists to refuse. The
        // predicate is safe for every in-tree caller: `speleodb_publish` and the
        // Ariane adopt both save to the cache path while the project is STILL
        // UNLINKED (the link is stamped after - pinned by
        // `publish_relocates_into_the_cache_before_it_stamps_the_link`), and
        // `speleodb_upload`'s pre-push flush is an implicit save.
        let copy_only = speleo_link.is_some() && !is_implicit_save;
        if copy_only {
            // Refuse the managed file itself as the copy's destination: writing an
            // unlinked copy over it would strip the managed project's link in
            // place - the one outcome this whole arrangement exists to prevent.
            // Both spellings of "itself" are checked: the open file, and the
            // project's canonical cache slot (they are normally the same file, but
            // `same_file` cannot bridge them when one side does not resolve).
            let names_the_managed_file = project
                .file_path
                .as_ref()
                .is_some_and(|open| same_file(open, &save_path))
                || speleo_link.as_ref().is_some_and(|link| {
                    super::speleodb::validate_project_id(&link.project_id).is_ok()
                        && super::speleodb_local_state::cache_root().is_some_and(|root| {
                            super::speleodb_local_state::is_the_cached_copy(
                                &root,
                                &link.project_id,
                                &save_path,
                            )
                        })
                });
            if names_the_managed_file {
                return CommandResult::failure(format!(
                    "\"{}\" is the managed copy of \"{}\" - Save a Copy needs a \
                     different destination. Use Save to save the project itself.",
                    save_path.display(),
                    project.name
                ));
            }
        }
        // [#303] The Unwind chain pointer needs the same treatment, and for a sharper
        // reason than "it would be lost". Losing it is documented as benign - the next
        // Unwind restarts from BASE - but the pointer is also what EXCUSES the dirty bit
        // a walk leaves behind. Dropped here, a copy the user only unwound reads as
        // holding un-pushed work nobody warned them about, so the confirmation and the
        // backend guard disagree: the dialog resolved the flag before an autosave, the
        // guard re-derived it after, and the Unwind failed on press with "this copy holds
        // un-pushed edits that the undo history no longer covers". A scripted run never
        // sees it because nothing saves in between; a person pausing between two Unwinds
        // hits it every time.
        let speleo_undo_chain = {
            let db_guard = self.database.lock().unwrap_or_else(|e| e.into_inner());
            db_guard
                .as_ref()
                .and_then(|db| db.load_speleo_undo_chain().ok().flatten())
        };

        // [#303] ...and the inherited-history watermark, for the same reason and with a
        // sharper failure. It decides which undo rows are cut from the next upload, so a
        // save that dropped it would silently let a loaded revision's history ride into
        // the commit as though the user had authored it here - the very duplication the
        // watermark exists to prevent, reintroduced by an idle autosave.
        let speleo_undo_watermark = {
            let db_guard = self.database.lock().unwrap_or_else(|e| e.into_inner());
            db_guard
                .as_ref()
                .and_then(|db| db.load_speleo_undo_watermark().ok().flatten())
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
        // EXCEPT on a copy save, where dropping the row is the whole point: the
        // copy is a plain unmanaged project.
        // [#303] The chain position and the inherited-history watermark join the link
        // under the SAME guard, rather than each carrying their own: all three describe
        // this machine's relationship to the SERVER, so a copy that has deliberately shed
        // its link must shed them too. A copy that kept the watermark and was later linked
        // would have its own first push cut the user's history as "inherited". Grouped
        // because the per-site version of this rule has already been missed once.
        if !copy_only {
            if let Some(link) = &speleo_link {
                if let Err(e) = db.save_speleo_link(Some(link)) {
                    tracing::warn!(
                        error = %e,
                        purpose = "preserve SpeleoDB hand-off link on save",
                        "Failed to copy speleo_link onto the fresh save file"
                    );
                }
            }
            // [#303] ...and the Unwind chain position with it. Only written when one exists:
            // `None` is already the fresh file's state, and writing it unconditionally would
            // mean every save of every project touched this table for nothing.
            if let Some(sha) = &speleo_undo_chain {
                if let Err(e) = db.save_speleo_undo_chain(Some(sha)) {
                    tracing::warn!(
                        error = %e,
                        purpose = "preserve the Unwind chain position on save (#303)",
                        "Failed to copy speleo_undo_chain onto the fresh save file; the next \
                         Unwind will restart from BASE and may warn about un-pushed work that \
                         is only a previous Unwind's own doing"
                    );
                }
            }

            // [#303] Likewise the inherited-history watermark.
            if let Some(ts) = &speleo_undo_watermark {
                if let Err(e) = db.save_speleo_undo_watermark(Some(ts)) {
                    tracing::warn!(
                        error = %e,
                        purpose = "preserve the inherited-history watermark on save (#303)",
                        "Failed to copy speleo_undo_watermark onto the fresh save file; the next \
                         push would carry the loaded revision's history as if it had been \
                         authored in this session"
                    );
                }
            }
        }

        // A copy gets the undo/redo history too (into the temp handle, while it
        // is still open - the normal path writes them into the REOPENED db after
        // the rename, but a copy never reopens). This keeps Save a Copy a
        // faithful Save As minus the link, and it is what lets the detach flow
        // (convert to unmanaged) carry the edit history onto the file it then
        // opens.
        if copy_only {
            self.persist_undo_stacks_into(&db);
        }

        // Close the temp database before renaming
        drop(db);

        if copy_only {
            // The destination is provably NOT the live file (refused above), so
            // the live connection stays open, the session keeps its file_path and
            // database handle, and no cache is invalidated. Rename the temp into
            // place, list the copy, and report it via `unlinked_copy_path` -
            // deliberately NOT `saved_path`, which the frontend treats as "the
            // open project now lives here".
            if let Err(e) = std::fs::rename(&temp_path, &save_path) {
                let _ = std::fs::remove_file(&temp_path);
                let e = anyhow::Error::from(e);
                tracing::error!(
                    error = %e,
                    purpose = "write a detached unlinked copy",
                    "Failed to rename temp file to the copy destination"
                );
                return save_failure("Failed to finalize save", &save_path, &e);
            }
            drop(proj_guard);
            self.note_recent_project(&save_path);
            tracing::info!(
                path = ?save_path,
                purpose = "write a detached unlinked copy",
                "Saved an unlinked copy of a SpeleoDB-managed project"
            );
            return CommandResult::success()
                .with_unlinked_copy_path(save_path.display().to_string());
        }

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
        self.persist_undo_stacks_into(&db);

        // Update file path after successful save
        project.file_path = Some(save_path.clone());

        // Update database handle
        drop(proj_guard);
        if let Ok(mut database) = self.database.lock() {
            *database = Some(db);
        }

        // Clear in-memory cache since settings are now persisted to DB
        self.clear_display_settings_cache();
        self.invalidate_adjusted_cache();

        // Add to recent projects and persist to config
        self.note_recent_project(&save_path);

        let save_path_str = save_path.display().to_string();
        tracing::info!(
            path = ?save_path,
            purpose = "persist edits safely",
            "Project saved successfully"
        );
        CommandResult::success().with_path(save_path_str)
    }

    /// Persist the undo/redo stacks into `db`, best-effort (shared by the normal
    /// save, which writes them into the reopened destination, and the copy save,
    /// which writes them into the temp handle before the rename). Locks
    /// `undo_stack` only - callers may hold `project` (the established order is
    /// `project` before `undo_stack`).
    fn persist_undo_stacks_into(&self, db: &Database) {
        if let Ok(undo_stack) = self.undo_stack.lock() {
            let _ = self.persist_locked_undo_stacks_into(db, &undo_stack);
        }
    }

    /// Persist an already-locked stack. The confirmed-push path uses this while it
    /// holds the live database and undo guards, so no late edit can land between
    /// pruning memory and rewriting SQLite.
    pub(super) fn persist_locked_undo_stacks_into(
        &self,
        db: &Database,
        undo_stack: &UndoStack,
    ) -> bool {
        // [#303] A Full-mode SpeleoDB-linked project persists its WHOLE history (bounded
        // by the byte budget, not by a count) because that history is what rides in the
        // next commit and gives undo its cross-commit reach. Everything else - local
        // projects, Disabled mode - keeps the `undo_persist_limit` window unchanged.
        //
        // The link is read from the LOCAL `db` handle rather than through
        // `undo_policy()`: `self.database` still points at the pre-save handle when the
        // normal save calls this, so asking the AppState would consult the wrong file.
        let count_limit = {
            let policy = self.undo_policy_for(db.load_speleo_link().ok().flatten().as_ref());
            if policy.unlimited_depth() {
                None
            } else {
                Some(
                    self.config
                        .lock()
                        .map(|c| c.general.undo_persist_limit)
                        .unwrap_or(20),
                )
            }
        };

        // Every save writes the WHOLE (windowed) stack, because the pipeline above
        // built a fresh temp file and renamed it over the target: the reopened `db`
        // has no undo tables to add to. See `UndoStack::rows_to_persist`.
        let undo_rows = undo_stack.rows_to_persist(PersistStack::Undo, count_limit);

        // [#303] Redo is persisted in EVERY mode, including Full, where that means a
        // save can write up to 2x `UNDO_BYTE_BUDGET_BYTES` - the budget is applied to
        // the two stacks independently.
        //
        // That doubling is deliberate and was re-decided after review, so do not
        // "fix" it by skipping redo in Full mode: that change was made and reversed.
        // The reasoning is that 64 MiB is a CEILING, not growth - each stack is
        // bounded by the budget, and a confirmed push clears the undo history - and
        // that persisting redo is what keeps a redo branch alive across a close and
        // reopen. Dropping it bought a smaller save on exactly the projects whose
        // saves are largest, and cost redo-after-reopen on all of them, which is the
        // worse end of the trade.
        //
        // None of the redo half reaches the server either way: `redo_stack` is
        // unconditionally in `PUSH_SNAPSHOT_LOCAL_TABLES`, so this is local-only cost
        // for a local-only feature.
        let redo_rows = undo_stack.rows_to_persist(PersistStack::Redo, count_limit);

        let undo_saved = match db.save_undo_stack_with_timestamps(undo_rows) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "preserve undo history",
                    "Failed to persist undo stack"
                );
                false
            }
        };
        let redo_saved = match db.save_redo_stack_with_timestamps(redo_rows) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "preserve redo history",
                    "Failed to persist redo stack"
                );
                false
            }
        };
        undo_saved && redo_saved
    }

    /// Put `path` at the head of the recent-projects list and persist it to
    /// config. Takes no state locks other than `recent_projects` + `config`;
    /// callers must NOT hold `project` (the save paths drop it first).
    fn note_recent_project(&self, path: &Path) {
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != path);
            recent.insert(0, path.to_path_buf());
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
    }

    /// Drop the open project's resources.
    ///
    /// Every lock here is RECOVERED from poisoning rather than skipped. A poisoned
    /// mutex means some earlier call panicked while holding it; the guarded values
    /// are `Option<Project>` / `Option<Database>` / the undo stack, and setting
    /// them to `None`/empty is precisely the recovery - there is no half-written
    /// state to protect. Skipping the drop, by contrast, is never safe: this
    /// function is the pre-rename close that `close_project_if_open_at` relies on,
    /// and it used to report `true` while still holding the live SQLite handle and
    /// its 256 MB mmap, so the caller went on to rename a new file over it - the
    /// exact SIGBUS / `MoveFileEx`-denied hazard the guard exists to prevent.
    pub(super) fn close_project(&self) -> CommandResult {
        tracing::debug!("close_project: acquiring project lock");
        let mut proj = self.project.lock().unwrap_or_else(|e| e.into_inner());
        self.close_open_project_locked(&mut proj)
    }

    /// [`close_project`](Self::close_project)'s teardown, with the `project` guard
    /// supplied by the caller so that a caller which must first DECIDE whether to
    /// close can decide and close under ONE acquisition.
    ///
    /// `delete_project` is that caller: it closes only when the `.stalx` it is
    /// about to hand to the OS delete is the file backing the open project, and
    /// doing the check through `open_project_path` (which releases the lock) and
    /// only then calling `close_project` (which re-acquires it) is a TOCTOU - a
    /// load that finished installing a DIFFERENT project in that gap had ITS
    /// database handle and undo stack torn down while the delete went on to remove
    /// the original file.
    ///
    /// Holding `project` across the `database` and `undo_stack` acquisitions below
    /// is the ordering the rest of the state layer already uses - `save_project`
    /// holds its `project` guard while it takes both - and no path acquires either
    /// of those BEFORE `project`, so it cannot deadlock. Calling
    /// [`close_project`](Self::close_project) with the guard held, by contrast,
    /// would self-deadlock on its own first acquisition.
    ///
    /// The caller owns the poison recovery for the `project` lock (both of this
    /// function's callers use `PoisonError::into_inner`, for the reason spelled out
    /// on `close_project`); the locks taken here recover it themselves.
    pub(super) fn close_open_project_locked(&self, project: &mut Option<Project>) -> CommandResult {
        tracing::debug!("close_project: dropping project");
        *project = None;
        // A session boundary: the caller holds the `project` guard (it passed it
        // in), which is the bump rule (`speleodb_session`). Covers close, delete
        // and the project switch, which all route through here.
        self.bump_speleodb_session();
        tracing::debug!("close_project: project dropped");

        tracing::debug!("close_project: acquiring database lock");
        {
            let mut db = self.database.lock().unwrap_or_else(|e| e.into_inner());
            tracing::debug!("close_project: dropping database");
            *db = None;
            tracing::debug!("close_project: database dropped");
        }

        tracing::debug!("close_project: acquiring undo_stack lock");
        {
            let mut undo_stack = self.undo_stack.lock().unwrap_or_else(|e| e.into_inner());
            tracing::debug!("close_project: clearing undo stack");
            undo_stack.clear();
            // [#303] Back onto the configured entry window: the next project to open is
            // local until a link says otherwise.
            undo_stack.use_count_limit();
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

    /// The path of the `.stalx` currently open, when one is open and it has been
    /// saved somewhere (a never-saved project has no `file_path`).
    ///
    /// Recovers a poisoned lock rather than reporting "nothing open": every caller
    /// uses this to decide whether the live handle / live link belongs to a file it
    /// is about to touch, and answering "no" on a poisoned mutex is the unsafe
    /// direction in both.
    pub(super) fn open_project_path(&self) -> Option<PathBuf> {
        let guard = self.project.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().and_then(|p| p.file_path.clone())
    }

    /// Close the open project IF AND ONLY IF it is the file at `dest`; returns
    /// whether it was closed.
    ///
    /// Guards every path that REPLACES a `.stalx` on disk out from under the app
    /// (the SpeleoDB cache download-replace: pull / fast-forward / revision swap).
    /// Two reasons the live handle has to go first:
    ///
    /// - `Database::open_existing` enables a 256 MB mmap over the file. Truncating
    ///   or replacing a file that SQLite has mmap'd can fault the mapped pages
    ///   (SIGBUS) and hands the connection a torn view of a different database.
    /// - On Windows, SQLite opens the file WITHOUT `FILE_SHARE_DELETE`, so
    ///   `MoveFileEx(REPLACE_EXISTING)` over a live handle fails with "Access is
    ///   denied" - the same hazard the save pipeline's pre-rename close covers.
    ///
    /// Closing is deliberately conditional: these callers replace a file that is
    /// USUALLY, but not always, the open project (a pull can target a cached
    /// project the user does not currently have open), and dropping an unrelated
    /// open project would throw away its undo/redo history for nothing.
    pub(super) fn close_project_if_open_at(&self, dest: &Path) -> bool {
        let Some(open_path) = self.open_project_path() else {
            return false;
        };
        if !same_file(&open_path, dest) {
            return false;
        }
        tracing::info!(
            path = ?dest,
            purpose = "release the live handle before replacing the file",
            "Closing the open project because its .stalx is about to be replaced"
        );
        self.close_project();
        true
    }
}

/// Whether two paths denote the same file on disk.
///
/// Canonicalization resolves `.`/`..`, symlinks, and (on Windows) case/short-name
/// differences, so two spellings of the open project's path still compare equal.
/// When either side cannot be canonicalized - most commonly because `dest` does
/// not exist yet (a first pull into an empty cache) - it cannot be the file a live
/// connection is holding unless it is LITERALLY the same path, so fall back to a
/// plain comparison instead of guessing.
///
/// Shared with `speleodb_local_state`, where the same question ("is the open
/// project THIS file?") decides whether the live in-memory link may vouch for a
/// copy that could not be read.
pub(super) fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}
