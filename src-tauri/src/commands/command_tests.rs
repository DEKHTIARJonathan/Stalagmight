//! Command wrapper tests focused on critical/edge behaviors.

use super::{cache, config, export, history, import, project, raw_data, section, shot, station, validation};
use crate::core::{AppState, CommandResult};
use crate::models::{
    ClosureStrategy, Coordinates, GpsCoordinates, Project, SectionData, SectionUpdates, ShotData,
    ShotUpdates, StationRef, SurveyDirection,
};
use crate::persistence::Database;
use crate::test_helpers::TestDb;
use chrono::NaiveDate;
use std::path::PathBuf;
use std::{env, fs};
use tauri::test::{mock_app, MockRuntime};
use tauri::{Manager, State};
use tempfile::{NamedTempFile, TempDir};

fn app_with_state() -> tauri::App<MockRuntime> {
    let app = mock_app();
    app.manage(AppState::new().expect("app state"));
    app
}

fn app_with_custom_state(state: AppState) -> tauri::App<MockRuntime> {
    let app = mock_app();
    app.manage(state);
    app
}

fn state(app: &tauri::App<MockRuntime>) -> State<'_, AppState> {
    app.state::<AppState>()
}

fn with_config_lock<T>(f: impl FnOnce() -> T) -> T {
    // Serialize config-touching tests AND redirect the config path to a fresh
    // temp dir, so they neither race each other nor read/pollute the real
    // ~/.config/stalagmight/config.toml. (Shared with test_get_config and any
    // other config-touching test via the same process-global lock.)
    crate::test_helpers::with_isolated_config(f)
}

fn with_restored_config<T>(app: &tauri::App<MockRuntime>, f: impl FnOnce() -> T) -> T {
    let original = config::get_config(state(app));
    let result = f();
    config::update_config(state(app), original).expect("restore config");
    result
}

struct EnvVarGuard {
    key: String,
    original: Option<String>,
}

impl EnvVarGuard {
    fn set(key: &str, value: &str) -> Self {
        let original = env::var(key).ok();
        env::set_var(key, value);
        Self {
            key: key.to_string(),
            original,
        }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.original {
            env::set_var(&self.key, value);
        } else {
            env::remove_var(&self.key);
        }
    }
}

fn assert_success(result: &CommandResult) {
    assert!(result.success, "expected success, got error: {:?}", result.error);
    assert!(result.error.is_none());
}

fn assert_failure_contains(result: &CommandResult, needle: &str) {
    assert!(!result.success, "expected failure");
    let err = result.error.as_deref().unwrap_or("<none>");
    assert!(
        err.contains(needle),
        "expected error containing '{needle}', got '{err}'"
    );
}

fn shot_data(length: f64) -> ShotData {
    ShotData {
        azimuth_in: 0.0,
        azimuth_out: 5.0,
        length,
        depth_in: 0.0,
        depth_out: 0.0,
        ..Default::default()
    }
}

fn shot_data_with_depth(length: f64, depth_in: f64, depth_out: f64) -> ShotData {
    ShotData {
        azimuth_in: 10.0,
        azimuth_out: 15.0,
        length,
        depth_in,
        depth_out,
        ..Default::default()
    }
}

fn create_project(app: &tauri::App<MockRuntime>) {
    let result = project::create_project(
        state(app),
        "Test Cave".to_string(),
        Some("Test Location".to_string()),
    );
    assert_success(&result);
}

fn set_project_for_tests(app: &tauri::App<MockRuntime>, project: Project) {
    state(app).inner().set_project_for_tests(project);
}

fn create_section_with_shots(app: &tauri::App<MockRuntime>, shots: Vec<ShotData>) -> u32 {
    let result = section::create_section(
        state(app),
        Some("Section A".to_string()),
        Some("Surveyor".to_string()),
        None,
        "#4ecdc4".to_string(),
        Some(SurveyDirection::In),
        shots,
    );
    assert_success(&result);
    result.section_id.expect("section id")
}

fn project_with_section(shots: Vec<ShotData>) -> Project {
    let mut project = Project::new("Test Cave".to_string(), None);
    project.add_section(SectionData {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        quality: 1.0,
        shots,
    });
    project
}

fn save_project_to_temp(app: &tauri::App<MockRuntime>, dir: &TempDir) -> PathBuf {
    let path = dir.path().join("project");
    let result = project::save_project(state(app), Some(path.clone()), None);
    assert_success(&result);
    path.with_extension("stalx")
}

// === Config commands ===

#[test]
fn test_get_config_defaults_general_auto_save() {
    // Isolate from the real config file: this asserts DEFAULTS, which only
    // holds when no user config (e.g. auto_save = false) is readable.
    with_config_lock(|| {
        let app = app_with_state();
        let cfg = config::get_config(state(&app));
        assert!(cfg.general.auto_save);
        assert_eq!(cfg.general.auto_save_interval_seconds, 30);
    });
}

#[test]
fn test_get_config_defaults_panels() {
    // Test the actual defaults, not user config which may differ
    let cfg = crate::config::Config::default();
    assert_eq!(cfg.panels.sections_panel_width, 250);
    assert_eq!(cfg.panels.detail_panel_width, 300);
    assert_eq!(cfg.panels.data_table_height, 200);
    assert!(cfg.panels.data_table_station_column_order.is_empty());
    assert_eq!(
        cfg.panels.data_table_station_hidden_columns,
        vec!["_x", "_y", "_lat", "_long"]
    );
}

#[test]
fn test_update_data_table_view_roundtrip() {
    with_config_lock(|| {
        let app = app_with_state();
        config::update_data_table_view_impl(
            state(&app).inner(),
            Some(vec!["length".to_string(), "_azimuth_avg".to_string()]),
            Some(vec!["left".to_string(), "right".to_string(), "up".to_string(), "down".to_string()]),
            Some("inout".to_string()),
            None,
            Some(vec!["_zeroDatum".to_string(), "_x".to_string()]),
            Some(vec!["_connections".to_string()]),
        )
        .expect("update data-table view");
        let cfg = config::get_config(state(&app));
        assert_eq!(cfg.panels.data_table_shot_column_order, vec!["length", "_azimuth_avg"]);
        assert_eq!(cfg.panels.data_table_shot_hidden_columns, vec!["left", "right", "up", "down"]);
        assert_eq!(cfg.panels.data_table_azimuth_mode, "inout");
        // untouched field keeps its default
        assert_eq!(cfg.panels.data_table_inclination_mode, "off");
        assert_eq!(cfg.panels.data_table_station_column_order, vec!["_zeroDatum", "_x"]);
        assert_eq!(cfg.panels.data_table_station_hidden_columns, vec!["_connections"]);
        // invalid mode is rejected, config untouched
        let err = config::update_data_table_view_impl(
            state(&app).inner(),
            None,
            None,
            Some("sideways".to_string()),
            None,
            None,
            None,
        );
        assert!(err.is_err());
        assert_eq!(config::get_config(state(&app)).panels.data_table_azimuth_mode, "inout");
    });
}

#[test]
fn test_get_config_defaults_validation() {
    // Same isolation as above: defaults must not depend on the real config.
    with_config_lock(|| {
        let app = app_with_state();
        let cfg = config::get_config(state(&app));
        assert_eq!(cfg.validation.warn_shot_length_min, 0.4);
        assert_eq!(cfg.validation.warn_shot_length_max, 50.0);
    });
}

#[test]
fn test_update_config_roundtrip_auto_save() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let mut cfg = config::get_config(state(&app));
            cfg.general.auto_save = false;
            config::update_config(state(&app), cfg).expect("update config");
            let updated = config::get_config(state(&app));
            assert!(!updated.general.auto_save);
        });
    });
}

#[test]
fn test_update_config_roundtrip_recent_projects() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let mut cfg = config::get_config(state(&app));
            cfg.general.recent_projects = vec![PathBuf::from("/tmp/example.stalx")];
            config::update_config(state(&app), cfg).expect("update config");
            let updated = config::get_config(state(&app));
            assert_eq!(updated.general.recent_projects.len(), 1);
            assert!(updated
                .general
                .recent_projects
                .first()
                .unwrap()
                .to_string_lossy()
                .contains("example.stalx"));
        });
    });
}

#[test]
fn test_update_panel_sizes_sections_only() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let before = config::get_config(state(&app));
            config::update_panel_sizes(state(&app), Some(333), None, None).unwrap();
            let after = config::get_config(state(&app));
            assert_eq!(after.panels.sections_panel_width, 333);
            assert_eq!(after.panels.detail_panel_width, before.panels.detail_panel_width);
            assert_eq!(after.panels.data_table_height, before.panels.data_table_height);
        });
    });
}

#[test]
fn test_update_panel_sizes_detail_only() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let before = config::get_config(state(&app));
            config::update_panel_sizes(state(&app), None, Some(444), None).unwrap();
            let after = config::get_config(state(&app));
            assert_eq!(after.panels.detail_panel_width, 444);
            assert_eq!(after.panels.sections_panel_width, before.panels.sections_panel_width);
            assert_eq!(after.panels.data_table_height, before.panels.data_table_height);
        });
    });
}

#[test]
fn test_update_panel_sizes_data_only() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let before = config::get_config(state(&app));
            config::update_panel_sizes(state(&app), None, None, Some(555)).unwrap();
            let after = config::get_config(state(&app));
            assert_eq!(after.panels.data_table_height, 555);
            assert_eq!(after.panels.sections_panel_width, before.panels.sections_panel_width);
            assert_eq!(after.panels.detail_panel_width, before.panels.detail_panel_width);
        });
    });
}

#[test]
fn test_update_panel_sizes_all() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            config::update_panel_sizes(state(&app), Some(111), Some(222), Some(333)).unwrap();
            let after = config::get_config(state(&app));
            assert_eq!(after.panels.sections_panel_width, 111);
            assert_eq!(after.panels.detail_panel_width, 222);
            assert_eq!(after.panels.data_table_height, 333);
        });
    });
}

#[test]
fn test_update_panel_sizes_none_keeps_values() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let before = config::get_config(state(&app));
            config::update_panel_sizes(state(&app), None, None, None).unwrap();
            let after = config::get_config(state(&app));
            assert_eq!(after.panels.sections_panel_width, before.panels.sections_panel_width);
            assert_eq!(after.panels.detail_panel_width, before.panels.detail_panel_width);
            assert_eq!(after.panels.data_table_height, before.panels.data_table_height);
        });
    });
}

