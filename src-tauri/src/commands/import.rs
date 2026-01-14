use std::path::PathBuf;

use crate::parsers::DmpFile;

/// Import a DMP file and return parsed data
#[tauri::command]
pub fn import_dmp(path: PathBuf) -> Result<DmpFile, String> {
    crate::parsers::parse_dmp(&path).map_err(|e| e.to_string())
}
