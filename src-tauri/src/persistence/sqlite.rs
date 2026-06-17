use anyhow::{Context, Result};
use chrono::{NaiveDate, Utc};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::Path;

use crate::models::{
    ClosureStrategy, GpsCoordinates, LoopClosure, Project, Section, SectionData, Shot,
    StationKey, StationMerge, SurveyDirection, ZeroDatum, FEATURE_ID_STRIDE,
};


/// Schema version for migrations
///
/// v8 adds a nullable `shot_uuid` column to `resolved_warnings` (issue #57):
/// "Ignore" suppression is keyed by the shot's stable UUID so it survives shot
/// inserts/deletes/reorders. Backfilled lazily from the legacy
/// `(section_id, shot_id)` key — no rewrite of existing rows at migration time.
const SCHEMA_VERSION: i32 = 8;

/// Schema version at which persisted undo/redo payloads became safe to replay.
///
/// v7 changed the `ShotUpdates` JSON wire format: nullable fields now use a
/// `double_option` deserializer where an explicit `null` means "clear the
/// field" (`Some(None)`), while pre-v7 writers serialized every UNTOUCHED
/// nullable field as an explicit `null`. Replaying a pre-v7 undo/redo entry
/// under the new semantics would silently clear pitch/LRUD/comment/marker/
/// temperature on the target shot. Legacy JSON cannot distinguish "untouched"
/// from "restore-to-empty", so files below this version get their persisted
/// undo/redo stacks dropped on open (see `drop_legacy_undo_history`).
///
/// Deliberately a separate constant from `SCHEMA_VERSION`: future schema bumps
/// (v8+) must NOT re-drop undo history unless the undo payload format changes
/// again, in which case bump this constant too.
const UNDO_FORMAT_SAFE_VERSION: i32 = 7;

/// Maximum number of rows a single raw-table page request may return.
pub const MAX_RAW_PAGE_ROWS: u32 = 10_000;

/// Render a blob value as a size placeholder, e.g. `<blob 4.2 KB>`.
fn format_blob_placeholder(len: usize) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let len = len as f64;
    if len < KB {
        format!("<blob {len:.0} B>")
    } else if len < MB {
        format!("<blob {:.1} KB>", len / KB)
    } else if len < GB {
        format!("<blob {:.1} MB>", len / MB)
    } else {
        format!("<blob {:.1} GB>", len / GB)
    }
}

fn compress_json(json: &str) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    // write_all and finish are infallible on Vec<u8>
    encoder
        .write_all(json.as_bytes())
        .and_then(|()| encoder.finish())
        .unwrap_or_else(|_| json.as_bytes().to_vec())
}

fn decompress_json(data: &[u8]) -> Result<String> {
    // Gzip magic bytes: 0x1f 0x8b
    if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
        let mut decoder = GzDecoder::new(data);
        let mut s = String::new();
        decoder.read_to_string(&mut s)?;
        Ok(s)
    } else {
        // Backward compat: old TEXT entries (or CAST-ed BLOB) are plain UTF-8
        Ok(String::from_utf8_lossy(data).into_owned())
    }
}

