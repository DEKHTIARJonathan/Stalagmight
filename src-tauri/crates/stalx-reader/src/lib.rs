//! Read-only reader for Stalagmight `.stalx` project files (#593).
//!
//! Built for servers that store `.stalx` uploads and need the survey inside
//! them, e.g. to generate a map. It never writes to the source file: the bytes
//! are copied to a private temporary file, the app's own load path runs on that
//! copy (integrity check, forward migrations, foreign-key check), and the
//! result is converted into this crate's [`Survey`].
//!
//! Running the app's migrations is what makes old files read correctly: some
//! migrations change stored meaning (v12 flips the pitch sign convention), so a
//! raw read of an old file would be silently wrong.
//!
//! Files written by a newer schema than this crate knows are refused with
//! [`ReadError::NewerSchema`]; upgrade the crate to read them.
//!
//! ```no_run
//! let survey = stalx_reader::read_file(std::path::Path::new("project.stalx"))?;
//! for section in &survey.sections {
//!     println!("{:?}: {} shots", section.name, section.shots.len());
//! }
//! # Ok::<(), stalx_reader::ReadError>(())
//! ```

mod survey;

use std::io::Write;
use std::path::Path;

use stalagmight_persistence::persistence::{Database, SCHEMA_VERSION};

pub use survey::{
    Direction, LoopClosure, North, Section, Shot, ShotKind, StationComment, StationId,
    StationMerge, StationPosition, Survey, ZeroDatum,
};

/// Default cap on the input size, in bytes.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// The newest `.stalx` schema version this crate reads.
pub const SUPPORTED_SCHEMA_VERSION: i32 = SCHEMA_VERSION;

/// Options for [`read_file_with`] and [`read_bytes`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ReadOptions {
    /// Inputs larger than this are refused before anything is copied.
    pub max_file_bytes: u64,
    /// Also compute measured (unadjusted) station positions into [`Survey::stations`].
    pub with_stations: bool,
}

impl Default for ReadOptions {
    fn default() -> Self {
        Self {
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            with_stations: false,
        }
    }
}

impl ReadOptions {
    #[must_use]
    pub fn max_file_bytes(mut self, bytes: u64) -> Self {
        self.max_file_bytes = bytes;
        self
    }

    #[must_use]
    pub fn with_stations(mut self, on: bool) -> Self {
        self.with_stations = on;
        self
    }
}

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ReadError {
    #[error("input is {size} bytes, over the {max}-byte limit")]
    TooLarge { size: u64, max: u64 },
    #[error("file uses .stalx schema v{found}; this reader supports up to v{supported}")]
    NewerSchema { found: i32, supported: i32 },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// Not a readable `.stalx`: not SQLite, corrupt, or missing project data.
    #[error("not a readable .stalx file: {0}")]
    Invalid(String),
}

/// Read a `.stalx` file with default options.
pub fn read_file(path: &Path) -> Result<Survey, ReadError> {
    read_file_with(path, &ReadOptions::default())
}

/// Read a `.stalx` file.
pub fn read_file_with(path: &Path, options: &ReadOptions) -> Result<Survey, ReadError> {
    let size = std::fs::metadata(path)?.len();
    check_size(size, options)?;
    read_bytes(&std::fs::read(path)?, options)
}

/// Read a `.stalx` file held in memory (e.g. an upload).
pub fn read_bytes(bytes: &[u8], options: &ReadOptions) -> Result<Survey, ReadError> {
    check_size(bytes.len() as u64, options)?;

    let dir = tempfile::tempdir()?;
    let copy = dir.path().join("project.stalx");
    std::fs::File::create(&copy)?.write_all(bytes)?;

    let schema_version = read_user_version(&copy)?;
    if schema_version > SCHEMA_VERSION {
        return Err(ReadError::NewerSchema {
            found: schema_version,
            supported: SCHEMA_VERSION,
        });
    }

    let db = Database::open_existing(&copy).map_err(invalid)?;
    let project = db.load_project().map_err(invalid)?;
    Ok(Survey::from_project(
        &project,
        schema_version,
        options.with_stations,
    ))
}

fn check_size(size: u64, options: &ReadOptions) -> Result<(), ReadError> {
    if size > options.max_file_bytes {
        return Err(ReadError::TooLarge {
            size,
            max: options.max_file_bytes,
        });
    }
    Ok(())
}

/// The file's version, read before `open_existing` migrates the copy forward.
fn read_user_version(path: &Path) -> Result<i32, ReadError> {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| ReadError::Invalid(e.to_string()))?;
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| ReadError::Invalid(e.to_string()))
}

fn invalid(e: anyhow::Error) -> ReadError {
    ReadError::Invalid(format!("{e:#}"))
}

#[cfg(test)]
mod tests;
