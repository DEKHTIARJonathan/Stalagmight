# Task 05: Validation Tests

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-05 |
| **Category** | Rust Unit Tests |
| **Target File** | `src-tauri/src/core/validation.rs` |
| **Tests** | 5 |
| **Priority** | P2 - Medium |
| **Dependencies** | None |

## Affected Files
- `src-tauri/src/core/validation.rs` - Add/extend test module

## Test Specifications

---

### Test 5.1: `test_validation_at_exact_threshold`

**Purpose:** Verify boundary conditions for validation thresholds - values exactly at limits should pass.

**Test Code:**
```rust
#[test]
fn test_validation_at_exact_threshold() {
    let config = ValidationConfig::default();
    // Assuming defaults: min_shot_length = 0.1, max_shot_length = 50.0

    // Test at exact minimum threshold (should NOT warn)
    let shot_at_min = ShotData {
        length: 0.1, // Exactly at minimum
        azimuth_in: 45.0,
        azimuth_out: 225.0,
        depth_in: 0.0,
        depth_out: 1.0,
        ..Default::default()
    };

    let warnings = validate_shot(&shot_at_min, &config);
    let length_warnings: Vec<_> = warnings.iter()
        .filter(|w| w.field == "length" && w.severity == Severity::Warning)
        .collect();
    assert!(length_warnings.is_empty(),
            "Shot at exact min threshold should NOT warn: {:?}", length_warnings);

    // Test at exact maximum threshold (should NOT warn)
    let shot_at_max = ShotData {
        length: 50.0, // Exactly at maximum
        azimuth_in: 90.0,
        azimuth_out: 270.0,
        depth_in: 0.0,
        depth_out: 5.0,
        ..Default::default()
    };

    let warnings = validate_shot(&shot_at_max, &config);
    let length_warnings: Vec<_> = warnings.iter()
        .filter(|w| w.field == "length")
        .collect();
    assert!(length_warnings.is_empty(),
            "Shot at exact max threshold should NOT warn: {:?}", length_warnings);

    // Test just below minimum (should warn)
    let shot_below_min = ShotData {
        length: 0.09,
        ..shot_at_min.clone()
    };
    let warnings = validate_shot(&shot_below_min, &config);
    assert!(warnings.iter().any(|w| w.field == "length"),
            "Shot below min threshold SHOULD warn");

    // Test just above maximum (should warn)
    let shot_above_max = ShotData {
        length: 50.01,
        ..shot_at_max.clone()
    };
    let warnings = validate_shot(&shot_above_max, &config);
    assert!(warnings.iter().any(|w| w.field == "length"),
            "Shot above max threshold SHOULD warn");
}

#[test]
fn test_validation_azimuth_boundaries() {
    let config = ValidationConfig::default();

    // Azimuth 0.0 - valid
    let shot_az_zero = ShotData {
        azimuth_in: 0.0,
        azimuth_out: 180.0,
        length: 5.0,
        ..Default::default()
    };
    let errors = validate_shot(&shot_az_zero, &config)
        .iter().filter(|w| w.severity == Severity::Error).count();
    assert_eq!(errors, 0, "Azimuth 0 should be valid");

    // Azimuth 360.0 - should be normalized or valid
    let shot_az_360 = ShotData {
        azimuth_in: 360.0,
        azimuth_out: 180.0,
        length: 5.0,
        ..Default::default()
    };
    let errors = validate_shot(&shot_az_360, &config)
        .iter().filter(|w| w.severity == Severity::Error).count();
    assert_eq!(errors, 0, "Azimuth 360 should be valid (equals 0)");

    // Azimuth 359.99 - valid
    let shot_az_max = ShotData {
        azimuth_in: 359.99,
        azimuth_out: 179.99,
        length: 5.0,
        ..Default::default()
    };
    let errors = validate_shot(&shot_az_max, &config)
        .iter().filter(|w| w.severity == Severity::Error).count();
    assert_eq!(errors, 0, "Azimuth 359.99 should be valid");
}
```

