//! The SpeleoDB SESSION generation and the guards built on it.
//!
//! There is no session object in this codebase: what the UI calls an edit
//! session is the `project` slot, two gate booleans and a `lock_acquired_here`
//! record, none of which can tell "the same project, before and after a
//! teardown" apart (`docs/plans/2026-07-30_speleodb-lock-session-races.md`).
//! This module adds the missing discriminator - a monotonic generation bumped
//! on every session boundary - plus the two guards F7/F8 need:
//!
//! - **The commit guard** ([`AppState::speleodb_commit_editing`]): Start
//!   Editing runs three network round trips between reading the open project
//!   and opening its edit gate. The guard re-checks, under the `project`
//!   mutex, that the world it started from is still there before a single bit
//!   is committed - a delete / close / switch / logout landing inside the
//!   window now refuses the commit (F7) instead of opening a gate onto a
//!   torn-down world and minting a claim nothing can ever release.
//! - **The reclaim check** ([`AppState::speleodb_release_unless_reclaimed`]):
//!   a release captured by a session that has since ended (the delete's
//!   captured release, the janitor below) must stand down when a SUCCESSOR
//!   session has meanwhile claimed the same project's mutex - the server
//!   treats a same-account re-acquire as a no-op, so the successor inherited
//!   the very lock the stale release would free (F8). The check has TWO eyes,
//!   because a successor accounts for the lock in two shapes: a claim record
//!   (its probe proved the mutex unheld, so it recorded an acquisition) and a
//!   live edit session WITHOUT one (its probe saw the account still holding -
//!   the pending release had not POSTed - so it inherited, and an inheritance
//!   deliberately mints no record). Reading only the record frees the mutex
//!   out from under exactly the inherited successors the stand-down exists
//!   for - see [`AppState::speleodb_live_session_accounts_for`].
//!
//! What makes the reclaim check sound is the `speleodb_lock_ops` mutex: Start
//! Editing holds it across probe -> commit (from BEFORE the pre-acquire
//! holder probe, so a captured release cannot invalidate the provenance the
//! probe read before the acquire runs), and every reclaim-checked release
//! holds it across check -> POST, so a claim can never be minted between a
//! release's decision and its network call. Deliberately held across
//! network I/O - which is exactly why it is OUTERMOST: nothing that holds
//! `project` / `database` / `undo_stack` may block on it (decide under
//! `project`, drop, then take it), and code already inside a lock-ops span
//! uses the `_locked` variants instead of re-taking it.
//!
//! ## Generation rules
//!
//! 1. Bumped ONLY while holding the `project` mutex. The commit guard checks
//!    and commits under that same mutex, so a boundary either happens entirely
//!    before the commit (and is seen) or entirely after (and finds the commit
//!    already made by a live session).
//! 2. A bump means "the session ended or another began": committing a project
//!    into the slot (open / create / the fast-forward reload), clearing it
//!    (close, which delete and project-switch route through), and logout
//!    (which ends the edit session without touching the slot - footgun 5.8).
//! 3. NOT a bump: an undo rollback (`restore_snapshot_into` restores the SAME
//!    open project - footgun 5.7), and every save (`save_project` never
//!    replaces the slot; a Save a Copy does not even move `file_path`).
//!
//! The bump-site inventory is pinned by `bump_sites_are_exactly_the_known_set`
//! below - a new project-slot writer that forgets to classify itself trips it.

use std::sync::atomic::Ordering;

use super::speleodb::local_dto;
use super::speleodb_lock_release::LockReleaseParams;
use super::AppState;
use crate::speleodb::{client, SpeleoDbError, SpeleoErrorDto};

impl AppState {
    /// Record a session boundary. Call ONLY while holding the `project` mutex
    /// (rule 1 above); every call site takes a `_proj_guard`-shaped local or
    /// sits inside a block that owns one.
    pub(super) fn bump_speleodb_session(&self) {
        self.speleodb_session_generation
            .fetch_add(1, Ordering::SeqCst);
    }

    /// The current session generation. Meaningful for equality comparison only.
    pub(super) fn speleodb_session_generation(&self) -> u64 {
        self.speleodb_session_generation.load(Ordering::SeqCst)
    }

    /// The generation and the open project's validated link, read together
    /// under the `project` mutex so they describe ONE world. Start Editing's
    /// entry point: capturing them separately is D6 from the abandoned attempt
    /// (a teardown between the two reads pairs the old world's generation with
    /// the new world's link, and the eventual refusal then unwinds the lock of
    /// the project the user actually has open).
    pub(super) fn speleodb_session_snapshot(
        &self,
    ) -> Result<(u64, crate::models::SpeleoLink), SpeleoErrorDto> {
        let _proj_guard = self
            .project
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let generation = self.speleodb_session_generation();
        let link = self.speleodb_open_link().map_err(local_dto)?;
        super::speleodb::validate_project_id(&link.project_id).map_err(local_dto)?;
        Ok((generation, link))
    }

