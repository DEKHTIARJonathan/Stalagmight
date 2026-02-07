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
                "Repair succeeded — database integrity restored.".to_string()
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
