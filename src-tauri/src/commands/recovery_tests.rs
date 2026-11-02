//! [#576 C15, NF-AN2-7] Restoring a project from the recovery dialog.
//!
//! Driven through the IPC command itself (`recovery::restore_from_backup`), so
//! the guarantees are the ones the dialog gets:
//! - every restore keeps the file it replaces as a NUMBERED copy, so a second
//!   restore never destroys the only copy of the original;
//! - a candidate that is not a usable project is refused before anything is
//!   touched;
//!
//! The rollback-journal cases (an interrupted save's `.tmp`, a journal left
//! beside the project) need raw SQLite to build, so they live with
//! `Database::restore_from_backup` in the persistence crate.
//!
//! All files are synthetic projects this build writes; no fixture is read.

use std::path::Path;

use tempfile::TempDir;

use super::recovery;
use crate::models::Project;
use crate::persistence::Database;

/// A valid project file named `name` at `path`.
fn project_file(path: &Path, name: &str) {
    let mut db = Database::open(path).unwrap();
    db.save_project(&Project::new(name.to_string(), None))
        .unwrap();
}

/// The project name stored in `path`, read through the ordinary open path.
fn project_name(path: &Path) -> String {
    Database::open_existing(path)
        .unwrap()
        .load_project()
        .unwrap()
        .name
}

/// Every pre-restore copy beside `project` and the project name each holds.
fn pre_restore_copies(project: &Path) -> Vec<(String, String)> {
    let stem = project.file_name().unwrap().to_string_lossy().into_owned();
    let mut copies: Vec<(String, String)> = std::fs::read_dir(project.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            name.starts_with(&format!("{stem}.pre-restore")) && !name.ends_with("-journal")
        })
        .map(|p| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let held = Database::open_existing(&p)
                .and_then(|db| db.load_project())
                .map_or_else(|e| format!("<unreadable: {e}>"), |project| project.name);
            (name, held)
        })
        .collect();
    copies.sort();
    copies
}

fn restore(project: &Path, candidate: &Path) -> Result<String, String> {
    recovery::restore_from_backup(project.to_path_buf(), candidate.to_path_buf())
}

/// [#576 C15] Two restores in a row keep BOTH files they replaced. The safety
/// copy used to be one fixed name overwritten by every restore, so trying a
/// second backup after a first bad one destroyed the only copy of the original.
#[test]
fn a_second_restore_keeps_the_original_file() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "Original");
    let first = temp.path().join("CaveA.stalx.backup");
    project_file(&first, "BackupOne");
    let second = temp.path().join("CaveA.stalx.backup.1");
    project_file(&second, "BackupTwo");

    restore(&project, &first).unwrap();
    restore(&project, &second).unwrap();

    let copies = pre_restore_copies(&project);
    println!("project now holds: {}", project_name(&project));
    println!("pre-restore copies: {copies:?}");
    assert_eq!(project_name(&project), "BackupTwo");
    let held: Vec<&str> = copies.iter().map(|(_, name)| name.as_str()).collect();
    assert!(
        held.contains(&"Original") && held.contains(&"BackupOne"),
        "both replaced files must survive, got {copies:?}"
    );
}

/// [#576 C15] A candidate that is not a usable project (here: leftover bytes
/// that are not a database at all) is refused, and the project is untouched.
/// It used to be copied over the project with nothing checked but `exists()`.
#[test]
fn an_unusable_candidate_is_refused_and_the_project_is_untouched() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "Original");
    let before = std::fs::read(&project).unwrap();
    let debris = temp.path().join("CaveA.stalx.tmp");
    std::fs::write(&debris, b"leftover bytes of a save that never finished").unwrap();

    let outcome = restore(&project, &debris);
    println!("restore -> {outcome:?}");
    assert!(outcome.is_err(), "an unusable candidate must be refused");
    assert!(
        std::fs::read(&project).unwrap() == before,
        "the project file must be exactly as it was"
    );
}
