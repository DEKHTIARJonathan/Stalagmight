use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

use super::{Database, SCHEMA_VERSION};

/// Whether `path` names a `.stalx` project file, in any letter case.
///
/// Case-insensitive because everything else that decides "is this a project
/// file" is: the frontend's save dialogs accept `CaveA.STALX` as already having
/// the extension, the open router lowercases it, and a project copied from a
/// case-insensitive filesystem can arrive with any spelling. Comparing
/// case-sensitively made the save pipeline rewrite `CaveA.STALX` to
/// `CaveA.stalx` - on a case-sensitive filesystem a DIFFERENT file, which the
/// rename then replaced without the overwrite prompt that only ever saw
/// `CaveA.STALX` (#576 B33).
pub fn has_stalx_extension(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("stalx"))
}

/// Every file type Stalagmight reads or writes. A trailing extension naming one
/// of them is a mistyped format and is REPLACED; any other is part of the name.
/// Mirrors `KNOWN_FILE_EXTENSIONS` in `src/utils/fileDialogs.ts` (#576 D35).
const KNOWN_FILE_EXTENSIONS: &[&str] = &[
    "stalx", "plnx", "gpx", "tml", "tmlu", "mak", "dat", "wpj", "srv", "dmp", "csv", "json", "png",
    "svg", "pdf", "xml",
];

/// `path` with a `.stalx` extension: returned as given when it already has one
/// in any letter case (see [`has_stalx_extension`]). Otherwise an extension that
/// names a known file type (`CaveA.tml`) - or a bare trailing dot - is replaced,
/// and anything else is appended to: `CaveA 1.5` becomes `CaveA 1.5.stalx`, not
/// `CaveA 1.stalx`, a different file no overwrite prompt was shown for
/// (#576 D35-D1, the frontend's `ensureExtension` rule).
pub fn with_stalx_extension(path: PathBuf) -> PathBuf {
    if has_stalx_extension(&path) {
        return path;
    }
    let replace = path.extension().is_some_and(|ext| {
        ext.is_empty()
            || KNOWN_FILE_EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
    });
    if replace {
        path.with_extension("stalx")
    } else {
        let mut appended = path.into_os_string();
        appended.push(".stalx");
        PathBuf::from(appended)
    }
}

impl Database {
    /// Open or create a database at the given path
    pub fn open(path: &Path) -> Result<Self> {
        // Per-open chatter is debug-only - `open` is called for every
        // project create / save-as / import / recent-list refresh.
        tracing::debug!("Opening database at: {:?}", path);

        // Whether the file already existed decides fresh-vs-migrate below, so
        // capture it BEFORE Connection::open creates it for a new path. This is a
        // more robust discriminator than user_version/row-count: an existing file
        // that predates the user_version pragma (stamped 0) or that has no project
        // row yet must still be MIGRATED, not treated as fresh.
        let file_existed = path.exists();

        let conn = Connection::open(path).context("Failed to open database")?;

        let mut db = Self { conn };
        db.enable_foreign_keys()?;

        let prior_version = db.get_user_version().unwrap_or(0);
        if prior_version > SCHEMA_VERSION {
            tracing::warn!(
                current = prior_version,
                expected = SCHEMA_VERSION,
                "Database schema version is newer than this app"
            );
        }
        db.init_schema()?;

        // A brand-new file (did not exist until Connection::open created it) was
        // just built at the CURRENT schema by init_schema (CREATE-IF-NOT-EXISTS),
        // so stamp it directly -- cheap, and the hot path for every save/import
        // temp file. An EXISTING file may predate a column-adding migration:
        // init_schema cannot ALTER an existing table, so it must run the real
        // migration chain so e.g. the v9->v10 speleo_link.last_edit_at ALTER
        // actually happens BEFORE the version is stamped -- otherwise
        // ensure_schema_version()'s fast path (user_version == SCHEMA_VERSION)
        // skips the migration forever and a later `SELECT last_edit_at` fails.
        // ensure_schema_version() also drops the unsafe pre-v7 undo/redo payloads
        // it used to be open()'s job to strip. (#241)
        if !file_existed {
            db.set_user_version(SCHEMA_VERSION)?;
        } else if prior_version < SCHEMA_VERSION {
            db.ensure_schema_version()?;
        }
        // An existing file already at (or newer than) SCHEMA_VERSION is left
        // untouched; a newer version was warned about above.

        tracing::debug!("Schema initialized");

        Ok(db)
    }

