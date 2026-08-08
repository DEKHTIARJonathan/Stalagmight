//! The Tauri-backed [`EventSink`]: core's one route out to the running app.
//!
//! Core stores this type-erased (see `core::events`); this module is the only
//! place that turns the trait's calls back into real Tauri API calls - event
//! emission via [`Emitter`] and managed-state access via [`Manager`]. It also
//! hosts the setup-time glue that feeds Tauri-resolved platform directories to
//! the runtime-agnostic `app_dirs` registry ([`init_app_dirs`]).

use std::path::PathBuf;
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

/// Resolve the platform application directories via Tauri's path resolver and
/// hand them to [`crate::app_dirs::init_paths`].
///
/// Must be called once during `.setup()`, before `AppState::new()` or any
/// other code that reads paths.
pub fn init_app_dirs(handle: &AppHandle) {
    let resolver = handle.path();

    let data_local = resolver
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let config = resolver
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let cache = resolver
        .app_cache_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    // Unlike the dirs above, do NOT fall back to ".": a relative documents
    // path produces broken project save paths (e.g. "./stalagmight/foo.stalx").
    // Returning None lets callers fall through to their own resolution
    // (directories crate, $HOME/Documents).
    let document = resolver.document_dir().ok();

    tracing::debug!(
        ?data_local,
        ?config,
        ?cache,
        ?document,
        "Resolved application directories via Tauri path resolver"
    );

    crate::app_dirs::init_paths(data_local, config, cache, document);
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
