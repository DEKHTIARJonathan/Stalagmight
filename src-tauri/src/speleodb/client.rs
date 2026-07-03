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

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;

use super::metrics::{Endpoint, Outcome};
use super::models::{
    Commit, Permission, Project, RevisionHistory, Team, TeamPermission, TeamPermissionList,
    UserAutocomplete, UserPermission, UserPermissionList,
};
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
/// the top — the single chokepoint a new method cannot forget (#187 step 5). The
/// same chokepoint carries the #210 traffic instrumentation: `endpoint` labels
/// each attempt so [`super::metrics::record`] emits its count + latency + outcome
/// (a new method cannot forget that either — it must pass an [`Endpoint`]).
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
    endpoint: Endpoint,
    mut attempt: impl FnMut() -> Result<(u16, Vec<u8>), ureq::Error>,
) -> Result<(u16, Vec<u8>), SpeleoDbError> {
    // #187: block public `http://` / scheme-less endpoints before any dial. A
    // policy block is not server traffic, so it is intentionally not recorded.
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
        // #210: time each attempt (the backoff sleep above is excluded) and
        // record it as one server hit — a retried 5xx really re-hits the server,
        // so counting per attempt is what makes a retry storm legible.
        let started = std::time::Instant::now();
        let result = attempt();
        let elapsed = started.elapsed();
        let outcome = match &result {
            Ok((status, _)) => Outcome::from_status(*status),
            Err(_) => Outcome::NetworkError,
        };
        super::metrics::record(endpoint, outcome, elapsed);
        match result {
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
    Err(SpeleoDbError::Transport(clean_transport(
        &last_err.unwrap_or_else(|| "unknown transport error".to_owned()),
    )))
}

/// Strip `ureq`/std-io noise from a transport error string so it reads as a
/// user-facing detail: drop a leading `io: ` and a trailing ` (os error N)`.
/// (e.g. `io: Connection refused (os error 111)` → `Connection refused`.)
fn clean_transport(raw: &str) -> String {
    let s = raw.strip_prefix("io: ").unwrap_or(raw);
    let s = match s.rfind(" (os error ") {
        Some(idx) if s.ends_with(')') => &s[..idx],
        _ => s,
    };
    s.trim().to_owned()
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
    // DRF validation error: `{errors: {non_field_errors: ["..."], field: ["..."]}}`.
    // Surface the first human sentence (non_field_errors first, else any field's
    // first message) rather than dumping the raw JSON object at the user.
    if let Some(errors) = value.get("errors") {
        return first_error_sentence(errors).or_else(|| Some(errors.to_string()));
    }
    None
}

/// Pull the first human message out of a DRF `errors` object: prefer
/// `non_field_errors`, else the first string in the first field (by sorted key).
///
/// The SpeleoDB v2 endpoints raise `non_field_errors` (from a serializer's
/// `validate()`) for the real failure cases the client surfaces - bad
/// credentials, etc. - and per-field errors only for a missing/invalid single
/// field; DRF never mixes both in one 400 (it runs `validate()` only after every
/// per-field check passes). So `non_field_errors` wins whenever present. For a
/// multi-field 400 with no `non_field_errors`, the field pick is made over
/// EXPLICITLY sorted keys so the surfaced sentence is deterministic and can't
/// silently depend on `serde_json`'s object-map ordering (a `BTreeMap` today, but
/// a feature-unified `preserve_order` elsewhere would otherwise change which field
/// wins).
fn first_error_sentence(errors: &serde_json::Value) -> Option<String> {
    fn first_string(v: &serde_json::Value) -> Option<String> {
        match v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Array(a) => a.iter().find_map(|x| x.as_str().map(str::to_owned)),
            _ => None,
        }
    }
    if let Some(m) = errors.get("non_field_errors").and_then(first_string) {
        return Some(m);
    }
    let obj = errors.as_object()?;
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort();
    keys.into_iter()
        .find_map(|k| obj.get(k).and_then(first_string))
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
    let (status, body) = with_retry(base, insecure_http, true, Endpoint::Login, || {
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

    let (status, body) = with_retry(base, insecure_http, true, Endpoint::ListProjects, || {
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
/// `project_id` (UUID) before calling. Consumed by #194 start_editing (the
/// lock-holder re-GET) and #202 (the freshness fold).
pub(crate) fn get_project(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<Project, SpeleoDbError> {
    get_project_inner(
        base,
        token,
        insecure_http,
        project_id,
        REQUEST_TIMEOUT,
        true,
    )
}

/// Short per-request budget for the best-effort #202 lazy lock re-verify probe. It
/// runs UNDER the command lock, so a slow/hung server must not stall the whole
/// command pipeline (autosave included) for the full 30s x (1 + retries) read
/// budget; a tight timeout keeps the worst-case block bounded.
const REVERIFY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Like [`get_project`] but with a tight, NON-retried budget for the #202 lazy lock
/// re-verify: one attempt, [`REVERIFY_PROBE_TIMEOUT`]. #202 is not a correctness
/// guard (a probe miss allows the edit and the release fence backstops it), so a
/// single fast attempt is the right trade - it must never freeze the editor.
pub(crate) fn get_project_probe(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<Project, SpeleoDbError> {
    get_project_inner(
        base,
        token,
        insecure_http,
        project_id,
        REVERIFY_PROBE_TIMEOUT,
        false,
    )
}

fn get_project_inner(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    timeout: Duration,
    idempotent: bool,
) -> Result<Project, SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/"));
    let auth = bearer(token);

    let (status, body) = with_retry(
        base,
        insecure_http,
        idempotent,
        Endpoint::GetProject,
        || {
            let resp = agent_with_timeout(timeout)
                .get(&url)
                .header("Authorization", auth.as_str())
                .call()?;
            read_status_body(resp)
        },
    )?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    // FRESHNESS FOLD (#189/#191): authoritative Project available here; cache +
    // reset last_verify_at lands later (D-B1, #202).
    serde_json::from_slice(&body).map_err(|e| SpeleoDbError::Parse(format!("project detail: {e}")))
}

/// `GET /api/v2/projects/{id}/revisions/` — the project's linear commit history
/// (#193). Used by guardrail-7 ancestry recovery to decide, after a push whose
/// confirmation was lost, whether our edit actually landed on the server. The
/// caller validates `project_id` (UUID) first. A GET, so it is retry-safe.
/// Consumed by #197 done (ancestry recovery).
pub(crate) fn get_revisions(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<RevisionHistory, SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/revisions/"));
    let auth = bearer(token);

    let (status, body) = with_retry(base, insecure_http, true, Endpoint::GetRevisions, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    serde_json::from_slice(&body).map_err(|e| SpeleoDbError::Parse(format!("revisions: {e}")))
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

    let (status, body) = with_retry(base, insecure_http, true, Endpoint::FetchUser, || {
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

    let (status, body) = with_retry(base, insecure_http, true, Endpoint::DownloadDump, || {
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

/// MIME type for an artifact part, by extension (D-A-mime). The server selects
/// the processor by *extension* via the AUTO catch-all, but then validates the
/// part's `Content-Type` against that processor's allow-list — so for `.tml` the
/// explicit MIME is **REQUIRED, not just robustness**: `ArianeTMLFileProcessor`
/// allows only `application/octet-stream` / `application/zip` (no `text/plain`),
/// and a bare `.tml` part is rejected with HTTP 400 (OPEN-1, resolved live at
/// #184: `live_open1_bare_tml_mime_outcome`; see `docs/speleodb-dev-testing.md`).
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
    let part = |src: &Path, wire_name: &str| UploadPart {
        // Both parts are named "artifact" (repeated), NEVER "artifact[]" — the
        // server expects repeated same-named parts, not bracket-indexed ones.
        name: "artifact",
        // The multipart filename is the CANONICAL server-side name, decoupled from
        // the local source path's basename. The server's upload/auto/ is additive
        // (it `git add`s each uploaded file by its name onto ToT), so the `.stalx`
        // MUST always land as `project.stalx` — else a push from the scratch
        // `snapshot.stalx` would commit a SECOND `.stalx` beside the canonical one,
        // and the next download_dump would be an ambiguous multi-`.stalx` repo.
        file_name: wire_name.to_owned(),
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
    let (status, body) = with_retry(base, insecure_http, false, Endpoint::Upload, || {
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
    // CONDITIONAL CLEAR (#191): the adopted hexsha is the edit-epoch the
    // comparison that clears has_unpushed_edits is owned by #191 — do NOT clear
    // the dirty bit unconditionally here.
    // FRESHNESS FOLD (#189/#191): authoritative Project available here; cache +
    // reset last_verify_at lands later (D-B1, #202).
    //
    // The upload/auto success body is an ENVELOPE — `{ files, message, hexsha,
    // browser_url, project: {…} }` — with the Project NESTED under `project`
    // (verified live; a bare `parse_project` here failed with "missing field
    // `id`"). The authoritative SHA of the commit THIS push created is the
    // TOP-LEVEL `hexsha`. The nested `project.latest_commit` is
    // eventually-consistent and was observed live still pointing at the PRIOR tip
    // (the service-account root creation commit) immediately after a push — so we
    // adopt `hexsha`, not the nested pointer, and overwrite `latest_commit` with
    // it so every caller's `latest_commit.id` is the commit just created (#197).
    parse_upload_auto_response(&body)
}

/// Parse the `upload/auto/` success envelope into the adopted [`Project`]. The
/// top-level `hexsha` is the SHA of the commit THIS push created; prefer it and
/// overwrite `latest_commit` so callers adopt the right BASE. If a deployment
/// omits the top-level `hexsha`, fall back to the nested `project.latest_commit`
/// rather than failing an ACCEPTED (200) push as a Parse/Fatal error — that would
/// strand the dirty bit forever (#197 review); a slightly-stale BASE self-heals via
/// the ancestry fence on the next Sync.
fn parse_upload_auto_response(body: &[u8]) -> Result<Project, SpeleoDbError> {
    #[derive(serde::Deserialize)]
    struct UploadAutoResponse {
        #[serde(default)]
        hexsha: Option<String>,
        project: Project,
    }
    let parsed: UploadAutoResponse = serde_json::from_slice(body)
        .map_err(|e| SpeleoDbError::Parse(format!("upload auto response: {e}")))?;
    let mut project = parsed.project;
    if let Some(hexsha) = parsed.hexsha.filter(|h| !h.is_empty()) {
        project.latest_commit = Some(Commit { id: hexsha });
    }
    Ok(project)
}

/// `POST /api/v2/projects/{id}/acquire/` — take the project mutex, returning the
/// updated [`Project`]. The upload endpoint requires the caller to hold the lock
/// (`UserOwnsProjectMutex`). `idempotent = false`. Consumed by #194
/// `speleodb_start_editing`.
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
        Endpoint::Acquire,
        &format!("projects/{project_id}/acquire/"),
        "acquire lock response",
    )
}

/// `POST /api/v2/projects/{id}/release/` — release the project mutex, returning
/// the updated [`Project`]. `idempotent = false`. Consumed by #194/#197.
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
        Endpoint::Release,
        &format!("projects/{project_id}/release/"),
        "release lock response",
    )
}

/// `DELETE /api/v2/user/release_all_locks/` — release EVERY write lock the token
/// holder currently holds, returning `()` on success. Idempotent (releasing when
/// none are held is a no-op), so a transient-transport retry is safe. Drives the
/// held-lock resume/release prompt's "Release all" choice (#201, B1).
pub(crate) fn release_all_locks(
    base: &str,
    token: &str,
    insecure_http: bool,
) -> Result<(), SpeleoDbError> {
    let url = api_url(base, "user/release_all_locks/");
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, true, Endpoint::ReleaseAll, || {
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

/// `PATCH /api/v2/projects/{id}/` — update project metadata, returning the updated
/// [`Project`]. Non-idempotent (`idempotent = false`) so a mid-response transport
/// failure can't double-apply. Consumed by #200's Enable-rendering action (PATCH
/// `exclude_geojson = false`); the server enforces permission (READ_AND_WRITE, no
/// lock) on the metadata PATCH.
pub(crate) fn patch_project(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    payload: &str,
) -> Result<Project, SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/"));
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, false, Endpoint::PatchProject, || {
        let resp = agent()
            .patch(&url)
            .header("Authorization", auth.as_str())
            .header("Content-Type", "application/json")
            .send(payload)?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    parse_project(&body, "patch project response")
}

/// `POST /api/v2/projects/` with a caller-built JSON body - create a fresh project
/// and return the full parsed [`Project`]. `idempotent = false` (run once so a
/// mid-response failure can't double-submit a create). The #207 create-on-SDB
/// orchestration builds the payload (name/description/country/visibility/`type`/
/// lat-long/`exclude_geojson`); `created_by` is injected server-side.
pub(crate) fn create_project_with(
    base: &str,
    token: &str,
    insecure_http: bool,
    payload: &str,
) -> Result<Project, SpeleoDbError> {
    let url = api_url(base, "projects/");
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, false, Endpoint::CreateProject, || {
        let resp = agent()
            .post(&url)
            .header("Authorization", auth.as_str())
            .header("Content-Type", "application/json")
            .send(payload)?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    // FRESHNESS FOLD (#189/#191): authoritative Project available here; cache +
    // reset last_verify_at lands later (D-B1, #202).
    parse_project(&body, "create project response")
}

/// Convenience: create a minimal `other`-type project by name. Test/seed helper
/// (the #207 production path uses [`create_project_with`] with a full payload).
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "name-only convenience; prod create-on-SDB (#207) uses create_project_with"
    )
)]
pub(crate) fn create_project(
    base: &str,
    token: &str,
    insecure_http: bool,
    name: &str,
) -> Result<Project, SpeleoDbError> {
    let payload = serde_json::json!({
        "name": name,
        "description": "Stalagmight project (auto-created)",
        "country": "US",
        "type": "other",
    })
    .to_string();
    create_project_with(base, token, insecure_http, &payload)
}

/// Shared POST-with-no-body helper for the lock mutations (acquire/release):
/// non-idempotent (run once), parse the 2xx body into a [`Project`].
fn post_no_body_project(
    base: &str,
    token: &str,
    insecure_http: bool,
    endpoint: Endpoint,
    suffix: &str,
    context: &str,
) -> Result<Project, SpeleoDbError> {
    let url = api_url(base, suffix);
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, false, endpoint, || {
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

/// `DELETE /api/v2/projects/{id}/` - soft-delete the project (the server
/// deactivates it and a cron purges after ~30 days), returning `()` on success.
/// DELETE is idempotent (deleting an already-deleted project is a no-op/404), so a
/// transient-transport retry is safe. Consumed by #215's Delete-project action and
/// the live tests' per-run cleanup. Does not require releasing the lock first.
pub(crate) fn delete_project(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<(), SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/"));
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, true, Endpoint::DeleteProject, || {
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

/// Send `payload` as a JSON body with an arbitrary `method` to `suffix`, enforcing
/// the http private-network policy first ([`super::tls::enforce`], the #187
/// chokepoint); a 2xx maps to `Ok(())`. The collaborator permission-detail
/// endpoints (#215) are non-idempotent writes routed here: they run exactly once
/// (no retry, matching every other SDB write), AND the `remove` variants are a
/// DELETE-with-body - which ureq's typestate `.delete()` builder cannot express -
/// so all three verbs go through `Agent::run` with an explicit `http::Request`.
fn send_json_request(
    base: &str,
    token: &str,
    insecure_http: bool,
    endpoint: Endpoint,
    method: http::Method,
    suffix: &str,
    payload: &serde_json::Value,
) -> Result<(), SpeleoDbError> {
    // #187: block public `http://` / scheme-less endpoints before any dial (the
    // same gate `with_retry` runs; these writes bypass the retry loop, never it).
    // A policy block is not server traffic, so it is intentionally not recorded.
    super::tls::enforce(base, insecure_http)?;
    let url = api_url(base, suffix);
    let request = http::Request::builder()
        .method(method)
        .uri(url)
        .header("Authorization", bearer(token))
        .header("Content-Type", "application/json")
        .body(payload.to_string())
        .map_err(|e| SpeleoDbError::Parse(format!("build request: {e}")))?;
    // #210: this write bypasses `with_retry`, so record its one attempt here — the
    // same count + latency + outcome the retry-loop chokepoint emits. Time and
    // classify the FULL attempt (dial + status + body read), exactly as
    // `with_retry`'s timed closure does, so latency covers the body read and a
    // mid-body read failure counts as `network-error` on both paths (not a false
    // `ok`/`server-error` off the status line alone).
    let started = std::time::Instant::now();
    let result = agent().run(request).and_then(read_status_body);
    let outcome = match &result {
        Ok((status, _)) => Outcome::from_status(*status),
        Err(_) => Outcome::NetworkError,
    };
    super::metrics::record(endpoint, outcome, started.elapsed());
    let (status, body) =
        result.map_err(|e| SpeleoDbError::Transport(clean_transport(&e.to_string())))?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    Ok(())
}

/// `GET /api/v2/projects/{id}/permissions/user/` - list the project's active
/// per-user permission grants (#215). A GET, so retry-safe; requires READ_ONLY+
/// server-side (403 below that). Only the `permissions[]` array is consumed.
pub(crate) fn list_user_permissions(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<Vec<UserPermission>, SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/permissions/user/"));
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, true, Endpoint::ListPermissions, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    let list: UserPermissionList = serde_json::from_slice(&body)
        .map_err(|e| SpeleoDbError::Parse(format!("user permissions: {e}")))?;
    Ok(list.permissions)
}

/// `POST /api/v2/projects/{id}/permission/user/detail/` `{user, level}` - grant a
/// collaborator a permission level (#215). ADMIN-gated server-side.
pub(crate) fn add_user_permission(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    email: &str,
    level: Permission,
) -> Result<(), SpeleoDbError> {
    send_json_request(
        base,
        token,
        insecure_http,
        Endpoint::MutatePermission,
        http::Method::POST,
        &format!("projects/{project_id}/permission/user/detail/"),
        &serde_json::json!({ "user": email, "level": level }),
    )
}

/// `PUT /api/v2/projects/{id}/permission/user/detail/` `{user, level}` - change an
/// existing collaborator's permission level (#215). ADMIN-gated server-side.
pub(crate) fn set_user_permission(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    email: &str,
    level: Permission,
) -> Result<(), SpeleoDbError> {
    send_json_request(
        base,
        token,
        insecure_http,
        Endpoint::MutatePermission,
        http::Method::PUT,
        &format!("projects/{project_id}/permission/user/detail/"),
        &serde_json::json!({ "user": email, "level": level }),
    )
}

/// `DELETE /api/v2/projects/{id}/permission/user/detail/` with body `{user}` -
/// remove a collaborator (soft, #215). ADMIN-gated server-side.
pub(crate) fn remove_user_permission(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    email: &str,
) -> Result<(), SpeleoDbError> {
    send_json_request(
        base,
        token,
        insecure_http,
        Endpoint::MutatePermission,
        http::Method::DELETE,
        &format!("projects/{project_id}/permission/user/detail/"),
        &serde_json::json!({ "user": email }),
    )
}

/// `GET /api/v2/projects/{id}/permissions/team/` - list the project's active
/// per-team permission grants (#215). A GET, so retry-safe.
pub(crate) fn list_team_permissions(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
) -> Result<Vec<TeamPermission>, SpeleoDbError> {
    let url = api_url(base, &format!("projects/{project_id}/permissions/team/"));
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, true, Endpoint::ListPermissions, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    let list: TeamPermissionList = serde_json::from_slice(&body)
        .map_err(|e| SpeleoDbError::Parse(format!("team permissions: {e}")))?;
    Ok(list.permissions)
}

/// `POST /api/v2/projects/{id}/permission/team/detail/` `{team, level}` - grant a
/// team a permission level (#215). ADMIN-gated; the server rejects `ADMIN` for a
/// team (teams may only hold WEB_VIEWER / READ_ONLY / READ_AND_WRITE).
pub(crate) fn add_team_permission(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    team_id: &str,
    level: Permission,
) -> Result<(), SpeleoDbError> {
    send_json_request(
        base,
        token,
        insecure_http,
        Endpoint::MutatePermission,
        http::Method::POST,
        &format!("projects/{project_id}/permission/team/detail/"),
        &serde_json::json!({ "team": team_id, "level": level }),
    )
}

/// `PUT /api/v2/projects/{id}/permission/team/detail/` `{team, level}` - change a
/// team's permission level (#215). ADMIN-gated; no `ADMIN` for teams.
pub(crate) fn set_team_permission(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    team_id: &str,
    level: Permission,
) -> Result<(), SpeleoDbError> {
    send_json_request(
        base,
        token,
        insecure_http,
        Endpoint::MutatePermission,
        http::Method::PUT,
        &format!("projects/{project_id}/permission/team/detail/"),
        &serde_json::json!({ "team": team_id, "level": level }),
    )
}

/// `DELETE /api/v2/projects/{id}/permission/team/detail/` with body `{team}` -
/// revoke a team's access (soft, #215). ADMIN-gated server-side.
pub(crate) fn remove_team_permission(
    base: &str,
    token: &str,
    insecure_http: bool,
    project_id: &str,
    team_id: &str,
) -> Result<(), SpeleoDbError> {
    send_json_request(
        base,
        token,
        insecure_http,
        Endpoint::MutatePermission,
        http::Method::DELETE,
        &format!("projects/{project_id}/permission/team/detail/"),
        &serde_json::json!({ "team": team_id }),
    )
}

/// `GET /api/v2/teams/` - the authenticated user's teams (a bare JSON array), for
/// the add-team picker and to resolve a team-permission UUID to a display name
/// (#215). A GET, so retry-safe.
pub(crate) fn list_teams(
    base: &str,
    token: &str,
    insecure_http: bool,
) -> Result<Vec<Team>, SpeleoDbError> {
    let url = api_url(base, "teams/");
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, true, Endpoint::ListTeams, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    serde_json::from_slice(&body).map_err(|e| SpeleoDbError::Parse(format!("teams: {e}")))
}

/// `GET /api/v2/user/autocomplete/?query=<substr>` - up to 10 users whose email or
/// name contains `query` (the server requires >= 3 chars; the caller guards that).
/// Backs the add-collaborator email typeahead (#215). A GET, so retry-safe. The
/// query is percent-encoded so spaces / `@` / `&` in a partial name or email cannot
/// break the URL.
pub(crate) fn list_user_autocomplete(
    base: &str,
    token: &str,
    insecure_http: bool,
    query: &str,
) -> Result<Vec<UserAutocomplete>, SpeleoDbError> {
    let encoded = utf8_percent_encode(query, NON_ALPHANUMERIC);
    let url = api_url(base, &format!("user/autocomplete/?query={encoded}"));
    let auth = bearer(token);
    let (status, body) = with_retry(base, insecure_http, true, Endpoint::Autocomplete, || {
        let resp = agent()
            .get(&url)
            .header("Authorization", auth.as_str())
            .call()?;
        read_status_body(resp)
    })?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body));
    }
    serde_json::from_slice(&body)
        .map_err(|e| SpeleoDbError::Parse(format!("user autocomplete: {e}")))
}

/// Test-only convenience: grant `email` the given `level` string on the project.
/// Drives the two-account live tests' collaborator setup; the production path is
/// [`add_user_permission`] (typed `Permission`). The dev box is a private address,
/// so `insecure_http = false` is fine here.
#[cfg(test)]
pub(crate) fn grant_permission(
    base: &str,
    token: &str,
    project_id: &str,
    email: &str,
    level: &str,
) -> Result<(), SpeleoDbError> {
    send_json_request(
        base,
        token,
        false,
        Endpoint::MutatePermission,
        http::Method::POST,
        &format!("projects/{project_id}/permission/user/detail/"),
        &serde_json::json!({ "user": email, "level": level }),
    )
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
        add_team_permission, add_user_permission, api_url, bearer, build_upload_parts,
        clean_transport, delete_project, list_teams, list_user_autocomplete, list_user_permissions,
        mime_for, parse_error_message, parse_upload_auto_response, remove_team_permission,
        remove_user_permission, set_user_permission, with_retry, Endpoint, RevisionHistory,
        UserInfo,
    };
    use crate::speleodb::{Permission, SpeleoDbError};

    #[test]
    fn revisions_payload_decodes_verified_v2_field_names() {
        // The whole sync engine keys off the /revisions/ field names `parent_ids` and
        // `author_email`, both #[serde(default)] — so a RENAMED server key would
        // SILENTLY default (parent_ids=[] → every commit reads as a root → tip None →
        // fail closed; author_email="" → stranger → Diverged) with no parse error. The
        // only other decode of a real payload is the #[ignore] live test, so this
        // recorded fixture (the verified v2 contract, incl. the extra fields serde
        // ignores) locks the names in CI. (#197 review)
        let payload = r#"{
            "project": {"id": "11111111-1111-1111-1111-111111111111", "name": "X"},
            "commits": [
                {"id": "root0", "parent_ids": [], "author_email": "svc@speleodb.org",
                 "author_name": "Service", "authored_date": "2026-06-01T00:00:00Z", "message": "init"},
                {"id": "childA", "parent_ids": ["root0"], "author_email": "Me@Example.COM",
                 "author_name": "Me", "authored_date": "2026-06-02T00:00:00Z", "message": "edit"}
            ]
        }"#;
        let history: RevisionHistory = serde_json::from_slice(payload.as_bytes())
            .expect("verified v2 revisions payload decodes");
        assert_eq!(history.commits.len(), 2, "both commits decode");
        let child = history
            .commits
            .iter()
            .find(|c| c.id == "childA")
            .expect("childA present");
        assert_eq!(
            child.parent_ids,
            vec!["root0".to_owned()],
            "parent_ids MUST populate from the `parent_ids` key (a rename would silently default to [])"
        );
        assert_eq!(
            child.author_email, "Me@Example.COM",
            "author_email MUST populate from the `author_email` key (a rename would default to \"\")"
        );
        // parent_ids actually drives the topology leaf the fence trusts.
        assert_eq!(
            crate::speleodb::sync::tip_of(&history.commits),
            Some("childA"),
            "tip_of resolves the leaf via parent_ids"
        );
    }

    #[test]
    fn upload_auto_response_prefers_hexsha_then_falls_back_to_nested() {
        // #197 review: a top-level hexsha is the commit THIS push created → adopt it.
        // But a 200 envelope WITHOUT a top-level hexsha must NOT fail as Parse/Fatal
        // (which would strand the dirty bit) — fall back to the nested latest_commit.
        let proj = r#"{"id":"11111111-1111-1111-1111-111111111111","name":"Up","latest_commit":{"id":"nested-prior"}}"#;

        let with = format!("{{\"hexsha\":\"top-new\",\"project\":{proj}}}");
        let adopted = parse_upload_auto_response(with.as_bytes()).expect("parse with hexsha");
        assert_eq!(
            adopted.latest_commit.as_ref().map(|c| c.id.as_str()),
            Some("top-new"),
            "a present top-level hexsha is adopted as the new BASE"
        );

        let without = format!("{{\"project\":{proj}}}");
        let fallback =
            parse_upload_auto_response(without.as_bytes()).expect("missing hexsha must not error");
        assert_eq!(
            fallback.latest_commit.as_ref().map(|c| c.id.as_str()),
            Some("nested-prior"),
            "a 200 lacking hexsha falls back to the nested latest_commit, not a Parse error"
        );

        // An empty-string hexsha is treated as absent (same fallback).
        let empty = format!("{{\"hexsha\":\"\",\"project\":{proj}}}");
        let empty_fb =
            parse_upload_auto_response(empty.as_bytes()).expect("empty hexsha must not error");
        assert_eq!(
            empty_fb.latest_commit.as_ref().map(|c| c.id.as_str()),
            Some("nested-prior")
        );
    }

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
        // The auth-token bad-credentials shape: a nested `errors` object - surface
        // the human sentence (non_field_errors first), never the raw JSON.
        assert_eq!(
            parse_error_message(br#"{"errors":{"non_field_errors":["bad"]}}"#).as_deref(),
            Some("bad")
        );
        // A field error with no non_field_errors falls back to the first field msg.
        assert_eq!(
            parse_error_message(br#"{"errors":{"email":["Enter a valid email."]}}"#).as_deref(),
            Some("Enter a valid email.")
        );
        // A multi-field error with no non_field_errors picks the first field by
        // SORTED key, deterministically, regardless of JSON key order on the wire
        // (both orderings below must yield the same "email" message).
        assert_eq!(
            parse_error_message(br#"{"errors":{"password":["Too short."],"email":["Required."]}}"#)
                .as_deref(),
            Some("Required.")
        );
        assert_eq!(
            parse_error_message(br#"{"errors":{"email":["Required."],"password":["Too short."]}}"#)
                .as_deref(),
            Some("Required.")
        );
        // non_field_errors still wins over any per-field entry.
        assert_eq!(
            parse_error_message(
                br#"{"errors":{"email":["Required."],"non_field_errors":["Bad login."]}}"#
            )
            .as_deref(),
            Some("Bad login.")
        );
        assert_eq!(parse_error_message(b"not json"), None);
    }

    #[test]
    fn clean_transport_strips_io_and_os_error_noise() {
        assert_eq!(
            clean_transport("io: Connection refused (os error 111)"),
            "Connection refused"
        );
        assert_eq!(clean_transport("io: Connection reset"), "Connection reset");
        // A message without the noise is returned as-is (trimmed).
        assert_eq!(clean_transport("timed out"), "timed out");
        // A parenthetical that isn't an os-error suffix is preserved.
        assert_eq!(
            clean_transport("dns error (lookup failed)"),
            "dns error (lookup failed)"
        );
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
        // The `.stalx` source is the scratch SNAPSHOT path (its real basename in the
        // push pipeline) — the wire filename MUST still be the canonical
        // `project.stalx`, NOT the source basename. The server is additive, so a
        // `snapshot.stalx` wire name would commit a second `.stalx` and corrupt the
        // repo into an ambiguous multi-`.stalx` dump. (Regression: this test used to
        // pass a `project.stalx` source, masking exactly that bug.)
        let parts = build_upload_parts(
            Path::new("/cache/snapshot.stalx"),
            Path::new("/cache/ariane.tml"),
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
        assert_eq!(
            parts.parts[0].file_name, "project.stalx",
            "the .stalx uploads under the canonical name, not the scratch basename"
        );
        assert_eq!(parts.parts[1].file_name, "ariane.tml");
        // The source path is still the snapshot (that's what gets read + streamed).
        assert_eq!(parts.parts[0].src, Path::new("/cache/snapshot.stalx"));
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
        let result = with_retry(
            "http://8.8.8.8",
            false,
            true,
            Endpoint::ListProjects,
            move || {
                c.fetch_add(1, Ordering::SeqCst);
                Ok((200, Vec::new()))
            },
        );
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
        let out = with_retry(
            "http://127.0.0.1:9",
            false,
            true,
            Endpoint::ListProjects,
            move || {
                let i = c.fetch_add(1, Ordering::SeqCst);
                if i == 0 {
                    Err(ureq::Error::HostNotFound)
                } else {
                    Ok((200, b"ok".to_vec()))
                }
            },
        )
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
        let out = with_retry(
            "http://127.0.0.1:9",
            false,
            true,
            Endpoint::ListProjects,
            move || {
                let i = c.fetch_add(1, Ordering::SeqCst);
                if i < 2 {
                    Ok((503, b"busy".to_vec()))
                } else {
                    Ok((200, b"ok".to_vec()))
                }
            },
        )
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
        let out = with_retry(
            "http://127.0.0.1:9",
            false,
            true,
            Endpoint::ListProjects,
            move || {
                c.fetch_add(1, Ordering::SeqCst);
                Ok((500, b"down".to_vec()))
            },
        )
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
        let out = with_retry(
            "http://127.0.0.1:9",
            false,
            false,
            Endpoint::ListProjects,
            move || {
                c.fetch_add(1, Ordering::SeqCst);
                Ok((500, b"down".to_vec()))
            },
        )
        .expect("write returns the 5xx body");
        assert_eq!(out.0, 500);
        assert_eq!(n.load(Ordering::SeqCst), 1, "write must run exactly once");

        // A write whose closure errors also runs exactly once (then surfaces the
        // transport error).
        let n2 = Arc::new(AtomicUsize::new(0));
        let c2 = Arc::clone(&n2);
        let err = with_retry(
            "http://127.0.0.1:9",
            false,
            false,
            Endpoint::ListProjects,
            move || {
                c2.fetch_add(1, Ordering::SeqCst);
                Err(ureq::Error::HostNotFound)
            },
        )
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
        let (status, _body) = with_retry(&base, false, true, Endpoint::ListProjects, || {
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
        let (status, _body) = with_retry(&base, false, false, Endpoint::ListProjects, || {
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

    #[test]
    fn upload_parts_pin_the_canonical_repo_filenames() {
        // #208 repo-layout contract: every push lands the survey as `project.stalx`
        // and its render as `ariane.tml` REGARDLESS of the local source basenames.
        // The push uploads from scratch paths (`snapshot.stalx`) beside the live
        // cache file, so the multipart filename must be the CANONICAL server name,
        // never the source's basename -- else a second `.stalx` (or a `snapshot.stalx`)
        // would be committed and the next download_dump would be an ambiguous
        // multi-`.stalx` repo. Assert build_upload_parts decouples the two.
        let dir = tempfile::tempdir().expect("tempdir");
        let stalx_src = dir.path().join("snapshot.stalx");
        let tml_src = dir.path().join("render-42.tml");
        std::fs::write(&stalx_src, b"x").expect("write stalx");
        std::fs::write(&tml_src, b"y").expect("write tml");

        let parts = build_upload_parts(&stalx_src, &tml_src, "msg").expect("build parts");
        let names: Vec<&str> = parts.parts.iter().map(|p| p.file_name.as_str()).collect();
        assert_eq!(
            names,
            vec!["project.stalx", "ariane.tml"],
            "#208: canonical wire names, decoupled from the source basenames"
        );
        // Both parts are the repeated `artifact` field (never `artifact[]`).
        assert!(
            parts.parts.iter().all(|p| p.name == "artifact"),
            "each file is a repeated `artifact` part"
        );
        assert_eq!(parts.message, "msg");
    }

    // --- #215 collaborator/team permission + delete wire contract ---------------
    //
    // These pin the exact method + path + JSON body each new client fn puts on the
    // wire, against the same LoopbackStub the multipart test uses. The load-bearing
    // case is the DELETE-with-body: ureq's typestate `.delete()` builder cannot
    // carry a body, so the remove-* fns hand-build an `http::Request` and go through
    // `Agent::run`. If that body were ever dropped (a ureq bump, or a refactor back
    // to `.delete()`), the server would receive a target-less DELETE and 400 - so
    // asserting `{"user"}` / `{"team"}` actually reaches the socket is the point.
    // The stub replies `{}`; the fns that return `()` treat 200 as success, so we
    // assert the returned `Ok(())` too (the ones that parse a body are ignored - we
    // only care about the request bytes).
    const WIRE_PID: &str = "11111111-1111-1111-1111-111111111111";

    #[test]
    fn loopback_remove_user_permission_is_delete_with_user_body() {
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        remove_user_permission(&base, "tok", false, WIRE_PID, "bob@example.com")
            .expect("200 -> Ok(())");
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with(&format!(
                "DELETE /api/v2/projects/{WIRE_PID}/permission/user/detail/ "
            )),
            "singular `permission/user/detail/` DELETE, not the plural list path: {wire}"
        );
        assert!(
            wire.to_ascii_lowercase()
                .contains("content-type: application/json"),
            "carries a JSON content-type: {wire}"
        );
        assert!(
            wire.contains(r#""user":"bob@example.com""#),
            "the DELETE body identifies the target user on the wire: {wire}"
        );
    }

    #[test]
    fn loopback_remove_team_permission_is_delete_with_team_body() {
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        remove_team_permission(&base, "tok", false, WIRE_PID, "team-uuid-9")
            .expect("200 -> Ok(())");
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with(&format!(
                "DELETE /api/v2/projects/{WIRE_PID}/permission/team/detail/ "
            )),
            "singular `permission/team/detail/` DELETE: {wire}"
        );
        assert!(
            wire.contains(r#""team":"team-uuid-9""#),
            "the DELETE body identifies the target team on the wire: {wire}"
        );
    }

    #[test]
    fn loopback_add_user_permission_is_post_with_user_and_level() {
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        add_user_permission(
            &base,
            "tok",
            false,
            WIRE_PID,
            "bob@example.com",
            Permission::ReadOnly,
        )
        .expect("200 -> Ok(())");
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with(&format!(
                "POST /api/v2/projects/{WIRE_PID}/permission/user/detail/ "
            )),
            "POST to the singular detail path: {wire}"
        );
        assert!(
            wire.contains(r#""user":"bob@example.com""#),
            "user on wire: {wire}"
        );
        assert!(
            wire.contains(r#""level":"READ_ONLY""#),
            "the typed Permission serializes to its wire label: {wire}"
        );
    }

    #[test]
    fn loopback_set_user_permission_is_put() {
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        set_user_permission(
            &base,
            "tok",
            false,
            WIRE_PID,
            "bob@example.com",
            Permission::ReadAndWrite,
        )
        .expect("200 -> Ok(())");
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with(&format!(
                "PUT /api/v2/projects/{WIRE_PID}/permission/user/detail/ "
            )),
            "a level change is a PUT: {wire}"
        );
        assert!(
            wire.contains(r#""level":"READ_AND_WRITE""#),
            "new level on wire: {wire}"
        );
    }

    #[test]
    fn loopback_add_team_permission_is_post_with_team_and_level() {
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        add_team_permission(
            &base,
            "tok",
            false,
            WIRE_PID,
            "team-uuid-9",
            Permission::ReadOnly,
        )
        .expect("200 -> Ok(())");
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with(&format!(
                "POST /api/v2/projects/{WIRE_PID}/permission/team/detail/ "
            )),
            "team grant POST: {wire}"
        );
        assert!(
            wire.contains(r#""team":"team-uuid-9""#),
            "team on wire: {wire}"
        );
        assert!(
            wire.contains(r#""level":"READ_ONLY""#),
            "level on wire: {wire}"
        );
    }

    #[test]
    fn loopback_list_user_permissions_is_get_plural_path() {
        // The list path is PLURAL (`permissions/user/`), distinct from the singular
        // write path (`permission/user/detail/`) - a mismatch would 404 the roster.
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        // Stub replies `{}` -> `permissions` defaults to [] -> Ok(empty). We only
        // assert the request bytes.
        let _ = list_user_permissions(&base, "tok", false, WIRE_PID);
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with(&format!(
                "GET /api/v2/projects/{WIRE_PID}/permissions/user/ "
            )),
            "plural `permissions/user/` GET: {wire}"
        );
    }

    #[test]
    fn loopback_list_teams_is_get_teams() {
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        let _ = list_teams(&base, "tok", false);
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with("GET /api/v2/teams/ "),
            "the teams picker/name-map GET: {wire}"
        );
    }

    #[test]
    fn loopback_user_autocomplete_get_percent_encodes_query() {
        // A partial name with a space must be percent-encoded into the query string
        // (a raw space would produce an invalid request line / truncated query).
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        let _ = list_user_autocomplete(&base, "tok", false, "jo di");
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with("GET /api/v2/user/autocomplete/?query=jo%20di "),
            "GET the autocomplete endpoint with a percent-encoded query: {wire}"
        );
    }

    #[test]
    fn loopback_delete_project_is_bare_delete() {
        let mut stub = LoopbackStub::start(vec![200]);
        let base = stub.base.clone();
        delete_project(&base, "tok", false, WIRE_PID).expect("200 -> Ok(())");
        stub.join();
        let wire = String::from_utf8_lossy(&stub.captured()[0]).into_owned();
        assert!(
            wire.starts_with(&format!("DELETE /api/v2/projects/{WIRE_PID}/ ")),
            "project delete is a bare DELETE on the project, no detail suffix: {wire}"
        );
    }
}
