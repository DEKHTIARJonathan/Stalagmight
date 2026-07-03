use super::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    let mut config = StationConfig {
        radius: 1.0,
        hit_area: 1.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 1.0);
    assert_eq!(config.hit_area, 1.0);
}

#[test]
fn test_station_validation_accepts_mid_range() {
    let mut config = StationConfig {
        radius: 25.0,
        hit_area: 25.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 25.0);
    assert_eq!(config.hit_area, 25.0);
}

#[test]
fn test_station_validation_accepts_maximum_bound() {
    let mut config = StationConfig {
        radius: 50.0,
        hit_area: 50.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 50.0);
    assert_eq!(config.hit_area, 50.0);
}

#[test]
fn test_station_validation_rejects_zero() {
    let mut config = StationConfig {
        radius: 0.0,
        hit_area: 0.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 1.0); // clamped to min
    assert_eq!(config.hit_area, 1.0); // clamped to min
}

#[test]
fn test_gas_config_normalize_clamps_invalid_speeds_and_multipliers() {
    let mut config = GasConfig {
        swim_speed_m_per_min: 0.0,          // invalid -> default 10
        survey_speed_m_per_min: Some(-1.0), // invalid -> None (symmetric)
        survey_rmv_multiplier: f64::NAN,    // invalid -> default 1.0
        stressed_rmv_multiplier: 0.0,       // invalid -> default 1.5
        jump_rmv_multiplier: 0.5,           // below 1.0 (would cut gas) -> default 1.5
        dpv: Some(DpvProfile {
            speed_m_per_min: -5.0,
            burn_minutes: None,
            range_m: None,
        }),
        ..GasConfig::default()
    };
    config.normalize();
    assert_eq!(config.swim_speed_m_per_min, 10.0);
    assert_eq!(config.survey_speed_m_per_min, None);
    assert_eq!(config.survey_rmv_multiplier, 1.0);
    assert_eq!(config.stressed_rmv_multiplier, 1.5);
    assert_eq!(config.jump_rmv_multiplier, 1.5); // clamped up to the default: a jump is never less work
    assert_eq!(config.dpv, None); // bad DPV speed drops the profile
}

#[test]
fn test_gas_config_normalize_preserves_valid_values() {
    let mut config = GasConfig {
        swim_speed_m_per_min: 12.0,
        survey_speed_m_per_min: Some(4.0),
        survey_rmv_multiplier: 1.2,
        stressed_rmv_multiplier: 2.0,
        jump_rmv_multiplier: 2.0, // a valid non-default value: must be preserved, not reset
        ..GasConfig::default()
    };
    config.normalize();
    assert_eq!(config.swim_speed_m_per_min, 12.0);
    assert_eq!(config.survey_speed_m_per_min, Some(4.0));
    assert_eq!(config.survey_rmv_multiplier, 1.2);
    assert_eq!(config.stressed_rmv_multiplier, 2.0);
    assert_eq!(config.jump_rmv_multiplier, 2.0);
}

#[test]
fn test_gas_config_normalize_drops_backwards_survey_speed() {
    // Survey faster than swim is backwards → dropped to symmetric (None).
    let mut backwards = GasConfig {
        swim_speed_m_per_min: 10.0,
        survey_speed_m_per_min: Some(15.0),
        ..GasConfig::default()
    };
    backwards.normalize();
    assert_eq!(backwards.survey_speed_m_per_min, None);

    // Survey slower than (or equal to) swim is kept.
    let mut ok = GasConfig {
        swim_speed_m_per_min: 10.0,
        survey_speed_m_per_min: Some(4.0),
        ..GasConfig::default()
    };
    ok.normalize();
    assert_eq!(ok.survey_speed_m_per_min, Some(4.0));
}

#[test]
fn test_gas_config_normalize_clamps_reserve_profile() {
    // A NEGATIVE stage reserve is the unsafe direction (it drops the stage lower → more in-gas),
    // so it resets to the default; non-finite recalc holds reset too; valid values preserved.
    let mut config = GasConfig {
        reserve_profile: ReserveProfile {
            stage_reserve_bar: -5.0,
            all_thirds_safety_margin_bar: -3.0, // negative → adds gas (unsafe) → reset to 0
            recalc_hold_stage2_bar: f64::NAN,
            recalc_hold_stage1_bar: 80.0, // valid → kept
        },
        ..GasConfig::default()
    };
    config.normalize();
    assert_eq!(config.reserve_profile.stage_reserve_bar, 30.0);
    assert_eq!(config.reserve_profile.all_thirds_safety_margin_bar, 0.0);
    assert_eq!(config.reserve_profile.recalc_hold_stage2_bar, 100.0);
    assert_eq!(config.reserve_profile.recalc_hold_stage1_bar, 80.0);
}

#[test]
fn test_gas_config_caps_oversized_stage_reserve() {
    // A LARGE stage reserve only shrinks a stage's usable in-gas — the SAFE direction — so it is
    // merely capped at the max (resetting it to the smaller default would be *less* conservative),
    // unlike the negative case which resets. A plausible value is preserved.
    let mut config = GasConfig {
        reserve_profile: ReserveProfile {
            stage_reserve_bar: 9999.0,
            ..ReserveProfile::default()
        },
        ..GasConfig::default()
    };
    config.normalize();
    assert_eq!(config.reserve_profile.stage_reserve_bar, 100.0);

    let mut ok = GasConfig {
        reserve_profile: ReserveProfile {
            stage_reserve_bar: 40.0,
            ..ReserveProfile::default()
        },
        ..GasConfig::default()
    };
    ok.normalize();
    assert_eq!(ok.reserve_profile.stage_reserve_bar, 40.0);
}

