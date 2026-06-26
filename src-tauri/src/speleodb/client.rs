//! ureq HTTP client for the SpeleoDB v2 API (#183 read-only spike → #185
//! production transport).
//!
//! Reuses the tile-fetch transport idiom (`lib.rs`): a fresh `ureq::Agent` per
//! attempt with a global timeout, and a retry loop over transient failures. The
//! agent is configured with `http_status_as_error(false)` so non-2xx responses
//! are returned (not turned into errors) and this module branches on the status
//! itself — the shape #186's status→action table builds on.
//!
//! Auth uses `Authorization: Bearer <token>` (verified: `BearerAuthentication`,
//! `authentication.py:59`).
//!
//! Transport policy (#185/#187/D-A-retry/D-B3):
//! - [`with_retry`] enforces the http private-network policy ([`super::tls`]) on
//!   every request before the first attempt, then runs the closure with backoff.
//! - The closure returns `(status, body)` so a 5xx is visible to the retry loop.
//!   Idempotent (read-like) calls retry a transient 5xx; non-idempotent writes
//!   (`idempotent == false`) run **exactly once** — a mid-response failure must
//!   never double-submit a commit / lock / create.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use super::models::Project;
use super::SpeleoDbError;

/// Global per-request timeout for reads. Larger than the tile timeout because a
/// project dump (whole working tree as a ZIP) can be bigger than a single tile.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Upload (multipart `PUT`) timeout — a full `.stalx` + `.tml` push is larger and
/// slower than a read, so it gets its own, longer budget (D-A-methods).
// (Referenced by `upload_auto`, so rustc does not flag it dead even while that
// method's orchestration caller is pending — no dead_code expectation needed.)
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Transient-transport retries (total attempts = 1 + MAX_RETRIES).
const MAX_RETRIES: u32 = 2;
/// Backoff delays between retries (mirrors the tile-fetch idiom).
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(200), Duration::from_millis(500)];

/// Build a fresh agent with the read timeout. `http_status_as_error(false)` makes
/// non-2xx a normal `Response` so the caller branches on the status code itself.
fn agent() -> ureq::Agent {
    agent_with_timeout(REQUEST_TIMEOUT)
}

