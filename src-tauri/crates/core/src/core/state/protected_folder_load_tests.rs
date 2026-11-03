//! [#576 RV4-R-M3-OPEN] What a load does with a location's upgrade refusal.
//!
//! The load commands work out whether a project sits where nothing may be written
//! (the app's own folders, a system folder: `commands::write_path`) and hand the
//! refusal to the load. A file this build reads as it is opens exactly as it would
//! anywhere and is not written; an older-format file - one the open would upgrade
//! in place, keeping a backup copy beside it first - is refused before the first
//! write, with its own code and the refusal as the message, and left as it was.
//!
//! All data is synthetic: a project built in memory, saved by this build, then
//! re-stamped as an older file. No fixture is read or written.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;

use super::AppState;
use crate::models::{CommandErrorCode, Project, SectionData, ShotData};
use crate::persistence::{Database, UpgradeRefusal};

const REFUSAL: &str = "CaveL.stalx was saved by an older version of Stalagmight (test refusal). \
                       Copy the project to a folder of your own and open the copy.";
/// [#576 RV6b-R3] The message for an unstamped file the open would complete.
const UNSTAMPED_REFUSAL: &str = "CaveL.stalx has no file-format version stamp (test refusal). \
                                 Copy the project to a folder of your own and open the copy.";

/// What the load commands hand the load for a protected folder.
fn refusal() -> UpgradeRefusal {
    UpgradeRefusal {
        older_format: REFUSAL.to_owned(),
        unstamped: UNSTAMPED_REFUSAL.to_owned(),
    }
}

const OLDER_FORMAT: &str = "UPDATE project SET schema_version = 16; PRAGMA user_version = 16;";

/// `do_load_project_full_with` reports progress through the installed sink;
/// nobody is listening here.
struct NoListener;

impl crate::core::events::EventSink for NoListener {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}

    fn with_app_state(&self, _f: Box<dyn FnOnce(&AppState) + Send>) -> bool {
        false
    }
}

fn state_with_sink() -> AppState {
    let state = AppState::new().expect("state");
    state.set_event_sink(Arc::new(NoListener));
    state
}

/// A current project file with one section of two shots, then re-stamped by
/// `surgery` (empty: left current).
fn write_project(dir: &Path, surgery: &str) -> PathBuf {
    let path = dir.join("CaveL.stalx");
    let mut project = Project::new("CaveL".to_owned(), None);
    project.add_section(SectionData {
        name: Some("SectionA".to_owned()),
        color: "#123456".to_owned(),
        shots: vec![
            ShotData {
                length: 5.0,
                ..Default::default()
            },
            ShotData {
                length: 7.0,
                ..Default::default()
            },
        ],
        ..Default::default()
    });
    Database::open(&path)
        .expect("create")
        .save_project(&project)
        .expect("write");
    if !surgery.is_empty() {
        rusqlite::Connection::open(&path)
            .expect("reopen")
            .execute_batch(surgery)
            .expect("re-stamp");
    }
    path
}

/// The files in `dir`, by name (a backup copy or a journal would show up here).
fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("list")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

#[test]
fn a_current_project_where_nothing_may_be_written_opens_and_is_not_written() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().expect("dir");
    let path = write_project(dir.path(), "");
    let before = std::fs::read(&path).expect("read");

    let state = state_with_sink();
    let loaded = state.do_load_project_full_with(path.clone(), Some(&refusal()));
    let after = std::fs::read(&path).expect("read");
    println!(
        "current-format project, upgrade refused here: opened={} shots={:?}; file unchanged: {}; folder: {:?}",
        loaded.is_ok(),
        loaded
            .as_ref()
            .ok()
            .and_then(|l| l.project.sections.first())
            .map(|s| s.shots.len()),
        after == before,
        files_in(dir.path())
    );
    let loaded = loaded.unwrap_or_else(|e| panic!("it must open: {} {}", e.code, e.message));
    assert_eq!(loaded.project.sections[0].shots.len(), 2);
    assert!(state.get_project_state().is_some(), "the project is open");
    assert_eq!(after, before, "opening it wrote nothing");
    assert_eq!(files_in(dir.path()), ["CaveL.stalx"]);
}

#[test]
fn an_older_project_where_nothing_may_be_written_is_refused_untouched() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().expect("dir");
    let path = write_project(dir.path(), OLDER_FORMAT);
    let before = std::fs::read(&path).expect("read");

    let state = state_with_sink();
    let Err(error) = state.do_load_project_full_with(path.clone(), Some(&refusal())) else {
        panic!("an older file must not be upgraded there");
    };
    let after = std::fs::read(&path).expect("read");
    println!(
        "older-format project, upgrade refused here: code={} message={:?}; file unchanged: {}; folder: {:?}",
        error.code,
        error.message,
        after == before,
        files_in(dir.path())
    );
    assert_eq!(error.code, CommandErrorCode::UpgradeRefused);
    assert_eq!(
        error.message, REFUSAL,
        "shown as-is, so the message carries no code prefix"
    );
    assert!(
        state.get_project_state().is_none(),
        "a refused open leaves no project"
    );
    assert_eq!(after, before, "the file is left as it was");
    assert_eq!(
        files_in(dir.path()),
        ["CaveL.stalx"],
        "and no backup copy beside it"
    );
}

#[test]
fn without_a_refusal_the_same_older_project_is_upgraded_as_before() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().expect("dir");
    let path = write_project(dir.path(), OLDER_FORMAT);

    let state = state_with_sink();
    let loaded = state.do_load_project_full_with(path, None);
    println!(
        "older-format project in a user folder: opened={}; folder: {:?}",
        loaded.is_ok(),
        files_in(dir.path())
    );
    assert!(loaded.is_ok(), "it opens, upgraded");
    assert!(
        files_in(dir.path()).contains(&"CaveL.stalx.pre-v16.backup".to_owned()),
        "with its pre-upgrade copy"
    );
}

/// [#576 RV6b-R3] No file-format stamp, but a project row claiming this build's
/// version: the open would only complete the tables in place (no backup copy, no
/// stamp), so the user is not told the file is an older one.
const UNSTAMPED: &str = "PRAGMA user_version = 0;";

#[test]
fn an_unstamped_project_where_nothing_may_be_written_is_not_called_older() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().expect("dir");
    let path = write_project(dir.path(), UNSTAMPED);
    let before = std::fs::read(&path).expect("read");

    let state = state_with_sink();
    let Err(error) = state.do_load_project_full_with(path.clone(), Some(&refusal())) else {
        panic!("an unstamped file is not completed in place there either");
    };
    let after = std::fs::read(&path).expect("read");
    println!(
        "unstamped project claiming the current version, upgrade refused here: code={} \
         message={:?}; file unchanged: {}; folder: {:?}",
        error.code,
        error.message,
        after == before,
        files_in(dir.path())
    );
    assert_eq!(error.code, CommandErrorCode::UpgradeRefused);
    assert!(
        !error.message.contains("older version") && !error.message.contains("backup"),
        "the message must not call the file older or promise a backup: {:?}",
        error.message
    );
    assert_eq!(error.message, UNSTAMPED_REFUSAL, "shown as-is");
    assert_eq!(after, before, "the file is left as it was");
    assert_eq!(files_in(dir.path()), ["CaveL.stalx"]);
}
