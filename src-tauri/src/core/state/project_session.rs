//! Identity for the OPEN-PROJECT session, and the two SpeleoDB decisions that
//! need it.
//!
//! Nothing in `AppState` used to say WHICH open project a piece of deferred work
//! had been decided against. The open project is three separate slots (`project`,
//! `database`, `undo_stack`) plus two flags (`edit_enabled`, `force_editing`), and
//! every teardown resets the flags to their defaults - so after a close, "the edit
//! gate is open" is indistinguishable from "somebody opened a gate". A caller that
//! read state, went away to do a network round trip, and came back to act on what
//! it read had no way to notice that the thing it read had been torn down and
//! replaced underneath it. Two confirmed defects came out of exactly that:
//!
//! - **Start editing committing onto a session that no longer exists.**
//!   `AppState::speleodb_start_editing` reads the open project's link, makes three
//!   HTTP round trips, and then commits `edit_enabled = true` plus an acquisition
//!   record. A `AppState::delete_project` landing anywhere in that window closes
//!   the project and trashes its `.stalx`, and its own release snapshot answers
//!   `None` (the gate is still shut for a remote project opened read-only), so no
//!   release is attempted. The commit then lands on nothing: a server mutex held,
//!   an edit gate open, an acquisition recorded, and no project. Unrecoverable by
//!   any existing path - every release re-reads the link through the database
//!   handle the teardown dropped, and the poll's catch-all clear is behind an
//!   early return that a closed project never gets past.
//! - **A deferred release freeing a REPLACEMENT session's lock.**
//!   `AppState::speleodb_release_captured_lock` runs after `delete_project` has
//!   dropped the `project` mutex (an HTTP round trip may not happen under it). A
//!   second local `.stalx` linked to the same remote project - Save-As carries the
//!   `speleo_link` row forward, and a re-pull rebuilds the cache copy at the same
//!   path - can be opened and Started editing inside that gap. The server treats
//!   that acquire as an own-account no-op, so the replacement inherits the very
//!   mutex this release is about to hand back, and a project-id comparison cannot
//!   tell the two sessions apart because their ids are equal by construction. The
//!   replacement is then left `edit_enabled && !force_editing` with no server lock:
//!   the "unflagged lockless edit session" state the rest of the code treats as
//!   impossible, with only the 20-minute #202 re-verify behind it.
//!
//! [`ProjectSession`] is the missing discriminator, and it is deliberately the
//! smallest one that works: a monotonic counter bumped by every path that installs
//! or tears down an open project. It is compared for EQUALITY only, never ordered,
//! so "the session I decided against" is a single `==` at the moment of acting.
//!
//! Why a counter rather than something richer:
//!
//! - A project id cannot separate two local files on one remote project, which is
//!   the second defect above verbatim.
//! - A file path cannot separate a project from its own re-pulled replacement at
//!   the same cache path, and is absent entirely for a never-saved project.
//! - The edit gate cannot be used at all: `AppState::close_open_project_locked`
//!   resets it to `true`, so after a teardown it reads exactly like a live edit
//!   session.
//! - A serialising lock (making Start editing hold `project`, or routing it
//!   through `command_lock`) would hold a mutex across three HTTP round trips, and
//!   the whole reason the delete's release is deferred is that network I/O may not
//!   happen under `project`. A counter needs no lock of its own.
//!
//! The same idiom is already used twice in `AppState` for the same class of bug:
//! `unrecognised_shot_kinds` is tagged with the `loading_id` of the load that wrote
//! it ("a cancelled load keeps running until its next checkpoint, so it can write
//! here AFTER the new project already did"), and `adjusted_cache_generation` is
//! captured before the lock-free solve "so a result computed against a
//! since-invalidated project is not written back".

use std::sync::atomic::Ordering;

use super::AppState;

