use anyhow::{Context, Result};
use chrono::{NaiveDate, Utc};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::Path;

use crate::models::{
    ClosureStrategy, GpsCoordinates, LoopClosure, Project, Section, SectionData, Shot,
    StationMerge, StationRef, SurveyDirection, ZeroDatum, FEATURE_ID_STRIDE,
};


/// Schema version for migrations
const SCHEMA_VERSION: i32 = 5;

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
        tracing::info!("Opening database at: {:?}", path);
        let exists = path.exists();
        tracing::info!("File existed before open: {}", exists);

        let conn = Connection::open(path).context("Failed to open database")?;
        tracing::info!("SQLite connection created");

        let db = Self { conn };
        db.enable_foreign_keys()?;

        if let Ok(version) = db.get_user_version() {
            if version > SCHEMA_VERSION {
                tracing::warn!(
                    current = version,
                    expected = SCHEMA_VERSION,
                    "Database schema version is newer than this app"
                );
            }
        }
        db.init_schema()?;
        db.set_user_version(SCHEMA_VERSION)?;
        tracing::info!("Schema initialized");

        // Verify tables exist after schema init
        let table_count: i32 = db.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        tracing::info!("Tables in database after init: {}", table_count);

        Ok(db)
    }

    /// Open an existing database (does not create if missing)
    pub fn open_existing(path: &Path) -> Result<Self> {
        tracing::info!("Opening existing database at: {:?}", path);

        if !path.exists() {
            tracing::error!("File does not exist: {:?}", path);
            anyhow::bail!("File does not exist");
        }
        tracing::info!("File exists, size: {:?} bytes", std::fs::metadata(path).map(|m| m.len()).ok());

        // Open in read-only mode first to check if it's valid
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .context("Failed to open database - file may not be a valid SQLite database")?;
        tracing::info!("SQLite connection opened successfully");

        let mut db = Self { conn };
        db.enable_foreign_keys()?;

        // Run quick integrity check before reading any data (SPEC 14.4)
        db.validate_integrity().context("Database file may be corrupted")?;

        // Check if the project table exists and has data
        let has_data = db.has_project_data()?;
        tracing::info!("has_project_data returned: {}", has_data);

        if !has_data {
            tracing::error!("File does not contain valid Stalagmight project data");
            anyhow::bail!("File does not contain a valid Stalagmight project");
        }

        // Run lightweight migrations to ensure newer tables exist in legacy projects
        db.ensure_schema_version()?;
        db.validate_foreign_keys()?;

        Ok(db)
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

        if current <= SCHEMA_VERSION {
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
            self.set_user_version(SCHEMA_VERSION)?;
            // Keep project-level schema_version in sync with PRAGMA user_version.
            let _ = self.conn.execute(
                "UPDATE project SET schema_version = ?1",
                params![SCHEMA_VERSION],
            );
        }

        Ok(())
    }

    /// Check if the database has valid project data
    pub fn has_project_data(&self) -> Result<bool> {
        tracing::info!("Checking if database has project data...");

        // First check if project table exists
        let table_exists: i32 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='project'",
            [],
            |row| row.get(0),
        )?;
        tracing::info!("project table exists: {}", table_exists > 0);

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
        tracing::info!("project table row count: {}", count);

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
        tracing::info!("Saving project: name={}, sections={}", project.name, project.sections.len());

        tracing::info!("About to start transaction...");
        let tx = match self.conn.transaction() {
            Ok(t) => {
                tracing::info!("Transaction started successfully");
                t
            }
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
        tracing::info!("Existing data cleared");

        // Save project metadata (including next_closure_id for monotonic ID persistence)
        let next_closure_id_i64 = i64::try_from(project.next_closure_id)
            .map_err(|_| anyhow::anyhow!("next_closure_id {} exceeds i64 range", project.next_closure_id))?;
        let rows_affected = tx.execute(
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
        tracing::info!("Project metadata inserted, rows_affected={}", rows_affected);

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
                // The database uses auto-increment for the id column
                tx.execute(
                    r"INSERT INTO shots (
                        section_id, sequence_order,
                        azimuth_in, azimuth_out, length, depth_in, depth_out,
                        pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                        comment, is_reference, marker_index, temperature
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
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
                        shot.temperature
                    ],
                )?;
            }
        }

        // Save station merges
        for merge in &project.station_merges {
            tx.execute(
                "INSERT INTO station_merges (station_a_section, station_a_index, station_b_section, station_b_index, merged_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    merge.station_a.section_id,
                    merge.station_a.station_index,
                    merge.station_b.section_id,
                    merge.station_b.station_index,
                    merge.merged_at.to_rfc3339()
                ],
            )?;
        }

        // Save zero datums
        for zd in &project.zero_datums {
            tx.execute(
                "INSERT INTO zero_datums (section_id, station_index, latitude, longitude, depth_reference) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    zd.station_ref.section_id,
                    zd.station_ref.station_index,
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
        for (station_ref, (offset_x, offset_y, offset_z)) in &project.station_offsets {
            tx.execute(
                "INSERT INTO station_offsets (section_id, station_index, offset_x, offset_y, offset_z) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![station_ref.section_id, station_ref.station_index, offset_x, offset_y, offset_z],
            )?;
        }

        // Save station comments
        for (station_ref, comment) in &project.station_comments {
            tx.execute(
                "INSERT INTO station_comments (section_id, station_index, comment) VALUES (?1, ?2, ?3)",
                params![station_ref.section_id, station_ref.station_index, comment],
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
            tx.execute(
                "INSERT INTO loop_closures (station_a_section, station_a_index, station_b_section, station_b_index, path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure, closure_id, strategy, is_aligned) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    lc.station_a.section_id,
                    lc.station_a.station_index,
                    lc.station_b.section_id,
                    lc.station_b.station_index,
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
        tracing::info!("Transaction committed");

        // Verify the data was written
        let verify_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM project",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        tracing::info!("Save verification: project table has {} rows", verify_count);

        Ok(())
    }

    /// Load a project from the database
    pub fn load_project(&self) -> Result<Project> {
        tracing::info!("Loading project from database");

        // First check if project table has data and log what's there
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM project",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        tracing::info!("Project table row count: {}", count);

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

                let mut section = Section::new(id, section_data);

                // Load shots for this section
                // Note: Shot IDs are generated from section_id and sequence_order
                let mut shot_stmt = self.conn.prepare(
                    r"SELECT sequence_order, azimuth_in, azimuth_out, length, depth_in, depth_out,
                              pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                              comment, is_reference, marker_index, temperature
                       FROM shots WHERE section_id = ?1 ORDER BY sequence_order",
                )?;

                let section_id_for_shots = id;
                let shot_rows = shot_stmt.query_map([id], |row| {
                    let seq: i64 = row.get(0)?;
                    Ok(Shot {
                        // Generate globally unique shot ID from section_id and sequence
                        id: section_id_for_shots * FEATURE_ID_STRIDE + (seq as u32),
                        azimuth_in: row.get(1)?,
                        azimuth_out: row.get(2)?,
                        length: row.get(3)?,
                        depth_in: row.get(4)?,
                        depth_out: row.get(5)?,
                        pitch_in: row.get(6)?,
                        pitch_out: row.get(7)?,
                        left: row.get(8)?,
                        right: row.get(9)?,
                        up: row.get(10)?,
                        down: row.get(11)?,
                        comment: row.get(12)?,
                        is_reference: row.get::<_, i32>(13)? != 0,
                        marker_index: row.get(14)?,
                        temperature: row.get(15)?,
                    })
                })?;

                for shot_row in shot_rows {
                    section.shots.push(shot_row?);
                }
                // Shots were pushed directly (bypassing add_shot), so advance
                // next_shot_id past the loaded shots to avoid ID collisions.
                section.next_shot_id = id * FEATURE_ID_STRIDE + section.shots.len() as u32;

                next_section_id = next_section_id.max(id + 1);
                sections.push(section);
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
                station_merges.push(StationMerge {
                    station_a: StationRef::new(a_sec, a_idx),
                    station_b: StationRef::new(b_sec, b_idx),
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
                    station_ref: StationRef::new(section_id, station_index),
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

            for offset_row in offset_rows {
                let (section_id, offset_x, offset_y) = offset_row?;
                section_offsets.insert(section_id, (offset_x, offset_y));
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

        let mut entries = Vec::new();
        for row in rows {
            let (seq, cmd_bytes, undo_bytes, ts) = row?;
            let command_json = decompress_json(&cmd_bytes)?;
            let undo_data_json = decompress_json(&undo_bytes)?;
            entries.push((seq, command_json, undo_data_json, ts));
        }
        Ok(entries)
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

        tracing::info!(count = entries.len(), "Saved undo stack to database");
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

        tracing::info!(count = entries.len(), "Saved undo stack with timestamps to database");
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

        let mut entries = Vec::new();
        for row in rows {
            let (seq, cmd_bytes, undo_bytes, ts) = row?;
            let command_json = decompress_json(&cmd_bytes)?;
            let undo_data_json = decompress_json(&undo_bytes)?;
            entries.push((seq, command_json, undo_data_json, ts));
        }
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
                station_a: StationRef::new(row.get(0)?, row.get(1)?),
                station_b: StationRef::new(row.get(2)?, row.get(3)?),
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
    fn load_station_offsets(&self) -> Result<HashMap<StationRef, (f64, f64, f64)>> {
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
                StationRef::new(section_id, station_index),
                (offset_x, offset_y, offset_z),
            );
        }

        Ok(offsets)
    }

    fn load_station_comments(&self) -> Result<HashMap<StationRef, String>> {
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
                StationRef::new(section_id, station_index),
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
            "SELECT section_id, shot_id, warning_code, resolved_at, resolved_comment \
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
            })
        })?;

        for row in rows {
            resolved.push(row?);
        }

        Ok(resolved)
    }

    /// Save a resolved warning to database
    pub fn save_resolved_warning(&self, warning: &ResolvedWarning) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO resolved_warnings (section_id, shot_id, warning_code, resolved_at, resolved_comment) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                warning.section_id,
                warning.shot_id,
                warning.warning_code,
                warning.resolved_at.to_rfc3339(),
                warning.resolved_comment,
            ],
        )?;
        Ok(())
    }

    /// Delete a resolved warning from database
    pub fn delete_resolved_warning(&self, section_id: u32, shot_id: u32, warning_code: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM resolved_warnings WHERE section_id = ?1 AND shot_id = ?2 AND warning_code = ?3",
            params![section_id, shot_id, warning_code],
        )?;
        Ok(())
    }

    /// Save multiple resolved warnings to database in a single transaction
    pub fn save_resolved_warnings_bulk(&self, warnings: &[ResolvedWarning]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO resolved_warnings (section_id, shot_id, warning_code, resolved_at, resolved_comment) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for warning in warnings {
                stmt.execute(params![
                    warning.section_id,
                    warning.shot_id,
                    warning.warning_code,
                    warning.resolved_at.to_rfc3339(),
                    warning.resolved_comment,
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
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout, clippy::float_cmp)]
mod tests;
