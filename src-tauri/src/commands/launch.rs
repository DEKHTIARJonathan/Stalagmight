//! Launch-with-file plumbing (#424).
//!
//! Three OS paths can hand this app a file to open:
//!
//! - **Cold launch with argv** (Windows Explorer, a Linux `.desktop` handler):
//!   the path is an ordinary command-line argument.
//! - **Apple events** (macOS): Finder never passes argv, it sends an open-URLs
//!   event that Tauri surfaces as [`tauri::RunEvent::Opened`] - for both a cold
//!   launch and a double-click while the app is already running.
//! - **A second process** (Windows/Linux): `tauri-plugin-single-instance` kills
//!   the newcomer and forwards its argv to the running instance.
//!
//! All three converge here. Paths are pushed onto [`PendingLaunchFiles`] and the
//! frontend is nudged with [`LAUNCH_FILE_EVENT`]; the frontend drains the queue
//! via [`take_pending_launch_files`] once it is ready and routes each path
//! through its own unified open/import router. The queue - rather than an event
//! payload - is what makes a cold launch work at all: the file is known long
//! before the webview exists to receive an event.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime, Url};

/// Payload-free nudge telling the frontend to drain the pending-launch queue.
///
/// Deliberately carries no path: the queue is the single source of truth, so a
/// listener that misses this event (or is not mounted yet) still gets the file
/// on its next drain, and no path can be handled twice.
pub const LAUNCH_FILE_EVENT: &str = "launch-file-queued";

/// Extensions the OS may hand us, lowercase and without the leading dot.
///
/// Must stay in sync with `bundle.fileAssociations` in `tauri.conf.json` (what
/// the OS is told we handle) and with `PROJECT_EXTENSION` +
/// `IMPORT_EXTENSIONS` in `src/utils/fileDialogs.ts` (what `routeOpenedFile`
/// actually dispatches). Anything else is dropped here rather than forwarded,
/// so a stray command-line argument can never reach the router as a file.
pub const LAUNCHABLE_EXTENSIONS: &[&str] = &[
    "stalx", "gpx", "tml", "tmlu", "mak", "dat", "wpj", "srv", "dmp",
];

fn has_launchable_extension(path: &str) -> bool {
    let Some(ext) = path.rsplit_once('.').map(|(_, ext)| ext) else {
        return false;
    };
    // A dot in a directory component is not an extension.
    if ext.contains('/') || ext.contains('\\') {
        return false;
    }
    let ext = ext.to_ascii_lowercase();
    LAUNCHABLE_EXTENSIONS.contains(&ext.as_str())
}

/// Decode one command-line argument into a launchable absolute path.
///
/// Returns `None` for flags, for unsupported extensions, and for `file://`
/// URLs that don't resolve to a local path. Only arguments that already look
/// like a URL are parsed as one: a Windows path (`C:\dive\cave.stalx`) parses
/// as a URL with scheme `c`, so blanket URL parsing would mangle it.
pub fn launch_path_from_arg(arg: &str) -> Option<String> {
    if arg.starts_with('-') {
        return None;
    }
    if arg.starts_with("file://") {
        return launch_path_from_url(&Url::parse(arg).ok()?);
    }
    has_launchable_extension(arg).then(|| arg.to_owned())
}

/// Decode one opened URL (macOS Apple event) into a launchable local path.
pub fn launch_path_from_url(url: &Url) -> Option<String> {
    if url.scheme() != "file" {
        return None;
    }
    let path = url.to_file_path().ok()?;
    let path = path.to_str()?;
    has_launchable_extension(path).then(|| path.to_owned())
}

