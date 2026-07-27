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
//! site. Every caller entitled to it arrives from a frontend that has already had
//! the loss confirmed by name: `speleodb_take_remote` (the divergence prompt's
//! destroy-confirmed "Take remote"), `speleodb_open_project_discarding_local` (the
//! same confirmed choice on a refused open), and `speleodb_restore_revision` under
//! its `discard_local` waiver (a Restore only, never a View - a restore stamps the
//! copy un-pushed itself, so without the waiver Restore was single-use). Anything
//! else passes [`LocalEditsPolicy::Protect`], or calls
//! [`AppState::replace_cache_stalx`], and refuses instead.

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
/// For the orchestration paths that serve BOTH kinds of caller with the same
/// mechanics - `speleodb_fast_forward`, the shared body behind
/// `speleodb_open_project` / `speleodb_open_project_discarding_local`, and
/// `speleodb_restore_revision`'s View-vs-Restore split - so the intent is named at
/// every call site instead of riding on a bare `bool`, and so a diff that adds a
/// waiver says `Discard` in it.
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
#[expect(
    clippy::expect_used,
    reason = "unit test fixtures fail loudly on setup errors"
)]
mod tests {
    use super::*;
    use crate::models::{Project, SpeleoLink};
    use crate::persistence::Database;
    use crate::speleodb::dump::Dump;

    const ID: &str = "11111111-1111-1111-1111-111111111111";
    /// The `.stalx` entry inside the fixture dump below.
    const ENTRY: &str = "misc/project.stalx";

    /// Tripwire: the orchestration never names the abandoning replace directly, so
    /// every waiver of the un-pushed-edits guard is spelled out as a
    /// [`LocalEditsPolicy`] at its call site and shows up in a diff as the word
    /// `Discard`. Everything that pulls the server copy over the local one funnels
    /// through this module, and the whole point of splitting the verb in two is that
    /// opting out of the guard is a deliberate, reviewable act.
    ///
    /// The orchestration's source is scanned from HERE rather than from its own test
    /// module so the needle does not match the test that looks for it.
    ///
    /// This test used to ALSO pin the number of `LocalEditsPolicy::Discard` sites at
    /// a literal count. That was not a safety property - it was an assertion about a
    /// source string - and it distorted the code it guarded: `speleodb_adopt_ariane`
    /// rebuilds its destination itself rather than going through
    /// [`AppState::replace_cache_stalx_with`], so it has no policy to pass, and the
    /// enum value was constructed there and immediately compared away purely to keep
    /// the count at four. What holds the line instead is the shape of this module -
    /// the guard is the DEFAULT (`replace_cache_stalx`), the opt-out is a separate
    /// `pub(super)` verb no production code outside this file names (the assertion
    /// this test kept), and the behaviour of both is pinned by the test below.
    #[test]
    fn the_orchestration_never_calls_the_abandoning_replace_directly() {
        let source = include_str!("speleodb.rs");
        // Production code only: the orchestration's own test module drives both
        // verbs on purpose.
        let orchestration = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert_eq!(
            orchestration
                .matches("replace_cache_stalx_abandoning")
                .count(),
            0,
            "the orchestration reaches the abandoning replace only through the \
             named LocalEditsPolicy, so every waiver is spelled out at its call site"
        );
    }

    /// A `.stalx` at `path` linked to [`ID`], carrying the given un-pushed-edits bit.
    fn seed_linked_stalx(path: &Path, dirty: bool) {
        let mut db = Database::open(path).expect("open db");
        db.save_project(&Project::new("Local".to_owned(), None))
            .expect("save project");
        db.save_speleo_link(Some(&SpeleoLink {
            endpoint: "http://x/".to_owned(),
            project_id: ID.to_owned(),
            project_name: "Local".to_owned(),
            base_commit_sha: Some("abc123".to_owned()),
            has_unpushed_edits: dirty,
            last_edit_at: dirty.then(|| "2026-07-27T10:00:00Z".to_owned()),
            last_verify_at: None,
        }))
        .expect("save link");
    }

    /// A one-entry ZIP standing in for a downloaded dump. The body is not a `.stalx`
    /// - nothing here re-opens it, and the point is only whether it reached `dest`.
    fn server_dump() -> Vec<u8> {
        use std::io::Write as _;
        let mut writer = zip::write::ZipWriter::new(std::io::Cursor::new(Vec::<u8>::new()));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file(ENTRY, opts).expect("start_file");
        writer.write_all(b"the server copy").expect("write entry");
        writer.finish().expect("finish zip").into_inner()
    }

    #[test]
    fn only_a_named_discard_gets_a_replace_past_un_pushed_edits() {
        // The behaviour the split verb exists for, pinned from all three sides: the
        // default replace refuses over un-pushed work and leaves the file alone, the
        // policy-driven form agrees under `Protect`, and `Discard` is the ONLY thing
        // that gets through. A caller that wants the destruction has to name it.
        let temp = tempfile::TempDir::new().expect("temp");
        let dest = temp.path().join("project.stalx");
        seed_linked_stalx(&dest, true);
        let before = std::fs::read(&dest).expect("read dest");
        let state = AppState::new().expect("state");
        let zip = server_dump();

        let err = state
            .replace_cache_stalx(&mut Dump::open(&zip).expect("open dump"), ENTRY, &dest, ID)
            .expect_err("un-pushed edits must refuse the plain replace");
        assert!(
            matches!(err, SpeleoDbError::WouldDiscardLocalEdits { .. }),
            "and refuse it with the typed routing signal, got {err:?}"
        );
        assert_eq!(
            std::fs::read(&dest).expect("read dest"),
            before,
            "a refusal must leave the local copy byte-identical"
        );

        let err = state
            .replace_cache_stalx_with(
                &mut Dump::open(&zip).expect("open dump"),
                ENTRY,
                &dest,
                ID,
                LocalEditsPolicy::Protect,
            )
            .expect_err("Protect is the same refusal");
        assert!(matches!(err, SpeleoDbError::WouldDiscardLocalEdits { .. }));
        assert_eq!(
            std::fs::read(&dest).expect("read dest"),
            before,
            "still untouched"
        );

        state
            .replace_cache_stalx_with(
                &mut Dump::open(&zip).expect("open dump"),
                ENTRY,
                &dest,
                ID,
                LocalEditsPolicy::Discard,
            )
            .expect("the confirmed-discard waiver replaces the copy");
        assert_eq!(
            std::fs::read(&dest).expect("read dest"),
            b"the server copy",
            "and only that waiver actually overwrites it"
        );
    }

    #[test]
    fn a_clean_copy_is_replaced_without_any_waiver() {
        // The other half: `Protect` is not "always refuse". With nothing un-pushed
        // there is no work to lose, so an ordinary re-pull goes straight through.
        let temp = tempfile::TempDir::new().expect("temp");
        let dest = temp.path().join("project.stalx");
        seed_linked_stalx(&dest, false);
        let state = AppState::new().expect("state");
        let zip = server_dump();

        state
            .replace_cache_stalx(&mut Dump::open(&zip).expect("open dump"), ENTRY, &dest, ID)
            .expect("a clean local copy needs no waiver");
        assert_eq!(
            std::fs::read(&dest).expect("read dest"),
            b"the server copy",
            "the server copy landed"
        );
    }
}
