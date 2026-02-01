use crate::core::{Command, CommandResult, UndoData, Validator};
use crate::models::{
    ClosureStrategy, ConnectivityResult, Coordinates, GpsCoordinates, SectionData, SectionId,
    SectionUpdates, ShotData, ShotId, ShotUpdates, StationRef,
};

use super::AppState;

impl AppState {
    /// Execute a command and return the result
    pub fn execute(&self, cmd: Command) -> CommandResult {
        // Serialize all command execution to prevent concurrent interleaving
        let _cmd_guard = match self.command_lock.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to acquire command lock".to_string()),
        };
        tracing::info!(command = ?cmd.description(), "Executing command");

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
            Command::SetShotVirtual {
                section_id,
                shot_id,
                is_virtual,
            } => self.set_shot_virtual(*section_id, *shot_id, *is_virtual),
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
            Command::SetZeroDatum {
                station_ref,
                coordinates,
            } => self.set_zero_datum(*station_ref, *coordinates),
            Command::RemoveZeroDatum { station_ref } => self.remove_zero_datum(*station_ref),
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

        // Auto-save if enabled - check config first, then release lock before saving
        let should_auto_save = result.success
            && Self::is_modifying(&cmd)
            && self.config.lock().map(|c| c.general.auto_save).unwrap_or(false);

        if should_auto_save {
            let _ = self.save_project(None);
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
        let _cmd_guard = match self.command_lock.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to acquire command lock".to_string()),
        };
        tracing::info!("Executing create_section_and_merge as single undo unit");

