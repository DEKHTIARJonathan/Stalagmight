//! Read-only reader for Stalagmight `.stalx` project files (#593).
//!
//! Built for servers that store `.stalx` uploads and need the survey inside
//! them, e.g. to generate a map. It never writes to the source: the bytes are
//! copied to a private temporary file, the app's own load path runs on that
//! copy (integrity check, forward migrations, foreign-key check), and the
//! result is converted into this crate's [`Survey`].
//!
//! Running the app's migrations is what makes old files read correctly: some
//! migrations change stored meaning (v12 flips the pitch sign convention), so a
//! raw read of an old file would be silently wrong.
//!
//! The input is treated as hostile. Before the app's load path runs, a file
//! that defines views, triggers, virtual tables or generated columns is
//! refused, because those would run SQL the file chose. Every connection to the
//! copy runs in defensive mode with `trusted_schema` off, a cap on any value
//! SQLite produces, and a deadline that interrupts any statement still running
//! past it; the load connection also skips memory-mapping and keeps temporary
//! data on disk.
//!
//! **The deadline covers SQLite only.** The steps after the load (the app's
//! post-load normalisation, the conversion, and optional station positions) are
//! plain Rust and have no time or memory bound here; some are super-linear in
//! counts the file controls (#597, #596). A server should run each read in a
//! worker it can kill on its own wall-clock and memory limits.
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

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use stalagmight_models::ClassifyScope;
use stalagmight_persistence::persistence::{Database, SCHEMA_VERSION};

pub use survey::{
    Direction, LoopClosure, North, Section, Shot, ShotKind, StationComment, StationId,
    StationMerge, StationPosition, Survey, ZeroDatum,
};

/// Default cap on the input size, in bytes.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Default deadline, measured from opening the copy.
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

/// The newest `.stalx` schema version this crate reads.
pub const SUPPORTED_SCHEMA_VERSION: i32 = SCHEMA_VERSION;

/// Options for [`read_file_with`] and [`read_bytes`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ReadOptions {
    /// Inputs larger than this are refused before anything is copied. Also caps
    /// any single string or blob SQLite produces while loading.
    pub max_file_bytes: u64,
    /// A statement still running this long after the copy is opened is
    /// interrupted and the read fails. SQLite checks it every 1,000 VM steps per
    /// statement, so it bounds long statements, not the sum of many short ones,
    /// and nothing after the load (see the crate docs).
    pub deadline: Duration,
    /// Also compute measured (unadjusted) station positions into [`Survey::stations`].
    pub with_stations: bool,
}

