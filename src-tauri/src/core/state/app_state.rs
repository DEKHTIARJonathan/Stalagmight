use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

use crate::cache::TileCache;
use crate::config::Config;
use crate::models::Project;
use crate::persistence::Database;
use crate::tilemap_cache::TilemapCache;
use crate::TileFetchStats;

use crate::core::{CommandResult, UndoStack};

/// Trait for types that can represent project lock errors.
/// Enables `with_project_mut` and `with_project` to work with different return types.
pub(super) trait FromProjectLockError {
    fn lock_failed() -> Self;
    fn no_project() -> Self;
}

impl FromProjectLockError for CommandResult {
    fn lock_failed() -> Self {
        CommandResult::failure("Failed to lock project".to_string())
    }
    fn no_project() -> Self {
        CommandResult::failure("No project open".to_string())
    }
}

impl<T> FromProjectLockError for Result<T, String> {
    fn lock_failed() -> Self {
        Err("Failed to lock project".to_string())
    }
    fn no_project() -> Self {
        Err("No project open".to_string())
    }
}

/// Application state managed by Tauri
pub struct AppState {
    /// Current project (if any)
    pub(super) project: Mutex<Option<Project>>,
    /// Database connection (if project is open)
    pub(super) database: Mutex<Option<Database>>,
    /// Undo/redo stack
    pub(super) undo_stack: Mutex<UndoStack>,
    /// Application configuration
    pub(super) config: Mutex<Config>,
    /// Recent projects list
    pub(super) recent_projects: Mutex<Vec<PathBuf>>,
    /// In-memory display settings cache (used when no DB is open, e.g., new unsaved project)
    pub(super) display_settings_cache: Mutex<HashMap<String, String>>,
    /// Serialization lock for command execution.
    /// Held for the entire duration of execute(), undo(), and redo() to prevent
    /// concurrent commands from interleaving (especially with batch sub-commands).
    pub(super) command_lock: Mutex<()>,
    /// Tile cache for offline satellite imagery.
    ///
    /// Note: Uses Arc<Mutex<...>> rather than plain Mutex<...> because the protocol handler
    /// runs in a separate async task/thread that outlives the closure scope, requiring
    /// owned/cloneable access to the cache. This is a deliberate deviation from the spec
    /// for thread-safety requirements.
    ///
    /// Note: Changes to CacheConfig at runtime (via update_config) do NOT re-initialize
    /// this cache. Users must restart the app for cache config changes to take effect.
    pub(super) tile_cache: Arc<Mutex<Option<TileCache>>>,
    /// In-memory cache for ArcGIS tilemap API responses.
    /// Used to efficiently check tile availability before fetching.
    pub(super) tilemap_cache: Arc<Mutex<TilemapCache>>,
    /// Lock-free tile fetch statistics (in-flight count, latency, errors).
    /// Uses Arc because the protocol handler needs a cloneable reference.
    pub(super) tile_fetch_stats: Arc<TileFetchStats>,
    /// Tauri app handle for emitting events (set during app setup)
    pub(super) app_handle: Mutex<Option<AppHandle>>,
    /// Active loading cancellation token (if any load operation is in progress)
    pub(super) active_loading: Mutex<Option<Arc<AtomicBool>>>,
}

