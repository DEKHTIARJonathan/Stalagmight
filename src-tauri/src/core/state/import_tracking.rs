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
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
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

    /// Batch-check which section hashes have already been imported.
    /// Returns a parallel `Vec<bool>` (true = already imported).
    pub fn check_section_hashes(&self, hashes: &[String]) -> Result<Vec<bool>> {
        let proj_guard = self.project.lock()
            .map_err(|_| anyhow::anyhow!("Failed to lock project"))?;

        if let Some(project) = proj_guard.as_ref() {
            Ok(hashes.iter().map(|h| project.imported_section_hashes.contains(h)).collect())
        } else {
            Ok(vec![false; hashes.len()])
        }
    }

    /// Batch-track imported section hashes, skipping duplicates.
    pub fn track_section_hashes(&self, hashes: Vec<String>) -> CommandResult {
        let Ok(mut proj_guard) = self.project.lock() else {
            return CommandResult::failure("Failed to lock project".to_string());
        };

        if let Some(project) = proj_guard.as_mut() {
            let mut added = 0usize;
            for hash in hashes {
                if !project.imported_section_hashes.contains(&hash) {
                    project.imported_section_hashes.push(hash);
                    added += 1;
                }
            }
            if added > 0 {
                project.touch();
                tracing::info!(added, "Tracked imported section hashes");
            }
            CommandResult::success()
        } else {
            CommandResult::failure("No project open".to_string())
        }
    }
}