    /// Open an existing database (does not create if missing)
    pub fn open_existing(path: &Path) -> Result<Self> {
        // Verbose open-time logging is debug-only - it fires on every
        // project load and every recent-projects metadata read, which
        // adds up.  The error paths still log at error/warn.
        tracing::debug!("Opening existing database at: {:?}", path);

        if !path.exists() {
            tracing::error!("File does not exist: {:?}", path);
            anyhow::bail!("File does not exist");
        }

        // Open in read-only mode first to check if it's valid
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .context("Failed to open database - file may not be a valid SQLite database")?;

        let mut db = Self { conn };
        db.enable_foreign_keys()?;

        // Let SQLite mmap the whole file (up to 256 MB).  Sequential
        // scans during integrity check / shot load go through the OS
        // page cache without a per-row copy into SQLite's buffer.
        // Cheap to enable; bounded by SQLite's own mmap_size cap.
        let _ = db
            .conn
            .pragma_update(None, "mmap_size", 256i64 * 1024 * 1024);
        // Default cache_size is 2 000 pages (~2 MB). Large projects
        // benefit from holding more pages resident so the per-section
        // shot SELECT and the integrity check don't re-fault from
        // mmap. 32 MiB covers the 11 MB 92.stalx with headroom for
        // the indexes; SQLite caps this against its own limits.
        let _ = db.conn.pragma_update(None, "cache_size", -32_000i64); // negative = KiB
                                                                       // Skip syncing on read-only-equivalent operations.
                                                                       // (load path doesn't write - this is harmless on writes too;
                                                                       // we already use a single transaction in save_project.)
        let _ = db.conn.pragma_update(None, "temp_store", "MEMORY");

        // Run quick integrity check before reading any data (SPEC 14.4)
        let t = std::time::Instant::now();
        db.validate_integrity()
            .context("Database file may be corrupted")?;
        tracing::debug!(
            ms = t.elapsed().as_millis() as u64,
            "open_existing: validate_integrity"
        );

        // Check if the project table exists and has data
        let t = std::time::Instant::now();
        let has_data = db.has_project_data()?;
        tracing::debug!(
            ms = t.elapsed().as_millis() as u64,
            "open_existing: has_project_data"
        );

        if !has_data {
            tracing::error!("File does not contain valid Stalagmight project data");
            anyhow::bail!("File does not contain a valid Stalagmight project");
        }

        // Run lightweight migrations to ensure newer tables exist in legacy projects
        let t = std::time::Instant::now();
        db.ensure_schema_version()?;
        tracing::debug!(
            ms = t.elapsed().as_millis() as u64,
            "open_existing: ensure_schema_version"
        );

        let t = std::time::Instant::now();
        db.validate_foreign_keys()?;
        tracing::debug!(
            ms = t.elapsed().as_millis() as u64,
            "open_existing: validate_foreign_keys"
        );

        Ok(db)
    }

    /// [#576 B6-D1] The schema version stamped on this file when it is ABOVE the
    /// one this build knows - the file was saved by a newer Stalagmight - else
    /// `None`.
    ///
    /// Read off `PRAGMA user_version`, the same stamp `ensure_schema_version`
    /// keys its "newer than this app" branch on, so the two can never disagree
    /// about a file: every build stamps it on every file it writes. The project
    /// row's `schema_version` is deliberately not consulted - on an unstamped
    /// file it is an unverified claim (#485), and that shape is not one any
    /// build writes.
    pub fn newer_schema_version(&self) -> Option<i32> {
        self.get_user_version()
            .ok()
            .filter(|version| *version > SCHEMA_VERSION)
    }

    /// [#576 B6-D1] Re-open `path` - the file this handle was opened from by
    /// [`Self::open_existing`] - through a READ-ONLY connection, consuming the
    /// read-write one so a session cannot keep both.
    ///
    /// For a file a newer build wrote ([`Self::newer_schema_version`]): the
    /// project is viewed, never written, and a read-only connection is what
    /// makes that hold for every path that reaches the handle - including the
    /// ones that are deliberately ungated (display settings) - instead of only
    /// for the ones that remember to check. A write through it fails with
    /// `SQLITE_READONLY` and leaves the file as it was.
    ///
    /// The checks `open_existing` ran (quick_check, project data, foreign keys)
    /// are not repeated: they described this same file a moment ago. The read
    /// tuning pragmas are, because they are per connection.
    pub fn into_read_only(self, path: &Path) -> Result<Self> {
        drop(self);
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("Failed to reopen the database read-only")?;
        let db = Self { conn };
        db.enable_foreign_keys()?;
        let _ = db
            .conn
            .pragma_update(None, "mmap_size", 256i64 * 1024 * 1024);
        let _ = db.conn.pragma_update(None, "cache_size", -32_000i64);
        let _ = db.conn.pragma_update(None, "temp_store", "MEMORY");
        Ok(db)
    }

