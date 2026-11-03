//! [#576 RV6b-2] A display setting lands in the project it was made for, or nowhere.
//!
//! Grid spacing, the geometry mode and the display toggles are per project:
//! `save_display_setting` writes into whichever project database is open when the
//! command runs. The frontend now queues same-key writes (the setting write
//! chain), so a burst of toggles in project A followed by opening project B could
//! execute A's queued writes after B opened: they landed in B's file, invisible
//! this session and shown on B's next open. The command now carries the identity
//! of the project the write was made for (`created_at`, in the RFC 3339 form the
//! frontend holds it in) and refuses a write for another project with
//! `PROJECT_CHANGED`.
//!
//! All data is synthetic.

use std::path::Path;

use tempfile::TempDir;

use super::AppState;
use crate::core::{Command, CommandErrorCode};
use crate::models::Project;
use crate::persistence::Database;
use crate::test_fixtures::state_with_project;

/// The identity the frontend holds for `project`: its `created_at` as the wire
/// carries it.
fn wire_identity(project: &Project) -> String {
    serde_json::to_value(project.created_at)
        .expect("serialize created_at")
        .as_str()
        .expect("created_at is a string on the wire")
        .to_string()
}

/// A saved project at `path`, open in `state` with its database.
fn open_saved(state: &AppState, path: &Path, name: &str, created: &str) -> Project {
    let mut project = Project::new(name.to_string(), None);
    project.created_at = created.parse().expect("timestamp");
    let mut db = Database::open(path).expect("create");
    db.save_project(&project).expect("write");
    drop(db);
    state.set_project_for_tests(project.clone());
    state.set_database_for_tests(Database::open_existing(path).expect("reopen"));
    project
}

#[test]
fn a_write_made_for_the_previous_project_does_not_land_in_the_one_now_open() {
    let temp = TempDir::new().expect("temp dir");
    let state = AppState::new().expect("state");
    let path_a = temp.path().join("CaveA.stalx");
    let path_b = temp.path().join("CaveB.stalx");
    let a = open_saved(&state, &path_a, "CaveA", "2026-01-01T10:00:00.123456789Z");
    let made_for_a = wire_identity(&a);
    // The user opens B while A's write is still queued.
    let b = open_saved(&state, &path_b, "CaveB", "2026-02-02T10:00:00Z");

    let late = state.save_display_setting_for(Some(&made_for_a), "gridSpacing", "50");
    let landed_in_b = Database::open_readonly(&path_b)
        .expect("open B")
        .get_display_setting("gridSpacing")
        .expect("read B");
    println!(
        "[RV6b-2] A's queued write after B opened: answer={:?}; B's gridSpacing={landed_in_b:?} (expected None)",
        late.as_ref().map_err(|e| e.code)
    );

    assert_eq!(
        late.map_err(|e| e.code),
        Err(CommandErrorCode::ProjectChanged)
    );
    assert_eq!(landed_in_b, None);

    // B's own write still lands.
    state
        .save_display_setting_for(Some(&wire_identity(&b)), "gridSpacing", "10")
        .expect("B's write");
    let own = Database::open_readonly(&path_b)
        .expect("open B")
        .get_display_setting("gridSpacing")
        .expect("read B");
    assert_eq!(own.as_deref(), Some("10"));
}

#[test]
fn a_write_for_the_open_unsaved_project_lands_in_its_cache() {
    let state = state_with_project("CaveA");
    let project = state.get_project_state().expect("open project");

    state
        .save_display_setting_for(Some(&wire_identity(&project)), "showStations", "false")
        .expect("write");
    assert_eq!(
        state
            .get_display_setting("showStations")
            .expect("read")
            .as_deref(),
        Some("false")
    );
}

#[test]
fn a_write_without_a_project_lands_only_while_none_is_open() {
    let state = AppState::new().expect("state");
    state
        .save_display_setting_for(None, "showStations", "false")
        .expect("no project on either side");

    state.execute(Command::CreateProject {
        name: "CaveA".to_string(),
        location: None,
    });
    let refused = state.save_display_setting_for(None, "showShots", "false");
    assert_eq!(
        refused.map_err(|e| e.code),
        Err(CommandErrorCode::ProjectChanged)
    );
    assert_eq!(state.get_display_setting("showShots").expect("read"), None);
}

#[test]
fn a_write_for_a_closed_project_or_an_unreadable_identity_is_refused() {
    let state = AppState::new().expect("state");
    let closed = state.save_display_setting_for(Some("2026-01-01T10:00:00Z"), "k", "v");
    assert_eq!(
        closed.map_err(|e| e.code),
        Err(CommandErrorCode::ProjectChanged)
    );

    state.execute(Command::CreateProject {
        name: "CaveA".to_string(),
        location: None,
    });
    let garbled = state.save_display_setting_for(Some("not a timestamp"), "k", "v");
    assert_eq!(
        garbled.map_err(|e| e.code),
        Err(CommandErrorCode::ProjectChanged)
    );
    assert_eq!(state.get_display_setting("k").expect("read"), None);
}