    /// Start Editing's commit: open the edit gate, mint the acquisition record
    /// (when `acquired_here`), and clear force-edit - IF the session the caller
    /// started from is still the session on screen. All under one `project`
    /// acquisition, which is what makes the check and the commit atomic against
    /// every bump site (rule 1).
    ///
    /// `entry_generation`:
    /// - `Some(gen)` - the UpToDate arm: refuse if ANY session boundary passed
    ///   since the entry snapshot.
    /// - `None` - the fast-forward arm, whose own in-place reload IS a session
    ///   boundary (close + reopen), so a generation captured at entry is
    ///   guaranteed stale by the time it commits. Identity does the work
    ///   instead: the open project must still be linked to `project_id`. The
    ///   residual this accepts is benign by construction - if a teardown AND a
    ///   re-open of the SAME project raced the reload, the commit lands on a
    ///   world where that project is open at its canonical path and this
    ///   process genuinely holds its mutex (the acquire happened and nothing
    ///   released it), so gate + record + lock still agree.
    ///
    /// On refusal nothing has been committed: the gate stays as the successor
    /// world set it, and no record is minted. The caller decides what to do
    /// with the server lock it acquired - see
    /// [`AppState::speleodb_unwind_release`].
    pub(super) fn speleodb_commit_editing(
        &self,
        entry_generation: Option<u64>,
        project_id: &str,
        acquired_here: bool,
    ) -> Result<(), SpeleoDbError> {
        let _proj_guard = self
            .project
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(expected) = entry_generation {
            if self.speleodb_session_generation() != expected {
                return Err(SpeleoDbError::SessionMoved);
            }
        }
        // Identity, not just epoch: the open project must still be linked to
        // the project this flow acquired for. Under `Some(gen)` this is
        // belt-and-braces over the generation (a missed bump site degrades to
        // a same-project blind spot instead of a wrong-project commit); under
        // `None` it is the whole check.
        let open = self
            .speleodb_open_link()
            .map_err(|_| SpeleoDbError::SessionMoved)?;
        if open.project_id != project_id {
            return Err(SpeleoDbError::SessionMoved);
        }
        self.set_edit_enabled(true);
        // AFTER the gate opens, never before - a status poll landing in between
        // would see a shut gate and clear the record again
        // (`speleodb_forget_lock_acquired_if_gate_shut`). Only where the
        // pre-acquire probe proved the mutex was free: keeping a lock we
        // INHERITED is an edit session, not an acquisition.
        if acquired_here {
            self.speleodb_note_lock_acquired(Some(project_id));
        }
        // #213: we now genuinely hold the lock, so clear force-edit - the
        // "reconnect" transition for a force-editor, a no-op otherwise.
        self.set_force_editing(false);
        // #202: a fresh-verdict commit (UpToDate) confirmed BASE == tip as of the
        // acquire, so start the lazy re-verify window here (best-effort; a failed
        // stamp just makes the first edit re-verify sooner). The fast-forward arm
        // passes `None` and does NOT stamp here - its reload already re-stamped
        // the link, `last_verify_at` included.
        if entry_generation.is_some() {
            let _ = self.speleodb_mutate_link(|l| {
                l.last_verify_at = Some(chrono::Utc::now().to_rfc3339());
            });
        }
        Ok(())
    }

    /// Forget the acquisition record IF the edit gate is (still) shut. The poll's
    /// catch-all for the release paths that do not run through a release verb:
    /// close, project switch, logout, take-remote, the 401 auto-drop, the
    /// lost-lock re-verify.
    ///
    /// Re-reads the gate HERE, under the session lock, instead of trusting the
    /// caller's earlier snapshot - which a fast-forward finishing underneath an
    /// in-flight poll makes stale. That fast-forward reopens the gate and
    /// restores a record for a lock we genuinely still hold; acting on the stale
    /// snapshot would erase it and cost the authorship shortcut on our own lock.
    /// Comparing project ids instead does NOT close this: the poll and the
    /// fast-forward are on the same project, so the ids match and the clear
    /// fires anyway. Which is exactly why this is NOT the same helper as
    /// `speleodb_forget_lock_acquired_for`, whose race an id comparison DOES
    /// close because its interloper is a DIFFERENT project. Same field, two
    /// different legitimacy tests - see there before unifying them.
    ///
    /// Sound because every writer opens the gate BEFORE recording (the commit
    /// above, and `speleodb_update`'s fast-forward arm) and needs this same
    /// mutex to record: either the writer released the mutex before we took it -
    /// its gate store visible across that edge, so we see an open gate and
    /// decline - or it has not recorded yet, and its write lands after our clear
    /// and stands.
    pub(super) fn speleodb_forget_lock_acquired_if_gate_shut(&self) {
        let Ok(mut session) = self.speleodb_session_lock() else {
            return;
        };
        if !self.edit_enabled() {
            session.lock_acquired_here = None;
        }
    }

