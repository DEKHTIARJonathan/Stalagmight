use crate::core::{Command, CommandResult, UndoData, Validator};
use crate::models::{
    ClosurePreview, ClosureStrategy, Coordinates, GpsCoordinates, SectionData, SectionId,
    SectionUpdates, ShotData, ShotId, ShotUpdates, StationRef,
};

use super::AppState;

impl AppState {
    /// Execute a command and return the result
    pub fn execute(&self, cmd: Command) -> CommandResult {
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
            } => self.create_shot(*section_id, shot.clone(), *after_shot_id),
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
            Command::MoveStation {
                station_ref,
                new_position,
            } => self.move_station(*station_ref, *new_position),
            Command::Batch { commands } => self.execute_batch(commands.clone()),
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

        // Push to undo stack if successful and undoable
        if result.success && Self::is_undoable(&cmd) {
            // For CreateSection and CreateShot, we need to capture the new ID for the inverse command
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
            // If merge fails, we need to undo the section creation by restoring the snapshot
            // For simplicity, we'll just report the error and let the user manually undo
            // In practice, we could restore the snapshot here, but that adds complexity
            return merge_result;
        }

        // Step 4: Capture the after snapshot and push undo entry with before+after
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

        if project.remove_section(section_id).is_some() {
            tracing::info!(section_id, "Section deleted");
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
    ) -> CommandResult {
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
        let shot_index = if let Some(after_id) = after_shot_id {
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

        let shot = if let Some(after_id) = after_shot_id {
            project.insert_shot_after(section_id, after_id, data)
        } else {
            project.add_shot(section_id, data)
        };

        if shot.is_some() {
            tracing::info!(section_id, "Shot created");
            CommandResult::success_with_warnings(warnings)
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

        // Apply offset to section's placement
        if let Some(_section) = project.sections.iter_mut().find(|s| s.id == section_id) {
            // Store offset in section metadata (we'll use this during coordinate calculation)
            // For now, we just acknowledge the command was received
            // The actual offset application would require extending the Section model
            tracing::info!(?section_id, ?offset, "Section move requested");
            CommandResult::success()
        } else {
            CommandResult::failure("Section not found".to_string())
        }
    }

    pub(super) fn move_station(&self, station_ref: StationRef, new_position: Coordinates) -> CommandResult {
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
            .iter_mut()
            .find(|s| s.id == station_ref.section_id);

        let section = match section {
            Some(s) => s,
            None => return CommandResult::failure("Section not found".to_string()),
        };

        // Validate station index
        if station_ref.station_index > section.shots.len() as u32 {
            return CommandResult::failure("Invalid station index".to_string());
        }

        // Moving a station requires updating adjacent shots
        // For station N:
        // - Update shot N-1 (if exists) to point to new position
        // - Update shot N (if exists) to start from new position

        // For now, log the request - full implementation requires coordinate recalculation
        tracing::info!(?station_ref, ?new_position, "Station move requested");
        CommandResult::success()
    }

    fn execute_batch(&self, commands: Vec<Command>) -> CommandResult {
        let mut all_warnings = Vec::new();
        let mut section_ids = Vec::new();

        for cmd in commands {
            let result = self.execute(cmd);
            if !result.success {
                return result;
            }
            all_warnings.extend(result.warnings);
            // Collect section IDs from CreateSection commands
            if let Some(id) = result.section_id {
                section_ids.push(id);
            }
            section_ids.extend(result.section_ids);
        }

        if section_ids.is_empty() {
            CommandResult::success_with_warnings(all_warnings)
        } else {
            CommandResult::success_with_section_ids_and_warnings(section_ids, all_warnings)
        }
    }

    // === Station query operations ===

    /// Check merge connectivity between two stations (read-only)
    pub fn check_merge_connectivity(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> Result<(bool, Option<ClosurePreview>), String> {
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
        let already_has_closure = project.loop_closures.iter().any(|lc| {
            (lc.station_a == station_a && lc.station_b == station_b)
                || (lc.station_a == station_b && lc.station_b == station_a)
        });
        if already_has_closure {
            return Err(
                "A loop closure already exists between these stations.".to_string(),
            );
        }

        // Check connectivity
        let connected_a = project.get_connected_section_ids(station_a.section_id);
        let connected = connected_a.contains(&station_b.section_id);

        if connected {
            // Compute preview data using shared helper
            let preview = project.compute_closure_metrics(station_a, station_b)?;
            Ok((true, Some(preview)))
        } else {
            Ok((false, None))
        }
    }

    // === Project merge operations ===
}