#[test]
fn test_save_display_setting_then_get() {
    let app = app_with_state();
    config::save_display_setting(state(&app), "k1".to_string(), "v1".to_string()).unwrap();
    let value = config::get_display_setting(state(&app), "k1".to_string()).unwrap();
    assert_eq!(value, Some("v1".to_string()));
}

#[test]
fn test_save_display_setting_overwrites() {
    let app = app_with_state();
    config::save_display_setting(state(&app), "k2".to_string(), "v1".to_string()).unwrap();
    config::save_display_setting(state(&app), "k2".to_string(), "v2".to_string()).unwrap();
    let value = config::get_display_setting(state(&app), "k2".to_string()).unwrap();
    assert_eq!(value, Some("v2".to_string()));
}

#[test]
fn test_get_display_setting_missing_returns_none() {
    let app = app_with_state();
    let value = config::get_display_setting(state(&app), "missing".to_string()).unwrap();
    assert_eq!(value, None);
}

#[test]
fn test_load_display_settings_empty_default() {
    let app = app_with_state();
    let values = config::load_display_settings(state(&app)).unwrap();
    assert!(values.is_empty());
}

#[test]
fn test_load_display_settings_returns_all() {
    let app = app_with_state();
    config::save_display_setting(state(&app), "k1".to_string(), "v1".to_string()).unwrap();
    config::save_display_setting(state(&app), "k2".to_string(), "v2".to_string()).unwrap();
    let values = config::load_display_settings(state(&app)).unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values.get("k1").cloned(), Some("v1".to_string()));
    assert_eq!(values.get("k2").cloned(), Some("v2".to_string()));
}

// === History commands ===

#[test]
fn test_can_undo_false_initial() {
    let app = app_with_state();
    assert!(!history::can_undo(state(&app)));
}

#[test]
fn test_can_redo_false_initial() {
    let app = app_with_state();
    assert!(!history::can_redo(state(&app)));
}

#[test]
fn test_undo_fails_when_empty() {
    let app = app_with_state();
    let result = history::undo(state(&app));
    assert_failure_contains(&result, "Nothing to undo");
}

#[test]
fn test_redo_fails_when_empty() {
    let app = app_with_state();
    let result = history::redo(state(&app));
    assert_failure_contains(&result, "Nothing to redo");
}

#[test]
fn test_can_undo_true_after_create_section() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    assert!(history::can_undo(state(&app)));
}

#[test]
fn test_undo_removes_section() {
    let app = app_with_state();
    create_project(&app);
    let section_id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let undo_result = history::undo(state(&app));
    assert_success(&undo_result);
    let section = section::get_section(state(&app), section_id);
    assert!(section.is_none());
}

#[test]
fn test_can_redo_true_after_undo() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let _ = history::undo(state(&app));
    assert!(history::can_redo(state(&app)));
}

#[test]
fn test_redo_restores_section() {
    let app = app_with_state();
    create_project(&app);
    let _section_id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let _ = history::undo(state(&app));
    let redo_result = history::redo(state(&app));
    assert_success(&redo_result);
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.sections.len(), 1);
}

#[test]
fn test_undo_to_fails_when_index_out_of_bounds() {
    let app = app_with_state();
    create_project(&app);
    // Create one section - only 1 item in undo stack
    create_section_with_shots(&app, vec![shot_data(1.0)]);

    // Index 0 should work (1 item), but index 1 should fail
    let result = history::undo_to(1, state(&app));
    assert!(!result.success);
    assert!(result.error.unwrap().contains("Invalid undo index"));
}

#[test]
fn test_undo_to_index_0_undoes_one_operation() {
    let app = app_with_state();
    create_project(&app);
    let section_id = create_section_with_shots(&app, vec![shot_data(1.0)]);

    // Undo to index 0 should undo just the most recent action
    let result = history::undo_to(0, state(&app));
    assert_success(&result);

    // Section should be removed
    let section = section::get_section(state(&app), section_id);
    assert!(section.is_none());
}

#[test]
fn test_undo_to_index_2_undoes_three_operations() {
    let app = app_with_state();
    create_project(&app);

    // Create 3 sections (3 undo entries)
    let _section_1 = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let _section_2 = create_section_with_shots(&app, vec![shot_data(2.0)]);
    let _section_3 = create_section_with_shots(&app, vec![shot_data(3.0)]);

    // Verify we have 3 sections
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.sections.len(), 3);

    // Undo to index 2 should undo all 3 sections (indices 0, 1, 2)
    let result = history::undo_to(2, state(&app));
    assert_success(&result);

    // All sections should be removed
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.sections.len(), 0);
}

#[test]
fn test_redo_to_fails_when_index_out_of_bounds() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    // Undo to create a redo entry
    let _ = history::undo(state(&app));

    // Index 0 should work (1 item), but index 1 should fail
    let result = history::redo_to(1, state(&app));
    assert!(!result.success);
    assert!(result.error.unwrap().contains("Invalid redo index"));
}

#[test]
fn test_redo_to_index_0_redoes_one_operation() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let _ = history::undo(state(&app));

    // Verify section is gone
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.sections.len(), 0);

    // Redo to index 0 should redo just the most recent undone action
    let result = history::redo_to(0, state(&app));
    assert_success(&result);

    // Section should be restored
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.sections.len(), 1);
}

#[test]
fn test_redo_to_index_2_redoes_three_operations() {
    let app = app_with_state();
    create_project(&app);

    // Create 3 sections
    let _section_1 = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let _section_2 = create_section_with_shots(&app, vec![shot_data(2.0)]);
    let _section_3 = create_section_with_shots(&app, vec![shot_data(3.0)]);

    // Undo all 3
    let _ = history::undo_to(2, state(&app));

    // Verify all sections are gone
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.sections.len(), 0);

    // Redo to index 2 should redo all 3 sections (indices 0, 1, 2)
    let result = history::redo_to(2, state(&app));
    assert_success(&result);

    // All sections should be restored
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.sections.len(), 3);
}

#[test]
fn test_undo_to_fails_when_stack_empty() {
    let app = app_with_state();
    // No project or actions
    let result = history::undo_to(0, state(&app));
    assert!(!result.success);
    assert!(result.error.unwrap().contains("Invalid undo index"));
}

#[test]
fn test_redo_to_fails_when_stack_empty() {
    let app = app_with_state();
    // No project or actions, so no redo available
    let result = history::redo_to(0, state(&app));
    assert!(!result.success);
    assert!(result.error.unwrap().contains("Invalid redo index"));
}

// === Project commands ===

#[test]
fn test_create_project_success() {
    let app = app_with_state();
    let result = project::create_project(
        state(&app),
        "Demo".to_string(),
        Some("Loc".to_string()),
    );
    assert_success(&result);
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.name, "Demo");
    assert_eq!(project_state.project.location, Some("Loc".to_string()));
}

#[test]
fn test_get_project_state_none_when_no_project() {
    let app = app_with_state();
    assert!(project::get_project_state(state(&app)).is_none());
}

#[test]
fn test_close_project_clears_state() {
    let app = app_with_state();
    create_project(&app);
    assert_success(&project::close_project(state(&app)));
    assert!(project::get_project_state(state(&app)).is_none());
}

#[test]
fn test_save_project_fails_when_no_project() {
    let app = app_with_state();
    let result = project::save_project(state(&app), Some(PathBuf::from("/tmp/nope.stalx")), None);
    assert_failure_contains(&result, "No project open");
}

#[test]
fn test_open_project_fails_when_missing() {
    let app = app_with_state();
    let result = project::open_project(state(&app), PathBuf::from("/tmp/missing.stalx"));
    assert_failure_contains(&result, "File not found");
}

#[test]
fn test_save_project_creates_stalx_extension() {
    with_config_lock(|| {
        let app = app_with_state();
        create_project(&app);
        let dir = TempDir::new().unwrap();
        let raw_path = dir.path().join("project_data");
        let result = project::save_project(state(&app), Some(raw_path), None);
        assert_success(&result);
        let saved_path = dir.path().join("project_data.stalx");
        assert!(saved_path.exists());
    });
}

#[test]
fn test_open_project_loads_saved_project() {
    with_config_lock(|| {
        let app = app_with_state();
        create_project(&app);
        let dir = TempDir::new().unwrap();
        let saved_path = save_project_to_temp(&app, &dir);

        let app2 = app_with_state();
        let result = project::open_project(state(&app2), saved_path);
        assert_success(&result);
        let project_state = project::get_project_state(state(&app2)).expect("project state");
        assert_eq!(project_state.project.name, "Test Cave");
    });
}

#[test]
fn test_project_lifecycle_persists_undo_and_state() {
    with_config_lock(|| {
        let app = app_with_state();
        create_project(&app);
        let section_a = create_section_with_shots(&app, vec![shot_data(10.0), shot_data(5.0)]);
        let section_b = create_section_with_shots(&app, vec![shot_data(7.0)]);

        let merge_result = station::merge_stations(
            state(&app),
            StationRef::new(section_a, 0),
            StationRef::new(section_b, 0),
        );
        assert_success(&merge_result);

        let gps = GpsCoordinates::new(10.0, 20.0, 0.0).unwrap();
        let datum_result = station::set_zero_datum(state(&app), StationRef::new(section_a, 0), gps);
        assert_success(&datum_result);

        let updates = ShotUpdates {
            length: Some(12.5),
            comment: Some(Some("recalc".to_string())),
            ..Default::default()
        };
        let update_result = shot::update_shot(state(&app), section_a, 0, updates);
        assert_success(&update_result);

        let undo_before = history::get_undo_stack(state(&app));
        assert!(!undo_before.is_empty());
        assert_eq!(undo_before[0].command_type, "update_shot");

        let dir = TempDir::new().unwrap();
        let saved_path = save_project_to_temp(&app, &dir);

        // Wait for background undo persistence thread to complete
        std::thread::sleep(std::time::Duration::from_millis(200));

        assert_success(&project::close_project(state(&app)));
        let open_result = project::open_project(state(&app), saved_path);
        assert_success(&open_result);

        let project_state = project::get_project_state(state(&app)).expect("project state");
        assert_eq!(project_state.project.sections.len(), 2);
        assert_eq!(project_state.project.station_merges.len(), 1);
        assert_eq!(project_state.project.zero_datums.len(), 1);

        let section = project_state
            .project
            .get_section(section_a)
            .expect("section a");
        assert!((section.shots[0].length - 12.5).abs() < f64::EPSILON);
        assert_eq!(section.shots[0].comment.as_deref(), Some("recalc"));

        let undo_after = history::get_undo_stack(state(&app));
        assert_eq!(undo_after.len(), undo_before.len());
        assert_eq!(undo_after[0].command_type, "update_shot");
    });
}

