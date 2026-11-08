use std::path::PathBuf;

use crate::persistence::{BackupInfo, Database, RepairResult, SalvagedData};

/// Attempt to repair a corrupt database file.
///
/// Creates a numbered backup before attempting repair via REINDEX + VACUUM.
/// Returns the backup path and whether the repair restored integrity.
#[tauri::command]
pub fn attempt_repair(path: PathBuf) -> Result<RepairResult, String> {
    tracing::info!(path = ?path, "IPC: attempt_repair");

    match Database::attempt_repair(&path) {
        Ok((backup_path, integrity_ok)) => {
            let message = if integrity_ok {
                "Repair succeeded - database integrity restored.".to_string()
            } else {
                "Repair completed but integrity check still fails. \
                 Try exporting salvageable data instead."
                    .to_string()
            };
            Ok(RepairResult {
                success: integrity_ok,
                backup_path: backup_path.display().to_string(),
                message,
            })
        }
        Err(e) => {
            tracing::error!(error = %e, "Repair failed");
            Err(format!("Repair failed: {e}"))
        }
    }
}

/// List available backup files for a project.
///
/// Scans for `.backup`, `.backup.N`, and `.tmp` files alongside the project.
#[tauri::command]
pub fn list_backups(path: PathBuf) -> Vec<BackupInfo> {
    tracing::info!(path = ?path, "IPC: list_backups");
    Database::list_backups(&path)
}

/// Restore a project from a backup file.
///
/// Copies the backup over the original project file after creating a safety
/// backup of the current (corrupt) file.
#[tauri::command]
pub fn restore_from_backup(project_path: PathBuf, backup_path: PathBuf) -> Result<String, String> {
    tracing::info!(project = ?project_path, backup = ?backup_path, "IPC: restore_from_backup");

    // Verify backup exists
    if !backup_path.exists() {
        return Err(format!("Backup file not found: {}", backup_path.display()));
    }

    // Copying a backup over a project a newer Stalagmight saved would put an
    // older file in its place, and a backup a newer Stalagmight saved would put
    // a file this build cannot open there (#649). Both before the safety copy.
    for file in [&project_path, &backup_path] {
        Database::check_not_newer_at(file).map_err(|e| format!("Not restored: {e}"))?;
    }

    // Create a safety backup of the current (corrupt) file before overwriting
    let safety = project_path.with_extension("stalx.pre-restore");
    if let Err(e) = std::fs::copy(&project_path, &safety) {
        tracing::warn!(error = %e, "Could not create pre-restore backup (continuing anyway)");
    }

    // Copy backup over the project file
    std::fs::copy(&backup_path, &project_path)
        .map_err(|e| format!("Failed to restore backup: {e}"))?;

    Ok(format!("Restored from {}", backup_path.display()))
}

/// Export whatever data can be salvaged from a corrupt database.
///
/// Reads each table independently, collecting recoverable data and errors.
#[tauri::command]
pub fn export_salvageable_data(path: PathBuf) -> Result<SalvagedData, String> {
    tracing::info!(path = ?path, "IPC: export_salvageable_data");

    Database::export_salvageable(&path).map_err(|e| format!("Salvage failed: {e}"))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test module: panics on a failed assumption are the point"
)]
mod tests {
    use super::restore_from_backup;
    use crate::models::Project;
    use crate::persistence::{Database, SCHEMA_VERSION};
    use std::path::{Path, PathBuf};

    /// A saved synthetic project at `dir/name`, stamped `version`. The stamp is
    /// written straight into the SQLite header's user-version field (bytes
    /// 60..64, big-endian), which is what `PRAGMA user_version` sets.
    fn project_file(dir: &Path, name: &str, version: i32) -> PathBuf {
        let path = dir.join(name);
        {
            let mut db = Database::open(&path).unwrap();
            db.save_project(&Project::new(name.to_string(), None))
                .unwrap();
        }
        let mut bytes = std::fs::read(&path).unwrap();
        bytes
            .get_mut(60..64)
            .unwrap()
            .copy_from_slice(&version.to_be_bytes());
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// [#649] Restoring an older backup over a project a newer Stalagmight saved
    /// would downgrade it; the restore refuses before it copies anything.
    #[test]
    fn a_restore_never_puts_a_backup_over_a_newer_project() {
        let dir = tempfile::TempDir::new().unwrap();
        let project = project_file(dir.path(), "cave.stalx", SCHEMA_VERSION + 1);
        let backup = project_file(dir.path(), "cave.stalx.backup", SCHEMA_VERSION);
        let before = std::fs::read(&project).unwrap();

        let err = restore_from_backup(project.clone(), backup).unwrap_err();

        assert!(err.contains("newer version of Stalagmight"), "{err}");
        assert_eq!(std::fs::read(&project).unwrap(), before);
        assert!(
            !project.with_extension("stalx.pre-restore").exists(),
            "refused before the safety copy"
        );
    }

    /// [#649] The roles swapped: a backup a newer Stalagmight saved is not put
    /// over a project this build can open, and the refusal names the backup.
    #[test]
    fn a_restore_never_puts_a_newer_backup_over_a_project() {
        let dir = tempfile::TempDir::new().unwrap();
        let project = project_file(dir.path(), "cave.stalx", SCHEMA_VERSION);
        let backup = project_file(dir.path(), "cave.stalx.backup", SCHEMA_VERSION + 1);
        let before = std::fs::read(&project).unwrap();

        let err = restore_from_backup(project.clone(), backup).unwrap_err();

        assert_eq!(
            err,
            format!(
                "Not restored: \"cave.stalx.backup\" was saved by a newer version of \
                 Stalagmight (file format {}; this version reads up to {SCHEMA_VERSION}). \
                 Update Stalagmight to open it.",
                SCHEMA_VERSION + 1
            )
        );
        assert_eq!(std::fs::read(&project).unwrap(), before);
        assert!(
            !project.with_extension("stalx.pre-restore").exists(),
            "refused before the safety copy"
        );
    }

    /// The restore is still for damaged files: one that is not even a database
    /// is restored over as before.
    #[test]
    fn a_restore_over_a_damaged_project_still_runs() {
        let dir = tempfile::TempDir::new().unwrap();
        let project = dir.path().join("cave.stalx");
        std::fs::write(&project, b"damaged beyond reading").unwrap();
        let backup = project_file(dir.path(), "cave.stalx.backup", SCHEMA_VERSION);

        restore_from_backup(project.clone(), backup.clone()).unwrap();

        assert_eq!(
            std::fs::read(&project).unwrap(),
            std::fs::read(&backup).unwrap()
        );
    }
}
