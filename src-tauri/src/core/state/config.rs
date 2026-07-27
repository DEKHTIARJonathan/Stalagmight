use anyhow::Result;

use crate::config::Config;

use super::AppState;

impl AppState {
    /// Get config
    pub fn get_config(&self) -> Config {
        self.config
            .lock()
            .ok()
            .map(|c| c.clone())
            .unwrap_or_default()
    }

    /// Update config
    pub fn update_config(&self, mut config: Config) -> Result<()> {
        tracing::info!(purpose = "apply user settings", "Updating configuration");
        // Preserve backend-only fields the frontend never receives. `webkit_memory`
        // is `#[serde(skip_serializing)]` + `#[ts(skip)]`, so a settings-save payload
        // always carries the serde default. This restore is load-bearing: the save
        // below re-appends the in-memory `[webkit_memory]` table to `config.toml`
        // (see `Config::save_to_path`), so without putting the real value back here
        // first, saving any setting would persist defaults and silently reset a
        // user's hand-tuned knobs.
        //
        // The two credential-storage fields are preserved for a different reason:
        // they ARE serialized, but the Settings form does not own them. Where the
        // API key is kept is settled by the login-time storage prompt and the
        // "Try again" button, both of which write `config.toml` through the backend
        // while the Settings dialog stays mounted over its snapshot of the config
        // (`SpeleoStorageChoiceDialog` is a top-layer overlay precisely so Settings
        // is not unmounted). Saving any unrelated setting afterwards posted the
        // stale pair back and silently undid the answer - re-arming the launch-time
        // keyring nag, or worse: a successful "Try again" moves the key into the
        // keychain and deletes the plaintext copy, so restoring a stale
        // `keychain_declined = true` made the next launch skip the keychain read
        // and find nothing, signing the user out with no way to explain it.
        if let Ok(existing) = self.config.lock() {
            config.webkit_memory = existing.webkit_memory.clone();
            config.speleodb.token_fallback = existing.speleodb.token_fallback;
            config.speleodb.keychain_declined = existing.speleodb.keychain_declined;
            // Backend-owned for the same reason: it records what the keychain
            // actually holds, which only the credential paths know. `keychain_disabled`
            // is deliberately NOT in this list - that one IS a Settings toggle.
            config.speleodb.keychain_has_token = existing.speleodb.keychain_has_token;
        }
        // The keyring switch has to bite NOW, not at the next launch: a user turning
        // it on has just been asked one unlock prompt too many, and the live session
        // would otherwise keep reaching for the keychain until they restart.
        let keychain_disabled = config.speleodb.keychain_disabled;
        if let Ok(mut session) = self.speleodb.lock() {
            session.token_store.set_keychain_disabled(keychain_disabled);
        }
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
                            tracing::info!(purpose = "enable offline tiles", "Tile cache enabled");
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
                    tracing::info!(purpose = "disable offline tiles", "Tile cache disabled");
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
