use std::path::{Path, PathBuf};

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

    /// Permanently delete a project from disk and drop it from the recent list.
    ///
    /// The destructive counterpart to
    /// [`remove_from_recent_projects`](Self::remove_from_recent_projects), which
    /// only forgets the entry. The project's `.stalx` (and, when
    /// `delete_collab_sibling` is set, its same-stem `.tml` collab file) are handed
    /// to the OS's own delete via [`send_to_trash`]: on macOS they land in the
    /// Trash, on Linux in the freedesktop trash where one exists. The app keeps no
    /// undo trail of its own — recovery, if any, is whatever the OS provides.
    ///
    /// Tolerant of a file that is already gone (it still drops the entry from
    /// recents). If the deleted project is the one currently open in memory, the
    /// open project is cleared so a later autosave can't recreate the file we
    /// just removed.
    pub fn delete_project(&self, path: PathBuf, delete_collab_sibling: bool) -> CommandResult {
        // Hand the project DB to the OS trash. The sibling `.tml` is removed only
        // when the caller confirms it's this project's collab file — a same-stem
        // `.tml` next to a non-collab project may be an unrelated/imported Ariane
        // file the user was never warned about, so we leave it alone.
        let mut targets = vec![path.clone()];
        if delete_collab_sibling {
            let tml = path.with_extension("tml");
            if tml != path {
                targets.push(tml);
            }
        }
        for target in &targets {
            if !target.exists() {
                continue;
            }
            if let Err(e) = send_to_trash(target) {
                return CommandResult::failure(format!("Failed to delete {}: {e}", target.display()));
            }
        }

        // Drop it from the recent list. Best-effort: a project that was never in
        // recents (or already removed) should still delete cleanly.
        if let Ok(mut recent) = self.recent_projects.lock() {
            let before = recent.len();
            recent.retain(|p| p != &path);
            if recent.len() != before {
                if let Ok(mut config) = self.config.lock() {
                    config.general.recent_projects.clone_from(&recent);
                    if let Err(e) = config.save() {
                        tracing::warn!("Failed to save config after deleting project: {}", e);
                        return CommandResult::failure(format!("Failed to save config: {e}"));
                    }
                }
            }
        }

        // If we just deleted the file backing the open project, clear it so an
        // autosave can't resurrect the project at the now-trashed path.
        if let Ok(mut guard) = self.project.lock() {
            if guard.as_ref().and_then(|p| p.file_path.as_deref()) == Some(path.as_path()) {
                *guard = None;
            }
        }

        tracing::info!(path = ?path, "Deleted project");
        CommandResult::success()
    }

    /// Rename a project's display name on disk by path, without requiring it to
    /// be the open project. Used by the recent-projects metadata panel. Mirrors
    /// [`set_collab_enabled_for_path`](Self::set_collab_enabled_for_path): a
    /// targeted DB update, plus keeping the open project's in-memory name in
    /// sync if it happens to be the same file.
    pub fn set_project_name_for_path(&self, path: PathBuf, name: String) -> CommandResult {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return CommandResult::failure("Project name cannot be empty".to_string());
        }

        let db = match Database::open_existing(&path) {
            Ok(db) => db,
            Err(e) => return CommandResult::failure(format!("Failed to open project: {e}")),
        };
        if let Err(e) = db.save_project_name(trimmed) {
            return CommandResult::failure(format!("Failed to rename project: {e}"));
        }

        // Keep the open project's in-memory state consistent if it's the same file.
        let mut guard = match self.project.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(open) = guard.as_mut() {
            if open.file_path.as_deref() == Some(path.as_path()) {
                open.name = trimmed.to_string();
            }
        }

        tracing::info!(path = ?path, "Renamed project");
        CommandResult::success()
    }
}

/// Delete a single file by handing it to the OS's native delete.
///
/// Production prefers the platform trash (`trash::delete`) — macOS Trash, Windows
/// Recycle Bin, freedesktop trash on most Linux — so deletes are recoverable where
/// the OS supports it. When there's no usable trash for the file's filesystem (a
/// NAS / removable mount, `HOME` unset, a read-only FS), the trash call fails and
/// we fall back to a permanent `fs::remove_file` so the delete still happens — the
/// user asked for a real delete, and the OS provides recovery only where it can.
///
/// Test builds (and the Android `cdylib` target, which has no desktop trash and
/// excludes the `trash` crate) skip all of that and take the deterministic
/// `fs::remove_file` directly, so `cargo test` neither pollutes the developer's
/// real Trash nor depends on a trash directory existing on a headless CI runner.
#[cfg(all(not(test), not(target_os = "android")))]
fn send_to_trash(path: &Path) -> Result<(), String> {
    match trash::delete(path) {
        Ok(()) => Ok(()),
        Err(trash_err) => std::fs::remove_file(path).map_err(|fs_err| {
            format!("trash failed ({trash_err}); permanent delete also failed ({fs_err})")
        }),
    }
}

// Android has no desktop trash and the `trash` crate isn't built there (the
// dependency is gated off `target_os = "android"` in Cargo.toml), so fall straight
// through to a permanent remove. The app ships desktop-only; this just keeps the
// Android `cdylib` target compiling.
#[cfg(all(not(test), target_os = "android"))]
fn send_to_trash(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(test)]
fn send_to_trash(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
