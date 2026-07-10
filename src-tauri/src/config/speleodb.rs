//! SpeleoDB connection configuration ([`SpeleoDbConfig`] and its
//! [`TokenFallback`] tier), split out of `types.rs` for the file-size ratchet
//! (#157). The runtime consumer is `crate::speleodb`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Opt-in fallback tier for the SpeleoDB token when no OS keychain is available.
///
/// [Track C] (#188, D-188): the user-facing surface is **two-valued**
/// (`SessionOnly` default, `Plaintext`); `Unknown` is the serde `#[serde(other)]`
/// sentinel (same idiom as `ThemeMode::Unknown`), normalized back to
/// `SessionOnly` so an unrecognized TOML value never blocks loading. `Plaintext`
/// is the headless-Linux escape hatch; the warned confirmation that *sets* it is
/// #205 Settings — Track C only honors the persisted preference.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum TokenFallback {
    /// Token lives in memory only (lost on restart) when the keychain is absent.
    #[default]
    SessionOnly,
    /// Opt-in: write the token to a `0o600` plaintext file when the keychain
    /// fails this session (the two-gate plaintext write).
    Plaintext,
    /// Catch-all for unrecognized values; normalized to `SessionOnly`.
    #[serde(other, rename = "unknown")]
    Unknown,
}

/// SpeleoDB connection settings (#183 read-only spike).
///
/// The auth token is **never** stored here — it lives in the OS keychain (or a
/// plaintext escape hatch / in-memory session fallback); see
/// `crate::speleodb::auth`. At runtime the `DEV_SPELEODB_URL` env var overrides
/// `endpoint`. The full Settings-tab UI binding is #205.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SpeleoDbConfig {
    /// Persisted endpoint base URL (e.g. `https://www.speleodb.org`). Overridden
    /// at runtime by `DEV_SPELEODB_URL` when set.
    #[serde(default)]
    pub endpoint: Option<String>,
    /// Last-used account email, for prefilling the login dialog.
    #[serde(default)]
    pub email: Option<String>,
    /// [Track C] (#188, D-188): opt-in plaintext token fallback preference.
    /// Default `SessionOnly`; only `Plaintext` enables the two-gate plaintext
    /// write. #205 Settings owns the warned confirmation that flips it.
    #[serde(default)]
    pub token_fallback: TokenFallback,
    /// [Track C] (#187/D-B10/D-B19): allow an `http://` endpoint to a PUBLIC host.
    /// Off by default. Relaxes ONLY the public-http scheme block in
    /// `speleodb::tls::enforce` (Track A #187) — NEVER TLS cert verification
    /// (self-signed / internal CAs stay rejected). Pre-wired for #205 Settings;
    /// D-B19's scheme reject lives in `tls.rs`, not here.
    #[serde(default)]
    pub insecure_http: bool,
    /// [#213] Opt-in: allow "force-edit" - editing a remote project WITHOUT holding
    /// the server write lock (surveying offline / when someone else holds it), behind
    /// a big-red unmergeable-`.stalx` warning. Off by default; #205 Settings owns the
    /// warned toggle. When off, a remote project stays strictly read-only until the
    /// lock is acquired (the only escape being "Save a local copy" / detach).
    #[serde(default)]
    pub allow_force_edit: bool,
    /// How often (seconds) the action shell re-checks the linked project's remote
    /// state (lock holder / remote-ahead / conflict) for its status icon. Default
    /// 60; **clamped up to `MIN_POLL_INTERVAL_SECONDS` on load** so a hand-edited
    /// config below the floor can't spam the server.
    #[serde(default = "default_poll_interval_seconds")]
    pub poll_interval_seconds: u32,
}

/// Floor for [`SpeleoDbConfig::poll_interval_seconds`]. Enforced both in the
/// Settings UI and here on load (a hand-edited sub-floor value is corrected up).
pub const MIN_POLL_INTERVAL_SECONDS: u32 = 30;

fn default_poll_interval_seconds() -> u32 {
    60
}

impl Default for SpeleoDbConfig {
    fn default() -> Self {
        Self {
            endpoint: None,
            email: None,
            token_fallback: TokenFallback::default(),
            insecure_http: false,
            allow_force_edit: false,
            poll_interval_seconds: default_poll_interval_seconds(),
        }
    }
}

impl SpeleoDbConfig {
    /// [Track C] (#188): coerce the `#[serde(other)]` sentinel back to the safe
    /// default, and clamp the poll interval up to the floor. Mirrors
    /// `AppearanceConfig::normalize`; wired into `Config::normalize`.
    pub fn normalize(&mut self) {
        if self.token_fallback == TokenFallback::Unknown {
            tracing::warn!(
                "Unknown token_fallback value in config, normalizing to \"session_only\""
            );
            self.token_fallback = TokenFallback::SessionOnly;
        }
        if self.poll_interval_seconds < MIN_POLL_INTERVAL_SECONDS {
            tracing::warn!(
                requested = self.poll_interval_seconds,
                floor = MIN_POLL_INTERVAL_SECONDS,
                "SpeleoDB poll_interval_seconds below floor; clamping up"
            );
            self.poll_interval_seconds = MIN_POLL_INTERVAL_SECONDS;
        }
    }
}
