use serde::{Deserialize, Serialize};

/// Unique identifier for a shot within a section
pub type ShotId = u32;

/// A single survey measurement between two stations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shot {
    /// Internal immutable ID
    pub id: ShotId,
    /// Azimuth reading when entering the shot (degrees, 0-360)
    pub azimuth_in: f64,
    /// Azimuth reading when exiting the shot (degrees, 0-360)
    pub azimuth_out: f64,
    /// Length of the shot in meters
    pub length: f64,
    /// Depth at the start of the shot (meters, positive = below surface)
    pub depth_in: f64,
    /// Depth at the end of the shot (meters, positive = below surface)
    pub depth_out: f64,
    /// Pitch reading when entering (degrees, -90 to 90)
    pub pitch_in: Option<f64>,
    /// Pitch reading when exiting (degrees, -90 to 90)
    pub pitch_out: Option<f64>,
    /// Left passage dimension (meters)
    pub left: Option<f64>,
    /// Right passage dimension (meters)
    pub right: Option<f64>,
    /// Up passage dimension (meters)
    pub up: Option<f64>,
    /// Down passage dimension (meters)
    pub down: Option<f64>,
    /// Optional comment
    pub comment: Option<String>,
    /// Whether this is a virtual (temporary connection) shot
    pub is_virtual: bool,
    /// Physical marker index on cave line
    pub marker_index: Option<u32>,
    /// Water temperature in celsius
    pub temperature: Option<f64>,
}

/// Data for creating or updating a shot
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShotData {
    pub azimuth_in: f64,
    pub azimuth_out: f64,
    pub length: f64,
    pub depth_in: f64,
    pub depth_out: f64,
    #[serde(default)]
    pub pitch_in: Option<f64>,
    #[serde(default)]
    pub pitch_out: Option<f64>,
    #[serde(default)]
    pub left: Option<f64>,
    #[serde(default)]
    pub right: Option<f64>,
    #[serde(default)]
    pub up: Option<f64>,
    #[serde(default)]
    pub down: Option<f64>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub is_virtual: bool,
    #[serde(default)]
    pub marker_index: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

/// Partial updates to a shot
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShotUpdates {
    #[serde(default)]
    pub azimuth_in: Option<f64>,
    #[serde(default)]
    pub azimuth_out: Option<f64>,
    #[serde(default)]
    pub length: Option<f64>,
    #[serde(default)]
    pub depth_in: Option<f64>,
    #[serde(default)]
    pub depth_out: Option<f64>,
    #[serde(default)]
    pub pitch_in: Option<Option<f64>>,
    #[serde(default)]
    pub pitch_out: Option<Option<f64>>,
    #[serde(default)]
    pub left: Option<Option<f64>>,
    #[serde(default)]
    pub right: Option<Option<f64>>,
    #[serde(default)]
    pub up: Option<Option<f64>>,
    #[serde(default)]
    pub down: Option<Option<f64>>,
    #[serde(default)]
    pub comment: Option<Option<String>>,
    #[serde(default)]
    pub is_virtual: Option<bool>,
    #[serde(default)]
    pub marker_index: Option<Option<u32>>,
    #[serde(default)]
    pub temperature: Option<Option<f64>>,
}

impl Shot {
    /// Create a new shot from shot data
    pub fn new(id: ShotId, data: ShotData) -> Self {
        Self {
            id,
            azimuth_in: data.azimuth_in,
            azimuth_out: data.azimuth_out,
            length: data.length,
            depth_in: data.depth_in,
            depth_out: data.depth_out,
            pitch_in: data.pitch_in,
            pitch_out: data.pitch_out,
            left: data.left,
            right: data.right,
            up: data.up,
            down: data.down,
            comment: data.comment,
            is_virtual: data.is_virtual,
            marker_index: data.marker_index,
            temperature: data.temperature,
        }
    }

    /// Apply partial updates to this shot
    pub fn apply_updates(&mut self, updates: &ShotUpdates) {
        if let Some(v) = updates.azimuth_in {
            self.azimuth_in = v;
        }
        if let Some(v) = updates.azimuth_out {
            self.azimuth_out = v;
        }
        if let Some(v) = updates.length {
            self.length = v;
        }
        if let Some(v) = updates.depth_in {
            self.depth_in = v;
        }
        if let Some(v) = updates.depth_out {
            self.depth_out = v;
        }
        if let Some(v) = &updates.pitch_in {
            self.pitch_in = v.clone();
        }
        if let Some(v) = &updates.pitch_out {
            self.pitch_out = v.clone();
        }
        if let Some(v) = &updates.left {
            self.left = *v;
        }
        if let Some(v) = &updates.right {
            self.right = *v;
        }
        if let Some(v) = &updates.up {
            self.up = *v;
        }
        if let Some(v) = &updates.down {
            self.down = *v;
        }
        if let Some(v) = &updates.comment {
            self.comment = v.clone();
        }
        if let Some(v) = updates.is_virtual {
            self.is_virtual = v;
        }
        if let Some(v) = &updates.marker_index {
            self.marker_index = *v;
        }
        if let Some(v) = &updates.temperature {
            self.temperature = *v;
        }
    }

    /// Calculate the average azimuth from in and out readings
    pub fn average_azimuth(&self) -> f64 {
        // Handle wraparound at 360 degrees
        let diff = (self.azimuth_out - self.azimuth_in + 540.0) % 360.0 - 180.0;
        (self.azimuth_in + diff / 2.0 + 360.0) % 360.0
    }

    /// Get depth change for this shot
    pub fn depth_change(&self) -> f64 {
        self.depth_out - self.depth_in
    }

    /// Convert to ShotData (for undo snapshots)
    pub fn to_shot_data(&self) -> ShotData {
        ShotData {
            azimuth_in: self.azimuth_in,
            azimuth_out: self.azimuth_out,
            length: self.length,
            depth_in: self.depth_in,
            depth_out: self.depth_out,
            pitch_in: self.pitch_in,
            pitch_out: self.pitch_out,
            left: self.left,
            right: self.right,
            up: self.up,
            down: self.down,
            comment: self.comment.clone(),
            is_virtual: self.is_virtual,
            marker_index: self.marker_index,
            temperature: self.temperature,
        }
    }
}

impl From<Shot> for ShotData {
    fn from(shot: Shot) -> Self {
        ShotData {
            azimuth_in: shot.azimuth_in,
            azimuth_out: shot.azimuth_out,
            length: shot.length,
            depth_in: shot.depth_in,
            depth_out: shot.depth_out,
            pitch_in: shot.pitch_in,
            pitch_out: shot.pitch_out,
            left: shot.left,
            right: shot.right,
            up: shot.up,
            down: shot.down,
            comment: shot.comment,
            is_virtual: shot.is_virtual,
            marker_index: shot.marker_index,
            temperature: shot.temperature,
        }
    }
}
