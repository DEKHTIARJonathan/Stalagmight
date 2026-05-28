use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Unique identifier for a shot within a section
pub type ShotId = u32;

use super::{SectionId, FEATURE_ID_STRIDE};

/// Convert a raw ShotId to a 1-indexed display position.
///
/// After database reload, shot IDs have the form `section_id * FEATURE_ID_STRIDE + sequence_order`
/// where `sequence_order` is 0-indexed. Before first save, shot IDs are plain
/// sequential integers (0, 1, 2, …).
///
/// Returns a 1-indexed position suitable for user display (e.g., "13:5").
pub fn shot_display_position(shot_id: ShotId, section_id: SectionId) -> u32 {
    let base = section_id.saturating_mul(FEATURE_ID_STRIDE);
    if shot_id >= base {
        shot_id - base + 1
    } else {
        shot_id + 1
    }
}

/// Convert slope length + vertical delta into horizontal length.
/// Returns 0.0 if the inputs are invalid (e.g., slope < |dz|).
pub(crate) fn horizontal_length_from_slope(length: f64, dz: f64) -> f64 {
    let len_sq = length * length - dz * dz;
    if len_sq <= 0.0 {
        0.0
    } else {
        len_sq.sqrt()
    }
}

/// Convert horizontal + vertical components into slope length.
#[allow(dead_code)]
pub(crate) fn slope_length_from_components(horizontal: f64, dz: f64) -> f64 {
    (horizontal * horizontal + dz * dz).sqrt()
}

/// Compute pitch (degrees) from horizontal + vertical components.
/// Positive pitch corresponds to increasing depth (downwards).
#[allow(dead_code)]
pub(crate) fn pitch_from_components(horizontal: f64, dz: f64) -> f64 {
    dz.atan2(horizontal).to_degrees()
}

/// A single survey measurement between two stations
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Shot {
    /// Internal immutable ID, regenerated on load from sequence order.
    /// Use [`Shot::uuid`] instead when you need an identity that survives
    /// save/load — the collaboration round-trip with Ariane relies on it.
    pub id: ShotId,
    /// Persistent v4 UUID minted at shot creation, stable across saves
    /// and reloads.  Emitted into the TML on export so Ariane 26+ can
    /// round-trip shot identity without depending on the lossy
    /// `(section_id, shot_index)` key (which drifts as soon as the user
    /// inserts or deletes a shot in the same section).  `None` only for
    /// shots loaded from .stalx files written before schema v6; those
    /// get a fresh UUID minted lazily on the next save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub uuid: Option<String>,
    /// First forward azimuth reading for the shot (degrees, 0-360)
    pub azimuth_in: f64,
    /// Second forward azimuth reading for the shot (degrees, 0-360).
    /// This is not a backsight/reciprocal field.
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
    /// Whether this is a reference (temporary connection) shot
    #[serde(alias = "is_virtual")]
    pub is_reference: bool,
    /// Physical marker index on cave line
    pub marker_index: Option<u32>,
    /// Water temperature in celsius
    pub temperature: Option<f64>,
}

/// Data for creating or updating a shot
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
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
    #[serde(default, alias = "is_virtual")]
    pub is_reference: bool,
    #[serde(default)]
    pub marker_index: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

/// Partial updates to a shot
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct ShotUpdates {
    #[serde(default)]
    #[ts(optional)]
    pub azimuth_in: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub azimuth_out: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub length: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub depth_in: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub depth_out: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub pitch_in: Option<Option<f64>>,
    #[serde(default)]
    #[ts(optional)]
    pub pitch_out: Option<Option<f64>>,
    #[serde(default)]
    #[ts(optional)]
    pub left: Option<Option<f64>>,
    #[serde(default)]
    #[ts(optional)]
    pub right: Option<Option<f64>>,
    #[serde(default)]
    #[ts(optional)]
    pub up: Option<Option<f64>>,
    #[serde(default)]
    #[ts(optional)]
    pub down: Option<Option<f64>>,
    #[serde(default)]
    #[ts(optional)]
    pub comment: Option<Option<String>>,
    #[serde(default, alias = "is_virtual")]
    #[ts(optional)]
    pub is_reference: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub marker_index: Option<Option<u32>>,
    #[serde(default)]
    #[ts(optional)]
    pub temperature: Option<Option<f64>>,
}