/// Build a fresh agent with an explicit global timeout (upload uses the longer
/// [`UPLOAD_TIMEOUT`]). `http_status_as_error(false)` is kept so the status
/// branching shape #186 keys off is preserved.
fn agent_with_timeout(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
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

/// Run `attempt`, enforcing the http private-network policy first and then
/// retrying transient failures with backoff.
///
/// `base` + `insecure_http` are threaded so [`super::tls::enforce`] runs once at
/// the top — the single chokepoint a new method cannot forget (#187 step 5).
///
/// The closure returns `(status, body)`. With `http_status_as_error(false)` every
/// `Err` is transport-level (DNS, timeout, connection reset, mid-body read).
/// Retry rules (D-A-retry / D-B3):
/// - `idempotent` reads retry a transport `Err` **and** an idempotent 5xx (read
///   the body, treat a 500–599 like a transient error).
/// - non-idempotent writes (`idempotent == false`, `max_retries == 0`) run
///   exactly once and surface a 5xx straight through — retrying could
///   double-submit (the response failure can land after the server committed).
fn with_retry(
    base: &str,
    insecure_http: bool,
    idempotent: bool,
    mut attempt: impl FnMut() -> Result<(u16, Vec<u8>), ureq::Error>,
) -> Result<(u16, Vec<u8>), SpeleoDbError> {
    // #187: block public `http://` / scheme-less endpoints before any dial.
    super::tls::enforce(base, insecure_http)?;

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
            Ok((status, body)) => {
                // D-B3: an idempotent 5xx is treated like a transient error so it
                // is retried with backoff; a write (idempotent == false) returns
                // the 5xx immediately (it already ran, do not re-run it).
                if idempotent && i < max_retries && (500..600).contains(&status) {
                    tracing::debug!(
                        status,
                        attempt = i + 1,
                        "SpeleoDB idempotent request returned 5xx; will retry"
                    );
                    last_err = Some(format!("HTTP {status}"));
                    continue;
                }
                return Ok((status, body));
            }
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

/// Read a response into `(status, body)` for [`with_retry`]'s closure. A
/// body-read failure is a transport `Err` (so an idempotent call retries it).
fn read_status_body(resp: http::Response<ureq::Body>) -> Result<(u16, Vec<u8>), ureq::Error> {
    let status = resp.status().as_u16();
    let body = resp.into_body().read_to_vec()?;
    Ok((status, body))
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

/// Extract a human-facing message from a v2 error body. DISPLAY-ONLY: the
/// status→action contract ([`super::contract::map_status`]) is a pure function of
/// `(endpoint, status)` and never reads this string (#186, D-186).
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
pub(crate) fn login(
    base: &str,
    insecure_http: bool,
    email: &str,
    password: &str,
) -> Result<String, SpeleoDbError> {
    let url = api_url(base, "user/auth-token/");
    let payload = serde_json::json!({ "email": email, "password": password }).to_string();

    // Idempotent: the auth-token endpoint is get-or-create (non-rotating), so a
    // retried login returns the same token rather than minting a duplicate.
    let (status, body) = with_retry(base, insecure_http, true, || {
        let resp = agent()
            .post(&url)
            .header("Content-Type", "application/json")
            .send(payload.as_str())?;
        read_status_body(resp)
    })?;

    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    let parsed: AuthTokenResponse = serde_json::from_slice(&body)
        .map_err(|e| SpeleoDbError::Parse(format!("auth-token response: {e}")))?;
    Ok(parsed.token)
}

/// `GET /api/v2/projects/` — list the projects visible to the token holder.
pub(crate) fn list_projects(
    base: &str,
    token: &str,
    insecure_http: bool,
) -> Result<Vec<Project>, SpeleoDbError> {
    let url = api_url(base, "projects/");
    let auth = bearer(token);

    let (status, body) = with_retry(base, insecure_http, true, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    // v2 returns a bare JSON array (no `{data: …}` envelope).
    // FRESHNESS FOLD (#189/#191): the authoritative Projects are available here;
    // caching the verdict + resetting last_verify_at lands later (D-B1, #202).
    serde_json::from_slice(&body).map_err(|e| SpeleoDbError::Parse(format!("projects list: {e}")))
}

/// `GET /api/v2/projects/{id}/` — fetch a single project (D-B11, #185). A ~10-line
/// mirror of [`list_projects`] parsing one bare [`Project`]. The caller validates
/// `project_id` (UUID) before calling. #202 consumes this on the freshness-fold
/// path.
// Production primitive landed now (D-B11); its orchestration caller is #202, so
// it is dead in the non-test lib build until then.
#[cfg_attr(not(test), expect(dead_code, reason = "get_project caller is #202"))]
pub(crate) fn get_project(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<Project, SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/"));
    let auth = bearer(token);

    let (status, body) = with_retry(base, insecure_http, true, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    // FRESHNESS FOLD (#189/#191): authoritative Project available here; cache +
    // reset last_verify_at lands later (D-B1, #202).
    serde_json::from_slice(&body).map_err(|e| SpeleoDbError::Parse(format!("project detail: {e}")))
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
pub(crate) fn fetch_user_email(
    base: &str,
    token: &str,
    insecure_http: bool,
) -> Result<String, SpeleoDbError> {
    let url = api_url(base, "user/");
    let auth = bearer(token);

    let (status, body) = with_retry(base, insecure_http, true, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
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
    insecure_http: bool,
    project_id: &str,
) -> Result<Vec<u8>, SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/download/dump/"));
    let auth = bearer(token);

    let (status, body) = with_retry(base, insecure_http, true, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    Ok(body)
}

/// Parse a 2xx body into a [`Project`] (the shape every write endpoint returns).
fn parse_project(body: &[u8], context: &str) -> Result<Project, SpeleoDbError> {
    serde_json::from_slice(body).map_err(|e| SpeleoDbError::Parse(format!("{context}: {e}")))
}

/// MIME type for an artifact part, by extension (D-A-mime). The server routes on
/// extension via the AUTO catch-all; explicit MIME is robustness, not a hard
/// requirement (OPEN-1, corrected).
fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("stalx") => "application/vnd.sqlite3",
        // .tml (and anything else co-pushed) → generic binary.
        _ => "application/octet-stream",
    }
}

/// One multipart `artifact` part, described *before* it is folded into an opaque
/// `ureq::Form` (D-B15 / OPEN-2: a built `Form` exposes no `parts()` accessor, so
/// the CI part-name/MIME assertions run against this descriptor). The
/// bare-`.file()`-impossible invariant is structural: there is no constructor
/// path that omits `mime`, and [`upload_auto`] always builds the form from here.
struct UploadPart {
    name: &'static str,
    file_name: String,
    mime: &'static str,
    src: PathBuf,
}

/// The full multipart upload shape: the repeated `artifact` parts + the commit
/// `message` text part.
struct UploadParts {
    parts: Vec<UploadPart>,
    message: String,
}

/// Build the multipart descriptor for an `upload/auto/` push: one `artifact` part
/// per file (never `artifact[]`), each with an explicit per-extension MIME, plus
/// the commit message. Rejects a blank message at the boundary (D-A-methods) — it
/// does NOT substitute a placeholder like the spike's seed helper did.
fn build_upload_parts(
    stalx: &Path,
    tml: &Path,
    message: &str,
) -> Result<UploadParts, SpeleoDbError> {
    if message.trim().is_empty() {
        return Err(SpeleoDbError::Parse(
            "a non-empty commit message is required to upload".to_owned(),
        ));
    }
    let part = |src: &Path, default_name: &str| UploadPart {
        // Both parts are named "artifact" (repeated), NEVER "artifact[]" — the
        // server expects repeated same-named parts, not bracket-indexed ones.
        name: "artifact",
        file_name: src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(default_name)
            .to_owned(),
        mime: mime_for(src),
        src: src.to_path_buf(),
    };
    Ok(UploadParts {
        parts: vec![part(stalx, "project.stalx"), part(tml, "ariane.tml")],
        message: message.to_owned(),
    })
}

/// `PUT /api/v2/projects/{id}/upload/auto/` — push the project's `.stalx` and its
/// co-derived `ariane.tml` as a single multipart commit, returning the parsed
/// [`Project`] (its `latest_commit.id` is the adopted hexsha for #186 step 5).
///
/// Two `artifact` parts (never `artifact[]`), each streamed via `Part::file` with
/// an explicit MIME (D-A-multipart / D-A-mime). The caller must hold the project
/// mutex. `idempotent = false` → runs at most once (a commit must not
/// double-submit on a mid-response failure).
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "upload orchestration caller is #185 step 12 / #194"
    )
)]
pub(crate) fn upload_auto(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    stalx_path: &Path,
    tml_path: &Path,
    message: &str,
) -> Result<Project, SpeleoDbError> {
    use ureq::unversioned::multipart::{Form, Part};

    let descriptor = build_upload_parts(stalx_path, tml_path, message)?;
    let url = api_url(base, &format!("projects/{project_id}/upload/auto/"));
    let auth = bearer(token);

    // The Form/Part builders consume their inputs (`send(form)` takes the Form by
    // value), so the form is rebuilt inside the closure. `idempotent = false`
    // means the closure runs at most once regardless.
    let (status, body) = with_retry(base, insecure_http, false, || {
        let mut form = Form::new();
        for p in &descriptor.parts {
            let part = Part::file(&p.src)?
                .file_name(&p.file_name)
                .mime_str(p.mime)?;
            form = form.part(p.name, part);
        }
        let form = form.text("message", descriptor.message.as_str());
        let resp = agent_with_timeout(UPLOAD_TIMEOUT)
            .put(&url)
            .header("Authorization", auth.as_str())
            .send(form)?;
        read_status_body(resp)
    })?;

    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    // CONDITIONAL CLEAR (#191): the returned latest_commit.id is the adopted
    // hexsha; the edit-epoch comparison that clears has_unpushed_edits is owned
    // by #191 — do NOT clear the dirty bit unconditionally here.
    // FRESHNESS FOLD (#189/#191): authoritative Project available here; cache +
    // reset last_verify_at lands later (D-B1, #202).
    //
    // The upload/auto success body is an ENVELOPE — `{ files, message, hexsha,
    // browser_url, project: {…} }` — with the authoritative Project NESTED under
    // `project` (verified against the live server; a bare `parse_project` here
    // failed with "missing field `id`"). Parse the nested project, not the
    // envelope top level. `hexsha` / `browser_url` are surfaced later by #191/#197.
    #[derive(serde::Deserialize)]
    struct UploadAutoResponse {
        project: Project,
    }
    let parsed: UploadAutoResponse = serde_json::from_slice(&body)
        .map_err(|e| SpeleoDbError::Parse(format!("upload auto response: {e}")))?;
    Ok(parsed.project)
}

/// `POST /api/v2/projects/{id}/acquire/` — take the project mutex, returning the
/// updated [`Project`]. The upload endpoint requires the caller to hold the lock
/// (`UserOwnsProjectMutex`). `idempotent = false`. The real acquire/reconcile
/// orchestration is #194; this is the production primitive.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "lock orchestration caller is #194")
)]
pub(crate) fn acquire_lock(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<Project, SpeleoDbError> {
    post_no_body_project(
        base,
        token,
        insecure_http,
        &format!("projects/{project_id}/acquire/"),
        "acquire lock response",
    )
}

/// `POST /api/v2/projects/{id}/release/` — release the project mutex, returning
/// the updated [`Project`]. `idempotent = false`.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "lock orchestration caller is #194")
)]
pub(crate) fn release_lock(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<Project, SpeleoDbError> {
    post_no_body_project(
        base,
        token,
        insecure_http,
        &format!("projects/{project_id}/release/"),
        "release lock response",
    )
}

/// `POST /api/v2/projects/` — create a fresh project, returning the full parsed
/// [`Project`]. `idempotent = false`. The shipped create-on-SDB UX is #207; this
/// is the production primitive.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "create-project orchestration caller is #207")
)]
pub(crate) fn create_project(
    base: &str,
    token: &str,
    insecure_http: bool,
    name: &str,
) -> Result<Project, SpeleoDbError> {
    let url = api_url(base, "projects/");
    let auth = bearer(token);
    let payload = serde_json::json!({
        "name": name,
        "description": "Stalagmight project (auto-created)",
        "country": "US",
        "type": "other",
    })
    .to_string();

    // Non-idempotent write: run once so a mid-response failure can't double-submit.
    let (status, body) = with_retry(base, insecure_http, false, || {
        let resp = agent()
            .post(&url)
            .header("Authorization", auth.as_str())
            .header("Content-Type", "application/json")
            .send(payload.as_str())?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    // FRESHNESS FOLD (#189/#191): authoritative Project available here; cache +
    // reset last_verify_at lands later (D-B1, #202).
    parse_project(&body, "create project response")
}

/// Shared POST-with-no-body helper for the lock mutations (acquire/release):
/// non-idempotent (run once), parse the 2xx body into a [`Project`].
fn post_no_body_project(
    base: &str,
    token: &str,
    insecure_http: bool,
    suffix: &str,
    context: &str,
) -> Result<Project, SpeleoDbError> {
    let url = api_url(base, suffix);
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, false, || {
        let resp = agent()
            .post(&url)
            .header("Authorization", auth.as_str())
            .send("")?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    parse_project(&body, context)
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
    let (status, body) = with_retry(base, false, true, || {
        let resp = agent()
            .delete(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
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
    let (status, body) = with_retry(base, false, false, || {
        let resp = agent()
            .post(&url)
            .header("Authorization", auth.as_str())
            .header("Content-Type", "application/json")
            .send(payload.as_str())?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    Ok(())
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::{
        api_url, bearer, build_upload_parts, mime_for, parse_error_message, with_retry, UserInfo,
    };
    use crate::speleodb::SpeleoDbError;

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

    #[test]
    fn parse_error_message_is_display_only() {
        // Guards the #186 invariant at the unit level: parse_error_message only
        // ever yields a display STRING — it never returns or implies an action.
        // (The action is a pure fn of (endpoint, status); see contract.rs.)
        let m = parse_error_message(br#"{"detail":"forbidden"}"#);
        assert_eq!(m.as_deref(), Some("forbidden"));
    }

    #[test]
    fn upload_parts_both_named_artifact_never_bracketed() {
        let parts = build_upload_parts(
            Path::new("/x/project.stalx"),
            Path::new("/x/ariane.tml"),
            "msg",
        )
        .expect("descriptor builds");
        assert_eq!(parts.parts.len(), 2);
        for p in &parts.parts {
            assert_eq!(
                p.name, "artifact",
                "every part is the repeated `artifact` name"
            );
            assert_ne!(p.name, "artifact[]", "never the bracketed form");
        }
        assert_eq!(parts.message, "msg");
        assert_eq!(parts.parts[0].file_name, "project.stalx");
        assert_eq!(parts.parts[1].file_name, "ariane.tml");
    }

    #[test]
    fn upload_parts_carry_explicit_mime() {
        let parts = build_upload_parts(
            Path::new("/x/project.stalx"),
            Path::new("/x/ariane.tml"),
            "msg",
        )
        .expect("descriptor builds");
        assert_eq!(parts.parts[0].mime, "application/vnd.sqlite3");
        assert_eq!(parts.parts[1].mime, "application/octet-stream");
        // The extension→MIME map itself.
        assert_eq!(mime_for(Path::new("a.stalx")), "application/vnd.sqlite3");
        assert_eq!(mime_for(Path::new("a.tml")), "application/octet-stream");
        assert_eq!(mime_for(Path::new("a.bin")), "application/octet-stream");
    }

    #[test]
    fn upload_auto_rejects_blank_message() {
        for blank in ["", "   ", "\t\n"] {
            assert!(
                matches!(
                    build_upload_parts(Path::new("a.stalx"), Path::new("a.tml"), blank),
                    Err(SpeleoDbError::Parse(_))
                ),
                "blank message {blank:?} must be rejected"
            );
        }
    }

    #[test]
    fn project_dto_defaults_exclude_geojson() {
        use crate::speleodb::models::Project;
        // exclude_geojson defaults false when omitted, and parses when present.
        let omitted: Project =
            serde_json::from_str(r#"{"id":"a","name":"n"}"#).expect("minimal project");
        assert!(!omitted.exclude_geojson);
        let present: Project =
            serde_json::from_str(r#"{"id":"a","name":"n","exclude_geojson":true}"#)
                .expect("project with field");
        assert!(present.exclude_geojson);
    }

    #[test]
    fn get_project_parses_single_project() {
        // The get_project body is a bare single Project object (not an array).
        use crate::speleodb::models::Project;
        let p: Project = serde_json::from_str(
            r#"{"id":"11111111-1111-1111-1111-111111111111","name":"Solo","type":"other"}"#,
        )
        .expect("single project");
        assert_eq!(p.id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(p.name, "Solo");
    }

    #[test]
    fn with_retry_calls_tls_enforce_first() {
        // A public http base must be rejected by tls::enforce BEFORE the closure
        // runs even once (the closure increments a counter we assert stays 0).
        let calls = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&calls);
        let result = with_retry("http://8.8.8.8", false, true, move || {
            c.fetch_add(1, Ordering::SeqCst);
            Ok((200, Vec::new()))
        });
        assert!(matches!(
            result,
            Err(SpeleoDbError::InsecureEndpoint { .. })
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "closure must never run");
    }

    #[test]
    fn with_retry_reads_retry_transient_then_succeed() {
        // An idempotent read whose closure fails transiently the first time then
        // succeeds returns Ok — over a loopback base so tls::enforce allows it.
        let n = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&n);
        let out = with_retry("http://127.0.0.1:9", false, true, move || {
            let i = c.fetch_add(1, Ordering::SeqCst);
            if i == 0 {
                Err(ureq::Error::HostNotFound)
            } else {
                Ok((200, b"ok".to_vec()))
            }
        })
        .expect("idempotent read should retry then succeed");
        assert_eq!(out, (200, b"ok".to_vec()));
        assert_eq!(n.load(Ordering::SeqCst), 2, "one failure + one success");
    }

    #[test]
    fn with_retry_idempotent_5xx_is_retried() {
        // A 503 on an idempotent call is retried (treated like a transient error)
        // and the eventual 200 is returned.
        let n = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&n);
        let out = with_retry("http://127.0.0.1:9", false, true, move || {
            let i = c.fetch_add(1, Ordering::SeqCst);
            if i < 2 {
                Ok((503, b"busy".to_vec()))
            } else {
                Ok((200, b"ok".to_vec()))
            }
        })
        .expect("idempotent 5xx should retry to success");
        assert_eq!(out.0, 200);
        assert_eq!(n.load(Ordering::SeqCst), 3, "503, 503, 200");
    }

    #[test]
    fn with_retry_idempotent_5xx_exhausted_returns_5xx() {
        // If every idempotent attempt 5xxs, the final 5xx is surfaced (NOT a
        // transport error) so map_status can classify it as Retry.
        let n = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&n);
        let out = with_retry("http://127.0.0.1:9", false, true, move || {
            c.fetch_add(1, Ordering::SeqCst);
            Ok((500, b"down".to_vec()))
        })
        .expect("exhausted 5xx is still an Ok((status, body)), not a transport Err");
        assert_eq!(out.0, 500);
        assert_eq!(n.load(Ordering::SeqCst), 3, "1 + MAX_RETRIES attempts");
    }

    #[test]
    fn with_retry_writes_run_exactly_once() {
        // A non-idempotent write whose closure 5xxs runs ONCE and returns the 5xx
        // straight through (no retry — double-submit hazard).
        let n = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&n);
        let out = with_retry("http://127.0.0.1:9", false, false, move || {
            c.fetch_add(1, Ordering::SeqCst);
            Ok((500, b"down".to_vec()))
        })
        .expect("write returns the 5xx body");
        assert_eq!(out.0, 500);
        assert_eq!(n.load(Ordering::SeqCst), 1, "write must run exactly once");

        // A write whose closure errors also runs exactly once (then surfaces the
        // transport error).
        let n2 = Arc::new(AtomicUsize::new(0));
        let c2 = Arc::clone(&n2);
        let err = with_retry("http://127.0.0.1:9", false, false, move || {
            c2.fetch_add(1, Ordering::SeqCst);
            Err(ureq::Error::HostNotFound)
        })
        .expect_err("transport error surfaces");
        assert!(matches!(err, SpeleoDbError::Transport(_)));
        assert_eq!(
            n2.load(Ordering::SeqCst),
            1,
            "write transport error runs once"
        );
    }

    /// A one-shot loopback HTTP server that replies to each accepted connection
    /// with the next status from `statuses`, recording the raw request bytes. The
    /// only socket I/O in the unit suite (D-B15); doubles as the #187 127.0.0.1
    /// fixture.
    struct LoopbackStub {
        base: String,
        captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl LoopbackStub {
        fn start(statuses: Vec<u16>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
            let port = listener.local_addr().expect("addr").port();
            let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
            let cap = Arc::clone(&captured);
            let handle = std::thread::spawn(move || {
                for status in statuses {
                    let Ok((mut stream, _)) = listener.accept() else {
                        return;
                    };
                    // Drain the whole request (request line + headers + any
                    // multipart body) by reading with a short timeout until the
                    // socket goes quiet — the body can arrive in a TCP segment
                    // after the headers, so a single read would miss it.
                    use std::io::Read as _;
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(150)));
                    let mut captured_bytes: Vec<u8> = Vec::new();
                    let mut chunk = vec![0u8; 16 * 1024];
                    loop {
                        match stream.read(&mut chunk) {
                            // Peer closed write half — request fully delivered.
                            Ok(0) => break,
                            Ok(n) => captured_bytes.extend_from_slice(&chunk[..n]),
                            // WouldBlock/TimedOut (read timeout): the client is now
                            // waiting on our response, so the request is complete.
                            Err(_) => break,
                        }
                    }
                    cap.lock().expect("capture lock").push(captured_bytes);
                    let body = b"{}";
                    let resp = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.write_all(body);
                    let _ = stream.flush();
                }
            });
            Self {
                base: format!("http://127.0.0.1:{port}"),
                captured,
                handle: Some(handle),
            }
        }

        fn captured(&self) -> Vec<Vec<u8>> {
            self.captured.lock().expect("capture lock").clone()
        }

        fn join(&mut self) {
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    #[test]
    fn loopback_read_retries_503_then_200() {
        // A real socket: an idempotent GET that the stub answers 503,503,200 must
        // succeed after the backoff, and the stub must have served 3 connections.
        let mut stub = LoopbackStub::start(vec![503, 503, 200]);
        let url = format!("{}/api/v2/projects/", stub.base);
        let base = stub.base.clone();
        let (status, _body) = with_retry(&base, false, true, || {
            let resp = super::agent().get(&url).call()?;
            super::read_status_body(resp)
        })
        .expect("read retries to success");
        assert_eq!(status, 200);
        stub.join();
        assert_eq!(stub.captured().len(), 3, "served 503, 503, 200");
    }

    #[test]
    fn loopback_write_attempted_once() {
        // A non-idempotent write that the stub answers 503 must hit the socket
        // exactly once (no double-submit), surfacing the 503.
        let mut stub = LoopbackStub::start(vec![503]);
        let url = format!("{}/api/v2/projects/", stub.base);
        let base = stub.base.clone();
        let (status, _body) = with_retry(&base, false, false, || {
            let resp = super::agent().post(&url).send("")?;
            super::read_status_body(resp)
        })
        .expect("write returns the 503");
        assert_eq!(status, 503);
        stub.join();
        assert_eq!(
            stub.captured().len(),
            1,
            "write hit the socket exactly once"
        );
    }

    #[test]
    fn loopback_multipart_parts_on_the_wire() {
        // The real multipart PUT must carry two `name="artifact"` parts with their
        // explicit Content-Type headers — asserted against the captured bytes.
        let dir = tempfile::tempdir().expect("tempdir");
        let stalx = dir.path().join("project.stalx");
        let tml = dir.path().join("ariane.tml");
        let mut f = std::fs::File::create(&stalx).expect("create stalx");
        f.write_all(b"SQLITE_BYTES").expect("write stalx");
        let mut g = std::fs::File::create(&tml).expect("create tml");
        g.write_all(b"<tml/>").expect("write tml");

        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        let project = super::upload_auto(
            &base,
            "tok",
            false,
            "11111111-1111-1111-1111-111111111111",
            &stalx,
            &tml,
            "wire test",
        );
        stub.join();
        // The stub returns `{}` which lacks id/name, so parsing fails — that's
        // fine; we only care about the bytes on the wire.
        let _ = project;
        let captured = stub.captured();
        assert_eq!(captured.len(), 1, "one PUT attempt");
        let wire = String::from_utf8_lossy(&captured[0]);
        let artifact_parts = wire.matches("name=\"artifact\"").count();
        assert_eq!(
            artifact_parts, 2,
            "two repeated `artifact` parts on the wire"
        );
        assert!(
            !wire.contains("artifact[]"),
            "never the bracketed `artifact[]` form"
        );
        assert!(
            wire.contains("application/vnd.sqlite3"),
            "the .stalx part carries its explicit MIME"
        );
        assert!(
            wire.contains("application/octet-stream"),
            "the .tml part carries its explicit MIME"
        );
        assert!(wire.contains("PUT "), "it is a PUT");
    }
}
