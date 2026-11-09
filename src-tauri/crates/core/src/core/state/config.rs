use anyhow::Result;

use crate::config::Config;

use super::speleodb_lock_release::LockReleaseParams;
use super::AppState;

/// Which door a config write came through, which decides what it may change.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ConfigWrite {
    /// A whole-`Config` payload (the Settings dialog). The only door that can change
    /// the SpeleoDB instance, so the only one that may need the lock-ops span.
    /// `lock_ops_held` says whether the caller took it.
    Whole { lock_ops_held: bool },
    /// A partial update (`modify_config`). It never edits `[speleodb]`, so the
    /// stored section is kept as it is at write time. Its payload is a clone taken
    /// under `config_write_lock`, but a sign-in writes `config` without that lock,
    /// and the clone's endpoint can be one sign-in old. Kept from the live config,
    /// the section cannot read as an instance change, and a divider drag cannot sign
    /// the user out or wait behind a SpeleoDB network operation.
    Partial,
}

/// What a whole-config write must still do after `config_write_lock` is dropped.
#[must_use]
struct AfterConfigWrite {
    /// The old instance's write lock, captured while its gates came down. Released
    /// over the network only after the write lock is gone, so partial config
    /// writers (which are sync commands on the main thread) never wait on the POST.
    release: Option<LockReleaseParams>,
}

