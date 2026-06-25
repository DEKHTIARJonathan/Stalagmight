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
pub(crate) mod dump;
pub mod models;

pub use models::{
    Permission, SpeleoLoginResult, SpeleoOpenResult, SpeleoProjectSummary, SpeleoSessionStatus,
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
        let err = client::login(&url, "nobody@example.com", "definitely-wrong")
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
        let token = client::login(&url, &email, &password).expect("login should succeed");

        // 2. Create a throwaway project so the test owns its own state, and
        //    register cleanup before doing anything else that could panic.
        let name = format!("stalagmight-spike-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &token, &name).expect("create project");
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &token,
            id: project_id.clone(),
        };

        // It should now be visible to this account.
        let projects = client::list_projects(&url, &token).expect("list_projects should succeed");
        assert!(
            projects.iter().any(|p| p.id == project_id),
            "freshly created project {project_id} not visible in list"
        );

        // 3. Seed a known-good .stalx: acquire the mutex, upload, release.
        let fixture = std::path::Path::new(SEED_FIXTURE);
        assert!(fixture.exists(), "seed fixture missing: {SEED_FIXTURE}");
        client::acquire_lock(&url, &token, &project_id).expect("acquire mutex");
        client::upload_auto_single(&url, &token, &project_id, fixture, "spike seed")
            .expect("seed upload");
        client::release_lock(&url, &token, &project_id).expect("release mutex");

        // 4. Pull the dump, classify, extract, and open the .stalx self-contained.
        let zip = client::download_dump(&url, &token, &project_id).expect("download dump");
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
        let token = client::login(&url, &email, &password).expect("login should succeed");
        let got = client::fetch_user_email(&url, &token).expect("fetch_user_email should succeed");
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
        let owner = client::login(&url, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-perm-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, &name).expect("create project");
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        client::grant_permission(&url, &owner, &project_id, &email2, "READ_ONLY")
            .expect("grant READ_ONLY");

        let collab = client::login(&url, &email2, &pw2).expect("collaborator login");
        let projects = client::list_projects(&url, &collab).expect("collaborator list");
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
        let owner = client::login(&url, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-wv-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, &name).expect("create project");
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        // Seed a real .stalx so the only thing stopping the download is permission.
        let fixture = std::path::Path::new(SEED_FIXTURE);
        client::acquire_lock(&url, &owner, &project_id).expect("acquire mutex");
        client::upload_auto_single(&url, &owner, &project_id, fixture, "seed")
            .expect("seed upload");
        client::release_lock(&url, &owner, &project_id).expect("release mutex");
        client::grant_permission(&url, &owner, &project_id, &email2, "WEB_VIEWER")
            .expect("grant WEB_VIEWER");

        let viewer = client::login(&url, &email2, &pw2).expect("viewer login");
        let err = client::download_dump(&url, &viewer, &project_id)
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
        let owner = client::login(&url, &owner_email, &owner_pw).expect("owner login");
        let name = format!("stalagmight-lock-{}", uuid::Uuid::new_v4());
        let project_id = client::create_project(&url, &owner, &name).expect("create project");
        let _cleanup = ProjectCleanup {
            url: &url,
            token: &owner,
            id: project_id.clone(),
        };
        client::grant_permission(&url, &owner, &project_id, &email2, "READ_AND_WRITE")
            .expect("grant READ_AND_WRITE");

        let collab = client::login(&url, &email2, &pw2).expect("collaborator login");
        client::acquire_lock(&url, &collab, &project_id).expect("collaborator acquire mutex");

        let projects = client::list_projects(&url, &owner).expect("owner list");
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
        if let Err(e) = client::release_lock(&url, &collab, &project_id) {
            eprintln!("cleanup: failed to release collaborator lock: {e:?}");
        }
    }
}