impl ShotUpdates {
    /// Returns true if this update touches any geometry fields
    /// (azimuth, length, depth, pitch).
    pub fn touches_geometry(&self) -> bool {
        self.azimuth_in.is_some()
            || self.azimuth_out.is_some()
            || self.length.is_some()
            || self.depth_in.is_some()
            || self.depth_out.is_some()
            || self.pitch_in.is_some()
            || self.pitch_out.is_some()
    }
}

impl Shot {
    /// Create a new shot from shot data.  A fresh v4 UUID is minted for
    /// collaboration identity (see `Shot::uuid`); call [`Shot::with_uuid`]
    /// instead when restoring a shot from a persisted UUID.
    pub fn new(id: ShotId, data: ShotData) -> Self {
        Self::with_uuid(id, data, Some(uuid::Uuid::new_v4().to_string()))
    }

    /// Construct a shot with an explicit UUID (`None` = pre-v6 .stalx
    /// shot loaded without a recorded UUID; the next save will mint one).
    pub fn with_uuid(id: ShotId, data: ShotData, uuid: Option<String>) -> Self {
        Self {
            id,
            uuid,
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
            is_reference: data.is_reference,
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
            self.pitch_in = *v;
        }
        if let Some(v) = &updates.pitch_out {
            self.pitch_out = *v;
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
            // Normalize empty string → None (clear comment).
            // JSON `null` for Option<Option<String>> deserializes as outer None (= no update),
            // so the frontend sends "" to signal "clear", which arrives as Some(Some("")).
            self.comment = match v {
                Some(s) if s.is_empty() => None,
                _ => v.clone(),
            };
        }
        if let Some(v) = updates.is_reference {
            self.is_reference = v;
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

    /// Horizontal projection of the shot length (meters).
    /// Shot.length is slope distance, so horizontal is derived from depth change.
    pub fn horizontal_length(&self) -> f64 {
        horizontal_length_from_slope(self.length, self.depth_out - self.depth_in)
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
            is_reference: self.is_reference,
            marker_index: self.marker_index,
            temperature: self.temperature,
        }
    }
}

impl ShotData {
    /// Horizontal projection of the shot length (meters).
    /// ShotData.length is slope distance, so horizontal is derived from depth change.
    pub fn horizontal_length(&self) -> f64 {
        horizontal_length_from_slope(self.length, self.depth_out - self.depth_in)
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
            is_reference: shot.is_reference,
            marker_index: shot.marker_index,
            temperature: shot.temperature,
        }
    }
}