        // Take a project snapshot BEFORE any modifications
        let snapshot = {
            let proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
            };
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => return CommandResult::failure(format!("Failed to serialize project: {}", e)),
                },
                None => return CommandResult::failure("No project open".to_string()),
            }
        };

        // Step 1: Create the section (using internal method)
        let section_data = SectionData {
            name: name.clone(),
            surveyor: surveyor.clone(),
            date,
            color: color.clone(),
            direction,
            shots: shots.clone(),
        };

        let create_result = self.create_section(section_data.clone());
        if !create_result.success {
            return create_result;
        }

        let new_section_id = match create_result.section_id {
            Some(id) => id,
            None => return CommandResult::failure("Section created but no ID returned".to_string()),
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
            tracing::error!("Merge failed after section creation; rolling back to pre-mutation snapshot");
            match serde_json::from_str::<crate::models::Project>(&snapshot) {
                Ok(restored) => {
                    match self.project.lock() {
                        Ok(mut proj) => {
                            *proj = Some(restored);
                            tracing::info!("Successfully rolled back create_and_merge after merge failure");
                        }
                        Err(poisoned) => {
                            let mut proj = poisoned.into_inner();
                            *proj = Some(restored);
                            tracing::warn!("Rolled back create_and_merge via poisoned mutex after merge failure");
                        }
                    }
                }
                Err(e) => tracing::error!("Failed to deserialize snapshot for rollback: {e}"),
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
                    tracing::warn!("Project mutex poisoned during after-snapshot; recovering");
                    poisoned.into_inner()
                }
            };
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => {
                        // Serialization failure — rollback to pre-mutation snapshot
                        tracing::error!("Failed to serialize after snapshot: {e}; rolling back");
                        match serde_json::from_str::<crate::models::Project>(&snapshot) {
                            Ok(restored) => {
                                *proj_guard = Some(restored);
                                tracing::info!("Successfully rolled back create_and_merge after serialization failure");
                            }
                            Err(re) => tracing::error!("Failed to deserialize snapshot for rollback: {re}"),
                        }
                        return CommandResult::failure(format!("Failed to serialize after snapshot: {}", e));
                    }
                },
                None => {
                    // Project became None — rollback to pre-mutation snapshot
                    tracing::error!("Project became None after mutation; rolling back");
                    match serde_json::from_str::<crate::models::Project>(&snapshot) {
                        Ok(restored) => *proj_guard = Some(restored),
                        Err(e) => tracing::error!("Failed to deserialize snapshot for rollback: {e}"),
                    }
                    return CommandResult::failure("No project for after snapshot".to_string());
                }
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

        // Auto-save if enabled
        let should_auto_save = self.config.lock().map(|c| c.general.auto_save).unwrap_or(false);
        if should_auto_save {
            let _ = self.save_project(None);
        }

        // Return success with the new section ID
        if all_warnings.is_empty() {
            CommandResult::success_with_section_id(new_section_id)
        } else {
            CommandResult::success_with_section_id_and_warnings(new_section_id, all_warnings)
        }
    }

    pub(super) fn create_section(&self, data: SectionData) -> CommandResult {
        let config = self.config.lock().ok();

        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Validate shots using the section_id that will be assigned
        let section_id_for_validation = project.next_section_id;
        let mut warnings = Vec::new();
        for (i, shot) in data.shots.iter().enumerate() {
            if let Some(ref cfg) = config {
                warnings.extend(Validator::validate_shot(shot, &cfg.validation, section_id_for_validation, i));
            }
        }

        let section = project.add_section(data);
        let section_id = section.id;
        tracing::info!(section_id = section_id, "Section created");

        if warnings.is_empty() {
            CommandResult::success_with_section_id(section_id)
        } else {
            CommandResult::success_with_section_id_and_warnings(section_id, warnings)
        }
    }

    pub(super) fn delete_section(&self, section_id: SectionId) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Only clean up if the section actually exists
        if project.get_section(section_id).is_some() {
            project.cleanup_section_references(section_id);
            project.remove_section(section_id);
            tracing::info!(section_id, "Section deleted (with cleanup)");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Section {} not found", section_id))
        }
    }

    pub(super) fn update_section(&self, section_id: SectionId, updates: SectionUpdates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.update_section(section_id, &updates).is_some() {
            tracing::info!(section_id, "Section updated");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Section {} not found", section_id))
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

        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Compute the real shot index for validation messages
        let shot_index = if let Some(before_id) = before_shot_id {
            project
                .sections
                .iter()
                .find(|s| s.id == section_id)
                .and_then(|s| s.shots.iter().position(|shot| shot.id == before_id))
                .unwrap_or(0)
        } else if let Some(after_id) = after_shot_id {
            project
                .sections
                .iter()
                .find(|s| s.id == section_id)
                .and_then(|s| s.shots.iter().position(|shot| shot.id == after_id))
                .map(|pos| pos + 1)
                .unwrap_or(0)
        } else {
            project
                .sections
                .iter()
                .find(|s| s.id == section_id)
                .map(|s| s.shots.len())
                .unwrap_or(0)
        };

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
            tracing::info!(section_id, shot_id = new_shot_id, "Shot created");
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
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.update_shot(section_id, shot_id, &updates).is_some() {
            tracing::info!(section_id, shot_id, "Shot updated");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Shot {}:{} not found", section_id, shot_id))
        }
    }

    pub(super) fn delete_shot(&self, section_id: SectionId, shot_id: ShotId) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.remove_shot(section_id, shot_id).is_some() {
            tracing::info!(section_id, shot_id, "Shot deleted");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Shot {}:{} not found", section_id, shot_id))
        }
    }

    pub(super) fn set_shot_virtual(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
        is_virtual: bool,
    ) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project
            .set_shot_virtual(section_id, shot_id, is_virtual)
            .is_some()
        {
            tracing::info!(section_id, shot_id, is_virtual, "Shot virtual status updated");
            CommandResult::success()
        } else {
            CommandResult::failure(format!("Shot {}:{} not found", section_id, shot_id))
        }
    }

    // === Station operations ===

    pub(super) fn merge_stations(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Check same section (not allowed)
        if station_a.section_id == station_b.section_id {
            return CommandResult::failure(
                "Cannot merge stations from the same section".to_string(),
            );
        }

        match project.merge_stations(station_a, station_b) {
            Ok(_) => {
                tracing::info!(?station_a, ?station_b, "Stations merged");
                CommandResult::success()
            }
            Err(e) => {
                tracing::warn!(?station_a, ?station_b, error = %e, "Failed to merge stations");
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
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        match project.create_loop_closure(station_a, station_b, strategy) {
            Ok(_) => {
                tracing::info!(?station_a, ?station_b, "Loop closure created");
                CommandResult::success()
            }
            Err(e) => {
                tracing::warn!(?station_a, ?station_b, error = %e, "Failed to create loop closure");
                CommandResult::failure(e)
            }
        }
    }

    pub(super) fn unmerge_stations(&self, station_ref: StationRef) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
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

        tracing::info!(?station_ref, "Station unmerged");
        CommandResult::success()
    }

    pub(super) fn set_zero_datum(&self, station_ref: StationRef, gps: GpsCoordinates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        match project.set_zero_datum(station_ref, gps) {
            Ok(_) => {
                tracing::info!(?station_ref, "Zero datum set");
                CommandResult::success()
            }
            Err(e) => {
                tracing::warn!(?station_ref, error = %e, "Failed to set zero datum");
                CommandResult::failure(e)
            }
        }
    }

    pub(super) fn remove_zero_datum(&self, station_ref: StationRef) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.remove_zero_datum(station_ref) {
            tracing::info!(?station_ref, "Zero datum removed");
            CommandResult::success()
        } else {
            CommandResult::failure("Station is not a zero datum".to_string())
        }
    }

    pub(super) fn move_section(&self, section_id: SectionId, offset: Coordinates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        if project.sections.iter().any(|s| s.id == section_id) {
            let current = project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
            let new_offset = (current.0 + offset.x, current.1 + offset.y);
            project.section_offsets.insert(section_id, new_offset);
            project.touch();
            tracing::info!(?section_id, ?offset, ?new_offset, "Section moved");
            CommandResult::success()
        } else {
            CommandResult::failure("Section not found".to_string())
        }
    }

    pub(super) fn move_segment(&self, section_id: SectionId, offset: Coordinates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Validate section exists
        if !project.sections.iter().any(|s| s.id == section_id) {
            return CommandResult::failure("Section not found".to_string());
        }

        // Get all connected section IDs (merges + closures), filtered to existing sections
        let existing: std::collections::HashSet<SectionId> =
            project.sections.iter().map(|s| s.id).collect();
        let connected: Vec<SectionId> = project
            .get_connected_section_ids(section_id)
            .into_iter()
            .filter(|id| existing.contains(id))
            .collect();

        // Apply offset to every section in the connected set
        for sid in &connected {
            let current = project.section_offsets.get(sid).copied().unwrap_or((0.0, 0.0));
            let new_offset = (current.0 + offset.x, current.1 + offset.y);
            project.section_offsets.insert(*sid, new_offset);
        }
        project.touch();
        tracing::info!(?section_id, ?offset, section_count = connected.len(), "Segment moved");
        CommandResult::success()
    }

    pub(super) fn move_station(&self, station_ref: StationRef, offset: Coordinates) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Find the section containing this station
        let section = project
            .sections
            .iter()
            .find(|s| s.id == station_ref.section_id);

        let section = match section {
            Some(s) => s,
            None => return CommandResult::failure("Section not found".to_string()),
        };

        // Validate station index
        if station_ref.station_index > section.shots.len() as u32 {
            return CommandResult::failure("Invalid station index".to_string());
        }

        // Get current offset or default to (0, 0, 0)
        let current = project.station_offsets.get(&station_ref).copied().unwrap_or((0.0, 0.0, 0.0));
        // Apply delta
        let new_offset = (current.0 + offset.x, current.1 + offset.y, current.2 + offset.z);
        project.station_offsets.insert(station_ref, new_offset);
        project.touch();

        tracing::info!(?station_ref, ?offset, ?new_offset, "Station moved");
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
            let proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
            };
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => return CommandResult::failure(format!("Failed to capture pre-batch snapshot: {e}")),
                },
                None => return CommandResult::failure("No project open".to_string()),
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
                            tracing::info!("Successfully rolled back batch after sub-command failure");
                        } else {
                            tracing::error!("Failed to acquire project lock during batch rollback — project state may be inconsistent");
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to deserialize before-snapshot during batch rollback: {e} — project state may be inconsistent");
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
                let proj_guard = match self.project.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        // Cannot lock — rollback impossible, return failure
                        return CommandResult::failure("Failed to lock project for after-snapshot".to_string());
                    }
                };
                match proj_guard.as_ref() {
                    Some(p) => match serde_json::to_string(p) {
                        Ok(json) => json,
                        Err(e) => {
                            tracing::error!("Failed to capture after-snapshot for batch: {e}; rolling back");
                            drop(proj_guard);
                            // Rollback: restore pre-batch state
                            if let Ok(project) = serde_json::from_str::<crate::models::Project>(&before_snapshot) {
                                if let Ok(mut proj) = self.project.lock() {
                                    *proj = Some(project);
                                    tracing::info!("Successfully rolled back batch after after-snapshot failure");
                                }
                            } else {
                                tracing::error!("Failed to deserialize before-snapshot during rollback — project state may be inconsistent");
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
        let _cmd_guard = match self.command_lock.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to acquire command lock".to_string()),
        };
        tracing::info!(section_id, shot_id, "Executing delete_shot_and_split as single undo unit");

        // Step 1: Take BEFORE snapshot
        let before_snapshot = {
            let proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
            };
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => return CommandResult::failure(format!("Failed to serialize project: {}", e)),
                },
                None => return CommandResult::failure("No project open".to_string()),
            }
        };

        // Step 2: Get split data and perform the operation
        let new_section_id = {
            let mut proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
            };

            let project = match proj_guard.as_mut() {
                Some(p) => p,
                None => return CommandResult::failure("No project open".to_string()),
            };

            let section = match project.get_section(section_id) {
                Some(s) => s,
                None => return CommandResult::failure(format!("Section {} not found", section_id)),
            };

            // Pre-check: distinguish "shot not found" from "edge shot"
            let shot_pos = section.shots.iter().position(|s| s.id == shot_id);
            match shot_pos {
                None => return CommandResult::failure(
                    format!("Shot {} not found in section {}", shot_id, section_id)
                ),
                Some(p) if p == 0 || p == section.shots.len() - 1 => {
                    return CommandResult::failure(
                        "Cannot split at edge shot (first or last). Use simple delete instead.".to_string()
                    );
                }
                _ => {}
            }

            // Get split data (safe to unwrap after pre-checks)
            let (pos, shots_before, shots_after) = section.split_shots_at(shot_id).unwrap();

            // Capture deleted shot data for offset calculation
            let deleted_shot_data = section.shots[pos].to_shot_data();

            // Capture metadata from original section (surveyor, date, color, direction -- NOT comment)
            let surveyor = section.surveyor.clone();
            let date = section.date;
            let color = section.color.clone();
            let direction = section.direction;

            // Step 3: Modify original section -> section A
            // Truncate in-place to preserve existing Shot IDs and next_shot_id
            let section_mut = project.get_section_mut(section_id).unwrap();
            section_mut.name = Some(name_a);
            section_mut.shots.truncate(pos); // keep shots[0..pos], drop deleted + after

            // Step 4: Calculate offset for section B
            // Walk shots_before + deleted shot to accumulate (bx, by)
            let mut bx: f64 = 0.0;
            let mut by: f64 = 0.0;
            for shot_data in &shots_before {
                let avg_az = crate::models::Shot::new(0, shot_data.clone()).average_azimuth();
                let azimuth_rad = avg_az.to_radians();
                bx += shot_data.length * azimuth_rad.sin();
                by += shot_data.length * azimuth_rad.cos();
            }
            // Add deleted shot
            {
                let deleted_shot = crate::models::Shot::new(0, deleted_shot_data);
                let azimuth_rad = deleted_shot.average_azimuth().to_radians();
                bx += deleted_shot.length * azimuth_rad.sin();
                by += deleted_shot.length * azimuth_rad.cos();
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
            let proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project for after snapshot".to_string()),
            };
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => return CommandResult::failure(format!("Failed to serialize after snapshot: {}", e)),
                },
                None => return CommandResult::failure("No project for after snapshot".to_string()),
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
                    name: Some(format!("Split from section {}", section_id)),
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

        // Auto-save if enabled
        let should_auto_save = self.config.lock().map(|c| c.general.auto_save).unwrap_or(false);
        if should_auto_save {
            let _ = self.save_project(None);
        }

        tracing::info!(
            section_id,
            shot_id,
            new_section_id,
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
        let _cmd_guard = match self.command_lock.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to acquire command lock".to_string()),
        };
        tracing::info!(section_id, shot_id, "Executing delete_last_shot_and_section as single undo unit");

        // Step 1: Take BEFORE snapshot
        let before_snapshot = {
            let proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
            };
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => return CommandResult::failure(format!("Failed to serialize project: {}", e)),
                },
                None => return CommandResult::failure("No project open".to_string()),
            }
        };

        // Step 2: Validate, mutate, and capture AFTER snapshot in a single lock scope.
        // This ensures the after snapshot is always captured atomically with the mutation,
        // and on any failure after mutation we rollback from before_snapshot.
        let after_snapshot = {
            let mut proj_guard = match self.project.lock() {
                Ok(g) => g,
                Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
            };

            let project = match proj_guard.as_mut() {
                Some(p) => p,
                None => return CommandResult::failure("No project open".to_string()),
            };

            // Validate section exists
            let section = match project.get_section(section_id) {
                Some(s) => s,
                None => return CommandResult::failure(format!("Section {} not found", section_id)),
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

            // Remove zero datums referencing this section
            project.zero_datums.retain(|zd| zd.station_ref.section_id != section_id);

            // Step 4: Remove the section (and its only shot)
            if project.remove_section(section_id).is_none() {
                // Section vanished between validation and removal (should not happen).
                // Rollback to before_snapshot to undo reference cleanup.
                tracing::error!(section_id, "remove_section returned None after validation; rolling back");
                match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
                    Ok(restored) => *proj_guard = Some(restored),
                    Err(e) => tracing::error!("Failed to rollback from before_snapshot: {e}"),
                }
                return CommandResult::failure(format!("Section {} not found during removal", section_id));
            }

            tracing::info!(section_id, shot_id, "Deleted last shot and removed section");

            // Step 5: Take AFTER snapshot while still holding the lock
            match proj_guard.as_ref() {
                Some(p) => match serde_json::to_string(p) {
                    Ok(json) => json,
                    Err(e) => {
                        // Rollback: restore before_snapshot since we already mutated
                        tracing::error!("Failed to serialize after snapshot: {e}; rolling back");
                        match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
                            Ok(restored) => {
                                *proj_guard = Some(restored);
                                tracing::info!("Successfully rolled back after snapshot failure");
                            }
                            Err(re) => tracing::error!("Failed to rollback from before_snapshot: {re}"),
                        }
                        return CommandResult::failure(format!("Failed to serialize after snapshot: {}", e));
                    }
                },
                None => {
                    // Project became None -- restore
                    tracing::error!("Project became None after mutation; rolling back");
                    match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
                        Ok(restored) => *proj_guard = Some(restored),
                        Err(e) => tracing::error!("Failed to rollback from before_snapshot: {e}"),
                    }
                    return CommandResult::failure("No project after mutation".to_string());
                }
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

        match self.undo_stack.lock() {
            Ok(mut undo_stack) => {
                undo_stack.push_with_data(batch_cmd, UndoData::ProjectSnapshotPair {
                    before: before_snapshot.clone(),
                    after: after_snapshot,
                });
            }
            Err(_) => {
                // Undo stack lock failure: rollback to preserve atomicity
                tracing::error!("Failed to lock undo stack; rolling back mutation");
                match serde_json::from_str::<crate::models::Project>(&before_snapshot) {
                    Ok(restored) => {
                        if let Ok(mut proj) = self.project.lock() {
                            *proj = Some(restored);
                            tracing::info!("Successfully rolled back after undo-stack lock failure");
                        }
                    }
                    Err(e) => tracing::error!("Failed to rollback from before_snapshot: {e}"),
                }
                return CommandResult::failure("Failed to lock undo stack".to_string());
            }
        }

        // Auto-save if enabled
        let should_auto_save = self.config.lock().map(|c| c.general.auto_save).unwrap_or(false);
        if should_auto_save {
            let _ = self.save_project(None);
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
        let (can_merge, reason) = if a_has_zd && b_has_zd {
            // Both sections have fixed coordinates — cannot merge
            (false, Some("Both sections have fixed coordinates".to_string()))
        } else if connected {
            // Already connected — merging would create a survey loop
            (false, Some("Creates survey loop".to_string()))
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
            return Err(format!("Section {} not found", section_id));
        }

        // Filter to existing sections (stale merges/closures may reference deleted sections)
        let existing: std::collections::HashSet<SectionId> =
            project.sections.iter().map(|s| s.id).collect();
        let connected = project.get_connected_section_ids(section_id);
        let mut result: Vec<SectionId> = connected.into_iter().filter(|id| existing.contains(id)).collect();
        result.sort_unstable();
        Ok(result)
    }

    /// Get all section IDs anchored by a zero datum.
    /// A zero datum anchors every section reachable through merges AND closures,
    /// since the entire connected network is positioned relative to the fixed point.
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
            let connected = project.get_connected_section_ids(zd.station_ref.section_id);
            anchored.extend(connected.into_iter().filter(|id| existing.contains(id)));
        }
        let mut result: Vec<SectionId> = anchored.into_iter().collect();
        result.sort_unstable();
        Ok(result)
    }
}
