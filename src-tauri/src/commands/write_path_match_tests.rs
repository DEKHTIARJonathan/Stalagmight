//! [#576 RV6b-R4] How the app/system-folder check matches a path against a
//! folder: letter case, symlinks and Windows verbatim (`\\?\`) forms.
//!
//! The comparison is pure text under a platform's rules (`PathRules`), so each
//! platform's rules are tested here on every host: case folds on Windows and
//! macOS (APFS and HFS+ are case-insensitive by default) and not on Linux;
//! Windows' verbatim prefixes and forward slashes name the same folder as the
//! plain form. The symlink cases go through the real check on a Unix host.
//!
//! All paths are synthetic.

use std::path::Path;

use crate::commands::write_path::{
    check_write_path_with, load_upgrade_refusal_with, path_is_within, AppDirs, PathRules,
    WriteTarget,
};

const LINUX: PathRules = PathRules {
    windows: false,
    fold_case: false,
};
const MACOS: PathRules = PathRules {
    windows: false,
    fold_case: true,
};
const WINDOWS: PathRules = PathRules {
    windows: true,
    fold_case: true,
};

#[test]
fn the_host_rules_fold_case_where_the_file_system_does() {
    println!("host path rules: {:?}", PathRules::HOST);
    assert_eq!(PathRules::HOST.windows, cfg!(windows));
    assert_eq!(
        PathRules::HOST.fold_case,
        cfg!(any(windows, target_os = "macos")),
        "Windows and macOS file systems are case-insensitive by default"
    );
}

#[test]
fn each_platform_matches_a_path_against_a_folder_by_its_own_rules() {
    let cases: &[(&str, &str, &str, PathRules, bool)] = &[
        // Case.
        (
            "linux, other case",
            "/USR/share/CaveL.stalx",
            "/usr",
            LINUX,
            false,
        ),
        (
            "macos, other case",
            "/USR/share/CaveL.stalx",
            "/usr",
            MACOS,
            true,
        ),
        (
            "macos, app folder in other case",
            "/Users/a/library/application support/stalagmight/CaveL.stalx",
            "/Users/a/Library/Application Support/Stalagmight",
            MACOS,
            true,
        ),
        (
            "windows, other case",
            r"c:\WINDOWS\System32\CaveL.stalx",
            r"C:\Windows",
            WINDOWS,
            true,
        ),
        // Verbatim and separator forms.
        (
            "windows, verbatim path",
            r"\\?\C:\Windows\CaveL.stalx",
            r"C:\Windows",
            WINDOWS,
            true,
        ),
        (
            "windows, verbatim folder",
            r"C:\Program Files\CaveL.stalx",
            r"\\?\C:\Program Files",
            WINDOWS,
            true,
        ),
        (
            "windows, verbatim UNC",
            r"\\?\UNC\server\share\AppData\CaveL.stalx",
            r"\\server\share\AppData",
            WINDOWS,
            true,
        ),
        (
            "windows, forward slashes",
            "C:/Windows/CaveL.stalx",
            r"C:\Windows",
            WINDOWS,
            true,
        ),
        // Look-alikes that are not inside.
        (
            "linux, sibling prefix",
            "/usrlocal/CaveL.stalx",
            "/usr",
            LINUX,
            false,
        ),
        (
            "windows, sibling prefix",
            r"\\?\C:\WindowsOld\CaveL.stalx",
            r"C:\Windows",
            WINDOWS,
            false,
        ),
        (
            "windows, other drive",
            r"\\?\D:\Windows\CaveL.stalx",
            r"C:\Windows",
            WINDOWS,
            false,
        ),
        // Separators that do not change the place.
        (
            "linux, trailing separator",
            "/etc/CaveL.stalx",
            "/etc/",
            LINUX,
            true,
        ),
        (
            "linux, doubled separator",
            "/etc//CaveL.stalx",
            "/etc",
            LINUX,
            true,
        ),
        ("linux, the folder itself", "/etc", "/etc", LINUX, true),
    ];
    let mut wrong = Vec::new();
    for (what, path, dir, rules, inside) in cases {
        let got = path_is_within(path, dir, *rules);
        println!("{what}: {path:?} within {dir:?}: {got}");
        if got != *inside {
            wrong.push(*what);
        }
    }
    assert!(wrong.is_empty(), "wrong verdicts: {wrong:?}");
}

/// The real check, through a symlink each way. A link in a user's folder that
/// leads into the app's folders is refused (its resolved form is inside); a link
/// inside the app's folders that leads out is refused too (its spelled form is
/// inside) - the conservative side.
#[cfg(unix)]
#[test]
fn a_symlink_into_or_out_of_an_app_folder_is_refused() -> std::io::Result<()> {
    let root = tempfile::TempDir::new()?;
    let config = root.path().join("app/config");
    let user = root.path().join("user");
    std::fs::create_dir_all(&config)?;
    std::fs::create_dir_all(&user)?;
    std::os::unix::fs::symlink(&config, user.join("into-app"))?;
    std::os::unix::fs::symlink(&user, config.join("out-to-user"))?;
    let dirs = AppDirs {
        internal: vec![config.clone()],
        managed_projects: None,
    };
    let cases: [(&str, &Path, bool); 3] = [
        (
            "a user file through a link into the app config",
            &user.join("into-app/CaveL.stalx"),
            true,
        ),
        (
            "an app-config file through a link out to the user folder",
            &config.join("out-to-user/CaveL.stalx"),
            true,
        ),
        ("a plain user file", &user.join("CaveL.stalx"), false),
    ];
    let mut wrong = Vec::new();
    for (what, path, refused) in cases {
        let write = check_write_path_with(path, WriteTarget::Project, &dirs);
        let load = load_upgrade_refusal_with(path, &dirs);
        println!(
            "{what}: write refused: {}, load upgrade refused: {}",
            write.is_err(),
            load.is_some()
        );
        if write.is_err() != refused || load.is_some() != refused {
            wrong.push(what);
        }
    }
    assert!(wrong.is_empty(), "wrong verdicts: {wrong:?}");
    Ok(())
}
