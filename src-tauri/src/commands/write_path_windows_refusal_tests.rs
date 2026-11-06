//! [#576 W24-D1] Windows paths the write-path policy refuses from their text:
//! device, volume and drive-relative paths, alternate data streams, device
//! names and this computer reached as a network share. Judged under Windows
//! rules on an empty model disk, so every host runs them; Unix and macOS rules
//! take the same text as plain names.
//!
//! All paths are synthetic.

use std::path::{Path, PathBuf};

use crate::commands::write_path::{
    check_write_path_under, AppDirs, LinkLookup, PathRules, Walk, WriteTarget,
};

const WINDOWS: PathRules = PathRules {
    windows: true,
    fold_case: true,
};
const LINUX: PathRules = PathRules {
    windows: false,
    fold_case: false,
};
const MACOS: PathRules = PathRules {
    windows: false,
    fold_case: true,
};

/// A disk with nothing on it: no name exists and no link leads anywhere, so
/// nothing is touched.
struct NoDisk;

impl LinkLookup for NoDisk {
    fn canonical(&self, _: &Path) -> Option<PathBuf> {
        None
    }

    fn link_target(&self, _: &Path) -> Option<PathBuf> {
        None
    }
}

/// The cases a project write under `rules` does not answer as expected: each
/// `(what, path, refused)`, `Some(reason)` for a refusal whose message holds
/// `reason`, `None` for a write that is allowed. No app folders; every answer
/// printed.
fn wrong_writes(rules: PathRules, cases: &[(&str, &str, Option<&str>)]) -> Vec<String> {
    let dirs = AppDirs {
        internal: Vec::new(),
        managed_projects: None,
    };
    let walk = Walk {
        rules,
        disk: &NoDisk,
    };
    let mut wrong = Vec::new();
    for (what, path, refused) in cases {
        let got = check_write_path_under(Path::new(path), WriteTarget::Project, &dirs, walk);
        println!("W24-D1 {what}: {path:?}: {got:?}");
        let as_expected = match (&got, refused) {
            (Ok(()), None) => true,
            (Err(why), Some(reason)) => why.contains(reason),
            _ => false,
        };
        if !as_expected {
            wrong.push(format!("{what}: {got:?}"));
        }
    }
    wrong
}

const NOT_PLAIN: Option<&str> = Some("a Windows device, volume or drive-relative path");
const STREAM: Option<&str> = Some("an alternate data stream");

/// Class 1: a `\\?\` or `\\.\` path that is not a drive or UNC path, the NT
/// prefix `\??\`, and a path relative to a drive's current folder (`C:x`).
#[test]
fn a_device_volume_or_drive_relative_path_is_refused() {
    let cases = [
        (
            "GLOBALROOT volume",
            r"\\?\GLOBALROOT\Device\HarddiskVolume3\Users\a\CaveL.stalx",
            NOT_PLAIN,
        ),
        (
            "GLOBALROOT network",
            r"\\?\GLOBALROOT\Device\Mup\server\share\CaveL.stalx",
            NOT_PLAIN,
        ),
        (
            "volume GUID",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\CaveL.stalx",
            NOT_PLAIN,
        ),
        (
            "device volume",
            r"\\.\HarddiskVolume3\Users\a\CaveL.stalx",
            NOT_PLAIN,
        ),
        ("named pipe", r"\\.\pipe\CaveL.stalx", NOT_PLAIN),
        (
            "device prefix in forward slashes",
            "//?/GLOBALROOT/Device/Mup/server/share/CaveL.stalx",
            NOT_PLAIN,
        ),
        ("NT prefix, drive", r"\??\C:\Users\a\CaveL.stalx", NOT_PLAIN),
        (
            "NT prefix, UNC",
            r"\??\UNC\server\share\CaveL.stalx",
            NOT_PLAIN,
        ),
        ("drive-relative", "C:CaveL.stalx", NOT_PLAIN),
        ("drive-relative folder", r"c:Users\a\CaveL.stalx", NOT_PLAIN),
        ("drive-relative parent", r"C:..\CaveL.stalx", NOT_PLAIN),
        ("plain drive", r"C:\Users\a\CaveL.stalx", None),
        ("verbatim drive", r"\\?\C:\Users\a\CaveL.stalx", None),
        ("device drive", r"\\.\C:\Users\a\CaveL.stalx", None),
        ("plain UNC", r"\\server\share\CaveL.stalx", None),
        ("verbatim UNC", r"\\?\UNC\server\share\CaveL.stalx", None),
        ("device UNC", r"\\.\unc\server\share\CaveL.stalx", None),
        ("rooted on the current drive", r"\Users\a\CaveL.stalx", None),
        ("relative", r"Documents\CaveL.stalx", None),
    ];
    let wrong = wrong_writes(WINDOWS, &cases);
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Class 2: a `:` after the drive prefix names an alternate data stream - of
/// another file (`notes.txt:x.stalx`) or of a folder itself (`C:\Windows:x`).
#[test]
fn an_alternate_data_stream_is_refused() {
    let cases = [
        (
            "stream of another file",
            r"C:\Users\a\notes.txt:x.stalx",
            STREAM,
        ),
        ("stream of a folder", r"C:\Windows:CaveL.stalx", STREAM),
        (
            "stream named like the file",
            r"C:\Users\a\CaveL.stalx:x.stalx",
            STREAM,
        ),
        (
            "stream, verbatim",
            r"\\?\C:\Users\a\notes.txt:x.stalx",
            STREAM,
        ),
        (
            "stream on a share",
            r"\\server\share\notes.txt:x.stalx",
            STREAM,
        ),
        ("stream, relative", "notes.txt:x.stalx", STREAM),
        ("the drive's own colon", r"C:\Users\a\CaveL.stalx", None),
    ];
    let wrong = wrong_writes(WINDOWS, &cases);
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Unix and macOS rules take every one of those spellings as plain names: a
/// `:`, `C:x`, `NUL.stalx` or `//localhost` is a file or folder name there.
#[test]
fn on_unix_and_macos_the_windows_spellings_are_plain_names() {
    let cases = [
        (
            "device prefix",
            r"\\?\GLOBALROOT\Device\Mup\CaveL.stalx",
            None,
        ),
        ("drive-relative", "C:CaveL.stalx", None),
        ("stream", "/home/a/notes.txt:x.stalx", None),
        ("device name", "/home/a/NUL.stalx", None),
        ("loopback", "//localhost/share/CaveL.stalx", None),
    ];
    let mut wrong = wrong_writes(LINUX, &cases);
    wrong.extend(wrong_writes(MACOS, &cases));
    assert!(wrong.is_empty(), "{wrong:#?}");
}
