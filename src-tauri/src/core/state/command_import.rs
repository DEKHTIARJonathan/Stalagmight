use super::AppState;
use crate::core::{Command, CommandResult};
use crate::models::{
    ClosureStrategy, Coordinates, Project, SectionData, SectionId, ShotData, StationRef,
};
use std::sync::Mutex;

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
        use crate::models::{ImportPlacement, StationRef};
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
                // Make `resolve_key`'s AfterShot lookup O(1) for the hot
                // merge/closure connectivity loops below — without this, a large
                // import (e.g. a big Walls project) pins a core for minutes.
                project.rebuild_shot_uuid_index();
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

        // Create loop closures from TML CLOSURE shots (non-fatal). Resolve every
        // pair first (in order), then create them in ONE batch that builds the
        // closure-graph invariants once instead of rebuilding the whole graph per
        // closure — the dominant cost on a large import.
        let mut closure_pairs: Vec<(StationRef, StationRef)> = Vec::with_capacity(closures.len());
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
            closure_pairs.push((
                StationRef::new(from_section_id, closure.from_station_index),
                StationRef::new(to_section_id, closure.to_station_index),
            ));
        }
        if !closure_pairs.is_empty() {
            let results = {
                let mut proj_guard = match self.project.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                match proj_guard.as_mut() {
                    Some(project) => project.create_loop_closures_batch(&closure_pairs),
                    None => Vec::new(),
                }
            };
            for ((station_a, station_b), result) in closure_pairs.iter().zip(results) {
                match result {
                    Ok(lc) => tracing::debug!(
                        closure_id = lc.id,
                        ?station_a,
                        ?station_b,
                        purpose = "import loop closures",
                        "Created loop closure from TML import"
                    ),
                    Err(e) => tracing::warn!(
                        ?station_a,
                        ?station_b,
                        error = %e,
                        purpose = "import loop closures",
                        "Failed to create loop closure from TML import, skipping"
                    ),
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
        // An import only ADDS sections/merges/closures (its closures are loops over
        // the spanning-tree merges, never sole bridges), so it can't strand a
        // section behind a closure — skip the O(closures × connectivity)
        // sole-bridge conversion that otherwise dominated a large import.
        if self.finalize_structural_edit(pre_had_critical, false) {
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
}