impl Default for ReadOptions {
    fn default() -> Self {
        Self {
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            deadline: DEFAULT_DEADLINE,
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
    pub fn deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
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
    #[error("input is over the {max}-byte limit")]
    TooLarge { max: u64 },
    #[error("file uses .stalx schema v{found}; this reader supports up to v{supported}")]
    NewerSchema { found: i32, supported: i32 },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// Not a readable `.stalx`: not SQLite, corrupt, missing project data, a
    /// refused schema object, or interrupted by the deadline.
    ///
    /// The text can quote content from the file (SQLite error context). Treat it
    /// as untrusted: log it, don't echo it to other users.
    #[error("not a readable .stalx file: {0}")]
    Invalid(String),
}

/// Read a `.stalx` file with default options.
pub fn read_file(path: &Path) -> Result<Survey, ReadError> {
    read_file_with(path, &ReadOptions::default())
}

/// Read a `.stalx` file. Streams at most `max_file_bytes + 1` bytes from `path`
/// straight into the private copy, so the input is never held in memory.
pub fn read_file_with(path: &Path, options: &ReadOptions) -> Result<Survey, ReadError> {
    let dir = tempfile::tempdir()?;
    let copy = dir.path().join("project.stalx");
    let written = std::io::copy(
        &mut std::fs::File::open(path)?.take(options.max_file_bytes.saturating_add(1)),
        &mut std::fs::File::create(&copy)?,
    )?;
    if written > options.max_file_bytes {
        return Err(ReadError::TooLarge {
            max: options.max_file_bytes,
        });
    }
    read_copy(&copy, options)
}

/// Read a `.stalx` file held in memory (e.g. an upload).
pub fn read_bytes(bytes: &[u8], options: &ReadOptions) -> Result<Survey, ReadError> {
    if bytes.len() as u64 > options.max_file_bytes {
        return Err(ReadError::TooLarge {
            max: options.max_file_bytes,
        });
    }
    let dir = tempfile::tempdir()?;
    let copy = dir.path().join("project.stalx");
    std::fs::File::create(&copy)?.write_all(bytes)?;
    read_copy(&copy, options)
}

/// Read the private copy. The caller keeps the temp dir alive across this call;
/// every connection to the copy is dropped before it returns.
fn read_copy(copy: &Path, options: &ReadOptions) -> Result<Survey, ReadError> {
    let max_value_bytes = i32::try_from(options.max_file_bytes).unwrap_or(i32::MAX);
    let schema_version = inspect(copy, max_value_bytes, options.deadline)?;
    if schema_version > SCHEMA_VERSION {
        return Err(ReadError::NewerSchema {
            found: schema_version,
            supported: SCHEMA_VERSION,
        });
    }

    let db = Database::open_existing_untrusted(copy, max_value_bytes, options.deadline)
        .map_err(invalid)?;
    let mut project = db.load_project().map_err(invalid)?;
    // The post-load steps of the app's own open (`project_load.rs`) that change
    // what this crate reports: ids for legacy closures, re-derived section
    // offsets (which also re-anchors refs and turns orphan closures into
    // merges), and the one-shot Jump/Reference classification an old file's
    // migration left pending. All in-memory; the copy is discarded.
    project.assign_closure_ids();
    project.redrive_offsets_after_load();
    if db.is_kind_classification_pending() {
        project.classify_virtual_shots(&ClassifyScope::WholeProject);
    }
    Ok(Survey::from_project(
        &project,
        schema_version,
        options.with_stations,
    ))
}

/// Refuse schema objects that would run file-chosen SQL, and return the file's
/// schema version, both read before anything migrates the copy.
///
/// The version follows the app's own rule: `PRAGMA user_version`, or when that
/// is 0 (files from before the pragma), the `project.schema_version` column.
fn inspect(path: &Path, max_value_bytes: i32, deadline: Duration) -> Result<i32, ReadError> {
    use rusqlite::config::DbConfig;
    use rusqlite::limits::Limit;

    let sql_err = |e: rusqlite::Error| ReadError::Invalid(e.to_string());
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(sql_err)?;
    // Same hardening as the load connection: this one parses the file's schema too.
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(sql_err)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
        .map_err(sql_err)?;
    conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, max_value_bytes);
    let expires = std::time::Instant::now() + deadline;
    conn.progress_handler(1_000, Some(move || std::time::Instant::now() > expires));

    // Decided by what SQLite PARSED, not by the stored `sql` text: SQLite accepts
    // `CREATE/**/VIRTUAL TABLE` and other spellings a text match would miss.
    // `pragma_table_list` reports each object's parsed type without connecting it.
    let refused: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM pragma_table_list \
                     WHERE type IN ('view', 'virtual', 'shadow')) \
                  + (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger')",
            [],
            |row| row.get(0),
        )
        .map_err(sql_err)?;
    if refused > 0 {
        return Err(ReadError::Invalid(format!(
            "the file defines {refused} view(s), trigger(s) or virtual table(s)"
        )));
    }
    // A generated column evaluates file-chosen expressions on every read, and
    // built-ins such as zeroblob stay allowed with trusted_schema off.
    let generated: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master AS m, pragma_table_xinfo(m.name) AS c \
             WHERE m.type = 'table' AND c.hidden IN (2, 3)",
            [],
            |row| row.get(0),
        )
        .map_err(sql_err)?;
    if generated > 0 {
        return Err(ReadError::Invalid(format!(
            "the file defines {generated} generated column(s)"
        )));
    }

    let stamped: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_err)?;
    if stamped < 0 {
        return Err(ReadError::Invalid(format!(
            "negative schema version {stamped}"
        )));
    }
    if stamped > 0 {
        return Ok(stamped);
    }
    let has_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('project') WHERE name = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .map_err(sql_err)?;
    if has_column == 0 {
        return Ok(0);
    }
    let claimed: Option<i32> = conn
        .query_row("SELECT schema_version FROM project LIMIT 1", [], |row| {
            row.get(0)
        })
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e),
        })
        .map_err(sql_err)?;
    Ok(claimed.unwrap_or(0).max(0))
}

fn invalid(e: anyhow::Error) -> ReadError {
    ReadError::Invalid(format!("{e:#}"))
}

#[cfg(test)]
mod tests;
