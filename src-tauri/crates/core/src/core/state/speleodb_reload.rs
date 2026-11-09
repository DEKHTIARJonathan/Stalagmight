//! Install an already parsed project while retaining the current tree on failure.
use std::path::Path;

use super::speleodb::local_dto;
use super::AppState;
use crate::models::Project;
use crate::persistence::Database;
use crate::speleodb::{SpeleoDbError, SpeleoErrorDto};

impl AppState {
    /// Caller holds project through file installation and the prepared state commit.
    pub(super) fn install_prepared_database(
        &self,
        source: &Path,
        dest: &Path,
        prepared: Database,
        current: Option<&Project>,
    ) -> Result<Database, SpeleoErrorDto> {
        let io_error = |error: std::io::Error| local_dto(SpeleoDbError::Io(error.to_string()));
        let parent = dest.parent().unwrap_or_else(|| Path::new("."));
        let backup = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
        let had_file = dest.try_exists().map_err(io_error)?;
        if had_file {
            std::fs::copy(dest, backup.path()).map_err(io_error)?;
        }
        // Windows requires both SQLite handles closed before replacing their files.
        drop(prepared);
        self.database
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let installed = std::fs::rename(source, dest)
            .map_err(anyhow::Error::from)
            .and_then(|()| Database::open_existing(dest));
        match installed {
            Ok(db) => {
                super::speleodb_cache_install::sync_cache_directory(dest);
                Ok(db)
            }
            Err(error) => {
                if had_file {
                    std::fs::copy(backup.path(), dest).map_err(io_error)?;
                }
                if let Some(path) = current.and_then(|project| project.file_path.as_deref()) {
                    let original = Database::open_existing(path).map_err(|e| {
                        local_dto(SpeleoDbError::Io(format!(
                            "could not reopen original project: {e}"
                        )))
                    })?;
                    *self
                        .database
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(original);
                }
                Err(local_dto(SpeleoDbError::Io(format!(
                    "could not replace project: {error}"
                ))))
            }
        }
    }
}
