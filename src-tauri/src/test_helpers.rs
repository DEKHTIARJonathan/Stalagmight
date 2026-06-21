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
        let path = dir.path().join("project.stalx");
        let mut db = Database::open(&path)?;
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

// === Config isolation =====================================================
//
// `AppState::new()` loads the global config via `Config::load()`, which (because
// `app_dirs` is never initialized in unit tests) falls back to the developer's
// REAL `~/.config/stalagmight/config.toml`. Tests that read or write config
// therefore raced on — and permanently polluted — that real file (e.g. a test
// writing `undo_history_limit = 42` made `test_get_config`'s default assertion
// fail forever after). These helpers redirect the config path to a fresh temp
// dir, serialized so the process-global override can't tear under parallel
// tests, so config-touching tests are isolated from each other and the real file.

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

#[cfg(test)]
fn config_override_cell() -> &'static Mutex<Option<PathBuf>> {
    static CELL: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// The config directory override active for the current isolated test, if any.
/// `Config::config_path()` consults this (under `#[cfg(test)]`) so tests never
/// touch the real config file.
#[cfg(test)]
pub fn config_path_override() -> Option<PathBuf> {
    config_override_cell()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[cfg(test)]
fn config_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Acquire the process-global config serialization lock WITHOUT setting an
/// override. For the rare test that drives `Config::config_path()` itself (e.g.
/// pointing `XDG_CONFIG_HOME` at a read-only dir to force a save failure): it
/// must still serialize against override-using tests, but must not have the
/// path redirected to a temp dir. Recovers from a poisoned lock.
#[cfg(test)]
pub fn config_lock_guard() -> MutexGuard<'static, ()> {
    config_test_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// RAII guard that holds the config serialization lock and the temp dir backing
/// the override. Dropping it clears the override (so later non-isolated calls
/// see the real path) and releases the lock.
#[cfg(test)]
pub struct IsolatedConfig {
    _dir: TempDir,
    _guard: MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for IsolatedConfig {
    fn drop(&mut self) {
        *config_override_cell()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}

/// Redirect the global config path to a fresh temp directory until the returned
/// guard drops, serialized against every other config-touching test. Hold the
/// guard for the lifetime of any code that reads or writes config (note: recent
/// projects live in the config too, so they are isolated as well).
#[cfg(test)]
pub fn isolated_config() -> IsolatedConfig {
    let guard = config_lock_guard();
    let dir = TempDir::new().expect("create temp config dir");
    *config_override_cell()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(dir.path().to_path_buf());
    IsolatedConfig {
        _dir: dir,
        _guard: guard,
    }
}

/// Run `f` with the config path redirected to a fresh temp dir (see
/// [`isolated_config`]).
#[cfg(test)]
pub fn with_isolated_config<T>(f: impl FnOnce() -> T) -> T {
    let _cfg = isolated_config();
    f()
}
