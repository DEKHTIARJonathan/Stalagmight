use super::*;
use serde::{Deserialize, Serialize};

// ========================================================================
// Default Values Tests
// ========================================================================

#[test]
fn test_station_config_defaults() {
    let config = StationConfig::default();
    assert_eq!(config.radius, 4.0);
    assert_eq!(config.hit_area, 10.0);
}

#[test]
fn test_shot_config_defaults() {
    let config = ShotConfig::default();
    assert_eq!(config.width, 2.0);
    assert_eq!(config.hit_area, 8.0);
}

#[test]
fn test_map_snap_config_defaults() {
    let config = MapSnapConfig::default();
    assert_eq!(config.threshold, 10.0);
    assert!(config.enabled_draw);
    assert!(config.enabled_merge);
    assert!(config.enabled_measure);
}

#[test]
fn test_map_config_defaults() {
    let config = MapConfig::default();
    assert_eq!(config.station.radius, 4.0);
    assert_eq!(config.station.hit_area, 10.0);
    assert_eq!(config.shot.width, 2.0);
    assert_eq!(config.shot.hit_area, 8.0);
    assert_eq!(config.snap.threshold, 10.0);
    assert_eq!(config.zoom_step, 1.0);
}

#[test]
fn test_debug_config_defaults() {
    let config = DebugConfig::default();
    assert!(!config.map.show_hitboxes);
    assert!(!config.map.log_hit_detection);
}

// ========================================================================
// Station Config Validation Tests
// ========================================================================

#[test]
fn test_station_validation_accepts_minimum_bound() {
    let mut config = StationConfig { radius: 1.0, hit_area: 1.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 1.0);
    assert_eq!(config.hit_area, 1.0);
}

#[test]
fn test_station_validation_accepts_mid_range() {
    let mut config = StationConfig { radius: 25.0, hit_area: 25.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 25.0);
    assert_eq!(config.hit_area, 25.0);
}

#[test]
fn test_station_validation_accepts_maximum_bound() {
    let mut config = StationConfig { radius: 50.0, hit_area: 50.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 50.0);
    assert_eq!(config.hit_area, 50.0);
}

#[test]
fn test_station_validation_rejects_zero() {
    let mut config = StationConfig { radius: 0.0, hit_area: 0.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 1.0); // clamped to min
    assert_eq!(config.hit_area, 1.0); // clamped to min
}

#[test]
fn test_station_validation_rejects_negative() {
    let mut config = StationConfig { radius: -1.0, hit_area: -1.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 1.0); // clamped to min
    assert_eq!(config.hit_area, 1.0); // clamped to min
}

#[test]
fn test_station_validation_rejects_above_max() {
    let mut config = StationConfig { radius: 51.0, hit_area: 51.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 50.0); // clamped to max
    assert_eq!(config.hit_area, 50.0); // clamped to max
}

#[test]
fn test_station_validation_rejects_large_values() {
    let mut config = StationConfig { radius: 100.0, hit_area: 100.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 50.0); // clamped to max
    assert_eq!(config.hit_area, 50.0); // clamped to max
}

#[test]
fn test_station_validation_handles_nan() {
    let mut config = StationConfig { radius: f64::NAN, hit_area: f64::NAN, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 4.0); // default
    assert_eq!(config.hit_area, 10.0); // default
}

#[test]
fn test_station_validation_handles_infinity() {
    let mut config = StationConfig { radius: f64::INFINITY, hit_area: f64::INFINITY, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 4.0); // default
    assert_eq!(config.hit_area, 10.0); // default
}

#[test]
fn test_station_validation_handles_neg_infinity() {
    let mut config = StationConfig { radius: f64::NEG_INFINITY, hit_area: f64::NEG_INFINITY, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 4.0); // default
    assert_eq!(config.hit_area, 10.0); // default
}

#[test]
fn test_station_hit_area_enforced_gte_radius() {
    let mut config = StationConfig { radius: 20.0, hit_area: 10.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.radius, 20.0);
    assert_eq!(config.hit_area, 20.0); // enforced >= radius
}

// ========================================================================
// Shot Config Validation Tests
// ========================================================================

#[test]
fn test_shot_validation_accepts_minimum_bound() {
    let mut config = ShotConfig { width: 0.5, hit_area: 0.5, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 0.5);
    assert_eq!(config.hit_area, 0.5);
}

#[test]
fn test_shot_validation_accepts_mid_range() {
    let mut config = ShotConfig { width: 10.0, hit_area: 10.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 10.0);
    assert_eq!(config.hit_area, 10.0);
}

#[test]
fn test_shot_validation_accepts_maximum_bound() {
    let mut config = ShotConfig { width: 20.0, hit_area: 20.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 20.0);
    assert_eq!(config.hit_area, 20.0);
}

#[test]
fn test_shot_validation_rejects_zero() {
    let mut config = ShotConfig { width: 0.0, hit_area: 0.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 0.5); // clamped to min
    assert_eq!(config.hit_area, 0.5); // clamped to min
}

