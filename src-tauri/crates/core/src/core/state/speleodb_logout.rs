//! End SpeleoDB sessions and remove the persisted token.
use super::speleodb::local_dto;
use super::AppState;
use crate::speleodb::{SpeleoDbError, SpeleoErrorDto};

impl AppState {
    /// Clear the token while holding the same lock used by settings saves.
    pub(super) fn speleodb_clear_saved_token(&self) -> Result<(), SpeleoErrorDto> {
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        config.speleodb.token.0 = None;
        config.speleodb.preserve_unreadable_file = false;
        config.save_speleodb().map_err(|_| local_dto(SpeleoDbError::Io(
            "Signed out, but the saved SpeleoDB token could not be removed. Try signing out again.".to_owned()
        )))
    }

    pub fn speleodb_logout(&self) -> Result<(), SpeleoErrorDto> {
        let _lock_ops = self.speleodb_lock_ops_guard();
        self.speleodb_logout_drop_gates();
        self.speleodb
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .forget();
        self.speleodb_clear_saved_token()
    }

    pub(super) fn speleodb_logout_drop_gates(&self) {
        // A session boundary even though the project slot never moves (footgun
        // 5.8): the token an in-flight Start Editing would commit a claim over is
        // being forgotten, so the commit guard must see this. Bumped under a brief
        // `project` acquisition per the `speleodb_session` rule; taken and dropped
        // before the gates/lock work below, none of which needs it. Bumped even on
        // the read-only early return: the boundary is the LOGOUT, not the release.
        {
            let _proj_guard = self
                .project
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.bump_speleodb_session();
        }
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
