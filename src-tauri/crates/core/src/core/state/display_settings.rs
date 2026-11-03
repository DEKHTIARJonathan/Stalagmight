use anyhow::Result;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

use super::AppState;
use crate::core::{CommandError, CommandErrorCode};

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
        self.write_display_setting(key, value)
    }

    /// [#576 RV6b-2] [`Self::save_display_setting`] for the project the write was
    /// MADE for, named by its `created_at` (RFC 3339, the frontend's identity of the
    /// open project; `None` when it had none open).
    ///
    /// A display setting belongs to one project, and the IPC carries no other
    /// identity: a write queued or still in flight when the user opened another
    /// project used to land in whichever project was open by the time it ran -
    /// invisible this session (the new project's settings came with its load) and
    /// shown on its next open. Refused with `PROJECT_CHANGED` when the identity is
    /// not the open project's; nothing is written then. The check and the write
    /// share one `command_lock` span, and every project-slot commit takes that
    /// lock, so no open can land between them.
    pub fn save_display_setting_for(
        &self,
        project_created_at: Option<&str>,
        key: &str,
        value: &str,
    ) -> Result<(), CommandError> {
        let _between_commands = self.hold_commands();
        let open = self.project.lock().as_ref().map(|p| p.created_at);
        let made_for = project_created_at
            .map(|raw| DateTime::parse_from_rfc3339(raw).map(|at| at.with_timezone(&Utc)));
        let same_project = match (made_for, open) {
            (None, None) => true,
            (Some(Ok(made_for)), Some(open)) => made_for == open,
            _ => false,
        };
        if !same_project {
            return Err(CommandError::new(
                CommandErrorCode::ProjectChanged,
                "The display setting was not saved: another project is open now.",
            ));
        }
        self.write_display_setting(key, value)
            .map_err(|e| CommandError::failed(e.to_string()))
    }

    /// The write itself, for a caller already holding `command_lock`.
    fn write_display_setting(&self, key: &str, value: &str) -> Result<()> {
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
