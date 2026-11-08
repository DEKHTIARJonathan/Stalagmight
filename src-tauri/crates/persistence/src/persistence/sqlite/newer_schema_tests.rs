//! [#649] Every opener refuses a `.stalx` a newer schema saved, and leaves it
//! byte-for-byte as it was.
//!
//! All data is synthetic: a project built in memory, saved by this build, then
//! re-stamped as if a newer build had written it. No fixture is read or written.

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::{Database, NewerSchema, SCHEMA_VERSION};
use crate::models::Project;

/// How a file claims its version: the stamp, or (files from before the pragma)
/// the project row with the stamp left at 0.
#[derive(Clone, Copy)]
enum Claim {
    Stamp,
    ProjectRow,
}

/// A `.stalx` that claims `SCHEMA_VERSION + 1`, with one undo row so a history
/// cleanup on open would show in its bytes.
fn newer_file(dir: &TempDir, name: &str, claim: Claim) -> PathBuf {
    let path = dir.path().join(name);
    let mut db = Database::open(&path).unwrap();
    db.save_project(&Project::new("Newer".to_string(), None))
        .unwrap();
    db.save_undo_stack_with_timestamps(vec![(
        r#"{"type":"close_project"}"#.to_string(),
        r#"{"InverseCommand":{"type":"close_project"}}"#.to_string(),
        None,
    )])
    .unwrap();
    match claim {
        Claim::Stamp => db.set_user_version(SCHEMA_VERSION + 1).unwrap(),
        Claim::ProjectRow => {
            db.conn
                .execute(
                    "UPDATE project SET schema_version = ?1",
                    [SCHEMA_VERSION + 1],
                )
                .unwrap();
            db.set_user_version(0).unwrap();
        }
    }
    drop(db);
    path
}

fn assert_refused_as_newer(result: anyhow::Result<Database>, file: &str, what: &str) {
    let Err(err) = result else {
        panic!("{what}: a file from a newer schema must be refused");
    };
    let newer = err
        .chain()
        .find_map(|cause| cause.downcast_ref::<NewerSchema>())
        .unwrap_or_else(|| panic!("{what}: refused for the wrong reason: {err:#}"));
    assert_eq!(
        *newer,
        NewerSchema {
            file: file.to_string(),
            found: SCHEMA_VERSION + 1,
            supported: SCHEMA_VERSION,
        },
        "{what}"
    );
}

fn bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

#[test]
fn every_project_opener_refuses_a_newer_file_and_leaves_it_unchanged() {
    for claim in [Claim::Stamp, Claim::ProjectRow] {
        let dir = TempDir::new().unwrap();
        let path = newer_file(&dir, "newer.stalx", claim);
        let before = bytes(&path);

        let name = "newer.stalx";
        assert_refused_as_newer(Database::open(&path), name, "open");
        assert_refused_as_newer(Database::open_existing(&path), name, "open_existing");
        assert_refused_as_newer(
            Database::open_existing_untrusted(&path, 1 << 20, std::time::Duration::from_secs(5)),
            name,
            "open_existing_untrusted",
        );
        assert_refused_as_newer(Database::open_readonly(&path), name, "open_readonly");

        assert_eq!(bytes(&path), before, "a refused open wrote into the file");
        // The history cleanup the open used to run is the write most likely to
        // land; read it back on a connection that runs no migration.
        let db = Database::open_for_metadata(&path).unwrap();
        assert_eq!(db.load_undo_stack_with_timestamps().unwrap().len(), 1);
    }
}

/// The recents list reads metadata through `open_for_metadata`, which must keep
/// working so a newer project stays listed; opening it is what refuses.
#[test]
fn a_newer_file_still_reads_for_the_recents_list() {
    let dir = TempDir::new().unwrap();
    let path = newer_file(&dir, "listed.stalx", Claim::Stamp);
    let before = bytes(&path);

    let meta = Database::open_for_metadata(&path)
        .unwrap()
        .load_metadata(path.clone())
        .unwrap();
    assert_eq!(meta.name, "Newer");
    assert_eq!(bytes(&path), before);
}

#[test]
fn a_current_file_still_opens() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("current.stalx");
    {
        let mut db = Database::open(&path).unwrap();
        db.save_project(&Project::new("Current".to_string(), None))
            .unwrap();
    }
    Database::check_not_newer_at(&path).unwrap();
    assert_eq!(
        Database::open_existing(&path)
            .unwrap()
            .load_project()
            .unwrap()
            .name,
        "Current"
    );
}

#[test]
fn the_path_check_refuses_only_a_newer_file() {
    let dir = TempDir::new().unwrap();
    for claim in [Claim::Stamp, Claim::ProjectRow] {
        let path = newer_file(&dir, "check.stalx", claim);
        let before = bytes(&path);
        let err = Database::check_not_newer_at(&path).unwrap_err();
        let newer = err.downcast_ref::<NewerSchema>().unwrap();
        assert_eq!(newer.file, "check.stalx");
        assert_eq!(newer.found, SCHEMA_VERSION + 1);
        assert_eq!(bytes(&path), before);
        std::fs::remove_file(&path).unwrap();
    }

    // Not this refusal: the caller's own path reports these.
    let garbage = dir.path().join("garbage.stalx");
    std::fs::write(&garbage, b"not a database at all").unwrap();
    Database::check_not_newer_at(&garbage).unwrap();
    Database::check_not_newer_at(&dir.path().join("missing.stalx")).unwrap();
}

#[test]
fn repair_refuses_a_newer_file_before_it_backs_up_or_rewrites_it() {
    let dir = TempDir::new().unwrap();
    let path = newer_file(&dir, "repair.stalx", Claim::Stamp);
    let before = bytes(&path);

    let err = Database::attempt_repair(&path).unwrap_err();

    assert!(err.downcast_ref::<NewerSchema>().is_some(), "{err:#}");
    assert_eq!(bytes(&path), before, "the repair's VACUUM must not run");
    assert!(
        !path.with_extension("stalx.backup").exists(),
        "nothing to back up when nothing is repaired"
    );
}

/// `ensure_schema_version` holds the same rule on its own, so a caller that
/// reaches it without going through an opener cannot migrate the file either.
#[test]
fn the_migration_chain_refuses_a_newer_file_on_its_own() {
    for claim in [Claim::Stamp, Claim::ProjectRow] {
        let dir = TempDir::new().unwrap();
        let path = newer_file(&dir, "chain.stalx", claim);
        let before = bytes(&path);
        let mut db = Database {
            conn: rusqlite::Connection::open(&path).unwrap(),
        };

        let err = db.ensure_schema_version().unwrap_err();

        assert_eq!(
            err.downcast_ref::<NewerSchema>().map(|n| n.file.as_str()),
            Some("chain.stalx"),
            "{err:#}"
        );
        drop(db);
        assert_eq!(bytes(&path), before);
    }
}
