use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use ts_rs::TS;

use super::{Coordinates, GpsCoordinates, Shot, ShotData, ShotId, ShotUpdates, StationRef};

/// Unique identifier for a section
pub type SectionId = u32;

/// Survey direction (In = going into cave, Out = returning)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum SurveyDirection {
    #[default]
    In,
    Out,
}

impl fmt::Display for SurveyDirection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SurveyDirection::In => write!(f, "in"),
            SurveyDirection::Out => write!(f, "out"),
        }
    }
}

impl FromStr for SurveyDirection {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "in" => Ok(SurveyDirection::In),
            "out" => Ok(SurveyDirection::Out),
            _ => Err(format!("Invalid direction: {s}")),
        }
    }
}

/// A group of consecutive shots collected during a single survey session
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Section {
    /// Internal immutable ID
    pub id: SectionId,
    /// Optional human-readable name
    pub name: Option<String>,
    /// Surveyor who collected this data
    pub surveyor: Option<String>,
    /// Date of the survey
    #[ts(type = "string | null")]
    pub date: Option<NaiveDate>,
    /// Display color (hex format, e.g., "#4ecdc4")
    pub color: String,
    /// Survey direction (In = entering cave, Out = exiting)
    pub direction: SurveyDirection,
    /// Quality factor (1.0 = default). Used for weighted adjustments.
    #[serde(default = "default_section_quality")]
    pub quality: f64,
    /// Shots in this section, in order
    pub shots: Vec<Shot>,
    /// Next shot ID to assign
    pub next_shot_id: ShotId,
}

/// Data for creating a new section
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SectionData {
    pub name: Option<String>,
    pub surveyor: Option<String>,
    #[ts(type = "string | null")]
    pub date: Option<NaiveDate>,
    pub color: String,
    /// Survey direction (defaults to In if not specified)
    #[serde(default)]
    pub direction: Option<SurveyDirection>,
    /// Quality factor (1.0 = default). Used for weighted adjustments.
    #[serde(default = "default_section_quality")]
    pub quality: f64,
    pub shots: Vec<ShotData>,
}

/// Partial updates to a section
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct SectionUpdates {
    #[serde(default)]
    #[ts(optional)]
    pub name: Option<Option<String>>,
    #[serde(default)]
    #[ts(optional)]
    pub surveyor: Option<Option<String>>,
    #[serde(default)]
    #[ts(type = "string | null")]
    #[ts(optional)]
    pub date: Option<Option<NaiveDate>>,
    #[serde(default)]
    #[ts(optional)]
    pub color: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub direction: Option<SurveyDirection>,
    #[serde(default)]
    #[ts(optional)]
    pub quality: Option<f64>,
}

/// Section statistics (computed, not stored)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SectionStats {
    pub shot_count: usize,
    pub total_length: f64,
    pub min_depth: f64,
    pub max_depth: f64,
    pub reference_shot_count: usize,
}

/// Configuration for a single section being imported via the batch import command.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ImportSectionConfig {
    /// Index of this section in the import array (used for fromImporting references)
    pub section_index: u32,
    pub name: Option<String>,
    pub surveyor: Option<String>,
    #[ts(type = "string | null")]
    pub date: Option<NaiveDate>,
    pub color: String,
    #[serde(default)]
    pub direction: Option<SurveyDirection>,
    /// Quality factor (1.0 = default). Used for weighted adjustments.
    #[serde(default = "default_section_quality")]
    pub quality: f64,
    pub shots: Vec<ShotData>,
    pub placement: ImportPlacement,
    /// Station comments to apply after section creation.
    /// Each tuple is (station_index, comment_text).
    #[serde(default)]
    pub station_comments: Vec<(u32, String)>,
}

/// Update to apply to an existing section's shot during batch import.
/// Used for overlap interpolation: when an import section overlaps with an
/// existing project section, the overlap shots on the existing side get
/// updated with interpolated values as part of the same atomic transaction.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExistingShotUpdate {
    pub section_id: SectionId,
    pub shot_id: ShotId,
    pub updates: ShotUpdates,
}

