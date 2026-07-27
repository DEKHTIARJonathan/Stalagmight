//! WHERE the SpeleoDB API key is kept, once the OS keychain has already failed.
//!
//! Split out of `core::state::speleodb` (frozen at the file-size ratchet) as a
//! sibling `impl AppState` block, next to `speleodb_logout` - which owns the other
//! half of the same preference, the persisted refusal flag.
//!
//! Both verbs here are the SAME operation with the decline flag set differently
//! beforehand: clear or set `keychain_declined`, then re-store the token the
//! session is already holding ([`crate::speleodb::auth::TokenStore::restore`]).
//! That is the point of asking at login rather than in Settings - at the moment
//! the keychain fails the key is in memory, so honouring the answer costs no
//! re-login and no re-typed password.
//!
//! Neither verb PROBES the keychain, but neither leaves it strictly alone either.
//! `speleodb_set_token_storage` sets the decline flag first, so the store/load
//! path never reaches the keyring - yet a SESSION-ONLY answer still issues one
//! direct DELETE ([`crate::speleodb::auth::TokenStore::restore`] sweeps both
//! persistent tiers when the token lands in memory), because "gone when the app
//! closes" has to be true on disk and an entry from an earlier working login would
//! otherwise sign the user straight back in. `speleodb_retry_keychain` reaches it
//! for the obvious reason: the user pressed "Try again". Both are explicit
//! user-initiated moments - the one context where a desktop unlock prompt is an
//! answer rather than a nag - and neither runs from a background path.

use super::speleodb::local_dto;
use super::AppState;
use crate::config::TokenFallback;
use crate::speleodb::auth::TokenTier;
use crate::speleodb::{SpeleoDbError, SpeleoErrorDto, SpeleoSessionStatus};

impl AppState {
    /// Record where the user wants the API key kept after this login's keychain
    /// failure, and move it there. `mode` is the new `token_fallback` preference:
    /// `SessionOnly` (gone when the app closes) or `Plaintext` (a `0o600` file that
    /// survives a restart).
    ///
    /// Also sets `keychain_declined`, because a choice made here is only meaningful
    /// if we then stop asking: while it is set nothing is stored to or read from
    /// the keychain - not a login write, not a startup read, not a status probe -
    /// which is what stops the dismissed unlock prompt returning on every launch.
    /// (The one exception is the session-only sweep described in the module doc,
    /// which DELETES rather than asks.)
    ///
    /// Returns the refreshed status so the frontend renders where the key actually
    /// landed rather than where it asked for it to go: the plaintext write can
    /// itself fail, and then the honest answer is session-only.
    pub(crate) fn speleodb_set_token_storage(
        &self,
        mode: TokenFallback,
    ) -> Result<SpeleoSessionStatus, SpeleoErrorDto> {
        // The sentinel never reaches the session or the config file; an
        // unrecognized mode falls to the safe tier rather than the on-disk one.
        let fallback = if mode == TokenFallback::Plaintext {
            TokenFallback::Plaintext
        } else {
            TokenFallback::SessionOnly
        };
        self.speleodb_move_token(true, fallback == TokenFallback::Plaintext)?;
        // Persisted only after the move succeeded, so a "not signed in" refusal
        // leaves no settled-looking preference behind for the next launch.
        self.speleodb_persist_storage_choice(fallback);
        self.speleodb_session_status()
    }