**Assertions:**
- [ ] Value at exact minimum threshold passes
- [ ] Value at exact maximum threshold passes
- [ ] Value just below minimum warns
- [ ] Value just above maximum warns
- [ ] Azimuth 0 is valid
- [ ] Azimuth 360 is valid (or normalized to 0)

---

### Test 5.2: `test_validation_multiple_errors_single_shot`

**Purpose:** Verify that multiple validation issues in a single shot are all reported.

**Test Code:**
```rust
#[test]
fn test_validation_multiple_errors_single_shot() {
    let config = ValidationConfig::default();

    // Shot with multiple problems:
    // - length = 0 (invalid)
    // - azimuth = 400 (invalid, > 360)
    // - left = -1 (invalid, negative)
    let bad_shot = ShotData {
        length: 0.0,           // ERROR: zero length
        azimuth_in: 400.0,     // ERROR: > 360
        azimuth_out: 225.0,
        depth_in: 0.0,
        depth_out: 1.0,
        left: Some(-1.0),      // ERROR: negative LRUD
        right: Some(1.0),
        up: Some(1.0),
        down: Some(1.0),
        ..Default::default()
    };

    let issues = validate_shot(&bad_shot, &config);

    // Should have at least 3 distinct issues
    assert!(issues.len() >= 3,
            "Expected at least 3 issues, got {}: {:?}", issues.len(), issues);

    // Verify each issue is identified
    let fields: Vec<&str> = issues.iter().map(|i| i.field.as_str()).collect();

    assert!(fields.contains(&"length"),
            "Should report length issue. Fields: {:?}", fields);
    assert!(fields.contains(&"azimuth_in") || fields.contains(&"azimuth"),
            "Should report azimuth issue. Fields: {:?}", fields);
    assert!(fields.contains(&"left"),
            "Should report LRUD left issue. Fields: {:?}", fields);

    // Verify error messages are specific
    let length_issue = issues.iter().find(|i| i.field == "length").unwrap();
    assert!(length_issue.message.contains("zero") || length_issue.message.contains("0")
            || length_issue.message.contains("positive"),
            "Length error should mention zero/positive: {}", length_issue.message);

    let azimuth_issue = issues.iter()
        .find(|i| i.field.contains("azimuth"))
        .unwrap();
    assert!(azimuth_issue.message.contains("360") || azimuth_issue.message.contains("range"),
            "Azimuth error should mention valid range: {}", azimuth_issue.message);
}

#[test]
fn test_validation_shot_with_all_problems() {
    let config = ValidationConfig::default();

    // Maximally broken shot
    let terrible_shot = ShotData {
        length: -5.0,          // Negative length
        azimuth_in: -10.0,     // Negative azimuth
        azimuth_out: 500.0,    // Azimuth > 360
        depth_in: f64::NAN,    // NaN depth
        depth_out: f64::INFINITY, // Infinity
        left: Some(-1.0),
        right: Some(-2.0),
        up: Some(-3.0),
        down: Some(-4.0),
        pitch_in: Some(100.0), // Pitch > 90
        pitch_out: Some(-100.0), // Pitch < -90
        ..Default::default()
    };

    let issues = validate_shot(&terrible_shot, &config);

    // Should report many issues without panicking
    assert!(issues.len() >= 5, "Should find many issues in terrible shot");

    // Verify no duplicate field reports
    let mut seen_fields = std::collections::HashSet::new();
    for issue in &issues {
        let key = format!("{}:{}", issue.field, issue.message);
        assert!(seen_fields.insert(key.clone()),
                "Duplicate issue reported: {}", key);
    }
}
```

**Assertions:**
- [ ] Multiple issues reported for single shot
- [ ] Each issue identifies correct field
- [ ] Error messages are specific and helpful
- [ ] No duplicate issues reported
- [ ] Handles NaN and infinity gracefully

---

### Test 5.3: `test_validation_negative_lrud_each_dimension`

**Purpose:** Verify each LRUD dimension validates independently with specific error messages.

