//! Serde DTOs for the SpeleoDB v2 JSON API (read-only spike, #183), plus the
//! IPC-facing summary types returned to the webview.
//!
//! Wire format: the `/api/v2/` endpoints return **bare** JSON (the serializer
//! output directly). Only the deprecated `/api/v1/` alias is wrapped in a
//! `{data, success, …}` envelope by `DRFWrapResponseMiddleware`, which
//! early-returns unless `/api/v1/` is in the path. So a project list is a bare
//! JSON array and a project detail is a bare JSON object — no envelope to peel.
//!
//! Only the fields the spike needs are modelled; serde ignores the rest. Fields
//! the server *omits* when empty (notably `permission` when the user has no
//! access) are `Option<_>` with `#[serde(default)]`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// [Track A] #186/D-B2: the typed action carried on the IPC error DTO.
use super::contract::SpeleoDbAction;

/// Project permission level.
///
/// The server serializes the **label string** (e.g. `"READ_AND_WRITE"`), not the
/// numeric `PermissionLevel` enum — verified in `serializers/project.py`
/// (`get_permission` → `str(...level_label)`). Issues #188/#203 describe this as
/// an integer; that is incorrect for the wire format.
///
/// Variants are ordered ascending so `>=` expresses capability thresholds
/// (download ≥ `ReadOnly`, upload/lock ≥ `ReadAndWrite`, delete/collab = `Admin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum Permission {
    #[serde(rename = "WEB_VIEWER")]
    WebViewer,
    #[serde(rename = "READ_ONLY")]
    ReadOnly,
    #[serde(rename = "READ_AND_WRITE")]
    ReadAndWrite,
    #[serde(rename = "ADMIN")]
    Admin,
}

/// A git commit as carried in `latest_commit`. Only the SHA is needed here.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Commit {
    /// 40-hex git commit SHA.
    pub(crate) id: String,
}

/// One commit in a project's **linear** revision history
/// (`GET /api/v2/projects/{id}/revisions/`). Only the fields the ancestry
/// classifier (#193) needs are modelled — the server also sends `author_name`,
/// `authored_date`, and `message`, which serde ignores.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct RevisionCommit {
    /// 40-hex git commit SHA.
    pub(crate) id: String,
    /// Parent SHAs. Empty for the root commit; exactly one for a linear commit;
    /// more than one only for a merge (which the classifier treats as
    /// non-linear → fail closed).
    #[serde(default)]
    pub(crate) parent_ids: Vec<String>,
    /// Commit author's email — compared against our own to tell "my push
    /// landed" from "someone else pushed".
    #[serde(default)]
    pub(crate) author_email: String,
}

/// Response of `GET /api/v2/projects/{id}/revisions/` — the project's linear
/// commit list. The sibling `project` object the server also returns is ignored.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct RevisionHistory {
    #[serde(default)]
    pub(crate) commits: Vec<RevisionCommit>,
}

/// The active lock ("mutex") on a project, when one is held.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ActiveMutex {
    /// Email of the user currently holding the lock.
    pub(crate) user: String,
}

/// A SpeleoDB project as returned by `GET /api/v2/projects/` (and `/{id}/`),
/// parsed down to the fields the spike consumes.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) name: String,
    /// Absent (not null) when the requesting user has no permission.
    #[serde(default)]
    pub(crate) permission: Option<Permission>,
    /// Present only while the project is locked.
    #[serde(default)]
    pub(crate) active_mutex: Option<ActiveMutex>,
    /// Null on an empty (never-committed) repo.
    #[serde(default)]
    pub(crate) latest_commit: Option<Commit>,
    /// Raw project-type label (`ariane`/`compass`/…/`other`). Kept as the wire
    /// string: it is only a display heuristic, and staying a string is robust to
    /// new server types. The dump classifier is the authoritative openability check.
    #[serde(default, rename = "type")]
    pub(crate) kind: String,
    // [Track A] #185/D-A-methods: the server's GeoJSON-export toggle. Parsed (not
    // ignored) so the full v2 payload round-trips; defaults false when omitted.
    // Read by the tests; no production reader yet (the freshness fold that would
    // consume it is #202), so it is dead in the non-test lib build for now.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "exclude_geojson consumer is #202")
    )]
    #[serde(default)]
    pub(crate) exclude_geojson: bool,
}