/// Which open-project session is installed.
///
/// NOT the SpeleoDB account session (that is `super::speleodb::SpeleoDbSession`,
/// which outlives every project and models who is signed in). This names the
/// `project` / `database` / `undo_stack` trio and the edit flags that hang off it:
/// one value per install, a fresh one per teardown, and never reused, so a captured
/// value that still compares equal is proof that the very session it was taken from
/// is the one installed now.
///
/// Monotonic and compared only with `==`. Ordering it would be a mistake: "newer
/// than what I captured" is not a useful question (any change at all invalidates a
/// deferred decision), and treating it as an ordering invites an "at or after"
/// comparison that a close-then-reopen would silently pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ProjectSession(u64);

/// The acquisition provenance behind the authorship shortcut in
/// `AppState::speleodb_remote_state`: the project whose SpeleoDB write lock this
/// process took, PLUS the open-project session that took it.
///
/// The session half is what the plain `Option<String>` this replaces could not
/// express. Two sessions on one remote project have equal ids, so an id-keyed
/// record cannot say whose claim it is - which is the second defect in the module
/// doc. It also makes a claim minted by a session that has since been torn down
/// inert on sight ([`LockClaim::held_by`] answers `false` for it) instead of leaving
/// it to the poll's catch-all clear, which a closed project never reaches.
///
/// Deliberately process-local and never persisted, exactly as before: a lock left
/// over from an earlier run, or one held by a sibling session on the same account,
/// is no evidence that THIS process pushed anything.
#[derive(Debug, Clone)]
pub(super) struct LockClaim {
    /// The open-project session that took the lock.
    session: ProjectSession,
    /// The project whose write lock it took.
    project_id: String,
}

impl LockClaim {
    /// Whether this claim is a LIVE one for `project_id`: the right project, taken
    /// by the session that is still installed. A claim from a torn-down session
    /// names a lock this process may well still hold, but no longer holds *as that
    /// edit session* - so it licenses nothing.
    pub(super) fn held_by(&self, session: ProjectSession, project_id: &str) -> bool {
        self.session == session && self.project_id == project_id
    }

    /// Whether this claim is the one `session` took on `project_id`, regardless of
    /// which session is installed now. The question a release asks about a claim it
    /// is ending: `held_by` would answer `false` for exactly the claims a deferred
    /// release exists to clean up (its own session is gone by the time it runs).
    ///
    /// `session: None` means "whichever session took it" - for a release that ends
    /// EVERY claim on the named project rather than one session's
    /// (`AppState::speleodb_release_lock`, which targets an arbitrary project id and
    /// cannot know which session, if any, is editing under it).
    pub(super) fn taken_by(&self, session: Option<ProjectSession>, project_id: &str) -> bool {
        self.project_id == project_id && session.is_none_or(|s| s == self.session)
    }
}

impl AppState {
    /// A claim on `project_id` by the open-project session installed right now.
    ///
    /// The one constructor outside [`AppState::speleodb_commit_project_session`],
    /// which builds its own under the `project` guard because it has to read the
    /// session and write the claim atomically. Callers here are the in-place reload
    /// sites restoring a record across their own reload, so "right now" is the
    /// session that reload installed - the one that holds the lock.
    pub(super) fn speleodb_new_lock_claim(&self, project_id: &str) -> LockClaim {
        LockClaim {
            session: self.project_session(),
            project_id: project_id.to_owned(),
        }
    }

