//! [#576 B15 follow-up, decision B15-EDIT] A stored project setting the open
//! could not read stops blocking saves once the user sets it again.
//!
//! B15 made every save refuse while a stored setting is unread, so the default
//! standing in for it can never be written over the stored value. Once the user
//! sets that setting themselves in Project Settings, the value in memory is
//! theirs, not a stand-in, and writing it is exactly what they asked for: that
//! key leaves the unreadable list, and when the list is empty saves work again.
//! The default north reference has no control in Project Settings, so it can only
//! clear by reopening the project.
//!
//! All data is synthetic: a project this build saves, then its settings table
//! broken with SQL so the open cannot read it.

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::AppState;
use crate::models::{Project, SectionData, ShotData};
use crate::persistence::Database;

/// A project whose settings table is broken (its `value` column renamed), so the
/// open can read none of `validation`, `surface_elevation` and
/// `default_azimuth_reference`.
fn file_with_unreadable_settings(dir: &Path) -> PathBuf {
    let path = dir.join("CaveB.stalx");
    let mut project = Project::new("CaveB".to_string(), None);
    project.add_section(SectionData {
        name: Some("SectionB".to_string()),
        color: "#654321".to_string(),
        shots: vec![ShotData {
            length: 4.0,
            ..Default::default()
        }],
        ..Default::default()
    });
    project.validation.warn_shot_length_max = 77.0;
    project.surface_elevation = Some(123.0);
    let mut db = Database::open(&path).unwrap();
    db.save_project(&project).unwrap();
    drop(db);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("ALTER TABLE project_settings RENAME COLUMN value TO broken_value;")
        .unwrap();
    path
}

/// Setting the validation thresholds and the entrance elevation again in Project
/// Settings takes each off the unreadable list - also when the value set equals
/// the default in memory (the dialog sends it anyway while it is unread). The
/// north reference, which no control sets, stays, and still refuses the save.
#[test]
fn setting_an_unread_setting_again_takes_it_off_the_list() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().unwrap();
    let path = file_with_unreadable_settings(dir.path());
    let state = AppState::new().unwrap();
    assert!(state.open_project(path).success);
    println!(
        "unreadable after open: {:?}",
        state.unreadable_project_settings()
    );

    let live = state.get_project_state().unwrap();
    let validation = state.update_project_settings(live.name.clone(), live.validation);
    assert!(validation.success, "{:?}", validation.error);
    println!(
        "after Project Settings sets the thresholds: {:?}",
        state.unreadable_project_settings()
    );
    assert!(
        !state
            .unreadable_project_settings()
            .contains(&"validation".to_string()),
        "the thresholds the user set are theirs to save"
    );

    let elevation = state.set_surface_elevation(Some(98.5));
    assert!(elevation.success, "{:?}", elevation.error);
    let left = state.unreadable_project_settings();
    println!("after Project Settings sets the elevation: {left:?}");
    assert_eq!(left, vec!["default_azimuth_reference".to_string()]);

    let refused = state.save_project(None);
    println!(
        "save: success={} error={:?}",
        refused.success, refused.error
    );
    assert!(!refused.success, "the north reference is still unread");
    assert!(
        refused
            .error
            .unwrap_or_default()
            .contains("default north reference could not be read"),
        "and the refusal names only what is still unread"
    );
}

/// When every unread setting has been set again, saving works again: the values
/// the user set are what the file now gets.
#[test]
fn once_nothing_is_unread_the_save_goes_through() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("CaveC.stalx");
    let mut db = Database::open(&path).unwrap();
    db.save_project(&Project::new("CaveC".to_string(), None))
        .unwrap();
    drop(db);
    let state = AppState::new().unwrap();
    assert!(state.open_project(path.clone()).success);
    // What a load that could not read the elevation commits.
    state.set_unreadable_project_settings(vec!["surface_elevation".to_string()]);
    assert!(
        !state.save_project(None).success,
        "premise: refused while unread"
    );

    assert!(state.set_surface_elevation(Some(12.0)).success);
    let saved = state.save_project(None);
    println!("save: success={} error={:?}", saved.success, saved.error);
    assert!(saved.success, "{:?}", saved.error);
    let stored = Database::open_existing(&path)
        .unwrap()
        .load_project_surface_elevation()
        .unwrap();
    assert_eq!(stored, Some(12.0));
}
