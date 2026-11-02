//! The event boundary between core and the host application.
//!
//! Core never talks to the UI layer directly: anything it wants delivered
//! (loading progress today) goes through the [`EventSink`] installed on
//! [`AppState`] during app setup. The host application provides the one real
//! implementation (a thin wrapper over the Tauri app handle); unit tests run
//! with no sink installed, which every consumer treats as "no one listening".

use super::loading::LoadingProgress;
use super::state::AppState;

/// [#576 C13] One backend -> webview event: its wire name and its payload type,
/// declared once. Emitters take both from here (core through [`payload`], the app
/// crate through its `emit_event` helper), so a misspelled name or a payload of
/// the wrong type does not compile; `pnpm gen:ipc-types` writes every event below
/// to `src/types/ipc/IpcEvents.ts`, which the frontend's listeners use.
pub trait IpcEvent {
    /// The name `listen()` takes.
    const NAME: &'static str;
    /// What the event carries; `()` for a bare signal, which arrives as `null`.
    type Payload: serde::Serialize + ts_rs::TS + Clone;
}

/// Load / create / import / export progress ([`crate::core::loading::ProgressEmitter`]).
pub struct LoadingProgressEvent;
impl IpcEvent for LoadingProgressEvent {
    const NAME: &'static str = "loading-progress";
    type Payload = LoadingProgress;
}

/// The tile protocol reached the network again after a transport failure.
pub struct TileTransportSuccess;
impl IpcEvent for TileTransportSuccess {
    const NAME: &'static str = "tile-transport-success";
    type Payload = ();
}

/// A tile fetch failed at the transport (offline) after a success.
pub struct TileTransportError;
impl IpcEvent for TileTransportError {
    const NAME: &'static str = "tile-transport-error";
    type Payload = ();
}

/// A path the OS handed the app was queued; drain it with `take_pending_launch_files`.
pub struct LaunchFileQueued;
impl IpcEvent for LaunchFileQueued {
    const NAME: &'static str = "launch-file-queued";
    type Payload = ();
}

/// The user asked to close the window; the backend prevented it so the frontend
/// can confirm (unsaved changes) and then close it itself.
pub struct CloseRequested;
impl IpcEvent for CloseRequested {
    const NAME: &'static str = "tauri://close-requested";
    type Payload = ();
}

/// `E`'s payload as the JSON value an [`EventSink`] takes, typed by `E`.
pub fn payload<E: IpcEvent>(payload: &E::Payload) -> serde_json::Result<serde_json::Value> {
    serde_json::to_value(payload)
}

/// A type-erased route from core out to the running application.
pub trait EventSink: Send + Sync + 'static {
    /// Fire-and-forget UI event. Implementations log their own delivery
    /// failures; core neither sees nor retries them.
    fn emit(&self, event: &str, payload: serde_json::Value);

    /// Run `f` against the process's managed [`AppState`], if any. Returns
    /// `false` when there is no managed state (tests, pre-setup) and `f` was
    /// NOT run - the caller keeps ownership of whatever it would have moved in
    /// only in the sense that the closure is dropped uncalled, so capture
    /// clones when a fallback path still needs the data.
    fn with_app_state(&self, f: Box<dyn FnOnce(&AppState) + Send>) -> bool;
}