    /// Give the OS keychain another go (the Settings "Try again" affordance): lift
    /// the refusal on the live store and re-store the held token, which now reaches
    /// the keychain again. A user whose keyring was locked when they signed in,
    /// and who has since unlocked it, gets a durable key without signing out.
    ///
    /// The PERSISTED refusal is lifted only if the keychain actually takes the key
    /// - see the gate below. The live one is lifted either way, which is what makes
    /// a second press meaningful.
    ///
    /// The refreshed status is the whole answer: if the keychain is still broken
    /// the re-store falls back exactly as login does and the report says
    /// `unavailable`, so the button is safe to press twice.
    pub(crate) fn speleodb_retry_keychain(&self) -> Result<SpeleoSessionStatus, SpeleoErrorDto> {
        // The plaintext preference is unchanged by a retry - it only decides where
        // the token lands if the keychain refuses AGAIN.
        let allow_plaintext = self.speleodb_plaintext_allowed();
        let tier = self.speleodb_move_token(false, allow_plaintext)?;
        // Revoke the persisted refusal ONLY once the keychain has actually taken the
        // key - the same gate the login path is held to, for the same reason (#259).
        // `speleodb_move_token` reports `Ok` for ANY landing tier, so writing `false`
        // unconditionally revoked the refusal on a retry that had just fallen back to
        // plaintext or memory: the keyring was still broken, nothing had proved
        // otherwise, and the next launch rehydrated through it and re-raised the
        // unlock prompt the flag exists to stop.
        //
        // The live store's flag stays cleared either way, exactly as it does after a
        // failed login attempt: that is what lets this session report `unavailable`
        // (a broken keyring) rather than `declined`, which is the honest answer to a
        // button the user just pressed - and it is what keeps a further press from
        // being a no-op.
        if tier == TokenTier::Keychain {
            self.speleodb_persist_keychain_declined(false);
        }
        self.speleodb_session_status()
    }

    /// The shared half of both verbs: apply `declined` to the live token store,
    /// re-persist the held token under it, and report WHICH TIER it landed on.
    ///
    /// The tier is the return value rather than a discarded detail because `Ok`
    /// alone says almost nothing: the fallback chain means a still-broken keychain
    /// resolves to plaintext or memory and still reports success. A caller deciding
    /// whether the keychain has proved itself has to ask the tier.
    ///
    /// Refuses when no token is held. That is not pedantry - the two callers are a
    /// post-login prompt and a Settings button, and both can be reached after the
    /// session ended underneath them (a 401 auto-drop, a logout in another window).
    /// Silently succeeding would report a storage tier for a key that no longer
    /// exists, and would persist a preference the user never got the benefit of.
    fn speleodb_move_token(
        &self,
        declined: bool,
        allow_plaintext: bool,
    ) -> Result<TokenTier, SpeleoErrorDto> {
        // A cold session that has only ever been rehydrated lazily still holds its
        // token behind this call, so run it before reading the session's identity.
        self.speleodb_ensure_rehydrated();

        let mut session = self.speleodb_session_lock().map_err(local_dto)?;
        let (Some(endpoint), Some(email)) = (session.endpoint.clone(), session.email.clone())
        else {
            return Err(local_dto(SpeleoDbError::NotAuthenticated));
        };
        // Flip the flag around the restore, and put it BACK if the restore fails.
        // Leaving the mutation in place on the failure path left the live store
        // saying "the keychain is fine to use" while `config.speleodb
        // .keychain_declined` still said the opposite - the disagreement the login
        // path's "the two must not disagree across a restart" note guards against,
        // and enough to let a later keychain access in this process raise the
        // unlock prompt the persisted refusal forbids. Reachable whenever the
        // session ended underneath the panel (a 401 auto-drop, a logout in another
        // window) between the identity check above and the restore.
        let previously_declined = session.token_store.keychain_declined();
        session.token_store.set_keychain_declined(declined);
        match session
            .token_store
            .restore(&endpoint, &email, allow_plaintext)
        {
            Some(tier) => {
                drop(session);
                self.speleodb_persist_keychain_has_token(tier == TokenTier::Keychain);
                Ok(tier)
            }
            None => {
                session
                    .token_store
                    .set_keychain_declined(previously_declined);
                Err(local_dto(SpeleoDbError::NotAuthenticated))
            }
        }
    }

    /// Read the `token_fallback` preference under the config lock. Taken BEFORE the
    /// session lock is acquired: `speleodb_ensure_rehydrated` documents the
    /// config-then-session lock order, and inverting it here would be the deadlock.
    fn speleodb_plaintext_allowed(&self) -> bool {
        self.config
            .lock()
            .ok()
            .is_some_and(|c| c.speleodb.token_fallback == TokenFallback::Plaintext)
    }