#[test]
fn test_shot_validation_rejects_negative() {
    let mut config = ShotConfig { width: -1.0, hit_area: -1.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 0.5); // clamped to min
    assert_eq!(config.hit_area, 0.5); // clamped to min
}

#[test]
fn test_shot_validation_rejects_above_max() {
    let mut config = ShotConfig { width: 21.0, hit_area: 21.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 20.0); // clamped to max
    assert_eq!(config.hit_area, 20.0); // clamped to max
}

#[test]
fn test_shot_validation_rejects_large_values() {
    let mut config = ShotConfig { width: 100.0, hit_area: 100.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 20.0); // clamped to max
    assert_eq!(config.hit_area, 20.0); // clamped to max
}

#[test]
fn test_shot_validation_handles_nan() {
    let mut config = ShotConfig { width: f64::NAN, hit_area: f64::NAN, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 2.0); // default
    assert_eq!(config.hit_area, 8.0); // default
}

#[test]
fn test_shot_validation_handles_infinity() {
    let mut config = ShotConfig { width: f64::INFINITY, hit_area: f64::INFINITY, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 2.0); // default
    assert_eq!(config.hit_area, 8.0); // default
}

#[test]
fn test_shot_hit_area_enforced_gte_width() {
    let mut config = ShotConfig { width: 15.0, hit_area: 5.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.width, 15.0);
    assert_eq!(config.hit_area, 15.0); // enforced >= width
}

// ========================================================================
// Snap Config Validation Tests
// ========================================================================

#[test]
fn test_snap_validation_accepts_minimum_bound() {
    let mut config = MapSnapConfig { threshold: 1.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.threshold, 1.0);
}

#[test]
fn test_snap_validation_accepts_mid_range() {
    let mut config = MapSnapConfig { threshold: 25.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.threshold, 25.0);
}

#[test]
fn test_snap_validation_accepts_maximum_bound() {
    let mut config = MapSnapConfig { threshold: 50.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.threshold, 50.0);
}

#[test]
fn test_snap_validation_rejects_zero() {
    let mut config = MapSnapConfig { threshold: 0.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.threshold, 1.0); // clamped to min
}

#[test]
fn test_snap_validation_rejects_negative() {
    let mut config = MapSnapConfig { threshold: -1.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.threshold, 1.0); // clamped to min
}

#[test]
fn test_snap_validation_rejects_above_max() {
    let mut config = MapSnapConfig { threshold: 51.0, ..Default::default() };
    config.normalize();
    assert_eq!(config.threshold, 50.0); // clamped to max
}

#[test]
fn test_snap_validation_handles_nan() {
    let mut config = MapSnapConfig { threshold: f64::NAN, ..Default::default() };
    config.normalize();
    assert_eq!(config.threshold, 10.0); // default
}

#[test]
fn test_snap_validation_handles_infinity() {
    let mut config = MapSnapConfig { threshold: f64::INFINITY, ..Default::default() };
    config.normalize();
    assert_eq!(config.threshold, 10.0); // default
}

// ========================================================================
// Config Parsing Tests
// ========================================================================

#[test]
fn test_config_parsing_complete() {
    let toml_str = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22
zoom_step = 1.5

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[map.station]
radius = 6.0
hit_area = 12.0

[map.shot]
width = 3.0
hit_area = 10.0

[map.snap]
threshold = 15.0
enabled_draw = true
enabled_merge = false
enabled_measure = true

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"

[debug.map]
show_hitboxes = true
log_hit_detection = true
"##;

    let config: Config = toml::from_str(toml_str).expect("Complete config should parse");

    // Verify map section values
    assert_eq!(config.map.station.radius, 6.0);
    assert_eq!(config.map.station.hit_area, 12.0);
    assert_eq!(config.map.shot.width, 3.0);
    assert_eq!(config.map.shot.hit_area, 10.0);
    assert_eq!(config.map.snap.threshold, 15.0);
    assert!(config.map.snap.enabled_draw);
    assert!(!config.map.snap.enabled_merge);
    assert!(config.map.snap.enabled_measure);
    assert_eq!(config.map.zoom_step, 1.5);

    // Verify debug values
    assert!(config.debug.map.show_hitboxes);
    assert!(config.debug.map.log_hit_detection);
}

#[test]
fn test_config_parsing_partial_uses_defaults() {
    // Config with only required sections, missing optional nested configs
    let toml_str = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"
"##;

    let config: Config = toml::from_str(toml_str).expect("Partial config should parse");

    // Missing sections should use defaults
    assert_eq!(config.map.station.radius, 4.0); // default
    assert_eq!(config.map.station.hit_area, 10.0); // default
    assert_eq!(config.map.shot.width, 2.0); // default
    assert_eq!(config.map.shot.hit_area, 8.0); // default
    assert_eq!(config.map.snap.threshold, 10.0); // default
    assert!(config.map.snap.enabled_draw); // default
    assert!(config.map.snap.enabled_merge); // default
    assert!(config.map.snap.enabled_measure); // default
    assert_eq!(config.map.zoom_step, 1.0); // default

    // Debug section defaults
    assert!(!config.debug.map.show_hitboxes);
    assert!(!config.debug.map.log_hit_detection);
}

