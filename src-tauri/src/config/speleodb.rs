//! SpeleoDB connection configuration ([`SpeleoDbConfig`] and its
//! [`TokenFallback`] tier), split out of `types.rs` for the file-size ratchet
//! (#157). The runtime consumer is `crate::speleodb`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::speleodb::auth::account_key;

/// Opt-in fallback tier for the SpeleoDB token when no OS keychain is available.
///
/// [Track C] (#188, D-188): the user-facing surface is **two-valued**
/// (`SessionOnly` default, `Plaintext`); `Unknown` is the serde `#[serde(other)]`
/// sentinel (same idiom as `ThemeMode::Unknown`), normalized back to
/// `SessionOnly` so an unrecognized TOML value never blocks loading. `Plaintext`
/// is the headless-Linux escape hatch; the warned confirmation that *sets* it is
/// #205 Settings - Track C only honors the persisted preference.
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
/// The auth token is **never** stored here - it lives in the OS keychain (or a
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
    /// write. The warned confirmation that flips it is raised at LOGIN, at the
    /// moment the keychain actually fails, rather than buried in Settings.
    #[serde(default)]
    pub token_fallback: TokenFallback,
    /// The user declined the OS keychain when it failed at login, and chose where
    /// the API key should live instead (see `token_fallback`).
    ///
    /// While this is set the app must not touch the keychain AT ALL - not to
    /// store, not to read on startup, not to probe for a status line. On Linux a
    /// locked keyring turns every one of those into a desktop unlock prompt, so a
    /// user who dismissed it once was being asked again on every single launch.
    /// The refusal is persisted rather than session-scoped precisely so a restart
    /// does not re-ask. It is cleared only by an access that PROVED the keychain
    /// took the key - a fresh sign-in or the Settings "Try again", each gated on
    /// the token actually landing on the keychain tier. Clearing it on an attempt
    /// that fell back to another tier revoked an answer nothing had disproved, and
    /// the next launch re-raised the prompt (#259).
    #[serde(default)]
    pub keychain_declined: bool,
    /// The user turned the OS keychain OFF for good, from Settings.
    ///
    /// Stronger than `keychain_declined`, which answers one login's failure and is
    /// lifted the next time the keychain proves itself. This is a standing
    /// instruction: nothing is STORED to or READ from the keyring on any path,
    /// including a fresh login, and the API key lives wherever `token_fallback`
    /// says. It exists because a headless or locked-keyring box has no working
    /// keychain to offer, and being asked about it on every sign-in is the same nag
    /// in a different costume.
    ///
    /// DELETES are the deliberate exception, and the only thing keeping the switch
    /// honest. Turning it on evicts whatever an earlier successful login left in
    /// the keyring, and logout still sweeps it - nothing else ever would, because
    /// the instruction is re-applied on every subsequent login (so a store never
    /// overwrites the entry) and "Try again" clears only the other flag. Skipping
    /// those left a working bearer token in the OS keychain of a user who had just
    /// turned the OS keychain off, with logout reporting a clean sign-out over it.
    #[serde(default)]
    pub keychain_disabled: bool,
    /// Whether we believe the OS keychain currently holds a token for the account
    /// named by `keychain_token_account`.
    ///
    /// Recorded when a store succeeds and cleared when the entry is deleted (or a
    /// store lands on another tier), so startup can decide whether the keychain is
    /// worth opening WITHOUT opening it. That question used to be answered by
    /// reading the keyring, which on Linux is itself the desktop unlock prompt -
    /// so every launch of a signed-out app raised one to discover there was
    /// nothing to find. A stale `true` costs one prompt and self-corrects on the
    /// miss; a stale `false` means a rehydratable session is not restored until
    /// the user signs in again, which is the safe direction.
    ///
    /// NEVER read on its own - ask [`Self::keychain_belief_applies_to`], which
    /// pairs it with the stamp below. A belief with nobody's name on it is the
    /// pre-upgrade shape, not a claim about whoever happens to be signing in.
    #[serde(default)]
    pub keychain_has_token: bool,
    /// WHOSE entry [`Self::keychain_has_token`] is about: the
    /// `account_key(endpoint, email)` the credential itself is keyed by.
    ///
    /// One field holding the composed key rather than an endpoint and an email
    /// side by side, and built by the SAME function the keyring entry is named
    /// with, so the stamp and the credential key cannot disagree - not about
    /// trailing slashes, not about a `:443`, not about case. Comparing a
    /// re-composed pair would put a second copy of that normalization here to
    /// drift from.
    ///
    /// The email alone is not enough, which is what this exists to fix. A keyring
    /// entry is keyed by endpoint AND email, so the same person signing in to a
    /// second server (a dev box, a migrated host) has a different entry there and
    /// usually none at all; inheriting the first server's `true` opened the keyring
    /// for an account it holds nothing for, and - if the keyring was locked, so
    /// neither the clear nor the store could correct it - re-asserted and persisted
    /// that `true` under the new server, after which turning the keyring off warned
    /// about a residue no operation under the new endpoint can find or remove.
    ///
    /// `None` means one of two things, and they are told apart by
    /// `keychain_has_token`. With it `false`, there is simply no belief - the pair
    /// every writer since the stamp landed writes together. With it `true`, this is
    /// a config written BEFORE the stamp existed: see
    /// [`Self::keychain_belief_applies_to`] for how that one is read, and why it is
    /// not read as "nobody's".
    #[serde(default)]
    pub keychain_token_account: Option<String>,
    /// [Track C] (#187/D-B10/D-B19): allow an `http://` endpoint to a PUBLIC host.
    /// Off by default. Relaxes ONLY the public-http scheme block in
    /// `speleodb::tls::enforce` (Track A #187) - NEVER TLS cert verification
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