/// Database operations for projects
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Open or create a database at the given path
    pub fn open(path: &Path) -> Result<Self> {
        // Per-open chatter is debug-only — `open` is called for every
        // project create / save-as / import / recent-list refresh.
        tracing::debug!("Opening database at: {:?}", path);

        let conn = Connection::open(path).context("Failed to open database")?;

        let db = Self { conn };
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
        // `open` stamps the file with the current SCHEMA_VERSION below without
        // running the full migration chain (init_schema is CREATE IF NOT
        // EXISTS). Pre-v7 persisted undo/redo payloads are unsafe to replay
        // (see UNDO_FORMAT_SAFE_VERSION), so drop them here BEFORE the stamp
        // erases the evidence that this file predates the format change.
        // No-op for freshly created files (empty tables).
        if prior_version < UNDO_FORMAT_SAFE_VERSION {
            db.drop_legacy_undo_history()?;
        }
        db.set_user_version(SCHEMA_VERSION)?;
        tracing::debug!("Schema initialized");

        Ok(db)
    }

    /// Open an existing database (does not create if missing)
    pub fn open_existing(path: &Path) -> Result<Self> {
        // Verbose open-time logging is debug-only — it fires on every
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
        let _ = db
            .conn
            .pragma_update(None, "cache_size", -32_000i64); // negative = KiB
        // Skip syncing on read-only-equivalent operations.
        // (load path doesn't write — this is harmless on writes too;
        // we already use a single transaction in save_project.)
        let _ = db
            .conn
            .pragma_update(None, "temp_store", "MEMORY");

        // Run quick integrity check before reading any data (SPEC 14.4)
        let t = std::time::Instant::now();
        db.validate_integrity().context("Database file may be corrupted")?;
        tracing::debug!(ms = t.elapsed().as_millis() as u64, "open_existing: validate_integrity");

        // Check if the project table exists and has data
        let t = std::time::Instant::now();
        let has_data = db.has_project_data()?;
        tracing::debug!(ms = t.elapsed().as_millis() as u64, "open_existing: has_project_data");

        if !has_data {
            tracing::error!("File does not contain valid Stalagmight project data");
            anyhow::bail!("File does not contain a valid Stalagmight project");
        }

        // Run lightweight migrations to ensure newer tables exist in legacy projects
        let t = std::time::Instant::now();
        db.ensure_schema_version()?;
        tracing::debug!(ms = t.elapsed().as_millis() as u64, "open_existing: ensure_schema_version");

        let t = std::time::Instant::now();
        db.validate_foreign_keys()?;
        tracing::debug!(ms = t.elapsed().as_millis() as u64, "open_existing: validate_foreign_keys");

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
    /// error if the schema is missing — that's enough validation for the
    /// purpose. If the user later opens this project, the full open path
    /// runs its checks then.
    pub fn open_for_metadata(path: &Path) -> Result<Self> {
        if !path.exists() {
            anyhow::bail!("File does not exist: {}", path.display());
        }
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .context("Failed to open database read-only for metadata")?;
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
        let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if extension != "stalx" {
            anyhow::bail!("Not a Stalagmight project file: {}", path.display());
        }

        // Open in read-only mode - no writes possible
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .context("Failed to open database read-only")?;

        let db = Self { conn };
        db.enable_foreign_keys()?;

        // Run quick integrity check before reading any data (SPEC 14.4)
        db.validate_integrity().context("Database file may be corrupted")?;

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

    /// Run lightweight schema migrations for tables added after initial release
    fn migrate_schema(&self) -> Result<()> {
        // Ensure display_settings table exists (added in v1.x for per-project display toggles)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS display_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )?;

        // Add direction column to sections table if it doesn't exist (added for direction field)
        // Check if column exists first
        let has_direction_column: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sections') WHERE name='direction'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        if !has_direction_column {
            self.conn.execute(
                "ALTER TABLE sections ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'",
                [],
            )?;
            tracing::info!("Added direction column to sections table");
        }

        // Add quality column to sections table if it doesn't exist (added for weighted adjustments)
        let has_quality_column: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sections') WHERE name='quality'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        if !has_quality_column {
            self.conn.execute(
                "ALTER TABLE sections ADD COLUMN quality REAL NOT NULL DEFAULT 1.0",
                [],
            )?;
            tracing::info!("Added quality column to sections table");
        }

        // Ensure station_offsets table exists (added for individual station moves)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS station_offsets (
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                offset_x REAL NOT NULL,
                offset_y REAL NOT NULL,
                offset_z REAL NOT NULL,
                PRIMARY KEY (section_id, station_index),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // Ensure resolved_warnings table exists (added for user-resolved warnings)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS resolved_warnings (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL,
                shot_id INTEGER NOT NULL,
                warning_code TEXT NOT NULL,
                resolved_at TEXT NOT NULL,
                resolved_comment TEXT,
                shot_uuid TEXT,
                UNIQUE(section_id, shot_id, warning_code),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // Ensure imported_file_hashes table exists (added for duplicate import detection)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS imported_file_hashes (
                id INTEGER PRIMARY KEY,
                hash TEXT NOT NULL UNIQUE
            )",
            [],
        )?;

        // Ensure imported_section_hashes table exists (section-level duplicate detection)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS imported_section_hashes (
                id INTEGER PRIMARY KEY,
                hash TEXT NOT NULL UNIQUE
            )",
            [],
        )?;

        // Add closure_id column to loop_closures table if it doesn't exist (added for closure ID tracking)
        let has_closure_id: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='closure_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        if !has_closure_id {
            // Table may not exist in very old projects, check first
            let loop_table_exists: bool = self.conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='loop_closures'",
                [],
                |row| row.get::<_, i64>(0),
            ).map(|c| c > 0).unwrap_or(false);

            if loop_table_exists {
                self.conn.execute(
                    "ALTER TABLE loop_closures ADD COLUMN closure_id INTEGER NOT NULL DEFAULT 0",
                    [],
                )?;
                tracing::info!("Added closure_id column to loop_closures table");
            }
        }

        // Add strategy column to loop_closures table if it doesn't exist
        let has_strategy: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='strategy'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        if !has_strategy {
            let loop_table_exists: bool = self.conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='loop_closures'",
                [],
                |row| row.get::<_, i64>(0),
            ).map(|c| c > 0).unwrap_or(false);

            if loop_table_exists {
                self.conn.execute(
                    "ALTER TABLE loop_closures ADD COLUMN strategy TEXT NOT NULL DEFAULT 'Batch'",
                    [],
                )?;
                tracing::info!("Added strategy column to loop_closures table");
            }
        }

        // Add is_aligned column to loop_closures table if it doesn't exist
        let has_is_aligned: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='is_aligned'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        if !has_is_aligned {
            let loop_table_exists: bool = self.conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='loop_closures'",
                [],
                |row| row.get::<_, i64>(0),
            ).map(|c| c > 0).unwrap_or(false);

            if loop_table_exists {
                self.conn.execute(
                    "ALTER TABLE loop_closures ADD COLUMN is_aligned INTEGER NOT NULL DEFAULT 0",
                    [],
                )?;
                tracing::info!("Added is_aligned column to loop_closures table");
            }
        }

        // Add next_closure_id column to project table if it doesn't exist (persists monotonic counter)
        let has_next_closure_id: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('project') WHERE name='next_closure_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        if !has_next_closure_id {
            self.conn.execute(
                "ALTER TABLE project ADD COLUMN next_closure_id INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
            tracing::info!("Added next_closure_id column to project table");
        }

        // Ensure station_comments table exists (added for station-level comments)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS station_comments (
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                comment TEXT NOT NULL,
                PRIMARY KEY (section_id, station_index),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // Ensure collab_state table exists (schema v5: collaboration mode).
        // Single-row JSON blob holding the project's CollabState.
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS collab_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state_json TEXT NOT NULL
            )",
            [],
        )?;

        // Add uuid column to shots table (schema v5→v6: per-shot UUIDs
        // for collaboration round-trip identity).  We don't backfill
        // existing rows here — `load_project` lazily mints a UUID for
        // any row that comes back with NULL, and the next save persists
        // it.  That keeps the migration cost a single ALTER TABLE for
        // even very large pre-v6 databases.
        let has_shot_uuid_column: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('shots') WHERE name='uuid'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_shot_uuid_column {
            self.conn
                .execute("ALTER TABLE shots ADD COLUMN uuid TEXT", [])?;
            tracing::info!("Added uuid column to shots table (schema v6)");
        }

        // Add shot_uuid column to resolved_warnings (schema v7→v8: key "Ignore"
        // suppression by the shot's stable UUID, issue #57). Pre-v8 rows keep
        // shot_uuid NULL and continue to match by the legacy
        // (section_id, shot_id) key; they are backfilled lazily on the next
        // resolve of the same shot. A single idempotent ALTER, like the shots
        // uuid column above.
        let has_resolved_warnings_uuid_column: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('resolved_warnings') WHERE name='shot_uuid'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_resolved_warnings_uuid_column {
            self.conn
                .execute("ALTER TABLE resolved_warnings ADD COLUMN shot_uuid TEXT", [])?;
            // Backfill the UUID for existing rows so suppressions survive the
            // migration. The legacy key stored `shot_id`, which on load is
            // `section_id * FEATURE_ID_STRIDE + sequence_order` (stride =
            // 100_000), so we can recover each shot's row and copy its UUID.
            // Rows whose shot has no UUID (pre-v6 .stalx) stay NULL and keep
            // matching by the legacy position.
            self.conn.execute(
                "UPDATE resolved_warnings \
                 SET shot_uuid = ( \
                     SELECT s.uuid FROM shots s \
                     WHERE s.section_id = resolved_warnings.section_id \
                       AND s.sequence_order = resolved_warnings.shot_id - resolved_warnings.section_id * 100000 \
                 ) \
                 WHERE shot_uuid IS NULL",
                [],
            )?;
            tracing::info!("Added shot_uuid column to resolved_warnings table (schema v8)");
        }

        tracing::debug!("Schema migration complete");
        Ok(())
    }

    /// Rename `is_virtual` column to `is_reference` in shots table, and
    /// rename the `showVirtualShots` display-settings key to `showReferenceShots`
    /// (schema v3→v4).
    fn migrate_is_virtual_to_is_reference(conn: &Connection) -> Result<()> {
        tracing::info!("Renaming is_virtual → is_reference in shots table (v3→v4)");
        // Only rename the column if it still has the old name (earlier migrations
        // may have already created the table with `is_reference` directly).
        let needs_rename = conn
            .prepare("SELECT is_virtual FROM shots LIMIT 0")
            .is_ok();
        if needs_rename {
            conn.execute_batch(
                "ALTER TABLE shots RENAME COLUMN is_virtual TO is_reference;"
            )?;
        }
        // Always update display_settings key (idempotent UPDATE).
        conn.execute_batch(
            "UPDATE display_settings SET key = 'showReferenceShots' WHERE key = 'showVirtualShots';"
        )?;
        Ok(())
    }

    /// Migrate undo/redo tables from TEXT to BLOB columns (schema v2→v3).
    /// Existing TEXT data is CAST to BLOB; on read, `decompress_json` detects
    /// whether content is gzip-compressed or plain UTF-8, so old entries remain
    /// readable without re-encoding.
    fn migrate_undo_redo_to_blob(&self) -> Result<()> {
        tracing::info!("Migrating undo/redo tables to BLOB columns (v2→v3)");

        self.conn.execute("PRAGMA foreign_keys = OFF;", [])?;
        let tx = self.conn.unchecked_transaction()?;

        for table in &["undo_stack", "redo_stack"] {
            let has_table: bool = tx
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !has_table {
                continue;
            }

            // Check if command_json is already BLOB (idempotency)
            let col_type: String = tx
                .query_row(
                    &format!(
                        "SELECT type FROM pragma_table_info('{table}') WHERE name='command_json'"
                    ),
                    [],
                    |row| row.get(0),
                )
                .unwrap_or_default();

            if col_type.eq_ignore_ascii_case("BLOB") {
                tracing::debug!("{table} already has BLOB columns, skipping");
                continue;
            }

            let new_table = format!("{table}_new");
            tx.execute_batch(&format!(
                r"
                CREATE TABLE {new_table} (
                    id INTEGER PRIMARY KEY,
                    sequence INTEGER NOT NULL,
                    command_json BLOB NOT NULL,
                    undo_data_json BLOB NOT NULL,
                    executed_at TEXT NOT NULL
                );
                INSERT INTO {new_table} SELECT id, sequence, CAST(command_json AS BLOB), CAST(undo_data_json AS BLOB), executed_at FROM {table};
                DROP TABLE {table};
                ALTER TABLE {new_table} RENAME TO {table};
                "
            ))?;
            tracing::info!("Migrated {table} to BLOB columns");
        }

        tx.commit()?;
        self.enable_foreign_keys()?;
        Ok(())
    }

    /// Drop persisted undo/redo stacks written by pre-v7 builds (schema v6→v7).
    ///
    /// Pre-v7 builds serialized every untouched nullable `ShotUpdates` field as
    /// an explicit `"left": null, "pitch_in": null, ...` inside the persisted
    /// `command_json` / `undo_data_json` payloads. Under the v7 `double_option`
    /// semantics an explicit `null` means "clear the field", so replaying such
    /// an entry would silently wipe pitch/LRUD/comment/marker/temperature on
    /// the target shot — an upgrade-path data loss. The legacy JSON is
    /// ambiguous (null = "untouched" and "restore-to-empty" look identical),
    /// so the only safe option is to drop the persisted stacks: they are
    /// best-effort history (capped at ~20 entries), and losing them once at
    /// upgrade is acceptable.
    fn drop_legacy_undo_history(&self) -> Result<()> {
        for table in ["undo_stack", "redo_stack"] {
            if !self.table_exists(table)? {
                continue;
            }
            let removed = self
                .conn
                .execute(&format!("DELETE FROM {table}"), [])?;
            if removed > 0 {
                tracing::info!(
                    table,
                    removed,
                    purpose = "prevent legacy undo entries from clearing shot fields",
                    "Dropped pre-v7 persisted undo history (explicit-null payloads are unsafe to replay)"
                );
            }
        }
        Ok(())
    }

    /// Enable foreign key enforcement on this connection.
    fn enable_foreign_keys(&self) -> Result<()> {
        self.conn.execute("PRAGMA foreign_keys = ON;", [])?;
        Ok(())
    }

    /// Check if a table exists in the database.
    fn table_exists(&self, name: &str) -> Result<bool> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            params![name],
            |row| row.get(0),
        )?;
        Ok(exists > 0)
    }

    /// Read schema_version from the project table, if present.
    fn get_project_schema_version(&self) -> Result<Option<i32>> {
        if !self.table_exists("project")? {
            return Ok(None);
        }

        let has_column: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('project') WHERE name='schema_version'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        if !has_column {
            return Ok(None);
        }

        let version: i32 = self
            .conn
            .query_row("SELECT schema_version FROM project LIMIT 1", [], |row| row.get(0))?;
        Ok(Some(version))
    }

    /// Run PRAGMA quick_check to detect database corruption.
    /// This is a fast subset of integrity_check that skips index verification.
    /// Called automatically on project open per SPEC 14.4.
    fn validate_integrity(&self) -> Result<()> {
        tracing::debug!("Running PRAGMA quick_check");
        let result: String = self
            .conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if result != "ok" {
            tracing::error!(result = %result, "Database integrity check failed");
            anyhow::bail!("Database integrity check failed: {result}");
        }
        tracing::debug!("PRAGMA quick_check passed");
        Ok(())
    }

    /// Run full PRAGMA integrity_check for on-demand deep validation.
    /// This is slower than quick_check but also verifies index consistency.
    /// Returns a list of error messages, or empty vec if database is healthy.
    pub fn full_integrity_check(&self) -> Result<Vec<String>> {
        tracing::info!("Running PRAGMA integrity_check (full)");
        let mut stmt = self.conn.prepare("PRAGMA integrity_check")?;
        let mut rows = stmt.query([])?;
        let mut errors = Vec::new();

        while let Some(row) = rows.next()? {
            let msg: String = row.get(0)?;
            if msg != "ok" {
                errors.push(msg);
            }
        }

        if errors.is_empty() {
            tracing::info!("Full integrity check passed");
        } else {
            tracing::error!(error_count = errors.len(), "Full integrity check found errors");
        }

        Ok(errors)
    }

    /// Verify there are no foreign key violations.
    fn validate_foreign_keys(&self) -> Result<()> {
        let mut stmt = self.conn.prepare("PRAGMA foreign_key_check")?;
        let mut rows = stmt.query([])?;
        let mut count = 0usize;
        let mut samples = Vec::new();

        while let Some(row) = rows.next()? {
            count += 1;
            if samples.len() < 3 {
                let table: String = row.get(0)?;
                let rowid: i64 = row.get(1)?;
                let parent: String = row.get(2)?;
                let fkid: i64 = row.get(3)?;
                samples.push(format!("{table} rowid={rowid} parent={parent} fkid={fkid}"));
            }
        }

        if count > 0 {
            anyhow::bail!(
                "Foreign key violations detected ({}). Sample: {}",
                count,
                samples.join("; ")
            );
        }

        Ok(())
    }

    /// Rebuild key tables with foreign key constraints.
    fn rebuild_tables_with_foreign_keys(&mut self) -> Result<()> {
        tracing::info!("Rebuilding tables with foreign key constraints (schema v2)");

        let has_sections = self.table_exists("sections")?;
        if !has_sections {
            anyhow::bail!("Missing sections table during FK migration");
        }

        let has_shots = self.table_exists("shots")?;
        let has_station_merges = self.table_exists("station_merges")?;
        let has_zero_datums = self.table_exists("zero_datums")?;
        let has_section_offsets = self.table_exists("section_offsets")?;
        let has_station_offsets = self.table_exists("station_offsets")?;
        let has_loop_closures = self.table_exists("loop_closures")?;
        let has_resolved_warnings = self.table_exists("resolved_warnings")?;

        self.conn.execute("PRAGMA foreign_keys = OFF;", [])?;
        let tx = self.conn.transaction()?;

        // Rename old tables
        tx.execute("ALTER TABLE sections RENAME TO sections_old", [])?;
        if has_shots {
            tx.execute("ALTER TABLE shots RENAME TO shots_old", [])?;
        }
        if has_station_merges {
            tx.execute("ALTER TABLE station_merges RENAME TO station_merges_old", [])?;
        }
        if has_zero_datums {
            tx.execute("ALTER TABLE zero_datums RENAME TO zero_datums_old", [])?;
        }
        if has_section_offsets {
            tx.execute("ALTER TABLE section_offsets RENAME TO section_offsets_old", [])?;
        }
        if has_station_offsets {
            tx.execute("ALTER TABLE station_offsets RENAME TO station_offsets_old", [])?;
        }
        if has_loop_closures {
            tx.execute("ALTER TABLE loop_closures RENAME TO loop_closures_old", [])?;
        }
        if has_resolved_warnings {
            tx.execute("ALTER TABLE resolved_warnings RENAME TO resolved_warnings_old", [])?;
        }

        // Recreate tables with FK constraints
        tx.execute_batch(
            r"
            CREATE TABLE sections (
                id INTEGER PRIMARY KEY,
                name TEXT,
                surveyor TEXT,
                date TEXT,
                color TEXT NOT NULL,
                direction TEXT NOT NULL DEFAULT 'in',
                quality REAL NOT NULL DEFAULT 1.0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE shots (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL,
                sequence_order INTEGER NOT NULL,
                azimuth_in REAL NOT NULL,
                azimuth_out REAL NOT NULL,
                length REAL NOT NULL,
                depth_in REAL NOT NULL,
                depth_out REAL NOT NULL,
                pitch_in REAL,
                pitch_out REAL,
                left_distance REAL,
                right_distance REAL,
                up_distance REAL,
                down_distance REAL,
                comment TEXT,
                is_reference INTEGER NOT NULL DEFAULT 0,
                marker_index INTEGER,
                temperature REAL,
                uuid TEXT,
                UNIQUE(section_id, sequence_order),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            CREATE TABLE station_merges (
                id INTEGER PRIMARY KEY,
                station_a_section INTEGER NOT NULL,
                station_a_index INTEGER NOT NULL,
                station_b_section INTEGER NOT NULL,
                station_b_index INTEGER NOT NULL,
                merged_at TEXT NOT NULL,
                FOREIGN KEY (station_a_section) REFERENCES sections(id) ON DELETE CASCADE,
                FOREIGN KEY (station_b_section) REFERENCES sections(id) ON DELETE CASCADE
            );

            CREATE TABLE zero_datums (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                depth_reference REAL NOT NULL,
                UNIQUE(section_id, station_index),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            CREATE TABLE section_offsets (
                section_id INTEGER PRIMARY KEY,
                offset_x REAL NOT NULL,
                offset_y REAL NOT NULL,
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            CREATE TABLE station_offsets (
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                offset_x REAL NOT NULL,
                offset_y REAL NOT NULL,
                offset_z REAL NOT NULL,
                PRIMARY KEY (section_id, station_index),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            CREATE TABLE loop_closures (
                id INTEGER PRIMARY KEY,
                station_a_section INTEGER NOT NULL,
                station_a_index INTEGER NOT NULL,
                station_b_section INTEGER NOT NULL,
                station_b_index INTEGER NOT NULL,
                path_length REAL NOT NULL,
                misclosure_distance REAL NOT NULL,
                error_percentage REAL NOT NULL,
                horizontal_misclosure REAL NOT NULL,
                vertical_misclosure REAL NOT NULL,
                closure_id INTEGER NOT NULL DEFAULT 0,
                strategy TEXT NOT NULL DEFAULT 'Batch',
                is_aligned INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (station_a_section) REFERENCES sections(id) ON DELETE CASCADE,
                FOREIGN KEY (station_b_section) REFERENCES sections(id) ON DELETE CASCADE
            );

            CREATE TABLE resolved_warnings (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL,
                shot_id INTEGER NOT NULL,
                warning_code TEXT NOT NULL,
                resolved_at TEXT NOT NULL,
                resolved_comment TEXT,
                shot_uuid TEXT,
                UNIQUE(section_id, shot_id, warning_code),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );
            ",
        )?;

        // Copy data
        tx.execute(
            "INSERT INTO sections (id, name, surveyor, date, color, direction, quality, created_at)
             SELECT id, name, surveyor, date, color, direction, quality, created_at FROM sections_old",
            [],
        )?;

        if has_shots {
            // The old table may have `is_virtual` (pre-v4) or `is_reference` (v4+).
            // Use COALESCE to handle either column name gracefully.
            let old_has_is_reference = tx
                .prepare("SELECT is_reference FROM shots_old LIMIT 0")
                .is_ok();
            let virtual_col = if old_has_is_reference {
                "is_reference"
            } else {
                "is_virtual"
            };
            tx.execute(
                &format!(
                    "INSERT INTO shots (
                        id, section_id, sequence_order,
                        azimuth_in, azimuth_out, length, depth_in, depth_out,
                        pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                        comment, is_reference, marker_index, temperature
                    )
                    SELECT
                        id, section_id, sequence_order,
                        azimuth_in, azimuth_out, length, depth_in, depth_out,
                        pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                        comment, {virtual_col}, marker_index, temperature
                    FROM shots_old"
                ),
                [],
            )?;
        }

        if has_station_merges {
            tx.execute(
                "INSERT INTO station_merges (id, station_a_section, station_a_index, station_b_section, station_b_index, merged_at)
                 SELECT id, station_a_section, station_a_index, station_b_section, station_b_index, merged_at
                 FROM station_merges_old",
                [],
            )?;
        }

        if has_zero_datums {
            tx.execute(
                "INSERT INTO zero_datums (id, section_id, station_index, latitude, longitude, depth_reference)
                 SELECT id, section_id, station_index, latitude, longitude, depth_reference
                 FROM zero_datums_old",
                [],
            )?;
        }

        if has_section_offsets {
            tx.execute(
                "INSERT INTO section_offsets (section_id, offset_x, offset_y)
                 SELECT section_id, offset_x, offset_y FROM section_offsets_old",
                [],
            )?;
        }

        if has_station_offsets {
            tx.execute(
                "INSERT INTO station_offsets (section_id, station_index, offset_x, offset_y, offset_z)
                 SELECT section_id, station_index, offset_x, offset_y, offset_z FROM station_offsets_old",
                [],
            )?;
        }

        if has_loop_closures {
            tx.execute(
                "INSERT INTO loop_closures (
                    id, station_a_section, station_a_index, station_b_section, station_b_index,
                    path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure,
                    closure_id, strategy
                )
                SELECT
                    id, station_a_section, station_a_index, station_b_section, station_b_index,
                    path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure,
                    closure_id, strategy
                FROM loop_closures_old",
                [],
            )?;
        }

        if has_resolved_warnings {
            tx.execute(
                "INSERT INTO resolved_warnings (id, section_id, shot_id, warning_code, resolved_at, resolved_comment)
                 SELECT id, section_id, shot_id, warning_code, resolved_at, resolved_comment
                 FROM resolved_warnings_old",
                [],
            )?;
        }

        // Drop old tables
        tx.execute("DROP TABLE sections_old", [])?;
        if has_shots {
            tx.execute("DROP TABLE shots_old", [])?;
        }
        if has_station_merges {
            tx.execute("DROP TABLE station_merges_old", [])?;
        }
        if has_zero_datums {
            tx.execute("DROP TABLE zero_datums_old", [])?;
        }
        if has_section_offsets {
            tx.execute("DROP TABLE section_offsets_old", [])?;
        }
        if has_station_offsets {
            tx.execute("DROP TABLE station_offsets_old", [])?;
        }
        if has_loop_closures {
            tx.execute("DROP TABLE loop_closures_old", [])?;
        }
        if has_resolved_warnings {
            tx.execute("DROP TABLE resolved_warnings_old", [])?;
        }

        // Recreate indexes
        tx.execute("CREATE INDEX IF NOT EXISTS idx_shots_section ON shots(section_id)", [])?;

        tx.commit()?;
        self.enable_foreign_keys()?;
        Ok(())
    }

    /// Read the current schema version from PRAGMA user_version.
    fn get_user_version(&self) -> Result<i32> {
        let version: i32 = self.conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok(version)
    }

    /// Persist the schema version to PRAGMA user_version.
    fn set_user_version(&self, version: i32) -> Result<()> {
        self.conn.execute(&format!("PRAGMA user_version = {version}"), [])?;
        Ok(())
    }

    /// Ensure schema migrations are applied and user_version is current.
    fn ensure_schema_version(&mut self) -> Result<()> {
        let mut current = self.get_user_version().unwrap_or(0);
        if current == 0 {
            if let Ok(Some(project_version)) = self.get_project_schema_version() {
                current = project_version;
            }
        }
        if current > SCHEMA_VERSION {
            tracing::warn!(
                current = current,
                expected = SCHEMA_VERSION,
                "Database schema version is newer than this app"
            );
            return Ok(());
        }

        // Fast path: already current.  migrate_schema() scans pragma
        // table_info() for every conditional column add on every open,
        // which previously cost ~10 ms per project load even when no
        // migration was needed.
        if current == SCHEMA_VERSION {
            return Ok(());
        }

        self.migrate_schema()?;
        if current < 2 {
            self.rebuild_tables_with_foreign_keys()?;
        }
        if current < 3 {
            self.migrate_undo_redo_to_blob()?;
        }
        if current < 4 {
            Self::migrate_is_virtual_to_is_reference(&self.conn)?;
        }
        if current < UNDO_FORMAT_SAFE_VERSION {
            self.drop_legacy_undo_history()?;
        }
        self.set_user_version(SCHEMA_VERSION)?;
        // Keep project-level schema_version in sync with PRAGMA user_version.
        let _ = self.conn.execute(
            "UPDATE project SET schema_version = ?1",
            params![SCHEMA_VERSION],
        );

        Ok(())
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
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM project",
            [],
            |row| row.get(0),
        )?;

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

    /// Initialize the database schema
    fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r"
            -- Project metadata
            CREATE TABLE IF NOT EXISTS project (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                location TEXT,
                created_at TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                next_closure_id INTEGER NOT NULL DEFAULT 1
            );

            -- Sections
            CREATE TABLE IF NOT EXISTS sections (
                id INTEGER PRIMARY KEY,
                name TEXT,
                surveyor TEXT,
                date TEXT,
                color TEXT NOT NULL,
                direction TEXT NOT NULL DEFAULT 'in',
                quality REAL NOT NULL DEFAULT 1.0,
                created_at TEXT NOT NULL
            );

            -- Shots
            CREATE TABLE IF NOT EXISTS shots (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL,
                sequence_order INTEGER NOT NULL,
                azimuth_in REAL NOT NULL,
                azimuth_out REAL NOT NULL,
                length REAL NOT NULL,
                depth_in REAL NOT NULL,
                depth_out REAL NOT NULL,
                pitch_in REAL,
                pitch_out REAL,
                left_distance REAL,
                right_distance REAL,
                up_distance REAL,
                down_distance REAL,
                comment TEXT,
                is_reference INTEGER NOT NULL DEFAULT 0,
                marker_index INTEGER,
                temperature REAL,
                uuid TEXT,
                UNIQUE(section_id, sequence_order),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            -- Station merges
            CREATE TABLE IF NOT EXISTS station_merges (
                id INTEGER PRIMARY KEY,
                station_a_section INTEGER NOT NULL,
                station_a_index INTEGER NOT NULL,
                station_b_section INTEGER NOT NULL,
                station_b_index INTEGER NOT NULL,
                merged_at TEXT NOT NULL,
                FOREIGN KEY (station_a_section) REFERENCES sections(id) ON DELETE CASCADE,
                FOREIGN KEY (station_b_section) REFERENCES sections(id) ON DELETE CASCADE
            );

            -- Zero datums
            CREATE TABLE IF NOT EXISTS zero_datums (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                depth_reference REAL NOT NULL,
                UNIQUE(section_id, station_index),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            -- Section offsets (for aligning merged sections)
            CREATE TABLE IF NOT EXISTS section_offsets (
                section_id INTEGER PRIMARY KEY,
                offset_x REAL NOT NULL,
                offset_y REAL NOT NULL,
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            -- Station offsets (for individually moved stations)
            CREATE TABLE IF NOT EXISTS station_offsets (
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                offset_x REAL NOT NULL,
                offset_y REAL NOT NULL,
                offset_z REAL NOT NULL,
                PRIMARY KEY (section_id, station_index),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            -- Station comments
            CREATE TABLE IF NOT EXISTS station_comments (
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                comment TEXT NOT NULL,
                PRIMARY KEY (section_id, station_index),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            -- Collaboration mode state (single-row JSON blob; schema v5)
            CREATE TABLE IF NOT EXISTS collab_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state_json TEXT NOT NULL
            );

            -- Undo/redo stack (BLOB columns hold gzip-compressed JSON)
            CREATE TABLE IF NOT EXISTS undo_stack (
                id INTEGER PRIMARY KEY,
                sequence INTEGER NOT NULL,
                command_json BLOB NOT NULL,
                undo_data_json BLOB NOT NULL,
                executed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS redo_stack (
                id INTEGER PRIMARY KEY,
                sequence INTEGER NOT NULL,
                command_json BLOB NOT NULL,
                undo_data_json BLOB NOT NULL,
                executed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS loop_closures (
                id INTEGER PRIMARY KEY,
                station_a_section INTEGER NOT NULL,
                station_a_index INTEGER NOT NULL,
                station_b_section INTEGER NOT NULL,
                station_b_index INTEGER NOT NULL,
                path_length REAL NOT NULL,
                misclosure_distance REAL NOT NULL,
                error_percentage REAL NOT NULL,
                horizontal_misclosure REAL NOT NULL,
                vertical_misclosure REAL NOT NULL,
                closure_id INTEGER NOT NULL DEFAULT 0,
                strategy TEXT NOT NULL DEFAULT 'Batch',
                is_aligned INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (station_a_section) REFERENCES sections(id) ON DELETE CASCADE,
                FOREIGN KEY (station_b_section) REFERENCES sections(id) ON DELETE CASCADE
            );

            -- Display settings
            CREATE TABLE IF NOT EXISTS display_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Resolved warnings (user acknowledged)
            CREATE TABLE IF NOT EXISTS resolved_warnings (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL,
                shot_id INTEGER NOT NULL,
                warning_code TEXT NOT NULL,
                resolved_at TEXT NOT NULL,
                resolved_comment TEXT,
                shot_uuid TEXT,
                UNIQUE(section_id, shot_id, warning_code),
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            );

            -- Imported file hashes (for duplicate detection)
            CREATE TABLE IF NOT EXISTS imported_file_hashes (
                id INTEGER PRIMARY KEY,
                hash TEXT NOT NULL UNIQUE
            );

            -- Imported section hashes (section-level duplicate detection)
            CREATE TABLE IF NOT EXISTS imported_section_hashes (
                id INTEGER PRIMARY KEY,
                hash TEXT NOT NULL UNIQUE
            );

            -- Indexes
            CREATE INDEX IF NOT EXISTS idx_shots_section ON shots(section_id);
            CREATE INDEX IF NOT EXISTS idx_undo_sequence ON undo_stack(sequence);
            ",
        )?;

        Ok(())
    }

    /// Save a project to the database
    pub fn save_project(&mut self, project: &Project) -> Result<()> {
        tracing::debug!("Saving project: name={}, sections={}", project.name, project.sections.len());

        let tx = match self.conn.transaction() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!("Failed to start transaction: {}", e);
                return Err(e.into());
            }
        };

        // Clear existing data (delete children before parents for foreign key compliance)
        tx.execute_batch(
            r"
            DELETE FROM shots;
            DELETE FROM sections;
            DELETE FROM station_merges;
            DELETE FROM zero_datums;
            DELETE FROM section_offsets;
            DELETE FROM station_offsets;
            DELETE FROM station_comments;
            DELETE FROM loop_closures;
            DELETE FROM imported_file_hashes;
            DELETE FROM imported_section_hashes;
            DELETE FROM collab_state;
            DELETE FROM project;
            ",
        )?;

        // Save project metadata (including next_closure_id for monotonic ID persistence)
        let next_closure_id_i64 = i64::try_from(project.next_closure_id)
            .map_err(|_| anyhow::anyhow!("next_closure_id {} exceeds i64 range", project.next_closure_id))?;
        tx.execute(
            "INSERT INTO project (id, name, location, created_at, modified_at, schema_version, next_closure_id) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                project.name,
                project.location,
                project.created_at.to_rfc3339(),
                project.modified_at.to_rfc3339(),
                SCHEMA_VERSION,
                next_closure_id_i64
            ],
        )?;

        // Save sections and shots
        for section in &project.sections {
            tx.execute(
                "INSERT INTO sections (id, name, surveyor, date, color, direction, quality, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    section.id,
                    section.name,
                    section.surveyor,
                    section.date.map(|d| d.to_string()),
                    section.color,
                    section.direction.to_string(),
                    section.quality,
                    Utc::now().to_rfc3339()
                ],
            )?;

            for (seq, shot) in section.shots.iter().enumerate() {
                // Note: We don't store shot.id - it's regenerated on load based on sequence_order
                // The database uses auto-increment for the id column.
                // `shot.uuid` IS persisted — it's the only stable identity
                // a shot has across save/load and the basis for the
                // collaboration round-trip with Ariane.  Mint one lazily
                // here for any shot that arrived without (e.g. loaded
                // from a pre-v6 .stalx) so we never write NULL twice.
                let uuid = shot
                    .uuid
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                tx.execute(
                    r"INSERT INTO shots (
                        section_id, sequence_order,
                        azimuth_in, azimuth_out, length, depth_in, depth_out,
                        pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                        comment, is_reference, marker_index, temperature, uuid
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                    params![
                        section.id,
                        seq as i64,
                        shot.azimuth_in,
                        shot.azimuth_out,
                        shot.length,
                        shot.depth_in,
                        shot.depth_out,
                        shot.pitch_in,
                        shot.pitch_out,
                        shot.left,
                        shot.right,
                        shot.up,
                        shot.down,
                        shot.comment,
                        i32::from(shot.is_reference),
                        shot.marker_index,
                        shot.temperature,
                        uuid,
                    ],
                )?;
            }
        }

        // Save station merges. Cross-references are stored as stable
        // `StationKey` anchors in memory but persisted positionally (resolved
        // against the current shots) — the on-disk format stays positional, like
        // the binary IPC wire; load reconstructs anchors and re-anchors them.
        // A dangling endpoint is SKIPPED, never collapsed to (section, 0): the
        // app-layer save gate already blocks this, but the persistence layer must
        // not crash (PK collision) or write a phantom for any path that reaches
        // it directly (collab sibling write, salvage).
        for merge in &project.station_merges {
            let (Some(a), Some(b)) = (
                project.resolve_key(&merge.station_a),
                project.resolve_key(&merge.station_b),
            ) else {
                tracing::warn!(
                    purpose = "skip dangling merge on save",
                    "Dropping a station merge whose endpoint no longer resolves"
                );
                continue;
            };
            tx.execute(
                "INSERT INTO station_merges (station_a_section, station_a_index, station_b_section, station_b_index, merged_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    a.section_id,
                    a.station_index,
                    b.section_id,
                    b.station_index,
                    merge.merged_at.to_rfc3339()
                ],
            )?;
        }

        // Save zero datums
        for zd in &project.zero_datums {
            let Some(sr) = project.resolve_key(&zd.station_ref) else {
                tracing::warn!(
                    purpose = "skip dangling zero datum on save",
                    "Dropping a zero datum whose station no longer resolves"
                );
                continue;
            };
            tx.execute(
                "INSERT INTO zero_datums (section_id, station_index, latitude, longitude, depth_reference) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    sr.section_id,
                    sr.station_index,
                    zd.gps.latitude,
                    zd.gps.longitude,
                    zd.gps.depth_reference
                ],
            )?;
        }

        // Save section offsets
        for (section_id, (offset_x, offset_y)) in &project.section_offsets {
            tx.execute(
                "INSERT INTO section_offsets (section_id, offset_x, offset_y) VALUES (?1, ?2, ?3)",
                params![section_id, offset_x, offset_y],
            )?;
        }

        // Save station offsets
        for (key, (offset_x, offset_y, offset_z)) in &project.station_offsets {
            let Some(sr) = project.resolve_key(key) else {
                tracing::warn!(
                    purpose = "skip orphan station offset on save",
                    "Dropping a station offset whose station no longer resolves"
                );
                continue;
            };
            tx.execute(
                "INSERT INTO station_offsets (section_id, station_index, offset_x, offset_y, offset_z) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![sr.section_id, sr.station_index, offset_x, offset_y, offset_z],
            )?;
        }

        // Save station comments
        for (key, comment) in &project.station_comments {
            let Some(sr) = project.resolve_key(key) else {
                tracing::warn!(
                    purpose = "skip orphan station comment on save",
                    "Dropping a station comment whose station no longer resolves"
                );
                continue;
            };
            tx.execute(
                "INSERT INTO station_comments (section_id, station_index, comment) VALUES (?1, ?2, ?3)",
                params![sr.section_id, sr.station_index, comment],
            )?;
        }

        // Save collaboration state (single-row JSON blob)
        if let Some(collab) = &project.collab {
            let json = serde_json::to_string(collab)
                .context("Failed to serialize collab state")?;
            tx.execute(
                "INSERT INTO collab_state (id, state_json) VALUES (1, ?1)",
                params![json],
            )?;
        }

        // Save loop closures (with closure_id column)
        // Ensure closure_id column exists
        let has_closure_id: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='closure_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_closure_id {
            tx.execute(
                "ALTER TABLE loop_closures ADD COLUMN closure_id INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }

        // Ensure strategy column exists
        let has_strategy: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='strategy'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_strategy {
            tx.execute(
                "ALTER TABLE loop_closures ADD COLUMN strategy TEXT NOT NULL DEFAULT 'Batch'",
                [],
            )?;
        }

        // Ensure is_aligned column exists
        let has_is_aligned: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='is_aligned'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_is_aligned {
            tx.execute(
                "ALTER TABLE loop_closures ADD COLUMN is_aligned INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }

        for lc in &project.loop_closures {
            let closure_id_i64 = i64::try_from(lc.id)
                .map_err(|_| anyhow::anyhow!("Closure ID {} exceeds i64 range", lc.id))?;
            let (Some(a), Some(b)) = (
                project.resolve_key(&lc.station_a),
                project.resolve_key(&lc.station_b),
            ) else {
                tracing::warn!(
                    purpose = "skip dangling loop closure on save",
                    "Dropping a loop closure whose endpoint no longer resolves"
                );
                continue;
            };
            tx.execute(
                "INSERT INTO loop_closures (station_a_section, station_a_index, station_b_section, station_b_index, path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure, closure_id, strategy, is_aligned) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    a.section_id,
                    a.station_index,
                    b.section_id,
                    b.station_index,
                    lc.path_length,
                    lc.misclosure_distance,
                    lc.error_percentage,
                    lc.horizontal_misclosure,
                    lc.vertical_misclosure,
                    closure_id_i64,
                    lc.strategy.as_str(),
                    i32::from(lc.is_aligned)
                ],
            )?;
        }

        // Save imported file hashes
        for hash in &project.imported_file_hashes {
            tx.execute(
                "INSERT INTO imported_file_hashes (hash) VALUES (?1)",
                params![hash],
            )?;
        }

        // Save imported section hashes
        for hash in &project.imported_section_hashes {
            tx.execute(
                "INSERT INTO imported_section_hashes (hash) VALUES (?1)",
                params![hash],
            )?;
        }

        tx.commit()?;
        tracing::debug!("Transaction committed");

        // Verify the data was written
        let verify_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM project",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        tracing::debug!("Save verification: project table has {} rows", verify_count);

        Ok(())
    }

    /// Load a project from the database
    /// Load only the metadata needed to populate `ProjectMetadata` — no
    /// per-shot deserialization. Uses SQL COUNT/SUM aggregates and a
    /// single small read of `zero_datums` for GPS info. This replaces the
    /// "load entire project just to drop everything but metadata" path
    /// used by `list_recent_projects`, which was responsible for the
    /// multi-second freeze when returning to the global view with a
    /// large project in the recent list.
    pub fn load_metadata(&self, file_path: std::path::PathBuf) -> Result<crate::models::ProjectMetadata> {
        use crate::models::{GpsBounds, GpsCoordinates, Project, ProjectMetadata};
        use std::cmp::Ordering;
        use std::time::Instant;
        let start = Instant::now();

        // Tiny project header read.
        let (name, location, modified_at_raw): (String, Option<String>, String) =
            self.conn.query_row(
                "SELECT name, location, modified_at FROM project LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).context("Failed to read project metadata header")?;
        let t_header = start.elapsed();

        let modified_at = chrono::DateTime::parse_from_rfc3339(&modified_at_raw)
            .context("Failed to parse modified_at")?
            .with_timezone(&Utc);

        // Aggregate-only queries.
        let section_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM sections", [], |row| row.get(0))
            .unwrap_or(0);
        let t_sections = start.elapsed();
        let shot_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM shots", [], |row| row.get(0))
            .unwrap_or(0);
        let t_shot_count = start.elapsed();
        // COALESCE so an empty shots table returns 0.0 instead of NULL.
        let total_length: f64 = self
            .conn
            .query_row("SELECT COALESCE(SUM(length), 0.0) FROM shots", [], |row| row.get(0))
            .unwrap_or(0.0);
        let t_sum_length = start.elapsed();

        // GPS info: zero_datums is small (typically 1-10 rows) so we read
        // it in full and reuse the existing dateline-aware bounds logic.
        let mut zero_datums: Vec<GpsCoordinates> = Vec::new();
        if let Ok(mut stmt) = self
            .conn
            .prepare("SELECT latitude, longitude, depth_reference FROM zero_datums")
        {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            }) {
                for r in rows.flatten() {
                    // Skip rows that don't validate (matches load_project behavior).
                    if let Ok(gps) = GpsCoordinates::new(r.0, r.1, r.2) {
                        zero_datums.push(gps);
                    }
                }
            }
        }

        let (gps_center, gps_bounds) = if zero_datums.is_empty() {
            (None, None)
        } else {
            let first = &zero_datums[0];
            let center = Some((first.longitude, first.latitude));

            let mut south = f64::INFINITY;
            let mut north = f64::NEG_INFINITY;
            let mut longitudes = Vec::with_capacity(zero_datums.len());
            for gps in &zero_datums {
                south = south.min(gps.latitude);
                north = north.max(gps.latitude);
                longitudes.push(gps.longitude);
            }
            let (west, east) = Project::compute_longitude_bounds(&longitudes);
            // Avoid f64 NaN propagation if there was only one (already handled by helper).
            let south = if south.is_finite() { south } else { 0.0 };
            let north = if north.is_finite() { north } else { 0.0 };
            let _ = Ordering::Equal; // silence the import if compute_longitude_bounds is inlined
            (
                center,
                Some(GpsBounds {
                    north,
                    south,
                    east,
                    west,
                }),
            )
        };

        let t_gps = start.elapsed();

        // station_count = shot_count + section_count per Project::stats().
        let station_count = (shot_count as usize) + (section_count as usize);

        // Trace where the time went, in ms, so we can spot which query
        // is the bottleneck. Debug-level — fires for every recent
        // project on every metadata refresh, so default releases skip
        // it.  Enable with `RUST_LOG=stalagmight_lib=debug` when you
        // need to see it.
        tracing::debug!(
            path = ?file_path,
            shots = shot_count,
            header_ms = t_header.as_micros() as f64 / 1000.0,
            sections_ms = (t_sections - t_header).as_micros() as f64 / 1000.0,
            shotcount_ms = (t_shot_count - t_sections).as_micros() as f64 / 1000.0,
            sumlength_ms = (t_sum_length - t_shot_count).as_micros() as f64 / 1000.0,
            gps_ms = (t_gps - t_sum_length).as_micros() as f64 / 1000.0,
            total_ms = t_gps.as_micros() as f64 / 1000.0,
            "load_metadata timings"
        );

        // Fast collab-on check: the recent-projects panel surfaces this
        // without opening the project, so we can't call the full
        // `load_collab_state` here (it deserialises the whole baseline).
        // Just probe the `enabled` flag from the JSON blob.
        let collab_enabled: bool = self
            .conn
            .query_row(
                "SELECT json_extract(state_json, '$.enabled') FROM collab_state WHERE id = 1",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
            .map(|v| v != 0)
            .unwrap_or(false);

        Ok(ProjectMetadata {
            name,
            location,
            file_path,
            modified_at,
            section_count: section_count as usize,
            total_length,
            station_count,
            gps_center,
            gps_bounds,
            collab_enabled,
        })
    }

    pub fn load_project(&self) -> Result<Project> {
        tracing::debug!("Loading project from database");

        // First check if project table has data and log what's there
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM project",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        tracing::debug!("Project table row count: {}", count);

        if count == 0 {
            anyhow::bail!("Project table is empty - file may be corrupted");
        }

        // Load project metadata - get the first row (don't require id = 1)
        // Read next_closure_id if the column exists (added for monotonic ID persistence)
        let has_next_closure_id_col: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('project') WHERE name='next_closure_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        let (name, location, created_at, modified_at, persisted_next_closure_id): (String, Option<String>, String, String, Option<u64>) =
            if has_next_closure_id_col {
                self.conn.query_row(
                    "SELECT name, location, created_at, modified_at, next_closure_id FROM project LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, Some(row.get::<_, i64>(4).unwrap_or(1).max(1) as u64))),
                ).context("Failed to read project metadata")?
            } else {
                let (n, l, c, m) = self.conn.query_row(
                    "SELECT name, location, created_at, modified_at FROM project LIMIT 1",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
                ).context("Failed to read project metadata")?;
                (n, l, c, m, None)
            };

        let created_at = chrono::DateTime::parse_from_rfc3339(&created_at)?.with_timezone(&Utc);
        let modified_at = chrono::DateTime::parse_from_rfc3339(&modified_at)?.with_timezone(&Utc);

        // Load sections
        let mut sections: Vec<Section> = Vec::new();
        let mut next_section_id = 0u32;

        {
            let has_quality_column: bool = self.conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('sections') WHERE name='quality'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            let mut stmt = if has_quality_column {
                self.conn.prepare(
                    "SELECT id, name, surveyor, date, color, direction, quality FROM sections ORDER BY id",
                )?
            } else {
                self.conn.prepare(
                    "SELECT id, name, surveyor, date, color, direction FROM sections ORDER BY id",
                )?
            };

            let mut section_rows = Vec::new();
            if has_quality_column {
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, f64>(6)?,
                    ))
                })?;
                for row in rows {
                    section_rows.push(row?);
                }
            } else {
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        1.0,
                    ))
                })?;
                for row in rows {
                    section_rows.push(row?);
                }
            }

            // Build the empty sections first so we can address them by
            // ID when partitioning the bulk shot stream below.
            let mut section_by_id: HashMap<u32, usize> = HashMap::with_capacity(section_rows.len());
            for section_row in section_rows {
                let (id, name, surveyor, date_str, color, direction_str, quality_raw) = section_row;
                let date = date_str.and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok());
                let direction = direction_str
                    .and_then(|s| s.parse::<SurveyDirection>().ok())
                    .unwrap_or_default();
                let quality = if quality_raw.is_finite() && quality_raw > 0.0 {
                    quality_raw
                } else {
                    1.0
                };

                let section_data = SectionData {
                    name,
                    surveyor,
                    date,
                    color,
                    direction: Some(direction),
                    quality,
                    shots: Vec::new(),
                };

                let section = Section::new(id, section_data);
                section_by_id.insert(id, sections.len());
                next_section_id = next_section_id.max(id + 1);
                sections.push(section);
            }

            // Load ALL shots in one SELECT and partition by section_id.
            // The legacy code prepared a per-section statement inside the
            // loop above, executing 14k+ separate queries on large files;
            // each query had to parse + plan + execute, so cost was
            // dominated by SQLite overhead rather than row I/O.  A single
            // bulk SELECT cuts roughly 350 ms off a 14k-section load and
            // is friendly to the query planner: it can stream rows
            // sequentially without re-preparing.
            {
                let mut shot_stmt = self.conn.prepare(
                    r"SELECT section_id, sequence_order, azimuth_in, azimuth_out, length, depth_in, depth_out,
                              pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                              comment, is_reference, marker_index, temperature, uuid
                       FROM shots ORDER BY section_id, sequence_order",
                )?;
                let shot_rows = shot_stmt.query_map([], |row| {
                    let section_id: u32 = row.get(0)?;
                    let seq: i64 = row.get(1)?;
                    Ok((
                        section_id,
                        Shot {
                            id: section_id * FEATURE_ID_STRIDE + (seq as u32),
                            azimuth_in: row.get(2)?,
                            azimuth_out: row.get(3)?,
                            length: row.get(4)?,
                            depth_in: row.get(5)?,
                            depth_out: row.get(6)?,
                            pitch_in: row.get(7)?,
                            pitch_out: row.get(8)?,
                            left: row.get(9)?,
                            right: row.get(10)?,
                            up: row.get(11)?,
                            down: row.get(12)?,
                            comment: row.get(13)?,
                            is_reference: row.get::<_, i32>(14)? != 0,
                            marker_index: row.get(15)?,
                            temperature: row.get(16)?,
                            // `uuid` column was added in schema v6; pre-v6
                            // rows return NULL here.  Treat NULL and empty
                            // string the same — the next save mints a
                            // fresh UUID and persists it.
                            uuid: row
                                .get::<_, Option<String>>(17)?
                                .filter(|s| !s.is_empty()),
                        },
                    ))
                })?;

                let mut sanitized_shots = 0usize;
                for row in shot_rows {
                    let (section_id, mut shot) = row?;
                    // Neutralize geometry corrupt-on-disk at the load boundary: a
                    // single non-finite (NaN/inf) value would otherwise propagate
                    // through the offset cascade and break the whole survey. The
                    // degenerate-but-finite result is localized and visible. (Our own
                    // save can't write NaN — SQLite coerces it to NULL, which the
                    // NOT NULL columns reject — so this guards inf, hand-edited DBs,
                    // and any future nullable geometry column.)
                    if shot.sanitize_non_finite() {
                        sanitized_shots += 1;
                    }
                    if let Some(&idx) = section_by_id.get(&section_id) {
                        sections[idx].shots.push(shot);
                    }
                    // (rows for unknown sections are silently dropped —
                    // matches the legacy `WHERE section_id = ?` filter
                    // which never returned orphan rows in the first place.)
                }
                if sanitized_shots > 0 {
                    tracing::warn!(
                        sanitized_shots,
                        purpose = "block corruption at the source",
                        "Replaced non-finite (NaN/inf) shot geometry with finite defaults on load"
                    );
                }

                // Advance each section's next_shot_id past its loaded
                // shots so future appends don't collide with persisted IDs.
                for section in sections.iter_mut() {
                    section.next_shot_id =
                        section.id * FEATURE_ID_STRIDE + section.shots.len() as u32;
                }
            }
        }

        // Load station merges
        let mut station_merges: Vec<StationMerge> = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT station_a_section, station_a_index, station_b_section, station_b_index, merged_at FROM station_merges",
            )?;
            let merge_rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?;

            for merge_row in merge_rows {
                let (a_sec, a_idx, b_sec, b_idx, merged_at_str) = merge_row?;
                let merged_at =
                    chrono::DateTime::parse_from_rfc3339(&merged_at_str)?.with_timezone(&Utc);
                // Persisted positionally; load as transitional Index anchors,
                // which `reanchor_station_refs` (run on the load path) canonicalizes
                // to stable shot-UUID anchors once shots are present.
                station_merges.push(StationMerge {
                    station_a: StationKey::positional(a_sec, a_idx),
                    station_b: StationKey::positional(b_sec, b_idx),
                    merged_at,
                });
            }
        }

        // Load zero datums
        let mut zero_datums: Vec<ZeroDatum> = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT section_id, station_index, latitude, longitude, depth_reference FROM zero_datums",
            )?;
            let zd_rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, f64>(4)?,
                ))
            })?;

            for zd_row in zd_rows {
                let (section_id, station_index, lat, lon, depth) = zd_row?;
                zero_datums.push(ZeroDatum {
                    station_ref: StationKey::positional(section_id, station_index),
                    gps: GpsCoordinates {
                        latitude: lat,
                        longitude: lon,
                        depth_reference: depth,
                    },
                });
            }
        }

        // Load section offsets
        let mut section_offsets: HashMap<u32, (f64, f64)> = HashMap::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT section_id, offset_x, offset_y FROM section_offsets",
            )?;
            let offset_rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            })?;

            let mut sanitized_offsets = 0usize;
            for offset_row in offset_rows {
                let (section_id, mut offset_x, mut offset_y) = offset_row?;
                // Sanitize non-finite (NaN/inf) section offsets at the load boundary,
                // mirroring the per-shot sanitize above. section_offsets is the one
                // geometry field with no finite guard, and resolve_offsets never
                // adjusts a component ANCHOR's own offset, so a non-finite anchor/
                // floating offset from a corrupt or hand-edited DB would survive the
                // load and poison every world coordinate for that component. Coerce
                // to 0.0 so the subsequent re-solve can re-derive a finite position.
                if !offset_x.is_finite() || !offset_y.is_finite() {
                    if !offset_x.is_finite() {
                        offset_x = 0.0;
                    }
                    if !offset_y.is_finite() {
                        offset_y = 0.0;
                    }
                    sanitized_offsets += 1;
                }
                section_offsets.insert(section_id, (offset_x, offset_y));
            }
            if sanitized_offsets > 0 {
                tracing::warn!(
                    sanitized_offsets,
                    purpose = "block corruption at the source",
                    "Replaced non-finite (NaN/inf) section offset with 0.0 on load"
                );
            }
        }

        // Load station offsets
        let station_offsets = self.load_station_offsets()?;

        // Load loop closures
        let loop_closures = self.load_loop_closures()?;

        // Load imported file hashes
        let imported_file_hashes = self.load_imported_file_hashes()?;

        // Load imported section hashes
        let imported_section_hashes = self.load_imported_section_hashes()?;

        // Derive next_closure_id: use persisted value if available, otherwise fall back to max(existing) + 1.
        // Always ensure it's at least max(existing closures) + 1 for safety.
        let max_existing = loop_closures.iter().map(|lc| lc.id).max().unwrap_or(0);
        let next_closure_id = match persisted_next_closure_id {
            Some(persisted) => persisted.max(max_existing + 1),
            None => max_existing + 1,
        };

        // Load station comments
        let station_comments = self.load_station_comments()?;

        // Load collaboration state (None for pre-v5 projects or when off)
        let collab = self.load_collab_state()?;

        // Pre-populate the section_id → index lookup so callers get
        // O(1) get_section without needing rebuild_section_index().
        let mut section_index_cache = HashMap::with_capacity(sections.len());
        for (i, s) in sections.iter().enumerate() {
            section_index_cache.insert(s.id, i);
        }
        // Same for merge adjacency — the first compute_station_coordinates
        // call hammers get_merged_section_ids and would otherwise pay the
        // O(N) linear fallback on every BFS step.
        let mut merge_adjacency_cache: HashMap<u32, Vec<u32>> = HashMap::new();
        for m in &station_merges {
            merge_adjacency_cache
                .entry(m.station_a.section_id)
                .or_default()
                .push(m.station_b.section_id);
            merge_adjacency_cache
                .entry(m.station_b.section_id)
                .or_default()
                .push(m.station_a.section_id);
        }
        Ok(Project {
            name,
            location,
            created_at,
            modified_at,
            sections,
            station_merges,
            zero_datums,
            loop_closures,
            section_offsets,
            station_offsets,
            station_comments,
            file_path: None,
            next_section_id,
            imported_file_hashes,
            imported_section_hashes,
            next_closure_id,
            collab,
            cascade_deferred: false,
            section_index_cache,
            merge_adjacency_cache,
        })
    }

    /// Save undo entry to database
    pub fn save_undo_entry(
        &self,
        sequence: i64,
        command_json: &str,
        undo_data_json: &str,
    ) -> Result<()> {
        let cmd_compressed = compress_json(command_json);
        let undo_compressed = compress_json(undo_data_json);
        self.conn.execute(
            "INSERT INTO undo_stack (sequence, command_json, undo_data_json, executed_at) VALUES (?1, ?2, ?3, ?4)",
            params![sequence, cmd_compressed, undo_compressed, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Load undo stack from database
    pub fn load_undo_stack(&self) -> Result<Vec<(i64, String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT sequence, command_json, undo_data_json FROM undo_stack ORDER BY sequence")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?;

        let mut entries = Vec::new();
        for row in rows {
            let (seq, cmd_bytes, undo_bytes) = row?;
            let command_json = decompress_json(&cmd_bytes)?;
            let undo_data_json = decompress_json(&undo_bytes)?;
            entries.push((seq, command_json, undo_data_json));
        }
        Ok(entries)
    }

    /// Load undo stack from database with timestamps
    pub fn load_undo_stack_with_timestamps(&self) -> Result<Vec<(i64, String, String, Option<String>)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT sequence, command_json, undo_data_json, executed_at FROM undo_stack ORDER BY sequence")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;

        // Collect compressed blobs first, then decompress in parallel —
        // the command_json and undo_data_json blobs of a single entry
        // are independent of each other, and on big undo entries (e.g.
        // a multi-MB project snapshot from a batch import) gzip
        // decompression is single-threaded and slow.  std::thread::scope
        // keeps us dep-free.
        let mut raw: Vec<(i64, Vec<u8>, Vec<u8>, Option<String>)> = Vec::new();
        for row in rows {
            raw.push(row?);
        }
        let entries: Result<Vec<_>> = std::thread::scope(|scope| {
            let handles: Vec<_> = raw
                .into_iter()
                .map(|(seq, cmd_bytes, undo_bytes, ts)| {
                    let h_cmd = scope.spawn(move || decompress_json(&cmd_bytes));
                    let h_undo = scope.spawn(move || decompress_json(&undo_bytes));
                    (seq, h_cmd, h_undo, ts)
                })
                .collect();
            handles
                .into_iter()
                .map(|(seq, h_cmd, h_undo, ts)| {
                    let cmd = h_cmd.join().map_err(|_| {
                        anyhow::anyhow!("undo decompress thread panicked")
                    })??;
                    let undo = h_undo.join().map_err(|_| {
                        anyhow::anyhow!("undo decompress thread panicked")
                    })??;
                    Ok((seq, cmd, undo, ts))
                })
                .collect()
        });
        entries
    }

    /// Clear undo stack entries after a given sequence
    pub fn clear_undo_after(&self, sequence: i64) -> Result<()> {
        self.conn.execute(
            "DELETE FROM undo_stack WHERE sequence > ?1",
            params![sequence],
        )?;
        Ok(())
    }

    /// Save undo stack (clear existing and save new entries)
    pub fn save_undo_stack(&self, entries: Vec<(String, String)>) -> Result<()> {
        // Clear existing
        self.conn.execute("DELETE FROM undo_stack", [])?;

        // Save new entries
        for (seq, (command_json, undo_data_json)) in entries.iter().enumerate() {
            let cmd_compressed = compress_json(command_json);
            let undo_compressed = compress_json(undo_data_json);
            self.conn.execute(
                "INSERT INTO undo_stack (sequence, command_json, undo_data_json, executed_at) VALUES (?1, ?2, ?3, ?4)",
                params![seq as i64, cmd_compressed, undo_compressed, Utc::now().to_rfc3339()],
            )?;
        }

        tracing::debug!(count = entries.len(), "Saved undo stack to database");
        Ok(())
    }

    /// Save undo stack with timestamps (clear existing and save new entries)
    pub fn save_undo_stack_with_timestamps(&self, entries: Vec<(String, String, Option<String>)>) -> Result<()> {
        // Clear existing
        self.conn.execute("DELETE FROM undo_stack", [])?;

        // Save new entries
        for (seq, (command_json, undo_data_json, timestamp_str)) in entries.iter().enumerate() {
            // Use provided timestamp or fall back to current time
            let executed_at = timestamp_str.clone().unwrap_or_else(|| Utc::now().to_rfc3339());
            let cmd_compressed = compress_json(command_json);
            let undo_compressed = compress_json(undo_data_json);
            self.conn.execute(
                "INSERT INTO undo_stack (sequence, command_json, undo_data_json, executed_at) VALUES (?1, ?2, ?3, ?4)",
                params![seq as i64, cmd_compressed, undo_compressed, executed_at],
            )?;
        }

        tracing::debug!(count = entries.len(), "Saved undo stack with timestamps to database");
        Ok(())
    }

    /// Load redo stack from database with timestamps
    pub fn load_redo_stack_with_timestamps(&self) -> Result<Vec<(i64, String, String, Option<String>)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT sequence, command_json, undo_data_json, executed_at FROM redo_stack ORDER BY sequence")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;

        // Parallel gzip decompression of the per-entry blobs — see
        // load_undo_stack_with_timestamps for the rationale.
        let mut raw: Vec<(i64, Vec<u8>, Vec<u8>, Option<String>)> = Vec::new();
        for row in rows {
            raw.push(row?);
        }
        let entries: Result<Vec<_>> = std::thread::scope(|scope| {
            let handles: Vec<_> = raw
                .into_iter()
                .map(|(seq, cmd_bytes, undo_bytes, ts)| {
                    let h_cmd = scope.spawn(move || decompress_json(&cmd_bytes));
                    let h_undo = scope.spawn(move || decompress_json(&undo_bytes));
                    (seq, h_cmd, h_undo, ts)
                })
                .collect();
            handles
                .into_iter()
                .map(|(seq, h_cmd, h_undo, ts)| {
                    let cmd = h_cmd.join().map_err(|_| {
                        anyhow::anyhow!("redo decompress thread panicked")
                    })??;
                    let undo = h_undo.join().map_err(|_| {
                        anyhow::anyhow!("redo decompress thread panicked")
                    })??;
                    Ok((seq, cmd, undo, ts))
                })
                .collect()
        });
        let entries = entries?;
        Ok(entries)
    }

    /// Save redo stack with timestamps (clear existing and save new entries)
    pub fn save_redo_stack_with_timestamps(&self, entries: Vec<(String, String, Option<String>)>) -> Result<()> {
        self.conn.execute("DELETE FROM redo_stack", [])?;

        for (seq, (command_json, undo_data_json, timestamp_str)) in entries.iter().enumerate() {
            let executed_at = timestamp_str.clone().unwrap_or_else(|| Utc::now().to_rfc3339());
            let cmd_compressed = compress_json(command_json);
            let undo_compressed = compress_json(undo_data_json);
            self.conn.execute(
                "INSERT INTO redo_stack (sequence, command_json, undo_data_json, executed_at) VALUES (?1, ?2, ?3, ?4)",
                params![seq as i64, cmd_compressed, undo_compressed, executed_at],
            )?;
        }

        Ok(())
    }

    /// Load loop closures from database
    fn load_loop_closures(&self) -> Result<Vec<LoopClosure>> {
        let mut closures = Vec::new();

        // Check if table exists (for backwards compatibility with older files)
        let table_exists: bool = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='loop_closures'",
            [],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if !table_exists {
            return Ok(closures);
        }

        // Check which optional columns exist
        let has_closure_id: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='closure_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        let has_strategy: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='strategy'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        let has_is_aligned: bool = self.conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='is_aligned'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        // Build SELECT dynamically based on available columns
        let mut extra_cols = String::new();
        if has_closure_id {
            extra_cols.push_str(", closure_id");
        }
        if has_strategy {
            extra_cols.push_str(", strategy");
        }
        if has_is_aligned {
            extra_cols.push_str(", is_aligned");
        }
        let query = format!(
            "SELECT station_a_section, station_a_index, station_b_section, station_b_index, \
             path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure{extra_cols} \
             FROM loop_closures"
        );

        let mut stmt = self.conn.prepare(&query)?;
        let rows = stmt.query_map([], |row| {
            let mut col = 9usize; // next column index after the 9 base columns
            let id = if has_closure_id {
                let v = row.get::<_, i64>(col).unwrap_or(0).max(0) as u64;
                col += 1;
                v
            } else { 0 };
            let strategy = if has_strategy {
                let s: String = row.get::<_, String>(col).unwrap_or_default();
                col += 1;
                ClosureStrategy::from_str_lossy(&s)
            } else {
                ClosureStrategy::default()
            };
            let is_aligned = if has_is_aligned {
                let v = row.get::<_, i64>(col).unwrap_or(0);
                v != 0
            } else {
                false
            };
            Ok(LoopClosure {
                id,
                station_a: StationKey::positional(row.get(0)?, row.get(1)?),
                station_b: StationKey::positional(row.get(2)?, row.get(3)?),
                path_length: row.get(4)?,
                misclosure_distance: row.get(5)?,
                error_percentage: row.get(6)?,
                horizontal_misclosure: row.get(7)?,
                vertical_misclosure: row.get(8)?,
                strategy,
                is_aligned,
            })
        })?;

        for row in rows {
            closures.push(row?);
        }

        Ok(closures)
    }

    /// Load station offsets from database
    fn load_station_offsets(&self) -> Result<HashMap<StationKey, (f64, f64, f64)>> {
        let mut offsets = HashMap::new();

        // Check if table exists (for backwards compatibility with older files)
        let table_exists: bool = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='station_offsets'",
            [],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if !table_exists {
            return Ok(offsets);
        }

        let mut stmt = self.conn.prepare(
            "SELECT section_id, station_index, offset_x, offset_y, offset_z FROM station_offsets",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })?;

        for row in rows {
            let (section_id, station_index, offset_x, offset_y, offset_z) = row?;
            offsets.insert(
                StationKey::positional(section_id, station_index),
                (offset_x, offset_y, offset_z),
            );
        }

        Ok(offsets)
    }

    fn load_station_comments(&self) -> Result<HashMap<StationKey, String>> {
        let mut comments = HashMap::new();

        // Check if table exists (for backwards compatibility with older files)
        let table_exists: bool = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='station_comments'",
            [],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if !table_exists {
            return Ok(comments);
        }

        let mut stmt = self.conn.prepare(
            "SELECT section_id, station_index, comment FROM station_comments",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;

        for row in rows {
            let (section_id, station_index, comment) = row?;
            comments.insert(
                StationKey::positional(section_id, station_index),
                comment,
            );
        }

        Ok(comments)
    }

    /// Load collaboration state from the single-row `collab_state` table.
    /// Returns `None` for pre-v5 projects (table absent) or when no row is present.
    fn load_collab_state(&self) -> Result<Option<crate::models::CollabState>> {
        let table_exists: bool = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='collab_state'",
            [],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if !table_exists {
            return Ok(None);
        }

        let json: Option<String> = self.conn.query_row(
            "SELECT state_json FROM collab_state WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        ).ok();

        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).context("Failed to deserialize collab state")?,
            )),
            None => Ok(None),
        }
    }

    /// Upsert the collaboration state without rewriting the whole project.
    /// Used by the save-both hook to persist a refreshed baseline after exporting
    /// the sibling `.tml`. `None` clears the row (collaboration disabled).
    pub fn save_collab_state(&self, collab: Option<&crate::models::CollabState>) -> Result<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS collab_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state_json TEXT NOT NULL
            )",
            [],
        )?;
        match collab {
            Some(state) => {
                let json = serde_json::to_string(state)
                    .context("Failed to serialize collab state")?;
                self.conn.execute(
                    "INSERT INTO collab_state (id, state_json) VALUES (1, ?1)
                     ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json",
                    params![json],
                )?;
            }
            None => {
                self.conn.execute("DELETE FROM collab_state", [])?;
            }
        }
        Ok(())
    }

    /// Rename the project's display name without rewriting the whole project.
    /// A targeted `UPDATE` on the single `project` row (mirrors
    /// [`save_collab_state`](Self::save_collab_state)); leaves `modified_at`
    /// untouched so a rename doesn't reorder the recent list by edit time.
    pub fn save_project_name(&self, name: &str) -> Result<()> {
        let affected = self
            .conn
            .execute("UPDATE project SET name = ?1 WHERE id = 1", params![name])
            .context("Failed to update project name")?;
        if affected == 0 {
            anyhow::bail!("No project row to rename");
        }
        Ok(())
    }

    /// Load imported file hashes from database
    fn load_imported_file_hashes(&self) -> Result<Vec<String>> {
        let mut hashes = Vec::new();

        // Check if table exists (for backwards compatibility with older files)
        let table_exists: bool = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='imported_file_hashes'",
            [],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if !table_exists {
            return Ok(hashes);
        }

        let mut stmt = self.conn.prepare("SELECT hash FROM imported_file_hashes")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        for row in rows {
            hashes.push(row?);
        }

        Ok(hashes)
    }

    /// Load imported section hashes from database
    fn load_imported_section_hashes(&self) -> Result<Vec<String>> {
        let mut hashes = Vec::new();

        // Check if table exists (for backwards compatibility with older files)
        let table_exists: bool = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='imported_section_hashes'",
            [],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if !table_exists {
            return Ok(hashes);
        }

        let mut stmt = self.conn.prepare("SELECT hash FROM imported_section_hashes")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        for row in rows {
            hashes.push(row?);
        }

        Ok(hashes)
    }

    /// Load resolved warnings from database
    pub fn load_resolved_warnings(&self) -> Result<Vec<ResolvedWarning>> {
        let mut resolved = Vec::new();

        // Check if table exists (for backwards compatibility with older files)
        let table_exists: bool = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='resolved_warnings'",
            [],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if !table_exists {
            return Ok(resolved);
        }

        let mut stmt = self.conn.prepare(
            "SELECT section_id, shot_id, warning_code, resolved_at, resolved_comment, shot_uuid \
             FROM resolved_warnings",
        )?;

        let rows = stmt.query_map([], |row| {
            let resolved_at_str: String = row.get(3)?;
            let resolved_at = chrono::DateTime::parse_from_rfc3339(&resolved_at_str).map_or_else(|_| Utc::now(), |dt| dt.with_timezone(&Utc));
            Ok(ResolvedWarning {
                section_id: row.get(0)?,
                shot_id: row.get(1)?,
                warning_code: row.get(2)?,
                resolved_at,
                resolved_comment: row.get(4)?,
                // NULL for pre-v8 rows; an empty string is treated as absent too.
                shot_uuid: row.get::<_, Option<String>>(5)?.filter(|s| !s.is_empty()),
            })
        })?;

        for row in rows {
            resolved.push(row?);
        }

        Ok(resolved)
    }

    /// Save a resolved warning to database.
    ///
    /// Suppression is keyed by the shot's stable `shot_uuid` (issue #57). To
    /// keep a single row per suppressed `(shot, warning_code)`, we first delete
    /// any prior row that matches either the UUID or the legacy
    /// `(section_id, shot_id)` position (which also backfills/upgrades a pre-v8
    /// row to the UUID key), then insert the fresh record. Falls back to the
    /// legacy position key when the shot has no UUID.
    pub fn save_resolved_warning(&self, warning: &ResolvedWarning) -> Result<()> {
        Self::delete_matching_resolved(&self.conn, warning)?;
        self.conn.execute(
            "INSERT INTO resolved_warnings (section_id, shot_id, warning_code, resolved_at, resolved_comment, shot_uuid) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                warning.section_id,
                warning.shot_id,
                warning.warning_code,
                warning.resolved_at.to_rfc3339(),
                warning.resolved_comment,
                warning.shot_uuid,
            ],
        )?;
        Ok(())
    }

    /// Delete any resolved-warning rows matching `warning`, keyed by UUID when
    /// present (so a moved/renumbered shot still dedups) plus the legacy
    /// position. Shared by save (dedup) and unresolve (clear).
    fn delete_matching_resolved(conn: &Connection, warning: &ResolvedWarning) -> Result<()> {
        if let Some(uuid) = warning.shot_uuid.as_deref() {
            conn.execute(
                "DELETE FROM resolved_warnings WHERE warning_code = ?1 \
                 AND (shot_uuid = ?2 OR (section_id = ?3 AND shot_id = ?4))",
                params![warning.warning_code, uuid, warning.section_id, warning.shot_id],
            )?;
        } else {
            conn.execute(
                "DELETE FROM resolved_warnings WHERE warning_code = ?1 \
                 AND section_id = ?2 AND shot_id = ?3",
                params![warning.warning_code, warning.section_id, warning.shot_id],
            )?;
        }
        Ok(())
    }

    /// Delete a resolved warning from database (un-ignore). Matches by UUID when
    /// `shot_uuid` is provided (the normal case), else by the legacy position.
    pub fn delete_resolved_warning(
        &self,
        section_id: u32,
        shot_id: u32,
        warning_code: &str,
        shot_uuid: Option<&str>,
    ) -> Result<()> {
        Self::delete_matching_resolved(
            &self.conn,
            &ResolvedWarning {
                section_id,
                shot_id,
                warning_code: warning_code.to_string(),
                resolved_at: Utc::now(),
                resolved_comment: None,
                shot_uuid: shot_uuid.map(str::to_string),
            },
        )
    }

    /// Save multiple resolved warnings to database in a single transaction
    pub fn save_resolved_warnings_bulk(&self, warnings: &[ResolvedWarning]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for warning in warnings {
            Self::delete_matching_resolved(&tx, warning)?;
        }
        {
            let mut stmt = tx.prepare(
                "INSERT INTO resolved_warnings (section_id, shot_id, warning_code, resolved_at, resolved_comment, shot_uuid) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for warning in warnings {
                stmt.execute(params![
                    warning.section_id,
                    warning.shot_id,
                    warning.warning_code,
                    warning.resolved_at.to_rfc3339(),
                    warning.resolved_comment,
                    warning.shot_uuid,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Load all display settings from database
    pub fn load_display_settings(&self) -> Result<HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM display_settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut settings = HashMap::new();
        for row in rows {
            let (key, value) = row?;
            settings.insert(key, value);
        }
        Ok(settings)
    }

    /// Save a display setting to database
    pub fn save_display_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO display_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// Get a single display setting from database
    pub fn get_display_setting(&self, key: &str) -> Result<Option<String>> {
        let result = self.conn.query_row(
            "SELECT value FROM display_settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        );
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // =========================================================================
    // Raw table browsing (data table fullscreen)
    // =========================================================================

    /// List user table names in the database, excluding sqlite-internal tables.
    pub fn list_raw_table_names(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        let mut names = Vec::new();
        for row in rows {
            names.push(row?);
        }
        Ok(names)
    }

    /// Read a page of rows from a raw table, with every value stringified
    /// (NULL → `"NULL"`, blobs → a size placeholder like `<blob 4.2 KB>`).
    ///
    /// Injection guard: `table` must be an exact member of
    /// [`Self::list_raw_table_names`]; the identifier is double-quoted and
    /// LIMIT/OFFSET are bound parameters. `limit` is clamped to
    /// [`MAX_RAW_PAGE_ROWS`].
    pub fn read_raw_table(&self, table: &str, limit: u32, offset: u32) -> Result<RawTableData> {
        let known = self.list_raw_table_names()?;
        if !known.iter().any(|name| name == table) {
            anyhow::bail!("Unknown table: {table}");
        }
        let limit = limit.min(MAX_RAW_PAGE_ROWS);
        let ident = format!("\"{}\"", table.replace('"', "\"\""));

        let total_rows: u32 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM {ident}"),
            [],
            |row| row.get(0),
        )?;

        let mut stmt = self
            .conn
            .prepare(&format!("SELECT * FROM {ident} LIMIT ?1 OFFSET ?2"))?;
        let columns: Vec<String> = stmt.column_names().iter().map(|c| (*c).to_string()).collect();
        let column_count = columns.len();
        let mapped = stmt.query_map(params![limit, offset], |row| {
            let mut values = Vec::with_capacity(column_count);
            for i in 0..column_count {
                values.push(match row.get_ref(i)? {
                    ValueRef::Null => "NULL".to_string(),
                    ValueRef::Integer(v) => v.to_string(),
                    ValueRef::Real(v) => v.to_string(),
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                    ValueRef::Blob(b) => format_blob_placeholder(b.len()),
                });
            }
            Ok(values)
        })?;

        let mut rows = Vec::new();
        for row in mapped {
            rows.push(row?);
        }
        Ok(RawTableData {
            columns,
            rows,
            total_rows,
        })
    }

    // =========================================================================
    // Recovery methods (SPEC 14.4)
    // =========================================================================

    /// Open a database for recovery purposes, skipping integrity checks.
    /// This allows reading whatever data is still accessible from a corrupt file.
    pub fn open_for_recovery(path: &Path) -> Result<Self> {
        tracing::info!("Opening database for recovery at: {:?}", path);

        if !path.exists() {
            anyhow::bail!("File does not exist");
        }

        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("Failed to open database for recovery")?;

        let db = Self { conn };
        // Skip integrity check intentionally — we know the file may be corrupt
        Ok(db)
    }

    /// Attempt to repair a corrupt database using REINDEX + VACUUM.
    ///
    /// Always creates a backup first (`path.stalx.backup`, with numeric
    /// suffixes to avoid overwriting existing backups).
    ///
    /// Returns `(backup_path, integrity_ok)`.
    pub fn attempt_repair(path: &Path) -> Result<(std::path::PathBuf, bool)> {
        tracing::info!("Attempting repair of: {:?}", path);

        // 1. Create backup (never overwrite existing backups)
        let backup_path = Self::create_numbered_backup(path)?;
        tracing::info!("Created backup at: {:?}", backup_path);

        // 2. Open read-write (skip our integrity check wrapper)
        let conn = Connection::open(path)
            .context("Failed to open database for repair")?;

        // 3. Rebuild indexes
        if let Err(e) = conn.execute_batch("REINDEX;") {
            tracing::warn!(error = %e, "REINDEX failed, continuing with VACUUM");
        }

        // 4. VACUUM rebuilds the entire database from readable pages
        conn.execute_batch("VACUUM;")
            .context("VACUUM failed — database may be too damaged to repair")?;

        // 5. Verify result
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap_or_else(|_| "error".to_string());
        let ok = check == "ok";

        if ok {
            tracing::info!("Repair succeeded — integrity check passed");
        } else {
            tracing::error!(result = %check, "Repair completed but integrity check still fails");
        }

        Ok((backup_path, ok))
    }

    /// Export whatever data can be read from a (possibly corrupt) database.
    ///
    /// Each table is read independently so a failure in one table doesn't
    /// prevent salvaging data from others.
    pub fn export_salvageable(path: &Path) -> Result<SalvagedData> {
        let db = Self::open_for_recovery(path)?;
        let mut salvaged = SalvagedData::default();

        // Project metadata
        match db.try_read_project_metadata() {
            Ok(Some((name, location))) => {
                salvaged.project_name = Some(name);
                salvaged.project_location = location;
            }
            Ok(None) => salvaged.errors.push("Project table is empty".into()),
            Err(e) => salvaged.errors.push(format!("Failed to read project metadata: {e}")),
        }

        // Sections
        match db.try_read_sections() {
            Ok(sections) => {
                salvaged.section_count = sections.len();
                salvaged.sections_json = serde_json::to_string(&sections).ok();
            }
            Err(e) => salvaged.errors.push(format!("Failed to read sections: {e}")),
        }

        // Shots
        match db.try_read_shot_count() {
            Ok(count) => salvaged.shot_count = count,
            Err(e) => salvaged.errors.push(format!("Failed to read shots: {e}")),
        }

        // Station merges
        match db.try_read_merge_count() {
            Ok(count) => salvaged.merge_count = count,
            Err(e) => salvaged.errors.push(format!("Failed to read station merges: {e}")),
        }

        // Full project (best-effort)
        match db.load_project() {
            Ok(project) => {
                salvaged.full_project_json = serde_json::to_string(&project).ok();
            }
            Err(e) => salvaged.errors.push(format!("Failed to load full project: {e}")),
        }

        Ok(salvaged)
    }

    /// List backup files for a given project path.
    pub fn list_backups(path: &Path) -> Vec<BackupInfo> {
        let mut backups = Vec::new();
        let Some(parent) = path.parent() else {
            return backups;
        };
        let stem = path.file_name().unwrap_or_default().to_string_lossy();

        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // Match patterns: file.stalx.backup, file.stalx.backup.1, file.stalx.tmp
                let is_backup = name.starts_with(&*stem)
                    && (name.contains(".backup") || name.to_ascii_lowercase().ends_with(".tmp"));
                if is_backup {
                    if let Ok(meta) = entry.metadata() {
                        backups.push(BackupInfo {
                            path: entry.path().display().to_string(),
                            size_bytes: meta.len(),
                            modified_at: meta
                                .modified()
                                .ok()
                                .map(|t| {
                                    let dt: chrono::DateTime<Utc> = t.into();
                                    dt.to_rfc3339()
                                })
                                .unwrap_or_default(),
                        });
                    }
                }
            }
        }

        // Sort by modification time, newest first
        backups.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        backups
    }

    /// Create a numbered backup: file.stalx.backup, .backup.1, .backup.2, etc.
    fn create_numbered_backup(path: &Path) -> Result<std::path::PathBuf> {
        let base = path.with_extension("stalx.backup");
        if !base.exists() {
            std::fs::copy(path, &base)?;
            return Ok(base);
        }
        for i in 1..100 {
            let numbered = path.with_extension(format!("stalx.backup.{i}"));
            if !numbered.exists() {
                std::fs::copy(path, &numbered)?;
                return Ok(numbered);
            }
        }
        anyhow::bail!("Too many existing backups (max 100)")
    }

    // --- Helper readers for salvage (best-effort, each catches its own errors) ---

    fn try_read_project_metadata(&self) -> Result<Option<(String, Option<String>)>> {
        if !self.table_exists("project")? {
            return Ok(None);
        }
        let count: i64 = self.conn.query_row("SELECT COUNT(*) FROM project", [], |row| row.get(0))?;
        if count == 0 {
            return Ok(None);
        }
        let (name, location): (String, Option<String>) = self.conn.query_row(
            "SELECT name, location FROM project LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(Some((name, location)))
    }

    fn try_read_sections(&self) -> Result<Vec<SalvagedSection>> {
        if !self.table_exists("sections")? {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, name, surveyor, date, color FROM sections ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SalvagedSection {
                id: row.get(0)?,
                name: row.get(1)?,
                surveyor: row.get(2)?,
                date: row.get(3)?,
                color: row.get(4)?,
            })
        })?;
        let mut sections = Vec::new();
        for row in rows {
            sections.push(row?);
        }
        Ok(sections)
    }

    fn try_read_shot_count(&self) -> Result<usize> {
        if !self.table_exists("shots")? {
            return Ok(0);
        }
        let count: i64 = self.conn.query_row("SELECT COUNT(*) FROM shots", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    fn try_read_merge_count(&self) -> Result<usize> {
        if !self.table_exists("station_merges")? {
            return Ok(0);
        }
        let count: i64 = self.conn.query_row("SELECT COUNT(*) FROM station_merges", [], |row| row.get(0))?;
        Ok(count as usize)
    }
}

/// A stringified page of rows from a raw sqlite table.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RawTableData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: u32,
}

/// Information about a backup file.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: String,
}

/// Result of attempting to repair a corrupt database.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    pub success: bool,
    pub backup_path: String,
    pub message: String,
}

