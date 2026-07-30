//! The SILENT, best-effort release paths for a held SpeleoDB write lock.
//!
//! These are the releases nobody asked for explicitly: closing a project,
//! switching to another project, and quitting the app. They exist so a normal
//! close/quit doesn't strand the server mutex locked for every other editor
//! (fix 1 / M1 / M2). Split out of `core::state::speleodb` so the one gate they
//! all share - [`AppState::speleodb_held_lock_release_params`] - and the
//! data-safety rule it enforces live in one small, readable place.
//!
//! The DELIBERATE (explicit) release verbs do NOT go through the veto:
//! `speleodb_done` (push, then release once the push is confirmed),
//! `speleodb_release_lock` / `speleodb_release_all_locks` (the held-lock prompt's
//! per-project / release-all), `speleodb_release_current_lock`, and the two
//! ABANDON verbs - `speleodb_unlink` and `speleodb_take_remote` - via
//! [`AppState::speleodb_release_held_lock_abandoning`]. A user who asks to drop
//! the lock still gets to drop it, un-pushed edits or not.
//!
//! `speleodb_logout` is NOT in that list: it releases through
//! [`AppState::speleodb_release_held_lock_best_effort`], veto included. Logging
//! out is not the same act as surrendering the lock - unlike the abandon verbs it
//! neither deletes the link row nor discards the edits - and the lock it leaves
//! held is recoverable, because the next login's scan raises the held-lock prompt
//! over exactly that project.
//!
//! The abandon variant exists because those two verbs are only ever reached WITH
//! un-pushed edits and deliberately walk away from them: unlink deletes the link
//! row (a lock kept back could never be released from this project again), and
//! take-remote discards the local edits by definition, behind the frontend's
//! second destroy-confirmation.
//!
//! `AppState::delete_project` is the third abandon caller and the only one that
//! cannot use a single verb: it destroys the `.stalx` the link row lives in, so it
//! has to snapshot with [`AppState::speleodb_abandon_lock_release_params`] while the
//! database handle is still alive and release with
//! [`AppState::speleodb_release_captured_lock`] once its teardown - and the `project`
//! mutex - are out of the way. Destroying the file is the plainest abandon there is,
//! which is why it takes the un-vetoed snapshot.

use std::time::Duration;

use super::AppState;
use crate::speleodb::client;
use crate::speleodb::SpeleoDbError;

/// What one lock release needs: the server to talk to, the credential, the
/// http-policy allowance, and which project's mutex to drop.
///
/// A struct rather than the `(String, String, bool, String)` this used to be. Three
/// same-typed `String`s around a bare `bool`, destructured positionally at four
/// call sites, is a swap the compiler cannot catch - and swapping `endpoint` with
/// `token` sends the bearer token into a URL, or the project id into the auth
/// header, with a type error nowhere in sight.
pub(super) struct LockReleaseParams {
    /// The SpeleoDB base URL this session is authenticated against.
    pub(super) endpoint: String,
    /// The bearer token for that endpoint.
    pub(super) token: String,
    /// The persisted public-`http://` allowance, threaded to `tls::enforce`.
    pub(super) insecure_http: bool,
    /// The project whose write lock is being released.
    pub(super) project_id: String,
    /// The open-project session this snapshot was taken from - the session that was
    /// editing under the lock, and whose acquisition claim this release ends.
    ///
    /// Every caller but one snapshots and releases in one breath, so for them this is
    /// simply the live session. It exists for [`AppState::speleodb_release_captured_lock`],
    /// which runs after `AppState::delete_project` has torn that session down and
    /// dropped the `project` mutex: a REPLACEMENT session on the same remote project
    /// can be open and editing by then, and `project_id` cannot tell the two apart
    /// (two local `.stalx` files can be linked to one remote project). See
    /// [`super::project_session`].
    pub(super) session: super::project_session::ProjectSession,
}