    /// The unwind release for Start Editing's abort arms, now that a session
    /// boundary can have passed mid-flight. Same session: exactly the release
    /// this always was (`speleodb_release_best_effort`, which also ends OUR
    /// acquisition record). Session moved: the record is NOT ours to touch
    /// (footgun 5.5 / D1 - the refusal fires precisely when another session
    /// may have minted its own claim), so release the lock raw - and only if
    /// no successor has claimed this project's mutex, which the caller's
    /// lock-ops span makes a stable answer.
    ///
    /// Called ONLY from inside Start Editing's lock-ops span - hence the
    /// `_locked` reclaim variant; taking `speleodb_lock_ops` here would
    /// self-deadlock.
    pub(super) fn speleodb_unwind_release(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        project_id: &str,
        entry_gen: u64,
    ) {
        if self.speleodb_session_generation() == entry_gen {
            self.speleodb_release_best_effort(endpoint, token, insecure_http, project_id);
            return;
        }
        let params = LockReleaseParams {
            endpoint: endpoint.to_owned(),
            token: token.to_owned(),
            insecure_http,
            project_id: project_id.to_owned(),
        };
        if let Err(e) = self.speleodb_release_unless_reclaimed_locked(&params) {
            tracing::warn!(
                error = %e,
                project_id,
                purpose = "hand back a lock acquired by a session that no longer exists",
                "speleodb: post-session-move unwind release failed"
            );
        }
    }

    /// Serialized, reclaim-checked release: takes the lock-ops mutex, then
    /// releases `params.project_id`'s mutex UNLESS a live claim for it exists -
    /// in which case a successor session inherited the lock (a same-account
    /// re-acquire is a server-side no-op) and releasing would free the mutex
    /// out from under them (F8). Standing down reports `Ok`: the lock is held
    /// by a session that accounts for it, so nothing is stranded.
    ///
    /// For releases that run detached from the session that captured them (the
    /// delete's captured release, the janitor). Callers already inside a
    /// lock-ops span use [`Self::speleodb_release_unless_reclaimed_locked`].
    pub(super) fn speleodb_release_unless_reclaimed(
        &self,
        params: &LockReleaseParams,
    ) -> Result<(), SpeleoDbError> {
        let _lock_ops = self
            .speleodb_lock_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.speleodb_release_unless_reclaimed_locked(params)
    }

    /// Whether a LIVE edit session currently accounts for `project_id`'s server
    /// mutex: the open project is linked to it and the edit gate is open without
    /// force-edit (a force-editor holds no lock by definition). Link and gate
    /// are read under the `project` mutex so they describe one world.
    ///
    /// This is the reclaim check's second eye. A successor session that
    /// INHERITED the account's lock never minted an acquisition record - its
    /// probe saw the mutex already held (the capturing session's release had
    /// not POSTed yet), and recording an inheritance as an acquisition is the
    /// footgun the probe exists to prevent - so a reclaim check that reads only
    /// `lock_acquired_here` frees the mutex out from under exactly the
    /// successors the stand-down is for. The gate + link ARE that successor's
    /// footprint: its commit opened the gate on a project linked to this id,
    /// under the same lock-ops span that keeps this answer stable.
    pub(super) fn speleodb_live_session_accounts_for(&self, project_id: &str) -> bool {
        let _proj_guard = self
            .project
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.edit_enabled() || self.force_editing() {
            return false;
        }
        self.speleodb_open_link()
            .is_ok_and(|link| link.project_id == project_id)
    }

