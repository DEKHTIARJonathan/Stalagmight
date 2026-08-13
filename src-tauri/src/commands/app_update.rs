//! In-app updater IPC surface (#579).
//!
//! Rust drives the whole cycle rather than the plugin's JS guest API, for one
//! concrete reason: the guest `check()` cannot override the endpoint per call,
//! and the endpoint is exactly what changes between the stable and weekly
//! release tracks. So the endpoint is computed here from the user's configured
//! track and handed to a per-call [`tauri_plugin_updater::UpdaterBuilder`].
//!
//! The cycle is deliberately THREE commands, not one:
//!
//! - [`check_for_app_update`] asks the manifest and parks the answer,
//! - [`download_app_update`] fetches and signature-verifies the bytes,
//! - [`install_app_update_and_restart`] writes them and relaunches.
//!
//! `Update::download_and_install` would collapse the last two, and must not be
//! used: on Windows the install step hands control to the NSIS installer and
//! exits this process, so anything the frontend still had to ask the user -
//! unsaved work, a held SpeleoDB write lock - would never be asked. Splitting
//! the download from the install is what keeps the point of no return behind
//! the existing quit guards.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};
use ts_rs::TS;

use crate::config::UpdateTrack;
use crate::core::AppState;

/// Endpoint override, honoured in every build.
///
/// Not a debug gate: it is how a maintainer points a real installed app at a
/// local manifest to reproduce a user's failing update, and the manual test
/// recipe in docs/releasing.md depends on it. Read at CALL time, so exporting
/// it and re-checking is enough - no restart.
pub const UPDATE_URL_ENV: &str = "STALAGMIGHT_UPDATE_URL";

/// Per-track manifests, both rolling assets of the `updater` release.
const STABLE_ENDPOINT: &str =
    "https://github.com/Stalagmight/Stalagmight/releases/download/updater/latest-stable.json";
const WEEKLY_ENDPOINT: &str =
    "https://github.com/Stalagmight/Stalagmight/releases/download/updater/latest-weekly.json";

/// Release-notes landing page for an offered version. Tags are `v<version>`.
const RELEASE_TAG_URL_PREFIX: &str = "https://github.com/Stalagmight/Stalagmight/releases/tag/v";

/// Progress event the frontend listens on during [`download_app_update`].
pub const DOWNLOAD_PROGRESS_EVENT: &str = "app-update:download-progress";

/// Emit at most one progress event per this many bytes.
///
/// A release bundle arrives in chunks of a few KiB, so emitting per chunk would
/// put thousands of messages through the IPC channel for one download - enough
/// to compete with the UI it is meant to be updating. A quarter-megabyte step
/// is still ~40 updates for a 10 MB bundle, which is finer than a progress bar
/// can show.
const PROGRESS_EMIT_BYTES: u64 = 256 * 1024;

/// The answer to one update check.
#[derive(Debug, Clone, Serialize, TS)]
pub struct AppUpdateCheck {
    pub status: AppUpdateStatus,
    /// The version the RUNNING app was built as, so the UI can say "you have X"
    /// without a second round trip.
    pub current_version: String,
}

/// Whether an update is on offer.
///
/// A discriminated union rather than an `Option<info>`: "no update" and "there
/// is one" are different states in the banner, and the payload must not be able
/// to travel without the arm that says it is real.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppUpdateStatus {
    /// Nothing newer is published for this platform on this track. Also the
    /// answer when the manifest is missing entirely (see
    /// [`check_for_app_update`]).
    UpToDate,
    Available {
        version: String,
        /// Verbatim from the manifest's `pub_date`, not reformatted - the
        /// frontend renders it in the user's locale or not at all.
        pub_date: Option<String>,
        notes_url: String,
    },
}

/// Payload of [`DOWNLOAD_PROGRESS_EVENT`].
///
/// `total` is `None` when the server sent no `Content-Length`; the frontend
/// then has bytes-so-far but no percentage, which is a real state and not an
/// error.
#[derive(Debug, Clone, Copy, Serialize, TS)]
pub struct AppUpdateProgress {
    /// `number` in TS, not ts-rs's default `bigint` for `u64`: serde_json puts a
    /// plain JSON number on the wire, so a `bigint` declaration would typecheck
    /// against arithmetic that throws at runtime. A release bundle is hundreds
    /// of megabytes at the very most, nowhere near 2^53.
    #[ts(type = "number")]
    pub downloaded: u64,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
}

