use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::{
    ClosureStrategy, Coordinates, GpsCoordinates, LoopClosure, Section, SectionData, SectionId,
    SectionUpdates, Shot, ShotData, ShotId, ShotUpdates, Station, StationMerge, StationRef,
    ZeroDatum,
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

    /// Helper to get sections connected to a station through merges
    fn get_connected_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
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

        // Check zero datum status
        let a_has_zd = self.section_has_zero_datum(station_a.section_id);
        let b_has_zd = self.section_has_zero_datum(station_b.section_id);

        if a_has_zd && b_has_zd {
            return Err("Both stations are connected to zero datums. Use Closure instead to handle survey loops.".to_string());
        }

        // Compute current coordinates
        let coords_a = self.compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b = self.compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute coordinates for station B".to_string())?;

        // Determine which section group needs to move:
        // - If A has zero datum, B's group moves
        // - If B has zero datum, A's group moves
        // - If neither has zero datum, A's group moves to align with B
        let (anchor_coords, moving_coords, moving_section_id) = if a_has_zd {
            (coords_a, coords_b, station_b.section_id)
        } else {
            // B has zero datum OR neither has one (in which case B is the anchor)
            (coords_b, coords_a, station_a.section_id)
        };

        // Calculate offset to align moving station with anchor
        let offset_x = anchor_coords.x - moving_coords.x;
        let offset_y = anchor_coords.y - moving_coords.y;

        // Apply offset to all sections in the moving group
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
        let mut connected = HashSet::new();
        let mut sections_to_process: HashSet<SectionId> = HashSet::new();
        let mut processed_sections: HashSet<SectionId> = HashSet::new();

        // Start with the section containing this station
        sections_to_process.insert(station_ref.section_id);

        while !sections_to_process.is_empty() {
            // Get a section to process
            let section_id = *sections_to_process.iter().next().unwrap();
            sections_to_process.remove(&section_id);

            if processed_sections.contains(&section_id) {
                continue;
            }
            processed_sections.insert(section_id);

            // Add all stations in this section (they're all connected via shots)
            if let Some(section) = self.sections.iter().find(|s| s.id == section_id) {
                // A section with N shots has N+1 stations (indices 0 to N)
                for i in 0..=section.shots.len() {
                    connected.insert(StationRef {
                        section_id,
                        station_index: i as u32,
                    });
                }
            }

            // Find all sections connected via merges to any station in this section
            for merge in &self.station_merges {
                if merge.station_a.section_id == section_id {
                    if !processed_sections.contains(&merge.station_b.section_id) {
                        sections_to_process.insert(merge.station_b.section_id);
                    }
                } else if merge.station_b.section_id == section_id {
                    if !processed_sections.contains(&merge.station_a.section_id) {
                        sections_to_process.insert(merge.station_a.section_id);
                    }
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

    /// Set a station as the zero datum
    /// Returns Err if the station doesn't exist or if a connected station already has a zero datum
    pub fn set_zero_datum(&mut self, station_ref: StationRef, gps: GpsCoordinates) -> Result<bool, String> {
        if !self.station_exists(station_ref) {
            return Err("Station does not exist".to_string());
        }

        // Check for connected zero datum
        if let Some(existing) = self.find_connected_zero_datum(station_ref) {
            return Err(format!(
                "Cannot set zero datum: station {}.{} is connected to station {}.{} which already has a zero datum",
                station_ref.section_id, station_ref.station_index,
                existing.section_id, existing.station_index
            ));
        }

        // Remove any existing zero datum for this station
        self.zero_datums
            .retain(|zd| zd.station_ref != station_ref);

        self.zero_datums.push(ZeroDatum { station_ref, gps });
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

    /// Compute all station coordinates from shots
    pub fn compute_station_coordinates(&self) -> Vec<Station> {
        let mut stations: Vec<Station> = Vec::new();

        for section in &self.sections {
            // Get section offset (from merges)
            let (offset_x, offset_y) = self.section_offsets.get(&section.id).copied().unwrap_or((0.0, 0.0));
            let mut current_coords = Coordinates::new(offset_x, offset_y, 0.0);

            // First station of section
            let first_station_ref = StationRef::new(section.id, 0);
            stations.push(Station::with_coordinates(first_station_ref, current_coords));

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
            }
        }

        // Apply zero datums as offsets
        if let Some(zd) = self.primary_zero_datum() {
            if let Some(datum_station) = stations.iter().find(|s| s.station_ref == zd.station_ref) {
                let offset = datum_station.coordinates;
                for station in &mut stations {
                    station.coordinates.x -= offset.x;
                    station.coordinates.y -= offset.y;
                    // Keep relative depth, but could also use GPS depth reference
                }
            }
        }

        // Mark merged stations
        for merge in &self.station_merges {
            for station in &mut stations {
                if station.station_ref == merge.station_a {
                    station.merged_with.push(merge.station_b);
                } else if station.station_ref == merge.station_b {
                    station.merged_with.push(merge.station_a);
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

        Some(ProjectMetadata {
            name: self.name.clone(),
            location: self.location.clone(),
            file_path,
            modified_at: self.modified_at,
            section_count: stats.section_count,
            total_length: stats.total_length,
        })
    }
}

impl Default for Project {
    fn default() -> Self {
        Self::new("Untitled".to_string(), None)
    }
}
