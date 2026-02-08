use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::cmp::Ordering;
use std::path::PathBuf;
use tracing::{debug, error, info, trace, warn};
use ts_rs::TS;

use crate::config::ClosureAdjustmentConfig;

use super::{
    gps_to_local, ClosurePreview, ClosureRef, ClosureStrategy, Coordinates, FrozenShotRef,
    GpsBounds, GpsCoordinates, LoopClosure, Section, SectionData, SectionId, SectionUpdates, Shot,
    ShotData, ShotId, ShotUpdates, Station, StationMerge, StationRef, ZeroDatum, FEATURE_ID_STRIDE,
};

/// Relationships that reference a given section (merges, closures, offsets, zero datums).
/// Used by the frontend to show affected relationships before section deletion.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SectionRelationships {
    /// Station merges referencing the section
    pub merges: Vec<StationMerge>,
    /// Loop closures referencing the section
    pub closures: Vec<LoopClosure>,
    /// Whether the section has a section offset
    pub has_section_offset: bool,
    /// Number of station offsets referencing the section
    pub station_offset_count: usize,
    /// Number of zero datums referencing the section
    pub zero_datum_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct StationPair {
    pub station_a: StationRef,
    pub station_b: StationRef,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct ClosurePair {
    pub closure_id: u64,
    pub station_a: StationRef,
    pub station_b: StationRef,
}

#[derive(Debug, Clone, Copy)]
enum PathEdge {
    Shot {
        section_id: SectionId,
        shot_index: usize,
        forward: bool,
    },
    Merge,
}

#[derive(Debug, Clone, Copy)]
struct PathStep {
    to: StationRef,
    edge: PathEdge,
}

#[derive(Debug, Clone)]
struct StationPath {
    start: StationRef,
    steps: Vec<PathStep>,
}

#[derive(Debug, Clone, Copy)]
struct SegmentShot {
    section_id: SectionId,
    shot_index: usize,
    forward: bool,
    length: f64,
    path_vec: Coordinates,
    sign: f64,
}

#[derive(Debug, Clone, Copy)]
struct HeapItem {
    cost: f64,
    node: StationRef,
}

impl Eq for HeapItem {}

impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.cost == other.cost
    }
}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse for min-heap; treat NaN as equal (should not occur).
        other
            .cost
            .partial_cmp(&self.cost)
            .unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct ClosureUpdate {
    pub closure_id: u64,
    pub old_station: StationRef,
    pub new_station: StationRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DeleteShotImpact {
    pub removed_station: StationRef,
    pub removed_merges: Vec<StationPair>,
    pub removed_closures: Vec<ClosurePair>,
    pub replacement_merges: Vec<StationPair>,
    pub replacement_closure_updates: Vec<ClosureUpdate>,
    pub merge_rewire_skipped: bool,
    pub closure_rewire_skipped: bool,
    #[serde(default)]
    pub shift_blocked: bool,
    #[serde(default)]
    pub shift_blocked_reasons: Vec<String>,
}

/// A complete cave survey project
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Project {
    /// Project name (typically cave system name)
    pub name: String,
    /// Optional location description
    pub location: Option<String>,
    /// Creation timestamp
    #[ts(type = "string")]
    pub created_at: DateTime<Utc>,
    /// Last modification timestamp
    #[ts(type = "string")]
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
    #[ts(type = "string | null")]
    pub file_path: Option<PathBuf>,
    /// Next section ID to assign
    pub next_section_id: SectionId,
    /// Section offsets (x, y) applied when sections are merged/aligned
    #[serde(default)]
    pub section_offsets: HashMap<SectionId, (f64, f64)>,
    /// Station offsets (x, y, z) applied when individual stations are moved
    #[serde(default, serialize_with = "serialize_station_offsets", deserialize_with = "deserialize_station_offsets")]
    #[ts(skip)]
    #[ts(type = "Array<[StationRef, [number, number, number]]>")]
    pub station_offsets: HashMap<StationRef, (f64, f64, f64)>,
    /// SHA256 hashes of imported DMP files (for duplicate detection)
    #[serde(default)]
    pub imported_file_hashes: Vec<String>,
    /// Monotonic counter for closure IDs. Never reused, even after deletions.
    #[serde(default)]
    pub next_closure_id: u64,
}

/// Project metadata for listing
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProjectMetadata {
    pub name: String,
    pub location: Option<String>,
    #[ts(type = "string")]
    pub file_path: PathBuf,
    #[ts(type = "string")]
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
            if lc.strategy == ClosureStrategy::Move {
                lc.is_aligned = true;
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
        let idx = self.sections.len() - 1;
        &self.sections[idx]
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

    /// Query relationships that reference the given section.
    /// Returns merges, closures, offset info, and zero datum count.
    pub fn get_section_relationships(&self, section_id: SectionId) -> SectionRelationships {
        let merges: Vec<StationMerge> = self
            .station_merges
            .iter()
            .filter(|m| m.station_a.section_id == section_id || m.station_b.section_id == section_id)
            .cloned()
            .collect();

        let closures: Vec<LoopClosure> = self
            .loop_closures
            .iter()
            .filter(|lc| lc.station_a.section_id == section_id || lc.station_b.section_id == section_id)
            .cloned()
            .collect();

        let has_section_offset = self.section_offsets.contains_key(&section_id);

        let station_offset_count = self
            .station_offsets
            .keys()
            .filter(|sr| sr.section_id == section_id)
            .count();

        let zero_datum_count = self
            .zero_datums
            .iter()
            .filter(|zd| zd.station_ref.section_id == section_id)
            .count();

        SectionRelationships {
            merges,
            closures,
            has_section_offset,
            station_offset_count,
            zero_datum_count,
        }
    }

    /// Remove all merges, closures, section_offsets, station_offsets, and zero_datums
    /// that reference the given section. Call before `remove_section()` to avoid orphans.
    pub fn cleanup_section_references(&mut self, section_id: SectionId) {
        // Remove merges referencing this section
        self.station_merges.retain(|m| {
            m.station_a.section_id != section_id && m.station_b.section_id != section_id
        });

        // Remove closures referencing this section
        self.loop_closures.retain(|lc| {
            lc.station_a.section_id != section_id && lc.station_b.section_id != section_id
        });

        // Remove section offset
        self.section_offsets.remove(&section_id);

        // Remove station offsets referencing this section
        self.station_offsets.retain(|sr, _| sr.section_id != section_id);

        // Remove zero datums referencing this section
        self.zero_datums.retain(|zd| zd.station_ref.section_id != section_id);
    }

    /// Compute the (dx, dy) horizontal displacement of a shot from its data.
    /// Uses the same average azimuth calculation as coordinate computation.
    pub(crate) fn shot_displacement(data: &ShotData) -> (f64, f64) {
        let diff = (data.azimuth_out - data.azimuth_in + 540.0) % 360.0 - 180.0;
        let avg_az = (data.azimuth_in + diff / 2.0 + 360.0) % 360.0;
        let az_rad = avg_az.to_radians();
        let horizontal = data.horizontal_length();
        (horizontal * az_rad.sin(), horizontal * az_rad.cos())
    }

    /// Shift all StationRef indices in the project for the given section.
    ///
    /// All station references where `section_id` matches AND `station_index >= from_index`
    /// have their `station_index` shifted by `delta`. This is needed when inserting or
    /// removing shots, which changes station indices for all subsequent stations.
    ///
    /// Affects: station_merges, loop_closures, zero_datums, station_offsets.
    pub(crate) fn shift_station_refs(&mut self, section_id: SectionId, from_index: u32, delta: i32) {
        let shift = |sr: &mut StationRef| {
            if sr.section_id == section_id && sr.station_index >= from_index {
                sr.station_index = (sr.station_index as i32 + delta) as u32;
            }
        };

        // Shift station_merges
        for merge in &mut self.station_merges {
            shift(&mut merge.station_a);
            shift(&mut merge.station_b);
        }

        // Shift loop_closures
        for closure in &mut self.loop_closures {
            shift(&mut closure.station_a);
            shift(&mut closure.station_b);
        }

        // Shift zero_datums
        for zd in &mut self.zero_datums {
            shift(&mut zd.station_ref);
        }

        // Shift station_offsets (HashMap keys — collect, remove, re-insert)
        let keys_to_shift: Vec<(StationRef, (f64, f64, f64))> = self
            .station_offsets
            .iter()
            .filter(|(sr, _)| sr.section_id == section_id && sr.station_index >= from_index)
            .map(|(sr, v)| (*sr, *v))
            .collect();

        for (old_key, value) in keys_to_shift {
            self.station_offsets.remove(&old_key);
            let new_key = StationRef::new(
                old_key.section_id,
                (old_key.station_index as i32 + delta) as u32,
            );
            self.station_offsets.insert(new_key, value);
        }
    }

    fn station_ref_key(station_ref: &StationRef) -> (SectionId, u32) {
        (station_ref.section_id, station_ref.station_index)
    }

    fn has_direct_merge(&self, a: StationRef, b: StationRef) -> bool {
        self.station_merges.iter().any(|m| {
            (m.station_a == a && m.station_b == b) || (m.station_a == b && m.station_b == a)
        })
    }

    fn get_merge_group(&self, station_ref: StationRef) -> HashSet<StationRef> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(station_ref);
        queue.push_back(station_ref);

        while let Some(current) = queue.pop_front() {
            for merge in &self.station_merges {
                let neighbor = if merge.station_a == current {
                    Some(merge.station_b)
                } else if merge.station_b == current {
                    Some(merge.station_a)
                } else {
                    None
                };
                if let Some(next) = neighbor {
                    if visited.insert(next) {
                        queue.push_back(next);
                    }
                }
            }
        }

        visited
    }

    fn build_merge_components(
        &self,
        stations: &HashSet<StationRef>,
        removed_station: StationRef,
    ) -> Vec<Vec<StationRef>> {
        let mut adjacency: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for station in stations {
            adjacency.entry(*station).or_default();
        }

        for merge in &self.station_merges {
            if merge.station_a == removed_station || merge.station_b == removed_station {
                continue;
            }
            if stations.contains(&merge.station_a) && stations.contains(&merge.station_b) {
                adjacency.entry(merge.station_a).or_default().push(merge.station_b);
                adjacency.entry(merge.station_b).or_default().push(merge.station_a);
            }
        }

        let mut components = Vec::new();
        let mut visited = HashSet::new();

        let mut station_list: Vec<StationRef> = stations.iter().copied().collect();
        station_list.sort_by_key(Self::station_ref_key);

        for station in station_list {
            if visited.contains(&station) {
                continue;
            }
            let mut component = Vec::new();
            let mut queue = VecDeque::new();
            visited.insert(station);
            queue.push_back(station);

            while let Some(current) = queue.pop_front() {
                component.push(current);
                if let Some(neighbors) = adjacency.get(&current) {
                    for neighbor in neighbors {
                        if visited.insert(*neighbor) {
                            queue.push_back(*neighbor);
                        }
                    }
                }
            }

            component.sort_by_key(Self::station_ref_key);
            components.push(component);
        }

        components
    }

    fn station_neighbors_excluding_shot(
        &self,
        station_ref: StationRef,
        excluded_shot: Option<(SectionId, usize)>,
    ) -> Vec<StationRef> {
        let mut neighbors = Vec::new();
        let Some(section) = self.get_section(station_ref.section_id) else {
            return neighbors;
        };
        let idx = station_ref.station_index as usize;
        if idx > section.shots.len() {
            return neighbors;
        }

        // Adjacent stations via shots (skip the excluded shot)
        if idx > 0 {
            let shot_idx = idx - 1;
            if excluded_shot != Some((station_ref.section_id, shot_idx)) {
                neighbors.push(StationRef::new(station_ref.section_id, (idx - 1) as u32));
            }
        }
        if idx < section.shots.len() {
            let shot_idx = idx;
            if excluded_shot != Some((station_ref.section_id, shot_idx)) {
                neighbors.push(StationRef::new(station_ref.section_id, (idx + 1) as u32));
            }
        }

        // Merges
        for merge in &self.station_merges {
            if merge.station_a == station_ref {
                neighbors.push(merge.station_b);
            } else if merge.station_b == station_ref {
                neighbors.push(merge.station_a);
            }
        }

        // Closures (all strategies)
        for closure in &self.loop_closures {
            if closure.station_a == station_ref {
                neighbors.push(closure.station_b);
            } else if closure.station_b == station_ref {
                neighbors.push(closure.station_a);
            }
        }

        neighbors
    }

    fn are_stations_connected_excluding_shot(
        &self,
        station_a: StationRef,
        station_b: StationRef,
        excluded_shot: Option<(SectionId, usize)>,
    ) -> bool {
        if station_a == station_b {
            return true;
        }
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(station_a);
        queue.push_back(station_a);

        while let Some(current) = queue.pop_front() {
            for neighbor in self.station_neighbors_excluding_shot(current, excluded_shot) {
                if visited.insert(neighbor) {
                    if neighbor == station_b {
                        return true;
                    }
                    queue.push_back(neighbor);
                }
            }
        }
        false
    }

    fn station_reaches_zero_datum_excluding_shot(
        &self,
        station_ref: StationRef,
        excluded_shot: Option<(SectionId, usize)>,
    ) -> bool {
        let zero_datum_set: HashSet<StationRef> =
            self.zero_datums.iter().map(|zd| zd.station_ref).collect();
        if zero_datum_set.contains(&station_ref) {
            return true;
        }
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(station_ref);
        queue.push_back(station_ref);

        while let Some(current) = queue.pop_front() {
            for neighbor in self.station_neighbors_excluding_shot(current, excluded_shot) {
                if visited.insert(neighbor) {
                    if zero_datum_set.contains(&neighbor) {
                        return true;
                    }
                    queue.push_back(neighbor);
                }
            }
        }
        false
    }

    // === Shot operations ===

    fn max_shots_per_section() -> usize {
        FEATURE_ID_STRIDE.saturating_sub(1) as usize
    }

    /// Add a shot to a section
    pub fn add_shot(&mut self, section_id: SectionId, data: ShotData) -> Option<&Shot> {
        let section = self.get_section_mut(section_id)?;
        if section.shots.len() >= Self::max_shots_per_section() {
            return None;
        }
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
        // Look up position before mutable borrow
        let section = self.get_section(section_id)?;
        let pos = section.shots.iter().position(|s| s.id == after_shot_id)?;
        if section.shots.len() >= Self::max_shots_per_section() {
            return None;
        }
        let section = self.get_section_mut(section_id)?;
        let shot = section.insert_shot_after(after_shot_id, data)?;
        let shot_id = shot.id;
        // insert_after at pos: new shot at pos+1, old stations >= pos+2 shift up
        self.shift_station_refs(section_id, (pos + 2) as u32, 1);
        self.touch();
        self.get_section(section_id)?.get_shot(shot_id)
    }

    /// Insert a shot before a specific shot in a section
    pub fn insert_shot_before(
        &mut self,
        section_id: SectionId,
        before_shot_id: ShotId,
        data: ShotData,
    ) -> Option<&Shot> {
        // Look up position before mutable borrow
        let section = self.get_section(section_id)?;
        let pos = section.shots.iter().position(|s| s.id == before_shot_id)?;
        if section.shots.len() >= Self::max_shots_per_section() {
            return None;
        }
        // Compute displacement before data is consumed (only needed at pos=0)
        let disp = if pos == 0 {
            Some(Self::shot_displacement(&data))
        } else {
            None
        };
        let section = self.get_section_mut(section_id)?;
        let shot = section.insert_shot_before(before_shot_id, data)?;
        let shot_id = shot.id;
        // insert_before at pos: new shot at pos, old station at pos becomes pos+1
        self.shift_station_refs(section_id, pos as u32, 1);
        // When prepending (pos=0), adjust this section's offset so existing
        // stations keep their visual position. Station 0 is always at
        // section_offset, so old station 0 (now 1) = section_offset +
        // displacement. Subtract the displacement from the offset to compensate.
        // Only this section is adjusted — other merged sections are unaffected
        // because the new shot only changes this section's coordinate walk.
        if let Some((dx, dy)) = disp {
            if dx != 0.0 || dy != 0.0 {
                let current = self.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
                self.section_offsets.insert(section_id, (current.0 - dx, current.1 - dy));
            }
        }
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

    pub fn preview_delete_shot(
        &self,
        section_id: SectionId,
        shot_id: ShotId,
    ) -> Result<DeleteShotImpact, String> {
        let section = self
            .get_section(section_id)
            .ok_or_else(|| format!("Section {section_id} not found"))?;
        let pos = section
            .shots
            .iter()
            .position(|s| s.id == shot_id)
            .ok_or_else(|| format!("Shot {shot_id} not found in section {section_id}"))?;

        let removed_station = if pos == 0 {
            StationRef::new(section_id, 0)
        } else {
            StationRef::new(section_id, (pos + 1) as u32)
        };

        let mut impact = DeleteShotImpact {
            removed_station,
            removed_merges: Vec::new(),
            removed_closures: Vec::new(),
            replacement_merges: Vec::new(),
            replacement_closure_updates: Vec::new(),
            merge_rewire_skipped: false,
            closure_rewire_skipped: false,
            shift_blocked: false,
            shift_blocked_reasons: Vec::new(),
        };

        for merge in &self.station_merges {
            if merge.station_a == removed_station || merge.station_b == removed_station {
                impact.removed_merges.push(StationPair {
                    station_a: merge.station_a,
                    station_b: merge.station_b,
                });
            }
        }

        for closure in &self.loop_closures {
            if closure.station_a == removed_station || closure.station_b == removed_station {
                impact.removed_closures.push(ClosurePair {
                    closure_id: closure.id,
                    station_a: closure.station_a,
                    station_b: closure.station_b,
                });
            }
        }

        let merge_group = self.get_merge_group(removed_station);
        let mut merge_group_without = merge_group;
        merge_group_without.remove(&removed_station);

        if merge_group_without.len() > 1 {
            let components = self.build_merge_components(&merge_group_without, removed_station);
            if components.len() > 1 {
                let base_component = &components[0];

                let mut planned_pairs: Vec<StationPair> = Vec::new();
                for component in components.iter().skip(1) {
                    let mut found_pair: Option<StationPair> = None;
                    for station_a in base_component {
                        for station_b in component {
                            if station_a.section_id != station_b.section_id {
                                found_pair = Some(StationPair {
                                    station_a: *station_a,
                                    station_b: *station_b,
                                });
                                break;
                            }
                        }
                        if found_pair.is_some() {
                            break;
                        }
                    }

                    if let Some(pair) = found_pair {
                        if !self.has_direct_merge(pair.station_a, pair.station_b)
                            && !planned_pairs.iter().any(|p| {
                                (p.station_a == pair.station_a && p.station_b == pair.station_b)
                                    || (p.station_a == pair.station_b
                                        && p.station_b == pair.station_a)
                            })
                        {
                            planned_pairs.push(pair);
                        }
                    } else {
                        impact.merge_rewire_skipped = true;
                    }
                }

                impact.replacement_merges = planned_pairs;
            }
        }

        if !impact.removed_closures.is_empty() {
            let mut candidates: Vec<StationRef> = merge_group_without.into_iter().collect();
            candidates.sort_by_key(Self::station_ref_key);
            let replacement = candidates.first().copied();

            for closure in &impact.removed_closures {
                if let Some(replacement_station) = replacement {
                    let other = if closure.station_a == removed_station {
                        closure.station_b
                    } else {
                        closure.station_a
                    };

                    if replacement_station == other
                        || self.are_stations_merged(replacement_station, other)
                        || self.are_stations_in_closure(replacement_station, other)
                    {
                        impact.closure_rewire_skipped = true;
                    } else {
                        impact.replacement_closure_updates.push(ClosureUpdate {
                            closure_id: closure.closure_id,
                            old_station: removed_station,
                            new_station: replacement_station,
                        });
                    }
                } else {
                    impact.closure_rewire_skipped = true;
                }
            }
        }

        let is_mid_shot = pos > 0 && pos < section.shots.len() - 1;
        if is_mid_shot {
            let station_before = StationRef::new(section_id, pos as u32);
            let station_after = StationRef::new(section_id, (pos + 1) as u32);
            let excluded = Some((section_id, pos));

            if self.are_stations_connected_excluding_shot(station_before, station_after, excluded) {
                impact.shift_blocked_reasons.push(
                    "This shot is part of a loop (the two sides are already connected).".to_string(),
                );
            }

            let anchored_before = self.station_reaches_zero_datum_excluding_shot(station_before, excluded);
            let anchored_after = self.station_reaches_zero_datum_excluding_shot(station_after, excluded);
            if anchored_before && anchored_after {
                impact.shift_blocked_reasons.push(
                    "Both sides are anchored to a zero datum.".to_string(),
                );
            }

            impact.shift_blocked = !impact.shift_blocked_reasons.is_empty();
        }

        Ok(impact)
    }

    pub fn remove_shot_with_rewire(
        &mut self,
        section_id: SectionId,
        shot_id: ShotId,
    ) -> Result<(Shot, DeleteShotImpact), String> {
        let section = self
            .get_section(section_id)
            .ok_or_else(|| format!("Section {section_id} not found"))?;
        let pos = section
            .shots
            .iter()
            .position(|s| s.id == shot_id)
            .ok_or_else(|| format!("Shot {shot_id} not found in section {section_id}"))?;

        let impact = self.preview_delete_shot(section_id, shot_id)?;
        let removed_station = impact.removed_station;

        self.station_offsets.remove(&removed_station);
        self.zero_datums.retain(|zd| zd.station_ref != removed_station);

        self.station_merges.retain(|m| {
            m.station_a != removed_station && m.station_b != removed_station
        });

        let mut closure_updates: HashMap<u64, StationRef> = HashMap::new();
        for update in &impact.replacement_closure_updates {
            closure_updates.insert(update.closure_id, update.new_station);
        }

        let mut updated_closures = Vec::with_capacity(self.loop_closures.len());
        for mut closure in self.loop_closures.drain(..) {
            if closure.station_a == removed_station || closure.station_b == removed_station {
                if let Some(new_station) = closure_updates.get(&closure.id).copied() {
                    if closure.station_a == removed_station {
                        closure.station_a = new_station;
                    } else {
                        closure.station_b = new_station;
                    }
                    updated_closures.push(closure);
                }
            } else {
                updated_closures.push(closure);
            }
        }
        self.loop_closures = updated_closures;

        for pair in &impact.replacement_merges {
            if !self.has_direct_merge(pair.station_a, pair.station_b) {
                self.station_merges.push(StationMerge {
                    station_a: pair.station_a,
                    station_b: pair.station_b,
                    merged_at: Utc::now(),
                });
            }
        }

        let deleted_shot = {
            let section_mut = self
                .get_section_mut(section_id)
                .ok_or_else(|| format!("Section {section_id} not found"))?;
            section_mut
                .remove_shot(shot_id)
                .ok_or_else(|| format!("Shot {shot_id} not found in section {section_id}"))?
        };

        self.shift_station_refs(section_id, (pos + 1) as u32, -1);

        if pos == 0 {
            let (dx, dy) = Self::shot_displacement(&deleted_shot.to_shot_data());
            if dx != 0.0 || dy != 0.0 {
                let current = self.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
                self.section_offsets.insert(section_id, (current.0 + dx, current.1 + dy));
            }
        }

        self.touch();
        Ok((deleted_shot, impact))
    }

    /// Remove a shot
    pub fn remove_shot(&mut self, section_id: SectionId, shot_id: ShotId) -> Option<Shot> {
        self.remove_shot_with_rewire(section_id, shot_id)
            .ok()
            .map(|(shot, _)| shot)
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

    /// Get all section IDs connected to the given section through merges and closures.
    /// Both merges and closures are treated as bidirectional edges.
    /// Returns a set containing the given section and all transitively connected sections.
    pub fn get_connected_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
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
                    } else if merge.station_b.section_id == current
                        && !connected.contains(&merge.station_a.section_id) {
                            queue.push(merge.station_a.section_id);
                        }
                }
                // Follow closures as edges (bidirectional, same as merges)
                for closure in &self.loop_closures {
                    if closure.station_a.section_id == current {
                        if !connected.contains(&closure.station_b.section_id) {
                            queue.push(closure.station_b.section_id);
                        }
                    } else if closure.station_b.section_id == current
                        && !connected.contains(&closure.station_a.section_id) {
                            queue.push(closure.station_a.section_id);
                        }
                }
            }
        }
        connected
    }

    /// Get all section IDs connected through merges and aligned closures (rigid groups).
    /// Unaligned closures are ignored so sections can move independently before adjustment.
    pub fn get_rigid_connected_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
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
                    } else if merge.station_b.section_id == current
                        && !connected.contains(&merge.station_a.section_id) {
                            queue.push(merge.station_a.section_id);
                        }
                }
                // Follow aligned closures as edges (bidirectional, same as merges)
                for closure in &self.loop_closures {
                    if !closure.is_aligned {
                        continue;
                    }
                    if closure.station_a.section_id == current {
                        if !connected.contains(&closure.station_b.section_id) {
                            queue.push(closure.station_b.section_id);
                        }
                    } else if closure.station_b.section_id == current
                        && !connected.contains(&closure.station_a.section_id) {
                            queue.push(closure.station_a.section_id);
                        }
                }
            }
        }
        connected
    }

    /// Get all section IDs connected through station merges only (rigid groups).
    /// Closures are NOT followed. Use this for rigid-group operations:
    /// datum propagation, offset application, zero-datum validation.
    pub fn get_merged_section_ids(&self, section_id: SectionId) -> HashSet<SectionId> {
        let mut connected = HashSet::new();
        let mut queue = vec![section_id];

        while let Some(current) = queue.pop() {
            if connected.insert(current) {
                for merge in &self.station_merges {
                    if merge.station_a.section_id == current {
                        if !connected.contains(&merge.station_b.section_id) {
                            queue.push(merge.station_b.section_id);
                        }
                    } else if merge.station_b.section_id == current
                        && !connected.contains(&merge.station_a.section_id) {
                            queue.push(merge.station_a.section_id);
                        }
                }
            }
        }
        connected
    }

    /// Capture section offsets for all sections connected to the given section.
    /// Returns a HashMap where:
    ///   - Key is the section ID
    ///   - Value is Option<(f64, f64)>: Some if offset existed, None if key didn't exist
    ///
    /// This is used by undo to restore exact previous state.
    pub fn capture_connected_section_offsets(
        &self,
        section_id: SectionId,
    ) -> HashMap<SectionId, Option<(f64, f64)>> {
        let merged_sections = self.get_merged_section_ids(section_id);
        let mut offsets = HashMap::new();
        for sid in merged_sections {
            offsets.insert(sid, self.section_offsets.get(&sid).copied());
        }
        offsets
    }

    /// Check if a section is connected to a zero datum (directly or through merges only)
    fn section_has_zero_datum(&self, section_id: SectionId) -> bool {
        let merged = self.get_merged_section_ids(section_id);
        self.zero_datums.iter().any(|zd| merged.contains(&zd.station_ref.section_id))
    }

    /// Get all stations colocated with the given station (via merges and aligned closures).
    ///
    /// Returns a vec including the station itself plus all merge/closure partners,
    /// transitively connected.
    fn get_colocated_stations(&self, station_ref: StationRef) -> Vec<StationRef> {
        let mut group = vec![station_ref];
        let mut visited = HashSet::new();
        visited.insert(station_ref);
        let mut queue = VecDeque::new();
        queue.push_back(station_ref);

        while let Some(current) = queue.pop_front() {
            // Check merges
            for merge in &self.station_merges {
                let partner = if merge.station_a == current {
                    Some(merge.station_b)
                } else if merge.station_b == current {
                    Some(merge.station_a)
                } else {
                    None
                };
                if let Some(p) = partner {
                    if visited.insert(p) {
                        group.push(p);
                        queue.push_back(p);
                    }
                }
            }
            // Check aligned closures
            for closure in &self.loop_closures {
                if !closure.is_aligned {
                    continue;
                }
                let partner = if closure.station_a == current {
                    Some(closure.station_b)
                } else if closure.station_b == current {
                    Some(closure.station_a)
                } else {
                    None
                };
                if let Some(p) = partner {
                    if visited.insert(p) {
                        group.push(p);
                        queue.push_back(p);
                    }
                }
            }
        }

        group
    }

    /// Compute a station's absolute depth from the average of surrounding shot depths.
    ///
    /// For a station and its colocated group (merge + aligned closure partners),
    /// collects depth measurements from:
    /// - **Incoming shot** (shot at index `station_index - 1`): use `depth_out`
    /// - **Outgoing shot** (shot at index `station_index`): use `depth_in`
    ///
    /// Returns the average of all collected measurements, or 0.0 if none exist.
    fn compute_station_depth(&self, colocated: &[StationRef]) -> f64 {
        let mut depths: Vec<f64> = Vec::new();

        for &sr in colocated {
            if let Some(section) = self.sections.iter().find(|s| s.id == sr.section_id) {
                let idx = sr.station_index as usize;

                // Incoming shot: shot at index station_index - 1 → use depth_out
                if idx > 0 && idx - 1 < section.shots.len() {
                    depths.push(section.shots[idx - 1].depth_out);
                }

                // Outgoing shot: shot at index station_index → use depth_in
                if idx < section.shots.len() {
                    depths.push(section.shots[idx].depth_in);
                }
            }
        }

        if depths.is_empty() {
            0.0
        } else {
            depths.iter().sum::<f64>() / depths.len() as f64
        }
    }

    /// Compute raw station coordinates for a single station (without global zero datum offset)
    pub(crate) fn compute_station_raw_coords(&self, station_ref: StationRef) -> Option<Coordinates> {
        let section = self.sections.iter().find(|s| s.id == station_ref.section_id)?;

        // Get section offset
        let (offset_x, offset_y) = self.section_offsets.get(&section.id).copied().unwrap_or((0.0, 0.0));
        let mut coords = Coordinates::new(offset_x, offset_y, 0.0);

        // Walk through shots to reach the station (X, Y only)
        for i in 0..station_ref.station_index as usize {
            if i >= section.shots.len() {
                return None;
            }
            let shot = &section.shots[i];
            let azimuth_rad = shot.average_azimuth().to_radians();
            let horizontal = shot.horizontal_length();
            let dx = horizontal * azimuth_rad.sin();
            let dy = horizontal * azimuth_rad.cos();
            coords.x += dx;
            coords.y += dy;
        }

        // Z = absolute depth from averaged surrounding shots
        let colocated = self.get_colocated_stations(station_ref);
        coords.z = self.compute_station_depth(&colocated);

        // Apply station offset if exists (individual station move)
        if let Some(&(ox, oy, oz)) = self.station_offsets.get(&station_ref) {
            coords.x += ox;
            coords.y += oy;
            coords.z += oz;
        }

        Some(coords)
    }

    /// Calculate the path length between two stations through shots, merges, and closures.
    /// Both merges and closures are zero-distance edges.
    pub(crate) fn calculate_path_length_between(&self, station_a: StationRef, station_b: StationRef) -> f64 {
        self.calculate_path_length_impl(station_a, station_b, true)
    }

    /// Calculate path length through shots and merges only (no closures).
    /// Use this when only rigid-group survey path length is needed.
    #[cfg(test)]
    pub(crate) fn calculate_merge_only_path_length(&self, station_a: StationRef, station_b: StationRef) -> f64 {
        self.calculate_path_length_impl(station_a, station_b, false)
    }

    /// Internal Dijkstra path length implementation.
    /// When `include_closures` is true, loop closures are treated as zero-distance edges.
    fn calculate_path_length_impl(&self, station_a: StationRef, station_b: StationRef, include_closures: bool) -> f64 {
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return 0.0;
        }

        let section_lookup = self.build_section_lookup();
        let merge_adj = self.build_merge_adjacency(&section_lookup);

        let mut closure_adj: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        if include_closures {
            for closure in &self.loop_closures {
                if !self.station_exists(closure.station_a) || !self.station_exists(closure.station_b) {
                    continue;
                }
                closure_adj.entry(closure.station_a).or_default().push(closure.station_b);
                closure_adj.entry(closure.station_b).or_default().push(closure.station_a);
            }
        }

        let mut dist: HashMap<StationRef, f64> = HashMap::new();
        let mut heap = BinaryHeap::new();
        dist.insert(station_a, 0.0);
        heap.push(HeapItem { cost: 0.0, node: station_a });

        while let Some(HeapItem { cost, node }) = heap.pop() {
            if let Some(&known) = dist.get(&node) {
                if cost > known + 1e-9 {
                    continue;
                }
            }

            if node == station_b {
                return cost;
            }

            let Some(section) = section_lookup.get(&node.section_id) else {
                continue;
            };

            // Previous station (shot index = station_index - 1)
            if node.station_index > 0 {
                let prev_index = node.station_index - 1;
                if (prev_index as usize) <= section.shots.len() {
                    let shot_len = section
                        .shots
                        .get(prev_index as usize)
                        .map_or(0.0, |s| s.length.max(0.0));
                    let neighbor = StationRef::new(node.section_id, prev_index);
                    let next_cost = cost + shot_len;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        heap.push(HeapItem { cost: next_cost, node: neighbor });
                    }
                }
            }

            // Next station (shot index = station_index)
            if (node.station_index as usize) < section.shots.len() {
                let next_index = node.station_index + 1;
                let shot_len = section
                    .shots
                    .get(node.station_index as usize)
                    .map_or(0.0, |s| s.length.max(0.0));
                let neighbor = StationRef::new(node.section_id, next_index);
                let next_cost = cost + shot_len;
                if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                    dist.insert(neighbor, next_cost);
                    heap.push(HeapItem { cost: next_cost, node: neighbor });
                }
            }

            // Merge neighbors (zero distance)
            if let Some(neighbors) = merge_adj.get(&node) {
                for &neighbor in neighbors {
                    let next_cost = cost;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        heap.push(HeapItem { cost: next_cost, node: neighbor });
                    }
                }
            }

            // Closure neighbors (zero distance)
            if include_closures {
                if let Some(neighbors) = closure_adj.get(&node) {
                    for &neighbor in neighbors {
                        let next_cost = cost;
                        if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                            dist.insert(neighbor, next_cost);
                            heap.push(HeapItem { cost: next_cost, node: neighbor });
                        }
                    }
                }
            }
        }

        // No path found (shouldn't happen if sections are connected)
        // Fall back to sum of all reachable section lengths
        let fallback_sections = if include_closures {
            self.get_connected_section_ids(station_a.section_id)
        } else {
            self.get_merged_section_ids(station_a.section_id)
        };
        fallback_sections.iter()
            .filter_map(|sid| self.sections.iter().find(|s| s.id == *sid))
            .flat_map(|s| s.shots.iter())
            .map(|shot| shot.length)
            .sum()
    }

    fn coords_add(a: Coordinates, b: Coordinates) -> Coordinates {
        Coordinates::new(a.x + b.x, a.y + b.y, a.z + b.z)
    }

    fn coords_sub(a: Coordinates, b: Coordinates) -> Coordinates {
        Coordinates::new(a.x - b.x, a.y - b.y, a.z - b.z)
    }

    fn coords_scale(a: Coordinates, factor: f64) -> Coordinates {
        Coordinates::new(a.x * factor, a.y * factor, a.z * factor)
    }

    fn coords_norm(a: Coordinates) -> f64 {
        (a.x * a.x + a.y * a.y + a.z * a.z).sqrt()
    }

    fn coords_close(a: Coordinates, b: Coordinates, eps: f64) -> bool {
        (a.x - b.x).abs() < eps && (a.y - b.y).abs() < eps && (a.z - b.z).abs() < eps
    }

    #[expect(dead_code)]
    fn coords_close_xy(a: Coordinates, b: Coordinates, eps: f64) -> bool {
        (a.x - b.x).abs() < eps && (a.y - b.y).abs() < eps
    }

    fn shot_vector_along(shot: &Shot, forward: bool) -> Coordinates {
        let azimuth_rad = shot.average_azimuth().to_radians();
        let horizontal = shot.horizontal_length();
        let dx = horizontal * azimuth_rad.sin();
        let dy = horizontal * azimuth_rad.cos();
        let dz = shot.depth_out - shot.depth_in;
        if forward {
            Coordinates::new(dx, dy, dz)
        } else {
            Coordinates::new(-dx, -dy, -dz)
        }
    }

    fn update_shot_from_forward_vector(shot: &mut Shot, vec: Coordinates) {
        let dx = vec.x;
        let dy = vec.y;
        let dz = vec.z;
        let horizontal = (dx * dx + dy * dy).sqrt();
        let new_len = (horizontal * horizontal + dz * dz).sqrt();
        let new_azi = if horizontal > 1e-9 {
            dx.atan2(dy).to_degrees().rem_euclid(360.0)
        } else {
            shot.average_azimuth()
        };
        shot.length = new_len;
        shot.azimuth_in = new_azi;
        shot.azimuth_out = new_azi;
        shot.depth_out = shot.depth_in + dz;
        let pitch = dz.atan2(horizontal).to_degrees();
        shot.pitch_in = Some(pitch);
        shot.pitch_out = Some(pitch);
    }

    #[expect(dead_code)]
    fn collect_segment_shots(
        &self,
        path: &StationPath,
        section_lookup: &HashMap<SectionId, &Section>,
    ) -> Result<Vec<SegmentShot>, String> {
        let mut shots: Vec<SegmentShot> = Vec::new();
        for step in &path.steps {
            if let PathEdge::Shot {
                section_id,
                shot_index,
                forward,
            } = step.edge
            {
                let section = section_lookup
                    .get(&section_id)
                    .ok_or_else(|| "Section not found for closure path".to_string())?;
                let shot = section
                    .shots
                    .get(shot_index)
                    .ok_or_else(|| "Shot not found for closure path".to_string())?;
                let path_vec = Self::shot_vector_along(shot, forward);
                shots.push(SegmentShot {
                    section_id,
                    shot_index,
                    forward,
                    length: shot.length,
                    path_vec,
                    sign: 1.0,
                });
            }
        }
        Ok(shots)
    }

    fn apply_correction_to_shots(
        &mut self,
        shots: &[SegmentShot],
        correction_vec: Coordinates,
        distribution: ClosureStrategy,
    ) -> Result<(), String> {
        if shots.is_empty() {
            return Err("No distributable shots found for closure path".to_string());
        }

        let total_len: f64 = shots.iter().map(|s| s.length).sum();
        let shot_count = shots.len();

        if distribution == ClosureStrategy::ProportionalByLength && total_len <= 0.0 {
            return Err("No valid shot lengths for proportional distribution".to_string());
        }

        for shot in shots {
            let signed = Self::coords_scale(correction_vec, shot.sign);
            let (corr_x, corr_y, corr_z) = match distribution {
                ClosureStrategy::ProportionalByLength => {
                    let weight = shot.length / total_len;
                    (
                        signed.x * weight,
                        signed.y * weight,
                        signed.z * weight,
                    )
                }
                ClosureStrategy::EqualDistribution => {
                    let weight = 1.0 / shot_count as f64;
                    (
                        signed.x * weight,
                        signed.y * weight,
                        signed.z * weight,
                    )
                }
                _ => {
                    return Err("Unsupported distribution strategy for adjustment".to_string());
                }
            };

            let new_path_vec = Coordinates::new(
                shot.path_vec.x + corr_x,
                shot.path_vec.y + corr_y,
                shot.path_vec.z + corr_z,
            );
            let forward_vec = if shot.forward {
                new_path_vec
            } else {
                Self::coords_scale(new_path_vec, -1.0)
            };

            let section = self
                .get_section_mut(shot.section_id)
                .ok_or_else(|| "Section not found for closure path".to_string())?;
            let shot_mut = section
                .shots
                .get_mut(shot.shot_index)
                .ok_or_else(|| "Shot not found for closure path".to_string())?;
            Self::update_shot_from_forward_vector(shot_mut, forward_vec);
        }

        Ok(())
    }

    pub fn adjust_loop_closures(
        &mut self,
        anchor_station: StationRef,
        method: ClosureStrategy,
        config: &ClosureAdjustmentConfig,
    ) -> Result<(), String> {
        if !self.station_exists(anchor_station) {
            return Err("Anchor station does not exist".to_string());
        }

        let component = self.get_connected_section_ids(anchor_station.section_id);
        let zero_datum_set: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter(|zd| component.contains(&zd.station_ref.section_id))
            .map(|zd| zd.station_ref)
            .collect();

        debug!(
            anchor_station = ?anchor_station,
            method = ?method,
            component_section_count = component.len(),
            zero_datum_count = zero_datum_set.len(),
            purpose = "adjust loop closures",
            "Preparing loop closure adjustment"
        );

        let mut zero_datum_coords: HashMap<StationRef, Coordinates> = HashMap::new();
        for zd in &zero_datum_set {
            let coords = self
                .compute_station_raw_coords(*zd)
                .ok_or_else(|| "Failed to compute zero datum coordinates".to_string())?;
            zero_datum_coords.insert(*zd, coords);
        }

        let closures: Vec<LoopClosure> = self
            .loop_closures
            .iter()
            .filter(|lc| {
                component.contains(&lc.station_a.section_id)
                    && component.contains(&lc.station_b.section_id)
                    && (lc.strategy == method || lc.strategy == ClosureStrategy::Batch)
            })
            .cloned()
            .collect();

        if closures.is_empty() {
            warn!(
                anchor_station = ?anchor_station,
                method = ?method,
                purpose = "adjust loop closures",
                "No eligible loop closures found for adjustment"
            );
            return Err("No eligible loop closures found for adjustment".to_string());
        }

        match method {
            ClosureStrategy::LeastSquaresWeighted => {
                self.adjust_least_squares(
                    &component,
                    &closures,
                    anchor_station,
                    config,
                )?;
            }
            _ => {
                return Err("Unsupported adjustment method".to_string());
            }
        }

        // Verify zero datums remain fixed
        for (zd, before) in &zero_datum_coords {
            let after = self
                .compute_station_raw_coords(*zd)
                .ok_or_else(|| "Failed to compute zero datum coordinates".to_string())?;
            if !Self::coords_close(*before, after, 1e-6) {
                error!(
                    zero_datum = ?zd,
                    before = ?before,
                    after = ?after,
                    purpose = "protect zero datum position",
                    "Adjustment would move a zero datum station"
                );
                return Err("Adjustment would move a zero datum station".to_string());
            }
        }

        // Recompute closure metrics for the affected component
        self.recompute_closure_metrics_for_component(&component);

        // Mark adjusted closures as aligned (locked for future moves)
        let adjusted_ids: HashSet<u64> = closures.iter().map(|lc| lc.id).collect();
        for closure in &mut self.loop_closures {
            if adjusted_ids.contains(&closure.id) {
                closure.is_aligned = true;
            }
        }

        Ok(())
    }

    /// Enforce merge alignment by adjusting section and station offsets.
    #[expect(dead_code)]
    fn enforce_merge_alignment(
        &mut self,
        sections_to_align: &HashSet<SectionId>,
        colocated_groups: &HashMap<StationRef, Vec<StationRef>>,
        fixed_initial: &HashSet<StationRef>,
    ) -> Result<(), String> {
        if sections_to_align.is_empty() {
            return Ok(());
        }

        let mut section_deltas: HashMap<SectionId, Coordinates> = HashMap::new();
        let mut conflict_samples: Vec<(SectionId, StationRef, StationRef, Coordinates, Coordinates)> = Vec::new();
        let mut conflicted_sections: HashSet<SectionId> = HashSet::new();
        let mut section_station_counts: HashMap<SectionId, usize> = HashMap::new();
        let mut section_targets: HashMap<SectionId, HashMap<StationRef, Coordinates>> = HashMap::new();

        for section in self.sections.iter().filter(|s| sections_to_align.contains(&s.id)) {
            section_station_counts.insert(section.id, section.shots.len());
        }

        for members in colocated_groups.values() {
            let group_sections: HashSet<SectionId> = members.iter().map(|m| m.section_id).collect();
            if group_sections.is_disjoint(sections_to_align) {
                continue;
            }

            let anchor = members
                .iter()
                .copied()
                .find(|m| fixed_initial.contains(m))
                .unwrap_or_else(|| members[0]);
            let anchor_coords = self
                .compute_station_raw_coords(anchor)
                .ok_or_else(|| "Failed to compute merge anchor coordinates".to_string())?;

            for member in members {
                let coords = self
                    .compute_station_raw_coords(*member)
                    .ok_or_else(|| "Failed to compute merge member coordinates".to_string())?;
                let delta = Self::coords_sub(anchor_coords, coords);
                section_targets
                    .entry(member.section_id)
                    .or_default()
                    .insert(*member, anchor_coords);
                let entry = section_deltas.entry(member.section_id).or_insert(delta);
                if !Self::coords_close(*entry, delta, 1e-6) {
                    conflicted_sections.insert(member.section_id);
                    conflict_samples.push((member.section_id, anchor, *member, *entry, delta));
                }
            }
        }

        if !conflict_samples.is_empty() {
            debug!(
                samples = conflict_samples.len(),
                ?conflict_samples,
                "Merge alignment produced conflicting section translations"
            );
        }

        for (section_id, delta) in &section_deltas {
            if !sections_to_align.contains(section_id) || conflicted_sections.contains(section_id) {
                continue;
            }
            if delta.x.abs() > 1e-9 || delta.y.abs() > 1e-9 {
                let current = self.section_offsets.get(section_id).copied().unwrap_or((0.0, 0.0));
                self.section_offsets.insert(*section_id, (current.0 + delta.x, current.1 + delta.y));
            }
            if delta.z.abs() > 1e-9 {
                if let Some(shot_count) = section_station_counts.get(section_id).copied() {
                    for idx in 0..=shot_count {
                        let station = StationRef::new(*section_id, idx as u32);
                        let entry = self.station_offsets.entry(station).or_insert((0.0, 0.0, 0.0));
                        entry.2 += delta.z;
                    }
                }
            }
        }

        if !conflicted_sections.is_empty() {
            for section_id in conflicted_sections.iter().copied() {
                let mut anchor_map: HashMap<StationRef, Coordinates> = HashMap::new();
                if let Some(targets) = section_targets.get(&section_id) {
                    for (station, target) in targets {
                        anchor_map.insert(*station, *target);
                    }
                }

                for fixed in fixed_initial.iter().filter(|s| s.section_id == section_id) {
                    let coords = self
                        .compute_station_raw_coords(*fixed)
                        .ok_or_else(|| "Failed to compute fixed station coordinates".to_string())?;
                    anchor_map.insert(*fixed, coords);
                }

                if anchor_map.is_empty() {
                    continue;
                }

                let mut anchors: Vec<(StationRef, Coordinates)> = anchor_map.into_iter().collect();
                anchors.sort_by(|a, b| (a.0.station_index).cmp(&b.0.station_index));

                let ref_index = anchors
                    .iter()
                    .position(|(s, _)| fixed_initial.contains(s))
                    .unwrap_or(0);
                let (ref_station, ref_target) = anchors[ref_index];
                let ref_current = self
                    .compute_station_raw_coords(ref_station)
                    .ok_or_else(|| "Failed to compute reference anchor coordinates".to_string())?;
                let ref_delta = Self::coords_sub(ref_target, ref_current);
                if Self::coords_norm(ref_delta) > 1e-9 {
                    if ref_delta.x.abs() > 1e-9 || ref_delta.y.abs() > 1e-9 {
                        let current = self.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
                        self.section_offsets
                            .insert(section_id, (current.0 + ref_delta.x, current.1 + ref_delta.y));
                    }
                    if ref_delta.z.abs() > 1e-9 {
                        if let Some(shot_count) = section_station_counts.get(&section_id).copied() {
                            for idx in 0..=shot_count {
                                let station = StationRef::new(section_id, idx as u32);
                                let entry = self.station_offsets.entry(station).or_insert((0.0, 0.0, 0.0));
                                entry.2 += ref_delta.z;
                            }
                        }
                    }
                }

                let mut apply_segment_alignment = |start: StationRef,
                                                   end: StationRef,
                                                   target_end: Coordinates|
                 -> Result<(), String> {
                    if start.station_index == end.station_index {
                        return Ok(());
                    }
                    let current_end = self
                        .compute_station_raw_coords(end)
                        .ok_or_else(|| "Failed to compute merge segment end coordinates".to_string())?;
                    let correction = Self::coords_sub(target_end, current_end);
                    if Self::coords_norm(correction) <= 1e-9 {
                        return Ok(());
                    }

                    let section_lookup = self.build_section_lookup();
                    let section = section_lookup
                        .get(&section_id)
                        .ok_or_else(|| "Section not found for merge alignment".to_string())?;
                    let (start_idx, end_idx, forward) = if start.station_index < end.station_index {
                        (start.station_index as usize, end.station_index as usize, true)
                    } else {
                        (end.station_index as usize, start.station_index as usize, false)
                    };
                    let mut shots: Vec<SegmentShot> = Vec::new();
                    for idx in start_idx..end_idx {
                        let shot = section
                            .shots
                            .get(idx)
                            .ok_or_else(|| "Shot not found for merge alignment".to_string())?;
                        let path_vec = Self::shot_vector_along(shot, forward);
                        shots.push(SegmentShot {
                            section_id,
                            shot_index: idx,
                            forward,
                            length: shot.length,
                            path_vec,
                            sign: 1.0,
                        });
                    }

                    if shots.is_empty() {
                        self.apply_station_move_internal(end, correction)?;
                        return Ok(());
                    }

                    self.apply_correction_to_shots(
                        &shots,
                        correction,
                        ClosureStrategy::ProportionalByLength,
                    )?;
                    Ok(())
                };

                for idx in ref_index..anchors.len().saturating_sub(1) {
                    let (start, _) = anchors[idx];
                    let (end, target_end) = anchors[idx + 1];
                    apply_segment_alignment(start, end, target_end)?;
                }
                for idx in (1..=ref_index).rev() {
                    let (start, _) = anchors[idx];
                    let (end, target_end) = anchors[idx - 1];
                    apply_segment_alignment(start, end, target_end)?;
                }
            }
        }

        Ok(())
    }

    fn adjust_least_squares(
        &mut self,
        component: &HashSet<SectionId>,
        closures: &[LoopClosure],
        anchor_station: StationRef,
        config: &ClosureAdjustmentConfig,
    ) -> Result<(), String> {
        // Collect all stations in component
        let mut stations: Vec<StationRef> = Vec::new();
        for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
            for idx in 0..=section.shots.len() {
                stations.push(StationRef::new(section.id, idx as u32));
            }
        }

        let mut parent: HashMap<StationRef, StationRef> = HashMap::new();
        for station in &stations {
            parent.insert(*station, *station);
        }

        let find = |x: StationRef, parent: &mut HashMap<StationRef, StationRef>| -> StationRef {
            let mut current = x;
            while let Some(p) = parent.get(&current) {
                if *p == current {
                    break;
                }
                current = *p;
            }
            let root = current;
            // Path compression
            let mut current = x;
            while let Some(p) = parent.get(&current) {
                if *p == root {
                    break;
                }
                let next = *p;
                parent.insert(current, root);
                current = next;
            }
            root
        };

        let union = |a: StationRef, b: StationRef, parent: &mut HashMap<StationRef, StationRef>| {
            let ra = find(a, parent);
            let rb = find(b, parent);
            if ra != rb {
                parent.insert(ra, rb);
            }
        };

        for merge in &self.station_merges {
            if component.contains(&merge.station_a.section_id)
                && component.contains(&merge.station_b.section_id)
            {
                union(merge.station_a, merge.station_b, &mut parent);
            }
        }

        for closure in closures {
            if component.contains(&closure.station_a.section_id)
                && component.contains(&closure.station_b.section_id)
            {
                union(closure.station_a, closure.station_b, &mut parent);
            }
        }

        let mut groups: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        let mut station_root: HashMap<StationRef, StationRef> = HashMap::new();
        for station in &stations {
            let root = find(*station, &mut parent);
            station_root.insert(*station, root);
            groups.entry(root).or_default().push(*station);
        }

        let zero_datum_set: HashSet<StationRef> = self
            .zero_datums
            .iter()
            .filter(|zd| component.contains(&zd.station_ref.section_id))
            .map(|zd| zd.station_ref)
            .collect();

        let mut fixed_groups: HashSet<StationRef> = HashSet::new();
        let mut fixed_coords: HashMap<StationRef, Coordinates> = HashMap::new();

        for (root, members) in &groups {
            let mut datum_members: Vec<StationRef> = members
                .iter()
                .filter(|m| zero_datum_set.contains(m))
                .copied()
                .collect();
            if datum_members.len() > 1 {
                return Err("Multiple zero datums in a single constraint group".to_string());
            }
            if let Some(datum) = datum_members.pop() {
                let coords = self
                    .compute_station_raw_coords(datum)
                    .ok_or_else(|| "Failed to compute zero datum coordinates".to_string())?;
                fixed_groups.insert(*root);
                fixed_coords.insert(*root, coords);
            }
        }

        if fixed_groups.is_empty() {
            let anchor_root = *station_root
                .get(&anchor_station)
                .ok_or_else(|| "Anchor station not found".to_string())?;
            let coords = self
                .compute_station_raw_coords(anchor_station)
                .ok_or_else(|| "Failed to compute anchor coordinates".to_string())?;
            fixed_groups.insert(anchor_root);
            fixed_coords.insert(anchor_root, coords);
        }

        let mut unknown_index: HashMap<StationRef, usize> = HashMap::new();
        for root in groups.keys() {
            if !fixed_groups.contains(root) {
                let next = unknown_index.len();
                unknown_index.insert(*root, next);
            }
        }

        let n = unknown_index.len();
        if n == 0 {
            return Ok(());
        }

        let mut ata_x = vec![0.0; n * n];
        let mut atb_x = vec![0.0; n];
        let mut ata_y = vec![0.0; n * n];
        let mut atb_y = vec![0.0; n];
        let mut ata_z = vec![0.0; n * n];
        let mut atb_z = vec![0.0; n];

        let add_row = |ata: &mut [f64],
                           atb: &mut [f64],
                           i: Option<usize>,
                           j: Option<usize>,
                           b: f64,
                           w: f64| {
            if !w.is_finite() || w <= 0.0 {
                return;
            }
            match (i, j) {
                (Some(i_idx), Some(j_idx)) => {
                    let ii = i_idx * n + i_idx;
                    let jj = j_idx * n + j_idx;
                    let ij = i_idx * n + j_idx;
                    let ji = j_idx * n + i_idx;
                    ata[ii] += w;
                    ata[jj] += w;
                    ata[ij] -= w;
                    ata[ji] -= w;
                    atb[i_idx] += -w * b;
                    atb[j_idx] += w * b;
                }
                (Some(i_idx), None) => {
                    let ii = i_idx * n + i_idx;
                    ata[ii] += w;
                    atb[i_idx] += -w * b;
                }
                (None, Some(j_idx)) => {
                    let jj = j_idx * n + j_idx;
                    ata[jj] += w;
                    atb[j_idx] += w * b;
                }
                (None, None) => {}
            }
        };

        for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
            let quality = if section.quality.is_finite() && section.quality > 0.0 {
                section.quality
            } else {
                1.0
            };
            let sigma_len = config.base_sigma_length_m * quality;
            let sigma_az = config.base_sigma_azimuth_deg.to_radians() * quality;
            let sigma_depth = config.base_sigma_depth_m * quality;

            for (idx, shot) in section.shots.iter().enumerate() {
                let station_i = StationRef::new(section.id, idx as u32);
                let station_j = StationRef::new(section.id, (idx + 1) as u32);

                let root_i = *station_root
                    .get(&station_i)
                    .ok_or_else(|| "Missing station root".to_string())?;
                let root_j = *station_root
                    .get(&station_j)
                    .ok_or_else(|| "Missing station root".to_string())?;

                if root_i == root_j {
                    continue;
                }

                let vec = Self::shot_vector_along(shot, true);
                let az = shot.average_azimuth().to_radians();
                let len = shot.length;

                let sigma_dx = ((az.sin() * sigma_len).powi(2) + (len * az.cos() * sigma_az).powi(2)).sqrt();
                let sigma_dy = ((az.cos() * sigma_len).powi(2) + (len * az.sin() * sigma_az).powi(2)).sqrt();
                let sigma_dz = sigma_depth;

                let w_x = if sigma_dx > 0.0 { 1.0 / (sigma_dx * sigma_dx) } else { 0.0 };
                let w_y = if sigma_dy > 0.0 { 1.0 / (sigma_dy * sigma_dy) } else { 0.0 };
                let w_z = if sigma_dz > 0.0 { 1.0 / (sigma_dz * sigma_dz) } else { 0.0 };

                let i_idx = unknown_index.get(&root_i).copied();
                let j_idx = unknown_index.get(&root_j).copied();

                let b_x = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.x,
                    (Some(_), None) => {
                        let xj = fixed_coords.get(&root_j).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.x - xj.x
                    }
                    (None, Some(_)) => {
                        let xi = fixed_coords.get(&root_i).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.x + xi.x
                    }
                    (None, None) => 0.0,
                };
                let b_y = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.y,
                    (Some(_), None) => {
                        let yj = fixed_coords.get(&root_j).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.y - yj.y
                    }
                    (None, Some(_)) => {
                        let yi = fixed_coords.get(&root_i).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.y + yi.y
                    }
                    (None, None) => 0.0,
                };
                let b_z = match (i_idx, j_idx) {
                    (Some(_), Some(_)) => vec.z,
                    (Some(_), None) => {
                        let zj = fixed_coords.get(&root_j).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.z - zj.z
                    }
                    (None, Some(_)) => {
                        let zi = fixed_coords.get(&root_i).copied().unwrap_or_else(|| Coordinates::new(0.0, 0.0, 0.0));
                        vec.z + zi.z
                    }
                    (None, None) => 0.0,
                };

                add_row(&mut ata_x, &mut atb_x, i_idx, j_idx, b_x, w_x);
                add_row(&mut ata_y, &mut atb_y, i_idx, j_idx, b_y, w_y);
                add_row(&mut ata_z, &mut atb_z, i_idx, j_idx, b_z, w_z);
            }
        }

        let solve_axis = |ata: Vec<f64>, atb: Vec<f64>| -> Result<Vec<f64>, String> {
            let m = nalgebra::DMatrix::from_row_slice(n, n, &ata);
            let b = nalgebra::DVector::from_row_slice(&atb);
            let sol = m.lu().solve(&b).ok_or_else(|| "Least squares solve failed".to_string())?;
            Ok(sol.as_slice().to_vec())
        };

        let sol_x = solve_axis(ata_x, atb_x)?;
        let sol_y = solve_axis(ata_y, atb_y)?;
        let sol_z = solve_axis(ata_z, atb_z)?;

        let mut group_coords: HashMap<StationRef, Coordinates> = HashMap::new();
        for root in groups.keys() {
            if let Some(coords) = fixed_coords.get(root) {
                group_coords.insert(*root, *coords);
                continue;
            }
            if let Some(idx) = unknown_index.get(root) {
                group_coords.insert(
                    *root,
                    Coordinates::new(sol_x[*idx], sol_y[*idx], sol_z[*idx]),
                );
            }
        }

        let station_offsets = self.station_offsets.clone();

        // Update shots based on solved coordinates
        for section in self.sections.iter_mut().filter(|s| component.contains(&s.id)) {
            for idx in 0..section.shots.len() {
                let station_i = StationRef::new(section.id, idx as u32);
                let station_j = StationRef::new(section.id, (idx + 1) as u32);

                let root_i = *station_root
                    .get(&station_i)
                    .ok_or_else(|| "Missing station root".to_string())?;
                let root_j = *station_root
                    .get(&station_j)
                    .ok_or_else(|| "Missing station root".to_string())?;
                let coords_i = group_coords
                    .get(&root_i)
                    .ok_or_else(|| "Missing solved coordinates".to_string())?;
                let coords_j = group_coords
                    .get(&root_j)
                    .ok_or_else(|| "Missing solved coordinates".to_string())?;

                let offset_i = station_offsets.get(&station_i).copied().unwrap_or((0.0, 0.0, 0.0));
                let offset_j = station_offsets.get(&station_j).copied().unwrap_or((0.0, 0.0, 0.0));

                let base_i = Coordinates::new(coords_i.x - offset_i.0, coords_i.y - offset_i.1, coords_i.z - offset_i.2);
                let base_j = Coordinates::new(coords_j.x - offset_j.0, coords_j.y - offset_j.1, coords_j.z - offset_j.2);
                let forward_vec = Self::coords_sub(base_j, base_i);

                let shot = section
                    .shots
                    .get_mut(idx)
                    .ok_or_else(|| "Shot not found for LSQ update".to_string())?;
                Self::update_shot_from_forward_vector(shot, forward_vec);
            }
        }

        // Align each section's absolute position to solved coordinates (rigid translation).
        // This prevents merged stations in different sections from drifting apart.
        let mut section_deltas: HashMap<SectionId, Coordinates> = HashMap::new();
        let mut section_station_counts: HashMap<SectionId, usize> = HashMap::new();
        for section in self.sections.iter().filter(|s| component.contains(&s.id)) {
            section_station_counts.insert(section.id, section.shots.len());
            let mut delta: Option<Coordinates> = None;
            for idx in 0..=section.shots.len() {
                let station = StationRef::new(section.id, idx as u32);
                let root = *station_root.get(&station).unwrap_or(&station);
                let target = group_coords
                    .get(&root)
                    .ok_or_else(|| "Missing solved coordinates".to_string())?;
                let current = self
                    .compute_station_raw_coords(station)
                    .ok_or_else(|| "Failed to compute station coordinates".to_string())?;
                let d = Self::coords_sub(*target, current);
                if let Some(existing) = delta {
                    if !Self::coords_close(existing, d, 1e-6) {
                        return Err("Least squares adjustment produced inconsistent section translation".to_string());
                    }
                } else {
                    delta = Some(d);
                }
            }
            if let Some(d) = delta {
                if Self::coords_norm(d) > 1e-9 {
                    section_deltas.insert(section.id, d);
                }
            }
        }

        for (section_id, delta) in section_deltas {
            if delta.x.abs() > 1e-9 || delta.y.abs() > 1e-9 {
                let current = self.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
                self.section_offsets.insert(section_id, (current.0 + delta.x, current.1 + delta.y));
            }
            if delta.z.abs() > 1e-9 {
                if let Some(shot_count) = section_station_counts.get(&section_id).copied() {
                    for idx in 0..=shot_count {
                        let station = StationRef::new(section_id, idx as u32);
                        let entry = self.station_offsets.entry(station).or_insert((0.0, 0.0, 0.0));
                        entry.2 += delta.z;
                    }
                }
            }
        }

        Ok(())
    }

    fn recompute_closure_metrics_for_component(&mut self, component: &HashSet<SectionId>) {
        let mut updates = Vec::new();
        for (idx, closure) in self.loop_closures.iter().enumerate() {
            if component.contains(&closure.station_a.section_id)
                && component.contains(&closure.station_b.section_id)
            {
                if let Ok(metrics) =
                    self.compute_closure_metrics(closure.station_a, closure.station_b)
                {
                    updates.push((idx, metrics));
                }
            }
        }

        for (idx, metrics) in updates {
            if let Some(closure) = self.loop_closures.get_mut(idx) {
                closure.path_length = metrics.path_length;
                closure.misclosure_distance = metrics.misclosure_distance;
                closure.error_percentage = metrics.error_percentage;
                closure.horizontal_misclosure = metrics.horizontal_misclosure;
                closure.vertical_misclosure = metrics.vertical_misclosure;
            }
        }
    }

    pub(crate) fn build_section_lookup(&self) -> HashMap<SectionId, &Section> {
        self.sections.iter().map(|s| (s.id, s)).collect()
    }

    pub(crate) fn build_merge_adjacency(
        &self,
        section_lookup: &HashMap<SectionId, &Section>,
    ) -> HashMap<StationRef, Vec<StationRef>> {
        let mut adjacency: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for merge in &self.station_merges {
            if !section_lookup.contains_key(&merge.station_a.section_id)
                || !section_lookup.contains_key(&merge.station_b.section_id)
            {
                continue;
            }
            adjacency.entry(merge.station_a).or_default().push(merge.station_b);
            adjacency.entry(merge.station_b).or_default().push(merge.station_a);
        }
        adjacency
    }

    fn shortest_path_with_target<F>(
        &self,
        start: StationRef,
        is_target: F,
    ) -> Option<(StationRef, HashMap<StationRef, (StationRef, PathEdge)>)>
    where
        F: Fn(StationRef) -> bool,
    {
        let section_lookup = self.build_section_lookup();
        let merge_adj = self.build_merge_adjacency(&section_lookup);

        // Validate start station exists
        let start_section = section_lookup.get(&start.section_id)?;
        if start.station_index as usize > start_section.shots.len() {
            return None;
        }

        let mut dist: HashMap<StationRef, f64> = HashMap::new();
        let mut prev: HashMap<StationRef, (StationRef, PathEdge)> = HashMap::new();
        let mut heap = BinaryHeap::new();

        dist.insert(start, 0.0);
        heap.push(HeapItem { cost: 0.0, node: start });

        while let Some(HeapItem { cost, node }) = heap.pop() {
            if let Some(&known) = dist.get(&node) {
                if cost > known + 1e-9 {
                    continue;
                }
            }

            if is_target(node) {
                return Some((node, prev));
            }

            let Some(section) = section_lookup.get(&node.section_id) else {
                continue;
            };

            // Previous station
            if node.station_index > 0 {
                let prev_index = node.station_index - 1;
                if (prev_index as usize) <= section.shots.len() {
                    let shot_len = section.shots.get(prev_index as usize).map_or(0.0, |s| s.length);
                    let neighbor = StationRef::new(node.section_id, prev_index);
                    let next_cost = cost + shot_len;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        prev.insert(
                            neighbor,
                            (
                                node,
                                PathEdge::Shot {
                                    section_id: node.section_id,
                                    shot_index: prev_index as usize,
                                    forward: false,
                                },
                            ),
                        );
                        heap.push(HeapItem { cost: next_cost, node: neighbor });
                    }
                }
            }

            // Next station
            if (node.station_index as usize) < section.shots.len() {
                let next_index = node.station_index + 1;
                let shot_len = section.shots.get(node.station_index as usize).map_or(0.0, |s| s.length);
                let neighbor = StationRef::new(node.section_id, next_index);
                let next_cost = cost + shot_len;
                if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                    dist.insert(neighbor, next_cost);
                    prev.insert(
                        neighbor,
                        (
                            node,
                            PathEdge::Shot {
                                section_id: node.section_id,
                                shot_index: node.station_index as usize,
                                forward: true,
                            },
                        ),
                    );
                    heap.push(HeapItem { cost: next_cost, node: neighbor });
                }
            }

            // Merge neighbors (zero distance)
            if let Some(neighbors) = merge_adj.get(&node) {
                for &neighbor in neighbors {
                    let next_cost = cost;
                    if dist.get(&neighbor).is_none_or(|&d| next_cost < d - 1e-9) {
                        dist.insert(neighbor, next_cost);
                        prev.insert(neighbor, (node, PathEdge::Merge));
                        heap.push(HeapItem { cost: next_cost, node: neighbor });
                    }
                }
            }
        }

        None
    }

    fn reconstruct_path(
        start: StationRef,
        goal: StationRef,
        prev: &HashMap<StationRef, (StationRef, PathEdge)>,
    ) -> Option<StationPath> {
        let mut steps_rev: Vec<PathStep> = Vec::new();
        let mut current = goal;
        while current != start {
            let (p, edge) = prev.get(&current).copied()?;
            steps_rev.push(PathStep { to: current, edge });
            current = p;
        }
        steps_rev.reverse();
        Some(StationPath { start, steps: steps_rev })
    }

    fn shortest_path_shots_merges(&self, start: StationRef, goal: StationRef) -> Option<StationPath> {
        let (found, prev) = self.shortest_path_with_target(start, |node| node == goal)?;
        Self::reconstruct_path(start, found, &prev)
    }

    fn shortest_path_to_any_zero_datum(&self, start: StationRef) -> Option<(StationRef, StationPath)> {
        if self.zero_datums.is_empty() {
            return None;
        }
        let zero_set: HashSet<StationRef> = self.zero_datums.iter().map(|zd| zd.station_ref).collect();
        let (found, prev) = self.shortest_path_with_target(start, |node| zero_set.contains(&node))?;
        let path = Self::reconstruct_path(start, found, &prev)?;
        Some((found, path))
    }

    fn build_colocated_groups(&self) -> HashMap<StationRef, Vec<StationRef>> {
        let mut parent: HashMap<StationRef, StationRef> = HashMap::new();
        let mut rank: HashMap<StationRef, usize> = HashMap::new();

        for section in &self.sections {
            for idx in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, idx as u32);
                parent.insert(sr, sr);
                rank.insert(sr, 0);
            }
        }

        fn find(
            parent: &mut HashMap<StationRef, StationRef>,
            x: StationRef,
        ) -> StationRef {
            let mut current = x;
            while let Some(&p) = parent.get(&current) {
                if p == current {
                    break;
                }
                current = p;
            }
            let mut node = x;
            while let Some(&p) = parent.get(&node) {
                if p == current {
                    break;
                }
                parent.insert(node, current);
                node = p;
            }
            current
        }

        fn union(
            parent: &mut HashMap<StationRef, StationRef>,
            rank: &mut HashMap<StationRef, usize>,
            a: StationRef,
            b: StationRef,
        ) {
            let ra = find(parent, a);
            let rb = find(parent, b);
            if ra == rb {
                return;
            }
            let rank_a = *rank.get(&ra).unwrap_or(&0);
            let rank_b = *rank.get(&rb).unwrap_or(&0);
            match rank_a.cmp(&rank_b) {
                Ordering::Less => { parent.insert(ra, rb); }
                Ordering::Greater => { parent.insert(rb, ra); }
                Ordering::Equal => {
                    parent.insert(rb, ra);
                    rank.insert(ra, rank_a + 1);
                }
            }
        }

        for merge in &self.station_merges {
            union(&mut parent, &mut rank, merge.station_a, merge.station_b);
        }

        for closure in &self.loop_closures {
            if !closure.is_aligned {
                continue;
            }
            union(&mut parent, &mut rank, closure.station_a, closure.station_b);
        }

        let mut groups: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for section in &self.sections {
            for idx in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, idx as u32);
                let root = find(&mut parent, sr);
                groups.entry(root).or_default().push(sr);
            }
        }

        groups
    }

    fn build_merge_groups(&self) -> HashMap<StationRef, Vec<StationRef>> {
        let mut parent: HashMap<StationRef, StationRef> = HashMap::new();
        let mut rank: HashMap<StationRef, usize> = HashMap::new();

        for section in &self.sections {
            for idx in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, idx as u32);
                parent.insert(sr, sr);
                rank.insert(sr, 0);
            }
        }

        fn find(
            parent: &mut HashMap<StationRef, StationRef>,
            x: StationRef,
        ) -> StationRef {
            let mut current = x;
            while let Some(&p) = parent.get(&current) {
                if p == current {
                    break;
                }
                current = p;
            }
            let mut node = x;
            while let Some(&p) = parent.get(&node) {
                if p == current {
                    break;
                }
                parent.insert(node, current);
                node = p;
            }
            current
        }

        fn union(
            parent: &mut HashMap<StationRef, StationRef>,
            rank: &mut HashMap<StationRef, usize>,
            a: StationRef,
            b: StationRef,
        ) {
            let ra = find(parent, a);
            let rb = find(parent, b);
            if ra == rb {
                return;
            }
            let rank_a = *rank.get(&ra).unwrap_or(&0);
            let rank_b = *rank.get(&rb).unwrap_or(&0);
            match rank_a.cmp(&rank_b) {
                Ordering::Less => { parent.insert(ra, rb); }
                Ordering::Greater => { parent.insert(rb, ra); }
                Ordering::Equal => {
                    parent.insert(rb, ra);
                    rank.insert(ra, rank_a + 1);
                }
            }
        }

        for merge in &self.station_merges {
            union(&mut parent, &mut rank, merge.station_a, merge.station_b);
        }

        let mut groups: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for section in &self.sections {
            for idx in 0..=section.shots.len() {
                let sr = StationRef::new(section.id, idx as u32);
                let root = find(&mut parent, sr);
                groups.entry(root).or_default().push(sr);
            }
        }

        groups
    }

    fn apply_station_move_internal(
        &mut self,
        station_ref: StationRef,
        delta: Coordinates,
    ) -> Result<(), String> {
        if self.zero_datums.iter().any(|zd| zd.station_ref == station_ref)
            && Self::coords_norm(delta) > 1e-9
        {
            error!(
                station_ref = ?station_ref,
                delta = ?delta,
                purpose = "protect zero datum position",
                "Zero datum station move requested outside GPS update"
            );
        }

        let existing = self.station_offsets.get(&station_ref).copied().unwrap_or((0.0, 0.0, 0.0));
        let total_dx = existing.0 + delta.x;
        let total_dy = existing.1 + delta.y;
        let total_dz = existing.2 + delta.z;

        let Some(section) = self.sections.iter_mut().find(|s| s.id == station_ref.section_id) else {
            return Err("Section not found".to_string());
        };

        let idx = station_ref.station_index as usize;
        if idx > section.shots.len() {
            return Err("Invalid station index".to_string());
        }

        if idx == 0 && (total_dx != 0.0 || total_dy != 0.0) {
            let current = self
                .section_offsets
                .get(&station_ref.section_id)
                .copied()
                .unwrap_or((0.0, 0.0));
            self.section_offsets.insert(
                station_ref.section_id,
                (current.0 + total_dx, current.1 + total_dy),
            );
        }

        if idx > 0 {
            if let Some(shot) = section.shots.get_mut(idx - 1) {
                let azi_rad = shot.average_azimuth().to_radians();
                let old_horizontal = shot.horizontal_length();
                let old_dx = old_horizontal * azi_rad.sin();
                let old_dy = old_horizontal * azi_rad.cos();
                let new_dx = old_dx + total_dx;
                let new_dy = old_dy + total_dy;
                let new_horizontal = (new_dx * new_dx + new_dy * new_dy).sqrt();
                let new_dz = (shot.depth_out + total_dz) - shot.depth_in;
                let new_len = (new_horizontal * new_horizontal + new_dz * new_dz).sqrt();
                let new_azi = if new_horizontal > 1e-9 {
                    new_dx.atan2(new_dy).to_degrees().rem_euclid(360.0)
                } else {
                    shot.average_azimuth()
                };
                shot.length = new_len;
                shot.azimuth_in = new_azi;
                shot.azimuth_out = new_azi;
                shot.depth_out += total_dz;
                let pitch = new_dz.atan2(new_horizontal).to_degrees();
                shot.pitch_in = Some(pitch);
                shot.pitch_out = Some(pitch);
            }
        }

        if let Some(shot) = section.shots.get_mut(idx) {
            let azi_rad = shot.average_azimuth().to_radians();
            let old_horizontal = shot.horizontal_length();
            let old_dx = old_horizontal * azi_rad.sin();
            let old_dy = old_horizontal * azi_rad.cos();
            let new_dx = old_dx - total_dx;
            let new_dy = old_dy - total_dy;
            let new_horizontal = (new_dx * new_dx + new_dy * new_dy).sqrt();
            let new_dz = shot.depth_out - (shot.depth_in + total_dz);
            let new_len = (new_horizontal * new_horizontal + new_dz * new_dz).sqrt();
            let new_azi = if new_horizontal > 1e-9 {
                new_dx.atan2(new_dy).to_degrees().rem_euclid(360.0)
            } else {
                shot.average_azimuth()
            };
            shot.length = new_len;
            shot.azimuth_in = new_azi;
            shot.azimuth_out = new_azi;
            shot.depth_in += total_dz;
            let pitch = new_dz.atan2(new_horizontal).to_degrees();
            shot.pitch_in = Some(pitch);
            shot.pitch_out = Some(pitch);
        }

        self.station_offsets.remove(&station_ref);
        Ok(())
    }

    // Deferred: create-time distribution algorithms are disabled; retained for potential future use.
    fn distribute_closure_error_internal(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
        extra_fixed: Option<&HashSet<StationRef>>,
        use_merge_groups: bool,
    ) -> Result<(), String> {
        let colocated_groups = if use_merge_groups {
            self.build_merge_groups()
        } else {
            self.build_colocated_groups()
        };
        let mut station_to_group: HashMap<StationRef, StationRef> = HashMap::new();
        for (root, members) in &colocated_groups {
            for member in members {
                station_to_group.insert(*member, *root);
            }
        }
        let root_for = |station: StationRef| station_to_group.get(&station).copied().unwrap_or(station);
        let mut zero_datum_set: HashSet<StationRef> = self.zero_datums.iter().map(|zd| zd.station_ref).collect();
        if let Some(extra) = extra_fixed {
            zero_datum_set.extend(extra.iter().copied());
        }

        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            strategy = ?strategy,
            use_merge_groups,
            extra_fixed_count = extra_fixed.map_or(0, HashSet::len),
            group_count = colocated_groups.len(),
            zero_datum_count = zero_datum_set.len(),
            purpose = "distribute loop closure error",
            "Starting closure error distribution"
        );

        let is_group_anchored = |station: StationRef, groups: &HashMap<StationRef, Vec<StationRef>>| -> bool {
            let root = groups
                .iter()
                .find(|(_, members)| members.contains(&station))
                .map(|(r, _)| *r);
            if let Some(root) = root {
                if let Some(members) = groups.get(&root) {
                    return members.iter().any(|m| zero_datum_set.contains(m));
                }
            }
            false
        };

        let a_anchored = is_group_anchored(station_a, &colocated_groups);
        let b_anchored = is_group_anchored(station_b, &colocated_groups);

        let (start, end) = if b_anchored && !a_anchored {
            (station_b, station_a)
        } else {
            (station_a, station_b)
        };
        debug!(
            station_a = ?station_a,
            station_b = ?station_b,
            a_anchored,
            b_anchored,
            start = ?start,
            end = ?end,
            purpose = "select closure anchor order",
            "Resolved anchor order for closure distribution"
        );

        let coords_a_orig = self
            .compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute coordinates for station A".to_string())?;
        let coords_b_orig = self
            .compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute coordinates for station B".to_string())?;

        let coords_start = if start == station_a { coords_a_orig } else { coords_b_orig };
        let coords_end = if end == station_a { coords_a_orig } else { coords_b_orig };

        let base_correction = Self::coords_sub(coords_end, coords_start);
        let correction = Self::coords_sub(coords_b_orig, coords_a_orig);
        trace!(
            base_correction = ?base_correction,
            correction = ?correction,
            purpose = "compute closure correction vectors",
            "Computed closure correction vectors"
        );

        let mut targets: HashMap<StationRef, Coordinates> = HashMap::new();
        let section_lookup = self.build_section_lookup();

        let apply_path_targets = |path: &StationPath,
                                      start_coords: Coordinates,
                                      correction_vec: Coordinates,
                                      sign: f64,
                                      total_len: f64,
                                      shot_count: usize,
                                      targets: &mut HashMap<StationRef, Coordinates>|
         -> Result<(), String> {
            let mut current = start_coords;
            let mut current_root = root_for(path.start);
            if let Some(existing) = targets.get(&current_root) {
                if !Self::coords_close(*existing, current, 1e-6) {
                    return Err("Inconsistent target coordinates on path start".to_string());
                }
            } else {
                targets.insert(current_root, current);
            }

            for step in &path.steps {
                let next_root = root_for(step.to);
                if next_root == current_root {
                    continue;
                }
                let vec = match step.edge {
                    PathEdge::Shot {
                        section_id,
                        shot_index,
                        forward,
                    } => {
                        let section = section_lookup
                            .get(&section_id)
                            .ok_or_else(|| "Section not found for closure path".to_string())?;
                        let shot = section
                            .shots
                            .get(shot_index)
                            .ok_or_else(|| "Shot not found for closure path".to_string())?;
                        let mut v = Self::shot_vector_along(shot, forward);
                        let weight = if strategy == ClosureStrategy::ProportionalByLength {
                            shot.length / total_len
                        } else {
                            1.0 / shot_count as f64
                        };
                        let corr = Self::coords_scale(correction_vec, sign * weight);
                        v = Self::coords_add(v, corr);
                        v
                    }
                    PathEdge::Merge => Coordinates::new(0.0, 0.0, 0.0),
                };
                current = Self::coords_add(current, vec);
                if let Some(existing) = targets.get(&next_root) {
                    if !Self::coords_close(*existing, current, 1e-6) {
                        return Err("Inconsistent target coordinates in closure path".to_string());
                    }
                } else {
                    targets.insert(next_root, current);
                }
                current_root = next_root;
            }
            Ok(())
        };

        let add_path_stats = |path: &StationPath, total_len: &mut f64, shot_count: &mut usize| {
            let mut current_root = root_for(path.start);
            for step in &path.steps {
                let next_root = root_for(step.to);
                if next_root == current_root {
                    continue;
                }
                if let PathEdge::Shot { section_id, shot_index, .. } = step.edge {
                    if let Some(section) = section_lookup.get(&section_id) {
                        if let Some(shot) = section.shots.get(shot_index) {
                            *total_len += shot.length;
                            *shot_count += 1;
                        }
                    }
                }
                current_root = next_root;
            }
        };

        let loop_path_ab = self.shortest_path_shots_merges(station_a, station_b);

        if let Some(loop_path) = loop_path_ab {
            // Inspect loop path for zero datum anchors
            let mut zero_nodes: Vec<StationRef> = Vec::new();
            let mut nodes: Vec<StationRef> = Vec::with_capacity(loop_path.steps.len() + 1);
            nodes.push(loop_path.start);
            for step in &loop_path.steps {
                nodes.push(step.to);
            }
            for node in nodes {
                if zero_datum_set.contains(&node) {
                    zero_nodes.push(node);
                }
            }
            zero_nodes.sort_by(|a, b| (a.section_id, a.station_index).cmp(&(b.section_id, b.station_index)));
            zero_nodes.dedup();

            if zero_nodes.len() > 1 {
                return Err("Multiple zero datum stations in closure path".to_string());
            }

            if zero_nodes.len() == 1 && zero_nodes[0] != station_a && zero_nodes[0] != station_b {
                let anchor = zero_nodes[0];
                let path_a = self
                    .shortest_path_shots_merges(anchor, station_a)
                    .ok_or_else(|| "Failed to build path from zero datum to station A".to_string())?;
                let path_b = self
                    .shortest_path_shots_merges(anchor, station_b)
                    .ok_or_else(|| "Failed to build path from zero datum to station B".to_string())?;

                let mut total_len = 0.0;
                let mut shot_count = 0usize;
                add_path_stats(&path_a, &mut total_len, &mut shot_count);
                add_path_stats(&path_b, &mut total_len, &mut shot_count);

                if (strategy == ClosureStrategy::ProportionalByLength && total_len <= 0.0)
                    || (strategy == ClosureStrategy::EqualDistribution && shot_count == 0)
                {
                    return Err("No distributable shots found for zero datum loop path".to_string());
                }

                let coords_anchor = self
                    .compute_station_raw_coords(anchor)
                    .ok_or_else(|| "Failed to compute coordinates for zero datum anchor".to_string())?;

                apply_path_targets(
                    &path_a,
                    coords_anchor,
                    correction,
                    1.0,
                    total_len,
                    shot_count,
                    &mut targets,
                )?;
                apply_path_targets(
                    &path_b,
                    coords_anchor,
                    correction,
                    -1.0,
                    total_len,
                    shot_count,
                    &mut targets,
                )?;
            } else {
                let path = if start == station_a && end == station_b {
                    loop_path
                } else {
                    self.shortest_path_shots_merges(start, end)
                        .ok_or_else(|| "Failed to build closure path".to_string())?
                };

                let mut total_len = 0.0;
                let mut shot_count = 0usize;
                add_path_stats(&path, &mut total_len, &mut shot_count);

                if (strategy == ClosureStrategy::ProportionalByLength && total_len <= 0.0)
                    || (strategy == ClosureStrategy::EqualDistribution && shot_count == 0)
                {
                    warn!(
                        strategy = ?strategy,
                        total_len,
                        shot_count,
                        purpose = "distribute loop closure error",
                        "No distributable shots found for closure path"
                    );
                    return Err("No distributable shots found for closure path".to_string());
                }

                let coords_start = if path.start == station_a { coords_a_orig } else { coords_b_orig };
                apply_path_targets(
                    &path,
                    coords_start,
                    base_correction,
                    -1.0,
                    total_len,
                    shot_count,
                    &mut targets,
                )?;
            }
        } else {
            // Fallback: use zero datum paths
            debug!(
                station_a = ?station_a,
                station_b = ?station_b,
                strategy = ?strategy,
                purpose = "distribute loop closure error",
                "Using zero datum fallback paths for closure distribution"
            );
            let (zd_a, _) = self
                .shortest_path_to_any_zero_datum(station_a)
                .ok_or_else(|| "No zero datum path found from station A".to_string())?;
            let (zd_b, _) = self
                .shortest_path_to_any_zero_datum(station_b)
                .ok_or_else(|| "No zero datum path found from station B".to_string())?;

            let path_a = self
                .shortest_path_shots_merges(zd_a, station_a)
                .ok_or_else(|| "Failed to build path from zero datum to station A".to_string())?;
            let path_b = self
                .shortest_path_shots_merges(zd_b, station_b)
                .ok_or_else(|| "Failed to build path from zero datum to station B".to_string())?;

            let coords_zd_a = self
                .compute_station_raw_coords(zd_a)
                .ok_or_else(|| "Failed to compute coordinates for zero datum A".to_string())?;
            let coords_zd_b = self
                .compute_station_raw_coords(zd_b)
                .ok_or_else(|| "Failed to compute coordinates for zero datum B".to_string())?;

            let mut total_len = 0.0;
            let mut shot_count = 0usize;
            add_path_stats(&path_a, &mut total_len, &mut shot_count);
            add_path_stats(&path_b, &mut total_len, &mut shot_count);

            if (strategy == ClosureStrategy::ProportionalByLength && total_len <= 0.0)
                || (strategy == ClosureStrategy::EqualDistribution && shot_count == 0)
            {
                warn!(
                    strategy = ?strategy,
                    total_len,
                    shot_count,
                    purpose = "distribute loop closure error",
                    "No distributable shots found for zero datum fallback"
                );
                return Err("No distributable shots found for zero datum fallback".to_string());
            }

            apply_path_targets(
                &path_a,
                coords_zd_a,
                correction,
                1.0,
                total_len,
                shot_count,
                &mut targets,
            )?;
            apply_path_targets(
                &path_b,
                coords_zd_b,
                correction,
                -1.0,
                total_len,
                shot_count,
                &mut targets,
            )?;
        }

        let mut group_delta: HashMap<StationRef, Coordinates> = HashMap::new();
        for (root, target) in &targets {
            let current = self
                .compute_station_raw_coords(*root)
                .ok_or_else(|| "Failed to compute station coordinates".to_string())?;
            let delta = Self::coords_sub(*target, current);
            if Self::coords_norm(delta) > 1e-9 {
                group_delta.insert(*root, delta);
            }
        }
        debug!(
            target_count = targets.len(),
            move_group_count = group_delta.len(),
            purpose = "distribute loop closure error",
            "Computed closure target deltas"
        );

        let mut final_deltas: HashMap<StationRef, Coordinates> = HashMap::new();
        for (root, delta) in &group_delta {
            if let Some(members) = colocated_groups.get(root) {
                for member in members {
                    final_deltas.insert(*member, *delta);
                }
            } else {
                final_deltas.insert(*root, *delta);
            }
        }

        // Prevent moving zero datum stations
        for (station, delta) in &final_deltas {
            if zero_datum_set.contains(station) && Self::coords_norm(*delta) > 1e-9 {
                error!(
                    station_ref = ?station,
                    delta = ?delta,
                    strategy = ?strategy,
                    purpose = "protect zero datum position",
                    "Closure distribution would move a zero datum station"
                );
                return Err("Closure distribution would move a zero datum station".to_string());
            }
        }

        // Apply moves
        let mut moves: Vec<(StationRef, Coordinates)> = final_deltas.into_iter().collect();
        moves.sort_by(|a, b| {
            (a.0.section_id, a.0.station_index).cmp(&(b.0.section_id, b.0.station_index))
        });
        for (station, delta) in moves {
            if Self::coords_norm(delta) <= 1e-9 {
                continue;
            }
            self.apply_station_move_internal(station, delta)?;
        }

        // Ensure endpoints overlap exactly
        let coords_a_after = self
            .compute_station_raw_coords(station_a)
            .ok_or_else(|| "Failed to compute station A after distribution".to_string())?;
        let coords_b_after = self
            .compute_station_raw_coords(station_b)
            .ok_or_else(|| "Failed to compute station B after distribution".to_string())?;
        let residual = Self::coords_sub(coords_b_after, coords_a_after);
        if Self::coords_norm(residual) > 1e-6 {
            // Move B's group if possible, otherwise move A's group
            let b_root = colocated_groups
                .iter()
                .find(|(_, members)| members.contains(&station_b))
                .map_or(station_b, |(r, _)| *r);
            let a_root = colocated_groups
                .iter()
                .find(|(_, members)| members.contains(&station_a))
                .map_or(station_a, |(r, _)| *r);

            let b_anchor = colocated_groups
                .get(&b_root)
                .is_some_and(|members| members.iter().any(|m| zero_datum_set.contains(m)));
            let a_anchor = colocated_groups
                .get(&a_root)
                .is_some_and(|members| members.iter().any(|m| zero_datum_set.contains(m)));

            if !b_anchor {
                if let Some(members) = colocated_groups.get(&b_root) {
                    for member in members {
                        self.apply_station_move_internal(*member, Self::coords_scale(residual, -1.0))?;
                    }
                } else {
                    self.apply_station_move_internal(station_b, Self::coords_scale(residual, -1.0))?;
                }
            } else if !a_anchor {
                if let Some(members) = colocated_groups.get(&a_root) {
                    for member in members {
                        self.apply_station_move_internal(*member, residual)?;
                    }
                } else {
                    self.apply_station_move_internal(station_a, residual)?;
                }
            } else {
                error!(
                    residual = ?residual,
                    station_a = ?station_a,
                    station_b = ?station_b,
                    purpose = "align closure endpoints",
                    "Closure distribution failed to align endpoints without moving zero datum"
                );
                return Err("Closure distribution failed to align endpoints".to_string());
            }
        }

        Ok(())
    }

    #[expect(dead_code)]
    fn distribute_closure_error(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    ) -> Result<(), String> {
        self.distribute_closure_error_internal(station_a, station_b, strategy, None, false)
    }

    #[cfg(test)]
    pub(crate) fn test_distribute_closure_error(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        strategy: ClosureStrategy,
    ) -> Result<(), String> {
        self.distribute_closure_error_internal(station_a, station_b, strategy, None, false)
    }

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

        // Check if already connected (via merges or closures) - reject, use CreateLoopClosure instead
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

        // Apply offset to all sections in the moving merge group (rigid body)
        // This repositions the entire moving group relative to the datum coordinate system
        let moving_sections = self.get_merged_section_ids(moving_section_id);
        let moving_has_zero_datum = moving_sections
            .iter()
            .any(|sid| self.zero_datums.iter().any(|zd| zd.station_ref.section_id == *sid));
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
        trace!(
            station_a = ?station_a,
            station_b = ?station_b,
            purpose = "compute closure metrics",
            "Computing closure metrics"
        );
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
            return Err("These stations are already merged. Closures are for unmerged station pairs.".to_string());
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

        let closure = LoopClosure {
            id: next_id,
            station_a,
            station_b,
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
                let neighbor = if merge.station_a == current {
                    Some(merge.station_b)
                } else if merge.station_b == current {
                    Some(merge.station_a)
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

    /// Get all station refs connected to this station via shots and merges (transitive).
    /// All stations in a section are connected via shots, and merges connect stations across sections.
    /// Uses merge-only connectivity (rigid groups) for datum validation.
    fn get_connected_stations(&self, station_ref: StationRef) -> HashSet<StationRef> {
        // Reuse get_merged_section_ids for merge-only section-level traversal
        let connected_sections = self.get_merged_section_ids(station_ref.section_id);

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
            .and_then(|s| s.name.as_ref()).map_or_else(|| format!("Section {}", station_ref.section_id), |name| format!("\"{name}\""));

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
            .is_some_and(|d| d.station_ref == station_ref);

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

        // Apply offset to all connected sections
        for section_id in &connected_sections {
            let current_offset = self.section_offsets.get(section_id).copied().unwrap_or((0.0, 0.0));
            let new_offset = (
                current_offset.0 + offset_delta_x,
                current_offset.1 + offset_delta_y,
            );
            self.section_offsets.insert(*section_id, new_offset);
            trace!(
                section_id = *section_id,
                from = ?current_offset,
                to = ?new_offset,
                purpose = "reposition connected sections",
                "Applied section offset for zero datum"
            );
        }

        // Store the GPS datum
        // Update in-place if datum exists (preserves order/position for stable center)
        let mut updated_existing = false;
        if let Some(existing) = self
            .zero_datums
            .iter_mut()
            .find(|zd| zd.station_ref == station_ref)
        {
            existing.gps = gps;
            updated_existing = true;
        } else {
            self.zero_datums.push(ZeroDatum { station_ref, gps });
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
            .find(|zd| zd.station_ref == station_ref)
        {
            existing.gps = gps;
            updated_existing = true;
        } else {
            self.zero_datums.push(ZeroDatum { station_ref, gps });
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
        self.zero_datums
            .retain(|zd| zd.station_ref != station_ref);
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
        if let Some(current) = self.compute_station_raw_coords(datum.station_ref) {
            let delta_x = target_x - current.x;
            let delta_y = target_y - current.y;
            if delta_x.abs() > 1e-12 || delta_y.abs() > 1e-12 {
                let old = self
                    .section_offsets
                    .get(&datum_section_id)
                    .copied()
                    .unwrap_or((0.0, 0.0));
                self.section_offsets
                    .insert(datum_section_id, (old.0 + delta_x, old.1 + delta_y));
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
                let (this_station, partner_station) =
                    if merge.station_a.section_id == current_section
                        && !visited.contains(&merge.station_b.section_id)
                    {
                        (merge.station_a, merge.station_b)
                    } else if merge.station_b.section_id == current_section
                        && !visited.contains(&merge.station_a.section_id)
                    {
                        (merge.station_b, merge.station_a)
                    } else {
                        continue;
                    };

                let partner_section = partner_station.section_id;
                visited.insert(partner_section);

                // this_station's section is already aligned; partner needs adjustment
                if let (Some(this_pos), Some(partner_pos)) = (
                    self.compute_station_raw_coords(this_station),
                    self.compute_station_raw_coords(partner_station),
                ) {
                    let delta_x = this_pos.x - partner_pos.x;
                    let delta_y = this_pos.y - partner_pos.y;
                    if delta_x.abs() > 1e-12 || delta_y.abs() > 1e-12 {
                        let old = self
                            .section_offsets
                            .get(&partner_section)
                            .copied()
                            .unwrap_or((0.0, 0.0));
                        self.section_offsets
                            .insert(partner_section, (old.0 + delta_x, old.1 + delta_y));
                    }
                }

                queue.push_back(partner_section);
            }
        }
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

        // Pre-compute absolute station depths using colocated groups.
        // Each station's Z is the average of surrounding shot depths across
        // all merge/closure partners — no cumulative dz walk needed.
        let colocated_groups = self.build_colocated_groups();
        let mut station_depths: HashMap<StationRef, f64> = HashMap::new();
        for group in colocated_groups.values() {
            let depth = self.compute_station_depth(group);
            for &sr in group {
                station_depths.insert(sr, depth);
            }
        }

        let mut stations: Vec<Station> = Vec::new();
        let mut station_count = 0u32;

        for section in &self.sections {
            // Get section offset (from merges)
            let (offset_x, offset_y) = self.section_offsets.get(&section.id).copied().unwrap_or((0.0, 0.0));
            let mut current_xy = (offset_x, offset_y);

            // First station of section
            let first_station_ref = StationRef::new(section.id, 0);
            let z = station_depths.get(&first_station_ref).copied().unwrap_or(0.0);
            let mut station_coords = Coordinates::new(current_xy.0, current_xy.1, z);
            // Apply station offset if exists
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

            // Compute subsequent stations from shots (X, Y walk; Z from pre-computed depths)
            for (i, shot) in section.shots.iter().enumerate() {
                let azimuth_rad = shot.average_azimuth().to_radians();
                let horizontal_length = shot.horizontal_length();

                // Compute new X, Y position
                let dx = horizontal_length * azimuth_rad.sin();
                let dy = horizontal_length * azimuth_rad.cos();
                current_xy.0 += dx;
                current_xy.1 += dy;

                let station_ref = StationRef::new(section.id, (i + 1) as u32);
                let z = station_depths.get(&station_ref).copied().unwrap_or(0.0);
                let mut station_coords = Coordinates::new(current_xy.0, current_xy.1, z);
                // Apply station offset if exists
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
        let mut station_to_group: HashMap<StationRef, usize> = HashMap::new();
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
                .get(&a_ref).map_or_else(|| vec![a_ref], |&gid| groups[gid].clone());
            let b_group: Vec<StationRef> = station_to_group
                .get(&b_ref).map_or_else(|| vec![b_ref], |&gid| groups[gid].clone());

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
                        let via = if station.station_ref == a_ref {
                            None
                        } else {
                            Some(a_ref) // transitive: reached via the actual closure endpoint
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
                        let via = if station.station_ref == b_ref {
                            None
                        } else {
                            Some(b_ref)
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

        // Closure-chain transitivity: when a station has direct closures to multiple
        // other stations, those other stations should see transitive closures to each
        // other via the shared station.
        //
        // Example: Station X has closures to Y and Z.
        //   Y should see: transitive closure to Z (via X)
        //   Z should see: transitive closure to Y (via X)
        //
        // The closure_id used is the one connecting the shared station to the far endpoint,
        // so the metrics displayed correspond to that specific loop closure.
        {
            // Collect direct (non-transitive) closure refs for each station
            let mut direct_closures: HashMap<StationRef, Vec<(u64, StationRef)>> =
                HashMap::new();
            for station in &stations {
                for cr in &station.closures_with {
                    if !cr.is_transitive {
                        direct_closures
                            .entry(station.station_ref)
                            .or_default()
                            .push((cr.closure_id, cr.station_ref));
                    }
                }
            }

            // For each station with 2+ direct closures, create chain-transitive refs
            // between all pairs of its closure partners
            let mut chain_transitive_refs: Vec<(StationRef, ClosureRef)> = Vec::new();
            for (shared_ref, endpoints) in &direct_closures {
                if endpoints.len() < 2 {
                    continue;
                }
                for i in 0..endpoints.len() {
                    for j in 0..endpoints.len() {
                        if i == j {
                            continue;
                        }
                        let (_, target_i) = &endpoints[i];
                        let (closure_j, target_j) = &endpoints[j];

                        // target_i should see transitive closure to target_j via shared_ref
                        // using closure_j's id (the closure connecting shared_ref to target_j)
                        if target_i != target_j {
                            chain_transitive_refs.push((
                                *target_i,
                                ClosureRef {
                                    closure_id: *closure_j,
                                    station_ref: *target_j,
                                    via_station: Some(*shared_ref),
                                    is_transitive: true,
                                },
                            ));
                        }
                    }
                }
            }

            // Apply chain-transitive refs, avoiding duplicates
            for (station_ref, new_ref) in chain_transitive_refs {
                if let Some(station) = stations.iter_mut().find(|s| s.station_ref == station_ref) {
                    let already_exists = station.closures_with.iter().any(|cr| {
                        cr.station_ref == new_ref.station_ref
                            && cr.via_station == new_ref.via_station
                    });
                    if !already_exists {
                        station.closures_with.push(new_ref);
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
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));

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

    // ── Frozen shots ─────────────────────────────────────────────────

    /// Build adjacency from aligned loop closures (bidirectional).
    pub(crate) fn build_aligned_closure_adjacency(
        &self,
        section_lookup: &HashMap<SectionId, &Section>,
    ) -> HashMap<StationRef, Vec<StationRef>> {
        let mut adjacency: HashMap<StationRef, Vec<StationRef>> = HashMap::new();
        for closure in &self.loop_closures {
            if !closure.is_aligned {
                continue;
            }
            if !section_lookup.contains_key(&closure.station_a.section_id)
                || !section_lookup.contains_key(&closure.station_b.section_id)
            {
                continue;
            }
            adjacency
                .entry(closure.station_a)
                .or_default()
                .push(closure.station_b);
            adjacency
                .entry(closure.station_b)
                .or_default()
                .push(closure.station_a);
        }
        adjacency
    }

    /// BFS reachability check: can `start` reach any zero datum station,
    /// traversing shots + merges + aligned closures, but excluding one specific shot edge?
    fn can_reach_datum_excluding_shot(
        &self,
        start: StationRef,
        exclude_section_id: SectionId,
        exclude_shot_index: usize,
        section_lookup: &HashMap<SectionId, &Section>,
        merge_adj: &HashMap<StationRef, Vec<StationRef>>,
        closure_adj: &HashMap<StationRef, Vec<StationRef>>,
        datum_stations: &HashSet<StationRef>,
    ) -> bool {
        if datum_stations.contains(&start) {
            return true;
        }

        let mut visited: HashSet<StationRef> = HashSet::new();
        let mut queue: VecDeque<StationRef> = VecDeque::new();
        visited.insert(start);
        queue.push_back(start);

        while let Some(node) = queue.pop_front() {
            let Some(section) = section_lookup.get(&node.section_id) else {
                continue;
            };

            // Adjacent stations via shots (backward: station_index - 1 via shot index-1)
            if node.station_index > 0 {
                let shot_idx = (node.station_index - 1) as usize;
                let is_excluded =
                    node.section_id == exclude_section_id && shot_idx == exclude_shot_index;
                if !is_excluded && shot_idx < section.shots.len() {
                    let neighbor = StationRef::new(node.section_id, node.station_index - 1);
                    if visited.insert(neighbor) {
                        if datum_stations.contains(&neighbor) {
                            return true;
                        }
                        queue.push_back(neighbor);
                    }
                }
            }

            // Adjacent stations via shots (forward: station_index + 1 via shot at station_index)
            if (node.station_index as usize) < section.shots.len() {
                let shot_idx = node.station_index as usize;
                let is_excluded =
                    node.section_id == exclude_section_id && shot_idx == exclude_shot_index;
                if !is_excluded {
                    let neighbor = StationRef::new(node.section_id, node.station_index + 1);
                    if visited.insert(neighbor) {
                        if datum_stations.contains(&neighbor) {
                            return true;
                        }
                        queue.push_back(neighbor);
                    }
                }
            }

            // Merge neighbors
            if let Some(neighbors) = merge_adj.get(&node) {
                for &neighbor in neighbors {
                    if visited.insert(neighbor) {
                        if datum_stations.contains(&neighbor) {
                            return true;
                        }
                        queue.push_back(neighbor);
                    }
                }
            }

            // Aligned closure neighbors
            if let Some(neighbors) = closure_adj.get(&node) {
                for &neighbor in neighbors {
                    if visited.insert(neighbor) {
                        if datum_stations.contains(&neighbor) {
                            return true;
                        }
                        queue.push_back(neighbor);
                    }
                }
            }
        }

        false
    }

    /// Check if a specific shot is frozen.
    /// A shot is frozen when both its endpoints can reach a zero datum station
    /// (excluding the shot itself) via shots, merges, and aligned closures.
    pub(crate) fn is_shot_frozen(
        &self,
        section_id: SectionId,
        shot_index: usize,
        section_lookup: &HashMap<SectionId, &Section>,
        merge_adj: &HashMap<StationRef, Vec<StationRef>>,
        closure_adj: &HashMap<StationRef, Vec<StationRef>>,
        datum_stations: &HashSet<StationRef>,
    ) -> bool {
        if datum_stations.is_empty() {
            return false;
        }

        let station_a = StationRef::new(section_id, shot_index as u32);
        let station_b = StationRef::new(section_id, (shot_index + 1) as u32);

        self.can_reach_datum_excluding_shot(
            station_a,
            section_id,
            shot_index,
            section_lookup,
            merge_adj,
            closure_adj,
            datum_stations,
        ) && self.can_reach_datum_excluding_shot(
            station_b,
            section_id,
            shot_index,
            section_lookup,
            merge_adj,
            closure_adj,
            datum_stations,
        )
    }

    /// Compute all frozen shots for the project.
    pub fn compute_frozen_shots(&self) -> Vec<FrozenShotRef> {
        if self.zero_datums.is_empty() {
            return Vec::new();
        }

        let section_lookup = self.build_section_lookup();
        let merge_adj = self.build_merge_adjacency(&section_lookup);
        let closure_adj = self.build_aligned_closure_adjacency(&section_lookup);
        let datum_stations: HashSet<StationRef> =
            self.zero_datums.iter().map(|d| d.station_ref).collect();

        let mut frozen = Vec::new();
        for section in &self.sections {
            for shot_index in 0..section.shots.len() {
                if self.is_shot_frozen(
                    section.id,
                    shot_index,
                    &section_lookup,
                    &merge_adj,
                    &closure_adj,
                    &datum_stations,
                ) {
                    frozen.push(FrozenShotRef {
                        section_id: section.id,
                        shot_index: shot_index as u32,
                    });
                }
            }
        }
        frozen
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, clippy::float_cmp)]
mod tests;