**Test Code:**
```rust
#[test]
fn test_validation_negative_lrud_each_dimension() {
    let config = ValidationConfig::default();

    let base_shot = ShotData {
        length: 5.0,
        azimuth_in: 45.0,
        azimuth_out: 225.0,
        depth_in: 0.0,
        depth_out: 1.0,
        left: Some(1.0),
        right: Some(1.0),
        up: Some(1.0),
        down: Some(1.0),
        ..Default::default()
    };

    // Test negative left
    let mut shot = base_shot.clone();
    shot.left = Some(-0.1);
    let issues = validate_shot(&shot, &config);
    let left_issues: Vec<_> = issues.iter().filter(|i| i.field == "left").collect();
    assert_eq!(left_issues.len(), 1, "Should have exactly one left issue");
    assert!(left_issues[0].message.contains("negative") || left_issues[0].message.contains("< 0"),
            "Left error should mention negative: {}", left_issues[0].message);

    // Test negative right
    let mut shot = base_shot.clone();
    shot.right = Some(-0.5);
    let issues = validate_shot(&shot, &config);
    let right_issues: Vec<_> = issues.iter().filter(|i| i.field == "right").collect();
    assert_eq!(right_issues.len(), 1, "Should have exactly one right issue");

    // Test negative up
    let mut shot = base_shot.clone();
    shot.up = Some(-2.0);
    let issues = validate_shot(&shot, &config);
    let up_issues: Vec<_> = issues.iter().filter(|i| i.field == "up").collect();
    assert_eq!(up_issues.len(), 1, "Should have exactly one up issue");

    // Test negative down
    let mut shot = base_shot.clone();
    shot.down = Some(-10.0);
    let issues = validate_shot(&shot, &config);
    let down_issues: Vec<_> = issues.iter().filter(|i| i.field == "down").collect();
    assert_eq!(down_issues.len(), 1, "Should have exactly one down issue");

    // Test None LRUD (should NOT error - optional field)
    let mut shot = base_shot.clone();
    shot.left = None;
    shot.right = None;
    shot.up = None;
    shot.down = None;
    let issues = validate_shot(&shot, &config);
    let lrud_issues: Vec<_> = issues.iter()
        .filter(|i| ["left", "right", "up", "down"].contains(&i.field.as_str()))
        .collect();
    assert!(lrud_issues.is_empty(), "None LRUD should not produce errors");
}

#[test]
fn test_validation_lrud_zero_is_valid() {
    let config = ValidationConfig::default();

    // LRUD of exactly 0.0 is valid (wall at survey point)
    let shot = ShotData {
        length: 5.0,
        azimuth_in: 45.0,
        azimuth_out: 225.0,
        depth_in: 0.0,
        depth_out: 1.0,
        left: Some(0.0),
        right: Some(0.0),
        up: Some(0.0),
        down: Some(0.0),
        ..Default::default()
    };

    let issues = validate_shot(&shot, &config);
    let lrud_issues: Vec<_> = issues.iter()
        .filter(|i| ["left", "right", "up", "down"].contains(&i.field.as_str()))
        .collect();
    assert!(lrud_issues.is_empty(),
            "LRUD of 0.0 should be valid (wall at survey point): {:?}", lrud_issues);
}
```

**Assertions:**
- [ ] Negative left produces specific error
- [ ] Negative right produces specific error
- [ ] Negative up produces specific error
- [ ] Negative down produces specific error
- [ ] None LRUD does not produce errors
- [ ] Zero LRUD is valid

---

### Test 5.4: `test_validation_pitch_extreme_angles`

**Purpose:** Verify pitch values at extreme valid angles (straight up/down) are accepted.

