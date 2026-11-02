//! [#576 NF-PNEWER-1] `Database::open` decides what a file is BEFORE it writes
//! to it. It used to run `init_schema` (CREATE TABLE IF NOT EXISTS for every
//! table this build knows) on an existing file first, so a file a newer build
//! wrote gained the tables this build knows and the newer schema dropped, and
//! a pre-release file was refused only after its missing tables were
//! recreated in it.
//!
//! All files are synthetic projects this build writes, then reshaped with raw
//! SQL. No fixture is read.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tempfile::TempDir;

use super::{Database, SCHEMA_VERSION};
use crate::models::Project;

/// A current project file at `dir/name`, then reshaped by `surgery`.
fn reshaped_file(dir: &Path, name: &str, surgery: &str) -> PathBuf {
    let path = dir.join(name);
    let mut db = Database::open(&path).unwrap();
    db.save_project(&Project::new("CaveA".to_string(), None))
        .unwrap();
    drop(db);
    Connection::open(&path)
        .unwrap()
        .execute_batch(surgery)
        .unwrap();
    path
}

fn has_table(path: &Path, table: &str) -> bool {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
        > 0
}

/// A file a NEWER build wrote, without a table this build knows (the newer
/// schema dropped it), comes through `Database::open` exactly as it was.
#[test]
fn database_open_leaves_a_newer_file_untouched() {
    let temp = TempDir::new().unwrap();
    let newer = SCHEMA_VERSION + 1;
    let path = reshaped_file(
        temp.path(),
        "CaveA.stalx",
        &format!(
            "DROP TABLE station_comments; UPDATE project SET schema_version = {newer}; \
             PRAGMA user_version = {newer};"
        ),
    );
    let before = std::fs::read(&path).unwrap();

    let opened = Database::open(&path).map(drop);
    let unchanged = std::fs::read(&path).unwrap() == before;
    let recreated = has_table(&path, "station_comments");
    println!(
        "Database::open(newer file) -> {opened:?}; file unchanged: {unchanged}; \
         station_comments recreated: {recreated}"
    );
    assert!(opened.is_ok(), "{opened:?}");
    assert!(
        !recreated,
        "no table this build knows may be added to a newer file"
    );
    assert!(
        unchanged,
        "a newer file must be left byte-for-byte as it was"
    );
}

/// A pre-release file is refused before anything is written to it, on this
/// path too (docs/saving.md: "refused before anything is written to it").
#[test]
fn database_open_refuses_a_pre_release_file_before_writing_to_it() {
    let temp = TempDir::new().unwrap();
    let path = reshaped_file(
        temp.path(),
        "CaveA.stalx",
        "DROP TABLE station_comments; UPDATE project SET schema_version = 1; \
         PRAGMA user_version = 0;",
    );
    let before = std::fs::read(&path).unwrap();

    let message = Database::open(&path)
        .err()
        .map(|e| format!("{e:#}"))
        .unwrap_or_default();
    let unchanged = std::fs::read(&path).unwrap() == before;
    let recreated = has_table(&path, "station_comments");
    println!(
        "Database::open(pre-release file) -> {message}; file unchanged: {unchanged}; \
         station_comments recreated: {recreated}"
    );
    assert!(message.contains(super::PRE_RELEASE_FILE_CODE), "{message}");
    assert!(!recreated, "a refused file gains no tables");
    assert!(
        unchanged,
        "a refused file must be left byte-for-byte as it was"
    );
}
