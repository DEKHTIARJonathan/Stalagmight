//! [#303] Resolving the effective undo policy for the open project.
//!
//! The hybrid undo stack has ONE question at its centre: does this project's undo
//! history ride to SpeleoDB, and is its depth therefore bounded by a byte budget
//! instead of the fixed `undo_history_limit` / `undo_persist_limit` window? Every
//! trim, strip and clear site asks it here rather than re-deriving it, because the
//! answer has three inputs (is there a link, what does the link override say, what
//! is the global default) and three chances to get the precedence wrong.

use crate::models::{SpeleoLink, UndoMode, UndoPolicy};
use crate::speleodb::{SpeleoDbError, SpeleoErrorDto};

use super::AppState;

impl AppState {
    /// The effective [`UndoPolicy`] for the OPEN project.
    ///
    /// Reads the `speleo_link` row through the live database handle, so a project
    /// that is not linked (or not open at all) reads as local - the fixed window.
    ///
    /// Takes the `database` lock, so it must NOT be called from a site that already
    /// holds it, or from `save_project`'s persist block (where the live handle has
    /// been swapped out for a local one mid-save). Those pass the link they already
    /// have to [`Self::undo_policy_for`] instead.
    pub(crate) fn undo_policy(&self) -> UndoPolicy {
        let link = self
            .database
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().and_then(|db| db.load_speleo_link().ok()))
            .flatten();
        self.undo_policy_for(link.as_ref())
    }

    /// [`Self::undo_policy`] over a link the caller has ALREADY read - for
    /// `save_project`, which holds a database handle this state's `database` field
    /// does not yet point at, and for the unit tests.
    ///
    /// `None` means "no link", i.e. a local-only project, NOT "no override".
    pub(crate) fn undo_policy_for(&self, link: Option<&SpeleoLink>) -> UndoPolicy {
        let Some(link) = link else {
            return UndoPolicy::local();
        };
        UndoPolicy {
            linked: true,
            mode: self.effective_undo_mode(link.undo_mode),
        }
    }

    /// [#303] Set the open project's per-project undo-history policy, or clear the
    /// override (`None`) so it follows the global default.
    ///
    /// LOCK-REQUIRED (q17), and the reason is structural rather than cautious: this writes
    /// `speleo_link.undo_mode` in the `.stalx`, which rides to the server in the next
    /// push, so the value becomes every collaborator's. That makes it an edit of the
    /// project - it dirties the copy exactly like a survey edit, and takes effect for
    /// anyone else only once pushed - so it goes through the same gate every other edit
    /// verb does. A read-only session cannot silently change what the project ships.
    ///
    /// Re-arms the depth bound immediately, so switching to Disabled starts trimming to
    /// the count window without waiting for a reload.
    pub(crate) fn speleodb_set_undo_mode(
        &self,
        mode: Option<UndoMode>,
    ) -> Result<(), SpeleoErrorDto> {
        // Must be a remote project: a local one has no policy to set (the fixed window is
        // unconditional there), and no link row to write it into.
        let _link = self.speleodb_validated_link()?;
        if !self.edit_enabled() {
            return Err(super::speleodb::local_dto(SpeleoDbError::Io(
                "acquire the write lock before changing the undo-history setting".to_owned(),
            )));
        }
        self.speleodb_mutate_link(|l| l.undo_mode = mode)
            .map_err(super::speleodb::local_dto)?;
        // The write is an edit of the project file, so the copy is now ahead of the
        // server until it is pushed - the same bookkeeping every other edit does.
        self.mark_remote_dirty();
        self.sync_undo_depth_limit();
        tracing::info!(
            mode = ?mode,
            purpose = "per-project undo-history policy (#303)",
            "Set the project's undo mode"
        );
        Ok(())
    }

    /// [#303] Re-arm the undo stack's depth bound from the current policy.
    ///
    /// Must be called wherever the policy can change: a project opening or closing, a
    /// mode flip, a config reload. Full mode on a linked project goes onto the byte
    /// budget; everything else goes back onto the configured entry-count window.
    ///
    /// Takes the `database` lock (via [`Self::undo_policy`]) and then `undo_stack`, so
    /// it must not be called while either is held. Callers that already hold a link pass
    /// it to [`Self::sync_undo_depth_limit_for`].
    pub(crate) fn sync_undo_depth_limit(&self) {
        let policy = self.undo_policy();
        self.apply_undo_depth_limit(policy);
    }

    fn apply_undo_depth_limit(&self, policy: UndoPolicy) {
        if let Ok(mut undo) = self.undo_stack.lock() {
            if policy.unlimited_depth() {
                undo.set_byte_budget(crate::core::undo::UNDO_BYTE_BUDGET_BYTES);
            } else {
                undo.use_count_limit();
            }
        }
    }

    /// The global default, or [`UndoMode::Full`] if the config lock is unavailable
    /// (the documented default is the safe answer, and it is what a fresh config
    /// carries anyway).
    fn global_undo_mode(&self) -> UndoMode {
        self.config
            .lock()
            .map(|c| c.speleodb.undo_mode)
            .unwrap_or_default()
            .resolved()
    }

    /// An override, else the global default - resolved, so no consumer ever sees
    /// [`UndoMode::Unknown`]. The one place the precedence rule lives.
    fn effective_undo_mode(&self, override_mode: Option<UndoMode>) -> UndoMode {
        match override_mode {
            Some(mode) => mode.resolved(),
            None => self.global_undo_mode(),
        }
    }

    /// The effective mode for the open project, for the status/IPC surface: the
    /// resolved value the FE renders, plus whether it came from an override.
    ///
    /// Reported as a pair rather than folded into one value because the settings
    /// control has to say "Full (following the global default)" differently from
    /// "Full (set on this project)" - otherwise clearing an override looks like a
    /// no-op.
    ///
    /// Deliberately NOT `undo_policy().mode`: that reports `Full` for an unlinked
    /// project, because a local project is exempt from the hybrid rules rather than
    /// following them, and rendering that as the control's value would show a
    /// setting the global default disagrees with. This answers the narrower question
    /// the control asks - which value is in force for this project's undo history.
    pub(crate) fn undo_mode_status(&self) -> (UndoMode, bool) {
        let override_mode = self
            .database
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().and_then(|db| db.load_speleo_link().ok()))
            .flatten()
            .and_then(|l| l.undo_mode);
        (
            self.effective_undo_mode(override_mode),
            override_mode.is_some(),
        )
    }
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use super::*;
    use crate::core::state::AppState;
    use crate::test_helpers::with_isolated_config;

    /// `AppState::new()` loads the global config, so every test here runs under the
    /// config isolation guard - otherwise it reads (and races on) the developer's
    /// real `config.toml`, which is what `with_isolated_config` exists to prevent.
    fn state() -> AppState {
        AppState::new().expect("construct AppState")
    }

    fn link_with(mode: Option<UndoMode>) -> SpeleoLink {
        SpeleoLink {
            endpoint: "https://example.invalid".to_owned(),
            project_id: "11111111-1111-1111-1111-111111111111".to_owned(),
            project_name: "P".to_owned(),
            base_commit_sha: None,
            has_unpushed_edits: false,
            last_edit_at: None,
            last_verify_at: None,
            undo_mode: mode,
        }
    }

    /// Spec item 27, first half: a link override beats the global default in BOTH
    /// directions, so a Disabled project stays Disabled under a Full default and a
    /// Full project stays Full under a Disabled default.
    #[test]
    fn undo_mode_override_wins_over_the_global_default() {
        with_isolated_config(|| {
            let state = state();

            state.config.lock().expect("config lock").speleodb.undo_mode = UndoMode::Full;
            let policy = state.undo_policy_for(Some(&link_with(Some(UndoMode::Disabled))));
            assert_eq!(policy.mode, UndoMode::Disabled);
            assert!(!policy.pushes_history());

            state.config.lock().expect("config lock").speleodb.undo_mode = UndoMode::Disabled;
            let policy = state.undo_policy_for(Some(&link_with(Some(UndoMode::Full))));
            assert_eq!(policy.mode, UndoMode::Full);
            assert!(policy.pushes_history());
        });
    }

    /// Spec item 27, second half: no override follows the global default, and keeps
    /// following it when that default changes.
    #[test]
    fn no_override_follows_the_global_default() {
        with_isolated_config(|| {
            let state = state();
            let link = link_with(None);

            state.config.lock().expect("config lock").speleodb.undo_mode = UndoMode::Disabled;
            assert_eq!(
                state.undo_policy_for(Some(&link)).mode,
                UndoMode::Disabled,
                "a NULL column tracks the global setting rather than snapshotting it"
            );

            state.config.lock().expect("config lock").speleodb.undo_mode = UndoMode::Full;
            assert_eq!(state.undo_policy_for(Some(&link)).mode, UndoMode::Full);
        });
    }

    /// q4: no link, no hybrid. A local project keeps the fixed window whatever the
    /// global default says, because there is no commit for its history to chain
    /// through.
    #[test]
    fn a_project_with_no_link_is_local_whatever_the_default() {
        with_isolated_config(|| {
            let state = state();
            state.config.lock().expect("config lock").speleodb.undo_mode = UndoMode::Full;

            let policy = state.undo_policy_for(None);
            assert!(!policy.linked);
            assert!(!policy.unlimited_depth());
            assert!(!policy.pushes_history());
        });
    }

    /// An unrecognized column value (a file written by a newer build, or hand-edited)
    /// must resolve to the documented default rather than reaching a consumer as
    /// `Unknown`.
    #[test]
    fn an_unknown_override_resolves_to_full() {
        with_isolated_config(|| {
            let state = state();
            let policy = state.undo_policy_for(Some(&link_with(Some(UndoMode::Unknown))));
            assert_eq!(policy.mode, UndoMode::Full);
            assert!(policy.pushes_history());
        });
    }

    /// Spec item 26: the per-project undo-mode write is LOCK-REQUIRED, and refuses a
    /// project with no link outright.
    ///
    /// Not caution: the value lands in the `.stalx` and rides to the server in the next
    /// push, so it becomes every collaborator's policy. That makes it an edit of the
    /// project, and a read-only session must not be able to change what the project
    /// ships.
    #[test]
    fn setting_the_undo_mode_requires_the_write_lock() {
        with_isolated_config(|| {
            let state = state();

            // No project open: there is no link row to write the override into.
            let err = state
                .speleodb_set_undo_mode(Some(UndoMode::Disabled))
                .expect_err("a local / absent project has no per-project policy to set");
            assert!(
                !err.message.is_empty(),
                "the refusal must carry a message the FE can surface, got {err:?}"
            );

            // ...and with the edit gate shut (a remote project opened read-only) it
            // refuses too. Asserted through the same absent-link path here - the gate
            // check sits behind `speleodb_validated_link`, and a live remote link needs
            // the cache dir the env-gated live tests initialise - so what this pins is
            // that no arm of the verb succeeds without an edit session.
            state.set_edit_enabled(false);
            assert!(
                state.speleodb_set_undo_mode(None).is_err(),
                "read-only sessions cannot change what the project ships"
            );
        });
    }

    /// The lock gate is the FIRST thing after the link lookup, so no write can slip in
    /// ahead of it. Structural, for the reason above.
    #[test]
    fn the_undo_mode_write_is_gated_before_it_mutates() {
        let src = include_str!("undo_policy.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production region precedes the test module");
        let verb = src
            .split_once("pub(crate) fn speleodb_set_undo_mode")
            .map(|(_, rest)| rest)
            .expect("the verb is in this file");
        let gate = verb
            .find("if !self.edit_enabled()")
            .expect("the verb must check the edit gate");
        let write = verb
            .find("self.speleodb_mutate_link(")
            .expect("the verb writes the link");
        assert!(
            gate < write,
            "the lock gate must precede the write - checking afterwards would leave the \
             override on disk for the next push to ship"
        );
    }

    /// The status pair reports the RESOLVED mode plus whether an override supplied
    /// it - the distinction the settings control needs to say "following the global
    /// default" honestly.
    #[test]
    fn undo_mode_status_separates_the_value_from_its_provenance() {
        with_isolated_config(|| {
            let state = state();
            state.config.lock().expect("config lock").speleodb.undo_mode = UndoMode::Disabled;

            // No project open at all: the GLOBAL default, and not overridden. Not
            // `UndoPolicy::local()`'s Full - that answers "is this project exempt
            // from the hybrid rules", which is a different question from "what
            // value is in force", and conflating them showed the control a value
            // the global setting disagreed with.
            let (mode, overridden) = state.undo_mode_status();
            assert_eq!(mode, UndoMode::Disabled);
            assert!(!overridden);
        });
    }
}