/// Whether a release may proceed over un-pushed local edits.
///
/// The same distinction [`super::speleodb_cache::LocalEditsPolicy`] draws for a
/// download-replace, drawn here for the lock: named at every call site so a reader
/// sees which act they are looking at instead of decoding a bare `bool`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReleaseIntent {
    /// A SILENT release nobody asked for (close, project switch, quit, logout):
    /// vetoed when the project still holds un-pushed edits.
    Silent,
    /// A DELIBERATE abandon of the project's SpeleoDB identity (`speleodb_unlink`,
    /// `speleodb_take_remote`): the user has said outright they are walking away
    /// from the local work, so there is no future push for the veto to protect.
    Abandon,
}

impl AppState {
    /// Snapshot of what a best-effort lock release needs, or `None` when no held
    /// remote edit session is active - or when releasing would strand local work.
    /// Cheap + non-blocking (reads the open link + config, no network), so a caller
    /// that must not block on the OLD project's server - the app-exit path, a
    /// project switch - can hand the actual HTTP release to a bounded / detached
    /// thread. Reads the link BEFORE the caller tears down or swaps the database.
    pub(super) fn speleodb_held_lock_release_params(&self) -> Option<LockReleaseParams> {
        self.speleodb_lock_release_params(ReleaseIntent::Silent)
    }

    /// The same snapshot WITHOUT the un-pushed-edits veto, for a deliberate
    /// abandon (see [`AppState::speleodb_release_held_lock_abandoning`]).
    pub(super) fn speleodb_abandon_lock_release_params(&self) -> Option<LockReleaseParams> {
        self.speleodb_lock_release_params(ReleaseIntent::Abandon)
    }