#[test]
fn test_get_project_state_emits_positional_wire_refs() {
    with_config_lock(|| {
        let app = app_with_state();
        create_project(&app);
        let section_a = create_section_with_shots(&app, vec![shot_data(10.0), shot_data(5.0)]);
        let section_b = create_section_with_shots(&app, vec![shot_data(7.0)]);
        // Merge two AfterShot stations across sections so the wire form must
        // resolve a non-trivial positional index.
        assert_success(&station::merge_stations(
            state(&app),
            StationRef::new(section_a, 1),
            StationRef::new(section_b, 1),
        ));

        let project_state = project::get_project_state(state(&app)).expect("project state");

        // The IPC payload (ProjectState) must carry the positional StationRef
        // wire shape: `station_index` present, no StationKey `anchor`.
        let ipc = serde_json::to_value(&project_state).unwrap();
        let merge = &ipc["project"]["station_merges"][0];
        assert!(
            merge["station_a"]["station_index"].is_number(),
            "wire merge endpoint must expose station_index, got: {merge}"
        );
        assert!(
            merge["station_a"].get("anchor").is_none(),
            "wire merge endpoint must NOT expose the StationKey anchor, got: {merge}"
        );

        // Regression guard: the raw Project serde (the undo snapshot path) must
        // STILL emit the lossless StationKey form. The two encodings diverge by
        // design — only the IPC view is positional.
        let raw = serde_json::to_string(&project_state.project).unwrap();
        assert!(
            raw.contains("anchor"),
            "raw Project serde must keep StationKey anchors for undo snapshots"
        );
    });
}

#[test]
#[cfg(target_os = "linux")]
fn test_open_project_updates_recent_projects_when_config_save_fails() {
    use std::os::unix::fs::PermissionsExt;

    // Skip when running as root — file permission restrictions don't apply to UID 0
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("Skipping: test requires non-root (chmod 555 has no effect as root)");
        return;
    }

    // Serialize against other config-touching tests, but DON'T redirect the
    // config path to a temp dir — this test drives config_path() itself by
    // pointing XDG_CONFIG_HOME at a read-only dir to force a save failure.
    let _config_guard = crate::test_helpers::config_lock_guard();
    {
        let readonly_dir = TempDir::new().unwrap();
        let mut perms = fs::metadata(readonly_dir.path()).unwrap().permissions();
        perms.set_mode(0o555);
        fs::set_permissions(readonly_dir.path(), perms).unwrap();

        let _env_guard = EnvVarGuard::set(
            "XDG_CONFIG_HOME",
            readonly_dir.path().to_str().unwrap(),
        );

        let app = app_with_state();
        let project_dir = TempDir::new().unwrap();
        let project_path = project_dir.path().join("config-fail.stalx");

        let mut project = Project::new("Config Fail".to_string(), None);
        project.add_section(SectionData {
            shots: vec![shot_data(1.0)],
            ..Default::default()
        });
        let mut db = Database::open(&project_path).unwrap();
        db.save_project(&project).unwrap();
        drop(db);

        let result = project::open_project(state(&app), project_path.clone());
        assert_success(&result);

        let cfg = config::get_config(state(&app));
        assert_eq!(cfg.general.recent_projects.first(), Some(&project_path));

        let config_path = crate::config::Config::config_path().unwrap();
        assert!(
            !config_path.exists(),
            "config file should not be written when config dir is read-only"
        );

        // Reset permissions so TempDir can clean up.
        let mut perms = fs::metadata(readonly_dir.path()).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(readonly_dir.path(), perms).unwrap();
    }
}

/// macOS sibling of the Linux test above. On macOS the `directories` crate ignores
/// XDG_CONFIG_HOME, deriving paths from $HOME instead. We override HOME to a
/// read-only temp dir so config.save() fails, then verify in-memory state is
/// still updated.
#[test]
#[cfg(target_os = "macos")]
fn test_open_project_updates_recent_projects_when_config_save_fails_macos() {
    use std::os::unix::fs::PermissionsExt;

    if unsafe { libc::geteuid() } == 0 {
        eprintln!("Skipping: test requires non-root (chmod 555 has no effect as root)");
        return;
    }

    // Lock-only (no temp-dir override): this test drives config_path() via HOME.
    let _config_guard = crate::test_helpers::config_lock_guard();
    {
        let readonly_dir = TempDir::new().unwrap();
        let mut perms = fs::metadata(readonly_dir.path()).unwrap().permissions();
        perms.set_mode(0o555);
        fs::set_permissions(readonly_dir.path(), perms).unwrap();

        // On macOS, directories crate uses ~/Library/Application Support/...
        // Setting HOME to a read-only dir makes create_dir_all fail for config save.
        let _env_guard = EnvVarGuard::set(
            "HOME",
            readonly_dir.path().to_str().unwrap(),
        );

        let app = app_with_state();
        let project_dir = TempDir::new().unwrap();
        let project_path = project_dir.path().join("config-fail.stalx");

        let mut project = Project::new("Config Fail".to_string(), None);
        project.add_section(SectionData {
            shots: vec![shot_data(1.0)],
            ..Default::default()
        });
        let mut db = Database::open(&project_path).unwrap();
        db.save_project(&project).unwrap();
        drop(db);

        let result = project::open_project(state(&app), project_path.clone());
        assert_success(&result);

        let cfg = config::get_config(state(&app));
        assert_eq!(cfg.general.recent_projects.first(), Some(&project_path));

        let config_path = crate::config::Config::config_path().unwrap();
        assert!(
            !config_path.exists(),
            "config file should not be written when HOME points to a read-only dir"
        );

        // Reset permissions so TempDir can clean up.
        let mut perms = fs::metadata(readonly_dir.path()).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(readonly_dir.path(), perms).unwrap();
    }
}

#[test]
fn test_open_project_updates_recent_projects_order_and_truncates() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let mut cfg = config::get_config(state(&app));
            cfg.general.recent_projects_max = 2;
            cfg.general.recent_projects = Vec::new();
            config::update_config(state(&app), cfg).expect("update config");

            let dir = TempDir::new().unwrap();
            let path_a = dir.path().join("a.stalx");
            let path_b = dir.path().join("b.stalx");
            let path_c = dir.path().join("c.stalx");

            for (path, name) in [
                (&path_a, "A"),
                (&path_b, "B"),
                (&path_c, "C"),
            ] {
                let mut project = Project::new(name.to_string(), None);
                project.add_section(SectionData {
                    shots: vec![shot_data(1.0)],
                    ..Default::default()
                });
                let mut db = Database::open(path).unwrap();
                db.save_project(&project).unwrap();
            }

            assert_success(&project::open_project(state(&app), path_a));
            assert_success(&project::open_project(state(&app), path_b.clone()));
            assert_success(&project::open_project(state(&app), path_c.clone()));

            let cfg = config::get_config(state(&app));
            assert_eq!(cfg.general.recent_projects, vec![path_c.clone(), path_b.clone()]);

            assert_success(&project::open_project(state(&app), path_b.clone()));
            let cfg = config::get_config(state(&app));
            assert_eq!(cfg.general.recent_projects, vec![path_b, path_c]);
        });
    });
}

#[test]
fn test_save_project_persists_sections() {
    with_config_lock(|| {
        let app = app_with_state();
        create_project(&app);
        create_section_with_shots(&app, vec![shot_data(1.0)]);
        let dir = TempDir::new().unwrap();
        let saved_path = save_project_to_temp(&app, &dir);

        let app2 = app_with_state();
        let _ = project::open_project(state(&app2), saved_path);
        let project_state = project::get_project_state(state(&app2)).expect("project state");
        assert_eq!(project_state.project.sections.len(), 1);
    });
}

#[test]
fn test_save_project_fails_when_output_is_directory() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            create_project(&app);
            let dir = TempDir::new().unwrap();
            let blocked = dir.path().join("blocked.stalx");
            fs::create_dir_all(&blocked).unwrap();

            let result = project::save_project(state(&app), Some(blocked.clone()), None);
            assert_failure_contains(&result, "Failed to finalize save");

            let temp_path = blocked.with_extension("stalx.tmp");
            assert!(!temp_path.exists());

            let project_state = state(&app).inner().get_project_state().unwrap();
            assert!(project_state.file_path.is_none());
        });
    });
}

#[test]
fn test_list_recent_projects_includes_saved() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            create_project(&app);
            let dir = TempDir::new().unwrap();
            let saved_path = save_project_to_temp(&app, &dir);
            let recent = project::list_recent_projects(state(&app));
            assert!(recent.iter().any(|p| p.file_path == saved_path));
        });
    });
}

#[test]
fn test_remove_from_recent_projects_fails_missing() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let missing = PathBuf::from("/tmp/does-not-exist.stalx");
            let result = project::remove_from_recent_projects(state(&app), missing);
            assert_failure_contains(&result, "Project not found");
        });
    });
}

#[test]
fn test_remove_from_recent_projects_success() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            create_project(&app);
            let dir = TempDir::new().unwrap();
            let saved_path = save_project_to_temp(&app, &dir);
            let remove_result = project::remove_from_recent_projects(state(&app), saved_path.clone());
            assert_success(&remove_result);
            let recent = project::list_recent_projects(state(&app));
            assert!(!recent.iter().any(|p| p.file_path == saved_path));
        });
    });
}

#[test]
fn test_save_project_fails_when_directory_missing() {
    with_config_lock(|| {
        let app = app_with_state();
        create_project(&app);
        let dir = TempDir::new().unwrap();
        let missing_dir = dir.path().join("missing");
        let path = missing_dir.join("project");

        let result = project::save_project(state(&app), Some(path), None);
        assert_failure_contains(&result, "Failed to create save file");
        assert!(!missing_dir.exists());
    });
}

