use anyhow::Result;

use crate::config::{Config, TokenFallback};

use super::AppState;

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

    /// Update config
    pub fn update_config(&self, mut config: Config) -> Result<()> {
        tracing::info!(purpose = "apply user settings", "Updating configuration");
        // Preserve backend-only fields the frontend never receives. `webkit_memory`
        // is `#[serde(skip_serializing)]` + `#[ts(skip)]`, so a settings-save payload
        // always carries the serde default. This restore is load-bearing: the save
        // below re-appends the in-memory `[webkit_memory]` table to `config.toml`
        // (see `Config::save_to_path`), so without putting the real value back here
        // first, saving any setting would persist defaults and silently reset a
        // user's hand-tuned knobs.
        //
        // The credential fields below are preserved for a different reason: they ARE
        // serialized, but the Settings form does not own them. Who is signed in and
        // where their API key is kept are settled by the login itself, the
        // login-time storage prompt and the "Try again" button, all of which write
        // `config.toml` through the backend while the Settings dialog stays mounted
        // over its snapshot of the config (`SpeleoStorageChoiceDialog` is a
        // top-layer overlay precisely so Settings is not unmounted, and the account
        // panel's "Log in now" runs without closing anything). Saving any unrelated
        // setting afterwards posted the stale values back and silently undid what
        // the backend had just recorded - re-arming the launch-time keyring nag, or
        // worse: a successful "Try again" moves the key into the keychain and
        // deletes the plaintext copy, so restoring a stale `keychain_declined = true`
        // made the next launch skip the keychain read and find nothing, signing the
        // user out with no way to explain it.
        //
        // `email` belongs in that list for exactly the same reason and costs the
        // same when it is missing: it is the rehydrate seed - `speleodb_ensure_
        // rehydrated` keys the credential lookup by it - so posting back the stale
        // (usually null) snapshot from before an inline login left the next launch
        // unable to find the token of the account that is signed in, forcing another
        // sign-in.
        //
        // A POISONED config mutex is RECOVERED (`into_inner`) rather than skipped,
        // for that last reason: skipping restores nothing, so the form's serde
        // defaults land on top of the backend-owned fields and sign the user out
        // with no way to explain it. That is the unsafe direction, and it is the
        // same call the save pipeline makes with the project lock
        // (`project_io::close_project_if_open_at`) - these are plain values with no
        // half-written invariant to protect.
        let (previously_disabled, old_cache_enabled) = {
            let existing = self
                .config
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            config.webkit_memory = existing.webkit_memory.clone();
            config.speleodb.email.clone_from(&existing.speleodb.email);
            config.speleodb.token_fallback = existing.speleodb.token_fallback;
            config.speleodb.keychain_declined = existing.speleodb.keychain_declined;
            // Backend-owned for the same reason: it records what the keychain
            // actually holds, which only the credential paths know. `keychain_disabled`
            // is deliberately NOT in this list - that one IS a Settings toggle.
            config.speleodb.keychain_has_token = existing.speleodb.keychain_has_token;
            (
                existing.speleodb.keychain_disabled,
                existing.cache.tile_cache_enabled,
            )
        };
        // The keyring switch has to bite NOW, not at the next launch: a user turning
        // it on has just been asked one unlock prompt too many, and the live session
        // would otherwise keep reaching for the keychain until they restart.
        let keychain_disabled = config.speleodb.keychain_disabled;
        if keychain_disabled && !previously_disabled {
            // Turning it ON is not a gate flip. Looking away from the keychain does
            // not empty it, and NOTHING else ever will: the disable is re-applied on
            // every subsequent login, so `TokenStore::store` never reaches the keyring
            // to overwrite the entry, and Settings' "Try again" clears only
            // `keychain_declined`. What a previous successful login left there would
            // stay as a working bearer token belonging to a user who has just said
            // "do not use the OS keychain" - and logout swept nothing and reported
            // success over it.
            //
            // Deliberately BEFORE the save below, so a save that fails leaves the
            // keyring emptied while the file still says it is enabled. That is the
            // recoverable direction (the next launch opens the keyring, finds
            // nothing, and asks for a sign-in); saving first would leave the file
            // saying "off" over an entry that survived.
            if self.speleodb_disable_keychain(config.speleodb.token_fallback) {
                config.speleodb.keychain_has_token = false;
            }
        } else {
            let mut session = self
                .speleodb
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            session.token_store.set_keychain_disabled(keychain_disabled);
        }
        let new_cache_enabled = config.cache.tile_cache_enabled;

        if let Err(e) = config.save() {
            tracing::error!(
                reason = %e,
                purpose = "persist user settings",
                "Failed to save configuration"
            );
            return Err(e);
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

        // Recovered rather than skipped for the third time in this function: the
        // settings are already on disk by now, so dropping the in-memory update
        // would leave the running app disagreeing with its own config file until
        // the next launch.
        *self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = config;
        Ok(())
    }

    /// Apply a NEW standing "never use the OS keyring" instruction to the live
    /// session: take the key OUT of the keychain, THEN close the gate, then re-land
    /// the key wherever the closed gate allows.
    ///
    /// The order is the whole point. `TokenStore::evict_from_keychain` is the one
    /// call that bypasses the off-gate, and it has to run before the flag is set or
    /// the gate blocks it; the trailing `restore` is what stops `active_tier` (and
    /// so the Settings credential line) claiming a keychain we just emptied.
    ///
    /// The eviction is NOT gated on `keychain_has_token`. That flag is what startup
    /// reads to avoid opening the keyring, but it defaults to `false` for every
    /// config written before it existed - so trusting it here would silently skip
    /// the eviction for exactly the upgraded users most likely to have an entry.
    /// The cost of being wrong the other way is one delete against a keyring that
    /// holds nothing, which is `Ok` (a missing entry maps to success).
    ///
    /// Returns whether the keychain is now known to hold nothing for this account,
    /// i.e. whether the caller may record `keychain_has_token = false`. A refused
    /// delete answers `false`: the entry is probably still there, and a later
    /// re-enable should still know the keyring is worth looking in.
    fn speleodb_disable_keychain(&self, fallback: TokenFallback) -> bool {
        // Seeds `endpoint` / `email` from config when the session is still cold -
        // Settings is reachable without having touched SpeleoDB this run, and
        // without an account there is no key to evict by. Called with NO lock held:
        // `speleodb_ensure_rehydrated` documents the config-then-session order, and
        // inverting it here would be the deadlock.
        self.speleodb_ensure_rehydrated();

        let mut session = self
            .speleodb
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (Some(endpoint), Some(email)) = (session.endpoint.clone(), session.email.clone())
        else {
            session.token_store.set_keychain_disabled(true);
            tracing::debug!(
                purpose = "no persisted account to key a keychain entry by",
                "turned the OS keyring off without an eviction"
            );
            // We verified nothing, so we claim nothing: leave the recorded belief
            // alone rather than assert an emptiness we did not check.
            return false;
        };

        let emptied = match session.token_store.evict_from_keychain(&endpoint, &email) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "could not remove the SpeleoDB token from the OS keyring while turning it off; \
                     it may still be stored on this machine"
                );
                false
            }
        };
        session.token_store.set_keychain_disabled(true);
        // The key is still in hand, so honour the instruction now: re-store it at
        // whatever tier the closed gate allows (the `token_fallback` preference
        // still decides between a `0o600` file and session-only memory).
        //
        // A survivor of the session-only sweep is LOGGED here rather than failing
        // the settings save, unlike `speleodb_move_token` which refuses on it. The
        // two verbs make different promises: answering the storage prompt with "this
        // session only" IS the promise that nothing persists, so a surviving copy
        // falsifies the very thing being reported, whereas turning the keyring off
        // promises only that the keyring stops being used - where the key goes
        // instead is `token_fallback`, which this save did not change. Failing here
        // would also abandon the rest of the user's settings over a residue, having
        // already emptied the keyring.
        match session
            .token_store
            .restore(&endpoint, &email, fallback == TokenFallback::Plaintext)
        {
            Ok(landed) => tracing::info!(
                ?landed,
                emptied,
                "OS keyring turned off; the SpeleoDB key was moved out of it"
            ),
            Err(e) => tracing::warn!(
                error = %e,
                emptied,
                "OS keyring turned off, but an older copy of the SpeleoDB key could not be \
                 removed from this machine"
            ),
        }
        emptied
    }

    /// Reload config from disk without saving
    /// Returns the newly loaded config
    /// Also syncs config-derived state (recent_projects, undo_stack limit)
    pub fn reload_config(&self) -> Result<Config> {
        let new_config = Config::load()?;

        // Update the config
        if let Ok(mut cfg) = self.config.lock() {
            *cfg = new_config.clone();
        }

        // Sync recent_projects from config
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.clone_from(&new_config.general.recent_projects);
        }

        // Sync undo_stack history limit from config
        if let Ok(mut undo) = self.undo_stack.lock() {
            undo.set_history_limit(new_config.general.undo_history_limit);
        }

        Ok(new_config)
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "unit test fixtures fail loudly on setup errors"
)]
mod tests {
    use super::AppState;
    use crate::config::TokenFallback;
    use crate::speleodb::auth::{
        account_key, InMemoryStore, KeychainState, PlaintextStore, SecretStore, SecretStoreError,
        TokenStore, TokenTier,
    };
    use std::path::Path;