    /// Shared body of the two snapshots above. `intent` is what separates a silent
    /// release from a deliberate one.
    fn speleodb_lock_release_params(&self, intent: ReleaseIntent) -> Option<LockReleaseParams> {
        // #213: a force-editor is edit-enabled but holds NO lock, so there is nothing
        // to release on close / app-exit / project-switch.
        if !self.edit_enabled() || self.force_editing() {
            return None;
        }
        // A `.ok()?` here used to collapse REAL failures into the ordinary "nothing
        // to release" no-op with no trace at all: `speleodb_open_link` returns
        // `Io("database lock poisoned")` as readily as `NoRemoteProject`. A poisoned
        // mutex at close / switch / quit then stranded the server lock permanently
        // and silently - the exact outcome this module exists to prevent, and
        // indistinguishable in the log from a local project holding no lock. The
        // un-pushed-edits veto below has always logged; so must this.
        let link = match self.speleodb_open_link() {
            Ok(link) => link,
            Err(SpeleoDbError::NoRemoteProject) => return None,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    ?intent,
                    purpose = "release a held SpeleoDB write lock",
                    "speleodb: could not read the open project's link; the server lock \
                     (if any) is being left held"
                );
                return None;
            }
        };
        // Data-safety asymmetry, deliberate: never SILENTLY release a lock whose
        // project still has un-pushed local edits. The two failure modes are not
        // symmetric. Keeping the lock held is recoverable - the user reopens the
        // project and continues, pushes with Done, or releases on purpose - and the
        // server lock times out on its own anyway. Releasing while edits are
        // stranded locally is NOT: the project is immediately free for someone else
        // to lock and push, and the local edits can then only be reconciled through
        // a divergence. `speleodb_done` gets this right (it pushes first and only
        // releases once a re-check confirms the push landed); this gate is what the
        // silent paths get instead. The user-driven verbs listed in the module doc
        // bypass this gate on purpose, so "discard my edits and release" still works.
        if intent == ReleaseIntent::Silent && link.has_unpushed_edits {
            tracing::info!(
                project_id = %link.project_id,
                purpose = "avoid stranding un-pushed local edits behind a freed lock",
                "speleodb: skipping the silent lock release; the project has un-pushed edits"
            );
            return None;
        }
        // Same reasoning as the link read above: `speleodb_active_token` returns
        // `Io("SpeleoDB session lock poisoned")` alongside the ordinary
        // `NotAuthenticated`, and a silently-dropped poisoned mutex here strands the
        // lock just as thoroughly.
        let (endpoint, token) = match self.speleodb_active_token() {
            Ok(pair) => pair,
            Err(SpeleoDbError::NotAuthenticated) => return None,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %link.project_id,
                    ?intent,
                    purpose = "release a held SpeleoDB write lock",
                    "speleodb: could not read the session token; the server lock is \
                     being left held"
                );
                return None;
            }
        };
        Some(LockReleaseParams {
            endpoint,
            token,
            insecure_http: self.speleodb_insecure_http(),
            project_id: link.project_id,
            // Read LAST, but still before the caller's teardown: `delete_project`
            // calls this under the `project` guard it then tears the session down
            // with, so the value captured here IS the session being ended.
            session: self.project_session(),
        })
    }

    /// Best-effort release of a held SpeleoDB write lock when a remote EDIT session
    /// is closed, so a normal close/quit doesn't strand the server mutex locked for
    /// every other editor (fix 1). Unlike [`AppState::speleodb_logout`] it keeps the
    /// token and the edit gate (the caller's close teardown resets the gate) - it
    /// only surrenders the server lock. Reads the link BEFORE the caller tears down
    /// the database. The keep-lock close path skips this by passing
    /// `release_lock = false` to the close command. A read-only-open or local
    /// project holds no lock, so this is a no-op there. Synchronous: acceptable on
    /// the close command (Tauri runs it off the main thread); the app-exit and
    /// project-switch paths use the bounded / detached variants below instead.
    pub(crate) fn speleodb_release_held_lock_best_effort(&self) {
        if let Some(p) = self.speleodb_held_lock_release_params() {
            self.speleodb_release_best_effort(
                &p.endpoint,
                &p.token,
                p.insecure_http,
                &p.project_id,
            );
        }
    }

    /// Release a held lock for a caller that is ABANDONING the project's SpeleoDB
    /// identity (`speleodb_unlink`): same best-effort release as
    /// [`AppState::speleodb_release_held_lock_best_effort`], minus the
    /// un-pushed-edits veto. Unlink deletes the `speleo_link` row, so a lock kept
    /// back here could not be released from this project again - and the user has
    /// said outright that the managed copy is being walked away from, so there is
    /// no future push for the veto to protect.
    pub(crate) fn speleodb_release_held_lock_abandoning(&self) {
        if let Some(p) = self.speleodb_abandon_lock_release_params() {
            self.speleodb_release_best_effort(
                &p.endpoint,
                &p.token,
                p.insecure_http,
                &p.project_id,
            );
        }
    }

    /// Forget the acquisition record IF it is still the claim `taken_by` took on
    /// `project_id`: one compare-and-clear under a SINGLE session-lock acquisition.
    ///
    /// `taken_by: Some(session)` ends exactly ONE session's claim - for a release that
    /// decided against a session which may no longer be installed by the time it runs.
    /// `None` ends whichever claim names the project, for a release aimed at an
    /// arbitrary project id whose editing session (if any) it cannot name:
    /// [`AppState::speleodb_release_lock`], the held-lock prompt's per-project release.
    ///
    /// The session half is what an id comparison alone cannot do. Two local `.stalx`
    /// files can carry the same `speleo_link` row, so "the claim names this project"
    /// is true for a REPLACEMENT session's claim as well as for the dead session's -
    /// and blanking the replacement's costs it the authorship shortcut described
    /// below just as surely.
    ///
    /// For the releases that clear the record at a different moment than they decided
    /// to release it. [`AppState::speleodb_release_captured_lock`] is the reason this
    /// exists: `AppState::delete_project` snapshots the release params under the
    /// `project` mutex, tears the session down, drops that mutex, and only THEN runs
    /// the network release - so there is a real gap between "we decided to hand this
    /// project's lock back" and "we say so in the session". Another SpeleoDB project
    /// can be opened and Started editing inside that gap, and a successful Start
    /// editing records ITSELF in `lock_acquired_here`.
    ///
    /// An unconditional `speleodb_note_lock_acquired(None)` after the gap then erases
    /// the NEW project's record while releasing the OLD project's lock. Nothing looks
    /// broken - the new lock is still held and still editable - but the acquisition
    /// PROVENANCE for it is gone, and that provenance is the entire licence for the
    /// authorship shortcut in `AppState::speleodb_remote_state`: it is what feeds
    /// `we_hold_the_lock` into `crate::speleodb::sync::poll_verdict`, which without it
    /// refuses to explain a commit in the `BASE..tip` gap as our own landed push. The
    /// concrete outcome is that OUR OWN next push comes back as
    /// `RemoteState::Conflict` - a self-conflict against our own commit on a project
    /// nobody else touched - with the status mark routing the user's next click into the
    /// divergence dialog, which is exactly the misreport the record was introduced to
    /// stop.
    ///
    /// Comparing project ids is what closes THIS window, and that is not in tension
    /// with `AppState::speleodb_forget_lock_acquired_if_gate_shut`, whose doc says at
    /// length that an id comparison does NOT close ITS race. The races are different
    /// and neither test substitutes for the other:
    ///
    /// - There, the poll and the fast-forward that can be trampled are on the SAME
    ///   project, so the ids always match and the clear fires regardless; only
    ///   re-reading the edit GATE separates them.
    /// - Here the interloper is by definition a DIFFERENT project - there is one
    ///   `project` mutex and one open project, and the old one was torn down before
    ///   this runs - so the id IS the signal. The gate is no use at all: after the
    ///   delete it is shut for the project being released and OPEN for whatever
    ///   session took its place, so a gate test would either never fire or fire on the
    ///   wrong session's record.
    ///
    /// So: do not unify the two behind one condition. Doing so reintroduces one of the
    /// two bugs, whichever condition loses.
    ///
    /// The compare and the clear MUST share one guard. A
    /// `speleodb_lock_acquired_here` read followed by a separate
    /// `speleodb_note_lock_acquired(None)` write is two acquisitions with a gap of
    /// their own, and an acquisition landing in THAT gap is erased just the same: a
    /// narrower window is still the same bug. (Which is why
    /// `AppState::speleodb_release_lock`, the per-project release that had the id
    /// comparison right from the start, clears through here too.)
    ///
    /// A poisoned session lock silently declines to clear, matching
    /// `speleodb_note_lock_acquired`: it costs the shortcut rather than granting one,
    /// since the same poisoned mutex fails the token read the poll needs to identify a
    /// lock holder at all.
    pub(super) fn speleodb_forget_lock_acquired_for(
        &self,
        project_id: &str,
        taken_by: Option<super::project_session::ProjectSession>,
    ) {
        let Ok(mut session) = self.speleodb_session_lock() else {
            return;
        };
        if session
            .lock_acquired_here
            .as_ref()
            .is_some_and(|c| c.taken_by(taken_by, project_id))
        {
            session.lock_acquired_here = None;
        }
    }

    /// Run the network half of a release for params captured EARLIER, and REPORT the
    /// outcome instead of only logging it.
    ///
    /// Every verb above snapshots and releases in one breath, which suits any caller
    /// still holding the database handle the `speleo_link` row is read from. The
    /// project DELETE (`AppState::delete_project`) can do neither:
    ///
    /// - It must snapshot while the handle is alive but release after its own
    ///   teardown has dropped that handle - and after it has released the `project`
    ///   mutex, because an HTTP round trip inside that critical section would stall
    ///   every other state-layer operation for its duration. So the two halves are
    ///   necessarily separate calls there, with
    ///   [`AppState::speleodb_abandon_lock_release_params`] as the first one.
    /// - It has to surface a failure to the user, not just the log. Every other
    ///   caller leaves a lock whose `.stalx` (and link row) survive, so the release
    ///   is retryable from the project itself; a delete destroys exactly that, and
    ///   the user's only remaining route to the stranded mutex is the held-lock
    ///   prompt - which they will not look for unless they are told.
    ///
    /// The ABANDON snapshot is the one to pair this with: a delete forfeits any
    /// un-pushed edits by definition, so the veto that protects them on
    /// close / quit / switch has nothing left to protect and would only strand the
    /// server lock.
    ///
    /// The same deferral is why the acquisition-record clear below is CONDITIONAL,
    /// unlike the one every other release verb makes - see
    /// [`AppState::speleodb_forget_lock_acquired_for`] - and why the RELEASE ITSELF is
    /// conditional too, which no other verb's is: see the skip below.
    pub(super) fn speleodb_release_captured_lock(
        &self,
        params: &LockReleaseParams,
    ) -> Result<(), SpeleoDbError> {
        // The same bookkeeping `speleodb_release_best_effort` does, and for the same
        // reason: a release we asked for ends this process's claim on the lock whether
        // or not the POST lands, and one that failed leaves behind a lock this process
        // can no longer account for.
        //
        // But KEYED on the project AND on the session that took it, which that one
        // does not have to be. Every caller of `speleodb_release_best_effort` decides
        // and clears in one breath, so no other acquisition can have happened in
        // between; this one runs after `delete_project` has dropped the `project`
        // mutex, and a Start editing inside that gap records ITSELF in the very slot
        // an unconditional clear would then blank. See the helper for what that costs
        // - and for why the project id alone cannot tell the two claims apart.
        self.speleodb_forget_lock_acquired_for(&params.project_id, Some(params.session));
        // Has another edit session taken over this same remote project's lock while we
        // were getting here? Then the mutex is no longer ours to hand back.
        //
        // The delete drops the `project` guard before this runs - an HTTP round trip
        // may not happen under it - and inside that gap another local `.stalx` linked
        // to the SAME remote project can be opened and Started editing. Two files can
        // carry one `speleo_link` row (Save-As copies it forward, and a re-pull
        // rebuilds the cache copy at the very path this delete just trashed), and the
        // server answers a re-acquire by an account that already holds the mutex with
        // a successful no-op - so the replacement session becomes editable UNDER THE
        // LOCK THIS RELEASE IS ABOUT TO FREE, without taking a lock of its own and
        // without recording anything. Releasing anyway leaves it `edit_enabled` and
        // not force-editing with no server lock behind it: the unflagged lockless
        // edit session the rest of this crate treats as unreachable, with nothing
        // behind it but the 20-minute #202 re-verify.
        //
        // So leave the mutex held and let the session that is actually editing under
        // it release it on close / Done / quit. That is the recoverable direction this
        // module argues for everywhere else: a lock kept back times out on the server
        // and is re-offered by the next login's held-lock prompt, while work stranded
        // behind a freed lock is not recoverable at all.
        //
        // BOTH terms are load-bearing. The session comparison alone would skip the
        // release whenever ANYTHING had been opened since - an unrelated local project
        // would strand the deleted project's mutex forever, which is the bug this
        // deferred release exists to fix. The live-edit-session test alone is sound
        // only because the delete happens to tear down first: it says nothing about a
        // caller that defers a release WITHOUT ending its session, and it is the
        // session id that makes "a DIFFERENT session" a fact rather than an inference
        // from the call order.
        if self.project_session() != params.session
            && self.speleodb_editing_under(&params.project_id)
        {
            tracing::info!(
                project_id = %params.project_id,
                purpose = "avoid freeing the lock a replacement edit session is using",
                "speleodb: skipping the deleted project's lock release; another session \
                 is editing the same remote project under that lock"
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

    /// Whether the OPEN project is `project_id` and is being edited under a genuinely
    /// held server lock right now.
    ///
    /// The three conjuncts are the ones every lock-aware path in this crate uses, in
    /// the same order: the edit gate is the permission, `!force_editing` is what
    /// separates a lock-holding session from a #213 force-editor (edit-enabled while
    /// holding NO lock, so its presence is no reason to keep a mutex alive), and the
    /// link is what says the lock in question is this one.
    ///
    /// Reads the link through the database handle, so it must not be called while the
    /// `project` guard is held: the order is `project` -> `database` and this takes
    /// the second without the first. Its only caller runs after `delete_project` has
    /// released that guard, which is the same constraint the network release has.
    fn speleodb_editing_under(&self, project_id: &str) -> bool {
        self.edit_enabled()
            && !self.force_editing()
            && self
                .speleodb_open_link()
                .is_ok_and(|l| l.project_id == project_id)
    }

    /// Snapshot the release params, then run the network release on a detached
    /// thread, returning a receiver for its outcome (or `None` when no lock is held,
    /// so nothing was spawned). Because the params are captured synchronously first,
    /// the release targets the CURRENT project even if the caller swaps the database
    /// immediately after. Shared by the two non-blocking callers below.
    fn speleodb_spawn_lock_release(
        &self,
    ) -> Option<std::sync::mpsc::Receiver<Result<(), SpeleoDbError>>> {
        let p = self.speleodb_held_lock_release_params()?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(
                client::release_lock(&p.endpoint, &p.token, p.insecure_http, &p.project_id)
                    .map(|_| ()),
            );
        });
        Some(rx)
    }

    /// Release a held write lock WITHOUT blocking the caller: fire the network
    /// release on a detached thread and return immediately. For a project switch,
    /// where waiting would stall opening the NEXT project on the OLD project's
    /// (possibly unreachable) server (fix M1). No-op when no lock is held.
    pub(crate) fn speleodb_release_held_lock_detached(&self) {
        // Drop the receiver: the release still runs on its thread (best-effort); we
        // just don't wait for or read the result.
        let _ = self.speleodb_spawn_lock_release();
    }

    /// Release a held write lock with a hard deadline, for the app-exit path: run
    /// the network release on a detached thread and wait at most `deadline`. A hung
    /// / unreachable server must not freeze quit for the full HTTP timeout; on
    /// timeout we return and let the process exit (the server lock times out on its
    /// own). (fix M2). No-op when no lock is held.
    pub(crate) fn speleodb_release_held_lock_bounded(&self, deadline: Duration) {
        let Some(rx) = self.speleodb_spawn_lock_release() else {
            return;
        };
        match rx.recv_timeout(deadline) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(
                error = %e,
                purpose = "release held lock on exit",
                "speleodb: exit-time lock release failed"
            ),
            Err(_) => tracing::warn!(
                purpose = "release held lock on exit",
                "speleodb: exit-time lock release timed out; exiting anyway"
            ),
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    clippy::panic,
    reason = "unit test fixtures fail loudly on setup errors; the panic POISONS a mutex on purpose"
)]
mod tests {
    use super::AppState;

