use anyhow::Result;
use std::path::{Path, PathBuf};

use crate::core::AppState;
use crate::models::Project;
use crate::persistence::Database;

#[cfg(test)]
use tempfile::TempDir;

#[cfg(test)]
pub struct TestDb {
    _dir: TempDir,
    path: PathBuf,
}

#[cfg(test)]
impl TestDb {
    pub fn with_project(project: &Project) -> Result<(Self, Database)> {
        let dir = TempDir::new()?;
        let path = dir.path().join("project.cvproj");
        let db = Database::open(&path)?;
        db.save_project(project)?;
        Ok((Self { _dir: dir, path }, db))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
pub fn app_state_with_project_db(project: Project) -> Result<(AppState, TestDb)> {
    let (test_db, db) = TestDb::with_project(&project)?;
    let state = AppState::new()?;
    state.set_project_for_tests(project);
    state.set_database_for_tests(db);
    Ok((state, test_db))
}
