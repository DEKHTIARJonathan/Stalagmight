//! Status → action decision contract for the SpeleoDB client (#186).
//!
//! One pure function, [`map_status`], turns an `(endpoint, http_status)` pair
//! into a typed [`SpeleoDbAction`] the rest of the app (and the frontend, over
//! IPC) branches on — instead of re-parsing human-facing error strings. The
//! function **fails closed**: any status we do not explicitly model maps to
//! [`SpeleoDbAction::Fatal`] (surface it, keep the project dirty, never auto-drop
//! the token).
//!
//! INVARIANT (D-186): the action is a pure function of `(endpoint, status)`.
//! `client::parse_error_message` stays DISPLAY-only — **no** branch in
//! `map_status` reads the parsed message string. The `SpeleoDbError::Status`
//! variant stays `{status, message}` with no action field; the action is derived
//! here, at the IPC boundary, where the endpoint context is known, so the error
//! enum is not coupled to call-site context.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::models::SpeleoErrorDto;
use super::SpeleoDbError;

/// The decision the caller should take after a SpeleoDB call, derived from the
/// HTTP status + the endpoint it came from. Crosses IPC as a ts-rs enum so the
/// frontend branches on `err.action` rather than on message text (D-B2). Order
/// is non-load-bearing (no `>=` comparisons — unlike [`super::Permission`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum SpeleoDbAction {
    /// The token is dead (revoked / invalid): a 401 on any authed endpoint, or a
    /// 403 on the `/user/` whoami chokepoint (the box's DRF 401→403 downgrade,
    /// verified live). Drives Track C's auto-drop (D-B4).
    ReLogin,
    /// 403 on a read-capable endpoint (list/get/download = read-only access).
    ReadOnly,
    /// 403 on upload/acquire/release — no write permission / lock fence.
    Fence,
    /// A write surfaced without a confirmed server commit — keep dirty (g7).
    StayDirty,
    /// Upload-304 — the remote tree is already at this state (benign; the dirty
    /// bit is left unchanged, this is NOT an error).
    UpToDate,
    /// An idempotent 5xx that the transport already retried + exhausted; the FE
    /// may offer a manual retry.
    Retry,
    /// Unmapped / 422 / 4xx we do not model — surface, fail closed.
    Fatal,
}

/// The SpeleoDB endpoint a status came from, so [`map_status`] can apply the
/// per-endpoint 403 semantics (D-B4): a 403 on a read endpoint means read-only
/// access, a 403 on a write endpoint means a write fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Endpoint {
    Login,
    User,
    ListProjects,
    // GetProject/Acquire/Release/UploadAuto/CreateProject are constructed by the
    // not-yet-wired orchestration callers (#202/#194/#207) and by the unit tests;
    // they are dead in the non-test lib build until those callers land.
    // [P1] #197 maps get_project / get_revisions errors via GetProject.
    GetProject,
    DownloadDump,
    // [P1] #194 start_editing constructs Acquire (auth handler + dto_for_error).
    Acquire,
    // [P1] #197 done maps release errors via Release.
    Release,
    // [P1] #197 done maps upload errors via UploadAuto.
    UploadAuto,
    // [P1] #207 speleodb_publish constructs CreateProject (auth handler + dto_for_error).
    CreateProject,
    // [#215] Collaborator/team permission writes + project delete. A write (not
    // read, not idempotent): a 403 is a Fence (no admin/write grant, not read-only
    // access), a 5xx is StayDirty (never auto-retried - these are non-idempotent
    // POST/PUT/DELETE). Falls through the `403 => Fence` / `500..=599 => StayDirty`
    // arms of `map_status` by being absent from both `is_read` and `is_idempotent`.
    ManageProject,
}

impl Endpoint {
    /// Idempotent (read-like) endpoints retry a transient 5xx (D-B3); the write
    /// endpoints never auto-retry (double-submit hazard) and surface for g7.
    fn is_idempotent(self) -> bool {
        matches!(
            self,
            Endpoint::Login
                | Endpoint::User
                | Endpoint::ListProjects
                | Endpoint::GetProject
                | Endpoint::DownloadDump
        )
    }

    /// `true` for the read-capable endpoints whose 403 means "read-only access"
    /// rather than a write fence.
    fn is_read(self) -> bool {
        matches!(
            self,
            Endpoint::ListProjects | Endpoint::GetProject | Endpoint::DownloadDump
        )
    }
}