#[test]
fn test_merge_projects_fails_when_source_missing() {
    let app = app_with_state();
    let project = project_with_section(vec![shot_data(1.0)]);
    let (db_a, _database_a) = TestDb::with_project(&project).unwrap();
    let missing_path = db_a.path().with_file_name("missing.stalx");
    let output_dir = TempDir::new().unwrap();
    let output_path = output_dir.path().join("merged.stalx");

    let result = project::merge_projects(
        state(&app),
        vec![db_a.path().to_path_buf(), missing_path],
        output_path,
        "Merged".to_string(),
        false,
    );

    assert_failure_contains(&result, "Source file not found");
}

// === Section commands ===

#[test]
fn test_create_section_fails_without_project() {
    let app = app_with_state();
    let result = section::create_section(
        state(&app),
        Some("Section".to_string()),
        None,
        None,
        "#4ecdc4".to_string(),
        None,
        vec![shot_data(1.0)],
    );
    assert_failure_contains(&result, "No project open");
}

#[test]
fn test_create_section_success_returns_id() {
    let app = app_with_state();
    create_project(&app);
    let section_id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    assert_eq!(section_id, 0);
}

#[test]
fn test_create_section_defaults_direction() {
    let app = app_with_state();
    create_project(&app);
    let result = section::create_section(
        state(&app),
        Some("Section".to_string()),
        None,
        None,
        "#4ecdc4".to_string(),
        None,
        vec![shot_data(1.0)],
    );
    assert_success(&result);
    let section = section::get_section(state(&app), result.section_id.unwrap()).unwrap();
    assert_eq!(section.direction, SurveyDirection::In);
}

#[test]
fn test_get_section_returns_none_missing() {
    let app = app_with_state();
    create_project(&app);
    assert!(section::get_section(state(&app), 999).is_none());
}

#[test]
fn test_get_section_returns_section() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let section = section::get_section(state(&app), id).unwrap();
    assert_eq!(section.id, id);
}

#[test]
fn test_update_section_fails_missing() {
    let app = app_with_state();
    create_project(&app);
    let result = section::update_section(state(&app), 99, SectionUpdates::default());
    assert_failure_contains(&result, "not found");
}

#[test]
fn test_update_section_updates_name() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let updates = SectionUpdates {
        name: Some(Some("Updated".to_string())),
        ..Default::default()
    };
    let result = section::update_section(state(&app), id, updates);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert_eq!(section.name, Some("Updated".to_string()));
}

#[test]
fn test_update_section_updates_color() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let updates = SectionUpdates {
        color: Some("#123456".to_string()),
        ..Default::default()
    };
    let result = section::update_section(state(&app), id, updates);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert_eq!(section.color, "#123456".to_string());
}

#[test]
fn test_delete_section_fails_missing() {
    let app = app_with_state();
    create_project(&app);
    let result = section::delete_section(state(&app), 22);
    assert_failure_contains(&result, "not found");
}

#[test]
fn test_delete_section_removes_section() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = section::delete_section(state(&app), id);
    assert_success(&result);
    assert!(section::get_section(state(&app), id).is_none());
}

#[test]
fn test_move_section_fails_missing() {
    let app = app_with_state();
    create_project(&app);
    let result = section::move_section(state(&app), 22, Coordinates::new(1.0, 1.0, 0.0));
    assert_failure_contains(&result, "Section not found");
}

#[test]
fn test_move_section_success() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = section::move_section(state(&app), id, Coordinates::new(2.0, -3.0, 0.0));
    assert_success(&result);
}

#[test]
fn test_move_segment_moves_connected_sections() {
    let app = app_with_state();
    create_project(&app);
    let section_a = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let section_b = create_section_with_shots(&app, vec![shot_data(1.0)]);

    assert_success(&station::merge_stations(
        state(&app),
        StationRef::new(section_a, 1),
        StationRef::new(section_b, 0),
    ));

    let before = project::get_project_state(state(&app)).expect("project state");
    let offset_a_before = before
        .project
        .section_offsets
        .get(&section_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let offset_b_before = before
        .project
        .section_offsets
        .get(&section_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    let delta = Coordinates::new(3.0, -2.0, 0.0);
    assert_success(&section::move_segment(state(&app), section_a, delta));

    let after = project::get_project_state(state(&app)).expect("project state");
    let offset_a_after = after
        .project
        .section_offsets
        .get(&section_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let offset_b_after = after
        .project
        .section_offsets
        .get(&section_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    assert!((offset_a_after.0 - (offset_a_before.0 + delta.x)).abs() < 1e-6);
    assert!((offset_a_after.1 - (offset_a_before.1 + delta.y)).abs() < 1e-6);
    assert!((offset_b_after.0 - (offset_b_before.0 + delta.x)).abs() < 1e-6);
    assert!((offset_b_after.1 - (offset_b_before.1 + delta.y)).abs() < 1e-6);
}

#[test]
fn test_create_section_with_validation_warnings() {
    let app = app_with_state();
    create_project(&app);
    let result = section::create_section(
        state(&app),
        Some("Section".to_string()),
        None,
        None,
        "#4ecdc4".to_string(),
        None,
        vec![shot_data(0.05)],
    );
    assert!(result.success);
    assert!(!result.warnings.is_empty());
}

// === Shot commands ===

#[test]
fn test_create_shot_fails_without_project() {
    let app = app_with_state();
    let result = shot::create_shot(state(&app), 0, shot_data(1.0), None, None);
    assert_failure_contains(&result, "No project open");
}

#[test]
fn test_create_shot_fails_invalid_section() {
    let app = app_with_state();
    create_project(&app);
    let result = shot::create_shot(state(&app), 99, shot_data(1.0), None, None);
    assert_failure_contains(&result, "Section 99 not found");
}

#[test]
fn test_create_shot_success_adds_shot() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![]);
    let result = shot::create_shot(state(&app), id, shot_data(1.0), None, None);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert_eq!(section.shots.len(), 1);
}

#[test]
fn test_create_shot_after_shot_id_inserts() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0), shot_data(2.0)]);
    let result = shot::create_shot(state(&app), id, shot_data(3.0), Some(0), None);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert_eq!(section.shots.len(), 3);
    assert_eq!(section.shots[1].length, 3.0);
}

#[test]
fn test_create_shot_returns_warning_for_short() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![]);
    let result = shot::create_shot(state(&app), id, shot_data(0.05), None, None);
    assert!(result.success);
    assert!(!result.warnings.is_empty());
    assert!(result.shot_id.is_some(), "shot_id must be returned even when warnings are present");
}

#[test]
fn test_create_shot_rejects_both_after_and_before() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0), shot_data(2.0)]);
    let result = shot::create_shot(state(&app), id, shot_data(3.0), Some(0), Some(1));
    assert_failure_contains(&result, "Cannot specify both");
}

#[test]
fn test_create_shot_before_inserts_at_position() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0), shot_data(2.0)]);
    // Insert before the first shot (position 0)
    let result = shot::create_shot(state(&app), id, shot_data(5.0), None, Some(0));
    assert_success(&result);
    assert!(result.shot_id.is_some(), "shot_id must be returned on success");
    let section = section::get_section(state(&app), id).unwrap();
    assert_eq!(section.shots.len(), 3);
    assert_eq!(section.shots[0].length, 5.0, "New shot should be at position 0 (prepended)");
    assert_eq!(section.shots[1].length, 1.0);
    assert_eq!(section.shots[2].length, 2.0);
}

#[test]
fn test_update_shot_fails_missing() {
    let app = app_with_state();
    create_project(&app);
    let result = shot::update_shot(state(&app), 0, 999, ShotUpdates::default());
    assert_failure_contains(&result, "not found");
}

#[test]
fn test_update_shot_updates_length() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let updates = ShotUpdates {
        length: Some(12.0),
        ..Default::default()
    };
    let result = shot::update_shot(state(&app), id, 0, updates);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert_eq!(section.shots[0].length, 12.0);
}

#[test]
fn test_update_shot_updates_comment() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let updates = ShotUpdates {
        comment: Some(Some("note".to_string())),
        ..Default::default()
    };
    let result = shot::update_shot(state(&app), id, 0, updates);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert_eq!(section.shots[0].comment, Some("note".to_string()));
}

#[test]
fn test_delete_shot_fails_missing() {
    let app = app_with_state();
    create_project(&app);
    let result = shot::delete_shot(state(&app), 0, 1);
    assert_failure_contains(&result, "not found");
}

#[test]
fn test_delete_shot_removes_shot() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = shot::delete_shot(state(&app), id, 0);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert!(section.shots.is_empty());
}

#[test]
fn test_delete_shot_and_split_creates_new_section() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(
        &app,
        vec![shot_data(1.0), shot_data(2.0), shot_data(3.0)],
    );
    let section_state = section::get_section(state(&app), id).unwrap();
    let shot_id = section_state.shots[1].id;

    let result = shot::delete_shot_and_split(
        state(&app),
        id,
        shot_id,
        "Section A".to_string(),
        "Section B".to_string(),
    );
    assert_success(&result);
    let new_id = result.section_id.expect("new section id");

    let section_a = section::get_section(state(&app), id).unwrap();
    let section_b = section::get_section(state(&app), new_id).unwrap();
    assert_eq!(section_a.name, Some("Section A".to_string()));
    assert_eq!(section_b.name, Some("Section B".to_string()));
    assert_eq!(section_a.shots.len(), 1);
    assert_eq!(section_b.shots.len(), 1);
}

#[test]
fn test_delete_last_shot_and_section_removes_section() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let section_state = section::get_section(state(&app), id).unwrap();
    let shot_id = section_state.shots[0].id;

    let result = shot::delete_last_shot_and_section(state(&app), id, shot_id);
    assert_success(&result);
    assert!(section::get_section(state(&app), id).is_none());
}

#[test]
fn test_set_shot_reference_fails_missing() {
    let app = app_with_state();
    create_project(&app);
    let result = shot::set_shot_reference(state(&app), 0, 999, true);
    assert_failure_contains(&result, "not found");
}

#[test]
fn test_set_shot_reference_sets_true() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = shot::set_shot_reference(state(&app), id, 0, true);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert!(section.shots[0].is_reference);
}

#[test]
fn test_set_shot_reference_sets_false() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let _ = shot::set_shot_reference(state(&app), id, 0, true);
    let result = shot::set_shot_reference(state(&app), id, 0, false);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert!(!section.shots[0].is_reference);
}

