use crate::core::{Command, CommandResult, UndoData};
use crate::models::{
    ClosureStrategy, Coordinates, LoopClosure, Project, Section, SectionData, SectionId,
    SectionUpdates, Shot, ShotData, ShotId, ShotUpdates,
};

use super::AppState;

impl AppState {
    /// Generate undo data before executing a command
    pub(super) fn generate_undo_data(&self, cmd: &Command) -> UndoData {
        let Ok(proj_guard) = self.project.lock() else {
            return UndoData::None;
        };

        let Some(project) = proj_guard.as_ref() else {
            return UndoData::None;
        };

        match cmd {
            // For create commands, we'll fill in the ID after execution
            Command::CreateSection { .. } => UndoData::None, // Will be finalized after execution
            Command::CreateShot { .. } => UndoData::None, // Will be finalized after execution

            // For DeleteSection, capture full project snapshot (before/after pair)
            // because cleanup_section_references removes merges, closures, offsets, and
            // zero datums — a SectionSnapshot alone cannot restore those.
            // Guard: only serialize if section exists (avoids overhead for doomed commands).
            Command::DeleteSection { section_id } => {
                if project.get_section(*section_id).is_some() {
                    match serde_json::to_string(project) {
                        Ok(before) => UndoData::ProjectSnapshotPair {
                            before,
                            after: String::new(), // Filled by finalize_undo_data
                        },
                        Err(_) => UndoData::None,
                    }
                } else {
                    UndoData::None
                }
            }

            // For DeleteShot, capture full project snapshot (before/after pair)
            // because remove_shot shifts station refs — a ShotSnapshot alone cannot
            // restore the original station references.
            Command::DeleteShot {
                section_id,
                shot_id,
            } => {
                if let Some(section) = project.get_section(*section_id) {
                    if section.shots.iter().any(|s| s.id == *shot_id) {
                        match serde_json::to_string(project) {
                            Ok(before) => UndoData::ProjectSnapshotPair {
                                before,
                                after: String::new(), // Filled by finalize_undo_data
                            },
                            Err(_) => UndoData::None,
                        }
                    } else {
                        UndoData::None
                    }
                } else {
                    UndoData::None
                }
            }

            // AdjustLoopClosures: capture full project snapshot (before/after pair)
            Command::AdjustLoopClosures { .. } => match serde_json::to_string(project) {
                Ok(before) => UndoData::ProjectSnapshotPair {
                    before,
                    after: String::new(),
                },
                Err(_) => UndoData::None,
            },

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
                            is_reference: updates.is_reference.map(|_| shot.is_reference),
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
                        quality: updates.quality.map(|_| section.quality),
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

            // For reference status toggle, inverse is toggling back
            Command::SetShotReference {
                section_id,
                shot_id,
                is_reference,
            } => UndoData::InverseCommand(Command::SetShotReference {
                section_id: *section_id,
                shot_id: *shot_id,
                is_reference: !*is_reference,
            }),

            // For merge, store the info to unmerge + section offsets to restore positions
            Command::MergeStations {
                station_a,
                station_b,
            } => {
                // Capture section offsets for both merge groups before the merge moves them
                let mut previous_offsets = std::collections::HashMap::new();
                let sections_a = project.get_merged_section_ids(station_a.section_id);
                let sections_b = project.get_merged_section_ids(station_b.section_id);
                for section_id in sections_a.into_iter().chain(sections_b.into_iter()) {
                    previous_offsets
                        .insert(section_id, project.section_offsets.get(&section_id).copied());
                }

                UndoData::MergeInfo {
                    station_a: *station_a,
                    station_b: *station_b,
                    removed_closures: Vec::new(),
                    previous_offsets,
                }
            }

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

            Command::UnmergeStationPair {
                station_a,
                station_b,
            } => {
                let closures_to_remove: Vec<LoopClosure> = project
                    .loop_closures
                    .iter()
                    .filter(|lc| {
                        (lc.station_a == *station_a && lc.station_b == *station_b)
                            || (lc.station_a == *station_b && lc.station_b == *station_a)
                    })
                    .cloned()
                    .collect();

                UndoData::UnmergeInfo {
                    station_a: *station_a,
                    station_b: *station_b,
                    removed_closures: closures_to_remove,
                }
            }

            // For create loop closure, capture snapshot when it mutates shot data
            Command::CreateLoopClosure { closure_strategy, .. } => {
                if matches!(
                    closure_strategy,
                    ClosureStrategy::ProportionalByLength | ClosureStrategy::EqualDistribution
                ) {
                    match serde_json::to_string(project) {
                        Ok(before) => UndoData::ProjectSnapshotPair {
                            before,
                            after: String::new(), // Filled by finalize_undo_data
                        },
                        Err(_) => UndoData::None,
                    }
                } else {
                    UndoData::None
                }
            }

            Command::RemoveLoopClosure { closure_id } => {
                if let Some(closure) = project.loop_closures.iter().find(|lc| lc.id == *closure_id) {
                    UndoData::ClosureInfo {
                        closure: closure.clone(),
                    }
                } else {
                    UndoData::None
                }
            }

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

            // For station comment, inverse is restoring the previous comment
            Command::SetStationComment {
                station_ref,
                comment: _,
            } => {
                let previous_comment = project.station_comments.get(station_ref).cloned();
                UndoData::InverseCommand(Command::SetStationComment {
                    station_ref: *station_ref,
                    comment: previous_comment,
                })
            }

            // Move commands use inverse commands
            Command::MoveSection { section_id, offset } => {
                // Inverse is moving back by negative offset
                UndoData::InverseCommand(Command::MoveSection {
                    section_id: *section_id,
                    offset: Coordinates::new(-offset.x, -offset.y, -offset.z),
                })
            }

            Command::MoveSegment { section_id, offset } => {
                // Capture affected sections and their previous offsets at execution time
                // so that undo/redo is correct even if the connectivity graph changes later.
                // Filter to existing sections to avoid stale merges/closures referencing
                // deleted sections (matches move_segment() filtering).
                let existing: std::collections::HashSet<SectionId> =
                    project.sections.iter().map(|s| s.id).collect();
                let connected: Vec<SectionId> = project
                    .get_rigid_connected_section_ids(*section_id)
                    .into_iter()
                    .filter(|id| existing.contains(id))
                    .collect();
                let mut previous_offsets = std::collections::HashMap::new();
                for sid in &connected {
                    previous_offsets.insert(*sid, project.section_offsets.get(sid).copied());
                }
                UndoData::SegmentMoveInfo {
                    affected_sections: connected,
                    previous_offsets,
                    offset: (offset.x, offset.y),
                }
            }

            Command::MoveStation {
                station_ref,
                offset: _,
            } => {
                // Capture adjacent shot data and station offset before execution
                let section = project.sections.iter().find(|s| s.id == station_ref.section_id);
                match section {
                    Some(section) => {
                        let idx = station_ref.station_index as usize;
                        let prev_shot_before = if idx > 0 {
                            section.shots.get(idx - 1).map(|s| (s.id, s.to_shot_data()))
                        } else {
                            None
                        };
                        let prev_shot_after = section.shots.get(idx).map(|s| (s.id, s.to_shot_data()));
                        let prev_offset = project.station_offsets.get(station_ref).copied();
                        let prev_section_offset = project.section_offsets.get(&station_ref.section_id).copied();
                        UndoData::StationMoveInfo {
                            station_ref: *station_ref,
                            prev_shot_before,
                            prev_shot_after,
                            prev_offset,
                            prev_section_offset,
                        }
                    }
                    None => UndoData::None,
                }
            }

            // MoveComment: undo data is handled entirely inside execute_move_comment(),
            // which captures before+after snapshots and pushes directly.
            Command::MoveComment { .. } => UndoData::None,

            // Batch: undo data is handled entirely inside execute_batch(),
            // which captures before+after snapshots and pushes directly.
            Command::Batch { .. } => UndoData::None,

            // Non-undoable commands
            _ => UndoData::None,
        }
    }

