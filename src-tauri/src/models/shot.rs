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

#[cfg(test)]
mod tests {
    use super::*;

    fn base_shot_data() -> ShotData {
        ShotData {
            azimuth_in: 10.0,
            azimuth_out: 20.0,
            length: 30.0,
            depth_in: 5.0,
            depth_out: 7.0,
            pitch_in: Some(1.0),
            pitch_out: Some(2.0),
            left: Some(0.5),
            right: Some(0.6),
            up: Some(0.7),
            down: Some(0.8),
            comment: Some("note".to_string()),
            is_virtual: false,
            marker_index: Some(3),
            temperature: Some(21.5),
        }
    }

    #[test]
    fn apply_updates_changes_only_provided_fields() {
        let mut shot = Shot::new(1, base_shot_data());
        let updates = ShotUpdates {
            azimuth_in: Some(11.0),
            depth_out: Some(8.0),
            pitch_in: Some(None),
            right: Some(Some(1.2)),
            comment: Some(Some("updated".to_string())),
            is_virtual: Some(true),
            marker_index: Some(None),
            ..Default::default()
        };

        shot.apply_updates(&updates);

        assert_eq!(shot.azimuth_in, 11.0);
        assert_eq!(shot.depth_out, 8.0);
        assert!(shot.pitch_in.is_none());
        assert_eq!(shot.right, Some(1.2));
        assert_eq!(shot.comment.as_deref(), Some("updated"));
        assert!(shot.is_virtual);
        assert!(shot.marker_index.is_none());

        assert_eq!(shot.azimuth_out, 20.0);
        assert_eq!(shot.length, 30.0);
        assert_eq!(shot.depth_in, 5.0);
        assert_eq!(shot.pitch_out, Some(2.0));
        assert_eq!(shot.left, Some(0.5));
        assert_eq!(shot.up, Some(0.7));
        assert_eq!(shot.down, Some(0.8));
        assert_eq!(shot.temperature, Some(21.5));
    }

    #[test]
    fn average_azimuth_handles_wraparound() {
        let shot = Shot::new(
            1,
            ShotData {
                azimuth_in: 350.0,
                azimuth_out: 10.0,
                length: 1.0,
                depth_in: 0.0,
                depth_out: 0.0,
                ..Default::default()
            },
        );
        let average = shot.average_azimuth();
        assert!((average - 0.0).abs() < 1e-6);
    }

    #[test]
    fn depth_change_and_conversion_roundtrip() {
        let shot = Shot::new(4, base_shot_data());
        assert!((shot.depth_change() - 2.0).abs() < 1e-6);

        let data = shot.to_shot_data();
        assert_eq!(data.azimuth_in, 10.0);
        assert_eq!(data.comment.as_deref(), Some("note"));

        let from_shot: ShotData = Shot::new(5, base_shot_data()).into();
        assert_eq!(from_shot.length, 30.0);
        assert_eq!(from_shot.marker_index, Some(3));
    }
}