    const EP: &str = "https://sdb.example";
    const EMAIL: &str = "u@x";

    /// A keychain that cannot be written to - the headless / locked-keyring box.
    /// Local to this module for the same reason its siblings are: the real fakes in
    /// `auth.rs` are private to that file's test module.
    struct FailingSecretStore;

    impl SecretStore for FailingSecretStore {
        fn kind(&self) -> &'static str {
            "failing"
        }
        fn store(&self, _: &str, _: &str) -> Result<(), SecretStoreError> {
            Err(SecretStoreError::for_test("no secret service"))
        }
        fn load(&self, _: &str) -> Result<Option<String>, SecretStoreError> {
            Err(SecretStoreError::for_test("no secret service"))
        }
        fn delete(&self, _: &str) -> Result<(), SecretStoreError> {
            Err(SecretStoreError::for_test("no secret service"))
        }
    }

    /// A state whose session is signed in over the injected keychain backend.
    /// `endpoint` is seeded, which short-circuits `speleodb_ensure_rehydrated`, so
    /// nothing in these tests reaches a real keyring.
    fn signed_in_over(keychain: Box<dyn SecretStore>) -> AppState {
        let state = AppState::new().expect("state");
        let mut session = state.speleodb.lock().expect("session");
        session.endpoint = Some(EP.to_owned());
        session.email = Some(EMAIL.to_owned());
        session.token_store = TokenStore::from_stores(keychain, None);
        drop(session);
        state
    }

    /// A `PlaintextStore` standing in for the OS keychain, so the entry it holds is
    /// observable from OUTSIDE the `TokenStore` that owns the backend.
    fn observable_keychain(root: &Path) -> Box<dyn SecretStore> {
        Box::new(PlaintextStore::new(root.to_path_buf()))
    }

    /// The Settings payload: what `get_config` hands the form, with the keyring
    /// switch set as the user left it.
    fn settings_save(state: &AppState, keychain_disabled: bool) -> crate::config::Config {
        let mut config = state.get_config();
        config.speleodb.keychain_disabled = keychain_disabled;
        config
    }

    #[test]
    fn disabling_the_keychain_removes_the_entry_it_already_holds() {
        // Flipping the switch used to only make the live session look away. Nothing
        // ever removed what an earlier successful login had already written: the
        // disable is re-applied on every subsequent login so `store` never overwrites
        // the entry, and "Try again" clears the OTHER flag. The result was a working
        // bearer token left in the OS keychain of a user who had just turned the OS
        // keychain off - and logout then swept nothing and reported success.
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let state = signed_in_over(observable_keychain(dir.path()));
            {
                let mut session = state.speleodb.lock().expect("session");
                // An earlier working login: the key is durably in the keychain.
                assert_eq!(
                    session.token_store.store(EP, EMAIL, "tok", false),
                    TokenTier::Keychain
                );
                drop(session);
                let mut config = state.config.lock().expect("config");
                config.speleodb.keychain_has_token = true;
            }
            let probe = PlaintextStore::new(dir.path().to_path_buf());
            assert!(probe.load(&account_key(EP, EMAIL)).unwrap().is_some());

            state
                .update_config(settings_save(&state, true))
                .expect("settings saved");

            assert_eq!(
                probe.load(&account_key(EP, EMAIL)).unwrap(),
                None,
                "turning the keyring off must take the key OUT of it, not just look away"
            );
            let session = state.speleodb.lock().expect("session");
            assert!(
                !session.token_store.keychain_backed(),
                "and the credential line must stop claiming a keychain we just emptied"
            );
            drop(session);
            assert!(
                !state.get_config().speleodb.keychain_has_token,
                "the recorded belief has to follow, or the next launch opens the keyring for nothing"
            );
        });
    }

    #[test]
    fn the_keyring_switch_reaches_the_live_session_immediately() {
        // The point of applying it here rather than at the next launch: the user has
        // just been asked one unlock prompt too many, so the running session must
        // stop reaching for the keychain now.
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_over(Box::new(InMemoryStore::new()));

            state
                .update_config(settings_save(&state, true))
                .expect("settings saved");

            let mut session = state.speleodb.lock().expect("session");
            assert_eq!(
                session.token_store.keychain_state(),
                KeychainState::Declined,
                "the live store has to know before the next restart"
            );
            assert_eq!(
                session.token_store.store(EP, EMAIL, "tok", false),
                TokenTier::Memory,
                "a working keychain is still not used once the switch is on"
            );
        });
    }

    #[test]
    fn a_settings_save_keeps_the_backend_owned_credential_fields() {
        // The switch is the only credential field the form owns. Its three siblings
        // are settled by the login-time storage prompt and "Try again" - both of
        // which write `config.toml` behind a Settings dialog that is still mounted
        // over its own stale snapshot - so a save has to put them back.
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_over(Box::new(InMemoryStore::new()));
            {
                let mut config = state.config.lock().expect("config");
                config.speleodb.token_fallback = TokenFallback::Plaintext;
                config.speleodb.keychain_declined = true;
                config.speleodb.keychain_has_token = true;
                config.speleodb.keychain_disabled = true;
            }

            // A form payload carrying the serde defaults for everything it does not
            // own, and the switch turned back off.
            let mut posted = crate::config::Config::default();
            posted.speleodb.keychain_disabled = false;
            state.update_config(posted).expect("settings saved");

            let saved = state.get_config();
            assert_eq!(saved.speleodb.token_fallback, TokenFallback::Plaintext);
            assert!(saved.speleodb.keychain_declined);
            assert!(saved.speleodb.keychain_has_token);
            assert!(
                !saved.speleodb.keychain_disabled,
                "the switch itself IS the form's to set, in both directions"
            );
        });
    }

    #[test]
    fn a_settings_save_keeps_an_email_persisted_underneath_it() {
        // The account panel's "Log in now" signs in WITHOUT closing Settings, so the
        // backend writes the account email while the form still holds the snapshot it
        // opened with - one where nobody was signed in. Saving any unrelated setting
        // afterwards posted that snapshot back and cleared the email, which is the
        // rehydrate seed: `speleodb_ensure_rehydrated` keys the credential lookup by
        // it, so the next launch could not find the token of the account that was
        // signed in and asked for another login instead.
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_over(Box::new(InMemoryStore::new()));
            // The form's copy, taken before the inline login resolved the account.
            let staged = state.get_config();
            assert_eq!(staged.speleodb.email, None);
            state.speleodb_persist_email(EMAIL);

            state.update_config(staged).expect("settings saved");

            assert_eq!(
                state.get_config().speleodb.email.as_deref(),
                Some(EMAIL),
                "a save behind an inline login must not clear the rehydrate seed"
            );
        });
    }

    #[test]
    fn an_unrelated_settings_save_keeps_the_credential_line() {
        // Keychain fails at login, the user answers the storage prompt with "Decide
        // later" (which deliberately persists nothing), then saves any unrelated
        // setting. Re-applying the UNCHANGED `keychain_disabled` re-ran
        // `refresh_keychain_state`, which reset the line to "not attempted" and took
        // the "Try again" button with it - it is offered only for `declined` /
        // `unavailable` - until the user signed in again.
        crate::test_helpers::with_isolated_config(|| {
            let state = signed_in_over(Box::new(FailingSecretStore));
            {
                let mut session = state.speleodb.lock().expect("session");
                assert_eq!(
                    session.token_store.store(EP, EMAIL, "tok", false),
                    TokenTier::Memory
                );
                assert_eq!(
                    session.token_store.keychain_state(),
                    KeychainState::Unavailable
                );
            }

            let mut posted = settings_save(&state, false);
            posted.general.undo_history_limit = 42;
            state.update_config(posted).expect("settings saved");

            let session = state.speleodb.lock().expect("session");
            assert_eq!(
                session.token_store.keychain_state(),
                KeychainState::Unavailable,
                "saving an unrelated setting must not forget that the keychain is broken"
            );
        });
    }
}