    /// Persist the pair the login-time choice settles: where the key goes, and the
    /// fact that the question has been answered. One lock and one save rather than
    /// two, so a crash between them can't leave a refusal recorded with no
    /// destination (or the reverse).
    ///
    /// Best-effort in the same sense as the sibling email / decline writers: a
    /// config that could not be written means the next launch asks again, which is
    /// annoying but never unsafe.
    fn speleodb_persist_storage_choice(&self, fallback: TokenFallback) {
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if config.speleodb.token_fallback == fallback && config.speleodb.keychain_declined {
            return; // no write, no disk churn on a repeated choice
        }
        config.speleodb.token_fallback = fallback;
        config.speleodb.keychain_declined = true;
        if let Err(e) = config.save() {
            tracing::warn!(
                error = %e,
                ?fallback,
                "failed to persist the SpeleoDB credential-storage choice; the next launch may ask again"
            );
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "unit test fixtures fail loudly on setup errors"
)]
mod tests {
    use super::AppState;
    use crate::config::TokenFallback;
    use crate::speleodb::auth::{
        InMemoryStore, PlaintextStore, SecretStore, SecretStoreError, TokenStore,
    };
    use crate::speleodb::{KeychainReport, TokenStorage};

    /// A keychain that refuses every op - the locked / headless keyring that makes
    /// "Try again" a button worth having, and worth pressing twice.
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

    /// A state whose session already holds a token, over a WORKING fake keychain
    /// and a plaintext tier in `plaintext_root`. The working keychain is the point:
    /// it makes "we did not touch it" observable as a tier that is not Keychain.
    ///
    /// `rehydrate_attempted` is left alone - a seeded `endpoint` already
    /// short-circuits `speleodb_ensure_rehydrated`, so the fixture never reaches
    /// the config/keychain read.
    fn holding(plaintext_root: Option<std::path::PathBuf>) -> AppState {
        holding_over(Box::new(InMemoryStore::new()), plaintext_root)
    }

    /// [`holding`] with the keychain backend chosen by the caller, so a test can
    /// ask what happens when the retry does NOT reach the keyring.
    fn holding_over(
        keychain: Box<dyn SecretStore>,
        plaintext_root: Option<std::path::PathBuf>,
    ) -> AppState {
        let state = AppState::new().expect("state");
        let plaintext =
            plaintext_root.map(|r| Box::new(PlaintextStore::new(r)) as Box<dyn SecretStore>);
        let mut session = state.speleodb.lock().expect("session");
        session.endpoint = Some("https://sdb.example".to_owned());
        session.email = Some("u@x".to_owned());
        session.token_store = TokenStore::from_stores_holding("tok-1", keychain, plaintext);
        drop(session);
        state
    }

    /// The persisted `(token_fallback, keychain_declined)` pair.
    fn persisted(state: &AppState) -> (TokenFallback, bool) {
        let config = state.config.lock().expect("config");
        (
            config.speleodb.token_fallback,
            config.speleodb.keychain_declined,
        )
    }

