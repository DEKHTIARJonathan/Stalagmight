//! The Tauri-backed [`EventSink`]: core's one route out to the running app.
//!
//! Core stores this type-erased (see `core::events`); this module is the only
//! place that turns the trait's calls back into real Tauri API calls - event
//! emission via [`Emitter`] and managed-state access via [`Manager`].

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::core::events::EventSink;
use crate::core::state::AppState;

/// [`EventSink`] over the real Tauri app handle. Installed on [`AppState`]
/// during app setup; unit tests never construct one (they run with no sink).
pub struct TauriSink(pub AppHandle);

/// Wrap `handle` as the shared, type-erased [`EventSink`] every consumer takes.
pub fn tauri_sink(handle: AppHandle) -> Arc<dyn EventSink> {
    Arc::new(TauriSink(handle))
}

impl EventSink for TauriSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Err(e) = self.0.emit(event, payload) {
            tracing::warn!(
                error = %e,
                event,
                purpose = "report loading progress to UI",
                "Failed to emit event"
            );
        }
    }

    fn with_app_state(&self, f: Box<dyn FnOnce(&AppState) + Send>) -> bool {
        match self.0.try_state::<AppState>() {
            Some(state) => {
                f(&state);
                true
            }
            None => false,
        }
    }
}
