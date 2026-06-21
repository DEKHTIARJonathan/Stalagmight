use std::sync::Mutex;

use crate::core::{
    Command, CommandResult, CommentHolder, IntegrityCheckResult, IntegrityRepairResult, UndoData,
    Validator,
};
use crate::models::{
    shot_display_position, ClosureStrategy, ConnectivityResult, Coordinates, GpsCoordinates,
    Project, SectionData, SectionId, SectionUpdates, ShotData, ShotId, ShotUpdates, StationKey,
    StationRef, ViolationSeverity, FEATURE_ID_STRIDE,
};

use super::AppState;

/// RAII guard for [`Project::cascade_deferred`].
///
/// `execute_import_sections` flips the flag on so each per-section
/// `merge_stations` skips its O(N) cascade, then runs ONE cascade at the
/// end.  If the apply loop panics (poisoning the mutex) or any code path
/// returns early without clearing the flag, every subsequent command
/// silently skips its cascade and accumulates section-offset drift.  The
/// guard's `Drop` resets the flag to `false` even through a poisoned
/// mutex, closing that window.
///
/// Call [`Self::disarm`] before the final cascade so the cascade is
/// actually allowed to run (the cascade itself early-exits when the flag
/// is still `true`).  After `disarm`, `Drop` is a no-op.
struct CascadeDeferGuard<'a> {
    project: &'a Mutex<Option<Project>>,
    armed: bool,
}

impl<'a> CascadeDeferGuard<'a> {
    /// Set `cascade_deferred = true` on the project (if present) and
    /// return a guard.  If the lock is already poisoned the flag is set
    /// anyway via `into_inner` — the import is about to run regardless,
    /// and we still want the Drop reset to fire.
    fn arm(project: &'a Mutex<Option<Project>>) -> Self {
        Self::set_flag(project, true);
        Self {
            project,
            armed: true,
        }
    }

    /// Clear the flag now (allowing the final cascade to run) and skip
    /// the Drop reset.
    fn disarm(mut self) {
        Self::set_flag(self.project, false);
        self.armed = false;
    }

    fn set_flag(project: &Mutex<Option<Project>>, value: bool) {
        let mut guard = match project.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(p) = guard.as_mut() {
            p.cascade_deferred = value;
        }
    }
}

impl<'a> Drop for CascadeDeferGuard<'a> {
    fn drop(&mut self) {
        if self.armed {
            // Reset on the panic / early-return path.  `set_flag` tolerates
            // a poisoned mutex so the flag is cleared even if the apply
            // loop panicked while holding the lock.
            Self::set_flag(self.project, false);
        }
    }
}

/// The integrity-relevant capabilities of a [`Command`], declared in ONE place
/// ([`AppState::command_integrity`]). The `execute()` epilogue reads these flags
/// instead of three separate hand-maintained allow/deny lists, so a new command
/// variant can't silently skip an integrity step.
#[derive(Debug, Clone, Copy)]
struct CommandIntegrity {
    /// Can drift section offsets (move merged partners out of alignment) and so
    /// needs the post-command geometry reconcile. Pure metadata/lifecycle edits
    /// cannot, so they skip it.
    affects_geometry: bool,
    /// Can introduce a dangling/out-of-range cross-reference — by removing a
    /// referenced entity or renumbering station indices — and so needs the
    /// (expensive) whole-project rollback snapshot to reject corruption at the
    /// source. Geometry-only commands add valid refs or shift offsets but cannot
    /// dangle a reference, so they skip the serialize.
    can_dangle_refs: bool,
    /// Can REMOVE connectivity and strand a section so its only attachment is a
    /// loop closure — which must then be converted to a merge (issue #8). Commands
    /// that add or keep connectivity are excluded (a move must leave an inert
    /// closure independent).
    can_orphan_closures: bool,
}

impl AppState {
    /// Declare every command's integrity-relevant capabilities in one exhaustive
    /// match, so adding a [`Command`] variant FORCES a decision here (the compiler
    /// rejects a non-exhaustive match) rather than silently defaulting across three
    /// separate allow/deny lists — where a miss fails open: a skipped rollback
    /// snapshot commits corruption, a missing reconcile leaves merges drifted, and
    /// a missing orphan-closure conversion leaves a phantom loop closure.
    fn command_integrity(cmd: &Command) -> CommandIntegrity {
        use Command::*;
        // Named profiles keep the table readable; every variant maps to exactly one.
        const INERT: CommandIntegrity = CommandIntegrity {
            affects_geometry: false,
            can_dangle_refs: false,
            can_orphan_closures: false,
        };
        const GEOMETRY_ONLY: CommandIntegrity = CommandIntegrity {
            affects_geometry: true,
            can_dangle_refs: false,
            can_orphan_closures: false,
        };
        const REMOVES: CommandIntegrity = CommandIntegrity {
            affects_geometry: true,
            can_dangle_refs: true,
            can_orphan_closures: true,
        };
        const CREATE_SHOT: CommandIntegrity = CommandIntegrity {
            affects_geometry: true,
            can_dangle_refs: true,
            can_orphan_closures: false,
        };
        const UNMERGE: CommandIntegrity = CommandIntegrity {
            affects_geometry: true,
            can_dangle_refs: false,
            can_orphan_closures: true,
        };
        match cmd {
            // Lifecycle + pure metadata edits: touch no geometry and no refs.
            // RepairIntegrity never runs through execute() (it records its own
            // snapshot-pair undo and returns failure here), so its flags are never
            // read; grouped here as it disturbs nothing.
            CreateProject { .. }
            | OpenProject { .. }
            | SaveProject { .. }
            | CloseProject
            | UpdateSectionMetadata { .. }
            | SetShotReference { .. }
            // Station comments are metadata keyed by station identity; they are
            // never geometry-derived and can never introduce merge drift, so they
            // must NOT run the reconcile epilogue. Classifying them GEOMETRY_ONLY
            // would heal an already-drifted project as a side effect of a comment
            // edit, while their undo (restore the previous comment) does not invert
            // that geometry change — an asymmetric undo.
            | SetStationComment { .. }
            | MoveComment { .. }
            | RepairIntegrity
            | UpdateProjectSettings => INERT,

            // Remove an entity / renumber stations: can dangle refs AND strand a
            // section behind a sole-bridge closure.
            DeleteSection { .. } | DeleteShot { .. } | Batch { .. } | MergeProjects { .. } => REMOVES,

            // Inserting a shot renumbers later stations (can dangle a positional
            // ref) but cannot strand a section.
            CreateShot { .. } => CREATE_SHOT,

            // Unmerge removes connectivity (can strand a section) but adds no
            // dangling reference.
            UnmergeStations { .. } | UnmergeStationPair { .. } => UNMERGE,

            // Everything else shifts geometry but keeps refs valid and connectivity
            // intact, so it needs only the reconcile. UpdateShot belongs here too: a
            // length/azimuth/depth edit moves stations, and its bespoke
            // realign_after_shot_edit no-ops on a merge group with no zero datum, so
            // without the reconcile epilogue a shot edit upstream of a datum-less
            // merge would leave the partners drifted until a later load/repair.
            CreateSection { .. }
            | UpdateShot { .. }
            | MergeStations { .. }
            | CreateLoopClosure { .. }
            | RemoveLoopClosure { .. }
            | SetZeroDatum { .. }
            | RemoveZeroDatum { .. }
            | MoveSection { .. }
            | MoveSegment { .. }
            | MoveStation { .. }
            | ApplyCollabChanges => GEOMETRY_ONLY,
        }
    }

    /// Whether a *specific* command instance warrants the geometry-reconcile
    /// epilogue. Refines the per-variant [`CommandIntegrity::affects_geometry`]
    /// flag with a per-instance check for [`Command::UpdateShot`]: the same
    /// command carries both geometry edits (length/azimuth/depth/pitch — must
    /// reconcile) and pure metadata edits (comment/LRUD/reference — must NOT).
    /// Running the reconcile on a metadata-only edit would heal an already-drifted
    /// project as a side effect, while its undo only restores the metadata — the
    /// same asymmetric undo that keeps `SetStationComment` INERT (see
    /// `command_integrity`). The variant flag stays `true` (it CAN move stations);
    /// only the epilogue decision is instance-aware.
    ///
    /// A [`Command::Batch`] inherits the union of its members, so a metadata-only
    /// batch (a multi-cell comment/LRUD paste) skips the reconcile at BOTH the
    /// inner `execute_batch` epilogue and the outer `execute` epilogue that re-runs
    /// it — otherwise the outer pass would heal the drift the inner pass left.
    fn cmd_affects_geometry(cmd: &Command) -> bool {
        match cmd {
            Command::UpdateShot { updates, .. } => updates.touches_geometry(),
            Command::Batch { commands } => commands.iter().any(Self::cmd_affects_geometry),
            other => Self::command_integrity(other).affects_geometry,
        }
    }

    /// Convert any sole-bridge loop closures in the open project to merges.
    fn convert_orphan_closures_in_open_project(&self) {
        let mut guard = match self.project.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(project) = guard.as_mut() else {
            return;
        };
        let converted = project.convert_orphan_closures_to_merges();
        if converted > 0 {
            tracing::info!(
                converted,
                purpose = "enforce closures-are-loops invariant",
                "Converted sole-bridge loop closures to merges after a removal"
            );
        }
    }

