//! ureq HTTP client for the SpeleoDB v2 API (read-only spike, #183).
//!
//! Reuses the tile-fetch transport idiom (`lib.rs`): a fresh `ureq::Agent` per
//! attempt with a global timeout, and a small retry loop over transient
//! transport errors. The agent is configured with `http_status_as_error(false)`
//! so non-2xx responses are returned (not turned into errors) and this module
//! branches on the status itself — the shape #186's status→action table builds on.
//!
//! Auth uses `Authorization: Bearer <token>` (verified: `BearerAuthentication`,
//! `authentication.py:59`). The full transport policy + remaining methods are
//! #185; this is the spike's read-only surface plus a test-only seed upload.

use std::time::Duration;

use serde::Deserialize;

use super::models::Project;
use super::SpeleoDbError;

/// Global per-request timeout. Larger than the tile timeout because a project
/// dump (whole working tree as a ZIP) can be bigger than a single tile.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Transient-transport retries (total attempts = 1 + MAX_RETRIES).
const MAX_RETRIES: u32 = 2;
/// Backoff delays between retries (mirrors the tile-fetch idiom).
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(200), Duration::from_millis(500)];

/// Build a fresh agent. `http_status_as_error(false)` makes non-2xx a normal
/// `Response` so the caller branches on the status code itself.
fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

fn api_url(base: &str, suffix: &str) -> String {
    format!(
        "{}/api/v2/{}",
        base.trim_end_matches('/'),
        suffix.trim_start_matches('/')
    )
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// Run `attempt`, retrying transient transport errors with backoff — but only
/// when the request is `idempotent`. With `http_status_as_error(false)` every
/// `Err` here is transport-level (DNS, timeout, connection reset, mid-body read).
/// A mid-body failure can land *after* the server already processed the request,
/// so retrying a non-idempotent write (create / upload / lock) could double-submit
/// it; those callers pass `idempotent = false` and run exactly once. Reads — and
/// the get-or-create login — are safe to retry.
fn with_retry<R>(
    idempotent: bool,
    mut attempt: impl FnMut() -> Result<R, ureq::Error>,
) -> Result<R, SpeleoDbError> {
    let max_retries = if idempotent { MAX_RETRIES } else { 0 };
    let mut last_err: Option<String> = None;
    for i in 0..=max_retries {
        if i > 0 {
            let delay = RETRY_DELAYS
                .get((i - 1) as usize)
                .copied()
                .unwrap_or(REQUEST_TIMEOUT);
            std::thread::sleep(delay);
        }
        match attempt() {
            Ok(r) => return Ok(r),
            Err(e) => {
                tracing::debug!(error = %e, attempt = i + 1, "SpeleoDB request failed; will retry if attempts remain");
                last_err = Some(e.to_string());
            }
        }
    }
    Err(SpeleoDbError::Transport(
        last_err.unwrap_or_else(|| "unknown transport error".to_owned()),
    ))
}

/// Map a non-2xx response into a [`SpeleoDbError::Status`], extracting a
/// best-effort human message from the v2 error body (`{error}` / `{errors}` /
/// `{detail}`).
fn status_error(status: u16, body: &[u8]) -> SpeleoDbError {
    SpeleoDbError::Status {
        status,
        message: parse_error_message(body).unwrap_or_else(|| format!("HTTP {status}")),
    }
}

fn parse_error_message(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    if let Some(s) = value.get("error").and_then(serde_json::Value::as_str) {
        return Some(s.to_owned());
    }
    if let Some(s) = value.get("detail").and_then(serde_json::Value::as_str) {
        return Some(s.to_owned());
    }
    value.get("errors").map(ToString::to_string)
}

#[derive(Deserialize)]
struct AuthTokenResponse {
    token: String,
}

/// `POST /api/v2/user/auth-token/` — exchange email+password for a token.
///
/// Note (verified against the live box): bad credentials return **400** with
/// `{errors: {non_field_errors: [...]}}`, not 401. On an authenticated endpoint a
/// *missing* header yields 403 and an *invalid/expired* token yields 401.
pub(crate) fn login(base: &str, email: &str, password: &str) -> Result<String, SpeleoDbError> {
    let url = api_url(base, "user/auth-token/");
    let payload = serde_json::json!({ "email": email, "password": password }).to_string();

    // Idempotent: the auth-token endpoint is get-or-create (non-rotating), so a
    // retried login returns the same token rather than minting a duplicate.
    let resp = with_retry(true, || {
        agent()
            .post(&url)
            .header("Content-Type", "application/json")
            .send(payload.as_str())
    })?;

    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    let parsed: AuthTokenResponse = serde_json::from_slice(&body)
        .map_err(|e| SpeleoDbError::Parse(format!("auth-token response: {e}")))?;
    Ok(parsed.token)
}

/// `GET /api/v2/projects/` — list the projects visible to the token holder.
pub(crate) fn list_projects(base: &str, token: &str) -> Result<Vec<Project>, SpeleoDbError> {
    let url = api_url(base, "projects/");
    let auth = bearer(token);

    let resp = with_retry(true, || {
        agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()
    })?;
    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    // v2 returns a bare JSON array (no `{data: …}` envelope).
    serde_json::from_slice(&body).map_err(|e| SpeleoDbError::Parse(format!("projects list: {e}")))
}

/// The authenticated user's profile (`GET /api/v2/user/`), parsed to the one
/// field the spike needs. The server also returns `name`/`country`/notification
/// prefs, which serde ignores.
#[derive(Deserialize)]
struct UserInfo {
    email: String,
}

/// `GET /api/v2/user/` — return the authenticated user's email. The token-paste
/// login path uses this to derive the authoritative email from the token itself
/// (instead of trusting typed input) and, as a side effect, to validate the
/// token at login time: a bad/expired token 401s here rather than slipping
/// through to the first list call.
pub(crate) fn fetch_user_email(base: &str, token: &str) -> Result<String, SpeleoDbError> {
    let url = api_url(base, "user/");
    let auth = bearer(token);

    let resp = with_retry(true, || {
        agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()
    })?;
    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    let info: UserInfo = serde_json::from_slice(&body)
        .map_err(|e| SpeleoDbError::Parse(format!("user info response: {e}")))?;
    Ok(info.email)
}

/// `GET /api/v2/projects/{id}/download/dump/` — download the project's working
/// tree (HEAD) as a ZIP. Returns the raw ZIP bytes for [`super::dump`] to handle.
pub(crate) fn download_dump(
    base: &str,
    token: &str,
    project_id: &str,
) -> Result<Vec<u8>, SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/download/dump/"));
    let auth = bearer(token);

    let resp = with_retry(true, || {
        agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()
    })?;
    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    Ok(body)
}

