//! [#218] SpeleoDB revision history and the View / Restore swap.
//!
//! Split out of `core/state/speleodb.rs` (which is frozen at the file-size ratchet
//! warn line) into a sibling `impl AppState` block.
//!
//! The two modes share one command and differ in what they promise. A **Restore**
//! rides FORWARD on HEAD: the chosen tree lands in the working copy as an unpushed
//! edit with BASE stamped at the CURRENT server tip, so history is never rewritten
//! and the next push is an ordinary push. A **View** is a read-only peek that pins
//! BASE to the viewed hexsha and stays clean, so the next Update fast-forwards it
//! away. Both replace the cache `.stalx` and reload the project - a View is not
//! ephemeral, only reversible.

use super::speleodb::{local_dto, validate_project_id};
use super::speleodb_cache::{restore_display_settings, LocalEditsPolicy};
use super::speleodb_pull::ArianeRoute;
use super::AppState;
use crate::speleodb::contract::{dto_for_error, Endpoint};
use crate::speleodb::models::SpeleoRevision;
use crate::speleodb::{client, dump, sync};
use crate::speleodb::{SpeleoDbError, SpeleoErrorDto, SpeleoOpenResult};

/// [#218] Validate a git commit SHA supplied over IPC (revision restore) before it
/// is interpolated into the download-at-hash URL. A git object id is 7..=40 lowercase
/// or uppercase hex digits (the `/revisions/` endpoint returns full 40-hex ids; a
/// short prefix is also accepted). Rejecting anything else closes the route-traversal
/// vector at the trust boundary, mirroring [`validate_project_id`].
pub(super) fn validate_hexsha(hexsha: &str) -> Result<(), SpeleoDbError> {
    let len = hexsha.len();
    if (7..=40).contains(&len) && hexsha.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(SpeleoDbError::InvalidRevision)
    }
}

/// [#218] The BASE / dirty stamp for a revision swap, keyed on the mode. Pure (no
/// I/O, no clock) so both branches are unit-testable in isolation from the download.
///
/// - **Restore** (`restore == true`): the old tree rides as an unpushed edit ON TOP
///   of the current server HEAD, so BASE = `server_tip` and the dirty bit is set. A
///   push lands it as a forward commit (SpeleoDB exposes no server-side revert).
/// - **View** (`restore == false`): BASE = the viewed `hexsha` itself and the copy is
///   clean, so the working tree IS that revision (behind tip) and a later Update
///   fast-forwards straight back to the latest.
///
/// `server_tip` is `None` only when the HEAD fetch failed with no fallback; the caller
/// prefers the open link's last-known BASE over `None` so the next fence can't read a
/// spurious `Diverged`.
fn revision_swap_base(
    restore: bool,
    hexsha: &str,
    server_tip: Option<String>,
) -> (Option<String>, bool) {
    if restore {
        (server_tip, true)
    } else {
        (Some(hexsha.to_owned()), false)
    }
}

impl AppState {
    /// [#218] The project's revision history for the read-only history view:
    /// `GET /projects/{id}/revisions/`, projected to [`SpeleoRevision`] DTOs (no
    /// token, only the display fields). Takes an arbitrary project id (a GlobalView
    /// remote row need not be the open project), so it validates the id at the trust
    /// boundary exactly like `speleodb_release_lock`, then reuses the same server-head
    /// fetch the sync path uses. The server's own order is NOT preserved: the list is
    /// re-ordered newest-first by walking the parent chain from the tip (the server
    /// sorts by `authored_date`, which ties on a freshly-created project), and the
    /// automated project-creation commit is dropped - so a project with nothing but
    /// that commit yields an empty list. Both live in [`sync::display_history`], which
    /// touches this view only; every fence reads the raw history. No lock required
    /// (reading history is permission-free).
    pub(crate) fn speleodb_get_revisions(
        &self,
        project_id: String,
    ) -> Result<Vec<SpeleoRevision>, SpeleoErrorDto> {
        validate_project_id(&project_id).map_err(local_dto)?;
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();
        let (_, commits) = self
            .speleodb_server_head(&endpoint, &token, insecure_http, &project_id)
            .map_err(|e| dto_for_error(Endpoint::GetProject, &e))?;
        // Display ordering + the creation-commit filter live in `sync` so they are
        // unit-tested offline, and so it is obvious they touch ONLY this view: every
        // fence reads the raw history through `speleodb_server_head` directly.
        Ok(sync::display_history(commits)
            .into_iter()
            .map(SpeleoRevision::from)
            .collect())
    }

