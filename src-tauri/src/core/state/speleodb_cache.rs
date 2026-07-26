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
//!
//! It also carries the DATA-SAFETY half: the copy being replaced may hold edits
//! the server has never seen, and those exist in no git anywhere - overwriting
//! them is unrecoverable. So the plain verb REFUSES that replace
//! ([`SpeleoDbError::WouldDiscardLocalEdits`], which crosses IPC as a typed
//! routing signal for the keep-local / take-remote choice), and a caller that
//! genuinely means to discard has to say so by name through
//! [`AppState::replace_cache_stalx_abandoning`]. Same shape as the lock release
//! (`speleodb_release_held_lock_best_effort` vs `_abandoning`): the safe verb is
//! the one you reach for by default, and abandoning is spelled out at the call
//! site. Exactly ONE caller is entitled to it - `speleodb_take_remote`, whose
//! whole purpose is discarding local edits behind the frontend's second
//! destroy-confirmation.

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

/// Whether a re-pull may destroy un-pushed local edits at its destination.
///
/// For the two orchestration verbs that serve BOTH kinds of caller
/// (`speleodb_fast_forward`, the shared body behind `speleodb_open_project` /
/// `speleodb_open_project_discarding_local`) - so the intent is named at every
/// call site instead of riding on a bare `bool`, and so the discarding call sites
/// stay greppable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LocalEditsPolicy {
    /// Refuse the replace when the destination holds un-pushed edits. The default
    /// for every path the user did not explicitly point at their own work.
    Protect,
    /// Discard them: the user confirmed it (take-remote's destroy-confirmation, or
    /// the "take remote and discard local" branch of the open-project prompt).
    Discard,
}

impl AppState {
    /// Refuse when the copy of `project_id` at `dest` still holds edits the server
    /// has never seen. The gate in front of every download-replace, and the reason
    /// re-opening a project from the SpeleoDB list can no longer silently destroy a
    /// week of unpushed survey.
    ///
    /// Reads through [`AppState::local_copy_state`], so the OPEN project's live
    /// in-memory link counts - the case a naive on-disk-only check gets wrong, and
    /// the one where the user is most likely to be actively working.
    ///
    /// Public to the module so the ONE replace that does not go through
    /// [`AppState::replace_cache_stalx`] - Ariane adoption, which rebuilds the
    /// cache `.stalx` from an imported `.tml` rather than extracting it - can share
    /// the same gate.
    pub(super) fn guard_local_edits(
        &self,
        project_id: &str,
        dest: &Path,
    ) -> Result<(), SpeleoDbError> {
        // `None` = the file is there but unreadable, so we CANNOT rule out un-pushed
        // edits. A guard that stands in front of an overwrite has to fail closed on
        // that: the likely causes are a hot journal after a kill or power loss (which
        // a read-only connection cannot roll back - `SQLITE_READONLY_ROLLBACK`) and a
        // transient `SQLITE_BUSY`, and in both cases a read-write open would have
        // recovered work that reading the silence as "clean" would have overwritten.
        // Refusing is recoverable in a way overwriting is not: the frontend's prompt
        // offers keep-local (nothing is touched) or an explicit take-remote.
        let Some(local) = self.local_copy_state(project_id, dest) else {
            tracing::warn!(
                project_id = %project_id,
                path = %dest.display(),
                purpose = "fail closed when the local copy cannot be read",
                "speleodb: refusing to replace a local copy whose state could not be determined"
            );
            return Err(SpeleoDbError::WouldDiscardLocalEdits {
                project_id: project_id.to_owned(),
                local_path: dest.to_string_lossy().into_owned(),
                last_edit_at: None,
            });
        };
        if !local.has_unpushed_edits {
            return Ok(());
        }
        tracing::info!(
            project_id = %project_id,
            path = %dest.display(),
            is_open = local.is_open,
            purpose = "avoid silently destroying un-pushed local work on a re-pull",
            "speleodb: refusing to replace a local copy that has un-pushed edits"
        );
        Err(SpeleoDbError::WouldDiscardLocalEdits {
            project_id: project_id.to_owned(),
            local_path: dest.to_string_lossy().into_owned(),
            last_edit_at: local.last_edit_at,
        })
    }

