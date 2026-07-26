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

use std::time::Duration;

use super::AppState;
use crate::speleodb::client;
use crate::speleodb::SpeleoDbError;

impl AppState {
    /// Snapshot of what a best-effort lock release needs (endpoint, token, the
    /// insecure-http allowance, project id), or `None` when no held remote edit
    /// session is active - or when releasing would strand local work. Cheap +
    /// non-blocking (reads the open link + config, no network), so a caller that
    /// must not block on the OLD project's server - the app-exit path, a project
    /// switch - can hand the actual HTTP release to a bounded / detached thread.
    /// Reads the link BEFORE the caller tears down or swaps the database.
    pub(super) fn speleodb_held_lock_release_params(
        &self,
    ) -> Option<(String, String, bool, String)> {
        self.speleodb_lock_release_params(true)
    }

    /// The same snapshot WITHOUT the un-pushed-edits veto, for a deliberate
    /// abandon (see [`AppState::speleodb_release_held_lock_abandoning`]).
    pub(super) fn speleodb_abandon_lock_release_params(
        &self,
    ) -> Option<(String, String, bool, String)> {
        self.speleodb_lock_release_params(false)
    }

    /// Shared body of the two snapshots above. `veto_unpushed` is what separates a
    /// silent release from a deliberate one.
    fn speleodb_lock_release_params(
        &self,
        veto_unpushed: bool,
    ) -> Option<(String, String, bool, String)> {
        // #213: a force-editor is edit-enabled but holds NO lock, so there is nothing
        // to release on close / app-exit / project-switch.
        if !self.edit_enabled() || self.force_editing() {
            return None;
        }
        let link = self.speleodb_open_link().ok()?;
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
        if veto_unpushed && link.has_unpushed_edits {
            tracing::info!(
                project_id = %link.project_id,
                purpose = "avoid stranding un-pushed local edits behind a freed lock",
                "speleodb: skipping the silent lock release; the project has un-pushed edits"
            );
            return None;
        }
        let (endpoint, token) = self.speleodb_active_token().ok()?;
        Some((
            endpoint,
            token,
            self.speleodb_insecure_http(),
            link.project_id,
        ))
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
        if let Some((endpoint, token, insecure_http, project_id)) =
            self.speleodb_held_lock_release_params()
        {
            self.speleodb_release_best_effort(&endpoint, &token, insecure_http, &project_id);
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
        if let Some((endpoint, token, insecure_http, project_id)) =
            self.speleodb_abandon_lock_release_params()
        {
            self.speleodb_release_best_effort(&endpoint, &token, insecure_http, &project_id);
        }
    }

    /// Snapshot the release params, then run the network release on a detached
    /// thread, returning a receiver for its outcome (or `None` when no lock is held,
    /// so nothing was spawned). Because the params are captured synchronously first,
    /// the release targets the CURRENT project even if the caller swaps the database
    /// immediately after. Shared by the two non-blocking callers below.
    fn speleodb_spawn_lock_release(
        &self,
    ) -> Option<std::sync::mpsc::Receiver<Result<(), SpeleoDbError>>> {
        let (endpoint, token, insecure_http, project_id) =
            self.speleodb_held_lock_release_params()?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(
                client::release_lock(&endpoint, &token, insecure_http, &project_id).map(|_| ()),
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