    /// Whether THIS process took `project_id`'s SpeleoDB write lock and is still
    /// editing under it - the acquisition provenance that licenses the authorship
    /// shortcut in `AppState::speleodb_remote_state` (see
    /// `AppState::speleodb_note_lock_acquired` for what writes it).
    ///
    /// "Still" now means it. A claim minted by an open-project session that has since
    /// been torn down or replaced answers `false` here instead of waiting for the
    /// poll's catch-all clear - which a closed project never reaches, because
    /// `AppState::speleodb_link_status` returns on `NoRemoteProject` BEFORE it. That
    /// stale claim used to keep licensing the shortcut, so a SECOND same-account
    /// session's commit could be explained away as our own landed push and a genuine
    /// conflict rested unbadged.
    ///
    /// Lives here rather than beside the field for the same reason
    /// `AppState::speleodb_forget_lock_acquired_for` lives in
    /// `super::speleodb_lock_release`: the question it answers is about
    /// [`ProjectSession`], and `core::state::speleodb` is frozen by the file-size
    /// ratchet. The field is `pub(super)` precisely so these can live where they
    /// belong.
    pub(super) fn speleodb_lock_acquired_here(&self, project_id: &str) -> bool {
        let session = self.project_session();
        self.speleodb_session_lock().is_ok_and(|s| {
            s.lock_acquired_here
                .as_ref()
                .is_some_and(|c| c.held_by(session, project_id))
        })
    }
}

impl AppState {
    /// The open-project session installed right now.
    ///
    /// Capture it BEFORE any work that will be acted on later, and compare it for
    /// equality at the moment of acting. A plain atomic load: no lock is taken, so
    /// this is legal under any guard and adds no edge to the lock order.
    pub(super) fn project_session(&self) -> ProjectSession {
        ProjectSession(self.project_session.load(Ordering::SeqCst))
    }

    /// End the current open-project session and start a new one.
    ///
    /// Called by every path that installs an open project and by the single
    /// teardown chokepoint, so "the slots changed" and "the session id changed" are
    /// the same event. A teardown gets an id of its own rather than a sentinel: it
    /// leaves no project installed, so no capture can match it, and giving it a
    /// value keeps the counter's one rule ("never reused") free of special cases.
    ///
    /// `SeqCst` on a `fetch_add`, deliberately over-strong for what is a handful of
    /// calls on project open/close: this is the edge that orders a teardown against
    /// a concurrent `Ordering::SeqCst` load in
    /// [`AppState::speleodb_commit_project_session`], and the cost is unmeasurable
    /// next to opening a SQLite database.
    pub(super) fn begin_project_session(&self) {
        self.project_session.fetch_add(1, Ordering::SeqCst);
    }

