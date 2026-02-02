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

impl GpsCoordinates {
    /// Creates new GPS coordinates after validation
    /// Returns Err if values are non-finite or out of range
    pub fn new(latitude: f64, longitude: f64, depth_reference: f64) -> Result<Self, String> {
        Self::validate(latitude, longitude, depth_reference)?;
        Ok(Self {
            latitude,
            longitude: Self::normalize_longitude(longitude),
            depth_reference,
        })
    }

    /// Validates GPS coordinate values
    /// Latitude must be in [-90, 90], longitude in [-180, 180]
    /// All values must be finite (not NaN or ±infinity)
    pub fn validate(latitude: f64, longitude: f64, depth_reference: f64) -> Result<(), String> {
        if !latitude.is_finite() {
            return Err(format!("Latitude must be finite, got {}", latitude));
        }
        if !longitude.is_finite() {
            return Err(format!("Longitude must be finite, got {}", longitude));
        }
        if !depth_reference.is_finite() {
            return Err(format!("Depth reference must be finite, got {}", depth_reference));
        }
        if !(-90.0..=90.0).contains(&latitude) {
            return Err(format!("Latitude must be in [-90, 90], got {}", latitude));
        }
        if !(-180.0..=180.0).contains(&longitude) {
            return Err(format!("Longitude must be in [-180, 180], got {}", longitude));
        }
        Ok(())
    }

    /// Checks if coordinates are valid (finite and in range)
    pub fn is_valid(&self) -> bool {
        Self::validate(self.latitude, self.longitude, self.depth_reference).is_ok()
    }

    /// Normalizes longitude to [-180, 180) range
    fn normalize_longitude(mut lon: f64) -> f64 {
        while lon >= 180.0 {
            lon -= 360.0;
        }
        while lon < -180.0 {
            lon += 360.0;
        }
        lon
    }
}

/// GPS bounding box in WGS84 format
/// Uses cardinal directions: north/south for latitude, east/west for longitude
/// Note: When bounds cross the international dateline, `east < west`.
/// For example, bounds spanning from 170°E to 170°W would have west=170, east=-170.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct GpsBounds {
    /// Northern boundary (max latitude)
    pub north: f64,
    /// Southern boundary (min latitude)
    pub south: f64,
    /// Eastern boundary longitude. If `east < west`, bounds cross the dateline.
    pub east: f64,
    /// Western boundary longitude
    pub west: f64,
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

    /// Format this offset as a human-readable string with 16-point compass direction.
    ///
    /// x = East, y = North, z = Depth (positive = below surface).
    /// Examples: "5.3m NNW", "5.3m NNW, 1.2m down", "1.2m up", "no movement"
    pub fn display_offset(&self) -> String {
        const COMPASS: [&str; 16] = [
            "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
        ];

        let horiz_dist = (self.x * self.x + self.y * self.y).sqrt();
        let has_horiz = horiz_dist >= 0.01;
        let vert_abs = self.z.abs();
        let has_vert = vert_abs >= 0.01;

        if !has_horiz && !has_vert {
            return "no movement".to_string();
        }

        let mut parts = Vec::with_capacity(2);

        if has_horiz {
            // Bearing from North: atan2(East, North) in degrees [0, 360)
            let bearing_rad = self.x.atan2(self.y);
            let bearing_deg = bearing_rad.to_degrees().rem_euclid(360.0);
            let sector = ((bearing_deg + 11.25) / 22.5).floor() as usize % 16;
            parts.push(format!("{:.1}m {}", horiz_dist, COMPASS[sector]));
        }

        if has_vert {
            let direction = if self.z > 0.0 { "down" } else { "up" };
            parts.push(format!("{:.1}m {}", vert_abs, direction));
        }

        parts.join(", ")
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
    /// Loop closures involving this station
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub closures_with: Vec<ClosureRef>,
}

impl Station {
    pub fn new(station_ref: StationRef) -> Self {
        Self {
            station_ref,
            coordinates: Coordinates::default(),
            is_zero_datum: false,
            gps_coordinates: None,
            merged_with: Vec::new(),
            closures_with: Vec::new(),
        }
    }

    pub fn with_coordinates(station_ref: StationRef, coordinates: Coordinates) -> Self {
        Self {
            station_ref,
            coordinates,
            is_zero_datum: false,
            gps_coordinates: None,
            merged_with: Vec::new(),
            closures_with: Vec::new(),
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
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
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
    /// Created by snap-to-merge move (station was physically moved to align)
    Move,
}

impl ClosureStrategy {
    /// Convert to a string suitable for SQLite storage
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ProportionalByLength => "ProportionalByLength",
            Self::EqualDistribution => "EqualDistribution",
            Self::KeepRaw => "KeepRaw",
            Self::ManualAdjustment => "ManualAdjustment",
            Self::Move => "Move",
        }
    }

    /// Parse from a SQLite string value, defaulting to ProportionalByLength
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "ProportionalByLength" => Self::ProportionalByLength,
            "EqualDistribution" => Self::EqualDistribution,
            "KeepRaw" => Self::KeepRaw,
            "ManualAdjustment" => Self::ManualAdjustment,
            "Move" => Self::Move,
            _ => Self::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn station_ref_display_formats_as_section_and_index() {
        let station = StationRef::new(2, 3);
        assert_eq!(station.to_string(), "2:3");
    }