    /// Finalize undo data after command execution (for commands that create new entities)
    pub(super) fn finalize_undo_data(&self, cmd: &Command, undo_data: UndoData) -> UndoData {
        let Ok(proj_guard) = self.project.lock() else {
            return undo_data;
        };

        let Some(project) = proj_guard.as_ref() else {
            return undo_data;
        };

        match cmd {
            Command::CreateSection { .. } => {
                // Capture full snapshot of the just-created section (the last one)
                // so that redo can restore it with its original ID instead of
                // re-executing CreateSection (which would assign a new ID).
                if let Some(section) = project.sections.last() {
                    UndoData::CreatedSectionSnapshot {
                        section_id: section.id,
                        section_data: section.to_section_data(),
                    }
                } else {
                    undo_data
                }
            }

            Command::CreateShot {
                section_id,
                before_shot_id,
                ..
            } => {
                // Capture full snapshot of the just-created shot so that redo can
                // restore it with its original ID instead of re-executing CreateShot
                // (which would assign a new ID).
                if let Some(section) = project.get_section(*section_id) {
                    // The just-created shot has ID = next_shot_id - 1
                    let shot_id = section.next_shot_id - 1;
                    // Find the shot by ID to get its actual position (not last() which
                    // would be wrong for mid-section inserts via after_shot_id)
                    if let Some((position, shot)) = section
                        .shots
                        .iter()
                        .enumerate()
                        .find(|(_, s)| s.id == shot_id)
                    {
                        // For insert_before: station_shift_from = position (the array position)
                        // For insert_after/append: station_shift_from = position + 1
                        // (insert_after creates new station at pos+2 of old array, but after
                        // insertion it's at position+1 in the new array; for redo we need the
                        // from_index matching the shift semantics of insert_before)
                        let station_shift_from = if before_shot_id.is_some() {
                            position as u32
                        } else {
                            // For insert_after and append: the new station doesn't displace
                            // existing ones in the same way. We use position + 1 so that on redo,
                            // refs at station >= position+1 get shifted up (matching insert_after
                            // semantics of shifting >= pos+2, but pos here is already post-insert).
                            // Actually, for append (end of section), no refs need shifting since
                            // there are no stations beyond it. Using section.shots.len() as u32
                            // ensures no refs match.
                            (position + 1) as u32
                        };
                        UndoData::CreatedShotSnapshot {
                            section_id: *section_id,
                            shot_id,
                            shot_data: shot.to_shot_data(),
                            position,
                            station_shift_from,
                        }
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
                closure_strategy,
            } => {
                if matches!(
                    closure_strategy,
                    ClosureStrategy::ProportionalByLength | ClosureStrategy::EqualDistribution
                ) {
                    if let UndoData::ProjectSnapshotPair { before, .. } = undo_data {
                        match serde_json::to_string(project) {
                            Ok(after) => UndoData::ProjectSnapshotPair { before, after },
                            Err(_) => UndoData::None,
                        }
                    } else {
                        undo_data
                    }
                } else {
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
            }

            // DeleteSection/DeleteShot/AdjustLoopClosures: fill in the "after" snapshot now that removal/adjustment is done
            Command::DeleteSection { .. }
            | Command::DeleteShot { .. }
            | Command::AdjustLoopClosures { .. } => {
                if let UndoData::ProjectSnapshotPair { before, .. } = undo_data {
                    match serde_json::to_string(project) {
                        Ok(after) => UndoData::ProjectSnapshotPair { before, after },
                        Err(_) => UndoData::None,
                    }
                } else {
                    undo_data
                }
            }

            // MoveComment: finalize is a no-op; execute_move_comment handles its own snapshots.
            Command::MoveComment { .. } => undo_data,

            // Batch: finalize_undo_data is a no-op; execute_batch handles
            // ProjectSnapshotPair construction directly so after-snapshot
            // failure can trigger rollback.
            Command::Batch { .. } => undo_data,

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
                // Pushes its own snapshot-pair undo inside apply_collab_changes.
                | Command::ApplyCollabChanges
        )
    }

    // === Project operations ===

    /// Perform undo - restore previous state based on undo data
    pub fn undo(&self) -> CommandResult {
        // Serialize command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
        self.undo_inner()
    }

    /// Undo implementation (caller must hold command_lock)
    fn undo_inner(&self) -> CommandResult {
        // Pop from undo stack
        let entry = {
            let Ok(mut stack) = self.undo_stack.lock() else {
                return CommandResult::failure("Failed to lock undo stack".to_string());
            };

            let Some(e) = stack.pop_undo() else {
                return CommandResult::failure("Nothing to undo".to_string());
            };
            e
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

            UndoData::CreatedSectionSnapshot {
                section_id, ..
            } => {
                // Undo a CreateSection by deleting the section
                self.delete_section(*section_id)
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

            UndoData::CreatedShotSnapshot {
                section_id,
                shot_id,
                ..
            } => {
                // Undo a CreateShot by deleting the shot
                self.delete_shot(*section_id, *shot_id)
            }

            UndoData::MergeInfo {
                station_a,
                station_b,
                previous_offsets,
                ..
            } => {
                // Undo a merge by restoring section offsets and unmerging the stations.
                match self.project.lock() {
                    Ok(mut proj_guard) => match proj_guard.as_mut() {
                        Some(project) => {
                            // Restore section offsets to pre-merge positions
                            project.restore_section_offsets(previous_offsets);

                            // Then unmerge the stations
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
                if merge_result.success {
                    // Merge succeeded, now restore removed closures
                    if !removed_closures.is_empty() {
                        if let Ok(mut proj_guard) = self.project.lock() {
                            if let Some(project) = proj_guard.as_mut() {
                                for closure in removed_closures {
                                    project.next_closure_id = project.next_closure_id.max(closure.id + 1);
                                    project.loop_closures.push(closure.clone());
                                }
                                project.touch();
                            }
                        }
                    }
                    merge_result
                } else {
                    // If re-merge fails (e.g., stations now connected), try direct restoration
                    match self.project.lock() {
                        Ok(mut proj_guard) => match proj_guard.as_mut() {
                            Some(project) => {
                                project.station_merges.push(crate::models::StationMerge {
                                    station_a: *station_a,
                                    station_b: *station_b,
                                    merged_at: chrono::Utc::now(),
                                });
                                // Restore removed closures and bump next_closure_id
                                for closure in removed_closures {
                                    project.next_closure_id = project.next_closure_id.max(closure.id + 1);
                                    project.loop_closures.push(closure.clone());
                                }
                                project.touch();
                                CommandResult::success()
                            }
                            None => CommandResult::failure("No project open".to_string()),
                        },
                        Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                    }
                }
            }

            UndoData::ClosureInfo { closure } => {
                match &entry.command {
                    Command::CreateLoopClosure { .. } => {
                        // Undo create by removing the same closure ID.
                        match self.project.lock() {
                            Ok(mut proj_guard) => match proj_guard.as_mut() {
                                Some(project) => {
                                    if let Some(pos) = project
                                        .loop_closures
                                        .iter()
                                        .position(|lc| lc.id == closure.id)
                                    {
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
                    Command::RemoveLoopClosure { .. } => {
                        // Undo remove by restoring the captured closure.
                        match self.project.lock() {
                            Ok(mut proj_guard) => match proj_guard.as_mut() {
                                Some(project) => {
                                    project.next_closure_id =
                                        project.next_closure_id.max(closure.id + 1);
                                    project.loop_closures.push(closure.clone());
                                    project.touch();
                                    CommandResult::success()
                                }
                                None => CommandResult::failure("No project open".to_string()),
                            },
                            Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                        }
                    }
                    _ => CommandResult::failure(
                        "Unsupported closure undo command".to_string(),
                    ),
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
                            project.restore_section_offsets(previous_offsets);

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

            UndoData::SegmentMoveInfo {
                previous_offsets,
                ..
            } => {
                // Restore previous offsets for each affected section
                match self.project.lock() {
                    Ok(mut proj_guard) => match proj_guard.as_mut() {
                        Some(project) => {
                            project.restore_section_offsets(previous_offsets);
                            project.touch();
                            CommandResult::success()
                        }
                        None => CommandResult::failure("No project open".to_string()),
                    },
                    Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                }
            }

            UndoData::StationMoveInfo {
                station_ref,
                prev_shot_before,
                prev_shot_after,
                prev_offset,
                prev_section_offset,
            } => {
                // Restore adjacent shot data and station offset
                match self.project.lock() {
                    Ok(mut proj_guard) => match proj_guard.as_mut() {
                        Some(project) => {
                            let section = project
                                .sections
                                .iter_mut()
                                .find(|s| s.id == station_ref.section_id);
                            if let Some(section) = section {
                                // Restore preceding shot
                                if let Some((shot_id, shot_data)) = prev_shot_before {
                                    if let Some(shot) = section.shots.iter_mut().find(|s| s.id == *shot_id) {
                                        shot.azimuth_in = shot_data.azimuth_in;
                                        shot.azimuth_out = shot_data.azimuth_out;
                                        shot.length = shot_data.length;
                                        shot.depth_in = shot_data.depth_in;
                                        shot.depth_out = shot_data.depth_out;
                                    }
                                }
                                // Restore following shot
                                if let Some((shot_id, shot_data)) = prev_shot_after {
                                    if let Some(shot) = section.shots.iter_mut().find(|s| s.id == *shot_id) {
                                        shot.azimuth_in = shot_data.azimuth_in;
                                        shot.azimuth_out = shot_data.azimuth_out;
                                        shot.length = shot_data.length;
                                        shot.depth_in = shot_data.depth_in;
                                        shot.depth_out = shot_data.depth_out;
                                    }
                                }
                            }
                            // Restore station offset
                            match prev_offset {
                                Some(offset) => {
                                    project.station_offsets.insert(*station_ref, *offset);
                                }
                                None => {
                                    project.station_offsets.remove(station_ref);
                                }
                            }
                            // Restore section offset
                            match prev_section_offset {
                                Some(offset) => {
                                    project.section_offsets.insert(station_ref.section_id, *offset);
                                }
                                None => {
                                    project.section_offsets.remove(&station_ref.section_id);
                                }
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
        // Serialize command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };
        self.redo_inner()
    }

    /// Redo implementation (caller must hold command_lock)
    fn redo_inner(&self) -> CommandResult {
        // Pop from redo stack
        let entry = {
            let Ok(mut stack) = self.undo_stack.lock() else {
                return CommandResult::failure("Failed to lock undo stack".to_string());
            };

            let Some(e) = stack.pop_redo() else {
                return CommandResult::failure("Nothing to redo".to_string());
            };
            e
        };

        // For snapshot-based undo data, restore from snapshot instead of re-executing.
        // This handles cases where re-execution would create different IDs.
        // IMPORTANT: No early returns after the pop — all paths flow through the epilogue.
        let result = match &entry.undo_data {
            UndoData::ProjectSnapshotPair { before: _, after } => {
                match serde_json::from_str::<Project>(after.as_str()) {
                    Ok(project) => match self.project.lock() {
                        Ok(mut proj) => {
                            *proj = Some(project);
                            CommandResult::success()
                        }
                        Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                    },
                    Err(_) => {
                        CommandResult::failure("Failed to parse project snapshot".to_string())
                    }
                }
            }
            UndoData::CreatedSectionSnapshot {
                section_id,
                section_data,
            } => {
                // Redo CreateSection by restoring from snapshot to preserve original ID
                self.restore_section(*section_id, section_data.clone())
            }
            UndoData::CreatedShotSnapshot {
                section_id,
                shot_id,
                shot_data,
                position,
                station_shift_from,
            } => {
                // Redo CreateShot by restoring from snapshot to preserve original ID
                let result = self.restore_shot(*section_id, *shot_id, shot_data.clone(), *position);
                if result.success && *station_shift_from < u32::MAX {
                    // Apply station ref shift for redo (mirrors what insert_shot_before/after does)
                    if let Ok(mut proj_guard) = self.project.lock() {
                        if let Some(project) = proj_guard.as_mut() {
                            project.shift_station_refs(*section_id, *station_shift_from, 1);
                            // For insert_before at pos=0, also adjust this section's
                            // offset to keep existing stations at the same visual position
                            if *position == 0 && *station_shift_from == 0 {
                                let (dx, dy) = Project::shot_displacement(shot_data);
                                if dx != 0.0 || dy != 0.0 {
                                    let current = project.section_offsets.get(section_id).copied().unwrap_or((0.0, 0.0));
                                    project.section_offsets.insert(*section_id, (current.0 - dx, current.1 - dy));
                                }
                            }
                        }
                    }
                }
                result
            }
            UndoData::SegmentMoveInfo {
                affected_sections,
                offset,
                ..
            } => {
                // Redo by reapplying the offset to the captured affected sections
                // Filter to sections that still exist (a section may have been deleted since capture)
                match self.project.lock() {
                    Ok(mut proj_guard) => match proj_guard.as_mut() {
                        Some(project) => {
                            let existing: std::collections::HashSet<SectionId> =
                                project.sections.iter().map(|s| s.id).collect();
                            for sid in affected_sections {
                                if !existing.contains(sid) {
                                    continue;
                                }
                                let current = project.section_offsets.get(sid).copied().unwrap_or((0.0, 0.0));
                                let new_offset = (current.0 + offset.0, current.1 + offset.1);
                                project.section_offsets.insert(*sid, new_offset);
                            }
                            project.touch();
                            CommandResult::success()
                        }
                        None => CommandResult::failure("No project open".to_string()),
                    },
                    Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                }
            }
            UndoData::ClosureInfo { closure } => {
                match &entry.command {
                    Command::CreateLoopClosure { .. } => {
                        // Redo create by restoring the captured closure to preserve its ID.
                        match self.project.lock() {
                            Ok(mut proj_guard) => match proj_guard.as_mut() {
                                Some(project) => {
                                    project.next_closure_id =
                                        project.next_closure_id.max(closure.id + 1);
                                    project.loop_closures.push(closure.clone());
                                    project.touch();
                                    CommandResult::success()
                                }
                                None => CommandResult::failure("No project open".to_string()),
                            },
                            Err(_) => CommandResult::failure("Failed to lock project".to_string()),
                        }
                    }
                    Command::RemoveLoopClosure { .. } => {
                        // Redo remove by removing the same closure ID again.
                        match self.project.lock() {
                            Ok(mut proj_guard) => match proj_guard.as_mut() {
                                Some(project) => {
                                    if let Some(pos) = project
                                        .loop_closures
                                        .iter()
                                        .position(|lc| lc.id == closure.id)
                                    {
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
                    _ => CommandResult::failure(
                        "Unsupported closure redo command".to_string(),
                    ),
                }
            }
            _ => {
                // Re-execute the original command for other undo data types
                self.execute_without_undo(entry.command.clone())
            }
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

    /// Execute a command without pushing to undo stack (used for undo operations and batch)
    pub(super) fn execute_without_undo(&self, cmd: Command) -> CommandResult {
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
            Command::MoveSection { section_id, offset } => self.move_section(*section_id, *offset),
            Command::MoveSegment { section_id, offset } => self.move_segment(*section_id, *offset),
            Command::SetStationComment {
                station_ref,
                comment,
            } => self.set_station_comment(*station_ref, comment.clone()),
            Command::MoveStation { station_ref, offset } => self.move_station(*station_ref, *offset),
            Command::Batch { commands } => self.execute_batch(commands.clone(), false),
            _ => CommandResult::failure("Command cannot be executed in undo context".to_string()),
        }
    }

    /// Restore a deleted section with its original ID
    fn restore_section(&self, original_id: SectionId, data: SectionData) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
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
        CommandResult::success().with_section_id(original_id)
    }

    /// Restore a deleted shot at its original position with its original ID
    fn restore_shot(
        &self,
        section_id: SectionId,
        original_shot_id: ShotId,
        data: ShotData,
        position: usize,
    ) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        let Some(project) = proj_guard.as_mut() else {
            return CommandResult::failure("No project open".to_string());
        };

        let Some(section) = project.get_section_mut(section_id) else {
            return CommandResult::failure(format!("Section {section_id} not found"));
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
        // Build a lightweight section name lookup map, then release the project lock
        // before acquiring the undo_stack lock (avoids holding both simultaneously)
        let section_names: std::collections::HashMap<u32, Option<String>> = self
            .project
            .lock()
            .ok()
            .and_then(|guard| {
                guard.as_ref().map(|p| {
                    p.sections.iter().map(|s| (s.id, s.name.clone())).collect()
                })
            })
            .unwrap_or_default();

        self.undo_stack
            .lock()
            .map(|stack| {
                stack
                    .undo_entries()
                    .enumerate()
                    .map(|(idx, entry)| {
                        crate::commands::history::entry_to_history_item(
                            entry,
                            idx,
                            &section_names,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Get the redo stack as a list of history items for the UI
    pub fn get_redo_stack(&self) -> Vec<crate::commands::history::UndoHistoryItem> {
        let section_names: std::collections::HashMap<u32, Option<String>> = self
            .project
            .lock()
            .ok()
            .and_then(|guard| {
                guard.as_ref().map(|p| {
                    p.sections.iter().map(|s| (s.id, s.name.clone())).collect()
                })
            })
            .unwrap_or_default();

        self.undo_stack
            .lock()
            .map(|stack| {
                stack
                    .redo_entries()
                    .enumerate()
                    .map(|(idx, entry)| {
                        crate::commands::history::entry_to_history_item(
                            entry,
                            idx,
                            &section_names,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Perform multiple undos to reach a specific history point
    /// Index 0 = most recent action, so undo_to(N) executes (N+1) undos
    pub fn undo_to(&self, index: usize) -> CommandResult {
        // Serialize command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };

        // Validate index first
        {
            let Ok(stack) = self.undo_stack.lock() else {
                return CommandResult::failure("Failed to lock undo stack".to_string());
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
            let result = self.undo_inner();
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
        // Serialize command execution to prevent concurrent interleaving
        let Ok(_cmd_guard) = self.command_lock.lock() else {
            return CommandResult::failure("Failed to acquire command lock".to_string());
        };

        // Validate index first
        {
            let Ok(stack) = self.undo_stack.lock() else {
                return CommandResult::failure("Failed to lock undo stack".to_string());
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
            let result = self.redo_inner();
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
