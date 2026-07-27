//! Logging OUT of SpeleoDB, and the two RESIDUES a logout has to clear.
//!
//! Split out of `core::state::speleodb` because logout is not one action but three
//! that must all happen and are each independently fallible, and the rules for what
//! to do when one fails are subtle enough to deserve their own place:
//!
//! 1. the transient EDIT GATE (and the force-edit gate), plus a best-effort release
//!    of a held write lock - see [`AppState::speleodb_release_held_lock_best_effort`];
//! 2. the stored CREDENTIAL, across every [`crate::speleodb::auth::SecretStore`] tier;
//! 3. the persisted account EMAIL - the *rehydrate seed*.
//!
//! (2) and (3) are one hazard, not two. A credential that outlives a failed delete is
//! only dangerous because `speleodb_ensure_rehydrated` keys the keychain lookup by the
//! saved email: leave the seed and the next launch finds the credential and silently
//! re-authenticates a user who asked to log out. So both are reported, and a run that
//! fails both reports both.
//!
//! The logout ITSELF always happens - the user asked for it, and a flaky keychain must
//! never leave them logged in. The `Err` is a WARNING the frontend surfaces so a retry
//! can be offered, never a refusal.

use super::speleodb::local_dto;
use super::AppState;
use crate::speleodb::{SpeleoDbError, SpeleoErrorDto};

impl AppState {
    /// Persist the authoritative account email - never the token - so a later
    /// silent rehydrate can key the keychain lookup by (endpoint, email) after a
    /// restart. The email is only known once login resolves it, so it can't ride
    /// the Settings config the way the endpoint does.
    ///
    /// The **endpoint is deliberately NOT persisted here**: it is a user-facing
    /// Settings field owned by the config-staging flow, persisted only when the
    /// Settings dialog's Save runs (`updateConfig`). Writing it as a login side
    /// effect meant a "Log in now" test - or any login - leaked the endpoint into
    /// the saved config behind the dialog's back, surviving a Cancel/Undo, and
    /// also risked leaking the `DEV_SPELEODB_URL` dev box. Best-effort; a failure
    /// is logged, not fatal.
    pub(super) fn speleodb_persist_email(&self, email: &str) {
        // Login side: genuinely best-effort. A config that could not be written just
        // means the next launch will not silently rehydrate - the safe direction.
        let _ = self.speleodb_write_config_email(Some(email.to_owned()));
    }

    /// Persist whether the user has declined the OS keychain (items 11/12).
    ///
    /// This has to survive a restart to do its job at all: the whole complaint is
    /// that dismissing the desktop unlock prompt once did not stop it coming back
    /// on the next launch. Best-effort in the same sense as the email above - a
    /// failed write means the next launch asks again, which is annoying but never
    /// unsafe. A poisoned config mutex is recovered rather than treated as "cannot
    /// write", mirroring the email path.
    pub(super) fn speleodb_persist_keychain_declined(&self, declined: bool) {
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if config.speleodb.keychain_declined == declined {
            return; // no write, no disk churn on every login
        }
        config.speleodb.keychain_declined = declined;
        if let Err(e) = config.save() {
            tracing::warn!(
                error = %e,
                declined,
                "failed to persist the SpeleoDB keychain preference; the next launch may ask again"
            );
        }
    }

    /// Write (or clear, with `None`) the persisted account email. `None` is the
    /// logout half (#270): the email is the *rehydrate seed* - leaving it behind
    /// means a keychain entry that outlived a failed logout delete is found again
    /// by `speleodb_ensure_rehydrated` on the next launch, silently
    /// re-authenticating a user who asked to log out. The endpoint is deliberately
    /// left alone (a Settings preference, see above).
    ///
    /// Returns the reason the write did not land, so LOGOUT can report it. A
    /// silently-skipped clear is the whole hazard here: the caller was told logout
    /// succeeded while the seed that re-authenticates them is still on disk.
    ///
    /// A POISONED config mutex is recovered (`into_inner`) rather than treated as
    /// "cannot write", exactly as the save pipeline does with the project lock
    /// (`project_io::close_project_if_open_at`): a poisoned lock means some other
    /// thread panicked mid-mutation, which is a reason to be careful with what is
    /// in there - not a reason to leave a live rehydrate seed behind. Skipping was
    /// the unsafe direction.
    fn speleodb_write_config_email(&self, email: Option<String>) -> Result<(), String> {
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        config.speleodb.email = email;
        config.save().map_err(|e| {
            tracing::warn!(error = %e, "failed to persist the SpeleoDB account email to config");
            e.to_string()
        })
    }

    /// Forget the local token (keychain + plaintext + in-memory), clear the session,
    /// and clear the persisted account email. The DRF token is not revoked
    /// server-side, but if we were mid-edit on a remote project we best-effort
    /// RELEASE the write lock (it needs the token, so before `forget`) so it isn't
    /// stranded, and drop the transient edit gate - a token-less session must not
    /// keep mutating a project it can never push.
    ///
    /// #270: returns `Err` when a *persistent* tier refused to give the credential
    /// up, OR when the persisted account email (the rehydrate seed) could not be
    /// cleared. The logout still happened (session dropped, gates dropped); the
    /// error means a residue that can resurrect the session survives on this
    /// machine, which the FE surfaces so the user can retry. Unlike the 401
    /// auto-drop (`AppState::speleodb_forget`), which stays best-effort by design.
    pub(crate) fn speleodb_logout(&self) -> Result<(), SpeleoErrorDto> {
        self.speleodb_logout_drop_gates();

        // Drop the session AND the persisted rehydrate seed FIRST, then report. The
        // ordering is load-bearing: an early return on the credential failure would
        // leave the seed behind, which is the half that makes the credential findable.
        let cleared = self
            .speleodb_session_lock()
            .map_err(local_dto)?
            .forget_reporting();
        let seed_cleared = self.speleodb_write_config_email(None);
        logout_residue_error(cleared.err().map(|e| e.to_string()), seed_cleared.err())
    }

