//! SpeleoDB integration — P0 read-only spike (#183).
//!
//! Proves the read-only half of the single-writer hand-off: log in, list
//! projects, download a project "dump", extract the `.stalx`, and open it
//! locally. No lock, no real push, no SpeleoLink persistence, no edit gate —
//! those are later issues (see the epic, #182).
//!
//! Layout:
//! - [`client`] — the ureq HTTP surface (Bearer auth, retry/timeout idiom).
//! - [`auth`]   — backend-only token storage (OS keychain + in-memory fallback).
//! - [`dump`]   — ZIP dump classification + `.stalx` extraction.
//! - [`models`] — serde DTOs + the IPC-facing summary types.
//!
//! The orchestration that ties these to `AppState`/config/app-dirs lives in
//! `core::state::speleodb`; the IPC commands are in `commands::speleodb`.

pub(crate) mod auth;
pub(crate) mod client;
// [Track A] #186 status→action contract (pure map_status + ts-rs SpeleoDbAction).
pub(crate) mod contract;
pub(crate) mod dump;
pub mod models;
// [Track A] #187 http/https private-network TLS policy (pure classify_addr + enforce).
pub(crate) mod tls;

// [Track A] #186/D-B2: SpeleoDbAction + the structured SpeleoErrorDto cross IPC.
pub use contract::SpeleoDbAction;
pub use models::{
    Permission, SpeleoErrorDto, SpeleoLoginResult, SpeleoOpenResult, SpeleoProjectSummary,
    SpeleoSessionStatus,
};

/// Errors from the SpeleoDB client and dump handling.
///
/// Shaped so the status→action decision table (#186) can branch on
/// [`SpeleoDbError::Status`] without re-parsing message strings.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SpeleoDbError {
    /// No token is available — the user is not logged in (or the token was dropped).
    #[error("not logged in to SpeleoDB")]
    NotAuthenticated,
    /// No endpoint is configured (no `DEV_SPELEODB_URL`, no saved config).
    #[error("SpeleoDB endpoint is not configured")]
    NoEndpoint,
    /// Password login was attempted without both an email and a password (and
    /// without a pasted token). Rejected at the boundary rather than POSTing
    /// blank credentials and relying on the server to 400.
    #[error("email and password are required to log in")]
    MissingCredentials,
    /// A transport-level failure (DNS, timeout, connection reset, body read).
    #[error("network error talking to SpeleoDB: {0}")]
    Transport(String),
    /// The server returned a non-2xx status. `status` is the HTTP code; `message`
    /// is a best-effort detail parsed from the body.
    #[error("SpeleoDB returned HTTP {status}: {message}")]
    Status { status: u16, message: String },
    /// A response (or dump) could not be parsed into the expected shape.
    #[error("invalid response from SpeleoDB: {0}")]
    Parse(String),
    /// The dump contained no openable project and no Ariane sidecar.
    #[error("the project dump contained nothing to open")]
    EmptyDump,
    /// The dump held an `ariane.tml` but no `.stalx` — route to adoption (#214).
    #[error("the project is an Ariane (.tml) project; adoption is not yet supported (#214)")]
    AdoptAriane,
    /// The dump held more than one `.stalx` — ambiguous; fail closed.
    #[error("the project dump contained multiple .stalx files: {0:?}")]
    AmbiguousDump(Vec<String>),
    /// A local filesystem error while extracting/writing.
    #[error("filesystem error: {0}")]
    Io(String),
    /// The project id supplied over IPC was not a valid SpeleoDB project UUID.
    /// Guards the cache-path join and request-URL interpolation against path /
    /// route traversal at the trust boundary.
    #[error("invalid SpeleoDB project id")]
    InvalidProjectId,
    // [Track A] #187: the endpoint scheme/host failed the http private-network
    // policy (public `http://`, a missing/unknown scheme, or an unresolvable
    // host). Non-retryable by construction — `tls::enforce` errors before any
    // request attempt, so `with_retry` never loops on it.
    #[error("refusing to use an insecure SpeleoDB endpoint: {endpoint}")]
    InsecureEndpoint { endpoint: String },
}

#[cfg(test)]
mod tests {
    use super::SpeleoDbError;

    #[test]
    fn error_display_strings_are_stable() {
        // These messages are the human-facing surface (and the #186 status→action
        // table keys off `Status`); pin them so they can't drift silently.
        assert_eq!(
            SpeleoDbError::NotAuthenticated.to_string(),
            "not logged in to SpeleoDB"
        );
        assert_eq!(
            SpeleoDbError::NoEndpoint.to_string(),
            "SpeleoDB endpoint is not configured"
        );
        assert_eq!(
            SpeleoDbError::Status {
                status: 404,
                message: "not found".to_owned(),
            }
            .to_string(),
            "SpeleoDB returned HTTP 404: not found"
        );
        assert_eq!(
            SpeleoDbError::EmptyDump.to_string(),
            "the project dump contained nothing to open"
        );
        assert_eq!(
            SpeleoDbError::InvalidProjectId.to_string(),
            "invalid SpeleoDB project id"
        );
        assert_eq!(
            SpeleoDbError::MissingCredentials.to_string(),
            "email and password are required to log in"
        );
        assert_eq!(
            SpeleoDbError::AmbiguousDump(vec!["a.stalx".to_owned(), "b.stalx".to_owned()])
                .to_string(),
            "the project dump contained multiple .stalx files: [\"a.stalx\", \"b.stalx\"]"
        );
        // [Track A] #187: the insecure-endpoint message is the human-facing
        // surface for a blocked public-http / scheme-less endpoint; pin it.
        assert_eq!(
            SpeleoDbError::InsecureEndpoint {
                endpoint: "http://example.com".to_owned(),
            }
            .to_string(),
            "refusing to use an insecure SpeleoDB endpoint: http://example.com"
        );
    }
}

