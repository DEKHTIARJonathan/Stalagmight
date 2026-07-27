//! Backend-only credential storage for the SpeleoDB auth token.
//!
//! The token is written to one of three [`SecretStore`] tiers, keyed by the
//! normalized endpoint + email, and **never** crosses into the webview / IPC
//! payloads:
//!
//! 1. **OS keychain** ([`KeyringStore`], keyring-rs v3) - the persistent,
//!    survives-a-restart tier. First precedence on both read and write.
//! 2. **Plaintext file** ([`PlaintextStore`], `0o600` on Unix) - the opt-in
//!    headless-Linux escape hatch; only written when the two gates pass (the
//!    `token_fallback == Plaintext` preference AND the keychain failed this
//!    session). See [`TokenStore::store`].
//! 3. **In-memory** ([`InMemoryStore`] / the live session cache) - session-only,
//!    never persisted; the always-available fallback.
//!
//! [Track C] (#188) closed the spike's three holes documented here historically:
//! startup re-hydration (now wired lazily on the first authed call in
//! `core::state::speleodb`), the opt-in plaintext escape hatch (this module), and
//! the 401 auto-drop policy (the `clear` sink, driven from the orchestration
//! layer). Full URL-parse endpoint normalization lives in `account_key`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "stalagmight";

/// Build the keychain account key from the endpoint and email. The endpoint is
/// normalized via a real URL parse (scheme + host + port, lowercased host,
/// trailing slash and default ports dropped) so the same server entered several
/// ways resolves to one entry. Falls back to the lightweight string normalization
/// when the endpoint does not parse as a URL (e.g. a bare host).
pub(crate) fn account_key(endpoint: &str, email: &str) -> String {
    let normalized = normalize_endpoint(endpoint);
    format!("{normalized}|{email}")
}

/// Normalize an endpoint to a stable `scheme://host[:port]` form for keying.
///
/// [Track C] (#188, D-188 "URL-parse endpoint normalization"): a proper parse so
/// `https://Sdb.Example.com/`, `https://sdb.example.com`, and
/// `https://sdb.example.com:443` all collapse to one key. D-B19's *scheme reject*
/// (require explicit http/https) is **not** done here - it lives in Track A's
/// `tls.rs`; this is keying only, so an unparseable endpoint degrades gracefully
/// to the trimmed/lowercased string rather than erroring.
fn normalize_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    if let Ok(uri) = trimmed.parse::<http::Uri>() {
        if let Some(host) = uri.host() {
            let scheme = uri.scheme_str().unwrap_or("https").to_ascii_lowercase();
            let host = host.to_ascii_lowercase();
            // Drop the port when it is the scheme default so `:443`/`:80` and the
            // implicit form collapse together.
            let default_port = match scheme.as_str() {
                "http" => Some(80),
                "https" => Some(443),
                _ => None,
            };
            return match uri.port_u16() {
                Some(port) if Some(port) != default_port => format!("{scheme}://{host}:{port}"),
                _ => format!("{scheme}://{host}"),
            };
        }
    }
    // Bare host / unparseable: keep the spike's lightweight normalization.
    trimmed.trim_end_matches('/').to_ascii_lowercase()
}

/// An error from any [`SecretStore`] backend, unified behind the trait so callers
/// don't depend on `keyring::Error` vs `io::Error`. **Never** carries the token
/// (mirrors the redacted [`TokenStore`] `Debug`).
#[derive(Debug, thiserror::Error)]
#[error("secret store error: {0}")]
pub(crate) struct SecretStoreError(String);

#[cfg(test)]
impl SecretStoreError {
    /// Build a store error directly, so test fakes in sibling modules can fail a
    /// backend op (the inner message is private to this module).
    pub(crate) fn for_test(message: &str) -> Self {
        Self(message.to_owned())
    }
}

impl From<keyring::Error> for SecretStoreError {
    fn from(e: keyring::Error) -> Self {
        Self(e.to_string())
    }
}

impl From<std::io::Error> for SecretStoreError {
    fn from(e: std::io::Error) -> Self {
        Self(e.to_string())
    }
}

/// Backend-agnostic secret storage keyed by the `account_key(endpoint, email)`
/// string. The three production impls are [`KeyringStore`], [`PlaintextStore`],
/// and [`InMemoryStore`]; the test-only `FailingSecretStore` drives the
/// keychain-unavailable branches.
///
/// [Track C] (#188, D-B17): introduced so the keychain tiers are CI-testable
/// without a real OS secret service.
pub(crate) trait SecretStore: Send + Sync {
    /// A stable label for the backend (`"keychain"` | `"plaintext"` | `"memory"`).
    fn kind(&self) -> &'static str;
    /// Persist `token` under `account_key`, overwriting any existing value.
    fn store(&self, account_key: &str, token: &str) -> Result<(), SecretStoreError>;
    /// Load the token for `account_key`, or `Ok(None)` if absent.
    fn load(&self, account_key: &str) -> Result<Option<String>, SecretStoreError>;
    /// Delete the token for `account_key`. Idempotent: a missing entry is `Ok`.
    fn delete(&self, account_key: &str) -> Result<(), SecretStoreError>;
}

/// OS-keychain backend (keyring-rs v3). The persistent tier.
pub(crate) struct KeyringStore;

impl KeyringStore {
    fn entry(account_key: &str) -> Result<keyring::Entry, keyring::Error> {
        keyring::Entry::new(KEYRING_SERVICE, account_key)
    }
}

impl SecretStore for KeyringStore {
    fn kind(&self) -> &'static str {
        "keychain"
    }

    fn store(&self, account_key: &str, token: &str) -> Result<(), SecretStoreError> {
        Self::entry(account_key)?.set_password(token)?;
        Ok(())
    }

    fn load(&self, account_key: &str) -> Result<Option<String>, SecretStoreError> {
        match Self::entry(account_key)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn delete(&self, account_key: &str) -> Result<(), SecretStoreError> {
        match Self::entry(account_key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// In-memory backend (`Mutex<HashMap>`). The always-run CI seam (D-B17): tier
/// precedence, delete-on-401, rehydration, and the never-override-keychain
/// guardrail are all unit-tested by injecting these. It compiles in production
/// (the impls are not `#[cfg(test)]`-gated per the plan) but its constructor is
/// only called from tests, hence the non-test dead-code expectation on `new`.
pub(crate) struct InMemoryStore {
    map: Mutex<HashMap<String, String>>,
}

impl InMemoryStore {
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "[Track C] CI test seam (D-B17); constructed only in tests"
        )
    )]
    pub(crate) fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl SecretStore for InMemoryStore {
    fn kind(&self) -> &'static str {
        "memory"
    }

    fn store(&self, account_key: &str, token: &str) -> Result<(), SecretStoreError> {
        let mut map = self
            .map
            .lock()
            .map_err(|_| SecretStoreError("in-memory store lock poisoned".to_owned()))?;
        map.insert(account_key.to_owned(), token.to_owned());
        Ok(())
    }

    fn load(&self, account_key: &str) -> Result<Option<String>, SecretStoreError> {
        let map = self
            .map
            .lock()
            .map_err(|_| SecretStoreError("in-memory store lock poisoned".to_owned()))?;
        Ok(map.get(account_key).cloned())
    }

    fn delete(&self, account_key: &str) -> Result<(), SecretStoreError> {
        let mut map = self
            .map
            .lock()
            .map_err(|_| SecretStoreError("in-memory store lock poisoned".to_owned()))?;
        map.remove(account_key);
        Ok(())
    }
}

