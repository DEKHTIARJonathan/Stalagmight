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
//! What makes both guards sound is the `speleodb_lock_ops` mutex, which every
//! SpeleoDB LOCK OPERATION holds for its whole span:
//!
//! - Start Editing, from before its FIRST read (generation, link, token,
//!   mutex holder) through the commit. Each of those facts is one another
//!   lock operation can invalidate mid-flight, so the span has to start
//!   before the earliest of them, not at the acquire.
//! - Every reclaim-checked release, across check -> POST, so a claim cannot
//!   be minted between a release's decision and its network call.
//! - The status poll's inherited-lock gate reopen, across its holder re-read
//!   and the gate ([`AppState::speleodb_reopen_gate_for_inherited_lock`]).
//! - LOGOUT, which ends an edit session and hands its mutex back. It is the
//!   one boundary the identity check cannot see (the project slot never
//!   moves), so excluding it from the spans above is what lets the
//!   fast-forward arm commit on identity alone.
//!
//! Deliberately held across network I/O - which is exactly why it is
//! OUTERMOST: nothing that holds `project` / `database` / `undo_stack` may
//! block on it (decide under `project`, drop, then take it), and code already
//! inside a lock-ops span uses the `_locked` variants instead of re-taking it.
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

/// WHICH project this process took a write lock on, and under WHOSE account.
///
/// The account half is not bookkeeping. A lock lives on ONE server under ONE
/// user, and this record outlives the session that made it on purpose - it is
/// the only local pointer to a mutex a torn-down session left held, and the
/// janitor's whole job is to hand that mutex back later. "Later" can be after a
/// sign-out and a sign-in as somebody else, or to a different SpeleoDB
/// deployment: without the account stamped on it, a bare project id gets paired
/// with whatever credentials happen to be around when the cleanup finally runs.
/// That POSTs project A's id to server B, reads B's idempotent success as
/// cleanup, and clears the only pointer to the lock still held on A - or takes
/// a 403 under the wrong account and retries forever.
///
/// It is also what makes the authorship shortcut honest
/// (`AppState::speleodb_remote_state`): a claim earned as one user says nothing
/// about what another user's session pushed.
#[derive(Debug, Clone)]
pub(super) struct LockClaim {
    /// The project whose server mutex this process took.
    pub(super) project_id: String,
    /// The SpeleoDB deployment it was taken on.
    endpoint: String,
    /// The account it was taken as.
    email: String,
}

impl LockClaim {
    /// A claim on `project_id`, stamped with the account it was taken under.
    ///
    /// `endpoint` and `email` must be read from the SAME session-lock
    /// acquisition that stores the result, so the stamp cannot name an account
    /// other than the one whose token the acquire used.
    pub(super) fn taken(project_id: &str, endpoint: String, email: String) -> Self {
        Self {
            project_id: project_id.to_owned(),
            endpoint,
            email,
        }
    }