/// Collect the launchable paths out of a full argv, skipping `argv[0]`.
///
/// Duplicates are collapsed while preserving first-seen order so a path listed
/// twice on one command line opens once.
pub fn launch_paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for arg in args.into_iter().skip(1) {
        if let Some(path) = launch_path_from_arg(&arg) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

/// Same, for the URL list of a macOS open event.
pub fn launch_paths_from_urls(urls: &[Url]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for url in urls {
        if let Some(path) = launch_path_from_url(url) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

/// Files the OS asked us to open that the frontend has not consumed yet.
///
/// Managed Tauri state. Holding them here (instead of emitting a path with the
/// event) is what lets a cold launch work: the OS tells us the file before the
/// webview exists, and the frontend picks it up when its stores are ready.
#[derive(Debug, Default)]
pub struct PendingLaunchFiles(Mutex<Vec<String>>);

impl PendingLaunchFiles {
    /// Queue paths not already queued; returns how many were newly added.
    ///
    /// A poisoned lock is treated as "nothing queued" rather than a panic - a
    /// dropped open request is recoverable, a crashed event loop is not.
    pub fn push_all(&self, paths: Vec<String>) -> usize {
        let Ok(mut queue) = self.0.lock() else {
            return 0;
        };
        let before = queue.len();
        for path in paths {
            if !queue.contains(&path) {
                queue.push(path);
            }
        }
        queue.len() - before
    }

    /// Remove and return everything queued.
    pub fn take(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut queue| std::mem::take(&mut *queue))
            .unwrap_or_default()
    }
}

/// Queue `paths` and nudge the frontend, unless nothing new was queued.
pub fn queue_and_notify<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let Some(pending) = app.try_state::<PendingLaunchFiles>() else {
        tracing::warn!(
            purpose = "queue an OS-opened file",
            "PendingLaunchFiles state is not managed; dropping the request"
        );
        return;
    };
    if pending.push_all(paths) == 0 {
        return;
    }
    if let Err(e) = app.emit(LAUNCH_FILE_EVENT, ()) {
        tracing::warn!(
            error = %e,
            purpose = "notify the frontend of an OS-opened file",
            "Emit failed; the file stays queued for the next drain"
        );
    }
}

/// Drain the files the OS asked us to open since the last call.
#[tauri::command]
pub fn take_pending_launch_files(pending: tauri::State<'_, PendingLaunchFiles>) -> Vec<String> {
    pending.take()
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn accepts_every_associated_extension() {
        for ext in LAUNCHABLE_EXTENSIONS {
            let arg = format!("/dives/cave.{ext}");
            assert_eq!(
                launch_path_from_arg(&arg),
                Some(arg.clone()),
                "{ext} should be launchable"
            );
        }
    }

    #[test]
    fn extension_match_is_case_insensitive() {
        assert_eq!(
            launch_path_from_arg("/dives/Cave.STALX"),
            Some("/dives/Cave.STALX".to_owned())
        );
    }

    #[test]
    fn rejects_flags_and_unsupported_extensions() {
        assert_eq!(launch_path_from_arg("--webdriver"), None);
        assert_eq!(launch_path_from_arg("-v"), None);
        assert_eq!(launch_path_from_arg("/dives/notes.txt"), None);
        assert_eq!(launch_path_from_arg("/dives/cave"), None);
        // A dot in a directory component is not an extension.
        assert_eq!(launch_path_from_arg("/dives.stalx/cave"), None);
    }

    #[test]
    fn keeps_windows_paths_intact() {
        // `C:\...` parses as a URL with scheme "c"; it must not be URL-decoded.
        assert_eq!(
            launch_path_from_arg(r"C:\dives\cave.stalx"),
            Some(r"C:\dives\cave.stalx".to_owned())
        );
    }

    #[test]
    fn decodes_file_urls() {
        let url = Url::parse("file:///dives/deep%20cave.stalx").unwrap();
        assert_eq!(
            launch_path_from_url(&url),
            Some("/dives/deep cave.stalx".to_owned())
        );
        assert_eq!(
            launch_path_from_arg("file:///dives/deep%20cave.stalx"),
            Some("/dives/deep cave.stalx".to_owned())
        );
    }

    #[test]
    fn rejects_non_file_urls() {
        let url = Url::parse("https://example.com/cave.stalx").unwrap();
        assert_eq!(launch_path_from_url(&url), None);
    }

    #[test]
    fn skips_argv_zero() {
        // argv[0] can itself end in a launchable extension in a test rig; it is
        // the executable, never a file to open.
        let args = vec![
            "/apps/cave.stalx".to_owned(),
            "/dives/one.tml".to_owned(),
            "--flag".to_owned(),
            "/dives/one.tml".to_owned(),
            "/dives/two.dmp".to_owned(),
        ];
        assert_eq!(
            launch_paths_from_args(args),
            vec!["/dives/one.tml".to_owned(), "/dives/two.dmp".to_owned()]
        );
    }

    #[test]
    fn urls_are_filtered_and_deduped() {
        let urls = vec![
            Url::parse("file:///dives/one.stalx").unwrap(),
            Url::parse("file:///dives/one.stalx").unwrap(),
            Url::parse("file:///dives/notes.txt").unwrap(),
        ];
        assert_eq!(
            launch_paths_from_urls(&urls),
            vec!["/dives/one.stalx".to_owned()]
        );
    }

    #[test]
    fn queue_holds_until_taken_and_dedupes() {
        let pending = PendingLaunchFiles::default();
        assert_eq!(pending.push_all(vec!["/dives/one.stalx".to_owned()]), 1);
        // Still queued: nothing has drained it yet.
        assert_eq!(
            pending.push_all(vec![
                "/dives/one.stalx".to_owned(),
                "/dives/two.tml".to_owned()
            ]),
            1
        );
        assert_eq!(
            pending.take(),
            vec!["/dives/one.stalx".to_owned(), "/dives/two.tml".to_owned()]
        );
        assert!(pending.take().is_empty());
    }
}
