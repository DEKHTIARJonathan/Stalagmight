use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tracing::{debug, info};

use super::{
    gps_to_local, ClosureStrategy, Coordinates, GpsBounds, GpsCoordinates, LoopClosure, Section,
    SectionData, SectionId, SectionUpdates, Shot, ShotData, ShotId, ShotUpdates, Station,
    StationMerge, StationRef, ZeroDatum,
};

/// A complete cave survey project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Project name (typically cave system name)
    pub name: String,
    /// Optional location description
    pub location: Option<String>,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last modification timestamp
    pub modified_at: DateTime<Utc>,
    /// All sections in this project
    pub sections: Vec<Section>,
    /// Station merges
    pub station_merges: Vec<StationMerge>,
    /// Zero datums
    pub zero_datums: Vec<ZeroDatum>,
    /// Detected loop closures
    #[serde(default)]
    pub loop_closures: Vec<LoopClosure>,
    /// File path if saved (None for new unsaved projects)
    pub file_path: Option<PathBuf>,
    /// Next section ID to assign
    pub next_section_id: SectionId,
    /// Section offsets (x, y) applied when sections are merged/aligned
    #[serde(default)]
    pub section_offsets: HashMap<SectionId, (f64, f64)>,
    /// SHA256 hashes of imported DMP files (for duplicate detection)
    #[serde(default)]
    pub imported_file_hashes: Vec<String>,
}

/// Project metadata for listing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMetadata {
    pub name: String,
    pub location: Option<String>,
    pub file_path: PathBuf,
    pub modified_at: DateTime<Utc>,
    pub section_count: usize,
    pub total_length: f64,
    /// GPS center from first zero datum (lat, lng)
    pub gps_center: Option<(f64, f64)>,
    /// GPS bounds including all zero datums
    pub gps_bounds: Option<GpsBounds>,
}

/// Overall project statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStats {
    pub section_count: usize,
    pub shot_count: usize,
    pub total_length: f64,
    pub min_depth: f64,
    pub max_depth: f64,
    pub station_count: usize,
    pub loop_count: usize,
    /// Maximum straight-line distance from zero datum to any station
    pub penetration_distance: f64,
}

impl Project {
    /// Create a new empty project
    pub fn new(name: String, location: Option<String>) -> Self {
        let now = Utc::now();
        Self {
            name,
            location,
            created_at: now,
            modified_at: now,
            sections: Vec::new(),
            station_merges: Vec::new(),
            zero_datums: Vec::new(),
            loop_closures: Vec::new(),
            file_path: None,
            next_section_id: 0,
            section_offsets: HashMap::new(),
            imported_file_hashes: Vec::new(),
        }
    }

    /// Mark the project as modified
    pub fn touch(&mut self) {
        self.modified_at = Utc::now();
    }

    // === Section operations ===

    /// Add a new section to the project
    pub fn add_section(&mut self, data: SectionData) -> &Section {
        let section = Section::new(self.next_section_id, data);
        self.next_section_id += 1;
        self.sections.push(section);
        self.touch();
        self.sections.last().unwrap()
    }

    /// Get a section by ID
    pub fn get_section(&self, section_id: SectionId) -> Option<&Section> {
        self.sections.iter().find(|s| s.id == section_id)
    }

    /// Get a mutable reference to a section by ID
    pub fn get_section_mut(&mut self, section_id: SectionId) -> Option<&mut Section> {
        self.sections.iter_mut().find(|s| s.id == section_id)
    }

    /// Update a section's metadata
    pub fn update_section(
        &mut self,
        section_id: SectionId,
        updates: &SectionUpdates,
    ) -> Option<&Section> {
        let section = self.get_section_mut(section_id)?;
        section.apply_updates(updates);
        self.touch();
        self.get_section(section_id)
    }

    /// Remove a section by ID
    pub fn remove_section(&mut self, section_id: SectionId) -> Option<Section> {
        let pos = self.sections.iter().position(|s| s.id == section_id)?;
        self.touch();
        Some(self.sections.remove(pos))
    }

    // === Shot operations ===