    #[test]
    fn gps_coordinates_normalizes_longitude() {
        let gps = GpsCoordinates::new(10.0, 180.0, 5.0).unwrap();
        assert!((gps.longitude + 180.0).abs() < 1e-6);
    }

    #[test]
    fn gps_coordinates_validation_rejects_invalid_values() {
        assert!(GpsCoordinates::new(91.0, 0.0, 0.0).is_err());
        assert!(GpsCoordinates::new(-91.0, 0.0, 0.0).is_err());
        assert!(GpsCoordinates::new(0.0, 181.0, 0.0).is_err());
        assert!(GpsCoordinates::new(0.0, -181.0, 0.0).is_err());
        assert!(GpsCoordinates::new(f64::NAN, 0.0, 0.0).is_err());
        assert!(GpsCoordinates::new(0.0, f64::NAN, 0.0).is_err());
        assert!(GpsCoordinates::new(0.0, 0.0, f64::NAN).is_err());
    }

    #[test]
    fn gps_coordinates_is_valid_checks_ranges() {
        let gps = GpsCoordinates::new(10.0, 20.0, 5.0).unwrap();
        assert!(gps.is_valid());

        let invalid = GpsCoordinates {
            latitude: 120.0,
            longitude: 0.0,
            depth_reference: 0.0,
        };
        assert!(!invalid.is_valid());
    }

    #[test]
    fn coordinates_distance_calculations() {
        let a = Coordinates::new(0.0, 0.0, 0.0);
        let b = Coordinates::new(3.0, 4.0, 12.0);

        let distance = a.distance_to(&b);
        assert!((distance - 13.0).abs() < 1e-6);

        let horizontal = a.horizontal_distance_to(&b);
        assert!((horizontal - 5.0).abs() < 1e-6);
    }

    #[test]
    fn display_offset_no_movement() {
        assert_eq!(Coordinates::new(0.0, 0.0, 0.0).display_offset(), "no movement");
        assert_eq!(Coordinates::new(0.005, 0.005, 0.005).display_offset(), "no movement");
    }

    #[test]
    fn display_offset_cardinal_directions() {
        // Pure North
        assert_eq!(Coordinates::new(0.0, 5.0, 0.0).display_offset(), "5.0m N");
        // Pure East
        assert_eq!(Coordinates::new(5.0, 0.0, 0.0).display_offset(), "5.0m E");
        // Pure South
        assert_eq!(Coordinates::new(0.0, -5.0, 0.0).display_offset(), "5.0m S");
        // Pure West
        assert_eq!(Coordinates::new(-5.0, 0.0, 0.0).display_offset(), "5.0m W");
    }

    #[test]
    fn display_offset_intercardinal_directions() {
        // NE (equal x and y positive)
        let d = Coordinates::new(5.0, 5.0, 0.0).display_offset();
        assert!(d.contains("NE"), "expected NE in '{}'", d);
        // SW (equal x and y negative)
        let d = Coordinates::new(-5.0, -5.0, 0.0).display_offset();
        assert!(d.contains("SW"), "expected SW in '{}'", d);
    }

    #[test]
    fn display_offset_16_point_compass() {
        // NNE: bearing ~22.5° (small east, large north)
        let d = Coordinates::new(1.0, 2.5, 0.0).display_offset();
        assert!(d.contains("NNE"), "expected NNE in '{}'", d);
        // SSW: bearing ~202.5° (small west, large south)
        let d = Coordinates::new(-1.0, -2.5, 0.0).display_offset();
        assert!(d.contains("SSW"), "expected SSW in '{}'", d);
    }

    #[test]
    fn display_offset_vertical_only() {
        assert_eq!(Coordinates::new(0.0, 0.0, 3.0).display_offset(), "3.0m down");
        assert_eq!(Coordinates::new(0.0, 0.0, -2.5).display_offset(), "2.5m up");
    }

    #[test]
    fn display_offset_combined_horizontal_and_vertical() {
        let d = Coordinates::new(0.0, 5.0, -1.2).display_offset();
        assert_eq!(d, "5.0m N, 1.2m up");
    }
}

/// A detected loop closure in the survey
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopClosure {
    /// Unique identifier for this closure
    #[serde(default)]
    pub id: u64,
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
    /// Strategy for distributing the closure error
    #[serde(default)]
    pub strategy: ClosureStrategy,
}

/// Reference to a loop closure from a station's perspective
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClosureRef {
    /// References LoopClosure.id
    pub closure_id: u64,
    /// Target station in the closure
    pub station_ref: StationRef,
    /// Intermediate station for transitive closures
    pub via_station: Option<StationRef>,
    /// Whether this is a transitive closure
    pub is_transitive: bool,
}

/// Preview data for a potential loop closure (read-only metrics, no mutation)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClosurePreview {
    pub path_length: f64,
    pub misclosure_distance: f64,
    pub error_percentage: f64,
    pub horizontal_misclosure: f64,
    pub vertical_misclosure: f64,
}

/// Result of a connectivity check between two stations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectivityResult {
    pub connected: bool,
    pub preview: Option<ClosurePreview>,
    /// Whether merge is allowed for the given station pair
    #[serde(default)]
    pub can_merge: bool,
    /// Explanation when merge is not allowed
    #[serde(default)]
    pub reason: Option<String>,
}