/// IPC-facing summary of a project for the spike dialog's list. Derived from
/// [`Project`]; carries only display fields — never a token or raw API detail.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SpeleoProjectSummary {
    pub id: String,
    pub name: String,
    pub permission: Option<Permission>,
    /// Email of the lock holder, if the project is currently locked.
    pub lock_holder: Option<String>,
    /// Raw project-type label (display heuristic only).
    pub type_tag: String,
    /// SHA of the latest commit, if the project has any commits.
    pub latest_commit_sha: Option<String>,
}

impl SpeleoProjectSummary {
    pub(crate) fn from_project(p: Project) -> Self {
        Self {
            id: p.id,
            name: p.name,
            permission: p.permission,
            lock_holder: p.active_mutex.map(|m| m.user),
            type_tag: p.kind,
            latest_commit_sha: p.latest_commit.map(|c| c.id),
        }
    }
}

/// Result of a successful login, returned to the webview. Deliberately does NOT
/// include the token — the token is stored backend-side only (see [`super::auth`]).
#[derive(Debug, Clone, Serialize, TS)]
pub struct SpeleoLoginResult {
    pub user_email: String,
    /// True when the token was stored in the OS keychain; false means a
    /// session-only in-memory fallback (e.g. headless CI with no secret service).
    pub keychain_backed: bool,
}

/// Result of pulling + extracting a project, returned to the webview. The
/// frontend then opens `local_path` through the normal `open_project` flow.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SpeleoOpenResult {
    pub local_path: String,
    /// #193 b8: the server reports a write lock held by THIS account at open time,
    /// i.e. a second same-account session is editing the project. The frontend
    /// surfaces a notice (the ancestry self-heal assumes a single same-account
    /// session — a concurrent one would misattribute its commits as ours).
    pub concurrent_session: bool,
}

/// Outcome of `speleodb_start_editing` (#194): the result of acquiring the write
/// lock and reconciling the open project against the server. A discriminated
/// union (`kind`) the webview branches on. Errors (no permission, anomalies,
/// network) surface through the `Err(SpeleoErrorDto)` channel instead.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartEditingResult {
    /// Lock acquired; the local copy already matched the server tip. Editing is
    /// now enabled.
    Editing,
    /// Lock acquired; the server had advanced with no local edits, so we
    /// fast-forwarded (re-pulled + reloaded the project) and enabled editing. The
    /// webview should refresh its view from the reloaded `local_path`.
    FastForwarded { local_path: String },
    /// The server diverged from our base AND we hold un-pushed local edits:
    /// editing is NOT enabled and the freshly-acquired lock was released. The
    /// user must reconcile (the divergence prompt is #198, next batch).
    DivergenceNeeded,
    /// Someone else holds the write lock; `email` is the holder when known.
    LockedBy { email: Option<String> },
}

/// Outcome of `speleodb_done` (#197): push the open project's edits, then release
/// the lock and return to read-only.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DoneResult {
    /// Edits pushed (or there was nothing to push); the lock was released and the
    /// project is read-only again.
    Released,
    /// The server diverged (a stranger commit between our base and the tip):
    /// nothing was pushed, the lock + dirty bit are retained for the user to
    /// reconcile (#198).
    DivergenceNeeded,
    /// The push outcome was ambiguous (no confirmed server commit): the dirty bit
    /// AND the lock are retained so a later retry recovers via ancestry (#193) —
    /// no edits are lost.
    PushUnconfirmed,
}

/// Outcome of `speleodb_update` (#197): a read-only refresh of the open project
/// against the server (no lock taken).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateResult {
    /// Already at the server tip — nothing to do.
    UpToDate,
    /// Fast-forwarded to the server tip (re-pulled + reloaded the project).
    FastForwarded { local_path: String },
    /// The server diverged from our base AND we hold un-pushed local edits — the
    /// refresh cannot proceed without reconciliation (#198/#199, next batch).
    DivergenceNeeded,
}

