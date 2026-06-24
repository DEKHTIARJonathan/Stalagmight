use chrono::Utc;
use std::collections::{HashSet, VecDeque};
use tracing::{debug, error, info, trace};

use crate::models::{
    gps_to_local, ClosurePreview, ClosureStrategy, GpsCoordinates, LoopClosure, SectionId,
    StationMerge, StationRef, ZeroDatum,
};

use super::Project;

impl Project {
    /// Merge two stations
    /// Returns Err if validation fails, Ok(true) on success
    pub fn merge_stations(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> Result<bool, String> {
        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            purpose = "merge stations",
            "Merging stations"
        );
        // Check that both stations exist
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return Err("One or both stations do not exist".to_string());
        }

        // Check not already merged
        if self.are_stations_merged(station_a, station_b) {
            return Err("These stations are already merged".to_string());
        }

        // Reject only if the two sections are already RIGIDLY connected (via merges
        // or *aligned* closures) — adding a merge there would create a redundant
        // rigid cycle, which is what a loop closure is for. An INERT (unaligned)
        // closure does not constrain the two stations yet, so a merge across one is
        // the first real connection and must be allowed; rejecting it (the old
        // get_connected_section_ids walk, which followed inert closures too) forced
        // users into the sole-bridge-closure-that-should-be-a-merge bug. This asserts
        // the same graph the cascade actually solves (catalog #8 / #integrity Root 3).
        let connected_a = self.get_rigid_connected_section_ids(station_a.section_id);
        if connected_a.contains(&station_b.section_id) {
            return Err(
                "Stations are already connected. Use Create Loop Closure instead.".to_string(),
            );
        }

        // Check zero datum status - uses transitive connections through existing merges
        // This ensures that if B is connected to a datum-holding section C through an
        // earlier merge, b_has_zd will be true and the merge will propagate datum positioning
        let a_has_zd = self.section_has_zero_datum(station_a.section_id);
        let b_has_zd = self.section_has_zero_datum(station_b.section_id);

