//! [#576 C15, NF-AN2-7] The recovery dialog's backend: which files it offers,
//! how it checks them, and how a restore installs one.
//!
//! All files are synthetic projects this build writes, some frozen mid-write
//! with raw SQL to produce a hot rollback journal. No fixture is read.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use tempfile::TempDir;

use super::{BackupInfo, BackupKind, Database};
use crate::models::Project;

/// A valid project file named `name` at `path`.
fn project_file(path: &Path, name: &str) {
    let mut db = Database::open(path).unwrap();
    db.save_project(&Project::new(name.to_string(), None))
        .unwrap();
}

/// The project name in `path` through the ordinary open path, or why it failed.
fn project_name(path: &Path) -> String {
    Database::open_existing(path)
        .and_then(|db| db.load_project())
        .map_or_else(|e| format!("<unreadable: {e:#}>"), |p| p.name)
}

fn journal_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap().to_os_string();
    name.push("-journal");
    path.with_file_name(name)
}

/// Copy `src` to `dest` frozen in the middle of a write: the main file already
/// holds pages a transaction spilled (the project renamed to "Torn", plus
/// filler), and `dest`'s hot rollback journal holds what undoes them. Opened
/// normally the copy rolls back to `src`'s committed state; read without the
/// journal it is torn (renamed, or outright malformed).
fn torn_copy(src: &Path, dest: &Path) {
    let conn = Connection::open(src).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode = DELETE;
         PRAGMA cache_size = 10;
         BEGIN;
         UPDATE project SET name = 'Torn';
         CREATE TABLE filler (x BLOB);",
    )
    .unwrap();
    for _ in 0..300 {
        conn.execute("INSERT INTO filler VALUES (randomblob(4000))", [])
            .unwrap();
    }
    std::fs::copy(src, dest).unwrap();
    std::fs::copy(journal_of(src), journal_of(dest)).unwrap();
    conn.execute_batch("ROLLBACK;").unwrap();
}

/// What `path`'s main file says WITHOUT its journal (SQLite's `immutable` mode
/// ignores it): the torn state an interrupted write left on disk.
fn name_ignoring_the_journal(path: &Path) -> String {
    let uri = format!("file:{}?immutable=1", path.display());
    let conn = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap();
    conn.query_row("SELECT name FROM project LIMIT 1", [], |r| r.get(0))
        .unwrap_or_else(|e| format!("<unreadable: {e}>"))
}

fn listed<'a>(list: &'a [BackupInfo], file: &str) -> Option<&'a BackupInfo> {
    list.iter()
        .find(|b| Path::new(&b.path).file_name().unwrap().to_string_lossy() == file)
}

/// [#576 C15, NF-AN2-7] An interrupted save's `.tmp` is restored WITH its
/// rollback journal - checked and installed as its last committed state - and
/// both stay exactly as they were. Copying the `.tmp` alone installed the torn
/// pages the interrupted write had already spilled into it.
#[test]
fn an_interrupted_save_is_restored_with_its_journal_as_committed() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "Original");
    let committed = temp.path().join("work.stalx");
    project_file(&committed, "Committed");
    let interrupted = temp.path().join("CaveA.stalx.tmp");
    torn_copy(&committed, &interrupted);
    let torn = name_ignoring_the_journal(&interrupted);
    println!("the .tmp without its journal reads: {torn}");
    assert_ne!(
        torn, "Committed",
        "premise: without its journal the .tmp is torn"
    );
    let tmp_before = std::fs::read(&interrupted).unwrap();
    let journal_before = std::fs::read(journal_of(&interrupted)).unwrap();

    let outcome = Database::restore_from_backup(&project, &interrupted);
    println!(
        "restore -> {:?}",
        outcome.as_ref().map_err(|e| format!("{e:#}"))
    );
    outcome.unwrap();
    let restored = project_name(&project);
    println!("project now holds: {restored}");
    assert_eq!(
        restored, "Committed",
        "the committed state, not the torn pages"
    );
    assert!(
        std::fs::read(&interrupted).unwrap() == tmp_before
            && std::fs::read(journal_of(&interrupted)).unwrap() == journal_before,
        "the candidate and its journal are left as they were"
    );
}

/// [#576 NF-AN2-7] A rollback journal left beside the PROJECT (the file was being
/// written when it broke) belongs to the file being replaced: it moves aside with
/// that file's safety copy, so it cannot be rolled back into the restored file,
/// and the safety copy reads back as the file was.
#[test]
fn a_journal_left_beside_the_project_moves_aside_with_its_safety_copy() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("old.stalx");
    project_file(&source, "Original");
    let project = temp.path().join("CaveA.stalx");
    torn_copy(&source, &project);
    let backup = temp.path().join("CaveA.stalx.backup");
    project_file(&backup, "Restored");

    let outcome = Database::restore_from_backup(&project, &backup).unwrap();
    let safety = outcome.safety_copy.unwrap();
    println!(
        "project now holds: {}; safety copy {:?} holds: {}; project journal left: {}",
        project_name(&project),
        safety.file_name().unwrap(),
        project_name(&safety),
        journal_of(&project).exists()
    );
    assert_eq!(project_name(&project), "Restored");
    assert!(
        !journal_of(&project).exists(),
        "no journal left beside the restored file"
    );
    assert_eq!(
        project_name(&safety),
        "Original",
        "the replaced file and its journal are kept together"
    );
}