#[test]
fn test_gas_config_deserializes_with_reserve_profile_missing() {
    // Migration tolerance: an old config whose [gas] block predates reserve_profile (or omits
    // some members) must still load, defaulting the missing pieces — not error.
    let missing: GasConfig =
        toml::from_str("units = \"metric\"\n").expect("gas config without reserve_profile loads");
    assert_eq!(missing.reserve_profile, ReserveProfile::default());

    // An old config carrying the RENAMED `turn_buffer_bar` key loads fine — the unknown key is
    // ignored and stage_reserve_bar defaults (30). The new key is honoured when present.
    let legacy: GasConfig =
        toml::from_str("units = \"metric\"\n[reserve_profile]\nturn_buffer_bar = 20.0\n")
            .expect("legacy reserve_profile with the old key loads");
    assert_eq!(legacy.reserve_profile.stage_reserve_bar, 30.0);

    let partial: GasConfig =
        toml::from_str("units = \"metric\"\n[reserve_profile]\nstage_reserve_bar = 40.0\n")
            .expect("partial reserve_profile loads");
    assert_eq!(partial.reserve_profile.stage_reserve_bar, 40.0);
    assert_eq!(partial.reserve_profile.recalc_hold_stage2_bar, 100.0); // missing member defaults
}

#[test]
fn test_station_validation_rejects_negative() {
    let mut config = StationConfig {
        radius: -1.0,
        hit_area: -1.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 1.0); // clamped to min
    assert_eq!(config.hit_area, 1.0); // clamped to min
}

#[test]
fn test_station_validation_rejects_above_max() {
    let mut config = StationConfig {
        radius: 51.0,
        hit_area: 51.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 50.0); // clamped to max
    assert_eq!(config.hit_area, 50.0); // clamped to max
}

#[test]
fn test_station_validation_rejects_large_values() {
    let mut config = StationConfig {
        radius: 100.0,
        hit_area: 100.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 50.0); // clamped to max
    assert_eq!(config.hit_area, 50.0); // clamped to max
}

#[test]
fn test_station_validation_handles_nan() {
    let mut config = StationConfig {
        radius: f64::NAN,
        hit_area: f64::NAN,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 4.0); // default
    assert_eq!(config.hit_area, 10.0); // default
}

#[test]
fn test_station_validation_handles_infinity() {
    let mut config = StationConfig {
        radius: f64::INFINITY,
        hit_area: f64::INFINITY,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 4.0); // default
    assert_eq!(config.hit_area, 10.0); // default
}

#[test]
fn test_station_validation_handles_neg_infinity() {
    let mut config = StationConfig {
        radius: f64::NEG_INFINITY,
        hit_area: f64::NEG_INFINITY,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 4.0); // default
    assert_eq!(config.hit_area, 10.0); // default
}

#[test]
fn test_station_hit_area_enforced_gte_radius() {
    let mut config = StationConfig {
        radius: 20.0,
        hit_area: 10.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.radius, 20.0);
    assert_eq!(config.hit_area, 20.0); // enforced >= radius
}

// ========================================================================
// Shot Config Validation Tests
// ========================================================================

#[test]
fn test_shot_validation_accepts_minimum_bound() {
    let mut config = ShotConfig {
        width: 0.5,
        hit_area: 0.5,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 0.5);
    assert_eq!(config.hit_area, 0.5);
}

#[test]
fn test_shot_validation_accepts_mid_range() {
    let mut config = ShotConfig {
        width: 10.0,
        hit_area: 10.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 10.0);
    assert_eq!(config.hit_area, 10.0);
}

#[test]
fn test_shot_validation_accepts_maximum_bound() {
    let mut config = ShotConfig {
        width: 20.0,
        hit_area: 20.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 20.0);
    assert_eq!(config.hit_area, 20.0);
}

#[test]
fn test_shot_validation_rejects_zero() {
    let mut config = ShotConfig {
        width: 0.0,
        hit_area: 0.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 0.5); // clamped to min
    assert_eq!(config.hit_area, 0.5); // clamped to min
}

#[test]
fn test_shot_validation_rejects_negative() {
    let mut config = ShotConfig {
        width: -1.0,
        hit_area: -1.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 0.5); // clamped to min
    assert_eq!(config.hit_area, 0.5); // clamped to min
}

#[test]
fn test_shot_validation_rejects_above_max() {
    let mut config = ShotConfig {
        width: 21.0,
        hit_area: 21.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 20.0); // clamped to max
    assert_eq!(config.hit_area, 20.0); // clamped to max
}

#[test]
fn test_shot_validation_rejects_large_values() {
    let mut config = ShotConfig {
        width: 100.0,
        hit_area: 100.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 20.0); // clamped to max
    assert_eq!(config.hit_area, 20.0); // clamped to max
}

#[test]
fn test_shot_validation_handles_nan() {
    let mut config = ShotConfig {
        width: f64::NAN,
        hit_area: f64::NAN,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 2.0); // default
    assert_eq!(config.hit_area, 8.0); // default
}

#[test]
fn test_shot_validation_handles_infinity() {
    let mut config = ShotConfig {
        width: f64::INFINITY,
        hit_area: f64::INFINITY,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 2.0); // default
    assert_eq!(config.hit_area, 8.0); // default
}

#[test]
fn test_shot_hit_area_enforced_gte_width() {
    let mut config = ShotConfig {
        width: 15.0,
        hit_area: 5.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.width, 15.0);
    assert_eq!(config.hit_area, 15.0); // enforced >= width
}

// ========================================================================
// Snap Config Validation Tests
// ========================================================================

#[test]
fn test_snap_validation_accepts_minimum_bound() {
    let mut config = MapSnapConfig {
        threshold: 1.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.threshold, 1.0);
}

#[test]
fn test_snap_validation_accepts_mid_range() {
    let mut config = MapSnapConfig {
        threshold: 25.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.threshold, 25.0);
}

#[test]
fn test_snap_validation_accepts_maximum_bound() {
    let mut config = MapSnapConfig {
        threshold: 50.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.threshold, 50.0);
}

#[test]
fn test_snap_validation_rejects_zero() {
    let mut config = MapSnapConfig {
        threshold: 0.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.threshold, 1.0); // clamped to min
}

#[test]
fn test_snap_validation_rejects_negative() {
    let mut config = MapSnapConfig {
        threshold: -1.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.threshold, 1.0); // clamped to min
}

#[test]
fn test_snap_validation_rejects_above_max() {
    let mut config = MapSnapConfig {
        threshold: 51.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.threshold, 50.0); // clamped to max
}

