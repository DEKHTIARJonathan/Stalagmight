//! The event boundary between core and the host application.
//!
//! Core never talks to the UI layer directly: anything it wants delivered
//! (loading progress today) goes through the [`EventSink`] installed on
//! [`AppState`] during app setup. The host application provides the one real
//! implementation (a thin wrapper over the Tauri app handle); unit tests run
//! with no sink installed, which every consumer treats as "no one listening".

use super::state::AppState;

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
