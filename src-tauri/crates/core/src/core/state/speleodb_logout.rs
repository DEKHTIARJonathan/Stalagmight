//! End SpeleoDB sessions and remove the persisted token.
use super::speleodb::local_dto;
use super::speleodb_lock_release::LockReleaseParams;
use super::AppState;
use crate::speleodb::{SpeleoDbError, SpeleoErrorDto};

/// Delete only this account's obsolete app-owned plaintext file. Never read or
/// import its contents, inspect other accounts, or access a system keychain.
fn remove_legacy_token(
    config_path: &std::path::Path,
    endpoint: &str,
    email: &str,
) -> Result<(), SpeleoErrorDto> {
    let filename: String = crate::speleodb::auth::account_key(endpoint, email)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let root = config_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    match std::fs::remove_file(root.join("speleodb").join("tokens").join(filename)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(local_dto(SpeleoDbError::Io("Signed out, but an obsolete plaintext SpeleoDB credential could not be removed. Try signing out again.".into()))),
    }
}

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
        )))?;
        if let (Some(endpoint), Some(email)) = (&config.speleodb.endpoint, &config.speleodb.email) {
            let path = crate::config::Config::config_path().map_err(|_| {
                local_dto(SpeleoDbError::Io(
                    "Could not locate obsolete SpeleoDB credentials".into(),
                ))
            })?;
            remove_legacy_token(&path, endpoint, email)?;
        }
        Ok(())
    }

    pub fn speleodb_logout(&self) -> Result<(), SpeleoErrorDto> {
        let _lock_ops = self.speleodb_lock_ops_guard();
        self.speleodb_logout_drop_gates();
        self.speleodb
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .forget();
        // Attempt both cleanups even when credential persistence fails.
        let token_result = self.speleodb_clear_saved_token();
        let recent_result = self.speleodb_forget_recent_projects();
        token_result.and(recent_result)
    }

    /// Forget only confirmed SpeleoDB references. Metadata reads never modify the
    /// project files; unreadable/missing entries are retained rather than guessed.
    fn speleodb_forget_recent_projects(&self) -> Result<(), SpeleoErrorDto> {
        let mut recent = self
            .recent_projects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        recent.retain(|path| {
            !crate::persistence::Database::open_for_metadata(path)
                .and_then(|db| db.load_speleo_link())
                .is_ok_and(|link| link.is_some())
        });
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        config.general.recent_projects.clone_from(&recent);
        config.save().map_err(|_| local_dto(SpeleoDbError::Io(
            "Signed out, but SpeleoDB project references could not be saved. Try signing out again.".into()
        )))
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
            Ok(_) => {
                self.speleodb_release_held_lock_best_effort();
                self.set_edit_enabled(false);
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
            }
        }
    }
    /// [`Self::speleodb_logout_drop_gates`] for a caller that holds a lock the
    /// release POST must not be made under: a settings save that changes the
    /// SpeleoDB instance holds `config_write_lock`, which every synchronous partial
    /// config command (panel sizes, column widths) also takes on the main thread.
    ///
    /// Everything but the network call happens here, in the original order - the
    /// session boundary, the silent-release veto and claim clear, the gate - and the
    /// release is returned for the caller to send once that lock is dropped, still
    /// inside its lock-ops span, so no lock operation can land between this and the
    /// POST. The gate closes before the POST rather than after it: nothing is edited
    /// under a lock that is about to be handed back.
    pub(super) fn speleodb_logout_drop_gates_deferring_release(&self) -> Option<LockReleaseParams> {
        {
            let _proj_guard = self
                .project
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.bump_speleodb_session();
        }
        if !self.edit_enabled() {
            return None;
        }
        match self.speleodb_open_link() {
            Ok(_) => {
                let release = self.speleodb_held_lock_release_params();
                if let Some(params) = &release {
                    // The claim ends now, as `speleodb_release_best_effort` ends it
                    // before its POST: the session is about to be forgotten, and a
                    // claim cleared after that could no longer be matched to it.
                    self.speleodb_forget_lock_acquired_for(&params.project_id);
                }
                self.set_edit_enabled(false);
                release
            }
            Err(SpeleoDbError::NoRemoteProject) => None,
            // Fail safe to read-only, as the inline variant does.
            Err(_) => {
                self.set_edit_enabled(false);
                None
            }
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "synthetic legacy credential cleanup tests"
)]
mod tests {
    use super::*;
    #[test]
    fn logout_forgets_only_speleodb_references_and_preserves_files() {
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("temp");
            let state = AppState::new().expect("state");
            let local = dir.path().join("local.stalx");
            let missing = dir.path().join("missing.stalx");
            let unreadable = dir.path().join("unreadable.stalx");
            std::fs::write(&unreadable, b"synthetic invalid database").expect("write");
            let mut paths = vec![local.clone(), missing, unreadable];
            for (name, endpoint) in [
                ("local", None),
                ("remote-a", Some("https://a.example/")),
                ("remote-b", Some("https://b.example/")),
            ] {
                let path = dir.path().join(format!("{name}.stalx"));
                let mut db = crate::persistence::Database::open(&path).expect("db");
                db.save_project(&crate::models::Project::new(name.into(), None))
                    .expect("project");
                if let Some(endpoint) = endpoint {
                    db.save_speleo_link(Some(&crate::models::SpeleoLink {
                        endpoint: endpoint.into(),
                        project_id: uuid::Uuid::new_v4().to_string(),
                        project_name: name.into(),
                        base_commit_sha: None,
                        has_unpushed_edits: true,
                        last_edit_at: None,
                        last_verify_at: None,
                        undo_mode: None,
                    }))
                    .expect("link");
                    paths.push(path);
                }
            }
            let preserved: Vec<_> = paths.iter().map(|path| std::fs::read(path).ok()).collect();
            *state.recent_projects.lock().expect("recents") = paths.clone();
            state.config.lock().expect("config").general.recent_projects = paths.clone();
            assert!(state.open_project(local).success);
            state.speleodb_logout().expect("logout");
            assert_eq!(*state.recent_projects.lock().expect("recents"), paths[..3]);
            assert_eq!(state.get_config().general.recent_projects, paths[..3]);
            assert_eq!(
                crate::config::Config::load()
                    .expect("reload")
                    .general
                    .recent_projects,
                paths[..3]
            );
            assert!(state.get_project_state().is_some());
            assert!(state.edit_enabled());
            for (path, before) in paths.iter().zip(preserved) {
                assert_eq!(std::fs::read(path).ok(), before, "{}", path.display());
            }
            state.speleodb_logout().expect("repeated logout");
            assert_eq!(*state.recent_projects.lock().expect("recents"), paths[..3]);
        });
    }

    #[test]
    fn logout_removes_only_the_current_accounts_obsolete_plaintext_file() {
        crate::test_helpers::with_isolated_config(|| {
            let state = AppState::new().expect("state");
            let path = crate::config::Config::config_path().expect("isolated config");
            let root = path.parent().expect("parent").join("speleodb/tokens");
            std::fs::create_dir_all(&root).expect("directory");
            let old = root.join("https___example.com_diver_example.com");
            let other = root.join("other-account");
            std::fs::write(&old, b"synthetic-old-token").expect("legacy file");
            std::fs::write(&other, b"synthetic-other-token").expect("other account");
            {
                let mut config = state.config.lock().expect("config");
                config.speleodb.endpoint = Some("https://example.com".into());
                config.speleodb.email = Some("diver@example.com".into());
                config.speleodb.token.0 = Some("synthetic-current-token".into());
            }
            state.speleodb_logout().expect("logout");
            assert!(!old.exists());
            assert!(other.exists());
            assert!(state.get_config().speleodb.token.0.is_none());
        });
    }
    #[test]
    fn legacy_cleanup_failure_is_reported_without_recursive_deletion() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("config.toml");
        let target = dir
            .path()
            .join("speleodb/tokens/https___example.com_diver_example.com");
        std::fs::create_dir_all(&target).expect("block removal");
        assert!(remove_legacy_token(&path, "https://example.com", "diver@example.com").is_err());
        assert!(target.is_dir());
    }
}