impl AppState {
    /// Get config
    ///
    /// A POISONED config mutex is RECOVERED rather than answered with
    /// `Config::default()`: the Settings dialog renders whatever comes back and
    /// posts it straight to [`Self::update_config`], so handing out defaults would
    /// turn one unrelated panic into a wholesale reset of the user's settings.
    pub fn get_config(&self) -> Config {
        self.config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Whether saving `incoming` would move the app to a different SpeleoDB instance.
    fn speleodb_instance_changes(&self, incoming: &Config) -> bool {
        let normalize = |endpoint: &Option<String>| {
            endpoint
                .as_deref()
                .map(crate::speleodb::auth::normalize_endpoint)
        };
        normalize(&self.get_config().speleodb.endpoint) != normalize(&incoming.speleodb.endpoint)
    }

    /// Update config from a whole-`Config` payload.
    ///
    /// Takes the SpeleoDB lock-ops span ONLY when the payload changes the instance:
    /// that ends the session (a logout) and can release the open project's lock, so
    /// it must not land inside another lock operation's span. Every other save is a
    /// plain local write and must not queue behind an upload or a download, which
    /// hold lock-ops for minutes. Lock-ops is OUTERMOST, so it is taken before
    /// `config_write_lock`; a writer that lands between the check and the write lock
    /// and turns this into an instance change sends it round again to take it.
    pub fn update_config(&self, config: Config) -> Result<()> {
        let mut lock_ops = None;
        loop {
            if lock_ops.is_none() && self.speleodb_instance_changes(&config) {
                lock_ops = Some(self.speleodb_lock_ops_guard());
            }
            let write = self
                .config_write_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if lock_ops.is_none() && self.speleodb_instance_changes(&config) {
                drop(write);
                continue;
            }
            let after = self.update_config_locked(
                config,
                ConfigWrite::Whole {
                    lock_ops_held: lock_ops.is_some(),
                },
            )?;
            drop(write);
            self.finish_config_write(after);
            return Ok(());
        }
    }

    /// The network half of an instance change, after `config_write_lock` is gone and
    /// still inside the caller's lock-ops span: hand the old instance's lock back.
    /// Best-effort, exactly like the logout release it is split from.
    fn finish_config_write(&self, after: AfterConfigWrite) {
        if let Some(params) = after.release {
            self.speleodb_release_best_effort(
                &params.endpoint,
                &params.token,
                params.insecure_http,
                &params.project_id,
            );
        }
    }

    /// Read-modify-write the config under ONE lock, for the partial-update
    /// commands.
    ///
    /// This is the whole of the fix for the lost-update race described on
    /// `AppState::config_write_lock`: `get_config()` then `update_config()` is two
    /// critical sections with a gap in the middle, and a concurrent writer that
    /// lands in the gap has its write overwritten by this caller's stale clone.
    /// Going through here closes the gap, so every partial update is applied to
    /// whatever is current at the moment it runs.
    ///
    /// `mutate` may reject the payload (`Err`), in which case NOTHING is written -
    /// the validation the partial commands do on modes and panel names happens
    /// inside the critical section, on the config that is actually about to be
    /// saved.
    ///
    /// Never waits on SpeleoDB: the partial commands are synchronous, so Tauri runs
    /// them on the main thread, and a wait here froze the whole window for as long
    /// as an upload or download held the lock-ops span. They cannot change the
    /// instance (see [`ConfigWrite::Partial`]), which is the only reason a config
    /// write needs that span.
    pub fn modify_config<F>(&self, mutate: F) -> Result<()>
    where
        F: FnOnce(&mut Config) -> Result<()>,
    {
        let _guard = self
            .config_write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut config = self.get_config();
        mutate(&mut config)?;
        let after = self.update_config_locked(config, ConfigWrite::Partial)?;
        debug_assert!(
            after.release.is_none(),
            "a partial config write never changes the SpeleoDB instance"
        );
        self.finish_config_write(after);
        Ok(())
    }

    /// The body of [`Self::update_config`], with `config_write_lock` already held.
    /// Never call this directly - the lock is what makes a partial update safe.
    ///
    /// Holds no lock across network I/O. An instance change returns the release it
    /// captured in [`AfterConfigWrite`] for the caller to send once the write lock is
    /// dropped.
    fn update_config_locked(&self, mut config: Config, door: ConfigWrite) -> Result<AfterConfigWrite> {
        tracing::info!(purpose = "apply user settings", "Updating configuration");
        // Hold the config lock through persistence so login cannot update the token
        // between this restore and the settings write.
        let mut existing = self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if door == ConfigWrite::Partial {
            config.speleodb.clone_from(&existing.speleodb);
        }
        let instance_changed = {
            let normalize = |endpoint: &Option<String>| {
                endpoint
                    .as_deref()
                    .map(crate::speleodb::auth::normalize_endpoint)
            };
            normalize(&existing.speleodb.endpoint) != normalize(&config.speleodb.endpoint)
        };
        if instance_changed && door != (ConfigWrite::Whole { lock_ops_held: true }) {
            // Unreachable by construction: a partial write keeps the stored section,
            // and `update_config` re-checks under the write lock before it gets here.
            // Refuse rather than end a session outside the lock-ops span.
            return Err(anyhow::anyhow!(
                "the SpeleoDB instance changed while these settings were being saved; try again"
            ));
        }
        config.webkit_memory = existing.webkit_memory.clone();
        config.speleodb.email.clone_from(&existing.speleodb.email);
        if instance_changed {
            config.speleodb.token.0 = None;
        } else {
            config.speleodb.token.clone_from(&existing.speleodb.token);
        }
        config.speleodb.preserve_unreadable_file = existing.speleodb.preserve_unreadable_file
            && serde_json::to_value(&existing.speleodb).ok()
                == serde_json::to_value(&config.speleodb).ok();
        let old_cache_enabled = existing.cache.tile_cache_enabled;
        config.normalize_except_shortcuts();
        let new_cache_enabled = config.cache.tile_cache_enabled;

        if let Err(e) = config.save() {
            tracing::error!(
                reason = %e,
                purpose = "persist user settings",
                "Failed to save configuration"
            );
            return Err(e);
        }

        let mut release = None;
        if instance_changed {
            // A failed save must leave the current session and lock untouched.
            // The caller's lock-ops span and the write guard still exclude
            // login/settings writers. The release POST itself is deferred to the
            // caller, after the write guard is dropped.
            drop(existing);
            release = self.speleodb_logout_drop_gates_deferring_release();
            existing = self
                .config
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        *existing = config.clone();
        drop(existing);
        if instance_changed {
            self.speleodb
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .forget();
        }

        // Sync tile cache if cache setting changed
        if old_cache_enabled != new_cache_enabled {
            if let Ok(mut cache_guard) = self.tile_cache.lock() {
                if new_cache_enabled {
                    // Enable cache - create new cache
                    match Self::init_tile_cache(&config) {
                        Ok(cache) => {
                            tracing::info!(purpose = "enable offline tiles", "Tile cache enabled");
                            *cache_guard = Some(cache);
                        }
                        Err(e) => {
                            tracing::warn!(
                                error = %e,
                                purpose = "enable offline tiles",
                                "Failed to initialize tile cache"
                            );
                        }
                    }
                } else {
                    // Disable cache - set to None (existing cache data remains on disk)
                    tracing::info!(purpose = "disable offline tiles", "Tile cache disabled");
                    *cache_guard = None;
                }
            }
        }

        Ok(AfterConfigWrite { release })
    }

    /// Reload settings from disk.
    ///
    /// Like [`Self::update_config`], takes the lock-ops span only when the file on
    /// disk names a different account or instance, and takes it before
    /// `config_write_lock`. That is only known once the file is read, so a reload
    /// that discovers a change drops the write lock, takes lock-ops, and reads again.
    pub fn reload_config(&self) -> Result<(Config, bool)> {
        let mut lock_ops = None;
        loop {
            let write = self
                .config_write_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let new_config = Config::load()?;
            let previous = self.get_config();
            let normalize = |endpoint: &Option<String>| {
                endpoint
                    .as_deref()
                    .map(crate::speleodb::auth::normalize_endpoint)
            };
            let auth_changed = normalize(&previous.speleodb.endpoint)
                != normalize(&new_config.speleodb.endpoint)
                || previous.speleodb.email != new_config.speleodb.email
                || previous.speleodb.token.0 != new_config.speleodb.token.0;
            if auth_changed && lock_ops.is_none() {
                drop(write);
                lock_ops = Some(self.speleodb_lock_ops_guard());
                continue;
            }
            let release = self.reload_config_locked(&new_config, auth_changed);
            drop(write);
            self.finish_config_write(AfterConfigWrite { release });
            return Ok((new_config, auth_changed));
        }
    }

    /// The body of [`Self::reload_config`], with `config_write_lock` (and, on an
    /// identity change, lock-ops) held. Returns the old instance's lock release for
    /// the caller to send after the write lock is dropped.
    fn reload_config_locked(
        &self,
        new_config: &Config,
        auth_changed: bool,
    ) -> Option<LockReleaseParams> {
        let release = if auth_changed {
            self.speleodb_logout_drop_gates_deferring_release()
        } else {
            None
        };

        // Publish the new source before allowing lazy credential restoration.
        // Keep config locked so a parallel session read cannot restore the old file.
        {
            let mut cfg = self
                .config
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *cfg = new_config.clone();
            if auth_changed {
                self.speleodb
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .reload_credentials();
            }
        }

        // Sync recent_projects from config
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.clone_from(&new_config.general.recent_projects);
        }

        // Sync undo_stack history limit from config.
        //
        // [#303] `set_history_limit` records the new count but only re-arms the COUNT
        // bound; a Full-mode SpeleoDB project stays on the byte budget, so a settings
        // save cannot silently truncate the history its next push is meant to carry.
        // The recorded count still takes effect the moment the project goes back onto a
        // count window (closed, or switched to Disabled).
        if let Ok(mut undo) = self.undo_stack.lock() {
            undo.set_history_limit(new_config.general.undo_history_limit);
        }
        // ...and the BOUND itself, which `set_history_limit` deliberately will not touch.
        // The global `speleodb.undo_mode` can change in the same save. An already-open
        // linked project has an explicit value and therefore stays unchanged; local/no
        // project state remains on the count window. `sync_undo_depth_limit`'s own doc
        // lists config reload as a site it must be called from, so keep the re-arm here.
        // Sequenced after the block above so no lock is held across it.
        self.sync_undo_depth_limit();
        release
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "synthetic session test setup")]
mod tests {
    use super::*;
    use crate::speleodb::auth::TokenStore;