    #[test]
    fn choosing_a_file_moves_the_key_there_and_settles_the_question() {
        // Both halves matter. Moving the key is what the user asked for; recording
        // the refusal is what stops the keychain being touched again on the next
        // launch, which is the complaint the whole flow exists to answer.
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let state = holding(Some(dir.path().to_path_buf()));

            let status = state
                .speleodb_set_token_storage(TokenFallback::Plaintext)
                .expect("the session holds a token, so it can be moved");

            assert_eq!(status.storage, Some(TokenStorage::Plaintext));
            assert_eq!(status.keychain, KeychainReport::Declined);
            assert!(status.logged_in, "moving the key does not sign anyone out");
            assert_eq!(
                persisted(&state),
                (TokenFallback::Plaintext, true),
                "the choice has to survive a restart to do its job"
            );
        });
    }

    #[test]
    fn choosing_session_only_keeps_the_key_off_disk() {
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let state = holding(Some(dir.path().to_path_buf()));

            let status = state
                .speleodb_set_token_storage(TokenFallback::SessionOnly)
                .expect("moved");

            assert_eq!(status.storage, Some(TokenStorage::Memory));
            assert_eq!(persisted(&state), (TokenFallback::SessionOnly, true));
            // Nothing was written to the plaintext root - "this session only" is a
            // promise about the filesystem, not a label.
            assert!(
                std::fs::read_dir(dir.path()).is_ok_and(|mut d| d.next().is_none()),
                "a session-only choice must leave no token file behind"
            );
        });
    }

    #[test]
    fn the_sentinel_mode_falls_to_the_safe_tier() {
        // `TokenFallback::Unknown` is the serde catch-all; an unrecognized mode from
        // the webview must never be resolved towards the ON-DISK tier.
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let state = holding(Some(dir.path().to_path_buf()));

            let status = state
                .speleodb_set_token_storage(TokenFallback::Unknown)
                .expect("moved");

            assert_eq!(status.storage, Some(TokenStorage::Memory));
            assert_eq!(persisted(&state), (TokenFallback::SessionOnly, true));
        });
    }

    #[test]
    fn retrying_the_keychain_clears_the_refusal_and_re_stores() {
        // The "Try again" affordance for someone who has since unlocked their
        // keyring: no sign-out, no re-typed password, and the refusal is lifted so
        // the next launch rehydrates from the keychain again.
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let state = holding(Some(dir.path().to_path_buf()));
            state
                .speleodb_set_token_storage(TokenFallback::Plaintext)
                .expect("declined first");

            let status = state.speleodb_retry_keychain().expect("retried");

            assert_eq!(status.storage, Some(TokenStorage::Keychain));
            assert_eq!(status.keychain, KeychainReport::Available);
            let (fallback, declined) = persisted(&state);
            assert!(!declined, "the refusal is lifted");
            assert_eq!(
                fallback,
                TokenFallback::Plaintext,
                "the retry does not undo where the key goes if the keychain fails again"
            );
        });
    }

    #[test]
    fn a_retry_that_never_reached_the_keychain_keeps_the_refusal() {
        // The retry falls back exactly as login does, so `speleodb_move_token`
        // reports `Ok` even when the keyring is still broken and the key just went
        // back into the plaintext file. Revoking the persisted refusal on that
        // outcome undid an answer nothing had disproved, and the next launch
        // rehydrated through the keychain and re-raised the unlock prompt the flag
        // exists to stop - the same hazard the login path is gated against (#259).
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("tempdir");
            let state = holding_over(Box::new(FailingSecretStore), Some(dir.path().to_path_buf()));
            state
                .speleodb_set_token_storage(TokenFallback::Plaintext)
                .expect("declined first");
            assert_eq!(persisted(&state), (TokenFallback::Plaintext, true));

            let status = state.speleodb_retry_keychain().expect("retried");

            assert_eq!(
                status.storage,
                Some(TokenStorage::Plaintext),
                "the keyring is still broken, so the key went back to the file"
            );
            assert_eq!(
                status.keychain,
                KeychainReport::Unavailable,
                "and the panel says why, rather than claiming the user declined"
            );
            let (_, declined) = persisted(&state);
            assert!(
                declined,
                "a retry that never reached the keychain must not revoke the refusal"
            );
        });
    }

    #[test]
    fn a_failed_move_puts_the_live_decline_flag_back() {
        // The session can end underneath the panel between the identity check and
        // the restore. Leaving the flag flipped there left the live store saying
        // "the keychain is fine to use" while the persisted preference still said
        // the opposite - and that disagreement is enough to let a later keychain
        // access raise the unlock prompt the refusal forbids.
        crate::test_helpers::with_isolated_config(|| {
            let state = AppState::new().expect("state");
            {
                let mut session = state.speleodb.lock().expect("session");
                session.endpoint = Some("https://sdb.example".to_owned());
                session.email = Some("u@x".to_owned());
                // Identity present, but NO token held - `restore` returns None.
                session.token_store = TokenStore::from_stores(Box::new(InMemoryStore::new()), None);
                session.token_store.set_keychain_declined(true);
            }

            assert!(state.speleodb_retry_keychain().is_err(), "no token to move");

            let session = state.speleodb.lock().expect("session");
            assert!(
                session.token_store.keychain_declined(),
                "a failed move must not leave the refusal silently lifted"
            );
        });
    }

    #[test]
    fn neither_verb_settles_anything_without_a_session() {
        // Both are reachable after the session died underneath them (a 401 auto-drop,
        // a logout in another window). Persisting a preference for a key that no
        // longer exists would mean the user is silently opted out of the keychain
        // without ever having been given the benefit of the choice.
        crate::test_helpers::with_isolated_config(|| {
            let state = AppState::new().expect("state");
            assert!(state
                .speleodb_set_token_storage(TokenFallback::Plaintext)
                .is_err());
            assert!(state.speleodb_retry_keychain().is_err());
            assert_eq!(persisted(&state), (TokenFallback::SessionOnly, false));
        });
    }
}
