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

use crate::core::UndoStack;

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
                        "Failed to initialize tile cache - offline tile access will be unavailable"
                    );
                    None
                }
            }
        } else {
            tracing::info!("Tile cache disabled in configuration");
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
            app_handle: Mutex::new(None),
            active_loading: Mutex::new(None),
        })
    }

    /// Initialize the tile cache based on config
    pub(super) fn init_tile_cache(config: &Config) -> Result<TileCache> {
        let dirs = directories::ProjectDirs::from("com", "cavechef", "CaveChef")
            .ok_or_else(|| anyhow::anyhow!("Could not determine app data directory"))?;
        let cache_dir = dirs.cache_dir();
        TileCache::open(cache_dir, config.cache.tile_cache_max_mb, config.cache.tile_ttl_days)
    }

    /// Get a clone of the tile cache Arc for sharing across threads
    pub fn tile_cache(&self) -> Arc<Mutex<Option<TileCache>>> {
        Arc::clone(&self.tile_cache)
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
        let mut guard = self.active_loading.lock().unwrap();

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
}
