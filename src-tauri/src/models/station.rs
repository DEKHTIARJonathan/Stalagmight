use serde::{Deserialize, Serialize};

use super::SectionId;

/// Reference to a station using section_id:station_index format
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StationRef {
    pub section_id: SectionId,
    pub station_index: u32,
}

impl StationRef {
    pub fn new(section_id: SectionId, station_index: u32) -> Self {
        Self {
            section_id,
            station_index,
        }
    }
}

impl std::fmt::Display for StationRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.section_id, self.station_index)
    }
}

/// GPS coordinates in WGS84 format
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct GpsCoordinates {
    pub latitude: f64,
    pub longitude: f64,
    /// Depth reference (meters below surface)
    pub depth_reference: f64,
}

/// Internal XYZ coordinates (meters)
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Coordinates {
    /// X = East (meters)
    pub x: f64,
    /// Y = North (meters)
    pub y: f64,
    /// Z = Depth (meters, positive = below surface)
    pub z: f64,
}

impl Coordinates {
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    /// Calculate distance to another coordinate
    pub fn distance_to(&self, other: &Coordinates) -> f64 {
        let dx = other.x - self.x;
        let dy = other.y - self.y;
        let dz = other.z - self.z;
        (dx * dx + dy * dy + dz * dz).sqrt()
    }

    /// Calculate 2D horizontal distance to another coordinate
    pub fn horizontal_distance_to(&self, other: &Coordinates) -> f64 {
        let dx = other.x - self.x;
        let dy = other.y - self.y;
        (dx * dx + dy * dy).sqrt()
    }
}

/// A computed station in the cave survey
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Station {
    /// Reference to this station
    pub station_ref: StationRef,
    /// Computed coordinates (or GPS-assigned)
    pub coordinates: Coordinates,
    /// Whether this station has GPS coordinates assigned
    pub is_zero_datum: bool,
    /// GPS coordinates if this is a zero datum
    pub gps_coordinates: Option<GpsCoordinates>,
    /// Other stations merged with this one
    pub merged_with: Vec<StationRef>,
}

impl Station {
    pub fn new(station_ref: StationRef) -> Self {
        Self {
            station_ref,
            coordinates: Coordinates::default(),
            is_zero_datum: false,
            gps_coordinates: None,
            merged_with: Vec::new(),
        }
    }

    pub fn with_coordinates(station_ref: StationRef, coordinates: Coordinates) -> Self {
        Self {
            station_ref,
            coordinates,
            is_zero_datum: false,
            gps_coordinates: None,
            merged_with: Vec::new(),
        }
    }
}

/// Record of a station merge
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationMerge {
    pub station_a: StationRef,
    pub station_b: StationRef,
    pub merged_at: chrono::DateTime<chrono::Utc>,
}

/// Zero datum assignment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZeroDatum {
    pub station_ref: StationRef,
    pub gps: GpsCoordinates,
}

/// Strategy for distributing loop closure errors
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub enum ClosureStrategy {
    /// Distribute proportionally by shot length (Bowditch method)
    #[default]
    ProportionalByLength,
    /// Distribute equally across all shots
    EqualDistribution,
    /// Keep raw data, stations won't align perfectly
    KeepRaw,
    /// Manual adjustment later
    ManualAdjustment,
}

/// A detected loop closure in the survey
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopClosure {
    /// First station in the closure (merge point A)
    pub station_a: StationRef,
    /// Second station in the closure (merge point B)
    pub station_b: StationRef,
    /// Total path length along the loop (meters)
    pub path_length: f64,
    /// Misclosure distance (meters) - how far apart the two stations are
    pub misclosure_distance: f64,
    /// Closure error percentage (misclosure / path_length * 100)
    pub error_percentage: f64,
    /// Horizontal misclosure component (meters)
    pub horizontal_misclosure: f64,
    /// Vertical misclosure component (meters)
    pub vertical_misclosure: f64,
}
