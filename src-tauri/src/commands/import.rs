use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::State;

use crate::core::state::AppState;
use crate::core::CommandResult;
use crate::parsers::DmpFile;
use crate::parsers::tml::TmlFile;

/// Import a DMP file and return parsed data
#[tauri::command]
pub fn import_dmp(path: PathBuf) -> Result<DmpFile, String> {
    tracing::info!(
        path = ?path,
        purpose = "prepare import preview",
        "Parsing DMP file for import preview"
    );
    let result = crate::parsers::parse_dmp(&path);
    if let Err(ref e) = result {
        tracing::error!(
            path = ?path,
            purpose = "prepare import preview",
            reason = %e,
            "Failed to parse DMP file for import preview"
        );
    }
    result.map_err(|e| e.to_string())
}

/// Calculate SHA256 hash of a file
#[tauri::command]
pub fn calculate_file_hash(path: PathBuf) -> Result<String, String> {
    tracing::debug!(
        path = ?path,
        purpose = "detect duplicate imports",
        "Calculating file hash for import deduplication"
    );
    let contents = fs::read(&path).map_err(|e| {
        tracing::error!(
            path = ?path,
            purpose = "detect duplicate imports",
            reason = %e,
            "Failed to read file while calculating import hash"
        );
        format!("Failed to read file: {e}")
    })?;

    let mut hasher = Sha256::new();
    hasher.update(&contents);
    let result = hasher.finalize();

    let hash = format!("{result:x}");
    tracing::debug!(
        path = ?path,
        purpose = "detect duplicate imports",
        hash = %hash,
        "Calculated file hash for import deduplication"
    );
    Ok(hash)
}

/// Check if a file hash has already been imported to the project
#[tauri::command]
pub fn check_duplicate_import(state: State<'_, AppState>, hash: String) -> Result<bool, String> {
    check_duplicate_import_impl(state.inner(), hash)
}

pub(crate) fn check_duplicate_import_impl(state: &AppState, hash: String) -> Result<bool, String> {
    tracing::debug!(
        hash = %hash,
        purpose = "detect duplicate imports",
        "Checking whether file hash was previously imported"
    );
    state.check_duplicate_import(&hash).map_err(|e| e.to_string())
}

/// Track an imported file hash in the project
#[tauri::command]
pub fn track_imported_file(state: State<'_, AppState>, hash: String) -> CommandResult {
    track_imported_file_impl(state.inner(), hash)
}

pub(crate) fn track_imported_file_impl(state: &AppState, hash: String) -> CommandResult {
    tracing::debug!(
        hash = %hash,
        purpose = "prevent duplicate imports",
        "Tracking imported file hash"
    );
    state.track_imported_file(hash)
}

/// Import multiple sections as a single atomic undo/redo unit.
/// Includes file hash tracking so undo also reverts the duplicate-detection state.
#[tauri::command]
pub fn import_sections(
    state: State<'_, AppState>,
    sections: Vec<crate::models::ImportSectionConfig>,
    file_hash: Option<String>,
) -> CommandResult {
    state.execute_import_sections(sections, file_hash)
}

/// Parse a TML/TMLU file and return preview data for the import dialog.
#[tauri::command]
pub fn parse_tml(path: PathBuf) -> Result<TmlFile, String> {
    tracing::info!(
        path = ?path,
        purpose = "prepare TML import preview",
        "Parsing Ariane TML/TMLU file for import preview"
    );
    let result = crate::parsers::tml::parse_tml(&path);
    if let Err(ref e) = result {
        tracing::error!(
            path = ?path,
            purpose = "prepare TML import preview",
            reason = %e,
            "Failed to parse TML/TMLU file for import preview"
        );
    }
    result.map_err(|e| e.to_string())
}

/// Parse a TML/TMLU file, convert to import configs, and execute the import.
#[tauri::command]
pub fn execute_tml_import(
    state: State<'_, AppState>,
    path: PathBuf,
    file_hash: Option<String>,
) -> CommandResult {
    tracing::info!(
        path = ?path,
        purpose = "import Ariane TML/TMLU",
        "Executing TML import"
    );

    let tml = match crate::parsers::tml::parse_tml(&path) {
        Ok(tml) => tml,
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "import Ariane TML/TMLU",
                reason = %e,
                "Failed to parse TML/TMLU file for import"
            );
            return CommandResult::failure(format!("Failed to parse TML file: {e}"));
        }
    };

    let sections = match crate::parsers::tml::convert_tml_to_import_configs(&tml) {
        Ok(configs) => configs,
        Err(e) => {
            tracing::error!(
                path = ?path,
                purpose = "import Ariane TML/TMLU",
                reason = %e,
                "Failed to convert TML data to import configs"
            );
            return CommandResult::failure(format!("Failed to convert TML data: {e}"));
        }
    };

    tracing::info!(
        path = ?path,
        section_count = sections.len(),
        purpose = "import Ariane TML/TMLU",
        "Converted TML to import configs, executing import"
    );

    state.execute_import_sections(sections, file_hash)
}