    /// [#218] Check the open remote project's working copy out to a past revision.
    /// Download the project tree AT `hexsha` (the server's `FileDownloadAtHashView`),
    /// replace the cached `.stalx`, re-stamp the hand-off link, and reopen the swapped
    /// tree in place. Two modes, keyed on `restore`:
    ///
    /// - `restore == true` (**Restore**, the user holds the lock): a git-FORWARD
    ///   restore. BASE stays at the CURRENT server HEAD and `has_unpushed_edits` is set
    ///   true, so the tree rides as an unpushed edit ON TOP of HEAD; editing is
    ///   re-enabled. The normal push / Done flow lands the old content as a NEW commit,
    ///   so project history is never rewritten (SpeleoDB exposes no server-side revert).
    /// - `restore == false` (**View**, read-only, no lock): BASE = `hexsha` and the
    ///   copy is stamped CLEAN, so the working tree IS that revision, behind tip. The
    ///   project stays read-only and a later Update fast-forwards straight back to the
    ///   latest - a non-destructive peek.
    ///
    /// Both ids are validated at the trust boundary before the download URL is built,
    /// and the swap is BOUND to the open project (a mismatched id is refused). A
    /// force-edit session (#213) is refused outright (both View and Restore), and
    /// Restore additionally requires the write lock genuinely held - the backend never
    /// trusts the FE's View/Restore choice. Returns the local path (like a pull); the
    /// FE pulls the swapped geometry.
    pub(crate) fn speleodb_restore_revision(
        &self,
        project_id: String,
        project_name: String,
        hexsha: String,
        restore: bool,
        discard_local: bool,
        entry_path: Option<String>,
    ) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
        validate_project_id(&project_id).map_err(local_dto)?;
        validate_hexsha(&hexsha).map_err(local_dto)?;

        // Bind to the OPEN project. A revision swap replaces the whole tree in place,
        // so a stale / mismatched FE project_id must never close the open project and
        // swap in a DIFFERENT cached one behind the unsaved-changes guard - every other
        // edit verb goes through the open link, and so does this.
        let open_link = self.speleodb_open_link().map_err(local_dto)?;
        if open_link.project_id != project_id {
            return Err(local_dto(SpeleoDbError::NoRemoteProject));
        }
        // [#213] A force-edit session holds unsaved edits with NO lock protecting them.
        // Swapping the tree (View OR Restore) would silently clobber that work, and
        // clearing force_editing below would hide the big-red "no lock held" warning.
        // Refuse both until the user finishes or discards the force-edit session.
        if self.force_editing() {
            return Err(local_dto(SpeleoDbError::Io(
                "finish or discard force-editing before viewing or restoring a revision".to_owned(),
            )));
        }
        // Restore (editable) additionally requires the write lock genuinely held (with
        // force-editing already excluded above, edit_enabled here means a real lock).
        // View is a read-only peek and needs no lock.
        if restore && !self.edit_enabled() {
            return Err(local_dto(SpeleoDbError::Io(
                "acquire the write lock before restoring a revision".to_owned(),
            )));
        }

        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();

        let zip = self
            .speleodb_handle_auth(
                Endpoint::DownloadDump,
                client::download_dump_at_hash(
                    &endpoint,
                    &token,
                    insecure_http,
                    &project_id,
                    &hexsha,
                ),
            )
            .map_err(|e| dto_for_error(Endpoint::DownloadDump, &e))?;

        // Open the dump once: list entries (to classify) and extract the chosen
        // `.stalx` from the same parsed archive (identical to the pull path).
        let mut dump = dump::Dump::open(&zip).map_err(local_dto)?;
        // [#258] Consults the session's existing answer, so a user who resolved the
        // ambiguity when they OPENED the project - before any lock existed - is not
        // asked again here, where asking costs a lock round trip.
        // Ariane data REFUSES here rather than routing to adoption: adoption imports
        // the project's tip, so on a revision swap it would answer a question about
        // `hexsha` with today's contents, and there is no import-at-hash path to do
        // otherwise. The resolver records the user's pick itself when it honours one;
        // re-recording it here would also record an entry nobody chose, turning an
        // unambiguous revision's sole `.stalx` into a standing session answer.
        let entry = self
            .speleodb_resolve_entry_remembering(
                &project_id,
                &mut dump,
                entry_path.as_deref(),
                ArianeRoute::Refuse,
            )
            .map_err(local_dto)?;