#[test]
fn test_config_parsing_partial_station_uses_field_defaults() {
    // Config with partial station config (only radius, missing hit_area)
    let toml_str = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[map.station]
radius = 8.0

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"
"##;

    let config: Config = toml::from_str(toml_str).expect("Config with partial station should parse");

    // Explicit value
    assert_eq!(config.map.station.radius, 8.0);
    // Missing field uses default
    assert_eq!(config.map.station.hit_area, 10.0);
}

// ========================================================================
// Config Serialization Tests
// ========================================================================

#[test]
fn test_config_serialization_roundtrip() {
    let original = Config::default();
    let serialized = toml::to_string_pretty(&original).expect("Config should serialize");
    let deserialized: Config = toml::from_str(&serialized).expect("Serialized config should parse");

    // Verify key values survived roundtrip
    assert_eq!(deserialized.map.station.radius, original.map.station.radius);
    assert_eq!(deserialized.map.station.hit_area, original.map.station.hit_area);
    assert_eq!(deserialized.map.shot.width, original.map.shot.width);
    assert_eq!(deserialized.map.shot.hit_area, original.map.shot.hit_area);
    assert_eq!(deserialized.map.snap.threshold, original.map.snap.threshold);
    assert_eq!(deserialized.debug.map.show_hitboxes, original.debug.map.show_hitboxes);
}

#[test]
fn test_config_serialization_preserves_custom_values() {
    let mut config = Config::default();
    config.map.station.radius = 8.0;
    config.map.station.hit_area = 16.0;
    config.map.shot.width = 4.0;
    config.map.shot.hit_area = 12.0;
    config.map.snap.threshold = 20.0;
    config.map.snap.enabled_draw = false;
    config.debug.map.show_hitboxes = true;

    let serialized = toml::to_string_pretty(&config).expect("Config should serialize");
    let deserialized: Config = toml::from_str(&serialized).expect("Serialized config should parse");

    assert_eq!(deserialized.map.station.radius, 8.0);
    assert_eq!(deserialized.map.station.hit_area, 16.0);
    assert_eq!(deserialized.map.shot.width, 4.0);
    assert_eq!(deserialized.map.shot.hit_area, 12.0);
    assert_eq!(deserialized.map.snap.threshold, 20.0);
    assert!(!deserialized.map.snap.enabled_draw);
    assert!(deserialized.debug.map.show_hitboxes);
}

#[test]
fn test_config_serialization_includes_map_section() {
    let config = Config::default();
    let serialized = toml::to_string_pretty(&config).expect("Config should serialize");

    assert!(serialized.contains("[map.station]"));
    assert!(serialized.contains("radius"));
    assert!(serialized.contains("hit_area"));
    assert!(serialized.contains("[map.shot]"));
    assert!(serialized.contains("width"));
    assert!(serialized.contains("[map.snap]"));
    assert!(serialized.contains("threshold"));
    assert!(serialized.contains("[debug.map]"));
    assert!(serialized.contains("show_hitboxes"));
}

// ========================================================================
// Legacy Migration Tests (existing)
// ========================================================================

#[test]
fn test_legacy_snap_migration() {
    let old_config_toml = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"

[snap]
enabled_draw = false
enabled_merge = true
enabled_measure = false
threshold_pixels = 25
"##;

    let mut config: Config = toml::from_str(old_config_toml)
        .expect("Config with legacy [snap] should parse");

    // Before migration, map.snap has defaults
    assert_eq!(config.map.snap.threshold, 10.0);
    assert!(config.map.snap.enabled_draw);
    assert!(config.map.snap.enabled_merge);
    assert!(config.map.snap.enabled_measure);

    // legacy_snap should have the old values
    assert!(config.legacy_snap.is_some());

    // Run migration (simulating what Config::load does)
    config.migrate_legacy();
    config.normalize();

    // After migration, map.snap should have the legacy values
    assert_eq!(config.map.snap.threshold, 25.0);
    assert!(!config.map.snap.enabled_draw);
    assert!(config.map.snap.enabled_merge);
    assert!(!config.map.snap.enabled_measure);

    // legacy_snap should be consumed (taken)
    assert!(config.legacy_snap.is_none());
}

#[test]
fn test_legacy_snap_not_migrated_when_new_config_present() {
    // If user has both old [snap] and new [map.snap], prefer new values
    let mixed_config_toml = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "openstreetmap"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[map.snap]
threshold = 30.0
enabled_draw = true
enabled_merge = false
enabled_measure = true

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"

[snap]
enabled_draw = false
enabled_merge = true
enabled_measure = false
threshold_pixels = 25
"##;

    let mut config: Config = toml::from_str(mixed_config_toml)
        .expect("Config with both snap configs should parse");

    // map.snap has explicit values (not defaults)
    assert_eq!(config.map.snap.threshold, 30.0);
    assert!(config.map.snap.enabled_draw);
    assert!(!config.map.snap.enabled_merge);
    assert!(config.map.snap.enabled_measure);

    // Run migration
    config.migrate_legacy();
    config.normalize();

    // map.snap should NOT be overwritten by legacy values
    // (because map.snap was explicitly set, not defaults)
    assert_eq!(config.map.snap.threshold, 30.0);
    assert!(config.map.snap.enabled_draw);
    assert!(!config.map.snap.enabled_merge);
    assert!(config.map.snap.enabled_measure);
}

