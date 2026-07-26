use super::AppState;
use crate::core::CommandResult;
use crate::persistence::Database;
use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;

impl AppState {
    pub(super) fn open_project(&self, path: PathBuf) -> CommandResult {
        tracing::info!(
            path = ?path,
            purpose = "resume editing",
            "Opening project file"
        );
        // `try_exists()` rather than `exists()`: a metadata-access denial (e.g.
        // macOS folder-permission loss after an OS/app update) must not collapse to
        // a misleading "not found" - `exists()` would do exactly that. Parity with
        // `do_load_project_full` (#169 / #92 / #104). A denial is tagged with
        // `PERMISSION_DENIED_CODE`, matching the save path's `save_failure`.
        // NOTE: `open_project` is the legacy command - its frontend consumer
        // (`openProject`, projectStore.ts) does NOT strip the marker or run
        // `isPermissionError` (the load/save paths do). So this tag is currently
        // forward-compatible hardening, not live folder-access guidance; the
        // production UI opens via `loadProject` → `load_project_full`, whose
        // structured `LoadError::permission` is handled there.
        match path.try_exists() {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!(
                    path = ?path,
                    purpose = "resume editing",
                    reason = "file not found",
                    "Project open failed"
                );
                return CommandResult::failure(format!("File not found: {}", path.display()));
            }
            Err(e) => {
                let e = anyhow::Error::from(e);
                if crate::core::loading::is_permission_denied(&e) {
                    tracing::warn!(
                        path = ?path,
                        purpose = "resume editing",
                        reason = "permission denied",
                        "Project open failed"
                    );
                    return CommandResult::failure(format!(
                        "{}: Cannot access {}: {e}",
                        crate::core::loading::PERMISSION_DENIED_CODE,
                        path.display()
                    ));
                }
                tracing::warn!(
                    path = ?path,
                    purpose = "resume editing",
                    reason = %e,
                    "Project open failed (metadata access error)"
                );
                return CommandResult::failure(format!("File not found: {}", path.display()));
            }
        }

        // Use open_existing which validates the file is a valid Stalagmight project
        let db = match Database::open_existing(&path) {
            Ok(db) => db,
            Err(e) => {
                tracing::error!(
                    path = ?path,
                    purpose = "resume editing",
                    reason = %e,
                    "Failed to open project database"
                );
                return CommandResult::failure(format!("{e}"));
            }
        };