// === Station commands ===

#[test]
fn test_merge_stations_fails_without_project() {
    let app = app_with_state();
    let result = station::merge_stations(
        state(&app),
        StationRef::new(0, 0),
        StationRef::new(1, 0),
    );
    assert_failure_contains(&result, "No project open");
}

#[test]
fn test_merge_stations_fails_same_section() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = station::merge_stations(
        state(&app),
        StationRef::new(0, 0),
        StationRef::new(0, 1),
    );
    assert_failure_contains(&result, "same section");
}

#[test]
fn test_merge_stations_success_between_sections() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = station::merge_stations(
        state(&app),
        StationRef::new(0, 1),
        StationRef::new(1, 0),
    );
    assert_success(&result);
}

#[test]
fn test_unmerge_stations_noop_success() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = station::unmerge_stations(state(&app), StationRef::new(0, 0));
    assert_success(&result);
}

#[test]
fn test_unmerge_stations_removes_merge() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let _ = station::merge_stations(
        state(&app),
        StationRef::new(0, 1),
        StationRef::new(1, 0),
    );
    let result = station::unmerge_stations(state(&app), StationRef::new(0, 1));
    assert_success(&result);
}

#[test]
fn test_set_zero_datum_success() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let gps = GpsCoordinates {
        latitude: 1.0,
        longitude: 2.0,
        depth_reference: 3.0,
    };
    let result = station::set_zero_datum(state(&app), StationRef::new(0, 0), gps);
    assert_success(&result);
}

#[test]
fn test_set_zero_datum_fails_invalid_station() {
    let app = app_with_state();
    create_project(&app);
    let gps = GpsCoordinates {
        latitude: 1.0,
        longitude: 2.0,
        depth_reference: 3.0,
    };
    let result = station::set_zero_datum(state(&app), StationRef::new(0, 99), gps);
    assert_failure_contains(&result, "does not exist");
}

#[test]
fn test_remove_zero_datum_fails_when_not_zero() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = station::remove_zero_datum(state(&app), StationRef::new(0, 0));
    assert_failure_contains(&result, "not a zero datum");
}

#[test]
fn test_remove_zero_datum_success() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let gps = GpsCoordinates {
        latitude: 1.0,
        longitude: 2.0,
        depth_reference: 3.0,
    };
    let _ = station::set_zero_datum(state(&app), StationRef::new(0, 0), gps);
    let result = station::remove_zero_datum(state(&app), StationRef::new(0, 0));
    assert_success(&result);
}

#[test]
fn test_move_station_fails_without_project() {
    let app = app_with_state();
    let result = station::move_station(
        state(&app),
        StationRef::new(0, 0),
        Coordinates::new(1.0, 1.0, 0.0),
    );
    assert_failure_contains(&result, "No project open");
}

#[test]
fn test_move_station_fails_invalid_section() {
    let app = app_with_state();
    create_project(&app);
    let result = station::move_station(
        state(&app),
        StationRef::new(99, 0),
        Coordinates::new(1.0, 1.0, 0.0),
    );
    assert_failure_contains(&result, "Section not found");
}

#[test]
fn test_move_station_fails_invalid_index() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = station::move_station(
        state(&app),
        StationRef::new(0, 5),
        Coordinates::new(1.0, 1.0, 0.0),
    );
    assert_failure_contains(&result, "Invalid station index");
}

#[test]
fn test_move_station_success() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = station::move_station(
        state(&app),
        StationRef::new(0, 0),
        Coordinates::new(1.0, 1.0, 0.0),
    );
    assert_success(&result);
}

// === Import commands ===

#[test]
fn test_import_dmp_missing_file_err() {
    let missing = PathBuf::from("/tmp/does-not-exist.dmp");
    let result = import::import_dmp(missing);
    assert!(result.is_err());
}

#[test]
fn test_calculate_file_hash_empty() {
    let file = NamedTempFile::new().unwrap();
    let hash = import::calculate_file_hash(file.path().to_path_buf()).unwrap();
    assert_eq!(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

#[test]
fn test_calculate_file_hash_known_abc() {
    let file = NamedTempFile::new().unwrap();
    fs::write(file.path(), b"abc").unwrap();
    let hash = import::calculate_file_hash(file.path().to_path_buf()).unwrap();
    assert_eq!(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

#[test]
fn test_calculate_file_hash_known_linebreak() {
    let file = NamedTempFile::new().unwrap();
    fs::write(file.path(), b"line1\n").unwrap();
    let hash = import::calculate_file_hash(file.path().to_path_buf()).unwrap();
    assert_eq!(hash, "cd205f1f8b8ab1bf7da554fd3460b5d377c587eb7fa4f394c3f403af3a787a1b");
}

#[test]
fn test_check_duplicate_import_false_no_project() {
    let app = app_with_state();
    let result = import::check_duplicate_import(state(&app), "hash1".to_string()).unwrap();
    assert!(!result);
}

#[test]
fn test_track_imported_file_fails_no_project() {
    let app = app_with_state();
    let result = import::track_imported_file(state(&app), "hash1".to_string());
    assert_failure_contains(&result, "No project open");
}

#[test]
fn test_track_imported_file_then_check_true() {
    let app = app_with_state();
    create_project(&app);
    let _ = import::track_imported_file(state(&app), "hash1".to_string());
    let result = import::check_duplicate_import(state(&app), "hash1".to_string()).unwrap();
    assert!(result);
}

#[test]
fn test_track_imported_file_idempotent() {
    let app = app_with_state();
    create_project(&app);
    let _ = import::track_imported_file(state(&app), "hash1".to_string());
    let _ = import::track_imported_file(state(&app), "hash1".to_string());
    let project_state = project::get_project_state(state(&app)).unwrap();
    assert_eq!(project_state.project.imported_file_hashes.len(), 1);
}

#[test]
fn test_check_duplicate_import_false_before_track() {
    let app = app_with_state();
    create_project(&app);
    let result = import::check_duplicate_import(state(&app), "hash2".to_string()).unwrap();
    assert!(!result);
}

// === Export commands ===

#[test]
fn test_export_csv_fails_no_project() {
    let app = app_with_state();
    let result = export::export_csv(state(&app), PathBuf::from("/tmp/out.csv"));
    assert!(result.is_err());
}

#[test]
fn test_export_json_fails_no_project() {
    let app = app_with_state();
    let result = export::export_json(state(&app), PathBuf::from("/tmp/out.json"));
    assert!(result.is_err());
}

#[test]
fn test_export_image_fails_no_project() {
    let app = app_with_state();
    let options = crate::export::ExportImageOptions::default();
    let result = export::export_image_impl(state(&app).inner(), PathBuf::from("/tmp/out.png"), options);
    assert!(result.is_err());
}

#[test]
fn test_export_csv_fails_when_directory_missing() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let dir = TempDir::new().unwrap();
    let missing_dir = dir.path().join("missing");
    let path = missing_dir.join("out.csv");
    let result = export::export_csv(state(&app), path.clone());
    assert!(result.is_err());
    assert!(!path.exists());
}

#[test]
fn test_export_json_fails_when_directory_missing() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let dir = TempDir::new().unwrap();
    let missing_dir = dir.path().join("missing");
    let path = missing_dir.join("out.json");
    let result = export::export_json(state(&app), path.clone());
    assert!(result.is_err());
    assert!(!path.exists());
}

#[test]
fn test_export_image_fails_when_directory_missing() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let dir = TempDir::new().unwrap();
    let missing_dir = dir.path().join("missing");
    let path = missing_dir.join("out.svg");
    let mut options = crate::export::ExportImageOptions::default();
    options.format = crate::export::ImageFormat::Svg;
    let result = export::export_image_impl(state(&app).inner(), path.clone(), options);
    assert!(result.is_err());
    assert!(!path.exists());
}

#[test]
fn test_export_image_rejects_zero_dpi() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("out.png");
    let mut options = crate::export::ExportImageOptions::default();
    options.format = crate::export::ImageFormat::Png;
    options.dpi = 0;
    let result = export::export_image_impl(state(&app).inner(), path.clone(), options);
    assert!(result.is_err());
    assert!(!path.exists());
}

#[test]
fn test_export_json_overwrites_existing_file() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("out.json");
    fs::write(&path, "sentinel").unwrap();
    export::export_json(state(&app), path.clone()).unwrap();
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.contains("\"project\""));
    assert!(!contents.contains("sentinel"));
}

#[test]
fn test_export_csv_success_creates_file() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("out.csv");
    export::export_csv(state(&app), path.clone()).unwrap();
    assert!(path.exists());
}

#[test]
fn test_export_json_success_creates_file() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("out.json");
    export::export_json(state(&app), path.clone()).unwrap();
    assert!(path.exists());
}

#[test]
fn test_export_image_success_creates_file() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(1.0)]);
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("out.svg");
    let mut options = crate::export::ExportImageOptions::default();
    options.format = crate::export::ImageFormat::Svg;
    export::export_image_impl(state(&app).inner(), path.clone(), options).unwrap();
    assert!(path.exists());
}

#[test]
fn test_export_roundtrip_includes_reference_and_comment() {
    let app = app_with_state();
    create_project(&app);
    let shot = ShotData {
        azimuth_in: 12.0,
        azimuth_out: 15.0,
        length: 8.25,
        depth_in: 1.0,
        depth_out: 2.0,
        left: Some(0.3),
        right: Some(0.4),
        up: Some(0.5),
        down: Some(0.6),
        comment: Some("note,with comma".to_string()),
        ..Default::default()
    };
    let section_id = create_section_with_shots(&app, vec![shot]);
    assert_success(&shot::set_shot_reference(state(&app), section_id, 0, true));

    let dir = TempDir::new().unwrap();
    let csv_path = dir.path().join("export.csv");
    let json_path = dir.path().join("export.json");

    export::export_csv(state(&app), csv_path.clone()).unwrap();
    export::export_json(state(&app), json_path.clone()).unwrap();

    let csv_contents = fs::read_to_string(&csv_path).unwrap();
    assert!(csv_contents.contains("section_id,section_name"));
    assert!(csv_contents.contains("\"note,with comma\""));
    assert!(csv_contents.contains("true"));

    let json_contents = fs::read_to_string(&json_path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json_contents).unwrap();
    let shot_json = &parsed["sections"][0]["shots"][0];
    assert_eq!(shot_json["is_reference"], true);
    assert_eq!(shot_json["comment"], "note,with comma");
    assert!(shot_json["lrud"].is_array());
}