// ========================================================================
// Shortcut Deserializer Tests
// ========================================================================

#[test]
fn test_shortcut_deserialize_legacy_string() {
    // Test deserializing old format (single string)
    let toml_str = r#"
select = "S"
pan = "P"
"#;
    let config: ShortcutsConfig = toml::from_str(toml_str).expect("Legacy string should parse");
    assert_eq!(config.select, vec!["S".to_string()]);
    assert_eq!(config.pan, vec!["P".to_string()]);
}

#[test]
fn test_shortcut_deserialize_new_array() {
    // Test deserializing new format (array)
    let toml_str = r#"
select = ["S", "Shift+S"]
pan = ["P"]
"#;
    let config: ShortcutsConfig = toml::from_str(toml_str).expect("Array format should parse");
    assert_eq!(config.select, vec!["S".to_string(), "Shift+S".to_string()]);
    assert_eq!(config.pan, vec!["P".to_string()]);
}

#[test]
fn test_shortcut_deserialize_mixed_formats() {
    // Test deserializing mix of old and new formats
    let toml_str = r#"
select = "S"
pan = ["P", "Shift+P"]
zoom = "Z"
"#;
    let config: ShortcutsConfig = toml::from_str(toml_str).expect("Mixed format should parse");
    assert_eq!(config.select, vec!["S".to_string()]);
    assert_eq!(config.pan, vec!["P".to_string(), "Shift+P".to_string()]);
    assert_eq!(config.zoom, vec!["Z".to_string()]);
}

#[test]
fn test_shortcut_missing_fields_use_defaults() {
    // Test that missing fields get defaults via #[serde(default)]
    let toml_str = r#"
select = "S"
"#;
    let mut config: ShortcutsConfig = toml::from_str(toml_str).expect("Partial config should parse");
    config.normalize();

    // Explicit value
    assert_eq!(config.select, vec!["S".to_string()]);
    // Missing fields should have defaults after normalize
    assert_eq!(config.pan, vec!["P".to_string()]);
    assert_eq!(config.undo, vec!["Ctrl+Z".to_string()]);
    assert_eq!(config.zoom_in, vec!["Equal".to_string(), "Plus".to_string()]);
}

// ========================================================================
// Shortcut Normalization Tests
// ========================================================================

#[test]
fn test_normalize_shortcut_simple_key() {
    assert_eq!(normalize_shortcut("S"), Some("S".to_string()));
    assert_eq!(normalize_shortcut("s"), Some("S".to_string()));
    assert_eq!(normalize_shortcut("1"), Some("1".to_string()));
    assert_eq!(normalize_shortcut("Digit1"), Some("1".to_string()));
    assert_eq!(normalize_shortcut("Numpad1"), Some("1".to_string()));
}

#[test]
fn test_normalize_shortcut_with_modifiers() {
    assert_eq!(normalize_shortcut("Ctrl+S"), Some("Ctrl+S".to_string()));
    assert_eq!(normalize_shortcut("ctrl+s"), Some("Ctrl+S".to_string()));
    assert_eq!(normalize_shortcut("CTRL+S"), Some("Ctrl+S".to_string()));
    assert_eq!(normalize_shortcut("Ctrl+Digit1"), Some("Ctrl+1".to_string()));
    assert_eq!(normalize_shortcut("Ctrl+Numpad1"), Some("Ctrl+1".to_string()));
}

#[test]
fn test_normalize_shortcut_modifier_order() {
    // Modifiers should always be Ctrl+Alt+Shift+Key
    assert_eq!(normalize_shortcut("Shift+Ctrl+S"), Some("Ctrl+Shift+S".to_string()));
    assert_eq!(normalize_shortcut("Alt+Ctrl+S"), Some("Ctrl+Alt+S".to_string()));
    assert_eq!(normalize_shortcut("Shift+Alt+Ctrl+S"), Some("Ctrl+Alt+Shift+S".to_string()));
}

#[test]
fn test_normalize_shortcut_platform_aliases() {
    // Meta/Cmd/Command should normalize to Ctrl
    assert_eq!(normalize_shortcut("Meta+S"), Some("Ctrl+S".to_string()));
    assert_eq!(normalize_shortcut("Cmd+S"), Some("Ctrl+S".to_string()));
    assert_eq!(normalize_shortcut("Command+S"), Some("Ctrl+S".to_string()));
    assert_eq!(normalize_shortcut("Option+S"), Some("Alt+S".to_string()));
}