#[cfg(test)]
mod live_tests {
    //! Env-gated live tests against a real SpeleoDB box. `#[ignore]` so they
    //! never run in normal `cargo test`/CI; run explicitly with:
    //!   DEV_SPELEODB_URL=… DEV_SPELEODB_EMAIL=… DEV_SPELEODB_PASSWORD=… \
    //!   cargo test -p stalagmight speleodb -- --ignored
    //! Each test creates throwaway projects per run and deletes them on the way
    //! out (see `ProjectCleanup`), so it owns its own state. The two-account
    //! tests additionally need a pre-provisioned, email-verified collaborator via
    //! `DEV_SPELEODB_EMAIL2`/`_PASSWORD2` (that account can't be created over
    //! HTTP) and skip when those are absent. See `docs/speleodb-dev-testing.md`.
    //!
    //! Env-var tiers (each test early-returns/skips cleanly when its tier's vars
    //! are absent — they NEVER run in CI, there is no dev box there):
    //! - **URL-only** (needs `DEV_SPELEODB_URL`): `live_bad_credentials_returns_400`,
    //!   `live_missing_auth_header_returns_403`, `live_dead_token_returns_401`,
    //!   `live_http_to_public_blocked` (the public-host block needs no box at all).
    //! - **Single-account** (needs `DEV_SPELEODB_URL` + `_EMAIL` + `_PASSWORD`, via
    //!   `live_env()`): `live_round_trip_seed_pull_open`,
    //!   `live_fetch_user_email_matches_token_owner`,
    //!   `live_upload_200_returns_hexsha_and_project`, `live_upload_304_when_unchanged`,
    //!   `live_upload_422_missing_revision`, `live_stalx_round_trips_through_auto`,
    //!   `live_auto_rejects_unknown_extension_canary`, `live_http_to_private_box_allowed`.
    //! - **Two-account** (additionally needs `DEV_SPELEODB_EMAIL2` + `_PASSWORD2`,
    //!   via `live_env2()`): `live_collaborator_sees_read_only_label`,
    //!   `live_web_viewer_cannot_download`, `live_lock_holder_reflects_other_user`,
    //!   `live_no_permission_field_absent`, `live_acquire_contended_returns_400`,
    //!   `live_acquire_no_perm_returns_403`.

    use super::dump::{self, DumpClassification};
    use super::{client, Permission, SpeleoDbError, SpeleoProjectSummary};

    fn live_env() -> Option<(String, String, String)> {
        Some((
            std::env::var("DEV_SPELEODB_URL").ok()?,
            std::env::var("DEV_SPELEODB_EMAIL").ok()?,
            std::env::var("DEV_SPELEODB_PASSWORD").ok()?,
        ))
    }

    /// The SECOND account (a pre-provisioned, email-verified collaborator). It
    /// can't be created over HTTP — the box enforces mandatory email
    /// verification — so the two-account tests skip unless these are set.
    fn live_env2() -> Option<(String, String, String)> {
        Some((
            std::env::var("DEV_SPELEODB_URL").ok()?,
            std::env::var("DEV_SPELEODB_EMAIL2").ok()?,
            std::env::var("DEV_SPELEODB_PASSWORD2").ok()?,
        ))
    }

