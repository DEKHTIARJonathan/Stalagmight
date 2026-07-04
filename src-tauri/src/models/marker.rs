use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{SectionId, ShotId};

/// The visual type of a survey marker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "bindings/MarkerType.ts")]
pub enum MarkerType {
    /// Non-Directional Marker — a fixed physical reference point.
    Ndm,
    /// Directional arrow marker — indicates direction of travel along the line.
    Arrow,
}

/// Direction for an Arrow marker (relative to the shot it sits on).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export_to = "bindings/MarkerDirection.ts")]
pub enum MarkerDirection {
    /// Arrow points toward the start station of the shot.
    TowardStart,
    /// Arrow points toward the end station of the shot.
    TowardEnd,
}

/// A survey marker placed at a position along a shot.
///
/// Markers are project-level entities (stored in `Project.markers`) that
/// reference their host shot by `(section_id, shot_id)`. Position is a
/// percentage (0.0 = start station, 100.0 = end station).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export_to = "bindings/Marker.ts")]
pub struct Marker {
    /// Unique identifier — monotonically assigned, never reused.
    pub id: u64,
    /// Section that owns the host shot.
    pub section_id: SectionId,
    /// ID of the shot this marker sits on.
    pub shot_id: ShotId,
    /// Position along the shot as a percentage (0.0 = start, 100.0 = end).
    pub position: f32,
    /// Visual type of this marker.
    pub marker_type: MarkerType,
    /// Display color. One of the preset names ("white", "orange", "yellow",
    /// "blue") or a hex string like "#a3b4c5".
    pub color: String,
    /// Optional text label shown alongside the marker on the map.
    #[serde(default)]
    pub text: String,
    /// Direction for Arrow markers. Ignored for other types.
    #[serde(default)]
    pub direction: Option<MarkerDirection>,
}