        let dest = self.speleodb_cache_path(&project_id).map_err(local_dto)?;
        // Carry the user's local view toggles across the download-replace, same as a
        // re-pull (display_settings are stripped from the server copy), and drop the
        // live handle to this file first - the reload below re-opens it anyway, so
        // hoisting the close ahead of the extract costs nothing and keeps the swap
        // off a mmap'd/locked destination.
        //
        // GUARDED BY DEFAULT: a revision swap replaces the whole working tree, so
        // with un-pushed edits present it destroys them - for View just as much as
        // for Restore, which makes the documented "non-destructive peek" untrue in
        // exactly the case where the user has most to lose.
        //
        // `discard_local` is the ONE waiver, and only a Restore may carry it, after
        // the frontend's second confirmation has named the edits being discarded
        // (`SpeleoRestoreDialog`'s armed discard step). It exists because a restore
        // STAMPS the working copy as un-pushed itself, so the guard otherwise made
        // Restore single-use: restoring a second revision - or reverting a restore
        // the user disliked - refused over edits the previous restore had just
        // created, reported as "local edits never pushed". A View can never waive
        // it: a read-only peek has no confirmation surface and must stay
        // non-destructive.
        let policy = if restore && discard_local {
            LocalEditsPolicy::Discard
        } else {
            LocalEditsPolicy::Protect
        };
        let preserved_view = self
            .replace_cache_stalx_with(&mut dump, &entry, &dest, &project_id, policy)
            .map_err(local_dto)?;