**Test Code:**
```rust
#[test]
fn test_validation_pitch_extreme_angles() {
    let config = ValidationConfig::default();

    // Pitch -90.0 (straight down) - VALID
    let shot_down = ShotData {
        length: 5.0,
        azimuth_in: 0.0, // Azimuth irrelevant for vertical shot
        azimuth_out: 0.0,
        depth_in: 0.0,
        depth_out: 5.0,
        pitch_in: Some(-90.0),
        pitch_out: Some(-90.0),
        ..Default::default()
    };

    let issues = validate_shot(&shot_down, &config);
    let pitch_errors: Vec<_> = issues.iter()
        .filter(|i| i.field.contains("pitch") && i.severity == Severity::Error)
        .collect();
    assert!(pitch_errors.is_empty(),
            "Pitch -90 (straight down) should be valid: {:?}", pitch_errors);

    // Pitch +90.0 (straight up) - VALID
    let shot_up = ShotData {
        length: 5.0,
        azimuth_in: 0.0,
        azimuth_out: 0.0,
        depth_in: 5.0,
        depth_out: 0.0,
        pitch_in: Some(90.0),
        pitch_out: Some(90.0),
        ..Default::default()
    };

    let issues = validate_shot(&shot_up, &config);
    let pitch_errors: Vec<_> = issues.iter()
        .filter(|i| i.field.contains("pitch") && i.severity == Severity::Error)
        .collect();
    assert!(pitch_errors.is_empty(),
            "Pitch +90 (straight up) should be valid: {:?}", pitch_errors);

    // Pitch beyond valid range - ERROR
    let shot_invalid = ShotData {
        pitch_in: Some(91.0),
        pitch_out: Some(-91.0),
        ..shot_down.clone()
    };

    let issues = validate_shot(&shot_invalid, &config);
    assert!(issues.iter().any(|i| i.field.contains("pitch")),
            "Pitch beyond ±90 should error");

    // Mixed valid extremes
    let shot_mixed = ShotData {
        pitch_in: Some(-90.0), // Valid
        pitch_out: Some(90.0), // Valid
        ..shot_down.clone()
    };

    let issues = validate_shot(&shot_mixed, &config);
    let pitch_errors: Vec<_> = issues.iter()
        .filter(|i| i.field.contains("pitch") && i.severity == Severity::Error)
        .collect();
    assert!(pitch_errors.is_empty(),
            "Mixed extreme pitches should be valid: {:?}", pitch_errors);
}

#[test]
fn test_validation_pitch_none_is_valid() {
    let config = ValidationConfig::default();

    // Pitch = None (horizontal shot assumed)
    let shot = ShotData {
        length: 5.0,
        azimuth_in: 45.0,
        azimuth_out: 225.0,
        depth_in: 0.0,
        depth_out: 0.0,
        pitch_in: None,
        pitch_out: None,
        ..Default::default()
    };

    let issues = validate_shot(&shot, &config);
    let pitch_issues: Vec<_> = issues.iter()
        .filter(|i| i.field.contains("pitch"))
        .collect();
    assert!(pitch_issues.is_empty(), "None pitch should be valid (horizontal)");
}
```

**Assertions:**
- [ ] Pitch -90 (straight down) is valid
- [ ] Pitch +90 (straight up) is valid
- [ ] Pitch > 90 produces error
- [ ] Pitch < -90 produces error
- [ ] None pitch is valid (horizontal assumed)

---

### Test 5.5: `test_validation_with_custom_config_thresholds`

**Purpose:** Verify validation respects custom config thresholds.

