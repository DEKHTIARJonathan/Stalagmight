//! [#649] The app's own paths into a project refuse a `.stalx` a newer schema
//! saved, leave it byte-for-byte as it was, and change no session state.
//!
//! All data is synthetic: projects built in memory, saved by this build, then
//! re-stamped as if a newer build had written them. No fixture is read or
//! written.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;

use super::AppState;
use crate::core::events::EventSink;
use crate::models::Project;
use crate::persistence::{Database, SCHEMA_VERSION};

/// The load needs a sink for its progress events; nothing listens here.
struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}

    fn with_app_state(&self, _f: Box<dyn FnOnce(&AppState) + Send>) -> bool {
        false
    }
}

/// A saved project at `dir/name`, stamped `version`.
fn project_file(dir: &TempDir, name: &str, version: i32) -> PathBuf {
    let path = dir.path().join(name);
    {
        let mut db = Database::open(&path).unwrap();
        db.save_project(&Project::new(name.to_string(), None))
            .unwrap();
    }
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", version).unwrap();
    path
}

fn bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

#[test]
fn the_load_refuses_a_newer_project_with_its_own_code() {
    let dir = TempDir::new().unwrap();
    let path = project_file(&dir, "newer.stalx", SCHEMA_VERSION + 1);
    let before = bytes(&path);
    let state = AppState::new().unwrap();
    state.set_event_sink(Arc::new(NullSink));

    let Err(err) = state.do_load_project_full(path.clone()) else {
        panic!("a project from a newer schema must not load");
    };

    assert_eq!(err.code, "NEWER_SCHEMA", "{}", err.message);
    assert!(
        err.message.contains("newer version of Stalagmight")
            && err.message.contains("Update Stalagmight"),
        "{}",
        err.message
    );
    assert_eq!(
        err.details.as_deref(),
        Some(path.display().to_string().as_str())
    );
    assert_eq!(bytes(&path), before);
    assert!(
        state.project.lock().unwrap().is_none(),
        "no project was installed"
    );
    assert!(
        state.database.lock().unwrap().is_none(),
        "no database was installed"
    );
}

/// The legacy open (the cache replace's recovery reopen) refuses it too, and
/// names the remedy in its message.
#[test]
fn the_legacy_open_refuses_a_newer_project() {
    let dir = TempDir::new().unwrap();
    let path = project_file(&dir, "legacy.stalx", SCHEMA_VERSION + 1);
    let before = bytes(&path);
    let state = AppState::new().unwrap();

    let result = state.open_project(path.clone());

    assert!(!result.success);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|e| e.contains("update Stalagmight to open it")),
        "{:?}",
        result.error
    );
    assert_eq!(bytes(&path), before);
    assert!(state.project.lock().unwrap().is_none());
}

#[test]
fn a_merge_with_a_newer_source_writes_nothing() {
    let dir = TempDir::new().unwrap();
    let current = project_file(&dir, "current.stalx", SCHEMA_VERSION);
    let newer = project_file(&dir, "newer.stalx", SCHEMA_VERSION + 1);
    let (current_before, newer_before) = (bytes(&current), bytes(&newer));
    let output = dir.path().join("merged.stalx");
    let state = AppState::new().unwrap();

    let result = state.merge_projects(
        vec![current.clone(), newer.clone()],
        output.clone(),
        "Merged".to_string(),
        true,
    );

    assert!(!result.success);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|e| e.contains("newer version of Stalagmight")),
        "{:?}",
        result.error
    );
    assert!(!output.exists(), "no merged file");
    assert!(!output.with_extension("stalx.tmp").exists(), "no temp file");
    // `archive_originals` must not have moved either source.
    assert_eq!(bytes(&current), current_before);
    assert_eq!(bytes(&newer), newer_before);
}

/// Renaming a project from the Recents panel writes into the file by path.
#[test]
fn renaming_a_newer_project_by_path_writes_nothing() {
    let dir = TempDir::new().unwrap();
    let path = project_file(&dir, "rename.stalx", SCHEMA_VERSION + 1);
    let before = bytes(&path);
    let state = AppState::new().unwrap();

    let result = state.set_project_name_for_path(path.clone(), "Renamed".to_string());

    assert!(!result.success, "{result:?}");
    assert_eq!(bytes(&path), before);
}