    /// Whether this claim belongs to the account `(endpoint, email)` names -
    /// i.e. whether that account's token is the one that can release it.
    ///
    /// Email comparison is case-insensitive, matching every other "is this us?"
    /// test in this tree (`lock_held_by_me`, the #202 re-verify): SpeleoDB may
    /// normalise case, and a claim we refuse to recognise is a lock nothing
    /// hands back. The endpoint is compared exactly - it is the same resolved
    /// string the acquire used, and a user who has since pointed the app at a
    /// different deployment must NOT have this claim released against it.
    pub(super) fn taken_by(&self, endpoint: Option<&str>, email: Option<&str>) -> bool {
        matches!(
            (endpoint, email),
            (Some(e), Some(m)) if e == self.endpoint && m.eq_ignore_ascii_case(&self.email)
        )
    }
}

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
    ///   What makes identity ENOUGH is not identity: it is that the one boundary
    ///   identity cannot see is excluded from the caller's span. Every other
    ///   boundary moves the project slot (close, delete, switch), so the link
    ///   comparison below catches it. LOGOUT does not - it ends the session and
    ///   leaves the slot exactly where it was - and a logout landing after the
    ///   reload therefore passed this check and reopened the edit gate for a
    ///   signed-out user, on a remote project whose mutex this process still held
    ///   (round 6). It cannot land there any more: logout takes
    ///   `speleodb_lock_ops`, which Start Editing holds from before its first
    ///   read through this commit, so it runs strictly before the flow (whose
    ///   token read then fails) or strictly after it. Anything that gives a
    ///   session boundary a way past that guard puts this arm back where it was.
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
            // This account's claims only. The gate is a fact about the session
            // signed in NOW; another account's retained claim is a pointer to a
            // mutex still held elsewhere, and dropping it strands that mutex.
            let (endpoint, email) = (session.endpoint.clone(), session.email.clone());
            session
                .locks_acquired_here
                .retain(|claim| !claim.taken_by(endpoint.as_deref(), email.as_deref()));
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

    /// The status poll's inherited-lock gate reopen: enable editing on the open
    /// remote project because the SERVER says this account already holds its
    /// mutex - re-asked and committed inside the lock-ops span, so the answer
    /// cannot go stale between the asking and the gate.
    ///
    /// The poll's own `get_project` cannot license this. It is one read in a
    /// sequence of several, and a captured or janitor release for this very
    /// project can complete between that read and the gate: the release's
    /// reclaim check looks for a claim record (none - the poll never minted one)
    /// and a live edit session (none - the gate is still SHUT, which is exactly
    /// why the poll is here), so it rightly POSTs and frees the mutex. Opening
    /// the gate from the earlier read then leaves a session editing a remote
    /// project with no server lock behind it and no record saying so - the one
    /// state the whole lock protocol is built to prevent.
    ///
    /// So the holder is read AGAIN under `speleodb_lock_ops`, and the gate opens
    /// in the same span. A release either finished first (the re-read finds the
    /// mutex free or someone else's, and the gate stays shut - the user can
    /// Start Editing to take it properly) or has not started (it will find the
    /// open gate and stand down, per
    /// [`Self::speleodb_live_session_accounts_for`]).
    ///
    /// Commits through [`Self::speleodb_commit_editing`] with `acquired_here`
    /// false: an inherited lock is an edit session, never an acquisition. A
    /// failed re-read declines to reopen - "cannot say" must not enable editing.
    pub(super) fn speleodb_reopen_gate_for_inherited_lock(
        &self,
        link: &crate::models::SpeleoLink,
    ) -> bool {
        let Ok((endpoint, token)) = self.speleodb_active_token() else {
            return false;
        };
        let insecure_http = self.speleodb_insecure_http();
        let _lock_ops = self.speleodb_lock_ops_guard();
        let holder = match self.speleodb_lock_holder_checked(
            &endpoint,
            &token,
            insecure_http,
            &link.project_id,
        ) {
            Ok(holder) => holder,
            Err(e) => {
                tracing::debug!(
                    error = %e,
                    project_id = %link.project_id,
                    purpose = "confirm we still hold the lock before reopening the gate",
                    "speleodb: could not re-read the lock holder; leaving the project read-only"
                );
                return false;
            }
        };
        if !super::speleodb::lock_held_by_me(holder.as_deref(), self.speleodb_my_email().as_deref())
        {
            return false;
        }
        self.speleodb_commit_editing(None, &link.project_id, false)
            .is_ok()
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
    ///
    /// Which is exactly why the claim carries the account it was taken under
    /// ([`LockClaim`]) and this pairs the id with THAT account's credentials,
    /// never with whoever happens to be signed in when the cleanup finally
    /// runs. A record surviving a sign-out is the normal case here, and the
    /// next sign-in can be a different user or a different deployment: posting
    /// project A's id to server B would read B's idempotent success as cleanup
    /// and drop the only pointer to the lock still held on A.
    pub(super) fn speleodb_janitor_stranded_claim(&self) {
        let params = {
            let proj_guard = self
                .project
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if proj_guard.is_some() {
                return;
            }
            {
                // Unusable ids first, whoever they belong to: one that can never
                // be joined into a URL can never be released either, so clearing
                // is its only safe end and nobody's later sign-in helps.
                let Ok(mut session) = self.speleodb_session_lock() else {
                    return;
                };
                session.locks_acquired_here.retain(|claim| {
                    super::speleodb::validate_project_id(&claim.project_id).is_ok()
                });
                if session.locks_acquired_here.is_empty() {
                    return;
                }
            }
            // The ACCOUNT is resolved BEFORE a claim is chosen, because it is what
            // makes a claim choosable at all: only the account that took a lock can
            // hand it back. Picking first and testing afterwards let one account's
            // retained claim sit at the head of the list and answer every poll -
            // failing the test, returning, and starving a claim the live account
            // COULD have released until the other user happened to sign in.
            //
            // Both reads take the session lock themselves, so neither may run under
            // it (the mutex is not reentrant). `proj_guard` is still held, so no
            // session can begin underneath them.
            let Ok((endpoint, token)) = self.speleodb_active_token() else {
                // No token, no POST. Keep the records: they describe dead sessions
                // either way, but with no project open they drive nothing except
                // this janitor, and the poll after a sign-in walks this branch
                // again WITH a token.
                return;
            };
            let me = self.speleodb_my_email();
            let Ok(mut session) = self.speleodb_session_lock() else {
                return;
            };
            // One claim per visit - the poll comes back for the rest.
            let Some(position) = session
                .locks_acquired_here
                .iter()
                .position(|claim| claim.taken_by(Some(&endpoint), me.as_deref()))
            else {
                // Everything retained belongs to another account or another
                // deployment. Their tokens are the only ones that can release
                // them, so hold the records until one of those signs in; using
                // this token would either succeed against the wrong project on
                // the wrong server or 403 forever.
                tracing::debug!(
                    purpose = "clean up after a torn-down edit session",
                    "speleodb: holding stranded claims until their own accounts sign in again"
                );
                return;
            };
            // Removed by position, so the entry taken is exactly the entry
            // chosen - no second predicate to drift from the first.
            let claim = session.locks_acquired_here.remove(position);
            drop(session);
            tracing::info!(
                project_id = %claim.project_id,
                purpose = "clean up after a torn-down edit session",
                "speleodb: clearing a lock claim with no project open"
            );
            (
                LockReleaseParams {
                    endpoint,
                    token,
                    insecure_http: self.speleodb_insecure_http(),
                    project_id: claim.project_id.clone(),
                },
                claim,
            )
        };
        let (params, claim) = params;
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
            // Restore for the retry - the WHOLE claim, account included, or the
            // retry would be the account-blind pairing this cleanup just
            // refused to make. Only into the same no-project-open world the
            // decision read: with a project open the field belongs to the live
            // world (its own verbs and catch-alls own it), and this janitor
            // never runs there anyway.
            let proj_guard = self
                .project
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if proj_guard.is_none() {
                if let Ok(mut session) = self.speleodb_session_lock() {
                    // Only if nothing has re-claimed this project meanwhile: a
                    // successor's entry is newer than ours and must stand.
                    if !session
                        .locks_acquired_here
                        .iter()
                        .any(|live| live.project_id == claim.project_id)
                    {
                        session.locks_acquired_here.push(claim);
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

    /// A signed-in session, so a claim has an account to be stamped with
    /// ([`super::LockClaim`]). Points at a dead endpoint: token resolution
    /// succeeds locally and every POST fails fast (nothing listens on port 1).
    /// The in-memory token store keeps it hermetic - no OS keychain probe, and
    /// `endpoint.is_some()` short-circuits the rehydration.
    fn sign_in_unreachable(state: &AppState) {
        sign_in_as(state, "http://127.0.0.1:1/", "diver@example.com");
    }

    /// [`sign_in_unreachable`] for a named account on a named deployment, for
    /// the tests about a claim outliving the account that made it.
    fn sign_in_as(state: &AppState, endpoint: &str, email: &str) {
        let mut session = state.speleodb_session_lock().expect("session lock");
        session.endpoint = Some(endpoint.to_owned());
        session.email = Some(email.to_owned());
        session.token_store = crate::speleodb::auth::TokenStore::from_in_memory_token("tok");
    }

    /// Every claim still retained, whatever account it belongs to.
    ///
    /// The accessors deliberately answer only for the account signed in NOW
    /// (`speleodb_lock_acquired_here`, `speleodb_acquired_here_project`), so a
    /// claim held FOR a signed-out or different account is invisible through
    /// them - which is the whole point, and exactly what these tests have to
    /// look past to see that it survived.
    fn retained_projects(state: &AppState) -> Vec<String> {
        state
            .speleodb_session_lock()
            .expect("session lock")
            .locks_acquired_here
            .iter()
            .map(|claim| claim.project_id.clone())
            .collect()
    }

    /// Sign out, WITHOUT touching the claim - what a logout that could not run
    /// its release leaves behind, and the state the janitor is written for.
    fn sign_out(state: &AppState) {
        let mut session = state.speleodb_session_lock().expect("session lock");
        session.endpoint = None;
        session.email = None;
        session.token_store = crate::speleodb::auth::TokenStore::from_stores(
            Box::new(crate::speleodb::auth::InMemoryStore::new()),
            None,
        );
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
        sign_in_unreachable(&state);
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
        sign_in_unreachable(&state);
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
        sign_in_unreachable(&state);
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
    #[test]
    fn the_janitor_leaves_a_live_claim_and_a_signed_out_stranded_claim_alone() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        sign_in_unreachable(&state);

        // A project open: the claim may be live - leave it alone.
        open_linked(&state, temp.path(), "a.stalx", ID);
        state.speleodb_note_lock_acquired(Some(ID));
        state.speleodb_janitor_stranded_claim();
        assert!(
            state.speleodb_lock_acquired_here(ID),
            "a claim with a project open is not the janitor's to judge"
        );

        // No project open, and signed out afterwards: no token means no release
        // POST, and the record is the ONLY pointer to the stranded lock - keep
        // it so the first poll after a sign-in can retry (round 5).
        state.close_project();
        state.speleodb_note_lock_acquired(Some(ID));
        sign_out(&state);
        state.speleodb_janitor_stranded_claim();
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned()],
            "signed out, the record must survive: it is the retry"
        );
    }

    #[test]
    fn a_new_acquisition_leaves_another_accounts_retained_claim_alone() {
        // Round 7 (P2): a claim can outlive the session that made it - logout
        // declines to release over un-pushed edits, and a torn-down session
        // leaves one for the janitor - and only its own account can ever hand
        // that mutex back. With ONE slot, signing in as somebody else and
        // starting to edit anything overwrote the only pointer to it, and the
        // lock was stranded until the server's own timeout.
        let state = AppState::new().expect("state");
        sign_in_as(&state, "http://127.0.0.1:1/", "first@example.com");
        state.speleodb_note_lock_acquired(Some(ID));

        sign_in_as(&state, "http://127.0.0.1:1/", "second@example.com");
        state.speleodb_note_lock_acquired(Some(OTHER_ID));

        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned(), OTHER_ID.to_owned()],
            "the new acquisition must not evict the claim held for another account"
        );
        assert!(
            state.speleodb_lock_acquired_here(OTHER_ID),
            "the live account's own claim answers for it"
        );
        assert!(
            !state.speleodb_lock_acquired_here(ID),
            "another account's does not - it is no evidence about this session"
        );
        assert_eq!(
            state.speleodb_acquired_here_project().as_deref(),
            Some(OTHER_ID),
            "and the unwind is only ever offered the live account's project: \
             releasing the other one would use these credentials against a lock \
             they have nothing to do with (round 7 P1)"
        );

        // Re-acquiring the SAME project replaces that entry rather than piling
        // a duplicate on top of it.
        state.speleodb_note_lock_acquired(Some(OTHER_ID));
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned(), OTHER_ID.to_owned()],
            "one claim per (account, project), not one per acquisition"
        );

        // Round 8 (P2): a DIFFERENT project ADDS an entry. One account can be
        // owed more than one mutex - a janitor release that failed transiently
        // leaves exactly such a claim - and locking a second project must not be
        // what loses the first one's retry pointer.
        const THIRD_ID: &str = "33333333-3333-3333-3333-333333333333";
        state.speleodb_note_lock_acquired(Some(THIRD_ID));
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned(), OTHER_ID.to_owned(), THIRD_ID.to_owned()],
            "acquiring one project must not end this account's claim on another"
        );

        // A per-project release ends exactly that project's claim...
        state.speleodb_forget_lock_acquired_for(OTHER_ID);
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned(), THIRD_ID.to_owned()],
            "the per-project release is the one that ends one claim"
        );

        // ...and release-all ends this account's claims without touching the
        // other account's.
        state.speleodb_note_lock_acquired(None);
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned()],
            "the first account's claim survives a second account's release-all"
        );

        sign_out(&state);
        assert_eq!(
            state.speleodb_acquired_here_project(),
            None,
            "signed out there is no live account, so no claim is ours to unwind"
        );
    }

    /// A loopback server that answers every request with 200 and a minimal
    /// project body - enough for `release_lock` to read a success.
    fn release_stub(project_id: &str) -> (String, std::net::TcpListener) {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("addr").port();
        let body = format!(r#"{{"id":"{project_id}","name":"Remote"}}"#);
        let accept_on = listener.try_clone().expect("clone listener");
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = accept_on.accept() {
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(150)));
                let mut chunk = vec![0u8; 8 * 1024];
                while let Ok(n) = stream.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    if chunk[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://127.0.0.1:{port}"), listener)
    }

    #[test]
    fn the_janitor_picks_the_claim_the_live_account_can_actually_release() {
        // Round 8 (P2): another account's retained claim sitting at the head of
        // the list used to answer every poll - the janitor took the FIRST entry,
        // found it was not this session's to release, and returned. The live
        // account's own stranded claim was never attempted, for as long as that
        // other user did not happen to sign in.
        //
        // The stub answers the release, so the two behaviours are told apart by
        // what is LEFT: choosing correctly releases our claim and drops it,
        // while stopping at the head of the list leaves both standing.
        let (base, _listener) = release_stub(OTHER_ID);
        let state = AppState::new().expect("state");
        sign_in_as(&state, "http://127.0.0.1:1/", "first@example.com");
        state.speleodb_note_lock_acquired(Some(ID));

        sign_in_as(&state, &base, "second@example.com");
        state.speleodb_note_lock_acquired(Some(OTHER_ID));
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned(), OTHER_ID.to_owned()],
            "fixture: the other account's claim is FIRST in the list"
        );

        state.speleodb_janitor_stranded_claim();

        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned()],
            "the live account's claim was found past the head of the list, \
             released, and dropped - and the other account's is untouched"
        );
    }

    #[test]
    fn the_janitor_will_not_release_one_accounts_lock_with_anothers_token() {
        // Round 6 (P2): a stranded claim outliving a sign-out is the NORMAL case
        // here - and the next sign-in can be a different user, or the same user
        // against a different deployment. Pairing the id with whatever
        // credentials are around by then posts project A's id to server B,
        // reads B's idempotent success as cleanup, and drops the only pointer
        // to the lock still held on A.
        let state = AppState::new().expect("state");
        sign_in_as(&state, "http://127.0.0.1:1/", "diver@example.com");
        state.speleodb_note_lock_acquired(Some(ID));

        // Same person, different deployment.
        sign_in_as(&state, "http://127.0.0.1:2/", "diver@example.com");
        state.speleodb_janitor_stranded_claim();
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned()],
            "a claim taken on another server is not this one's to clean up"
        );

        // Same deployment, different person.
        sign_in_as(&state, "http://127.0.0.1:1/", "someone.else@example.com");
        state.speleodb_janitor_stranded_claim();
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned()],
            "nor is a claim taken by another account"
        );

        // And the account that DID take it still gets to clean up: the POST
        // fails against the dead endpoint, so the claim comes back for the next
        // poll rather than being lost.
        sign_in_as(&state, "http://127.0.0.1:1/", "DIVER@example.com");
        state.speleodb_janitor_stranded_claim();
        assert_eq!(
            retained_projects(&state),
            vec![ID.to_owned()],
            "the same account under a different case is still the same account, \
             so this one tried the release and restored the claim when it failed"
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

        let lock_ops = body
            .find("self.speleodb_lock_ops_guard()")
            .expect("the acquire span must be serialized against captured releases");
        let snapshot = body
            .find("self.speleodb_session_snapshot()")
            .expect("entry must snapshot generation + link as one world (D6)");
        let token = body
            .find("self.speleodb_active_token()")
            .expect("the flow resolves a token");
        let probe = body
            .find("self.speleodb_lock_holder_checked(")
            .expect("the pre-acquire holder probe is present");
        let acquire = body
            .find("client::acquire_lock(")
            .expect("the acquire is present");
        assert!(
            lock_ops < snapshot && snapshot < token && token < probe && probe < acquire,
            "order must be: lock-ops guard FIRST, then the session snapshot, the \
             token, the holder probe, and the acquire. Every fact after the guard \
             is one another lock operation could invalidate: a probe outside the \
             span reads provenance a captured release can undo before the acquire \
             (round 5), and a token read outside it lets a logout leave this flow \
             committing on behalf of a signed-out session (round 6)"
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
    fn every_file_backed_installer_finalizes_under_one_project_guard() {
        // Round 4: the delete's check-and-teardown holds the `project` mutex
        // and reasons "strictly before the load, or strictly after it". That
        // argument is only sound while every installer of a file-backed
        // project commits the slot AND its companion state (database handle,
        // undo stack, recents) inside one unbroken acquisition - a slot commit
        // in its own span reopens the torn-middle interleaving where the
        // delete tears down a half-built session and the loader finishes
        // building into an empty world. `create_project` is exempt: it
        // commits a project with no `file_path`, which the delete's identity
        // check can never match.
        for (file, func, database_commit, undo_commit) in [
            (
                "project_load.rs",
                "fn open_project",
                " = Some(db);",
                "load_from_persisted_with_timestamps(",
            ),
            (
                "project_load.rs",
                "pub fn do_load_project_full",
                " = Some(db);",
                "load_from_persisted_with_timestamps(",
            ),
            (
                "project_create.rs",
                "fn do_create_project_full",
                " = db;",
                ".clear();",
            ),
        ] {
            let src = state_source(file);
            let start = src
                .find(func)
                .unwrap_or_else(|| panic!("{func} is present in {file}"));
            let body = &src[start..];
            let body = &body[..body.find("\n    }\n").expect("fn body terminates")];

            let guard = body
                .find("let mut proj_guard")
                .unwrap_or_else(|| panic!("{func} takes the project guard by name"));
            let slot = body
                .find(" = Some(project")
                .unwrap_or_else(|| panic!("{func} commits the project slot"));
            let db_commit = body
                .find(database_commit)
                .unwrap_or_else(|| panic!("{func} commits the database handle"));
            let undo = body
                .find(undo_commit)
                .unwrap_or_else(|| panic!("{func} commits the undo stack"));
            let released = body
                .find("drop(proj_guard)")
                .unwrap_or_else(|| panic!("{func} releases the guard explicitly"));
            assert!(
                guard < slot && slot < db_commit && db_commit < undo && undo < released,
                "{func} must commit slot, database and undo history inside one \
                 project-guard span (guard at {guard}, slot {slot}, database \
                 {db_commit}, undo {undo}, drop {released})"
            );
            assert_eq!(
                body.matches("drop(proj_guard)").count(),
                1,
                "{func}: one release, at the end of the finalization"
            );
        }
    }

    #[test]
    fn logout_takes_the_lock_ops_guard_before_it_ends_the_session() {
        // The fast-forward arm commits on identity alone, and identity cannot see
        // a logout (the project slot never moves). What keeps that sound is this
        // guard: logout is a lock operation like the acquire and the captured
        // releases, so it cannot run inside a Start Editing span. Drop it here and
        // the identity-only commit silently goes back to reopening the edit gate
        // for a signed-out session (round 6).
        let src = state_source("speleodb_logout.rs");
        // Production region only, like every other scan in this family - and here
        // it also keeps the search off the test-only wrapper whose name starts
        // with the same words.
        let src = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let start = src
            .find("fn speleodb_logout(")
            .expect("the logout verb is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];

        let guard = body
            .find("self.speleodb_lock_ops_guard()")
            .expect("logout must serialize with every other SpeleoDB lock operation");
        let gates = body
            .find("self.speleodb_logout_drop_gates()")
            .expect("logout drops the gates and releases the lock");
        let forget = body
            .find(".forget_reporting()")
            .expect("logout forgets the credential");
        assert!(
            guard < gates && gates < forget,
            "the guard has to be taken BEFORE the gates drop and still be held \
             when the credential goes. Round 6 scoped it to the gate half alone, \
             which left a Start Editing free to take it the instant that half \
             returned, read the not-yet-forgotten token, and commit an edit \
             session for an account this call was in the middle of deleting"
        );
        // The gate half must NOT re-take it: the span belongs to the whole verb.
        let gate_half = src
            .find("fn speleodb_logout_drop_gates")
            .expect("the gate-drop half is present");
        let gate_body = &src[gate_half..];
        let gate_body = &gate_body[..gate_body.find("\n    }\n").expect("fn body terminates")];
        assert!(
            !gate_body.contains("self.speleodb_lock_ops_guard()"),
            "the gate half must inherit its caller's span, not open a narrower \
             one of its own (the mutex is not reentrant either)"
        );
        assert!(
            gate_body.contains("self.bump_speleodb_session()"),
            "logout is still a session boundary"
        );
    }

    #[test]
    fn logout_waits_for_an_in_flight_lock_operation() {
        // The tripwire above reads the source; this one proves the exclusion is
        // real, over the WHOLE verb rather than its gate half. With the lock-ops
        // guard held, a logout on another thread must not reach its session
        // boundary - if it does, it is landing in the middle of exactly the span
        // the guard exists to protect.
        //
        // `with_isolated_config` because logout writes the config (it clears the
        // rehydrate seed); the override is process-global, so the spawned thread
        // sees it too.
        crate::test_helpers::with_isolated_config(|| {
            let state = AppState::new().expect("state");
            let before = state.speleodb_session_generation();
            let (started, has_started) = std::sync::mpsc::channel();
            let (finished, has_finished) = std::sync::mpsc::channel();

            let lock_ops = state.speleodb_lock_ops_guard();
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    started.send(()).expect("announce the thread is running");
                    let _ = state.speleodb_logout();
                    finished.send(()).expect("announce the logout got through");
                });

                has_started.recv().expect("the thread runs");
                assert!(
                    has_finished
                        .recv_timeout(std::time::Duration::from_millis(250))
                        .is_err(),
                    "a logout must not end the session while a lock operation \
                     holds the guard"
                );
                assert_eq!(
                    state.speleodb_session_generation(),
                    before,
                    "and it must not have published its boundary either"
                );

                drop(lock_ops);
                has_finished
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .expect("the logout completes once the span ends");
            });
            assert_ne!(
                state.speleodb_session_generation(),
                before,
                "the logout still happens - it is deferred, never dropped"
            );
        });
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
