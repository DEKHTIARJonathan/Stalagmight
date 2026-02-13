use crate::core::{Command, CommentHolder, CommandResult, UndoData, Validator};
use crate::models::{
    shot_display_position, ClosureStrategy, ConnectivityResult, Coordinates, GpsCoordinates,
    SectionData, SectionId, SectionUpdates, ShotData, ShotId, ShotUpdates, StationRef,
    FEATURE_ID_STRIDE,
};

use super::AppState;

impl AppState {
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

        let result = match &cmd {
            Command::CreateProject { name, location } => {
                self.create_project(name.clone(), location.clone())
            }
            Command::OpenProject { path } => self.open_project(path.clone()),
            Command::SaveProject { path } => self.save_project(path.clone()),
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
            Command::CreateLoopClosure {
                station_a,
                station_b,
                closure_strategy,
            } => self.create_loop_closure(*station_a, *station_b, *closure_strategy),
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
        };

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
        let snapshot = {
            let Ok(proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(p) = proj_guard.as_ref() else {
                return CommandResult::failure("No project open".to_string());
            };
            match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => return CommandResult::failure(format!("Failed to serialize project: {e}")),
            }
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
            // Use unwrap_or_else to recover from poisoned mutex (rollback must succeed).
            tracing::error!(
                purpose = "keep project consistent after failed merge",
                "Merge failed after section creation; rolling back to pre-mutation snapshot"
            );
            match serde_json::from_str::<crate::models::Project>(&snapshot) {
                Ok(restored) => {
                    match self.project.lock() {
                        Ok(mut proj) => {
                            *proj = Some(restored);
                            tracing::info!(
                                purpose = "restore project after failed merge",
                                "Successfully rolled back create_and_merge after merge failure"
                            );
                        }
                        Err(poisoned) => {
                            let mut proj = poisoned.into_inner();
                            *proj = Some(restored);
                            tracing::warn!(
                                purpose = "restore project after failed merge",
                                "Rolled back create_and_merge via poisoned mutex after merge failure"
                            );
                        }
                    }
                }
                Err(e) => tracing::error!(
                    purpose = "restore project after failed merge",
                    reason = %e,
                    "Failed to deserialize snapshot for rollback"
                ),
            }
            return merge_result;
        }

