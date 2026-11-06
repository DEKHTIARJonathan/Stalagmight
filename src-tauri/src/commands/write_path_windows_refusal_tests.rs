//! [#576 W24-D1] Windows paths the write-path policy refuses from their text:
//! device, volume and drive-relative paths, alternate data streams, device
//! names and this computer reached as a network share. Judged under Windows
//! rules on an empty model disk, so every host runs them; Unix and macOS rules
//! take the same text as plain names.
//!
//! All paths are synthetic.

use std::path::{Path, PathBuf};

use crate::commands::write_path::{
    check_write_path_under, windows_path_refusal, AppDirs, LinkLookup, PathRules, Walk, WriteTarget,
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
const DEVICE_NAME: Option<&str> = Some("a Windows device name");
const LOOPBACK: Option<&str> = Some("this computer reached as a network share");

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

/// Class 3: a last name that is a Windows device name, with or without an
/// extension, in any case, with trailing dots or spaces before the extension.
#[test]
fn a_device_name_is_refused() {
    let cases = [
        ("NUL", r"C:\Users\a\NUL.stalx", DEVICE_NAME),
        ("con, lower case", r"C:\Users\a\con.stalx", DEVICE_NAME),
        ("PRN", r"C:\Users\a\PRN.stalx", DEVICE_NAME),
        ("Aux, mixed case", r"C:\Users\a\Aux.stalx", DEVICE_NAME),
        ("COM1", r"C:\Users\a\COM1.stalx", DEVICE_NAME),
        ("com9", r"C:\Users\a\com9.stalx", DEVICE_NAME),
        ("LPT1", r"C:\Users\a\LPT1.stalx", DEVICE_NAME),
        ("lpt9", r"C:\Users\a\lpt9.stalx", DEVICE_NAME),
        (
            "two extensions",
            r"C:\Users\a\NUL.backup.stalx",
            DEVICE_NAME,
        ),
        (
            "space before the dot",
            r"C:\Users\a\nul .stalx",
            DEVICE_NAME,
        ),
        (
            "dots before the extension",
            r"C:\Users\a\CON..stalx",
            DEVICE_NAME,
        ),
        ("relative", "NUL.stalx", DEVICE_NAME),
        ("on a share", r"\\server\share\aux.stalx", DEVICE_NAME),
        ("COM10 is a file", r"C:\Users\a\COM10.stalx", None),
        ("NULL is a file", r"C:\Users\a\NULL.stalx", None),
        ("CONSOLE is a file", r"C:\Users\a\CONSOLE.stalx", None),
        ("a folder named NUL", r"C:\Users\a\NUL\CaveL.stalx", None),
    ];
    let wrong = wrong_writes(WINDOWS, &cases);
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Class 4: a UNC path whose server is this computer - `localhost`, an address
/// in 127.0.0.0/8 or `::1` (also as an `ipv6-literal.net` name), in every UNC
/// spelling.
#[test]
fn this_computer_reached_as_a_network_share_is_refused() {
    let cases = [
        ("localhost", r"\\localhost\C$\Users\a\CaveL.stalx", LOOPBACK),
        ("LOCALHOST", r"\\LOCALHOST\share\CaveL.stalx", LOOPBACK),
        ("localhost.", r"\\localhost.\share\CaveL.stalx", LOOPBACK),
        ("127.0.0.1", r"\\127.0.0.1\c$\CaveL.stalx", LOOPBACK),
        ("127.1.2.3", r"\\127.1.2.3\share\CaveL.stalx", LOOPBACK),
        ("127.1", r"\\127.1\share\CaveL.stalx", LOOPBACK),
        ("::1", r"\\::1\c$\CaveL.stalx", LOOPBACK),
        (
            "::1 as an ipv6-literal.net name",
            r"\\--1.ipv6-literal.net\c$\CaveL.stalx",
            LOOPBACK,
        ),
        (
            "verbatim UNC",
            r"\\?\UNC\localhost\c$\CaveL.stalx",
            LOOPBACK,
        ),
        ("device UNC", r"\\.\unc\127.0.0.1\c$\CaveL.stalx", LOOPBACK),
        ("forward slashes", "//localhost/c$/CaveL.stalx", LOOPBACK),
        ("another server", r"\\server\share\CaveL.stalx", None),
        ("128.0.0.1", r"\\128.0.0.1\share\CaveL.stalx", None),
        ("localhostx", r"\\localhostx\share\CaveL.stalx", None),
        (
            "another ipv6-literal.net name",
            r"\\fe80--2.ipv6-literal.net\share\CaveL.stalx",
            None,
        ),
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

/// Class 4, the rest: this computer's own name (read from `COMPUTERNAME` on
/// Windows, given here) is a loopback server too, alone or as the start of a
/// domain name; another computer whose name starts the same is not.
#[test]
fn this_computer_s_own_name_is_a_loopback_server() {
    let own = Some("CaveHost");
    let cases = [
        (r"\\CaveHost\share\CaveL.stalx", own, LOOPBACK),
        (r"\\cavehost\share\CaveL.stalx", own, LOOPBACK),
        (r"\\cavehost.example.org\share\CaveL.stalx", own, LOOPBACK),
        (r"\\?\UNC\CAVEHOST\c$\CaveL.stalx", own, LOOPBACK),
        (r"\\cavehost2\share\CaveL.stalx", own, None),
        (r"\\server\share\CaveL.stalx", own, None),
        (r"\\CaveHost\share\CaveL.stalx", None, None),
    ];
    let mut wrong = Vec::new();
    for (path, own_name, refused) in cases {
        let got = windows_path_refusal(path, own_name);
        println!("W24-D1 own name {own_name:?}: {path:?}: {got:?}");
        let as_expected = match (got, refused) {
            (None, None) => true,
            (Some(why), Some(reason)) => why.contains(reason),
            _ => false,
        };
        if !as_expected {
            wrong.push(format!("{path} ({own_name:?}): {got:?}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}