impl AppState {
    /// Create a new application state
    pub fn new() -> Result<Self> {
        let config = Config::load().unwrap_or_default();
        // Load recent projects from config
        let recent = config.general.recent_projects.clone();
        let undo_limit = config.general.undo_history_limit;

        // Initialize tile cache if enabled
        let tile_cache = if config.cache.tile_cache_enabled {
            match Self::init_tile_cache(&config) {
                Ok(cache) => Some(cache),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        purpose = "enable offline tiles at startup",
                        "Failed to initialize tile cache; offline tile access will be unavailable"
                    );
                    None
                }
            }
        } else {
            tracing::info!(
                purpose = "respect user cache settings",
                "Tile cache disabled in configuration"
            );
            None
        };

        Ok(Self {
            project: Mutex::new(None),
            database: Mutex::new(None),
            undo_stack: Mutex::new(UndoStack::new_with_limit(undo_limit)),
            config: Mutex::new(config),
            recent_projects: Mutex::new(recent),
            display_settings_cache: Mutex::new(HashMap::new()),
            command_lock: Mutex::new(()),
            tile_cache: Arc::new(Mutex::new(tile_cache)),
            tilemap_cache: Arc::new(Mutex::new(TilemapCache::new())),
            tile_fetch_stats: Arc::new(TileFetchStats::new()),
            app_handle: Mutex::new(None),
            active_loading: Mutex::new(None),
        })
    }

    /// Initialize the tile cache based on config
    pub(super) fn init_tile_cache(config: &Config) -> Result<TileCache> {
        let cache_dir = crate::app_dirs::cache_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine app cache directory"))?;
        TileCache::open(cache_dir, config.cache.tile_cache_max_mb, config.cache.tile_ttl_days)
    }

    /// Get a clone of the tile cache Arc for sharing across threads
    pub fn tile_cache(&self) -> Arc<Mutex<Option<TileCache>>> {
        Arc::clone(&self.tile_cache)
    }

    /// Get a clone of the tilemap cache Arc for sharing across threads
    pub fn tilemap_cache(&self) -> Arc<Mutex<TilemapCache>> {
        Arc::clone(&self.tilemap_cache)
    }

    /// Get a clone of the tile fetch stats Arc for sharing across threads
    pub fn tile_fetch_stats(&self) -> Arc<TileFetchStats> {
        Arc::clone(&self.tile_fetch_stats)
    }

    /// Set the app handle (called during app setup)
    pub fn set_app_handle(&self, handle: AppHandle) {
        if let Ok(mut h) = self.app_handle.lock() {
            *h = Some(handle);
        }
    }

    /// Get the app handle
    pub fn get_app_handle(&self) -> Option<AppHandle> {
        self.app_handle.lock().ok().and_then(|h| h.clone())
    }

    /// Start a new loading operation, cancelling any existing one.
    /// Returns the cancellation token for the new operation.
    pub fn start_new_load(&self) -> Arc<AtomicBool> {
        let mut guard = self.active_loading.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

        // Cancel any existing load
        if let Some(old_token) = guard.take() {
            old_token.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        // Create new token
        let token = Arc::new(AtomicBool::new(false));
        *guard = Some(Arc::clone(&token));
        token
    }

    /// Clear the active loading token (called when load completes or fails).
    /// Identity-safe: only clears if the provided token matches the current active token.
    /// This prevents a stale load from clearing a newer load's token.
    pub fn clear_active_load(&self, expected_token: &Arc<AtomicBool>) {
        if let Ok(mut guard) = self.active_loading.lock() {
            if let Some(ref current) = *guard {
                if Arc::ptr_eq(current, expected_token) {
                    *guard = None;
                }
            }
        }
    }

    /// Cancel any active loading operation (idempotent - safe to call anytime)
    pub fn cancel_loading(&self) {
        if let Ok(guard) = self.active_loading.lock() {
            if let Some(token) = guard.as_ref() {
                token.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        // No error if no active load - cancel_loading is idempotent
    }

    /// Lock the project mutex and pass a mutable reference to the callback.
    /// Returns the callback's result, or an error if the lock fails or no project is open.
    pub(super) fn with_project_mut<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut Project) -> R,
        R: FromProjectLockError,
    {
        let Ok(mut guard) = self.project.lock() else {
            return R::lock_failed();
        };
        let Some(project) = guard.as_mut() else {
            return R::no_project();
        };
        f(project)
    }

    /// Lock the project mutex and pass an immutable reference to the callback.
    /// Returns the callback's result, or an error if the lock fails or no project is open.
    pub(super) fn with_project<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Project) -> R,
        R: FromProjectLockError,
    {
        let Ok(guard) = self.project.lock() else {
            return R::lock_failed();
        };
        let Some(project) = guard.as_ref() else {
            return R::no_project();
        };
        f(project)
    }

    // === Snapshot helpers for snapshot-based undo ===

    /// Capture a JSON snapshot of the current project for undo.
    /// Returns the serialized JSON, or a `CommandResult` failure if unavailable.
    pub(super) fn capture_project_snapshot(&self) -> Result<String, CommandResult> {
        let Ok(guard) = self.project.lock() else {
            return Err(CommandResult::failure("Failed to lock project".to_string()));
        };
        let Some(p) = guard.as_ref() else {
            return Err(CommandResult::failure("No project open".to_string()));
        };
        serde_json::to_string(p)
            .map_err(|e| CommandResult::failure(format!("Failed to serialize project: {e}")))
    }

    /// Deserialize a project snapshot and install it into `slot`, rebuilding the
    /// transient lookup caches (`section_index_cache`, `merge_adjacency_cache`)
    /// that serde skips. THE single place a restored project enters the live slot:
    /// every rollback/undo/redo path routes through here so none can forget to
    /// rebuild a cache and leave a half-populated / stale map behind (which would
    /// silently mis-resolve sections or merge groups) — see catalog #14/#39.
    /// Returns false and leaves `slot` untouched if the snapshot can't be parsed.
    #[must_use]
    pub(super) fn restore_snapshot_into(slot: &mut Option<Project>, snapshot: &str) -> bool {
        match serde_json::from_str::<Project>(snapshot) {
            Ok(mut restored) => {
                restored.rebuild_section_index();
                restored.rebuild_merge_adjacency();
                *slot = Some(restored);
                true
            }
            Err(e) => {
                tracing::error!(
                    purpose = "restore project snapshot",
                    reason = %e,
                    "Failed to deserialize project snapshot; slot left unchanged"
                );
                false
            }
        }
    }

    /// Rollback the project to a previously captured snapshot.
    /// Handles poisoned mutex gracefully (recovery is more important than panic).
    pub(super) fn rollback_project(&self, snapshot: &str) {
        let mut proj = match self.project.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if Self::restore_snapshot_into(&mut proj, snapshot) {
            tracing::info!(
                purpose = "restore project after failed command",
                "Successfully rolled back to pre-mutation snapshot"
            );
        }
    }

    /// Capture an "after" snapshot of the project, rolling back on failure.
    /// Returns the serialized JSON, or rolls back and returns a `CommandResult` failure.
    pub(super) fn capture_after_snapshot_or_rollback(
        &self,
        before_snapshot: &str,
    ) -> Result<String, CommandResult> {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                tracing::warn!(
                    purpose = "finalize undo snapshot",
                    "Project mutex poisoned during after-snapshot; recovering"
                );
                poisoned.into_inner()
            }
        };
        let Some(p) = proj_guard.as_ref() else {
            tracing::error!(
                purpose = "restore project after mutation error",
                "Project became None after mutation; rolling back"
            );
            let _ = Self::restore_snapshot_into(&mut proj_guard, before_snapshot);
            return Err(CommandResult::failure(
                "No project for after snapshot".to_string(),
            ));
        };
        match serde_json::to_string(p) {
            Ok(json) => Ok(json),
            Err(e) => {
                tracing::error!(
                    purpose = "finalize undo snapshot",
                    reason = %e,
                    "Failed to serialize after snapshot; rolling back"
                );
                if Self::restore_snapshot_into(&mut proj_guard, before_snapshot) {
                    tracing::info!(
                        purpose = "restore project after snapshot failure",
                        "Successfully rolled back after serialization failure"
                    );
                }
                Err(CommandResult::failure(format!(
                    "Failed to serialize after snapshot: {e}"
                )))
            }
        }
    }

    /// Push a snapshot-pair undo entry onto the undo stack.
    pub(super) fn push_snapshot_undo(
        &self,
        cmd: crate::core::Command,
        before: String,
        after: String,
    ) {
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.push_with_data(
                cmd,
                crate::core::UndoData::ProjectSnapshotPair { before, after },
            );
        }
    }
}
