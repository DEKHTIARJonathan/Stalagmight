//! Orchestration tying the `crate::speleodb` primitives (HTTP client, token
//! store, dump handling) to `AppState`, config, and the app cache directory.
//!
//! The `commands::speleodb` IPC layer is a thin wrapper over these methods.
//! Everything here is read-only against the server (login / list / pull); no
//! lock, push, or persistence — those are later issues (#182 epic).

use std::path::PathBuf;

use super::AppState;
use crate::speleodb::auth::TokenStore;
use crate::speleodb::client;
use crate::speleodb::dump::{self, DumpClassification};
use crate::speleodb::models::SpeleoProjectSummary;
use crate::speleodb::{SpeleoDbError, SpeleoLoginResult, SpeleoOpenResult, SpeleoSessionStatus};

/// Per-session SpeleoDB connection state held in [`AppState`]. The token lives
/// inside [`TokenStore`] (keychain or in-memory fallback) and is never exposed
/// to the webview.
#[derive(Debug, Default)]
pub(crate) struct SpeleoDbSession {
    endpoint: Option<String>,
    email: Option<String>,
    token_store: TokenStore,
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

impl SpeleoDbSession {
    /// Resolve the active `(endpoint, token)` for this session, or
    /// [`SpeleoDbError::NotAuthenticated`] if endpoint, email, or token is
    /// missing. Extracted from [`AppState::speleodb_active_token`] so the branch
    /// logic is testable without a full `AppState`.
    fn active_token(&self) -> Result<(String, String), SpeleoDbError> {
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
    /// revoked server-side is only caught on the next real call; 401 auto-drop is
    /// #188). When not logged in, neither the email nor the keychain flag is
    /// surfaced, so the status can never claim a keychain-backed token while
    /// reporting logged-out.
    fn status(&self) -> SpeleoSessionStatus {
        let logged_in = self.active_token().is_ok();
        SpeleoSessionStatus {
            user_email: logged_in.then(|| self.email.clone()).flatten(),
            keychain_backed: logged_in && self.token_store.keychain_backed(),
            logged_in,
        }
    }

    /// Forget the local token (keychain + in-memory) and clear the session. No
    /// server-side call — logout is purely local (the DRF token is not revoked).
    fn forget(&mut self) {
        if let (Some(endpoint), Some(email)) = (self.endpoint.clone(), self.email.clone()) {
            self.token_store.clear(&endpoint, &email);
        }
        self.endpoint = None;
        self.email = None;
    }
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

    fn speleodb_session_lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, SpeleoDbSession>, SpeleoDbError> {
        self.speleodb
            .lock()
            .map_err(|_| SpeleoDbError::Io("SpeleoDB session lock poisoned".to_owned()))
    }

    /// Resolve the active `(endpoint, token)` for an authenticated call, or
    /// [`SpeleoDbError::NotAuthenticated`] if there is no usable token.
    fn speleodb_active_token(&self) -> Result<(String, String), SpeleoDbError> {
        self.speleodb_session_lock()?.active_token()
    }

    /// Report whether a usable token is held (and for whom), so the dialog can
    /// restore the project list on reopen instead of forcing a re-login. The
    /// token itself never leaves the backend.
    pub(crate) fn speleodb_session_status(&self) -> Result<SpeleoSessionStatus, SpeleoDbError> {
        Ok(self.speleodb_session_lock()?.status())
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
    ) -> Result<SpeleoLoginResult, SpeleoDbError> {
        // Only a user-supplied endpoint (the dialog override) is persisted; the env
        // default must not leak into the saved config (see speleodb_persist_account).
        let persist_endpoint = override_endpoint
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_owned);

        let endpoint = self
            .speleodb_resolve_endpoint(override_endpoint.as_deref())
            .ok_or(SpeleoDbError::NoEndpoint)?;

        // Two login modes, each yielding both the token and the *authoritative*
        // account email used for the session/keychain key:
        // - Pasted token: the email is NOT typed (it can't be trusted), so derive
        //   it from `GET /user/`. That call also validates the token (a bad token
        //   401s here instead of silently slipping through to the first list call).
        // - Email + password: the auth-token exchange verifies the pair, so the
        //   typed email is authoritative by construction.
        let (token, email) =
            if let Some(t) = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
                let email = client::fetch_user_email(&endpoint, &t)?;
                (t, email)
            } else {
                let email = email.map(|e| e.trim().to_owned()).unwrap_or_default();
                let password = password.unwrap_or_default();
                // Reject blank credentials at the boundary rather than POSTing them
                // and relying on the server to 400.
                if email.is_empty() || password.is_empty() {
                    return Err(SpeleoDbError::MissingCredentials);
                }
                let token = client::login(&endpoint, &email, &password)?;
                (token, email)
            };