        // Step 4: Capture the after snapshot and push undo entry with before+after.
        // Use unwrap_or_else on lock to handle poisoned mutex — rollback must apply.
        let after_snapshot = {
            let mut proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(poisoned) => {
                    // Mutex was poisoned — recover the guard so we can still capture snapshot
                    tracing::warn!(
                        purpose = "finalize undo snapshot",
                        "Project mutex poisoned during after-snapshot; recovering"
                    );
                    poisoned.into_inner()
                }
            };
            if let Some(p) = proj_guard.as_ref() { match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => {
                    // Serialization failure — rollback to pre-mutation snapshot
                    tracing::error!(
                        purpose = "finalize undo snapshot",
                        reason = %e,
                        "Failed to serialize after snapshot; rolling back"
                    );
                    match serde_json::from_str::<crate::models::Project>(&snapshot) {
                        Ok(restored) => {
                            *proj_guard = Some(restored);
                            tracing::info!(
                                purpose = "restore project after snapshot failure",
                                "Successfully rolled back create_and_merge after serialization failure"
                            );
                        }
                        Err(re) => tracing::error!(
                            purpose = "restore project after snapshot failure",
                            reason = %re,
                            "Failed to deserialize snapshot for rollback"
                        ),
                    }
                    return CommandResult::failure(format!("Failed to serialize after snapshot: {e}"));
                }
            } } else {
                // Project became None — rollback to pre-mutation snapshot
                tracing::error!(
                    purpose = "restore project after mutation error",
                    "Project became None after mutation; rolling back"
                );
                match serde_json::from_str::<crate::models::Project>(&snapshot) {
                    Ok(restored) => *proj_guard = Some(restored),
                    Err(e) => tracing::error!(
                        purpose = "restore project after mutation error",
                        reason = %e,
                        "Failed to deserialize snapshot for rollback"
                    ),
                }
                return CommandResult::failure("No project for after snapshot".to_string());
            }
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

        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.push_with_data(batch_cmd, UndoData::ProjectSnapshotPair {
                before: snapshot,
                after: after_snapshot,
            });
        }

        // Combine warnings from both operations
        let mut all_warnings = create_result.warnings;
        all_warnings.extend(merge_result.warnings);

        // Return success with the new section ID
        if all_warnings.is_empty() {
            CommandResult::success_with_section_id(new_section_id)
        } else {
            CommandResult::success_with_section_id_and_warnings(new_section_id, all_warnings)
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
        existing_shot_updates: Vec<crate::models::ExistingShotUpdate>,
    ) -> CommandResult {
        use std::collections::HashMap;
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
        let before_snapshot = {
            let Ok(proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(p) = proj_guard.as_ref() else {
                return CommandResult::failure("No project open".to_string());
            };
            match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => return CommandResult::failure(format!("Failed to serialize project: {e}")),
            }
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
                for update in &existing_shot_updates {
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
                            tracing::info!(
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
            }
        }

        // Mapping from import section_index to created SectionId
        let mut created_ids: HashMap<u32, u32> = HashMap::new();
        let mut all_section_ids: Vec<u32> = Vec::new();
        let mut all_warnings = Vec::new();
        // Collect commands for the undo entry description
        let mut batch_commands: Vec<Command> = Vec::new();

        for config in &sections {
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
            let create_result = self.create_section(section_data.clone());
            if !create_result.success {
                // Rollback to before-snapshot
                self.rollback_to_snapshot(&before_snapshot);
                return CommandResult::failure(format!(
                    "Failed to create section \"{}\": {}",
                    config.name.as_deref().unwrap_or("unnamed"),
                    create_result.error.unwrap_or_default()
                ));
            }

            let Some(section_id) = create_result.section_id else {
                self.rollback_to_snapshot(&before_snapshot);
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
            match &config.placement {
                ImportPlacement::Origin => {
                    // No-op — section starts at origin
                }

                ImportPlacement::ZeroDatum { coordinates, station_index } => {
                    let station_ref = StationRef::new(section_id, *station_index);
                    let result = self.set_zero_datum(station_ref, *coordinates);
                    if !result.success {
                        self.rollback_to_snapshot(&before_snapshot);
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
                        self.rollback_to_snapshot(&before_snapshot);
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
                        self.rollback_to_snapshot(&before_snapshot);
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
                        self.rollback_to_snapshot(&before_snapshot);
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
                            self.rollback_to_snapshot(&before_snapshot);
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
                        self.rollback_to_snapshot(&before_snapshot);
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
        }

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
                    tracing::info!(
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

        // Capture after-snapshot for redo support
        let after_snapshot = {
            let proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(poisoned) => {
                    tracing::warn!(
                        purpose = "finalize import snapshot",
                        "Project mutex poisoned during after-snapshot; recovering"
                    );
                    poisoned.into_inner()
                }
            };
            if let Some(p) = proj_guard.as_ref() { match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => {
                    tracing::error!(
                        purpose = "finalize import snapshot",
                        reason = %e,
                        "Failed to serialize after-snapshot; rolling back"
                    );
                    drop(proj_guard);
                    self.rollback_to_snapshot(&before_snapshot);
                    return CommandResult::failure(format!("Failed to capture after-snapshot: {e}"));
                }
            } } else {
                tracing::error!(
                    purpose = "restore project after import failure",
                    "Project became None after import; rolling back"
                );
                drop(proj_guard);
                self.rollback_to_snapshot(&before_snapshot);
                return CommandResult::failure("No project after import".to_string());
            }
        };

        // Push a single undo entry covering all sections + hash
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.push_with_data(
                Command::Batch { commands: batch_commands },
                UndoData::ProjectSnapshotPair {
                    before: before_snapshot,
                    after: after_snapshot,
                },
            );
        }

        if all_warnings.is_empty() {
            CommandResult::success_with_section_ids_and_warnings(all_section_ids, vec![])
        } else {
            CommandResult::success_with_section_ids_and_warnings(all_section_ids, all_warnings)
        }
    }

    /// Rollback project state to a serialized snapshot.
    fn rollback_to_snapshot(&self, snapshot: &str) {
        match serde_json::from_str::<crate::models::Project>(snapshot) {
            Ok(restored) => {
                match self.project.lock() {
                    Ok(mut proj) => {
                        *proj = Some(restored);
                        tracing::info!(
                            purpose = "restore project after failed command",
                            "Successfully rolled back to snapshot"
                        );
                    }
                    Err(poisoned) => {
                        let mut proj = poisoned.into_inner();
                        *proj = Some(restored);
                        tracing::warn!(
                            purpose = "restore project after failed command",
                            "Rolled back via poisoned mutex"
                        );
                    }
                }
            }
            Err(e) => {
                tracing::error!(
                    purpose = "restore project after failed command",
                    reason = %e,
                    "Failed to deserialize snapshot for rollback"
                );
            }
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
        tracing::info!(
            section_id = section_id,
            purpose = "add section to project",
            "Section created"
        );

        if warnings.is_empty() {
            CommandResult::success_with_section_id(section_id)
        } else {
            CommandResult::success_with_section_id_and_warnings(section_id, warnings)
        }
    }

    pub(super) fn delete_section(&self, section_id: SectionId) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Only clean up if the section actually exists
        if project.get_section(section_id).is_some() {
            project.cleanup_section_references(section_id);
            project.remove_section(section_id);
            tracing::info!(
                section_id,
                purpose = "remove section and cleanup references",
                "Section deleted (with cleanup)"
            );
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Section {section_id} not found"))
        }
    }

    pub(super) fn update_section(&self, section_id: SectionId, updates: SectionUpdates) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        if project.update_section(section_id, &updates).is_some() {
            tracing::info!(
                section_id,
                purpose = "update section metadata or shots",
                "Section updated"
            );
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Section {section_id} not found"))
        }
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
            project.insert_shot_before(section_id, before_id, data)
        } else if let Some(after_id) = after_shot_id {
            project.insert_shot_after(section_id, after_id, data)
        } else {
            project.add_shot(section_id, data)
        };

        if let Some(new_shot) = shot {
            let new_shot_id = new_shot.id;
            tracing::info!(
                section_id,
                shot_id = new_shot_id,
                purpose = "add shot to section",
                "Shot created"
            );
            if warnings.is_empty() {
                CommandResult::success_with_shot_id(new_shot_id)
            } else {
                CommandResult::success_with_shot_id_and_warnings(new_shot_id, warnings)
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
            tracing::info!(
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
                tracing::info!(
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
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

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
    }

    // === Station operations ===

    pub(super) fn merge_stations(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        // Check same section (not allowed)
        if station_a.section_id == station_b.section_id {
            return CommandResult::failure(
                "Cannot merge stations from the same section".to_string(),
            );
        }

        match project.merge_stations(station_a, station_b) {
            Ok(_) => {
                tracing::info!(
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
                tracing::info!(
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

    pub(super) fn adjust_loop_closures(
        &self,
        anchor_station: StationRef,
        method: ClosureStrategy,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_ref() else {
            return CommandResult::failure("No project open".to_string());
        };

        let config = self.get_config();
        let mut working = project.clone();

        match working.adjust_loop_closures(
            anchor_station,
            method,
            &config.closure_adjustment,
        ) {
            Ok(()) => {
                working.touch();
                *proj_guard = Some(working);
                tracing::info!(
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
    }

    pub(super) fn unmerge_stations(&self, station_ref: StationRef) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

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
    }

    pub(super) fn set_zero_datum(&self, station_ref: StationRef, gps: GpsCoordinates) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

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
    }

    pub(super) fn remove_zero_datum(&self, station_ref: StationRef) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        if project.remove_zero_datum(station_ref) {
            tracing::info!(
                ?station_ref,
                purpose = "remove GPS anchor",
                "Zero datum removed"
            );
            CommandResult::success()
        } else {
            CommandResult::failure("Station is not a zero datum".to_string())
        }
    }

    pub(super) fn set_station_comment(
        &self,
        station_ref: StationRef,
        comment: Option<String>,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

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
        let before_snapshot = {
            let Ok(proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(p) = proj_guard.as_ref() else {
                return CommandResult::failure("No project open".to_string());
            };
            match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => {
                    return CommandResult::failure(format!("Failed to serialize project: {e}"))
                }
            }
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
        let after_snapshot = {
            let Ok(proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(p) = proj_guard.as_ref() else {
                return CommandResult::failure("No project open".to_string());
            };
            match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => {
                    // Rollback to before snapshot
                    drop(proj_guard);
                    if let Ok(mut pg) = self.project.lock() {
                        if let Ok(restored) =
                            serde_json::from_str::<crate::models::Project>(&before_snapshot)
                        {
                            *pg = Some(restored);
                        }
                    }
                    return CommandResult::failure(format!(
                        "Failed to serialize after snapshot: {e}"
                    ));
                }
            }
        };

        // Step 4: Push single undo entry
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.push_with_data(
                cmd,
                UndoData::ProjectSnapshotPair {
                    before: before_snapshot,
                    after: after_snapshot,
                },
            );
        }

        tracing::info!(
            swap = swap,
            purpose = "move comment atomically",
            "Move comment completed"
        );
        CommandResult::success()
    }

    /// Read the comment from a CommentHolder (station or shot)
    fn get_holder_comment(
        project: &crate::models::Project,
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
        project: &mut crate::models::Project,
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
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        if project.sections.iter().any(|s| s.id == section_id) {
            if project.zero_datums.iter().any(|zd| zd.station_ref.section_id == section_id)
                && (offset.x.abs() > 1e-9 || offset.y.abs() > 1e-9 || offset.z.abs() > 1e-9)
            {
                tracing::error!(
                    section_id,
                    ?offset,
                    purpose = "protect zero datum position",
                    "Section move would shift a zero datum station"
                );
            }
            let current = project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
            let new_offset = (current.0 + offset.x, current.1 + offset.y);
            project.section_offsets.insert(section_id, new_offset);
            project.touch();
            tracing::info!(
                ?section_id,
                ?offset,
                ?new_offset,
                purpose = "reposition section for alignment",
                "Section moved"
            );
            CommandResult::success()
        } else {
            CommandResult::failure("Section not found".to_string())
        }
    }

    pub(super) fn move_segment(&self, section_id: SectionId, offset: Coordinates) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

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

        let mut zero_datum_sections: Vec<SectionId> = project
            .zero_datums
            .iter()
            .map(|zd| zd.station_ref.section_id)
            .filter(|sid| connected.contains(sid))
            .collect();
        zero_datum_sections.sort_unstable();
        zero_datum_sections.dedup();
        if !zero_datum_sections.is_empty()
            && (offset.x.abs() > 1e-9 || offset.y.abs() > 1e-9 || offset.z.abs() > 1e-9)
        {
            tracing::error!(
                ?offset,
                section_id,
                zero_datum_sections = ?zero_datum_sections,
                purpose = "protect zero datum position",
                "Segment move would shift zero datum stations"
            );
        }

        // Apply offset to every section in the connected set
        for sid in &connected {
            let current = project.section_offsets.get(sid).copied().unwrap_or((0.0, 0.0));
            let new_offset = (current.0 + offset.x, current.1 + offset.y);
            project.section_offsets.insert(*sid, new_offset);
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
    }

    pub(super) fn move_station(&self, station_ref: StationRef, offset: Coordinates) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        if project.zero_datums.iter().any(|zd| zd.station_ref == station_ref)
            && (offset.x.abs() > 1e-9 || offset.y.abs() > 1e-9 || offset.z.abs() > 1e-9)
        {
            tracing::error!(
                ?station_ref,
                ?offset,
                purpose = "protect zero datum position",
                "Station move would shift a zero datum station"
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
        project.station_offsets.remove(&station_ref);
        project.touch();

        tracing::info!(
            ?station_ref,
            ?offset,
            purpose = "adjust station position",
            "Station moved (shot data updated)"
        );
        CommandResult::success()
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
        let before_snapshot = {
            let Ok(proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(p) = proj_guard.as_ref() else {
                return CommandResult::failure("No project open".to_string());
            };
            match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => return CommandResult::failure(format!("Failed to capture pre-batch snapshot: {e}")),
            }
        };

        let mut all_warnings = Vec::new();
        let mut section_ids = Vec::new();

        for cmd in &commands {
            // Use execute_without_undo to avoid pushing individual undo entries;
            // the outer Batch command handles undo as a single unit via ProjectSnapshotPair
            let result = self.execute_without_undo(cmd.clone());
            if !result.success {
                // Rollback: restore pre-batch state to avoid partial mutations
                match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
                    Ok(project) => {
                        if let Ok(mut proj) = self.project.lock() {
                            *proj = Some(project);
                            tracing::info!(
                                purpose = "restore project after batch failure",
                                "Successfully rolled back batch after sub-command failure"
                            );
                        } else {
                            tracing::error!(
                                purpose = "restore project after batch failure",
                                "Failed to acquire project lock during batch rollback; project state may be inconsistent"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::error!(
                            purpose = "restore project after batch failure",
                            reason = %e,
                            "Failed to deserialize before-snapshot during batch rollback; project state may be inconsistent"
                        );
                    }
                }
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
            let after_snapshot = {
                let Ok(proj_guard) = self.project.lock() else {
                    // Cannot lock — rollback impossible, return failure
                    return CommandResult::failure("Failed to lock project for after-snapshot".to_string());
                };
                match proj_guard.as_ref() {
                    Some(p) => match serde_json::to_string(p) {
                        Ok(json) => json,
                        Err(e) => {
                            tracing::error!(
                                purpose = "finalize batch undo snapshot",
                                reason = %e,
                                "Failed to capture after-snapshot for batch; rolling back"
                            );
                            drop(proj_guard);
                            // Rollback: restore pre-batch state
                            if let Ok(project) = serde_json::from_str::<crate::models::Project>(&before_snapshot) {
                                if let Ok(mut proj) = self.project.lock() {
                                    *proj = Some(project);
                                    tracing::info!(
                                        purpose = "restore project after batch snapshot failure",
                                        "Successfully rolled back batch after after-snapshot failure"
                                    );
                                }
                            } else {
                                tracing::error!(
                                    purpose = "restore project after batch snapshot failure",
                                    "Failed to deserialize before-snapshot during rollback; project state may be inconsistent"
                                );
                            }
                            return CommandResult::failure(format!("Failed to capture after-snapshot for batch undo: {e}"));
                        }
                    },
                    None => {
                        return CommandResult::failure("No project open after batch execution".to_string());
                    }
                }
            };

            // Push undo entry directly (bypasses finalize_undo_data which is a no-op for Batch)
            if let Ok(mut undo_stack) = self.undo_stack.lock() {
                undo_stack.push_with_data(
                    Command::Batch { commands },
                    UndoData::ProjectSnapshotPair {
                        before: before_snapshot,
                        after: after_snapshot,
                    },
                );
            }
        }

        if section_ids.is_empty() {
            CommandResult::success_with_warnings(all_warnings)
        } else {
            CommandResult::success_with_section_ids_and_warnings(section_ids, all_warnings)
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
        let before_snapshot = {
            let Ok(proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(p) = proj_guard.as_ref() else {
                return CommandResult::failure("No project open".to_string());
            };
            match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => return CommandResult::failure(format!("Failed to serialize project: {e}")),
            }
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
            let (section_ox, section_oy) = project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));

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
            project.section_offsets.insert(new_id, (section_ox + bx, section_oy + by));

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
        let after_snapshot = {
            let Ok(proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project for after snapshot".to_string());
            };
            let Some(p) = proj_guard.as_ref() else {
                return CommandResult::failure("No project for after snapshot".to_string());
            };
            match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => return CommandResult::failure(format!("Failed to serialize after snapshot: {e}")),
            }
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

        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.push_with_data(batch_cmd, UndoData::ProjectSnapshotPair {
                before: before_snapshot,
                after: after_snapshot,
            });
        }

        tracing::info!(
            section_id,
            shot_id,
            new_section_id,
            purpose = "split section after deleting shot",
            "Delete shot and split section completed"
        );

        CommandResult::success_with_section_id(new_section_id)
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
        let before_snapshot = {
            let Ok(proj_guard) = self.project.lock() else {
                return CommandResult::failure("Failed to lock project".to_string());
            };
            let Some(p) = proj_guard.as_ref() else {
                return CommandResult::failure("No project open".to_string());
            };
            match serde_json::to_string(p) {
                Ok(json) => json,
                Err(e) => return CommandResult::failure(format!("Failed to serialize project: {e}")),
            }
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

            // Step 3: Clean up section references (inline, Task 7 will provide helper later)
            // Remove merges referencing this section
            project.station_merges.retain(|m| {
                m.station_a.section_id != section_id && m.station_b.section_id != section_id
            });

            // Remove closures referencing this section
            project.loop_closures.retain(|lc| {
                lc.station_a.section_id != section_id && lc.station_b.section_id != section_id
            });

            // Remove section offsets
            project.section_offsets.remove(&section_id);

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
                match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
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
                    match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
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
                match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
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

        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.push_with_data(batch_cmd, UndoData::ProjectSnapshotPair {
                before: before_snapshot,
                after: after_snapshot,
            });
        } else {
            // Undo stack lock failure: rollback to preserve atomicity
            tracing::error!(
                purpose = "preserve atomic delete operation",
                "Failed to lock undo stack; rolling back mutation"
            );
            match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
                Ok(restored) => {
                    if let Ok(mut proj) = self.project.lock() {
                        *proj = Some(restored);
                        tracing::info!(
                            purpose = "restore after undo-stack lock failure",
                            "Successfully rolled back after undo-stack lock failure"
                        );
                    }
                }
                Err(e) => tracing::error!(
                    purpose = "restore after undo-stack lock failure",
                    reason = %e,
                    "Failed to rollback from before_snapshot"
                ),
            }
            return CommandResult::failure("Failed to lock undo stack".to_string());
        }

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
        let connected = project.get_rigid_connected_section_ids(section_id);
        let mut result: Vec<SectionId> = connected.into_iter().filter(|id| existing.contains(id)).collect();
        result.sort_unstable();
        Ok(result)
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
        let proj_guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let project = proj_guard
            .as_ref()
            .ok_or_else(|| "No project open".to_string())?;

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
    }
}
