use crate::config::ValidationConfig;
use crate::models::{SectionId, ShotData};

use super::{ValidationWarning, WarningSeverity};

/// Validator for survey data
pub struct Validator;

impl Validator {
    /// Validate a shot and return any warnings
    pub fn validate_shot(
        shot: &ShotData,
        config: &ValidationConfig,
        section_id: SectionId,
        shot_index: usize,
    ) -> Vec<ValidationWarning> {
        let mut warnings = Vec::new();

        // Check for zero length
        if shot.length == 0.0 {
            warnings.push(ValidationWarning {
                code: "ZERO_LENGTH".to_string(),
                message: format!("Shot {}:{} has zero length", section_id, shot_index + 1),
                severity: WarningSeverity::Error,
            });
        }

        // Check for negative length
        if shot.length < 0.0 {
            warnings.push(ValidationWarning {
                code: "NEGATIVE_LENGTH".to_string(),
                message: format!("Shot {}:{} has negative length: {:.1}m", section_id, shot_index + 1, shot.length),
                severity: WarningSeverity::Error,
            });
        }

        // Check length thresholds
        if shot.length > 0.0 && shot.length < config.warn_shot_length_min {
            warnings.push(ValidationWarning {
                code: "SHORT_SHOT".to_string(),
                message: format!(
                    "Shot {}:{} length {:.1}m below minimum threshold {:.1}m",
                    section_id,
                    shot_index + 1,
                    shot.length,
                    config.warn_shot_length_min
                ),
                severity: WarningSeverity::Warning,
            });
        }

        if shot.length > config.warn_shot_length_max {
            warnings.push(ValidationWarning {
                code: "LONG_SHOT".to_string(),
                message: format!(
                    "Shot {}:{} length {:.1}m above maximum threshold {:.1}m",
                    section_id,
                    shot_index + 1,
                    shot.length,
                    config.warn_shot_length_max
                ),
                severity: WarningSeverity::Warning,
            });
        }

        // Check depth change
        let depth_change = (shot.depth_out - shot.depth_in).abs();
        if depth_change > config.warn_depth_change_per_shot_max {
            warnings.push(ValidationWarning {
                code: "LARGE_DEPTH_CHANGE".to_string(),
                message: format!(
                    "Shot {}:{} depth change {:.1}m exceeds threshold {:.1}m",
                    section_id,
                    shot_index + 1,
                    depth_change,
                    config.warn_depth_change_per_shot_max
                ),
                severity: WarningSeverity::Warning,
            });
        }

        // Check azimuth range
        if shot.azimuth_in < 0.0 || shot.azimuth_in >= 360.0 {
            warnings.push(ValidationWarning {
                code: "INVALID_AZIMUTH".to_string(),
                message: format!(
                    "Shot {}:{} has invalid azimuth_in: {:.1}° (must be 0-360)",
                    section_id,
                    shot_index + 1,
                    shot.azimuth_in
                ),
                severity: WarningSeverity::Error,
            });
        }

        if shot.azimuth_out < 0.0 || shot.azimuth_out >= 360.0 {
            warnings.push(ValidationWarning {
                code: "INVALID_AZIMUTH".to_string(),
                message: format!(
                    "Shot {}:{} has invalid azimuth_out: {:.1}° (must be 0-360)",
                    section_id,
                    shot_index + 1,
                    shot.azimuth_out
                ),
                severity: WarningSeverity::Error,
            });
        }

        // Check azimuth deviation (should be roughly 180° apart)
        let expected_out = (shot.azimuth_in + 180.0) % 360.0;
        let deviation = ((shot.azimuth_out - expected_out + 540.0) % 360.0 - 180.0).abs();
        if deviation > config.warn_azimuth_deviation_max {
            warnings.push(ValidationWarning {
                code: "AZIMUTH_DEVIATION".to_string(),
                message: format!(
                    "Shot {}:{} azimuth in/out deviation {:.1}° exceeds threshold {:.1}°",
                    section_id,
                    shot_index + 1,
                    deviation,
                    config.warn_azimuth_deviation_max
                ),
                severity: WarningSeverity::Warning,
            });
        }

        // Check LRUD values are non-negative
        if let Some(left) = shot.left {
            if left < 0.0 {
                warnings.push(ValidationWarning {
                    code: "NEGATIVE_LRUD".to_string(),
                    message: format!("Shot {}:{} has negative left distance: {:.1}m", section_id, shot_index + 1, left),
                    severity: WarningSeverity::Error,
                });
            }
        }

        if let Some(right) = shot.right {
            if right < 0.0 {
                warnings.push(ValidationWarning {
                    code: "NEGATIVE_LRUD".to_string(),
                    message: format!("Shot {}:{} has negative right distance: {:.1}m", section_id, shot_index + 1, right),
                    severity: WarningSeverity::Error,
                });
            }
        }

        if let Some(up) = shot.up {
            if up < 0.0 {
                warnings.push(ValidationWarning {
                    code: "NEGATIVE_LRUD".to_string(),
                    message: format!("Shot {}:{} has negative up distance: {:.1}m", section_id, shot_index + 1, up),
                    severity: WarningSeverity::Error,
                });
            }
        }

        if let Some(down) = shot.down {
            if down < 0.0 {
                warnings.push(ValidationWarning {
                    code: "NEGATIVE_LRUD".to_string(),
                    message: format!("Shot {}:{} has negative down distance: {:.1}m", section_id, shot_index + 1, down),
                    severity: WarningSeverity::Error,
                });
            }
        }

        warnings
    }

