//! Command wrapper tests focused on critical/edge behaviors.

use super::{cache, config, export, history, import, project, section, shot, station, validation};
use crate::core::{AppState, CommandResult};
use crate::models::{
    ClosureStrategy, Coordinates, GpsCoordinates, Project, SectionData, SectionUpdates, ShotData,
    ShotUpdates, StationRef, SurveyDirection,
};
use crate::test_helpers::TestDb;
use chrono::NaiveDate;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
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

fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn with_config_lock<T>(f: impl FnOnce() -> T) -> T {
    let _guard = config_lock().lock().expect("config lock");
    f()
}

fn with_restored_config<T>(app: &tauri::App<MockRuntime>, f: impl FnOnce() -> T) -> T {
    let original = config::get_config(state(app));
    let result = f();
    config::update_config(state(app), original).expect("restore config");
    result
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
    let result = project::save_project(state(app), Some(path.clone()));
    assert_success(&result);
    path.with_extension("stalx")
}

// === Config commands ===

#[test]
fn test_get_config_defaults_general_auto_save() {
    let app = app_with_state();
    let cfg = config::get_config(state(&app));
    assert!(cfg.general.auto_save);
    assert_eq!(cfg.general.auto_save_interval_seconds, 30);
}

#[test]
fn test_get_config_defaults_panels() {
    // Test the actual defaults, not user config which may differ
    let cfg = crate::config::Config::default();
    assert_eq!(cfg.panels.sections_panel_width, 250);
    assert_eq!(cfg.panels.detail_panel_width, 300);
    assert_eq!(cfg.panels.data_table_height, 200);
}

#[test]
fn test_get_config_defaults_validation() {
    let app = app_with_state();
    let cfg = config::get_config(state(&app));
    assert_eq!(cfg.validation.warn_shot_length_min, 0.1);
    assert_eq!(cfg.validation.warn_shot_length_max, 50.0);
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
    let result = project::save_project(state(&app), Some(PathBuf::from("/tmp/nope.stalx")));
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
        let result = project::save_project(state(&app), Some(raw_path));
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
        let result = project::open_project(state(&app2), saved_path.clone());
        assert_success(&result);
        let project_state = project::get_project_state(state(&app2)).expect("project state");
        assert_eq!(project_state.project.name, "Test Cave");
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
fn test_set_shot_virtual_fails_missing() {
    let app = app_with_state();
    create_project(&app);
    let result = shot::set_shot_virtual(state(&app), 0, 999, true);
    assert_failure_contains(&result, "not found");
}

#[test]
fn test_set_shot_virtual_sets_true() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let result = shot::set_shot_virtual(state(&app), id, 0, true);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert!(section.shots[0].is_virtual);
}

#[test]
fn test_set_shot_virtual_sets_false() {
    let app = app_with_state();
    create_project(&app);
    let id = create_section_with_shots(&app, vec![shot_data(1.0)]);
    let _ = shot::set_shot_virtual(state(&app), id, 0, true);
    let result = shot::set_shot_virtual(state(&app), id, 0, false);
    assert_success(&result);
    let section = section::get_section(state(&app), id).unwrap();
    assert!(!section.shots[0].is_virtual);
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
    std::fs::write(file.path(), b"abc").unwrap();
    let hash = import::calculate_file_hash(file.path().to_path_buf()).unwrap();
    assert_eq!(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

#[test]
fn test_calculate_file_hash_known_linebreak() {
    let file = NamedTempFile::new().unwrap();
    std::fs::write(file.path(), b"line1\n").unwrap();
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

#[test]
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
        warning.code.clone(),
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
    std::fs::write(&output_path, b"exists").unwrap();

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