/// Current backend session status, so the dialog can restore its view when
/// reopened instead of forcing a re-login: the in-memory/keychain token lives in
/// `AppState` for the whole app run, but the dialog's React state resets on each
/// remount. Carries no token — only whether one is held and for whom.
#[derive(Debug, Clone, Serialize, TS)]
pub struct SpeleoSessionStatus {
    pub logged_in: bool,
    /// Email of the logged-in user, when `logged_in`.
    pub user_email: Option<String>,
    /// False when the token is held in memory only (no OS keychain) — surfaced so
    /// the UI keeps showing the "won't survive a restart" note after a reopen.
    pub keychain_backed: bool,
}

/// IPC-facing status of the currently open project's SpeleoDB link, so the
/// frontend action shell (#204) can render the read-only/editing indicator and
/// gate its controls on ANY load — including a reopen from Recent Projects,
/// where the open flow's [`SpeleoProjectSummary`] isn't in hand.
///
/// The cheap local fields (`is_remote`, `edit_enabled`, `has_unpushed_edits`)
/// come from the persisted `speleo_link` row + the transient edit gate. The
/// network fields (`permission`, `lock_holder`) are best-effort from a single
/// `get_project`; they degrade to `None` when logged out / offline so the local
/// truth (which the read-only gate hangs on) always returns. Carries no token.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SpeleoLinkStatus {
    /// True when the open project is linked to a SpeleoDB project (a `speleo_link`
    /// row exists). False for a local project or when no project is open.
    pub is_remote: bool,
    /// The backend edit gate: true when mutations are allowed (a local project,
    /// or a remote one with the write lock held). False for a remote project
    /// opened read-only.
    pub edit_enabled: bool,
    /// The command-driven dirty bit: un-pushed remote edits are pending.
    pub has_unpushed_edits: bool,
    /// This user's permission tier on the project. Best-effort — `None` when
    /// logged out / offline / the lookup failed.
    pub permission: Option<Permission>,
    /// Email of the current lock holder, if any. Best-effort — `None` when
    /// unlocked / logged out / the lookup failed.
    pub lock_holder: Option<String>,
    /// How the local copy relates to the server tip — drives the action button's
    /// "remote has an update" / "conflict" states (T2c). Best-effort over the
    /// revision topology; `Unknown` when logged out / offline / the lookup failed.
    pub remote_state: RemoteState,
    /// The project is linked but the server definitively refused this user access
    /// to it (a 403 on `get_project`) — e.g. a managed `.stalx` shared as a bare
    /// file to someone who is not a collaborator. Distinct from a transient
    /// offline miss (which leaves `permission: None` but this `false`), so the UI
    /// can offer converting it to an unmanaged local file rather than nagging to
    /// retry. Never set on a plain 401 (that is a dead token → re-login).
    pub access_denied: bool,
}

/// The local copy's relationship to the server tip (the reconcile verdict,
/// projected for the UI). Drives the action button (T2c): `RemoteAhead` → pull,
/// `Conflict` → resolve. Derived from [`super::sync::reconcile_verdict`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum RemoteState {
    /// Local BASE == server tip (nothing to pull).
    UpToDate,
    /// The server advanced and we can fast-forward cleanly (no local edits block it).
    RemoteAhead,
    /// The server diverged from BASE and we hold un-pushed edits — needs reconcile.
    Conflict,
    /// Not determined (logged out / offline / lookup failed).
    Unknown,
}

/// Outcome of `speleodb_push` (T2d): push the open project's edits **without**
/// releasing the lock (unlike [`DoneResult`], which releases). The lock is
/// retained in every arm so editing continues.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PushResult {
    /// Edits pushed (or nothing to push); the lock is retained.
    Pushed,
    /// The server diverged: nothing pushed, lock + dirty bit retained to reconcile.
    DivergenceNeeded,
    /// Ambiguous push (no confirmed server commit): dirty bit + lock retained so a
    /// retry recovers via ancestry (#193).
    PushUnconfirmed,
}

