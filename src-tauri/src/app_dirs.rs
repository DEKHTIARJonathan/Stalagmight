//! Cross-platform application directory resolution via Tauri's `PathResolver`.
//!
//! On desktop, the `directories` crate works fine. On Android it returns `None`
//! for every path, crashing the app at startup. This module resolves paths
//! through Tauri's `path` API (which delegates to platform-native APIs) and
//! stores them in a `OnceLock` so they're available for the lifetime of the
//! process.
//!
//! Call [`init`] once in `.setup()` before any other code that needs paths.
//! The getter functions return `None` if called before `init()`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::Manager;

/// Resolved application directories.
#[derive(Debug)]
struct Dirs {
    data_local: PathBuf,
    config: PathBuf,
    cache: PathBuf,
    document: Option<PathBuf>,
}

static DIRS: OnceLock<Dirs> = OnceLock::new();

/// Populate application directories from Tauri's path resolver.
///
/// Must be called once during `.setup()`, before `AppState::new()` or any
/// other code that reads paths. Subsequent calls are no-ops.
pub fn init(handle: &tauri::AppHandle) {
    DIRS.get_or_init(|| {
        let resolver = handle.path();

        let data_local = resolver
            .app_local_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let config = resolver
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let cache = resolver
            .app_cache_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        // Unlike the dirs above, do NOT fall back to ".": a relative documents
        // path produces broken project save paths (e.g. "./stalagmight/foo.stalx").
        // Returning None lets callers fall through to their own resolution
        // (directories crate, $HOME/Documents).
        let document = resolver.document_dir().ok();

        tracing::debug!(
            ?data_local,
            ?config,
            ?cache,
            ?document,
            "Resolved application directories via Tauri path resolver"
        );

        Dirs {
            data_local,
            config,
            cache,
            document,
        }
    });
}

/// Local data directory (logs, telemetry buffer).
pub fn data_local_dir() -> Option<&'static Path> {
    DIRS.get().map(|d| d.data_local.as_path())
}

/// Configuration directory.
pub fn config_dir() -> Option<&'static Path> {
    DIRS.get().map(|d| d.config.as_path())
}

/// Cache directory (tile cache).
pub fn cache_dir() -> Option<&'static Path> {
    DIRS.get().map(|d| d.cache.as_path())
}

/// User documents directory (default project location).
///
/// `None` if not yet initialized, or if the platform could not resolve a
/// documents directory — callers should fall back rather than use a relative path.
pub fn document_dir() -> Option<&'static Path> {
    DIRS.get().and_then(|d| d.document.as_deref())
}
