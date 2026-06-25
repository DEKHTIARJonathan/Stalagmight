//! Backend-only credential storage for the SpeleoDB auth token.
//!
//! The token is written to the OS keychain (keyring-rs v3), keyed by the
//! normalized endpoint + email, and **never** crosses into the webview / IPC
//! payloads. When no OS secret service is available (e.g. headless CI, a Linux
//! box without gnome-keyring/KWallet), the keychain calls fail and the token
//! falls back to an in-memory, session-only slot.
//!
//! Deferred to #188 (the dedicated auth issue): the opt-in plaintext escape
//! hatch, the `token_fallback` preference, the full endpoint-normalization
//! edge cases, and the 401 auto-drop policy. This is the spike's minimum that
//! still satisfies "token never in IPC".

const KEYRING_SERVICE: &str = "stalagmight";

/// Build the keychain account key from the endpoint and email. The endpoint is
/// lightly normalized (trimmed, trailing slash stripped, lowercased) so the same
/// server entered two ways resolves to one entry. (#188 owns full normalization.)
pub(crate) fn account_key(endpoint: &str, email: &str) -> String {
    let normalized = endpoint.trim().trim_end_matches('/').to_ascii_lowercase();
    format!("{normalized}|{email}")
}

fn entry(endpoint: &str, email: &str) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(KEYRING_SERVICE, &account_key(endpoint, email))
}

fn keychain_store(endpoint: &str, email: &str, token: &str) -> Result<(), keyring::Error> {
    entry(endpoint, email)?.set_password(token)
}

fn keychain_load(endpoint: &str, email: &str) -> Result<Option<String>, keyring::Error> {
    match entry(endpoint, email)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

fn keychain_delete(endpoint: &str, email: &str) -> Result<(), keyring::Error> {
    match entry(endpoint, email)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Holds the SpeleoDB token backend-side: OS keychain when available, otherwise
/// an in-memory session-only fallback. The active token is never returned to the
/// webview; only [`Self::keychain_backed`] is surfaced (so the UI can warn that a
/// fallback token won't survive a restart).
#[derive(Debug, Default)]
pub(crate) struct TokenStore {
    /// The live token for this session: cached here after [`Self::store`] (so
    /// authed calls don't re-hit the keychain on every request) and the sole
    /// store when the OS keychain is unavailable.
    in_memory: Option<String>,
    /// Whether the active token is also persisted in the OS keychain (vs only
    /// `in_memory`). Surfaced to the UI so it can warn when a token won't survive
    /// a restart.
    keychain_backed: bool,
}

impl TokenStore {
    /// Store `token` for `(endpoint, email)`. Tries the keychain first; on any
    /// keychain error, falls back to in-memory. Returns `true` iff the keychain
    /// was used.
    pub(crate) fn store(&mut self, endpoint: &str, email: &str, token: &str) -> bool {
        match keychain_store(endpoint, email, token) {
            Ok(()) => {
                // Cache in memory too so authed calls this session serve from
                // memory instead of a fresh keychain (Secret-Service/D-Bus) read
                // each time; the keychain copy is what survives a restart.
                self.in_memory = Some(token.to_owned());
                self.keychain_backed = true;
                true
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "OS keychain unavailable; holding SpeleoDB token in memory for this session only"
                );
                self.in_memory = Some(token.to_owned());
                self.keychain_backed = false;
                false
            }
        }
    }

    /// Whether the active token is backed by the OS keychain (vs the in-memory
    /// session-only fallback). Lets the UI keep warning about a non-persistent
    /// token after a dialog reopen.
    pub(crate) fn keychain_backed(&self) -> bool {
        self.keychain_backed
    }

    /// Load the active token, if any. Serves the in-memory copy first (cached at
    /// [`Self::store`] time), falling back to the keychain only on a cold restore
    /// where a keychain-backed token has not been read into memory yet. A keychain
    /// read error yields `None` (treated by callers as "not authenticated" →
    /// re-login).
    pub(crate) fn load(&self, endpoint: &str, email: &str) -> Option<String> {
        if let Some(token) = &self.in_memory {
            return Some(token.clone());
        }
        if self.keychain_backed {
            return keychain_load(endpoint, email).ok().flatten();
        }
        None
    }

    /// Forget the token locally. The keychain delete is best-effort.
    pub(crate) fn clear(&mut self, endpoint: &str, email: &str) {
        if self.keychain_backed {
            if let Err(e) = keychain_delete(endpoint, email) {
                tracing::warn!(error = %e, "failed to delete SpeleoDB token from keychain");
            }
        }
        self.in_memory = None;
        self.keychain_backed = false;
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
            keychain_backed: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{account_key, TokenStore};

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
    fn in_memory_fallback_round_trips_without_keychain() {
        // The in-memory constructor never touches the real OS keychain.
        let store = TokenStore::from_in_memory_token("tok-123");
        assert_eq!(
            store.load("http://10.10.0.220:8000/", "u@x"),
            Some("tok-123".to_owned())
        );
    }

    #[test]
    fn clear_forgets_in_memory_token() {
        let mut store = TokenStore::from_in_memory_token("tok-123");
        store.clear("http://10.10.0.220:8000/", "u@x");
        assert_eq!(store.load("http://10.10.0.220:8000/", "u@x"), None);
    }
}
