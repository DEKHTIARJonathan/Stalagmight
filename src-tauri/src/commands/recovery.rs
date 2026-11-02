use std::path::PathBuf;

use crate::commands::write_path::{check_write_path, WriteTarget};
use crate::persistence::{BackupInfo, Database, RepairResult, SalvagedData};

/// Attempt to repair a corrupt database file.
///
/// Creates a numbered backup before attempting repair via REINDEX + VACUUM.
/// Returns the backup path and whether the repair restored integrity.
#[tauri::command]
pub fn attempt_repair(path: PathBuf) -> Result<RepairResult, String> {
    tracing::info!(path = ?path, "IPC: attempt_repair");
    // [#576 C11-D1] The repair rewrites the file in place.
    check_write_path(&path, WriteTarget::Project)?;

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

/// List the files a project can be restored from, labelled and checked.
///
/// Backups (`.backup`, `.backup.N`, `.pre-v<N>.backup`), an interrupted save's
/// `.tmp`, and the files earlier restores replaced (`.pre-restore.N`); each says
/// what it is and whether it can be restored (#576 C15).
#[tauri::command]
pub fn list_backups(path: PathBuf) -> Vec<BackupInfo> {
    tracing::info!(path = ?path, "IPC: list_backups");
    Database::list_backups(&path)
}

/// Restore a project from a backup file.
///
/// The candidate is checked on a staged copy first (refused, with the project
/// untouched, when it is not a usable project); the file it replaces is kept as
/// a numbered `.pre-restore.N` that never overwrites an earlier one; the staged
/// copy is renamed into place atomically (#576 C15). See
/// `Database::restore_from_backup`.
#[tauri::command]
pub fn restore_from_backup(project_path: PathBuf, backup_path: PathBuf) -> Result<String, String> {
    tracing::info!(project = ?project_path, backup = ?backup_path, "IPC: restore_from_backup");
    // [#576 C11-D1] The restore replaces the project file.
    check_write_path(&project_path, WriteTarget::Project)?;

    let outcome = Database::restore_from_backup(&project_path, &backup_path).map_err(|e| {
        tracing::error!(error = %e, "Restore failed");
        format!("{e:#}")
    })?;
    let name = |path: &std::path::Path| {
        path.file_name().map_or_else(
            || path.display().to_string(),
            |n| n.to_string_lossy().into_owned(),
        )
    };
    let message = match outcome.safety_copy {
        Some(copy) => format!(
            "Restored from {}. The file it replaced is kept as {}, and is offered in this \
             list too.",
            name(&backup_path),
            name(&copy)
        ),
        None => format!("Restored from {}.", name(&backup_path)),
    };
    Ok(message)
}

/// Export whatever data can be salvaged from a corrupt database.
///
/// Reads each table independently, collecting recoverable data and errors.
#[tauri::command]
pub fn export_salvageable_data(path: PathBuf) -> Result<SalvagedData, String> {
    tracing::info!(path = ?path, "IPC: export_salvageable_data");

    Database::export_salvageable(&path).map_err(|e| format!("Salvage failed: {e}"))
}