#[test]
fn test_normalize_shortcut_special_keys() {
    assert_eq!(normalize_shortcut("Space"), Some("Space".to_string()));
    assert_eq!(normalize_shortcut("space"), Some("Space".to_string()));
    assert_eq!(normalize_shortcut("Enter"), Some("Enter".to_string()));
    assert_eq!(normalize_shortcut("Return"), Some("Enter".to_string()));
    assert_eq!(normalize_shortcut("Escape"), Some("Escape".to_string()));
    assert_eq!(normalize_shortcut("Esc"), Some("Escape".to_string()));
    assert_eq!(normalize_shortcut("ArrowUp"), Some("ArrowUp".to_string()));
    assert_eq!(normalize_shortcut("Up"), Some("ArrowUp".to_string()));
    assert_eq!(normalize_shortcut("ArrowDown"), Some("ArrowDown".to_string()));
    assert_eq!(normalize_shortcut("Down"), Some("ArrowDown".to_string()));
}

#[test]
fn test_normalize_shortcut_plus_minus_equal() {
    assert_eq!(normalize_shortcut("+"), Some("Plus".to_string()));
    assert_eq!(normalize_shortcut("Plus"), Some("Plus".to_string()));
    assert_eq!(normalize_shortcut("-"), Some("Minus".to_string()));
    assert_eq!(normalize_shortcut("Minus"), Some("Minus".to_string()));
    assert_eq!(normalize_shortcut("="), Some("Equal".to_string()));
    assert_eq!(normalize_shortcut("Equal"), Some("Equal".to_string()));
}

#[test]
fn test_normalize_shortcut_function_keys() {
    assert_eq!(normalize_shortcut("F1"), Some("F1".to_string()));
    assert_eq!(normalize_shortcut("f1"), Some("F1".to_string()));
    assert_eq!(normalize_shortcut("F12"), Some("F12".to_string()));
}

#[test]
fn test_normalize_shortcut_invalid() {
    // Empty string
    assert_eq!(normalize_shortcut(""), None);
    // Only whitespace
    assert_eq!(normalize_shortcut("   "), None);
    // Multiple non-modifier keys
    assert_eq!(normalize_shortcut("A+B"), None);
    // Empty parts in middle
    assert_eq!(normalize_shortcut("Ctrl++S"), None);
}

#[test]
fn test_normalize_shortcut_trailing_plus() {
    // "Ctrl+" is valid and means Ctrl+Plus
    assert_eq!(normalize_shortcut("Ctrl+"), Some("Ctrl+Plus".to_string()));
    assert_eq!(normalize_shortcut("Shift+"), Some("Shift+Plus".to_string()));
    // "Ctrl++" is also valid and means Ctrl+Plus (common representation)
    assert_eq!(normalize_shortcut("Ctrl++"), Some("Ctrl+Plus".to_string()));
    assert_eq!(normalize_shortcut("Shift++"), Some("Shift+Plus".to_string()));
    // Multiple modifiers with trailing +
    assert_eq!(normalize_shortcut("Ctrl+Shift+"), Some("Ctrl+Shift+Plus".to_string()));
    assert_eq!(normalize_shortcut("Ctrl+Shift++"), Some("Ctrl+Shift+Plus".to_string()));
}

#[test]
fn test_normalize_shortcut_remaining_special_keys() {
    // Arrow keys (all directions)
    assert_eq!(normalize_shortcut("ArrowLeft"), Some("ArrowLeft".to_string()));
    assert_eq!(normalize_shortcut("arrowleft"), Some("ArrowLeft".to_string()));
    assert_eq!(normalize_shortcut("Left"), Some("ArrowLeft".to_string()));
    assert_eq!(normalize_shortcut("ArrowRight"), Some("ArrowRight".to_string()));
    assert_eq!(normalize_shortcut("arrowright"), Some("ArrowRight".to_string()));
    assert_eq!(normalize_shortcut("Right"), Some("ArrowRight".to_string()));

    // Backspace
    assert_eq!(normalize_shortcut("Backspace"), Some("Backspace".to_string()));
    assert_eq!(normalize_shortcut("backspace"), Some("Backspace".to_string()));
    assert_eq!(normalize_shortcut("Back"), Some("Backspace".to_string()));

    // Delete
    assert_eq!(normalize_shortcut("Delete"), Some("Delete".to_string()));
    assert_eq!(normalize_shortcut("delete"), Some("Delete".to_string()));
    assert_eq!(normalize_shortcut("Del"), Some("Delete".to_string()));

    // Tab
    assert_eq!(normalize_shortcut("Tab"), Some("Tab".to_string()));
    assert_eq!(normalize_shortcut("tab"), Some("Tab".to_string()));

    // Home/End
    assert_eq!(normalize_shortcut("Home"), Some("Home".to_string()));
    assert_eq!(normalize_shortcut("End"), Some("End".to_string()));

    // Page Up/Down
    assert_eq!(normalize_shortcut("PageUp"), Some("PageUp".to_string()));
    assert_eq!(normalize_shortcut("pgup"), Some("PageUp".to_string()));
    assert_eq!(normalize_shortcut("PageDown"), Some("PageDown".to_string()));
    assert_eq!(normalize_shortcut("pgdn"), Some("PageDown".to_string()));

    // Insert
    assert_eq!(normalize_shortcut("Insert"), Some("Insert".to_string()));
    assert_eq!(normalize_shortcut("Ins"), Some("Insert".to_string()));
}