// === Cache commands ===

#[test]
fn test_get_cache_stats_empty_when_disabled() {
    let app = app_with_state();
    let cache = state(&app).tile_cache();
    let mut guard = cache.lock().unwrap();
    *guard = None;
    drop(guard);
    let stats = cache::get_cache_stats(state(&app)).unwrap();
    assert_eq!(stats.total_tiles, 0);
    assert_eq!(stats.total_bytes, 0);
    assert!(stats.providers.is_empty());
}

#[test]
fn test_get_cache_stats_counts_provider() {
    let app = app_with_state();
    let cache = state(&app).tile_cache();
    {
        let mut guard = cache.lock().unwrap();
        *guard = Some(crate::cache::TileCache::in_memory(1, 30).unwrap());
        let c = guard.as_mut().unwrap();
        c.put("esri", 1, 2, 3, b"data", "image/png").unwrap();
    }
    let stats = cache::get_cache_stats(state(&app)).unwrap();
    assert_eq!(stats.total_tiles, 1);
    assert_eq!(stats.providers.get("esri").unwrap().tiles, 1);
}

#[test]
fn test_clear_tile_cache_noop_when_disabled() {
    let app = app_with_state();
    let cache = state(&app).tile_cache();
    let mut guard = cache.lock().unwrap();
    *guard = None;
    drop(guard);
    let result = cache::clear_tile_cache(state(&app), None);
    assert!(result.is_ok());
}

#[test]
fn test_clear_tile_cache_all_clears() {
    let app = app_with_state();
    let cache = state(&app).tile_cache();
    {
        let mut guard = cache.lock().unwrap();
        *guard = Some(crate::cache::TileCache::in_memory(1, 30).unwrap());
        let c = guard.as_mut().unwrap();
        c.put("esri", 1, 2, 3, b"data", "image/png").unwrap();
    }
    cache::clear_tile_cache(state(&app), None).unwrap();
    let stats = cache::get_cache_stats(state(&app)).unwrap();
    assert_eq!(stats.total_tiles, 0);
}

#[test]
fn test_clear_tile_cache_provider_only_clears() {
    let app = app_with_state();
    let cache = state(&app).tile_cache();
    {
        let mut guard = cache.lock().unwrap();
        *guard = Some(crate::cache::TileCache::in_memory(1, 30).unwrap());
        let c = guard.as_mut().unwrap();
        c.put("esri", 1, 2, 3, b"data", "image/png").unwrap();
        c.put("other", 1, 2, 3, b"data", "image/png").unwrap();
    }
    cache::clear_tile_cache(state(&app), Some("esri".to_string())).unwrap();
    let stats = cache::get_cache_stats(state(&app)).unwrap();
    assert_eq!(stats.total_tiles, 1);
    assert!(stats.providers.contains_key("other"));
}

// FIXME: This test is not hermetic and currently cannot pass. The default
// CacheConfig disables offline caching for "esri" (the only registered
// provider), so fetch_tile always bypasses the cache and makes a live network
// request to ESRI instead of returning the seeded bytes. The cache-hit path is
// never reached for esri under default config. Re-enable once there is a test
// seam to exercise a cache hit without enabling esri caching or hitting the
// network (e.g. a fake provider / injectable fetcher).
#[test]
#[ignore = "not hermetic: esri caching is disabled by default, so fetch_tile hits the network"]
fn test_fetch_tile_cache_hit_returns_data() {
    let app = app_with_state();
    let cache = state(&app).tile_cache();
    {
        let mut guard = cache.lock().unwrap();
        *guard = Some(crate::cache::TileCache::in_memory(1, 30).unwrap());
        let c = guard.as_mut().unwrap();
        c.put("esri", 1, 2, 3, b"data", "image/png").unwrap();
    }
    let bytes = tauri::async_runtime::block_on(cache::fetch_tile(
        state(&app),
        "esri".to_string(),
        1,
        2,
        3,
    ))
    .unwrap();
    assert_eq!(bytes, b"data");
}

#[test]
fn test_fetch_tile_unknown_provider_errors() {
    let app = app_with_state();
    let result = tauri::async_runtime::block_on(cache::fetch_tile(
        state(&app),
        "unknown".to_string(),
        1,
        2,
        3,
    ));
    assert!(result.is_err());
}

// === Validation commands ===

#[test]
fn test_get_project_warnings_empty_when_no_project() {
    let app = app_with_state();
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.is_empty());
}

#[test]
fn test_get_project_warnings_detects_zero_length() {
    let app = app_with_state();
    let project = project_with_section(vec![shot_data(0.0)]);
    set_project_for_tests(&app, project);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.code == "ZERO_LENGTH"));
}

#[test]
fn test_get_project_warnings_detects_negative_length() {
    let app = app_with_state();
    let project = project_with_section(vec![shot_data(-1.0)]);
    set_project_for_tests(&app, project);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.code == "NEGATIVE_LENGTH"));
}

#[test]
fn test_get_project_warnings_detects_short_shot() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(0.05)]);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.code == "SHORT_SHOT"));
}

#[test]
fn test_get_project_warnings_detects_long_shot() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data(100.0)]);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.code == "LONG_SHOT"));
}

#[test]
fn test_get_project_warnings_orders_error_before_warning() {
    let app = app_with_state();
    let project = project_with_section(vec![shot_data(0.0), shot_data(0.05)]);
    set_project_for_tests(&app, project);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(!warnings.is_empty());
    assert_eq!(warnings[0].severity, crate::core::WarningSeverity::Error);
}

#[test]
fn test_get_project_warnings_includes_shot_index() {
    let app = app_with_state();
    let project = project_with_section(vec![shot_data(0.0), shot_data(0.0)]);
    set_project_for_tests(&app, project);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.shot_index == 0));
    assert!(warnings.iter().any(|w| w.shot_index == 1));
}

#[test]
fn test_get_project_warnings_multiple_sections_sorted_by_section_id() {
    let app = app_with_state();
    let mut project = Project::new("Test Cave".to_string(), None);
    project.add_section(SectionData {
        shots: vec![shot_data(0.0)],
        ..Default::default()
    });
    project.add_section(SectionData {
        shots: vec![shot_data(0.0)],
        ..Default::default()
    });
    set_project_for_tests(&app, project);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.len() >= 2);
    assert!(warnings[0].section_id <= warnings[1].section_id);
}

#[test]
fn test_get_project_warnings_detects_large_depth_change() {
    let app = app_with_state();
    create_project(&app);
    create_section_with_shots(&app, vec![shot_data_with_depth(5.0, 0.0, 20.0)]);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.code == "LARGE_DEPTH_CHANGE"));
}

#[test]
fn test_resolve_warning_fails_without_db() {
    let app = app_with_state();
    let result = validation::resolve_warning(
        state(&app),
        0,
        0,
        "ZERO_LENGTH".to_string(),
        None,
    );
    assert!(result.is_err());
}

#[test]
fn test_unresolve_warning_fails_without_db() {
    let app = app_with_state();
    let result = validation::unresolve_warning(
        state(&app),
        0,
        0,
        "ZERO_LENGTH".to_string(),
    );
    assert!(result.is_err());
}

#[test]
fn test_resolve_warning_marks_resolved_in_list() {
    let project = project_with_section(vec![shot_data(0.0)]);
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let warnings = validation::get_project_warnings(state(&app));
    let warning = warnings
        .iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    assert!(!warning.is_resolved);

    validation::resolve_warning(
        state(&app),
        warning.section_id,
        warning.shot_id,
        warning.code.clone(),
        Some("ack".to_string()),
    )
    .unwrap();

    let warnings_after = validation::get_project_warnings(state(&app));
    let warning_after = warnings_after
        .iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    assert!(warning_after.is_resolved);
}

#[test]
fn test_unresolve_warning_clears_resolved_flag() {
    let project = project_with_section(vec![shot_data(0.0)]);
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let warning = validation::get_project_warnings(state(&app))
        .into_iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");

    validation::resolve_warning(
        state(&app),
        warning.section_id,
        warning.shot_id,
        warning.code.clone(),
        None,
    )
    .unwrap();

    validation::unresolve_warning(
        state(&app),
        warning.section_id,
        warning.shot_id,
        warning.code,
    )
    .unwrap();

    let warnings_after = validation::get_project_warnings(state(&app));
    let warning_after = warnings_after
        .iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    assert!(!warning_after.is_resolved);
}

#[test]
fn test_resolved_warning_follows_shot_uuid_after_id_change() {
    // Issue #57: an ignore is keyed by the shot's stable UUID, so it stays
    // bound to the same shot even after a structural edit renumbers shot_id
    // (e.g. inserting a shot earlier in the section).
    let mut project = project_with_section(vec![shot_data(0.0)]);
    project.ensure_shot_uuids();
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let warning = validation::get_project_warnings(state(&app))
        .into_iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    let original_shot_id = warning.shot_id;
    let uuid = warning.shot_uuid.clone().expect("loaded shot has a uuid");

    validation::resolve_warning(
        state(&app),
        warning.section_id,
        warning.shot_id,
        warning.code.clone(),
        None,
    )
    .unwrap();
    assert!(validation::get_project_warnings(state(&app))
        .iter()
        .any(|w| w.code == "ZERO_LENGTH" && w.is_resolved));

    // Drift the unstable shot_id (mimicking an insert/reload) but keep the UUID.
    let mut renumbered = state(&app).inner().get_project_state().unwrap();
    renumbered.sections[0].shots[0].id = original_shot_id + 1000;
    state(&app).inner().set_project_for_tests(renumbered);

    let after = validation::get_project_warnings(state(&app));
    let w = after
        .iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    assert_eq!(w.shot_uuid.as_deref(), Some(uuid.as_str()));
    assert_ne!(w.shot_id, original_shot_id, "precondition: shot_id changed");
    assert!(w.is_resolved, "ignore must follow the shot UUID across an id change");
}

