use anyhow::Result;

use crate::core::CommandResult;

use super::AppState;

impl AppState {
    /// Check if a file hash has already been imported to the project
    pub fn check_duplicate_import(&self, hash: &str) -> Result<bool> {
        let proj_guard = self.project.lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock project"))?;

        if let Some(project) = proj_guard.as_ref() {
            Ok(project.imported_file_hashes.contains(&hash.to_string()))
        } else {
            Ok(false)
        }
    }

    /// Track an imported file hash in the project
    pub fn track_imported_file(&self, hash: String) -> CommandResult {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(_) => return CommandResult::failure("Failed to lock project".to_string()),
        };

        if let Some(project) = proj_guard.as_mut() {
            if !project.imported_file_hashes.contains(&hash) {
                project.imported_file_hashes.push(hash);
                project.touch();
                tracing::info!("Tracked imported file hash");
            }
            CommandResult::success()
        } else {
            CommandResult::failure("No project open".to_string())
        }
    }
}