/// [#576 C15] Restores never overwrite an earlier safety copy: each one is
/// numbered, and the copy of the original survives any number of restores.
#[test]
fn every_restore_keeps_its_own_numbered_safety_copy() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "Original");
    let first = temp.path().join("CaveA.stalx.backup");
    project_file(&first, "BackupOne");
    let second = temp.path().join("CaveA.stalx.backup.1");
    project_file(&second, "BackupTwo");

    let one = Database::restore_from_backup(&project, &first).unwrap();
    let two = Database::restore_from_backup(&project, &second).unwrap();
    let one = one.safety_copy.unwrap();
    let two = two.safety_copy.unwrap();
    assert_eq!(one.file_name().unwrap(), "CaveA.stalx.pre-restore.1");
    assert_eq!(two.file_name().unwrap(), "CaveA.stalx.pre-restore.2");
    assert_eq!(project_name(&one), "Original");
    assert_eq!(project_name(&two), "BackupOne");
    assert_eq!(project_name(&project), "BackupTwo");
}

/// [#576 C15] A candidate that does not pass the checks is refused before the
/// project is touched, and no safety copy or staging file is left behind.
#[test]
fn an_unusable_candidate_is_refused_before_anything_is_written() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "Original");
    let before = std::fs::read(&project).unwrap();
    let empty = temp.path().join("CaveA.stalx.backup");
    // A real database, but holding no project.
    drop(
        Connection::open(&empty)
            .unwrap()
            .execute_batch("CREATE TABLE t (x);"),
    );

    let refused = Database::restore_from_backup(&project, &empty);
    let message = refused.err().map(|e| format!("{e:#}")).unwrap_or_default();
    println!("restore -> {message}");
    assert!(message.contains("holds no project"), "{message}");
    assert_eq!(
        std::fs::read(&project).unwrap(),
        before,
        "the project is untouched"
    );
    let names: Vec<String> = std::fs::read_dir(temp.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !names
            .iter()
            .any(|n| n.contains("pre-restore") || n.contains("staging")),
        "nothing left behind: {names:?}"
    );
}

/// [#576 C15] The Restore list offers every kind of candidate, labelled and
/// checked: backups (repair copies and pre-upgrade copies), an interrupted save's
/// `.tmp`, and the files earlier restores replaced (numbered). Unusable ones are
/// listed but marked, with the reason. Journals, half-written copies and the
/// project itself are never offered. Checking a candidate that has a journal
/// must not change it.
#[test]
fn the_restore_list_labels_and_checks_every_candidate() {
    let temp = TempDir::new().unwrap();
    let dir = temp.path();
    let project = dir.join("CaveA.stalx");
    project_file(&project, "Original");
    project_file(&dir.join("CaveA.stalx.backup"), "Repair");
    project_file(&dir.join("CaveA.stalx.pre-v16.backup"), "Upgrade");
    project_file(&dir.join("CaveA.stalx.pre-restore.2"), "Second");
    project_file(&dir.join("CaveA.stalx.pre-restore"), "Legacy");
    std::fs::write(dir.join("CaveA.stalx.backup.1"), b"not a database").unwrap();
    let committed = dir.join("work.stalx");
    project_file(&committed, "Committed");
    let interrupted = dir.join("CaveA.stalx.tmp");
    torn_copy(&committed, &interrupted);
    let tmp_before = std::fs::read(&interrupted).unwrap();
    // Never offered: a stray journal of a backup, a half-written pre-upgrade copy.
    std::fs::write(dir.join("CaveA.stalx.backup-journal"), b"x").unwrap();
    std::fs::write(dir.join("CaveA.stalx.pre-v15.partial"), b"x").unwrap();

    let list = Database::list_backups(&project);
    for entry in &list {
        println!(
            "{:<28} kind={:?} restore_number={:?} usable={} problem={:?}",
            Path::new(&entry.path)
                .file_name()
                .unwrap()
                .to_string_lossy(),
            entry.kind,
            entry.restore_number,
            entry.usable,
            entry.problem
        );
    }
    assert_eq!(list.len(), 6, "exactly the six candidates");
    let backup = listed(&list, "CaveA.stalx.backup").unwrap();
    assert_eq!((backup.kind, backup.usable), (BackupKind::Backup, true));
    let upgrade = listed(&list, "CaveA.stalx.pre-v16.backup").unwrap();
    assert_eq!((upgrade.kind, upgrade.usable), (BackupKind::Backup, true));
    let second = listed(&list, "CaveA.stalx.pre-restore.2").unwrap();
    assert_eq!(
        (second.kind, second.restore_number, second.usable),
        (BackupKind::PreRestore, Some(2), true)
    );
    let legacy = listed(&list, "CaveA.stalx.pre-restore").unwrap();
    assert_eq!(
        (legacy.kind, legacy.restore_number),
        (BackupKind::PreRestore, None)
    );
    let broken = listed(&list, "CaveA.stalx.backup.1").unwrap();
    assert!(!broken.usable && broken.problem.is_some());
    let tmp = listed(&list, "CaveA.stalx.tmp").unwrap();
    assert_eq!((tmp.kind, tmp.usable), (BackupKind::InterruptedSave, true));
    assert!(
        std::fs::read(&interrupted).unwrap() == tmp_before && journal_of(&interrupted).exists(),
        "checking a candidate with a journal leaves both untouched"
    );
}