#[test]
fn test_resolved_warning_legacy_position_fallback_matches_uuid_shot() {
    // Issue #57: a pre-v8 (or pre-v6) suppression row carries no shot_uuid and is
    // keyed by (section_id, shot_id) position. After load the shot has a freshly
    // minted in-memory UUID, but the legacy row must still suppress it — without
    // the position fallback a pre-v6 file's ignores would be silently lost.
    let mut project = project_with_section(vec![shot_data(0.0)]);
    project.ensure_shot_uuids();
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let warning = validation::get_project_warnings(state(&app))
        .into_iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    assert!(warning.shot_uuid.is_some(), "loaded shot already carries a uuid");
    assert!(!warning.is_resolved);

    // Insert a LEGACY suppression row with NO shot_uuid, keyed by position only.
    state(&app)
        .inner()
        .save_resolved_warning(&crate::persistence::ResolvedWarning {
            section_id: warning.section_id,
            shot_id: warning.shot_id,
            warning_code: warning.code.clone(),
            resolved_at: chrono::Utc::now(),
            resolved_comment: None,
            shot_uuid: None,
        })
        .unwrap();

    let after = validation::get_project_warnings(state(&app));
    let w = after
        .iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    assert!(
        w.is_resolved,
        "a legacy position-keyed row must still suppress the now-UUID-bearing shot"
    );
}

#[test]
fn test_resolved_warning_survives_save() {
    // Issue #57 regression: resolved (ignored) warnings live in their own table,
    // not the Project model, so the save pipeline (temp file + atomic rename)
    // used to drop them. A save must carry them over so an ignore persists.
    let mut project = project_with_section(vec![shot_data(0.0)]);
    project.ensure_shot_uuids();
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let warning = validation::get_project_warnings(state(&app))
        .into_iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    validation::resolve_warning(
        state(&app),
        warning.section_id,
        warning.shot_id,
        warning.code.clone(),
        None,
    )
    .unwrap();

    // Save rebuilds the .stalx and reopens the DB at the new file.
    let dir = tempfile::tempdir().unwrap();
    let _saved = save_project_to_temp(&app, &dir);

    let after = validation::get_project_warnings(state(&app));
    let w = after
        .iter()
        .find(|w| w.code == "ZERO_LENGTH")
        .expect("zero length warning");
    assert!(w.is_resolved, "resolved/ignored warning must survive a save");
}

#[test]
fn test_save_keeps_other_ignores_when_a_section_was_deleted() {
    // Regression (#57 review): a resolved_warnings row for a deleted section is
    // orphaned in the DB (delete_section is in-memory and never prunes the
    // table). The save carry-over must skip it instead of letting one FK-violating
    // row abort the whole transaction and silently drop every other ignore.
    let mut project = Project::new("Test Cave".to_string(), None);
    for (name, color) in [("A", "#4ecdc4"), ("B", "#ff6b6b")] {
        project.add_section(SectionData {
            name: Some(name.to_string()),
            surveyor: None,
            date: None,
            color: color.to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![shot_data(0.0)], // zero-length → ZERO_LENGTH warning
        });
    }
    project.ensure_shot_uuids();
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    // Ignore the ZERO_LENGTH warning in each section.
    let zero: Vec<_> = validation::get_project_warnings(state(&app))
        .into_iter()
        .filter(|w| w.code == "ZERO_LENGTH")
        .collect();
    assert_eq!(zero.len(), 2, "expected a zero-length warning per section");
    for w in &zero {
        validation::resolve_warning(state(&app), w.section_id, w.shot_id, w.code.clone(), None).unwrap();
    }
    let surviving_section = zero[1].section_id;

    // Delete the first section — its resolved_warnings row is now orphaned.
    assert_success(&section::delete_section(state(&app), zero[0].section_id));

    // Save, then confirm the surviving section's ignore is still resolved.
    let dir = tempfile::tempdir().unwrap();
    let _ = save_project_to_temp(&app, &dir);

    let after = validation::get_project_warnings(state(&app));
    let surviving = after
        .iter()
        .find(|w| w.section_id == surviving_section && w.code == "ZERO_LENGTH")
        .expect("surviving section's zero-length warning");
    assert!(
        surviving.is_resolved,
        "an ignore in a surviving section must not be lost because another section was deleted"
    );
}

#[test]
fn test_resolve_warning_refuses_to_ignore_over_anchoring() {
    // Over-anchoring is not ignorable (issue #57): the resolve_warning command
    // must refuse to persist a suppression for it.
    let project = project_with_section(vec![shot_data(0.0)]);
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    validation::resolve_warning(
        state(&app),
        0,
        0,
        crate::models::MULTIPLE_DATUMS_PER_MERGE_COMPONENT.to_string(),
        None,
    )
    .unwrap();

    assert!(
        state(&app).inner().load_resolved_warnings().unwrap().is_empty(),
        "over-anchoring must never be recorded as an ignored warning"
    );
}

#[test]
fn test_over_anchoring_warning_is_never_suppressible() {
    // The authoritative invariant: even a stray resolved row (legacy, bulk, or
    // any other path) must NOT mark an over-anchoring warning resolved. It clears
    // only by removing a datum, after which the warning is not generated at all.
    use crate::models::{StationMerge, ZeroDatum};

    let mut project = Project::new("OverAnchored".to_string(), None);
    let a = project
        .add_section(SectionData { shots: vec![shot_data(10.0)], ..Default::default() })
        .id;
    let b = project
        .add_section(SectionData { shots: vec![shot_data(10.0)], ..Default::default() })
        .id;
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1).into(),
        station_b: StationRef::new(b, 0).into(),
        merged_at: chrono::Utc::now(),
    });
    project.rebuild_merge_adjacency();
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0).into(),
        gps: GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(b, 0).into(),
        gps: GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
    });
    project.ensure_shot_uuids();

    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let datum_warning = validation::get_project_warnings(state(&app))
        .into_iter()
        .find(|w| w.code == crate::models::MULTIPLE_DATUMS_PER_MERGE_COMPONENT)
        .expect("over-anchored merge component must raise a warning");
    assert!(!datum_warning.is_resolved, "freshly raised, not resolved");

    // Force a stray resolved row keyed exactly as the warning (as a bulk save or
    // a legacy file could). Compute must still refuse to mark it resolved.
    state(&app)
        .inner()
        .save_resolved_warning(&crate::persistence::ResolvedWarning {
            section_id: datum_warning.section_id,
            shot_id: datum_warning.shot_id,
            warning_code: datum_warning.code.clone(),
            resolved_at: chrono::Utc::now(),
            resolved_comment: None,
            shot_uuid: datum_warning.shot_uuid.clone(),
        })
        .unwrap();

    let after = validation::get_project_warnings(state(&app));
    let w = after
        .iter()
        .find(|w| w.code == crate::models::MULTIPLE_DATUMS_PER_MERGE_COMPONENT)
        .expect("over-anchoring warning still present");
    assert!(
        !w.is_resolved,
        "over-anchoring must never be suppressed by a resolved row"
    );
}

#[test]
fn test_get_project_warnings_detects_invalid_azimuth() {
    let app = app_with_state();
    create_project(&app);
    let mut shot = shot_data(1.0);
    shot.azimuth_in = -1.0;
    create_section_with_shots(&app, vec![shot]);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.code == "INVALID_AZIMUTH"));
}

#[test]
fn test_get_project_warnings_detects_negative_lrud() {
    let app = app_with_state();
    create_project(&app);
    let mut shot = shot_data(1.0);
    shot.left = Some(-1.0);
    create_section_with_shots(&app, vec![shot]);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.code == "NEGATIVE_LRUD"));
}

#[test]
fn test_get_project_warnings_detects_azimuth_deviation() {
    let app = app_with_state();
    create_project(&app);
    let mut shot = shot_data(5.0);
    shot.azimuth_in = 0.0;
    shot.azimuth_out = 45.0; // 45° difference exceeds 10° threshold
    create_section_with_shots(&app, vec![shot]);
    let warnings = validation::get_project_warnings(state(&app));
    assert!(warnings.iter().any(|w| w.code == "AZIMUTH_DEVIATION"));
}

// === Misc command coverage ===

#[test]
fn test_create_section_with_date_roundtrip() {
    let app = app_with_state();
    create_project(&app);
    let date = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
    let result = section::create_section(
        state(&app),
        Some("Dated".to_string()),
        None,
        Some(date),
        "#4ecdc4".to_string(),
        Some(SurveyDirection::Out),
        vec![shot_data(1.0)],
    );
    assert_success(&result);
    let section = section::get_section(state(&app), result.section_id.unwrap()).unwrap();
    assert_eq!(section.date, Some(date));
    assert_eq!(section.direction, SurveyDirection::Out);
}

#[test]
fn test_create_section_and_merge_fails_without_project() {
    let app = app_with_state();
    let result = section::create_section_and_merge(
        state(&app),
        Some("Imported".to_string()),
        None,
        None,
        "#4ecdc4".to_string(),
        Some(SurveyDirection::In),
        vec![shot_data(1.0)],
        0,
        StationRef::new(0, 0),
        ClosureStrategy::Batch,
    );
    assert_failure_contains(&result, "No project open");
}

#[test]
fn test_create_section_and_merge_success() {
    let app = app_with_state();
    create_project(&app);
    let existing_section_id = create_section_with_shots(&app, vec![shot_data(1.0)]);

    let result = section::create_section_and_merge(
        state(&app),
        Some("Imported".to_string()),
        None,
        None,
        "#4ecdc4".to_string(),
        Some(SurveyDirection::In),
        vec![shot_data(2.0)],
        0,
        StationRef::new(existing_section_id, 0),
        ClosureStrategy::Batch,
    );

    assert_success(&result);
    let new_section_id = result.section_id.expect("new section id");
    let project_state = project::get_project_state(state(&app)).expect("project state");
    assert_eq!(project_state.project.sections.len(), 2);
    assert_eq!(project_state.project.station_merges.len(), 1);

    let merge = &project_state.project.station_merges[0];
    let merged_sections = [merge.station_a.section_id, merge.station_b.section_id];
    assert!(merged_sections.contains(&existing_section_id));
    assert!(merged_sections.contains(&new_section_id));
}

#[test]
fn test_merge_projects_requires_sources() {
    let app = app_with_state();
    let output_dir = TempDir::new().unwrap();
    let output_path = output_dir.path().join("merged.stalx");

    let result = project::merge_projects(
        state(&app),
        Vec::new(),
        output_path,
        "Merged".to_string(),
        false,
    );

    assert_failure_contains(&result, "No source projects provided");
}