/// Plaintext-file backend. One file per account key under
/// `<root>/<sanitized_account_key>`. The opt-in headless-Linux escape hatch.
///
/// [Track C] (#188, D-B18): on Unix the file is created `0o600` and tightened if
/// it pre-existed looser (the 0600-at-create invariant). On Windows there is no
/// `0o600` equivalent - it relies on the per-user profile-dir ACL (documented
/// gap, no new platform dep). The `root` is injectable so tests use a tempdir.
pub(crate) struct PlaintextStore {
    root: PathBuf,
}

impl PlaintextStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Map an account key to a single safe filename component. The key contains a
    /// URL + `|` + email; replace every non-`[A-Za-z0-9._-]` byte with `_` so the
    /// result is one path component (no separators, no `..`).
    fn file_for(&self, account_key: &str) -> PathBuf {
        let sanitized: String = account_key
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.root.join(sanitized)
    }
}

impl SecretStore for PlaintextStore {
    fn kind(&self) -> &'static str {
        "plaintext"
    }

    fn store(&self, account_key: &str, token: &str) -> Result<(), SecretStoreError> {
        use std::io::Write as _;
        std::fs::create_dir_all(&self.root)?;
        let path = self.file_for(account_key);

        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
            // 0600-at-create: a fresh file is never group/other-readable.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)?;
            file.write_all(token.as_bytes())?;
            // If the file pre-existed looser, tighten it (mode() above does not
            // re-apply to an existing file).
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }

        #[cfg(not(unix))]
        {
            // SECURITY: Windows relies on profile-dir ACL; no 0600 equivalent (D-B18).
            let mut file = std::fs::File::create(&path)?;
            file.write_all(token.as_bytes())?;
        }

        Ok(())
    }

    fn load(&self, account_key: &str) -> Result<Option<String>, SecretStoreError> {
        let path = self.file_for(account_key);
        match std::fs::read_to_string(&path) {
            Ok(token) => Ok(Some(token)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn delete(&self, account_key: &str) -> Result<(), SecretStoreError> {
        let path = self.file_for(account_key);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Which tier the active token currently lives in.
///
/// [Track C] (#188): replaces the spike's bare `keychain_backed` bool so the
/// store can distinguish a persistent keychain token from the plaintext escape
/// hatch from a session-only one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokenTier {
    Keychain,
    Plaintext,
    Memory,
}

/// What we have LEARNED about the OS keychain - never what we went looking for.
///
/// Settings needs to tell the user where their API key actually lives, but on
/// Linux a locked keyring turns any keychain access into a desktop unlock
/// prompt, so *probing* to draw a status line would re-introduce exactly the
/// nag the decline flag exists to stop. So this is only ever set as a
/// side effect of access we already had to make (a login write, a startup
/// rehydrate read), and `NotAttempted` is an honest answer we are willing to
/// show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeychainState {
    /// Nothing has touched the keychain this session, so we genuinely do not know.
    NotAttempted,
    /// A keychain read or write succeeded.
    Available,
    /// A keychain read or write failed (absent, locked, or refused).
    Unavailable,
    /// The user declined it; we are deliberately not touching it until they sign
    /// in again.
    Declined,
}

/// Holds the SpeleoDB token backend-side across an ordered tier list. The active
/// token is never returned to the webview; only [`Self::keychain_backed`] is
/// surfaced (so the UI can warn that a non-keychain token won't survive a
/// restart).
///
/// [Track C] (#188): reworked from `{ in_memory, keychain_backed }` onto the
/// [`SecretStore`] tiers with keychain-first read + plaintext self-heal + the
/// two-gate plaintext write.
pub(crate) struct TokenStore {
    /// The live token for this session: cached here after [`Self::store`]/
    /// [`Self::load`] so authed calls don't re-hit the keychain each request.
    in_memory: Option<String>,
    /// Which tier the active token lives in. `None` = no active token.
    active_tier: Option<TokenTier>,
    /// First-precedence persistent backend (the OS keychain in production).
    keychain: Box<dyn SecretStore>,
    /// The plaintext escape hatch, present only when it is *available* this
    /// session (the production [`Default`] wires it; the two-gate in [`Self::store`]
    /// decides whether it is actually *written*).
    plaintext: Option<Box<dyn SecretStore>>,
    /// The user declined the keychain (persisted as `config.speleodb.keychain_declined`).
    /// While set, NEITHER [`Self::store`] NOR [`Self::load`] goes near it, which is
    /// what stops a dismissed unlock prompt coming back on every launch.
    /// [`Self::clear`] still sweeps every tier regardless - a refusal must never
    /// strand a token somewhere we then refuse to look.
    keychain_declined: bool,
    /// What keychain access we have already made taught us. See [`KeychainState`].
    keychain_state: KeychainState,
}

impl Default for TokenStore {
    /// Production wiring: a real keychain plus an *available* plaintext store
    /// rooted at `<config_dir>/speleodb/tokens`. Plaintext availability is not the
    /// same as plaintext *use* - the two-gate in [`Self::store`] still requires
    /// the `token_fallback == Plaintext` preference AND a keychain failure.
    fn default() -> Self {
        let plaintext_root =
            crate::app_dirs::config_dir().map(|dir| dir.join("speleodb").join("tokens"));
        Self::new(plaintext_root)
    }
}

impl std::fmt::Debug for TokenStore {
    /// Hand-written so the live token is never formatted: a stray
    /// `tracing::debug!(?session, …)` must not write the secret to logs (the
    /// token-never-in-logs invariant). Prints presence + `active_tier` only.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenStore")
            .field("token", &self.in_memory.as_ref().map(|_| "<redacted>"))
            .field("active_tier", &self.active_tier)
            .finish()
    }
}

impl TokenStore {
    /// Production constructor. The keychain is always a real [`KeyringStore`]; the
    /// plaintext tier is wired iff `plaintext_root` is `Some`.
    pub(crate) fn new(plaintext_root: Option<PathBuf>) -> Self {
        Self {
            in_memory: None,
            active_tier: None,
            keychain: Box::new(KeyringStore),
            plaintext: plaintext_root
                .map(|r| Box::new(PlaintextStore::new(r)) as Box<dyn SecretStore>),
            keychain_declined: false,
            keychain_state: KeychainState::NotAttempted,
        }
    }

    /// Apply the persisted decline flag (from `config.speleodb.keychain_declined`).
    /// Called when seeding the session and again when the user signs in - a fresh
    /// login is the one moment they have opted back into being asked, so that is
    /// where `false` is passed to re-enable the keychain.
    pub(crate) fn set_keychain_declined(&mut self, declined: bool) {
        self.keychain_declined = declined;
        self.keychain_state = if declined {
            KeychainState::Declined
        } else {
            // Re-enabling makes what we previously learned stale: an "Unavailable"
            // from before the user fixed their keyring would otherwise be reported
            // forever. Say we do not know, and let the next real access answer.
            KeychainState::NotAttempted
        };
    }

    /// What we know about the keychain, for the Settings credential-storage line.
    /// Reporting only - this never triggers keychain access.
    pub(crate) fn keychain_state(&self) -> KeychainState {
        self.keychain_state
    }

    /// Whether the keychain is currently being skipped. Lets a caller that flips
    /// the flag around a fallible operation put the previous answer back, instead
    /// of leaving the live store disagreeing with the persisted preference.
    pub(crate) fn keychain_declined(&self) -> bool {
        self.keychain_declined
    }

    /// The tier the active token lives in, or `None` when there is no token.
    pub(crate) fn active_tier(&self) -> Option<TokenTier> {
        self.active_tier
    }

    /// Record the outcome of a keychain access. Only ever called from a real
    /// read/write, never from a probe.
    fn note_keychain(&mut self, ok: bool) {
        self.keychain_state = if ok {
            KeychainState::Available
        } else {
            KeychainState::Unavailable
        };
    }

    /// Store `token` for `(endpoint, email)` across the tier list. Tries the
    /// keychain first; on success caches in memory, marks [`TokenTier::Keychain`],
    /// and **self-heals** by deleting any stale plaintext copy (guardrail 6:
    /// a usable keychain supersedes plaintext). On a keychain error runs the
    /// **two-gate** plaintext opt-in: writes plaintext iff `allow_plaintext` (gate
    /// 1, the `token_fallback == Plaintext` preference) AND the plaintext tier is
    /// available (gate 2 is the keychain failure that landed us here); otherwise
    /// falls back to session-only memory. Returns the resolved [`TokenTier`].
    pub(crate) fn store(
        &mut self,
        endpoint: &str,
        email: &str,
        token: &str,
        allow_plaintext: bool,
    ) -> TokenTier {
        let key = account_key(endpoint, email);
        self.in_memory = Some(token.to_owned());

        // Declined: go straight to the non-keychain tiers. Deliberately NOT
        // recorded as a keychain failure - the keychain may be perfectly healthy;
        // we simply are not asking.
        if self.keychain_declined {
            return self.store_without_keychain(&key, token, allow_plaintext);
        }

        match self.keychain.store(&key, token) {
            Ok(()) => {
                self.note_keychain(true);
                // Self-heal (guardrail 6): a usable keychain removes any stale
                // plaintext copy so the escape hatch never shadows the keychain.
                if let Some(plaintext) = &self.plaintext {
                    if let Err(e) = plaintext.delete(&key) {
                        tracing::warn!(error = %e, "failed to delete stale plaintext SpeleoDB token");
                    }
                }
                tracing::debug!(tier = self.keychain.kind(), "SpeleoDB token stored");
                self.active_tier = Some(TokenTier::Keychain);
                TokenTier::Keychain
            }
            Err(e) => {
                self.note_keychain(false);
                tracing::warn!(
                    error = %e,
                    "OS keychain unavailable; falling back to a non-keychain SpeleoDB token tier for this session"
                );
                self.store_without_keychain(&key, token, allow_plaintext)
            }
        }
    }

    /// The non-keychain half of [`Self::store`]: the two-gate plaintext opt-in,
    /// else session-only memory. Reached either because the keychain FAILED or
    /// because the user DECLINED it - the tier decision is identical, but only the
    /// former is a keychain failure, so the caller owns [`Self::note_keychain`].
    fn store_without_keychain(
        &mut self,
        key: &str,
        token: &str,
        allow_plaintext: bool,
    ) -> TokenTier {
        match (allow_plaintext, &self.plaintext) {
            (true, Some(plaintext)) => match plaintext.store(key, token) {
                Ok(()) => {
                    tracing::debug!(tier = plaintext.kind(), "SpeleoDB token stored");
                    self.active_tier = Some(TokenTier::Plaintext);
                    TokenTier::Plaintext
                }
                Err(e) => {
                    tracing::warn!(error = %e, "plaintext SpeleoDB token write failed; holding in memory only");
                    self.active_tier = Some(TokenTier::Memory);
                    TokenTier::Memory
                }
            },
            _ => {
                self.active_tier = Some(TokenTier::Memory);
                TokenTier::Memory
            }
        }
    }

    /// Re-persist the token this session ALREADY holds, at whatever tier the
    /// current gates allow. `None` when there is nothing to move (a logged-out
    /// session), which the caller reports rather than treating as success.
    ///
    /// This is what makes the storage question askable at all: when the keychain
    /// fails at login the key is sitting right here in memory, so "put it in a
    /// file instead" and "try the keychain again" are the same operation with the
    /// decline flag set differently beforehand - no re-login, no re-typed password.
    ///
    /// Runs the full [`Self::store`] path so the decline flag and the two-gate
    /// plaintext opt-in apply exactly as they do at login.
    pub(crate) fn restore(
        &mut self,
        endpoint: &str,
        email: &str,
        allow_plaintext: bool,
    ) -> Option<TokenTier> {
        let token = self.in_memory.clone()?;
        let tier = self.store(endpoint, email, &token, allow_plaintext);
        // "This session only" has to be true ON DISK, not just in the label the
        // user is shown: a copy from an earlier choice would otherwise sit there
        // and be re-loaded on the next launch, which is the opposite of what they
        // just asked for. The keychain tier self-heals plaintext inside `store`;
        // only the memory landing needs sweeping here.
        //
        // BOTH persistent tiers are swept, not just plaintext. A working login on
        // an earlier day writes the key to the keychain, and leaving that entry
        // behind makes "you will be signed out when the app closes" false the
        // moment the next launch rehydrates through it - the promise then rests
        // entirely on `keychain_declined` reaching disk, which is best-effort.
        //
        // Touching the keychain here does NOT re-open the nag this flow exists to
        // stop: `restore` is reached only from the two explicit credential verbs
        // (the post-login storage answer and the Settings button), never from a
        // background path, and on the broken keyring that raised the question in
        // the first place the delete fails harmlessly.
        if tier == TokenTier::Memory {
            let key = account_key(endpoint, email);
            if let Err(e) = self.keychain.delete(&key) {
                tracing::debug!(
                    error = %e,
                    "no keychain entry swept after a session-only choice (the keychain is unavailable here)"
                );
            }
            if let Some(plaintext) = &self.plaintext {
                if let Err(e) = plaintext.delete(&key) {
                    tracing::warn!(
                        error = %e,
                        "failed to delete the plaintext SpeleoDB token after a session-only choice"
                    );
                }
            }
        }
        Some(tier)
    }

    /// Whether the active token is backed by the OS keychain (vs the plaintext or
    /// in-memory tiers). Lets the UI keep warning about a non-persistent token.
    pub(crate) fn keychain_backed(&self) -> bool {
        self.active_tier == Some(TokenTier::Keychain)
    }

    /// Load the active token, if any. Within a session this serves the in-memory
    /// cache. On a cold session (rehydration) it reads **keychain-first**: a
    /// keychain hit deletes any stale plaintext copy (self-heal / guardrail 6),
    /// caches, and marks [`TokenTier::Keychain`]; otherwise it falls back to the
    /// plaintext tier. All-miss yields `None` (callers → `NotAuthenticated`).
    ///
    /// `&mut self` because it updates the session cache + `active_tier`.
    pub(crate) fn load(&mut self, endpoint: &str, email: &str) -> Option<String> {
        if let Some(token) = &self.in_memory {
            return Some(token.clone());
        }
        let key = account_key(endpoint, email);

        // Declined: skip the keychain entirely. THIS is the launch-time nag fix -
        // rehydration on startup is what re-raised the desktop unlock prompt on
        // every single launch for a user who had already dismissed it once.
        if !self.keychain_declined {
            // Keychain-first (precedence): a hit supersedes and self-heals plaintext.
            match self.keychain.load(&key) {
                Ok(Some(token)) => {
                    self.note_keychain(true);
                    if let Some(plaintext) = &self.plaintext {
                        if let Err(e) = plaintext.delete(&key) {
                            tracing::warn!(error = %e, "failed to delete stale plaintext SpeleoDB token");
                        }
                    }
                    self.in_memory = Some(token.clone());
                    self.active_tier = Some(TokenTier::Keychain);
                    return Some(token);
                }
                // Reachable and healthy: the keychain answered, it just holds
                // nothing for this account. That IS an availability signal.
                Ok(None) => self.note_keychain(true),
                Err(e) => {
                    self.note_keychain(false);
                    tracing::warn!(error = %e, "keychain read failed during SpeleoDB rehydration");
                }
            }
        }

        // Fall back to the plaintext tier (the headless escape hatch).
        if let Some(plaintext) = &self.plaintext {
            if let Ok(Some(token)) = plaintext.load(&key) {
                self.in_memory = Some(token.clone());
                self.active_tier = Some(TokenTier::Plaintext);
                return Some(token);
            }
        }

        None
    }

    /// Forget the token from **every** tier (keychain + plaintext + memory),
    /// **reporting** a persistent-tier delete failure to the caller.
    ///
    /// Every tier is attempted even when an earlier one fails, and the in-memory
    /// token is always dropped - the returned `Err` says "the credential may still
    /// be on this machine", never "nothing was cleared". Both persistent tiers are
    /// reported: a surviving plaintext file resurrects a session exactly like a
    /// surviving keychain entry does ([`Self::load`] falls back to it), and it is
    /// an on-disk cleartext token besides. The first failure wins as the reported
    /// error; both are logged.
    ///
    /// Logout propagates the `Err` so the user can be warned (#270); the 401
    /// auto-drop deliberately drops it (`SpeleoDbSession::forget`) - a dead token
    /// must leave the session even when the keychain is flaky.
    pub(crate) fn clear(&mut self, endpoint: &str, email: &str) -> Result<(), SecretStoreError> {
        let key = account_key(endpoint, email);
        let mut failure = None;
        // The keychain is ALWAYS swept, but its failure is only REPORTED when the
        // keychain could actually be holding a credential for this account.
        //
        // That question is ANSWERED BY PROBING, not inferred from `active_tier`.
        // `active_tier` says where THIS session's token came from, and a keychain
        // entry outlives the session that wrote it: a session running on the
        // plaintext or memory tier - the ordinary outcome of a transient keychain
        // hiccup at login - would suppress the warning about a live bearer token
        // that an EARLIER session left behind and this delete just failed to remove.
        // Logout then returned `Ok` with a working credential still in the OS
        // keychain, which is the one outcome this reporting exists to prevent.
        //
        // An `Err` from the probe keeps the original suppression, and for the
        // original reason: on a keychain-less box - headless Linux with no secret
        // service, a supported configuration with the plaintext tier as its escape
        // hatch - every keyring op fails at `Entry::new`, before it ever asks about
        // the entry (a missing entry is already `Ok`: `NoEntry` maps to success). So
        // `load`, `store` and `delete` all fail there, and warning that a credential
        // "may still be stored on this machine" about a store that cannot hold one
        // fires on every ordinary logout - a warning the user learns to ignore,
        // which costs them the case where it is real.
        //
        // A DECLINED keychain is skipped outright, probe included. `forget` routes
        // both the user's logout and the background 401 auto-drop through here, so
        // probing would raise the desktop unlock prompt on a locked keyring from an
        // auth failure the user never initiated - exactly the nag the decline flag
        // exists to stop, and the one path that can fire it without them asking for
        // anything. Nothing is orphaned by skipping: `store` never reaches the
        // keychain while the flag is set, so this store has put nothing there, and
        // an entry predating the decline is overwritten by the next successful
        // login (which clears the flag and re-stores) or swept by "Try again".
        if !self.keychain_declined {
            let keychain_may_hold_it = matches!(self.keychain.load(&key), Ok(Some(_)));
            if let Err(e) = self.keychain.delete(&key) {
                if keychain_may_hold_it {
                    tracing::warn!(error = %e, "failed to delete SpeleoDB token from keychain");
                    failure = Some(e);
                } else {
                    tracing::debug!(
                        error = %e,
                        active_tier = ?self.active_tier,
                        purpose = "defensive sweep of a keychain that holds nothing for this account",
                        "SpeleoDB keychain delete failed for an account it does not hold"
                    );
                }
            }
        } else {
            tracing::debug!(
                purpose =
                    "the user declined the keychain; probing it here is the nag the flag prevents",
                "skipped the SpeleoDB keychain sweep"
            );
        }
        if let Some(plaintext) = &self.plaintext {
            if let Err(e) = plaintext.delete(&key) {
                tracing::warn!(error = %e, "failed to delete SpeleoDB token from plaintext store");
                failure = failure.or(Some(e));
            }
        }
        self.in_memory = None;
        self.active_tier = None;
        failure.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
impl TokenStore {
    /// Build an in-memory-backed store directly, bypassing the OS keychain. For
    /// unit tests here and in sibling modules (the real fields are private, and
    /// touching the keychain in tests is both slow and environment-dependent).
    pub(crate) fn from_in_memory_token(token: &str) -> Self {
        Self {
            in_memory: Some(token.to_owned()),
            active_tier: Some(TokenTier::Memory),
            keychain: Box::new(InMemoryStore::new()),
            plaintext: None,
            keychain_declined: false,
            keychain_state: KeychainState::NotAttempted,
        }
    }

    /// A store already HOLDING `token` in memory over the injected backends - the
    /// shape a session has at the moment the storage question is asked: the key is
    /// in hand, only its destination is undecided. Lets sibling-module tests drive
    /// [`Self::restore`] without a login or a real keychain.
    pub(crate) fn from_stores_holding(
        token: &str,
        keychain: Box<dyn SecretStore>,
        plaintext: Option<Box<dyn SecretStore>>,
    ) -> Self {
        let mut store = Self::from_stores(keychain, plaintext);
        store.in_memory = Some(token.to_owned());
        store.active_tier = Some(TokenTier::Memory);
        store
    }

    /// Inject the keychain (+ optional plaintext) backends so tier-precedence,
    /// self-heal, two-gate, and guardrail-6 tests run against fakes.
    pub(crate) fn from_stores(
        keychain: Box<dyn SecretStore>,
        plaintext: Option<Box<dyn SecretStore>>,
    ) -> Self {
        Self {
            in_memory: None,
            active_tier: None,
            keychain,
            plaintext,
            keychain_declined: false,
            keychain_state: KeychainState::NotAttempted,
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "unit test fixtures"
)]
mod tests {
    use super::{
        account_key, normalize_endpoint, InMemoryStore, KeychainState, PlaintextStore, SecretStore,
        SecretStoreError, TokenStore, TokenTier,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// A [`SecretStore`] whose every op errors - simulates a headless box with no
    /// secret service. Drives the plaintext two-gate + the keychain-failure path.
    struct FailingSecretStore;

    impl SecretStore for FailingSecretStore {
        fn kind(&self) -> &'static str {
            "failing"
        }
        fn store(&self, _: &str, _: &str) -> Result<(), SecretStoreError> {
            Err(SecretStoreError("no secret service".to_owned()))
        }
        fn load(&self, _: &str) -> Result<Option<String>, SecretStoreError> {
            Err(SecretStoreError("no secret service".to_owned()))
        }
        fn delete(&self, _: &str) -> Result<(), SecretStoreError> {
            Err(SecretStoreError("no secret service".to_owned()))
        }
    }

    /// A WORKING keychain that refuses to delete: `store`/`load` behave normally, so
    /// it can hold (and report holding) an entry, while `delete` fails.
    ///
    /// This is the shape that actually matters for logout, and the one
    /// [`FailingSecretStore`] cannot express: a keychain that IS usable on this
    /// machine and IS holding a live bearer token that the delete just failed to
    /// remove. `FailingSecretStore` models the opposite case - a box with no secret
    /// service at all, where nothing can be stored and so nothing can survive.
    struct DeleteFailsStore(InMemoryStore);

    impl DeleteFailsStore {
        /// A store already holding `token` for `account_key`, as an earlier session
        /// would have left it.
        fn holding(account_key: &str, token: &str) -> Self {
            let inner = InMemoryStore::new();
            inner.store(account_key, token).expect("seed entry");
            Self(inner)
        }
    }

    impl SecretStore for DeleteFailsStore {
        fn kind(&self) -> &'static str {
            "delete-fails"
        }
        fn store(&self, account_key: &str, token: &str) -> Result<(), SecretStoreError> {
            self.0.store(account_key, token)
        }
        fn load(&self, account_key: &str) -> Result<Option<String>, SecretStoreError> {
            self.0.load(account_key)
        }
        fn delete(&self, _: &str) -> Result<(), SecretStoreError> {
            Err(SecretStoreError("delete refused".to_owned()))
        }
    }

    const EP: &str = "http://10.10.0.220:8000/";
    const EMAIL: &str = "u@x";

    // ── account_key / endpoint normalization ────────────────────────────────

    #[test]
    fn account_key_normalizes_endpoint() {
        // Same server, two spellings → one key.
        assert_eq!(
            account_key("https://Sdb.Example.com/", "a@b.com"),
            account_key("https://sdb.example.com", "a@b.com")
        );
        assert_eq!(
            account_key("http://10.10.0.220:8000/", "u@x"),
            "http://10.10.0.220:8000|u@x"
        );
    }

    #[test]
    fn endpoint_normalization_url_parse() {
        // A real URL parse: default ports collapse, host lowercases, trailing
        // slash and path-less differences fold to one key.
        assert_eq!(
            normalize_endpoint("https://SDB.Example.com:443/"),
            "https://sdb.example.com"
        );
        assert_eq!(
            normalize_endpoint("https://sdb.example.com"),
            "https://sdb.example.com"
        );
        assert_eq!(normalize_endpoint("http://Host:80"), "http://host");
        // A non-default port is preserved.
        assert_eq!(
            normalize_endpoint("http://10.10.0.220:8000/"),
            "http://10.10.0.220:8000"
        );
        // A bare host (no scheme) degrades to the lightweight normalization.
        assert_eq!(normalize_endpoint("Bare.Host/"), "bare.host");
    }

    // ── in-memory ctor (retained spike behavior) ────────────────────────────

    #[test]
    fn in_memory_fallback_round_trips_without_keychain() {
        // The in-memory constructor never touches the real OS keychain.
        let mut store = TokenStore::from_in_memory_token("tok-123");
        assert_eq!(store.load(EP, EMAIL), Some("tok-123".to_owned()));
    }

    #[test]
    fn clear_forgets_in_memory_token() {
        let mut store = TokenStore::from_in_memory_token("tok-123");
        store.clear(EP, EMAIL).expect("clear");
        assert_eq!(store.load(EP, EMAIL), None);
    }

    // ── tier precedence / self-heal / guardrail 6 ───────────────────────────

    #[test]
    fn tier_precedence_keychain_first() {
        // Keychain succeeds → active tier is Keychain, keychain_backed true.
        let mut store = TokenStore::from_stores(
            Box::new(InMemoryStore::new()),
            Some(Box::new(InMemoryStore::new())),
        );
        assert_eq!(store.store(EP, EMAIL, "tok", true), TokenTier::Keychain);
        assert!(store.keychain_backed());
    }

    #[test]
    fn store_keychain_success_deletes_stale_plaintext() {
        // Seed a stale plaintext copy on disk, then a successful keychain store
        // must wipe it (guardrail 6 self-heal on write). The on-disk tempdir is
        // observable through a sibling PlaintextStore after the box is consumed.
        let dir = tempfile::tempdir().expect("tempdir");
        let key = account_key(EP, EMAIL);
        let seeded = PlaintextStore::new(dir.path().to_path_buf());
        seeded.store(&key, "stale").unwrap();

        let mut store = TokenStore::from_stores(
            Box::new(InMemoryStore::new()),
            Some(Box::new(PlaintextStore::new(dir.path().to_path_buf()))),
        );
        assert_eq!(store.store(EP, EMAIL, "fresh", true), TokenTier::Keychain);
        assert!(store.keychain_backed());

        // The stale plaintext copy is gone (self-heal deleted it).
        let probe = PlaintextStore::new(dir.path().to_path_buf());
        assert_eq!(probe.load(&key).unwrap(), None);
    }

    #[test]
    fn keychain_read_self_heals_plaintext() {
        // A cold load that hits the keychain must delete the plaintext copy.
        let key = account_key(EP, EMAIL);
        let keychain = InMemoryStore::new();
        keychain.store(&key, "kc-tok").unwrap();
        let plaintext = InMemoryStore::new();
        plaintext.store(&key, "pt-tok").unwrap();

        // We need to observe the plaintext store after the load, so wire boxes we
        // also hold raw references to via separate InMemoryStores sharing state is
        // not possible; instead assert through a second load: after the keychain
        // load self-heals, a store with ONLY the plaintext tier must miss.
        let keychain_box: Box<dyn SecretStore> = Box::new(keychain);
        let plaintext_box: Box<dyn SecretStore> = Box::new(plaintext);
        let mut store = TokenStore::from_stores(keychain_box, Some(plaintext_box));
        assert_eq!(store.load(EP, EMAIL), Some("kc-tok".to_owned()));
        assert!(store.keychain_backed());

        // Clear the session cache and force a re-read: the keychain still wins,
        // and the plaintext copy was deleted during the first load (self-heal).
        store.in_memory = None;
        store.active_tier = None;
        assert_eq!(store.load(EP, EMAIL), Some("kc-tok".to_owned()));
        assert!(store.keychain_backed());
    }

    #[test]
    fn never_override_keychain_guardrail6() {
        // Even with the plaintext preference ON, a working keychain is used and
        // plaintext is never written (guardrail 6).
        let key = account_key(EP, EMAIL);
        let plaintext = InMemoryStore::new();
        let plaintext_box: Box<dyn SecretStore> = Box::new(plaintext);
        let mut store =
            TokenStore::from_stores(Box::new(InMemoryStore::new()), Some(plaintext_box));
        assert_eq!(store.store(EP, EMAIL, "tok", true), TokenTier::Keychain);

        // Re-load on a plaintext-only store: nothing was written there.
        let probe = InMemoryStore::new();
        assert_eq!(probe.load(&key).unwrap(), None);
    }

    // ── plaintext two-gate + 0600 ───────────────────────────────────────────

    #[test]
    fn plaintext_written_only_when_both_gates_pass() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key = account_key(EP, EMAIL);

        // Gate 1 OFF (allow_plaintext = false) + keychain fails → Memory, no file.
        let mut store = TokenStore::from_stores(
            Box::new(FailingSecretStore),
            Some(Box::new(PlaintextStore::new(dir.path().to_path_buf()))),
        );
        assert_eq!(store.store(EP, EMAIL, "tok", false), TokenTier::Memory);
        let probe = PlaintextStore::new(dir.path().to_path_buf());
        assert_eq!(probe.load(&key).unwrap(), None);

        // Gate 1 ON + keychain fails (gate 2) → Plaintext, file written.
        let mut store = TokenStore::from_stores(
            Box::new(FailingSecretStore),
            Some(Box::new(PlaintextStore::new(dir.path().to_path_buf()))),
        );
        assert_eq!(store.store(EP, EMAIL, "tok", true), TokenTier::Plaintext);
        assert_eq!(probe.load(&key).unwrap(), Some("tok".to_owned()));
        assert!(!store.keychain_backed());
    }

    #[test]
    fn plaintext_falls_back_to_memory_without_plaintext_tier() {
        // Preference ON but no plaintext tier available → Memory.
        let mut store = TokenStore::from_stores(Box::new(FailingSecretStore), None);
        assert_eq!(store.store(EP, EMAIL, "tok", true), TokenTier::Memory);
    }

    #[cfg(unix)]
    #[test]
    fn plaintext_file_is_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let key = account_key(EP, EMAIL);
        let pt = PlaintextStore::new(dir.path().to_path_buf());
        pt.store(&key, "tok").unwrap();
        let path = dir.path().join(
            key.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>(),
        );
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "plaintext token file must be 0600");
    }

    #[cfg(unix)]
    #[test]
    fn plaintext_tightens_preexisting_loose_file() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let key = account_key(EP, EMAIL);
        let pt = PlaintextStore::new(dir.path().to_path_buf());
        // Pre-create the file 0644 (looser), then store must tighten to 0600.
        std::fs::create_dir_all(dir.path()).unwrap();
        let sanitized: String = key
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let path = dir.path().join(&sanitized);
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        pt.store(&key, "new").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // ── clear-all-tiers + load misses ───────────────────────────────────────

    #[test]
    fn clear_deletes_from_all_tiers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key = account_key(EP, EMAIL);
        // Seed both keychain and plaintext, then clear must wipe both + memory.
        let keychain = InMemoryStore::new();
        keychain.store(&key, "kc").unwrap();
        let plaintext = PlaintextStore::new(dir.path().to_path_buf());
        plaintext.store(&key, "pt").unwrap();

        let mut store = TokenStore::from_stores(
            Box::new(InMemoryStore::new()),
            Some(Box::new(PlaintextStore::new(dir.path().to_path_buf()))),
        );
        // Prime the keychain tier through the store so it has something to delete.
        store.keychain.store(&key, "kc").unwrap();
        store.in_memory = Some("kc".to_owned());
        store.active_tier = Some(TokenTier::Keychain);

        store.clear(EP, EMAIL).expect("clear");
        assert_eq!(store.load(EP, EMAIL), None);
        // Plaintext side is wiped too.
        let probe = PlaintextStore::new(dir.path().to_path_buf());
        assert_eq!(probe.load(&key).unwrap(), None);
    }

    #[test]
    fn clear_surfaces_a_failed_keychain_delete() {
        // #270: a keychain delete that fails must be REPORTED (logout warns the user
        // that the credential may still live on this machine) - but the in-memory
        // token is dropped anyway, so the session is gone either way.
        //
        // The keychain is a DeleteFailsStore rather than the all-ops-fail
        // FailingSecretStore, because the suppression is no longer keyed on
        // `active_tier`: `clear` now PROBES the keychain, and a store that cannot even
        // be read is the keychain-less box (see
        // `clear_does_not_warn_about_a_keychain_that_never_held_the_token`). What has
        // to be reported is a keychain that IS holding a token and would not give it
        // up - which is precisely this fixture.
        let key = account_key(EP, EMAIL);
        let mut store =
            TokenStore::from_stores(Box::new(DeleteFailsStore::holding(&key, "tok")), None);
        store.in_memory = Some("tok".to_owned());
        store.active_tier = Some(TokenTier::Keychain);

        assert!(
            store.clear(EP, EMAIL).is_err(),
            "a failing keychain delete must be reported, not swallowed"
        );
        // Asserted on the field, not through `load`: the keychain entry SURVIVED (that
        // is the whole point of the reported error), so a `load` would legitimately
        // re-find it there - which is exactly the resurrection the Err warns about.
        assert!(
            store.in_memory.is_none(),
            "the in-memory token must be forgotten even when the keychain delete failed"
        );
        assert!(!store.keychain_backed());
    }

    #[test]
    fn clear_surfaces_a_failed_plaintext_delete() {
        // The plaintext tier is reported the same way: a surviving cleartext file is
        // itself a resurrectable token (`load` falls back to it).
        let mut store = TokenStore::from_stores(
            Box::new(InMemoryStore::new()),
            Some(Box::new(FailingSecretStore)),
        );
        store.in_memory = Some("tok".to_owned());
        assert!(store.clear(EP, EMAIL).is_err());
        assert_eq!(store.load(EP, EMAIL), None);
    }

    #[test]
    fn clear_deletes_every_tier_despite_an_earlier_failure() {
        // The keychain delete failing must not skip the plaintext delete - every tier
        // is attempted, the failure is only *reported* at the end.
        let dir = tempfile::tempdir().expect("tempdir");
        let key = account_key(EP, EMAIL);
        let seeded = PlaintextStore::new(dir.path().to_path_buf());
        seeded.store(&key, "pt").unwrap();

        let mut store = TokenStore::from_stores(
            Box::new(DeleteFailsStore::holding(&key, "kc")),
            Some(Box::new(PlaintextStore::new(dir.path().to_path_buf()))),
        );
        // A keychain that HOLDS the entry and refuses to delete it: that is what makes
        // the failure reportable now (`clear` probes rather than trusting
        // `active_tier`), and it is the only shape where a surviving keychain
        // credential is actually possible.
        store.active_tier = Some(TokenTier::Keychain);
        assert!(store.clear(EP, EMAIL).is_err());
        assert_eq!(
            seeded.load(&key).unwrap(),
            None,
            "the plaintext copy must still be deleted after the keychain delete failed"
        );
    }

    #[test]
    fn clear_reports_a_stale_keychain_entry_even_when_this_session_used_another_tier() {
        // The hole the `active_tier` test was keyed on. Suppression used to be
        // `active_tier == Some(Keychain)`, which is FALSE whenever this session's token
        // came from the plaintext or memory tier - an ordinary outcome of a transient
        // keychain hiccup at login. But a keychain entry from an EARLIER session for the
        // same (endpoint, email) outlives that session, so logout swept it, the delete
        // failed, the failure was downgraded to `debug!`, and logout returned Ok with a
        // live bearer token still sitting in the OS keychain.
        //
        // The suppression is now a probe of the keychain itself, so this reports.
        let key = account_key(EP, EMAIL);
        let mut store = TokenStore::from_stores(
            Box::new(DeleteFailsStore::holding(&key, "stale-from-last-run")),
            None,
        );
        store.in_memory = Some("this-session".to_owned());
        store.active_tier = Some(TokenTier::Memory);

        assert!(
            store.clear(EP, EMAIL).is_err(),
            "a surviving keychain entry must be reported no matter which tier this \
             session ran on"
        );
    }

    #[test]
    fn clear_does_not_warn_about_a_keychain_that_never_held_the_token() {
        // A keychain-less box - headless Linux with no secret service, a SUPPORTED
        // configuration whose escape hatch is the plaintext tier - fails the keychain
        // delete at `Entry::new`, before it can even ask about the entry (a missing
        // entry is already Ok: `NoEntry` maps to success). So every ordinary logout
        // used to warn that a credential "may still be stored on this machine" about
        // a store that cannot hold one and was never written to. A warning that fires
        // on every logout is one the user learns to ignore.
        let dir = tempfile::tempdir().expect("tempdir");
        let key = account_key(EP, EMAIL);
        let seeded = PlaintextStore::new(dir.path().to_path_buf());
        seeded.store(&key, "pt").unwrap();

        let mut store = TokenStore::from_stores(
            Box::new(FailingSecretStore),
            Some(Box::new(PlaintextStore::new(dir.path().to_path_buf()))),
        );
        // The token came from the plaintext tier, not the keychain - and, crucially,
        // this keychain cannot be READ either, which is what the suppression now keys
        // on (see `clear`): an unreadable keychain is one that cannot be holding
        // anything. A readable keychain that merely refuses to delete DOES report -
        // `clear_reports_a_stale_keychain_entry_even_when_this_session_used_another_tier`.
        store.in_memory = Some("pt".to_owned());
        store.active_tier = Some(TokenTier::Plaintext);

        store
            .clear(EP, EMAIL)
            .expect("an unusable keychain that never held the token is not a warning");
        // The tier that DID hold it is still wiped, and the session is gone.
        assert_eq!(
            seeded.load(&key).unwrap(),
            None,
            "the plaintext copy - the one that could resurrect the session - is deleted"
        );
        assert_eq!(store.load(EP, EMAIL), None);
    }

    #[test]
    fn load_misses_yield_none() {
        // Empty keychain + empty plaintext → None (callers → NotAuthenticated).
        let mut store = TokenStore::from_stores(
            Box::new(InMemoryStore::new()),
            Some(Box::new(InMemoryStore::new())),
        );
        assert_eq!(store.load(EP, EMAIL), None);
        assert!(!store.keychain_backed());
    }

    #[test]
    fn load_falls_back_to_plaintext_when_keychain_empty() {
        // No keychain entry but a plaintext copy → loads from plaintext tier.
        let key = account_key(EP, EMAIL);
        let plaintext = InMemoryStore::new();
        plaintext.store(&key, "pt-tok").unwrap();
        let mut store =
            TokenStore::from_stores(Box::new(InMemoryStore::new()), Some(Box::new(plaintext)));
        assert_eq!(store.load(EP, EMAIL), Some("pt-tok".to_owned()));
        assert!(!store.keychain_backed());
    }

    // ---- the keychain decline gate (items 11/12) ----

    /// A [`SecretStore`] that records whether it was touched AT ALL. The decline
    /// flag's real property is not "we chose another tier" but "we never went near
    /// the keychain" - on Linux the access itself is what raises the unlock prompt,
    /// so only a spy can tell the two apart.
    struct SpyStore {
        inner: InMemoryStore,
        touched: Arc<AtomicBool>,
    }

    impl SecretStore for SpyStore {
        fn kind(&self) -> &'static str {
            "spy"
        }
        fn store(&self, k: &str, v: &str) -> Result<(), SecretStoreError> {
            self.touched.store(true, Ordering::SeqCst);
            self.inner.store(k, v)
        }
        fn load(&self, k: &str) -> Result<Option<String>, SecretStoreError> {
            self.touched.store(true, Ordering::SeqCst);
            self.inner.load(k)
        }
        fn delete(&self, k: &str) -> Result<(), SecretStoreError> {
            self.touched.store(true, Ordering::SeqCst);
            self.inner.delete(k)
        }
    }

    /// A spy plus the flag to read it by, since [`SecretStore`] is moved into the
    /// store and cannot be inspected afterwards.
    fn spy_pair() -> (Box<dyn SecretStore>, Arc<AtomicBool>) {
        let touched = Arc::new(AtomicBool::new(false));
        (
            Box::new(SpyStore {
                inner: InMemoryStore::new(),
                touched: Arc::clone(&touched),
            }),
            touched,
        )
    }

    #[test]
    fn a_declined_keychain_is_never_touched_by_store_or_load() {
        // Item 12. The point is not that we pick a different tier - it is that we
        // do not go near the keychain at all, because on Linux the access itself
        // is what raises the desktop unlock prompt the user already dismissed.
        let (keychain, touched) = spy_pair();
        let mut store = TokenStore::from_stores(keychain, None);
        store.set_keychain_declined(true);

        assert_eq!(store.store(EP, EMAIL, "tok", false), TokenTier::Memory);
        assert!(
            !touched.load(Ordering::SeqCst),
            "store must not touch a declined keychain"
        );

        // A cold session (the startup rehydrate) is the path that used to nag.
        let (keychain2, touched2) = spy_pair();
        let mut cold = TokenStore::from_stores(keychain2, None);
        cold.set_keychain_declined(true);
        assert_eq!(cold.load(EP, EMAIL), None);
        assert!(
            !touched2.load(Ordering::SeqCst),
            "rehydration must not touch a declined keychain"
        );
    }

    #[test]
    fn declining_still_honours_the_plaintext_choice() {
        // Declining the keychain is not the same as declining persistence: the
        // user is offered plaintext at the same moment, and picking it must work.
        let temp = tempfile::TempDir::new().expect("temp");
        let plaintext = PlaintextStore::new(temp.path().to_path_buf());
        let (keychain, touched) = spy_pair();
        let mut store = TokenStore::from_stores(keychain, Some(Box::new(plaintext)));
        store.set_keychain_declined(true);

        assert_eq!(store.store(EP, EMAIL, "tok", true), TokenTier::Plaintext);
        assert!(!touched.load(Ordering::SeqCst), "still no keychain access");
    }

    #[test]
    fn keychain_state_reports_only_what_access_taught_us() {
        // Item 1: Settings shows where the key lives WITHOUT probing, so an
        // untouched store must say so rather than guess.
        let mut store = TokenStore::from_stores(Box::new(InMemoryStore::new()), None);
        assert_eq!(store.keychain_state(), KeychainState::NotAttempted);

        assert_eq!(store.store(EP, EMAIL, "tok", false), TokenTier::Keychain);
        assert_eq!(store.keychain_state(), KeychainState::Available);

        let mut failing = TokenStore::from_stores(Box::new(FailingSecretStore), None);
        assert_eq!(failing.keychain_state(), KeychainState::NotAttempted);
        assert_eq!(failing.store(EP, EMAIL, "tok", false), TokenTier::Memory);
        assert_eq!(failing.keychain_state(), KeychainState::Unavailable);
    }

    // ---- moving the key the session already holds (the login-time choice) ----

    #[test]
    fn restore_moves_the_held_token_without_touching_a_declined_keychain() {
        // The whole premise of asking "where should the key go?" right after a
        // keychain failure: the token is in memory, so honouring the answer must
        // not need a re-login - and must not go near the keychain, or the choice
        // re-raises the prompt it was offered to escape.
        let temp = tempfile::TempDir::new().expect("temp");
        let (keychain, touched) = spy_pair();
        let mut store = TokenStore::from_stores(
            keychain,
            Some(Box::new(PlaintextStore::new(temp.path().to_path_buf()))),
        );
        store.in_memory = Some("tok".to_owned());
        store.set_keychain_declined(true);

        assert_eq!(store.restore(EP, EMAIL, true), Some(TokenTier::Plaintext));
        assert!(!touched.load(Ordering::SeqCst), "no keychain access");
        let probe = PlaintextStore::new(temp.path().to_path_buf());
        assert_eq!(
            probe.load(&account_key(EP, EMAIL)).unwrap(),
            Some("tok".to_owned())
        );
    }

    #[test]
    fn a_session_only_choice_removes_an_existing_plaintext_copy() {
        // Picking "this session only" has to be true on disk. Landing on the memory
        // tier while a plaintext file from an earlier choice survives would leave the
        // key readable after the restart the user was told it would not survive - and
        // `load` would find it again on the next launch.
        let temp = tempfile::TempDir::new().expect("temp");
        let key = account_key(EP, EMAIL);
        let seeded = PlaintextStore::new(temp.path().to_path_buf());
        seeded.store(&key, "tok").unwrap();

        let (keychain, _touched) = spy_pair();
        let mut store = TokenStore::from_stores(
            keychain,
            Some(Box::new(PlaintextStore::new(temp.path().to_path_buf()))),
        );
        store.in_memory = Some("tok".to_owned());
        store.set_keychain_declined(true);

        assert_eq!(store.restore(EP, EMAIL, false), Some(TokenTier::Memory));
        assert_eq!(seeded.load(&key).unwrap(), None);
    }

    #[test]
    fn retrying_the_keychain_re_stores_the_same_token_there() {
        // The Settings "Try again" affordance: clearing the refusal and re-storing is
        // all it takes, because the token never left memory.
        let temp = tempfile::TempDir::new().expect("temp");
        let mut store = TokenStore::from_stores(
            Box::new(InMemoryStore::new()),
            Some(Box::new(PlaintextStore::new(temp.path().to_path_buf()))),
        );
        store.in_memory = Some("tok".to_owned());
        store.set_keychain_declined(true);
        assert_eq!(store.restore(EP, EMAIL, true), Some(TokenTier::Plaintext));

        store.set_keychain_declined(false);
        assert_eq!(store.restore(EP, EMAIL, true), Some(TokenTier::Keychain));
        assert!(store.keychain_backed());
        assert_eq!(store.keychain_state(), KeychainState::Available);
        // The keychain supersedes, so the plaintext copy it displaced is gone.
        let probe = PlaintextStore::new(temp.path().to_path_buf());
        assert_eq!(probe.load(&account_key(EP, EMAIL)).unwrap(), None);
    }

    #[test]
    fn a_session_only_choice_also_sweeps_the_keychain() {
        // The plaintext copy is not the only thing that can outlive the promise. A
        // working login on an earlier day writes the key to the KEYCHAIN, and
        // leaving that entry behind makes "you will be signed out when the app
        // closes" false the moment the next launch rehydrates through it - the
        // promise would rest entirely on a best-effort `keychain_declined` write.
        //
        // Reaching the keychain here is not the nag this flow exists to stop:
        // `restore` runs only from the two explicit credential verbs, never from a
        // background path.
        let mut store = TokenStore::from_stores(Box::new(InMemoryStore::new()), None);
        // Monday: the keychain works, so the key lands there durably.
        assert_eq!(store.store(EP, EMAIL, "tok", false), TokenTier::Keychain);

        // Tuesday: the keyring is locked at login, and the user answers the storage
        // question with "this session only".
        store.set_keychain_declined(true);
        assert_eq!(store.restore(EP, EMAIL, false), Some(TokenTier::Memory));

        // The next launch: nothing in memory, and the probe re-enabled, so `load`
        // can only answer from a persisted tier.
        store.in_memory = None;
        store.active_tier = None;
        store.set_keychain_declined(false);
        assert_eq!(
            store.load(EP, EMAIL),
            None,
            "Monday's keychain entry must not survive a session-only choice and sign the user back in"
        );
    }

    #[test]
    fn a_declined_keychain_is_not_probed_when_the_session_is_cleared() {
        // `forget` routes BOTH the user's logout and the background 401 auto-drop
        // through `clear`, so probing here raised the desktop unlock prompt on a
        // locked keyring from an auth failure the user never initiated - the one
        // path that can fire the nag without them asking for anything.
        let (keychain, touched) = spy_pair();
        let mut store = TokenStore::from_stores(keychain, None);
        store.in_memory = Some("tok".to_owned());
        store.set_keychain_declined(true);

        assert!(store.clear(EP, EMAIL).is_ok());
        assert!(
            !touched.load(Ordering::SeqCst),
            "a declined keychain must not be probed or deleted on a session drop"
        );
        assert_eq!(
            store.active_tier(),
            None,
            "the token still leaves the session"
        );
    }

    #[test]
    fn restore_reports_that_there_is_no_token_to_move() {
        // A logged-out store must not answer "moved it" - the caller turns this into
        // "not signed in" rather than a silent success.
        let mut store = TokenStore::from_stores(Box::new(InMemoryStore::new()), None);
        assert_eq!(store.restore(EP, EMAIL, false), None);
    }

    #[test]
    fn declining_is_reported_as_declined_not_as_unavailable() {
        // The two are different things to tell a user: "your keychain is broken"
        // versus "you chose otherwise, and here is how to change your mind".
        let mut store = TokenStore::from_stores(Box::new(FailingSecretStore), None);
        assert_eq!(store.store(EP, EMAIL, "tok", false), TokenTier::Memory);
        assert_eq!(store.keychain_state(), KeychainState::Unavailable);

        store.set_keychain_declined(true);
        assert_eq!(store.keychain_state(), KeychainState::Declined);

        // Re-enabling (a fresh login) must not keep reporting a stale verdict from
        // before the user fixed their keyring.
        store.set_keychain_declined(false);
        assert_eq!(store.keychain_state(), KeychainState::NotAttempted);
    }
}