    /// Open a database for read-only metadata extraction only.
    ///
    /// Skips the per-file integrity check, foreign-key validation, schema
    /// migration, and project-data presence check that `open_existing` /
    /// `open_readonly` run. Those are appropriate when actually loading
    /// project data; for the recent-projects listing they add hundreds of
    /// milliseconds per file (PRAGMA quick_check walks every page). The
    /// metadata reads below are pure SELECTs and will fail with a clear
    /// error if the schema is missing - that's enough validation for the
    /// purpose. If the user later opens this project, the full open path
    /// runs its checks then.
    pub fn open_for_metadata(path: &Path) -> Result<Self> {
        if !path.exists() {
            anyhow::bail!("File does not exist: {}", path.display());
        }
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("Failed to open database read-only for metadata")?;
        Ok(Self { conn })
    }

    /// [`Self::open_for_metadata`] with WRITE access, for the one question a
    /// read-only connection cannot answer: what is in a file whose last write
    /// was interrupted.
    ///
    /// A hot rollback journal (a kill, a power loss) fails a read-only open with
    /// `SQLITE_READONLY_ROLLBACK` because rolling it back is a write. This opens
    /// read-write so SQLite performs that recovery on the first read - and does
    /// nothing else: no integrity check, no project-data check, no foreign-key
    /// validation and, above all, NO `ensure_schema_version`. That last one is
    /// the point. The caller (`core::state::speleodb_foreign`, in the root
    /// crate) uses this to decide whether a file may be opened AT ALL, and may well
    /// refuse it; running the load path's migrations there would rewrite - and
    /// in the v15 case discard undo/redo history from - a file the user is
    /// about to be told they cannot open, before they have answered the prompt.
    ///
    /// Rolling the journal back is itself a write, and an unavoidable one: it is
    /// the only way to see the committed contents, and it is exactly what the
    /// next ordinary open would do anyway. Everything beyond it is avoidable,
    /// so this does none of it.
    ///
    /// Do NOT reach for this to load project data. It is `open_for_metadata`'s
    /// sibling, with `open_for_metadata`'s caveats: the schema is whatever the
    /// file has, and a missing table surfaces as a failed SELECT.
    pub fn open_for_metadata_recovering(path: &Path) -> Result<Self> {
        if !path.exists() {
            anyhow::bail!("File does not exist: {}", path.display());
        }
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .context("Failed to open database read-write for metadata")?;
        Ok(Self { conn })
    }

    /// Open an existing database in read-only mode.
    /// Does not create if missing, does not run migrations.
    /// Used for lazy loading survey geometry without modifying files.
    pub fn open_readonly(path: &Path) -> Result<Self> {
        tracing::debug!("Opening database read-only at: {:?}", path);

        if !path.exists() {
            anyhow::bail!("File does not exist: {}", path.display());
        }

        // Validate it's a Stalagmight project file by extension
        if !has_stalx_extension(path) {
            anyhow::bail!("Not a Stalagmight project file: {}", path.display());
        }

        // Open in read-only mode - no writes possible
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("Failed to open database read-only")?;

        let db = Self { conn };
        db.enable_foreign_keys()?;

        // Run quick integrity check before reading any data (SPEC 14.4)
        db.validate_integrity()
            .context("Database file may be corrupted")?;

        if let Ok(version) = db.get_user_version() {
            if version > SCHEMA_VERSION {
                tracing::warn!(
                    current = version,
                    expected = SCHEMA_VERSION,
                    "Database schema version is newer than this app"
                );
            }
        }

        // Verify project data exists
        if !db.has_project_data()? {
            anyhow::bail!("File does not contain a valid Stalagmight project");
        }

        db.validate_foreign_keys()?;
        Ok(db)
    }

    /// Check if the database has valid project data
    pub fn has_project_data(&self) -> Result<bool> {
        // First check if project table exists
        let table_exists: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='project'",
            [],
            |row| row.get(0),
        )?;

        if table_exists == 0 {
            tracing::warn!("project table does not exist in database");
            return Ok(false);
        }

        // Check if project table has any rows
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM project", [], |row| row.get(0))?;

        Ok(count > 0)
    }

    /// Create an in-memory database (for testing)
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("Failed to create in-memory database")?;
        let db = Self { conn };
        db.enable_foreign_keys()?;
        db.init_schema()?;
        db.set_user_version(SCHEMA_VERSION)?;
        Ok(db)
    }
}