    /// The body of [`Self::speleodb_release_unless_reclaimed`], for callers that
    /// already hold the lock-ops mutex. Never touches `lock_acquired_here`: a
    /// record present here is by definition a successor's (the capturing
    /// session's own record was cleared when the release was captured), and a
    /// record absent needs no clearing.
    ///
    /// Two stand-down tests, one per successor shape: the claim record (a
    /// successor whose acquire was real - the lock was freed out-of-band, or a
    /// re-record path outside the lock-ops span minted it) and the live edit
    /// session (a successor that inherited and so, deliberately, has no
    /// record). Either one means the lock is accounted for.
    pub(super) fn speleodb_release_unless_reclaimed_locked(
        &self,
        params: &LockReleaseParams,
    ) -> Result<(), SpeleoDbError> {
        if self.speleodb_lock_acquired_here(&params.project_id)
            || self.speleodb_live_session_accounts_for(&params.project_id)
        {
            tracing::info!(
                project_id = %params.project_id,
                purpose = "avoid freeing a successor session's mutex",
                "speleodb: standing down a captured release; a live session has \
                 reclaimed this project's lock"
            );
            return Ok(());
        }
        client::release_lock(
            &params.endpoint,
            &params.token,
            params.insecure_http,
            &params.project_id,
        )
        .map(|_| ())
    }

    /// The guard Start Editing holds across acquire -> commit (see the module
    /// doc). A poisoned mutex is recovered: the guarded value is `()`, so there
    /// is no state to protect - only the serialization matters.
    pub(super) fn speleodb_lock_ops_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.speleodb_lock_ops
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The stranded-claim janitor: with NO project open, a surviving
    /// `lock_acquired_here` record can only belong to a session that no longer
    /// exists (records are minted under the `project` mutex with a project
    /// open), so clear it and hand its lock back. Called from the
    /// `NoRemoteProject` branch of `speleodb_link_status` - the one state the
    /// old catch-all (`speleodb_forget_lock_acquired_if_gate_shut`) could never
    /// reach, because that branch returned before it (F7's leftover damage).
    ///
    /// The decision - and the clear - happen under the `project` mutex, so a
    /// racing open/commit serializes against them; the network release happens
    /// after that guard drops (never network under `project`), reclaim-checked
    /// under lock-ops so a Start Editing that slipped in between keeps the
    /// mutex it just claimed.
    ///
    /// The record is the ONLY pointer to the stranded lock, so it is cleared
    /// exactly when the cleanup can no longer need it: an unusable project id
    /// clears it permanently (it can never be joined into a URL), and a usable
    /// one is cleared only once a release POST is in hand - signed out, the
    /// record stays so the first poll after a sign-in retries, and a failed
    /// POST puts it back (below) so the next poll of this branch retries too.
    /// A take-first shape lost the record to a transient network blip and
    /// turned "retry on the next poll" into a promise nothing could keep.
    pub(super) fn speleodb_janitor_stranded_claim(&self) {
        let params = {
            let proj_guard = self
                .project
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if proj_guard.is_some() {
                return;
            }
            let project_id = {
                let Ok(mut session) = self.speleodb_session_lock() else {
                    return;
                };
                let Some(project_id) = session.lock_acquired_here.clone() else {
                    return;
                };
                if super::speleodb::validate_project_id(&project_id).is_err() {
                    // Never joined into a URL, and never releasable: clearing
                    // is the only safe end for an unusable id.
                    session.lock_acquired_here = None;
                    return;
                }
                project_id
            };
            // Session guard dropped for the token read - `active_token` takes it
            // itself. `proj_guard` is still held, so no session can begin.
            let Ok((endpoint, token)) = self.speleodb_active_token() else {
                // No token, no POST. Keep the record: it describes a dead
                // session either way, but with no project open it drives
                // nothing except this janitor, and the poll after a sign-in
                // walks this branch again WITH a token.
                return;
            };
            if let Ok(mut session) = self.speleodb_session_lock() {
                // This exact record, not whatever is there - the only writer
                // that could slip into the unguarded gap above is a clear.
                if session.lock_acquired_here.as_deref() == Some(project_id.as_str()) {
                    session.lock_acquired_here = None;
                }
            }
            tracing::info!(
                project_id = %project_id,
                purpose = "clean up after a torn-down edit session",
                "speleodb: clearing a lock claim with no project open"
            );
            LockReleaseParams {
                endpoint,
                token,
                insecure_http: self.speleodb_insecure_http(),
                project_id,
            }
        };
        // One lock-ops span over release AND restore: a Start Editing cannot
        // mint or inherit between a failed POST and the record going back, so
        // the restore can never overwrite a successor's claim.
        let _lock_ops = self.speleodb_lock_ops_guard();
        if let Err(e) = self.speleodb_release_unless_reclaimed_locked(&params) {
            tracing::warn!(
                error = %e,
                project_id = %params.project_id,
                purpose = "clean up after a torn-down edit session",
                "speleodb: stranded-claim release failed; the next poll retries"
            );
            // Restore for the retry - but only into the same no-project-open
            // world the decision read. With a project open the field belongs
            // to the live world (its own verbs and catch-alls own it), and
            // this janitor never runs there anyway.
            let proj_guard = self
                .project
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if proj_guard.is_none() {
                if let Ok(mut session) = self.speleodb_session_lock() {
                    if session.lock_acquired_here.is_none() {
                        session.lock_acquired_here = Some(params.project_id.clone());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    clippy::panic,
    reason = "unit test fixtures fail loudly on setup errors; the source-scan \
              tripwires panic with the path they could not read"
)]
mod tests {
    use std::path::Path;

    use super::AppState;
    use crate::models::{Project, SpeleoLink};
    use crate::persistence::Database;
    use crate::speleodb::SpeleoDbError;

    const ID: &str = "11111111-1111-1111-1111-111111111111";
    const OTHER_ID: &str = "22222222-2222-2222-2222-222222222222";

    /// A `.stalx` at `path` linked to `project_id` (same idiom as
    /// `speleodb_foreign`'s fixture).
    fn seed_linked(path: &Path, project_id: &str) {
        let mut db = Database::open(path).expect("open db");
        db.save_project(&Project::new("Linked".to_owned(), None))
            .expect("save project");
        db.save_speleo_link(Some(&SpeleoLink {
            endpoint: "http://x/".to_owned(),
            project_id: project_id.to_owned(),
            project_name: "Linked".to_owned(),
            base_commit_sha: Some("abc123".to_owned()),
            has_unpushed_edits: false,
            last_edit_at: None,
            last_verify_at: None,
        }))
        .expect("save link");
    }

    /// An open, linked project (read-only remote open: the gate is shut).
    fn open_linked(state: &AppState, dir: &Path, name: &str, project_id: &str) {
        let path = dir.join(name);
        seed_linked(&path, project_id);
        assert!(state.open_project(path).success, "fixture opens");
        assert!(!state.edit_enabled(), "remote open shuts the gate");
    }

    #[test]
    fn open_close_and_create_are_session_boundaries_but_saves_and_rollbacks_are_not() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        let g0 = state.speleodb_session_generation();

        open_linked(&state, temp.path(), "a.stalx", ID);
        let g1 = state.speleodb_session_generation();
        assert_ne!(g0, g1, "an open is a session boundary");

        // An undo rollback restores the SAME open project (footgun 5.7).
        let snapshot = state
            .capture_project_snapshot()
            .expect("snapshot the open project");
        state.rollback_project(&snapshot);
        assert_eq!(
            state.speleodb_session_generation(),
            g1,
            "an undo rollback is NOT a session boundary"
        );

        // Neither is a save - implicit or Save a Copy (the slot never moves).
        assert!(state.save_project(None).success);
        assert!(
            state
                .save_project(Some(temp.path().join("copy.stalx")))
                .success
        );
        assert_eq!(
            state.speleodb_session_generation(),
            g1,
            "saves are NOT session boundaries"
        );

        state.close_project();
        let g2 = state.speleodb_session_generation();
        assert_ne!(g1, g2, "a close is a session boundary");
    }

    #[test]
    fn the_session_snapshot_pairs_the_link_with_its_generation() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);

        let (entry_gen, link) = state
            .speleodb_session_snapshot()
            .expect("a linked open project has a snapshot");
        assert_eq!(entry_gen, state.speleodb_session_generation());
        assert_eq!(link.project_id, ID);

        state.close_project();
        assert!(
            state.speleodb_session_snapshot().is_err(),
            "no open project, no snapshot"
        );
    }

    #[test]
    fn a_commit_in_an_unmoved_session_opens_the_gate_and_mints_the_claim() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);
        let (entry_gen, link) = state.speleodb_session_snapshot().expect("snapshot");