        if a_has_zd && b_has_zd {
            return Err("Both stations are connected to zero datums. Remove one zero datum before merging, or create a loop closure if the sections are connected.".to_string());
        }

        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            a_has_zero_datum = a_has_zd,
            b_has_zero_datum = b_has_zd,
            purpose = "merge stations",
            "Resolved zero datum anchors for merge"
        );

        // Compute current coordinates (includes existing section offsets)
        // Coordinates are in the world coordinate system established by the datum
        let coords_a = self
            .compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b = self
            .compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute coordinates for station B".to_string())?;

        // Datum propagation: When merging a section without datum into a datum group,
        // the non-datum section is repositioned to align with the datum coordinate system.
        // This is similar to set_zero_datum() offset calculation but triggered by merge.
        //
        // Determine which section group needs to move:
        // - If A has zero datum (direct or transitive), B's group moves to align with A
        // - If B has zero datum (direct or transitive), A's group moves to align with B
        // - If neither has zero datum, A's group moves to align with B (arbitrary choice)
        let (anchor_coords, moving_coords, moving_section_id) = if a_has_zd {
            (coords_a, coords_b, station_b.section_id)
        } else {
            // B has zero datum OR neither has one (in which case B is the anchor)
            (coords_b, coords_a, station_a.section_id)
        };

        // Calculate offset to move the merge point station from its current position
        // to the anchor station's position, aligning them in world coordinates
        let offset_x = anchor_coords.x - moving_coords.x;
        let offset_y = anchor_coords.y - moving_coords.y;

        // Apply offset to all sections in the moving merge group (rigid body)
        // This repositions the entire moving group relative to the datum coordinate system
        let moving_sections = self.get_merged_section_ids(moving_section_id);
        // Resolve-aware (a dangling datum is not a real anchor — matching
        // section_has_zero_datum), so a deleted-anchor datum can't trigger a
        // spurious "merge would move a zero datum" alarm.
        let moving_has_zero_datum = self
            .zero_datums
            .iter()
            .filter_map(|zd| self.resolve_key(&zd.station_ref))
            .any(|sr| moving_sections.contains(&sr.section_id));
        if moving_has_zero_datum && (offset_x.abs() > 1e-9 || offset_y.abs() > 1e-9) {
            error!(
                moving_section_id,
                offset_x,
                offset_y,
                moving_section_count = moving_sections.len(),
                purpose = "protect zero datum position",
                "Merge would move a zero datum section"
            );
        }

        debug!(
            moving_section_id,
            moving_section_count = moving_sections.len(),
            offset_x,
            offset_y,
            purpose = "merge stations",
            "Computed merge offset for moving sections"
        );
        self.adjust_rigid_group_offsets(moving_section_id, offset_x, offset_y);

        // Record the merge via the helper so the merge-adjacency cache
        // stays in sync. (Direct push would silently skip the cache,
        // forcing the next BFS into the O(N) fallback path.)
        let (Some(key_a), Some(key_b)) = (self.key_for_ref(station_a), self.key_for_ref(station_b))
        else {
            return Err("Cannot merge: station has no stable anchor".to_string());
        };
        self.record_station_merge(StationMerge {
            station_a: key_a,
            station_b: key_b,
            merged_at: Utc::now(),
        });

        // Cascade through any further connections that the new merge may ripple into
        self.cascade_connection_offsets(&[station_a.section_id, station_b.section_id]);
        self.debug_assert_merge_alignment("merge_stations");
        self.touch();
        Ok(true)
    }

    /// Compute closure metrics between two stations without mutation.
    /// Both stations must exist and have computable coordinates.
    pub(crate) fn compute_closure_metrics(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> Result<ClosurePreview, String> {
        trace!(
            station_a = ?station_a,
            station_b = ?station_b,
            purpose = "compute closure metrics",
            "Computing closure metrics"
        );
        let coords_a = self
            .compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b = self
            .compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute coordinates for station B".to_string())?;

        let horizontal_misclosure = coords_a.horizontal_distance_to(&coords_b);
        let vertical_misclosure = (coords_a.z - coords_b.z).abs();
        let misclosure_distance = coords_a.distance_to(&coords_b);
        let path_length = self.calculate_path_length_between(station_a, station_b);

        let error_percentage = if path_length > 0.0 {
            (misclosure_distance / path_length) * 100.0
        } else {
            0.0
        };

        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            path_length,
            misclosure_distance,
            error_percentage,
            horizontal_misclosure,
            vertical_misclosure,
            purpose = "compute closure metrics",
            "Computed closure metrics"
        );

        Ok(ClosurePreview {
            path_length,
            misclosure_distance,
            error_percentage,
            horizontal_misclosure,
            vertical_misclosure,
        })
    }

    /// Create a loop closure between two connected stations
    /// Returns the created LoopClosure on success
    pub fn create_loop_closure(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    ) -> Result<LoopClosure, String> {
        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            strategy = ?strategy,
            purpose = "create loop closure",
            "Creating loop closure"
        );
        // Check that both stations exist
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return Err("One or both stations do not exist".to_string());
        }

        // Reject already-merged station pairs
        if self.are_stations_merged(station_a, station_b) {
            return Err(
                "These stations are already merged. Closures are for unmerged station pairs."
                    .to_string(),
            );
        }

        // Check stations are connected (via merges or closures)
        let connected_a = self.get_connected_section_ids(station_a.section_id);
        let connected = connected_a.contains(&station_b.section_id);
        if !connected {
            let a_has_zd = self.section_has_zero_datum(station_a.section_id);
            let b_has_zd = self.section_has_zero_datum(station_b.section_id);
            if !(a_has_zd && b_has_zd) {
                return Err("Stations are not connected. They must be in the same connected group to create a loop closure.".to_string());
            }
        }

        // Check for duplicate closure between same station pair
        let already_has_closure = self.are_stations_in_closure(station_a, station_b);
        if already_has_closure {
            return Err("A loop closure already exists between these stations.".to_string());
        }

        // Compute closure values using shared helper
        let metrics = self.compute_closure_metrics(station_a, station_b)?;

        // Deferred: create-time distribution strategies are disabled for now.
        if matches!(
            strategy,
            ClosureStrategy::ProportionalByLength | ClosureStrategy::EqualDistribution
        ) {
            return Err("Closure distribution strategies are deferred. Use Batch.".to_string());
        }

        // Normalize next_closure_id in case of legacy deserialization (default 0)
        let max_existing = self.loop_closures.iter().map(|lc| lc.id).max().unwrap_or(0);
        if self.next_closure_id <= max_existing {
            self.next_closure_id = max_existing + 1;
        }
        // Assign next closure ID from monotonic counter
        let next_id = self.next_closure_id;
        self.next_closure_id += 1;

        let (Some(key_a), Some(key_b)) = (self.key_for_ref(station_a), self.key_for_ref(station_b))
        else {
            return Err("Cannot create loop closure: station has no stable anchor".to_string());
        };
        let closure = LoopClosure {
            id: next_id,
            station_a: key_a,
            station_b: key_b,
            path_length: metrics.path_length,
            misclosure_distance: metrics.misclosure_distance,
            error_percentage: metrics.error_percentage,
            horizontal_misclosure: metrics.horizontal_misclosure,
            vertical_misclosure: metrics.vertical_misclosure,
            strategy,
            is_aligned: strategy == ClosureStrategy::Move,
        };

        self.loop_closures.push(closure.clone());
        self.touch();

        info!(
            closure_id = closure.id,
            station_a = ?station_a,
            station_b = ?station_b,
            strategy = ?strategy,
            purpose = "create loop closure",
            "Loop closure created"
        );

        Ok(closure)
    }

    /// Remove a loop closure by ID
    pub fn remove_loop_closure(&mut self, closure_id: u64) -> Result<LoopClosure, String> {
        if let Some(pos) = self.loop_closures.iter().position(|lc| lc.id == closure_id) {
            let closure = self.loop_closures.remove(pos);
            self.touch();
            info!(
                closure_id,
                station_a = ?closure.station_a,
                station_b = ?closure.station_b,
                purpose = "remove loop closure",
                "Loop closure removed"
            );
            Ok(closure)
        } else {
            Err("Loop closure not found".to_string())
        }
    }

    /// Unmerge stations. Also removes closures for the specific unmerged pair only.
    /// Returns (success, removed_closures) where removed_closures contains any
    /// loop closures that matched this specific station pair.
    pub fn unmerge_stations(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> (bool, Vec<LoopClosure>) {
        let pos = self.station_merges.iter().position(|m| {
            (self.key_is_ref(&m.station_a, station_a) && self.key_is_ref(&m.station_b, station_b))
                || (self.key_is_ref(&m.station_a, station_b)
                    && self.key_is_ref(&m.station_b, station_a))
        });

        if let Some(pos) = pos {
            self.station_merges.remove(pos);
            // Drop the adjacency cache — recomputing the precise edge
            // deletion would duplicate the work `retain` already did.
            self.merge_adjacency_cache.clear();

            // Decide which closures match the unmerged pair before the retain —
            // `resolve_key` needs `&self`, but `retain` borrows `loop_closures`
            // mutably, so the resolution can't happen inside the closure.
            let remove_flags: Vec<bool> = self
                .loop_closures
                .iter()
                .map(|lc| {
                    (self.key_is_ref(&lc.station_a, station_a)
                        && self.key_is_ref(&lc.station_b, station_b))
                        || (self.key_is_ref(&lc.station_a, station_b)
                            && self.key_is_ref(&lc.station_b, station_a))
                })
                .collect();

            // Remove closures for the specific unmerged pair only
            let mut removed_closures = Vec::new();
            let mut flag_iter = remove_flags.into_iter();
            self.loop_closures.retain(|lc| {
                if flag_iter.next() == Some(true) {
                    removed_closures.push(lc.clone());
                    false
                } else {
                    true
                }
            });

            self.touch();
            (true, removed_closures)
        } else {
            (false, Vec::new())
        }
    }

    /// Check if two stations are merged
    pub fn are_stations_merged(&self, a: StationRef, b: StationRef) -> bool {
        if a == b {
            return true;
        }
        // Check transitive merge equivalence using BFS through merge graph.
        // Two stations are "merged" if there's any chain of merges connecting them
        // (i.e., they're in the same merge group).
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(a);
        queue.push_back(a);

        while let Some(current) = queue.pop_front() {
            for merge in &self.station_merges {
                let neighbor = if self.key_is_ref(&merge.station_a, current) {
                    self.resolve_key(&merge.station_b)
                } else if self.key_is_ref(&merge.station_b, current) {
                    self.resolve_key(&merge.station_a)
                } else {
                    None
                };
                if let Some(n) = neighbor {
                    if n == b {
                        return true;
                    }
                    if visited.insert(n) {
                        queue.push_back(n);
                    }
                }
            }
        }
        false
    }

    /// Check if two stations are in a loop closure
    pub fn are_stations_in_closure(&self, a: StationRef, b: StationRef) -> bool {
        self.loop_closures.iter().any(|lc| {
            (self.key_is_ref(&lc.station_a, a) && self.key_is_ref(&lc.station_b, b))
                || (self.key_is_ref(&lc.station_a, b) && self.key_is_ref(&lc.station_b, a))
        })
    }

    /// Check if a station reference is valid
    pub fn station_exists(&self, station_ref: StationRef) -> bool {
        if let Some(section) = self.get_section(station_ref.section_id) {
            // Station index 0 is before first shot, subsequent indices are after each shot
            station_ref.station_index as usize <= section.shots.len()
        } else {
            false
        }
    }

    /// The zero datum (other than `station_ref` itself) that already anchors the
    /// merge-connected rigid group `station_ref` belongs to, if any. Used to reject
    /// setting a second datum on an already-anchored group. Merge-only connectivity
    /// via the shared [`Self::component_datum_refs`] source of truth.
    fn find_connected_zero_datum(&self, station_ref: StationRef) -> Option<StationRef> {
        self.component_datum_refs(station_ref.section_id)
            .into_iter()
            .find(|&sr| sr != station_ref)
    }

    /// Format a station reference for user display.
    /// Uses section name if available, otherwise "Section N" (0-indexed to match canonical IDs).
    /// Station index is displayed as 0-indexed to match UI format (e.g., "Section #0").
    fn format_station_ref_for_display(&self, station_ref: StationRef) -> String {
        let section_label = self
            .sections
            .iter()
            .find(|s| s.id == station_ref.section_id)
            .and_then(|s| s.name.as_ref())
            .map_or_else(
                || format!("Section {}", station_ref.section_id),
                |name| format!("\"{name}\""),
            );

        // Display station index as 0-indexed to match canonical StationRef format
        format!("{} #{}", section_label, station_ref.station_index)
    }

    /// Set a station as the zero datum and reposition connected sections.
    ///
    /// When a GPS reference is set:
    /// - For the first datum: The station is repositioned to (0, 0) via section offsets
    /// - For subsequent datums: The station is positioned at the GPS offset from the first datum
    ///
    /// All sections connected through station merges are moved together.
    /// Z-coordinates (depths) are preserved and not affected by GPS positioning.
    ///
    /// Returns Err if the station doesn't exist, GPS is invalid, or if a connected station
    /// already has a zero datum.
    pub fn set_zero_datum(
        &mut self,
        station_ref: StationRef,
        gps: GpsCoordinates,
    ) -> Result<bool, String> {
        if !self.station_exists(station_ref) {
            return Err("Station does not exist".to_string());
        }

        // Validate GPS coordinates to prevent serialization issues
        GpsCoordinates::validate(gps.latitude, gps.longitude, gps.depth_reference)?;

        // Stable stored identity for this datum's station.
        let datum_key = self
            .key_for_ref(station_ref)
            .ok_or_else(|| "Cannot set zero datum: station has no stable anchor".to_string())?;

        // Check for connected zero datum
        if let Some(existing) = self.find_connected_zero_datum(station_ref) {
            let new_station = self.format_station_ref_for_display(station_ref);
            let existing_station = self.format_station_ref_for_display(existing);
            return Err(format!(
                "Cannot set zero datum: {new_station} is connected to {existing_station} which already has a zero datum"
            ));
        }

        info!(
            station_ref = ?station_ref,
            gps_lat = gps.latitude,
            gps_lng = gps.longitude,
            purpose = "anchor survey to GPS",
            "Setting zero datum"
        );

        // Get all sections connected through merges (rigid group for offset propagation)
        let connected_sections = self.get_merged_section_ids(station_ref.section_id);
        debug!(
            station_ref = ?station_ref,
            connected_section_count = connected_sections.len(),
            connected_sections = ?connected_sections,
            purpose = "reposition connected sections",
            "Computed connected sections for zero datum"
        );

        // Compute current raw coordinates of the datum station
        let current_coords = self
            .compute_station_raw_coords(station_ref)
            .ok_or_else(|| "Failed to compute station coordinates".to_string())?;
        debug!(
            station_ref = ?station_ref,
            coords = ?current_coords,
            purpose = "reposition connected sections",
            "Computed raw station coordinates for zero datum"
        );

        // Determine target position based on whether this is the first datum
        // Special case: if updating the first datum station itself, keep it at origin
        let target_x: f64;
        let target_y: f64;

        let is_first_datum_station = self
            .zero_datums
            .first()
            .is_some_and(|d| d.station_ref == datum_key);

        if is_first_datum_station {
            // Updating the first datum: keep at origin (0, 0)
            target_x = 0.0;
            target_y = 0.0;
            debug!(
                station_ref = ?station_ref,
                purpose = "anchor survey to GPS",
                "Updating first datum; keeping at origin"
            );
        } else if let Some(first_datum) = self.zero_datums.first() {
            // Subsequent datum: compute GPS offset from first datum
            let (east, north) = gps_to_local(&gps, &first_datum.gps);
            target_x = east;
            target_y = north;
            debug!(
                station_ref = ?station_ref,
                offset_x = east,
                offset_y = north,
                purpose = "anchor survey to GPS",
                "Computed GPS offset from first datum"
            );
        } else {
            // First datum: position at origin (0, 0)
            target_x = 0.0;
            target_y = 0.0;
            debug!(
                station_ref = ?station_ref,
                purpose = "anchor survey to GPS",
                "First datum; positioning at origin"
            );
        }

        // Compute the offset needed to move station from current position to target
        let offset_delta_x = target_x - current_coords.x;
        let offset_delta_y = target_y - current_coords.y;
        debug!(
            station_ref = ?station_ref,
            offset_delta_x,
            offset_delta_y,
            purpose = "reposition connected sections",
            "Computed offset delta for zero datum"
        );

        // Apply offset to all connected sections (rigid group)
        self.adjust_rigid_group_offsets(station_ref.section_id, offset_delta_x, offset_delta_y);

        // Cascade through aligned closures that may have been affected
        self.cascade_connection_offsets(&[station_ref.section_id]);
        self.debug_assert_merge_alignment("set_zero_datum");

        // Store the GPS datum
        // Update in-place if datum exists (preserves order/position for stable center)
        let mut updated_existing = false;
        if let Some(existing) = self
            .zero_datums
            .iter_mut()
            .find(|zd| zd.station_ref == datum_key)
        {
            existing.gps = gps;
            updated_existing = true;
        } else {
            self.zero_datums.push(ZeroDatum {
                station_ref: datum_key,
                gps,
            });
        }

        self.touch();
        info!(
            station_ref = ?station_ref,
            updated_existing,
            connected_section_count = connected_sections.len(),
            total_zero_datums = self.zero_datums.len(),
            purpose = "anchor survey to GPS",
            "Zero datum set successfully"
        );
        Ok(true)
    }

    /// Store a zero datum without triggering section repositioning.
    ///
    /// This is an internal helper for use by `merge_projects` and import paths
    /// that need to copy datums from source projects without recomputing offsets.
    /// The source project's section_offsets are assumed to already be correct.
    ///
    /// Returns Err if validation fails (same rules as `set_zero_datum`).
    pub fn store_zero_datum_without_repositioning(
        &mut self,
        station_ref: StationRef,
        gps: GpsCoordinates,
    ) -> Result<bool, String> {
        if !self.station_exists(station_ref) {
            return Err("Station does not exist".to_string());
        }

        // Validate GPS coordinates
        GpsCoordinates::validate(gps.latitude, gps.longitude, gps.depth_reference)?;

        // Stable stored identity for this datum's station.
        let datum_key = self
            .key_for_ref(station_ref)
            .ok_or_else(|| "Cannot store zero datum: station has no stable anchor".to_string())?;

        // Check for connected zero datum (same validation as set_zero_datum)
        if let Some(existing) = self.find_connected_zero_datum(station_ref) {
            let new_station = self.format_station_ref_for_display(station_ref);
            let existing_station = self.format_station_ref_for_display(existing);
            return Err(format!(
                "Cannot store zero datum: {new_station} is connected to {existing_station} which already has a zero datum"
            ));
        }

        debug!(
            station_ref = ?station_ref,
            gps_lat = gps.latitude,
            gps_lng = gps.longitude,
            purpose = "store zero datum without repositioning",
            "Storing zero datum without repositioning"
        );

        // Store the GPS datum without computing or applying offsets
        let mut updated_existing = false;
        if let Some(existing) = self
            .zero_datums
            .iter_mut()
            .find(|zd| zd.station_ref == datum_key)
        {
            existing.gps = gps;
            updated_existing = true;
        } else {
            self.zero_datums.push(ZeroDatum {
                station_ref: datum_key,
                gps,
            });
        }

        self.touch();
        debug!(
            station_ref = ?station_ref,
            updated_existing,
            total_zero_datums = self.zero_datums.len(),
            purpose = "store zero datum without repositioning",
            "Zero datum stored without repositioning"
        );
        Ok(true)
    }

    /// Remove zero datum from a station
    pub fn remove_zero_datum(&mut self, station_ref: StationRef) -> bool {
        let len_before = self.zero_datums.len();
        let target_key = self.key_for_ref(station_ref);
        self.zero_datums
            .retain(|zd| Some(&zd.station_ref) != target_key.as_ref());
        if self.zero_datums.len() == len_before {
            debug!(
                station_ref = ?station_ref,
                purpose = "remove zero datum",
                "Zero datum not found for removal"
            );
            false
        } else {
            self.touch();
            info!(
                station_ref = ?station_ref,
                remaining_zero_datums = self.zero_datums.len(),
                purpose = "remove zero datum",
                "Zero datum removed"
            );
            true
        }
    }

    /// Get the primary zero datum (first one, or None)
    pub fn primary_zero_datum(&self) -> Option<&ZeroDatum> {
        self.zero_datums.first()
    }

    /// After a geometry-changing shot edit in `edited_section_id`, realign the
    /// merge group's section offsets so that anchored stations (zero datums,
    /// merge points to pinned sections) remain at their correct positions.
    ///
    /// Stations upstream of the edit absorb the length change; stations downstream
    /// (including merge points and closure endpoints) remain stationary.
    ///
    /// Algorithm:
    /// 1. Find the zero datum anchoring this merge group (if any)
    /// 2. Reanchor the datum section (adjust offset to keep datum at GPS target)
    /// 3. BFS through merges: adjust each partner section's offset so merge
    ///    points stay aligned
    ///
    /// Idempotent: calling multiple times produces the same result.
    pub(crate) fn realign_after_shot_edit(&mut self, edited_section_id: SectionId) {
        // Find the merge group containing the edited section
        let merge_group = self.get_merged_section_ids(edited_section_id);

        // Find the zero datum for this merge group (if any)
        let datum = self
            .zero_datums
            .iter()
            .find(|d| merge_group.contains(&d.station_ref.section_id))
            .cloned();

        let datum = match datum {
            Some(d) => d,
            None => return, // No anchor in this group, nothing to realign
        };

        // Determine the datum's target position
        let is_first = self
            .zero_datums
            .first()
            .map(|d| d.station_ref == datum.station_ref)
            .unwrap_or(false);

        let (target_x, target_y) = if is_first {
            (0.0, 0.0)
        } else if let Some(first) = self.zero_datums.first() {
            gps_to_local(&datum.gps, &first.gps)
        } else {
            return;
        };

        // Step 1: Reanchor the datum section's offset to keep datum at target
        let datum_section_id = datum.station_ref.section_id;
        if let Some(current) = self
            .resolve_key(&datum.station_ref)
            .and_then(|sr| self.compute_station_raw_coords(sr))
        {
            let delta_x = target_x - current.x;
            let delta_y = target_y - current.y;
            if delta_x.abs() > 1e-12 || delta_y.abs() > 1e-12 {
                self.adjust_section_offset(datum_section_id, delta_x, delta_y);
            }
        }

        // Step 2: BFS through merges from the datum section, adjusting each
        // partner section's offset so its merge station matches the already-
        // aligned station on the other side.
        let merges = self.station_merges.clone();
        let mut visited = HashSet::new();
        visited.insert(datum_section_id);
        let mut queue = VecDeque::new();
        queue.push_back(datum_section_id);

        while let Some(current_section) = queue.pop_front() {
            for merge in &merges {
                let (this_station, partner_station) = if merge.station_a.section_id
                    == current_section
                    && !visited.contains(&merge.station_b.section_id)
                {
                    (&merge.station_a, &merge.station_b)
                } else if merge.station_b.section_id == current_section
                    && !visited.contains(&merge.station_a.section_id)
                {
                    (&merge.station_b, &merge.station_a)
                } else {
                    continue;
                };

                let partner_section = partner_station.section_id;
                visited.insert(partner_section);

                // this_station's section is already aligned; partner needs adjustment
                if let (Some(this_pos), Some(partner_pos)) = (
                    self.resolve_key(this_station)
                        .and_then(|sr| self.compute_station_raw_coords(sr)),
                    self.resolve_key(partner_station)
                        .and_then(|sr| self.compute_station_raw_coords(sr)),
                ) {
                    let delta_x = this_pos.x - partner_pos.x;
                    let delta_y = this_pos.y - partner_pos.y;
                    if delta_x.abs() > 1e-12 || delta_y.abs() > 1e-12 {
                        self.adjust_section_offset(partner_section, delta_x, delta_y);
                    }
                }

                queue.push_back(partner_section);
            }
        }
    }
}