    /// Commit a successful Start editing onto the open project - the edit gate, the
    /// acquisition record and the force-edit clear - but ONLY if the session the
    /// caller decided against is still the one installed. Answers whether it
    /// committed.
    ///
    /// This is the fix for the first defect in the module doc. `speleodb_start_editing`
    /// takes neither `command_lock` nor the `project` mutex and makes three HTTP
    /// round trips between reading the link and committing, so the project it
    /// validated can be closed, deleted or replaced underneath it; without this
    /// check the commit lands anyway and leaves an edit session with no project
    /// behind a server mutex nothing will ever release.
    ///
    /// `expected`:
    ///
    /// - `Some(session)` - the session captured before the work. The ordinary case,
    ///   and the airtight one: any teardown or install in between changes the id.
    /// - `None` - "whatever session is installed, as long as one IS". For a caller
    ///   that has just reloaded the project IN PLACE and so deliberately ended the
    ///   session it started from (`speleodb_start_editing`'s fast-forward arm, whose
    ///   `speleodb_fast_forward` closes and reopens the project before this runs).
    ///   It still refuses to commit onto a torn-down project, which is the failure
    ///   that arm can actually produce; see the residual note below.
    ///
    /// `record` is the project id to record as an acquisition, or `None` for a lock
    /// this call INHERITED rather than took (keeping an inherited lock is an edit
    /// session, not an acquisition). The claim is stamped with the session that is
    /// committing, not with `expected`: for the in-place-reload caller those differ,
    /// and it is the LIVE session that holds the lock.
    ///
    /// Ordering inside the guard is the pre-existing one and is load-bearing: the
    /// gate opens BEFORE the record is written, because the poll's
    /// `speleodb_forget_lock_acquired_if_gate_shut` takes no `project` guard and can
    /// still interleave - it would see a shut gate and clear a record written first.
    ///
    /// Locks: `project`, then the SpeleoDB session mutex, and nothing else. That
    /// edge already exists in production - `AppState::delete_project` holds `project`
    /// across `speleodb_abandon_lock_release_params`, which reaches
    /// `speleodb_active_token` and hence the session mutex - and no path takes
    /// `project` while holding the session mutex (all thirteen session-lock sites
    /// were enumerated), so it cannot cycle. No I/O happens under the guard.
    ///
    /// A poisoned `project` mutex is RECOVERED rather than treated as "no session",
    /// matching every other reader of that slot: the guarded value is an
    /// `Option<Project>` with no half-written state to protect, and answering "gone"
    /// on a poisoned mutex would refuse a commit whose session is perfectly alive. A
    /// poisoned SESSION mutex silently declines to record, matching
    /// `AppState::speleodb_note_lock_acquired` - it costs the authorship shortcut
    /// rather than granting one, and the gate still opens exactly as it did before.
    ///
    /// RESIDUAL, `expected: None` only: a teardown landing between the in-place
    /// reload and this call is caught by the `is_none` refusal below, but a teardown
    /// AND a complete re-install landing in that window would be committed onto. The
    /// window is the return of one function call with no I/O in it, versus the whole
    /// download-extract-reload it replaces; closing it entirely would need
    /// `do_load_project_full` to hand back the id it installed, which its
    /// `CommandResult` return type has no room for.
    pub(super) fn speleodb_commit_project_session(
        &self,
        expected: Option<ProjectSession>,
        record: Option<&str>,
    ) -> bool {
        let project = self
            .project
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let session = self.project_session();
        if project.is_none() || expected.is_some_and(|e| e != session) {
            return false;
        }
        self.set_edit_enabled(true);
        if let Some(project_id) = record {
            if let Ok(mut speleodb) = self.speleodb_session_lock() {
                speleodb.lock_acquired_here = Some(LockClaim {
                    session,
                    project_id: project_id.to_owned(),
                });
            }
        }
        self.set_force_editing(false);
        drop(project);
        true
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    clippy::panic,
    reason = "unit test fixtures fail loudly on setup errors; the source-scan tripwire \
              panics with the name of the function it could no longer find"
)]
mod tests {
    use super::AppState;

    /// The whole scheme rests on one invariant: the counter moves whenever the open
    /// project does. Miss one writer and a Start editing that spans that swap commits
    /// its edit gate and its acquisition record onto the wrong session, and a deferred
    /// release frees the wrong lock - silently, and only under a race, so no
    /// behavioural test would catch it. So it is guarded at the SOURCE, from both
    /// ends: every function that writes the slot must bump, and no OTHER function may
    /// write it.
    ///
    /// Structural because the alternative is driving five load paths concurrently and
    /// hoping to lose the race the right way round.
    #[test]
    fn every_project_slot_writer_starts_a_new_session() {
        let load = include_str!("project_load.rs");
        let create = include_str!("project_create.rs");
        let io = include_str!("project_io.rs");
        // Every production writer of `AppState::project`, by name. Extracted the way
        // the speleodb source-scan tests do: from the header to the next method.
        for (file, src, header) in [
            ("project_load.rs", load, "fn open_project(&self"),
            ("project_load.rs", load, "fn do_load_project_full("),
            ("project_create.rs", create, "fn create_project(&self"),
            ("project_create.rs", create, "fn do_create_project_full("),
            ("project_io.rs", io, "fn close_open_project_locked(&self"),
        ] {
            let body = src
                .split_once(header)
                .map(|(_, rest)| rest)
                .and_then(|rest| rest.split("\n    /// ").next())
                .unwrap_or_else(|| panic!("{file} still declares `{header}`"));
            assert!(
                body.contains("begin_project_session()"),
                "{file}: `{header}` installs or tears down the open project without \
                 starting a new session; anything that captured the old id would then \
                 act on a project that is no longer the one it decided against"
            );
        }
        // And the other end: no writer that is NOT on that list. Matched on the four
        // assignment spellings in use, so a sixth installer copied from an existing
        // one shows up here as a count change rather than as a silent race.
        let assignments: usize = [load, create, io]
            .iter()
            .flat_map(|src| src.split("\nmod tests {").next().unwrap_or(src).lines())
            .filter(|line| {
                let l = line.trim_start();
                l.starts_with("*proj = Some(")
                    || l.starts_with("*slot = Some(")
                    || l.starts_with("*project = None")
                    || l.starts_with("*proj_guard = ")
            })
            .count();
        assert_eq!(
            assignments, 5,
            "expected exactly the five project-slot assignments the loop above covers; \
             a different count means a writer was added, removed or respelled - wire \
             begin_project_session() into it, add it to the list, and update this number"
        );
    }