    /// Add a shot to a section
    pub fn add_shot(&mut self, section_id: SectionId, data: ShotData) -> Option<&Shot> {
        let section = self.get_section_mut(section_id)?;
        let shot = section.add_shot(data);
        let shot_id = shot.id;
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    /// Insert a shot after a specific shot in a section
    pub fn insert_shot_after(
        &mut self,
        section_id: SectionId,
        after_shot_id: ShotId,
        data: ShotData,
    ) -> Option<&Shot> {
        let section = self.get_section_mut(section_id)?;
        let shot = section.insert_shot_after(after_shot_id, data)?;
        let shot_id = shot.id;
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    /// Update a shot
    pub fn update_shot(
        &mut self,
        section_id: SectionId,
        shot_id: ShotId,
        updates: &ShotUpdates,
    ) -> Option<&Shot> {
        let section = self.get_section_mut(section_id)?;
        let shot = section.get_shot_mut(shot_id)?;
        shot.apply_updates(updates);
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    /// Remove a shot
    pub fn remove_shot(&mut self, section_id: SectionId, shot_id: ShotId) -> Option<Shot> {
        let section = self.get_section_mut(section_id)?;
        let shot = section.remove_shot(shot_id)?;
        self.touch();
        Some(shot)
    }

    /// Set a shot as virtual or not
    pub fn set_shot_virtual(
        &mut self,
        section_id: SectionId,
        shot_id: ShotId,
        is_virtual: bool,
    ) -> Option<&Shot> {
        let section = self.get_section_mut(section_id)?;
        let shot = section.get_shot_mut(shot_id)?;
        shot.is_virtual = is_virtual;
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    // === Station operations ===

    /// Get all section IDs connected to the given section through station merges.
    /// Returns a set containing the given section and all transitively connected sections.
    pub fn get_connected_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
        let mut connected = HashSet::new();
        let mut queue = vec![section_id];

        while let Some(current) = queue.pop() {
            if connected.insert(current) {
                for merge in &self.station_merges {
                    if merge.station_a.section_id == current {
                        if !connected.contains(&merge.station_b.section_id) {
                            queue.push(merge.station_b.section_id);
                        }
                    } else if merge.station_b.section_id == current {
                        if !connected.contains(&merge.station_a.section_id) {
                            queue.push(merge.station_a.section_id);
                        }
                    }
                }
            }
        }
        connected
    }

    /// Capture section offsets for all sections connected to the given section.
    /// Returns a HashMap where:
    /// - Key is the section ID
    /// - Value is Option<(f64, f64)>: Some if offset existed, None if key didn't exist
    /// This is used by undo to restore exact previous state.
    pub fn capture_connected_section_offsets(
        &self,
        section_id: SectionId,
    ) -> HashMap<SectionId, Option<(f64, f64)>> {
        let connected_sections = self.get_connected_section_ids(section_id);
        let mut offsets = HashMap::new();
        for sid in connected_sections {
            offsets.insert(sid, self.section_offsets.get(&sid).copied());
        }
        offsets
    }

    /// Check if a section is connected to a zero datum (directly or through merges)
    fn section_has_zero_datum(&self, section_id: SectionId) -> bool {
        let connected = self.get_connected_section_ids(section_id);
        self.zero_datums.iter().any(|zd| connected.contains(&zd.station_ref.section_id))
    }

    /// Compute raw station coordinates for a single station (without global zero datum offset)
    fn compute_station_raw_coords(&self, station_ref: StationRef) -> Option<Coordinates> {
        let section = self.sections.iter().find(|s| s.id == station_ref.section_id)?;

        // Get section offset
        let (offset_x, offset_y) = self.section_offsets.get(&section.id).copied().unwrap_or((0.0, 0.0));
        let mut coords = Coordinates::new(offset_x, offset_y, 0.0);

        // Walk through shots to reach the station
        for i in 0..station_ref.station_index as usize {
            if i >= section.shots.len() {
                return None;
            }
            let shot = &section.shots[i];
            let azimuth_rad = shot.average_azimuth().to_radians();
            let dx = shot.length * azimuth_rad.sin();
            let dy = shot.length * azimuth_rad.cos();
            let dz = shot.depth_out - shot.depth_in;
            coords.x += dx;
            coords.y += dy;
            coords.z += dz;
        }

        Some(coords)
    }

    /// Calculate the path length between two stations through the survey
    /// This finds the shortest path through shots and existing merges
    fn calculate_path_length_between(&self, station_a: StationRef, station_b: StationRef) -> f64 {
        // Use BFS to find path between stations
        use std::collections::VecDeque;

        // Node in our search: (section_id, station_index, accumulated_length)
        let mut queue: VecDeque<(SectionId, u32, f64)> = VecDeque::new();
        let mut visited: HashSet<(SectionId, u32)> = HashSet::new();

        queue.push_back((station_a.section_id, station_a.station_index, 0.0));
        visited.insert((station_a.section_id, station_a.station_index));

        while let Some((section_id, station_index, path_len)) = queue.pop_front() {
            // Check if we reached the destination
            if section_id == station_b.section_id && station_index == station_b.station_index {
                return path_len;
            }

            let section = match self.sections.iter().find(|s| s.id == section_id) {
                Some(s) => s,
                None => continue,
            };

            // Move to previous station in section (if exists)
            if station_index > 0 {
                let prev_index = station_index - 1;
                let key = (section_id, prev_index);
                if !visited.contains(&key) {
                    let shot_len = section.shots.get(prev_index as usize).map(|s| s.length).unwrap_or(0.0);
                    visited.insert(key);
                    queue.push_back((section_id, prev_index, path_len + shot_len));
                }
            }

            // Move to next station in section (if exists)
            if (station_index as usize) < section.shots.len() {
                let next_index = station_index + 1;
                let key = (section_id, next_index);
                if !visited.contains(&key) {
                    let shot_len = section.shots.get(station_index as usize).map(|s| s.length).unwrap_or(0.0);
                    visited.insert(key);
                    queue.push_back((section_id, next_index, path_len + shot_len));
                }
            }

            // Follow merges to other sections
            for merge in &self.station_merges {
                let current_ref = StationRef::new(section_id, station_index);
                if merge.station_a == current_ref {
                    let key = (merge.station_b.section_id, merge.station_b.station_index);
                    if !visited.contains(&key) {
                        visited.insert(key);
                        queue.push_back((merge.station_b.section_id, merge.station_b.station_index, path_len));
                    }
                } else if merge.station_b == current_ref {
                    let key = (merge.station_a.section_id, merge.station_a.station_index);
                    if !visited.contains(&key) {
                        visited.insert(key);
                        queue.push_back((merge.station_a.section_id, merge.station_a.station_index, path_len));
                    }
                }
            }
        }

        // No path found (shouldn't happen if sections are connected)
        // Fall back to sum of all connected section lengths
        let connected = self.get_connected_section_ids(station_a.section_id);
        connected.iter()
            .filter_map(|sid| self.sections.iter().find(|s| s.id == *sid))
            .flat_map(|s| s.shots.iter())
            .map(|shot| shot.length)
            .sum()
    }

    /// Merge two stations
    /// Returns Err if validation fails, Ok(true) on success
    pub fn merge_stations(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        _strategy: ClosureStrategy,
    ) -> Result<bool, String> {
        // Check that both stations exist
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return Err("One or both stations do not exist".to_string());
        }

        // Check not already merged
        if self.are_stations_merged(station_a, station_b) {
            return Err("These stations are already merged".to_string());
        }

        // Check if already connected (same section group) - this creates a loop closure
        let connected_a = self.get_connected_section_ids(station_a.section_id);
        if connected_a.contains(&station_b.section_id) {
            // This merge creates a loop closure - record it but don't move sections
            let coords_a = self.compute_station_raw_coords(station_a)
                .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
            let coords_b = self.compute_station_raw_coords(station_b)
                .ok_or_else(|| "Failed to compute coordinates for station B".to_string())?;

            // Calculate misclosure
            let horizontal_misclosure = coords_a.horizontal_distance_to(&coords_b);
            let vertical_misclosure = (coords_a.z - coords_b.z).abs();
            let misclosure_distance = coords_a.distance_to(&coords_b);

            // Calculate path length (simplified: sum of all shot lengths in connected sections)
            let path_length = self.calculate_path_length_between(station_a, station_b);

            // Calculate error percentage
            let error_percentage = if path_length > 0.0 {
                (misclosure_distance / path_length) * 100.0
            } else {
                0.0
            };

            // Record the loop closure
            self.loop_closures.push(LoopClosure {
                station_a,
                station_b,
                path_length,
                misclosure_distance,
                error_percentage,
                horizontal_misclosure,
                vertical_misclosure,
            });

            // Record the merge (but don't move sections)
            self.station_merges.push(StationMerge {
                station_a,
                station_b,
                merged_at: Utc::now(),
            });

            self.touch();
            return Ok(true);
        }

        // Check zero datum status - uses transitive connections through existing merges
        // This ensures that if B is connected to a datum-holding section C through an
        // earlier merge, b_has_zd will be true and the merge will propagate datum positioning
        let a_has_zd = self.section_has_zero_datum(station_a.section_id);
        let b_has_zd = self.section_has_zero_datum(station_b.section_id);

        if a_has_zd && b_has_zd {
            return Err("Both stations are connected to zero datums. Use Closure instead to handle survey loops.".to_string());
        }

        // Compute current coordinates (includes existing section offsets)
        // Coordinates are in the world coordinate system established by the datum
        let coords_a = self.compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b = self.compute_station_raw_coords(station_b)
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

        // Apply offset to all sections in the moving group
        // This repositions the entire moving group relative to the datum coordinate system
        let moving_sections = self.get_connected_section_ids(moving_section_id);
        for section_id in moving_sections {
            let current_offset = self.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
            self.section_offsets.insert(section_id, (
                current_offset.0 + offset_x,
                current_offset.1 + offset_y,
            ));
        }

        // Record the merge
        self.station_merges.push(StationMerge {
            station_a,
            station_b,
            merged_at: Utc::now(),
        });

        self.touch();
        Ok(true)
    }

    /// Unmerge stations
    pub fn unmerge_stations(&mut self, station_a: StationRef, station_b: StationRef) -> bool {
        let pos = self.station_merges.iter().position(|m| {
            (m.station_a == station_a && m.station_b == station_b)
                || (m.station_a == station_b && m.station_b == station_a)
        });

        if let Some(pos) = pos {
            self.station_merges.remove(pos);
            self.touch();
            true
        } else {
            false
        }
    }

    /// Check if two stations are merged
    pub fn are_stations_merged(&self, a: StationRef, b: StationRef) -> bool {
        self.station_merges.iter().any(|m| {
            (m.station_a == a && m.station_b == b) || (m.station_a == b && m.station_b == a)
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

    /// Get all station refs connected to this station via shots and merges (transitive)
    /// All stations in a section are connected via shots, and merges connect stations across sections
    fn get_connected_stations(&self, station_ref: StationRef) -> HashSet<StationRef> {
        // Reuse get_connected_section_ids for section-level traversal
        let connected_sections = self.get_connected_section_ids(station_ref.section_id);

        // Enumerate all stations in connected sections
        let mut connected = HashSet::new();
        for section_id in connected_sections {
            if let Some(section) = self.sections.iter().find(|s| s.id == section_id) {
                // A section with N shots has N+1 stations (indices 0 to N)
                for i in 0..=section.shots.len() {
                    connected.insert(StationRef {
                        section_id,
                        station_index: i as u32,
                    });
                }
            }
        }

        connected
    }

    /// Check if any connected station already has a zero datum (returns the conflicting ref)
    fn find_connected_zero_datum(&self, station_ref: StationRef) -> Option<StationRef> {
        let connected = self.get_connected_stations(station_ref);
        for zd in &self.zero_datums {
            if connected.contains(&zd.station_ref) && zd.station_ref != station_ref {
                return Some(zd.station_ref);
            }
        }
        None
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
            .map(|name| format!("\"{}\"", name))
            .unwrap_or_else(|| format!("Section {}", station_ref.section_id));

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

        // Check for connected zero datum
        if let Some(existing) = self.find_connected_zero_datum(station_ref) {
            let new_station = self.format_station_ref_for_display(station_ref);
            let existing_station = self.format_station_ref_for_display(existing);
            return Err(format!(
                "Cannot set zero datum: {} is connected to {} which already has a zero datum",
                new_station, existing_station
            ));
        }

        info!(
            "Setting zero datum on station {}:{} with GPS ({}, {})",
            station_ref.section_id, station_ref.station_index, gps.latitude, gps.longitude
        );

        // Get all sections connected through merges
        let connected_sections = self.get_connected_section_ids(station_ref.section_id);
        debug!(
            "Connected sections for datum station: {:?}",
            connected_sections
        );

        // Compute current raw coordinates of the datum station
        let current_coords = self
            .compute_station_raw_coords(station_ref)
            .ok_or_else(|| "Failed to compute station coordinates".to_string())?;
        debug!(
            "Current station raw coords: ({}, {}, {})",
            current_coords.x, current_coords.y, current_coords.z
        );

        // Determine target position based on whether this is the first datum
        // Special case: if updating the first datum station itself, keep it at origin
        let target_x: f64;
        let target_y: f64;

        let is_first_datum_station = self
            .zero_datums
            .first()
            .map(|d| d.station_ref == station_ref)
            .unwrap_or(false);

        if is_first_datum_station {
            // Updating the first datum: keep at origin (0, 0)
            target_x = 0.0;
            target_y = 0.0;
            debug!("Updating first datum: keeping at origin (0, 0)");
        } else if let Some(first_datum) = self.zero_datums.first() {
            // Subsequent datum: compute GPS offset from first datum
            let (east, north) = gps_to_local(&gps, &first_datum.gps);
            target_x = east;
            target_y = north;
            debug!(
                "Subsequent datum: GPS offset from first datum = ({}, {})",
                east, north
            );
        } else {
            // First datum: position at origin (0, 0)
            target_x = 0.0;
            target_y = 0.0;
            debug!("First datum: positioning at origin (0, 0)");
        }

        // Compute the offset needed to move station from current position to target
        let offset_delta_x = target_x - current_coords.x;
        let offset_delta_y = target_y - current_coords.y;
        debug!(
            "Offset delta to apply: ({}, {})",
            offset_delta_x, offset_delta_y
        );

        // Apply offset to all connected sections
        for section_id in &connected_sections {
            let current_offset = self.section_offsets.get(section_id).copied().unwrap_or((0.0, 0.0));
            let new_offset = (
                current_offset.0 + offset_delta_x,
                current_offset.1 + offset_delta_y,
            );
            self.section_offsets.insert(*section_id, new_offset);
            debug!(
                "Section {}: offset {:?} -> {:?}",
                section_id, current_offset, new_offset
            );
        }

        // Store the GPS datum
        // Update in-place if datum exists (preserves order/position for stable center)
        if let Some(existing) = self
            .zero_datums
            .iter_mut()
            .find(|zd| zd.station_ref == station_ref)
        {
            existing.gps = gps;
        } else {
            self.zero_datums.push(ZeroDatum { station_ref, gps });
        }

        self.touch();
        info!(
            "Zero datum set successfully. {} sections repositioned.",
            connected_sections.len()
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

        // Check for connected zero datum (same validation as set_zero_datum)
        if let Some(existing) = self.find_connected_zero_datum(station_ref) {
            let new_station = self.format_station_ref_for_display(station_ref);
            let existing_station = self.format_station_ref_for_display(existing);
            return Err(format!(
                "Cannot store zero datum: {} is connected to {} which already has a zero datum",
                new_station, existing_station
            ));
        }

        debug!(
            "Storing zero datum without repositioning on station {}:{} with GPS ({}, {})",
            station_ref.section_id, station_ref.station_index, gps.latitude, gps.longitude
        );

        // Store the GPS datum without computing or applying offsets
        if let Some(existing) = self
            .zero_datums
            .iter_mut()
            .find(|zd| zd.station_ref == station_ref)
        {
            existing.gps = gps;
        } else {
            self.zero_datums.push(ZeroDatum { station_ref, gps });
        }

        self.touch();
        Ok(true)
    }

    /// Remove zero datum from a station
    pub fn remove_zero_datum(&mut self, station_ref: StationRef) -> bool {
        let len_before = self.zero_datums.len();
        self.zero_datums
            .retain(|zd| zd.station_ref != station_ref);
        if self.zero_datums.len() != len_before {
            self.touch();
            true
        } else {
            false
        }
    }

    /// Get the primary zero datum (first one, or None)
    pub fn primary_zero_datum(&self) -> Option<&ZeroDatum> {
        self.zero_datums.first()
    }

    // === Coordinate computation ===

    /// Compute all station coordinates from shots.
    /// Backward-compat wrapper that calls `compute_station_coordinates_with_progress(None)`.
    pub fn compute_station_coordinates(&self) -> Vec<Station> {
        self.compute_station_coordinates_with_progress(None)
    }

    /// Compute all station coordinates from shots with optional progress callback.
    ///
    /// The callback receives (current, total) station counts for progress reporting.
    /// Total stations = shots + 1 per section (first station).
    pub fn compute_station_coordinates_with_progress(
        &self,
        mut on_progress: Option<&mut dyn FnMut(u32, u32)>,
    ) -> Vec<Station> {
        // Calculate total stations first for progress reporting
        let total_stations: u32 = self.sections
            .iter()
            .map(|s| s.shots.len() as u32 + 1)
            .sum();

        let mut stations: Vec<Station> = Vec::new();
        let mut station_count = 0u32;

        for section in &self.sections {
            // Get section offset (from merges)
            let (offset_x, offset_y) = self.section_offsets.get(&section.id).copied().unwrap_or((0.0, 0.0));
            let mut current_coords = Coordinates::new(offset_x, offset_y, 0.0);

            // First station of section
            let first_station_ref = StationRef::new(section.id, 0);
            stations.push(Station::with_coordinates(first_station_ref, current_coords));
            station_count += 1;

            // Report progress for first station
            if let Some(ref mut cb) = on_progress {
                cb(station_count, total_stations);
            }

            // Compute subsequent stations from shots
            for (i, shot) in section.shots.iter().enumerate() {
                let azimuth_rad = shot.average_azimuth().to_radians();
                let horizontal_length = shot.length;

                // Compute new position
                let dx = horizontal_length * azimuth_rad.sin();
                let dy = horizontal_length * azimuth_rad.cos();
                let dz = shot.depth_out - shot.depth_in;

                current_coords = Coordinates::new(
                    current_coords.x + dx,
                    current_coords.y + dy,
                    current_coords.z + dz,
                );

                let station_ref = StationRef::new(section.id, (i + 1) as u32);
                stations.push(Station::with_coordinates(station_ref, current_coords));
                station_count += 1;

                // Report progress after each station
                if let Some(ref mut cb) = on_progress {
                    cb(station_count, total_stations);
                }
            }
        }

        // NOTE: Global zero datum subtraction removed (fn-19-mmx.2).
        // Positioning is now controlled solely by section_offsets, which are
        // computed when set_zero_datum() is called.

        // Mark merged stations - build merge groups (transitive closure)
        // First, build a map of station_ref -> group_id using Union-Find logic
        let mut station_to_group: std::collections::HashMap<StationRef, usize> = std::collections::HashMap::new();
        let mut groups: Vec<Vec<StationRef>> = Vec::new();

        for merge in &self.station_merges {
            let group_a = station_to_group.get(&merge.station_a).copied();
            let group_b = station_to_group.get(&merge.station_b).copied();

            match (group_a, group_b) {
                (None, None) => {
                    // Neither station is in a group, create a new group
                    let group_id = groups.len();
                    groups.push(vec![merge.station_a, merge.station_b]);
                    station_to_group.insert(merge.station_a, group_id);
                    station_to_group.insert(merge.station_b, group_id);
                }
                (Some(gid), None) => {
                    // station_a is in a group, add station_b to it
                    groups[gid].push(merge.station_b);
                    station_to_group.insert(merge.station_b, gid);
                }
                (None, Some(gid)) => {
                    // station_b is in a group, add station_a to it
                    groups[gid].push(merge.station_a);
                    station_to_group.insert(merge.station_a, gid);
                }
                (Some(gid_a), Some(gid_b)) => {
                    if gid_a != gid_b {
                        // Both are in different groups, merge the groups
                        // Move all from group_b to group_a
                        let group_b_members: Vec<StationRef> = groups[gid_b].drain(..).collect();
                        for member in &group_b_members {
                            station_to_group.insert(*member, gid_a);
                        }
                        groups[gid_a].extend(group_b_members);
                    }
                    // If same group, nothing to do
                }
            }
        }

        // Now assign merged_with for each station based on their group
        for station in &mut stations {
            if let Some(&group_id) = station_to_group.get(&station.station_ref) {
                for member in &groups[group_id] {
                    if *member != station.station_ref {
                        station.merged_with.push(*member);
                    }
                }
            }
        }

        // Mark zero datums
        for zd in &self.zero_datums {
            for station in &mut stations {
                if station.station_ref == zd.station_ref {
                    station.is_zero_datum = true;
                    station.gps_coordinates = Some(zd.gps);
                }
            }
        }

        stations
    }

    /// Calculate project statistics
    pub fn stats(&self) -> ProjectStats {
        let mut shot_count = 0;
        let mut total_length = 0.0;
        let mut min_depth = f64::MAX;
        let mut max_depth = f64::MIN;

        for section in &self.sections {
            let section_stats = section.stats();
            shot_count += section_stats.shot_count;
            total_length += section_stats.total_length;
            min_depth = min_depth.min(section_stats.min_depth);
            max_depth = max_depth.max(section_stats.max_depth);
        }

        if self.sections.is_empty() {
            min_depth = 0.0;
            max_depth = 0.0;
        }

        // Station count = shots + 1 per section (first station)
        let station_count = shot_count + self.sections.len();

        // Loop count = number of detected loop closures
        let loop_count = self.loop_closures.len();

        ProjectStats {
            section_count: self.sections.len(),
            shot_count,
            total_length,
            min_depth,
            max_depth,
            station_count,
            loop_count,
            penetration_distance: 0.0, // Calculated separately with stations
        }
    }

    /// Calculate penetration distance from zero datum to furthest station
    pub fn calculate_penetration(&self, stations: &[Station]) -> f64 {
        // If no zero datums, return 0
        if self.zero_datums.is_empty() {
            return 0.0;
        }

        // Find zero datum station(s)
        let zero_datum_coords: Vec<_> = self
            .zero_datums
            .iter()
            .filter_map(|zd| {
                stations
                    .iter()
                    .find(|s| {
                        s.station_ref.section_id == zd.station_ref.section_id
                            && s.station_ref.station_index == zd.station_ref.station_index
                    })
                    .map(|s| &s.coordinates)
            })
            .collect();

        if zero_datum_coords.is_empty() {
            return 0.0;
        }

        // Calculate max distance from any zero datum to any station
        let mut max_distance = 0.0f64;
        for station in stations {
            for datum_coord in &zero_datum_coords {
                let dx = station.coordinates.x - datum_coord.x;
                let dy = station.coordinates.y - datum_coord.y;
                let dz = station.coordinates.z - datum_coord.z;
                let distance = (dx * dx + dy * dy + dz * dz).sqrt();
                max_distance = max_distance.max(distance);
            }
        }

        max_distance
    }

    /// Get metadata for this project
    pub fn metadata(&self) -> Option<ProjectMetadata> {
        let file_path = self.file_path.clone()?;
        let stats = self.stats();

        // Compute GPS center and bounds from zero datums
        let (gps_center, gps_bounds) = self.compute_gps_info();

        Some(ProjectMetadata {
            name: self.name.clone(),
            location: self.location.clone(),
            file_path,
            modified_at: self.modified_at,
            section_count: stats.section_count,
            total_length: stats.total_length,
            gps_center,
            gps_bounds,
        })
    }

    /// Compute GPS center and bounds from zero datums
    /// Returns (center, bounds) where center is from first valid zero datum
    /// and bounds encompass all valid zero datums.
    /// Returns (None, None) if no valid datums exist.
    fn compute_gps_info(&self) -> (Option<(f64, f64)>, Option<GpsBounds>) {
        // Filter to valid datums only to prevent serialization issues
        let valid_datums: Vec<_> = self
            .zero_datums
            .iter()
            .filter(|zd| zd.gps.is_valid())
            .collect();

        if valid_datums.is_empty() {
            return (None, None);
        }

        // Center from first valid zero datum
        let first_gps = &valid_datums[0].gps;
        let gps_center = Some((first_gps.latitude, first_gps.longitude));

        // Bounds from all valid zero datums with dateline-aware longitude handling
        let mut south = f64::INFINITY;
        let mut north = f64::NEG_INFINITY;

        // Collect all longitudes for dateline-aware calculation
        let mut longitudes: Vec<f64> = Vec::with_capacity(valid_datums.len());

        for zd in &valid_datums {
            south = south.min(zd.gps.latitude);
            north = north.max(zd.gps.latitude);
            longitudes.push(zd.gps.longitude);
        }

        // Calculate longitude bounds with dateline awareness
        // Sort longitudes and find the largest gap - the bounds are on the opposite side
        let (west, east) = Self::compute_longitude_bounds(&longitudes);

        let gps_bounds = Some(GpsBounds {
            north,
            south,
            east,
            west,
        });

        (gps_center, gps_bounds)
    }

    /// Compute longitude bounds with dateline awareness
    /// Returns (west, east) where east < west indicates crossing the dateline
    fn compute_longitude_bounds(longitudes: &[f64]) -> (f64, f64) {
        if longitudes.is_empty() {
            return (0.0, 0.0);
        }
        if longitudes.len() == 1 {
            return (longitudes[0], longitudes[0]);
        }

        // Sort longitudes
        let mut sorted = longitudes.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        // Find the largest gap between consecutive longitudes (including wrap-around)
        let mut max_gap = 0.0f64;
        let mut max_gap_end_idx = 0;

        for i in 0..sorted.len() {
            let next_idx = (i + 1) % sorted.len();
            let gap = if next_idx == 0 {
                // Wrap-around gap from last to first (crossing -180/180)
                (sorted[0] + 360.0) - sorted[sorted.len() - 1]
            } else {
                sorted[next_idx] - sorted[i]
            };

            if gap > max_gap {
                max_gap = gap;
                max_gap_end_idx = next_idx;
            }
        }

        // The bounds are on the opposite side of the largest gap
        // west is at max_gap_end_idx, east is at (max_gap_end_idx - 1 + len) % len
        let west = sorted[max_gap_end_idx];
        let east_idx = (max_gap_end_idx + sorted.len() - 1) % sorted.len();
        let east = sorted[east_idx];

        (west, east)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot(azimuth_in: f64, azimuth_out: f64, length: f64, depth_in: f64, depth_out: f64) -> ShotData {
        ShotData {
            azimuth_in,
            azimuth_out,
            length,
            depth_in,
            depth_out,
            ..Default::default()
        }
    }

    #[test]
    fn get_connected_section_ids_traverses_merges() {
        let mut project = Project::new("Merged".to_string(), None);
        let a = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
        let b = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
        let c = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;

        project.station_merges.push(StationMerge {
            station_a: StationRef::new(a, 0),
            station_b: StationRef::new(b, 0),
            merged_at: Utc::now(),
        });
        project.station_merges.push(StationMerge {
            station_a: StationRef::new(b, 0),
            station_b: StationRef::new(c, 0),
            merged_at: Utc::now(),
        });

        let connected = project.get_connected_section_ids(a);
        assert!(connected.contains(&a));
        assert!(connected.contains(&b));
        assert!(connected.contains(&c));
        assert_eq!(connected.len(), 3);
    }

    #[test]
    fn section_has_zero_datum_with_connected_merges() {
        let mut project = Project::new("Zero".to_string(), None);
        let a = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
        let b = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
        let c = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
        let d = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;

        project.station_merges.push(StationMerge {
            station_a: StationRef::new(a, 0),
            station_b: StationRef::new(b, 0),
            merged_at: Utc::now(),
        });
        project.station_merges.push(StationMerge {
            station_a: StationRef::new(b, 0),
            station_b: StationRef::new(c, 0),
            merged_at: Utc::now(),
        });

        project.zero_datums.push(ZeroDatum {
            station_ref: StationRef::new(c, 0),
            gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
        });

        assert!(project.section_has_zero_datum(a));
        assert!(!project.section_has_zero_datum(d));
    }

    #[test]
    fn compute_station_raw_coords_applies_offsets_and_bounds() {
        let mut project = Project::new("Coords".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![
                    shot(0.0, 0.0, 10.0, 0.0, 0.0),
                    shot(90.0, 90.0, 5.0, 0.0, 2.0),
                ],
                ..Default::default()
            })
            .id;

        project.section_offsets.insert(section_id, (2.0, -3.0));

        let coords = project
            .compute_station_raw_coords(StationRef::new(section_id, 2))
            .expect("coords");
        assert!((coords.x - 7.0).abs() < 1e-6);
        assert!((coords.y - 7.0).abs() < 1e-6);
        assert!((coords.z - 2.0).abs() < 1e-6);

        let invalid = project.compute_station_raw_coords(StationRef::new(section_id, 5));
        assert!(invalid.is_none());
    }

    #[test]
    fn set_zero_datum_first_datum_positions_station_at_origin() {
        let mut project = Project::new("FirstDatum".to_string(), None);
        // Create a section with a shot going north (azimuth 0)
        let section_id = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 1.0)],
                ..Default::default()
            })
            .id;

        // Station 1 is at (0, 10, 1) before datum is set
        let station_ref = StationRef::new(section_id, 1);
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();

        // Set first datum on station 1
        project.set_zero_datum(station_ref, gps).unwrap();

        // Check that offset was applied to move station to origin
        let offset = project.section_offsets.get(&section_id).unwrap();
        // Station was at (0, 10), needs offset (-0, -10) to be at origin
        assert!((offset.0 - 0.0).abs() < 1e-6, "Expected x offset ~0, got {}", offset.0);
        assert!((offset.1 - (-10.0)).abs() < 1e-6, "Expected y offset ~-10, got {}", offset.1);

        // Verify station coordinates after applying offset
        let coords = project.compute_station_raw_coords(station_ref).unwrap();
        assert!((coords.x).abs() < 1e-6, "Expected x ~0, got {}", coords.x);
        assert!((coords.y).abs() < 1e-6, "Expected y ~0, got {}", coords.y);
        // Z should be preserved
        assert!((coords.z - 1.0).abs() < 1e-6, "Expected z ~1, got {}", coords.z);
    }

    #[test]
    fn set_zero_datum_connected_sections_move_together() {
        let mut project = Project::new("Connected".to_string(), None);
        // Create two sections
        let a = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;
        let b = project
            .add_section(SectionData {
                shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Merge section b's station 0 to section a's station 1
        project.station_merges.push(StationMerge {
            station_a: StationRef::new(a, 1),
            station_b: StationRef::new(b, 0),
            merged_at: Utc::now(),
        });

        // Record positions before setting datum
        // Section a station 1 is at (0, 10) before datum (shot goes north)
        // Section b station 0 is at (0, 0) before datum (no offset yet)
        // Section b station 1 is at (5, 0) before datum (shot goes east)
        let coords_b1_before = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
        assert!((coords_b1_before.x - 5.0).abs() < 1e-6, "Pre-datum b.1 x should be 5");
        assert!((coords_b1_before.y - 0.0).abs() < 1e-6, "Pre-datum b.1 y should be 0");

        // Set datum on section a, station 1 (which is at y=10 before datum)
        // This should move all connected sections so a.1 lands at origin
        let station_ref = StationRef::new(a, 1);
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(station_ref, gps).unwrap();

        // Both sections should have offsets applied
        assert!(project.section_offsets.contains_key(&a));
        assert!(project.section_offsets.contains_key(&b));

        // Section a station 1 (datum station) should be at origin
        let coords_a1 = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
        assert!((coords_a1.x).abs() < 1e-6, "Datum station x should be 0, got {}", coords_a1.x);
        assert!((coords_a1.y).abs() < 1e-6, "Datum station y should be 0, got {}", coords_a1.y);

        // Section a station 0 should be at (0, -10) since it's 10m south of the datum
        let coords_a0 = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
        assert!((coords_a0.x).abs() < 1e-6, "a.0 x should be 0, got {}", coords_a0.x);
        assert!((coords_a0.y - (-10.0)).abs() < 1e-6, "a.0 y should be -10, got {}", coords_a0.y);

        // Section b should have moved by the same delta as section a
        // Before: b.1 was at (5, 0). After: b.1 should be at (5, -10)
        // (The offset delta was (0, -10) to move a.1 from (0, 10) to (0, 0))
        let coords_b1_after = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
        assert!(
            (coords_b1_after.x - 5.0).abs() < 1e-6,
            "b.1 x should be 5, got {}",
            coords_b1_after.x
        );
        assert!(
            (coords_b1_after.y - (-10.0)).abs() < 1e-6,
            "b.1 y should be -10 (moved with connected sections), got {}",
            coords_b1_after.y
        );
    }

    #[test]
    fn set_zero_datum_subsequent_datum_uses_gps_offset() {
        let mut project = Project::new("SubsequentDatum".to_string(), None);
        // Create two unconnected sections
        let a = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;
        let b = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Set first datum on section a, station 0
        let gps_a = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(a, 0), gps_a).unwrap();

        // Section a station 0 should be at origin
        let coords_a0 = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
        assert!((coords_a0.x).abs() < 1e-6);
        assert!((coords_a0.y).abs() < 1e-6);

        // Set second datum on section b with GPS offset
        // At equator, 0.01 degree longitude ~ 1113 meters east
        let gps_b = GpsCoordinates::new(0.0, 0.01, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(b, 0), gps_b).unwrap();

        // Section b station 0 should be at approximately (1113, 0)
        let coords_b0 = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
        assert!(
            (coords_b0.x - 1113.2).abs() < 10.0,
            "Expected x ~1113, got {}",
            coords_b0.x
        );
        assert!(coords_b0.y.abs() < 10.0, "Expected y ~0, got {}", coords_b0.y);
    }

    #[test]
    fn set_zero_datum_z_coordinates_preserved() {
        let mut project = Project::new("PreserveZ".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![
                    shot(0.0, 0.0, 10.0, 0.0, 5.0),
                    shot(0.0, 0.0, 10.0, 5.0, 12.0),
                ],
                ..Default::default()
            })
            .id;

        // Set datum on station 1 (which has z=5)
        let station_ref = StationRef::new(section_id, 1);
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(station_ref, gps).unwrap();

        // Check all stations have preserved z coordinates
        let coords_0 = project.compute_station_raw_coords(StationRef::new(section_id, 0)).unwrap();
        let coords_1 = project.compute_station_raw_coords(StationRef::new(section_id, 1)).unwrap();
        let coords_2 = project.compute_station_raw_coords(StationRef::new(section_id, 2)).unwrap();

        assert!((coords_0.z - 0.0).abs() < 1e-6, "Station 0 z should be 0");
        assert!((coords_1.z - 5.0).abs() < 1e-6, "Station 1 z should be 5");
        assert!((coords_2.z - 12.0).abs() < 1e-6, "Station 2 z should be 12");
    }

    #[test]
    fn remove_zero_datum_keeps_positions_unchanged() {
        let mut project = Project::new("RemoveDatum".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Set datum
        let station_ref = StationRef::new(section_id, 1);
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(station_ref, gps).unwrap();

        // Record offset after setting datum
        let offset_before = project.section_offsets.get(&section_id).copied();

        // Remove datum
        project.remove_zero_datum(station_ref);

        // Offset should be unchanged
        let offset_after = project.section_offsets.get(&section_id).copied();
        assert_eq!(offset_before, offset_after, "Offset should not change when removing datum");
    }

    #[test]
    fn update_first_datum_gps_keeps_station_at_origin() {
        // Issue: Re-setting the first datum should not move it away from origin
        let mut project = Project::new("UpdateFirstDatum".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Set first datum on station 1 (which is at y=10 before datum)
        let station_ref = StationRef::new(section_id, 1);
        let gps1 = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(station_ref, gps1).unwrap();

        // Station 1 should be at origin
        let coords_after_first = project.compute_station_raw_coords(station_ref).unwrap();
        assert!((coords_after_first.x).abs() < 1e-6, "First datum: x should be 0");
        assert!((coords_after_first.y).abs() < 1e-6, "First datum: y should be 0");
        let offset_after_first = project.section_offsets.get(&section_id).copied().unwrap();

        // Update the first datum with different GPS coordinates
        let gps2 = GpsCoordinates::new(46.0, -91.0, 0.0).unwrap();
        project.set_zero_datum(station_ref, gps2).unwrap();

        // Station 1 should STILL be at origin (updating first datum doesn't reposition)
        let coords_after_update = project.compute_station_raw_coords(station_ref).unwrap();
        assert!(
            (coords_after_update.x).abs() < 1e-6,
            "After update: x should still be 0, got {}",
            coords_after_update.x
        );
        assert!(
            (coords_after_update.y).abs() < 1e-6,
            "After update: y should still be 0, got {}",
            coords_after_update.y
        );

        // Offset should be unchanged (no repositioning happened)
        let offset_after_update = project.section_offsets.get(&section_id).copied().unwrap();
        assert_eq!(
            offset_after_first, offset_after_update,
            "Offset should not change when updating first datum GPS"
        );

        // GPS should be updated
        assert_eq!(project.zero_datums[0].gps.latitude, 46.0);
        assert_eq!(project.zero_datums[0].gps.longitude, -91.0);
    }

    #[test]
    fn store_zero_datum_without_repositioning_does_not_modify_offsets() {
        let mut project = Project::new("StoreOnly".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Pre-set an offset manually (simulating merged project scenario)
        project.section_offsets.insert(section_id, (100.0, 200.0));

        // Store datum without repositioning
        let station_ref = StationRef::new(section_id, 0);
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.store_zero_datum_without_repositioning(station_ref, gps).unwrap();

        // Offset should remain unchanged
        let offset = project.section_offsets.get(&section_id).unwrap();
        assert_eq!(*offset, (100.0, 200.0), "Offset should not be modified");

        // But datum should be stored
        assert_eq!(project.zero_datums.len(), 1);
        assert_eq!(project.zero_datums[0].station_ref, station_ref);
    }

    #[test]
    fn coordinate_computation_no_global_datum_subtraction() {
        // Verify that compute_station_coordinates no longer subtracts primary datum
        let mut project = Project::new("NoGlobalSubtract".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Add a datum directly to zero_datums (bypassing set_zero_datum to avoid offset computation)
        project.zero_datums.push(ZeroDatum {
            station_ref: StationRef::new(section_id, 1),
            gps: GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
        });

        // Compute coordinates
        let stations = project.compute_station_coordinates();

        // Station 0 should be at (0, 0) - no global subtraction
        let station_0 = stations.iter().find(|s| s.station_ref == StationRef::new(section_id, 0)).unwrap();
        assert!((station_0.coordinates.x).abs() < 1e-6);
        assert!((station_0.coordinates.y).abs() < 1e-6);

        // Station 1 should be at (0, 10) - no global subtraction
        let station_1 = stations.iter().find(|s| s.station_ref == StationRef::new(section_id, 1)).unwrap();
        assert!((station_1.coordinates.x).abs() < 1e-6);
        assert!((station_1.coordinates.y - 10.0).abs() < 1e-6);
    }

    #[test]
    fn merge_stations_propagates_datum_positioning_a_into_b() {
        // Test: Section without datum merges into section group with datum
        // The merged section should be repositioned relative to the datum
        let mut project = Project::new("MergeDatumA".to_string(), None);

        // Section A: has datum, shot goes north 10m
        let a = project.add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Set datum on A.0 (positions A.0 at origin)
        project.set_zero_datum(
            StationRef::new(a, 0),
            GpsCoordinates::new(45.0, -90.0, 0.0).unwrap()
        ).unwrap();

        // Verify A is positioned correctly before merge
        let a0_coords = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
        assert!((a0_coords.x).abs() < 1e-6, "A.0 x should be 0");
        assert!((a0_coords.y).abs() < 1e-6, "A.0 y should be 0");
        let a1_coords = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
        assert!((a1_coords.y - 10.0).abs() < 1e-6, "A.1 y should be 10");

        // Section B: no datum, shot goes east 5m
        let b = project.add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Merge B.0 into A.1 (B merges into datum group)
        project.merge_stations(
            StationRef::new(a, 1),
            StationRef::new(b, 0),
            ClosureStrategy::KeepRaw
        ).unwrap();

        // After merge, B should be positioned in datum coordinate system
        // B.0 should be at A.1's position (0, 10)
        let b0_coords = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
        assert!((b0_coords.x).abs() < 1e-6, "B.0 x should be 0, got {}", b0_coords.x);
        assert!((b0_coords.y - 10.0).abs() < 1e-6, "B.0 y should be 10, got {}", b0_coords.y);

        // B.1 should be at (5, 10) - 5m east of B.0
        let b1_coords = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
        assert!((b1_coords.x - 5.0).abs() < 1e-6, "B.1 x should be 5, got {}", b1_coords.x);
        assert!((b1_coords.y - 10.0).abs() < 1e-6, "B.1 y should be 10, got {}", b1_coords.y);

        // A's positions should be unchanged
        let a0_after = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
        assert!((a0_after.x).abs() < 1e-6, "A.0 x should still be 0");
        assert!((a0_after.y).abs() < 1e-6, "A.0 y should still be 0");
    }

    #[test]
    fn merge_stations_propagates_datum_positioning_b_into_a() {
        // Test: Section with datum merges with section without datum
        // The non-datum section should be repositioned
        let mut project = Project::new("MergeDatumB".to_string(), None);

        // Section A: no datum, shot goes north 10m
        let a = project.add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Section B: has datum, shot goes east 5m
        let b = project.add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Set datum on B.0 (positions B.0 at origin)
        project.set_zero_datum(
            StationRef::new(b, 0),
            GpsCoordinates::new(45.0, -90.0, 0.0).unwrap()
        ).unwrap();

        // Verify B is positioned correctly before merge
        let b0_coords = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
        assert!((b0_coords.x).abs() < 1e-6, "B.0 x should be 0");
        assert!((b0_coords.y).abs() < 1e-6, "B.0 y should be 0");

        // Merge A.0 into B.1 (A merges into datum group)
        // B.1 is at (5, 0)
        project.merge_stations(
            StationRef::new(a, 0),
            StationRef::new(b, 1),
            ClosureStrategy::KeepRaw
        ).unwrap();

        // After merge, A should be positioned in datum coordinate system
        // A.0 should be at B.1's position (5, 0)
        let a0_coords = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
        assert!((a0_coords.x - 5.0).abs() < 1e-6, "A.0 x should be 5, got {}", a0_coords.x);
        assert!((a0_coords.y).abs() < 1e-6, "A.0 y should be 0, got {}", a0_coords.y);

        // A.1 should be at (5, 10) - 10m north of A.0
        let a1_coords = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
        assert!((a1_coords.x - 5.0).abs() < 1e-6, "A.1 x should be 5, got {}", a1_coords.x);
        assert!((a1_coords.y - 10.0).abs() < 1e-6, "A.1 y should be 10, got {}", a1_coords.y);

        // B's positions should be unchanged
        let b0_after = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
        assert!((b0_after.x).abs() < 1e-6, "B.0 x should still be 0");
        assert!((b0_after.y).abs() < 1e-6, "B.0 y should still be 0");
    }

    #[test]
    fn merge_stations_transitive_datum_propagation() {
        // Test: Merge into a section that's connected to a datum group through another merge
        // C merges into B, which is already merged with datum-holding A
        let mut project = Project::new("TransitiveDatum".to_string(), None);

        // Section A: has datum, shot goes north 10m
        let a = project.add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Set datum on A.0
        project.set_zero_datum(
            StationRef::new(a, 0),
            GpsCoordinates::new(45.0, -90.0, 0.0).unwrap()
        ).unwrap();

        // Section B: shot goes east 5m (will be connected to A)
        let b = project.add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Merge B.0 into A.1 - B now connected to datum group
        project.merge_stations(
            StationRef::new(a, 1),
            StationRef::new(b, 0),
            ClosureStrategy::KeepRaw
        ).unwrap();

        // Section C: shot goes south 3m
        let c = project.add_section(SectionData {
            shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Verify B.1 position before merging C
        // B.1 should be at (5, 10) - B.0 at (0, 10), B.1 5m east
        let b1_before = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
        assert!((b1_before.x - 5.0).abs() < 1e-6, "B.1 x should be 5");
        assert!((b1_before.y - 10.0).abs() < 1e-6, "B.1 y should be 10");

        // Merge C.0 into B.1 - C should be positioned via transitive datum
        project.merge_stations(
            StationRef::new(b, 1),
            StationRef::new(c, 0),
            ClosureStrategy::KeepRaw
        ).unwrap();

        // C.0 should be at B.1's position (5, 10)
        let c0_coords = project.compute_station_raw_coords(StationRef::new(c, 0)).unwrap();
        assert!((c0_coords.x - 5.0).abs() < 1e-6, "C.0 x should be 5, got {}", c0_coords.x);
        assert!((c0_coords.y - 10.0).abs() < 1e-6, "C.0 y should be 10, got {}", c0_coords.y);

        // C.1 should be at (5, 7) - 3m south of C.0
        let c1_coords = project.compute_station_raw_coords(StationRef::new(c, 1)).unwrap();
        assert!((c1_coords.x - 5.0).abs() < 1e-6, "C.1 x should be 5, got {}", c1_coords.x);
        assert!((c1_coords.y - 7.0).abs() < 1e-6, "C.1 y should be 7, got {}", c1_coords.y);
    }

    // === Duplicate datum validation tests ===

    #[test]
    fn set_zero_datum_rejects_duplicate_in_same_section() {
        // Cannot set two datums on different stations in the same section
        let mut project = Project::new("DuplicateSameSection".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![
                    shot(0.0, 0.0, 10.0, 0.0, 0.0),
                    shot(0.0, 0.0, 10.0, 0.0, 0.0),
                ],
                ..Default::default()
            })
            .id;

        // Set first datum on station 0
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

        // Attempt to set second datum on station 1 (same section) - should fail
        let result = project.set_zero_datum(StationRef::new(section_id, 1), gps);
        assert!(result.is_err(), "Should reject duplicate datum in same section");
        let err = result.unwrap_err();
        assert!(err.contains("already has a zero datum"), "Error should mention existing datum: {}", err);
    }

    #[test]
    fn set_zero_datum_rejects_duplicate_in_connected_group() {
        // Cannot set datum on a station connected through merges to another datum station
        let mut project = Project::new("DuplicateConnected".to_string(), None);

        // Create two sections
        let a = project.add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        }).id;
        let b = project.add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Merge B.0 to A.1
        project.station_merges.push(StationMerge {
            station_a: StationRef::new(a, 1),
            station_b: StationRef::new(b, 0),
            merged_at: Utc::now(),
        });

        // Set first datum on section A
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(a, 0), gps).unwrap();

        // Attempt to set second datum on section B (connected through merge) - should fail
        let result = project.set_zero_datum(StationRef::new(b, 1), gps);
        assert!(result.is_err(), "Should reject duplicate datum in connected group");
        let err = result.unwrap_err();
        assert!(err.contains("already has a zero datum"), "Error should mention existing datum: {}", err);
    }

    #[test]
    fn set_zero_datum_allows_disconnected_groups() {
        // Disconnected section groups can each have their own datum
        let mut project = Project::new("DisconnectedGroups".to_string(), None);

        // Create two unconnected sections
        let a = project.add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        }).id;
        let b = project.add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        }).id;

        // Set datum on section A
        let gps_a = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(a, 0), gps_a).unwrap();