    /// Check if any warnings are errors
    pub fn has_errors(warnings: &[ValidationWarning]) -> bool {
        warnings
            .iter()
            .any(|w| w.severity == WarningSeverity::Error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::GpsCoordinates;

    fn default_config() -> ValidationConfig {
        ValidationConfig {
            warn_shot_length_min: 0.1,
            warn_shot_length_max: 50.0,
            warn_depth_change_per_shot_max: 10.0,
            warn_azimuth_deviation_max: 30.0,
            azimuth_diff_threshold: 10.0,
            pitch_diff_threshold: 5.0,
        }
    }

    #[test]
    fn test_valid_shot() {
        let shot = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 5.0,
            depth_in: 10.0,
            depth_out: 11.0,
            ..Default::default()
        };

        let warnings = Validator::validate_shot(&shot, &default_config(), 0, 0);
        assert!(warnings.is_empty());
    }

    #[test]
    fn test_zero_length_shot() {
        let shot = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 0.0,
            depth_in: 10.0,
            depth_out: 10.0,
            ..Default::default()
        };

        let warnings = Validator::validate_shot(&shot, &default_config(), 0, 0);
        assert!(Validator::has_errors(&warnings));
    }

    #[test]
    fn test_azimuth_deviation() {
        let shot = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 180.0, // Should be ~225, deviation is 45°
            length: 5.0,
            depth_in: 10.0,
            depth_out: 11.0,
            ..Default::default()
        };

