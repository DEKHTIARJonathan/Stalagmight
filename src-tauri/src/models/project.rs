use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::{
    ClosureStrategy, Coordinates, GpsCoordinates, Section, SectionData, SectionId, SectionUpdates,
    Shot, ShotData, ShotId, ShotUpdates, Station, StationMerge, StationRef, ZeroDatum,
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
    /// File path if saved (None for new unsaved projects)
    pub file_path: Option<PathBuf>,
    /// Next section ID to assign
    pub next_section_id: SectionId,
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
            file_path: None,
            next_section_id: 0,
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

    /// Merge two stations
    pub fn merge_stations(
        &mut self,
        station_a: StationRef,
        station_b: StationRef,
        _strategy: ClosureStrategy,
    ) -> bool {
        // Check that both stations exist
        if !self.station_exists(station_a) || !self.station_exists(station_b) {
            return false;
        }

        // Check not already merged
        if self.are_stations_merged(station_a, station_b) {
            return false;
        }

        // Record the merge
        self.station_merges.push(StationMerge {
            station_a,
            station_b,
            merged_at: Utc::now(),
        });

        self.touch();
        true
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

    /// Set a station as the zero datum
    pub fn set_zero_datum(&mut self, station_ref: StationRef, gps: GpsCoordinates) -> bool {
        if !self.station_exists(station_ref) {
            return false;
        }

        // Remove any existing zero datum for this station
        self.zero_datums
            .retain(|zd| zd.station_ref != station_ref);

        self.zero_datums.push(ZeroDatum { station_ref, gps });
        self.touch();
        true
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
            let mut current_coords = Coordinates::default();

            // Find if this section's first station is merged with an anchored station
            // For now, just start from origin if not connected
            // TODO: Implement full graph traversal for connected sections

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

        // Loop count = number of station merges (simplified)
        let loop_count = self.station_merges.len();

        ProjectStats {
            section_count: self.sections.len(),
            shot_count,
            total_length,
            min_depth,
            max_depth,
            station_count,
            loop_count,
        }
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
