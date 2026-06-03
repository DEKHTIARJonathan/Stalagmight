use std::sync::Mutex;

use crate::core::{Command, CommentHolder, CommandResult, UndoData, Validator};
use crate::models::{
    shot_display_position, ClosureStrategy, ConnectivityResult, Coordinates, GpsCoordinates,
    Project, SectionData, SectionId, SectionUpdates, ShotData, ShotId, ShotUpdates, StationRef,
    ViolationSeverity, FEATURE_ID_STRIDE,
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

impl AppState {
    /// Whether a command can drift section offsets (move merged partners out of
    /// alignment) and therefore needs the post-command geometry reconcile. Pure
    /// metadata edits and lifecycle commands cannot, so they skip it.
    fn command_can_affect_integrity(cmd: &Command) -> bool {
        !matches!(
            cmd,
            Command::CreateProject { .. }
                | Command::OpenProject { .. }
                | Command::SaveProject { .. }
                | Command::CloseProject
                | Command::UpdateShot { .. }
                | Command::UpdateSectionMetadata { .. }
                | Command::SetShotReference { .. }
        )
    }

    /// Whether a command can introduce a *dangling/out-of-range cross-reference*
    /// — by removing a referenced entity or renumbering station indices — and so
    /// needs the (expensive) whole-project rollback snapshot. Geometry-only
    /// commands (moves, merges, datums, closures) add valid refs or shift
    /// offsets but cannot dangle a reference, so they get the cheap
    /// reconcile-only path and skip the serialize.
    fn command_can_dangle_refs(cmd: &Command) -> bool {
        matches!(
            cmd,
            Command::DeleteSection { .. }
                | Command::DeleteShot { .. }
                | Command::CreateShot { .. }
                | Command::Batch { .. }
                | Command::MergeProjects { .. }
        )
    }

    /// Structural-integrity violation messages for the open project, critical
    /// first. Empty when the project is sound or none is open. Used by the
    /// load-time "warn and offer repair" surface.
    pub fn integrity_violation_messages(&self) -> Vec<String> {
        let Some(project) = self.get_project_state() else {
            return Vec::new();
        };
        // Structural (dangling refs) + geometric (drifted merges + stale,
        // still-marked-closed loop closures).
        let mut violations = project.check_structural_integrity();
        violations.extend(project.check_merge_alignment());
        violations.extend(project.check_closure_alignment());
        violations.sort_by_key(|v| match v.severity {
            ViolationSeverity::Critical => 0,
            ViolationSeverity::Warning => 1,
        });
        violations.into_iter().map(|v| v.message).collect()
    }

    /// Repair the open project's integrity: drop dangling refs/orphans, then
    /// re-cascade section offsets so drifted merges line up again. Returns the
    /// number of issues fixed.
    pub fn repair_open_project_integrity(&self) -> usize {
        let mut guard = match self.project.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(project) = guard.as_mut() else {
            return 0;
        };
        let structural = project.repair_structural_integrity().len();
        // Dropping refs may have cleared the adjacency cache; rebuild before the
        // cascade walks the merge graph.
        project.rebuild_merge_adjacency();
        let realigned = project.realign_merges();
        structural + realigned
    }

    /// Execute a command and return the result
    pub fn execute(&self, cmd: Command) -> CommandResult {
        // Serialize all command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
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

        // Snapshot before a ref-removing/renumbering command so a result that
        // introduces dangling references can be rejected and rolled back —
        // corruption must not enter through the command path (#17). Only those
        // commands can dangle a ref, so geometry-only commands (moves, merges,
        // datums) skip the expensive whole-project serialize (#8).
        let integrity_snapshot = if Self::command_can_dangle_refs(&cmd) {
            self.capture_project_snapshot().ok()
        } else {
            None
        };
        // If the project is ALREADY corrupt (loaded that way), don't block — the
        // user repairs via the banner. We only reject commands that newly
        // introduce corruption into a clean project.
        let pre_had_critical = integrity_snapshot.is_some()
            && self
                .project
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(Project::has_critical_integrity_violations))
                .unwrap_or(false);

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
            Command::RemoveLoopClosure { closure_id } => {
                self.remove_loop_closure(*closure_id)
            }
            Command::AdjustLoopClosures {
                anchor_station,
                method,
            } => self.adjust_loop_closures(*anchor_station, *method),
            Command::SetZeroDatum {
                station_ref,
                coordinates,
            } => self.set_zero_datum(*station_ref, *coordinates),
            Command::RemoveZeroDatum { station_ref } => self.remove_zero_datum(*station_ref),
            Command::SetStationComment {
                station_ref,
                comment,
            } => self.set_station_comment(*station_ref, comment.clone()),
            Command::MoveSection { section_id, offset } => {
                self.move_section(*section_id, *offset)
            }
            Command::MoveSegment { section_id, offset } => {
                self.move_segment(*section_id, *offset)
            }
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
        };

        // Block corruption at the source: if a structural command left the
        // project with dangling references, roll back to the pre-command
        // snapshot and reject it rather than committing (and later persisting)
        // a corrupt state (#17).
        if result.success && !pre_had_critical {
            if let Some(snapshot) = &integrity_snapshot {
                let introduced_corruption = self
                    .project
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(Project::has_critical_integrity_violations))
                    .unwrap_or(false);
                if introduced_corruption {
                    self.rollback_project(snapshot);
                    tracing::error!(
                        command = ?cmd.description(),
                        purpose = "block corruption at the source",
                        "Rejected command that would corrupt survey structure; rolled back"
                    );
                    return CommandResult::failure(
                        "Blocked: this action would corrupt the survey structure \
                         (it leaves dangling references). No changes were made."
                            .to_string(),
                    );
                }
            }
        }

        // Treat section offsets as derived: after any structural command,
        // reconcile geometry so no command path can leave merged stations
        // drifted (a no-op when nothing moved; skipped during bulk import).
        if result.success && Self::command_can_affect_integrity(&cmd) {
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
        use std::collections::{HashMap, HashSet};
        use crate::models::{ClosureStrategy, ImportPlacement, StationRef};

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
                        if update.section_id != sid { continue; }
                        if let Some(idx) = section.shots.iter().position(|s| s.id == update.shot_id) {
                            modified_indices.push(idx as u32);
                        }
                    }
                    if modified_indices.is_empty() { continue; }
                    let min_shot = *modified_indices.iter().min().unwrap();
                    let max_shot = *modified_indices.iter().max().unwrap();

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
                            anchor_indices.push(zd.station_ref.station_index);
                        }
                    }
                    // Station merges (only datum-backed partners)
                    for m in &project.station_merges {
                        if m.station_a.section_id == sid {
                            if project.has_datum_path_excluding(m.station_b.section_id, sid) {
                                anchor_indices.push(m.station_a.station_index);
                            }
                        }
                        if m.station_b.section_id == sid {
                            if project.has_datum_path_excluding(m.station_a.section_id, sid) {
                                anchor_indices.push(m.station_b.station_index);
                            }
                        }
                    }
                    // Aligned closures (only datum-backed partners)
                    for c in &project.loop_closures {
                        if !c.is_aligned { continue; }
                        if c.station_a.section_id == sid {
                            if project.has_datum_path_excluding(c.station_b.section_id, sid) {
                                anchor_indices.push(c.station_a.station_index);
                            }
                        }
                        if c.station_b.section_id == sid {
                            if project.has_datum_path_excluding(c.station_a.section_id, sid) {
                                anchor_indices.push(c.station_b.station_index);
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
                    if blocked_sections.contains(&sid) { continue; }
                    if let Some(zd) = project.zero_datums.iter().find(|zd| zd.station_ref.section_id == sid) {
                        if let Some(coords) = project.compute_station_raw_coords(zd.station_ref) {
                            tracing::debug!(
                                section_id = sid,
                                anchor_station = zd.station_ref.station_index,
                                x = coords.x,
                                y = coords.y,
                                purpose = "zero datum stability",
                                "Recorded anchor position before shot updates",
                            );
                            anchor_positions.insert(sid, (zd.station_ref, coords));
                        }
                    }
                }

                // Apply the shot updates (skipping doubly-anchored sections)
                for update in &existing_shot_updates {
                    if blocked_sections.contains(&update.section_id) { continue; }
                    if let Some(section) = project.sections.iter_mut().find(|s| s.id == update.section_id) {
                        if let Some(shot) = section.shots.iter_mut().find(|s| s.id == update.shot_id) {
                            let old_len = shot.length;
                            if let Some(v) = update.updates.azimuth_in { shot.azimuth_in = v; }
                            if let Some(v) = update.updates.azimuth_out { shot.azimuth_out = v; }
                            if let Some(v) = update.updates.length { shot.length = v; }
                            if let Some(v) = update.updates.depth_in { shot.depth_in = v; }
                            if let Some(v) = update.updates.depth_out { shot.depth_out = v; }
                            if let Some(v) = update.updates.pitch_in { shot.pitch_in = v; }
                            if let Some(v) = update.updates.pitch_out { shot.pitch_out = v; }
                            if let Some(v) = update.updates.left { shot.left = v; }
                            if let Some(v) = update.updates.right { shot.right = v; }
                            if let Some(v) = update.updates.up { shot.up = v; }
                            if let Some(v) = update.updates.down { shot.down = v; }
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
                        project.station_comments.insert(station_ref, comment.clone());
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

                ImportPlacement::ZeroDatum { coordinates, station_index } => {
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

                ImportPlacement::FromExisting { import_station, existing_station } => {
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

                ImportPlacement::FromImporting { import_station, target_section_index, target_station_index } => {
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

                ImportPlacement::Manual { align_station_index: _, offset } => {
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

                ImportPlacement::ManualSnap { align_station_index, snapped_to_station } => {
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

        // Capture after-snapshot for redo support
        let after_snapshot = match self.capture_after_snapshot_or_rollback(&before_snapshot) {
            Ok(s) => s,
            Err(result) => return result,
        };

        // Push a single undo entry covering all sections + hash
        self.push_snapshot_undo(
            Command::Batch { commands: batch_commands },
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
        let config = self.config.lock().ok();

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
            if let Some(ref cfg) = config {
                warnings.extend(Validator::validate_shot(shot, &cfg.validation, section_id_for_validation, i));
            }
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

    pub(super) fn update_section(&self, section_id: SectionId, updates: SectionUpdates) -> CommandResult {
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

        let config = self.config.lock().ok();

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
                section.shots.iter().position(|shot| shot.id == before_id).unwrap_or(0)
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
        if let Some(ref cfg) = config {
            warnings.extend(Validator::validate_shot(&data, &cfg.validation, section_id, shot_index));
        }

        let shot = if let Some(before_id) = before_shot_id {
            project.insert_shot_before(section_id, before_id, data, None)
        } else if let Some(after_id) = after_shot_id {
            project.insert_shot_after(section_id, after_id, data, None)
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
            return CommandResult::failure("Shot update has a non-finite (NaN/inf) value".to_string());
        }

        // Validate resulting length (disallow zero/negative)
        if let Some(section) = project.sections.iter().find(|s| s.id == section_id) {
            if let Some((shot_index, existing)) = section.shots.iter().enumerate().find(|(_, s)| s.id == shot_id) {
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
                if updates.touches_geometry() {
                    let section_lookup = project.build_section_lookup();
                    let merge_adj = project.build_merge_adjacency(&section_lookup);
                    let closure_adj = project.build_aligned_closure_adjacency(&section_lookup);
                    let datum_stations: std::collections::HashSet<_> =
                        project.zero_datums.iter().map(|d| d.station_ref).collect();
                    if project.is_shot_frozen(
                        section_id,
                        shot_index,
                        &section_lookup,
                        &merge_adj,
                        &closure_adj,
                        &datum_stations,
                    ) {
                        return CommandResult::failure(
                            "Cannot edit geometry of a frozen shot. This shot is part of an adjusted survey network.".to_string()
                        );
                    }
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

        if let Ok(impact) = project.preview_delete_shot(section_id, shot_id) {
            if impact.shift_blocked {
                let reasons = if impact.shift_blocked_reasons.is_empty() {
                    "Shift geometry is not allowed for this shot.".to_string()
                } else {
                    impact.shift_blocked_reasons.join(" ")
                };
                return CommandResult::failure(format!(
                    "{reasons} Use split instead."
                ));
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

    pub(super) fn adjust_loop_closures(
        &self,
        anchor_station: StationRef,
        method: ClosureStrategy,
    ) -> CommandResult {
        let config = self.get_config();
        self.with_project_mut(|project| {
            let mut working = project.clone();

            match working.adjust_loop_closures(
                anchor_station,
                method,
                &config.closure_adjustment,
            ) {
                Ok(()) => {
                    working.touch();
                    *project = working;
                    tracing::debug!(
                        ?anchor_station,
                        ?method,
                        purpose = "reduce misclosure error",
                        "Loop closures adjusted"
                    );
                    CommandResult::success()
                }
                Err(e) => {
                    tracing::warn!(
                        ?anchor_station,
                        ?method,
                        error = %e,
                        purpose = "reduce misclosure error",
                        "Failed to adjust loop closures"
                    );
                    CommandResult::failure(e)
                }
            }
        })
    }

    pub(super) fn unmerge_stations(&self, station_ref: StationRef) -> CommandResult {
        self.with_project_mut(|project| {
            // Find and unmerge all merges involving this station
            let merges_to_remove: Vec<_> = project
                .station_merges
                .iter()
                .filter(|m| m.station_a == station_ref || m.station_b == station_ref)
                .map(|m| (m.station_a, m.station_b))
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

    pub(super) fn set_zero_datum(&self, station_ref: StationRef, gps: GpsCoordinates) -> CommandResult {
        self.with_project_mut(|project| {
            match project.set_zero_datum(station_ref, gps) {
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
            }
        })
    }

    pub(super) fn remove_zero_datum(&self, station_ref: StationRef) -> CommandResult {
        self.with_project_mut(|project| {
            if project.remove_zero_datum(station_ref) {
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
                    project.station_comments.insert(station_ref, text);
                }
                _ => {
                    project.station_comments.remove(&station_ref);
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
                let section = project.get_section(station_ref.section_id).ok_or_else(|| {
                    format!("Section {} not found", station_ref.section_id)
                })?;
                let max_station_index = section.shots.len() as u32;
                if station_ref.station_index > max_station_index {
                    return Err(format!(
                        "Station index {} out of range",
                        station_ref.station_index
                    ));
                }
                Ok(project.station_comments.get(station_ref).cloned())
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
                        project.station_comments.insert(*station_ref, text);
                    }
                    _ => {
                        project.station_comments.remove(station_ref);
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
        self.with_project_mut(|project| {
            if !project.sections.iter().any(|s| s.id == section_id) {
                return CommandResult::failure("Section not found".to_string());
            }

            if project.section_has_direct_datum(section_id)
                && (offset.x.abs() > 1e-9 || offset.y.abs() > 1e-9 || offset.z.abs() > 1e-9)
            {
                return CommandResult::failure(
                    "Cannot move a section that directly holds a zero datum".to_string(),
                );
            }

            project.adjust_section_offset(section_id, offset.x, offset.y);
            project.touch();
            tracing::debug!(
                ?section_id,
                ?offset,
                purpose = "reposition section for alignment",
                "Section moved"
            );
            CommandResult::success()
        })
    }

    pub(super) fn move_segment(&self, section_id: SectionId, offset: Coordinates) -> CommandResult {
        self.with_project_mut(|project| {
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

    pub(super) fn move_station(&self, station_ref: StationRef, offset: Coordinates) -> CommandResult {
        self.with_project_mut(|project| {
            if project.zero_datums.iter().any(|zd| zd.station_ref == station_ref)
                && (offset.x.abs() > 1e-9 || offset.y.abs() > 1e-9 || offset.z.abs() > 1e-9)
            {
                return CommandResult::failure(
                    "Cannot move a zero datum station".to_string(),
                );
            }

            // Incorporate any existing station offset
            let existing = project.station_offsets.get(&station_ref).copied().unwrap_or((0.0, 0.0, 0.0));
            let total_dx = existing.0 + offset.x;
            let total_dy = existing.1 + offset.y;
            let total_dz = existing.2 + offset.z;

            // Find the section containing this station (mutable)
            let Some(section) = project.sections.iter_mut().find(|s| s.id == station_ref.section_id) else {
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
                if new_len <= 0.0 {
                    return CommandResult::failure("Move would create zero-length shot".to_string());
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
                if new_len <= 0.0 {
                    return CommandResult::failure("Move would create zero-length shot".to_string());
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
                let current = project.section_offsets.get(&station_ref.section_id).copied().unwrap_or((0.0, 0.0));
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
            project.station_offsets.remove(&station_ref);
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

    /// Check if a command is allowed in a batch (whitelist for IPC safety)
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
                None => return CommandResult::failure(
                    format!("Shot {shot_id} not found in section {section_id}")
                ),
                Some(p) if p == 0 || p == section.shots.len() - 1 => {
                    return CommandResult::failure(
                        "Cannot split at edge shot (first or last). Use simple delete instead.".to_string()
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

            // Step 6: Remap merge/closure/station_offset references
            // Stations after split point belong to new section with adjusted indices.
            // Original station indices: 0..pos are section A, pos+1..N are section B (shifted)
            // The split position is the deleted shot. Stations in section B had indices
            // pos+1 through N (N = original shot count). In section B, they become
            // 0 through (N - pos - 1).
            let split_station = pos + 1; // first station index that belongs to section B

            // Original station count = shots_before + deleted_shot + shots_after + 1
            let original_station_count = shots_before.len() + 1 + shots_after_len + 1;

            // Remap station merges
            for merge in &mut project.station_merges {
                if merge.station_a.section_id == section_id
                    && (merge.station_a.station_index as usize) >= split_station
                    && (merge.station_a.station_index as usize) < original_station_count
                {
                    merge.station_a.section_id = new_id;
                    merge.station_a.station_index -= split_station as u32;
                }
                if merge.station_b.section_id == section_id
                    && (merge.station_b.station_index as usize) >= split_station
                    && (merge.station_b.station_index as usize) < original_station_count
                {
                    merge.station_b.section_id = new_id;
                    merge.station_b.station_index -= split_station as u32;
                }
            }

            // Remap loop closures
            for closure in &mut project.loop_closures {
                if closure.station_a.section_id == section_id
                    && (closure.station_a.station_index as usize) >= split_station
                    && (closure.station_a.station_index as usize) < original_station_count
                {
                    closure.station_a.section_id = new_id;
                    closure.station_a.station_index -= split_station as u32;
                }
                if closure.station_b.section_id == section_id
                    && (closure.station_b.station_index as usize) >= split_station
                    && (closure.station_b.station_index as usize) < original_station_count
                {
                    closure.station_b.section_id = new_id;
                    closure.station_b.station_index -= split_station as u32;
                }
            }

            // Remap station offsets
            let offsets_to_remap: Vec<(StationRef, (f64, f64, f64))> = project
                .station_offsets
                .iter()
                .filter(|(sr, _)| {
                    sr.section_id == section_id
                        && (sr.station_index as usize) >= split_station
                        && (sr.station_index as usize) < original_station_count
                })
                .map(|(sr, v)| (*sr, *v))
                .collect();

            for (old_ref, offset_val) in offsets_to_remap {
                project.station_offsets.remove(&old_ref);
                let new_ref = StationRef {
                    section_id: new_id,
                    station_index: old_ref.station_index - split_station as u32,
                };
                project.station_offsets.insert(new_ref, offset_val);
            }

            // Remap station comments
            let comments_to_remap: Vec<(StationRef, String)> = project
                .station_comments
                .iter()
                .filter(|(sr, _)| {
                    sr.section_id == section_id
                        && (sr.station_index as usize) >= split_station
                        && (sr.station_index as usize) < original_station_count
                })
                .map(|(sr, v)| (*sr, v.clone()))
                .collect();

            for (old_ref, comment_val) in comments_to_remap {
                project.station_comments.remove(&old_ref);
                let new_ref = StationRef {
                    section_id: new_id,
                    station_index: old_ref.station_index - split_station as u32,
                };
                project.station_comments.insert(new_ref, comment_val);
            }

            // Remap zero datums
            for zd in &mut project.zero_datums {
                if zd.station_ref.section_id == section_id
                    && (zd.station_ref.station_index as usize) >= split_station
                    && (zd.station_ref.station_index as usize) < original_station_count
                {
                    zd.station_ref.section_id = new_id;
                    zd.station_ref.station_index -= split_station as u32;
                }
            }

            project.touch();
            new_id
        };

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
            let station_offset_keys: Vec<StationRef> = project
                .station_offsets
                .keys()
                .filter(|sr| sr.section_id == section_id)
                .copied()
                .collect();
            for key in station_offset_keys {
                project.station_offsets.remove(&key);
            }

            // Remove station comments referencing this section
            project.station_comments.retain(|sr, _| sr.section_id != section_id);

            // Remove zero datums referencing this section
            project.zero_datums.retain(|zd| zd.station_ref.section_id != section_id);

            // Step 4: Remove the section (and its only shot)
            if project.remove_section(section_id).is_none() {
                // Section vanished between validation and removal (should not happen).
                // Rollback to before_snapshot to undo reference cleanup.
                tracing::error!(
                    section_id,
                    purpose = "remove single-shot section",
                    "remove_section returned None after validation; rolling back"
                );
                match serde_json::from_str::<Project>(&before_snapshot) {
                    Ok(restored) => *proj_guard = Some(restored),
                    Err(e) => tracing::error!(
                        purpose = "remove single-shot section",
                        reason = %e,
                        "Failed to rollback from before_snapshot"
                    ),
                }
                return CommandResult::failure(format!("Section {section_id} not found during removal"));
            }

            tracing::info!(
                section_id,
                shot_id,
                purpose = "remove single-shot section",
                "Deleted last shot and removed section"
            );

            // Step 5: Take AFTER snapshot while still holding the lock
            if let Some(p) = proj_guard.as_ref() { match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => {
                    // Rollback: restore before_snapshot since we already mutated
                    tracing::error!(
                        purpose = "finalize delete_last_shot snapshot",
                        reason = %e,
                        "Failed to serialize after snapshot; rolling back"
                    );
                    match serde_json::from_str::<Project>(&before_snapshot) {
                        Ok(restored) => {
                            *proj_guard = Some(restored);
                            tracing::info!(
                                purpose = "restore after snapshot failure",
                                "Successfully rolled back after snapshot failure"
                            );
                        }
                        Err(re) => tracing::error!(
                            purpose = "restore after snapshot failure",
                            reason = %re,
                            "Failed to rollback from before_snapshot"
                        ),
                    }
                    return CommandResult::failure(format!("Failed to serialize after snapshot: {e}"));
                }
            } } else {
                // Project became None -- restore
                tracing::error!(
                    purpose = "restore after mutation failure",
                    "Project became None after mutation; rolling back"
                );
                match serde_json::from_str::<Project>(&before_snapshot) {
                    Ok(restored) => *proj_guard = Some(restored),
                    Err(e) => tracing::error!(
                        purpose = "restore after mutation failure",
                        reason = %e,
                        "Failed to rollback from before_snapshot"
                    ),
                }
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
                Command::DeleteSection {
                    section_id,
                },
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
            return Err(
                "A loop closure already exists between these stations.".to_string(),
            );
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
        let a_has_zd = project.zero_datums.iter().any(|zd| {
            merged_a.contains(&zd.station_ref.section_id)
        });
        let merged_b = project.get_merged_section_ids(station_b.section_id);
        let b_has_zd = project.zero_datums.iter().any(|zd| {
            merged_b.contains(&zd.station_ref.section_id)
        });

        // Determine can_merge and reason with zero datum priority
        let (can_merge, reason) = if connected {
            // Already connected — merging would create a survey loop
            (false, Some("Creates survey loop".to_string()))
        } else if a_has_zd && b_has_zd {
            // Both sections have fixed coordinates — cannot merge
            (false, Some("Both sections have fixed coordinates".to_string()))
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
    pub fn get_connected_section_ids(&self, section_id: SectionId) -> Result<Vec<SectionId>, String> {
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
        let mut result: Vec<SectionId> = connected.into_iter().filter(|id| existing.contains(id)).collect();
        result.sort_unstable();
        Ok(result)
    }

    /// Get all section IDs connected through merges and aligned closures (rigid groups).
    pub fn get_rigid_connected_section_ids(&self, section_id: SectionId) -> Result<Vec<SectionId>, String> {
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
            let mut result: Vec<SectionId> = connected.into_iter().filter(|id| existing.contains(id)).collect();
            result.sort_unstable();
            Ok(result)
        })
    }

    /// Get shot-line geometry for all sections in the segment containing the given section.
    /// Coordinates are relative to the given section's station 0.
    pub fn get_segment_geometry(&self, section_id: SectionId) -> Result<crate::commands::section::SegmentGeometry, String> {
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
        let connected: std::collections::HashSet<SectionId> =
            connected.into_iter().filter(|id| existing.contains(id)).collect();

        // Compute all station coordinates
        let all_stations = project.compute_station_coordinates();

        // Find anchor: station 0 of the given section
        let anchor = all_stations
            .iter()
            .find(|s| s.station_ref.section_id == section_id && s.station_ref.station_index == 0)
            .map(|s| (s.coordinates.x, s.coordinates.y))
            .unwrap_or((0.0, 0.0));

        // Group stations by section
        let mut section_stations: std::collections::HashMap<SectionId, Vec<&crate::models::Station>> =
            std::collections::HashMap::new();
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