    #[test]
    fn a_poisoned_database_lock_declines_the_release_without_panicking() {
        // A poisoned mutex is not "there is nothing to release". Both reads in
        // `speleodb_lock_release_params` used to be `.ok()?`, which folded
        // `Io("database lock poisoned")` and `Io("SpeleoDB session lock poisoned")` into
        // the ordinary no-op with no trace at all - so a poisoned mutex at close /
        // switch / quit stranded the server lock permanently and silently, which is the
        // exact outcome this module exists to prevent. The failures are now matched and
        // logged (the veto three lines down always was).
        //
        // Behaviourally the answer is still `None` - keeping the lock held is the
        // recoverable direction - so what is pinned here is that the poisoned path is
        // reached and handled rather than panicking, and the log side is pinned by
        // `both_release_param_reads_log_their_real_failures`.
        let state = AppState::new().expect("state");
        state.set_edit_enabled(true);
        let db = &state.database;
        let _ = std::thread::scope(|s| {
            s.spawn(|| {
                let _guard = db.lock().expect("lock to poison");
                panic!("poison the database mutex on purpose");
            })
            .join()
        });
        assert!(
            state.database.is_poisoned(),
            "precondition: the database mutex is poisoned"
        );

        assert!(
            state.speleodb_held_lock_release_params().is_none(),
            "a poisoned lock declines the release (recoverable) rather than panicking"
        );
        assert!(
            state.speleodb_abandon_lock_release_params().is_none(),
            "and so does the abandoning variant"
        );
    }

    #[test]
    fn both_release_param_reads_log_their_real_failures() {
        // Whether a failure was LOGGED is not observable from the return value (both
        // arms are `None`), and silence is the whole defect: an operator looking at why
        // a project stayed locked forever had nothing to go on. Guard it at the source -
        // neither read may be a bare `.ok()?` again, and each must have a `warn!`.
        let src = include_str!("speleodb_lock_release.rs");
        let start = src
            .find("fn speleodb_lock_release_params")
            .expect("the shared body is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];
        // Matched on the CALLS, not on a bare `.ok()?` needle - the body's own comment
        // quotes that spelling while explaining why it is gone.
        for call in [
            "self.speleodb_open_link().ok()",
            "self.speleodb_active_token().ok()",
        ] {
            assert!(
                !body.contains(call),
                "`{call}` collapses a real failure into the ordinary no-op; match the \
                 error and warn instead"
            );
        }
        assert_eq!(
            body.matches("tracing::warn!").count(),
            2,
            "both the link read and the token read must warn on an unexpected failure"
        );
    }
}