        let warnings = Validator::validate_shot(&shot, &default_config(), 0, 0);
        assert!(!warnings.is_empty());
        assert!(warnings.iter().any(|w| w.code == "AZIMUTH_DEVIATION"));
    }

    /// Verify warning messages use "Shot {section_id}:{position}" format
    #[test]
    fn test_warning_message_format() {
        let config = default_config();

        // ZERO_LENGTH with section_id=4, shot_index=2 → "Shot 4:3 has zero length"
        let zero_shot = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 0.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&zero_shot, &config, 4, 2);
        let w = warnings.iter().find(|w| w.code == "ZERO_LENGTH").unwrap();
        assert!(w.message.starts_with("Shot 4:3 "), "Expected 'Shot 4:3 ...' but got: {}", w.message);

        // SHORT_SHOT with section_id=7, shot_index=0 → "Shot 7:1 length ..."
        let short_shot = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 0.05,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&short_shot, &config, 7, 0);
        let w = warnings.iter().find(|w| w.code == "SHORT_SHOT").unwrap();
        assert!(w.message.starts_with("Shot 7:1 "), "Expected 'Shot 7:1 ...' but got: {}", w.message);

        // INVALID_AZIMUTH with section_id=2, shot_index=5 → "Shot 2:6 has invalid azimuth_in..."
        let bad_azimuth = ShotData {
            azimuth_in: 400.0,
            azimuth_out: 180.0,
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&bad_azimuth, &config, 2, 5);
        let w = warnings.iter().find(|w| w.code == "INVALID_AZIMUTH").unwrap();
        assert!(w.message.starts_with("Shot 2:6 "), "Expected 'Shot 2:6 ...' but got: {}", w.message);

        // NEGATIVE_LRUD with section_id=10, shot_index=3 → "Shot 10:4 has negative left..."
        let neg_lrud = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            left: Some(-1.0),
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&neg_lrud, &config, 10, 3);
        let w = warnings.iter().find(|w| w.code == "NEGATIVE_LRUD").unwrap();
        assert!(w.message.starts_with("Shot 10:4 "), "Expected 'Shot 10:4 ...' but got: {}", w.message);
    }

    /// Test 5.1: Verify shot length validation (must be positive, reasonable max)
    #[test]
    fn test_validate_shot_length() {
        let config = default_config();

        // Valid positive length
        let valid_shot = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&valid_shot, &config, 0, 0);
        assert!(warnings.iter().all(|w| !w.code.contains("LENGTH")));

        // Negative length should produce error
        let negative_shot = ShotData {
            length: -5.0,
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&negative_shot, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "NEGATIVE_LENGTH"));
        assert!(Validator::has_errors(&warnings));

        // Zero length should produce error
        let zero_shot = ShotData {
            length: 0.0,
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&zero_shot, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "ZERO_LENGTH"));
        assert!(Validator::has_errors(&warnings));

        // Very short shot (below min threshold) should produce warning
        let short_shot = ShotData {
            length: 0.05, // Below warn_shot_length_min of 0.1
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&short_shot, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "SHORT_SHOT"));

        // Very long shot (above max threshold) should produce warning
        let long_shot = ShotData {
            length: 100.0, // Above warn_shot_length_max of 50.0
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&long_shot, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "LONG_SHOT"));
    }

    /// Test 5.2: Verify azimuth validation (0-360 degrees)
    #[test]
    fn test_validate_azimuth_range() {
        let config = default_config();

        // Valid azimuth at 0 degrees
        let shot_0 = ShotData {
            azimuth_in: 0.0,
            azimuth_out: 180.0,
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&shot_0, &config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "INVALID_AZIMUTH"));

        // Valid azimuth at 359.9 degrees
        let shot_359 = ShotData {
            azimuth_in: 359.9,
            azimuth_out: 179.9,
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&shot_359, &config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "INVALID_AZIMUTH"));

        // Invalid: azimuth_in >= 360
        let shot_360 = ShotData {
            azimuth_in: 360.0,
            azimuth_out: 180.0,
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&shot_360, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "INVALID_AZIMUTH"));
        assert!(Validator::has_errors(&warnings));

        // Invalid: azimuth_out >= 360
        let shot_out_400 = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 400.0,
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&shot_out_400, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "INVALID_AZIMUTH"));

        // Invalid: negative azimuth_in
        let shot_neg = ShotData {
            azimuth_in: -10.0,
            azimuth_out: 180.0,
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&shot_neg, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "INVALID_AZIMUTH"));

        // Invalid: negative azimuth_out
        let shot_neg_out = ShotData {
            azimuth_in: 45.0,
            azimuth_out: -45.0,
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&shot_neg_out, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "INVALID_AZIMUTH"));
    }

    /// Test 5.3: Verify LRUD validation (non-negative values)
    #[test]
    fn test_validate_lrud_values() {
        let config = default_config();

        // Valid LRUD values (all positive)
        let valid_shot = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            left: Some(2.0),
            right: Some(3.0),
            up: Some(1.5),
            down: Some(0.5),
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&valid_shot, &config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "NEGATIVE_LRUD"));

        // Valid: zero LRUD values are allowed (wall touching)
        let zero_lrud = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            left: Some(0.0),
            right: Some(0.0),
            up: Some(0.0),
            down: Some(0.0),
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&zero_lrud, &config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "NEGATIVE_LRUD"));

        // Valid: None LRUD values (not measured)
        let none_lrud = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            left: None,
            right: None,
            up: None,
            down: None,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&none_lrud, &config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "NEGATIVE_LRUD"));

        // Invalid: negative left
        let neg_left = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            left: Some(-1.0),
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&neg_left, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "NEGATIVE_LRUD"));
        assert!(Validator::has_errors(&warnings));

        // Invalid: negative right
        let neg_right = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            right: Some(-2.5),
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&neg_right, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "NEGATIVE_LRUD"));

        // Invalid: negative up
        let neg_up = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            up: Some(-0.5),
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&neg_up, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "NEGATIVE_LRUD"));

        // Invalid: negative down
        let neg_down = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            down: Some(-3.0),
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&neg_down, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "NEGATIVE_LRUD"));
    }

    /// Test 5.4: Verify GPS coordinate validation (latitude -90 to 90, longitude -180 to 180)
    #[test]
    fn test_validate_gps_coordinates() {
        // Valid coordinates: typical cave location
        assert!(GpsCoordinates::validate(45.0, -93.0, 10.0).is_ok());

        // Valid: equator and prime meridian
        assert!(GpsCoordinates::validate(0.0, 0.0, 0.0).is_ok());

        // Valid: north pole
        assert!(GpsCoordinates::validate(90.0, 0.0, 0.0).is_ok());

        // Valid: south pole
        assert!(GpsCoordinates::validate(-90.0, 0.0, 0.0).is_ok());

        // Valid: date line (positive)
        assert!(GpsCoordinates::validate(0.0, 180.0, 0.0).is_ok());

        // Valid: date line (negative)
        assert!(GpsCoordinates::validate(0.0, -180.0, 0.0).is_ok());

        // Valid: extreme valid coordinates
        assert!(GpsCoordinates::validate(90.0, 180.0, 0.0).is_ok());
        assert!(GpsCoordinates::validate(-90.0, -180.0, 0.0).is_ok());

        // Invalid: latitude > 90
        let result = GpsCoordinates::validate(91.0, 0.0, 0.0);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Latitude"));

        // Invalid: latitude < -90
        let result = GpsCoordinates::validate(-91.0, 0.0, 0.0);
        assert!(result.is_err());

        // Invalid: longitude > 180
        let result = GpsCoordinates::validate(0.0, 181.0, 0.0);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Longitude"));

        // Invalid: longitude < -180
        let result = GpsCoordinates::validate(0.0, -181.0, 0.0);
        assert!(result.is_err());

        // Invalid: NaN latitude
        let result = GpsCoordinates::validate(f64::NAN, 0.0, 0.0);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("finite"));

        // Invalid: infinity longitude
        let result = GpsCoordinates::validate(0.0, f64::INFINITY, 0.0);
        assert!(result.is_err());

        // Invalid: negative infinity depth reference
        let result = GpsCoordinates::validate(0.0, 0.0, f64::NEG_INFINITY);
        assert!(result.is_err());

        // Test GpsCoordinates::new() uses validation
        assert!(GpsCoordinates::new(45.0, -93.0, 10.0).is_ok());
        assert!(GpsCoordinates::new(100.0, 0.0, 0.0).is_err());

        // Test is_valid() method
        let valid_gps = GpsCoordinates {
            latitude: 45.0,
            longitude: -93.0,
            depth_reference: 10.0,
        };
        assert!(valid_gps.is_valid());
    }

    /// Test 5.5: Verify backsight azimuth tolerance (within configurable degrees of expected)
    #[test]
    fn test_validate_backsight_tolerance() {
        // Backsight validation: azimuth_out should be ~180° from azimuth_in
        // The validator checks if the deviation exceeds warn_azimuth_deviation_max

        // Test with default config (30° max deviation)
        let config = default_config();

        // Valid: perfect backsight (exactly 180° apart)
        let perfect_backsight = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0, // Exactly 180° from 45°
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&perfect_backsight, &config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "AZIMUTH_DEVIATION"));

        // Valid: within tolerance (20° deviation)
        let within_tolerance = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 245.0, // 20° off from expected 225°
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&within_tolerance, &config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "AZIMUTH_DEVIATION"));

        // Invalid: exceeds tolerance (45° deviation)
        let exceeds_tolerance = ShotData {
            azimuth_in: 45.0,
            azimuth_out: 180.0, // 45° off from expected 225°
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&exceeds_tolerance, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "AZIMUTH_DEVIATION"));

        // Test wraparound at 360°/0°: azimuth_in=350°, expected_out=170°
        let wraparound = ShotData {
            azimuth_in: 350.0,
            azimuth_out: 170.0, // Exactly 180° from 350°
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&wraparound, &config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "AZIMUTH_DEVIATION"));

        // Test wraparound with deviation: azimuth_in=350°, out=220° (50° off)
        let wraparound_deviation = ShotData {
            azimuth_in: 350.0,
            azimuth_out: 220.0, // 50° off from expected 170°
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&wraparound_deviation, &config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "AZIMUTH_DEVIATION"));

        // Test with strict config (5° max deviation)
        let strict_config = ValidationConfig {
            warn_azimuth_deviation_max: 5.0,
            ..default_config()
        };

        // Small deviation (3°) should pass with strict config
        let small_deviation = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 273.0, // 3° off from expected 270°
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&small_deviation, &strict_config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "AZIMUTH_DEVIATION"));

        // Medium deviation (10°) should fail with strict config
        let medium_deviation = ShotData {
            azimuth_in: 90.0,
            azimuth_out: 280.0, // 10° off from expected 270°
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&medium_deviation, &strict_config, 0, 0);
        assert!(warnings.iter().any(|w| w.code == "AZIMUTH_DEVIATION"));

        // Test with lenient config (90° max deviation)
        let lenient_config = ValidationConfig {
            warn_azimuth_deviation_max: 90.0,
            ..default_config()
        };

        // Large deviation (60°) should pass with lenient config
        let large_deviation = ShotData {
            azimuth_in: 0.0,
            azimuth_out: 240.0, // 60° off from expected 180°
            length: 5.0,
            ..Default::default()
        };
        let warnings = Validator::validate_shot(&large_deviation, &lenient_config, 0, 0);
        assert!(warnings.iter().all(|w| w.code != "AZIMUTH_DEVIATION"));
    }
}