/// Placement strategy for an imported section.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ImportPlacement {
    /// Place at origin (0, 0) — no additional operations needed.
    Origin,
    /// Set a GPS zero datum on a specific station.
    ZeroDatum {
        coordinates: GpsCoordinates,
        station_index: u32,
    },
    /// Merge a station with an existing project station.
    FromExisting {
        import_station: u32,
        existing_station: StationRef,
    },
    /// Merge a station with a station in another section being imported in the same batch.
    FromImporting {
        import_station: u32,
        target_section_index: u32,
        target_station_index: u32,
    },
    /// Place at a manual offset (pre-computed by the frontend).
    Manual {
        align_station_index: u32,
        #[serde(default)]
        offset: Option<Coordinates>,
    },
    /// Merge a station with an existing station (manual placement with snap).
    ManualSnap {
        align_station_index: u32,
        snapped_to_station: StationRef,
    },
}

/// A loop closure to create during import, referencing sections by their import index.
#[derive(Debug, Clone)]
pub struct ImportClosure {
    pub from_section_index: u32,
    pub from_station_index: u32,
    pub to_section_index: u32,
    pub to_station_index: u32,
}

impl Default for SectionData {
    fn default() -> Self {
        Self {
            name: None,
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
            direction: None,
            quality: default_section_quality(),
            shots: Vec::new(),
        }
    }
}

fn default_section_quality() -> f64 {
    1.0
}

impl Section {
    /// Create a new section from section data
    pub fn new(id: SectionId, data: SectionData) -> Self {
        let mut section = Self {
            id,
            name: data.name,
            surveyor: data.surveyor,
            date: data.date,
            color: data.color,
            direction: data.direction.unwrap_or_default(),
            quality: if data.quality.is_finite() && data.quality > 0.0 {
                data.quality
            } else {
                default_section_quality()
            },
            shots: Vec::new(),
            next_shot_id: 0,
        };

        for shot_data in data.shots {
            section.add_shot(shot_data);
        }

        section
    }

    /// Create a new section with a specific ID (for undo restoration)
    pub fn new_with_id(id: SectionId, data: SectionData) -> Self {
        Self::new(id, data)
    }

    /// Convert to SectionData (for undo snapshots)
    pub fn to_section_data(&self) -> SectionData {
        SectionData {
            name: self.name.clone(),
            surveyor: self.surveyor.clone(),
            date: self.date,
            color: self.color.clone(),
            direction: Some(self.direction),
            quality: self.quality,
            shots: self.shots.iter().map(Shot::to_shot_data).collect(),
        }
    }

    /// Add a shot to the end of this section
    pub fn add_shot(&mut self, data: ShotData) -> &Shot {
        let shot = Shot::new(self.next_shot_id, data);
        self.next_shot_id += 1;
        self.shots.push(shot);
        let idx = self.shots.len() - 1;
        &self.shots[idx]
    }

    /// Insert a shot after a specific shot ID
    pub fn insert_shot_after(&mut self, after_id: ShotId, data: ShotData) -> Option<&Shot> {
        let pos = self.shots.iter().position(|s| s.id == after_id)?;
        let shot = Shot::new(self.next_shot_id, data);
        self.next_shot_id += 1;
        self.shots.insert(pos + 1, shot);
        Some(&self.shots[pos + 1])
    }

    /// Insert a shot before a specific shot ID
    pub fn insert_shot_before(&mut self, before_id: ShotId, data: ShotData) -> Option<&Shot> {
        let pos = self.shots.iter().position(|s| s.id == before_id)?;
        let shot = Shot::new(self.next_shot_id, data);
        self.next_shot_id += 1;
        self.shots.insert(pos, shot);
        Some(&self.shots[pos])
    }

    /// Get a shot by ID
    pub fn get_shot(&self, shot_id: ShotId) -> Option<&Shot> {
        self.shots.iter().find(|s| s.id == shot_id)
    }