#[test]
fn test_merge_projects_requires_two_sources() {
    let app = app_with_state();
    let project = project_with_section(vec![shot_data(1.0)]);
    let (db, _database) = TestDb::with_project(&project).unwrap();
    let output_dir = TempDir::new().unwrap();
    let output_path = output_dir.path().join("merged.stalx");

    let result = project::merge_projects(
        state(&app),
        vec![db.path().to_path_buf()],
        output_path,
        "Merged".to_string(),
        false,
    );

    assert_failure_contains(&result, "At least two projects are required");
}

#[test]
fn test_merge_projects_fails_when_output_exists() {
    let app = app_with_state();
    let project = project_with_section(vec![shot_data(1.0)]);
    let (db_a, _database_a) = TestDb::with_project(&project).unwrap();
    let (db_b, _database_b) = TestDb::with_project(&project).unwrap();
    let output_dir = TempDir::new().unwrap();
    let output_path = output_dir.path().join("merged.stalx");
    fs::write(&output_path, b"exists").unwrap();

    let result = project::merge_projects(
        state(&app),
        vec![db_a.path().to_path_buf(), db_b.path().to_path_buf()],
        output_path,
        "Merged".to_string(),
        false,
    );

    assert_failure_contains(&result, "Output file already exists");
}

#[test]
fn test_merge_projects_success_creates_output() {
    let app = app_with_state();
    let project_a = project_with_section(vec![shot_data(1.0)]);
    let project_b = project_with_section(vec![shot_data(2.0)]);
    let (db_a, _database_a) = TestDb::with_project(&project_a).unwrap();
    let (db_b, _database_b) = TestDb::with_project(&project_b).unwrap();
    let output_dir = TempDir::new().unwrap();
    let output_path = output_dir.path().join("merged.stalx");

    let result = project::merge_projects(
        state(&app),
        vec![db_a.path().to_path_buf(), db_b.path().to_path_buf()],
        output_path.clone(),
        "Merged".to_string(),
        false,
    );

    assert_success(&result);
    assert!(output_path.exists());
}

#[test]
fn test_update_config_persists_and_reload_restores() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let mut cfg = config::get_config(state(&app));
            let original_auto_save = cfg.general.auto_save;
            cfg.general.auto_save = !original_auto_save;
            config::update_config(state(&app), cfg).expect("update config");

            let updated = config::get_config(state(&app));
            assert_eq!(updated.general.auto_save, !original_auto_save);

            let reloaded = config::reload_config(state(&app)).expect("reload config");
            assert_eq!(reloaded.general.auto_save, !original_auto_save);
        });
    });
}

#[test]
fn test_reload_config_syncs_undo_history_limit() {
    with_config_lock(|| {
        let app = app_with_state();
        with_restored_config(&app, || {
            let mut cfg = config::get_config(state(&app));
            cfg.general.undo_history_limit = 42;
            config::update_config(state(&app), cfg).expect("update config");

            let reloaded = config::reload_config(state(&app)).expect("reload config");
            assert_eq!(reloaded.general.undo_history_limit, 42);

            // Verify the in-memory config also reflects the reloaded limit
            let current = config::get_config(state(&app));
            assert_eq!(current.general.undo_history_limit, 42);
        });
    });
}

// === get_segment_geometry ===

#[test]
fn test_get_segment_geometry_no_project_errors() {
    let app = app_with_state();
    let result = section::get_segment_geometry_impl(state(&app).inner(), 0);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("No project open"));
}

#[test]
fn test_get_segment_geometry_invalid_section_errors() {
    let app = app_with_state();
    create_project(&app);
    let result = section::get_segment_geometry_impl(state(&app).inner(), 999);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not found"));
}

#[test]
fn test_get_segment_geometry_single_section() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(5.0), shot_data(3.0)]);

    let geom = section::get_segment_geometry_impl(state(&app).inner(), id).unwrap();
    assert_eq!(geom.sections.len(), 1);
    assert_eq!(geom.sections[0].section_id, id);
    // 2 shots → 2 shot lines (station 0→1, station 1→2)
    assert_eq!(geom.sections[0].shot_lines.len(), 2);
    // First station is the anchor, so first shot line starts at (0, 0)
    let first_line = &geom.sections[0].shot_lines[0];
    assert!((first_line[0][0]).abs() < 1e-6, "First station X should be 0 (anchor)");
    assert!((first_line[0][1]).abs() < 1e-6, "First station Y should be 0 (anchor)");
}

#[test]
fn test_get_segment_geometry_connected_sections() {
    let app = app_with_state();
    create_project(&app);
    let id_a = create_section_with_shots(&app, vec![shot_data(5.0)]);
    let id_b = create_section_with_shots(&app, vec![shot_data(3.0)]);

    // Merge section A station 1 with section B station 0
    assert_success(&station::merge_stations(
        state(&app),
        StationRef::new(id_a, 1),
        StationRef::new(id_b, 0),
    ));

    // Query segment from section A
    let geom = section::get_segment_geometry_impl(state(&app).inner(), id_a).unwrap();
    assert_eq!(geom.sections.len(), 2, "Both connected sections should be in the segment");

    // Both sections should have shot lines
    let section_ids: Vec<u32> = geom.sections.iter().map(|s| s.section_id).collect();
    assert!(section_ids.contains(&id_a));
    assert!(section_ids.contains(&id_b));

    // Section A should have 1 shot line, section B should have 1 shot line
    for s in &geom.sections {
        assert_eq!(s.shot_lines.len(), 1, "Each section has 1 shot → 1 shot line");
    }

    // Coordinates should be relative to section A station 0 (the anchor)
    let sec_a = geom.sections.iter().find(|s| s.section_id == id_a).unwrap();
    assert!((sec_a.shot_lines[0][0][0]).abs() < 1e-6, "Section A starts at anchor origin");
    assert!((sec_a.shot_lines[0][0][1]).abs() < 1e-6, "Section A starts at anchor origin");
}

#[test]
fn test_get_segment_geometry_unconnected_section_excluded() {
    let app = app_with_state();
    create_project(&app);
    let id_a = create_section_with_shots(&app, vec![shot_data(5.0)]);
    let _id_b = create_section_with_shots(&app, vec![shot_data(3.0)]);

    // No merge — sections are disconnected
    let geom = section::get_segment_geometry_impl(state(&app).inner(), id_a).unwrap();
    assert_eq!(geom.sections.len(), 1, "Only the queried section should be returned");
    assert_eq!(geom.sections[0].section_id, id_a);
}

#[test]
fn test_get_segment_geometry_queried_from_either_end() {
    let app = app_with_state();
    create_project(&app);
    let id_a = create_section_with_shots(&app, vec![shot_data(5.0)]);
    let id_b = create_section_with_shots(&app, vec![shot_data(3.0)]);

    assert_success(&station::merge_stations(
        state(&app),
        StationRef::new(id_a, 1),
        StationRef::new(id_b, 0),
    ));

    // Query from section B — should still include both sections
    let geom = section::get_segment_geometry_impl(state(&app).inner(), id_b).unwrap();
    assert_eq!(geom.sections.len(), 2);

    // Coordinates should now be relative to section B station 0
    let sec_b = geom.sections.iter().find(|s| s.section_id == id_b).unwrap();
    assert!((sec_b.shot_lines[0][0][0]).abs() < 1e-6, "Section B starts at anchor origin");
    assert!((sec_b.shot_lines[0][0][1]).abs() < 1e-6, "Section B starts at anchor origin");
}

// === Raw data commands ===

#[test]
fn test_get_raw_table_names_lists_project_tables() {
    let project = project_with_section(vec![shot_data(5.0)]);
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let names = raw_data::get_raw_table_names_impl(state(&app).inner()).unwrap();
    for expected in ["project", "sections", "shots"] {
        assert!(names.iter().any(|n| n == expected), "missing table {expected}");
    }
    assert!(!names.iter().any(|n| n.starts_with("sqlite_")));
}

#[test]
fn test_get_raw_table_row_shape_and_total() {
    let project = project_with_section(vec![shot_data(5.0), shot_data(3.0), shot_data(2.0)]);
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let data =
        raw_data::get_raw_table_impl(state(&app).inner(), "shots".to_string(), 100, 0).unwrap();
    assert!(!data.columns.is_empty());
    assert_eq!(data.total_rows, 3);
    assert_eq!(data.rows.len(), 3);
    for row in &data.rows {
        assert_eq!(row.len(), data.columns.len());
    }
}

#[test]
fn test_get_raw_table_offset_paging() {
    let project = project_with_section(vec![shot_data(5.0), shot_data(3.0), shot_data(2.0)]);
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    let first =
        raw_data::get_raw_table_impl(state(&app).inner(), "shots".to_string(), 2, 0).unwrap();
    let second =
        raw_data::get_raw_table_impl(state(&app).inner(), "shots".to_string(), 2, 2).unwrap();
    assert_eq!(first.rows.len(), 2);
    assert_eq!(second.rows.len(), 1);
    assert_eq!(first.total_rows, 3);
    assert_eq!(second.total_rows, 3);
    assert!(!second.rows.contains(&first.rows[0]));
    assert!(!second.rows.contains(&first.rows[1]));
}

#[test]
fn test_get_raw_table_rejects_injection_names() {
    let project = project_with_section(vec![shot_data(5.0)]);
    let (app_state, _db) = crate::test_helpers::app_state_with_project_db(project).unwrap();
    let app = app_with_custom_state(app_state);

    for name in ["shots; DROP TABLE shots", "sqlite_master"] {
        let err = raw_data::get_raw_table_impl(state(&app).inner(), name.to_string(), 100, 0)
            .unwrap_err();
        assert!(err.contains("Unknown table"), "expected rejection for {name:?}, got: {err}");
    }
}

#[test]
fn test_raw_data_commands_fail_without_db() {
    let app = app_with_state();

    let err = raw_data::get_raw_table_names_impl(state(&app).inner()).unwrap_err();
    assert!(err.contains("save the project"), "got: {err}");

    let err = raw_data::get_raw_table_impl(state(&app).inner(), "shots".to_string(), 100, 0)
        .unwrap_err();
    assert!(err.contains("save the project"), "got: {err}");
}