        // Set datum on section B (disconnected) - should succeed
        let gps_b = GpsCoordinates::new(46.0, -91.0, 0.0).unwrap();
        let result = project.set_zero_datum(StationRef::new(b, 0), gps_b);
        assert!(result.is_ok(), "Disconnected groups should each allow their own datum");
        assert_eq!(project.zero_datums.len(), 2);
    }

    #[test]
    fn set_zero_datum_error_includes_section_name() {
        // Error message should include section name if available
        let mut project = Project::new("NamedSection".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                name: Some("Main Passage".to_string()),
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Set first datum
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

        // Attempt duplicate
        let result = project.set_zero_datum(StationRef::new(section_id, 1), gps);
        let err = result.unwrap_err();

        // Error should include section name
        assert!(err.contains("Main Passage"), "Error should include section name: {}", err);
    }

    #[test]
    fn set_zero_datum_error_includes_station_number() {
        // Error message should include station numbers (0-indexed to match canonical IDs)
        let mut project = Project::new("StationNumbers".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![
                    shot(0.0, 0.0, 10.0, 0.0, 0.0),
                    shot(0.0, 0.0, 10.0, 0.0, 0.0),
                ],
                ..Default::default()
            })
            .id;

        // Set first datum on station 0
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

        // Attempt to set on station 2
        let result = project.set_zero_datum(StationRef::new(section_id, 2), gps);
        let err = result.unwrap_err();

        // Error should reference stations with 0-indexed format (e.g., "Section 0 #2")
        assert!(err.contains("#2"), "New station should include #2: {}", err);
        assert!(err.contains("#0"), "Existing datum station should include #0: {}", err);
    }

    #[test]
    fn set_zero_datum_validation_runs_before_state_changes() {
        // Validation should reject before any section offsets are modified
        let mut project = Project::new("NoStateChange".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Set first datum
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

        // Record state before failed attempt
        let offset_before = project.section_offsets.get(&section_id).copied();
        let datums_count_before = project.zero_datums.len();

        // Attempt duplicate (should fail)
        let result = project.set_zero_datum(StationRef::new(section_id, 1), gps);
        assert!(result.is_err());

        // State should be unchanged
        let offset_after = project.section_offsets.get(&section_id).copied();
        assert_eq!(offset_before, offset_after, "Section offset should not change on validation failure");
        assert_eq!(datums_count_before, project.zero_datums.len(), "Zero datums count should not change");
    }

    #[test]
    fn set_zero_datum_allows_resetting_same_station() {
        // Re-setting datum on the same station (updating GPS) should succeed
        let mut project = Project::new("ResetSame".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Set datum
        let gps1 = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 0), gps1).unwrap();

        // Re-set on same station with different GPS - should succeed
        let gps2 = GpsCoordinates::new(46.0, -91.0, 0.0).unwrap();
        let result = project.set_zero_datum(StationRef::new(section_id, 0), gps2);
        assert!(result.is_ok(), "Resetting same station should succeed");

        // Should still have only one datum
        assert_eq!(project.zero_datums.len(), 1);
        assert_eq!(project.zero_datums[0].gps.latitude, 46.0);
    }

    #[test]
    fn store_zero_datum_without_repositioning_validates_duplicate() {
        // The store-only helper should also validate for duplicates
        let mut project = Project::new("StoreOnlyValidation".to_string(), None);
        let section_id = project
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;

        // Set first datum normally
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

        // Attempt store-only on different station - should fail
        let result = project.store_zero_datum_without_repositioning(StationRef::new(section_id, 1), gps);
        assert!(result.is_err(), "Store-only should also validate for duplicates");
    }

    #[test]
    fn find_connected_zero_datum_uses_station_connectivity() {
        // Validation should use station-level connectivity (through shots within section)
        // not just section-level connectivity
        let mut project = Project::new("StationConnectivity".to_string(), None);

        // Single section with multiple stations - all connected through shots
        let section_id = project
            .add_section(SectionData {
                shots: vec![
                    shot(0.0, 0.0, 10.0, 0.0, 0.0),
                    shot(0.0, 0.0, 10.0, 0.0, 0.0),
                    shot(0.0, 0.0, 10.0, 0.0, 0.0),
                ],
                ..Default::default()
            })
            .id;

        // Set datum on station 1 (middle)
        let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 1), gps).unwrap();

        // Station 0 is connected to station 1 through shot 0
        let result_0 = project.set_zero_datum(StationRef::new(section_id, 0), gps);
        assert!(result_0.is_err(), "Station 0 should be connected to datum at station 1");

        // Station 3 is connected to station 1 through shots 1 and 2
        let result_3 = project.set_zero_datum(StationRef::new(section_id, 3), gps);
        assert!(result_3.is_err(), "Station 3 should be connected to datum at station 1");
    }
}

impl Default for Project {
    fn default() -> Self {
        Self::new("Untitled".to_string(), None)
    }
}