    fn signed_in_state() -> AppState {
        let state = AppState::new().unwrap();
        {
            let mut config = state.config.lock().unwrap();
            config.speleodb.endpoint = Some("https://sdb.example.com".to_owned());
            config.speleodb.email = Some("diver@example.com".to_owned());
            config.speleodb.token.0 = Some("synthetic-test-token".to_owned());
            config.save_speleodb().unwrap();
        }
        {
            let mut session = state.speleodb.lock().unwrap();
            session.endpoint = Some("https://sdb.example.com".to_owned());
            session.email = Some("diver@example.com".to_owned());
            session.token_store = TokenStore::from_in_memory_token("synthetic-test-token");
        }
        state
    }

    #[test]
    fn unrelated_settings_save_preserves_backend_credentials() {
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_state();
            let mut stale = state.get_config();
            stale.speleodb.email = None;
            stale.speleodb.token.0 = None;
            state.update_config(stale).unwrap();
            let loaded = Config::load().unwrap();
            assert_eq!(
                loaded.speleodb.token.0.as_deref(),
                Some("synthetic-test-token")
            );
            assert_eq!(loaded.speleodb.email.as_deref(), Some("diver@example.com"));
            assert!(!toml::to_string(&loaded.speleodb)
                .unwrap()
                .contains("allow_force_edit"));
            assert!(state.speleodb_session_status().unwrap().logged_in);
        });
    }

    #[test]
    fn changing_instance_clears_saved_and_live_credentials() {
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_state();
            let mut settings = state.get_config();
            settings.speleodb.endpoint = Some("https://other.example.com".to_owned());
            state.update_config(settings).unwrap();
            assert!(!state.speleodb_session_status().unwrap().logged_in);
            let loaded = Config::load().unwrap();
            assert_eq!(
                loaded.speleodb.endpoint.as_deref(),
                Some("https://other.example.com")
            );
            assert!(loaded.speleodb.token.0.is_none());
        });
    }

    #[test]
    fn equivalent_instance_spelling_keeps_the_token() {
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_state();
            let mut settings = state.get_config();
            settings.speleodb.endpoint = Some("https://SDB.example.com:443/".to_owned());
            state.update_config(settings).unwrap();
            assert!(state.speleodb_session_status().unwrap().logged_in);
            assert!(Config::load().unwrap().speleodb.token.0.is_some());
        });
    }

    #[test]
    fn sign_out_removes_token_and_keeps_connection_preferences() {
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_state();
            state.speleodb_logout().unwrap();
            assert!(!state.speleodb_session_status().unwrap().logged_in);
            let loaded = Config::load().unwrap();
            assert!(loaded.speleodb.token.0.is_none());
            assert_eq!(
                loaded.speleodb.endpoint.as_deref(),
                Some("https://sdb.example.com")
            );
        });
    }

    #[test]
    fn sign_out_reports_unwritable_file_but_ends_the_live_session() {
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_state();
            let dir = crate::test_helpers::current_config_dir().unwrap();
            let file = dir.join("speleodb/speleodb.conf");
            std::fs::remove_file(&file).unwrap();
            std::fs::create_dir(&file).unwrap();
            assert!(state.speleodb_logout().is_err());
            assert!(!state.speleodb_session_status().unwrap().logged_in);
        });
    }
    #[test]
    fn failed_instance_save_keeps_previous_live_and_saved_credentials() {
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_state();
            let dir = crate::test_helpers::current_config_dir().unwrap();
            let credentials = dir.join("speleodb/speleodb.conf");
            let previous = std::fs::read(&credentials).unwrap();
            std::fs::create_dir(dir.join("config.toml")).unwrap();
            let mut incoming = state.get_config();
            incoming.speleodb.endpoint = Some("https://other.example.com".to_owned());
            let generation = state.speleodb_session_generation();
            assert!(state.update_config(incoming).is_err());
            assert_eq!(state.speleodb_session_generation(), generation);
            assert_eq!(std::fs::read(&credentials).unwrap(), previous);
            assert_eq!(
                state.get_config().speleodb.endpoint.as_deref(),
                Some("https://sdb.example.com")
            );
            assert!(state.speleodb_session_status().unwrap().logged_in);
        });
    }

    #[test]
    fn failed_credential_save_does_not_change_general_preferences() {
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_state();
            state.get_config().save().unwrap();
            let dir = crate::test_helpers::current_config_dir().unwrap();
            let credentials = dir.join("speleodb/speleodb.conf");
            let before = std::fs::read(dir.join("config.toml")).unwrap();
            std::fs::remove_file(&credentials).unwrap();
            std::fs::create_dir(&credentials).unwrap();
            let mut incoming = state.get_config();
            incoming.general.undo_history_limit = 987;
            assert!(state.update_config(incoming).is_err());
            assert_eq!(std::fs::read(dir.join("config.toml")).unwrap(), before);
            assert!(state.speleodb_session_status().unwrap().logged_in);
        });
    }

    #[test]
    fn reload_only_replaces_session_when_saved_identity_changes() {
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_state();
            let mut changed = state.get_config();
            changed.general.undo_history_limit = 987;
            changed.save().unwrap();
            let generation = state.speleodb_session_generation();
            assert!(!state.reload_config().unwrap().1);
            assert_eq!(state.speleodb_session_generation(), generation);
            assert!(state.speleodb_session_status().unwrap().logged_in);
            for (endpoint, email, token) in [
                (
                    "https://other.example.com",
                    "diver@example.com",
                    "synthetic-test-token",
                ),
                (
                    "https://other.example.com",
                    "another@example.com",
                    "synthetic-test-token",
                ),
                (
                    "https://other.example.com",
                    "another@example.com",
                    "replacement-token",
                ),
            ] {
                let mut changed = state.get_config();
                changed.speleodb.endpoint = Some(endpoint.to_owned());
                changed.speleodb.email = Some(email.to_owned());
                changed.speleodb.token.0 = Some(token.to_owned());
                changed.save().unwrap();
                assert!(state.reload_config().unwrap().1);
                let actual = state.speleodb_active_account().unwrap();
                assert_eq!(
                    actual,
                    (endpoint.to_owned(), token.to_owned(), email.to_owned())
                );
            }
        });
    }
}