    /// Get a mutable reference to a shot by ID
    pub fn get_shot_mut(&mut self, shot_id: ShotId) -> Option<&mut Shot> {
        self.shots.iter_mut().find(|s| s.id == shot_id)
    }

    /// Remove a shot by ID, returns the removed shot if found
    pub fn remove_shot(&mut self, shot_id: ShotId) -> Option<Shot> {
        let pos = self.shots.iter().position(|s| s.id == shot_id)?;
        Some(self.shots.remove(pos))
    }

    /// Apply partial updates to this section
    pub fn apply_updates(&mut self, updates: &SectionUpdates) {
        if let Some(v) = &updates.name {
            self.name.clone_from(v);
        }
        if let Some(v) = &updates.surveyor {
            self.surveyor.clone_from(v);
        }
        if let Some(v) = &updates.date {
            self.date = *v;
        }
        if let Some(v) = &updates.color {
            self.color.clone_from(v);
        }
        if let Some(v) = updates.direction {
            self.direction = v;
        }
        if let Some(v) = updates.quality {
            if v.is_finite() && v > 0.0 {
                self.quality = v;
            } else {
                self.quality = default_section_quality();
            }
        }
    }

    /// Split shots at the given shot ID, excluding the target shot.
    /// Returns `(position, shots_before, shots_after)` where position is the index of the
    /// target shot. Returns `None` if the shot is first or last (edge shots don't split),
    /// or if the shot is not found.
    pub fn split_shots_at(&self, shot_id: ShotId) -> Option<(usize, Vec<ShotData>, Vec<ShotData>)> {
        let pos = self.shots.iter().position(|s| s.id == shot_id)?;

        // Edge shots cannot split
        if pos == 0 || pos == self.shots.len() - 1 {
            return None;
        }

        let shots_before: Vec<ShotData> = self.shots[..pos].iter().map(Shot::to_shot_data).collect();
        let shots_after: Vec<ShotData> = self.shots[pos + 1..].iter().map(Shot::to_shot_data).collect();

        Some((pos, shots_before, shots_after))
    }

    /// Calculate statistics for this section
    /// Note: min_depth and max_depth are computed from accumulated z-coordinates
    /// (like station positions) not from raw shot depth_in/depth_out values.
    pub fn stats(&self) -> SectionStats {
        let mut total_length = 0.0;
        let mut reference_count = 0;

        // Compute min/max from accumulated z-coordinates (station depths)
        // First station starts at z=0
        let mut current_z: f64 = 0.0;
        let mut min_depth: f64 = 0.0;
        let mut max_depth: f64 = 0.0;

        for shot in &self.shots {
            total_length += shot.length;
            if shot.is_reference {
                reference_count += 1;
            }

            // Accumulate depth change (same as station computation)
            current_z += shot.depth_out - shot.depth_in;
            min_depth = min_depth.min(current_z);
            max_depth = max_depth.max(current_z);
        }

        SectionStats {
            shot_count: self.shots.len(),
            total_length,
            min_depth,
            max_depth,
            reference_shot_count: reference_count,
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::float_cmp)]
mod tests {
    use super::*;
    use crate::models::ShotData;

    // === SurveyDirection Tests ===

    #[test]
    fn test_survey_direction_default() {
        let direction: SurveyDirection = SurveyDirection::default();
        assert_eq!(direction, SurveyDirection::In);
    }

    #[test]
    fn test_survey_direction_display() {
        assert_eq!(format!("{}", SurveyDirection::In), "in");
        assert_eq!(format!("{}", SurveyDirection::Out), "out");
    }

    #[test]
    fn test_survey_direction_from_str_valid() {
        assert_eq!(SurveyDirection::from_str("in").unwrap(), SurveyDirection::In);
        assert_eq!(SurveyDirection::from_str("In").unwrap(), SurveyDirection::In);
        assert_eq!(SurveyDirection::from_str("IN").unwrap(), SurveyDirection::In);
        assert_eq!(SurveyDirection::from_str("out").unwrap(), SurveyDirection::Out);
        assert_eq!(SurveyDirection::from_str("Out").unwrap(), SurveyDirection::Out);
        assert_eq!(SurveyDirection::from_str("OUT").unwrap(), SurveyDirection::Out);
    }

