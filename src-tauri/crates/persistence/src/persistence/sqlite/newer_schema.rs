//! Refusing a `.stalx` saved by a newer schema than this build knows (#649).
//!
//! This build reads a file with the columns and tables it knows, and every save
//! rebuilds the file from scratch at [`SCHEMA_VERSION`] (`save_project` in
//! `core::state::project_io` writes a fresh temp file and renames it over the
//! original). Anything a newer schema added would be dropped without a word, and
//! the open itself already writes into the file (the migration path's history
//! cleanup, `init_schema`'s `CREATE TABLE IF NOT EXISTS`). So the openers refuse
//! such a file before they write or read anything else; the `stalx-reader` crate
//! refuses it the same way (its `ReadError::NewerSchema`).

use rusqlite::types::ValueRef;
use rusqlite::Connection;

use super::SCHEMA_VERSION;

/// A project file saved by a newer Stalagmight than this one. Rides inside the
/// open error, so callers can `downcast_ref` it to tell this refusal apart from
/// corruption or an I/O failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewerSchema {
    /// The file's schema version.
    pub found: i32,
    /// The newest schema version this build reads, [`SCHEMA_VERSION`].
    pub supported: i32,
}

impl std::fmt::Display for NewerSchema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "this project was saved by a newer version of Stalagmight (file format {}, this \
             version reads up to {}); update Stalagmight to open it",
            self.found, self.supported
        )
    }
}

impl std::error::Error for NewerSchema {}

/// The schema version `conn`'s file was written at, by the rule
/// `ensure_schema_version` and the `stalx-reader` crate both use:
/// `PRAGMA user_version`, or, when that is 0 (files from before the pragma), the
/// `project.schema_version` column. A value that cannot be read counts as 0, so
/// a damaged file reaches the integrity check that names its real problem.
///
/// Run only after [`super::check_schema`]: it reads `pragma_table_info`, which a
/// hostile file could otherwise shadow.
pub(super) fn file_schema_version(conn: &Connection) -> i32 {
    let stamped: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if stamped != 0 {
        return stamped;
    }
    let has_column = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('project') WHERE name = 'schema_version'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .is_ok_and(|count| count > 0);
    if !has_column {
        return 0;
    }
    // Read loosely: the column may hold any storage type in a damaged file.
    conn.query_row("SELECT schema_version FROM project LIMIT 1", [], |row| {
        Ok(match row.get_ref(0)? {
            // Out of `i32` range is no version any build wrote; the migration
            // path reads it as 0 as well (`get_project_schema_version` fails).
            ValueRef::Integer(v) => i32::try_from(v).unwrap_or(0),
            _ => 0,
        })
    })
    .unwrap_or(0)
}

/// Refuse `conn`'s file if a newer schema than [`SCHEMA_VERSION`] wrote it.
/// Call it right after [`super::check_schema`] on every open of an existing
/// file, before anything writes to or validates it.
pub(super) fn check_not_newer(conn: &Connection) -> anyhow::Result<()> {
    let found = file_schema_version(conn);
    if found > SCHEMA_VERSION {
        return Err(anyhow::Error::new(NewerSchema {
            found,
            supported: SCHEMA_VERSION,
        }));
    }
    Ok(())
}