    /// The gate half of [`Self::speleodb_logout`]: surrender the write lock if one is
    /// held, and drop the edit / force-edit gates.
    ///
    /// A held write lock exists only on a remote EDIT session (`edit_enabled` + a
    /// remote link); a read-only open or a local project holds none. The gates are
    /// dropped independently of whether the token still resolves - a logged-out
    /// session must not keep editing a project it can never push.
    fn speleodb_logout_drop_gates(&self) {
        if !self.edit_enabled() {
            return;
        }
        match self.speleodb_open_link() {
            // Remote edit session: best-effort RELEASE the lock (needs the token, so
            // before `forget`), then drop the gates. #213: a force-editor holds NO
            // lock, so the release is a no-op there but the gates still drop.
            //
            // Through the SHARED gate, which vetoes the release when the project still
            // has un-pushed edits (it also re-checks the force-edit case). Logging out
            // is not the same act as giving up the lock: unlike unlink / take-remote -
            // the two verbs that legitimately bypass the veto - a logout neither
            // deletes the link row nor discards the local edits, so the asymmetry the
            // veto exists for applies in full. A lock left held is recoverable (the
            // re-login scan raises the held-lock prompt, which offers to resume it),
            // whereas a lock freed over stranded edits lets a colleague lock and push,
            // leaving weeks of local survey reachable only through a divergence.
            Ok(_) => {
                self.speleodb_release_held_lock_best_effort();
                self.set_edit_enabled(false);
                self.set_force_editing(false);
            }
            // Local-only project (no hand-off link): no lock, nothing to push - keep
            // it editable.
            Err(SpeleoDbError::NoRemoteProject) => {}
            // Couldn't determine locality (e.g. a poisoned database Mutex): the
            // gate-drop is a SAFETY action, so it must not be skipped just because the
            // link load failed - a logged-out session must not keep editing a project
            // it may be unable to push. Fail safe to read-only. (#197 review; no
            // project_id available here, so no lock release.)
            Err(_) => {
                self.set_edit_enabled(false);
                self.set_force_editing(false);
            }
        }
    }
}

/// Assemble logout's warning from whichever residues survived, or `Ok(())` when
/// none did.
///
/// BOTH are reported, and a run that fails both must not hide one behind the other:
/// a surviving credential is a live bearer token on this machine, and a surviving
/// email is the seed `speleodb_ensure_rehydrated` keys the keychain lookup by - so a
/// credential that outlived a failed delete gets found again on the next launch and
/// silently re-authenticates the user who asked to log out.
///
/// A free function over the two failure strings so the assembly is unit-testable
/// without a keychain or an unwritable config.
fn logout_residue_error(
    credential: Option<String>,
    seed: Option<String>,
) -> Result<(), SpeleoErrorDto> {
    let mut problems: Vec<String> = Vec::new();
    if let Some(e) = credential {
        problems.push(format!(
            "the stored SpeleoDB credential could not be removed from this machine ({e})"
        ));
    }
    if let Some(e) = seed {
        problems.push(format!(
            "the saved account could not be cleared, so this machine may sign in \
             again on the next launch ({e})"
        ));
    }
    if problems.is_empty() {
        return Ok(());
    }
    Err(local_dto(SpeleoDbError::Io(format!(
        "Logged out, but {}",
        problems.join("; and ")
    ))))
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "unit test fixtures fail loudly on setup errors"
)]
mod tests {
    use super::logout_residue_error;

    #[test]
    fn a_clean_logout_reports_nothing() {
        assert!(logout_residue_error(None, None).is_ok());
    }

    #[test]
    fn each_residue_is_named_and_neither_hides_the_other() {
        // The seed half used to have no error channel at all: the clear was skipped
        // silently on a poisoned config mutex and logout reported success, leaving the
        // session to re-authenticate itself on the next launch.
        let credential = logout_residue_error(Some("keychain refused".to_owned()), None)
            .expect_err("a surviving credential is reported");
        assert!(credential.message.contains("could not be removed"));
        assert!(
            !credential.message.contains("sign in again"),
            "and does not claim the seed also survived: {}",
            credential.message
        );

        let seed = logout_residue_error(None, Some("read-only config".to_owned()))
            .expect_err("a surviving rehydrate seed is reported on its own");
        assert!(seed.message.contains("sign in again"));

        // Both: one message, both facts. Reporting only the first would hide the half
        // that makes the other one dangerous.
        let both = logout_residue_error(
            Some("keychain refused".to_owned()),
            Some("read-only config".to_owned()),
        )
        .expect_err("both residues are reported");
        assert!(
            both.message.contains("could not be removed") && both.message.contains("sign in again"),
            "both residues must survive into the one warning: {}",
            both.message
        );
    }
}
