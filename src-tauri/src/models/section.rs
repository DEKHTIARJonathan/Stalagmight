use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

use super::{Shot, ShotData, ShotId};

/// Unique identifier for a section
pub type SectionId = u32;

/// Survey direction (In = going into cave, Out = returning)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
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
            _ => Err(format!("Invalid direction: {}", s)),
        }
    }
}

/// A group of consecutive shots collected during a single survey session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    /// Internal immutable ID
    pub id: SectionId,
    /// Optional human-readable name
    pub name: Option<String>,
    /// Surveyor who collected this data
    pub surveyor: Option<String>,
    /// Date of the survey
    pub date: Option<NaiveDate>,
    /// Display color (hex format, e.g., "#4ecdc4")
    pub color: String,
    /// Survey direction (In = entering cave, Out = exiting)
    pub direction: SurveyDirection,
    /// Shots in this section, in order
    pub shots: Vec<Shot>,
    /// Next shot ID to assign
    pub next_shot_id: ShotId,
}

/// Data for creating a new section
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionData {
    pub name: Option<String>,
    pub surveyor: Option<String>,
    pub date: Option<NaiveDate>,
    pub color: String,
    /// Survey direction (defaults to In if not specified)
    #[serde(default)]
    pub direction: Option<SurveyDirection>,
    pub shots: Vec<ShotData>,
}

/// Partial updates to a section
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SectionUpdates {
    #[serde(default)]
    pub name: Option<Option<String>>,
    #[serde(default)]
    pub surveyor: Option<Option<String>>,
    #[serde(default)]
    pub date: Option<Option<NaiveDate>>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub direction: Option<SurveyDirection>,
}

/// Section statistics (computed, not stored)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionStats {
    pub shot_count: usize,
    pub total_length: f64,
    pub min_depth: f64,
    pub max_depth: f64,
    pub virtual_shot_count: usize,
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
            shots: self.shots.iter().map(|s| s.to_shot_data()).collect(),
        }
    }

    /// Add a shot to the end of this section
    pub fn add_shot(&mut self, data: ShotData) -> &Shot {
        let shot = Shot::new(self.next_shot_id, data);
        self.next_shot_id += 1;
        self.shots.push(shot);
        self.shots.last().unwrap()
    }

    /// Insert a shot after a specific shot ID
    pub fn insert_shot_after(&mut self, after_id: ShotId, data: ShotData) -> Option<&Shot> {
        let pos = self.shots.iter().position(|s| s.id == after_id)?;
        let shot = Shot::new(self.next_shot_id, data);
        self.next_shot_id += 1;
        self.shots.insert(pos + 1, shot);
        Some(&self.shots[pos + 1])
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
            self.name = v.clone();
        }
        if let Some(v) = &updates.surveyor {
            self.surveyor = v.clone();
        }
        if let Some(v) = &updates.date {
            self.date = *v;
        }
        if let Some(v) = &updates.color {
            self.color = v.clone();
        }
        if let Some(v) = updates.direction {
            self.direction = v;
        }
    }

    /// Calculate statistics for this section
    pub fn stats(&self) -> SectionStats {
        let mut total_length = 0.0;
        let mut min_depth = f64::MAX;
        let mut max_depth = f64::MIN;
        let mut virtual_count = 0;

        for shot in &self.shots {
            total_length += shot.length;
            min_depth = min_depth.min(shot.depth_in).min(shot.depth_out);
            max_depth = max_depth.max(shot.depth_in).max(shot.depth_out);
            if shot.is_virtual {
                virtual_count += 1;
            }
        }

        if self.shots.is_empty() {
            min_depth = 0.0;
            max_depth = 0.0;
        }

        SectionStats {
            shot_count: self.shots.len(),
            total_length,
            min_depth,
            max_depth,
            virtual_shot_count: virtual_count,
        }
    }
}