#[test]
fn test_snap_validation_handles_nan() {
    let mut config = MapSnapConfig {
        threshold: f64::NAN,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.threshold, 10.0); // default
}

#[test]
fn test_snap_validation_handles_infinity() {
    let mut config = MapSnapConfig {
        threshold: f64::INFINITY,
        ..Default::default()
    };
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

    let config: Config =
        toml::from_str(toml_str).expect("Config with partial station should parse");

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
    assert_eq!(
        deserialized.map.station.hit_area,
        original.map.station.hit_area
    );
    assert_eq!(deserialized.map.shot.width, original.map.shot.width);
    assert_eq!(deserialized.map.shot.hit_area, original.map.shot.hit_area);
    assert_eq!(deserialized.map.snap.threshold, original.map.snap.threshold);
    assert_eq!(
        deserialized.debug.map.show_hitboxes,
        original.debug.map.show_hitboxes
    );
}

#[test]
fn test_config_serialization_preserves_custom_values() {
    let mut config = Config::default();
    config.map.station.radius = 8.0;
    config.map.station.hit_area = 16.0;
    config.map.shot.width = 4.0;
    config.map.shot.hit_area = 12.0;
    config.map.snap.threshold = 20.0;
    config.debug.map.show_hitboxes = true;

    let serialized = toml::to_string_pretty(&config).expect("Config should serialize");
    let deserialized: Config = toml::from_str(&serialized).expect("Serialized config should parse");

    assert_eq!(deserialized.map.station.radius, 8.0);
    assert_eq!(deserialized.map.station.hit_area, 16.0);
    assert_eq!(deserialized.map.shot.width, 4.0);
    assert_eq!(deserialized.map.shot.hit_area, 12.0);
    assert_eq!(deserialized.map.snap.threshold, 20.0);
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

    let mut config: Config =
        toml::from_str(old_config_toml).expect("Config with legacy [snap] should parse");

    // Before migration, map.snap has defaults
    assert_eq!(config.map.snap.threshold, 10.0);
    assert!(config.map.snap.enabled_merge);
    assert!(config.map.snap.enabled_measure);

    // legacy_snap should have the old values
    assert!(config.legacy_snap.is_some());

    // Run migration (simulating what Config::load does)
    config.migrate_legacy();
    config.normalize();

    // After migration, map.snap should have the legacy values
    assert_eq!(config.map.snap.threshold, 25.0);
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

    let mut config: Config =
        toml::from_str(mixed_config_toml).expect("Config with both snap configs should parse");

    // map.snap has explicit values (not defaults)
    assert_eq!(config.map.snap.threshold, 30.0);
    assert!(!config.map.snap.enabled_merge);
    assert!(config.map.snap.enabled_measure);

    // Run migration
    config.migrate_legacy();
    config.normalize();

    // map.snap should NOT be overwritten by legacy values
    // (because map.snap was explicitly set, not defaults)
    assert_eq!(config.map.snap.threshold, 30.0);
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
    let mut config: ShortcutsConfig =
        toml::from_str(toml_str).expect("Partial config should parse");
    config.normalize();

    // Explicit value
    assert_eq!(config.select, vec!["S".to_string()]);
    // Missing fields should have defaults after normalize
    assert_eq!(config.pan, vec!["P".to_string()]);
    assert_eq!(config.undo, vec!["Ctrl+Z".to_string()]);
    assert_eq!(
        config.zoom_in,
        vec!["Equal".to_string(), "Plus".to_string()]
    );
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
    assert_eq!(
        normalize_shortcut("Ctrl+Digit1"),
        Some("Ctrl+1".to_string())
    );
    assert_eq!(
        normalize_shortcut("Ctrl+Numpad1"),
        Some("Ctrl+1".to_string())
    );
}

#[test]
fn test_normalize_shortcut_modifier_order() {
    // Modifiers should always be Ctrl+Alt+Shift+Key
    assert_eq!(
        normalize_shortcut("Shift+Ctrl+S"),
        Some("Ctrl+Shift+S".to_string())
    );
    assert_eq!(
        normalize_shortcut("Alt+Ctrl+S"),
        Some("Ctrl+Alt+S".to_string())
    );
    assert_eq!(
        normalize_shortcut("Shift+Alt+Ctrl+S"),
        Some("Ctrl+Alt+Shift+S".to_string())
    );
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
    assert_eq!(
        normalize_shortcut("ArrowDown"),
        Some("ArrowDown".to_string())
    );
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
    assert_eq!(
        normalize_shortcut("Shift++"),
        Some("Shift+Plus".to_string())
    );
    // Multiple modifiers with trailing +
    assert_eq!(
        normalize_shortcut("Ctrl+Shift+"),
        Some("Ctrl+Shift+Plus".to_string())
    );
    assert_eq!(
        normalize_shortcut("Ctrl+Shift++"),
        Some("Ctrl+Shift+Plus".to_string())
    );
}

