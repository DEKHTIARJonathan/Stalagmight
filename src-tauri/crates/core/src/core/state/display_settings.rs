use anyhow::Result;
use std::collections::HashMap;

use super::AppState;

impl AppState {
    /// Load display settings from database or in-memory cache
    pub fn load_display_settings(&self) -> Result<HashMap<String, String>> {
        // Try database first
        let db_guard = self
            .database
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        if let Some(db) = db_guard.as_ref() {
            return db.load_display_settings();
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let cache = self
            .display_settings_cache
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock display settings cache"))?;
        Ok(cache.clone())
    }

    /// Save a display setting to database or in-memory cache
    pub fn save_display_setting(&self, key: &str, value: &str) -> Result<()> {
        // Try database first
        let db_guard = self
            .database
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        if let Some(db) = db_guard.as_ref() {
            return db.save_display_setting(key, value);
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let mut cache = self
            .display_settings_cache
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock display settings cache"))?;
        cache.insert(key.to_string(), value.to_string());
        Ok(())
    }

    /// Get a single display setting from database or in-memory cache
    pub fn get_display_setting(&self, key: &str) -> Result<Option<String>> {
        // Try database first
        let db_guard = self
            .database
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock database"))?;
        if let Some(db) = db_guard.as_ref() {
            return db.get_display_setting(key);
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let cache = self
            .display_settings_cache
            .lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock display settings cache"))?;
        Ok(cache.get(key).cloned())
    }

    /// Clear the in-memory display settings cache (called after save when settings are persisted to DB)
    pub(super) fn clear_display_settings_cache(&self) {
        if let Ok(mut cache) = self.display_settings_cache.lock() {
            cache.clear();
        }
    }
}