    #[test]
    fn a_new_session_never_compares_equal_to_the_one_it_replaced() {
        let state = AppState::new().expect("state");
        let first = state.project_session();
        state.begin_project_session();
        let second = state.project_session();
        assert_ne!(first, second, "a bump ends the session it found");
        state.begin_project_session();
        assert_ne!(
            first,
            state.project_session(),
            "and the id is never reused, so an old capture stays stale"
        );
        assert_ne!(second, state.project_session());
    }

    /// A project with a `file_path`, so `AppState` has something installed for the
    /// commit below to find. The commit reads nothing out of it - only whether the
    /// slot is occupied - so the cheapest possible project is the honest fixture.
    fn install_a_project(state: &AppState) {
        *state.project.lock().expect("project lock") =
            Some(crate::models::Project::new("P".to_owned(), None));
        state.begin_project_session();
    }

    #[test]
    fn the_commit_refuses_once_the_session_it_was_decided_against_is_gone() {
        // F7, at the primitive. `speleodb_start_editing` captures the session with the
        // link it validates and makes three HTTP round trips before committing; if a
        // close / delete / switch lands in between, committing anyway leaves the edit
        // gate open and an acquisition recorded over no project at all, behind a server
        // mutex nothing will ever release.
        let state = AppState::new().expect("state");
        install_a_project(&state);
        let captured = state.project_session();
        state.set_edit_enabled(false);

        // Exactly what `delete_project` / `close_project` do to the session.
        state.close_open_project_locked(&mut state.project.lock().expect("project lock"));

        assert!(
            !state.speleodb_commit_project_session(Some(captured), Some("P-1")),
            "the session the caller decided against is gone, so the commit is refused"
        );
        assert!(
            !state.speleodb_lock_acquired_here("P-1"),
            "and nothing was recorded - a claim by a session that does not exist would \
             license the authorship shortcut for a lock nobody in this process is \
             editing under"
        );
    }

    #[test]
    fn the_commit_refuses_a_replacement_session_on_the_same_project() {
        // The teardown is not the only way to lose the session, and the id of the
        // REMOTE project is no help: two local `.stalx` files can carry one
        // `speleo_link` row, so a replacement session is indistinguishable by project
        // id. It is the ProjectSession that separates them.
        let state = AppState::new().expect("state");
        install_a_project(&state);
        let captured = state.project_session();

        // A replacement installs over the top - the shape `open_project` and
        // `do_load_project_full` have, which never close first.
        install_a_project(&state);

        assert!(
            !state.speleodb_commit_project_session(Some(captured), Some("P-1")),
            "a project IS open, and it is even the same remote project - but it is not \
             the session the caller took its decision against"
        );
        assert!(
            state.speleodb_commit_project_session(Some(state.project_session()), Some("P-1")),
            "while the session that IS installed commits normally"
        );
    }

    #[test]
    fn the_commit_applies_and_records_on_the_ordinary_path() {
        // The uncontended path, unchanged: gate open, claim recorded, force-edit
        // cleared, in that order (the record must not precede the gate - a status poll
        // landing in between would see a shut gate and clear it again).
        let state = AppState::new().expect("state");
        install_a_project(&state);
        state.set_edit_enabled(false);
        state.set_force_editing(true);
        let captured = state.project_session();

        assert!(state.speleodb_commit_project_session(Some(captured), Some("P-1")));

        assert!(state.edit_enabled(), "the edit gate opens");
        assert!(!state.force_editing(), "#213 reconnect clears force-edit");
        assert!(
            state.speleodb_lock_acquired_here("P-1"),
            "and the acquisition is recorded against the live session"
        );
    }