/// Map an `(endpoint, status)` pair to the action the caller should take.
///
/// Pure + fail-closed: an unmodelled status yields [`SpeleoDbAction::Fatal`].
/// Per the ledger (D-186): no first-class 423/409/412/429 rows (the server does
/// not use them — lock contention is acquire-**400**, handled by #194), so they
/// fall through to the Fatal default; 429/Retry-After is intentionally NOT a
/// `Wait` action (there is no `Wait` in this issue).
pub(crate) fn map_status(endpoint: Endpoint, status: u16) -> SpeleoDbAction {
    match status {
        // 401 = real token revocation on every authenticated endpoint. Login is
        // the exception: bad creds come back as 400 (verified), so a 401 cannot
        // arise from Login and the catch-all below would treat it as Fatal — but
        // we still special-case Login here so it is explicit and 401 never maps
        // to ReLogin for the unauthenticated login call.
        401 if !matches!(endpoint, Endpoint::Login) => SpeleoDbAction::ReLogin,
        // 403 on the whoami (User) chokepoint = the unambiguous dead-token signal:
        // the box returns 200 for any valid token and 403 for a dead one (the DRF
        // 401→403 downgrade, verified live), and `/user/` carries no per-resource
        // permission, so a 403 there can ONLY mean the token is bad → ReLogin.
        403 if matches!(endpoint, Endpoint::User) => SpeleoDbAction::ReLogin,
        // 403 on a resource endpoint is ambiguous (a real read-only/fence grant vs
        // a dead token) and NEVER drops the token here (D-B4); the orchestration
        // disambiguates it with a whoami probe (`speleodb_token_is_dead`).
        403 if endpoint.is_read() => SpeleoDbAction::ReadOnly,
        403 => SpeleoDbAction::Fence, // UploadAuto / Acquire / Release / CreateProject / Login
        // Upload-304: the remote tree already matches — benign, dirty bit
        // unchanged. Without this row 304 would fall to the Fatal default.
        304 if matches!(endpoint, Endpoint::UploadAuto) => SpeleoDbAction::UpToDate,
        // 422: defensive unprocessable fatal row. NOTE (verified live): the box
        // answers a malformed/missing-artifact upload with 400, NOT 422 — that 400
        // has no first-class row and correctly falls to the fail-closed default
        // below. 422 is kept as a defensive mapping in case the server ever uses it.
        422 => SpeleoDbAction::Fatal,
        // 5xx: idempotent reads were already retried → surface the exhausted
        // Retry state; writes never auto-retried → StayDirty (keep dirty, g7).
        500..=599 if endpoint.is_idempotent() => SpeleoDbAction::Retry,
        500..=599 => SpeleoDbAction::StayDirty,
        // Everything else (incl. acquire-400 lock-held, 409/412/423/429, unknown
        // 4xx, and any 2xx that wrongly reaches here) fails closed.
        _ => SpeleoDbAction::Fatal,
    }
}

/// Convert a [`SpeleoDbError`] into the IPC [`SpeleoErrorDto`], deriving the
/// typed action from the endpoint the call came from (D-B2). This is the single
/// conversion the IPC boundary uses; it needs the `endpoint` context, so it is a
/// named fn called at the call site (not a blanket `From`).
///
/// - `Status { status, message }` → `map_status(endpoint, status)`, `status: Some`.
/// - `Transport` (network/timeout, post-retry) → `Retry`, `status: None`.
/// - `NotAuthenticated` → `ReLogin` (no usable token).
/// - `InsecureEndpoint` and every other local error → `Fatal`, `status: None`.
pub(crate) fn dto_for_error(endpoint: Endpoint, err: &SpeleoDbError) -> SpeleoErrorDto {
    let (action, status, message) = match err {
        // Status: carry the parsed human detail WITHOUT the "SpeleoDB returned HTTP
        // N:" wrapper - the frontend frames it per operation ("Login to SpeleoDB
        // failed: …", "Unable to open the project: …"). See utils/speleoError.ts.
        SpeleoDbError::Status { status, message } => (
            map_status(endpoint, *status),
            Some(*status),
            message.clone(),
        ),
        // Transport is already fully framed ("Network error talking to SpeleoDB: …").
        SpeleoDbError::Transport(_) => (SpeleoDbAction::Retry, None, err.to_string()),
        SpeleoDbError::NotAuthenticated => (SpeleoDbAction::ReLogin, None, err.to_string()),
        // InsecureEndpoint / NoEndpoint / MissingCredentials / Parse / EmptyDump /
        // AdoptAriane / AmbiguousDump / Io / InvalidProjectId - all fail closed;
        // their Display is already user-facing.
        _ => (SpeleoDbAction::Fatal, None, err.to_string()),
    };
    SpeleoErrorDto {
        message,
        action,
        status,
    }
}

