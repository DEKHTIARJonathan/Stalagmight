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

fn restore(project: &Path, candidate: &Path) -> Result<String, crate::core::CommandError> {
    tauri::async_runtime::block_on(recovery::restore_from_backup(
        project.to_path_buf(),
        candidate.to_path_buf(),
    ))
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

// --- [#576 HFI-3] Export Salvageable Data: the backend writes the file ---------

/// Run the salvage write through the command itself.
fn write_salvage(project: &Path, dest: &Path) -> Result<(), crate::core::CommandError> {
    tauri::async_runtime::block_on(recovery::write_salvaged_data(
        project.to_path_buf(),
        dest.to_path_buf(),
    ))
}

/// The file the dialog chose holds the salvage of the project - the JSON the
/// dialog used to write from the webview (which the fs scope refused in the real
/// app) - into a new folder, and over a file the OS dialog already agreed to
/// replace.
#[test]
fn the_salvage_export_writes_the_chosen_file() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "SalvageMe");
    let folder = temp.path().join("new-empty-folder");
    std::fs::create_dir(&folder).unwrap();
    let dest = folder.join("salvaged.json");

    let written = write_salvage(&project, &dest);
    println!(
        "write_salvaged_data: {written:?}; file written: {}",
        dest.exists()
    );
    written.unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
    println!("salvaged project name in the file: {}", json["name"]);
    assert_eq!(json["name"], "SalvageMe");

    // The same bytes the read command hands the dialog for its summary.
    let read =
        tauri::async_runtime::block_on(recovery::export_salvageable_data(project.clone())).unwrap();
    assert_eq!(
        std::fs::read_to_string(&dest).unwrap(),
        read.full_project_json.unwrap()
    );

    // Over an existing file (the OS save dialog asked about this exact name).
    std::fs::write(&dest, b"an older salvage").unwrap();
    write_salvage(&project, &dest).unwrap();
    assert!(std::fs::read_to_string(&dest)
        .unwrap()
        .contains("SalvageMe"));
}

/// Refused like every other write: the app's own folders, a non-JSON name, and
/// the damaged project itself - and nothing is written or touched.
#[test]
fn the_salvage_export_refuses_where_no_command_writes() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "SalvageMe");

    let app = TempDir::new().unwrap();
    let dirs = crate::commands::write_path::AppDirs {
        internal: vec![app.path().to_path_buf()],
        managed_projects: None,
    };
    let inside_app = app.path().join("salvaged.json");
    let refused = recovery::write_salvaged_data_with(&project, &inside_app, &dirs);
    println!("into the app's folder: {refused:?}");
    assert!(refused.unwrap_err().message.contains("app's own settings"));
    assert!(!inside_app.exists(), "nothing written there");

    let not_json = temp.path().join("notes.txt");
    let refused = write_salvage(&project, &not_json);
    println!("to notes.txt: {refused:?}");
    assert!(refused.unwrap_err().message.contains("must end in .json"));
    assert!(!not_json.exists());

    // A damaged project opened under a .json name (the open dialog offers "All
    // Files"): its own salvage must not replace it.
    let odd = temp.path().join("odd.json");
    project_file(&odd, "OddName");
    let before = std::fs::read(&odd).unwrap();
    let refused = write_salvage(&odd, &odd);
    println!("over the damaged project itself: {refused:?}");
    assert!(refused
        .unwrap_err()
        .message
        .contains("damaged project itself"));
    assert!(
        std::fs::read(&odd).unwrap() == before,
        "the project is untouched"
    );
}

#[cfg(unix)]
#[test]
fn the_salvage_export_refuses_a_system_folder() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "SalvageMe");
    let refused = write_salvage(&project, Path::new("/etc/stalagmight-hfi3.json"));
    println!("into /etc: {refused:?}");
    assert!(refused
        .unwrap_err()
        .message
        .contains("inside a system folder"));
}

/// A folder the user may not write to: an error with the reason, nothing written -
/// not a success the dialog would report as saved.
#[cfg(unix)]
#[test]
fn the_salvage_export_into_an_unwritable_folder_fails_and_says_why() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let project = temp.path().join("CaveA.stalx");
    project_file(&project, "SalvageMe");
    let locked = temp.path().join("read-only");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    // Root (CAP_DAC_OVERRIDE) ignores the mode bits; fail rather than pass untested.
    crate::models::test_support::assert_dir_refuses_new_files(&locked);

    let dest = locked.join("salvaged.json");
    let written = write_salvage(&project, &dest);

    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    println!(
        "into a read-only folder: {written:?}; file written: {}",
        dest.exists()
    );
    let err = written.unwrap_err();
    assert_eq!(
        err.code,
        crate::core::CommandErrorCode::Failed,
        "{}",
        err.message
    );
    assert!(
        err.message.contains("Could not write salvaged.json")
            && err.message.contains("Permission denied"),
        "{}",
        err.message
    );
    assert!(!dest.exists());
}