#[test]
fn test_normalize_shortcut_special_keys_with_modifiers() {
    assert_eq!(normalize_shortcut("Ctrl+ArrowLeft"), Some("Ctrl+ArrowLeft".to_string()));
    assert_eq!(normalize_shortcut("Shift+Delete"), Some("Shift+Delete".to_string()));
    assert_eq!(normalize_shortcut("Ctrl+Backspace"), Some("Ctrl+Backspace".to_string()));
    assert_eq!(normalize_shortcut("Alt+Tab"), Some("Alt+Tab".to_string()));
    assert_eq!(normalize_shortcut("Ctrl+Home"), Some("Ctrl+Home".to_string()));
    assert_eq!(normalize_shortcut("Ctrl+End"), Some("Ctrl+End".to_string()));
}

#[test]
fn test_shortcut_config_normalize_truncates() {
    let mut config = ShortcutsConfig::default();
    config.select = vec!["A".to_string(), "B".to_string(), "C".to_string()];
    config.normalize();
    // Should truncate to 2
    assert_eq!(config.select.len(), 2);
    assert_eq!(config.select, vec!["A".to_string(), "B".to_string()]);
}

#[test]
fn test_shortcut_config_normalize_removes_empty() {
    let mut config = ShortcutsConfig::default();
    config.select = vec!["".to_string(), "S".to_string(), "  ".to_string()];
    config.normalize();
    // Should remove empty and only keep "S"
    assert_eq!(config.select, vec!["S".to_string()]);
}

#[test]
fn test_shortcut_config_normalize_empty_uses_default() {
    let mut config = ShortcutsConfig::default();
    config.select = vec![];
    config.normalize();
    // Should use default
    assert_eq!(config.select, vec!["S".to_string()]);
}

#[test]
fn test_shortcut_config_normalize_invalid_falls_back() {
    let mut config = ShortcutsConfig::default();
    config.select = vec!["A+B".to_string()]; // Invalid (two non-modifier keys)
    config.normalize();
    // Should fall back to default
    assert_eq!(config.select, vec!["S".to_string()]);
}

// ========================================================================
// Legacy Delete Migration Tests
// ========================================================================

#[test]
fn test_shortcut_legacy_delete_migration() {
    // Old config with "delete" field should migrate to "delete_tool"
    let toml_str = r#"
select = "S"
delete = "X"
"#;
    let mut config: ShortcutsConfig = toml::from_str(toml_str).expect("Legacy delete should parse");
    config.normalize();

    // delete_tool should have the migrated value
    assert_eq!(config.delete_tool, vec!["X".to_string()]);
}

#[test]
fn test_shortcut_legacy_delete_array_migration() {
    // Legacy delete as array
    let toml_str = r#"
select = "S"
delete = ["X", "Shift+X"]
"#;
    let mut config: ShortcutsConfig = toml::from_str(toml_str).expect("Legacy delete array should parse");
    config.normalize();

    assert_eq!(config.delete_tool, vec!["X".to_string(), "Shift+X".to_string()]);
}

#[test]
fn test_shortcut_new_delete_tool_takes_precedence() {
    // If both delete and delete_tool present, delete_tool wins
    let toml_str = r#"
delete_tool = ["Y"]
delete = "X"
"#;
    let mut config: ShortcutsConfig = toml::from_str(toml_str).expect("Config should parse");
    config.normalize();

    // delete_tool should keep its value, not be overwritten by legacy delete
    assert_eq!(config.delete_tool, vec!["Y".to_string()]);
}

// ========================================================================
// New Actions Tests
// ========================================================================

#[test]
fn test_shortcut_new_actions_defaults() {
    let config = ShortcutsConfig::default();

    // Verify new actions have defaults
    assert_eq!(config.delete_tool, vec!["X".to_string()]);
    assert_eq!(config.toggle_station_labels, vec!["L".to_string()]);
    assert_eq!(config.toggle_shot_labels, vec!["Shift+L".to_string()]);
    assert_eq!(config.toggle_section_labels, vec!["Ctrl+L".to_string()]);
    assert_eq!(config.zoom_in, vec!["Equal".to_string(), "Plus".to_string()]);
    assert_eq!(config.zoom_out, vec!["Minus".to_string()]);
    assert_eq!(config.toggle_depth_gradient, vec!["Shift+D".to_string()]);
    assert_eq!(config.move_segment, vec!["V".to_string()]);
    assert_eq!(config.move_shot, vec!["G".to_string()]);
    assert_eq!(config.toggle_grid, vec!["Shift+G".to_string()]);
    assert_eq!(config.toggle_satellite, vec!["B".to_string()]);
    assert_eq!(config.fit_to_bounds, vec!["F".to_string()]);
    assert_eq!(config.toggle_sections_panel, vec!["Ctrl+1".to_string()]);
    assert_eq!(config.toggle_detail_panel, vec!["Ctrl+2".to_string()]);
    assert_eq!(config.toggle_data_table, vec!["Ctrl+3".to_string()]);
}