/// What a settings save has to tell the user beyond "it was written".
///
/// Saving settings is normally a yes/no, which is why the one thing it can half-do
/// went unreported: turning [`SpeleoDbConfig::keychain_disabled`] on MOVES the API
/// key off the keyring, and either half of that move can fail over settings that
/// were nevertheless written. The save still succeeds - deliberately, see
/// `AppState::update_config` - so an `Err` would be a lie in the other direction,
/// and the frontend needs a third answer to render.
///
/// Both fields answer the same user-facing question ("could a copy of my key still
/// be on this machine?") and both stay `None` unless it may genuinely be yes. They
/// are kept apart because only one of them knows WHICH store stranded it, and the
/// wording that sends a user to their keyring is wrong about a `0o600` file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ConfigSaveReport {
    /// Set when the OS keyring was turned off but the API key it already held
    /// could not be removed, carrying the reason for the parenthetical in the
    /// warning. `None` covers both "there was nothing to remove" and "it is gone",
    /// because a warning that fires on the ordinary path is one the user learns to
    /// ignore - which costs them the case where it is real.
    #[serde(default)]
    pub keychain_residue: Option<String>,
    /// Set when the same save re-landed the key on the SESSION-ONLY tier but a
    /// persistent copy of it survived the sweep that was supposed to make that
    /// landing true - a plaintext file left by an earlier storage choice, or a
    /// keyring that stopped answering between the eviction and the sweep. The
    /// consequence is the one `keychain_residue` describes (the next launch reads
    /// the survivor back and signs the user in), and the same `None` discipline
    /// applies: a tier proven empty, or one that never held anything, says nothing.
    ///
    /// Separate from `keychain_residue` because WHICH tier stranded it is not
    /// knowable here - `TokenStore::sweep_persistent_tiers` collapses both into one
    /// error - so the copy this drives must stay tier-neutral. It is left `None`
    /// when `keychain_residue` is already set, which is the case where the two would
    /// be the same failure said twice.
    #[serde(default)]
    pub persistent_residue: Option<String>,
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
            keychain_declined: false,
            keychain_disabled: false,
            keychain_has_token: false,
            keychain_token_account: None,
            insecure_http: false,
            allow_force_edit: false,
            poll_interval_seconds: default_poll_interval_seconds(),
        }
    }
}

impl SpeleoDbConfig {
    /// Whether the recorded keyring belief is a fact about THIS account - the one
    /// question anybody should ask [`Self::keychain_has_token`].
    ///
    /// `endpoint` and `email` must be the pair the credential would be keyed by,
    /// exactly as they reach `TokenStore` (trimmed; the endpoint resolved through
    /// login's precedence, so a `DEV_SPELEODB_URL` run asks about the dev box's
    /// entry and not the production one).
    ///
    /// An UNSTAMPED `true` - a config written before the stamp existed - is read
    /// as a belief about the persisted `email`, which is the strongest scoping
    /// that config could express: the flag and the email were written by the same
    /// login. It could instead be read as nobody's and dropped, and that is the
    /// tempting answer because it is the strict one; it is also the dangerous one.
    /// The two ways of being wrong are not symmetric. A belief wrongly KEPT costs
    /// one unlock prompt, and the read it buys is the very thing that disproves it
    /// (`TokenStore::load`'s `Ok(None)`, written back by
    /// `speleodb_ensure_rehydrated`), so it self-corrects on the next launch. A
    /// belief wrongly DROPPED strands a real token: startup stops opening the
    /// keyring, so the user is signed out with a working credential sitting in it,
    /// `TokenStore::clear` stops sweeping it, and turning the keyring off reports
    /// "nothing was in there" over it. Every upgraded user with a keychain login
    /// would take that on their first launch, to spare the rare same-email-new-
    /// server switch one prompt. So the unstamped belief is kept, and it is
    /// self-limiting: the first write from any belief writer stamps it.
    pub(crate) fn keychain_belief_applies_to(&self, endpoint: &str, email: &str) -> bool {
        if !self.keychain_has_token {
            return false;
        }
        match self.keychain_token_account.as_deref() {
            Some(stamp) => stamp == account_key(endpoint, email),
            None => self.email.as_deref().map(str::trim) == Some(email),
        }
    }

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