/// [Track A] #186/D-B2: the structured error the SpeleoDB IPC commands return.
///
/// Replaces the spike's `String`-flattened error at the IPC boundary so the
/// frontend branches on the typed [`SpeleoDbAction`] (`action`) instead of
/// scraping message text. `message` is DISPLAY-only (from
/// `client::parse_error_message` / the error's `Display`); `status` is the HTTP
/// code for a `Status` error and `None` for transport / local errors. Carries no
/// token (the no-token-leak guard pins this).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SpeleoErrorDto {
    pub message: String,
    pub action: SpeleoDbAction,
    pub status: Option<u16>,
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use super::{
        DoneResult, Permission, Project, PushResult, RemoteState, SpeleoDbAction, SpeleoErrorDto,
        SpeleoLinkStatus, SpeleoLoginResult, SpeleoOpenResult, SpeleoProjectSummary,
        SpeleoSessionStatus, StartEditingResult, UpdateResult,
    };

    #[test]
    fn ipc_dtos_never_serialize_a_token() {
        // Load-bearing invariant: no IPC-facing DTO carries the auth token (it
        // lives only in the backend TokenStore). Pin it so a future field that
        // names or holds a token can't silently break "token never in IPC".
        let login = serde_json::to_string(&SpeleoLoginResult {
            user_email: "u@x".to_owned(),
            keychain_backed: true,
        })
        .expect("serialize login result");
        let status = serde_json::to_string(&SpeleoSessionStatus {
            logged_in: true,
            user_email: Some("u@x".to_owned()),
            keychain_backed: true,
        })
        .expect("serialize session status");
        let summary = serde_json::to_string(&SpeleoProjectSummary {
            id: "11111111-1111-1111-1111-111111111111".to_owned(),
            name: "Cave".to_owned(),
            permission: Some(Permission::ReadOnly),
            lock_holder: None,
            type_tag: "ariane".to_owned(),
            latest_commit_sha: None,
        })
        .expect("serialize project summary");
        let open = serde_json::to_string(&SpeleoOpenResult {
            local_path: "/cache/project.stalx".to_owned(),
            concurrent_session: false,
        })
        .expect("serialize open result");
        // [Track A] #186/D-B2: the structured error DTO must also never carry a
        // token. (The message deliberately avoids the substring "token" so the
        // guard checks the field SHAPE, not an incidental word in the display
        // text — the real invariant is that no field name/value is the token.)
        let error = serde_json::to_string(&SpeleoErrorDto {
            message: "SpeleoDB returned HTTP 401: not authenticated".to_owned(),
            action: SpeleoDbAction::ReLogin,
            status: Some(401),
        })
        .expect("serialize error dto");
        // The single-writer hand-off DTOs (#194/#197) must also never carry a token
        // — serialize the field-bearing variants so a future field is caught.
        let start = serde_json::to_string(&StartEditingResult::FastForwarded {
            local_path: "/cache/project.stalx".to_owned(),
        })
        .expect("serialize start-editing result");
        let locked = serde_json::to_string(&StartEditingResult::LockedBy {
            email: Some("holder@example.com".to_owned()),
        })
        .expect("serialize locked-by result");
        let done = serde_json::to_string(&DoneResult::Released).expect("serialize done result");
        let update = serde_json::to_string(&UpdateResult::FastForwarded {
            local_path: "/cache/project.stalx".to_owned(),
        })
        .expect("serialize update result");
        // #204: the link-status DTO is authed-derived (permission + lock holder)
        // but must likewise never carry the token.
        let link_status = serde_json::to_string(&SpeleoLinkStatus {
            is_remote: true,
            edit_enabled: false,
            has_unpushed_edits: false,
            permission: Some(Permission::ReadAndWrite),
            lock_holder: Some("holder@example.com".to_owned()),
            remote_state: RemoteState::RemoteAhead,
            access_denied: false,
        })
        .expect("serialize link status");
        let push = serde_json::to_string(&PushResult::PushUnconfirmed).expect("serialize push");

        for json in [
            &login,
            &status,
            &summary,
            &open,
            &error,
            &start,
            &locked,
            &done,
            &update,
            &link_status,
            &push,
        ] {
            assert!(
                !json.to_ascii_lowercase().contains("token"),
                "IPC DTO must not expose a token field: {json}"
            );
        }
    }

    #[test]
    fn project_parses_full_v2_payload() {
        // Extra server fields (creation_date, message) are ignored; the modelled
        // fields — including exclude_geojson (#185/D-A-methods) — parse.
        let json = r#"{
            "id": "11111111-1111-1111-1111-111111111111",
            "name": "Test Cave",
            "permission": "READ_AND_WRITE",
            "active_mutex": {"user": "holder@example.com", "creation_date": "2026-01-01T00:00:00Z"},
            "latest_commit": {"id": "0123456789abcdef0123456789abcdef01234567", "message": "init"},
            "type": "ariane",
            "exclude_geojson": true
        }"#;
        let p: Project = serde_json::from_str(json).expect("valid project JSON");
        assert_eq!(p.id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(p.name, "Test Cave");
        assert_eq!(p.permission, Some(Permission::ReadAndWrite));
        // [Track A] #185: exclude_geojson is now PARSED (not ignored).
        assert!(p.exclude_geojson);
        assert_eq!(
            p.active_mutex.as_ref().map(|m| m.user.as_str()),
            Some("holder@example.com")
        );
        assert_eq!(
            p.latest_commit.as_ref().map(|c| c.id.as_str()),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(p.kind, "ariane"); // #[serde(rename = "type")]

        // The display projection carries the lock holder + commit SHA across.
        let summary = SpeleoProjectSummary::from_project(p);
        assert_eq!(summary.lock_holder.as_deref(), Some("holder@example.com"));
        assert_eq!(
            summary.latest_commit_sha.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(summary.type_tag, "ariane");
    }

    #[test]
    fn project_tolerates_omitted_and_null_optionals() {
        // No permission (the server omits it when the user has none), no
        // active_mutex, no latest_commit, no type.
        let omitted: Project =
            serde_json::from_str(r#"{"id": "a", "name": "Bare"}"#).expect("minimal project JSON");
        assert_eq!(omitted.permission, None);
        assert!(omitted.active_mutex.is_none());
        assert!(omitted.latest_commit.is_none());
        assert_eq!(omitted.kind, "");
        // [Track A] #185: exclude_geojson defaults to false when the server omits it.
        assert!(!omitted.exclude_geojson);

        // Explicit nulls deserialize to None just like absence.
        let nulled: Project = serde_json::from_str(
            r#"{"id": "b", "name": "N", "permission": null, "latest_commit": null, "type": "other"}"#,
        )
        .expect("nulled project JSON");
        assert_eq!(nulled.permission, None);
        assert!(nulled.latest_commit.is_none());
        assert_eq!(nulled.kind, "other");
    }

    #[test]
    fn permission_labels_round_trip() {
        // The wire format is the uppercase label string (not the integer the
        // issues describe); pin every variant both directions.
        for (variant, label) in [
            (Permission::WebViewer, "\"WEB_VIEWER\""),
            (Permission::ReadOnly, "\"READ_ONLY\""),
            (Permission::ReadAndWrite, "\"READ_AND_WRITE\""),
            (Permission::Admin, "\"ADMIN\""),
        ] {
            assert_eq!(serde_json::to_string(&variant).expect("serialize"), label);
            assert_eq!(
                serde_json::from_str::<Permission>(label).expect("deserialize"),
                variant
            );
        }
    }

    #[test]
    fn permission_orders_by_capability() {
        // `>=` is used as a capability threshold (download ≥ ReadOnly, upload/lock
        // ≥ ReadAndWrite, …), so the ascending ordering must hold.
        assert!(Permission::WebViewer < Permission::ReadOnly);
        assert!(Permission::ReadOnly < Permission::ReadAndWrite);
        assert!(Permission::ReadAndWrite < Permission::Admin);
    }
}