        let keychain_backed = {
            let mut session = self.speleodb_session_lock()?;
            // If a *different* account is already active, forget it first so its
            // keychain entry isn't orphaned. (The UI logs out before re-login, but
            // the backend shouldn't depend on that; a same-account re-login just
            // overwrites the existing entry.)
            let switching = session.endpoint.as_deref() != Some(endpoint.as_str())
                || session.email.as_deref() != Some(email.as_str());
            if switching {
                session.forget();
            }
            let backed = session.token_store.store(&endpoint, &email, &token);
            session.endpoint = Some(endpoint.clone());
            session.email = Some(email.clone());
            backed
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
    ) -> Result<Vec<SpeleoProjectSummary>, SpeleoDbError> {
        let (endpoint, token) = self.speleodb_active_token()?;
        let projects = client::list_projects(&endpoint, &token)?;
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
    ) -> Result<SpeleoOpenResult, SpeleoDbError> {
        // Validate the id at the trust boundary, before it reaches the download
        // URL or the cache-path join (closes the path/route-traversal vector).
        validate_project_id(&project_id)?;
        let (endpoint, token) = self.speleodb_active_token()?;
        let zip = client::download_dump(&endpoint, &token, &project_id)?;

        // Open the dump once: list entries (to classify) and extract the chosen
        // `.stalx` from the same parsed archive.
        let mut dump = dump::Dump::open(&zip)?;
        let entry = classify_dump_entry(&dump.entry_paths()?)?;

        let dest = self.speleodb_cache_path(&project_id)?;
        dump.extract_entry_to(&entry, &dest)?;

        // [Track B] (#189, D-B9) Stamp the SpeleoDB hand-off link into the pulled
        // `.stalx`. Opening via `open_existing` runs `ensure_schema_version`,
        // which creates the v9 `speleo_link` table on the freshly-extracted file;
        // then upsert the single row. `base_commit_sha` = the pulled SHA (NULL /
        // None for an empty repo). After this, `load_metadata().is_remote` is
        // true and the dirty bit (`has_unpushed_edits`) starts false.
        match crate::persistence::Database::open_existing(&dest) {
            Ok(db) => {
                let link = crate::models::SpeleoLink {
                    endpoint: endpoint.clone(),
                    project_id: project_id.clone(),
                    project_name,
                    base_commit_sha: latest_commit_sha,
                    has_unpushed_edits: false,
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
        })
    }

    /// Forget the local token (keychain + in-memory) and clear the session. No
    /// server-side call — logout is purely local (the DRF token is not revoked).
    pub(crate) fn speleodb_logout(&self) -> Result<(), SpeleoDbError> {
        self.speleodb_session_lock()?.forget();
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
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use super::{classify_dump_entry, resolve_endpoint, validate_project_id, SpeleoDbSession};
    use crate::speleodb::auth::TokenStore;
    use crate::speleodb::SpeleoDbError;

    /// A session seeded with an in-memory token (no real keychain).
    fn authed_session() -> SpeleoDbSession {
        SpeleoDbSession {
            endpoint: Some("https://x/".to_owned()),
            email: Some("u@x".to_owned()),
            token_store: TokenStore::from_in_memory_token("tok-1"),
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
        let session = SpeleoDbSession {
            endpoint: Some("https://x/".to_owned()),
            email: Some("u@x".to_owned()),
            token_store: TokenStore::from_in_memory_token("tok-1"),
        };
        let (endpoint, token) = session.active_token().expect("authenticated session");
        assert_eq!(endpoint, "https://x/");
        assert_eq!(token, "tok-1");

        // Each missing field independently yields NotAuthenticated (none of these
        // reach the keychain — the in-memory store has no token / is short-circuited).
        let no_token = SpeleoDbSession {
            endpoint: Some("https://x/".to_owned()),
            email: Some("u@x".to_owned()),
            token_store: TokenStore::default(),
        };
        assert!(matches!(
            no_token.active_token(),
            Err(SpeleoDbError::NotAuthenticated)
        ));

        let no_email = SpeleoDbSession {
            endpoint: Some("https://x/".to_owned()),
            email: None,
            token_store: TokenStore::from_in_memory_token("tok-1"),
        };
        assert!(matches!(
            no_email.active_token(),
            Err(SpeleoDbError::NotAuthenticated)
        ));

        let no_endpoint = SpeleoDbSession {
            endpoint: None,
            email: Some("u@x".to_owned()),
            token_store: TokenStore::from_in_memory_token("tok-1"),
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
}