#[test]
fn test_shortcut_config_serialization_roundtrip() {
    let original = ShortcutsConfig::default();
    let serialized = toml::to_string_pretty(&original).expect("Should serialize");
    let deserialized: ShortcutsConfig = toml::from_str(&serialized).expect("Should deserialize");

    assert_eq!(deserialized.select, original.select);
    assert_eq!(deserialized.delete_tool, original.delete_tool);
    assert_eq!(deserialized.zoom_in, original.zoom_in);
    assert_eq!(deserialized.toggle_station_labels, original.toggle_station_labels);
}

// ========================================================================
// ShortcutFeedback Enum Tests
// ========================================================================

#[test]
fn test_shortcut_feedback_default() {
    // Default should be NonObvious
    let feedback = ShortcutFeedback::default();
    assert_eq!(feedback, ShortcutFeedback::NonObvious);
}

#[test]
fn test_shortcut_feedback_serialize_none() {
    // TOML requires key-value pairs, so use wrapper struct
    #[derive(Serialize)]
    struct Wrapper { value: ShortcutFeedback }
    let w = Wrapper { value: ShortcutFeedback::None };
    let serialized = toml::to_string(&w).expect("Should serialize");
    assert!(serialized.contains("value = \"none\""));
}

#[test]
fn test_shortcut_feedback_serialize_non_obvious() {
    #[derive(Serialize)]
    struct Wrapper { value: ShortcutFeedback }
    let w = Wrapper { value: ShortcutFeedback::NonObvious };
    let serialized = toml::to_string(&w).expect("Should serialize");
    assert!(serialized.contains("value = \"non_obvious\""));
}

#[test]
fn test_shortcut_feedback_serialize_all() {
    #[derive(Serialize)]
    struct Wrapper { value: ShortcutFeedback }
    let w = Wrapper { value: ShortcutFeedback::All };
    let serialized = toml::to_string(&w).expect("Should serialize");
    assert!(serialized.contains("value = \"all\""));
}

#[test]
fn test_shortcut_feedback_deserialize_none() {
    #[derive(Deserialize)]
    struct Wrapper { value: ShortcutFeedback }
    let w: Wrapper = toml::from_str("value = \"none\"").expect("Should deserialize");
    assert_eq!(w.value, ShortcutFeedback::None);
}

#[test]
fn test_shortcut_feedback_deserialize_non_obvious() {
    #[derive(Deserialize)]
    struct Wrapper { value: ShortcutFeedback }
    let w: Wrapper = toml::from_str("value = \"non_obvious\"").expect("Should deserialize");
    assert_eq!(w.value, ShortcutFeedback::NonObvious);
}

#[test]
fn test_shortcut_feedback_deserialize_all() {
    #[derive(Deserialize)]
    struct Wrapper { value: ShortcutFeedback }
    let w: Wrapper = toml::from_str("value = \"all\"").expect("Should deserialize");
    assert_eq!(w.value, ShortcutFeedback::All);
}

#[test]
fn test_general_config_shortcut_feedback_default() {
    // When shortcut_feedback is missing from TOML, should use default
    let toml_str = r#"
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20
"#;
    let config: GeneralConfig = toml::from_str(toml_str).expect("Should deserialize");
    assert_eq!(config.shortcut_feedback, ShortcutFeedback::NonObvious);
}

#[test]
fn test_general_config_shortcut_feedback_explicit() {
    let toml_str = r#"
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20
shortcut_feedback = "all"
"#;
    let config: GeneralConfig = toml::from_str(toml_str).expect("Should deserialize");
    assert_eq!(config.shortcut_feedback, ShortcutFeedback::All);
}

#[test]
fn test_general_config_shortcut_feedback_roundtrip() {
    let mut config = GeneralConfig::default();
    config.shortcut_feedback = ShortcutFeedback::None;

    let serialized = toml::to_string_pretty(&config).expect("Should serialize");
    let deserialized: GeneralConfig = toml::from_str(&serialized).expect("Should deserialize");

    assert_eq!(deserialized.shortcut_feedback, ShortcutFeedback::None);
}

// ========================================================================
// File I/O Tests
// ========================================================================

#[test]
fn test_load_from_path_missing_returns_default() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let path = dir.path().join("config.toml");
    let config = Config::load_from_path(&path).unwrap();
    assert_eq!(config.general.auto_save_interval_seconds, 30);
    assert_eq!(config.validation.warn_shot_length_max, 50.0);
}

#[test]
fn test_save_to_path_and_load_roundtrip() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let path = dir.path().join("config.toml");

    let mut config = Config::default();
    config.general.auto_save = false;
    config.general.undo_history_limit = 42;
    config.display.grid_spacing = 7.5;

    config.save_to_path(&path).unwrap();
    let loaded = Config::load_from_path(&path).unwrap();

    assert!(!loaded.general.auto_save);
    assert_eq!(loaded.general.undo_history_limit, 42);
    assert_eq!(loaded.display.grid_spacing, 7.5);
}

