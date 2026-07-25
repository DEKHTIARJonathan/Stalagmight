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
        }
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

        match self.keychain.store(&key, token) {
            Ok(()) => {
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
                tracing::warn!(
                    error = %e,
                    "OS keychain unavailable; falling back to a non-keychain SpeleoDB token tier for this session"
                );
                // Two-gate plaintext opt-in (C6): gate 1 = the persisted
                // preference (`allow_plaintext`); gate 2 = this keychain failure
                // (intrinsic - we only reach here in the keychain-Err branch).
                match (allow_plaintext, &self.plaintext) {
                    (true, Some(plaintext)) => match plaintext.store(&key, token) {
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
        }
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

        // Keychain-first (precedence): a hit supersedes and self-heals plaintext.
        match self.keychain.load(&key) {
            Ok(Some(token)) => {
                if let Some(plaintext) = &self.plaintext {
                    if let Err(e) = plaintext.delete(&key) {
                        tracing::warn!(error = %e, "failed to delete stale plaintext SpeleoDB token");
                    }
                }
                self.in_memory = Some(token.clone());
                self.active_tier = Some(TokenTier::Keychain);
                return Some(token);
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(error = %e, "keychain read failed during SpeleoDB rehydration");
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
        if let Err(e) = self.keychain.delete(&key) {
            tracing::warn!(error = %e, "failed to delete SpeleoDB token from keychain");
            failure = Some(e);
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
        }
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
        account_key, normalize_endpoint, InMemoryStore, PlaintextStore, SecretStore,
        SecretStoreError, TokenStore, TokenTier,
    };

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
        let mut store = TokenStore::from_stores(Box::new(FailingSecretStore), None);
        store.in_memory = Some("tok".to_owned());
        store.active_tier = Some(TokenTier::Keychain);

        assert!(
            store.clear(EP, EMAIL).is_err(),
            "a failing keychain delete must be reported, not swallowed"
        );
        assert_eq!(
            store.load(EP, EMAIL),
            None,
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
            Box::new(FailingSecretStore),
            Some(Box::new(PlaintextStore::new(dir.path().to_path_buf()))),
        );
        assert!(store.clear(EP, EMAIL).is_err());
        assert_eq!(
            seeded.load(&key).unwrap(),
            None,
            "the plaintext copy must still be deleted after the keychain delete failed"
        );
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
}