fn read_body(resp: http::Response<ureq::Body>) -> Result<Vec<u8>, SpeleoDbError> {
    resp.into_body()
        .read_to_vec()
        .map_err(|e| SpeleoDbError::Transport(format!("reading response body: {e}")))
}

/// Test-only seed: `PUT /api/v2/projects/{id}/upload/auto/` with a single
/// `artifact` part (`project.stalx`, explicit `application/vnd.sqlite3` MIME) and
/// a non-empty `message`. Lets the env-gated live smoke test push a `.stalx`
/// before pulling it, so the round-trip is self-contained. NOT a shipped command
/// — the full `upload_auto` (repeated artifacts + the co-pushed `ariane.tml`) is
/// #185.
#[cfg(test)]
pub(crate) fn upload_auto_single(
    base: &str,
    token: &str,
    project_id: &str,
    stalx_path: &std::path::Path,
    message: &str,
) -> Result<(), SpeleoDbError> {
    use ureq::unversioned::multipart::{Form, Part};

    let url = api_url(base, &format!("projects/{project_id}/upload/auto/"));
    let auth = bearer(token);
    let message = if message.is_empty() { "seed" } else { message };

    // A fresh Part/Form is built per attempt because `send(form)` consumes it.
    // The explicit MIME is load-bearing (guardrail 1): a bare `.file()` part
    // ships no Content-Type and the server 400s.
    // Non-idempotent write (a commit): run once so a mid-response failure can't
    // push the artifact twice.
    let resp = with_retry(false, || {
        let part = Part::file(stalx_path)?
            .file_name("project.stalx")
            .mime_str("application/vnd.sqlite3")?;
        let form = Form::new().part("artifact", part).text("message", message);
        agent()
            .put(&url)
            .header("Authorization", auth.as_str())
            .send(form)
    })?;

    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    Ok(())
}

/// Test-only: `POST /api/v2/projects/{id}/acquire/` — take the project mutex.
/// The upload endpoint requires the caller to hold the lock
/// (`UserOwnsProjectMutex`), so the seed must acquire before uploading. The real
/// acquire/reconcile orchestration is #194; this is the bare POST for the seed.
#[cfg(test)]
pub(crate) fn acquire_lock(base: &str, token: &str, project_id: &str) -> Result<(), SpeleoDbError> {
    post_no_body(base, token, &format!("projects/{project_id}/acquire/"))
}

/// Test-only: `POST /api/v2/projects/{id}/release/` — release the project mutex.
#[cfg(test)]
pub(crate) fn release_lock(base: &str, token: &str, project_id: &str) -> Result<(), SpeleoDbError> {
    post_no_body(base, token, &format!("projects/{project_id}/release/"))
}

#[cfg(test)]
#[derive(Deserialize)]
struct CreatedProject {
    id: String,
}

