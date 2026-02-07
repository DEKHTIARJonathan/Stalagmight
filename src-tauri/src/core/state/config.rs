use anyhow::Result;

use crate::config::Config;

use super::AppState;

impl AppState {
    /// Get config
    pub fn get_config(&self) -> Config {
        self.config.lock().ok().map(|c| c.clone()).unwrap_or_default()
    }

    /// Update config
    pub fn update_config(&self, mut config: Config) -> Result<()> {
        tracing::info!(
            purpose = "apply user settings",
            "Updating configuration"
        );
        // Check if cache setting changed before saving
        let old_cache_enabled = self
            .config
            .lock()
            .ok()
            .is_none_or(|c| c.cache.tile_cache_enabled);
        let new_cache_enabled = config.cache.tile_cache_enabled;

        if let Err(e) = config.save() {
            tracing::error!(
                reason = %e,
                purpose = "persist user settings",
                "Failed to save configuration"
            );
            return Err(e);
        }

        // Sync tile cache if cache setting changed
        if old_cache_enabled != new_cache_enabled {
            if let Ok(mut cache_guard) = self.tile_cache.lock() {
                if new_cache_enabled {
                    // Enable cache - create new cache
                    match Self::init_tile_cache(&config) {
                        Ok(cache) => {
                            tracing::info!(
                                purpose = "enable offline tiles",
                                "Tile cache enabled"
                            );
                            *cache_guard = Some(cache);
                        }
                        Err(e) => {
                            tracing::warn!(
                                error = %e,
                                purpose = "enable offline tiles",
                                "Failed to initialize tile cache"
                            );
                        }
                    }
                } else {
                    // Disable cache - set to None (existing cache data remains on disk)
                    tracing::info!(
                        purpose = "disable offline tiles",
                        "Tile cache disabled"
                    );
                    *cache_guard = None;
                }
            }
        }

        if let Ok(mut cfg) = self.config.lock() {
            *cfg = config;
        }
        Ok(())
    }

    /// Reload config from disk without saving
    /// Returns the newly loaded config
    /// Also syncs config-derived state (recent_projects, undo_stack limit)
    pub fn reload_config(&self) -> Result<Config> {
        let new_config = Config::load()?;

        // Update the config
        if let Ok(mut cfg) = self.config.lock() {
            *cfg = new_config.clone();
        }

        // Sync recent_projects from config
        if let Ok(mut recent) = self.recent_projects.lock() {
            recent.clone_from(&new_config.general.recent_projects);
        }

        // Sync undo_stack history limit from config
        if let Ok(mut undo) = self.undo_stack.lock() {
            undo.set_history_limit(new_config.general.undo_history_limit);
        }

        Ok(new_config)
    }
}