#[cfg(test)]
#[expect(clippy::float_cmp)]
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
            is_reference: false,
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
            is_reference: Some(true),
            marker_index: Some(None),
            ..Default::default()
        };

        shot.apply_updates(&updates);

        assert_eq!(shot.azimuth_in, 11.0);
        assert_eq!(shot.depth_out, 8.0);
        assert!(shot.pitch_in.is_none());
        assert_eq!(shot.right, Some(1.2));
        assert_eq!(shot.comment.as_deref(), Some("updated"));
        assert!(shot.is_reference);
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
    fn apply_updates_empty_string_clears_comment() {
        let mut shot = Shot::new(1, base_shot_data());
        assert_eq!(shot.comment.as_deref(), Some("note"));

        // Empty string should clear comment (workaround for JSON null → outer None serde issue)
        let updates = ShotUpdates {
            comment: Some(Some(String::new())),
            ..Default::default()
        };
        shot.apply_updates(&updates);
        assert!(shot.comment.is_none(), "empty string should clear comment");
    }

    #[test]
    fn apply_updates_none_comment_leaves_unchanged() {
        let mut shot = Shot::new(1, base_shot_data());
        assert_eq!(shot.comment.as_deref(), Some("note"));

        // None (missing key) should leave comment unchanged
        let updates = ShotUpdates {
            comment: None,
            ..Default::default()
        };
        shot.apply_updates(&updates);
        assert_eq!(shot.comment.as_deref(), Some("note"));
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

    #[test]
    fn shot_display_position_pre_reload_ids() {
        // Before save/load, shot IDs are small sequential integers (0-indexed)
        assert_eq!(shot_display_position(0, 1), 1); // first shot → position 1
        assert_eq!(shot_display_position(4, 1), 5); // fifth shot → position 5
        assert_eq!(shot_display_position(0, 0), 1); // section 0 edge case
    }

    #[test]
    fn shot_display_position_post_reload_ids() {
        // After reload: shot_id = section_id * FEATURE_ID_STRIDE + sequence_order
        assert_eq!(shot_display_position(FEATURE_ID_STRIDE * 13 + 4, 13), 5); // section 13, seq 4 → pos 5
        assert_eq!(shot_display_position(FEATURE_ID_STRIDE, 1), 1);       // section 1, seq 0 → pos 1
        assert_eq!(shot_display_position(FEATURE_ID_STRIDE + 9, 1), 10);  // section 1, seq 9 → pos 10
        assert_eq!(shot_display_position(FEATURE_ID_STRIDE * 5 + 2, 5), 3);   // section 5, seq 2 → pos 3
    }

    // ========================================================================
    // Geometry edge cases
    // ========================================================================

    #[test]
    fn vertical_shot_has_zero_horizontal_length() {
        // Pure vertical shot: dz == length → horizontal = 0
        let shot = Shot::new(1, ShotData {
            length: 10.0,
            depth_in: 0.0,
            depth_out: 10.0, // dz == length
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            ..Default::default()
        });
        assert_eq!(shot.horizontal_length(), 0.0);
    }

    #[test]
    fn nearly_vertical_shot_small_horizontal_length() {
        // dz almost equals length — should produce small positive horizontal
        let shot = Shot::new(1, ShotData {
            length: 10.0,
            depth_in: 0.0,
            depth_out: 9.99,
            azimuth_in: 0.0,
            azimuth_out: 0.0,
            ..Default::default()
        });
        let h = shot.horizontal_length();
        assert!(h > 0.0 && h < 0.5, "nearly vertical shot h={h}");
    }

    #[test]
    fn horizontal_length_with_dz_greater_than_length() {
        // Invalid: |dz| > length — should return 0.0 (not NaN/panic)
        let h = horizontal_length_from_slope(5.0, 10.0);
        assert_eq!(h, 0.0);
    }

    #[test]
    fn horizontal_length_zero_length_zero_dz() {
        assert_eq!(horizontal_length_from_slope(0.0, 0.0), 0.0);
    }

    #[test]
    fn average_azimuth_same_in_out() {
        let shot = Shot::new(1, ShotData {
            azimuth_in: 90.0,
            azimuth_out: 90.0,
            length: 1.0,
            ..Default::default()
        });
        assert!((shot.average_azimuth() - 90.0).abs() < 1e-6);
    }

    #[test]
    fn average_azimuth_wraps_around_north() {
        // 350° and 10° should average to 0° (or 360°)
        let shot = Shot::new(1, ShotData {
            azimuth_in: 350.0,
            azimuth_out: 10.0,
            length: 1.0,
            ..Default::default()
        });
        let avg = shot.average_azimuth();
        assert!(avg < 1.0 || avg > 359.0,
            "350-10 wrap should give ~0/360, got {avg}");
    }

    #[test]
    fn average_azimuth_wraps_around_south() {
        // 170° and 190° should average to 180°
        let shot = Shot::new(1, ShotData {
            azimuth_in: 170.0,
            azimuth_out: 190.0,
            length: 1.0,
            ..Default::default()
        });
        assert!((shot.average_azimuth() - 180.0).abs() < 1e-6);
    }

    #[test]
    fn average_azimuth_opposite_direction() {
        // in=0, out=180 → diff = (180+540)%360-180 = -180 → avg = (0 + -90 + 360)%360 = 270
        let shot = Shot::new(1, ShotData {
            azimuth_in: 0.0,
            azimuth_out: 180.0,
            length: 1.0,
            ..Default::default()
        });
        assert!((shot.average_azimuth() - 270.0).abs() < 1e-6);
    }

    #[test]
    fn slope_length_from_components_pythagorean() {
        let s = slope_length_from_components(3.0, 4.0);
        assert!((s - 5.0).abs() < 1e-6);
    }

    #[test]
    fn pitch_from_components_45_degrees() {
        let p = pitch_from_components(1.0, 1.0);
        assert!((p - 45.0).abs() < 1e-6);
    }

    #[test]
    fn pitch_from_components_pure_vertical() {
        let p = pitch_from_components(0.0, 1.0);
        assert!((p - 90.0).abs() < 1e-6);
    }

    #[test]
    fn pitch_from_components_pure_horizontal() {
        let p = pitch_from_components(1.0, 0.0);
        assert!(p.abs() < 1e-6);
    }
}
