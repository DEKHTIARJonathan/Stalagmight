//! [#576 NF-W2SAVE-1] Done and Push carry the warnings of the save they run first.
//!
//! Done and Push save the live file in place before taking the upload snapshot
//! (`speleodb_flush_before_push`). A save that goes through can still have lost
//! something - the display settings, the undo history - and says so in its
//! warnings, which a normal save shows the user. The pre-push save only logged
//! them, and those warnings are one-shot: the next save does not repeat them. The
//! flush now hands them back so the Done / Push answer can carry them.
//!
//! The flush is driven directly: Done and Push reach it only after the cache-dir
//! check that only the env-gated live tests can pass. All data is synthetic.

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::AppState;
use crate::models::{Project, SectionData, ShotData};
use crate::persistence::Database;

/// A project whose display-settings table the save cannot read, so a save goes
/// through without it and says so (`DISPLAY_SETTINGS_NOT_SAVED`).
fn file_with_unreadable_display_settings(dir: &Path) -> PathBuf {
    let path = dir.join("CaveF.stalx");
    let mut project = Project::new("CaveF".to_string(), None);
    project.add_section(SectionData {
        name: Some("SectionF".to_string()),
        shots: vec![ShotData {
            length: 4.0,
            ..Default::default()
        }],
        ..Default::default()
    });
    let mut db = Database::open(&path).expect("create the fixture");
    db.save_project(&project).expect("save the fixture");
    drop(db);
    path
}

fn break_display_settings(path: &Path) {
    rusqlite::Connection::open(path)
        .expect("open the fixture directly")
        .execute_batch("ALTER TABLE display_settings RENAME COLUMN value TO broken_value;")
        .expect("break the display settings table");
}

#[test]
fn the_pre_push_save_hands_back_its_warnings() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().expect("tempdir");
    let path = file_with_unreadable_display_settings(dir.path());
    let state = AppState::new().expect("state");
    assert!(state.open_project(path.clone()).success);
    break_display_settings(&path);

    let warnings = state
        .speleodb_flush_before_push()
        .expect("the save goes ahead without the display settings");

    let codes: Vec<&str> = warnings.iter().map(|w| w.code.as_str()).collect();
    println!("the pre-push save's warnings: {codes:?}");
    assert!(
        codes.contains(&"DISPLAY_SETTINGS_NOT_SAVED"),
        "the lost display settings reach the push answer, got {codes:?}"
    );
}