    #[test]
    fn an_inherited_lock_commits_the_gate_and_records_nothing() {
        // `record: None` is Start editing resuming a lock the ACCOUNT already held:
        // an edit session, not an acquisition. The gate still opens.
        let state = AppState::new().expect("state");
        install_a_project(&state);
        state.set_edit_enabled(false);

        assert!(state.speleodb_commit_project_session(Some(state.project_session()), None));

        assert!(state.edit_enabled(), "an inherited lock still edits");
        assert!(
            !state.speleodb_lock_acquired_here("P-1"),
            "but mints no authorship claim it never earned"
        );
    }

    #[test]
    fn the_in_place_reload_commit_still_refuses_a_torn_down_project() {
        // `expected: None` is the fast-forward arm, which ENDED the session it started
        // from on purpose (the reload closes and reopens the project), so it cannot
        // compare against it. What it must still refuse is the failure it can actually
        // produce: a teardown landing between that reload and the commit, which would
        // leave the gate open over no project at all.
        let state = AppState::new().expect("state");
        install_a_project(&state);
        assert!(
            state.speleodb_commit_project_session(None, Some("P-1")),
            "a freshly reloaded project commits"
        );

        state.close_open_project_locked(&mut state.project.lock().expect("project lock"));
        state.set_edit_enabled(false);

        assert!(
            !state.speleodb_commit_project_session(None, Some("P-1")),
            "with nothing installed there is no session to commit onto"
        );
        assert!(
            !state.edit_enabled(),
            "and the gate the refusal declined to open stays shut"
        );
    }

    #[test]
    fn a_claim_goes_inert_when_its_session_is_replaced() {
        // The record's own session-keying, independent of any release. A claim minted
        // by a session that has since been torn down or replaced stops licensing the
        // authorship shortcut on sight, rather than waiting for the poll's catch-all
        // clear - which `speleodb_link_status` never reaches while no project is open,
        // because its `NoRemoteProject` early return precedes it.
        let state = AppState::new().expect("state");
        install_a_project(&state);
        state.speleodb_commit_project_session(Some(state.project_session()), Some("P-1"));
        assert!(state.speleodb_lock_acquired_here("P-1"), "precondition");

        state.begin_project_session();

        assert!(
            !state.speleodb_lock_acquired_here("P-1"),
            "the claim was taken by a session that no longer exists"
        );
    }

    #[test]
    fn forgetting_a_claim_can_be_keyed_on_the_session_that_took_it() {
        // F8's record half. Two sessions, one project id: an id-only comparison
        // matches BOTH claims, so ending the dead session's claim blanked the live
        // one's - and that provenance is the entire licence for the authorship
        // shortcut, so the next landed push read as a self-conflict.
        let state = AppState::new().expect("state");
        install_a_project(&state);
        let dead = state.project_session();
        state.speleodb_commit_project_session(Some(dead), Some("P-1"));

        // A replacement session on the SAME project id records its own claim.
        install_a_project(&state);
        state.speleodb_commit_project_session(Some(state.project_session()), Some("P-1"));

        state.speleodb_forget_lock_acquired_for("P-1", Some(dead));
        assert!(
            state.speleodb_lock_acquired_here("P-1"),
            "ending the DEAD session's claim must leave the live one's alone, even \
             though both name the same remote project"
        );

        state.speleodb_forget_lock_acquired_for("P-1", None);
        assert!(
            !state.speleodb_lock_acquired_here("P-1"),
            "and the un-keyed form (the held-lock prompt's per-project release, which \
             cannot name a session) still ends whichever claim names the project"
        );
    }
}
