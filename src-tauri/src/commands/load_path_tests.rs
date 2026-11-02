//! [#576 RV4-R-M3] Opening a project goes through the write-path check's location
//! rules.
//!
//! A load is not read-only: an older-schema file is upgraded IN PLACE (the
//! migration chain) and a `<name>.stalx.pre-v<N>.backup` is written beside it,
//! and every open writes SQLite's journal next to the file. The load commands took
//! any webview path unchecked, so a page script past the CSP could upgrade an old
//! `.stalx` anywhere and drop a sibling file next to it. They now refuse the app's
//! own folders (the SpeleoDB managed-project cache excepted) and system folders,
//! like every other command that writes. The extension rule is not applied: the
//! open dialog offers "All Files", and a load writes no NEW file of its own name.
//!
//! All paths are synthetic.

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::commands::write_path::{check_load_path_with, AppDirs};

fn verdict(path: &Path, dirs: &AppDirs) -> String {
    match check_load_path_with(path, dirs) {
        Ok(()) => "allowed".to_owned(),
        Err(why) => why,
    }
}

#[test]
fn a_load_is_refused_inside_the_app_folders_and_system_folders_only() {
    let app = TempDir::new().expect("app dir");
    let user = TempDir::new().expect("user dir");
    let dirs = AppDirs {
        internal: vec![app.path().join("config"), app.path().join("cache")],
        managed_projects: Some(app.path().join("cache").join("speleodb")),
    };
    let cases: Vec<(&str, PathBuf, bool)> = vec![
        ("a user's project", user.path().join("CaveL.stalx"), true),
        (
            "a user's file with another extension",
            user.path().join("CaveL.bak"),
            true,
        ),
        (
            "a SpeleoDB managed copy",
            app.path().join("cache/speleodb/p1/project.stalx"),
            true,
        ),
        (
            "inside the app config",
            app.path().join("config/CaveL.stalx"),
            false,
        ),
        (
            "inside the app cache",
            app.path().join("cache/CaveL.stalx"),
            false,
        ),
        (
            "inside a system folder",
            PathBuf::from("/etc/CaveL.stalx"),
            cfg!(windows),
        ),
    ];
    let mut wrong = Vec::new();
    for (what, path, allowed) in cases {
        let got = verdict(&path, &dirs);
        println!("{what}: {got}");
        if (got == "allowed") != allowed {
            wrong.push(what);
        }
    }
    assert!(wrong.is_empty(), "wrong verdicts: {wrong:?}");
}

#[test]
fn both_load_commands_check_the_path_before_loading() {
    let source = include_str!("project.rs");
    for command in [
        "pub async fn load_project_full(",
        "pub async fn load_project_full_binary(",
    ] {
        let body = source
            .split_once(command)
            .map(|(_, rest)| rest)
            .and_then(|rest| rest.split("\n}\n").next())
            .unwrap_or_default();
        let check = body.find("check_load_path(");
        let load = body.find("do_load_project_full(");
        println!("{command}: check at {check:?}, load at {load:?}");
        assert!(
            check.is_some() && check < load,
            "{command} must check the path before it loads"
        );
    }
}