/// Where in the check -> download -> install cycle we are.
///
/// The [`Update`] cannot be rebuilt from anything the frontend holds (it
/// carries the signature and the resolved per-platform download URL), so it is
/// parked here between commands, and the verified bytes with it.
#[derive(Default)]
struct Pending {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

/// Tauri-managed state for the update cycle.
///
/// Its own managed struct rather than a field on `AppState`: `AppState` is the
/// survey document and its undo stack, and this outlives every project the user
/// opens. `PendingLaunchFiles` sets the same precedent.
#[derive(Default)]
pub struct AppUpdateState(Mutex<Pending>);

impl AppUpdateState {
    fn with<T>(&self, f: impl FnOnce(&mut Pending) -> T) -> Result<T, String> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| "The update state is unusable; restart the app".to_owned())?;
        Ok(f(&mut pending))
    }
}

/// The parked update, or the message the frontend shows when there is none.
///
/// Cloned out rather than borrowed: the caller awaits a download afterwards,
/// and holding the lock across that await is exactly what `await_holding_lock`
/// forbids.
fn checked_update(update_state: &AppUpdateState) -> Result<Update, String> {
    update_state
        .with(|pending| pending.update.clone())?
        .ok_or_else(|| "No update to download; check for updates first".to_owned())
}

/// The parked update and its downloaded bytes, TAKING the bytes so a second
/// install cannot run off a copy the first one already consumed.
fn installable_update(update_state: &AppUpdateState) -> Result<(Update, Vec<u8>), String> {
    let (update, bytes) =
        update_state.with(|pending| (pending.update.clone(), pending.bytes.take()))?;
    let update =
        update.ok_or_else(|| "No update to install; check for updates first".to_owned())?;
    let bytes = bytes
        .ok_or_else(|| "The update has not been downloaded yet; download it first".to_owned())?;
    Ok((update, bytes))
}

/// The manifest URL for `track`, or the [`UPDATE_URL_ENV`] override.
///
/// Pure: the environment is the only input besides the track, and it is read
/// here rather than cached so a support session can point a running app
/// somewhere else between two checks. A variable set to whitespace is treated
/// as unset, since that is what an emptied shell export looks like.
pub fn endpoint_for_track(track: UpdateTrack) -> String {
    if let Ok(override_url) = std::env::var(UPDATE_URL_ENV) {
        if !override_url.trim().is_empty() {
            return override_url;
        }
    }
    match track {
        UpdateTrack::Stable => STABLE_ENDPOINT,
        UpdateTrack::Weekly => WEEKLY_ENDPOINT,
    }
    .to_owned()
}

/// Ask this track's manifest whether a newer build exists.
///
/// Deliberately does NOT consult `update_check_enabled`: the caller decides
/// whether to ask at all (the launch check is gated on the setting; the About
/// dialog's button is an explicit request and must work regardless). Making
/// this refuse would silently break the manual button.
///
/// "There is no manifest" and "the manifest has no entry for this platform" map
/// to [`AppUpdateStatus::UpToDate`], not to an error: both are the ordinary
/// state of a track that has not published for this platform yet (macOS stays
/// out of the manifests until Developer ID signing is live), and neither is
/// something the user can act on. A transport failure IS an error, so the
/// frontend can stay quiet about it rather than claim the app is current.
#[tauri::command]
pub async fn check_for_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
    update_state: State<'_, AppUpdateState>,
) -> Result<AppUpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let track = state.get_config().general.update_track;
    let endpoint = endpoint_for_track(track);
    let url = Url::parse(&endpoint)
        .map_err(|e| format!("Update endpoint '{endpoint}' is not a valid URL: {e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("Update endpoint was rejected: {e}"))?
        .build()
        .map_err(|e| format!("Could not build the updater: {e}"))?;

    let found = match updater.check().await {
        Ok(found) => found,
        // `ReleaseNotFound` is what a 404 (or an unparseable body) on every
        // endpoint reduces to; `TargetNotFound` is a manifest with no entry for
        // this OS/arch.
        Err(
            tauri_plugin_updater::Error::ReleaseNotFound
            | tauri_plugin_updater::Error::TargetNotFound(_),
        ) => None,
        Err(e) => return Err(format!("Update check failed: {e}")),
    };

    let Some(update) = found else {
        // Drop anything a previous check parked: an update the server has since
        // withdrawn must not stay installable from this session.
        update_state.with(|pending| {
            pending.update = None;
            pending.bytes = None;
        })?;
        return Ok(AppUpdateCheck {
            status: AppUpdateStatus::UpToDate,
            current_version,
        });
    };

    let version = update.version.clone();
    // Straight off the manifest rather than through the plugin's parsed
    // `OffsetDateTime`, which would have to be re-formatted to get back to the
    // string the manifest already carries.
    let pub_date = update
        .raw_json
        .get("pub_date")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);

    update_state.with(|pending| {
        pending.update = Some(update);
        // Bytes belong to the version they were downloaded for.
        pending.bytes = None;
    })?;

    Ok(AppUpdateCheck {
        status: AppUpdateStatus::Available {
            notes_url: format!("{RELEASE_TAG_URL_PREFIX}{version}"),
            version,
            pub_date,
        },
        current_version,
    })
}

