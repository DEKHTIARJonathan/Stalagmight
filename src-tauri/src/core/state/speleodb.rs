//! Orchestration tying the `crate::speleodb` primitives (HTTP client, token
//! store, dump handling) to `AppState`, config, and the app cache directory.
//!
//! The `commands::speleodb` IPC layer is a thin wrapper over these methods.
//! Everything here is read-only against the server (login / list / pull); no
//! lock, push, or persistence — those are later issues (#182 epic).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::AppState;
use crate::speleodb::auth::TokenStore;
use crate::speleodb::client;
// [Track A] #186/D-B2: typed Endpoint + map_status + SpeleoDbError→SpeleoErrorDto
// conversion. [Integration] map_status/SpeleoDbAction also drive Track C's C5
// 401 auto-drop (auth_error_drops_token).
use crate::speleodb::contract::{dto_for_error, map_status, Endpoint};
use crate::speleodb::dump::{self, DumpClassification};
use crate::speleodb::models::SpeleoProjectSummary;
use crate::speleodb::sync::{self, PushPlan, ReconcileVerdict};
use crate::speleodb::SpeleoDbAction;
use crate::speleodb::{
    DoneResult, SpeleoDbError, SpeleoErrorDto, SpeleoLoginResult, SpeleoOpenResult,
    SpeleoSessionStatus, StartEditingResult, UpdateResult,
};

/// Per-session SpeleoDB connection state held in [`AppState`]. The token lives
/// inside [`TokenStore`] (keychain / plaintext / in-memory tiers) and is never
/// exposed to the webview.
#[derive(Debug, Default)]
pub(crate) struct SpeleoDbSession {
    endpoint: Option<String>,
    email: Option<String>,
    token_store: TokenStore,
    /// [Track C] (#188, C4): set once per process after the lazy silent startup
    /// rehydration runs (whether it found a token or not), so an empty/failed
    /// `load()` doesn't re-hit the keychain on every authed call.
    rehydrate_attempted: bool,
}

/// Pure endpoint-precedence resolver (extracted so it is unit-testable without
/// process env or an `AppState`): the first tier that is present and non-blank,
/// in order override → env → config, trimmed. Returns `None` if all are blank.
fn resolve_endpoint(
    override_endpoint: Option<&str>,
    env_endpoint: Option<&str>,
    config_endpoint: Option<&str>,
) -> Option<String> {
    [override_endpoint, env_endpoint, config_endpoint]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|e| !e.is_empty())
        .map(str::to_owned)
}

/// Reject any `project_id` that is not a plain SpeleoDB project UUID before it is
/// used as a filesystem path component or interpolated into a request URL. The
/// server keys projects by UUID, so anything else is invalid; refusing it closes
/// the path-traversal / route-manipulation vector at the IPC trust boundary (a
/// `..`, an absolute path, or an embedded separator could otherwise redirect the
/// cached `.stalx` write or the download URL). A parsed UUID has no separators,
/// `..`, or absolute prefix, so it is always a safe single path component.
fn validate_project_id(project_id: &str) -> Result<(), SpeleoDbError> {
    uuid::Uuid::parse_str(project_id)
        .map(|_| ())
        .map_err(|_| SpeleoDbError::InvalidProjectId)
}

/// [Track A] #186/D-B2: map a non-endpoint (local / session) `SpeleoDbError` to
/// the IPC `SpeleoErrorDto`. Local errors always fail closed to `Fatal`
/// regardless of endpoint, so the endpoint passed to [`dto_for_error`] is
/// irrelevant for them (`User` is an arbitrary, non-load-bearing choice).
fn local_dto(err: SpeleoDbError) -> SpeleoErrorDto {
    dto_for_error(Endpoint::User, &err)
}

/// Map a downloaded dump's entry list to the single openable `.stalx` path, or
/// the appropriate error. Extracted from [`AppState::speleodb_open_project`] so
/// the classification→error mapping is unit-testable without the network.
fn classify_dump_entry(names: &[String]) -> Result<String, SpeleoDbError> {
    match dump::classify(names) {
        DumpClassification::Stalx(path) => Ok(path),
        DumpClassification::AdoptAriane => Err(SpeleoDbError::AdoptAriane),
        DumpClassification::NothingToOpen => Err(SpeleoDbError::EmptyDump),
        DumpClassification::AmbiguousStalx(paths) => Err(SpeleoDbError::AmbiguousDump(paths)),
    }
}

/// [Track C] (#188, C5): the pure 401 auto-drop predicate. A genuine 401 on an
/// established-session call drops the token; **everything else is kept** — 403 is
/// never a drop (D-B4, robust to a DRF 401→403 downgrade), and 2xx/5xx/transport/
/// local errors pass through. Extracted so the drop decision is unit-testable
/// without a full `AppState`.
///
/// [Integration] The drop decision now consumes Track A's #186 contract: the
/// token is dropped **iff** `map_status(endpoint, status) == SpeleoDbAction::ReLogin`
/// (the single authoritative status→action mapping). 401 on an authenticated
/// endpoint maps to `ReLogin`; 403/2xx/5xx/unmapped never do, so this is
/// behaviorally identical to the prior bare-401 guard while removing the
/// duplicate status logic.
fn auth_error_drops_token<T>(endpoint: Endpoint, result: &Result<T, SpeleoDbError>) -> bool {
    matches!(
        result,
        Err(SpeleoDbError::Status { status, .. })
            if map_status(endpoint, *status) == SpeleoDbAction::ReLogin
    )
}

/// Decide, from a whoami (`GET /user/`) probe result, whether the session token
/// is dead. The live box returns 200 for any valid token and 403 for a dead one
/// (the DRF 401→403 downgrade), so a probe whose status maps to
/// [`SpeleoDbAction::ReLogin`] (a 403 or 401 on the `User` endpoint) means the
/// token is dead. A success means it is alive — so a resource 403 was a genuine
/// permission denial, keep the token (D-B4). A transport error is inconclusive
/// and is treated as not-dead (never drop on a flaky probe). Pure + unit-tested;
/// the network call lives in [`AppState::speleodb_token_is_dead`].
fn whoami_indicates_dead_token(probe: &Result<String, SpeleoDbError>) -> bool {
    matches!(
        probe,
        Err(SpeleoDbError::Status { status, .. })
            if map_status(Endpoint::User, *status) == SpeleoDbAction::ReLogin
    )
}

impl SpeleoDbSession {
    /// Resolve the active `(endpoint, token)` for this session, or
    /// [`SpeleoDbError::NotAuthenticated`] if endpoint, email, or token is
    /// missing. Extracted from [`AppState::speleodb_active_token`] so the branch
    /// logic is testable without a full `AppState`.
    ///
    /// `&mut self` because [`TokenStore::load`] caches its result + updates the
    /// active tier ([Track C] #188: keychain-first read populates the cache).
    fn active_token(&mut self) -> Result<(String, String), SpeleoDbError> {
        let endpoint = self
            .endpoint
            .clone()
            .ok_or(SpeleoDbError::NotAuthenticated)?;
        let email = self.email.clone().ok_or(SpeleoDbError::NotAuthenticated)?;
        let token = self
            .token_store
            .load(&endpoint, &email)
            .ok_or(SpeleoDbError::NotAuthenticated)?;
        Ok((endpoint, token))
    }

    /// Current session status for the dialog. `logged_in` means a usable token is
    /// held *locally* — it is not re-validated against the server here (a token
    /// revoked server-side is caught on the next real call by the 401 auto-drop
    /// handler, [Track C] #188 C5). When not logged in, neither the email nor the
    /// keychain flag is surfaced, so the status can never claim a keychain-backed
    /// token while reporting logged-out.
    ///
    /// `&mut self` because resolving the token may rehydrate + cache it.
    fn status(&mut self) -> SpeleoSessionStatus {
        let logged_in = self.active_token().is_ok();
        SpeleoSessionStatus {
            user_email: logged_in.then(|| self.email.clone()).flatten(),
            keychain_backed: logged_in && self.token_store.keychain_backed(),
            logged_in,
        }
    }

    /// Forget the local token (every tier: keychain + plaintext + in-memory) and
    /// clear the session. No server-side call — logout is purely local (the DRF
    /// token is not revoked). [Track C] (#188): also the 401-drop sink (C5).
    fn forget(&mut self) {
        if let (Some(endpoint), Some(email)) = (self.endpoint.clone(), self.email.clone()) {
            self.token_store.clear(&endpoint, &email);
        }
        self.endpoint = None;
        self.email = None;
    }

    /// [Track C] (#188, C4): lazy **silent** startup rehydration, run once on the
    /// first authed/session call. Seeds `endpoint`/`email` from config (resolved
    /// through the same precedence as login so `DEV_SPELEODB_URL` still wins) and
    /// wires `TokenStore::load` for the **first time** so a prior-run keychain (or
    /// plaintext) token survives an app restart. **No network, no prompt.**
    ///
    /// Idempotent: marks `rehydrate_attempted` so a failed/empty load doesn't
    /// re-hit the keychain every call, and short-circuits if a session is already
    /// established this run.
    fn rehydrate(&mut self, resolved_endpoint: Option<String>, config_email: Option<String>) {
        if self.rehydrate_attempted || self.endpoint.is_some() {
            return;
        }
        self.rehydrate_attempted = true;

        let (Some(endpoint), Some(email)) = (resolved_endpoint, config_email) else {
            // No persisted account → stay logged-out (no keychain probe).
            return;
        };
        let endpoint = endpoint.trim().to_owned();
        let email = email.trim().to_owned();
        if endpoint.is_empty() || email.is_empty() {
            return;
        }

        self.endpoint = Some(endpoint.clone());
        self.email = Some(email.clone());
        // First wiring of load(): keychain-first read (then plaintext). On a hit
        // the token is cached + the active tier set; on a miss the session stays
        // seeded-but-unauthenticated and the next call surfaces NotAuthenticated.
        let _ = self.token_store.load(&endpoint, &email);
    }
}

/// Internal verdict of the push half of `speleodb_done`.
#[derive(Debug)]
enum PushOutcome {
    /// The push landed (200 → BASE advanced; or 304 → already at the tip): the
    /// dirty bit was cleared. Safe to release the lock.
    Confirmed,
    /// A stranger commit sits between our BASE and the server tip — never pushed.
    /// Stay locked + dirty for the user to reconcile (#198).
    Diverged,
    /// The push outcome was ambiguous (transport drop / retried-then-exhausted
    /// 5xx): we don't know whether it landed. Stay locked + dirty; the next
    /// attempt recovers via ancestry (#193).
    Unconfirmed,
}

/// Sanitize a push SNAPSHOT copy before upload: clear the dirty bit and strip the
/// per-machine view toggles (`display_settings`) so they don't ride to the server
/// (#197). All durable project data — survey, config, import-dedup,
/// resolved-warnings — proliferates with the project. Best-effort — a failure only
/// means the pushed file keeps a stale dirty bit, which the next puller re-stamps.
/// See [`crate::persistence::Database::sanitize_push_snapshot`] for the exact set.
fn clear_snapshot_dirty(snapshot: &Path) {
    if let Err(e) = crate::persistence::Database::sanitize_push_snapshot(snapshot) {
        tracing::warn!(error = %e, "clear_snapshot_dirty: failed to sanitize push snapshot");
    }
}

/// Snapshot the local per-machine `display_settings` from an existing cache file
/// BEFORE a download-replace overwrites it. View toggles are stripped from the
/// server copy on push (#197), so without re-applying them a fast-forward / re-open
/// — which replaces the whole local `.stalx` with the server's — would reset the
/// user's view to defaults. Empty when the file is absent or unreadable (a first
/// open → defaults, which is correct). Pairs with [`restore_display_settings`].
fn preserved_display_settings(dest: &Path) -> HashMap<String, String> {
    if !dest.exists() {
        return HashMap::new();
    }
    crate::persistence::Database::open_existing(dest)
        .and_then(|db| db.load_display_settings())
        .unwrap_or_default()
}

/// Re-apply preserved local `display_settings` into a freshly-downloaded cache file
/// (companion to [`preserved_display_settings`]). Best-effort per key — a failed
/// restore only means that one view toggle falls back to its default.
fn restore_display_settings(
    db: &crate::persistence::Database,
    preserved: &HashMap<String, String>,
) {
    for (key, value) in preserved {
        if let Err(e) = db.save_display_setting(key, value) {
            tracing::warn!(error = %e, key = %key, "failed to restore local display setting after download-replace");
        }
    }
}

/// Resolve the server head, re-fetching ONCE when a recorded BASE meets an empty
/// tip (#192). `(base Some, tip None)` is the fence's fail-closed trigger — but a
/// momentary empty read (replication lag, or a race right after project creation)
/// must not be mistaken for "the history is gone," so re-fetch a single time
/// before letting the caller fail closed. `(base None, tip None)` is the valid
/// empty-repo state and never retries. Generic over the injected `fetch` so the
/// retry is unit-tested without HTTP.
fn head_with_empty_retry<F>(
    base: Option<&str>,
    mut fetch: F,
) -> Result<(Option<String>, Vec<crate::speleodb::models::RevisionCommit>), SpeleoDbError>
where
    F: FnMut() -> Result<
        (Option<String>, Vec<crate::speleodb::models::RevisionCommit>),
        SpeleoDbError,
    >,
{
    let first = fetch()?;
    if base.is_some() && first.0.is_none() {
        // Recorded BASE but no tip — re-fetch exactly once, then trust the result
        // (a still-empty second read lets the fence fail closed).
        return fetch();
    }
    Ok(first)
}