/// Data salvaged from a corrupt database.
#[derive(Debug, Clone, Default, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SalvagedData {
    pub project_name: Option<String>,
    pub project_location: Option<String>,
    pub section_count: usize,
    pub shot_count: usize,
    pub merge_count: usize,
    /// Sections as JSON (for display/re-import)
    pub sections_json: Option<String>,
    /// Full project as JSON (if loadable despite corruption)
    pub full_project_json: Option<String>,
    /// Errors encountered while reading individual tables
    pub errors: Vec<String>,
}

/// Minimal section info for salvage display.
#[derive(Debug, Clone, serde::Serialize)]
struct SalvagedSection {
    id: u32,
    name: Option<String>,
    surveyor: Option<String>,
    date: Option<String>,
    color: String,
}

/// Resolved warning record
#[derive(Debug, Clone)]
pub struct ResolvedWarning {
    pub section_id: u32,
    pub shot_id: u32,
    pub warning_code: String,
    pub resolved_at: chrono::DateTime<Utc>,
    pub resolved_comment: Option<String>,
    /// Stable UUID of the suppressed shot (issue #57). `Some` for all warnings
    /// raised against shots that have a UUID (the normal case); `None` only for
    /// pre-v8 rows or shots loaded from pre-v6 .stalx files without a UUID yet.
    /// The suppression is matched by `(shot_uuid, warning_code)` when present,
    /// falling back to the legacy `(section_id, shot_id, warning_code)` key
    /// otherwise. See `AppState::compute_project_warnings`.
    pub shot_uuid: Option<String>,
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout, clippy::float_cmp)]
mod tests;