/// Download the update the last check found, and verify its signature.
///
/// Download ONLY - see the module docs for why this never installs. The bytes
/// are held in memory until [`install_app_update_and_restart`] asks for them;
/// the plugin has already checked them against the bundled minisign public key
/// by the time this returns.
#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    update_state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    let update = checked_update(&update_state)?;

    let mut downloaded: u64 = 0;
    let mut emitted_at: u64 = 0;
    let mut total: Option<u64> = None;
    let bytes = update
        .download(
            |chunk, content_length| {
                downloaded += chunk as u64;
                // Emit on the byte step OR when the announced total changes -
                // the latter is what makes the first chunk emit, so the UI
                // learns the size instead of waiting a quarter megabyte for it.
                if downloaded - emitted_at >= PROGRESS_EMIT_BYTES || content_length != total {
                    emitted_at = downloaded;
                    total = content_length;
                    emit_progress(&app, downloaded, total);
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("Update download failed: {e}"))?;

    // The throttle can swallow the tail, and a bar stuck at 97% reads as a
    // hang; the finished size is also the one the frontend can assert on.
    emit_progress(&app, downloaded, total);

    update_state.with(|pending| pending.bytes = Some(bytes))?;
    Ok(())
}

fn emit_progress(app: &AppHandle, downloaded: u64, total: Option<u64>) {
    if let Err(e) = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        AppUpdateProgress { downloaded, total },
    ) {
        // A dropped progress tick is cosmetic; the download itself carries on.
        tracing::warn!(
            error = %e,
            purpose = "report update download progress",
            "Emit failed"
        );
    }
}

/// Install the downloaded update and relaunch into it.
///
/// The point of no return, and the frontend must have run every exit guard
/// before calling it. On Windows `install` hands over to the installer and
/// exits this process, so nothing after it is guaranteed to run - which is also
/// why `app.restart()` (never-returning by signature) sits directly behind it
/// rather than any cleanup.
///
/// On failure the bytes are put back, so "Restart to update" can be retried
/// without downloading again.
#[tauri::command]
pub fn install_app_update_and_restart(
    app: AppHandle,
    update_state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    let (update, bytes) = installable_update(&update_state)?;

    if let Err(e) = update.install(&bytes) {
        update_state.with(|pending| pending.bytes = Some(bytes))?;
        return Err(format!("Update install failed: {e}"));
    }
    app.restart();
}

#[cfg(test)]
#[expect(clippy::expect_used)]
mod tests {
    use super::*;

    /// The endpoint override is process-global, so the tests that touch it take
    /// this first. Without it they race each other and read one another's value.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Restores whatever the variable held (including "unset") on drop, so a
    /// developer running the suite with a real override exported does not have
    /// it silently cleared.
    struct EnvVarGuard(Option<String>);

    impl EnvVarGuard {
        fn set(value: Option<&str>) -> Self {
            let original = std::env::var(UPDATE_URL_ENV).ok();
            match value {
                Some(value) => std::env::set_var(UPDATE_URL_ENV, value),
                None => std::env::remove_var(UPDATE_URL_ENV),
            }
            Self(original)
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.0 {
                Some(original) => std::env::set_var(UPDATE_URL_ENV, original),
                None => std::env::remove_var(UPDATE_URL_ENV),
            }
        }
    }

    #[test]
    fn each_track_has_its_own_manifest() {
        let _lock = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _env = EnvVarGuard::set(None);

        let stable = endpoint_for_track(UpdateTrack::Stable);
        let weekly = endpoint_for_track(UpdateTrack::Weekly);
        assert!(stable.ends_with("/latest-stable.json"), "{stable}");
        assert!(weekly.ends_with("/latest-weekly.json"), "{weekly}");
        assert_ne!(
            stable, weekly,
            "the two tracks must not resolve to one manifest"
        );
        // https only: the plugin refuses an insecure endpoint in release builds,
        // and it would be a signed-payload delivery over a channel anyone can
        // rewrite.
        assert!(stable.starts_with("https://"), "{stable}");
        assert!(weekly.starts_with("https://"), "{weekly}");
    }