impl AppState {
    /// Resolve the effective endpoint. Precedence: explicit dialog override →
    /// `DEV_SPELEODB_URL` env (dev default) → persisted `config.speleodb.endpoint`.
    fn speleodb_resolve_endpoint(&self, override_endpoint: Option<&str>) -> Option<String> {
        let env = std::env::var("DEV_SPELEODB_URL").ok();
        let config_endpoint = self
            .config
            .lock()
            .ok()
            .and_then(|c| c.speleodb.endpoint.clone());
        resolve_endpoint(
            override_endpoint,
            env.as_deref(),
            config_endpoint.as_deref(),
        )
    }

    /// [Track A] #187/D-B10: read the persisted `insecure_http` override under the
    /// config lock. It is threaded into every client call → `with_retry` →
    /// `tls::enforce`, where it relaxes ONLY the public-`http://` scheme block.
    /// Defaults `false` (the secure default) when the config lock is unavailable.
    fn speleodb_insecure_http(&self) -> bool {
        self.config
            .lock()
            .ok()
            .is_some_and(|c| c.speleodb.insecure_http)
    }

    fn speleodb_session_lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, SpeleoDbSession>, SpeleoDbError> {
        self.speleodb
            .lock()
            .map_err(|_| SpeleoDbError::Io("SpeleoDB session lock poisoned".to_owned()))
    }

    /// [Track C] (#188, C4): lazy silent startup rehydration. Resolve the config
    /// endpoint (same precedence as login, sans a dialog override) + email
    /// **outside** the session lock to avoid a config↔session lock-order hazard,
    /// then let [`SpeleoDbSession::rehydrate`] seed + wire `load()` once. Called
    /// before locking in the authed/session entry points. No network, no prompt,
    /// no config write.
    fn speleodb_ensure_rehydrated(&self) {
        // Cheap idempotency check first: if rehydration already ran (or a session
        // is live), skip the config read entirely.
        if let Ok(session) = self.speleodb_session_lock() {
            if session.rehydrate_attempted || session.endpoint.is_some() {
                return;
            }
        } else {
            return;
        }

        let resolved_endpoint = self.speleodb_resolve_endpoint(None);
        let config_email = self
            .config
            .lock()
            .ok()
            .and_then(|c| c.speleodb.email.clone());

        if let Ok(mut session) = self.speleodb_session_lock() {
            session.rehydrate(resolved_endpoint, config_email);
        }
    }

    /// Resolve the active `(endpoint, token)` for an authenticated call, or
    /// [`SpeleoDbError::NotAuthenticated`] if there is no usable token.
    fn speleodb_active_token(&self) -> Result<(String, String), SpeleoDbError> {
        self.speleodb_ensure_rehydrated();
        self.speleodb_session_lock()?.active_token()
    }

    /// Report whether a usable token is held (and for whom), so the dialog can
    /// restore the project list on reopen instead of forcing a re-login. The
    /// token itself never leaves the backend.
    pub(crate) fn speleodb_session_status(&self) -> Result<SpeleoSessionStatus, SpeleoErrorDto> {
        // [Track C] (#188): rehydrate first so a restart with a stored keychain
        // token reports logged_in:true without a re-login (the headline fix).
        self.speleodb_ensure_rehydrated();
        // No network call — only the (local) session-lock error can surface here.
        Ok(self.speleodb_session_lock().map_err(local_dto)?.status())
    }

    /// [Track C] (#188, C5): centralized session-level 401 auto-drop handler.
    /// Every **established-session** authed call (list/open) routes its `Result`
    /// through this; a **genuine 401** fully clears the token (keychain +
    /// plaintext + memory) via `forget()`. A 403 is **never** a drop (D-B4:
    /// per-endpoint read-only / fence semantics, robust to a DRF 401→403
    /// downgrade); 2xx/5xx pass through untouched.
    ///
    /// The login path is deliberately NOT routed here: login's 401 is a
    /// pasted-dead-token, not the drop of an *established* session.
    fn speleodb_handle_auth<T>(
        &self,
        endpoint: Endpoint,
        result: Result<T, SpeleoDbError>,
    ) -> Result<T, SpeleoDbError> {
        // Unambiguous dead token (a 401, or a 403 on the whoami `User` endpoint)
        // drops immediately. An ambiguous resource/write 403 (a real read-only /
        // fence grant vs a dead token) is disambiguated with a whoami probe.
        if auth_error_drops_token(endpoint, &result)
            || self.speleodb_ambiguous_403_is_dead_token(endpoint, &result)
        {
            self.speleodb_forget();
        }
        result
    }

    /// Full local token clear (keychain + plaintext + memory) + session reset —
    /// the shared sink for the C5 auto-drop paths. Also drops the transient edit
    /// gate: `guard_mutation` reads only `edit_enabled`, so leaving it open after
    /// the token is gone would let the user keep editing a remote project that can
    /// no longer be pushed. The server lock is intentionally NOT released here — a
    /// 401 may be transient, and surrendering the single-writer claim on a flaky
    /// blip is worse than holding it; a re-login reconciles. (This is the AppState
    /// auto-drop sink; `Session::forget` is left untouched so the login
    /// switch-account path does not spuriously close the gate.)
    fn speleodb_forget(&self) {
        // Drop the transient edit gate ONLY for a remote edit session. A dead token
        // surfaces as a 401 on ANY SpeleoDB call (e.g. a background list_projects /
        // refresh), and this is the auto-drop sink for all of them — so an
        // unconditional drop would silently turn an open LOCAL project read-only.
        // speleodb_open_link is Ok only when a remote hand-off link is open; mirror
        // speleodb_logout's remote-gated drop.
        if self.edit_enabled() && self.speleodb_open_link().is_ok() {
            self.set_edit_enabled(false);
        }
        if let Ok(mut session) = self.speleodb_session_lock() {
            session.forget();
        }
    }

    /// Disambiguate a resource/write **403** (D-B4 + the live-verified DRF 401→403
    /// downgrade): the box answers 403 for BOTH a real read-only / fence grant AND
    /// a dead token, so a 403 here is ambiguous. Probe the `/user/` whoami
    /// chokepoint (200 for any valid token, 403 for a dead one) and report the
    /// token dead **iff** the probe also indicates death — a whoami success means a
    /// genuine permission denial, so the token is kept (never log out a read-only
    /// user). Only the ambiguous 403s (`ReadOnly` / `Fence`) reach the probe; an
    /// unambiguous `ReLogin` (whoami 403 / 401) is handled by
    /// [`auth_error_drops_token`], and other statuses never indicate a dead token.
    fn speleodb_ambiguous_403_is_dead_token<T>(
        &self,
        endpoint: Endpoint,
        result: &Result<T, SpeleoDbError>,
    ) -> bool {
        let Err(SpeleoDbError::Status { status, .. }) = result else {
            return false;
        };
        if *status != 403
            || !matches!(
                map_status(endpoint, *status),
                SpeleoDbAction::ReadOnly | SpeleoDbAction::Fence
            )
        {
            return false;
        }
        self.speleodb_token_is_dead()
    }

    /// One whoami round-trip to test whether the current session token is still
    /// valid (see [`whoami_indicates_dead_token`]). Taken only on an ambiguous 403.
    /// Returns `false` when there is no established token (nothing to drop).
    fn speleodb_token_is_dead(&self) -> bool {
        let Ok((endpoint, token)) = self.speleodb_active_token() else {
            return false;
        };
        let insecure_http = self.speleodb_insecure_http();
        whoami_indicates_dead_token(&client::fetch_user_email(&endpoint, &token, insecure_http))
    }

    /// Persist the user-supplied endpoint (when given) + email — never the token —
    /// for a future prefill (#205). The `DEV_SPELEODB_URL` env default is
    /// deliberately *not* persisted: writing the resolved endpoint here would leak
    /// the dev box into the saved config and resurface it after the env var is
    /// unset. Best-effort; a failure is logged, not fatal.
    fn speleodb_persist_account(&self, endpoint: Option<&str>, email: &str) {
        let Ok(mut config) = self.config.lock() else {
            return;
        };
        if let Some(endpoint) = endpoint {
            config.speleodb.endpoint = Some(endpoint.to_owned());
        }
        config.speleodb.email = Some(email.to_owned());
        if let Err(e) = config.save() {
            tracing::warn!(error = %e, "failed to persist SpeleoDB endpoint/email to config");
        }
    }

    /// Log in: exchange email+password for a token (or accept a pasted `token`),
    /// store it backend-side, and record the session. The token never crosses
    /// back to the webview — only the email + whether the keychain was used.
    pub(crate) fn speleodb_login(
        &self,
        override_endpoint: Option<String>,
        email: Option<String>,
        password: Option<String>,
        token: Option<String>,
    ) -> Result<SpeleoLoginResult, SpeleoErrorDto> {
        // Only a user-supplied endpoint (the dialog override) is persisted; the env
        // default must not leak into the saved config (see speleodb_persist_account).
        let persist_endpoint = override_endpoint
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_owned);

        let endpoint = self
            .speleodb_resolve_endpoint(override_endpoint.as_deref())
            .ok_or(SpeleoDbError::NoEndpoint)
            .map_err(local_dto)?;
        // [Track A] #187: read the override and thread it into every client call.
        let insecure_http = self.speleodb_insecure_http();