    /// Replace the cache `.stalx` at `dest` with `entry` extracted from `dump`,
    /// returning the local view toggles the caller must re-apply to the fresh file
    /// (see [`restore_display_settings`]).
    ///
    /// REFUSES (without touching `dest`) when the local copy of `project_id` holds
    /// un-pushed edits - see [`AppState::guard_local_edits`]. A caller that means
    /// to discard them calls [`AppState::replace_cache_stalx_abandoning`] instead.
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
        project_id: &str,
    ) -> Result<HashMap<String, String>, SpeleoDbError> {
        self.guard_local_edits(project_id, dest)?;
        self.replace_cache_stalx_abandoning(dump, entry, dest)
    }

    /// [`AppState::replace_cache_stalx`] or its abandoning sibling, chosen by an
    /// explicit [`LocalEditsPolicy`]. For the orchestration verbs that serve both a
    /// protected and a confirmed-discard caller and therefore cannot pick one verb
    /// statically; their own callers name the policy.
    pub(super) fn replace_cache_stalx_with(
        &self,
        dump: &mut Dump<'_>,
        entry: &str,
        dest: &Path,
        project_id: &str,
        policy: LocalEditsPolicy,
    ) -> Result<HashMap<String, String>, SpeleoDbError> {
        match policy {
            LocalEditsPolicy::Protect => self.replace_cache_stalx(dump, entry, dest, project_id),
            LocalEditsPolicy::Discard => self.replace_cache_stalx_abandoning(dump, entry, dest),
        }
    }

    /// [`AppState::replace_cache_stalx`] WITHOUT the un-pushed-edits guard, for a
    /// caller that is deliberately throwing the local edits away - today only
    /// `speleodb_take_remote` (and the open-project prompt's "take remote and
    /// discard local" branch, which routes through the same policy). Named so the
    /// destruction is visible at the call site rather than implied by a flag.
    pub(super) fn replace_cache_stalx_abandoning(
        &self,
        dump: &mut Dump<'_>,
        entry: &str,
        dest: &Path,
    ) -> Result<HashMap<String, String>, SpeleoDbError> {
        let preserved_view = preserved_display_settings(dest);
        // Closing BEFORE the extract is the point (a live mmap must not survive into
        // the rename), so the failure path cannot simply reorder the two - it has to
        // undo the close. Left un-undone, a failed extract returned `Err` with the
        // project already closed backend-side while the frontend still displayed it:
        // every later command, auto-save included, then failed with "no project
        // open". The extract stages to a sibling temp and renames, so on failure
        // `dest` is still the file we just closed and re-opening restores the
        // pre-call state (bar the undo history, which the close spent either way).
        let closed = self.close_project_if_open_at(dest);
        match dump.extract_entry_to(entry, dest) {
            Ok(()) => Ok(preserved_view),
            Err(e) => {
                if closed {
                    let reopened = self.open_project(dest.to_path_buf());
                    if reopened.success {
                        tracing::info!(
                            path = %dest.display(),
                            purpose = "undo the pre-replace close after a failed extract",
                            "speleodb: re-opened the project the failed replace had closed"
                        );
                    } else {
                        // Nothing left to try: report it loudly, because the shell is
                        // now showing a project the backend does not have open.
                        tracing::error!(
                            path = %dest.display(),
                            error = ?reopened.error,
                            purpose = "undo the pre-replace close after a failed extract",
                            "speleodb: could not re-open the project after a failed replace"
                        );
                    }
                }
                Err(e.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /// Tripwire: the abandoning replace stays reachable from exactly the sanctioned
    /// places. Everything that pulls the server copy over the local one funnels
    /// through this module, and the whole point of splitting the verb in two is
    /// that opting out of the guard is a deliberate, reviewable act - a future call
    /// site that quietly picks the discarding path would silently reintroduce the
    /// data-loss hole this guard closes.
    ///
    /// The orchestration's source is scanned from HERE rather than from its own
    /// test module so the needles do not match the test that looks for them.
    #[test]
    fn only_the_confirmed_discard_paths_waive_the_guard() {
        let source = include_str!("speleodb.rs");
        // Production code only: the orchestration's own test module drives both
        // verbs on purpose.
        let orchestration = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert_eq!(
            orchestration.matches("LocalEditsPolicy::Discard").count(),
            3,
            "exactly three call sites may discard un-pushed local edits: \
             speleodb_take_remote (the divergence prompt's destroy-confirmed \
             'Take remote'), speleodb_open_project_discarding_local (the same \
             confirmed choice on a refused open), and speleodb_restore_revision \
             under its `discard_local` waiver (a RESTORE only, never a View, after \
             the restore confirm's armed discard step - a restore stamps the copy \
             un-pushed itself, so without it Restore was single-use). Any other \
             site must pass LocalEditsPolicy::Protect, or call \
             replace_cache_stalx, so it refuses instead of destroying work that \
             exists in no git anywhere."
        );
        assert_eq!(
            orchestration
                .matches("replace_cache_stalx_abandoning")
                .count(),
            0,
            "the orchestration reaches the abandoning replace only through the \
             named LocalEditsPolicy, so every waiver is spelled out at its call site"
        );
    }
}