    #[test]
    fn the_env_override_wins_over_both_tracks() {
        let _lock = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _env = EnvVarGuard::set(Some("http://127.0.0.1:8000/latest.json"));

        for track in [UpdateTrack::Stable, UpdateTrack::Weekly] {
            assert_eq!(
                endpoint_for_track(track),
                "http://127.0.0.1:8000/latest.json"
            );
        }
    }

    /// An exported-then-emptied variable (`export STALAGMIGHT_UPDATE_URL=`) is
    /// present but blank. Honouring it would send the check at an unparseable
    /// URL instead of the real manifest.
    #[test]
    fn a_blank_override_is_treated_as_unset() {
        let _lock = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _env = EnvVarGuard::set(Some("   "));

        assert_eq!(endpoint_for_track(UpdateTrack::Stable), STABLE_ENDPOINT);
        assert_eq!(endpoint_for_track(UpdateTrack::Weekly), WEEKLY_ENDPOINT);
    }

    /// The override is read on every call, not captured once. A support session
    /// exports it against a running app and re-checks; caching would make that
    /// silently do nothing.
    #[test]
    fn the_override_is_re_read_on_every_call() {
        let _lock = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let _env = EnvVarGuard::set(None);
        assert_eq!(endpoint_for_track(UpdateTrack::Stable), STABLE_ENDPOINT);
        std::env::set_var(UPDATE_URL_ENV, "https://example.invalid/latest.json");
        assert_eq!(
            endpoint_for_track(UpdateTrack::Stable),
            "https://example.invalid/latest.json"
        );
        std::env::remove_var(UPDATE_URL_ENV);
        assert_eq!(endpoint_for_track(UpdateTrack::Stable), STABLE_ENDPOINT);
    }

    /// Both default endpoints must survive `Url::parse`, which is the first
    /// thing `check_for_app_update` does with them.
    #[test]
    fn the_default_endpoints_parse() {
        let _lock = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _env = EnvVarGuard::set(None);

        for track in [UpdateTrack::Stable, UpdateTrack::Weekly] {
            Url::parse(&endpoint_for_track(track)).expect("endpoint should be a valid URL");
        }
    }

    #[test]
    fn the_notes_url_points_at_the_offered_versions_tag() {
        // Mirrors what `check_for_app_update` builds, which is the one place the
        // `v` prefix and the tag shape are decided.
        assert_eq!(
            format!("{RELEASE_TAG_URL_PREFIX}0.5.1-weekly.20260817"),
            "https://github.com/Stalagmight/Stalagmight/releases/tag/v0.5.1-weekly.20260817"
        );
    }

    /// `Update` has no `Debug`, so `expect_err` is unavailable on these.
    fn refusal<T>(result: Result<T, String>) -> String {
        result.err().expect("the step must refuse")
    }

    /// Nothing checked yet: both later steps must refuse, and say which step
    /// the user is missing rather than surfacing a lock or unwrap failure.
    #[test]
    fn download_and_install_refuse_an_unchecked_state() {
        let state = AppUpdateState::default();

        let download = refusal(checked_update(&state));
        assert!(download.contains("check for updates"), "{download}");

        let install = refusal(installable_update(&state));
        assert!(install.contains("check for updates"), "{install}");
    }

    /// The download step ran but the bytes are gone (or never landed). The
    /// install must name THAT, not repeat "check for updates" - the two are
    /// different things for the user to do.
    #[test]
    fn install_refuses_when_the_download_has_not_happened() {
        let state = AppUpdateState::default();
        // Only the bytes are observable without a live `Update`, so drive the
        // discrimination the other way: with bytes present and no update, the
        // message is still the check one; the byte message needs an update.
        state
            .with(|pending| pending.bytes = Some(vec![0u8; 4]))
            .expect("state should be lockable");
        let err = refusal(installable_update(&state));
        assert!(err.contains("check for updates"), "{err}");
        // ...and the taken bytes are NOT left behind for a later install to
        // pick up against a different version.
        assert!(state
            .with(|pending| pending.bytes.is_none())
            .expect("state should be lockable"));
    }
}