        // Two login modes, each yielding both the token and the *authoritative*
        // account email used for the session/keychain key:
        // - Pasted token: the email is NOT typed (it can't be trusted), so derive
        //   it from `GET /user/`. That call also validates the token (a bad token
        //   401s here instead of silently slipping through to the first list call).
        // - Email + password: the auth-token exchange verifies the pair, so the
        //   typed email is authoritative by construction.
        let (token, email) =
            if let Some(t) = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
                let email = client::fetch_user_email(&endpoint, &t, insecure_http)
                    .map_err(|e| dto_for_error(Endpoint::User, &e))?;
                (t, email)
            } else {
                let email = email.map(|e| e.trim().to_owned()).unwrap_or_default();
                let password = password.unwrap_or_default();
                // Reject blank credentials at the boundary rather than POSTing them
                // and relying on the server to 400.
                if email.is_empty() || password.is_empty() {
                    return Err(local_dto(SpeleoDbError::MissingCredentials));
                }
                let token = client::login(&endpoint, insecure_http, &email, &password)
                    .map_err(|e| dto_for_error(Endpoint::Login, &e))?;
                (token, email)
            };

        // [Track C] (#188, C6) Gate 1 of the two-gate plaintext opt-in: the
        // persisted `token_fallback == Plaintext` preference (read under the
        // config lock). Gate 2 (the keychain failed this session) is intrinsic to
        // TokenStore::store, which only reaches plaintext in the keychain-Err
        // branch. The warned confirmation that flips this preference is #205.
        let allow_plaintext = self
            .config
            .lock()
            .ok()
            .map(|c| c.speleodb.token_fallback == crate::config::TokenFallback::Plaintext)
            .unwrap_or(false);

        let keychain_backed = {
            let mut session = self.speleodb_session_lock().map_err(local_dto)?;
            // If a *different* account is already active, forget it first so its
            // keychain entry isn't orphaned. (The UI logs out before re-login, but
            // the backend shouldn't depend on that; a same-account re-login just
            // overwrites the existing entry.)
            let switching = session.endpoint.as_deref() != Some(endpoint.as_str())
                || session.email.as_deref() != Some(email.as_str());
            if switching {
                session.forget();
            }
            // [Track C] (#188): store() now returns the resolved TokenTier; only
            // Keychain counts as "backed" for the UI's restart warning (Plaintext
            // and Memory both report false — #205 owns surfacing the distinction).
            let tier = session
                .token_store
                .store(&endpoint, &email, &token, allow_plaintext);
            session.endpoint = Some(endpoint.clone());
            session.email = Some(email.clone());
            // A fresh login established a session this run; don't let a later lazy
            // rehydration clobber it.
            session.rehydrate_attempted = true;
            tier == crate::speleodb::auth::TokenTier::Keychain
        };

        self.speleodb_persist_account(persist_endpoint.as_deref(), &email);

        Ok(SpeleoLoginResult {
            user_email: email,
            keychain_backed,
        })
    }

    /// List the projects visible to the logged-in user, as display summaries.
    pub(crate) fn speleodb_list_projects(
        &self,
    ) -> Result<Vec<SpeleoProjectSummary>, SpeleoErrorDto> {
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();
        // [Track C] (#188, C5): route through the 401 auto-drop handler — a
        // genuine 401 on this established-session call fully clears the token —
        // then map the surfaced SpeleoDbError to the typed DTO ([Track A] D-B2).
        let projects = self
            .speleodb_handle_auth(
                Endpoint::ListProjects,
                client::list_projects(&endpoint, &token, insecure_http),
            )
            .map_err(|e| dto_for_error(Endpoint::ListProjects, &e))?;
        Ok(projects
            .into_iter()
            .map(SpeleoProjectSummary::from_project)
            .collect())
    }

    /// Pull a project's dump, extract its `.stalx` into the app cache, and return
    /// the local path. The frontend then opens it via the normal `open_project`
    /// flow. Read-only against the server (nothing is locked or pushed).
    ///
    /// [Track B] (#189, D-B9) `project_name` + `latest_commit_sha` are threaded
    /// through the open path (extra args, SAME command name → EVENT_NAMES stays
    /// 418) so the extracted `.stalx` is stamped `is_remote == true` end-to-end.
    ///
    /// FRESHNESS-FOLD SEAM (D-B1): #185's get_project/list_projects return the
    /// authoritative Project on every call. The persistence fold (cache the
    /// freshness verdict + reset last_verify_at) is a DOCUMENTED NO-OP until the
    /// #202 piggyback path consumes it. base_commit_sha is captured ONCE here on
    /// pull and NEVER mutated by #189 (a later Sync/Release issue re-stamps it).
    pub(crate) fn speleodb_open_project(
        &self,
        project_id: String,
        project_name: String,
        latest_commit_sha: Option<String>,
    ) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
        // Validate the id at the trust boundary, before it reaches the download
        // URL or the cache-path join (closes the path/route-traversal vector).
        validate_project_id(&project_id).map_err(local_dto)?;
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();
        // FRESHNESS-FOLD SEAM (D-B1, #189/#191): #185's get_project/list_projects
        // return the authoritative Project; the pull stamp (project_name +
        // latest_commit_sha → speleo_link) and the cache-the-verdict fold land
        // with #189/#191 — this call site is where they hook in.
        //
        // [Track C] (#188, C5): route through the 401 auto-drop handler before
        // mapping the surfaced SpeleoDbError to the typed DTO ([Track A] D-B2).
        let zip = self
            .speleodb_handle_auth(
                Endpoint::DownloadDump,
                client::download_dump(&endpoint, &token, insecure_http, &project_id),
            )
            .map_err(|e| dto_for_error(Endpoint::DownloadDump, &e))?;

        // Open the dump once: list entries (to classify) and extract the chosen
        // `.stalx` from the same parsed archive.
        let mut dump = dump::Dump::open(&zip).map_err(local_dto)?;
        let entry =
            classify_dump_entry(&dump.entry_paths().map_err(local_dto)?).map_err(local_dto)?;

        let dest = self.speleodb_cache_path(&project_id).map_err(local_dto)?;
        // Carry the user's local view toggles across the download-replace (a re-open
        // of a previously-customized remote project shouldn't reset their view —
        // display_settings are stripped from the server copy). Empty on first open.
        let preserved_view = preserved_display_settings(&dest);
        dump.extract_entry_to(&entry, &dest).map_err(local_dto)?;

        // Stamp BASE = the server's TRUE HEAD (the revision-topology leaf), NOT the
        // list/get_project `latest_commit` field, which is `max(authored_date)` and
        // ties to the root creation commit (see speleodb_server_head). The dump we
        // just downloaded IS this HEAD's working tree, so BASE must match it — else
        // the first Start editing would needlessly fast-forward. Best-effort: fall
        // back to the caller-supplied SHA if the history can't be fetched (Start
        // editing then fast-forwards to reconcile).
        // Fetch the revision history DIRECTLY here (NOT via speleodb_handle_auth) so
        // a transient/spurious 401 on this best-effort BASE-stamp cannot auto-drop the
        // whole session mid-open: the dump download above already authenticated with
        // this token, and the fence simply falls back to latest_commit_sha. Start
        // editing / Done DO route revisions through the auto-drop (a dead token there
        // must force re-login). (#197 review.)
        let base_sha = match client::get_revisions(&endpoint, &token, insecure_http, &project_id) {
            Ok(history) => sync::tip_of(&history.commits)
                .map(str::to_owned)
                .or(latest_commit_sha),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "resolve server HEAD on pull",
                    "speleodb_open_project: could not resolve server HEAD; using list latest_commit"
                );
                latest_commit_sha
            }
        };

        // Concurrent same-account session notice (#193 b8): if the server already
        // reports a lock held by our OWN account, a second session is editing this
        // project — the ancestry classifier's "author_email == me" proxy can't tell
        // the two sessions apart (a second session's commit reads as "mine" and
        // could wrongly clear the dirty bit), so surface a notice on open. Computed
        // here, before `endpoint`/`token` are moved into the stamped link.
        // Best-effort: a failed lookup (or no session email) never fails the open.
        let concurrent_session = {
            let holder = client::get_project(&endpoint, &token, insecure_http, &project_id)
                .ok()
                .and_then(|p| p.active_mutex.map(|m| m.user));
            self.speleodb_my_email()
                .is_some_and(|me| sync::concurrent_session_notice(holder.as_deref(), &me))
        };

        // [Track B] (#189, D-B9) Stamp the SpeleoDB hand-off link into the pulled
        // `.stalx`. Opening via `open_existing` runs `ensure_schema_version`,
        // which creates the `speleo_link` table on the freshly-extracted file;
        // then upsert the single row. After this, `load_metadata().is_remote` is
        // true and the dirty bit (`has_unpushed_edits`) starts false.
        match crate::persistence::Database::open_existing(&dest) {
            Ok(db) => {
                restore_display_settings(&db, &preserved_view);
                let link = crate::models::SpeleoLink {
                    endpoint,
                    project_id: project_id.clone(),
                    project_name,
                    base_commit_sha: base_sha,
                    has_unpushed_edits: false,
                    last_edit_at: None, // freshly pulled: no local edits yet
                };
                if let Err(e) = db.save_speleo_link(Some(&link)) {
                    // Non-fatal: the pull succeeded and the file is openable; the
                    // worst case is the project opens as local-only (editable)
                    // rather than read-only-remote. Surfacing a hard error here
                    // would strand a successfully-downloaded `.stalx`.
                    tracing::warn!(
                        error = %e,
                        project_id = %project_id,
                        purpose = "stamp SpeleoDB hand-off link on pull",
                        "speleodb_open_project: failed to stamp speleo_link; project will open local-only"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "stamp SpeleoDB hand-off link on pull",
                    "speleodb_open_project: could not reopen extracted .stalx to stamp speleo_link"
                );
            }
        }

        Ok(SpeleoOpenResult {
            local_path: dest.to_string_lossy().into_owned(),
            concurrent_session,
        })
    }

    /// Forget the local token (keychain + in-memory) and clear the session. The
    /// DRF token is not revoked server-side, but if we were mid-edit on a remote
    /// project we best-effort RELEASE the write lock (it needs the token, so before
    /// `forget`) so it isn't stranded, and drop the transient edit gate — a
    /// token-less session must not keep mutating a project it can never push.
    pub(crate) fn speleodb_logout(&self) -> Result<(), SpeleoErrorDto> {
        // A held write lock exists only on a remote EDIT session (edit_enabled +
        // a remote link); a read-only-open or local project holds none. In that
        // case best-effort RELEASE the lock (needs the token, so before `forget`)
        // and drop the gate — independent of whether the token still resolves, a
        // logged-out session must not keep editing a project it can never push.
        if self.edit_enabled() {
            if let Ok(link) = self.speleodb_open_link() {
                if let Ok((endpoint, token)) = self.speleodb_active_token() {
                    let insecure_http = self.speleodb_insecure_http();
                    self.speleodb_release_best_effort(
                        &endpoint,
                        &token,
                        insecure_http,
                        &link.project_id,
                    );
                }
                self.set_edit_enabled(false);
            }
        }
        self.speleodb_session_lock().map_err(local_dto)?.forget();
        Ok(())
    }

    /// Where a pulled `.stalx` is cached: `<cache>/speleodb/<project_id>/project.stalx`.
    fn speleodb_cache_path(&self, project_id: &str) -> Result<PathBuf, SpeleoDbError> {
        let cache = crate::app_dirs::cache_dir()
            .ok_or_else(|| SpeleoDbError::Io("no app cache directory available".to_owned()))?;
        Ok(cache
            .join("speleodb")
            .join(project_id)
            .join("project.stalx"))
    }

    /// Acquire the write lock on the open remote project and reconcile it against
    /// the server (#194). On a clean reconcile the transient edit gate is enabled;
    /// on divergence the freshly-taken lock is released and the user is asked to
    /// reconcile; on contention the lock holder is reported. Errors (no
    /// permission, an anomalous server state, network) surface as `SpeleoErrorDto`.
    ///
    /// Uses the base-SHA fence (#192) — NOT ancestry recovery (#193), which is the
    /// push path's concern (#197): start-editing only reconciles, it never pushes.
    /// `set_edit_enabled(true)` happens ONLY on a clean reconcile (UpToDate /
    /// FastForward), and for FastForward it happens AFTER the in-place reload (the
    /// reload re-derives the gate from `is_remote` and would otherwise re-disable).
    pub(crate) fn speleodb_start_editing(&self) -> Result<StartEditingResult, SpeleoErrorDto> {
        let link = self.speleodb_open_link().map_err(local_dto)?;
        validate_project_id(&link.project_id).map_err(local_dto)?;
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();

        // Acquire the lock. A 400 is the server's "someone else holds it" signal;
        // it has no first-class map_status row, so it is handled here (per #194).
        let acquired = self.speleodb_handle_auth(
            Endpoint::Acquire,
            client::acquire_lock(&endpoint, &token, insecure_http, &link.project_id),
        );
        // We only need the acquire to confirm we hold the lock; its `latest_commit`
        // is unreliable (see speleodb_server_head) so it is intentionally dropped.
        match acquired {
            Ok(_project) => {}
            Err(SpeleoDbError::Status { status: 400, .. }) => {
                return Ok(self.speleodb_locked_by(
                    &endpoint,
                    &token,
                    insecure_http,
                    &link.project_id,
                ));
            }
            Err(e) => return Err(dto_for_error(Endpoint::Acquire, &e)),
        }

        // We hold the lock. Resolve the true HEAD from the revision topology and
        // fence our BASE against it (re-fetch once on a transient empty tip).
        let (tip, commits) = match head_with_empty_retry(link.base_commit_sha.as_deref(), || {
            self.speleodb_server_head(&endpoint, &token, insecure_http, &link.project_id)
        }) {
            Ok(v) => v,
            Err(e) => {
                self.speleodb_release_best_effort(
                    &endpoint,
                    &token,
                    insecure_http,
                    &link.project_id,
                );
                return Err(dto_for_error(Endpoint::GetProject, &e));
            }
        };
        match sync::reconcile_verdict(
            link.base_commit_sha.as_deref(),
            tip.as_deref(),
            link.has_unpushed_edits,
            &commits,
        ) {
            ReconcileVerdict::UpToDate => {
                self.set_edit_enabled(true);
                Ok(StartEditingResult::Editing)
            }
            ReconcileVerdict::FastForward => {
                // A failure here (e.g. a corrupt re-pulled dump) leaves us holding
                // the lock with a closed project — release it before surfacing the
                // error so it isn't stranded (mirrors the divergence arm).
                let local_path = match self.speleodb_fast_forward(
                    &endpoint,
                    &token,
                    insecure_http,
                    &link,
                    tip.as_deref(),
                ) {
                    Ok(p) => p,
                    Err(e) => {
                        self.speleodb_release_best_effort(
                            &endpoint,
                            &token,
                            insecure_http,
                            &link.project_id,
                        );
                        return Err(local_dto(e));
                    }
                };
                self.set_edit_enabled(true);
                Ok(StartEditingResult::FastForwarded { local_path })
            }
            // A fork, a moved tip our BASE isn't an ancestor of, OR a server
            // inconsistency (non-linear / multi-root / a recorded BASE with no tip):
            // can't edit a diverged/anomalous copy. Release the lock we just took so
            // it isn't stranded while the user reconciles (#198, next batch) and
            // surface the divergence prompt — never overwrite, never a hard error
            // (#193 b2). The edit gate stays disabled.
            ReconcileVerdict::Diverged => {
                self.speleodb_release_best_effort(
                    &endpoint,
                    &token,
                    insecure_http,
                    &link.project_id,
                );
                Ok(StartEditingResult::DivergenceNeeded)
            }
        }
    }

    /// Read the open project's persisted SpeleoDB hand-off link, or
    /// [`SpeleoDbError::NoRemoteProject`] when no remote project is open.
    fn speleodb_open_link(&self) -> Result<crate::models::SpeleoLink, SpeleoDbError> {
        let db_guard = self
            .database
            .lock()
            .map_err(|_| SpeleoDbError::Io("database lock poisoned".to_owned()))?;
        let db = db_guard.as_ref().ok_or(SpeleoDbError::NoRemoteProject)?;
        db.load_speleo_link()
            .map_err(|e| SpeleoDbError::Io(e.to_string()))?
            .ok_or(SpeleoDbError::NoRemoteProject)
    }

    /// Re-GET the project to report who holds the contended lock. Best-effort: a
    /// failed GET (or a lock that has since cleared) reports the holder as unknown.
    fn speleodb_locked_by(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        project_id: &str,
    ) -> StartEditingResult {
        let email = client::get_project(endpoint, token, insecure_http, project_id)
            .ok()
            .and_then(|p| p.active_mutex.map(|m| m.user));
        StartEditingResult::LockedBy { email }
    }

    /// Best-effort lock release for when start-editing took the lock but can't
    /// proceed (divergence / anomaly). A failure is logged, never surfaced.
    fn speleodb_release_best_effort(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        project_id: &str,
    ) {
        if let Err(e) = client::release_lock(endpoint, token, insecure_http, project_id) {
            tracing::warn!(
                error = %e,
                project_id,
                purpose = "release a lock taken before a no-edit reconcile outcome",
                "speleodb_start_editing: failed to release lock"
            );
        }
    }

    /// Fast-forward the open remote project to the server tip: re-pull the dump,
    /// re-stamp the link (`base = tip`, dirty cleared, `last_edit_at` reset), then
    /// reload the project in place (resetting undo/redo). Returns the reloaded
    /// `.stalx` path.
    fn speleodb_fast_forward(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        link: &crate::models::SpeleoLink,
        tip: Option<&str>,
    ) -> Result<String, SpeleoDbError> {
        let project_id = &link.project_id;
        let zip = self.speleodb_handle_auth(
            Endpoint::DownloadDump,
            client::download_dump(endpoint, token, insecure_http, project_id),
        )?;
        let mut dump = dump::Dump::open(&zip)?;
        let entry = classify_dump_entry(&dump.entry_paths()?)?;
        let dest = self.speleodb_cache_path(project_id)?;
        // Capture the user's local view toggles BEFORE the download replaces the
        // file — they're stripped from the server copy, so they'd otherwise reset
        // to defaults on every fast-forward.
        let preserved_view = preserved_display_settings(&dest);
        dump.extract_entry_to(&entry, &dest)?;

        // Re-stamp the hand-off link onto the refreshed file: BASE advances to the
        // server tip, the dirty bit clears, last_edit_at resets (clean checkout).
        match crate::persistence::Database::open_existing(&dest) {
            Ok(db) => {
                restore_display_settings(&db, &preserved_view);
                let new_link = crate::models::SpeleoLink {
                    endpoint: endpoint.to_owned(),
                    project_id: project_id.clone(),
                    project_name: link.project_name.clone(),
                    base_commit_sha: tip.map(str::to_owned),
                    has_unpushed_edits: false,
                    last_edit_at: None,
                };
                if let Err(e) = db.save_speleo_link(Some(&new_link)) {
                    tracing::warn!(
                        error = %e,
                        project_id = %project_id,
                        purpose = "re-stamp speleo_link after fast-forward",
                        "speleodb_fast_forward: failed to re-stamp speleo_link"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "re-stamp speleo_link after fast-forward",
                    "speleodb_fast_forward: could not reopen extracted .stalx to re-stamp"
                );
            }
        }

        // Reload from the refreshed cache file. close_project clears the in-memory
        // project so do_load_project_full's "already open" guard won't reject the
        // same path; do_load_project_full re-opens it. The pulled snapshot carries
        // NO undo/redo history (stripped on push by sanitize_push_snapshot, #194 b3),
        // so the reload starts the in-memory stacks empty — i.e. adopt-remote resets
        // undo/redo, never inheriting the pusher's edit history.
        let local_path = dest.to_string_lossy().into_owned();
        self.close_project();
        self.do_load_project_full(dest)
            .map_err(|e| SpeleoDbError::Io(format!("reload after fast-forward failed: {e}")))?;
        Ok(local_path)
    }

    /// Render the open remote project to a scratch `ariane.tml` at `dest` for
    /// co-push (#196). Mints a stable UUID for any shot still missing one — a
    /// no-op for modern files; for legacy pre-v6 shots it mints AND persists so
    /// the canonical `.stalx` (hence its push snapshot) shares the identity the
    /// `.tml` carries. Renders via `export_tml` DIRECTLY (never the collab sibling
    /// `export_tml_with_baseline`), discarding the baseline — the `.tml` is a
    /// throwaway render sidecar, not the collab round-trip file.
    fn speleodb_render_tml(&self, dest: &Path) -> Result<(), SpeleoDbError> {
        // Snapshot the in-memory project so the UUID-persist + render run without
        // holding the project lock across the database lock.
        let (project, minted) = {
            let mut proj_guard = self
                .project
                .lock()
                .map_err(|_| SpeleoDbError::Io("project lock poisoned".to_owned()))?;
            let project = proj_guard.as_mut().ok_or(SpeleoDbError::NoRemoteProject)?;
            let minted = project.sections.iter().any(|s| {
                s.shots
                    .iter()
                    .any(|sh| sh.uuid.as_deref().map_or(true, str::is_empty))
            });
            project.ensure_shot_uuids();
            (project.clone(), minted)
        };
        // Persist freshly-minted UUIDs so the snapshot .stalx matches the .tml.
        // save_project does NOT clear the SpeleoDB dirty bit (speleo_link is
        // excluded), so this is safe to call inside the push pipeline.
        if minted {
            if let Ok(mut db_guard) = self.database.lock() {
                if let Some(db) = db_guard.as_mut() {
                    if let Err(e) = db.save_project(&project) {
                        tracing::warn!(
                            error = %e,
                            purpose = "persist freshly-minted shot UUIDs before push",
                            "speleodb_render_tml: failed to persist minted UUIDs"
                        );
                    }
                }
            }
        }
        crate::export::tml::export_tml(&project, dest)
            .map_err(|e| SpeleoDbError::Io(format!("render .tml failed: {e}")))?;
        Ok(())
    }

    /// Push the open project's edits (if any) and release the write lock,
    /// returning to read-only (#197). On a confirmed push (or nothing to push) the
    /// lock is released and the edit gate dropped; on divergence or an ambiguous
    /// push, the lock + dirty bit are retained so no edits are lost. `message` is
    /// the commit message (a generic default is used when blank).
    pub(crate) fn speleodb_done(
        &self,
        message: Option<String>,
    ) -> Result<DoneResult, SpeleoErrorDto> {
        let link = self.speleodb_open_link().map_err(local_dto)?;
        validate_project_id(&link.project_id).map_err(local_dto)?;

        // Edit-session gate: Done acts only on an ACTIVE edit session. The edit gate
        // is set true only by Start editing (after acquiring the lock) / its FF arm,
        // so `!edit_enabled` means we hold no lock — opened read-only, or already
        // finished. Releasing here would POST /release/ for a mutex this session
        // never acquired (a confusing Fence error, or a 401 that auto-drops the
        // token). We are already read-only, so report Released without a server call.
        if !self.edit_enabled() {
            return Ok(DoneResult::Released);
        }

        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();

        // Dirty-bit gate: only push when there are un-pushed edits.
        let outcome = if link.has_unpushed_edits {
            self.speleodb_push(&endpoint, &token, insecure_http, &link, message)?
        } else {
            PushOutcome::Confirmed
        };

        match outcome {
            PushOutcome::Confirmed => {
                // Edits are safely on the server; release the lock and go
                // read-only. Drop the edit gate only after a confirmed release —
                // if release fails the lock is still held, so a retry of Done
                // (now a no-op push, dirty already cleared) re-attempts it.
                self.speleodb_handle_auth(
                    Endpoint::Release,
                    client::release_lock(&endpoint, &token, insecure_http, &link.project_id),
                )
                .map_err(|e| dto_for_error(Endpoint::Release, &e))?;
                self.set_edit_enabled(false);
                Ok(DoneResult::Released)
            }
            // Stay locked + dirty so the user can reconcile / a retry can recover.
            PushOutcome::Diverged => Ok(DoneResult::DivergenceNeeded),
            PushOutcome::Unconfirmed => Ok(DoneResult::PushUnconfirmed),
        }
    }

    /// Read-only refresh of the open project against the server (#197): no lock is
    /// taken. UpToDate / FastForward (re-pull + reload) / DivergenceNeeded.
    pub(crate) fn speleodb_update(&self) -> Result<UpdateResult, SpeleoErrorDto> {
        let link = self.speleodb_open_link().map_err(local_dto)?;
        validate_project_id(&link.project_id).map_err(local_dto)?;
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();

        let (tip, commits) = head_with_empty_retry(link.base_commit_sha.as_deref(), || {
            self.speleodb_server_head(&endpoint, &token, insecure_http, &link.project_id)
        })
        .map_err(|e| dto_for_error(Endpoint::GetProject, &e))?;

        match sync::reconcile_verdict(
            link.base_commit_sha.as_deref(),
            tip.as_deref(),
            link.has_unpushed_edits,
            &commits,
        ) {
            ReconcileVerdict::UpToDate => Ok(UpdateResult::UpToDate),
            ReconcileVerdict::FastForward => {
                // speleodb_fast_forward reloads in place, which re-derives the edit
                // gate from is_remote (= false for a remote project). If the caller
                // was mid-edit-session (gate on, lock held — reachable if the lock
                // lapsed/was admin-released and another writer advanced the tip),
                // a clean FF must NOT silently strip editability; restore it after
                // the reload, mirroring speleodb_start_editing's FF arm. Captured
                // BEFORE the reload (which sets the gate false). FF only fires with
                // dirty == false, so there are no un-pushed edits to strand.
                let was_editing = self.edit_enabled();
                let local_path = self
                    .speleodb_fast_forward(&endpoint, &token, insecure_http, &link, tip.as_deref())
                    .map_err(local_dto)?;
                if was_editing {
                    self.set_edit_enabled(true);
                }
                Ok(UpdateResult::FastForwarded { local_path })
            }
            // A fork, a moved tip our BASE isn't an ancestor of, OR a server
            // inconsistency (non-linear / multi-root / a recorded BASE with no tip):
            // surface the divergence prompt, never a hard error (#193 b2).
            ReconcileVerdict::Diverged => Ok(UpdateResult::DivergenceNeeded),
        }
    }

    /// Resolve the server's TRUE HEAD and return it with the full revision
    /// history. The server's `latest_commit` field (carried by acquire /
    /// get_project / list) is `max(authored_date)` and ties to the ROOT creation
    /// commit when commits land within the same second — verified unreliable both
    /// live and in the server source — so every fence resolves the tip from the
    /// parent-id topology ([`sync::tip_of`]) instead. Returns `(tip, commits)`;
    /// `tip` is `None` for an empty / ambiguous (forked) history.
    fn speleodb_server_head(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        project_id: &str,
    ) -> Result<(Option<String>, Vec<crate::speleodb::models::RevisionCommit>), SpeleoDbError> {
        // No GetRevisions endpoint exists; reuse GetProject for the auth/error map.
        let history = self.speleodb_handle_auth(
            Endpoint::GetProject,
            client::get_revisions(endpoint, token, insecure_http, project_id),
        )?;
        let tip = sync::tip_of(&history.commits).map(str::to_owned);
        Ok((tip, history.commits))
    }

    /// The push half of [`Self::speleodb_done`]: fence BASE vs the server tip,
    /// recover via ancestry (#193) if the tip moved under our lock, then upload the
    /// snapshot + render.
    fn speleodb_push(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        link: &crate::models::SpeleoLink,
        message: Option<String>,
    ) -> Result<PushOutcome, SpeleoErrorDto> {
        let project_id = &link.project_id;

        // Authoritative server tip — the revision topology, NOT the unreliable
        // latest_commit field (see speleodb_server_head). The fetched history is
        // reused for ancestry recovery below, so this is the only revisions GET.
        let (tip, commits) = head_with_empty_retry(link.base_commit_sha.as_deref(), || {
            self.speleodb_server_head(endpoint, token, insecure_http, project_id)
        })
        .map_err(|e| dto_for_error(Endpoint::GetProject, &e))?;

        // `my_email` identifies our own landed commits in the BASE..tip gap (#193).
        // We are authenticated to be here; if it is somehow absent, plan_push can't
        // match any commit as "mine" and safely routes to the divergence prompt
        // rather than guessing.
        let my_email = self.speleodb_my_email().unwrap_or_default();

        // push-start is not persisted, so the ancestry timing stays conservative
        // (clear_dirty == false → AdoptThenUpload, never AdoptConfirmed) and we
        // re-push on top of any landed commit — a no-op 304 if nothing changed.
        match sync::plan_push(
            link.base_commit_sha.as_deref(),
            tip.as_deref(),
            &commits,
            &my_email,
            link.last_edit_at.as_deref(),
            None,
        ) {
            // base == tip: push our edits directly.
            PushPlan::Upload => {}
            // Our prior (ambiguous) push landed; adopt the tip as BASE, then push the
            // current state on top (a 304 if nothing changed since).
            PushPlan::AdoptThenUpload => {
                self.speleodb_mutate_link(|l| l.base_commit_sha = tip.clone())
                    .map_err(local_dto)?;
            }
            // Forward-compatible only (unreachable while push-start is unpersisted):
            // the prior push landed and no edit followed, so adopt the tip and clear
            // dirty without a redundant re-push.
            PushPlan::AdoptConfirmed => {
                self.speleodb_mutate_link(|l| {
                    l.base_commit_sha = tip.clone();
                    l.has_unpushed_edits = false;
                    l.last_edit_at = None;
                })
                .map_err(local_dto)?;
                return Ok(PushOutcome::Confirmed);
            }
            // A stranger's commit, OR a server inconsistency (non-linear / multi-root
            // / a recorded BASE with no tip): never overwrite or guess — surface the
            // divergence prompt (#193 b2 + b5). Stays locked + dirty in speleodb_done.
            PushPlan::Diverged => return Ok(PushOutcome::Diverged),
        }

        self.speleodb_upload(endpoint, token, insecure_http, link, message)
    }

    /// Build the upload (VACUUM snapshot with the dirty bit cleared in the copy +
    /// the `.tml` render) and push it as one commit, then reconcile the dirty bit
    /// from the result.
    fn speleodb_upload(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        link: &crate::models::SpeleoLink,
        message: Option<String>,
    ) -> Result<PushOutcome, SpeleoErrorDto> {
        let project_id = &link.project_id;
        let commit_message = message
            .map(|m| m.trim().to_owned())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "Updated in Stalagmight".to_owned());

        // The live on-disk `.stalx` (the open project's cache file) and the scratch
        // snapshot / render paths beside it.
        let live = self.speleodb_cache_path(project_id).map_err(local_dto)?;
        let dir = live
            .parent()
            .ok_or_else(|| local_dto(SpeleoDbError::Io("cache path has no parent".to_owned())))?;
        let snapshot = dir.join("snapshot.stalx");
        let tml = dir.join("ariane.tml");

        // Push-start fence (#197): capture the instant BEFORE the flush/snapshot.
        // Any edit recorded after this (last_edit_at > push_start) is NOT in the
        // snapshot we upload, so a confirmed push must NOT clear its dirty bit — it
        // is re-pushed on the next Done instead of being silently dropped. (dirty
        // edits always carry a last_edit_at: mark_remote_dirty stamps both
        // together, so the None branch of edits_captured_by_push is unreachable for
        // a real dirty bit here.)
        let push_start = chrono::Utc::now().to_rfc3339();

        // Flush in-memory state to the live `.stalx` FIRST, THEN render the `.tml`.
        // save_project heals the in-memory project (mints + DEDUPS shot UUIDs and
        // sanitizes non-finite geometry); rendering the `.tml` after that heal is
        // what guarantees the co-pushed `.tml` and the `.stalx` snapshot agree on
        // shot identity + geometry. Rendering first would ship a `.tml` built from
        // the un-healed project for a legacy file carrying within-section duplicate
        // UUIDs or non-finite values (#196).
        if !self.save_project(None, true).success {
            return Err(local_dto(SpeleoDbError::Io(
                "failed to flush project before push".to_owned(),
            )));
        }
        self.speleodb_render_tml(&tml).map_err(local_dto)?;

        // Self-contained snapshot of the live `.stalx` (#195), dirty bit cleared in
        // the COPY so it never rides to the server.
        crate::persistence::Database::vacuum_snapshot(&live, &snapshot)
            .map_err(|e| local_dto(SpeleoDbError::Io(e.to_string())))?;
        clear_snapshot_dirty(&snapshot);

        let result = self.speleodb_handle_auth(
            Endpoint::UploadAuto,
            client::upload_auto(
                endpoint,
                token,
                insecure_http,
                project_id,
                &snapshot,
                &tml,
                &commit_message,
            ),
        );
        match result {
            // 200: BASE advances to the adopted hexsha. Clear the dirty bit ONLY if
            // no edit was recorded after push_start (else a concurrent edit during
            // the upload would be dropped — keep it dirty so the next Done re-pushes
            // it). BASE advances unconditionally: the uploaded snapshot IS the new
            // base; a kept late edit is a clean second commit on top of it.
            Ok(pushed) => {
                let new_base = pushed.latest_commit.as_ref().map(|c| c.id.clone());
                self.speleodb_mutate_link(|l| {
                    l.base_commit_sha = new_base;
                    if sync::edits_captured_by_push(l.last_edit_at.as_deref(), Some(&push_start)) {
                        l.has_unpushed_edits = false;
                        l.last_edit_at = None;
                    }
                })
                .map_err(local_dto)?;
                Ok(PushOutcome::Confirmed)
            }
            Err(e) => {
                // 304: the remote tree already matches — clear dirty (same push-start
                // guard as the 200 path), BASE unchanged.
                if matches!(&e, SpeleoDbError::Status { status: 304, .. }) {
                    self.speleodb_mutate_link(|l| {
                        if sync::edits_captured_by_push(
                            l.last_edit_at.as_deref(),
                            Some(&push_start),
                        ) {
                            l.has_unpushed_edits = false;
                            l.last_edit_at = None;
                        }
                    })
                    .map_err(local_dto)?;
                    return Ok(PushOutcome::Confirmed);
                }
                // Ambiguous (retried-then-exhausted 5xx, or a transport drop): we
                // don't know whether it landed — stay dirty, recover via ancestry
                // on the next attempt.
                let ambiguous = match &e {
                    SpeleoDbError::Status { status, .. } => {
                        map_status(Endpoint::UploadAuto, *status) == SpeleoDbAction::StayDirty
                    }
                    SpeleoDbError::Transport(_) => true,
                    _ => false,
                };
                if ambiguous {
                    tracing::warn!(
                        error = %e,
                        purpose = "preserve un-pushed edits after an ambiguous push",
                        "speleodb push: ambiguous result; staying dirty for ancestry recovery"
                    );
                    return Ok(PushOutcome::Unconfirmed);
                }
                // A hard rejection (403 fence, 4xx, parse): surface it.
                Err(dto_for_error(Endpoint::UploadAuto, &e))
            }
        }
    }

    /// The authenticated user's email (for ancestry authorship checks), if any.
    fn speleodb_my_email(&self) -> Option<String> {
        self.speleodb_session_lock()
            .ok()
            .and_then(|s| s.email.clone())
    }

    /// Load the open project's `speleo_link`, apply `f`, and persist it. Errors if
    /// no remote project is open.
    fn speleodb_mutate_link(
        &self,
        f: impl FnOnce(&mut crate::models::SpeleoLink),
    ) -> Result<(), SpeleoDbError> {
        let db_guard = self
            .database
            .lock()
            .map_err(|_| SpeleoDbError::Io("database lock poisoned".to_owned()))?;
        let db = db_guard.as_ref().ok_or(SpeleoDbError::NoRemoteProject)?;
        let mut link = db
            .load_speleo_link()
            .map_err(|e| SpeleoDbError::Io(e.to_string()))?
            .ok_or(SpeleoDbError::NoRemoteProject)?;
        f(&mut link);
        db.save_speleo_link(Some(&link))
            .map_err(|e| SpeleoDbError::Io(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use super::{
        auth_error_drops_token, classify_dump_entry, clear_snapshot_dirty, head_with_empty_retry,
        preserved_display_settings, resolve_endpoint, restore_display_settings,
        validate_project_id, whoami_indicates_dead_token, Endpoint, PushOutcome, SpeleoDbSession,
    };
    use crate::models::{Project, SpeleoLink};
    use crate::persistence::Database;
    use crate::speleodb::auth::{InMemoryStore, SecretStore, TokenStore};
    use crate::speleodb::SpeleoDbError;
    use tempfile::TempDir;

    #[test]
    fn clear_snapshot_dirty_clears_the_flag_in_the_copy() {
        // #197 guardrail: the push snapshot must never carry has_unpushed_edits to
        // the server — clear_snapshot_dirty wipes the dirty bit (and last_edit_at)
        // in the COPY while preserving the hand-off identity.
        let temp = TempDir::new().expect("temp dir");
        let path = temp.path().join("snap.stalx");
        {
            let mut db = Database::open(&path).expect("open snapshot");
            db.save_project(&Project::new("Snap".to_owned(), None))
                .expect("save project");
            db.save_speleo_link(Some(&SpeleoLink {
                endpoint: "http://x".to_owned(),
                project_id: "11111111-1111-1111-1111-111111111111".to_owned(),
                project_name: "Snap".to_owned(),
                base_commit_sha: Some("abc".to_owned()),
                has_unpushed_edits: true,
                last_edit_at: Some("2026-06-27T10:00:00+00:00".to_owned()),
            }))
            .expect("stamp dirty link");
        }

        clear_snapshot_dirty(&path);

        let db = Database::open_existing(&path).expect("reopen snapshot");
        let link = db
            .load_speleo_link()
            .expect("load link")
            .expect("link present");
        assert!(
            !link.has_unpushed_edits,
            "dirty bit cleared in the snapshot copy"
        );
        assert_eq!(link.last_edit_at, None, "last_edit_at cleared too");
        // Identity is preserved — only the dirty bit / timestamp change.
        assert_eq!(link.base_commit_sha.as_deref(), Some("abc"));
        assert_eq!(link.project_id, "11111111-1111-1111-1111-111111111111");
    }

    #[test]
    fn local_display_settings_survive_a_download_replace() {
        // #197: view toggles are stripped from the server copy, so a fast-forward /
        // re-open (which replaces the whole local .stalx with the server's) must
        // carry the user's local display_settings across the overwrite — otherwise
        // their view resets to defaults on every sync.
        let temp = TempDir::new().expect("temp dir");
        let dest = temp.path().join("cache.stalx");

        // The user's local file with their view prefs (a project row is present, as
        // in any real pulled .stalx, so open_existing's validation passes).
        {
            let mut db = Database::open(&dest).expect("open local cache");
            db.save_project(&Project::new("Cache".to_owned(), None))
                .expect("save project");
            db.save_display_setting("grid", "off").expect("save grid");
            db.save_display_setting("color_mode", "depth")
                .expect("save color_mode");
        }

        // Snapshot the prefs, then simulate the server dump landing (a fresh file
        // with NO display_settings, as stripped on push).
        let preserved = preserved_display_settings(&dest);
        assert_eq!(preserved.len(), 2, "both local prefs captured");
        std::fs::remove_file(&dest).expect("remove old file");
        {
            let mut db = Database::open(&dest).expect("open replaced file");
            db.save_project(&Project::new("Cache".to_owned(), None))
                .expect("save project");
            assert!(
                db.load_display_settings().expect("load").is_empty(),
                "server copy carries no view prefs"
            );
            restore_display_settings(&db, &preserved);
        }

        // The user's view survived the replace.
        let after = Database::open_existing(&dest)
            .expect("reopen")
            .load_display_settings()
            .expect("load restored");
        assert_eq!(after.get("grid").map(String::as_str), Some("off"));
        assert_eq!(after.get("color_mode").map(String::as_str), Some("depth"));

        // A first open (no prior local file) has nothing to preserve → defaults.
        let fresh = temp.path().join("fresh.stalx");
        assert!(
            preserved_display_settings(&fresh).is_empty(),
            "first open preserves nothing"
        );
    }

    // --- head_with_empty_retry (#192 re-fetch-once on a transient empty tip) ---

    #[test]
    fn head_retries_once_then_succeeds_on_transient_empty() {
        let calls = std::cell::Cell::new(0u32);
        let (tip, _) = head_with_empty_retry(Some("base-sha"), || {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                Ok((None, Vec::new())) // transient empty read
            } else {
                Ok((Some("tip-sha".to_owned()), Vec::new()))
            }
        })
        .expect("ok");
        assert_eq!(
            calls.get(),
            2,
            "re-fetched exactly once on (base Some, tip None)"
        );
        assert_eq!(
            tip.as_deref(),
            Some("tip-sha"),
            "the second read's tip wins"
        );
    }

    #[test]
    fn head_fails_closed_after_single_retry_when_still_empty() {
        let calls = std::cell::Cell::new(0u32);
        let (tip, _) = head_with_empty_retry(Some("base-sha"), || {
            calls.set(calls.get() + 1);
            Ok((None, Vec::new()))
        })
        .expect("ok");
        assert_eq!(calls.get(), 2, "exactly one retry, never loops");
        assert!(
            tip.is_none(),
            "still empty -> the caller fences fail-closed"
        );
    }

    #[test]
    fn head_no_retry_for_empty_repo_when_base_none() {
        let calls = std::cell::Cell::new(0u32);
        let (tip, _) = head_with_empty_retry(None, || {
            calls.set(calls.get() + 1);
            Ok((None, Vec::new()))
        })
        .expect("ok");
        assert_eq!(
            calls.get(),
            1,
            "(base None, tip None) is the valid empty repo -> no retry"
        );
        assert!(tip.is_none());
    }

    #[test]
    fn head_no_retry_when_tip_present() {
        let calls = std::cell::Cell::new(0u32);
        let (tip, _) = head_with_empty_retry(Some("base-sha"), || {
            calls.set(calls.get() + 1);
            Ok((Some("tip-sha".to_owned()), Vec::new()))
        })
        .expect("ok");
        assert_eq!(calls.get(), 1, "tip present -> no retry");
        assert_eq!(tip.as_deref(), Some("tip-sha"));
    }

    #[test]
    fn base_commit_sha_advances_only_at_sanctioned_sites() {
        // Tripwire (mirrors the MUTATION_ENTRYPOINTS guard): BASE may change ONLY
        // via the sanctioned triggers. If a count below changes, a base write was
        // added/removed — confirm the new site is a legitimate trigger before
        // updating it. (#192/#193/#197)
        //
        //   mutate `l.base_commit_sha =` (inside speleodb_mutate_link closures):
        //     1. push 200 confirmed — advance to the adopted hexsha
        //     2. push ancestry Landed — advance BASE to tip
        //     3. push ancestry Landed — already-up-to-date sub-case
        //   struct-init `base_commit_sha:` (a fresh SpeleoLink for the pulled file):
        //     1. speleodb_open_project — stamp BASE on pull
        //     2. speleodb_fast_forward — re-stamp BASE = tip after a clean FF
        let src = include_str!("speleodb.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("production region precedes the test module");
        assert_eq!(
            prod.matches("base_commit_sha =").count(),
            3,
            "unexpected BASE mutate-advance count (sanctioned: push-200, ancestry-landed x2)"
        );
        assert_eq!(
            prod.matches("base_commit_sha:").count(),
            2,
            "unexpected BASE stamp count (sanctioned: open-on-pull, fast-forward restamp)"
        );
    }

    #[test]
    fn push_flushes_to_disk_before_snapshotting() {
        // #195 quiescent-point invariant: the push must flush in-memory edits to the
        // live .stalx (save_project) BEFORE taking the VACUUM snapshot, or the
        // uploaded snapshot would miss the last edit (data loss). The snapshot — NOT
        // the live bytes — is then what upload_auto streams. The ordering can't be
        // observed without a client seam, so pin it structurally (like the
        // BASE-advance tripwire); the live round-trips prove the behaviour itself.
        let src = include_str!("speleodb.rs");
        let upload = src
            .split_once("fn speleodb_upload")
            .map(|(_, rest)| rest)
            .and_then(|rest| rest.split("\n    fn ").next())
            .expect("speleodb_upload body precedes the next method");
        let save = upload
            .find("self.save_project(")
            .expect("push flushes via save_project");
        let vacuum = upload
            .find("vacuum_snapshot(")
            .expect("push snapshots via vacuum_snapshot");
        let upload_call = upload
            .find("upload_auto(")
            .expect("push streams via upload_auto");
        assert!(
            save < vacuum,
            "save_project (flush) must precede vacuum_snapshot — the snapshot must be quiescent (#195)"
        );
        assert!(
            vacuum < upload_call,
            "the VACUUM snapshot must be taken before upload_auto streams it (#195)"
        );
    }

    #[test]
    fn push_renders_via_pure_export_tml_not_the_collab_pipeline() {
        // #196 b1 + b5: the push renders the .tml through the PURE export_tml and
        // never routes through the Ariane-collab pipeline — export_tml_with_baseline
        // (whose baseline would be discarded) is not called, and nothing in the push
        // writes the collab sibling, so CollabState / reconcile.rs / sibling-.tml stay
        // untouched. Pin it structurally (like the BASE-advance + quiescent tripwires)
        // since "not called" can't be observed at runtime.
        let src = include_str!("speleodb.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("production region precedes the test module");

        // The render fn body renders via the pure export_tml (the doc comment that
        // mentions export_tml_with_baseline precedes the fn, so a body scan excludes it).
        let render = prod
            .split_once("fn speleodb_render_tml")
            .map(|(_, rest)| rest)
            .and_then(|rest| rest.split("\n    fn ").next())
            .expect("render fn body precedes the next method");
        assert!(
            render.contains("export::tml::export_tml("),
            "the push must render the .tml via the pure export_tml"
        );
        assert!(
            !render.contains("export_tml_with_baseline"),
            "the push render must NOT use the baseline/collab export (the baseline is discarded)"
        );
        // Nothing in the push ever writes the Ariane-collab sibling .tml.
        assert!(
            !prod.contains("write_collab_sibling"),
            "the push must never write the Ariane-collab sibling .tml (#196 b5)"
        );
    }

    #[test]
    fn forget_keeps_local_project_editable() {
        // #197 review: speleodb_forget is the dead-token auto-drop sink — it runs on a
        // 401 from ANY SpeleoDB call (e.g. a background list_projects/refresh). It must
        // NOT turn an open LOCAL project read-only; only a remote edit session loses
        // the gate. (No remote link open here → open_link Err → gate untouched.)
        let state = AppState::new().expect("state");
        assert!(state.edit_enabled(), "local default-true");
        state.speleodb_forget();
        assert!(
            state.edit_enabled(),
            "a 401 auto-drop must not disable editing on a local-only project"
        );
    }

    #[test]
    fn forget_drops_gate_on_remote_edit_session() {
        // ...but a remote edit session (gate on + an open hand-off link) DOES lose the
        // gate, so a token-less session can't keep mutating a project it can't push.
        let temp = TempDir::new().expect("temp");
        let path = temp.path().join("remote.stalx");
        let mut db = Database::open(&path).expect("open db");
        db.save_project(&Project::new("Remote".to_owned(), None))
            .expect("save project");
        db.save_speleo_link(Some(&SpeleoLink {
            endpoint: "http://x/".to_owned(),
            project_id: "11111111-1111-1111-1111-111111111111".to_owned(),
            project_name: "Remote".to_owned(),
            base_commit_sha: Some("abc123".to_owned()),
            has_unpushed_edits: false,
            last_edit_at: None,
        }))
        .expect("save link");
        drop(db);

        let state = AppState::new().expect("state");
        assert!(state.open_project(path).success, "open remote fixture");
        assert!(!state.edit_enabled(), "remote opens read-only");
        state.set_edit_enabled(true); // simulate Start editing acquiring the lock
        state.speleodb_forget();
        assert!(
            !state.edit_enabled(),
            "forget must drop the edit gate on a remote edit session"
        );
    }

    /// A session seeded with an in-memory token (no real keychain). Marked
    /// already-rehydrated so it behaves like a live, established session.
    fn authed_session() -> SpeleoDbSession {
        SpeleoDbSession {
            endpoint: Some("https://x/".to_owned()),
            email: Some("u@x".to_owned()),
            token_store: TokenStore::from_in_memory_token("tok-1"),
            rehydrate_attempted: true,
        }
    }

    #[test]
    fn session_status_reflects_auth_and_gates_keychain_flag() {
        // Authenticated: email surfaced; keychain flag reflects the store (an
        // in-memory token is not keychain-backed).
        let status = authed_session().status();
        assert!(status.logged_in);
        assert_eq!(status.user_email.as_deref(), Some("u@x"));
        assert!(!status.keychain_backed);

        // Not authenticated: no email leaks and keychain_backed is forced false
        // (it is gated on logged_in, so it can't claim a keychain token while
        // reporting logged-out).
        let status = SpeleoDbSession::default().status();
        assert!(!status.logged_in);
        assert_eq!(status.user_email, None);
        assert!(!status.keychain_backed);
    }

    #[test]
    fn forget_clears_session_and_token() {
        let mut session = authed_session();
        assert!(session.status().logged_in);
        session.forget();
        let status = session.status();
        assert!(!status.logged_in);
        assert_eq!(status.user_email, None);
        assert!(session.active_token().is_err());
    }

    // ── [Track C] (#188) C4 rehydration + C5 401-drop unit tests ────────────

    /// A logged-out session whose token store has a keychain (and optional
    /// plaintext) backend pre-seeded, so `rehydrate` can find a token.
    fn fresh_session_with_stores(
        keychain: Box<dyn SecretStore>,
        plaintext: Option<Box<dyn SecretStore>>,
    ) -> SpeleoDbSession {
        SpeleoDbSession {
            endpoint: None,
            email: None,
            token_store: TokenStore::from_stores(keychain, plaintext),
            rehydrate_attempted: false,
        }
    }

    /// A `SecretStore` that shares one `InMemoryStore` behind an `Arc`, so a test
    /// can keep a handle to seed/inspect the store *after* it has been boxed into
    /// a `TokenStore`. `InMemoryStore` is interior-mutable (`Mutex<HashMap>`), so
    /// every op delegates straight through the shared backend.
    struct SharedStore(std::sync::Arc<InMemoryStore>);

    impl SecretStore for SharedStore {
        fn kind(&self) -> &'static str {
            self.0.kind()
        }
        fn store(
            &self,
            account_key: &str,
            token: &str,
        ) -> Result<(), crate::speleodb::auth::SecretStoreError> {
            self.0.store(account_key, token)
        }
        fn load(
            &self,
            account_key: &str,
        ) -> Result<Option<String>, crate::speleodb::auth::SecretStoreError> {
            self.0.load(account_key)
        }
        fn delete(&self, account_key: &str) -> Result<(), crate::speleodb::auth::SecretStoreError> {
            self.0.delete(account_key)
        }
    }

    #[test]
    fn rehydration_seeds_session_from_config_and_keychain() {
        // A keychain holds a prior-run token; rehydrate seeds endpoint+email from
        // "config" and the first load() finds + caches it (the restart fix).
        let endpoint = "https://x/";
        let email = "u@x";
        let keychain = InMemoryStore::new();
        keychain
            .store(
                &crate::speleodb::auth::account_key(endpoint, email),
                "kc-tok",
            )
            .expect("seed keychain");

        let mut session = fresh_session_with_stores(Box::new(keychain), None);
        session.rehydrate(Some(endpoint.to_owned()), Some(email.to_owned()));

        let status = session.status();
        assert!(status.logged_in, "a stored keychain token survives restart");
        assert!(status.keychain_backed);
        assert_eq!(status.user_email.as_deref(), Some(email));
        // The active token resolves to the keychain value.
        let (ep, tok) = session
            .active_token()
            .expect("authenticated after rehydrate");
        assert_eq!(ep, endpoint);
        assert_eq!(tok, "kc-tok");
    }

    #[test]
    fn rehydration_noop_without_config_account() {
        // No persisted account → stays logged-out, and the keychain is NOT probed
        // (no endpoint/email to key it). rehydrate_attempted is still latched so
        // it won't retry every call.
        let mut session = fresh_session_with_stores(Box::new(InMemoryStore::new()), None);
        session.rehydrate(None, None);
        assert!(!session.status().logged_in);
        assert!(session.rehydrate_attempted);

        // A blank endpoint/email also yields a logged-out no-op.
        let mut session = fresh_session_with_stores(Box::new(InMemoryStore::new()), None);
        session.rehydrate(Some("   ".to_owned()), Some(String::new()));
        assert!(!session.status().logged_in);
    }

    #[test]
    fn rehydration_is_idempotent_and_skips_live_session() {
        // Once attempted, a second rehydrate (even with a now-seeded keychain) is
        // a no-op — it won't clobber or re-probe. The `Arc<InMemoryStore>` handle
        // (via the `SharedStore` delegating wrapper below) lets the test seed the
        // keychain *after* the latch is set, proving the latch — not an empty
        // store — is what keeps the second rehydrate logged-out.
        let endpoint = "https://x/";
        let email = "u@x";
        let keychain = std::sync::Arc::new(InMemoryStore::new());

        // First rehydrate with no account: latches `rehydrate_attempted`, probes
        // nothing, stays logged-out.
        let mut session = fresh_session_with_stores(
            Box::new(SharedStore(std::sync::Arc::clone(&keychain))),
            None,
        );
        session.rehydrate(None, None); // marks attempted, finds nothing
        assert!(session.rehydrate_attempted);
        assert!(!session.status().logged_in);

        // Now seed the SAME keychain store (shared via the Arc) with a usable
        // token for this account. A naive re-probe would find it and log in.
        keychain
            .store(
                &crate::speleodb::auth::account_key(endpoint, email),
                "kc-tok",
            )
            .expect("seed keychain after the latch is set");

        // Second rehydrate, this time WITH the account: the latch short-circuits
        // before any seed/probe, so the session stays logged-out and never adopts
        // endpoint/email despite the now-present token. This is the idempotency
        // invariant: `rehydrate_attempted` gates the keychain probe to once.
        session.rehydrate(Some(endpoint.to_owned()), Some(email.to_owned()));
        assert!(
            !session.status().logged_in,
            "the latch must block the re-probe even with a now-seeded keychain"
        );
        assert_eq!(
            session.endpoint, None,
            "a latched rehydrate must not adopt the account or probe the token"
        );

        // A live session (endpoint set) is also skipped.
        let mut live = authed_session();
        live.rehydrate(Some("https://other/".to_owned()), Some("z@z".to_owned()));
        assert_eq!(live.endpoint.as_deref(), Some("https://x/"));
    }

    /// Apply the 401 auto-drop decision to a session the way
    /// `speleodb_handle_auth` does (predicate → full clear), so the C5 effect is
    /// asserted without constructing a full `AppState`. Returns the session for
    /// post-condition checks. [Integration] the predicate now keys off
    /// `map_status(endpoint, status) == ReLogin`; these tests use a read endpoint
    /// (`ListProjects`) where 401→ReLogin, 403→ReadOnly, 5xx→Retry.
    fn apply_auth_drop(session: &mut SpeleoDbSession, result: &Result<(), SpeleoDbError>) {
        if auth_error_drops_token(Endpoint::ListProjects, result) {
            session.forget();
        }
    }

    #[test]
    fn whoami_probe_decision_distinguishes_dead_from_alive() {
        // The pure half of the ambiguous-403 disambiguation: a whoami 403/401
        // (→ ReLogin on the User endpoint) means the token is dead; a whoami
        // success means it is alive (so a resource 403 was a real permission
        // denial — keep it, D-B4); a 5xx / transport probe is inconclusive → not
        // dead (never drop on a flaky probe).
        assert!(whoami_indicates_dead_token(&Err(SpeleoDbError::Status {
            status: 403,
            message: "forbidden".to_owned(),
        })));
        assert!(whoami_indicates_dead_token(&Err(SpeleoDbError::Status {
            status: 401,
            message: "unauthorized".to_owned(),
        })));
        assert!(!whoami_indicates_dead_token(&Ok(
            "user@example.com".to_owned()
        )));
        assert!(!whoami_indicates_dead_token(&Err(SpeleoDbError::Status {
            status: 503,
            message: "server".to_owned(),
        })));
        assert!(!whoami_indicates_dead_token(&Err(
            SpeleoDbError::Transport("timeout".to_owned())
        )));
    }

    #[test]
    fn auth_handler_drops_token_on_401() {
        let mut session = authed_session();
        assert!(session.status().logged_in);
        let result: Result<(), SpeleoDbError> = Err(SpeleoDbError::Status {
            status: 401,
            message: "invalid token".to_owned(),
        });
        assert!(auth_error_drops_token(Endpoint::ListProjects, &result));
        apply_auth_drop(&mut session, &result);
        // Full clear: session is logged out and the token is gone from every tier.
        assert!(!session.status().logged_in);
        assert!(session.active_token().is_err());
    }

    #[test]
    fn auth_handler_keeps_token_on_403() {
        // 403 is NEVER a drop (D-B4: read-only/fence per-endpoint meaning,
        // robust to a DRF 401→403 downgrade).
        let mut session = authed_session();
        let result: Result<(), SpeleoDbError> = Err(SpeleoDbError::Status {
            status: 403,
            message: "forbidden".to_owned(),
        });
        assert!(!auth_error_drops_token(Endpoint::ListProjects, &result));
        apply_auth_drop(&mut session, &result);
        assert!(session.status().logged_in, "403 must not drop the session");
    }

    #[test]
    fn auth_handler_keeps_token_on_2xx_and_5xx() {
        // A successful call and a 5xx both leave the session intact (writes never
        // auto-drop; reads surface for manual retry).
        let ok: Result<(), SpeleoDbError> = Ok(());
        assert!(!auth_error_drops_token(Endpoint::ListProjects, &ok));

        for status in [500u16, 502, 503] {
            let mut session = authed_session();
            let result: Result<(), SpeleoDbError> = Err(SpeleoDbError::Status {
                status,
                message: "server error".to_owned(),
            });
            assert!(!auth_error_drops_token(Endpoint::ListProjects, &result));
            apply_auth_drop(&mut session, &result);
            assert!(
                session.status().logged_in,
                "HTTP {status} must not drop the session"
            );
        }
        // A transport error also never drops.
        let mut session = authed_session();
        let result: Result<(), SpeleoDbError> = Err(SpeleoDbError::Transport("timeout".to_owned()));
        assert!(!auth_error_drops_token(Endpoint::ListProjects, &result));
        apply_auth_drop(&mut session, &result);
        assert!(session.status().logged_in);
    }

    #[test]
    fn validate_project_id_accepts_uuid_rejects_traversal() {
        // A real SpeleoDB project id (UUID) passes.
        assert!(validate_project_id("11111111-1111-1111-1111-111111111111").is_ok());
        // Anything that could escape the cache dir or reshape the request URL is
        // rejected before it reaches the path join / URL interpolation.
        for bad in [
            "",
            "..",
            "../../etc/passwd",
            "/etc/cron.d/evil",
            "a/b",
            "11111111-1111-1111-1111-111111111111/../../etc",
            "not-a-uuid",
        ] {
            assert!(
                matches!(
                    validate_project_id(bad),
                    Err(SpeleoDbError::InvalidProjectId)
                ),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn resolve_endpoint_precedence_and_trimming() {
        // Override wins over env and config (trailing slash is left intact —
        // normalization is account_key's job, not the resolver's).
        assert_eq!(
            resolve_endpoint(
                Some("https://override/"),
                Some("https://env/"),
                Some("https://config/")
            ),
            Some("https://override/".to_owned())
        );
        // A blank override falls through to env.
        assert_eq!(
            resolve_endpoint(Some("   "), Some("https://env/"), Some("https://config/")),
            Some("https://env/".to_owned())
        );
        // Blank override + env fall through to config, which is also trimmed.
        assert_eq!(
            resolve_endpoint(Some(""), Some("  "), Some("  https://config/  ")),
            Some("https://config/".to_owned())
        );
        // Nothing usable anywhere → None.
        assert_eq!(resolve_endpoint(None, None, None), None);
        assert_eq!(resolve_endpoint(Some(""), None, Some("   ")), None);
    }

    #[test]
    fn active_token_requires_endpoint_email_and_token() {
        // Fully populated → Ok((endpoint, token)).
        let mut session = SpeleoDbSession {
            endpoint: Some("https://x/".to_owned()),
            email: Some("u@x".to_owned()),
            token_store: TokenStore::from_in_memory_token("tok-1"),
            rehydrate_attempted: true,
        };
        let (endpoint, token) = session.active_token().expect("authenticated session");
        assert_eq!(endpoint, "https://x/");
        assert_eq!(token, "tok-1");

        // Each missing field independently yields NotAuthenticated. The empty
        // in-memory keychain (NOT TokenStore::default(), which would probe the
        // real OS keychain) keeps this hermetic.
        let mut no_token = SpeleoDbSession {
            endpoint: Some("https://x/".to_owned()),
            email: Some("u@x".to_owned()),
            token_store: TokenStore::from_stores(Box::new(InMemoryStore::new()), None),
            rehydrate_attempted: true,
        };
        assert!(matches!(
            no_token.active_token(),
            Err(SpeleoDbError::NotAuthenticated)
        ));

        let mut no_email = SpeleoDbSession {
            endpoint: Some("https://x/".to_owned()),
            email: None,
            token_store: TokenStore::from_in_memory_token("tok-1"),
            rehydrate_attempted: true,
        };
        assert!(matches!(
            no_email.active_token(),
            Err(SpeleoDbError::NotAuthenticated)
        ));

        let mut no_endpoint = SpeleoDbSession {
            endpoint: None,
            email: Some("u@x".to_owned()),
            token_store: TokenStore::from_in_memory_token("tok-1"),
            rehydrate_attempted: true,
        };
        assert!(matches!(
            no_endpoint.active_token(),
            Err(SpeleoDbError::NotAuthenticated)
        ));
    }

    #[test]
    fn classify_dump_entry_maps_each_arm() {
        assert_eq!(
            classify_dump_entry(&["misc/project.stalx".to_owned()]).expect("single stalx"),
            "misc/project.stalx"
        );
        assert!(matches!(
            classify_dump_entry(&["ariane.tml".to_owned()]),
            Err(SpeleoDbError::AdoptAriane)
        ));
        assert!(matches!(
            classify_dump_entry(&["notes.txt".to_owned()]),
            Err(SpeleoDbError::EmptyDump)
        ));
        assert!(matches!(
            classify_dump_entry(&["a.stalx".to_owned(), "b.stalx".to_owned()]),
            Err(SpeleoDbError::AmbiguousDump(v)) if v.len() == 2
        ));
    }

    // ===================== Live orchestration round-trips (#194/#197) =========
    // AppState driven against the REAL dev box: the full wiring (acquire ->
    // server_head -> fence -> edit gate / fast-forward / push / release) with real
    // server responses — what the offline LoopbackStub cannot reproduce. Gated on
    // DEV_SPELEODB_* + #[ignore]; run with `--ignored --test-threads=1`.

    use crate::core::{AppState, Command};
    use crate::models::ShotData;
    use crate::speleodb::client;
    use crate::speleodb::{DoneResult, StartEditingResult, UpdateResult};
    use std::path::{Path, PathBuf};

    const ORCH_SEED: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../e2e/fixtures/fractal_plant_iter2.stalx"
    );
    const ORCH_SEED_V2: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../e2e/fixtures/fractal_plant_iter3.stalx"
    );
    const ORCH_TML: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/test_simple.tml"
    );

    fn orch_env() -> Option<(String, String, String)> {
        Some((
            std::env::var("DEV_SPELEODB_URL").ok()?,
            std::env::var("DEV_SPELEODB_EMAIL").ok()?,
            std::env::var("DEV_SPELEODB_PASSWORD").ok()?,
        ))
    }

    /// The second pre-provisioned collaborator account (email + password). `None`
    /// when `DEV_SPELEODB_EMAIL2`/`_PASSWORD2` are unset — the two-account tests
    /// skip rather than fail. (That account can't be created over HTTP; see
    /// docs/speleodb-dev-testing.md.)
    fn orch_env2() -> Option<(String, String)> {
        Some((
            std::env::var("DEV_SPELEODB_EMAIL2").ok()?,
            std::env::var("DEV_SPELEODB_PASSWORD2").ok()?,
        ))
    }

    /// Deletes the per-test project on drop (even on panic), so live runs don't leak.
    struct OrchCleanup {
        url: String,
        token: String,
        id: String,
    }
    impl Drop for OrchCleanup {
        fn drop(&mut self) {
            let _ = client::delete_project(&self.url, &self.token, &self.id);
        }
    }

    /// Create a fresh remote project seeded with `stalx` (lock released), returning
    /// its id. The token owner is ADMIN on the new project.
    fn orch_seed(url: &str, token: &str, name: &str, stalx: &str) -> String {
        let id = client::create_project(url, token, false, name)
            .expect("create project")
            .id;
        client::acquire_lock(url, token, false, &id).expect("acquire seed lock");
        client::upload_auto(
            url,
            token,
            false,
            &id,
            Path::new(stalx),
            Path::new(ORCH_TML),
            "seed",
        )
        .expect("seed upload");
        client::release_lock(url, token, false, &id).expect("release seed lock");
        id
    }

    /// Advance the remote tip with a DISTINCT upload (a different fixture → a new
    /// commit), simulating another writer moving HEAD forward after our open.
    fn orch_advance_tip(url: &str, token: &str, id: &str, stalx: &str) {
        client::acquire_lock(url, token, false, id).expect("acquire advance lock");
        client::upload_auto(
            url,
            token,
            false,
            id,
            Path::new(stalx),
            Path::new(ORCH_TML),
            "advance tip",
        )
        .expect("advance upload");
        client::release_lock(url, token, false, id).expect("release advance lock");
    }

    /// A fresh `AppState` whose SpeleoDB session carries a REAL dev-box token.
    fn orch_state(url: &str, email: &str, token: &str) -> AppState {
        // The pull/open path needs a resolved cache dir; without a Tauri runtime
        // point it at a throwaway temp tree.
        crate::app_dirs::init_for_test();
        let state = AppState::new().expect("AppState::new");
        *state.speleodb.lock().expect("session lock") = SpeleoDbSession {
            endpoint: Some(url.to_owned()),
            email: Some(email.to_owned()),
            token_store: TokenStore::from_in_memory_token(token),
            rehydrate_attempted: true,
        };
        state
    }

    /// Read the speleo_link straight from the open project DB.
    fn orch_link(state: &AppState) -> SpeleoLink {
        state
            .database
            .lock()
            .expect("db lock")
            .as_ref()
            .expect("db open")
            .load_speleo_link()
            .expect("load link")
            .expect("link present")
    }

    /// Open a remote project INTO this AppState: run the REAL download + BASE-stamp
    /// pull (`speleodb_open_project`), then load the extracted `.stalx` into state.
    /// The production load (`do_load_project_full`) needs a Wry `AppHandle` we can't
    /// build headless, so we do its essential work directly — open the db + project
    /// and drop the edit gate (a freshly pulled remote project is read-only until
    /// Start editing). The push path reads the same `speleodb_cache_path`, so the
    /// `file_path` we stamp here matches the live `.stalx` the upload snapshots.
    fn orch_open(state: &AppState, id: &str, name: &str) {
        let res = state
            .speleodb_open_project(id.to_owned(), name.to_owned(), None)
            .expect("pull + stamp");
        let path = PathBuf::from(res.local_path);
        let db = Database::open_existing(&path).expect("open extracted .stalx");
        let mut project = db.load_project().expect("load pulled project");
        project.file_path = Some(path);
        *state.database.lock().expect("db lock") = Some(db);
        *state.project.lock().expect("project lock") = Some(project);
        state.set_edit_enabled(false);
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_start_editing_edit_done_advances_base() {
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-roundtrip", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-roundtrip");
        assert!(
            !state.edit_enabled(),
            "a freshly pulled remote project is read-only until Start editing"
        );
        let base_before = orch_link(&state).base_commit_sha;

        // Start editing: clean reconcile -> editable, lock held.
        let started = state.speleodb_start_editing().expect("start_editing");
        assert!(
            matches!(started, StartEditingResult::Editing),
            "clean reconcile should enable editing, got {started:?}"
        );
        assert!(
            state.edit_enabled(),
            "editing enabled after a clean Start editing"
        );
        // #194 b1: acquire takes the mutex only; a clean (UpToDate) reconcile must
        // NOT move BASE. Only a confirmed push (below) advances it.
        assert_eq!(
            orch_link(&state).base_commit_sha,
            base_before,
            "acquire + clean reconcile must not move BASE"
        );

        // A real survey edit (new section) -> dirty bit set + content changed.
        assert!(
            state
                .execute(Command::CreateSection {
                    name: Some("orch-edit".to_owned()),
                    surveyor: None,
                    date: None,
                    color: "#abcdef".to_owned(),
                    direction: None,
                    shots: vec![ShotData {
                        length: 5.0,
                        ..Default::default()
                    }],
                })
                .success,
            "edit succeeds while editing"
        );
        assert!(
            orch_link(&state).has_unpushed_edits,
            "edit marks the project dirty"
        );

        // Done: push (200, new content) + release -> base advances, dirty cleared,
        // read-only again.
        let done = state.speleodb_done(None).expect("done");
        assert!(
            matches!(done, DoneResult::Released),
            "a confirmed push then release should report Released, got {done:?}"
        );
        assert!(!state.edit_enabled(), "read-only again after Done");
        let after = orch_link(&state);
        assert!(
            !after.has_unpushed_edits,
            "dirty cleared after a confirmed push"
        );
        assert!(
            after.base_commit_sha.is_some(),
            "BASE is the adopted hexsha"
        );
        assert_ne!(
            after.base_commit_sha, base_before,
            "BASE advanced to the new commit after a 200 push"
        );
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_update_up_to_date_on_fresh_open() {
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-update-utd", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-update-utd");
        // Freshly opened at the tip -> Update is a no-op.
        let r = state.speleodb_update().expect("update");
        assert!(
            matches!(r, UpdateResult::UpToDate),
            "a fresh open is up to date, got {r:?}"
        );
    }

    // NOTE on fast-forward coverage: the FF *decision* (clean local + moved tip ->
    // FastForward) is exhaustively unit-tested in `sync.rs` (fence/ancestry). Its
    // *execution* re-pulls and reloads via `do_load_project_full`, which hard-requires
    // a Wry `AppHandle` (progress events) that can't be built in a headless test —
    // so a live FF orchestration test is intentionally omitted here rather than
    // asserting a test-environment artifact.

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_update_diverges_when_dirty_and_tip_moved() {
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-diverge", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-diverge");
        // Local un-pushed edits...
        state.mark_remote_dirty();
        // ...AND the tip moved underneath us -> a genuine fork, never an overwrite.
        orch_advance_tip(&url, &token, &id, ORCH_SEED_V2);

        let r = state.speleodb_update().expect("update");
        assert!(
            matches!(r, UpdateResult::DivergenceNeeded),
            "dirty + moved tip must route to divergence, got {r:?}"
        );
        // Update never overwrites: the dirty bit is still set, awaiting resolution.
        assert!(
            orch_link(&state).has_unpushed_edits,
            "divergence keeps local edits (no blind overwrite)"
        );
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_open_flags_concurrent_same_account_lock() {
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-concurrent", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);

        // No lock held at open -> no concurrent-session notice (#193 b8).
        let unlocked = state
            .speleodb_open_project(id.clone(), "orch-concurrent".to_owned(), None)
            .expect("open (unlocked)");
        assert!(
            !unlocked.concurrent_session,
            "no lock held -> no concurrent-session notice"
        );

        // Our OWN account now holds the lock (a second same-account session): the
        // next open must warn, because the ancestry self-heal can't tell that
        // session's commits from ours.
        client::acquire_lock(&url, &token, false, &id).expect("acquire as same account");
        let locked = state
            .speleodb_open_project(id.clone(), "orch-concurrent".to_owned(), None)
            .expect("reopen (same-account lock held)");
        assert!(
            locked.concurrent_session,
            "a same-account lock-hold at open must raise the notice"
        );
        client::release_lock(&url, &token, false, &id).expect("release");
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_start_editing_diverges_on_unreconcilable_base() {
        // The dev server's history is structurally linear, so it can't produce a
        // merge / multi-root. A BASE that is not an ancestor of the tip drives the
        // SAME "can't reconcile -> divergence" routing (#193 b2): Start editing must
        // surface the divergence PROMPT (never a hard error) and release the lock it
        // just took, not strand it.
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-se-diverge", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-se-diverge");
        // Forge an un-reconcilable BASE: a real-shaped SHA absent from history, so
        // base_is_ancestor_of_tip() is false and the verdict is Diverged.
        state
            .speleodb_mutate_link(|l| l.base_commit_sha = Some("0".repeat(40)))
            .expect("forge stale base");

        let r = state.speleodb_start_editing().expect("start_editing");
        assert!(
            matches!(r, StartEditingResult::DivergenceNeeded),
            "an unreconcilable base must route to the divergence prompt, got {r:?}"
        );
        assert!(!state.edit_enabled(), "divergence must not enable editing");
        // The lock taken during Start editing must be released on divergence.
        let holder = client::get_project(&url, &token, false, &id)
            .ok()
            .and_then(|p| p.active_mutex.map(|m| m.user));
        assert!(
            holder.is_none(),
            "the freshly-taken lock must be released on divergence, still held by {holder:?}"
        );
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_pushed_snapshot_carries_no_undo_history() {
        // #194 b3: an edit builds local undo history; after Done (push), the copy
        // the SERVER stores must carry NO undo/redo — so any collaborator adopting
        // it starts with a clean slate (never inheriting + replaying the pusher's
        // edit history, a data-corruption vector).
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-undo", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-undo");
        let live_path = state
            .project
            .lock()
            .expect("project lock")
            .as_ref()
            .and_then(|p| p.file_path.clone())
            .expect("open project has a file path");

        state.speleodb_start_editing().expect("start_editing");
        assert!(
            state
                .execute(Command::CreateSection {
                    name: Some("undo-edit".to_owned()),
                    surveyor: None,
                    date: None,
                    color: "#abcdef".to_owned(),
                    direction: None,
                    shots: vec![ShotData {
                        length: 5.0,
                        ..Default::default()
                    }],
                })
                .success,
            "edit succeeds while editing"
        );
        state.speleodb_done(None).expect("done");

        // Sanity: the LOCAL file kept the editor's undo (only the uploaded snapshot
        // is sanitized, never the live file).
        let live_undo = Database::open_existing(&live_path)
            .expect("open live")
            .load_undo_stack_with_timestamps()
            .expect("load live undo");
        assert!(
            !live_undo.is_empty(),
            "sanity: the editor accumulated undo history locally"
        );

        // Re-download the SERVER's copy: it must carry NO undo/redo (the strip).
        let server = state
            .speleodb_open_project(id.clone(), "orch-undo".to_owned(), None)
            .expect("re-download server copy");
        let server_db =
            Database::open_existing(Path::new(&server.local_path)).expect("open server copy");
        assert!(
            server_db
                .load_undo_stack_with_timestamps()
                .expect("load server undo")
                .is_empty(),
            "the pushed snapshot must carry no undo history (#194 b3)"
        );
        assert!(
            server_db
                .load_redo_stack_with_timestamps()
                .expect("load server redo")
                .is_empty(),
            "the pushed snapshot must carry no redo history (#194 b3)"
        );
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* + _EMAIL2/_PASSWORD2 (run with --ignored --test-threads=1)"]
    fn live_orch_start_editing_reports_locked_by_other_account() {
        // #194 b5: a contended acquire (HTTP 400 — lock held by someone else) maps
        // to StartEditingResult::LockedBy{email}, surfacing WHO holds it, not an
        // error. Needs the second collaborator account.
        let (Some((url, owner_email, owner_pw)), Some((email2, pw2))) = (orch_env(), orch_env2())
        else {
            return;
        };
        let owner = client::login(&url, false, &owner_email, &owner_pw).expect("owner login");
        let id = orch_seed(&url, &owner, "orch-lockedby", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: owner.clone(),
            id: id.clone(),
        };
        client::grant_permission(&url, &owner, &id, &email2, "READ_AND_WRITE")
            .expect("grant collaborator write access");

        // The owner opens the project read-only...
        let state = orch_state(&url, &owner_email, &owner);
        orch_open(&state, &id, "orch-lockedby");

        // ...meanwhile the OTHER account takes the lock.
        let collab = client::login(&url, false, &email2, &pw2).expect("collaborator login");
        client::acquire_lock(&url, &collab, false, &id).expect("collaborator acquires the mutex");

        // The owner's Start editing now contends -> LockedBy{the collaborator}.
        let r = state.speleodb_start_editing().expect("start_editing");
        assert!(
            matches!(&r, StartEditingResult::LockedBy { email } if email.as_deref() == Some(email2.as_str())),
            "expected LockedBy{{{email2}}}, got {r:?}"
        );
        assert!(
            !state.edit_enabled(),
            "a contended Start editing must not enable editing"
        );

        // Release the collaborator's lock so cleanup's delete isn't fighting it.
        let _ = client::release_lock(&url, &collab, false, &id);
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_pushed_dump_is_self_contained_without_sidecars() {
        // #195 end-to-end against the real server: after a Done push, the dump the
        // server STORED must be exactly the VACUUM snapshot — one self-contained
        // `.stalx` (opens via open_existing with the pushed edit) co-pushed with the
        // `ariane.tml`, and NO `-wal`/`-journal`/`-shm` sidecar ever rode along
        // (bullets 1/2/3). The cache `.stalx` is default DELETE journal mode, so this
        // also exercises the push pipeline under DELETE (bullet 4 DELETE); the WAL
        // case is a client-local vacuum concern covered by vacuum_snapshot_under_wal_mode.
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-dump", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-dump");
        state.speleodb_start_editing().expect("start_editing");
        assert!(
            state
                .execute(Command::CreateSection {
                    name: Some("dump-edit".to_owned()),
                    surveyor: None,
                    date: None,
                    color: "#abcdef".to_owned(),
                    direction: None,
                    shots: vec![ShotData {
                        length: 5.0,
                        ..Default::default()
                    }],
                })
                .success,
            "edit succeeds while editing"
        );
        state.speleodb_done(None).expect("done");

        // Inspect the archive the server now holds.
        let zip = client::download_dump(&url, &token, false, &id).expect("download dump");
        let mut dump = crate::speleodb::dump::Dump::open(&zip).expect("open server dump");
        let entries = dump.entry_paths().expect("dump entry paths");

        // (3) no SQLite journal sidecar ever left the client.
        for entry in &entries {
            for suffix in ["-wal", "-journal", "-shm"] {
                assert!(
                    !entry.ends_with(suffix),
                    "no sqlite sidecar may ride to the server: {entry} in {entries:?}"
                );
            }
        }
        // Exactly one `.stalx` (the snapshot) — never the ambiguous multi-.stalx shape.
        let stalx_count = entries.iter().filter(|e| e.ends_with(".stalx")).count();
        assert_eq!(
            stalx_count, 1,
            "the server dump must hold exactly one .stalx, got {entries:?}"
        );
        // (#196 b2/b3/b5) the .tml is co-pushed, lands as `ariane.tml`, and is the
        // ONLY .tml — no Ariane-collab sibling rode along.
        assert!(
            entries.iter().any(|e| e.ends_with("ariane.tml")),
            "the render must be co-pushed as ariane.tml, got {entries:?}"
        );
        let tml_count = entries.iter().filter(|e| e.ends_with(".tml")).count();
        assert_eq!(
            tml_count, 1,
            "exactly one .tml (ariane.tml) — no collab sibling rode along, got {entries:?}"
        );

        // (1/2) it extracts + opens as a SELF-CONTAINED DB carrying the pushed edit.
        let entry = classify_dump_entry(&entries).expect("classify the dump");
        let temp = TempDir::new().expect("temp dir");
        let out = temp.path().join("server_snap.stalx");
        dump.extract_entry_to(&entry, &out).expect("extract .stalx");
        for suffix in ["-wal", "-journal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", out.to_string_lossy()));
            assert!(
                !sidecar.exists(),
                "the extracted snapshot must be self-contained: {sidecar:?} must not exist"
            );
        }
        let server_db =
            Database::open_existing(&out).expect("server snapshot opens self-contained");
        let project = server_db
            .load_project()
            .expect("load project from server snapshot");
        assert!(
            project
                .sections
                .iter()
                .any(|s| s.name.as_deref() == Some("dump-edit")),
            "the pushed edit must be present in the server's self-contained snapshot"
        );
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_pushed_tml_byte_stable_vs_rerender() {
        // #196 b4 end-to-end: the ariane.tml the server STORED must be byte-identical
        // to a fresh local re-render of the same (UUID-minted) project. The render is
        // deterministic — the one-time shot-UUID pass ran on push — so re-pushing
        // unchanged content never churns the .tml. (The offline byte-stability test
        // proves export_tml is deterministic; this proves the bytes the server holds
        // are exactly that deterministic render, intact through the round-trip.)
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-tmlstable", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-tmlstable");
        state.speleodb_start_editing().expect("start_editing");
        assert!(
            state
                .execute(Command::CreateSection {
                    name: Some("tml-edit".to_owned()),
                    surveyor: None,
                    date: None,
                    color: "#abcdef".to_owned(),
                    direction: None,
                    shots: vec![ShotData {
                        length: 5.0,
                        ..Default::default()
                    }],
                })
                .success,
            "edit succeeds while editing"
        );
        state.speleodb_done(None).expect("done");

        // Pull the ariane.tml the server now holds.
        let zip = client::download_dump(&url, &token, false, &id).expect("download dump");
        let mut dump = crate::speleodb::dump::Dump::open(&zip).expect("open server dump");
        let entries = dump.entry_paths().expect("dump entry paths");
        let tml_entry = entries
            .iter()
            .find(|e| e.ends_with("ariane.tml"))
            .expect("ariane.tml present in the dump");
        let temp = TempDir::new().expect("temp dir");
        let server_tml = temp.path().join("server.tml");
        dump.extract_entry_to(tml_entry, &server_tml)
            .expect("extract server ariane.tml");

        // Re-render the same in-memory project (UUIDs were minted + persisted on push).
        let project = state
            .project
            .lock()
            .expect("project lock")
            .as_ref()
            .expect("open project")
            .clone();
        let rerender = temp.path().join("rerender.tml");
        crate::export::tml::export_tml(&project, &rerender).expect("re-render .tml");

        assert_eq!(
            std::fs::read(&server_tml).expect("read server ariane.tml"),
            std::fs::read(&rerender).expect("read re-rendered .tml"),
            "the stored ariane.tml must be byte-identical to a fresh re-render (#196 b4)"
        );
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_done_without_edits_skips_push_and_releases() {
        // #197 b1: a non-dirty Done must push NOTHING (the dirty-bit gate skips the
        // upload) yet still release the lock back to read-only — no empty commit.
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-noedit", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-noedit");
        let started = state.speleodb_start_editing().expect("start_editing");
        assert!(
            matches!(started, StartEditingResult::Editing),
            "clean reconcile should enable editing, got {started:?}"
        );
        assert!(
            !orch_link(&state).has_unpushed_edits,
            "no edits made yet → the session is not dirty"
        );
        let base_before = orch_link(&state).base_commit_sha;

        // Commit count BEFORE the no-op Done.
        let (_, before) = state
            .speleodb_server_head(&url, &token, false, &id)
            .expect("revisions before Done");

        let done = state.speleodb_done(None).expect("done");
        assert!(
            matches!(done, DoneResult::Released),
            "a non-dirty Done releases (push skipped), got {done:?}"
        );
        assert!(!state.edit_enabled(), "read-only again after Done");
        assert_eq!(
            orch_link(&state).base_commit_sha,
            base_before,
            "a skipped push must not advance BASE"
        );

        // No commit was pushed.
        let (_, after) = state
            .speleodb_server_head(&url, &token, false, &id)
            .expect("revisions after Done");
        assert_eq!(
            before.len(),
            after.len(),
            "a non-dirty Done must push no commit (got {} -> {})",
            before.len(),
            after.len()
        );
    }

    #[test]
    #[ignore = "hits the live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored --test-threads=1)"]
    fn live_orch_ambiguous_upload_preserves_dirty_bit() {
        // #197 b5: an ambiguous push (transport drop / exhausted 5xx — we never learn
        // whether it landed) must NOT clear the dirty bit or advance BASE; the
        // un-pushed edits survive for ancestry recovery (g7) on the next Done. Forced
        // by pointing the UPLOAD at a dead port (connection refused -> Transport ->
        // StayDirty) while reusing a live-opened project for the real flush/snapshot.
        let Some((url, email, password)) = orch_env() else {
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let id = orch_seed(&url, &token, "orch-ambig", ORCH_SEED);
        let _cleanup = OrchCleanup {
            url: url.clone(),
            token: token.clone(),
            id: id.clone(),
        };

        let state = orch_state(&url, &email, &token);
        orch_open(&state, &id, "orch-ambig");

        // Make the session dirty (simulate an un-pushed edit): mark_remote_dirty stamps
        // the bit + last_edit_at together, exactly as a real edit would.
        state
            .speleodb_mutate_link(|l| {
                l.has_unpushed_edits = true;
                l.last_edit_at = Some("2020-01-01T00:00:00+00:00".to_owned());
            })
            .expect("mark dirty");
        let link = orch_link(&state);
        let base_before = link.base_commit_sha.clone();
        assert!(
            link.has_unpushed_edits,
            "precondition: the session is dirty"
        );

        // Upload to a dead endpoint -> transport failure -> ambiguous outcome.
        let outcome = state
            .speleodb_upload("http://127.0.0.1:1/", &token, false, &link, None)
            .expect("an ambiguous upload returns an outcome, not a hard error");
        assert!(
            matches!(outcome, PushOutcome::Unconfirmed),
            "an ambiguous push must report Unconfirmed, got {outcome:?}"
        );

        // The dirty bit + BASE survive untouched, so the edits aren't dropped.
        let after = orch_link(&state);
        assert!(
            after.has_unpushed_edits,
            "an ambiguous push must leave the file dirty (#197 b5)"
        );
        assert_eq!(
            after.base_commit_sha, base_before,
            "an ambiguous push must not advance BASE (#197 b5)"
        );
    }
}