        // Restore rides ON TOP of the current server HEAD (BASE = tip, dirty SET).
        // Resolve HEAD from the revision topology; if that blips, fall back to the open
        // link's last-known BASE rather than `None` - a None BASE + dirty makes the next
        // fence read `Diverged` and forces a spurious divergence prompt after a simple
        // restore. View pins BASE to the viewed revision (see `revision_swap_base`).
        let server_tip = if restore {
            match client::get_revisions(&endpoint, &token, insecure_http, &project_id) {
                Ok(history) => sync::tip_of(&history.commits)
                    .map(str::to_owned)
                    .or_else(|| open_link.base_commit_sha.clone()),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        project_id = %project_id,
                        purpose = "resolve server HEAD on restore",
                        "speleodb_restore_revision: could not resolve server HEAD; falling back to last-known BASE"
                    );
                    open_link.base_commit_sha.clone()
                }
            }
        } else {
            None
        };
        let (base_sha, has_unpushed_edits) = revision_swap_base(restore, &hexsha, server_tip);
        // `last_edit_at = now` on Restore so the g7 push-start comparison treats it as
        // an edit; View stays clean and carries no edit timestamp.
        let last_edit_at = has_unpushed_edits.then(|| chrono::Utc::now().to_rfc3339());

        match crate::persistence::Database::open_existing(&dest) {
            Ok(db) => {
                restore_display_settings(&db, &preserved_view);
                let link = crate::models::SpeleoLink {
                    endpoint,
                    project_id: project_id.clone(),
                    project_name,
                    base_commit_sha: base_sha,
                    has_unpushed_edits,
                    last_edit_at,
                    last_verify_at: None,
                };
                if let Err(e) = db.save_speleo_link(Some(&link)) {
                    tracing::warn!(
                        error = %e,
                        project_id = %project_id,
                        purpose = "stamp SpeleoDB hand-off link on restore",
                        "speleodb_restore_revision: failed to stamp speleo_link; project may open local-only"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "stamp SpeleoDB hand-off link on restore",
                    "speleodb_restore_revision: could not reopen extracted .stalx to stamp speleo_link"
                );
            }
        }

        let local_path = dest.to_string_lossy().into_owned();
        // Reopen the swapped tree in place. close_project drops the live handle to
        // `dest` so do_load_project_full's "already open" guard won't reject the same
        // path (and the reopened connection reads the overwritten file, not a stale
        // page cache). A fresh load of a remote project defaults to read-only (#191):
        // for Restore the user holds the lock, so re-enable editing (the restored tree
        // is a pushable unpushed edit); for View leave it read-only (a peek that Update
        // fast-forwards away). Mirrors the fast-forward reload (#193); the FE then
        // pulls the swapped geometry via refreshProjectState.
        //
        // `replace_cache_stalx` above already closed the project when it WAS this
        // file, and replaced it atomically (temp + rename), so the reopen below reads
        // a whole file rather than a possibly-torn one. This close stays because it
        // is not guaranteed to have fired (a stale/never-opened cache path) and it is
        // a cheap no-op when it did.
        //
        // Captured BEFORE the reload, which shuts the gate: a status poll landing in
        // that window clears the acquisition record for a lock we still genuinely
        // hold, and the `if restore` block below reopens the GATE without it - so the
        // record would be gone for good and our own landed push would later read as a
        // conflict. The third in-place reload site, alongside both fast-forward arms.
        //
        // Unlike `speleodb_update`'s arm this needs no gate/force PAIR: Restore's
        // entry guards above already refused a force-editor and already required an
        // open gate, so the record alone cannot mint - it is only ever handed back to
        // a session that demonstrably had one on the way in.
        let had_lock_record = self.speleodb_lock_acquired_here(&project_id);
        self.close_project();
        self.do_load_project_full(dest).map_err(|e| {
            local_dto(SpeleoDbError::Io(format!(
                "reload after restore failed: {e}"
            )))
        })?;
        if restore {
            self.set_edit_enabled(true);
            if had_lock_record {
                self.speleodb_note_lock_acquired(Some(&project_id));
            }
        }
        self.set_force_editing(false);

        Ok(SpeleoOpenResult {
            local_path,
            concurrent_session: false,
        })
    }
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use super::{revision_swap_base, validate_hexsha};
    use crate::speleodb::SpeleoDbError;

    /// The production region of this file, split out of the test module so the
    /// source-level tripwire below cannot match its own assertions.
    fn prod_source() -> &'static str {
        include_str!("speleodb_revisions.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production region precedes the test module")
    }

    #[test]
    fn restore_hands_the_acquisition_record_back_across_its_reload() {
        // The THIRD in-place reload site, and the one that was missed. A Restore is
        // only reachable with the write lock genuinely held (its entry guards refuse a
        // force-editor and require an open gate), yet it closes the project and
        // reloads it - and a fresh load of a remote project is read-only, so the gate
        // is shut for the length of that reload. A status poll landing in the window
        // clears the acquisition record, and the `if restore` block reopened the GATE
        // without it: the record was gone permanently, and our own next landed push
        // came back as a Conflict.
        //
        // Structural for the same reason as its two siblings above: the reload
        // resolves an app cache dir that only the env-gated live tests initialise, so
        // there is no unit-level seam to observe the restore through.
        let restore = prod_source()
            .split_once("fn speleodb_restore_revision")
            .map(|(_, rest)| rest)
            .and_then(|rest| rest.split("\n    /// ").next())
            .expect("speleodb_restore_revision body precedes the next item's doc");
        assert!(
            restore.contains("let had_lock_record = self.speleodb_lock_acquired_here("),
            "Restore must capture the acquisition record before its reload"
        );
        assert!(
            restore.contains("self.speleodb_note_lock_acquired(Some(&project_id));"),
            "and hand it back afterwards - reopening the gate alone leaves a lock we \
             still hold with no provenance for the push we are about to make"
        );
        let capture = restore
            .find("let had_lock_record")
            .expect("capture present (asserted above)");
        let reload = restore
            .find("self.do_load_project_full(")
            .expect("the in-place reload is what shuts the gate");
        let restore_back = restore
            .find("self.speleodb_note_lock_acquired(Some(&project_id));")
            .expect("re-record present (asserted above)");
        assert!(
            capture < reload && reload < restore_back,
            "capture BEFORE the reload (it is the last point the pre-reload truth \
             exists) and re-record AFTER it (a record written before the reload is \
             what the poll in that window drops)"
        );
        assert!(
            restore.contains("if had_lock_record {"),
            "and gate the hand-back on the captured record - re-recording \
             unconditionally would MINT provenance for an inherited lock"
        );
    }

    #[test]
    fn validate_hexsha_accepts_git_ids_rejects_traversal() {
        // #218 restore: a full 40-hex commit id and a shorter prefix both pass.
        assert!(validate_hexsha("0123456789abcdef0123456789abcdef01234567").is_ok());
        assert!(validate_hexsha("abc1234").is_ok());
        assert!(validate_hexsha("ABCDEF0").is_ok()); // upper-case hex accepted
                                                     // Anything that could reshape the download-at-hash URL is rejected before
                                                     // it is interpolated into the path (route traversal / injection).
        for bad in [
            "",
            "abc123",                                    // 6 chars: below the 7-min
            "0123456789abcdef0123456789abcdef012345678", // 41 chars: over the 40-max
            "abc123g",                                   // non-hex digit
            "../../etc",
            "abc/1234",
            "abc 1234",
        ] {
            assert!(
                matches!(validate_hexsha(bad), Err(SpeleoDbError::InvalidRevision)),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn revision_swap_base_stamps_restore_on_tip_view_on_hexsha() {
        // #218 Restore: BASE = the resolved server tip and the copy is dirty (rides as
        // an unpushed edit on top of HEAD).
        let (base, dirty) = revision_swap_base(true, "abc1234", Some("deadbeefcafe".to_owned()));
        assert_eq!(base.as_deref(), Some("deadbeefcafe"));
        assert!(dirty, "restore must set the dirty bit");

        // Restore with no resolvable tip (the caller's fallback already yielded None):
        // BASE stays None and the copy is still dirty. It is NOT stamped with the viewed
        // hexsha - a restore never pins BASE to the old revision.
        let (base, dirty) = revision_swap_base(true, "abc1234", None);
        assert_eq!(base, None);
        assert!(dirty);

        // View: BASE = the viewed hexsha itself and the copy is clean, so the working
        // tree IS that revision (a later Update fast-forwards back). The server tip is
        // irrelevant to View and must be ignored.
        let (base, dirty) = revision_swap_base(false, "abc1234", Some("deadbeefcafe".to_owned()));
        assert_eq!(base.as_deref(), Some("abc1234"));
        assert!(!dirty, "view must leave the copy clean");
    }
}