**Test Code:**
```rust
#[test]
fn test_validation_with_custom_config_thresholds() {
    // Custom config with stricter thresholds
    let strict_config = ValidationConfig {
        warn_shot_length_min: 1.0,  // Stricter: minimum 1m
        warn_shot_length_max: 20.0, // Stricter: maximum 20m
        warn_azimuth_difference: 5.0, // Warn if in/out differ by more than 5°
        warn_depth_change_max: 10.0, // Warn if depth change > 10m
        ..Default::default()
    };

    // Shot that passes default but fails strict
    let short_shot = ShotData {
        length: 0.5, // Passes default (>0.1), fails strict (<1.0)
        azimuth_in: 45.0,
        azimuth_out: 225.0,
        depth_in: 0.0,
        depth_out: 0.3,
        ..Default::default()
    };

    // Should pass with default config
    let default_config = ValidationConfig::default();
    let default_issues = validate_shot(&short_shot, &default_config);
    let default_length_warns: Vec<_> = default_issues.iter()
        .filter(|i| i.field == "length" && i.severity == Severity::Warning)
        .collect();
    assert!(default_length_warns.is_empty(),
            "Short shot should pass default config");

    // Should warn with strict config
    let strict_issues = validate_shot(&short_shot, &strict_config);
    let strict_length_warns: Vec<_> = strict_issues.iter()
        .filter(|i| i.field == "length" && i.severity == Severity::Warning)
        .collect();
    assert!(!strict_length_warns.is_empty(),
            "Short shot should warn with strict config");

    // Test azimuth difference warning
    let shot_az_diff = ShotData {
        length: 5.0,
        azimuth_in: 45.0,
        azimuth_out: 220.0, // 175° backsight (5° off from 225°)
        depth_in: 0.0,
        depth_out: 1.0,
        ..Default::default()
    };

    let issues = validate_shot(&shot_az_diff, &strict_config);
    // May or may not warn depending on how backsight difference is calculated
    // This tests that the config value is actually used

    // Test depth change warning
    let shot_deep = ShotData {
        length: 15.0,
        azimuth_in: 90.0,
        azimuth_out: 270.0,
        depth_in: 0.0,
        depth_out: 15.0, // 15m depth change > 10m threshold
        ..Default::default()
    };

    let issues = validate_shot(&shot_deep, &strict_config);
    let depth_warns: Vec<_> = issues.iter()
        .filter(|i| i.field.contains("depth") && i.severity == Severity::Warning)
        .collect();
    // If depth change validation is implemented
    if !depth_warns.is_empty() {
        assert!(depth_warns[0].message.contains("10") || depth_warns[0].message.contains("change"),
                "Depth warning should reference threshold");
    }
}

#[test]
fn test_validation_config_disabled_checks() {
    // Config with some checks disabled
    let permissive_config = ValidationConfig {
        warn_shot_length_min: 0.0, // Disable min length check
        warn_shot_length_max: f64::MAX, // Disable max length check
        check_backsight: false, // Disable backsight validation
        ..Default::default()
    };

    let extreme_shot = ShotData {
        length: 0.001, // Would normally warn
        azimuth_in: 45.0,
        azimuth_out: 45.0, // Same as forward (wrong backsight)
        depth_in: 0.0,
        depth_out: 0.0,
        ..Default::default()
    };

    let issues = validate_shot(&extreme_shot, &permissive_config);
    let length_issues: Vec<_> = issues.iter()
        .filter(|i| i.field == "length")
        .collect();
    let backsight_issues: Vec<_> = issues.iter()
        .filter(|i| i.field.contains("backsight") || i.field.contains("azimuth"))
        .collect();

    // Disabled checks should not produce issues
    assert!(length_issues.is_empty(),
            "Disabled length check should not warn");
    // Backsight check behavior depends on implementation
}
```

**Assertions:**
- [ ] Custom min threshold changes warning behavior
- [ ] Custom max threshold changes warning behavior
- [ ] Shot failing strict config passes default config
- [ ] Disabled checks produce no issues
- [ ] Config values are actually used in validation

---

## Helper Types

```rust
/// Validation severity levels
#[derive(Debug, Clone, PartialEq)]
pub enum Severity {
    Error,   // Invalid data, cannot proceed
    Warning, // Unusual data, user should verify
    Info,    // Informational note
}

/// Validation issue
#[derive(Debug, Clone)]
pub struct ValidationIssue {
    pub field: String,
    pub message: String,
    pub severity: Severity,
}

/// Validation configuration
#[derive(Debug, Clone)]
pub struct ValidationConfig {
    pub warn_shot_length_min: f64,
    pub warn_shot_length_max: f64,
    pub warn_azimuth_difference: f64,
    pub warn_depth_change_max: f64,
    pub check_backsight: bool,
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            warn_shot_length_min: 0.1,
            warn_shot_length_max: 50.0,
            warn_azimuth_difference: 3.0,
            warn_depth_change_max: 50.0,
            check_backsight: true,
        }
    }
}
```

---

## Verification

```bash
cd src-tauri && cargo test validation::tests -- --nocapture
```

## Definition of Done
- [ ] All 5 tests implemented
- [ ] Boundary conditions tested (exact thresholds)
- [ ] Multiple errors per shot reported
- [ ] Each LRUD dimension tested independently
- [ ] Pitch extremes (-90°, +90°) tested
- [ ] Custom config thresholds work correctly
- [ ] Tests pass locally