#[test]
fn test_normalize_shortcut_remaining_special_keys() {
    // Arrow keys (all directions)
    assert_eq!(
        normalize_shortcut("ArrowLeft"),
        Some("ArrowLeft".to_string())
    );
    assert_eq!(
        normalize_shortcut("arrowleft"),
        Some("ArrowLeft".to_string())
    );
    assert_eq!(normalize_shortcut("Left"), Some("ArrowLeft".to_string()));
    assert_eq!(
        normalize_shortcut("ArrowRight"),
        Some("ArrowRight".to_string())
    );
    assert_eq!(
        normalize_shortcut("arrowright"),
        Some("ArrowRight".to_string())
    );
    assert_eq!(normalize_shortcut("Right"), Some("ArrowRight".to_string()));

    // Backspace
    assert_eq!(
        normalize_shortcut("Backspace"),
        Some("Backspace".to_string())
    );
    assert_eq!(
        normalize_shortcut("backspace"),
        Some("Backspace".to_string())
    );
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
    assert_eq!(
        normalize_shortcut("Ctrl+ArrowLeft"),
        Some("Ctrl+ArrowLeft".to_string())
    );
    assert_eq!(
        normalize_shortcut("Shift+Delete"),
        Some("Shift+Delete".to_string())
    );
    assert_eq!(
        normalize_shortcut("Ctrl+Backspace"),
        Some("Ctrl+Backspace".to_string())
    );
    assert_eq!(normalize_shortcut("Alt+Tab"), Some("Alt+Tab".to_string()));
    assert_eq!(
        normalize_shortcut("Ctrl+Home"),
        Some("Ctrl+Home".to_string())
    );
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
    config.select = vec![String::new(), "S".to_string(), "  ".to_string()];
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

// ========================================================================
// New Actions Tests
// ========================================================================

#[test]
fn test_shortcut_new_actions_defaults() {
    let config = ShortcutsConfig::default();

    // Verify new actions have defaults
    assert_eq!(config.toggle_station_labels, vec!["L".to_string()]);
    assert_eq!(config.toggle_shot_labels, vec!["Shift+L".to_string()]);
    assert_eq!(config.toggle_section_labels, vec!["Ctrl+L".to_string()]);
    assert_eq!(
        config.zoom_in,
        vec!["Equal".to_string(), "Plus".to_string()]
    );
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
    assert_eq!(deserialized.zoom_in, original.zoom_in);
    assert_eq!(
        deserialized.toggle_station_labels,
        original.toggle_station_labels
    );
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
    struct Wrapper {
        value: ShortcutFeedback,
    }
    let w = Wrapper {
        value: ShortcutFeedback::None,
    };
    let serialized = toml::to_string(&w).expect("Should serialize");
    assert!(serialized.contains("value = \"none\""));
}

#[test]
fn test_shortcut_feedback_serialize_non_obvious() {
    #[derive(Serialize)]
    struct Wrapper {
        value: ShortcutFeedback,
    }
    let w = Wrapper {
        value: ShortcutFeedback::NonObvious,
    };
    let serialized = toml::to_string(&w).expect("Should serialize");
    assert!(serialized.contains("value = \"non_obvious\""));
}

#[test]
fn test_shortcut_feedback_serialize_all() {
    #[derive(Serialize)]
    struct Wrapper {
        value: ShortcutFeedback,
    }
    let w = Wrapper {
        value: ShortcutFeedback::All,
    };
    let serialized = toml::to_string(&w).expect("Should serialize");
    assert!(serialized.contains("value = \"all\""));
}

#[test]
fn test_shortcut_feedback_deserialize_none() {
    #[derive(Deserialize)]
    struct Wrapper {
        value: ShortcutFeedback,
    }
    let w: Wrapper = toml::from_str("value = \"none\"").expect("Should deserialize");
    assert_eq!(w.value, ShortcutFeedback::None);
}

#[test]
fn test_shortcut_feedback_deserialize_non_obvious() {
    #[derive(Deserialize)]
    struct Wrapper {
        value: ShortcutFeedback,
    }
    let w: Wrapper = toml::from_str("value = \"non_obvious\"").expect("Should deserialize");
    assert_eq!(w.value, ShortcutFeedback::NonObvious);
}

#[test]
fn test_shortcut_feedback_deserialize_all() {
    #[derive(Deserialize)]
    struct Wrapper {
        value: ShortcutFeedback,
    }
    let w: Wrapper = toml::from_str("value = \"all\"").expect("Should deserialize");
    assert_eq!(w.value, ShortcutFeedback::All);
}

#[test]
fn test_general_config_shortcut_feedback_default() {
    // When shortcut_feedback is missing from TOML, should use default
    let toml_str = r"
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20
";
    let config: GeneralConfig = toml::from_str(toml_str).expect("Should deserialize");
    assert_eq!(config.shortcut_feedback, ShortcutFeedback::NonObvious);
    assert_eq!(config.locale, "system");
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
fn test_general_config_locale_explicit() {
    let toml_str = r#"
auto_save = true
auto_save_interval_seconds = 30
recent_projects_max = 20
locale = "en-US"
"#;
    let config: GeneralConfig = toml::from_str(toml_str).expect("Should deserialize");
    assert_eq!(config.locale, "en-US");
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
    assert_eq!(config.general.locale, "system");
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
    struct Wrapper {
        theme: ThemeMode,
    }
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
    struct Wrapper {
        theme: ThemeMode,
    }
    let unknown: Wrapper =
        toml::from_str("theme = \"neon\"").expect("unknown theme should parse via #[serde(other)]");
    assert_eq!(unknown.theme, ThemeMode::Unknown);
}

#[test]
fn test_appearance_normalize_unknown_to_dark() {
    let mut config = AppearanceConfig {
        theme: ThemeMode::Unknown,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.theme, ThemeMode::Dark);
}

#[test]
fn test_appearance_normalize_valid_themes_unchanged() {
    let mut dark = AppearanceConfig {
        theme: ThemeMode::Dark,
        ..Default::default()
    };
    dark.normalize();
    assert_eq!(dark.theme, ThemeMode::Dark);

    let mut light = AppearanceConfig {
        theme: ThemeMode::Light,
        ..Default::default()
    };
    light.normalize();
    assert_eq!(light.theme, ThemeMode::Light);

    let mut auto = AppearanceConfig {
        theme: ThemeMode::Auto,
        ..Default::default()
    };
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

    let config: Config =
        toml::from_str(toml_str).expect("Config without [appearance] should parse");
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

    let mut config: Config =
        toml::from_str(toml_str).expect("Config with invalid theme should still parse");
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
        satellite_provider: String::new(),
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.satellite_provider, "esri");
}

// ========================================================================
// DecimalPrecision Deserialization Tests (backward-compatibility)
// ========================================================================

#[test]
fn test_decimal_precision_deserialize_bare_u8() {
    // Old format: decimal_precision = 2  →  all fields set to 2
    let toml_str = r#"
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 2
"#;
    let config: UnitsConfig = toml::from_str(toml_str).expect("Bare u8 should parse");
    assert_eq!(config.decimal_precision.length, 2);
    assert_eq!(config.decimal_precision.coordinates, 2);
    assert_eq!(config.decimal_precision.depth, 2);
    assert_eq!(config.decimal_precision.azimuth, 2);
    assert_eq!(config.decimal_precision.inclination, 2);
    assert_eq!(config.decimal_precision.gps, 2);
}

#[test]
fn test_decimal_precision_deserialize_bare_u8_zero() {
    let toml_str = r#"
length = "meters"
depth = "meters"
angle = "degrees"
decimal_precision = 0
"#;
    let config: UnitsConfig = toml::from_str(toml_str).expect("Bare u8 zero should parse");
    assert_eq!(config.decimal_precision.length, 0);
    assert_eq!(config.decimal_precision.gps, 0);
}

#[test]
fn test_decimal_precision_deserialize_struct_format() {
    // New format: individual fields
    let toml_str = r#"
length = "meters"
depth = "meters"
angle = "degrees"

[decimal_precision]
length = 1
coordinates = 2
depth = 1
azimuth = 1
inclination = 1
gps = 6
"#;
    let config: UnitsConfig = toml::from_str(toml_str).expect("Struct format should parse");
    assert_eq!(config.decimal_precision.length, 1);
    assert_eq!(config.decimal_precision.coordinates, 2);
    assert_eq!(config.decimal_precision.depth, 1);
    assert_eq!(config.decimal_precision.gps, 6);
}

#[test]
fn test_decimal_precision_deserialize_struct_partial_uses_field_defaults() {
    // New struct format with only some fields → missing ones use serde defaults
    let toml_str = r#"
length = "meters"
depth = "meters"
angle = "degrees"

[decimal_precision]
length = 3
gps = 4
"#;
    let config: UnitsConfig = toml::from_str(toml_str).expect("Partial struct should parse");
    assert_eq!(config.decimal_precision.length, 3);
    assert_eq!(config.decimal_precision.coordinates, 2); // default
    assert_eq!(config.decimal_precision.depth, 1); // default
    assert_eq!(config.decimal_precision.azimuth, 1); // default
    assert_eq!(config.decimal_precision.inclination, 1); // default
    assert_eq!(config.decimal_precision.gps, 4);
}

#[test]
fn test_decimal_precision_roundtrip_struct_format() {
    let original = UnitsConfig {
        length: LengthUnit::Meters,
        depth: LengthUnit::Meters,
        angle: AngleUnit::Degrees,
        decimal_precision: DecimalPrecision {
            length: 3,
            coordinates: 4,
            depth: 2,
            azimuth: 1,
            inclination: 0,
            gps: 5,
        },
    };
    let serialized = toml::to_string_pretty(&original).expect("Should serialize");
    let deserialized: UnitsConfig = toml::from_str(&serialized).expect("Should deserialize");
    assert_eq!(deserialized.decimal_precision.length, 3);
    assert_eq!(deserialized.decimal_precision.coordinates, 4);
    assert_eq!(deserialized.decimal_precision.depth, 2);
    assert_eq!(deserialized.decimal_precision.azimuth, 1);
    assert_eq!(deserialized.decimal_precision.inclination, 0);
    assert_eq!(deserialized.decimal_precision.gps, 5);
}

// ========================================================================
// DecimalPrecision Normalize Tests
// ========================================================================

#[test]
fn test_decimal_precision_normalize_clamps_to_six() {
    let mut dp = DecimalPrecision {
        length: 10,
        coordinates: 7,
        depth: 255,
        azimuth: 8,
        inclination: 100,
        gps: 6,
    };
    dp.normalize();
    assert_eq!(dp.length, 6);
    assert_eq!(dp.coordinates, 6);
    assert_eq!(dp.depth, 6);
    assert_eq!(dp.azimuth, 6);
    assert_eq!(dp.inclination, 6);
    assert_eq!(dp.gps, 6); // already at max, unchanged
}

#[test]
fn test_decimal_precision_normalize_preserves_valid_values() {
    let mut dp = DecimalPrecision {
        length: 0,
        coordinates: 3,
        depth: 6,
        azimuth: 1,
        inclination: 2,
        gps: 5,
    };
    dp.normalize();
    assert_eq!(dp.length, 0);
    assert_eq!(dp.coordinates, 3);
    assert_eq!(dp.depth, 6);
    assert_eq!(dp.azimuth, 1);
    assert_eq!(dp.inclination, 2);
    assert_eq!(dp.gps, 5);
}

#[test]
fn test_decimal_precision_normalize_is_idempotent() {
    let mut dp = DecimalPrecision {
        length: 10,
        coordinates: 3,
        depth: 0,
        azimuth: 6,
        inclination: 255,
        gps: 4,
    };
    dp.normalize();
    let first = dp.clone();
    dp.normalize();
    assert_eq!(dp.length, first.length);
    assert_eq!(dp.coordinates, first.coordinates);
    assert_eq!(dp.depth, first.depth);
    assert_eq!(dp.azimuth, first.azimuth);
    assert_eq!(dp.inclination, first.inclination);
    assert_eq!(dp.gps, first.gps);
}

// ========================================================================
// GlobalViewConfig Normalize Tests
// ========================================================================

#[test]
fn test_global_view_normalize_nan_tolerance_resets_to_default() {
    let mut config = GlobalViewConfig {
        tolerance: f64::NAN,
        throttle_tolerance: f64::NAN,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.tolerance, 0.5); // default
    assert_eq!(config.throttle_tolerance, 1.0); // default
}

#[test]
fn test_global_view_normalize_infinity_resets_to_default() {
    let mut config = GlobalViewConfig {
        tolerance: f64::INFINITY,
        throttle_tolerance: f64::NEG_INFINITY,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.tolerance, 0.5);
    assert_eq!(config.throttle_tolerance, 1.0);
}

#[test]
fn test_global_view_normalize_negative_clamped_to_zero() {
    let mut config = GlobalViewConfig {
        tolerance: -1.0,
        throttle_tolerance: -5.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.tolerance, 0.0);
    assert_eq!(config.throttle_tolerance, 0.0);
}

#[test]
fn test_global_view_normalize_throttle_bumped_to_tolerance() {
    let mut config = GlobalViewConfig {
        tolerance: 2.0,
        throttle_tolerance: 0.5,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.tolerance, 2.0);
    assert_eq!(config.throttle_tolerance, 2.0); // bumped to match tolerance
}

#[test]
fn test_global_view_normalize_valid_values_unchanged() {
    let mut config = GlobalViewConfig {
        fps_threshold: 60,
        tolerance: 0.3,
        throttle_tolerance: 0.8,
    };
    config.normalize();
    assert_eq!(config.tolerance, 0.3);
    assert_eq!(config.throttle_tolerance, 0.8);
}

#[test]
fn test_global_view_normalize_throttle_larger_ok() {
    let mut config = GlobalViewConfig {
        tolerance: 1.0,
        throttle_tolerance: 5.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.tolerance, 1.0);
    assert_eq!(config.throttle_tolerance, 5.0); // larger is fine
}

// ========================================================================
// ClosureAdjustmentConfig Normalize Tests
// ========================================================================

#[test]
fn test_closure_adjustment_normalize_nan_resets_to_default() {
    let mut config = ClosureAdjustmentConfig {
        base_sigma_length_m: f64::NAN,
        base_sigma_azimuth_deg: f64::NAN,
        base_sigma_depth_m: f64::NAN,
    };
    config.normalize();
    assert_eq!(config.base_sigma_length_m, 0.05);
    assert_eq!(config.base_sigma_azimuth_deg, 1.0);
    assert_eq!(config.base_sigma_depth_m, 0.05);
}

#[test]
fn test_closure_adjustment_normalize_infinity_resets_to_default() {
    let mut config = ClosureAdjustmentConfig {
        base_sigma_length_m: f64::INFINITY,
        base_sigma_azimuth_deg: f64::NEG_INFINITY,
        base_sigma_depth_m: f64::INFINITY,
    };
    config.normalize();
    assert_eq!(config.base_sigma_length_m, 0.05);
    assert_eq!(config.base_sigma_azimuth_deg, 1.0);
    assert_eq!(config.base_sigma_depth_m, 0.05);
}

#[test]
fn test_closure_adjustment_normalize_zero_resets_to_default() {
    let mut config = ClosureAdjustmentConfig {
        base_sigma_length_m: 0.0,
        base_sigma_azimuth_deg: 0.0,
        base_sigma_depth_m: 0.0,
    };
    config.normalize();
    assert_eq!(config.base_sigma_length_m, 0.05);
    assert_eq!(config.base_sigma_azimuth_deg, 1.0);
    assert_eq!(config.base_sigma_depth_m, 0.05);
}

#[test]
fn test_closure_adjustment_normalize_negative_resets_to_default() {
    let mut config = ClosureAdjustmentConfig {
        base_sigma_length_m: -0.1,
        base_sigma_azimuth_deg: -5.0,
        base_sigma_depth_m: -1.0,
    };
    config.normalize();
    assert_eq!(config.base_sigma_length_m, 0.05);
    assert_eq!(config.base_sigma_azimuth_deg, 1.0);
    assert_eq!(config.base_sigma_depth_m, 0.05);
}

#[test]
fn test_closure_adjustment_normalize_valid_values_unchanged() {
    let mut config = ClosureAdjustmentConfig {
        base_sigma_length_m: 0.1,
        base_sigma_azimuth_deg: 2.5,
        base_sigma_depth_m: 0.01,
    };
    config.normalize();
    assert_eq!(config.base_sigma_length_m, 0.1);
    assert_eq!(config.base_sigma_azimuth_deg, 2.5);
    assert_eq!(config.base_sigma_depth_m, 0.01);
}

#[test]
fn test_closure_adjustment_normalize_very_small_positive_accepted() {
    let mut config = ClosureAdjustmentConfig {
        base_sigma_length_m: 0.00001,
        base_sigma_azimuth_deg: 0.001,
        base_sigma_depth_m: 0.00001,
    };
    config.normalize();
    assert_eq!(config.base_sigma_length_m, 0.00001);
    assert_eq!(config.base_sigma_azimuth_deg, 0.001);
    assert_eq!(config.base_sigma_depth_m, 0.00001);
}

// ========================================================================
// MapConfig Normalize Tests (zoom_step edge cases)
// ========================================================================

#[test]
fn test_map_config_normalize_zoom_step_nan_resets_to_default() {
    let mut config = MapConfig {
        zoom_step: f64::NAN,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.zoom_step, 1.0);
}

#[test]
fn test_map_config_normalize_zoom_step_infinity_resets_to_default() {
    let mut config = MapConfig {
        zoom_step: f64::INFINITY,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.zoom_step, 1.0);
}

#[test]
fn test_map_config_normalize_zoom_step_below_min_clamped() {
    let mut config = MapConfig {
        zoom_step: 0.05,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.zoom_step, 0.1);
}

#[test]
fn test_map_config_normalize_zoom_step_above_max_clamped() {
    let mut config = MapConfig {
        zoom_step: 6.0,
        ..Default::default()
    };
    config.normalize();
    assert_eq!(config.zoom_step, 5.0);
}

#[test]
fn test_map_config_normalize_zoom_step_at_bounds_unchanged() {
    let mut min_config = MapConfig {
        zoom_step: 0.1,
        ..Default::default()
    };
    min_config.normalize();
    assert_eq!(min_config.zoom_step, 0.1);

    let mut max_config = MapConfig {
        zoom_step: 5.0,
        ..Default::default()
    };
    max_config.normalize();
    assert_eq!(max_config.zoom_step, 5.0);
}

// ========================================================================
// Config.next_section_color Tests
// ========================================================================

#[test]
fn test_next_section_color_returns_first_unused() {
    let mut config = Config::default();
    config.section_colors.palette = vec![
        "#ff0000".to_string(),
        "#00ff00".to_string(),
        "#0000ff".to_string(),
    ];
    let used = vec!["#ff0000".to_string()];
    assert_eq!(config.next_section_color(&used), "#00ff00");
}

#[test]
fn test_next_section_color_skips_multiple_used() {
    let mut config = Config::default();
    config.section_colors.palette = vec![
        "#ff0000".to_string(),
        "#00ff00".to_string(),
        "#0000ff".to_string(),
    ];
    let used = vec!["#ff0000".to_string(), "#00ff00".to_string()];
    assert_eq!(config.next_section_color(&used), "#0000ff");
}

#[test]
fn test_next_section_color_all_used_wraps_to_first() {
    let mut config = Config::default();
    config.section_colors.palette = vec!["#ff0000".to_string(), "#00ff00".to_string()];
    let used = vec!["#ff0000".to_string(), "#00ff00".to_string()];
    // All used → returns first color
    assert_eq!(config.next_section_color(&used), "#ff0000");
}

#[test]
fn test_next_section_color_empty_palette_returns_hardcoded() {
    let mut config = Config::default();
    config.section_colors.palette = vec![];
    assert_eq!(config.next_section_color(&[]), "#4ecdc4");
}

#[test]
fn test_next_section_color_no_used_returns_first() {
    let mut config = Config::default();
    config.section_colors.palette = vec!["#aabbcc".to_string(), "#ddeeff".to_string()];
    assert_eq!(config.next_section_color(&[]), "#aabbcc");
}

#[test]
fn test_next_section_color_used_colors_not_in_palette_ignored() {
    let mut config = Config::default();
    config.section_colors.palette = vec!["#ff0000".to_string(), "#00ff00".to_string()];
    let used = vec!["#999999".to_string()]; // not in palette
    assert_eq!(config.next_section_color(&used), "#ff0000");
}

// ========================================================================
// Syntactic Highlighting Tests
// ========================================================================

#[test]
fn test_syntactic_highlighting_defaults_to_full() {
    let config = SyntacticHighlightingConfig::default();
    assert_eq!(config.level, SyntacticHighlightLevel::Full);
    assert_eq!(config.preset, SyntacticHighlightPreset::Default);
    assert!(config.overrides.is_empty());
    // And the default top-level config exposes the same.
    assert_eq!(
        Config::default().syntactic_highlighting.level,
        SyntacticHighlightLevel::Full
    );
}

#[test]
fn test_syntactic_highlighting_missing_section_loads_as_full() {
    // A config written before this feature existed has no
    // [syntactic_highlighting] section; it must load with the opt-out default.
    // Simulate by serializing a default config and stripping the section.
    let mut value = toml::Value::try_from(Config::default()).expect("config to toml value");
    value
        .as_table_mut()
        .expect("config is a table")
        .remove("syntactic_highlighting");
    let without_section = toml::to_string(&value).expect("re-serialize");
    assert!(!without_section.contains("syntactic_highlighting"));

    let config: Config = toml::from_str(&without_section).expect("legacy config should parse");
    assert_eq!(
        config.syntactic_highlighting.level,
        SyntacticHighlightLevel::Full
    );
    assert_eq!(
        config.syntactic_highlighting.preset,
        SyntacticHighlightPreset::Default
    );
}

#[test]
fn test_syntactic_highlighting_serde_round_trip() {
    let mut config = SyntacticHighlightingConfig::default();
    config.level = SyntacticHighlightLevel::ToolbarOnly;
    config.preset = SyntacticHighlightPreset::Deuteranopia;
    let mut roles = HashMap::new();
    roles.insert("station".to_string(), "#36b96a".to_string());
    config.overrides.insert("deuteranopia".to_string(), roles);

    let serialized = toml::to_string(&config).expect("serialize");
    let deserialized: SyntacticHighlightingConfig =
        toml::from_str(&serialized).expect("deserialize");
    assert_eq!(deserialized.level, SyntacticHighlightLevel::ToolbarOnly);
    assert_eq!(deserialized.preset, SyntacticHighlightPreset::Deuteranopia);
    assert_eq!(deserialized.overrides["deuteranopia"]["station"], "#36b96a");
}

#[test]
fn test_syntactic_highlighting_unknown_enums_normalize() {
    let toml = r#"
level = "made_up"
preset = "also_made_up"
"#;
    let mut config: SyntacticHighlightingConfig = toml::from_str(toml).expect("parse");
    config.normalize();
    assert_eq!(config.level, SyntacticHighlightLevel::Full);
    assert_eq!(config.preset, SyntacticHighlightPreset::Default);
}

#[test]
fn test_syntactic_highlighting_normalize_drops_bad_hex() {
    let mut config = SyntacticHighlightingConfig::default();
    let mut roles = HashMap::new();
    roles.insert("station".to_string(), "#36b96a".to_string()); // valid
    roles.insert("shot".to_string(), "0070dd".to_string()); // missing '#'
    roles.insert("segment".to_string(), "#xyz123".to_string()); // non-hex
    roles.insert("section".to_string(), "#A335EE".to_string()); // valid uppercase
    config.overrides.insert("default".to_string(), roles);

    config.normalize();

    let default_roles = &config.overrides["default"];
    assert!(default_roles.contains_key("station"));
    assert!(default_roles.contains_key("section"));
    assert!(!default_roles.contains_key("shot"));
    assert!(!default_roles.contains_key("segment"));
}

#[test]
fn test_syntactic_highlighting_normalize_removes_empty_preset_maps() {
    let mut config = SyntacticHighlightingConfig::default();
    let mut roles = HashMap::new();
    roles.insert("station".to_string(), "notacolor".to_string()); // dropped
    config.overrides.insert("default".to_string(), roles);
    config.normalize();
    // The preset entry becomes empty after dropping the bad color, so it is removed.
    assert!(config.overrides.is_empty());
}

#[test]
fn test_panels_config_normalize_clamps_sizes() {
    // Out-of-range sizes (e.g. hand-edited or written by an older build) must be
    // clamped to the same bounds the UI enforces while dragging — a degenerate 0
    // would otherwise reload the panel collapsed/invisible.
    let mut p = PanelsConfig {
        sections_panel_width: 0,
        detail_panel_width: 99999,
        data_table_height: 1,
        ..PanelsConfig::default()
    };
    p.normalize();
    assert_eq!(p.sections_panel_width, 150); // clamped up to min
    assert_eq!(p.detail_panel_width, 500); // clamped down to max
    assert_eq!(p.data_table_height, 100); // clamped up to min
}

#[test]
fn test_panels_config_normalize_repairs_invalid_mode() {
    let mut p = PanelsConfig {
        sections_panel_mode: "Hover".to_string(), // wrong case
        detail_panel_mode: "nonsense".to_string(),
        data_table_mode: "hover".to_string(), // valid, preserved
        ..PanelsConfig::default()
    };
    p.normalize();
    assert_eq!(p.sections_panel_mode, "pin");
    assert_eq!(p.detail_panel_mode, "pin");
    assert_eq!(p.data_table_mode, "hover");
}

#[test]
fn test_panels_config_normalize_preserves_in_range_values() {
    let mut p = PanelsConfig {
        sections_panel_width: 300,
        detail_panel_width: 250,
        data_table_height: 400,
        sections_panel_mode: "hover".to_string(),
        detail_panel_mode: "pin".to_string(),
        data_table_mode: "hover".to_string(),
        ..PanelsConfig::default()
    };
    p.normalize();
    assert_eq!(p.sections_panel_width, 300);
    assert_eq!(p.detail_panel_width, 250);
    assert_eq!(p.data_table_height, 400);
    assert_eq!(p.sections_panel_mode, "hover");
    assert_eq!(p.detail_panel_mode, "pin");
    assert_eq!(p.data_table_mode, "hover");
}

#[test]
fn test_panels_config_deserializes_legacy_table_without_reveal_fields() {
    // An older [panels] table that predates the *_open/*_mode fields must still
    // deserialize, filling the new fields from their serde defaults.
    let toml = r"
        sections_panel_width = 250
        detail_panel_width = 300
        data_table_height = 200
    ";
    let p: PanelsConfig = toml::from_str(toml).expect("legacy panels table should deserialize");
    assert!(p.sections_panel_open);
    assert!(p.detail_panel_open);
    assert!(!p.data_table_open);
    assert_eq!(p.sections_panel_mode, "pin");
    assert_eq!(p.detail_panel_mode, "pin");
    assert_eq!(p.data_table_mode, "pin");
}

// ========================================================================
// [Track C] (#188) SpeleoDbConfig: token_fallback + insecure_http
// ========================================================================

#[test]
fn token_fallback_unknown_normalizes_to_session_only() {
    // An unrecognized TOML value parses to the #[serde(other)] sentinel, then
    // normalize() coerces it back to the safe default (mirrors ThemeMode).
    let sdb: SpeleoDbConfig = toml::from_str("token_fallback = \"definitely_not_a_real_value\"")
        .expect("unknown value must not block loading");
    assert_eq!(sdb.token_fallback, TokenFallback::Unknown);

    // The coercion is reachable through the top-level Config::normalize too.
    let mut config = Config::default();
    config.speleodb.token_fallback = TokenFallback::Unknown;
    config.normalize();
    assert_eq!(config.speleodb.token_fallback, TokenFallback::SessionOnly);
}

#[test]
fn speleodb_config_defaults_are_safe() {
    // Defaults: session-only fallback and the insecure-http override OFF.
    let config = SpeleoDbConfig::default();
    assert_eq!(config.token_fallback, TokenFallback::SessionOnly);
    assert!(!config.insecure_http);
    // An empty [speleodb] table (no fields) loads the same safe defaults, since
    // both new fields are #[serde(default)] — existing configs load unchanged.
    let sdb: SpeleoDbConfig = toml::from_str("").expect("empty table loads");
    assert_eq!(sdb.token_fallback, TokenFallback::SessionOnly);
    assert!(!sdb.insecure_http);
    // Only the legacy endpoint/email present (pre-Track-C config) still defaults
    // the new fields safely.
    let sdb: SpeleoDbConfig =
        toml::from_str("endpoint = \"https://x\"\nemail = \"u@x\"").expect("legacy table loads");
    assert_eq!(sdb.token_fallback, TokenFallback::SessionOnly);
    assert!(!sdb.insecure_http);
}

#[test]
fn speleodb_config_round_trips_new_fields() {
    let mut config = Config::default();
    config.speleodb.token_fallback = TokenFallback::Plaintext;
    config.speleodb.insecure_http = true;
    config.speleodb.endpoint = Some("http://10.10.0.220:8000".to_string());
    config.speleodb.email = Some("u@x".to_string());

    let serialized = toml::to_string_pretty(&config).expect("Config should serialize");
    let deserialized: Config = toml::from_str(&serialized).expect("round-trip parse");
    assert_eq!(
        deserialized.speleodb.token_fallback,
        TokenFallback::Plaintext
    );
    assert!(deserialized.speleodb.insecure_http);
    assert_eq!(
        deserialized.speleodb.endpoint.as_deref(),
        Some("http://10.10.0.220:8000")
    );
    assert_eq!(deserialized.speleodb.email.as_deref(), Some("u@x"));

    // Snake-case wire form: token_fallback serializes as "plaintext".
    assert!(
        serialized.contains("token_fallback = \"plaintext\""),
        "expected snake_case token_fallback in:\n{serialized}"
    );
}

#[test]
fn speleodb_poll_interval_defaults_to_60_and_clamps_up_to_floor() {
    // Default is 60 (not the u32 zero the old derived Default would have given).
    assert_eq!(SpeleoDbConfig::default().poll_interval_seconds, 60);

    // A hand-edited sub-floor value is corrected up on normalize (anti-spam).
    let mut cfg = SpeleoDbConfig {
        poll_interval_seconds: 5,
        ..SpeleoDbConfig::default()
    };
    cfg.normalize();
    assert_eq!(cfg.poll_interval_seconds, MIN_POLL_INTERVAL_SECONDS);

    // A value at/above the floor is preserved.
    let mut ok = SpeleoDbConfig {
        poll_interval_seconds: 120,
        ..SpeleoDbConfig::default()
    };
    ok.normalize();
    assert_eq!(ok.poll_interval_seconds, 120);

    // A config file that omits the field parses to the default (60).
    let deserialized: SpeleoDbConfig = toml::from_str("").expect("empty speleodb parses");
    assert_eq!(deserialized.poll_interval_seconds, 60);
}