        state
            .speleodb_commit_editing(Some(entry_gen), &link.project_id, true)
            .expect("nothing moved, so the commit lands");

        assert!(state.edit_enabled(), "the gate is open");
        assert!(!state.force_editing(), "force-edit is cleared");
        assert!(
            state.speleodb_lock_acquired_here(ID),
            "the acquisition record was minted"
        );
        let stamped = state.speleodb_open_link().expect("link");
        assert!(
            stamped.last_verify_at.is_some(),
            "a fresh-verdict commit starts the #202 re-verify window"
        );
    }

    #[test]
    fn a_commit_without_acquired_here_opens_the_gate_without_a_claim() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);
        let (entry_gen, link) = state.speleodb_session_snapshot().expect("snapshot");

        state
            .speleodb_commit_editing(Some(entry_gen), &link.project_id, false)
            .expect("commit lands");

        assert!(state.edit_enabled());
        assert!(
            !state.speleodb_lock_acquired_here(ID),
            "an inherited lock is an edit session, not an acquisition"
        );
    }

    #[test]
    fn a_commit_after_a_teardown_is_refused_with_nothing_committed() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);
        let (entry_gen, link) = state.speleodb_session_snapshot().expect("snapshot");

        state.close_project();

        let refused = state
            .speleodb_commit_editing(Some(entry_gen), &link.project_id, true)
            .expect_err("the world this flow started from is gone");
        assert!(matches!(refused, SpeleoDbError::SessionMoved));
        assert!(
            !state.speleodb_lock_acquired_here(ID),
            "no claim was minted onto the torn-down world"
        );
    }

    #[test]
    fn a_commit_after_a_same_project_reopen_is_still_refused() {
        // The doc's case (c): the same project before and after a teardown. The
        // identity check alone cannot see it - the generation is the
        // discriminator, and this is the test that keeps it load-bearing.
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);
        let (entry_gen, link) = state.speleodb_session_snapshot().expect("snapshot");

        state.close_project();
        open_linked(&state, temp.path(), "b.stalx", ID);

        let refused = state
            .speleodb_commit_editing(Some(entry_gen), &link.project_id, true)
            .expect_err("a successor session on the same project is not our session");
        assert!(matches!(refused, SpeleoDbError::SessionMoved));
        assert!(!state.edit_enabled(), "the successor's shut gate stands");
        assert!(
            !state.speleodb_lock_acquired_here(ID),
            "and no claim landed"
        );
    }

    #[test]
    fn an_identity_only_commit_asks_who_is_open_not_how_many_boundaries_passed() {
        // The fast-forward arm: its own reload is a boundary, so it commits with
        // `None` and identity does the work.
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);
        state.close_project();
        open_linked(&state, temp.path(), "b.stalx", ID);

        state
            .speleodb_commit_editing(None, ID, true)
            .expect("the open project is still linked to this id");
        assert!(state.edit_enabled());
        assert!(state.speleodb_lock_acquired_here(ID));

        state.close_project();
        open_linked(&state, temp.path(), "c.stalx", OTHER_ID);
        let refused = state
            .speleodb_commit_editing(None, ID, true)
            .expect_err("a different project is open");
        assert!(matches!(refused, SpeleoDbError::SessionMoved));

        state.close_project();
        let refused = state
            .speleodb_commit_editing(None, ID, true)
            .expect_err("no project is open at all");
        assert!(matches!(refused, SpeleoDbError::SessionMoved));
    }

    #[test]
    fn the_unwind_in_an_unmoved_session_clears_the_record_as_before() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);
        let entry_gen = state.speleodb_session_generation();
        state.speleodb_note_lock_acquired(Some(ID));

        // The POST fails fast (nothing listens); best-effort is the contract.
        state.speleodb_unwind_release("http://127.0.0.1:1/", "token", true, ID, entry_gen);

        assert!(
            !state.speleodb_lock_acquired_here(ID),
            "same session: the release ends OUR claim, exactly as it always did"
        );
    }

    #[test]
    fn the_unwind_after_a_boundary_never_touches_the_record() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);
        let entry_gen = state.speleodb_session_generation();

        state.close_project();
        open_linked(&state, temp.path(), "b.stalx", ID);
        // The successor's claim, minted by ITS Start Editing.
        state.speleodb_note_lock_acquired(Some(ID));

        state.speleodb_unwind_release("http://127.0.0.1:1/", "token", true, ID, entry_gen);

        assert!(
            state.speleodb_lock_acquired_here(ID),
            "session moved: the record is the successor's, not ours to blank (5.5)"
        );
    }

    /// A signed-in session pointing at a dead endpoint: token resolution
    /// succeeds locally, every POST fails fast (nothing listens on port 1).
    /// The in-memory token store keeps this hermetic - no OS keychain probe
    /// (and `endpoint.is_some()` short-circuits the rehydration).
    fn sign_in_unreachable(state: &AppState) {
        let mut session = state.speleodb_session_lock().expect("session lock");
        session.endpoint = Some("http://127.0.0.1:1/".to_owned());
        session.email = Some("diver@example.com".to_owned());
        session.token_store = crate::speleodb::auth::TokenStore::from_in_memory_token("tok");
    }

    #[test]
    fn the_janitor_leaves_a_live_claim_and_a_signed_out_stranded_claim_alone() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");

        // A project open: the claim may be live - leave it alone.
        open_linked(&state, temp.path(), "a.stalx", ID);
        state.speleodb_note_lock_acquired(Some(ID));
        state.speleodb_janitor_stranded_claim();
        assert!(
            state.speleodb_lock_acquired_here(ID),
            "a claim with a project open is not the janitor's to judge"
        );

        // No project open but signed out: no token means no release POST, and
        // the record is the ONLY pointer to the stranded lock - keep it so the
        // first poll after a sign-in can retry (round 5).
        state.close_project();
        state.speleodb_note_lock_acquired(Some(ID));
        state.speleodb_janitor_stranded_claim();
        assert!(
            state.speleodb_lock_acquired_here(ID),
            "signed out, the record must survive: it is the retry"
        );
    }

    #[test]
    fn the_janitor_restores_the_claim_when_the_release_post_fails() {
        let state = AppState::new().expect("state");
        sign_in_unreachable(&state);
        state.speleodb_note_lock_acquired(Some(ID));

        state.speleodb_janitor_stranded_claim();

        assert!(
            state.speleodb_lock_acquired_here(ID),
            "a transient POST failure must put the record back, or the next \
             poll has nothing to retry from (round 5)"
        );
    }

    #[test]
    fn the_janitor_permanently_clears_an_unusable_id() {
        // Signed out on purpose: an id that can never be joined into a URL is
        // cleared regardless of whether a release could even be attempted.
        let state = AppState::new().expect("state");
        state.speleodb_note_lock_acquired(Some("not-a-uuid"));

        state.speleodb_janitor_stranded_claim();

        assert!(
            !state.speleodb_lock_acquired_here("not-a-uuid"),
            "an unusable id has no release to retry; clearing is its only end"
        );
    }

    #[test]
    fn link_status_with_no_project_open_runs_the_janitor() {
        // Footgun 5.4 closed: the NoRemoteProject early-return used to be
        // unreachable territory for every cleanup. The unusable-id record is
        // the janitor outcome observable without a live server: it is cleared
        // on the spot, signed in or not.
        let state = AppState::new().expect("state");
        state.speleodb_note_lock_acquired(Some("not-a-uuid"));

        let status = state
            .speleodb_link_status()
            .expect("no project open is a valid status");

        assert!(!status.is_remote);
        assert!(
            !state.speleodb_lock_acquired_here("not-a-uuid"),
            "the poll's visit to the no-project branch ran the janitor"
        );
    }

    #[test]
    fn a_captured_release_stands_down_for_an_inherited_successor_session() {
        // The round-4 P1: a successor that started editing while the account
        // still held the lock (the capturing session's release had not POSTed)
        // INHERITED it - `acquired_here` false, so no record was minted. The
        // reclaim check must still see that session, or the deferred release
        // frees the mutex out from under it.
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        open_linked(&state, temp.path(), "a.stalx", ID);
        state
            .speleodb_commit_editing(None, ID, false)
            .expect("the inherited successor's commit");
        assert!(
            !state.speleodb_lock_acquired_here(ID),
            "fixture: an inherited session has no acquisition record"
        );

        let params = super::LockReleaseParams {
            endpoint: "http://127.0.0.1:1/".to_owned(),
            token: "tok".to_owned(),
            insecure_http: true,
            project_id: ID.to_owned(),
        };
        state
            .speleodb_release_unless_reclaimed(&params)
            .expect("stood down without a POST - a POST to a dead endpoint errs");
    }

    #[test]
    fn a_captured_release_posts_when_no_session_accounts_for_the_lock() {
        // The other half of the check: a world with no live claim and no live
        // edit session must NOT stand down - the POST is attempted (and errs
        // against the dead endpoint, which is how the attempt is observable).
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        let params = super::LockReleaseParams {
            endpoint: "http://127.0.0.1:1/".to_owned(),
            token: "tok".to_owned(),
            insecure_http: true,
            project_id: ID.to_owned(),
        };

        // No project open at all.
        assert!(state.speleodb_release_unless_reclaimed(&params).is_err());

        // The project open READ-ONLY: a shut gate is not an edit session and
        // accounts for nothing.
        open_linked(&state, temp.path(), "a.stalx", ID);
        assert!(state.speleodb_release_unless_reclaimed(&params).is_err());

        // A DIFFERENT project's live session says nothing about this lock.
        state.close_project();
        open_linked(&state, temp.path(), "b.stalx", OTHER_ID);
        state
            .speleodb_commit_editing(None, OTHER_ID, false)
            .expect("the other project's session");
        assert!(state.speleodb_release_unless_reclaimed(&params).is_err());
    }

    // ---- tripwires -------------------------------------------------------

    /// Read a sibling source file of this module at test time.
    fn state_source(name: &str) -> String {
        let path = format!("{}/src/core/state/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    #[test]
    fn bump_sites_are_exactly_the_known_set() {
        // D7's lesson from the abandoned attempt: an incomplete bump-site
        // inventory is invisible until the missed site re-opens the bug. Every
        // file that commits into or clears the project slot must either bump or
        // be on the classified DO-NOT-BUMP list below.
        let dir = format!("{}/src/core/state", env!("CARGO_MANIFEST_DIR"));
        let mut bumping: Vec<String> = Vec::new();
        let mut writing: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("read state dir") {
            let entry = entry.expect("dir entry");
            let name = entry.file_name().into_string().expect("utf-8 name");
            // Skip the shared test dump and THIS module (the scan needles appear
            // in this very test's source).
            if !name.ends_with(".rs") || name == "tests.rs" || name == "speleodb_session.rs" {
                continue;
            }
            let src = std::fs::read_to_string(entry.path()).expect("read source");
            // Production code only: this tree keeps test modules at the bottom of
            // the file, so truncating at the first test gate is enough for a
            // tripwire (fixtures write the slot freely and legitimately).
            let src = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
            if src.contains("self.bump_speleodb_session()") {
                bumping.push(name.clone());
            }
            // The slot-commit spellings in this tree: a load/create commit
            // (`= Some(project`), the rollback restore (`= Some(restored`), and
            // the close clear (`*project = None`). Space-prefixed so a
            // `== Some(project_id)` comparison does not read as an assignment.
            if src.contains(" = Some(project")
                || src.contains(" = Some(restored")
                || src.contains("*project = None")
            {
                writing.push(name);
            }
        }
        bumping.sort();
        assert_eq!(
            bumping,
            vec![
                "project_create.rs",
                "project_io.rs",
                "project_load.rs",
                "speleodb_logout.rs",
            ],
            "the bump-site inventory moved; re-derive the session-boundary \
             classification in `speleodb_session` before updating this list"
        );
        // Classified non-bumping slot writers: the rollback restore
        // (`restore_snapshot_into`) is the SAME session by design (footgun 5.7).
        // Everything else that writes the slot must bump.
        let exempt = ["app_state.rs"];
        for name in writing {
            assert!(
                bumping.contains(&name) || exempt.contains(&name.as_str()),
                "{name} writes the project slot but neither bumps the session \
                 generation nor is classified exempt - decide which it is \
                 (see `speleodb_session`'s module doc)"
            );
        }
    }

    #[test]
    fn start_editing_holds_the_guards_in_the_right_order() {
        let src = state_source("speleodb.rs");
        let start = src
            .find("fn speleodb_start_editing")
            .expect("start editing is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];

        let snapshot = body
            .find("self.speleodb_session_snapshot()")
            .expect("entry must snapshot generation + link as one world (D6)");
        let lock_ops = body
            .find("self.speleodb_lock_ops_guard()")
            .expect("the acquire span must be serialized against captured releases");
        let probe = body
            .find("self.speleodb_lock_holder_checked(")
            .expect("the pre-acquire holder probe is present");
        let acquire = body
            .find("client::acquire_lock(")
            .expect("the acquire is present");
        assert!(
            snapshot < lock_ops && lock_ops < probe && probe < acquire,
            "order must be: session snapshot, then lock-ops guard, then the \
             holder probe, then acquire - a probe OUTSIDE the span reads \
             provenance a captured release can invalidate before the acquire \
             (round 5: 'inherited, keep on unwind' over a mutex the release \
             then freed, so the abort arms strand a lock this call took)"
        );
        assert_eq!(
            body.matches("self.speleodb_commit_editing(").count(),
            2,
            "both success arms must commit through the session guard"
        );
        assert!(
            body.contains("self.speleodb_unwind_release("),
            "the unwind must route through the session-aware release"
        );
        assert!(
            !body.contains("self.set_edit_enabled(true)"),
            "no arm may open the gate outside the guarded commit"
        );
    }

    #[test]
    fn the_delete_clears_its_own_claim_before_the_guard_drops() {
        let src = state_source("recent_projects.rs");
        let start = src
            .find("fn delete_project")
            .expect("delete_project is present");
        let body = &src[start..];
        let forget = body
            .find("self.speleodb_forget_lock_acquired_for(")
            .expect("the delete must clear its own claim at snapshot time");
        let teardown = body
            .find("self.close_open_project_locked(")
            .expect("the delete tears the session down");
        assert!(
            forget < teardown,
            "the claim clear must happen under the same guard as the snapshot, \
             before the teardown - a later clear cannot tell our record from a \
             successor's (F8)"
        );
    }
}