#[cfg(test)]
mod tests {
    use super::{dto_for_error, map_status, Endpoint, SpeleoDbAction};
    use crate::speleodb::SpeleoDbError;

    #[test]
    fn map_status_per_row() {
        // The load-bearing rows from the ledger's #186 table.
        assert_eq!(map_status(Endpoint::Login, 400), SpeleoDbAction::Fatal);
        assert_eq!(map_status(Endpoint::User, 401), SpeleoDbAction::ReLogin);
        // whoami 403 = dead-token signal (the live box's DRF 401→403 downgrade).
        assert_eq!(map_status(Endpoint::User, 403), SpeleoDbAction::ReLogin);
        assert_eq!(
            map_status(Endpoint::ListProjects, 403),
            SpeleoDbAction::ReadOnly
        );
        assert_eq!(
            map_status(Endpoint::GetProject, 403),
            SpeleoDbAction::ReadOnly
        );
        assert_eq!(
            map_status(Endpoint::DownloadDump, 403),
            SpeleoDbAction::ReadOnly
        );
        // acquire-400 (lock held) is NOT a first-class row → Fatal (deferred to #194).
        assert_eq!(map_status(Endpoint::Acquire, 400), SpeleoDbAction::Fatal);
        assert_eq!(map_status(Endpoint::Acquire, 403), SpeleoDbAction::Fence);
        assert_eq!(map_status(Endpoint::UploadAuto, 403), SpeleoDbAction::Fence);
        // [#215] The admin writes (collaborator/team perms + delete) are write-shaped:
        // 403 = Fence (no write/admin grant), 5xx = StayDirty (non-idempotent, never
        // auto-retried) - NOT ReadOnly/Retry (which GetProject, a read, would give).
        assert_eq!(
            map_status(Endpoint::ManageProject, 403),
            SpeleoDbAction::Fence
        );
        assert_eq!(
            map_status(Endpoint::ManageProject, 503),
            SpeleoDbAction::StayDirty
        );
        assert_eq!(
            map_status(Endpoint::UploadAuto, 304),
            SpeleoDbAction::UpToDate
        );
        assert_eq!(map_status(Endpoint::UploadAuto, 422), SpeleoDbAction::Fatal);
        // Verified live: a malformed / missing-artifact upload is 400, which has
        // no first-class row and must fail closed to Fatal.
        assert_eq!(map_status(Endpoint::UploadAuto, 400), SpeleoDbAction::Fatal);
        assert_eq!(
            map_status(Endpoint::UploadAuto, 503),
            SpeleoDbAction::StayDirty
        );
    }

    #[test]
    fn map_status_unmapped_fails_closed() {
        // Any status we don't model maps to Fatal, on any endpoint.
        for status in [418, 451, 409, 423, 412, 429] {
            assert_eq!(
                map_status(Endpoint::ListProjects, status),
                SpeleoDbAction::Fatal,
                "status {status} on a read endpoint should fail closed"
            );
        }
        // 304 is only meaningful on UploadAuto; on a read endpoint it is Fatal.
        assert_eq!(
            map_status(Endpoint::ListProjects, 304),
            SpeleoDbAction::Fatal
        );
    }

    #[test]
    fn map_status_422_is_distinct_fatal() {
        // 422 is Fatal on every endpoint (no retry, no dirty change).
        for ep in [
            Endpoint::UploadAuto,
            Endpoint::Acquire,
            Endpoint::ListProjects,
            Endpoint::CreateProject,
        ] {
            assert_eq!(map_status(ep, 422), SpeleoDbAction::Fatal);
        }
    }

    #[test]
    fn map_status_upload_304_is_uptodate() {
        assert_eq!(
            map_status(Endpoint::UploadAuto, 304),
            SpeleoDbAction::UpToDate
        );
        // 304 elsewhere is NOT UpToDate.
        assert_ne!(
            map_status(Endpoint::DownloadDump, 304),
            SpeleoDbAction::UpToDate
        );
    }

