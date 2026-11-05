//! [#576 C11-D1] Every command that writes, replaces or deletes a file at a path
//! the webview hands it checks that path first: the right extension, not inside
//! the app's own folders, not inside a system folder.
//!
//! All files are synthetic, in temp dirs.

use std::path::{Path, PathBuf};

use tauri::Manager;
use tempfile::TempDir;

use super::command_tests::{h, run};
use crate::commands::write_path::{check_write_path_with, AppDirs, WriteTarget};
use crate::core::AppState;
use crate::export::ImageFormat;
use stalagmight_core::test_fixtures::state_with_project;

fn no_app_dirs() -> AppDirs {
    AppDirs {
        internal: Vec::new(),
        managed_projects: None,
    }
}

fn verdict(path: &Path, target: WriteTarget, dirs: &AppDirs) -> String {
    match check_write_path_with(path, target, dirs) {
        Ok(()) => "allowed".to_owned(),
        Err(why) => why,
    }
}

/// A project with one section, open, so the exports have something to write.
fn open_project_state(dir: &Path) -> AppState {
    let state = state_with_project("CaveW");
    let saved = state.execute(crate::core::Command::SaveProject {
        path: Some(dir.join("CaveW.stalx")),
    });
    assert!(saved.success, "{:?}", saved.error);
    state
}

#[test]
fn the_extension_must_be_the_one_being_written() {
    let dir = TempDir::new().expect("tempdir");
    let dirs = no_app_dirs();
    for (file, target, allowed) in [
        ("a.csv", WriteTarget::Csv, true),
        ("a.CSV", WriteTarget::Csv, true),
        ("config.toml", WriteTarget::Csv, false),
        ("a.json", WriteTarget::Json, true),
        ("a.tmlu", WriteTarget::Ariane, true),
        ("a.png", WriteTarget::Image(ImageFormat::Png), true),
        ("a.svg", WriteTarget::Image(ImageFormat::Png), false),
        ("a.stalx", WriteTarget::Project, true),
        ("notes.txt", WriteTarget::Project, false),
        ("noext", WriteTarget::Project, false),
    ] {
        let got = verdict(&dir.path().join(file), target, &dirs);
        println!("{file} as {target:?}: {got}");
        assert_eq!(got == "allowed", allowed, "{file} as {target:?}: {got}");
    }
}

#[test]
fn the_app_s_own_folders_are_refused_except_the_managed_project_cache() {
    let config = TempDir::new().expect("config dir");
    let cache = TempDir::new().expect("cache dir");
    let user = TempDir::new().expect("user dir");
    let dirs = AppDirs {
        internal: vec![config.path().to_path_buf(), cache.path().to_path_buf()],
        managed_projects: Some(cache.path().join("speleodb")),
    };
    let cases: [(PathBuf, WriteTarget, bool); 5] = [
        (
            config.path().join("settings.json"),
            WriteTarget::Json,
            false,
        ),
        (
            config.path().join("sub").join("x.stalx"),
            WriteTarget::Project,
            false,
        ),
        (
            cache.path().join("speleodb").join("p").join("x.stalx"),
            WriteTarget::Project,
            true,
        ),
        (
            cache.path().join("speleodb").join("x.csv"),
            WriteTarget::Csv,
            false,
        ),
        (user.path().join("x.stalx"), WriteTarget::Project, true),
    ];
    for (path, target, allowed) in cases {
        let got = verdict(&path, target, &dirs);
        println!("{}: {got}", path.display());
        assert_eq!(got == "allowed", allowed, "{}: {got}", path.display());
    }
}

#[cfg(unix)]
#[test]
fn system_folders_are_refused_and_user_mounts_are_not() {
    let dirs = no_app_dirs();
    for (path, allowed) in [
        ("/etc/stalagmight-w4.csv", false),
        ("/usr/share/stalagmight-w4.csv", false),
        ("/etc/../etc/stalagmight-w4.csv", false),
        ("/run/media/someone/USB/cave.csv", true),
        ("/var/home/someone/cave.csv", true),
        ("/mnt/data/cave.csv", true),
    ] {
        let got = verdict(Path::new(path), WriteTarget::Csv, &dirs);
        println!("{path}: {got}");
        assert_eq!(got == "allowed", allowed, "{path}: {got}");
    }
}