    #[test]
    fn test_survey_direction_from_str_invalid() {
        let result = SurveyDirection::from_str("invalid");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid direction"));
    }

    #[test]
    fn test_survey_direction_serde_roundtrip() {
        let direction_in = SurveyDirection::In;
        let serialized = serde_json::to_string(&direction_in).unwrap();
        assert_eq!(serialized, "\"in\"");
        let deserialized: SurveyDirection = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, direction_in);

        let direction_out = SurveyDirection::Out;
        let serialized = serde_json::to_string(&direction_out).unwrap();
        assert_eq!(serialized, "\"out\"");
        let deserialized: SurveyDirection = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, direction_out);
    }

    // === SectionData Tests ===

    #[test]
    fn test_section_data_default() {
        let data = SectionData::default();
        assert!(data.name.is_none());
        assert!(data.surveyor.is_none());
        assert!(data.date.is_none());
        assert_eq!(data.color, "#4ecdc4");
        assert!(data.direction.is_none());
        assert!(data.shots.is_empty());
    }

    // === Helper Functions ===

    fn test_shot_data(length: f64) -> ShotData {
        ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length,
            depth_in: 10.0,
            depth_out: 11.0,
            ..Default::default()
        }
    }

    fn test_shot_data_with_depths(length: f64, depth_in: f64, depth_out: f64) -> ShotData {
        ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length,
            depth_in,
            depth_out,
            ..Default::default()
        }
    }

    fn test_reference_shot_data(length: f64) -> ShotData {
        ShotData {
            azimuth_in: 0.0,
            azimuth_out: 180.0,
            length,
            depth_in: 5.0,
            depth_out: 5.0,
            is_reference: true,
            ..Default::default()
        }
    }

    // === Section Creation Tests ===

    #[test]
    fn test_section_new_empty() {
        let section = Section::new(1, SectionData::default());

        assert_eq!(section.id, 1);
        assert!(section.name.is_none());
        assert!(section.surveyor.is_none());
        assert!(section.date.is_none());
        assert_eq!(section.color, "#4ecdc4");
        assert_eq!(section.direction, SurveyDirection::In);
        assert!(section.shots.is_empty());
        assert_eq!(section.next_shot_id, 0);
    }

    #[test]
    fn test_section_new_with_metadata() {
        let date = NaiveDate::from_ymd_opt(2024, 6, 15).unwrap();
        let data = SectionData {
            name: Some("Test Section".to_string()),
            surveyor: Some("John Doe".to_string()),
            date: Some(date),
            color: "#ff5733".to_string(),
            direction: Some(SurveyDirection::Out),
            quality: 1.0,
            shots: vec![],
        };

        let section = Section::new(42, data);

        assert_eq!(section.id, 42);
        assert_eq!(section.name, Some("Test Section".to_string()));
        assert_eq!(section.surveyor, Some("John Doe".to_string()));
        assert_eq!(section.date, Some(date));
        assert_eq!(section.color, "#ff5733");
        assert_eq!(section.direction, SurveyDirection::Out);
    }

    #[test]
    fn test_section_new_with_shots() {
        let data = SectionData {
            shots: vec![test_shot_data(5.0), test_shot_data(7.0), test_shot_data(3.0)],
            ..Default::default()
        };

        let section = Section::new(0, data);

        assert_eq!(section.shots.len(), 3);
        assert_eq!(section.shots[0].id, 0);
        assert_eq!(section.shots[1].id, 1);
        assert_eq!(section.shots[2].id, 2);
        assert_eq!(section.next_shot_id, 3);

        assert_eq!(section.shots[0].length, 5.0);
        assert_eq!(section.shots[1].length, 7.0);
        assert_eq!(section.shots[2].length, 3.0);
    }

    #[test]
    fn test_section_new_with_id() {
        let data = SectionData {
            name: Some("Restored Section".to_string()),
            ..Default::default()
        };

        let section = Section::new_with_id(100, data);

        assert_eq!(section.id, 100);
        assert_eq!(section.name, Some("Restored Section".to_string()));
    }

    #[test]
    fn test_section_direction_defaults_to_in() {
        let data = SectionData {
            direction: None,
            ..Default::default()
        };

        let section = Section::new(0, data);
        assert_eq!(section.direction, SurveyDirection::In);
    }

    // === Shot Management Tests ===

    #[test]
    fn test_add_shot() {
        let mut section = Section::new(0, SectionData::default());

        let shot = section.add_shot(test_shot_data(10.0));

        assert_eq!(shot.id, 0);
        assert_eq!(shot.length, 10.0);
        assert_eq!(section.shots.len(), 1);
        assert_eq!(section.next_shot_id, 1);
    }

    #[test]
    fn test_add_multiple_shots() {
        let mut section = Section::new(0, SectionData::default());

        section.add_shot(test_shot_data(5.0));
        section.add_shot(test_shot_data(7.0));
        section.add_shot(test_shot_data(3.0));

        assert_eq!(section.shots.len(), 3);
        assert_eq!(section.next_shot_id, 3);
        assert_eq!(section.shots[0].id, 0);
        assert_eq!(section.shots[1].id, 1);
        assert_eq!(section.shots[2].id, 2);
    }

    #[test]
    fn test_insert_shot_after() {
        let mut section = Section::new(0, SectionData {
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
            ..Default::default()
        });

        // Insert after shot 0
        let inserted = section.insert_shot_after(0, test_shot_data(10.0));

        assert!(inserted.is_some());
        let inserted = inserted.unwrap();
        assert_eq!(inserted.id, 2); // IDs continue from next_shot_id
        assert_eq!(inserted.length, 10.0);

        assert_eq!(section.shots.len(), 3);
        assert_eq!(section.shots[0].length, 5.0);
        assert_eq!(section.shots[1].length, 10.0); // New shot
        assert_eq!(section.shots[2].length, 7.0);
    }

    #[test]
    fn test_insert_shot_after_nonexistent() {
        let mut section = Section::new(0, SectionData {
            shots: vec![test_shot_data(5.0)],
            ..Default::default()
        });

        let result = section.insert_shot_after(999, test_shot_data(10.0));

        assert!(result.is_none());
        assert_eq!(section.shots.len(), 1); // Unchanged
    }

    #[test]
    fn test_get_shot() {
        let section = Section::new(0, SectionData {
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
            ..Default::default()
        });

        let shot = section.get_shot(1);
        assert!(shot.is_some());
        assert_eq!(shot.unwrap().length, 7.0);

        let nonexistent = section.get_shot(999);
        assert!(nonexistent.is_none());
    }

    #[test]
    fn test_get_shot_mut() {
        let mut section = Section::new(0, SectionData {
            shots: vec![test_shot_data(5.0)],
            ..Default::default()
        });

        {
            let shot = section.get_shot_mut(0);
            assert!(shot.is_some());
            shot.unwrap().length = 15.0;
        }

        assert_eq!(section.shots[0].length, 15.0);
    }

    #[test]
    fn test_remove_shot() {
        let mut section = Section::new(0, SectionData {
            shots: vec![test_shot_data(5.0), test_shot_data(7.0), test_shot_data(3.0)],
            ..Default::default()
        });

        let removed = section.remove_shot(1);

        assert!(removed.is_some());
        assert_eq!(removed.unwrap().length, 7.0);
        assert_eq!(section.shots.len(), 2);
        assert_eq!(section.shots[0].length, 5.0);
        assert_eq!(section.shots[1].length, 3.0);
    }

    #[test]
    fn test_remove_shot_nonexistent() {
        let mut section = Section::new(0, SectionData {
            shots: vec![test_shot_data(5.0)],
            ..Default::default()
        });

        let result = section.remove_shot(999);

        assert!(result.is_none());
        assert_eq!(section.shots.len(), 1);
    }

    // === Section Update Tests ===

    #[test]
    fn test_apply_updates_name() {
        let mut section = Section::new(0, SectionData::default());

        section.apply_updates(&SectionUpdates {
            name: Some(Some("New Name".to_string())),
            ..Default::default()
        });

        assert_eq!(section.name, Some("New Name".to_string()));
    }

    #[test]
    fn test_apply_updates_clear_name() {
        let mut section = Section::new(0, SectionData {
            name: Some("Original".to_string()),
            ..Default::default()
        });

        section.apply_updates(&SectionUpdates {
            name: Some(None), // Set to None
            ..Default::default()
        });

        assert!(section.name.is_none());
    }

    #[test]
    fn test_apply_updates_all_fields() {
        let mut section = Section::new(0, SectionData::default());
        let new_date = NaiveDate::from_ymd_opt(2024, 12, 25).unwrap();

        section.apply_updates(&SectionUpdates {
            name: Some(Some("Updated".to_string())),
            surveyor: Some(Some("Jane".to_string())),
            date: Some(Some(new_date)),
            color: Some("#abc123".to_string()),
            direction: Some(SurveyDirection::Out),
            quality: Some(1.5),
        });

        assert_eq!(section.name, Some("Updated".to_string()));
        assert_eq!(section.surveyor, Some("Jane".to_string()));
        assert_eq!(section.date, Some(new_date));
        assert_eq!(section.color, "#abc123");
        assert_eq!(section.direction, SurveyDirection::Out);
        assert_eq!(section.quality, 1.5);
    }

    #[test]
    fn test_apply_updates_partial() {
        let mut section = Section::new(0, SectionData {
            name: Some("Original".to_string()),
            surveyor: Some("Original Surveyor".to_string()),
            color: "#000000".to_string(),
            ..Default::default()
        });

        // Only update color
        section.apply_updates(&SectionUpdates {
            color: Some("#ffffff".to_string()),
            ..Default::default()
        });

        assert_eq!(section.name, Some("Original".to_string())); // Unchanged
        assert_eq!(section.surveyor, Some("Original Surveyor".to_string())); // Unchanged
        assert_eq!(section.color, "#ffffff"); // Changed
    }

    // === Section Statistics Tests ===

    #[test]
    fn test_stats_empty_section() {
        let section = Section::new(0, SectionData::default());
        let stats = section.stats();

        assert_eq!(stats.shot_count, 0);
        assert_eq!(stats.total_length, 0.0);
        assert_eq!(stats.min_depth, 0.0);
        assert_eq!(stats.max_depth, 0.0);
        assert_eq!(stats.reference_shot_count, 0);
    }

    #[test]
    fn test_stats_single_shot() {
        // Shot with depth_in=5.0, depth_out=8.0 → dz=3.0
        // Station 0: z=0, Station 1: z=3.0
        let section = Section::new(0, SectionData {
            shots: vec![test_shot_data_with_depths(10.0, 5.0, 8.0)],
            ..Default::default()
        });

        let stats = section.stats();

        assert_eq!(stats.shot_count, 1);
        assert_eq!(stats.total_length, 10.0);
        assert_eq!(stats.min_depth, 0.0); // First station at z=0
        assert_eq!(stats.max_depth, 3.0); // Second station at z=3 (depth_out - depth_in)
        assert_eq!(stats.reference_shot_count, 0);
    }

    #[test]
    fn test_stats_multiple_shots() {
        // Shot 1: dz = 12-10 = 2, z: 0→2
        // Shot 2: dz = 15-12 = 3, z: 2→5
        // Shot 3: dz = 8-15 = -7, z: 5→-2
        let section = Section::new(0, SectionData {
            shots: vec![
                test_shot_data_with_depths(5.0, 10.0, 12.0),
                test_shot_data_with_depths(7.0, 12.0, 15.0),
                test_shot_data_with_depths(3.0, 15.0, 8.0),
            ],
            ..Default::default()
        });

        let stats = section.stats();

        assert_eq!(stats.shot_count, 3);
        assert_eq!(stats.total_length, 15.0); // 5 + 7 + 3
        assert_eq!(stats.min_depth, -2.0); // Station 3 at z=-2
        assert_eq!(stats.max_depth, 5.0);  // Station 2 at z=5
    }

    #[test]
    fn test_stats_with_reference_shots() {
        let section = Section::new(0, SectionData {
            shots: vec![
                test_shot_data(5.0),
                test_reference_shot_data(3.0),
                test_shot_data(7.0),
                test_reference_shot_data(2.0),
            ],
            ..Default::default()
        });

        let stats = section.stats();

        assert_eq!(stats.shot_count, 4);
        assert_eq!(stats.total_length, 17.0); // 5 + 3 + 7 + 2
        assert_eq!(stats.reference_shot_count, 2);
    }

    #[test]
    fn test_stats_negative_depths() {
        // Shot 1: dz = -5 - (-10) = 5, z: 0→5
        // Shot 2: dz = 2 - (-5) = 7, z: 5→12
        let section = Section::new(0, SectionData {
            shots: vec![
                test_shot_data_with_depths(5.0, -10.0, -5.0),
                test_shot_data_with_depths(3.0, -5.0, 2.0),
            ],
            ..Default::default()
        });

        let stats = section.stats();

        assert_eq!(stats.min_depth, 0.0);  // First station at z=0
        assert_eq!(stats.max_depth, 12.0); // Last station at z=12
    }

    // === Section Data Conversion Tests ===

    #[test]
    fn test_to_section_data() {
        let date = NaiveDate::from_ymd_opt(2024, 6, 15).unwrap();
        let original_data = SectionData {
            name: Some("Test".to_string()),
            surveyor: Some("John".to_string()),
            date: Some(date),
            color: "#ff0000".to_string(),
            direction: Some(SurveyDirection::Out),
            quality: 1.0,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        };

        let section = Section::new(1, original_data);
        let converted = section.to_section_data();

        assert_eq!(converted.name, Some("Test".to_string()));
        assert_eq!(converted.surveyor, Some("John".to_string()));
        assert_eq!(converted.date, Some(date));
        assert_eq!(converted.color, "#ff0000");
        assert_eq!(converted.direction, Some(SurveyDirection::Out));
        assert_eq!(converted.shots.len(), 2);
        assert_eq!(converted.shots[0].length, 5.0);
        assert_eq!(converted.shots[1].length, 7.0);
    }

    #[test]
    fn test_to_section_data_roundtrip() {
        let date = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let original_data = SectionData {
            name: Some("Roundtrip Test".to_string()),
            surveyor: Some("Tester".to_string()),
            date: Some(date),
            color: "#123456".to_string(),
            direction: Some(SurveyDirection::In),
            quality: 1.0,
            shots: vec![
                ShotData {
                    azimuth_in: 90.0,
                    azimuth_out: 270.0,
                    length: 10.0,
                    depth_in: 5.0,
                    depth_out: 8.0,
                    left: Some(1.0),
                    right: Some(2.0),
                    up: Some(3.0),
                    down: Some(4.0),
                    comment: Some("Test comment".to_string()),
                    ..Default::default()
                },
            ],
        };

        let section = Section::new(0, original_data);
        let converted = section.to_section_data();
        let restored = Section::new(0, converted);

        assert_eq!(restored.name, section.name);
        assert_eq!(restored.surveyor, section.surveyor);
        assert_eq!(restored.date, section.date);
        assert_eq!(restored.color, section.color);
        assert_eq!(restored.direction, section.direction);
        assert_eq!(restored.shots.len(), section.shots.len());
        assert_eq!(restored.shots[0].length, section.shots[0].length);
        assert_eq!(restored.shots[0].comment, section.shots[0].comment);
    }

    // === SectionUpdates Serde Tests ===

    #[test]
    fn test_section_updates_default() {
        let updates = SectionUpdates::default();

        assert!(updates.name.is_none());
        assert!(updates.surveyor.is_none());
        assert!(updates.date.is_none());
        assert!(updates.color.is_none());
        assert!(updates.direction.is_none());
    }

    #[test]
    fn test_section_updates_serde() {
        let updates = SectionUpdates {
            name: Some(Some("Updated Name".to_string())),
            color: Some("#aabbcc".to_string()),
            ..Default::default()
        };

        let json = serde_json::to_string(&updates).unwrap();
        let deserialized: SectionUpdates = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.name, Some(Some("Updated Name".to_string())));
        assert_eq!(deserialized.color, Some("#aabbcc".to_string()));
        assert!(deserialized.surveyor.is_none());
    }

    // === SectionStats Tests ===

    #[test]
    fn test_section_stats_clone() {
        let section = Section::new(0, SectionData {
            shots: vec![test_shot_data(10.0)],
            ..Default::default()
        });

        let stats = section.stats();
        let cloned = stats.clone();

        assert_eq!(cloned.shot_count, stats.shot_count);
        assert_eq!(cloned.total_length, stats.total_length);
    }

    #[test]
    fn test_section_stats_serde() {
        let stats = SectionStats {
            shot_count: 5,
            total_length: 42.5,
            min_depth: 3.0,
            max_depth: 25.0,
            reference_shot_count: 1,
        };

        let json = serde_json::to_string(&stats).unwrap();
        let deserialized: SectionStats = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.shot_count, 5);
        assert_eq!(deserialized.total_length, 42.5);
        assert_eq!(deserialized.min_depth, 3.0);
        assert_eq!(deserialized.max_depth, 25.0);
        assert_eq!(deserialized.reference_shot_count, 1);
    }

    // === Split Shots Tests ===

    #[test]
    fn test_split_shots_at_middle() {
        // 5-shot section, split at index 2 -> A has 2 shots, B has 2 shots
        let section = Section::new(0, SectionData {
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(7.0),
                test_shot_data(3.0), // shot to delete (index 2)
                test_shot_data(4.0),
                test_shot_data(6.0),
            ],
            ..Default::default()
        });

        let shot_id = section.shots[2].id; // middle shot
        let result = section.split_shots_at(shot_id);
        assert!(result.is_some());

        let (pos, before, after) = result.unwrap();
        assert_eq!(pos, 2);
        assert_eq!(before.len(), 2);
        assert_eq!(after.len(), 2);
        assert_eq!(before[0].length, 5.0);
        assert_eq!(before[1].length, 7.0);
        assert_eq!(after[0].length, 4.0);
        assert_eq!(after[1].length, 6.0);
    }

    #[test]
    fn test_split_shots_rejects_first_shot() {
        let section = Section::new(0, SectionData {
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(7.0),
                test_shot_data(3.0),
            ],
            ..Default::default()
        });

        let first_shot_id = section.shots[0].id;
        assert!(section.split_shots_at(first_shot_id).is_none());
    }

    #[test]
    fn test_split_shots_rejects_last_shot() {
        let section = Section::new(0, SectionData {
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(7.0),
                test_shot_data(3.0),
            ],
            ..Default::default()
        });

        let last_shot_id = section.shots[2].id;
        assert!(section.split_shots_at(last_shot_id).is_none());
    }

    #[test]
    fn test_split_shots_rejects_nonexistent() {
        let section = Section::new(0, SectionData {
            shots: vec![test_shot_data(5.0)],
            ..Default::default()
        });

        assert!(section.split_shots_at(999).is_none());
    }

    #[test]
    fn test_split_shots_at_index_1_of_3() {
        // 3-shot section, split at index 1 -> A has 1 shot, B has 1 shot
        let section = Section::new(0, SectionData {
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(7.0), // shot to delete
                test_shot_data(3.0),
            ],
            ..Default::default()
        });

        let shot_id = section.shots[1].id;
        let result = section.split_shots_at(shot_id);
        assert!(result.is_some());

        let (pos, before, after) = result.unwrap();
        assert_eq!(pos, 1);
        assert_eq!(before.len(), 1);
        assert_eq!(after.len(), 1);
        assert_eq!(before[0].length, 5.0);
        assert_eq!(after[0].length, 3.0);
    }
}
