use std::path::PathBuf;

use crate::core::CommandResult;
use crate::models::{Project, ProjectMetadata};
use crate::persistence::Database;

use super::AppState;

impl AppState {
    /// Get the current project state for the frontend
    pub fn get_project_state(&self) -> Option<Project> {
        self.project.lock().ok().and_then(|p| p.clone())
    }

    /// Get recent projects list.
    ///
    /// Hot path on every navigation to the global view. Uses SQL aggregates
    /// to compute metadata without deserializing the full project — the
    /// previous implementation called `db.load_project()` for every entry,
    /// which on a 75k-shot project parsed every shot row only to throw it
    /// all away. That caused a multi-second freeze every time the user hit
    /// "back" with a large project in the recent list.
    pub fn get_recent_projects(&self) -> Vec<ProjectMetadata> {
        let recent = match self.recent_projects.lock() {
            Ok(r) => r.clone(),
            Err(_) => return Vec::new(),
        };

        recent
            .iter()
            .filter_map(|path| {
                // open_for_metadata skips PRAGMA quick_check and migrations —
                // both are unnecessary when we're only reading aggregate
                // columns and the user hasn't asked to open the project.
                let db = Database::open_for_metadata(path).ok()?;
                match db.load_metadata(path.clone()) {
                    Ok(m) => Some(m),
                    Err(e) => {
                        tracing::debug!(
                            path = ?path,
                            error = %e,
                            "Failed to read recent project metadata; skipping"
                        );
                        None
                    }
                }
            })
            .collect()
    }

    /// Remove a project from the recent projects list
    pub fn remove_from_recent_projects(&self, path: PathBuf) -> CommandResult {
        let Ok(mut recent) = self.recent_projects.lock() else {
            return CommandResult::failure("Failed to lock recent projects".to_string());
        };

        // Remove the path from the list
        let initial_len = recent.len();
        recent.retain(|p| p != &path);

        if recent.len() == initial_len {
            return CommandResult::failure("Project not found in recent list".to_string());
        }

        // Update config and save
        if let Ok(mut config) = self.config.lock() {
            config.general.recent_projects.clone_from(&recent);
            if let Err(e) = config.save() {
                tracing::warn!("Failed to save config after removing from recent: {}", e);
                return CommandResult::failure(format!("Failed to save config: {e}"));
            }
        }

        tracing::info!(path = ?path, "Removed project from recent list");
        CommandResult::success()
    }
}
