use anyhow::Result;
use std::collections::HashMap;

use super::AppState;

impl AppState {
    /// Load display settings from database or in-memory cache
    pub fn load_display_settings(&self) -> Result<HashMap<String, String>> {
        // Try database first
        let db_guard = self.database.lock();
        if let Some(db) = db_guard.as_ref() {
            return db.load_display_settings();
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let cache = self.display_settings_cache.lock();
        Ok(cache.clone())
    }

    /// Save a display setting to database or in-memory cache
    ///
    /// [#576 RV5-1] Between commands, under `command_lock`. A save snapshots the
    /// display settings from the open file (or this cache), writes a fresh temp
    /// file and renames it over the open one, all under `command_lock`; a setting
    /// written through the open handle in between went into the file the rename
    /// replaced (and one written to the cache was cleared by the save), lost with
    /// `Ok` returned. Holding the lock puts the write wholly before or after the
    /// save. Never call it while holding `command_lock`.
    pub fn save_display_setting(&self, key: &str, value: &str) -> Result<()> {
        let _between_commands = self.hold_commands();
        // Try database first
        let db_guard = self.database.lock();
        if let Some(db) = db_guard.as_ref() {
            return db.save_display_setting(key, value);
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let mut cache = self.display_settings_cache.lock();
        cache.insert(key.to_string(), value.to_string());
        Ok(())
    }

    /// Get a single display setting from database or in-memory cache
    pub fn get_display_setting(&self, key: &str) -> Result<Option<String>> {
        // Try database first
        let db_guard = self.database.lock();
        if let Some(db) = db_guard.as_ref() {
            return db.get_display_setting(key);
        }
        drop(db_guard);

        // Fall back to in-memory cache for new unsaved projects
        let cache = self.display_settings_cache.lock();
        Ok(cache.get(key).cloned())
    }

    /// Clear the in-memory display settings cache (called after save when settings are persisted to DB)
    pub(super) fn clear_display_settings_cache(&self) {
        self.display_settings_cache.lock().clear();
    }
}
