use crate::config::ValidationConfig;
use crate::models::ShotData;

use super::{ValidationWarning, WarningSeverity};

/// Validator for survey data
pub struct Validator;

impl Validator {
    /// Validate a shot and return any warnings
    pub fn validate_shot(
        shot: &ShotData,
        config: &ValidationConfig,
        shot_index: usize,
    ) -> Vec<ValidationWarning> {
        let mut warnings = Vec::new();

        // Check for zero length
        if shot.length == 0.0 {
            warnings.push(ValidationWarning {
                code: "ZERO_LENGTH".to_string(),
                message: format!("Shot {} has zero length", shot_index + 1),
                severity: WarningSeverity::Error,
            });
        }

        // Check for negative length
        if shot.length < 0.0 {
            warnings.push(ValidationWarning {
                code: "NEGATIVE_LENGTH".to_string(),
                message: format!("Shot {} has negative length: {:.1}m", shot_index + 1, shot.length),
                severity: WarningSeverity::Error,
            });
        }

        // Check length thresholds
        if shot.length > 0.0 && shot.length < config.warn_shot_length_min {
            warnings.push(ValidationWarning {
                code: "SHORT_SHOT".to_string(),
                message: format!(
                    "Shot {} length {:.1}m below minimum threshold {:.1}m",
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
                    "Shot {} length {:.1}m above maximum threshold {:.1}m",
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
                    "Shot {} depth change {:.1}m exceeds threshold {:.1}m",
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
                    "Shot {} has invalid azimuth_in: {:.1}° (must be 0-360)",
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
                    "Shot {} has invalid azimuth_out: {:.1}° (must be 0-360)",
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
                    "Shot {} azimuth in/out deviation {:.1}° exceeds threshold {:.1}°",
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
                    message: format!("Shot {} has negative left distance: {:.1}m", shot_index + 1, left),
                    severity: WarningSeverity::Error,
                });
            }
        }

        if let Some(right) = shot.right {
            if right < 0.0 {
                warnings.push(ValidationWarning {
                    code: "NEGATIVE_LRUD".to_string(),
                    message: format!("Shot {} has negative right distance: {:.1}m", shot_index + 1, right),
                    severity: WarningSeverity::Error,
                });
            }
        }

        if let Some(up) = shot.up {
            if up < 0.0 {
                warnings.push(ValidationWarning {
                    code: "NEGATIVE_LRUD".to_string(),
                    message: format!("Shot {} has negative up distance: {:.1}m", shot_index + 1, up),
                    severity: WarningSeverity::Error,
                });
            }
        }

        if let Some(down) = shot.down {
            if down < 0.0 {
                warnings.push(ValidationWarning {
                    code: "NEGATIVE_LRUD".to_string(),
                    message: format!("Shot {} has negative down distance: {:.1}m", shot_index + 1, down),
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

    fn default_config() -> ValidationConfig {
        ValidationConfig {
            warn_shot_length_min: 0.1,
            warn_shot_length_max: 50.0,
            warn_depth_change_per_shot_max: 10.0,
            warn_azimuth_deviation_max: 30.0,
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

        let warnings = Validator::validate_shot(&shot, &default_config(), 0);
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

        let warnings = Validator::validate_shot(&shot, &default_config(), 0);
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

        let warnings = Validator::validate_shot(&shot, &default_config(), 0);
        assert!(!warnings.is_empty());
        assert!(warnings.iter().any(|w| w.code == "AZIMUTH_DEVIATION"));
    }
}