    const SEED_FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../e2e/fixtures/fractal_plant_iter2.stalx"
    );

    /// Build a `base/api/v2/{suffix}` URL the same way `client::api_url` does
    /// (`api_url` is private to `client`). Used by the raw-`ureq` tests that need a
    /// request the typed client can't make (no auth header, a junk token, or a
    /// deliberately malformed multipart).
    fn api_url(base: &str, suffix: &str) -> String {
        format!(
            "{}/api/v2/{}",
            base.trim_end_matches('/'),
            suffix.trim_start_matches('/')
        )
    }

    /// A fresh agent with `http_status_as_error(false)` so a non-2xx response is a
    /// normal `Response` whose status the raw tests can read (mirrors the agent the
    /// production `client` builds). Test-local because `client::agent` is private.
    fn raw_agent() -> ureq::Agent {
        ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(30)))
            .http_status_as_error(false)
            .build()
            .new_agent()
    }

    /// Deletes the per-run test project on drop, so the round-trip cleans up
    /// after itself even if an assertion panics partway through.
    struct ProjectCleanup<'a> {
        url: &'a str,
        token: &'a str,
        id: String,
    }

    impl Drop for ProjectCleanup<'_> {
        #[expect(clippy::print_stderr, reason = "ignored live integration test cleanup")]
        fn drop(&mut self) {
            if let Err(e) = client::delete_project(self.url, self.token, &self.id) {
                eprintln!("cleanup: failed to delete test project {}: {e:?}", self.id);
            }
        }
    }

    /// Credentials-free live check: junk credentials must come back as HTTP 400
    /// (not 401), which is the exact contract the client branches on. Needs only
    /// `DEV_SPELEODB_URL`, so it can run against the box without any account.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_URL (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_bad_credentials_returns_400() {
        let Ok(url) = std::env::var("DEV_SPELEODB_URL") else {
            eprintln!("skipping live_bad_credentials_returns_400: set DEV_SPELEODB_URL");
            return;
        };
        let err = client::login(&url, false, "nobody@example.com", "definitely-wrong")
            .expect_err("junk credentials must be rejected");
        assert!(
            matches!(&err, SpeleoDbError::Status { status: 400, .. }),
            "bad credentials should map to HTTP 400, got: {err:?}"
        );
    }

    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* env (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        clippy::panic,
        reason = "ignored live integration test"
    )]
    fn live_round_trip_seed_pull_open() {
        let Some((url, email, password)) = live_env() else {
            eprintln!("skipping live_round_trip: set DEV_SPELEODB_URL / _EMAIL / _PASSWORD");
            return;
        };

        // 1. Auth.
        let token = client::login(&url, false, &email, &password).expect("login should succeed");

        // 2. Create a throwaway project so the test owns its own state, and
        //    register cleanup before doing anything else that could panic.
        let name = format!("stalagmight-spike-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &token, false, &name)
            .expect("create project")
            .id;
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &token,
            id: project_id.clone(),
        };

        // It should now be visible to this account.
        let projects =
            client::list_projects(&url, &token, false).expect("list_projects should succeed");
        assert!(
            projects.iter().any(|p| p.id == project_id),
            "freshly created project {project_id} not visible in list"
        );

        // 3. Seed a known-good .stalx (+ a tiny .tml sidecar so the production
        //    two-`artifact` upload_auto path is exercised): acquire, upload,
        //    release. The returned Project's latest_commit.id is the new hexsha.
        let fixture = std::path::Path::new(SEED_FIXTURE);
        assert!(fixture.exists(), "seed fixture missing: {SEED_FIXTURE}");
        let tml_dir = tempfile::tempdir().expect("tml tempdir");
        let tml_sidecar = tml_dir.path().join("ariane.tml");
        std::fs::write(&tml_sidecar, b"<CaveFile/>").expect("write tml sidecar");
        client::acquire_lock(&url, &token, false, &project_id).expect("acquire mutex");
        let uploaded = client::upload_auto(
            &url,
            &token,
            false,
            &project_id,
            fixture,
            &tml_sidecar,
            "spike seed",
        )
        .expect("seed upload");
        assert!(
            uploaded.latest_commit.is_some(),
            "upload should return a Project carrying the new commit"
        );
        client::release_lock(&url, &token, false, &project_id).expect("release mutex");

        // 4. Pull the dump, classify, extract, and open the .stalx self-contained.
        let zip = client::download_dump(&url, &token, false, &project_id).expect("download dump");
        let mut dump = dump::Dump::open(&zip).expect("open dump zip");
        let names = dump.entry_paths().expect("read dump entries");
        let DumpClassification::Stalx(entry) = dump::classify(&names) else {
            panic!("expected exactly one .stalx in the dump, got entries: {names:?}");
        };

        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("project.stalx");
        dump.extract_entry_to(&entry, &dest)
            .expect("extract .stalx");

        let db = crate::persistence::Database::open_existing(&dest).expect("open extracted .stalx");
        let project = db
            .load_project()
            .expect("load project from extracted .stalx");
        assert!(
            !project.name.is_empty() || !project.sections.is_empty(),
            "extracted .stalx opened but looked empty"
        );
        // `_cleanup` drops here → soft-deletes the test project.
    }

    /// The `GET /user/` whoami returns the token owner's email — the basis for the
    /// token-paste login path deriving the email from the token instead of input.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* env (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_fetch_user_email_matches_token_owner() {
        let Some((url, email, password)) = live_env() else {
            eprintln!("skipping live_fetch_user_email: set DEV_SPELEODB_URL / _EMAIL / _PASSWORD");
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login should succeed");
        let got =
            client::fetch_user_email(&url, &token, false).expect("fetch_user_email should succeed");
        assert_eq!(got, email, "whoami should return the token owner's email");
    }

    /// Two-account: a collaborator granted READ_ONLY sees the project with the
    /// parsed `Permission::ReadOnly` label — the end-to-end check that the wire
    /// format is the string label, not the integer the issues describe.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* + _EMAIL2/_PASSWORD2 (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_collaborator_sees_read_only_label() {
        let (Some((url, owner_email, owner_pw)), Some((_, email2, pw2))) =
            (live_env(), live_env2())
        else {
            eprintln!("skipping live_collaborator_sees_read_only_label: set DEV_SPELEODB_* and _EMAIL2/_PASSWORD2");
            return;
        };
        let owner = client::login(&url, false, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-perm-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, false, &name)
            .expect("create project")
            .id;
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        client::grant_permission(&url, &owner, &project_id, &email2, "READ_ONLY")
            .expect("grant READ_ONLY");

        let collab = client::login(&url, false, &email2, &pw2).expect("collaborator login");
        let projects = client::list_projects(&url, &collab, false).expect("collaborator list");
        let project = projects
            .iter()
            .find(|p| p.id == project_id)
            .expect("collaborator should see the granted project");
        assert_eq!(
            project.permission,
            Some(Permission::ReadOnly),
            "granted READ_ONLY should parse to Permission::ReadOnly"
        );
    }

    /// Two-account: a WEB_VIEWER cannot download the dump (needs ≥ READ_ONLY), so
    /// the pull surfaces HTTP 403 — the contract the #203 "disable Open for
    /// view-only rows" gating builds on.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* + _EMAIL2/_PASSWORD2 (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_web_viewer_cannot_download() {
        let (Some((url, owner_email, owner_pw)), Some((_, email2, pw2))) =
            (live_env(), live_env2())
        else {
            eprintln!("skipping live_web_viewer_cannot_download: set DEV_SPELEODB_* and _EMAIL2/_PASSWORD2");
            return;
        };
        let owner = client::login(&url, false, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-wv-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, false, &name)
            .expect("create project")
            .id;
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        // Seed a real .stalx (+ .tml sidecar) so the only thing stopping the
        // download is permission.
        let fixture = std::path::Path::new(SEED_FIXTURE);
        let tml_dir = tempfile::tempdir().expect("tml tempdir");
        let tml_sidecar = tml_dir.path().join("ariane.tml");
        std::fs::write(&tml_sidecar, b"<CaveFile/>").expect("write tml sidecar");
        client::acquire_lock(&url, &owner, false, &project_id).expect("acquire mutex");
        client::upload_auto(
            &url,
            &owner,
            false,
            &project_id,
            fixture,
            &tml_sidecar,
            "seed",
        )
        .expect("seed upload");
        client::release_lock(&url, &owner, false, &project_id).expect("release mutex");
        client::grant_permission(&url, &owner, &project_id, &email2, "WEB_VIEWER")
            .expect("grant WEB_VIEWER");

        let viewer = client::login(&url, false, &email2, &pw2).expect("viewer login");
        let err = client::download_dump(&url, &viewer, false, &project_id)
            .expect_err("WEB_VIEWER must be denied the dump download");
        assert!(
            matches!(&err, SpeleoDbError::Status { status: 403, .. }),
            "WEB_VIEWER download should be HTTP 403, got: {err:?}"
        );
    }

    /// Two-account: when a different user holds the mutex, the owner's project
    /// list shows that user as the lock holder — validating the
    /// `active_mutex.user` → `SpeleoProjectSummary::lock_holder` mapping.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* + _EMAIL2/_PASSWORD2 (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_lock_holder_reflects_other_user() {
        let (Some((url, owner_email, owner_pw)), Some((_, email2, pw2))) =
            (live_env(), live_env2())
        else {
            eprintln!("skipping live_lock_holder_reflects_other_user: set DEV_SPELEODB_* and _EMAIL2/_PASSWORD2");
            return;
        };
        let owner = client::login(&url, false, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-lock-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, false, &name)
            .expect("create project")
            .id;
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        client::grant_permission(&url, &owner, &project_id, &email2, "READ_AND_WRITE")
            .expect("grant READ_AND_WRITE");

        let collab = client::login(&url, false, &email2, &pw2).expect("collaborator login");
        client::acquire_lock(&url, &collab, false, &project_id)
            .expect("collaborator acquire mutex");

        let projects = client::list_projects(&url, &owner, false).expect("owner list");
        let project = projects
            .iter()
            .find(|p| p.id == project_id)
            .expect("owner should see the project");
        let summary = SpeleoProjectSummary::from_project(project.clone());
        assert_eq!(
            summary.lock_holder.as_deref(),
            Some(email2.as_str()),
            "owner should see the collaborator as the lock holder"
        );

        // Release the collaborator's lock so cleanup's delete isn't fighting it.
        if let Err(e) = client::release_lock(&url, &collab, false, &project_id) {
            eprintln!("cleanup: failed to release collaborator lock: {e:?}");
        }
    }

    // ── L4 / L5: header vs token distinction (URL-only tier) ────────────────

    /// L4: a `GET /projects/` with **no** `Authorization` header is rejected with
    /// HTTP **403** (DRF "not authenticated on a protected endpoint with no
    /// credentials"), distinct from a present-but-dead token (→ 401, L5). The typed
    /// client always sends a Bearer header, so this is a raw `ureq` call. Needs
    /// only `DEV_SPELEODB_URL`.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_URL (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_missing_auth_header_returns_403() {
        let Ok(url) = std::env::var("DEV_SPELEODB_URL") else {
            eprintln!("skipping live_missing_auth_header_returns_403: set DEV_SPELEODB_URL");
            return;
        };
        let resp = raw_agent()
            .get(&api_url(&url, "projects/"))
            // Deliberately NO Authorization header.
            .call()
            .expect("request should reach the server (status branched below)");
        assert_eq!(
            resp.status().as_u16(),
            403,
            "a missing Authorization header should be HTTP 403 (vs dead token → 401)"
        );
    }

    /// L5: a `GET /user/` with a **junk/revoked** token is rejected with HTTP
    /// **401** ("authenticated route, bad token"), the contrast to the
    /// missing-header 403 (L4). Sent raw with a garbage Bearer token. Needs only
    /// `DEV_SPELEODB_URL`.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_URL (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_dead_token_returns_401() {
        let Ok(url) = std::env::var("DEV_SPELEODB_URL") else {
            eprintln!("skipping live_dead_token_returns_401: set DEV_SPELEODB_URL");
            return;
        };
        let resp = raw_agent()
            .get(&api_url(&url, "user/"))
            .header("Authorization", "Bearer this-token-is-not-real-deadbeef")
            .call()
            .expect("request should reach the server (status branched below)");
        assert_eq!(
            resp.status().as_u16(),
            401,
            "a present-but-dead token should be HTTP 401 (vs missing header → 403)"
        );
    }

    // ── L9 / L10 / L11: two-account permission + contention ─────────────────

    /// L9: a project the second user has **no grant** on does not even appear in
    /// their `GET /projects/` list — and on any project they *can* see without a
    /// grant the `permission` field is **ABSENT** (not `null`), parsing to `None`.
    /// We assert the structural invariant the wire format guarantees: when a
    /// project carries no permission the parsed field is `None` (absent ≡ null ≡
    /// `None`), and the un-granted project is invisible to the collaborator.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* + _EMAIL2/_PASSWORD2 (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_no_permission_field_absent() {
        let (Some((url, owner_email, owner_pw)), Some((_, email2, pw2))) =
            (live_env(), live_env2())
        else {
            eprintln!("skipping live_no_permission_field_absent: set DEV_SPELEODB_* and _EMAIL2/_PASSWORD2");
            return;
        };
        let owner = client::login(&url, false, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-noperm-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, false, &name)
            .expect("create project")
            .id;
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        // No grant to user2 at all.

        let collab = client::login(&url, false, &email2, &pw2).expect("collaborator login");
        let projects = client::list_projects(&url, &collab, false).expect("collaborator list");
        assert!(
            projects.iter().all(|p| p.id != project_id),
            "an un-granted project must NOT appear in the collaborator's list"
        );
        // Every project the collaborator can see carries a parsed permission OR
        // None — never a parse error from a present-but-absent field. (The wire
        // format omits the field entirely when there is no access; serde maps the
        // absent field to None.)
        for p in &projects {
            // `permission` is Option<Permission>; the field being absent on the
            // wire deserializes to None without error. This asserts the
            // absent≡None contract holds across the live payload.
            let _ = p.permission;
        }
    }

    /// L10: when the collaborator **holds the mutex**, the owner's acquire is
    /// rejected with HTTP **400** (`mutex.py` contention) — explicitly NOT 423 /
    /// 409 / 412. Pins the "no first-class lock-status codes" contract `map_status`
    /// relies on (lock contention is a plain 400).
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* + _EMAIL2/_PASSWORD2 (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_acquire_contended_returns_400() {
        let (Some((url, owner_email, owner_pw)), Some((_, email2, pw2))) =
            (live_env(), live_env2())
        else {
            eprintln!("skipping live_acquire_contended_returns_400: set DEV_SPELEODB_* and _EMAIL2/_PASSWORD2");
            return;
        };
        let owner = client::login(&url, false, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-contend-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, false, &name)
            .expect("create project")
            .id;
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        client::grant_permission(&url, &owner, &project_id, &email2, "READ_AND_WRITE")
            .expect("grant READ_AND_WRITE");

        // Collaborator takes the mutex first.
        let collab = client::login(&url, false, &email2, &pw2).expect("collaborator login");
        client::acquire_lock(&url, &collab, false, &project_id)
            .expect("collaborator acquires the mutex");

        // Owner's acquire now contends → 400 (NOT 423/409/412).
        let err = client::acquire_lock(&url, &owner, false, &project_id)
            .expect_err("owner acquire must be rejected while the mutex is held");
        assert!(
            matches!(&err, SpeleoDbError::Status { status: 400, .. }),
            "lock contention should map to HTTP 400 (not 423/409/412), got: {err:?}"
        );

        // Release the collaborator's lock so cleanup's delete isn't fighting it.
        if let Err(e) = client::release_lock(&url, &collab, false, &project_id) {
            eprintln!("cleanup: failed to release collaborator lock: {e:?}");
        }
    }

    /// L11: a collaborator with only READ_ONLY (no write permission) attempting to
    /// acquire the mutex is rejected with HTTP **403** ("no write perm" fence) —
    /// the contrast to contention's 400 (L10). `map_status(Acquire, 403) == Fence`.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* + _EMAIL2/_PASSWORD2 (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_acquire_no_perm_returns_403() {
        let (Some((url, owner_email, owner_pw)), Some((_, email2, pw2))) =
            (live_env(), live_env2())
        else {
            eprintln!("skipping live_acquire_no_perm_returns_403: set DEV_SPELEODB_* and _EMAIL2/_PASSWORD2");
            return;
        };
        let owner = client::login(&url, false, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-noperm-acq-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, false, &name)
            .expect("create project")
            .id;
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        // READ_ONLY: visible + downloadable, but NOT write/lock-capable.
        client::grant_permission(&url, &owner, &project_id, &email2, "READ_ONLY")
            .expect("grant READ_ONLY");

        let collab = client::login(&url, false, &email2, &pw2).expect("collaborator login");
        let err = client::acquire_lock(&url, &collab, false, &project_id)
            .expect_err("a READ_ONLY collaborator must be denied the mutex");
        assert!(
            matches!(&err, SpeleoDbError::Status { status: 403, .. }),
            "a no-write-perm acquire should be HTTP 403 (vs contention 400), got: {err:?}"
        );
    }

    // ── L12 / L13 / L14: upload/auto status contract (single-account) ───────

    /// Seed a project + acquire its mutex, returning `(project_id, fixture paths,
    /// tml tempdir guard)`. The caller owns the returned `ProjectCleanup` and the
    /// `TempDir` so they outlive the test body. Used by the upload-status tests.
    #[expect(clippy::expect_used, reason = "ignored live integration test helper")]
    fn seed_and_acquire<'a>(
        url: &'a str,
        token: &'a str,
    ) -> (ProjectCleanup<'a>, std::path::PathBuf, tempfile::TempDir) {
        let name = format!("stalagmight-upload-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(url, token, false, &name)
            .expect("create project")
            .id;
        let cleanup = ProjectCleanup {
            url,
            token,
            id: project_id,
        };
        client::acquire_lock(url, token, false, &cleanup.id).expect("acquire mutex");
        let tml_dir = tempfile::tempdir().expect("tml tempdir");
        (
            cleanup,
            std::path::Path::new(SEED_FIXTURE).to_path_buf(),
            tml_dir,
        )
    }

    /// L12: a real `upload/auto` of a fresh change returns **200** with a body
    /// carrying the new `latest_commit.id` (the adopted hexsha) and the project
    /// block. This is the success path #186's "adopt-hexsha + conditional
    /// clear-dirty" handoff keys off.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* env (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_upload_200_returns_hexsha_and_project() {
        let Some((url, email, password)) = live_env() else {
            eprintln!("skipping live_upload_200: set DEV_SPELEODB_URL / _EMAIL / _PASSWORD");
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let (cleanup, fixture, tml_dir) = seed_and_acquire(&url, &token);
        let tml_sidecar = tml_dir.path().join("ariane.tml");
        std::fs::write(&tml_sidecar, b"<CaveFile/>").expect("write tml sidecar");

        let project = client::upload_auto(
            &url,
            &token,
            false,
            &cleanup.id,
            &fixture,
            &tml_sidecar,
            "live upload-200 test",
        )
        .expect("upload/auto of a fresh change should be 200");
        let commit = project
            .latest_commit
            .as_ref()
            .expect("200 body must carry a latest_commit (the adopted hexsha)");
        assert!(
            !commit.id.is_empty(),
            "the returned latest_commit.id should be a non-empty hexsha"
        );
        assert_eq!(project.id, cleanup.id, "200 body carries the project block");

        if let Err(e) = client::release_lock(&url, &token, false, &cleanup.id) {
            eprintln!("cleanup: failed to release lock: {e:?}");
        }
    }

    /// L13: re-uploading the **identical** tree (no change since the last commit)
    /// returns **304** — the benign "remote already at this state" outcome
    /// `map_status(UploadAuto, 304) == UpToDate` models. A 304 is a non-2xx, so the
    /// production `upload_auto` surfaces it as `Status { status: 304, .. }`.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* env (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_upload_304_when_unchanged() {
        let Some((url, email, password)) = live_env() else {
            eprintln!("skipping live_upload_304: set DEV_SPELEODB_URL / _EMAIL / _PASSWORD");
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let (cleanup, fixture, tml_dir) = seed_and_acquire(&url, &token);
        let tml_sidecar = tml_dir.path().join("ariane.tml");
        std::fs::write(&tml_sidecar, b"<CaveFile/>").expect("write tml sidecar");

        // First upload lands the tree (200).
        client::upload_auto(
            &url,
            &token,
            false,
            &cleanup.id,
            &fixture,
            &tml_sidecar,
            "live upload-304 seed",
        )
        .expect("first upload should be 200");

        // Re-upload the identical tree → 304 (unchanged).
        let err = client::upload_auto(
            &url,
            &token,
            false,
            &cleanup.id,
            &fixture,
            &tml_sidecar,
            "live upload-304 re-push",
        )
        .expect_err("an unchanged re-upload should not be a 2xx");
        assert!(
            matches!(&err, SpeleoDbError::Status { status: 304, .. }),
            "an unchanged re-upload should be HTTP 304 (UpToDate), got: {err:?}"
        );

        if let Err(e) = client::release_lock(&url, &token, false, &cleanup.id) {
            eprintln!("cleanup: failed to release lock: {e:?}");
        }
    }

    /// L14: a malformed `upload/auto` payload (a multipart that omits the required
    /// revision/artifact, here a `message`-only form with no `artifact` part) is
    /// rejected with HTTP **422** — the distinct unprocessable/fatal row
    /// `map_status(UploadAuto, 422) == Fatal`. Sent raw because the typed
    /// `upload_auto` always builds a well-formed two-part form, so the malformed
    /// case can only be produced with a hand-built `ureq::Form`.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* env (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_upload_422_missing_revision() {
        use ureq::unversioned::multipart::Form;

        let Some((url, email, password)) = live_env() else {
            eprintln!("skipping live_upload_422: set DEV_SPELEODB_URL / _EMAIL / _PASSWORD");
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let name = format!("stalagmight-upload422-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &token, false, &name)
            .expect("create project")
            .id;
        let cleanup = ProjectCleanup {
            url: &url,
            token: &token,
            id: project_id,
        };
        client::acquire_lock(&url, &token, false, &cleanup.id).expect("acquire mutex");

        // A deliberately malformed multipart: only the message text part, NO
        // `artifact` part — the server cannot derive a revision → 422.
        let upload_url = api_url(&url, &format!("projects/{}/upload/auto/", cleanup.id));
        let resp = raw_agent()
            .put(&upload_url)
            .header("Authorization", &format!("Bearer {token}"))
            .send(Form::new().text("message", "deliberately malformed"))
            .expect("request should reach the server (status branched below)");
        assert_eq!(
            resp.status().as_u16(),
            422,
            "a malformed upload/auto (missing artifact/revision) should be HTTP 422"
        );

        if let Err(e) = client::release_lock(&url, &token, false, &cleanup.id) {
            eprintln!("cleanup: failed to release lock: {e:?}");
        }
    }

    // ── L15 / L16: the AUTO catch-all `.stalx` coupling + drift canary ──────

    /// L15: a `.stalx` pushed through `upload/auto` is stored **verbatim** by the
    /// server's AUTO catch-all and comes back in the dump — located by its `.stalx`
    /// **suffix**, never a hard-coded `misc/project.stalx` path (so it survives a
    /// server `TARGET_FOLDER` change). The bytes round-trip: the extracted `.stalx`
    /// opens as a real sqlite project.
    #[test]
    #[ignore = "hits a live SpeleoDB box; needs DEV_SPELEODB_* env (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        clippy::panic,
        reason = "ignored live integration test"
    )]
    fn live_stalx_round_trips_through_auto() {
        let Some((url, email, password)) = live_env() else {
            eprintln!("skipping live_stalx_round_trips: set DEV_SPELEODB_URL / _EMAIL / _PASSWORD");
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let (cleanup, fixture, tml_dir) = seed_and_acquire(&url, &token);
        let tml_sidecar = tml_dir.path().join("ariane.tml");
        std::fs::write(&tml_sidecar, b"<CaveFile/>").expect("write tml sidecar");
        client::upload_auto(
            &url,
            &token,
            false,
            &cleanup.id,
            &fixture,
            &tml_sidecar,
            "live .stalx round-trip seed",
        )
        .expect("seed upload");
        if let Err(e) = client::release_lock(&url, &token, false, &cleanup.id) {
            eprintln!("cleanup: failed to release lock: {e:?}");
        }

        // Pull the dump and locate the .stalx BY SUFFIX (the AUTO catch-all stored
        // it verbatim).
        let zip = client::download_dump(&url, &token, false, &cleanup.id).expect("download dump");
        let mut d = dump::Dump::open(&zip).expect("open dump zip");
        let names = d.entry_paths().expect("read dump entries");
        let DumpClassification::Stalx(entry) = dump::classify(&names) else {
            panic!("expected exactly one .stalx (located by suffix) in the dump: {names:?}");
        };
        assert!(
            entry.ends_with(".stalx"),
            "the located entry must be found by its .stalx suffix, got: {entry}"
        );
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("project.stalx");
        d.extract_entry_to(&entry, &dest).expect("extract .stalx");
        let db = crate::persistence::Database::open_existing(&dest)
            .expect("the round-tripped .stalx opens as sqlite");
        let project = db
            .load_project()
            .expect("load project from round-tripped .stalx");
        assert!(
            !project.name.is_empty() || !project.sections.is_empty(),
            "the round-tripped .stalx opened but looked empty"
        );
    }

    /// L16 — SERVER-DRIFT CANARY (kept `#[ignore]` like the rest). TODAY the
    /// server's AUTO catch-all (`BaseFileProcessor`) **accepts and stores** a file
    /// with an unknown extension. This test asserts that *current* behavior: the
    /// upload of an unknown-extension artifact succeeds. If the server ever starts
    /// **rejecting** unknown extensions, this test FAILS LOUDLY — that is the whole
    /// point. It is a tripwire on the `.stalx` catch-all coupling (D-T-stalx): the
    /// hand-off relies on the catch-all storing arbitrary extensions verbatim, so a
    /// behavior change here would silently break every push/pull. When this fails,
    /// investigate the server's processor allow-list before "fixing" the test.
    #[test]
    #[ignore = "SERVER-DRIFT CANARY; hits a live SpeleoDB box; needs DEV_SPELEODB_* (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_auto_rejects_unknown_extension_canary() {
        use ureq::unversioned::multipart::{Form, Part};

        let Some((url, email, password)) = live_env() else {
            eprintln!("skipping live_auto_rejects_unknown_extension_canary: set DEV_SPELEODB_URL / _EMAIL / _PASSWORD");
            return;
        };
        let token = client::login(&url, false, &email, &password).expect("login");
        let name = format!("stalagmight-canary-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &token, false, &name)
            .expect("create project")
            .id;
        let cleanup = ProjectCleanup {
            url: &url,
            token: &token,
            id: project_id,
        };
        client::acquire_lock(&url, &token, false, &cleanup.id).expect("acquire mutex");

        // An artifact with an unknown extension — what the AUTO catch-all is
        // expected to accept TODAY.
        let dir = tempfile::tempdir().expect("tempdir");
        let blob = dir.path().join("mystery.zzz");
        std::fs::write(&blob, b"unknown-extension-bytes").expect("write blob");

        let upload_url = api_url(&url, &format!("projects/{}/upload/auto/", cleanup.id));
        let part = Part::file(&blob)
            .expect("part from file")
            .file_name("mystery.zzz")
            .mime_str("application/octet-stream")
            .expect("mime");
        let form = Form::new()
            .part("artifact", part)
            .text("message", "drift canary: unknown extension");
        let resp = raw_agent()
            .put(&upload_url)
            .header("Authorization", &format!("Bearer {token}"))
            .send(form)
            .expect("request should reach the server (status branched below)");
        let status = resp.status().as_u16();

        // CANARY ASSERTION: today the AUTO catch-all ACCEPTS the unknown extension.
        // A 2xx (200 stored / 304 unchanged) is the documented current behavior.
        // If the server starts rejecting unknown extensions (4xx), this fails
        // LOUDLY — the catch-all coupling has drifted; see the doc-comment.
        assert!(
            (200..400).contains(&status),
            "DRIFT: the AUTO catch-all rejected an unknown extension (HTTP {status}); \
             the .stalx hand-off relies on it storing arbitrary extensions verbatim \
             — investigate the server processor allow-list before editing this test"
        );

        if let Err(e) = client::release_lock(&url, &token, false, &cleanup.id) {
            eprintln!("cleanup: failed to release lock: {e:?}");
        }
    }

    // ── L19 / L20: the #187 http private-network policy on the real wire ────

    /// L19: pointing the client at a **public** `http://` host is blocked **before
    /// any dial** with `SpeleoDbError::InsecureEndpoint` (the `tls::enforce`
    /// policy) — unless `insecure_http` is set, in which case the request is
    /// allowed to proceed (and fails for an unrelated reason, NOT InsecureEndpoint).
    /// Needs no box: the block happens client-side before the network. Uses a
    /// documentation/test public host so no real public SpeleoDB is contacted.
    #[test]
    #[ignore = "exercises the #187 http policy; gated with the live suite (run with --ignored)"]
    #[expect(clippy::print_stderr, reason = "ignored live integration test")]
    fn live_http_to_public_blocked() {
        // This one needs no env at all, but stays #[ignore] with the live suite so
        // it never runs in CI's plain `cargo test`. A public http host:
        let public = "http://example.com";

        // Blocked before dial when insecure_http is false.
        let blocked = client::list_projects(public, "tok", false);
        assert!(
            matches!(blocked, Err(SpeleoDbError::InsecureEndpoint { .. })),
            "public http must be blocked before dial, got: {blocked:?}"
        );

        // With insecure_http = true the scheme block is lifted, so enforce no
        // longer short-circuits: the call proceeds to the network and fails for
        // some OTHER reason (transport/status), never InsecureEndpoint.
        let allowed = client::list_projects(public, "tok", true);
        assert!(
            !matches!(allowed, Err(SpeleoDbError::InsecureEndpoint { .. })),
            "insecure_http must lift the public-http block, got: {allowed:?}"
        );
        eprintln!("live_http_to_public_blocked: insecure_http path resolved to {allowed:?}");
    }

    /// L20: a `GET /projects/` to the real **private** box over plain
    /// `http://10.10.0.220:8000/` (RFC-1918) is **allowed** by the #187 policy
    /// without `insecure_http` — `classify_addr` puts the box in the private range.
    /// The whole single-account round-trip already exercises this, so here we just
    /// assert the http private endpoint is not rejected by the TLS policy.
    #[test]
    #[ignore = "hits a live SpeleoDB box over http; needs DEV_SPELEODB_* env (run with --ignored)"]
    #[expect(
        clippy::expect_used,
        clippy::print_stderr,
        reason = "ignored live integration test"
    )]
    fn live_http_to_private_box_allowed() {
        let Some((url, email, password)) = live_env() else {
            eprintln!("skipping live_http_to_private_box_allowed: set DEV_SPELEODB_URL / _EMAIL / _PASSWORD");
            return;
        };
        // If the configured box isn't http (e.g. someone pointed the suite at an
        // https box), there is nothing to prove about the http private policy.
        if !url.starts_with("http://") {
            eprintln!(
                "skipping live_http_to_private_box_allowed: DEV_SPELEODB_URL is not http:// ({url})"
            );
            return;
        }
        let token = client::login(&url, false, &email, &password).expect("login over private http");
        // A successful list proves enforce() did NOT block the private http box.
        let projects = client::list_projects(&url, &token, false)
            .expect("private http box must be allowed by the #187 policy");
        // `projects` may legitimately be empty; the point is no InsecureEndpoint.
        eprintln!(
            "live_http_to_private_box_allowed: listed {} project(s) over private http",
            projects.len()
        );
    }
}