#[test]
fn the_commands_refuse_before_writing_or_deleting() {
    let _cfg = crate::test_helpers::isolated_config();
    let dir = TempDir::new().expect("tempdir");
    let app = tauri::test::mock_app();
    app.manage(open_project_state(dir.path()));

    // An export named to a file that is not of its format: nothing written.
    let toml = dir.path().join("config.toml");
    let export = run(crate::commands::export::export_csv(h(&app), toml.clone()));
    println!(
        "export_csv to config.toml: {export:?}; file written: {}",
        toml.exists()
    );
    assert!(export.is_err(), "refused");
    assert!(!toml.exists(), "and nothing was written");

    // Delete a file that is not a project: nothing deleted.
    let keep = dir.path().join("keep.txt");
    std::fs::write(&keep, b"user data").expect("write the bystander");
    let deleted = run(crate::commands::project::delete_project(
        h(&app),
        keep.clone(),
    ));
    println!(
        "delete_project on keep.txt: success={} error={:?}; file still there: {}",
        deleted.is_ok(),
        deleted.as_ref().err(),
        keep.exists()
    );
    assert!(deleted.is_err(), "refused");
    assert!(keep.exists(), "and nothing was deleted");

    // Save As into a system folder.
    #[cfg(unix)]
    {
        let saved = run(crate::commands::project::save_project(
            h(&app),
            Some(PathBuf::from("/etc/stalagmight-w4.stalx")),
            None,
        ));
        println!(
            "save as /etc/stalagmight-w4.stalx: {:?}",
            saved.as_ref().err()
        );
        assert!(saved.is_err());
        assert!(saved
            .expect_err("a save into a system folder is refused")
            .message
            .contains("system folder"));
    }

    // The ordinary cases still go through.
    let csv = dir.path().join("CaveW.csv");
    let export = run(crate::commands::export::export_csv(h(&app), csv.clone()));
    assert!(export.is_ok(), "{export:?}");
    assert!(csv.exists());
}

/// [#576 RV12-1] A folder reached through a link that follows a folder not made
/// yet and a `..`: `<user>/nope/../app-link/x`, where `app-link` points into the
/// app's own folder and `nope` does not exist. The OS cannot walk through `nope`,
/// but a write that first makes the missing folders (creating a project does,
/// `create_dir_all` on the parent) then goes `nope` -> `..` -> through the link.
/// The policy compared the path folded without looking at the disk (which cannot
/// see the link) and the deepest existing ancestor resolved with the rest
/// appended as given (whose `..` then matched nothing), so this passed every
/// caller of the policy. Each caller is asked here, for every file type.
#[cfg(unix)]
#[test]
fn a_link_reached_through_a_missing_folder_and_dot_dot_is_refused_by_every_caller() {
    use crate::commands::recovery::write_salvaged_data_with;
    use crate::commands::save_target::save_target_exists_with;
    use crate::commands::write_path::{check_write_path, load_upgrade_refusal_with};

    let app = TempDir::new().expect("app dir");
    let user = TempDir::new().expect("user dir");
    std::fs::write(app.path().join("settings.json"), b"{}").expect("an app file");
    std::os::unix::fs::symlink(app.path(), user.path().join("app-link")).expect("app link");
    std::os::unix::fs::symlink("/etc", user.path().join("etc-link")).expect("etc link");
    let dirs = AppDirs {
        internal: vec![app.path().to_path_buf()],
        managed_projects: None,
    };
    let shapes = |link: &str, file: &str| -> Vec<PathBuf> {
        let u = user.path();
        vec![
            u.join("nope").join("..").join(link).join(file),
            u.join("nope").join(".").join("..").join(link).join(file),
            u.join("nope")
                .join("deeper")
                .join("..")
                .join("..")
                .join(link)
                .join(file),
        ]
    };
    let files = [
        "x.stalx", "x.csv", "x.json", "x.tmlu", "x.png", "x.svg", "x.pdf", "x.xml", "x.txt",
    ];
    let mut passed: Vec<String> = Vec::new();
    for file in files {
        let target = WriteTarget::of_path(Path::new(file)).expect("a file type the app writes");
        for path in shapes("app-link", file) {
            let got = verdict(&path, target, &dirs);
            println!("RV12-1 check_write_path {}: {got}", path.display());
            if got == "allowed" {
                passed.push(format!("check_write_path {}", path.display()));
            }
            let probe = save_target_exists_with(&path, &dirs);
            if !probe
                .as_ref()
                .is_err_and(|e| e.code.as_str() == "WRITE_PATH_REFUSED")
            {
                passed.push(format!("save_target_exists {}: {probe:?}", path.display()));
            }
        }
        // The system folder, through the policy with the app's real directories:
        // the check `create_project_full` runs before it makes the missing folders.
        for path in shapes("etc-link", file) {
            if check_write_path(&path, target).is_ok() {
                passed.push(format!("check_write_path (system) {}", path.display()));
            }
        }
    }
    for path in shapes("app-link", "x.stalx") {
        if load_upgrade_refusal_with(&path, &dirs).is_none() {
            passed.push(format!("load_upgrade_refusal {}", path.display()));
        }
    }
    let damaged = user.path().join("damaged.stalx");
    std::fs::write(&damaged, b"not a database").expect("a damaged project");
    for path in shapes("app-link", "x.json") {
        let wrote = write_salvaged_data_with(&damaged, &path, &dirs);
        let refused = wrote
            .as_ref()
            .is_err_and(|e| e.message.starts_with("Refused to change"));
        if !refused {
            passed.push(format!("write_salvaged_data {}: {wrote:?}", path.display()));
        }
    }
    println!("RV12-1 passed the policy: {} of them", passed.len());
    for line in &passed {
        println!("RV12-1   {line}");
    }
    assert!(
        passed.is_empty(),
        "{} paths passed the policy",
        passed.len()
    );

    // The same shape that lands in a user folder is still allowed.
    let mine = user.path().join("nope").join("..").join("CaveA.stalx");
    assert_eq!(verdict(&mine, WriteTarget::Project, &dirs), "allowed");
    assert!(!app.path().join("x.stalx").exists(), "nothing written");
}