    /// True iff the open project currently holds a Critical integrity violation.
    pub(super) fn project_has_critical(&self) -> bool {
        self.project
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(Project::has_critical_integrity_violations))
            .unwrap_or(false)
    }

    /// Integrity gate shared by [`Self::execute`] and [`Self::execute_batch`]: if
    /// the project was clean before (`!pre_had_critical`) but the command made it
    /// Critical, roll back to `snapshot` and return the standard "blocked"
    /// failure; otherwise return `None` and let the caller proceed. Corruption
    /// must be rejected BEFORE any undo entry is pushed, or a later undo+redo
    /// would reinstate the corrupt state the guard rejected (#1).
    fn guard_introduced_corruption(
        &self,
        pre_had_critical: bool,
        snapshot: &str,
        cmd_desc: &str,
    ) -> Option<CommandResult> {
        if pre_had_critical || !self.project_has_critical() {
            return None;
        }
        self.rollback_project(snapshot);
        tracing::error!(
            command = cmd_desc,
            purpose = "block corruption at the source",
            "Rejected command that would corrupt survey structure; rolled back"
        );
        Some(CommandResult::failure(
            "Blocked: this action would corrupt the survey structure \
             (it leaves dangling references). No changes were made."
                .to_string(),
        ))
    }

    /// Shared structural-edit epilogue for the custom `execute_*` paths that
    /// bypass [`Self::execute`]'s gated epilogue (collab apply, TML import).
    /// Converts sole-bridge closures to merges and reconciles derived offsets,
    /// then reports whether this edit INTRODUCED a CRITICAL integrity violation
    /// (dangling ref / out-of-range index / non-finite geometry). A caller that
    /// captured a pre-edit snapshot rolls back to it when this returns `true`,
    /// giving these paths the same "block corruption at the source" guarantee the
    /// standard command path gets (#integrity Root 4).
    ///
    /// `pre_had_critical` is the project's critical state BEFORE the edit. Matching
    /// `guard_introduced_corruption` / `execute`, an already-critical project (one
    /// opened with a dangling ref or non-finite shot — permitted; the banner offers
    /// Repair) does not block an otherwise-clean collab apply / import: only NEWLY
    /// introduced corruption rolls back.
    pub(super) fn finalize_structural_edit(&self, pre_had_critical: bool) -> bool {
        self.convert_orphan_closures_in_open_project();
        self.reconcile_geometry();
        if pre_had_critical {
            return false;
        }
        self.project
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(Project::has_critical_integrity_violations))
            .unwrap_or(false)
    }

    /// Structural-integrity violation messages for the open project, critical
    /// first. Empty when the project is sound or none is open. Used by the
    /// load-time "warn and offer repair" surface.
    pub fn integrity_violation_messages(&self) -> Vec<String> {
        self.integrity_check().messages
    }

    /// Full integrity check for the open project: the violation messages
    /// (critical first; empty = sound) plus whether the project is currently
    /// save-blocked (has unresolvable cross-references — the exact condition that
    /// refuses both manual and auto-save). The frontend uses `save_blocked` to keep
    /// the integrity banner non-dismissable while saving is blocked, so the Repair
    /// entry point can't be hidden on a project that can't be saved.
    pub fn integrity_check(&self) -> IntegrityCheckResult {
        let Some(project) = self.get_project_state() else {
            return IntegrityCheckResult::default();
        };
        // Structural (dangling refs) + geometric (drifted merges + stale,
        // still-marked-closed loop closures) + topological (a closure that is
        // really a sole-bridge merge).
        let mut violations = project.check_structural_integrity();
        violations.extend(project.check_merge_alignment());
        violations.extend(project.check_closure_alignment());
        violations.extend(project.check_orphan_closures());
        violations.sort_by_key(|v| match v.severity {
            ViolationSeverity::Critical => 0,
            ViolationSeverity::Warning => 1,
        });
        IntegrityCheckResult {
            save_blocked: project.has_unresolvable_cross_references(),
            messages: violations.into_iter().map(|v| v.message).collect(),
        }
    }

    /// Repair the open project's integrity: drop dangling refs/orphans, re-mint
    /// duplicate shot UUIDs, then re-cascade section offsets so drifted merges
    /// line up again. Returns `{ fixed, remaining }` measured as the change in
    /// the FULL violation set (the same set the banner counts), so the reported
    /// numbers match what the user sees. `remaining > 0` means some issues are
    /// detect-only and need manual attention (a drifted aligned loop closure to
    /// recompute/remove; non-finite shot geometry to correct).
    pub fn repair_open_project_integrity(&self) -> IntegrityRepairResult {
        // Serialize against execute()/undo()/redo() for the WHOLE operation. Repair
        // captures before_snapshot, mutates, and pushes a snapshot-pair undo across
        // several independent project locks; without command_lock a concurrent
        // command could commit a mutation in the window between before_snapshot and
        // repair's own mutation, so undoing the Repair would restore a stale `before`
        // and silently drop that command's changes. Deadlock-safe: none of the
        // helpers repair calls take command_lock (execute holds it while calling the
        // same capture/snapshot/undo helpers).
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return IntegrityRepairResult {
                fixed: 0,
                remaining: 0,
                changed: false,
            };
        };
        // Count over the full violation set before repairing. Locks the project
        // internally, so it must run with no project guard held.
        let before = self.integrity_violation_messages().len();
        // Snapshot the project BEFORE mutating so the repair can be undone: it
        // drops dangling refs, re-mints duplicate UUIDs and re-cascades offsets,
        // all reversible by restoring this snapshot. (capture locks the project
        // internally, so take it with no guard held.)
        let before_snapshot = self.capture_project_snapshot().ok();
        {
            let mut guard = match self.project.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            let Some(project) = guard.as_mut() else {
                return IntegrityRepairResult {
                    fixed: 0,
                    remaining: 0,
                    changed: false,
                };
            };
            // Drop dangling refs/orphans and re-mint duplicate shot UUIDs.
            project.repair_structural_integrity();
            // Dropping refs may have cleared the adjacency cache; rebuild before
            // the cascade walks the merge graph.
            project.rebuild_merge_adjacency();
            // Turn any sole-bridge closure into a merge (a closure is only a
            // loop), then re-derive offsets. Repair is an explicit "fix my
            // project" action, so use the zero-trust re-solve that never honors a
            // persisted offset.
            project.convert_orphan_closures_to_merges();
            project.resolve_offsets();
        } // release the guard before re-measuring (integrity_violation_messages re-locks)
          // Repair mutated measured geometry (and convert_orphan_closures_to_merges
          // doesn't bump modified_at), so drop any cached closure-adjusted solve.
        self.invalidate_adjusted_cache();
        let after = self.integrity_violation_messages().len();
        // Record an undo entry (before -> after) so the user can revert the repair.
        // Only when it actually changed the project, so a no-op repair doesn't add
        // a spurious history entry. Undo restores the pre-repair (corrupt) state —
        // which the save guard still refuses to persist — and redo re-applies the
        // fix; both go through the snapshot-pair restore, never re-executing.
        //
        // `changed` mirrors that same before != after condition: it is the honest
        // "the project was mutated" signal the frontend dirties on. It is broader
        // than `fixed > 0` because resolve_offsets() above heals sub-tolerance drift
        // that never registered as a counted violation (fixed == 0, yet changed).
        let mut changed = false;
        if let Some(before_json) = before_snapshot {
            if let Ok(after_json) = self.capture_project_snapshot() {
                if before_json != after_json {
                    changed = true;
                    self.push_snapshot_undo(Command::RepairIntegrity, before_json, after_json);
                }
            }
        }
        IntegrityRepairResult {
            fixed: before.saturating_sub(after) as u32,
            remaining: after as u32,
            changed,
        }
    }

    /// Execute a command and return the result
    pub fn execute(&self, cmd: Command) -> CommandResult {
        // Serialize all command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
        // Any mutation invalidates the derived closure-adjusted view.
        self.invalidate_adjusted_cache();
        tracing::info!(
            command = ?cmd.description(),
            purpose = "apply user action",
            "Executing command to update project state"
        );

        // Generate undo data before executing the command
        let undo_data = if Self::is_undoable(&cmd) {
            self.generate_undo_data(&cmd)
        } else {
            UndoData::None
        };

        // The command's integrity capabilities, computed once and read by the
        // epilogue below (snapshot / orphan-closure conversion / reconcile).
        let integrity = Self::command_integrity(&cmd);

        // Snapshot before a ref-removing/renumbering command so a result that
        // introduces dangling references can be rejected and rolled back —
        // corruption must not enter through the command path (#17). Only those
        // commands can dangle a ref, so geometry-only commands (moves, merges,
        // datums) skip the expensive whole-project serialize (#8).
        // Batch owns its own snapshot + integrity guard inside execute_batch
        // (which must reject corruption BEFORE pushing its undo entry, #1), so it
        // is excluded here to avoid a redundant whole-project serialize and a
        // double rollback.
        let integrity_snapshot =
            if integrity.can_dangle_refs && !matches!(cmd, Command::Batch { .. }) {
                self.capture_project_snapshot().ok()
            } else {
                None
            };
        // If the project is ALREADY corrupt (loaded that way), don't block — the
        // user repairs via the banner. We only reject commands that newly
        // introduce corruption into a clean project.
        let pre_had_critical = integrity_snapshot.is_some() && self.project_has_critical();

        let result = match &cmd {
            Command::CreateProject { name, location } => {
                self.create_project(name.clone(), location.clone())
            }
            Command::OpenProject { path } => self.open_project(path.clone()),
            Command::SaveProject { path, is_autosave } => {
                self.save_project(path.clone(), *is_autosave)
            }
            Command::CloseProject => self.close_project(),
            Command::CreateSection {
                name,
                surveyor,
                date,
                color,
                direction,
                shots,
            } => self.create_section(SectionData {
                name: name.clone(),
                surveyor: surveyor.clone(),
                date: *date,
                color: color.clone(),
                direction: *direction,
                quality: 1.0,
                shots: shots.clone(),
            }),
            Command::DeleteSection { section_id } => self.delete_section(*section_id),
            Command::UpdateSectionMetadata {
                section_id,
                updates,
            } => self.update_section(*section_id, updates.clone()),
            Command::CreateShot {
                section_id,
                shot,
                after_shot_id,
                before_shot_id,
            } => self.create_shot(*section_id, shot.clone(), *after_shot_id, *before_shot_id),
            Command::UpdateShot {
                section_id,
                shot_id,
                updates,
            } => self.update_shot(*section_id, *shot_id, updates.clone()),
            Command::DeleteShot {
                section_id,
                shot_id,
            } => self.delete_shot(*section_id, *shot_id),
            Command::SetShotReference {
                section_id,
                shot_id,
                is_reference,
            } => self.set_shot_reference(*section_id, *shot_id, *is_reference),
            Command::MergeStations {
                station_a,
                station_b,
            } => self.merge_stations(*station_a, *station_b),
            Command::UnmergeStations { station_ref } => self.unmerge_stations(*station_ref),
            Command::UnmergeStationPair {
                station_a,
                station_b,
            } => self.unmerge_station_pair(*station_a, *station_b),
            Command::CreateLoopClosure {
                station_a,
                station_b,
                closure_strategy,
            } => self.create_loop_closure(*station_a, *station_b, *closure_strategy),
            Command::RemoveLoopClosure { closure_id } => self.remove_loop_closure(*closure_id),
            Command::SetZeroDatum {
                station_ref,
                coordinates,
            } => self.set_zero_datum(*station_ref, *coordinates),
            Command::RemoveZeroDatum { station_ref } => self.remove_zero_datum(*station_ref),
            Command::SetStationComment {
                station_ref,
                comment,
            } => self.set_station_comment(*station_ref, comment.clone()),
            Command::MoveSection { section_id, offset } => self.move_section(*section_id, *offset),
            Command::MoveSegment { section_id, offset } => self.move_segment(*section_id, *offset),
            Command::MoveStation {
                station_ref,
                offset,
            } => self.move_station(*station_ref, *offset),
            Command::MoveComment {
                source,
                target,
                swap,
            } => return self.execute_move_comment(source.clone(), target.clone(), *swap, cmd),
            Command::Batch { commands } => self.execute_batch(commands.clone(), true),
            Command::MergeProjects {
                source_paths,
                output_path,
                output_name,
                archive_originals,
            } => self.merge_projects(
                source_paths.clone(),
                output_path.clone(),
                output_name.clone(),
                *archive_originals,
            ),
            Command::ApplyCollabChanges => self.apply_collab_changes(),
            // Never routed here: repair is applied via `repair_project_integrity`,
            // which records its own snapshot-pair undo entry. Present only for match
            // exhaustiveness.
            Command::RepairIntegrity => CommandResult::failure(
                "RepairIntegrity is applied via repair_project_integrity, not execute()"
                    .to_string(),
            ),
            Command::UpdateProjectSettings => CommandResult::failure(
                "UpdateProjectSettings is applied via update_project_settings, not execute()"
                    .to_string(),
            ),
        };

        // Block corruption at the source: if a structural command left the
        // project with dangling references, roll back to the pre-command
        // snapshot and reject it rather than committing (and later persisting)
        // a corrupt state (#17).
        if result.success && !pre_had_critical {
            if let Some(snapshot) = &integrity_snapshot {
                if let Some(failure) =
                    self.guard_introduced_corruption(pre_had_critical, snapshot, &cmd.description())
                {
                    return failure;
                }
            }
        }

        // A command that REMOVES connectivity (delete shot/section, unmerge) can
        // strand a section so its only attachment is a loop closure — which is
        // then a merge, not a loop. Convert before reconciling offsets so the new
        // merge is solved immediately (#8). Scoped to removal commands so a move
        // still leaves an inert closure independent.
        if result.success && integrity.can_orphan_closures {
            self.convert_orphan_closures_in_open_project();
        }

        // Treat section offsets as derived: after any structural command,
        // reconcile geometry so no command path can leave merged stations
        // drifted (a no-op when nothing moved; skipped during bulk import). A
        // metadata-only UpdateShot (comment/LRUD/reference) is excluded — see
        // `cmd_affects_geometry` — so it can't silently heal drift with no undo.
        if result.success && Self::cmd_affects_geometry(&cmd) {
            self.reconcile_geometry();
        }

        // Push to undo stack if successful and undoable.
        // Batch commands handle their own undo push inside execute_batch()
        // (with before+after snapshots), so skip them here.
        if result.success && Self::is_undoable(&cmd) && !matches!(cmd, Command::Batch { .. }) {
            // For create commands, finalize undo data with snapshot-based ID preservation
            let final_undo_data = self.finalize_undo_data(&cmd, undo_data);

            if let Ok(mut undo_stack) = self.undo_stack.lock() {
                undo_stack.push_with_data(cmd.clone(), final_undo_data);
            }
        }

        result
    }

    /// Execute a create-section-and-merge operation as a single atomic undo/redo unit.
    /// This is used when importing a new section and immediately merging one of its stations
    /// with an existing station. Both operations are combined into a single undo entry.
    pub fn execute_create_and_merge(
        &self,
        name: Option<String>,
        surveyor: Option<String>,
        date: Option<chrono::NaiveDate>,
        color: String,
        direction: Option<crate::models::SurveyDirection>,
        shots: Vec<ShotData>,
        import_station_index: u32,
        target_station: StationRef,
        _closure_strategy: ClosureStrategy,
    ) -> CommandResult {
        // Serialize command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
        tracing::info!(
            purpose = "keep undo atomic for import merge",
            "Executing create_section_and_merge as single undo unit"
        );

        // Take a project snapshot BEFORE any modifications
        let snapshot = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Step 1: Create the section (using internal method)
        let section_data = SectionData {
            name: name.clone(),
            surveyor: surveyor.clone(),
            date,
            color: color.clone(),
            direction,
            quality: 1.0,
            shots: shots.clone(),
        };

        let create_result = self.create_section(section_data);
        if !create_result.success {
            return create_result;
        }

        let Some(new_section_id) = create_result.section_id else {
            return CommandResult::failure("Section created but no ID returned".to_string());
        };

        // Step 2: Create the station reference for the newly created section
        let import_station_ref = StationRef {
            section_id: new_section_id,
            station_index: import_station_index,
        };

        // Step 3: Merge the stations
        let merge_result = self.merge_stations(import_station_ref, target_station);
        if !merge_result.success {
            // Merge failed after section was created — rollback to pre-mutation snapshot
            // to avoid leaving a created section with no undo entry.
            tracing::error!(
                purpose = "keep project consistent after failed merge",
                "Merge failed after section creation; rolling back to pre-mutation snapshot"
            );
            self.rollback_project(&snapshot);
            return merge_result;
        }

        // Step 4: Capture the after snapshot and push undo entry with before+after.
        let after_snapshot = match self.capture_after_snapshot_or_rollback(&snapshot) {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Create a Batch command that represents both operations for the description
        let batch_cmd = Command::Batch {
            commands: vec![
                Command::CreateSection {
                    name,
                    surveyor,
                    date,
                    color,
                    direction,
                    shots,
                },
                Command::MergeStations {
                    station_a: import_station_ref,
                    station_b: target_station,
                },
            ],
        };

        self.push_snapshot_undo(batch_cmd, snapshot, after_snapshot);

        // Combine warnings from both operations
        let mut all_warnings = create_result.warnings;
        all_warnings.extend(merge_result.warnings);

        // Return success with the new section ID
        let result = CommandResult::success().with_section_id(new_section_id);
        if all_warnings.is_empty() {
            result
        } else {
            result.with_warnings(all_warnings)
        }
    }

    /// Execute a batch import of sections as a single atomic undo/redo unit.
    /// Creates all sections with their placements (merges, zero datums, moves)
    /// and optionally tracks the file hash. Uses `ProjectSnapshotPair` so a
    /// single undo reverts everything including the hash.
    pub fn execute_import_sections(
        &self,
        sections: Vec<crate::models::ImportSectionConfig>,
        closures: Vec<crate::models::ImportClosure>,
        file_hash: Option<String>,
        section_hashes: Vec<String>,
        existing_shot_updates: Vec<crate::models::ExistingShotUpdate>,
    ) -> CommandResult {
        use crate::models::{ClosureStrategy, ImportPlacement, StationRef};
        use std::collections::{HashMap, HashSet};

        // Serialize command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };

        if sections.is_empty() {
            return CommandResult::success();
        }

        tracing::info!(
            count = sections.len(),
            purpose = "apply imported sections as single undo",
            "Executing import_sections as single undo unit"
        );

        // Take a project snapshot BEFORE any modifications
        let pre_had_critical = self.project_has_critical();
        let before_snapshot = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Apply shot updates to existing sections FIRST (overlap interpolation).
        // This must happen before placing new sections so that FromExisting placements
        // compute station positions using the updated (interpolated) shot data.
        if !existing_shot_updates.is_empty() {
            tracing::info!(
                count = existing_shot_updates.len(),
                purpose = "overlap interpolation",
                "Applying existing shot updates before placement",
            );
            let mut proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            if let Some(project) = proj_guard.as_mut() {
                // Collect unique affected section IDs
                let affected_section_ids: HashSet<SectionId> =
                    existing_shot_updates.iter().map(|u| u.section_id).collect();

                // Filter out updates for doubly-anchored sections.
                // If the modified shots sit between two positional constraints
                // (zero datums, aligned closures, station merges), modifying
                // the intermediate geometry would break one of them. We can only
                // compensate for a single anchor via offset adjustment, so when
                // two anchors straddle the modified range we must skip updates.
                let mut blocked_sections: HashSet<SectionId> = HashSet::new();
                for &sid in &affected_section_ids {
                    let section = match project.sections.iter().find(|s| s.id == sid) {
                        Some(s) => s,
                        None => continue,
                    };

                    // Find shot indices being modified on this section
                    let mut modified_indices: Vec<u32> = Vec::new();
                    for update in &existing_shot_updates {
                        if update.section_id != sid {
                            continue;
                        }
                        if let Some(idx) = section.shots.iter().position(|s| s.id == update.shot_id)
                        {
                            modified_indices.push(idx as u32);
                        }
                    }
                    let (Some(&min_shot), Some(&max_shot)) =
                        (modified_indices.iter().min(), modified_indices.iter().max())
                    else {
                        continue;
                    };

                    // Collect anchor station indices on this section.
                    // An anchor is any station whose absolute position is
                    // constrained by an immovable external relationship:
                    //   - zero datums on this section (always anchors)
                    //   - merges / aligned closures where the PARTNER can
                    //     independently reach a datum (without going through
                    //     this section).  A merge to a free-floating section
                    //     is NOT a positional constraint — the partner can
                    //     follow when this section's geometry changes.
                    let mut anchor_indices: Vec<u32> = Vec::new();

                    // Zero datums
                    for zd in &project.zero_datums {
                        if zd.station_ref.section_id == sid {
                            if let Some(sr) = project.resolve_key(&zd.station_ref) {
                                anchor_indices.push(sr.station_index);
                            }
                        }
                    }
                    // Station merges (only datum-backed partners)
                    for m in &project.station_merges {
                        if m.station_a.section_id == sid
                            && project.has_datum_path_excluding(m.station_b.section_id, sid)
                        {
                            if let Some(sr) = project.resolve_key(&m.station_a) {
                                anchor_indices.push(sr.station_index);
                            }
                        }
                        if m.station_b.section_id == sid
                            && project.has_datum_path_excluding(m.station_a.section_id, sid)
                        {
                            if let Some(sr) = project.resolve_key(&m.station_b) {
                                anchor_indices.push(sr.station_index);
                            }
                        }
                    }
                    // Aligned closures (only datum-backed partners)
                    for c in &project.loop_closures {
                        if !c.is_aligned {
                            continue;
                        }
                        if c.station_a.section_id == sid
                            && project.has_datum_path_excluding(c.station_b.section_id, sid)
                        {
                            if let Some(sr) = project.resolve_key(&c.station_a) {
                                anchor_indices.push(sr.station_index);
                            }
                        }
                        if c.station_b.section_id == sid
                            && project.has_datum_path_excluding(c.station_a.section_id, sid)
                        {
                            if let Some(sr) = project.resolve_key(&c.station_b) {
                                anchor_indices.push(sr.station_index);
                            }
                        }
                    }

                    // Check for anchors on both sides of the modified range.
                    // Shot i connects station i → station i+1, so stations
                    // 0..=min_shot are unaffected (front) and stations
                    // max_shot+1..end are on the back side.
                    let has_front = anchor_indices.iter().any(|&idx| idx <= min_shot);
                    let has_back = anchor_indices.iter().any(|&idx| idx > max_shot);

                    if has_front && has_back {
                        tracing::warn!(
                            section_id = sid,
                            min_shot,
                            max_shot,
                            anchors = ?anchor_indices,
                            purpose = "doubly-anchored guard",
                            "Skipping shot updates: modified range is between two anchored stations",
                        );
                        blocked_sections.insert(sid);
                        continue;
                    }

                    // (Connection-based constraints are handled post-update
                    //  by adjusting only the affected section's offset.)
                }

                // Record anchor station positions BEFORE applying updates.
                // For each affected section that has a zero datum, we need to keep
                // the datum station fixed — otherwise modifying shots between station 0
                // and the datum shifts the datum's absolute position.
                let mut anchor_positions: HashMap<SectionId, (StationRef, Coordinates)> =
                    HashMap::new();
                for &sid in &affected_section_ids {
                    if blocked_sections.contains(&sid) {
                        continue;
                    }
                    let datum_sr = project
                        .zero_datums
                        .iter()
                        .find(|zd| zd.station_ref.section_id == sid)
                        .and_then(|zd| project.resolve_key(&zd.station_ref));
                    if let Some(sr) = datum_sr {
                        if let Some(coords) = project.compute_station_raw_coords(sr) {
                            tracing::debug!(
                                section_id = sid,
                                anchor_station = sr.station_index,
                                x = coords.x,
                                y = coords.y,
                                purpose = "zero datum stability",
                                "Recorded anchor position before shot updates",
                            );
                            anchor_positions.insert(sid, (sr, coords));
                        }
                    }
                }

                // Apply the shot updates (skipping doubly-anchored sections)
                for update in &existing_shot_updates {
                    if blocked_sections.contains(&update.section_id) {
                        continue;
                    }
                    if let Some(section) = project
                        .sections
                        .iter_mut()
                        .find(|s| s.id == update.section_id)
                    {
                        if let Some(shot) =
                            section.shots.iter_mut().find(|s| s.id == update.shot_id)
                        {
                            let old_len = shot.length;
                            if let Some(v) = update.updates.azimuth_in {
                                shot.azimuth_in = v;
                            }
                            if let Some(v) = update.updates.azimuth_out {
                                shot.azimuth_out = v;
                            }
                            if let Some(v) = update.updates.length {
                                shot.length = v;
                            }
                            if let Some(v) = update.updates.depth_in {
                                shot.depth_in = v;
                            }
                            if let Some(v) = update.updates.depth_out {
                                shot.depth_out = v;
                            }
                            if let Some(v) = update.updates.pitch_in {
                                shot.pitch_in = v;
                            }
                            if let Some(v) = update.updates.pitch_out {
                                shot.pitch_out = v;
                            }
                            if let Some(v) = update.updates.left {
                                shot.left = v;
                            }
                            if let Some(v) = update.updates.right {
                                shot.right = v;
                            }
                            if let Some(v) = update.updates.up {
                                shot.up = v;
                            }
                            if let Some(v) = update.updates.down {
                                shot.down = v;
                            }
                            tracing::debug!(
                                section_id = update.section_id,
                                shot_id = update.shot_id,
                                old_length = old_len,
                                new_length = shot.length,
                                purpose = "overlap interpolation",
                                "Updated existing shot",
                            );
                        } else {
                            tracing::warn!(
                                section_id = update.section_id,
                                shot_id = update.shot_id,
                                purpose = "overlap interpolation",
                                "Shot not found in section",
                            );
                        }
                    } else {
                        tracing::warn!(
                            section_id = update.section_id,
                            purpose = "overlap interpolation",
                            "Section not found in project",
                        );
                    }
                }

                // Compensate section offsets to keep zero datum stations fixed.
                // After modifying shots, the geometry between station 0 and the anchor
                // station has changed, so the anchor's computed position has drifted.
                // We adjust the section offset (and all connected sections in the rigid
                // group) by the inverse delta to pin the anchor back to its original spot.
                for (sid, (anchor_ref, old_coords)) in &anchor_positions {
                    if let Some(new_coords) = project.compute_station_raw_coords(*anchor_ref) {
                        let dx = old_coords.x - new_coords.x;
                        let dy = old_coords.y - new_coords.y;
                        if dx.abs() > 1e-12 || dy.abs() > 1e-12 {
                            tracing::info!(
                                section_id = sid,
                                anchor_station = anchor_ref.station_index,
                                dx,
                                dy,
                                purpose = "zero datum stability",
                                "Compensating section offsets to keep zero datum fixed",
                            );
                            project.adjust_rigid_group_offsets(*sid, dx, dy);
                        }
                    }
                }

                // Cascade offset adjustments through drifted merge/closure
                // connections.  After shot updates and zero datum compensation,
                // some connections may be misaligned — the modified section's
                // station shifted but its partner didn't follow.
                let cascade_seeds: Vec<SectionId> = affected_section_ids
                    .iter()
                    .filter(|sid| !blocked_sections.contains(sid))
                    .copied()
                    .collect();
                project.cascade_connection_offsets(&cascade_seeds);
            }
        }

        // Mapping from import section_index to created SectionId
        let mut created_ids: HashMap<u32, u32> = HashMap::new();
        let mut all_section_ids: Vec<u32> = Vec::new();
        let mut all_warnings = Vec::new();
        // Collect commands for the undo entry description
        let mut batch_commands: Vec<Command> = Vec::new();

        // Defer per-merge cascades during the placement loop. Each
        // `merge_stations` / `set_zero_datum` call would otherwise run a
        // full O(N) `cascade_connection_offsets`, turning a 1 200-section
        // tree-shaped import into ~O(N²) work. The cascade is purely
        // defensive against drift in pre-existing connections, and the
        // batch under us is creating its connections in dependency order
        // (topological sort happens during `convert_tml_to_import_configs`).
        // We arm the guard here, run the loop, then disarm + run one
        // final cascade after the loop — equivalent to the union of the
        // deferred per-call cascades.  The guard's Drop resets the flag
        // even on the panic-poisoned-mutex path so a partial import
        // can't leave `cascade_deferred = true` and silently skip
        // cascades on every subsequent command.
        let cascade_guard = CascadeDeferGuard::arm(&self.project);
        // Eagerly populate the section-id and merge-adjacency lookups
        // so the per-call `get_section` / `get_merged_section_ids` stay
        // O(1) / O(group) instead of degrading into O(N) linear scans
        // inside `merge_stations`.
        if let Ok(mut proj_guard) = self.project.lock() {
            if let Some(project) = proj_guard.as_mut() {
                project.rebuild_section_index();
                project.rebuild_merge_adjacency();
            }
        }

        // [perf-debug] Time the per-section apply loop. Used to confirm
        // whether the dominant cost in execute_import_sections scales
        // linearly with section count (good) or super-linearly (bad —
        // a per-section graph traversal that re-walks already-imported
        // sections would show up here as quadratic growth).
        let loop_start = std::time::Instant::now();
        let mut create_total = std::time::Duration::ZERO;
        let mut placement_total = std::time::Duration::ZERO;
        let report_every = 100usize;
        let mut last_report_idx = 0usize;
        let mut last_report_elapsed = std::time::Duration::ZERO;

        for (idx, config) in sections.iter().enumerate() {
            let t_section_start = std::time::Instant::now();
            // Build SectionData from ImportSectionConfig
            let section_data = SectionData {
                name: config.name.clone(),
                surveyor: config.surveyor.clone(),
                date: config.date,
                color: config.color.clone(),
                direction: config.direction,
                quality: config.quality,
                shots: config.shots.clone(),
            };

            // Step 1: Create the section
            let t_create_start = std::time::Instant::now();
            let create_result = self.create_section(section_data.clone());
            create_total += t_create_start.elapsed();
            if !create_result.success {
                // Rollback to before-snapshot
                self.rollback_project(&before_snapshot);
                return CommandResult::failure(format!(
                    "Failed to create section \"{}\": {}",
                    config.name.as_deref().unwrap_or("unnamed"),
                    create_result.error.unwrap_or_default()
                ));
            }

            let Some(section_id) = create_result.section_id else {
                self.rollback_project(&before_snapshot);
                return CommandResult::failure("Section created but no ID returned".to_string());
            };

            created_ids.insert(config.section_index, section_id);
            all_section_ids.push(section_id);
            all_warnings.extend(create_result.warnings);

            // Apply station comments (promoted from shot comments during TML import)
            if !config.station_comments.is_empty() {
                let mut proj_guard = match self.project.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if let Some(project) = proj_guard.as_mut() {
                    for (station_index, comment) in &config.station_comments {
                        let station_ref = StationRef::new(section_id, *station_index);
                        if let Some(key) = project.key_for_ref(station_ref) {
                            project.station_comments.insert(key, comment.clone());
                        }
                    }
                }
            }

            batch_commands.push(Command::CreateSection {
                name: config.name.clone(),
                surveyor: config.surveyor.clone(),
                date: config.date,
                color: config.color.clone(),
                direction: config.direction,
                shots: config.shots.clone(),
            });

            // Step 2: Apply placement
            let t_placement_start = std::time::Instant::now();
            match &config.placement {
                ImportPlacement::Origin => {
                    // No-op — section starts at origin
                }

                ImportPlacement::ZeroDatum {
                    coordinates,
                    station_index,
                } => {
                    let station_ref = StationRef::new(section_id, *station_index);
                    let result = self.set_zero_datum(station_ref, *coordinates);
                    if !result.success {
                        self.rollback_project(&before_snapshot);
                        return CommandResult::failure(format!(
                            "Failed to set zero datum for section \"{}\": {}",
                            config.name.as_deref().unwrap_or("unnamed"),
                            result.error.unwrap_or_default()
                        ));
                    }
                    all_warnings.extend(result.warnings);
                    batch_commands.push(Command::SetZeroDatum {
                        station_ref,
                        coordinates: *coordinates,
                    });
                }

                ImportPlacement::FromExisting {
                    import_station,
                    existing_station,
                } => {
                    let import_ref = StationRef::new(section_id, *import_station);
                    let result = self.merge_stations(import_ref, *existing_station);
                    if !result.success {
                        self.rollback_project(&before_snapshot);
                        return CommandResult::failure(format!(
                            "Failed to merge section \"{}\": {}",
                            config.name.as_deref().unwrap_or("unnamed"),
                            result.error.unwrap_or_default()
                        ));
                    }
                    all_warnings.extend(result.warnings);
                    batch_commands.push(Command::MergeStations {
                        station_a: import_ref,
                        station_b: *existing_station,
                    });
                }

                ImportPlacement::FromImporting {
                    import_station,
                    target_section_index,
                    target_station_index,
                } => {
                    let Some(&target_section_id) = created_ids.get(target_section_index) else {
                        self.rollback_project(&before_snapshot);
                        return CommandResult::failure(format!(
                            "Section \"{}\" references import section index {} which has not been created yet",
                            config.name.as_deref().unwrap_or("unnamed"),
                            target_section_index
                        ));
                    };
                    let import_ref = StationRef::new(section_id, *import_station);
                    let target_ref = StationRef::new(target_section_id, *target_station_index);
                    let result = self.merge_stations(import_ref, target_ref);
                    if !result.success {
                        self.rollback_project(&before_snapshot);
                        return CommandResult::failure(format!(
                            "Failed to merge section \"{}\" with imported section: {}",
                            config.name.as_deref().unwrap_or("unnamed"),
                            result.error.unwrap_or_default()
                        ));
                    }
                    all_warnings.extend(result.warnings);
                    batch_commands.push(Command::MergeStations {
                        station_a: import_ref,
                        station_b: target_ref,
                    });
                }

                ImportPlacement::Manual {
                    align_station_index: _,
                    offset,
                } => {
                    if let Some(offset) = offset {
                        let result = self.move_section(section_id, *offset);
                        if !result.success {
                            self.rollback_project(&before_snapshot);
                            return CommandResult::failure(format!(
                                "Failed to move section \"{}\": {}",
                                config.name.as_deref().unwrap_or("unnamed"),
                                result.error.unwrap_or_default()
                            ));
                        }
                        all_warnings.extend(result.warnings);
                        batch_commands.push(Command::MoveSection {
                            section_id,
                            offset: *offset,
                        });
                    }
                }

                ImportPlacement::ManualSnap {
                    align_station_index,
                    snapped_to_station,
                } => {
                    let snap_index = (*align_station_index).min(config.shots.len() as u32);
                    let import_ref = StationRef::new(section_id, snap_index);
                    let result = self.merge_stations(import_ref, *snapped_to_station);
                    if !result.success {
                        self.rollback_project(&before_snapshot);
                        return CommandResult::failure(format!(
                            "Failed to snap section \"{}\": {}",
                            config.name.as_deref().unwrap_or("unnamed"),
                            result.error.unwrap_or_default()
                        ));
                    }
                    all_warnings.extend(result.warnings);
                    batch_commands.push(Command::MergeStations {
                        station_a: import_ref,
                        station_b: *snapped_to_station,
                    });
                }
            }
            placement_total += t_placement_start.elapsed();
            let _ = t_section_start;

            // [perf-debug] Periodic log: emit every `report_every` sections.
            // The "recent" delta highlights super-linear growth — if each
            // 100-section batch is taking longer than the last, a
            // per-section graph traversal is to blame.
            if (idx + 1) % report_every == 0 || idx + 1 == sections.len() {
                let now_elapsed = loop_start.elapsed();
                let batch = now_elapsed.saturating_sub(last_report_elapsed);
                let batch_n = (idx + 1) - last_report_idx;
                // Per-batch import progress is debug-only — it's
                // perf-investigation noise, not something a release
                // log should record.
                tracing::debug!(
                    sections_done = idx + 1,
                    total = sections.len(),
                    batch_n,
                    batch_ms = batch.as_millis() as u64,
                    total_elapsed_ms = now_elapsed.as_millis() as u64,
                    create_ms = create_total.as_millis() as u64,
                    placement_ms = placement_total.as_millis() as u64,
                    purpose = "TML import loop timing",
                    "section import progress"
                );
                last_report_idx = idx + 1;
                last_report_elapsed = now_elapsed;
            }
        }

        tracing::debug!(
            sections = sections.len(),
            total_ms = loop_start.elapsed().as_millis() as u64,
            create_ms = create_total.as_millis() as u64,
            placement_ms = placement_total.as_millis() as u64,
            purpose = "TML import loop summary",
            "execute_import_sections per-section loop done"
        );

        // Lift the deferral (clears the flag now so `cascade_connection_offsets`
        // is allowed to run) and execute ONE cascade across every newly
        // created section. This propagates any drift that would have
        // been caught by the per-call cascades — for a tree-shaped
        // import (no closures yet) this is a near-no-op single pass
        // that early-exits on the first iteration.  `disarm` consumes
        // the guard so its Drop becomes a no-op for the success path.
        cascade_guard.disarm();
        let cascade_start = std::time::Instant::now();
        if let Ok(mut proj_guard) = self.project.lock() {
            if let Some(project) = proj_guard.as_mut() {
                project.cascade_connection_offsets(&all_section_ids);
            }
        }
        tracing::debug!(
            sections = all_section_ids.len(),
            cascade_ms = cascade_start.elapsed().as_millis() as u64,
            purpose = "TML import batch cascade",
            "final cascade after deferred placement loop"
        );

        // Create loop closures from TML CLOSURE shots (non-fatal)
        for closure in &closures {
            let Some(&from_section_id) = created_ids.get(&closure.from_section_index) else {
                tracing::warn!(
                    from_section_index = closure.from_section_index,
                    purpose = "import loop closures",
                    "Closure source section not found in created sections, skipping"
                );
                continue;
            };
            let Some(&to_section_id) = created_ids.get(&closure.to_section_index) else {
                tracing::warn!(
                    to_section_index = closure.to_section_index,
                    purpose = "import loop closures",
                    "Closure target section not found in created sections, skipping"
                );
                continue;
            };
            let station_a = StationRef::new(from_section_id, closure.from_station_index);
            let station_b = StationRef::new(to_section_id, closure.to_station_index);

            // Create directly on the locked project to avoid double-locking
            let result = {
                let mut proj_guard = match self.project.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if let Some(project) = proj_guard.as_mut() {
                    project.create_loop_closure(station_a, station_b, ClosureStrategy::Batch)
                } else {
                    Err("No project open".to_string())
                }
            };
            match result {
                Ok(lc) => {
                    tracing::debug!(
                        closure_id = lc.id,
                        ?station_a,
                        ?station_b,
                        purpose = "import loop closures",
                        "Created loop closure from TML import"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        ?station_a,
                        ?station_b,
                        error = %e,
                        purpose = "import loop closures",
                        "Failed to create loop closure from TML import, skipping"
                    );
                }
            }
        }

        // Track file hash if provided (before after-snapshot so it's part of the undo)
        if let Some(ref hash) = file_hash {
            let track_result = self.track_imported_file(hash.clone());
            if !track_result.success {
                tracing::warn!(
                    purpose = "prevent duplicate imports",
                    error = ?track_result.error,
                    "Failed to track imported file hash"
                );
                // Non-fatal: don't rollback the entire import for a hash tracking failure
            }
        }

        // Track section content hashes (before after-snapshot so undo reverts them)
        if !section_hashes.is_empty() {
            let track_result = self.track_section_hashes(section_hashes);
            if !track_result.success {
                tracing::warn!(
                    purpose = "prevent duplicate section imports",
                    error = ?track_result.error,
                    "Failed to track imported section hashes"
                );
            }
        }

        // Block corruption at the source: convert sole-bridge closures, reconcile
        // derived offsets, and reject the whole import if it produced critical
        // corruption (dangling refs / non-finite geometry) rather than committing
        // and later persisting it. This custom path bypasses execute()'s guard, so
        // it must run the same epilogue itself (#integrity Root 4 / catalog #19).
        if self.finalize_structural_edit(pre_had_critical) {
            self.rollback_project(&before_snapshot);
            tracing::error!(
                purpose = "block corruption at the source",
                "TML import would corrupt survey structure; rolled back, nothing imported"
            );
            return CommandResult::failure(
                "Blocked: the imported data would corrupt the survey structure \
                 (dangling references or invalid geometry). Nothing was imported."
                    .to_string(),
            );
        }

        // Capture after-snapshot for redo support
        let after_snapshot = match self.capture_after_snapshot_or_rollback(&before_snapshot) {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Push a single undo entry covering all sections + hash
        self.push_snapshot_undo(
            Command::Batch {
                commands: batch_commands,
            },
            before_snapshot,
            after_snapshot,
        );

        let result = CommandResult::success().with_section_ids(all_section_ids);
        if all_warnings.is_empty() {
            result
        } else {
            result.with_warnings(all_warnings)
        }
    }

    pub(super) fn create_section(&self, data: SectionData) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        let max_shots = FEATURE_ID_STRIDE.saturating_sub(1) as usize;
        if data.shots.len() > max_shots {
            return CommandResult::failure(format!(
                "Section exceeds maximum shots per section (limit = {max_shots})"
            ));
        }

        // Reject non-finite geometry before it reaches the coordinate path (NaN/
        // inf slips past the zero/negative-length checks below). This is the
        // import/create-and-merge ingest path, alongside create_shot/update_shot.
        if data.shots.iter().any(|s| !s.all_finite()) {
            return CommandResult::failure(
                "Section has a shot with a non-finite (NaN/inf) value".to_string(),
            );
        }

        // Validate shots using the section_id that will be assigned
        let section_id_for_validation = project.next_section_id;
        let mut warnings = Vec::new();
        for (i, shot) in data.shots.iter().enumerate() {
            if shot.length == 0.0 {
                return CommandResult::failure(format!(
                    "Shot {}:{} has zero length",
                    section_id_for_validation,
                    i + 1
                ));
            }
            if shot.length < 0.0 {
                return CommandResult::failure(format!(
                    "Shot {}:{} has negative length: {:.1}m",
                    section_id_for_validation,
                    i + 1,
                    shot.length
                ));
            }
            // Per-project thresholds (#57) so create-time warnings match the panel.
            warnings.extend(Validator::validate_shot(
                shot,
                &project.validation,
                section_id_for_validation,
                i,
            ));
        }

        let section = project.add_section(data);
        let section_id = section.id;
        tracing::debug!(
            section_id = section_id,
            purpose = "add section to project",
            "Section created"
        );

        let result = CommandResult::success().with_section_id(section_id);
        if warnings.is_empty() {
            result
        } else {
            result.with_warnings(warnings)
        }
    }

    pub(super) fn delete_section(&self, section_id: SectionId) -> CommandResult {
        self.with_project_mut(|project| {
            if project.get_section(section_id).is_some() {
                project.preserve_connections_for_section_deletion(section_id);
                project.cleanup_section_references(section_id);
                project.remove_section(section_id);
                tracing::debug!(
                    section_id,
                    purpose = "remove section and cleanup references",
                    "Section deleted (with cleanup)"
                );
                CommandResult::success()
            } else {
                CommandResult::failure(format!("Section {section_id} not found"))
            }
        })
    }

    pub(super) fn update_section(
        &self,
        section_id: SectionId,
        updates: SectionUpdates,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            if project.update_section(section_id, &updates).is_some() {
                tracing::debug!(
                    section_id,
                    purpose = "update section metadata or shots",
                    "Section updated"
                );
                CommandResult::success()
            } else {
                CommandResult::failure(format!("Section {section_id} not found"))
            }
        })
    }

    // === Shot operations ===

    pub(super) fn create_shot(
        &self,
        section_id: SectionId,
        data: ShotData,
        after_shot_id: Option<ShotId>,
        before_shot_id: Option<ShotId>,
    ) -> CommandResult {
        // Reject ambiguous input: both after and before cannot be specified
        if after_shot_id.is_some() && before_shot_id.is_some() {
            return CommandResult::failure(
                "Cannot specify both after_shot_id and before_shot_id".to_string(),
            );
        }

        // Reject non-finite geometry before it reaches the coordinate path
        // (NaN/inf slips past zero/negative-length checks and poisons offsets).
        if !data.all_finite() {
            return CommandResult::failure("Shot has a non-finite (NaN/inf) value".to_string());
        }

        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        let max_shots = FEATURE_ID_STRIDE.saturating_sub(1) as usize;

        // Compute the real shot index for validation messages
        let shot_index = {
            let Some(section) = project.sections.iter().find(|s| s.id == section_id) else {
                return CommandResult::failure(format!("Section {section_id} not found"));
            };

            if section.shots.len() >= max_shots {
                return CommandResult::failure(format!(
                    "Section {section_id} has reached the maximum of {max_shots} shots"
                ));
            }

            if let Some(before_id) = before_shot_id {
                section
                    .shots
                    .iter()
                    .position(|shot| shot.id == before_id)
                    .unwrap_or(0)
            } else if let Some(after_id) = after_shot_id {
                section
                    .shots
                    .iter()
                    .position(|shot| shot.id == after_id)
                    .map_or(0, |pos| pos + 1)
            } else {
                section.shots.len()
            }
        };

        if data.length == 0.0 {
            return CommandResult::failure(format!(
                "Shot {}:{} has zero length",
                section_id,
                shot_index + 1
            ));
        }
        if data.length < 0.0 {
            return CommandResult::failure(format!(
                "Shot {}:{} has negative length: {:.1}m",
                section_id,
                shot_index + 1,
                data.length
            ));
        }

        let mut warnings = Vec::new();
        // Per-project thresholds (#57) so create-time warnings match the panel.
        warnings.extend(Validator::validate_shot(
            &data,
            &project.validation,
            section_id,
            shot_index,
        ));

        let shot = if let Some(before_id) = before_shot_id {
            project.insert_shot_before(section_id, before_id, data, None, None)
        } else if let Some(after_id) = after_shot_id {
            project.insert_shot_after(section_id, after_id, data, None, None)
        } else {
            project.add_shot(section_id, data)
        };

        if let Some(new_shot) = shot {
            let new_shot_id = new_shot.id;
            tracing::debug!(
                section_id,
                shot_id = new_shot_id,
                purpose = "add shot to section",
                "Shot created"
            );
            let result = CommandResult::success().with_shot_id(new_shot_id);
            if warnings.is_empty() {
                result
            } else {
                result.with_warnings(warnings)
            }
        } else {
            CommandResult::failure("Failed to create shot".to_string())
        }
    }

    pub(super) fn update_shot(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        updates: ShotUpdates,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Reject non-finite geometry before it reaches the coordinate path.
        if !updates.all_finite() {
            return CommandResult::failure(
                "Shot update has a non-finite (NaN/inf) value".to_string(),
            );
        }

        // Validate resulting length (disallow zero/negative)
        if let Some(section) = project.sections.iter().find(|s| s.id == section_id) {
            if let Some(existing) = section.shots.iter().find(|s| s.id == shot_id) {
                let new_length = updates.length.unwrap_or(existing.length);
                if new_length == 0.0 {
                    return CommandResult::failure(format!(
                        "Shot {}:{} has zero length",
                        section_id,
                        shot_display_position(shot_id, section_id)
                    ));
                }
                if new_length < 0.0 {
                    return CommandResult::failure(format!(
                        "Shot {}:{} has negative length: {:.1}m",
                        section_id,
                        shot_display_position(shot_id, section_id),
                        new_length
                    ));
                }

                // Reject geometry edits on frozen shots
                if updates.touches_geometry() && project.is_shot_frozen_by_id(section_id, shot_id) {
                    return CommandResult::failure(
                        "Cannot edit geometry of a frozen shot. This shot is part of an adjusted survey network.".to_string()
                    );
                }
            }
        }

        if project.update_shot(section_id, shot_id, &updates).is_some() {
            // Realign merge group offsets if geometry changed (keeps locked
            // stations pinned: merge points, zero datums)
            if updates.touches_geometry() {
                project.realign_after_shot_edit(section_id);
            }
            tracing::debug!(
                section_id,
                shot_id,
                purpose = "update shot measurements",
                "Shot updated"
            );
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Shot {section_id}:{shot_id} not found"))
        }
    }

    pub(super) fn delete_shot(&self, section_id: SectionId, shot_id: ShotId) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Defense-in-depth: refuse to delete a frozen shot (collaborator-locked
        // geometry anchored to an adjusted survey network). Mirrors update_shot's
        // frozen-geometry guard; the resolve-flow UI also gates this option. Runs
        // BEFORE the shift-blocked check so a frozen shot reports the clear frozen
        // message rather than the misleading "Use split instead."
        if project.is_shot_frozen_by_id(section_id, shot_id) {
            return CommandResult::failure(
                "Cannot delete a frozen shot. This shot is part of an adjusted survey network."
                    .to_string(),
            );
        }

        if let Ok(impact) = project.preview_delete_shot(section_id, shot_id) {
            if impact.shift_blocked {
                let reasons = if impact.shift_blocked_reasons.is_empty() {
                    "Shift geometry is not allowed for this shot.".to_string()
                } else {
                    impact.shift_blocked_reasons.join(" ")
                };
                return CommandResult::failure(format!("{reasons} Use split instead."));
            }
        }

        match project.remove_shot_with_rewire(section_id, shot_id) {
            Ok(_) => {
                tracing::debug!(
                    section_id,
                    shot_id,
                    purpose = "remove shot and rewire geometry",
                    "Shot deleted"
                );
                CommandResult::success()
            }
            Err(e) => CommandResult::failure(e),
        }
    }

    pub(super) fn set_shot_reference(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        is_reference: bool,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            if project
                .set_shot_reference(section_id, shot_id, is_reference)
                .is_some()
            {
                tracing::info!(
                    section_id,
                    shot_id,
                    is_reference,
                    purpose = "toggle reference shot visibility",
                    "Shot reference status updated"
                );
                CommandResult::success()
            } else {
                CommandResult::failure(format!("Shot {section_id}:{shot_id} not found"))
            }
        })
    }

    // === Station operations ===

    pub(super) fn merge_stations(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            // Check same section (not allowed)
            if station_a.section_id == station_b.section_id {
                return CommandResult::failure(
                    "Cannot merge stations from the same section".to_string(),
                );
            }

            match project.merge_stations(station_a, station_b) {
                Ok(_) => {
                    tracing::debug!(
                        ?station_a,
                        ?station_b,
                        purpose = "connect survey sections",
                        "Stations merged"
                    );
                    CommandResult::success()
                }
                Err(e) => {
                    tracing::warn!(
                        ?station_a,
                        ?station_b,
                        error = %e,
                        purpose = "connect survey sections",
                        "Failed to merge stations"
                    );
                    CommandResult::failure(e)
                }
            }
        })
    }

    pub(super) fn create_loop_closure(
        &self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        match project.create_loop_closure(station_a, station_b, strategy) {
            Ok(_) => {
                tracing::debug!(
                    ?station_a,
                    ?station_b,
                    purpose = "add loop closure to improve accuracy",
                    "Loop closure created"
                );
                CommandResult::success()
            }
            Err(e) => {
                tracing::warn!(
                    ?station_a,
                    ?station_b,
                    error = %e,
                    purpose = "add loop closure to improve accuracy",
                    "Failed to create loop closure"
                );
                CommandResult::failure(e)
            }
        }
    }

    pub(super) fn remove_loop_closure(&self, closure_id: u64) -> CommandResult {
        self.with_project_mut(|project| match project.remove_loop_closure(closure_id) {
            Ok(closure) => {
                tracing::debug!(
                    closure_id,
                    ?closure.station_a,
                    ?closure.station_b,
                    purpose = "remove loop closure from project",
                    "Loop closure removed"
                );
                CommandResult::success()
            }
            Err(e) => {
                tracing::warn!(
                    closure_id,
                    error = %e,
                    purpose = "remove loop closure from project",
                    "Failed to remove loop closure"
                );
                CommandResult::failure(e)
            }
        })
    }

    pub(super) fn unmerge_stations(&self, station_ref: StationRef) -> CommandResult {
        self.with_project_mut(|project| {
            // Find and unmerge all merges involving this station
            let merges_to_remove: Vec<(StationRef, StationRef)> = project
                .station_merges
                .iter()
                .filter(|m| {
                    project.key_is_ref(&m.station_a, station_ref)
                        || project.key_is_ref(&m.station_b, station_ref)
                })
                .filter_map(|m| {
                    match (
                        project.resolve_key(&m.station_a),
                        project.resolve_key(&m.station_b),
                    ) {
                        (Some(a), Some(b)) => Some((a, b)),
                        _ => None,
                    }
                })
                .collect();

            for (a, b) in merges_to_remove {
                project.unmerge_stations(a, b);
            }

            tracing::info!(
                ?station_ref,
                purpose = "disconnect merged stations",
                "Station unmerged"
            );
            CommandResult::success()
        })
    }

    pub(super) fn unmerge_station_pair(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            let (success, _removed_closures) = project.unmerge_stations(station_a, station_b);
            if success {
                tracing::info!(
                    ?station_a,
                    ?station_b,
                    purpose = "disconnect selected merged station pair",
                    "Station pair unmerged"
                );
                CommandResult::success()
            } else {
                tracing::warn!(
                    ?station_a,
                    ?station_b,
                    purpose = "disconnect selected merged station pair",
                    "Failed to unmerge station pair"
                );
                CommandResult::failure("Stations are not directly merged".to_string())
            }
        })
    }

    pub(super) fn set_zero_datum(
        &self,
        station_ref: StationRef,
        gps: GpsCoordinates,
    ) -> CommandResult {
        self.with_project_mut(|project| match project.set_zero_datum(station_ref, gps) {
            Ok(_) => {
                tracing::info!(
                    ?station_ref,
                    purpose = "anchor survey to GPS coordinates",
                    "Zero datum set"
                );
                CommandResult::success()
            }
            Err(e) => {
                tracing::warn!(
                    ?station_ref,
                    error = %e,
                    purpose = "anchor survey to GPS coordinates",
                    "Failed to set zero datum"
                );
                CommandResult::failure(e)
            }
        })
    }

    pub(super) fn remove_zero_datum(&self, station_ref: StationRef) -> CommandResult {
        self.with_project_mut(|project| {
            if project.remove_zero_datum(station_ref) {
                // Removing the over-constraining datum can leave the merge group
                // pinned to a now-absent second anchor with a residual tear. The
                // standard geometry epilogue (realign_merges) is tolerance-gated at
                // 5 cm, so a sub-tolerance tear would persist until a reload. Force a
                // zero-trust re-solve here so removing the offending datum heals the
                // group in-session, exactly as a reload would.
                project.resolve_offsets();
                tracing::debug!(
                    ?station_ref,
                    purpose = "remove GPS anchor",
                    "Zero datum removed"
                );
                CommandResult::success()
            } else {
                CommandResult::failure("Station is not a zero datum".to_string())
            }
        })
    }

    pub(super) fn set_station_comment(
        &self,
        station_ref: StationRef,
        comment: Option<String>,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            // Validate station exists
            let section = match project.get_section(station_ref.section_id) {
                Some(s) => s,
                None => {
                    return CommandResult::failure(format!(
                        "Section {} not found",
                        station_ref.section_id
                    ));
                }
            };

            let max_station_index = section.shots.len() as u32;
            if station_ref.station_index > max_station_index {
                return CommandResult::failure(format!(
                    "Station index {} out of range (section has {} stations)",
                    station_ref.station_index,
                    max_station_index + 1
                ));
            }

            match comment {
                Some(text) if !text.is_empty() => {
                    if let Some(key) = project.key_for_ref(station_ref) {
                        project.station_comments.insert(key, text);
                    }
                }
                _ => {
                    if let Some(key) = project.key_for_ref(station_ref) {
                        project.station_comments.remove(&key);
                    }
                }
            }

            project.touch();
            tracing::info!(
                ?station_ref,
                purpose = "set station comment",
                "Station comment updated"
            );
            CommandResult::success()
        })
    }

    /// Execute a move-comment operation as a single atomic undo/redo unit.
    /// Handles its own undo push (like `execute_batch` / `execute_delete_shot_and_split`).
    fn execute_move_comment(
        &self,
        source: CommentHolder,
        target: CommentHolder,
        swap: bool,
        cmd: Command,
    ) -> CommandResult {
        // Step 1: Take BEFORE snapshot
        let before_snapshot = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Step 2: Read source and target comments, then mutate
        {
            let Ok(mut proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(project) = proj_guard.as_mut() else {
                return CommandResult::failure("No project open".to_string());
            };

            let source_comment = match Self::get_holder_comment(project, &source) {
                Ok(c) => c,
                Err(e) => return CommandResult::failure(e),
            };
            let target_comment = match Self::get_holder_comment(project, &target) {
                Ok(c) => c,
                Err(e) => return CommandResult::failure(e),
            };

            // Source must have a comment
            let Some(comment_text) = source_comment else {
                return CommandResult::failure("Source has no comment to move".to_string());
            };

            // Set target = source's comment
            if let Err(e) = Self::set_holder_comment(project, &target, Some(comment_text)) {
                return CommandResult::failure(e);
            }

            // Set source = target's comment (swap) or None (move)
            let new_source_comment = if swap { target_comment } else { None };
            if let Err(e) = Self::set_holder_comment(project, &source, new_source_comment) {
                return CommandResult::failure(e);
            }

            project.touch();
        }

        // Step 3: Take AFTER snapshot
        let after_snapshot = match self.capture_after_snapshot_or_rollback(&before_snapshot) {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Step 4: Push single undo entry
        self.push_snapshot_undo(cmd, before_snapshot, after_snapshot);

        tracing::info!(
            swap = swap,
            purpose = "move comment atomically",
            "Move comment completed"
        );
        CommandResult::success()
    }

    /// Read the comment from a CommentHolder (station or shot)
    fn get_holder_comment(
        project: &Project,
        holder: &CommentHolder,
    ) -> Result<Option<String>, String> {
        match holder {
            CommentHolder::Station { station_ref } => {
                // Validate station exists
                let section = project
                    .get_section(station_ref.section_id)
                    .ok_or_else(|| format!("Section {} not found", station_ref.section_id))?;
                let max_station_index = section.shots.len() as u32;
                if station_ref.station_index > max_station_index {
                    return Err(format!(
                        "Station index {} out of range",
                        station_ref.station_index
                    ));
                }
                Ok(project
                    .key_for_ref(*station_ref)
                    .and_then(|key| project.station_comments.get(&key).cloned()))
            }
            CommentHolder::Shot {
                section_id,
                shot_id,
            } => {
                let section = project
                    .get_section(*section_id)
                    .ok_or_else(|| format!("Section {section_id} not found"))?;
                let shot = section
                    .get_shot(*shot_id)
                    .ok_or_else(|| format!("Shot {shot_id} not found in section {section_id}"))?;
                Ok(shot.comment.clone())
            }
        }
    }

    /// Set the comment on a CommentHolder (station or shot)
    fn set_holder_comment(
        project: &mut Project,
        holder: &CommentHolder,
        comment: Option<String>,
    ) -> Result<(), String> {
        match holder {
            CommentHolder::Station { station_ref } => {
                match comment {
                    Some(text) if !text.is_empty() => {
                        if let Some(key) = project.key_for_ref(*station_ref) {
                            project.station_comments.insert(key, text);
                        }
                    }
                    _ => {
                        if let Some(key) = project.key_for_ref(*station_ref) {
                            project.station_comments.remove(&key);
                        }
                    }
                }
                Ok(())
            }
            CommentHolder::Shot {
                section_id,
                shot_id,
            } => {
                let section = project
                    .get_section_mut(*section_id)
                    .ok_or_else(|| format!("Section {section_id} not found"))?;
                let shot = section
                    .shots
                    .iter_mut()
                    .find(|s| s.id == *shot_id)
                    .ok_or_else(|| format!("Shot {shot_id} not found in section {section_id}"))?;
                match comment {
                    Some(text) if !text.is_empty() => {
                        shot.comment = Some(text);
                    }
                    _ => {
                        shot.comment = None;
                    }
                }
                Ok(())
            }
        }
    }

    pub(super) fn move_section(&self, section_id: SectionId, offset: Coordinates) -> CommandResult {
        // "Adjust Position" on a section moves the WHOLE rigid group it belongs to
        // (its merge partners and aligned-closure-connected sections), not just this
        // one section. A merged section is rigidly bound to its partner: moving it
        // alone would shove its merged station off the partner's, and the
        // post-command geometry reconcile would then either snap it back (silently
        // discarding the move when this isn't the group's min-id anchor) or drag the
        // partner along. Moving the rigid group as one body keeps every merge aligned,
        // so the move sticks. For a standalone section the rigid group is just itself,
        // so this is identical to the previous single-section move. Delegating to
        // `move_segment` also upgrades the datum guard from "this section holds a
        // datum" to "the group holds a datum" (a partner's datum now blocks too).
        self.move_segment(section_id, offset)
    }

    pub(super) fn move_segment(&self, section_id: SectionId, offset: Coordinates) -> CommandResult {
        self.with_project_mut(|project| {
            if !offset.is_finite() {
                return CommandResult::failure(
                    "Move offset must be finite (no NaN/inf)".to_string(),
                );
            }
            // Validate section exists
            if !project.sections.iter().any(|s| s.id == section_id) {
                return CommandResult::failure("Section not found".to_string());
            }

            // Get all connected section IDs (merges + closures), filtered to existing sections
            let existing: std::collections::HashSet<SectionId> =
                project.sections.iter().map(|s| s.id).collect();
            let connected: Vec<SectionId> = project
                .get_rigid_connected_section_ids(section_id)
                .into_iter()
                .filter(|id| existing.contains(id))
                .collect();

            if project.rigid_group_has_datum(section_id)
                && (offset.x.abs() > 1e-9 || offset.y.abs() > 1e-9 || offset.z.abs() > 1e-9)
            {
                return CommandResult::failure(
                    "Cannot move a segment whose merge group holds a zero datum".to_string(),
                );
            }

            // Apply offset to every section in the connected set
            // (uses the pre-filtered connected set, not adjust_rigid_group_offsets,
            // because move_segment follows rigid + aligned-closure connectivity)
            for sid in &connected {
                project.adjust_section_offset(*sid, offset.x, offset.y);
            }
            project.touch();
            tracing::info!(
                ?section_id,
                ?offset,
                section_count = connected.len(),
                purpose = "move connected segment as rigid group",
                "Segment moved"
            );
            CommandResult::success()
        })
    }

    pub(super) fn move_station(
        &self,
        station_ref: StationRef,
        offset: Coordinates,
    ) -> CommandResult {
        self.with_project_mut(|project| {
            // Reject a non-finite offset: move_station recomputes and writes raw
            // shot geometry (length/azimuth/depth) from it, and the only numeric
            // guard below is `new_len <= 0.0`, which is false for NaN and inf.
            if !offset.x.is_finite() || !offset.y.is_finite() || !offset.z.is_finite() {
                return CommandResult::failure(
                    "Move offset has a non-finite (NaN/inf) value".to_string(),
                );
            }
            if project
                .zero_datums
                .iter()
                .any(|zd| project.key_is_ref(&zd.station_ref, station_ref))
                && (offset.x.abs() > 1e-9 || offset.y.abs() > 1e-9 || offset.z.abs() > 1e-9)
            {
                return CommandResult::failure("Cannot move a zero datum station".to_string());
            }

            // Incorporate any existing station offset
            let existing = project
                .key_for_ref(station_ref)
                .and_then(|key| project.station_offsets.get(&key).copied())
                .unwrap_or((0.0, 0.0, 0.0));
            let total_dx = existing.0 + offset.x;
            let total_dy = existing.1 + offset.y;
            let total_dz = existing.2 + offset.z;

            // Find the section containing this station (mutable)
            let Some(section) = project
                .sections
                .iter_mut()
                .find(|s| s.id == station_ref.section_id)
            else {
                return CommandResult::failure("Section not found".to_string());
            };

            let idx = station_ref.station_index as usize;

            // Validate station index (N shots → N+1 stations, indices 0..=N)
            if idx > section.shots.len() {
                return CommandResult::failure("Invalid station index".to_string());
            }

            // Pre-compute updates to avoid partial mutations on failure.
            let mut prev_update: Option<(f64, f64, f64, f64)> = None; // len, azi, depth_out, pitch
            if idx > 0 {
                let shot = &section.shots[idx - 1];
                let azi_rad = shot.average_azimuth().to_radians();
                let old_horizontal = shot.horizontal_length();
                let old_dx = old_horizontal * azi_rad.sin();
                let old_dy = old_horizontal * azi_rad.cos();
                let new_dx = old_dx + total_dx;
                let new_dy = old_dy + total_dy;
                let new_horizontal = (new_dx * new_dx + new_dy * new_dy).sqrt();
                let new_depth_out = shot.depth_out + total_dz;
                let new_dz = new_depth_out - shot.depth_in;
                let new_len = (new_horizontal * new_horizontal + new_dz * new_dz).sqrt();
                if new_len <= 0.0 || !new_len.is_finite() {
                    return CommandResult::failure(
                        "Move would create zero-length shot".to_string(),
                    );
                }
                let new_azi = if new_horizontal > 1e-9 {
                    new_dx.atan2(new_dy).to_degrees().rem_euclid(360.0)
                } else {
                    shot.average_azimuth()
                };
                let pitch = new_dz.atan2(new_horizontal).to_degrees();
                prev_update = Some((new_len, new_azi, new_depth_out, pitch));
            }

            let mut next_update: Option<(f64, f64, f64, f64)> = None; // len, azi, depth_in, pitch
            if let Some(shot) = section.shots.get(idx) {
                let azi_rad = shot.average_azimuth().to_radians();
                let old_horizontal = shot.horizontal_length();
                let old_dx = old_horizontal * azi_rad.sin();
                let old_dy = old_horizontal * azi_rad.cos();
                let new_dx = old_dx - total_dx;
                let new_dy = old_dy - total_dy;
                let new_horizontal = (new_dx * new_dx + new_dy * new_dy).sqrt();
                let new_depth_in = shot.depth_in + total_dz;
                let new_dz = shot.depth_out - new_depth_in;
                let new_len = (new_horizontal * new_horizontal + new_dz * new_dz).sqrt();
                if new_len <= 0.0 || !new_len.is_finite() {
                    return CommandResult::failure(
                        "Move would create zero-length shot".to_string(),
                    );
                }
                let new_azi = if new_horizontal > 1e-9 {
                    new_dx.atan2(new_dy).to_degrees().rem_euclid(360.0)
                } else {
                    shot.average_azimuth()
                };
                let pitch = new_dz.atan2(new_horizontal).to_degrees();
                next_update = Some((new_len, new_azi, new_depth_in, pitch));
            }

            // Special case: moving station 0 should move the section offset so the
            // rest of the geometry stays in place. Shot 0 is adjusted below to
            // compensate for the offset shift.
            // Note: can't use project.adjust_section_offset() here because `section`
            // is a live &mut borrow from project.sections.
            if idx == 0 && (total_dx != 0.0 || total_dy != 0.0) {
                let current = project
                    .section_offsets
                    .get(&station_ref.section_id)
                    .copied()
                    .unwrap_or((0.0, 0.0));
                project.section_offsets.insert(
                    station_ref.section_id,
                    (current.0 + total_dx, current.1 + total_dy),
                );
            }

            // Apply updates after validation
            if let Some((new_len, new_azi, new_depth_out, pitch)) = prev_update {
                if let Some(shot) = section.shots.get_mut(idx - 1) {
                    shot.length = new_len;
                    shot.azimuth_in = new_azi;
                    shot.azimuth_out = new_azi;
                    shot.depth_out = new_depth_out;
                    shot.pitch_in = Some(pitch);
                    shot.pitch_out = Some(pitch);
                }
            }

            if let Some((new_len, new_azi, new_depth_in, pitch)) = next_update {
                if let Some(shot) = section.shots.get_mut(idx) {
                    shot.length = new_len;
                    shot.azimuth_in = new_azi;
                    shot.azimuth_out = new_azi;
                    shot.depth_in = new_depth_in;
                    shot.pitch_in = Some(pitch);
                    shot.pitch_out = Some(pitch);
                }
            }

            // Clear station offset (now incorporated into shot data)
            if let Some(key) = project.key_for_ref(station_ref) {
                project.station_offsets.remove(&key);
            }
            project.touch();

            tracing::info!(
                ?station_ref,
                ?offset,
                purpose = "adjust station position",
                "Station moved (shot data updated)"
            );
            CommandResult::success()
        })
    }

    /// Check if a command is allowed in a batch (whitelist for IPC safety).
    ///
    /// `UpdateShot` is permitted so the data-table grid can commit a multi-cell
    /// edit (paste/fill) as a single undo unit: it keeps refs + connectivity
    /// intact, self-validates length/finiteness/frozen-geometry, and a geometry
    /// edit has the moved stations baked in by the batch epilogue's
    /// `reconcile_geometry()` — which the epilogue runs only when the batch
    /// actually touches geometry (see `cmd_affects_geometry`), so a metadata-only
    /// UpdateShot batch (comment/LRUD/reference) commits WITHOUT reconciling.
    /// `SetStationComment` is still NOT allowed: as a whole it is INERT metadata
    /// (see `command_integrity_profiles_are_stable`), so it would never carry the
    /// geometry that justifies a batch; comment edits stay one-command-per-undo.
    fn is_batch_allowed(cmd: &Command) -> bool {
        matches!(
            cmd,
            Command::CreateSection { .. }
                | Command::CreateLoopClosure { .. }
                | Command::MergeStations { .. }
                | Command::MoveSection { .. }
                | Command::MoveSegment { .. }
                | Command::MoveStation { .. }
                | Command::SetZeroDatum { .. }
                | Command::UpdateShot { .. }
        )
    }

    /// Execute a batch of commands atomically.
    /// When `push_undo` is true (called from `execute()`), pushes a ProjectSnapshotPair
    /// undo entry. When false (called from `execute_without_undo()`), no undo entry is pushed.
    /// Caller must already hold `command_lock`.
    pub(super) fn execute_batch(&self, commands: Vec<Command>, push_undo: bool) -> CommandResult {
        // No-op for empty batch: skip snapshot/undo overhead
        if commands.is_empty() {
            return CommandResult::success();
        }

        // Whitelist: reject commands not allowed in batch context
        for cmd in &commands {
            if !Self::is_batch_allowed(cmd) {
                return CommandResult::failure(format!(
                    "Command '{}' is not allowed in batch context",
                    cmd.description()
                ));
            }
        }

        // Whether the project was ALREADY corrupt before the batch (loaded that
        // way) — captured against the pre-batch state so the guard below only
        // rejects corruption the batch itself introduces.
        let pre_had_critical = self.project_has_critical();

        // Capture pre-batch snapshot for rollback on partial failure and undo
        let before_snapshot = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(result) => return result,
        };

        let mut all_warnings = Vec::new();
        let mut section_ids = Vec::new();

        for cmd in &commands {
            // Use execute_without_undo to avoid pushing individual undo entries;
            // the outer Batch command handles undo as a single unit via ProjectSnapshotPair
            let result = self.execute_without_undo(cmd.clone());
            if !result.success {
                // Rollback: restore pre-batch state to avoid partial mutations
                self.rollback_project(&before_snapshot);
                return result;
            }
            all_warnings.extend(result.warnings);
            // Collect section IDs from CreateSection commands
            if let Some(id) = result.section_id {
                section_ids.push(id);
            }
            section_ids.extend(result.section_ids);
        }

        // Block corruption at the source — BEFORE pushing the undo entry. The
        // sub-commands ran via execute_without_undo (no per-command guard), so a
        // batch can strand a dangling reference; if we pushed the snapshot pair
        // first (as before) a later undo+redo would reinstate the corrupt state.
        // #1
        if let Some(failure) =
            self.guard_introduced_corruption(pre_had_critical, &before_snapshot, "Batch")
        {
            return failure;
        }

        // Finalize structural side-effects BEFORE snapshotting for redo, mirroring
        // the per-command epilogue in execute(). A batch that strands a sole-bridge
        // closure must have the closure→merge conversion baked into the after-
        // snapshot; otherwise undo→redo restores the pre-conversion topology — redo
        // only reconciles geometry, it does NOT re-run the conversion — and the
        // merge is silently lost. The conversion stays unconditional: a batched
        // CreateLoopClosure can itself create the sole-bridge closure that needs it.
        //
        // The reconcile, however, is gated exactly as execute() gates its own (see
        // cmd_affects_geometry): a batch that touches no geometry (a multi-cell
        // paste/fill of comments / LRUD / reference flags — all metadata-only
        // UpdateShots) must NOT reconcile, or it would heal an already-drifted
        // project as a side effect of a metadata edit whose undo only restores the
        // metadata (the asymmetric-undo hazard that keeps SetStationComment out of
        // batches entirely). The outer execute() epilogue applies the same gate to
        // the Batch command, so the two passes agree.
        self.convert_orphan_closures_in_open_project();
        if commands.iter().any(Self::cmd_affects_geometry) {
            self.reconcile_geometry();
        }

        if push_undo {
            // Capture after-snapshot for redo support; failure means rollback
            let after_snapshot = match self.capture_after_snapshot_or_rollback(&before_snapshot) {
                Ok(s) => s,
                Err(result) => return result,
            };

            // Push undo entry directly (bypasses finalize_undo_data which is a no-op for Batch)
            self.push_snapshot_undo(Command::Batch { commands }, before_snapshot, after_snapshot);
        }

        let result = if section_ids.is_empty() {
            CommandResult::success()
        } else {
            CommandResult::success().with_section_ids(section_ids)
        };
        if all_warnings.is_empty() {
            result
        } else {
            result.with_warnings(all_warnings)
        }
    }

    /// Execute a delete-shot-and-split-section operation as a single atomic undo/redo unit.
    /// Deletes a mid-section shot and splits the section into two, with user-provided names.
    /// Uses `ProjectSnapshotPair` for single-undo. Follows `execute_create_and_merge()` pattern.
    pub fn execute_delete_shot_and_split(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        name_a: String,
        name_b: String,
    ) -> CommandResult {
        // Serialize command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
        tracing::info!(
            section_id,
            shot_id,
            purpose = "split section after deleting shot",
            "Executing delete_shot_and_split as single undo unit"
        );

        // Step 1: Take BEFORE snapshot
        let before_snapshot = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(result) => return result,
        };

        let undo_section_b_name = name_b.clone();

        // Step 2: Get split data and perform the operation
        let new_section_id = {
            let Ok(mut proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };

            let Some(project) = proj_guard.as_mut() else {
                return CommandResult::failure("No project open".to_string());
            };

            let Some(section) = project.get_section(section_id) else {
                return CommandResult::failure(format!("Section {section_id} not found"));
            };

            // Pre-check: distinguish "shot not found" from "edge shot"
            let shot_pos = section.shots.iter().position(|s| s.id == shot_id);
            match shot_pos {
                None => {
                    return CommandResult::failure(format!(
                        "Shot {shot_id} not found in section {section_id}"
                    ))
                }
                Some(p) if p == 0 || p == section.shots.len() - 1 => {
                    return CommandResult::failure(
                        "Cannot split at edge shot (first or last). Use simple delete instead."
                            .to_string(),
                    );
                }
                _ => {}
            }

            // Get split data (safe after pre-checks above)
            let Some((pos, shots_before, shots_after)) = section.split_shots_at(shot_id) else {
                return CommandResult::failure(format!("Failed to split at shot {shot_id}"));
            };

            // Capture deleted shot data for offset calculation
            let deleted_shot_data = section.shots[pos].to_shot_data();

            // Capture metadata from original section (surveyor, date, color, direction -- NOT comment)
            let surveyor = section.surveyor.clone();
            let date = section.date;
            let color = section.color.clone();
            let direction = section.direction;
            let quality = section.quality;

            // Stable-identity remap snapshot: resolve every stored cross-reference
            // to its CURRENT positional ref BEFORE we mutate the section. The shots
            // moved into section B get fresh UUIDs, so positional-then-reanchor is
            // the sound way to carry refs across the split (anchors alone can't
            // follow a shot whose UUID changes).
            let split_station = (pos + 1) as u32;
            let original_station_count = section.shots.len() as u32 + 1;
            let old_refs: Vec<Option<StationRef>> = {
                let p: &Project = project;
                let mut out = Vec::new();
                p.for_each_station_ref(|_label, key| out.push(p.resolve_key(&key)));
                out
            };

            // Step 3: Modify original section -> section A
            // Truncate in-place to preserve existing Shot IDs and next_shot_id
            let Some(section_mut) = project.get_section_mut(section_id) else {
                return CommandResult::failure(format!("Section {section_id} not found"));
            };
            section_mut.name = Some(name_a);
            section_mut.shots.truncate(pos); // keep shots[0..pos], drop deleted + after

            // Step 4: Calculate offset for section B
            // Walk shots_before + deleted shot to accumulate (bx, by)
            let mut bx: f64 = 0.0;
            let mut by: f64 = 0.0;
            for shot_data in &shots_before {
                let temp_shot = crate::models::Shot::new(0, shot_data.clone());
                let avg_az = temp_shot.average_azimuth();
                let azimuth_rad = avg_az.to_radians();
                let horizontal = temp_shot.horizontal_length();
                bx += horizontal * azimuth_rad.sin();
                by += horizontal * azimuth_rad.cos();
            }
            // Add deleted shot
            {
                let deleted_shot = crate::models::Shot::new(0, deleted_shot_data);
                let azimuth_rad = deleted_shot.average_azimuth().to_radians();
                let horizontal = deleted_shot.horizontal_length();
                bx += horizontal * azimuth_rad.sin();
                by += horizontal * azimuth_rad.cos();
            }

            // Get existing section offset to add to computed B offset
            let (section_ox, section_oy) = project.section_offset(section_id);

            // Capture counts before moving data
            let shots_after_len = shots_after.len();

            // Step 5: Create section B with inherited metadata
            let section_b_data = SectionData {
                name: Some(name_b),
                surveyor,
                date,
                color,
                direction: Some(direction),
                quality,
                shots: shots_after,
            };

            let section_b = project.add_section(section_b_data);
            let new_id = section_b.id;

            // Set section B offset
            project.set_section_offset(new_id, (section_ox + bx, section_oy + by));

            // Step 6: Remap every cross-reference across the split.
            // Stations whose positional index moved into section B (index in
            // [split_station, original_station_count)) become section B refs with
            // index -= split_station; everything else stays put. We re-derive each
            // ref's stable key from its NEW positional home against the now-final
            // structure (section B's shots carry fresh UUIDs). `old_refs` was
            // captured before truncation, in `for_each_station_ref` order; the
            // `new_keys` Vec is consumed by `map_station_refs` in that same order.
            let _ = shots_after_len;
            let new_keys: Vec<Option<StationKey>> = old_refs
                .iter()
                .map(|old_ref| {
                    let sr = (*old_ref)?;
                    let new_ref = if sr.section_id == section_id
                        && sr.station_index >= split_station
                        && sr.station_index < original_station_count
                    {
                        StationRef::new(new_id, sr.station_index - split_station)
                    } else {
                        sr
                    };
                    project.key_for_ref(new_ref)
                })
                .collect();
            let mut remap_i = 0usize;
            project.map_station_refs(|old_key| {
                let next = new_keys.get(remap_i).cloned().flatten();
                remap_i += 1;
                next.unwrap_or(old_key)
            });
            // `new_keys` was built 1:1 from `old_refs` (a for_each_station_ref pass)
            // and is consumed positionally here; the alignment is only valid if
            // map_station_refs visits the same refs in the same order. Assert it so
            // a future divergence fails loudly in debug rather than silently
            // re-anchoring a cross-reference onto the wrong station.
            debug_assert_eq!(
                remap_i,
                new_keys.len(),
                "split-section remap: map_station_refs visited a different number of \
                 refs than were captured in old_refs — traversal order diverged"
            );

            // The split can strand a section so its only attachment is a loop
            // closure — that is a merge, not a loop. Convert it now (issue #8)
            // so it's fixed immediately, not only on the next reload.
            project.convert_orphan_closures_to_merges();

            project.touch();
            new_id
        };

        // This custom path bypasses execute()'s reconcile; re-derive offsets here
        // (after the orphan-closure conversion above) and before the after-snapshot
        // so undo/redo and the saved file reflect the normalized topology.
        self.reconcile_geometry();

        // Step 7: Take AFTER snapshot
        let after_snapshot = match self.capture_after_snapshot_or_rollback(&before_snapshot) {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Step 8: Push single undo entry with ProjectSnapshotPair
        // Use a Batch with both DeleteShot + CreateSection to accurately describe the compound op
        let batch_cmd = Command::Batch {
            commands: vec![
                Command::DeleteShot {
                    section_id,
                    shot_id,
                },
                Command::CreateSection {
                    name: Some(undo_section_b_name),
                    surveyor: None,
                    date: None,
                    color: String::new(),
                    direction: None,
                    shots: Vec::new(),
                },
            ],
        };

        self.push_snapshot_undo(batch_cmd, before_snapshot, after_snapshot);

        tracing::info!(
            section_id,
            shot_id,
            new_section_id,
            purpose = "split section after deleting shot",
            "Delete shot and split section completed"
        );

        CommandResult::success().with_section_id(new_section_id)
    }

    /// Delete a contiguous *interior* range of shots and split the section into
    /// two: section A keeps the shots before the range (in place), section B is a
    /// new section holding the shots after the range (offset so it keeps its
    /// absolute position). Generalizes [`Self::execute_delete_shot_and_split`]
    /// from a single shot to `[start_pos..=end_pos]`. Commits as ONE
    /// `ProjectSnapshotPair` undo entry. The range must be interior (shots remain
    /// before AND after); prefix/suffix/whole ranges use the shift or
    /// section-delete paths.
    pub fn execute_delete_shot_range_split(
        &self,
        section_id: SectionId,
        start_shot_id: ShotId,
        end_shot_id: ShotId,
        name_a: String,
        name_b: String,
    ) -> CommandResult {
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
        tracing::info!(
            section_id,
            start_shot_id,
            end_shot_id,
            purpose = "split section after deleting shot range",
            "Executing delete_shot_range_split as single undo unit"
        );

        let before_snapshot = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(result) => return result,
        };
        let undo_section_b_name = name_b.clone();

        let new_section_id = {
            let Ok(mut proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(project) = proj_guard.as_mut() else {
                return CommandResult::failure("No project open".to_string());
            };
            let Some(section) = project.get_section(section_id) else {
                return CommandResult::failure(format!("Section {section_id} not found"));
            };

            let n = section.shots.len();
            let Some(mut start_pos) = section.shots.iter().position(|s| s.id == start_shot_id)
            else {
                return CommandResult::failure(format!(
                    "Shot {start_shot_id} not found in section {section_id}"
                ));
            };
            let Some(mut end_pos) = section.shots.iter().position(|s| s.id == end_shot_id) else {
                return CommandResult::failure(format!(
                    "Shot {end_shot_id} not found in section {section_id}"
                ));
            };
            if start_pos > end_pos {
                std::mem::swap(&mut start_pos, &mut end_pos);
            }
            // Split requires shots both before and after the range.
            if start_pos == 0 || end_pos >= n - 1 {
                return CommandResult::failure(
                    "Range is not interior to the section (split needs shots before and after). \
                     Use shift or delete the section instead."
                        .to_string(),
                );
            }

            // Capture owned data; afterwards the `section` borrow ends so we can mutate.
            let shots_before: Vec<ShotData> = section.shots[..start_pos]
                .iter()
                .map(|s| s.to_shot_data())
                .collect();
            let shots_after: Vec<ShotData> = section.shots[end_pos + 1..]
                .iter()
                .map(|s| s.to_shot_data())
                .collect();
            let deleted_shots_data: Vec<ShotData> = section.shots[start_pos..=end_pos]
                .iter()
                .map(|s| s.to_shot_data())
                .collect();
            let range_shot_ids: Vec<ShotId> = section.shots[start_pos..=end_pos]
                .iter()
                .map(|s| s.id)
                .collect();
            let surveyor = section.surveyor.clone();
            let date = section.date;
            let color = section.color.clone();
            let direction = section.direction;
            let quality = section.quality;

            // Frozen-geometry guard (mirrors delete_shot).
            for &sid in &range_shot_ids {
                if project.is_shot_frozen_by_id(section_id, sid) {
                    return CommandResult::failure(
                        "Cannot delete a frozen shot. This range includes shots that are part of \
                         an adjusted survey network."
                            .to_string(),
                    );
                }
            }

            // Interior stations dropped by the split (strictly between the kept
            // boundary stations `start_pos` (→A) and `end_pos+1` (→B:0)).
            let interior: std::collections::HashSet<StationRef> = ((start_pos as u32 + 1)
                ..=(end_pos as u32))
                .map(|i| StationRef::new(section_id, i))
                .collect();

            // Preserve connectivity across the dropped stations, then drop their
            // own refs — BEFORE we capture old_refs, so the stored-ref set is
            // final and the positional remap below stays 1:1 aligned. Both run
            // while the section is structurally intact (indices still resolve).
            project.preserve_connections_for_removed_stations(&interior);
            project.cleanup_removed_station_references(&interior);

            // Stable-identity remap snapshot (see execute_delete_shot_and_split):
            // resolve every surviving cross-ref to its current positional ref.
            let split_station = (end_pos + 1) as u32;
            let original_station_count = n as u32 + 1;
            let old_refs: Vec<Option<StationRef>> = {
                let p: &Project = project;
                let mut out = Vec::new();
                p.for_each_station_ref(|_label, key| out.push(p.resolve_key(&key)));
                out
            };

            // Section A = before (truncate in place to preserve shot IDs).
            let Some(section_mut) = project.get_section_mut(section_id) else {
                // preserve/cleanup above already mutated the project; roll back
                // to the before-snapshot so a failure here leaves no half-applied
                // state (mirrors the shift path's rollback on remove failure).
                let _ = Self::restore_snapshot_into(&mut proj_guard, &before_snapshot);
                return CommandResult::failure(format!("Section {section_id} not found"));
            };
            section_mut.name = Some(name_a);
            section_mut.shots.truncate(start_pos);

            // Section B offset = section offset + displacement of (before ++ deleted).
            let mut bx: f64 = 0.0;
            let mut by: f64 = 0.0;
            for shot_data in shots_before.iter().chain(deleted_shots_data.iter()) {
                let temp_shot = crate::models::Shot::new(0, shot_data.clone());
                let azimuth_rad = temp_shot.average_azimuth().to_radians();
                let horizontal = temp_shot.horizontal_length();
                bx += horizontal * azimuth_rad.sin();
                by += horizontal * azimuth_rad.cos();
            }
            let (section_ox, section_oy) = project.section_offset(section_id);

            let section_b_data = SectionData {
                name: Some(name_b),
                surveyor,
                date,
                color,
                direction: Some(direction),
                quality,
                shots: shots_after,
            };
            let section_b = project.add_section(section_b_data);
            let new_id = section_b.id;
            project.set_section_offset(new_id, (section_ox + bx, section_oy + by));

            // Remap cross-refs across the split: stations at index >= split_station
            // (= end_pos+1) move to B with index -= split_station; everything else
            // (index <= start_pos) stays on A. Interior refs were already dropped,
            // so no surviving ref resolves into the gap.
            let new_keys: Vec<Option<StationKey>> = old_refs
                .iter()
                .map(|old_ref| {
                    let sr = (*old_ref)?;
                    let new_ref = if sr.section_id == section_id
                        && sr.station_index >= split_station
                        && sr.station_index < original_station_count
                    {
                        StationRef::new(new_id, sr.station_index - split_station)
                    } else {
                        sr
                    };
                    project.key_for_ref(new_ref)
                })
                .collect();
            let mut remap_i = 0usize;
            project.map_station_refs(|old_key| {
                let next = new_keys.get(remap_i).cloned().flatten();
                remap_i += 1;
                next.unwrap_or(old_key)
            });
            debug_assert_eq!(
                remap_i,
                new_keys.len(),
                "split-range remap: map_station_refs visited a different number of refs \
                 than were captured in old_refs — traversal order diverged"
            );

            project.convert_orphan_closures_to_merges();
            project.touch();
            new_id
        };

        // Custom path bypasses execute()'s reconcile; re-derive offsets here.
        self.reconcile_geometry();

        let after_snapshot = match self.capture_after_snapshot_or_rollback(&before_snapshot) {
            Ok(s) => s,
            Err(result) => return result,
        };

        let batch_cmd = Command::Batch {
            commands: vec![
                Command::DeleteShot {
                    section_id,
                    shot_id: start_shot_id,
                },
                Command::CreateSection {
                    name: Some(undo_section_b_name),
                    surveyor: None,
                    date: None,
                    color: String::new(),
                    direction: None,
                    shots: Vec::new(),
                },
            ],
        };
        self.push_snapshot_undo(batch_cmd, before_snapshot, after_snapshot);

        tracing::info!(
            section_id,
            new_section_id,
            purpose = "split section after deleting shot range",
            "Delete shot range and split section completed"
        );
        CommandResult::success().with_section_id(new_section_id)
    }

    /// Delete a contiguous range of shots by gap-closing (shifting) — the
    /// survivors rejoin and the section stays single. Generalizes the
    /// single-shot `delete_shot` (`remove_shot_with_rewire`) to a range by
    /// deleting the range's shots in forward order within ONE
    /// `ProjectSnapshotPair` undo unit (each step is a valid single-shot
    /// gap-close: head/before stays for interior & suffix ranges, tail/after
    /// stays for prefix ranges). Refuses when the range is shift-blocked or would
    /// empty the section (use split / section delete respectively).
    pub fn execute_delete_shot_range_shift(
        &self,
        section_id: SectionId,
        start_shot_id: ShotId,
        end_shot_id: ShotId,
    ) -> CommandResult {
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
        tracing::info!(
            section_id,
            start_shot_id,
            end_shot_id,
            purpose = "gap-close a deleted shot range",
            "Executing delete_shot_range_shift as single undo unit"
        );

        let before_snapshot = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(result) => return result,
        };

        let result_section = {
            let Ok(mut proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(project) = proj_guard.as_mut() else {
                return CommandResult::failure("No project open".to_string());
            };
            let Some(section) = project.get_section(section_id) else {
                return CommandResult::failure(format!("Section {section_id} not found"));
            };

            let n = section.shots.len();
            let Some(mut start_pos) = section.shots.iter().position(|s| s.id == start_shot_id)
            else {
                return CommandResult::failure(format!(
                    "Shot {start_shot_id} not found in section {section_id}"
                ));
            };
            let Some(mut end_pos) = section.shots.iter().position(|s| s.id == end_shot_id) else {
                return CommandResult::failure(format!(
                    "Shot {end_shot_id} not found in section {section_id}"
                ));
            };
            if start_pos > end_pos {
                std::mem::swap(&mut start_pos, &mut end_pos);
            }
            // Deleting the whole section this way would leave it empty — route
            // that through delete_section instead.
            if start_pos == 0 && end_pos == n - 1 {
                return CommandResult::failure(
                    "Cannot shift-delete an entire section; delete the section instead."
                        .to_string(),
                );
            }

            // Delete in forward (ascending position) order by stable shot id.
            let range_shot_ids: Vec<ShotId> = section.shots[start_pos..=end_pos]
                .iter()
                .map(|s| s.id)
                .collect();

            // Frozen-geometry + shift-blocked prechecks (no mutation yet).
            for &sid in &range_shot_ids {
                if project.is_shot_frozen_by_id(section_id, sid) {
                    return CommandResult::failure(
                        "Cannot delete a frozen shot. This range includes shots that are part of \
                         an adjusted survey network."
                            .to_string(),
                    );
                }
            }
            if let Ok(impact) =
                project.preview_delete_shot_range(section_id, start_shot_id, end_shot_id)
            {
                if impact.shift_blocked {
                    let reasons = if impact.shift_blocked_reasons.is_empty() {
                        "Shift geometry is not allowed for this range.".to_string()
                    } else {
                        impact.shift_blocked_reasons.join(" ")
                    };
                    return CommandResult::failure(format!("{reasons} Use split instead."));
                }
            }

            // Stations the WHOLE range will remove, captured up front as
            // canonical (position-independent) keys so renumbering during the
            // per-shot deletes can't invalidate them. Each per-shot gap-close
            // ignores anchors on these when deciding which side keeps its
            // position — otherwise an anchor on a later, also-doomed range shot
            // would displace the survivors (e.g. a suffix shift would keep the
            // doomed tail fixed and shift the head). Whole-section was refused
            // above, so start_pos==0 here means prefix.
            let doomed_indices: Vec<u32> = if start_pos == 0 {
                (0..=(end_pos as u32)).collect() // prefix
            } else if end_pos == n - 1 {
                ((start_pos as u32 + 1)..=(n as u32)).collect() // suffix
            } else {
                ((start_pos as u32 + 1)..=(end_pos as u32 + 1)).collect() // interior
            };
            let doomed_anchors: std::collections::HashSet<_> = doomed_indices
                .iter()
                .filter_map(|&i| project.key_for_ref(StationRef::new(section_id, i)))
                .collect();

            for &sid in &range_shot_ids {
                if let Err(e) = project.remove_shot_with_rewire_excluding_anchors(
                    section_id,
                    sid,
                    &doomed_anchors,
                    /* defer_cascade */ true,
                ) {
                    // Already mutated — roll back to the before snapshot.
                    let _ = Self::restore_snapshot_into(&mut proj_guard, &before_snapshot);
                    return CommandResult::failure(e);
                }
            }
            // Single cascade now that every range shot (and any doomed merge) is
            // gone, so a doomed station's intermediate shift never propagates into
            // a connected free-floating section — the per-shot cascades were
            // deferred for exactly this reason. Assert alignment here, since each
            // per-shot delete skipped its own alignment check.
            project.cascade_connection_offsets(&[section_id]);
            project.debug_assert_merge_alignment("delete_shot_range_shift");
            section_id
        };

        self.reconcile_geometry();

        let after_snapshot = match self.capture_after_snapshot_or_rollback(&before_snapshot) {
            Ok(s) => s,
            Err(result) => return result,
        };

        let batch_cmd = Command::Batch {
            commands: vec![
                Command::DeleteShot {
                    section_id,
                    shot_id: start_shot_id,
                },
                Command::DeleteShot {
                    section_id,
                    shot_id: end_shot_id,
                },
            ],
        };
        self.push_snapshot_undo(batch_cmd, before_snapshot, after_snapshot);

        tracing::info!(
            section_id,
            purpose = "gap-close a deleted shot range",
            "Delete shot range (shift) completed"
        );
        CommandResult::success().with_section_id(result_section)
    }

    /// Execute a delete-last-shot-and-section operation as a single atomic undo/redo unit.
    /// When a section has exactly 1 shot remaining, this removes the section (and its
    /// only shot) along with all section references (merges, closures, section_offsets,
    /// station_offsets, zero_datums). Uses `ProjectSnapshotPair` for single-undo.
    pub fn execute_delete_last_shot_and_section(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
    ) -> CommandResult {
        // Serialize command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
        tracing::info!(
            section_id,
            shot_id,
            purpose = "remove single-shot section",
            "Executing delete_last_shot_and_section as single undo unit"
        );

        // Step 1: Take BEFORE snapshot
        let before_snapshot = match self.capture_project_snapshot() {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Step 2: Validate, mutate, and capture AFTER snapshot in a single lock scope.
        // This ensures the after snapshot is always captured atomically with the mutation,
        // and on any failure after mutation we rollback from before_snapshot.
        let after_snapshot = {
            let Ok(mut proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };

            let Some(project) = proj_guard.as_mut() else {
                return CommandResult::failure("No project open".to_string());
            };

            // Validate section exists
            let Some(section) = project.get_section(section_id) else {
                return CommandResult::failure(format!("Section {section_id} not found"));
            };

            // Verify section has exactly 1 shot
            if section.shots.len() != 1 {
                return CommandResult::failure(format!(
                    "Section {} has {} shots, expected exactly 1",
                    section_id,
                    section.shots.len()
                ));
            }

            // Verify the shot matches
            if section.shots[0].id != shot_id {
                return CommandResult::failure(format!(
                    "Shot {} not found in section {} (section has shot {})",
                    shot_id, section_id, section.shots[0].id
                ));
            }

            // Step 3: Preserve merge/closure connectivity, then clean up section references
            project.preserve_connections_for_section_deletion(section_id);

            project.station_merges.retain(|m| {
                m.station_a.section_id != section_id && m.station_b.section_id != section_id
            });
            // The retain just dropped entries the adjacency cache still
            // claims exist — clear it so the next get_merged_section_ids
            // doesn't fast-path against stale data.
            project.merge_adjacency_cache.clear();

            project.loop_closures.retain(|lc| {
                lc.station_a.section_id != section_id && lc.station_b.section_id != section_id
            });

            // Remove section offsets
            project.remove_section_offset(section_id);

            // Remove station offsets referencing this section
            project
                .station_offsets
                .retain(|key, _| key.section_id != section_id);

            // Remove station comments referencing this section
            project
                .station_comments
                .retain(|key, _| key.section_id != section_id);

            // Remove zero datums referencing this section
            project
                .zero_datums
                .retain(|zd| zd.station_ref.section_id != section_id);

            // Step 4: Remove the section (and its only shot)
            if project.remove_section(section_id).is_none() {
                // Section vanished between validation and removal (should not happen).
                // Rollback to before_snapshot to undo reference cleanup.
                tracing::error!(
                    section_id,
                    purpose = "remove single-shot section",
                    "remove_section returned None after validation; rolling back"
                );
                let _ = Self::restore_snapshot_into(&mut proj_guard, &before_snapshot);
                return CommandResult::failure(format!(
                    "Section {section_id} not found during removal"
                ));
            }

            tracing::info!(
                section_id,
                shot_id,
                purpose = "remove single-shot section",
                "Deleted last shot and removed section"
            );

            // Step 5: Take AFTER snapshot while still holding the lock
            if let Some(p) = proj_guard.as_ref() {
                match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => {
                        // Rollback: restore before_snapshot since we already mutated
                        tracing::error!(
                            purpose = "finalize delete_last_shot snapshot",
                            reason = %e,
                            "Failed to serialize after snapshot; rolling back"
                        );
                        if Self::restore_snapshot_into(&mut proj_guard, &before_snapshot) {
                            tracing::info!(
                                purpose = "restore after snapshot failure",
                                "Successfully rolled back after snapshot failure"
                            );
                        }
                        return CommandResult::failure(format!(
                            "Failed to serialize after snapshot: {e}"
                        ));
                    }
                }
            } else {
                // Project became None -- restore
                tracing::error!(
                    purpose = "restore after mutation failure",
                    "Project became None after mutation; rolling back"
                );
                let _ = Self::restore_snapshot_into(&mut proj_guard, &before_snapshot);
                return CommandResult::failure("No project after mutation".to_string());
            }
        };

        // Step 6: Push single undo entry with ProjectSnapshotPair
        let batch_cmd = Command::Batch {
            commands: vec![
                Command::DeleteShot {
                    section_id,
                    shot_id,
                },
                Command::DeleteSection { section_id },
            ],
        };

        self.push_snapshot_undo(batch_cmd, before_snapshot, after_snapshot);

        CommandResult::success()
    }

    // === Station query operations ===

    /// Check merge connectivity between two stations (read-only)
    pub fn check_merge_connectivity(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> Result<ConnectivityResult, String> {
        let proj_guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let project = proj_guard
            .as_ref()
            .ok_or_else(|| "No project open".to_string())?;

        // Validate stations exist
        if !project.station_exists(station_a) {
            return Err("Station A does not exist.".to_string());
        }
        if !project.station_exists(station_b) {
            return Err("Station B does not exist.".to_string());
        }

        // Check if stations already merged
        if project.are_stations_merged(station_a, station_b) {
            return Err("These stations are already merged.".to_string());
        }

        // Check for existing closure between them
        if project.are_stations_in_closure(station_a, station_b) {
            return Err("A loop closure already exists between these stations.".to_string());
        }

        // Always compute connectivity (via merges and closures) for the `connected` field
        let connected_a = project.get_connected_section_ids(station_a.section_id);
        let connected = connected_a.contains(&station_b.section_id);
        let preview = if connected {
            Some(project.compute_closure_metrics(station_a, station_b)?)
        } else {
            None
        };

        // Check zero datum constraints (merge-only rigid groups)
        let merged_a = project.get_merged_section_ids(station_a.section_id);
        let a_has_zd = project
            .zero_datums
            .iter()
            .any(|zd| merged_a.contains(&zd.station_ref.section_id));
        let merged_b = project.get_merged_section_ids(station_b.section_id);
        let b_has_zd = project
            .zero_datums
            .iter()
            .any(|zd| merged_b.contains(&zd.station_ref.section_id));

        // Determine can_merge and reason with zero datum priority
        let (can_merge, reason) = if connected {
            // Already connected — merging would create a survey loop
            (false, Some("Creates survey loop".to_string()))
        } else if a_has_zd && b_has_zd {
            // Both sections have fixed coordinates — cannot merge
            (
                false,
                Some("Both sections have fixed coordinates".to_string()),
            )
        } else {
            // Not connected and zero datum check passed — merge allowed
            (true, None)
        };

        Ok(ConnectivityResult {
            connected,
            preview,
            can_merge,
            reason,
        })
    }

    // === Project merge operations ===

    // === Query operations ===

    /// Get all section IDs connected to the given section through merges and closures
    pub fn get_connected_section_ids(
        &self,
        section_id: SectionId,
    ) -> Result<Vec<SectionId>, String> {
        // Serialize with command execution to avoid observing intermediate batch state
        let _cmd_guard = self
            .command_lock
            .lock()
            .map_err(|_| "Failed to acquire command lock".to_string())?;
        let proj_guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let project = proj_guard
            .as_ref()
            .ok_or_else(|| "No project open".to_string())?;

        // Validate section exists
        if !project.sections.iter().any(|s| s.id == section_id) {
            return Err(format!("Section {section_id} not found"));
        }

        // Filter to existing sections (stale merges/closures may reference deleted sections)
        let existing: std::collections::HashSet<SectionId> =
            project.sections.iter().map(|s| s.id).collect();
        let connected = project.get_connected_section_ids(section_id);
        let mut result: Vec<SectionId> = connected
            .into_iter()
            .filter(|id| existing.contains(id))
            .collect();
        result.sort_unstable();
        Ok(result)
    }

    /// Get all section IDs connected through merges and aligned closures (rigid groups).
    pub fn get_rigid_connected_section_ids(
        &self,
        section_id: SectionId,
    ) -> Result<Vec<SectionId>, String> {
        // Serialize with command execution to avoid observing intermediate batch state
        let _cmd_guard = self
            .command_lock
            .lock()
            .map_err(|_| "Failed to acquire command lock".to_string())?;
        self.with_project(|project| {
            // Validate section exists
            if !project.sections.iter().any(|s| s.id == section_id) {
                return Err(format!("Section {section_id} not found"));
            }

            // Filter to existing sections (stale merges/closures may reference deleted sections)
            let existing: std::collections::HashSet<SectionId> =
                project.sections.iter().map(|s| s.id).collect();
            let connected = project.get_rigid_connected_section_ids(section_id);
            let mut result: Vec<SectionId> = connected
                .into_iter()
                .filter(|id| existing.contains(id))
                .collect();
            result.sort_unstable();
            Ok(result)
        })
    }

    /// Get shot-line geometry for all sections in the segment containing the given section.
    /// Coordinates are relative to the given section's station 0.
    pub fn get_segment_geometry(
        &self,
        section_id: SectionId,
    ) -> Result<crate::commands::section::SegmentGeometry, String> {
        use crate::commands::section::{SegmentGeometry, SegmentSectionGeometry};

        // Serialize with command execution to avoid observing intermediate batch state
        let _cmd_guard = self
            .command_lock
            .lock()
            .map_err(|_| "Failed to acquire command lock".to_string())?;
        let proj_guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let project = proj_guard
            .as_ref()
            .ok_or_else(|| "No project open".to_string())?;

        // Validate section exists
        if !project.sections.iter().any(|s| s.id == section_id) {
            return Err(format!("Section {section_id} not found"));
        }

        // Get all connected section IDs
        let existing: std::collections::HashSet<SectionId> =
            project.sections.iter().map(|s| s.id).collect();
        let connected = project.get_connected_section_ids(section_id);
        let connected: std::collections::HashSet<SectionId> = connected
            .into_iter()
            .filter(|id| existing.contains(id))
            .collect();

        // Compute all station coordinates
        let all_stations = project.compute_station_coordinates();

        // Find anchor: station 0 of the given section
        let anchor = all_stations
            .iter()
            .find(|s| s.station_ref.section_id == section_id && s.station_ref.station_index == 0)
            .map(|s| (s.coordinates.x, s.coordinates.y))
            .unwrap_or((0.0, 0.0));

        // Group stations by section
        let mut section_stations: std::collections::HashMap<
            SectionId,
            Vec<&crate::models::Station>,
        > = std::collections::HashMap::new();
        for station in &all_stations {
            if connected.contains(&station.station_ref.section_id) {
                section_stations
                    .entry(station.station_ref.section_id)
                    .or_default()
                    .push(station);
            }
        }

        // Build geometry for each section
        let mut sections = Vec::new();
        for &sid in &connected {
            let Some(section) = project.sections.iter().find(|s| s.id == sid) else {
                continue;
            };
            let Some(stations) = section_stations.get(&sid) else {
                continue;
            };

            // Sort stations by station_index to ensure correct shot-line pairing
            let mut sorted_stations = stations.clone();
            sorted_stations.sort_by_key(|s| s.station_ref.station_index);

            // Build shot lines: consecutive station pairs (station i → station i+1)
            let mut shot_lines = Vec::new();
            for pair in sorted_stations.windows(2) {
                let from = pair[0];
                let to = pair[1];
                shot_lines.push([
                    [from.coordinates.x - anchor.0, from.coordinates.y - anchor.1],
                    [to.coordinates.x - anchor.0, to.coordinates.y - anchor.1],
                ]);
            }

            sections.push(SegmentSectionGeometry {
                section_id: sid,
                color: section.color.clone(),
                shot_lines,
            });
        }

        Ok(SegmentGeometry { sections })
    }

    /// Get all section IDs anchored by a zero datum.
    /// A zero datum anchors every section reachable through merges AND aligned closures,
    /// since unaligned closures are not rigidly constrained yet.
    pub fn get_anchored_section_ids(&self) -> Result<Vec<SectionId>, String> {
        // Serialize with command execution to avoid observing intermediate batch state
        let _cmd_guard = self
            .command_lock
            .lock()
            .map_err(|_| "Failed to acquire command lock".to_string())?;
        self.with_project(|project| {
            // Filter to existing sections (stale merges/closures may reference deleted sections)
            let existing: std::collections::HashSet<SectionId> =
                project.sections.iter().map(|s| s.id).collect();
            let mut anchored = std::collections::HashSet::new();
            for zd in &project.zero_datums {
                let connected = project.get_rigid_connected_section_ids(zd.station_ref.section_id);
                anchored.extend(connected.into_iter().filter(|id| existing.contains(id)));
            }
            let mut result: Vec<SectionId> = anchored.into_iter().collect();
            result.sort_unstable();
            Ok(result)
        })
    }
}

#[cfg(test)]
mod integrity_capability_tests {
    use super::*;
    use crate::models::{Coordinates, ShotData, StationRef};

    /// Locks the integrity-capability table (one command per profile). The
    /// exhaustive match in `command_integrity` makes a new variant a *compile*
    /// error; this guards against an existing variant being moved to the wrong
    /// profile — especially the REMOVES group, where dropping `can_dangle_refs`
    /// would skip the rollback snapshot and let corruption be committed.
    #[test]
    fn command_integrity_profiles_are_stable() {
        let caps = |cmd: &Command| {
            let i = AppState::command_integrity(cmd);
            (i.affects_geometry, i.can_dangle_refs, i.can_orphan_closures)
        };

        // INERT (no geometry, no refs).
        assert_eq!(caps(&Command::CloseProject), (false, false, false));
        assert_eq!(
            caps(&Command::SaveProject {
                path: None,
                is_autosave: false
            }),
            (false, false, false)
        );
        // RepairIntegrity never runs through execute(); it is classified INERT.
        assert_eq!(caps(&Command::RepairIntegrity), (false, false, false));
        // Comment edits are metadata-only — INERT, so a comment edit can't run the
        // reconcile epilogue (which would heal a drifted project with no undo).
        assert_eq!(
            caps(&Command::SetStationComment {
                station_ref: StationRef::new(1, 0),
                comment: None
            }),
            (false, false, false)
        );
        assert_eq!(
            caps(&Command::MoveComment {
                source: CommentHolder::Station {
                    station_ref: StationRef::new(1, 0)
                },
                target: CommentHolder::Station {
                    station_ref: StationRef::new(1, 1)
                },
                swap: false,
            }),
            (false, false, false)
        );

        // REMOVES (can dangle refs AND orphan a closure → needs rollback snapshot
        // + reconcile + orphan-closure conversion).
        assert_eq!(
            caps(&Command::DeleteSection { section_id: 1 }),
            (true, true, true)
        );
        assert_eq!(
            caps(&Command::Batch { commands: vec![] }),
            (true, true, true)
        );

        // CREATE_SHOT (renumbers stations → can dangle, but cannot orphan).
        assert_eq!(
            caps(&Command::CreateShot {
                section_id: 1,
                shot: ShotData::default(),
                after_shot_id: None,
                before_shot_id: None,
            }),
            (true, true, false)
        );

        // UNMERGE (removes connectivity → can orphan, but adds no dangling ref).
        assert_eq!(
            caps(&Command::UnmergeStations {
                station_ref: StationRef::new(1, 0)
            }),
            (true, false, true)
        );

        // GEOMETRY_ONLY (shifts offsets only).
        assert_eq!(
            caps(&Command::MoveSection {
                section_id: 1,
                offset: Coordinates::new(1.0, 2.0, 0.0),
            }),
            (true, false, false)
        );
        // UpdateShot shifts geometry (a measurement edit moves stations) but keeps
        // refs valid and connectivity intact — it must reconcile, not be inert.
        assert_eq!(
            caps(&Command::UpdateShot {
                section_id: 1,
                shot_id: 0,
                updates: ShotUpdates::default(),
            }),
            (true, false, false)
        );
    }

    /// The data-table grid commits multi-cell edits (paste/fill) as one batch →
    /// one undo. `UpdateShot` must be batch-allowed (the batch epilogue reconciles
    /// only when an edit in the batch actually touches geometry); `SetStationComment`
    /// must NOT be (INERT metadata — it could never carry the geometry that
    /// justifies a batch, and batching it once ran the reconcile epilogue and could
    /// heal drift silently).
    #[test]
    fn update_shot_is_batch_allowed_but_station_comment_is_not() {
        assert!(AppState::is_batch_allowed(&Command::UpdateShot {
            section_id: 1,
            shot_id: 0,
            updates: ShotUpdates::default(),
        }));
        assert!(!AppState::is_batch_allowed(&Command::SetStationComment {
            station_ref: StationRef::new(1, 0),
            comment: None,
        }));
    }
}

#[cfg(test)]
mod update_shot_clear_undo_tests {
    use super::*;

    fn shot_data(left: Option<f64>) -> ShotData {
        ShotData {
            azimuth_in: 10.0,
            azimuth_out: 10.0,
            length: 5.0,
            depth_in: 0.0,
            depth_out: 1.0,
            left,
            ..Default::default()
        }
    }

    fn state_with_one_shot(left: Option<f64>) -> (AppState, SectionId, ShotId) {
        let state = AppState::new().unwrap();
        state.execute(Command::CreateProject {
            name: "Clear".to_string(),
            location: None,
        });
        let section_id = state
            .execute(Command::CreateSection {
                name: None,
                surveyor: None,
                date: None,
                color: "#ff0000".to_string(),
                direction: None,
                shots: vec![shot_data(left)],
            })
            .section_id
            .unwrap();
        let shot_id = state.get_project_state().unwrap().sections[0].shots[0].id;
        (state, section_id, shot_id)
    }

    /// A grid cell clear arrives as JSON `null` (deserialized to `Some(None)`,
    /// see `double_option`); the command must apply it and undo must restore
    /// the cleared value through the serialized `values_json` round-trip.
    #[test]
    fn update_shot_null_clears_field_and_undo_restores_it() {
        let (state, section_id, shot_id) = state_with_one_shot(Some(0.5));

        let updates: ShotUpdates =
            serde_json::from_value(serde_json::json!({ "left": null })).unwrap();
        let result = state.execute(Command::UpdateShot {
            section_id,
            shot_id,
            updates,
        });
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            state.get_project_state().unwrap().sections[0].shots[0].left,
            None
        );

        assert!(state.undo().success);
        assert_eq!(
            state.get_project_state().unwrap().sections[0].shots[0].left,
            Some(0.5),
            "undo must restore the cleared value"
        );
    }

    /// The reverse direction: setting a previously-empty field must undo back
    /// to empty — the captured previous value `Some(None)` has to survive the
    /// `values_json` round-trip as `null` rather than fold into "no update".
    #[test]
    fn update_shot_set_on_empty_field_undoes_back_to_empty() {
        let (state, section_id, shot_id) = state_with_one_shot(None);

        let updates: ShotUpdates =
            serde_json::from_value(serde_json::json!({ "left": 1.2 })).unwrap();
        let result = state.execute(Command::UpdateShot {
            section_id,
            shot_id,
            updates,
        });
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            state.get_project_state().unwrap().sections[0].shots[0].left,
            Some(1.2)
        );

        assert!(state.undo().success);
        assert_eq!(
            state.get_project_state().unwrap().sections[0].shots[0].left,
            None,
            "undo must clear the field back to its previous empty state"
        );
    }
}
