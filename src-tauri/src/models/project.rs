use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tracing::{debug, info};

use super::{
    gps_to_local, ClosurePreview, ClosureRef, ClosureStrategy, Coordinates, GpsBounds,
    GpsCoordinates, LoopClosure, Section, SectionData, SectionId, SectionUpdates, Shot, ShotData,
    ShotId, ShotUpdates, Station, StationMerge, StationRef, ZeroDatum,
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
    /// Station offsets (x, y, z) applied when individual stations are moved
    #[serde(default, serialize_with = "serialize_station_offsets", deserialize_with = "deserialize_station_offsets")]
    pub station_offsets: HashMap<StationRef, (f64, f64, f64)>,
    /// SHA256 hashes of imported DMP files (for duplicate detection)
    #[serde(default)]
    pub imported_file_hashes: Vec<String>,
    /// Monotonic counter for closure IDs. Never reused, even after deletions.
    #[serde(default)]
    pub next_closure_id: u64,
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
    /// Number of stations in the project (shots + 1 per section)
    pub station_count: usize,
    /// GPS center from first zero datum (lng, lat) - MapLibre order
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

/// Serialize station_offsets as a Vec of (StationRef, (f64, f64, f64)) tuples
/// to avoid serde_json's requirement that map keys be strings.
fn serialize_station_offsets<S: serde::Serializer>(
    map: &HashMap<StationRef, (f64, f64, f64)>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let entries: Vec<(&StationRef, &(f64, f64, f64))> = map.iter().collect();
    entries.serialize(serializer)
}

/// Deserialize station_offsets from a Vec of (StationRef, (f64, f64, f64)) tuples.
fn deserialize_station_offsets<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<StationRef, (f64, f64, f64)>, D::Error> {
    let entries: Vec<(StationRef, (f64, f64, f64))> = Vec::deserialize(deserializer)?;
    Ok(entries.into_iter().collect())
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
            station_offsets: HashMap::new(),
            imported_file_hashes: Vec::new(),
            next_closure_id: 1,
        }
    }

    /// Assign sequential IDs to any loop closures that have id=0 (legacy projects).
    /// Updates `next_closure_id` to be greater than all existing IDs.
    pub fn assign_closure_ids(&mut self) {
        // First, ensure next_closure_id is at least max(existing) + 1
        let max_id = self.loop_closures.iter().map(|lc| lc.id).max().unwrap_or(0);
        if self.next_closure_id <= max_id {
            self.next_closure_id = max_id + 1;
        }
        // Assign IDs to any closures with id=0
        for lc in &mut self.loop_closures {
            if lc.id == 0 {
                lc.id = self.next_closure_id;
                self.next_closure_id += 1;
            }
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

    /// Get all section IDs connected to the given section through station merges only.
    /// Returns a set containing the given section and all transitively merged sections.
    /// Use this for rigid-group operations: datum propagation, offset application, merge validation.
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

    /// Get all section IDs reachable from the given section through merges and closures.
    /// Returns a set containing the given section and all transitively reachable sections.
    /// Use this for graph reachability: connectivity checks, navigation, UI display.
    pub fn get_reachable_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
        let mut connected = HashSet::new();
        let mut queue = vec![section_id];

        while let Some(current) = queue.pop() {
            if connected.insert(current) {
                // Follow merges as edges
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
                // Follow closures as edges (bidirectional, same as merges)
                for closure in &self.loop_closures {
                    if closure.station_a.section_id == current {
                        if !connected.contains(&closure.station_b.section_id) {
                            queue.push(closure.station_b.section_id);
                        }
                    } else if closure.station_b.section_id == current {
                        if !connected.contains(&closure.station_a.section_id) {
                            queue.push(closure.station_a.section_id);
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
    pub(crate) fn compute_station_raw_coords(&self, station_ref: StationRef) -> Option<Coordinates> {
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

        // Apply station offset if exists (individual station move)
        if let Some(&(ox, oy, oz)) = self.station_offsets.get(&station_ref) {
            coords.x += ox;
            coords.y += oy;
            coords.z += oz;
        }

        Some(coords)
    }

    /// Calculate the survey traverse path length between two stations through shots and merges only.
    /// Merges are zero-distance edges. Closures are NOT followed (they are not rigid connections).
    /// Use this for closure metrics computation where "survey path length" means shots + merges.
    pub(crate) fn calculate_path_length_between(&self, station_a: StationRef, station_b: StationRef) -> f64 {
        self.calculate_path_length_impl(station_a, station_b, false)
    }

    /// Calculate the path length between two stations through shots, merges, and closures.
    /// Both merges and closures are zero-distance edges.
    /// Use this for graph navigation where closures are valid traversal paths.
    pub(crate) fn calculate_path_length_between_including_closures(&self, station_a: StationRef, station_b: StationRef) -> f64 {
        self.calculate_path_length_impl(station_a, station_b, true)
    }

    /// Internal BFS path length implementation.
    /// When `include_closures` is true, loop closures are treated as zero-distance edges.
    fn calculate_path_length_impl(&self, station_a: StationRef, station_b: StationRef, include_closures: bool) -> f64 {
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

            // Follow merges to other sections (zero distance)
            let current_ref = StationRef::new(section_id, station_index);
            for merge in &self.station_merges {
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

            // Follow closures to other sections (zero distance, same as merges)
            if include_closures {
                for closure in &self.loop_closures {
                    if closure.station_a == current_ref {
                        let key = (closure.station_b.section_id, closure.station_b.station_index);
                        if !visited.contains(&key) {
                            visited.insert(key);
                            queue.push_back((closure.station_b.section_id, closure.station_b.station_index, path_len));
                        }
                    } else if closure.station_b == current_ref {
                        let key = (closure.station_a.section_id, closure.station_a.station_index);
                        if !visited.contains(&key) {
                            visited.insert(key);
                            queue.push_back((closure.station_a.section_id, closure.station_a.station_index, path_len));
                        }
                    }
                }
            }
        }

        // No path found (shouldn't happen if sections are connected)
        // Fall back to sum of all reachable section lengths
        let reachable = if include_closures {
            self.get_reachable_section_ids(station_a.section_id)
        } else {
            self.get_connected_section_ids(station_a.section_id)
        };
        reachable.iter()
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
    ) -> Result<bool, String> {
        // Check that both stations exist
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return Err("One or both stations do not exist".to_string());
        }

        // Check not already merged
        if self.are_stations_merged(station_a, station_b) {
            return Err("These stations are already merged".to_string());
        }

        // Check if already connected (same section group) - reject, use CreateLoopClosure instead
        let connected_a = self.get_connected_section_ids(station_a.section_id);
        if connected_a.contains(&station_b.section_id) {
            return Err("Stations are already connected. Use Create Loop Closure instead.".to_string());
        }

        // Check zero datum status - uses transitive connections through existing merges
        // This ensures that if B is connected to a datum-holding section C through an
        // earlier merge, b_has_zd will be true and the merge will propagate datum positioning
        let a_has_zd = self.section_has_zero_datum(station_a.section_id);
        let b_has_zd = self.section_has_zero_datum(station_b.section_id);

        if a_has_zd && b_has_zd {
            return Err("Both stations are connected to zero datums. Remove one zero datum before merging, or create a loop closure if the sections are connected.".to_string());
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

    /// Compute closure metrics between two stations without mutation.
    /// Both stations must exist and have computable coordinates.
    pub(crate) fn compute_closure_metrics(
        &self,
        station_a: StationRef,
        station_b: StationRef,
    ) -> Result<ClosurePreview, String> {
        let coords_a = self.compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b = self.compute_station_raw_coords(station_b)
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
        _strategy: ClosureStrategy,
    ) -> Result<LoopClosure, String> {
        // Check that both stations exist
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return Err("One or both stations do not exist".to_string());
        }

        // Reject already-merged station pairs
        if self.are_stations_merged(station_a, station_b) {
            return Err("These stations are already merged. Closures are for unmerged station pairs.".to_string());
        }

        // Check stations are connected (via merges or closures)
        let reachable_a = self.get_reachable_section_ids(station_a.section_id);
        if !reachable_a.contains(&station_b.section_id) {
            return Err("Stations are not connected. They must be in the same connected group to create a loop closure.".to_string());
        }

        // Check for duplicate closure between same station pair
        let already_has_closure = self.are_stations_in_closure(station_a, station_b);
        if already_has_closure {
            return Err("A loop closure already exists between these stations.".to_string());
        }

        // Compute closure values using shared helper
        let metrics = self.compute_closure_metrics(station_a, station_b)?;

        // Normalize next_closure_id in case of legacy deserialization (default 0)
        let max_existing = self.loop_closures.iter().map(|lc| lc.id).max().unwrap_or(0);
        if self.next_closure_id <= max_existing {
            self.next_closure_id = max_existing + 1;
        }
        // Assign next closure ID from monotonic counter
        let next_id = self.next_closure_id;
        self.next_closure_id += 1;

        let closure = LoopClosure {
            id: next_id,
            station_a,
            station_b,
            path_length: metrics.path_length,
            misclosure_distance: metrics.misclosure_distance,
            error_percentage: metrics.error_percentage,
            horizontal_misclosure: metrics.horizontal_misclosure,
            vertical_misclosure: metrics.vertical_misclosure,
        };

        self.loop_closures.push(closure.clone());
        self.touch();

        Ok(closure)
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
            (m.station_a == station_a && m.station_b == station_b)
                || (m.station_a == station_b && m.station_b == station_a)
        });

        if let Some(pos) = pos {
            self.station_merges.remove(pos);

            // Remove closures for the specific unmerged pair only
            let mut removed_closures = Vec::new();
            self.loop_closures.retain(|lc| {
                let matches = (lc.station_a == station_a && lc.station_b == station_b)
                    || (lc.station_a == station_b && lc.station_b == station_a);
                if matches {
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
        self.station_merges.iter().any(|m| {
            (m.station_a == a && m.station_b == b) || (m.station_a == b && m.station_b == a)
        })
    }

    /// Check if two stations are in a loop closure
    pub fn are_stations_in_closure(&self, a: StationRef, b: StationRef) -> bool {
        self.loop_closures.iter().any(|lc| {
            (lc.station_a == a && lc.station_b == b) || (lc.station_a == b && lc.station_b == a)
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

    /// Get all station refs reachable from this station via shots, merges, and closures (transitive)
    /// All stations in a section are connected via shots; merges and closures connect across sections
    fn get_connected_stations(&self, station_ref: StationRef) -> HashSet<StationRef> {
        // Reuse get_reachable_section_ids for section-level traversal (includes closures)
        let connected_sections = self.get_reachable_section_ids(station_ref.section_id);

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
            // Apply station offset if exists (copy, don't mutate current_coords)
            let mut station_coords = current_coords;
            if let Some(&(ox, oy, oz)) = self.station_offsets.get(&first_station_ref) {
                station_coords = Coordinates::new(
                    station_coords.x + ox,
                    station_coords.y + oy,
                    station_coords.z + oz,
                );
            }
            stations.push(Station::with_coordinates(first_station_ref, station_coords));
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
                // Apply station offset if exists
                let mut station_coords = current_coords;
                if let Some(&(ox, oy, oz)) = self.station_offsets.get(&station_ref) {
                    station_coords = Coordinates::new(
                        station_coords.x + ox,
                        station_coords.y + oy,
                        station_coords.z + oz,
                    );
                }
                stations.push(Station::with_coordinates(station_ref, station_coords));
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

        // Populate closures_with for each station from loop_closures
        // For each closure, both endpoint stations (and their merged equivalents)
        // get a ClosureRef entry. Transitive closures go through merged stations.
        for closure in &self.loop_closures {
            let a_ref = closure.station_a;
            let b_ref = closure.station_b;

            // Collect merged equivalents for each endpoint
            let a_group: Vec<StationRef> = station_to_group
                .get(&a_ref)
                .map(|&gid| groups[gid].clone())
                .unwrap_or_else(|| vec![a_ref]);
            let b_group: Vec<StationRef> = station_to_group
                .get(&b_ref)
                .map(|&gid| groups[gid].clone())
                .unwrap_or_else(|| vec![b_ref]);

            // Skip if both endpoints are in the same merge group (legacy data edge case)
            let a_group_id = station_to_group.get(&a_ref);
            let b_group_id = station_to_group.get(&b_ref);
            if a_group_id.is_some() && a_group_id == b_group_id {
                continue;
            }

            // For each station in A's group, add direct ref to B and transitive refs to B's merged partners
            for station in &mut stations {
                if a_group.contains(&station.station_ref) {
                    // Direct closure to station_b (skip self-references)
                    if station.station_ref != b_ref {
                        let via = if station.station_ref != a_ref {
                            Some(a_ref) // transitive: reached via the actual closure endpoint
                        } else {
                            None
                        };
                        station.closures_with.push(ClosureRef {
                            closure_id: closure.id,
                            station_ref: b_ref,
                            via_station: via,
                            is_transitive: via.is_some(),
                        });
                    }
                    // Transitive closures to B's merged partners (skip self-references)
                    for &b_member in &b_group {
                        if b_member != b_ref && b_member != station.station_ref {
                            station.closures_with.push(ClosureRef {
                                closure_id: closure.id,
                                station_ref: b_member,
                                via_station: Some(b_ref),
                                is_transitive: true,
                            });
                        }
                    }
                } else if b_group.contains(&station.station_ref) {
                    // Direct closure to station_a (skip self-references)
                    if station.station_ref != a_ref {
                        let via = if station.station_ref != b_ref {
                            Some(b_ref)
                        } else {
                            None
                        };
                        station.closures_with.push(ClosureRef {
                            closure_id: closure.id,
                            station_ref: a_ref,
                            via_station: via,
                            is_transitive: via.is_some(),
                        });
                    }
                    // Transitive closures to A's merged partners (skip self-references)
                    for &a_member in &a_group {
                        if a_member != a_ref && a_member != station.station_ref {
                            station.closures_with.push(ClosureRef {
                                closure_id: closure.id,
                                station_ref: a_member,
                                via_station: Some(a_ref),
                                is_transitive: true,
                            });
                        }
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
            station_count: stats.station_count,
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

        // Center from first valid zero datum (lng, lat order for MapLibre)
        let first_gps = &valid_datums[0].gps;
        let gps_center = Some((first_gps.longitude, first_gps.latitude));

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
mod tests;