#[test]
fn test_load_from_path_invalid_toml_errors() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let path = dir.path().join("config.toml");
    std::fs::write(&path, "not = [valid").unwrap();
    assert!(Config::load_from_path(&path).is_err());
}

// ========================================================================
// Appearance Config Tests
// ========================================================================

#[test]
fn test_appearance_config_defaults() {
    let config = AppearanceConfig::default();
    assert_eq!(config.theme, ThemeMode::Dark);
}

#[test]
fn test_theme_mode_deserialize_valid_values() {
    #[derive(Deserialize)]
    struct Wrapper { theme: ThemeMode }
    let dark: Wrapper = toml::from_str("theme = \"dark\"").expect("dark should parse");
    assert_eq!(dark.theme, ThemeMode::Dark);
    let light: Wrapper = toml::from_str("theme = \"light\"").expect("light should parse");
    assert_eq!(light.theme, ThemeMode::Light);
    let auto: Wrapper = toml::from_str("theme = \"auto\"").expect("auto should parse");
    assert_eq!(auto.theme, ThemeMode::Auto);
}

#[test]
fn test_theme_mode_deserialize_unknown_value() {
    // Unknown theme values should deserialize as Unknown (not error)
    #[derive(Deserialize)]
    struct Wrapper { theme: ThemeMode }
    let unknown: Wrapper = toml::from_str("theme = \"neon\"").expect("unknown theme should parse via #[serde(other)]");
    assert_eq!(unknown.theme, ThemeMode::Unknown);
}

#[test]
fn test_appearance_normalize_unknown_to_dark() {
    let mut config = AppearanceConfig { theme: ThemeMode::Unknown };
    config.normalize();
    assert_eq!(config.theme, ThemeMode::Dark);
}

#[test]
fn test_appearance_normalize_valid_themes_unchanged() {
    let mut dark = AppearanceConfig { theme: ThemeMode::Dark };
    dark.normalize();
    assert_eq!(dark.theme, ThemeMode::Dark);

    let mut light = AppearanceConfig { theme: ThemeMode::Light };
    light.normalize();
    assert_eq!(light.theme, ThemeMode::Light);

    let mut auto = AppearanceConfig { theme: ThemeMode::Auto };
    auto.normalize();
    assert_eq!(auto.theme, ThemeMode::Auto);
}

#[test]
fn test_config_without_appearance_section_loads() {
    // Existing config without [appearance] should parse and default to dark
    let toml_str = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "esri"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"
"##;

    let config: Config = toml::from_str(toml_str).expect("Config without [appearance] should parse");
    assert_eq!(config.appearance.theme, ThemeMode::Dark);
}

#[test]
fn test_config_with_invalid_theme_normalizes() {
    let toml_str = r##"
[general]
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20

[units]
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 1

[display]
default_background = "#1a1a2e"
grid_color = "#333366"
font_size = 12
font_color = "#f5f5f5"

[display.depth_gradient]
enabled = false
shallow_color = "#00bfff"
deep_color = "#ff4444"
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
palette = ["#4ecdc4"]

[map]
satellite_provider = "esri"
satellite_enabled = false
zoom_default = 15
zoom_min = 0
zoom_max = 22

[map.controls]
pan_speed = 1.0
zoom_speed = 1.0
invert_scroll = false

[validation]
warn_shot_length_min = 0.1
warn_shot_length_max = 50.0
warn_depth_change_per_shot_max = 10.0
warn_azimuth_deviation_max = 30.0

[export]
default_image_format = "png"
default_dpi = 300
default_include_satellite = true
default_include_grid = false
default_include_labels = true

[logging]
level = "info"
max_directory_size_mb = 128

[shortcuts]
select = "S"
pan = "P"
zoom = "Z"
draw = "D"
delete = "X"
merge = "M"
measure = "R"
move_station = "T"
undo = "Ctrl+Z"
redo = "Ctrl+Y"
save = "Ctrl+S"

[appearance]
theme = "neon"
"##;

    let mut config: Config = toml::from_str(toml_str).expect("Config with invalid theme should still parse");
    assert_eq!(config.appearance.theme, ThemeMode::Unknown);
    config.normalize();
    assert_eq!(config.appearance.theme, ThemeMode::Dark);
}

// ========================================================================
// Satellite Provider Normalization Tests
// ========================================================================

#[test]
fn test_map_config_normalize_unknown_provider_to_esri() {
    let mut config = MapConfig {
        satellite_provider: "unknown_provider".to_string(),
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.satellite_provider, "esri");
}

#[test]
fn test_map_config_normalize_valid_provider_unchanged() {
    let mut config = MapConfig {
        satellite_provider: "esri".to_string(),
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.satellite_provider, "esri");
}

#[test]
fn test_map_config_normalize_empty_provider_to_esri() {
    let mut config = MapConfig {
        satellite_provider: "".to_string(),
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.satellite_provider, "esri");
}
