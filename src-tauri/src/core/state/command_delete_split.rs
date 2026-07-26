use super::AppState;
use crate::core::{Command, CommandResult};
use crate::models::{Project, SectionData, SectionId, ShotData, ShotId, StationKey, StationRef};

impl AppState {
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
        // Read-only edit gate (#191, D-B6): gated on a read-only remote project.
        if let Err(f) = self.guard_mutation("Delete shot and split section") {
            return f;
        }
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

            // Frozen-geometry guard (mirrors delete_shot and the range-split
            // path): this path deletes `shot_id`, so refuse if it is part of an
            // adjusted survey network -- otherwise a frozen mid-section shot can
            // be deleted through the split path, silently breaking the LSQ
            // solution's frozen geometry. (#241)
            if project.is_shot_frozen_by_id(section_id, shot_id) {
                return CommandResult::failure(
                    "Cannot delete a frozen shot. This shot is part of an adjusted survey network."
                        .to_string(),
                );
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

            // A split allocates a new section id. Refuse before mutating the
            // original: past MAX_SECTION_ID the save would succeed and the
            // reopen would not (persistence::sqlite::read rejects the id).
            if !project.can_add_section() {
                return CommandResult::failure(format!(
                    "Cannot split: project is at the maximum number of sections (limit = {})",
                    crate::models::MAX_SECTION_ID as u64 + 1
                ));
            }
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
                 refs than were captured in old_refs - traversal order diverged"
            );

            // The split can strand a section so its only attachment is a loop
            // closure - that is a merge, not a loop. Convert it now (issue #8)
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
        // Dirty-bit flip (#191, D-B16): a delete/split mutated a remote project.
        // Set-only; no-op for local-only.
        self.mark_remote_dirty();

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
        // Read-only edit gate (#191, D-B6): gated on a read-only remote project.
        if let Err(f) = self.guard_mutation("Delete shot range and split section") {
            return f;
        }
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
            // own refs - BEFORE we capture old_refs, so the stored-ref set is
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
            // A split allocates a new section id. Refuse before mutating the
            // original: past MAX_SECTION_ID the save would succeed and the
            // reopen would not (persistence::sqlite::read rejects the id).
            if !project.can_add_section() {
                return CommandResult::failure(format!(
                    "Cannot split: project is at the maximum number of sections (limit = {})",
                    crate::models::MAX_SECTION_ID as u64 + 1
                ));
            }
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
                 than were captured in old_refs - traversal order diverged"
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
        // Dirty-bit flip (#191, D-B16): a delete/split mutated a remote project.
        // Set-only; no-op for local-only.
        self.mark_remote_dirty();

        tracing::info!(
            section_id,
            new_section_id,
            purpose = "split section after deleting shot range",
            "Delete shot range and split section completed"
        );
        CommandResult::success().with_section_id(new_section_id)
    }

    /// Delete a contiguous range of shots by gap-closing (shifting) - the
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
        // Read-only edit gate (#191, D-B6): gated on a read-only remote project.
        if let Err(f) = self.guard_mutation("Delete shot range and shift") {
            return f;
        }
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
            // Deleting the whole section this way would leave it empty - route
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
            // position - otherwise an anchor on a later, also-doomed range shot
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
                    // Already mutated - roll back to the before snapshot.
                    let _ = Self::restore_snapshot_into(&mut proj_guard, &before_snapshot);
                    return CommandResult::failure(e);
                }
            }
            // Single cascade now that every range shot (and any doomed merge) is
            // gone, so a doomed station's intermediate shift never propagates into
            // a connected free-floating section - the per-shot cascades were
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
        // Dirty-bit flip (#191, D-B16): a delete/split mutated a remote project.
        // Set-only; no-op for local-only.
        self.mark_remote_dirty();

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
        // Read-only edit gate (#191, D-B6): gated on a read-only remote project.
        if let Err(f) = self.guard_mutation("Delete last shot and section") {
            return f;
        }
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
            // claims exist - clear it so the next get_merged_section_ids
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
        // Dirty-bit flip (#191, D-B16): a delete/split mutated a remote project.
        // Set-only; no-op for local-only.
        self.mark_remote_dirty();

        CommandResult::success()
    }
}