/// Test-only: `POST /api/v2/projects/` — create a fresh project so the live
/// round-trip can seed + clean up its own state (one project per run) instead of
/// depending on a fixed `DEV_SPELEODB_PROJECT_ID`. Returns the new project id.
/// The shipped create-on-SDB flow is #207.
#[cfg(test)]
pub(crate) fn create_project(base: &str, token: &str, name: &str) -> Result<String, SpeleoDbError> {
    let url = api_url(base, "projects/");
    let auth = bearer(token);
    let payload = serde_json::json!({
        "name": name,
        "description": "Stalagmight spike self-test project (auto-created)",
        "country": "US",
        "type": "other",
    })
    .to_string();

    // Non-idempotent write: run once so a mid-response failure can't double-submit.
    let resp = with_retry(false, || {
        agent()
            .post(&url)
            .header("Authorization", auth.as_str())
            .header("Content-Type", "application/json")
            .send(payload.as_str())
    })?;
    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    let created: CreatedProject = serde_json::from_slice(&body)
        .map_err(|e| SpeleoDbError::Parse(format!("create project response: {e}")))?;
    Ok(created.id)
}

/// Test-only: `DELETE /api/v2/projects/{id}/` — soft-delete the project (server
/// deactivates it; a cron purges after 30 days). Used to clean up the per-run
/// test project. Does not require releasing the lock first.
#[cfg(test)]
pub(crate) fn delete_project(
    base: &str,
    token: &str,
    project_id: &str,
) -> Result<(), SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/"));
    let auth = bearer(token);
    // DELETE is idempotent (deleting an already-deleted project is a no-op/404),
    // so a retry on a transient transport error is safe.
    let resp = with_retry(true, || {
        agent()
            .delete(&url)
            .header("Authorization", auth.as_str())
            .call()
    })?;
    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    Ok(())
}

/// Test-only: `POST /api/v2/projects/{id}/permission/user/detail/` — grant
/// `email` the permission `level` (`"WEB_VIEWER"` / `"READ_ONLY"` /
/// `"READ_AND_WRITE"`) on the project. Drives the two-account live tests'
/// collaborator setup.
#[cfg(test)]
pub(crate) fn grant_permission(
    base: &str,
    token: &str,
    project_id: &str,
    email: &str,
    level: &str,
) -> Result<(), SpeleoDbError> {
    let url = api_url(
        base,
        &format!("projects/{project_id}/permission/user/detail/"),
    );
    let auth = bearer(token);
    let payload = serde_json::json!({ "user": email, "level": level }).to_string();
    // Non-idempotent write: run once so a mid-response failure can't double-submit.
    let resp = with_retry(false, || {
        agent()
            .post(&url)
            .header("Authorization", auth.as_str())
            .header("Content-Type", "application/json")
            .send(payload.as_str())
    })?;
    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    Ok(())
}

#[cfg(test)]
fn post_no_body(base: &str, token: &str, suffix: &str) -> Result<(), SpeleoDbError> {
    let url = api_url(base, suffix);
    let auth = bearer(token);
    // Non-idempotent lock mutation (acquire/release): run once.
    let resp = with_retry(false, || {
        agent()
            .post(&url)
            .header("Authorization", auth.as_str())
            .send("")
    })?;
    let status = resp.status().as_u16();
    let body = read_body(resp)?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    Ok(())
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use super::{api_url, bearer, parse_error_message, UserInfo};

    #[test]
    fn user_info_parses_email_and_ignores_extra_fields() {
        // Mirrors the real `GET /user/` body: only `email` is consumed; the rest
        // (name/country/notification prefs) must be ignored, not rejected.
        let info: UserInfo = serde_json::from_str(
            r#"{"email":"a@b.com","name":"A","country":"","email_on_speleodb_updates":true}"#,
        )
        .expect("user info JSON");
        assert_eq!(info.email, "a@b.com");
    }

    #[test]
    fn api_url_joins_without_double_slash() {
        assert_eq!(
            api_url("http://10.10.0.220:8000/", "projects/"),
            "http://10.10.0.220:8000/api/v2/projects/"
        );
        assert_eq!(
            api_url("http://10.10.0.220:8000", "user/auth-token/"),
            "http://10.10.0.220:8000/api/v2/user/auth-token/"
        );
    }

    #[test]
    fn bearer_header_format() {
        assert_eq!(bearer("abc123"), "Bearer abc123");
    }

    #[test]
    fn parse_error_message_handles_v2_shapes() {
        assert_eq!(
            parse_error_message(br#"{"error":"nope"}"#).as_deref(),
            Some("nope")
        );
        assert_eq!(
            parse_error_message(br#"{"detail":"Not found."}"#).as_deref(),
            Some("Not found.")
        );
        // The auth-token bad-credentials shape: a nested `errors` object.
        let msg = parse_error_message(br#"{"errors":{"non_field_errors":["bad"]}}"#);
        assert!(msg.is_some_and(|m| m.contains("non_field_errors")));
        assert_eq!(parse_error_message(b"not json"), None);
    }
}