    #[test]
    fn map_status_idempotent_5xx_retry() {
        for ep in [
            Endpoint::Login,
            Endpoint::User,
            Endpoint::ListProjects,
            Endpoint::GetProject,
            Endpoint::DownloadDump,
        ] {
            for status in [500, 502, 503, 599] {
                assert_eq!(
                    map_status(ep, status),
                    SpeleoDbAction::Retry,
                    "{ep:?} {status} should be Retry"
                );
            }
        }
    }

    #[test]
    fn map_status_write_5xx_stay_dirty() {
        for ep in [
            Endpoint::UploadAuto,
            Endpoint::Acquire,
            Endpoint::Release,
            Endpoint::CreateProject,
            Endpoint::ManageProject,
        ] {
            for status in [500, 502, 503] {
                assert_eq!(
                    map_status(ep, status),
                    SpeleoDbAction::StayDirty,
                    "{ep:?} {status} should be StayDirty"
                );
            }
        }
    }

    #[test]
    fn map_status_whoami_403_is_relogin_but_resource_403_is_not() {
        // Verified live: `/user/` returns 403 for a dead token, so a whoami 403 is
        // the unambiguous dead-token signal → ReLogin. The SAME 403 on a resource
        // endpoint stays ReadOnly (read) / Fence (write) — it must NOT map to
        // ReLogin, or a read-only user would be logged out (D-B4); the
        // orchestration disambiguates a resource 403 with a whoami probe.
        assert_eq!(map_status(Endpoint::User, 403), SpeleoDbAction::ReLogin);
        assert_eq!(
            map_status(Endpoint::ListProjects, 403),
            SpeleoDbAction::ReadOnly
        );
        assert_eq!(
            map_status(Endpoint::DownloadDump, 403),
            SpeleoDbAction::ReadOnly
        );
        assert_eq!(map_status(Endpoint::UploadAuto, 403), SpeleoDbAction::Fence);
        assert_eq!(map_status(Endpoint::Acquire, 403), SpeleoDbAction::Fence);
    }

    #[test]
    fn map_status_login_401_is_not_relogin() {
        // Login is unauthenticated — a 401 there (which the live box never sends,
        // it 400s on bad creds) must not be ReLogin.
        assert_ne!(map_status(Endpoint::Login, 401), SpeleoDbAction::ReLogin);
        assert_eq!(map_status(Endpoint::Login, 401), SpeleoDbAction::Fatal);
    }

    #[test]
    fn speleo_error_dto_maps_status_to_action() {
        // A 401 Status on an authed endpoint → ReLogin, status carried through.
        let dto = dto_for_error(
            Endpoint::User,
            &SpeleoDbError::Status {
                status: 401,
                message: "invalid".to_owned(),
            },
        );
        assert_eq!(dto.action, SpeleoDbAction::ReLogin);
        assert_eq!(dto.status, Some(401));

        // A 403 on a read endpoint → ReadOnly.
        let dto = dto_for_error(
            Endpoint::ListProjects,
            &SpeleoDbError::Status {
                status: 403,
                message: "forbidden".to_owned(),
            },
        );
        assert_eq!(dto.action, SpeleoDbAction::ReadOnly);
        assert_eq!(dto.status, Some(403));

        // Transport → Retry, no status.
        let dto = dto_for_error(
            Endpoint::DownloadDump,
            &SpeleoDbError::Transport("timeout".to_owned()),
        );
        assert_eq!(dto.action, SpeleoDbAction::Retry);
        assert_eq!(dto.status, None);

        // NotAuthenticated → ReLogin; InsecureEndpoint / local → Fatal.
        assert_eq!(
            dto_for_error(Endpoint::User, &SpeleoDbError::NotAuthenticated).action,
            SpeleoDbAction::ReLogin
        );
        assert_eq!(
            dto_for_error(
                Endpoint::Login,
                &SpeleoDbError::InsecureEndpoint {
                    endpoint: "http://x".to_owned()
                }
            )
            .action,
            SpeleoDbAction::Fatal
        );
        assert_eq!(
            dto_for_error(Endpoint::User, &SpeleoDbError::InvalidProjectId).action,
            SpeleoDbAction::Fatal
        );
    }

    #[test]
    fn speleo_action_ts_export() {
        // ts-rs export must not panic and must name the enum the FE imports.
        use ts_rs::TS;
        let decl = SpeleoDbAction::decl();
        assert!(
            decl.contains("SpeleoDbAction"),
            "ts-rs decl should name the enum: {decl}"
        );
    }
}