        let mut project = match db.load_project() {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(
                    path = ?path,
                    purpose = "resume editing",
                    reason = %e,
                    "Failed to load project data"
                );
                return CommandResult::failure(format!("Failed to load project data: {e}"));
            }
        };

        project.file_path = Some(path.clone());

        // Same legacy-seeding as do_load_project_full: a project with no stored
        // `validation` row gets the user's global thresholds, not the hardcoded
        // default.
        match db.load_project_validation() {
            Ok(None) => {
                project.validation = self.get_config().validation;
            }
            Ok(Some(_)) => {}
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "seed validation thresholds for legacy project",
                    "open_project: could not determine stored validation thresholds; keeping loaded value"
                );
            }
        }

        // Assign IDs to any legacy closures that have id=0
        project.assign_closure_ids();

        // Canonicalize the same way the production load path (do_load_project_full)
        // does: a pre-v6 file installed here otherwise keeps positional Index cross-
        // reference anchors live, and since inserts/deletes no longer shift positional
        // refs, a later edit would silently move a merge/datum/comment to the wrong
        // station - and the integrity check can't see an in-range Index ref. Mint
        // UUIDs, then re-anchor (Index→AfterShot) and re-solve offsets, so the two
        // load entry points can't diverge. (This legacy IPC has no production caller
        // today, but it stays registered and invokable, so harden it.)
        // Upgrade legacy NULL-uuid resolved-warning rows to UUID keying. Build the
        // map BEFORE minting so it contains only shots whose UUID is already
        // PERSISTED in the file: backfilling a freshly-minted, not-yet-saved UUID
        // would write it to resolved_warnings on open, and if the user then closes
        // WITHOUT saving, the next open mints a DIFFERENT UUID and orphans the
        // ignore (issue #57 / Codex). Pre-v6 shots keep position-keyed ignores
        // until a save persists their UUIDs and the save carry-over re-keys them.
        // Shared with do_load_project_full via Project::shot_uuid_by_position so the
        // two load entry points can't diverge. Idempotent; non-fatal.
        let live_shot_uuids = project.shot_uuid_by_position();
        project.ensure_shot_uuids();
        if let Err(e) = db.backfill_resolved_warning_uuids(&live_shot_uuids) {
            tracing::warn!(
                error = %e,
                purpose = "upgrade legacy ignores to UUID keying",
                "open_project: failed to backfill resolved-warning UUIDs; legacy rows remain position-keyed"
            );
        }
        let healed_offsets = project.redrive_offsets_after_load();
        if healed_offsets > 0 {
            tracing::warn!(
                healed_offsets,
                purpose = "self-heal on open",
                "open_project: corrected drifted section offsets on load"
            );
        }
        // The #27 one-shot backfill (see `do_load_project_full`) is deliberately
        // NOT replicated here. It is the one load-time step that WRITES, and
        // this path has no remote/read-only context to gate that on. Leaving the
        // flag set costs nothing: the kinds a migrated file opens with are the
        // migration's Jump seed either way, and the next open through the real
        // load path classifies and persists them. Classifying in memory here
        // without persisting would only make the two paths disagree.

        if let Ok(mut proj) = self.project.lock() {
            *proj = Some(project);
        }

        // Load undo/redo stacks from database before replacing database reference
        let undo_entries = match db.load_undo_stack_with_timestamps() {
            Ok(loaded) => loaded
                .into_iter()
                .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "restore edit history",
                    "Failed to load undo stack from database; starting with empty history"
                );
                Vec::new()
            }
        };
        let redo_entries = match db.load_redo_stack_with_timestamps() {
            Ok(loaded) => loaded
                .into_iter()
                .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "restore edit history",
                    "Failed to load redo stack from database; starting with empty redo history"
                );
                Vec::new()
            }
        };

        // [Track B] (#191) Read-only edit gate: remote ⇒ edit disabled,
        // local-only ⇒ enabled (see do_load_project_full). Read before `db` moves.
        let is_remote = matches!(db.load_speleo_link(), Ok(Some(_)));
        self.set_edit_enabled(!is_remote);
        // #213: force-edit is per-session; a fresh open never starts force-editing.
        self.set_force_editing(false);

        if let Ok(mut database) = self.database.lock() {
            *database = Some(db);
        }
        // Opened an existing project from disk - its initial save is not deferred.
        self.initial_save_deferred
            .store(false, std::sync::atomic::Ordering::Relaxed);

        // Clear display settings cache (settings will be loaded from DB by frontend)
        self.clear_display_settings_cache();
        self.invalidate_adjusted_cache();

        // Restore persisted undo/redo stacks
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            if undo_entries.is_empty() && redo_entries.is_empty() {
                undo_stack.clear();
            } else {
                undo_stack.load_from_persisted_with_timestamps(undo_entries, redo_entries);
                tracing::info!(
                    undo = undo_stack.len(),
                    purpose = "restore edit history",
                    "Restored undo/redo stacks from database"
                );
            }
        }

        // Add to recent projects and persist to config
        let path_display = format!("{}", path.display());
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.retain(|p| p != &path);
            recent.insert(0, path);
            if let Ok(mut config) = self.config.lock() {
                recent.truncate(config.general.recent_projects_max);
                // Update config with recent projects and save
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

        tracing::info!(
            path = %path_display,
            purpose = "resume editing",
            "Project opened"
        );
        CommandResult::success()
    }

    /// Load a project with full progress reporting.
    /// This is the main implementation used by load_project_full command.
    ///
    /// All computation happens locally, then state is committed at the end.
    /// Cancellation is honored up to finalization; once finalization begins, it is
    /// non-cancellable to avoid partial AppState updates.
    pub fn do_load_project_full(
        &self,
        path: PathBuf,
    ) -> Result<crate::core::loading::LoadProjectFullResult, crate::core::loading::LoadError> {
        use crate::core::loading::{
            DisplaySettings, LoadError, LoadProjectFullResult, LoadingPhase, ProgressEmitter,
        };

        let handle = self
            .get_app_handle()
            .ok_or_else(|| LoadError::internal("AppHandle not initialized"))?;

        tracing::info!(
            path = ?path,
            purpose = "load project for workspace",
            "Starting full project load"
        );

        // Check if the same project is already open (avoid unnecessary reload)
        if let Ok(proj_guard) = self.project.lock() {
            if let Some(ref project) = *proj_guard {
                if project.file_path.as_ref() == Some(&path) {
                    return Err(LoadError::already_open());
                }
            }
        }

        // Start new load - cancels any existing load
        // Store the token for identity-safe clearing later
        let cancel_token = self.start_new_load();
        let mut progress = ProgressEmitter::new_for_open(handle, Arc::clone(&cancel_token));

        // Helper macro for early return with identity-safe token clearing
        macro_rules! check_cancelled {
            () => {
                if progress.is_cancelled() {
                    self.clear_active_load(&cancel_token);
                    return Err(LoadError::cancelled());
                }
            };
        }

        macro_rules! early_return_err {
            ($err:expr) => {{
                self.clear_active_load(&cancel_token);
                return Err($err);
            }};
        }

        // === PHASE 0: Opening database (5%) ===
        progress.start_phase(LoadingPhase::OpeningDatabase);
        // `try_exists()` rather than `exists()`: a metadata-access denial
        // (macOS folder permission) must surface guidance, not NOT_FOUND -
        // `exists()` would collapse that error to `false`.
        match path.try_exists() {
            Ok(true) => {}
            Ok(false) => {
                early_return_err!(LoadError::not_found(&path.display().to_string()))
            }
            Err(e) => {
                let e = anyhow::Error::from(e);
                if crate::core::loading::is_permission_denied(&e) {
                    early_return_err!(LoadError::permission(
                        e.to_string(),
                        &path.display().to_string()
                    ));
                }
                early_return_err!(LoadError::not_found(&path.display().to_string()));
            }
        }
        // Local variable only - NO state mutation until Finalizing
        let db = match Database::open_existing(&path) {
            Ok(db) => db,
            Err(e) => {
                let msg = e.to_string();
                // A permission denial (e.g. macOS forgot folder access after an
                // update) otherwise masquerades as corruption - check it first.
                if crate::core::loading::is_permission_denied(&e) {
                    early_return_err!(LoadError::permission(msg, &path.display().to_string()));
                }
                // Detect corruption-specific errors and return CORRUPT code
                // so the frontend can offer recovery options
                if msg.contains("integrity check failed") || msg.contains("corrupted") {
                    early_return_err!(LoadError::corrupt(msg, &path.display().to_string()));
                }
                early_return_err!(LoadError::new("DATABASE", msg));
            }
        };
        check_cancelled!();
        progress.complete_phase(LoadingPhase::OpeningDatabase);

        // === PHASE 1: Loading project data (20%) ===
        progress.start_phase(LoadingPhase::LoadingProjectData);
        let mut project = match db.load_project() {
            Ok(p) => p,
            Err(e) => {
                early_return_err!(LoadError::new("DATABASE", e.to_string()));
            }
        };
        project.file_path = Some(path.clone());
        // Legacy projects (saved before #57) have no persisted `validation` row;
        // load_project() filled `project.validation` with the hardcoded default.
        // Override it with the user's GLOBAL thresholds (the "defaults for new
        // projects"), matching create_project/merge. The choice persists on the
        // next save (save_project writes the row), so a project is only treated
        // as legacy until its first save under this build.
        match db.load_project_validation() {
            Ok(None) => {
                project.validation = self.get_config().validation;
            }
            Ok(Some(_)) => {} // explicit row present - honor it as-is
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "seed validation thresholds for legacy project",
                    "Could not determine whether project has stored validation thresholds; keeping loaded value"
                );
            }
        }
        // Upgrade legacy NULL-uuid resolved-warning rows to UUID keying. Build the
        // map BEFORE minting so it only contains shots whose UUID is already
        // PERSISTED: a freshly-minted, not-yet-saved UUID written into
        // resolved_warnings on open would be orphaned if the user closes without
        // saving (the next open mints a different UUID) - issue #57 / Codex. Pre-v6
        // shots keep position-keyed ignores until a save persists their UUIDs and
        // the carry-over re-keys them. Shared with open_project. Idempotent; non-fatal.
        let live_shot_uuids = project.shot_uuid_by_position();
        // Guarantee every shot has a stable UUID at runtime, not just after the
        // next save: pre-v6 files load shots with uuid=None, and station identity
        // (and the Ariane collaboration round-trip) anchors on the shot UUID. The
        // minted UUIDs persist on the next save (matching save_project's call).
        project.ensure_shot_uuids();
        match db.backfill_resolved_warning_uuids(&live_shot_uuids) {
            Ok(n) if n > 0 => tracing::info!(
                upgraded = n,
                purpose = "upgrade legacy ignores to UUID keying",
                "Backfilled resolved-warning UUIDs on load"
            ),
            Ok(_) => {}
            Err(e) => tracing::warn!(
                error = %e,
                purpose = "upgrade legacy ignores to UUID keying",
                "Failed to backfill resolved-warning UUIDs; legacy rows remain position-keyed"
            ),
        }
        // Assign IDs to any legacy closures that have id=0
        project.assign_closure_ids();
        // Section offsets are derived state: re-solve them from the merge/datum
        // constraints so a file persisted with drifted offsets (e.g. from an
        // older redo bug) opens geometrically correct, before stations are
        // computed below. No-op for an already-consistent file.
        let healed_offsets = project.redrive_offsets_after_load();
        if healed_offsets > 0 {
            tracing::warn!(
                healed = healed_offsets,
                purpose = "self-heal derived geometry on load",
                "Re-derived drifted section offsets while opening project"
            );
        }
        // One-shot #27 backfill. The v12->v13 migration seeded every legacy
        // `is_reference` row as Jump, which is only q2's guess; the real verdict
        // needs sections + merges + closures assembled, which is exactly what we
        // have now and the bare migration connection did not. Runs once, then
        // clears its own flag: classification is import-time only (q14), so a
        // later merge must never silently re-flip a kind.
        if db.is_kind_classification_pending() {
            let reclassified =
                project.classify_virtual_shots(&crate::models::ClassifyScope::WholeProject);
            tracing::info!(
                reclassified,
                purpose = "one-shot #27 Jump/Reference backfill after v12->v13 migration",
                "Classified virtual shots on first open after migration"
            );
            // Write the verdicts through and clear the flag together. The pass
            // only touched the in-memory project, so clearing the flag on its
            // own would burn the one retry on a result that dies with the
            // process if the user closes without saving - and the next open
            // would then keep the migration's Jump seed for good.
            //
            // Addressed by (section_id, sequence_order), which is what the rows
            // are keyed by on disk - `Shot::id` is a synthesised in-memory value
            // and would hit the wrong rows. Virtual shots only: `Normal` is what
            // the migration already wrote for every non-legacy-reference row, so
            // re-stamping them would be one UPDATE per shot in the project on a
            // load that is already paying for the schema migration.
            //
            // Runs for a remote project too, deliberately. Gating it on
            // `load_speleo_link()` looks safer - `shots.kind` rides in the push
            // snapshot, so writing on a lock-free open diverges the local .stalx
            // from BASE - but that predicate is true whether or not the user
            // holds the lock, so the flag would never clear and this pass would
            // re-run on EVERY open. Being project-wide, it cannot tell the
            // migration's Jump seed from a kind the user set by hand, so each
            // reopen would silently revert their choice and restore exactly the
            // unsafe shortcut #27 exists to remove. A one-time local write whose
            // values are what the classifier is meant to land - and which the
            // v12->v13 migration has already rewritten this file's schema
            // without a lock to produce - is the smaller hazard by a wide margin.
            //
            // `shot.id % FEATURE_ID_STRIDE`, not the enumerate() index: the
            // loader reads `ORDER BY section_id, sequence_order` and pushes
            // sequentially, so the index is the shot's RANK, while the id
            // carries the raw stored `sequence_order` (read.rs synthesises
            // `section_id * FEATURE_ID_STRIDE + seq` from the column). They
            // differ the moment a legacy file has a gap in the sequence, and
            // a miss here is permanent because the flag is cleared with it.
            let verdicts: Vec<_> = project
                .sections
                .iter()
                .flat_map(|section| {
                    section
                        .shots
                        .iter()
                        .filter(|shot| shot.kind.is_virtual())
                        .map(|shot| {
                            (
                                section.id,
                                shot.id % crate::models::FEATURE_ID_STRIDE,
                                shot.kind,
                            )
                        })
                })
                .collect();
            if let Err(e) = db.persist_backfilled_shot_kinds(&verdicts) {
                // Non-fatal: the flag is cleared in the same transaction as
                // the writes, so a failure here leaves both undone and the
                // (idempotent) backfill simply runs again on the next open.
                tracing::warn!(
                    error = %e,
                    purpose = "one-shot #27 Jump/Reference backfill after v12->v13 migration",
                    "Failed to persist backfilled shot kinds; will retry on next open"
                );
            }
        }

        progress.update_phase(LoadingPhase::LoadingProjectData, 1, 1);
        check_cancelled!();
        progress.complete_phase(LoadingPhase::LoadingProjectData);

        // === PHASE 2: Loading sections (15%) ===
        progress.start_phase(LoadingPhase::LoadingSections);
        let total_sections = project.sections.len() as u32;
        for (i, _section) in project.sections.iter().enumerate() {
            check_cancelled!();
            progress.update_phase(LoadingPhase::LoadingSections, i as u32 + 1, total_sections);
        }
        progress.complete_phase(LoadingPhase::LoadingSections);

        // === PHASE 3: Computing stations (20%) ===
        progress.start_phase(LoadingPhase::ComputingStations);
        // Pre-compute the expected station total so the UI can show a real
        // progress bar from the start of this phase. Otherwise the first
        // ~second of the phase (build_colocated_groups + station_depths)
        // shows an indeterminate spinner - the per-station callback only
        // fires once the main walk begins.
        let expected_station_total: u32 = project
            .sections
            .iter()
            .map(|s| s.shots.len() as u32 + 1)
            .sum();
        progress.update_phase(LoadingPhase::ComputingStations, 0, expected_station_total);
        let stations =
            project.compute_station_coordinates_with_progress(Some(&mut |current, total| {
                if !progress.is_cancelled() {
                    progress.update_phase(LoadingPhase::ComputingStations, current, total);
                }
            }));
        check_cancelled!();
        progress.complete_phase(LoadingPhase::ComputingStations);

        // === PHASE 4: Computing statistics (15%) - INDETERMINATE ===
        progress.start_phase(LoadingPhase::ComputingStatistics);
        // Reference ties are not swimmable, so penetration excludes them unless
        // the user opts them back in (#27 q13).
        let include_reference_legs = self.get_config().gas.include_reference_legs;
        // Heartbeat at start to indicate phase is active
        progress.heartbeat(LoadingPhase::ComputingStatistics);
        let mut stats = project.stats();
        // Calculate penetration distance with computed stations
        stats.penetration_distance =
            project.calculate_penetration_with(&stations, include_reference_legs);
        // Heartbeat after computation to indicate work completed
        progress.heartbeat(LoadingPhase::ComputingStatistics);
        check_cancelled!();
        progress.complete_phase(LoadingPhase::ComputingStatistics);

        // === PHASE 5: Validating data (10%) ===
        // Compute warnings using the local db reference (before finalization)
        progress.start_phase(LoadingPhase::ValidatingData);
        let warnings = self.compute_project_warnings(&project, Some(&db));

        // Surface corruption present on disk (older versions / external edits /
        // a missed offset cascade): both dangling references and drifted merges.
        // The frontend re-checks after load and offers a repair; here we just
        // record it. (#17, merge-misalignment)
        let mut integrity = project.check_structural_integrity();
        integrity.extend(project.check_merge_alignment());
        if !integrity.is_empty() {
            tracing::warn!(
                count = integrity.len(),
                purpose = "flag corruption on load",
                "Loaded project has integrity violations"
            );
            for violation in &integrity {
                tracing::warn!(category = %violation.category, "{}", violation.message);
            }
        }

        progress.heartbeat(LoadingPhase::ValidatingData);
        check_cancelled!();
        progress.complete_phase(LoadingPhase::ValidatingData);

        // === PHASE 6: Loading settings (5%) ===
        progress.start_phase(LoadingPhase::LoadingSettings);
        let stored_settings = db.load_display_settings().unwrap_or_default();
        let display_settings = DisplaySettings::from_stored(&stored_settings);
        check_cancelled!();
        progress.complete_phase(LoadingPhase::LoadingSettings);

        // === PHASE 7: Finalizing (10%) - NON-CANCELLABLE STATE COMMIT ===
        progress.start_phase(LoadingPhase::Finalizing);
        // Allow cancellation only before any state mutation occurs.
        check_cancelled!();

        // Load undo/redo stacks from database BEFORE storing db
        let undo_entries = match db.load_undo_stack_with_timestamps() {
            Ok(loaded) => loaded
                .into_iter()
                .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "restore edit history",
                    "Failed to load undo stack from database; starting with empty history"
                );
                Vec::new()
            }
        };
        let redo_entries = match db.load_redo_stack_with_timestamps() {
            Ok(loaded) => loaded
                .into_iter()
                .map(|(_, cmd, undo, ts)| (cmd, undo, ts))
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    purpose = "restore edit history",
                    "Failed to load redo stack from database; starting with empty redo history"
                );
                Vec::new()
            }
        };

        // All finalization commits use unwrap_or_else(PoisonError::into_inner) to ensure
        // data is written even if a previous panic poisoned a mutex. This is acceptable
        // during finalization because the alternative (silently skipping) leads to
        // inconsistent state that is harder to diagnose.

        // [Track B] (fix M1) Swapping to a DIFFERENT project while still holding the
        // OLD project's SpeleoDB write lock must release that lock, or it stays locked
        // for every other editor until the app quits - `close_project`/quit release,
        // but a direct open (Ctrl+O, Open-from-SpeleoDB, recents, discard-and-open)
        // routes here without a close. Done in this non-cancellable finalize section
        // (so a failed/cancelled load never releases), reading the OLD link BEFORE the
        // database/gate are swapped below, and detached so it can't stall opening the
        // new project on the old server. A same-project fast-forward reload doesn't
        // reach here (it `close_project`s first, clearing the link) and the "already
        // open" guard rejects reopening the same path, so neither releases our lock.
        self.speleodb_release_held_lock_detached();

        // Commit 1: Project state mutation
        *self
            .project
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(project.clone());

        // [Track B] (#191) Read-only edit gate: a remote SpeleoDB project (one
        // carrying a speleo_link row) opened WITHOUT a write lock is read-only.
        // There is no lock-acquire path yet (#191), so the rule is simply: remote
        // ⇒ edit disabled; local-only ⇒ edit enabled (default-true; the gate is a
        // no-op off-SpeleoDB). Read before `db` is moved into the handle slot.
        let is_remote = matches!(db.load_speleo_link(), Ok(Some(_)));
        self.set_edit_enabled(!is_remote);
        // #213: force-edit is per-session; a fresh open never starts force-editing.
        self.set_force_editing(false);

        // Commit 2: Database handle mutation
        *self
            .database
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(db);
        // Loaded an existing project from disk - its initial save is not deferred.
        self.initial_save_deferred
            .store(false, std::sync::atomic::Ordering::Relaxed);

        // Commit 3: Display settings cache clear
        self.clear_display_settings_cache();
        self.invalidate_adjusted_cache();

        // Commit 4: Undo/redo stack restore
        {
            let mut undo_stack = self
                .undo_stack
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if undo_entries.is_empty() && redo_entries.is_empty() {
                undo_stack.clear();
            } else {
                undo_stack.load_from_persisted_with_timestamps(undo_entries, redo_entries);
                tracing::info!(
                    undo = undo_stack.len(),
                    purpose = "restore edit history",
                    "Restored undo/redo stacks from database"
                );
            }
        }

        // Commit 5: Recent projects update
        {
            let mut recent = self
                .recent_projects
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            recent.retain(|p| p != &path);
            recent.insert(0, path.clone());
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

        progress.complete_phase(LoadingPhase::Finalizing);

        // Get loading_id before clearing token
        let loading_id = progress.loading_id();

        // Clear active load AFTER all mutations and computations complete
        self.clear_active_load(&cancel_token);

        tracing::info!(
            path = ?path,
            purpose = "load project for workspace",
            "Project loaded via load_project_full"
        );

        Ok(LoadProjectFullResult {
            loading_id,
            project,
            stations,
            stats,
            warnings,
            display_settings,
        })
    }
}
