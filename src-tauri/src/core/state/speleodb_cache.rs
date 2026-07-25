//! Replacing the local SpeleoDB cache `.stalx` with a freshly-downloaded copy.
//!
//! Three flows do this - the pull (`speleodb_open_project`), the fast-forward
//! (`speleodb_start_editing` / `speleodb_update`), and the revision swap
//! (`speleodb_restore_revision`) - and all three must handle the same two hazards
//! around clobbering a file the app may still hold open:
//!
//! 1. the per-machine `display_settings` in the OLD file have to survive the
//!    replace (the server copy has them stripped, #197), and
//! 2. any live SQLite handle to the destination has to be closed BEFORE the
//!    replace, and the replace itself has to be atomic.
//!
//! [`AppState::replace_cache_stalx`] is the single chokepoint that does all of
//! it, so no call site can forget half of it.

use std::collections::HashMap;
use std::path::Path;

use super::AppState;
use crate::speleodb::dump::Dump;
use crate::speleodb::SpeleoDbError;

/// Snapshot the local per-machine `display_settings` from an existing cache file
/// BEFORE a download-replace overwrites it. View toggles are stripped from the
/// server copy on push (#197), so without re-applying them a fast-forward / re-open
/// - which replaces the whole local `.stalx` with the server's - would reset the
/// user's view to defaults. Empty when the file is absent or unreadable (a first
/// open → defaults, which is correct). Pairs with [`restore_display_settings`].
///
/// Opens READ-ONLY via `open_for_metadata`: this is a handful of `SELECT`s, so it
/// needs neither the integrity check / migration chain nor `open_existing`'s
/// read-write connection with its 256 MB mmap - and it must not add another
/// mmap'd handle to a file that is about to be replaced.
pub(super) fn preserved_display_settings(dest: &Path) -> HashMap<String, String> {
    if !dest.exists() {
        return HashMap::new();
    }
    crate::persistence::Database::open_for_metadata(dest)
        .and_then(|db| db.load_display_settings())
        .unwrap_or_default()
}

/// Re-apply preserved local `display_settings` into a freshly-downloaded cache file
/// (companion to [`preserved_display_settings`]). Best-effort per key - a failed
/// restore only means that one view toggle falls back to its default.
pub(super) fn restore_display_settings(
    db: &crate::persistence::Database,
    preserved: &HashMap<String, String>,
) {
    for (key, value) in preserved {
        if let Err(e) = db.save_display_setting(key, value) {
            tracing::warn!(error = %e, key = %key, "failed to restore local display setting after download-replace");
        }
    }
}

impl AppState {
    /// Replace the cache `.stalx` at `dest` with `entry` extracted from `dump`,
    /// returning the local view toggles the caller must re-apply to the fresh file
    /// (see [`restore_display_settings`]).
    ///
    /// Order matters:
    ///
    /// 1. read the outgoing file's `display_settings` while it still exists;
    /// 2. close the open project IF it is this very file, so no live SQLite handle
    ///    (and no 256 MB mmap) survives into the replace - see
    ///    [`AppState::close_project_if_open_at`] for why that is required on
    ///    Windows and why it is conditional;
    /// 3. extract, which stages to a sibling temp file and RENAMES over `dest`, so
    ///    an interrupted extract leaves the old copy intact rather than a stub.
    ///
    /// Steps 2 and 3 cover different failure modes and neither replaces the other.
    pub(super) fn replace_cache_stalx(
        &self,
        dump: &mut Dump<'_>,
        entry: &str,
        dest: &Path,
    ) -> Result<HashMap<String, String>, SpeleoDbError> {
        let preserved_view = preserved_display_settings(dest);
        self.close_project_if_open_at(dest);
        dump.extract_entry_to(entry, dest)?;
        Ok(preserved_view)
    }
}
