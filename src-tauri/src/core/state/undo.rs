use crate::core::{Command, CommandResult, UndoData};
use crate::models::{
    Coordinates, LoopClosure, Project, Section, SectionData, SectionId, SectionUpdates, Shot,
    ShotData, ShotId, ShotUpdates,
};

use super::AppState;

impl AppState {
    /// Generate undo data before executing a command
    pub(super) fn generate_undo_data(&self, cmd: &Command) -> UndoData {
        let proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return UndoData::None,
        };

        let project = match proj_guard.as_ref() {
            Some(p) => p,
            None => return UndoData::None,
        };

        match cmd {
            // For create commands, we'll fill in the ID after execution
            Command::CreateSection { .. } => UndoData::None, // Will be finalized after execution
            Command::CreateShot { section_id, .. } => {
                // Store section ID, shot ID will be filled in after execution
                UndoData::InverseCommand(Command::DeleteShot {
                    section_id: *section_id,
                    shot_id: 0, // Placeholder, will be updated
                })
            }

            // For delete commands, capture the full state
            Command::DeleteSection { section_id } => {
                if let Some(section) = project.get_section(*section_id) {
                    UndoData::SectionSnapshot {
                        section_id: *section_id,
                        section_data: section.to_section_data(),
                    }
                } else {
                    UndoData::None
                }
            }

            Command::DeleteShot {
                section_id,
                shot_id,
            } => {
                if let Some(section) = project.get_section(*section_id) {
                    if let Some((position, shot)) = section
                        .shots
                        .iter()
                        .enumerate()
                        .find(|(_, s)| s.id == *shot_id)
                    {
                        UndoData::ShotSnapshot {
                            section_id: *section_id,
                            shot_id: *shot_id,
                            shot_data: shot.to_shot_data(),
                            position,
                        }
                    } else {
                        UndoData::None
                    }
                } else {
                    UndoData::None
                }
            }

            // For update commands, capture previous values
            Command::UpdateShot {
                section_id,
                shot_id,
                updates,
            } => {
                if let Some(section) = project.get_section(*section_id) {
                    if let Some(shot) = section.get_shot(*shot_id) {
                        // Capture only the fields that are being updated
                        let prev_updates = ShotUpdates {
                            azimuth_in: updates.azimuth_in.map(|_| shot.azimuth_in),
                            azimuth_out: updates.azimuth_out.map(|_| shot.azimuth_out),
                            length: updates.length.map(|_| shot.length),
                            depth_in: updates.depth_in.map(|_| shot.depth_in),
                            depth_out: updates.depth_out.map(|_| shot.depth_out),
                            pitch_in: updates.pitch_in.as_ref().map(|_| shot.pitch_in),
                            pitch_out: updates.pitch_out.as_ref().map(|_| shot.pitch_out),
                            left: updates.left.as_ref().map(|_| shot.left),
                            right: updates.right.as_ref().map(|_| shot.right),
                            up: updates.up.as_ref().map(|_| shot.up),
                            down: updates.down.as_ref().map(|_| shot.down),
                            comment: updates.comment.as_ref().map(|_| shot.comment.clone()),
                            is_virtual: updates.is_virtual.map(|_| shot.is_virtual),
                            marker_index: updates.marker_index.as_ref().map(|_| shot.marker_index),
                            temperature: updates.temperature.as_ref().map(|_| shot.temperature),
                        };

                        if let Ok(json) = serde_json::to_string(&prev_updates) {
                            UndoData::PreviousValues {
                                section_id: *section_id,
                                shot_id: Some(*shot_id),
                                values_json: json,
                            }
                        } else {
                            UndoData::None
                        }
                    } else {
                        UndoData::None
                    }
                } else {
                    UndoData::None
                }
            }

            Command::UpdateSectionMetadata {
                section_id,
                updates,
            } => {
                if let Some(section) = project.get_section(*section_id) {
                    // Capture previous section metadata
                    let prev_updates = SectionUpdates {
                        name: updates.name.as_ref().map(|_| section.name.clone()),
                        surveyor: updates.surveyor.as_ref().map(|_| section.surveyor.clone()),
                        date: updates.date.as_ref().map(|_| section.date),
                        color: updates.color.as_ref().map(|_| section.color.clone()),
                        direction: updates.direction.map(|_| section.direction),
                    };

                    if let Ok(json) = serde_json::to_string(&prev_updates) {
                        UndoData::PreviousValues {
                            section_id: *section_id,
                            shot_id: None,
                            values_json: json,
                        }
                    } else {
                        UndoData::None
                    }
                } else {
                    UndoData::None
                }
            }

            // For virtual status toggle, inverse is toggling back
            Command::SetShotVirtual {
                section_id,
                shot_id,
                is_virtual,
            } => UndoData::InverseCommand(Command::SetShotVirtual {
                section_id: *section_id,
                shot_id: *shot_id,
                is_virtual: !*is_virtual,
            }),

            // For merge, store the info to unmerge
            Command::MergeStations {
                station_a,
                station_b,
            } => UndoData::MergeInfo {
                station_a: *station_a,
                station_b: *station_b,
                removed_closures: Vec::new(),
            },

            // For unmerge, we need to know which stations to re-merge
            // Also capture closures that will be removed during unmerge
            Command::UnmergeStations { station_ref } => {
                // Find all merges involving this station
                let merges: Vec<_> = project
                    .station_merges
                    .iter()
                    .filter(|m| m.station_a == *station_ref || m.station_b == *station_ref)
                    .map(|m| (m.station_a, m.station_b))
                    .collect();

                if let Some((a, b)) = merges.first() {
                    // Capture closures that will be removed during unmerge
                    let closures_to_remove: Vec<LoopClosure> = project
                        .loop_closures
                        .iter()
                        .filter(|lc| {
                            (lc.station_a == *a && lc.station_b == *b)
                                || (lc.station_a == *b && lc.station_b == *a)
                        })
                        .cloned()
                        .collect();

                    UndoData::UnmergeInfo {
                        station_a: *a,
                        station_b: *b,
                        removed_closures: closures_to_remove,
                    }
                } else {
                    UndoData::None
                }
            }

            // For create loop closure, return None initially (closure doesn't exist yet)
            // Will be finalized after execution
            Command::CreateLoopClosure { .. } => UndoData::None,

            // For zero datum operations - capture GPS and section offsets
            Command::SetZeroDatum { station_ref, .. } => {
                // Find if there was a previous datum for this station
                let previous_gps = project
                    .zero_datums
                    .iter()
                    .find(|zd| zd.station_ref == *station_ref)
                    .map(|zd| zd.gps);

                // Capture section offsets for all connected sections
                // This allows undo to restore exact previous state
                let previous_offsets =
                    project.capture_connected_section_offsets(station_ref.section_id);

                UndoData::ZeroDatumInfo {
                    station_ref: *station_ref,
                    previous_gps,
                    previous_offsets,
                }
            }

            Command::RemoveZeroDatum { station_ref } => {
                // Capture the current datum
                let previous_gps = project
                    .zero_datums
                    .iter()
                    .find(|zd| zd.station_ref == *station_ref)
                    .map(|zd| zd.gps);

                // Capture section offsets for all connected sections
                // RemoveZeroDatum doesn't change offsets, but we capture for consistency
                let previous_offsets =
                    project.capture_connected_section_offsets(station_ref.section_id);

                UndoData::ZeroDatumInfo {
                    station_ref: *station_ref,
                    previous_gps,
                    previous_offsets,
                }
            }

            // Move commands use inverse commands
            Command::MoveSection { section_id, offset } => {
                // Inverse is moving back by negative offset
                UndoData::InverseCommand(Command::MoveSection {
                    section_id: *section_id,
                    offset: Coordinates::new(-offset.x, -offset.y, -offset.z),
                })
            }

            Command::MoveStation {
                station_ref: _,
                new_position: _,
            } => {
                // For undo, we'd need to capture the original position
                // For now, use project snapshot since this is complex
                UndoData::ProjectSnapshot(
                    serde_json::to_string(project).unwrap_or_default(),
                )
            }

            // For batch, snapshot the entire project
            Command::Batch { .. } => {
                if let Ok(json) = serde_json::to_string(project) {
                    UndoData::ProjectSnapshot(json)
                } else {
                    UndoData::None
                }
            }

            // Non-undoable commands
            _ => UndoData::None,
        }
    }

    /// Finalize undo data after command execution (for commands that create new entities)
    pub(super) fn finalize_undo_data(&self, cmd: &Command, undo_data: UndoData) -> UndoData {
        let proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return undo_data,
        };

        let project = match proj_guard.as_ref() {
            Some(p) => p,
            None => return undo_data,
        };

        match cmd {
            Command::CreateSection { .. } => {
                // Get the ID of the just-created section (it's the last one)
                if let Some(section) = project.sections.last() {
                    UndoData::InverseCommand(Command::DeleteSection {
                        section_id: section.id,
                    })
                } else {
                    undo_data
                }
            }

            Command::CreateShot { section_id, .. } => {
                // Get the ID of the just-created shot
                if let Some(section) = project.get_section(*section_id) {
                    if let Some(shot) = section.shots.last() {
                        UndoData::InverseCommand(Command::DeleteShot {
                            section_id: *section_id,
                            shot_id: shot.id,
                        })
                    } else {
                        undo_data
                    }
                } else {
                    undo_data
                }
            }

            Command::CreateLoopClosure {
                station_a,
                station_b,
                ..
            } => {
                // Capture the newly created closure from the project's loop_closures
                if let Some(closure) = project.loop_closures.iter().find(|lc| {
                    (lc.station_a == *station_a && lc.station_b == *station_b)
                        || (lc.station_a == *station_b && lc.station_b == *station_a)
                }) {
                    UndoData::ClosureInfo {
                        closure: closure.clone(),
                    }
                } else {
                    undo_data
                }
            }

            _ => undo_data,
        }
    }

    /// Check if a command should be pushed to undo stack
    pub(super) fn is_undoable(cmd: &Command) -> bool {
        !matches!(
            cmd,
            Command::OpenProject { .. }
                | Command::SaveProject { .. }
                | Command::CloseProject
                | Command::CreateProject { .. }
                | Command::MergeProjects { .. }
        )
    }

    /// Check if a command modifies project state
    pub(super) fn is_modifying(cmd: &Command) -> bool {
        !matches!(
            cmd,
            Command::OpenProject { .. }
                | Command::SaveProject { .. }
                | Command::CloseProject
                | Command::MergeProjects { .. }
        )
    }

    // === Project operations ===

    /// Perform undo - restore previous state based on undo data
    pub fn undo(&self) -> CommandResult {
        // Pop from undo stack
        let entry = {
            let mut stack = match self.undo_stack.lock() {
                Ok(s) => s,
                Err(_) => return CommandResult::failure("Failed to lock undo stack".to_string()),
            };

            match stack.pop_undo() {
                Some(e) => e,
                None => return CommandResult::failure("Nothing to undo".to_string()),
            }
        };

        // Apply undo based on undo_data type
        // IMPORTANT: No early returns after this point — all paths must flow
        // through the epilogue so the entry is either pushed to redo (success)
        // or pushed back to undo (failure).
        let result = match &entry.undo_data {
            UndoData::InverseCommand(inverse_cmd) => {
                // Execute the inverse command (without pushing to undo stack)
                self.execute_without_undo(inverse_cmd.clone())
            }

            UndoData::PreviousValues {
                section_id,
                shot_id,
                values_json,
            } => {
                // Restore previous values
                if let Some(shot_id) = shot_id {
                    // Restore shot values
                    if let Ok(prev_updates) = serde_json::from_str::<ShotUpdates>(values_json.as_str()) {
                        self.update_shot(*section_id, *shot_id, prev_updates)
                    } else {
                        CommandResult::failure("Failed to parse undo data".to_string())
                    }
                } else {
                    // Restore section values
                    if let Ok(prev_updates) = serde_json::from_str::<SectionUpdates>(values_json.as_str()) {
                        self.update_section(*section_id, prev_updates)
                    } else {
                        CommandResult::failure("Failed to parse undo data".to_string())
                    }
                }
            }

            UndoData::SectionSnapshot {
                section_id,
                section_data,
            } => {
                // Restore deleted section
                self.restore_section(*section_id, section_data.clone())
            }

            UndoData::ShotSnapshot {
                section_id,
                shot_id,
                shot_data,
                position,
            } => {
                // Restore deleted shot at its original position with original ID
                self.restore_shot(*section_id, *shot_id, shot_data.clone(), *position)
            }

            UndoData::MergeInfo {
                station_a,
                station_b,
                ..
            } => {
                // Undo a merge by unmerging the stations.
                // Note: removed_closures is always empty for MergeInfo (merges don't remove closures);
                // closure restoration is handled by UnmergeInfo instead.
                match self.project.lock() {
                    Ok(mut proj_guard) => match proj_guard.as_mut() {
                        Some(project) => {
                            project.unmerge_stations(*station_a, *station_b);
                            CommandResult::success()
                        }
                        None => CommandResult::failure("No project open".to_string()),
                    },
                    Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                }
            }

            UndoData::UnmergeInfo {
                station_a,
                station_b,
                removed_closures,
            } => {
                // Re-merge the stations to undo the unmerge
                let merge_result = self.merge_stations(*station_a, *station_b);
                if !merge_result.success {
                    // If re-merge fails (e.g., stations now connected), try direct restoration
                    match self.project.lock() {
                        Ok(mut proj_guard) => match proj_guard.as_mut() {
                            Some(project) => {
                                project.station_merges.push(crate::models::StationMerge {
                                    station_a: *station_a,
                                    station_b: *station_b,
                                    merged_at: chrono::Utc::now(),
                                });
                                // Restore removed closures
                                for closure in removed_closures {
                                    project.loop_closures.push(closure.clone());
                                }
                                project.touch();
                                CommandResult::success()
                            }
                            None => CommandResult::failure("No project open".to_string()),
                        },
                        Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                    }
                } else {
                    // Merge succeeded, now restore removed closures
                    if !removed_closures.is_empty() {
                        match self.project.lock() {
                            Ok(mut proj_guard) => {
                                if let Some(project) = proj_guard.as_mut() {
                                    for closure in removed_closures {
                                        project.loop_closures.push(closure.clone());
                                    }
                                    project.touch();
                                }
                            }
                            Err(_) => {}
                        }
                    }
                    merge_result
                }
            }

            UndoData::ClosureInfo { closure } => {
                // Remove the specific closure instance (match by exact station pair, not all matching)
                match self.project.lock() {
                    Ok(mut proj_guard) => match proj_guard.as_mut() {
                        Some(project) => {
                            // Find and remove only the first matching closure for this exact pair
                            if let Some(pos) = project.loop_closures.iter().position(|lc| {
                                (lc.station_a == closure.station_a
                                    && lc.station_b == closure.station_b)
                                    || (lc.station_a == closure.station_b
                                        && lc.station_b == closure.station_a)
                            }) {
                                project.loop_closures.remove(pos);
                            }
                            project.touch();
                            CommandResult::success()
                        }
                        None => CommandResult::failure("No project open".to_string()),
                    },
                    Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                }
            }

            UndoData::ZeroDatumInfo {
                station_ref,
                previous_gps,
                previous_offsets,
            } => {
                // Restore previous datum state directly without recomputing offsets
                // This is critical because set_zero_datum would compute new offsets
                // instead of restoring the exact previous state
                match self.project.lock() {
                    Ok(mut proj_guard) => match proj_guard.as_mut() {
                        Some(project) => {
                            // Restore section offsets directly
                            for (section_id, prev_offset) in previous_offsets {
                                match prev_offset {
                                    Some(offset) => {
                                        project.section_offsets.insert(*section_id, *offset);
                                    }
                                    None => {
                                        project.section_offsets.remove(section_id);
                                    }
                                }
                            }

                            // Restore GPS datum state
                            if let Some(gps) = previous_gps {
                                if let Some(existing) = project
                                    .zero_datums
                                    .iter_mut()
                                    .find(|zd| zd.station_ref == *station_ref)
                                {
                                    existing.gps = *gps;
                                } else {
                                    project.zero_datums.push(crate::models::ZeroDatum {
                                        station_ref: *station_ref,
                                        gps: *gps,
                                    });
                                }
                            } else {
                                project
                                    .zero_datums
                                    .retain(|zd| zd.station_ref != *station_ref);
                            }

                            project.touch();
                            CommandResult::success()
                        }
                        None => CommandResult::failure("No project open".to_string()),
                    },
                    Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                }
            }

            UndoData::ProjectSnapshot(json) => {
                // Restore entire project
                match serde_json::from_str::<Project>(json.as_str()) {
                    Ok(project) => match self.project.lock() {
                        Ok(mut proj) => {
                            *proj = Some(project);
                            CommandResult::success()
                        }
                        Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                    },
                    Err(_) => CommandResult::failure("Failed to parse project snapshot".to_string()),
                }
            }

            UndoData::ProjectSnapshotPair { before, after: _ } => {
                // Restore the "before" snapshot for undo
                match serde_json::from_str::<Project>(before.as_str()) {
                    Ok(project) => match self.project.lock() {
                        Ok(mut proj) => {
                            *proj = Some(project);
                            CommandResult::success()
                        }
                        Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                    },
                    Err(_) => CommandResult::failure("Failed to parse project snapshot".to_string()),
                }
            }

            UndoData::None => {
                CommandResult::failure("This command cannot be undone".to_string())
            }
        };

        // Epilogue: push to redo stack on success, push back to undo stack on failure
        if result.success {
            if let Ok(mut stack) = self.undo_stack.lock() {
                stack.push_redo(entry);
            }
            tracing::info!("Undo performed");
        } else {
            let reason = result.error.as_deref().unwrap_or("Unknown error");
            tracing::error!(
                command = %entry.command.description(),
                undo_data_variant = entry.undo_data.variant_name(),
                reason = reason,
                "Undo operation failed after popping entry; pushing back to undo stack"
            );
            match self.undo_stack.lock() {
                Ok(mut stack) => stack.push_undo(entry),
                Err(_) => {
                    tracing::error!("Failed to re-acquire undo stack lock to push back entry");
                }
            }
        }

        result
    }

    /// Perform redo - re-execute the command or restore snapshot
    pub fn redo(&self) -> CommandResult {
        // Pop from redo stack
        let entry = {
            let mut stack = match self.undo_stack.lock() {
                Ok(s) => s,
                Err(_) => return CommandResult::failure("Failed to lock undo stack".to_string()),
            };

            match stack.pop_redo() {
                Some(e) => e,
                None => return CommandResult::failure("Nothing to redo".to_string()),
            }
        };

        // For ProjectSnapshotPair, restore the "after" snapshot instead of re-executing
        // This handles cases where re-execution would create different IDs
        // IMPORTANT: No early returns after the pop — all paths flow through the epilogue.
        let result = if let UndoData::ProjectSnapshotPair { before: _, after } = &entry.undo_data {
            match serde_json::from_str::<Project>(after.as_str()) {
                Ok(project) => match self.project.lock() {
                    Ok(mut proj) => {
                        *proj = Some(project);
                        CommandResult::success()
                    }
                    Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                },
                Err(_) => CommandResult::failure("Failed to parse project snapshot".to_string()),
            }
        } else {
            // Re-execute the original command for other undo data types
            self.execute_without_undo(entry.command.clone())
        };

        // Epilogue: push back to undo stack on success, push back to redo stack on failure
        // Important: Use the original entry with its original undo_data, not regenerated data
        // This ensures undo after redo works correctly
        if result.success {
            if let Ok(mut stack) = self.undo_stack.lock() {
                stack.push_undo(entry);
            }
            tracing::info!("Redo performed");
        } else {
            let reason = result.error.as_deref().unwrap_or("Unknown error");
            tracing::error!(
                command = %entry.command.description(),
                undo_data_variant = entry.undo_data.variant_name(),
                reason = reason,
                "Redo operation failed after popping entry; pushing back to redo stack"
            );
            match self.undo_stack.lock() {
                Ok(mut stack) => stack.push_redo(entry),
                Err(_) => {
                    tracing::error!("Failed to re-acquire undo stack lock to push back entry");
                }
            }
        }

        result
    }

    /// Execute a command without pushing to undo stack (used for undo operations)
    fn execute_without_undo(&self, cmd: Command) -> CommandResult {
        match &cmd {
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
            Command::MoveSection { section_id, offset } => self.move_section(*section_id, *offset),
            _ => CommandResult::failure("Command cannot be executed in undo context".to_string()),
        }
    }

    /// Restore a deleted section with its original ID
    fn restore_section(&self, original_id: SectionId, data: SectionData) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        // Create section with original ID
        let section = Section::new_with_id(original_id, data);
        project.sections.push(section);
        project.touch();

        // Update next_section_id if needed
        if original_id >= project.next_section_id {
            project.next_section_id = original_id + 1;
        }

        tracing::info!(section_id = original_id, "Section restored");
        CommandResult::success()
    }

    /// Restore a deleted shot at its original position with its original ID
    fn restore_shot(
        &self,
        section_id: SectionId,
        original_shot_id: ShotId,
        data: ShotData,
        position: usize,
    ) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        let project = match proj_guard.as_mut() {
            Some(p) => p,
            None => return CommandResult::failure("No project open".to_string()),
        };

        let section = match project.get_section_mut(section_id) {
            Some(s) => s,
            None => return CommandResult::failure(format!("Section {} not found", section_id)),
        };

        // Create shot with original ID
        let shot = Shot::new(original_shot_id, data);

        // Update next_shot_id if needed to avoid collisions
        if original_shot_id >= section.next_shot_id {
            section.next_shot_id = original_shot_id + 1;
        }

        if position <= section.shots.len() {
            section.shots.insert(position, shot);
        } else {
            section.shots.push(shot);
        }

        project.touch();

        tracing::info!(section_id, shot_id = original_shot_id, position, "Shot restored");
        CommandResult::success()
    }

    // === State queries ===

    /// Check if undo is available
    pub fn can_undo(&self) -> bool {
        self.undo_stack
            .lock()
            .map(|s| s.can_undo())
            .unwrap_or(false)
    }

    /// Check if redo is available
    pub fn can_redo(&self) -> bool {
        self.undo_stack
            .lock()
            .map(|s| s.can_redo())
            .unwrap_or(false)
    }

    /// Get the undo stack as a list of history items for the UI
    pub fn get_undo_stack(&self) -> Vec<crate::commands::history::UndoHistoryItem> {
        self.undo_stack
            .lock()
            .map(|stack| {
                stack
                    .undo_entries()
                    .enumerate()
                    .map(|(idx, entry)| {
                        crate::commands::history::entry_to_history_item(entry, idx)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Get the redo stack as a list of history items for the UI
    pub fn get_redo_stack(&self) -> Vec<crate::commands::history::UndoHistoryItem> {
        self.undo_stack
            .lock()
            .map(|stack| {
                stack
                    .redo_entries()
                    .enumerate()
                    .map(|(idx, entry)| {
                        crate::commands::history::entry_to_history_item(entry, idx)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Perform multiple undos to reach a specific history point
    /// Index 0 = most recent action, so undo_to(N) executes (N+1) undos
    pub fn undo_to(&self, index: usize) -> CommandResult {
        // Validate index first
        {
            let stack = match self.undo_stack.lock() {
                Ok(s) => s,
                Err(_) => return CommandResult::failure("Failed to lock undo stack".to_string()),
            };
            if index >= stack.len() {
                return CommandResult::failure(format!(
                    "Invalid undo index: {} (stack has {} entries)",
                    index,
                    stack.len()
                ));
            }
        }

        // Execute (index + 1) undos to include the target index
        let count = index + 1;
        for i in 0..count {
            let result = self.undo();
            if !result.success {
                return CommandResult::failure(format!(
                    "Undo failed at step {} of {}: {}",
                    i + 1,
                    count,
                    result.error.unwrap_or_else(|| "Unknown error".to_string())
                ));
            }
        }

        tracing::info!(index = index, count = count, "Undo to index completed");
        CommandResult::success()
    }

    /// Perform multiple redos to reach a specific history point
    /// Index 0 = most recent undone action, so redo_to(N) executes (N+1) redos
    pub fn redo_to(&self, index: usize) -> CommandResult {
        // Validate index first
        {
            let stack = match self.undo_stack.lock() {
                Ok(s) => s,
                Err(_) => return CommandResult::failure("Failed to lock undo stack".to_string()),
            };
            if index >= stack.redo_len() {
                return CommandResult::failure(format!(
                    "Invalid redo index: {} (stack has {} entries)",
                    index,
                    stack.redo_len()
                ));
            }
        }

        // Execute (index + 1) redos to include the target index
        let count = index + 1;
        for i in 0..count {
            let result = self.redo();
            if !result.success {
                return CommandResult::failure(format!(
                    "Redo failed at step {} of {}: {}",
                    i + 1,
                    count,
                    result.error.unwrap_or_else(|| "Unknown error".to_string())
                ));
            }
        }

        tracing::info!(index = index, count = count, "Redo to index completed");
        CommandResult::success()
    }
}
