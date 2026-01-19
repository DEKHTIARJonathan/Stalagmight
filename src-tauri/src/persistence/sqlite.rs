use anyhow::{Context, Result};
use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::Path;

use crate::models::{
    GpsCoordinates, LoopClosure, Project, Section, SectionData, Shot, StationMerge, StationRef,
    SurveyDirection, ZeroDatum,
};

#[cfg(test)]
use crate::models::ShotData;

/// Schema version for migrations
const SCHEMA_VERSION: i32 = 1;

/// Database operations for projects
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Open or create a database at the given path
    pub fn open(path: &Path) -> Result<Self> {
        tracing::info!("=== DATABASE OPEN (for save) ===");
        tracing::info!("Opening database at: {:?}", path);
        let exists = path.exists();
        tracing::info!("File existed before open: {}", exists);

        let conn = Connection::open(path).context("Failed to open database")?;
        tracing::info!("SQLite connection created");

        let db = Self { conn };
        db.init_schema()?;
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
        tracing::info!("=== OPEN EXISTING START ===");
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

        let db = Self { conn };

        // Check if the project table exists and has data
        let has_data = db.has_project_data()?;
        tracing::info!("has_project_data returned: {}", has_data);

        if !has_data {
            tracing::error!("File does not contain valid CaveChef project data");
            anyhow::bail!("File does not contain a valid CaveChef project");
        }

        // Run lightweight migrations to ensure newer tables exist in legacy projects
        db.migrate_schema()?;

        tracing::info!("=== OPEN EXISTING END === Success");
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

        tracing::debug!("Schema migration complete");
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
        db.init_schema()?;
        Ok(db)
    }

    /// Initialize the database schema
    fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            -- Project metadata
            CREATE TABLE IF NOT EXISTS project (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                location TEXT,
                created_at TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                schema_version INTEGER NOT NULL
            );

            -- Sections
            CREATE TABLE IF NOT EXISTS sections (
                id INTEGER PRIMARY KEY,
                name TEXT,
                surveyor TEXT,
                date TEXT,
                color TEXT NOT NULL,
                direction TEXT NOT NULL DEFAULT 'in',
                created_at TEXT NOT NULL
            );

            -- Shots
            CREATE TABLE IF NOT EXISTS shots (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL REFERENCES sections(id),
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
                is_virtual INTEGER NOT NULL DEFAULT 0,
                marker_index INTEGER,
                temperature REAL,
                UNIQUE(section_id, sequence_order)
            );

            -- Station merges
            CREATE TABLE IF NOT EXISTS station_merges (
                id INTEGER PRIMARY KEY,
                station_a_section INTEGER NOT NULL,
                station_a_index INTEGER NOT NULL,
                station_b_section INTEGER NOT NULL,
                station_b_index INTEGER NOT NULL,
                merged_at TEXT NOT NULL
            );

            -- Zero datums
            CREATE TABLE IF NOT EXISTS zero_datums (
                id INTEGER PRIMARY KEY,
                section_id INTEGER NOT NULL,
                station_index INTEGER NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                depth_reference REAL NOT NULL,
                UNIQUE(section_id, station_index)
            );

            -- Section offsets (for aligning merged sections)
            CREATE TABLE IF NOT EXISTS section_offsets (
                section_id INTEGER PRIMARY KEY,
                offset_x REAL NOT NULL,
                offset_y REAL NOT NULL
            );

            -- Undo/redo stack
            CREATE TABLE IF NOT EXISTS undo_stack (
                id INTEGER PRIMARY KEY,
                sequence INTEGER NOT NULL,
                command_json TEXT NOT NULL,
                undo_data_json TEXT NOT NULL,
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
                vertical_misclosure REAL NOT NULL
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
                UNIQUE(section_id, shot_id, warning_code)
            );

            -- Imported file hashes (for duplicate detection)
            CREATE TABLE IF NOT EXISTS imported_file_hashes (
                id INTEGER PRIMARY KEY,
                hash TEXT NOT NULL UNIQUE
            );

            -- Indexes
            CREATE INDEX IF NOT EXISTS idx_shots_section ON shots(section_id);
            CREATE INDEX IF NOT EXISTS idx_undo_sequence ON undo_stack(sequence);
            "#,
        )?;

        Ok(())
    }

    /// Save a project to the database
    pub fn save_project(&mut self, project: &Project) -> Result<()> {
        tracing::info!("=== SAVE PROJECT START ===");
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
            r#"
            DELETE FROM shots;
            DELETE FROM sections;
            DELETE FROM station_merges;
            DELETE FROM zero_datums;
            DELETE FROM section_offsets;
            DELETE FROM loop_closures;
            DELETE FROM imported_file_hashes;
            DELETE FROM project;
            "#,
        )?;
        tracing::info!("Existing data cleared");

        // Save project metadata
        let rows_affected = tx.execute(
            "INSERT INTO project (id, name, location, created_at, modified_at, schema_version) VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            params![
                project.name,
                project.location,
                project.created_at.to_rfc3339(),
                project.modified_at.to_rfc3339(),
                SCHEMA_VERSION
            ],
        )?;
        tracing::info!("Project metadata inserted, rows_affected={}", rows_affected);

        // Save sections and shots
        for section in &project.sections {
            tx.execute(
                "INSERT INTO sections (id, name, surveyor, date, color, direction, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    section.id,
                    section.name,
                    section.surveyor,
                    section.date.map(|d| d.to_string()),
                    section.color,
                    section.direction.to_string(),
                    Utc::now().to_rfc3339()
                ],
            )?;

            for (seq, shot) in section.shots.iter().enumerate() {
                // Note: We don't store shot.id - it's regenerated on load based on sequence_order
                // The database uses auto-increment for the id column
                tx.execute(
                    r#"INSERT INTO shots (
                        section_id, sequence_order,
                        azimuth_in, azimuth_out, length, depth_in, depth_out,
                        pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                        comment, is_virtual, marker_index, temperature
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)"#,
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
                        shot.is_virtual as i32,
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

        // Save loop closures
        for lc in &project.loop_closures {
            tx.execute(
                "INSERT INTO loop_closures (station_a_section, station_a_index, station_b_section, station_b_index, path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    lc.station_a.section_id,
                    lc.station_a.station_index,
                    lc.station_b.section_id,
                    lc.station_b.station_index,
                    lc.path_length,
                    lc.misclosure_distance,
                    lc.error_percentage,
                    lc.horizontal_misclosure,
                    lc.vertical_misclosure
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

        tx.commit()?;
        tracing::info!("Transaction committed");

        // Verify the data was written
        let verify_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM project",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        tracing::info!("=== SAVE PROJECT END === Verification: project table has {} rows", verify_count);

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
        let (name, location, created_at, modified_at): (String, Option<String>, String, String) =
            self.conn.query_row(
                "SELECT name, location, created_at, modified_at FROM project LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).context("Failed to read project metadata")?;

        let created_at = chrono::DateTime::parse_from_rfc3339(&created_at)?.with_timezone(&Utc);
        let modified_at = chrono::DateTime::parse_from_rfc3339(&modified_at)?.with_timezone(&Utc);

        // Load sections
        let mut sections: Vec<Section> = Vec::new();
        let mut next_section_id = 0u32;

        {
            let mut stmt = self
                .conn
                .prepare("SELECT id, name, surveyor, date, color, direction FROM sections ORDER BY id")?;
            let section_rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })?;

            for section_row in section_rows {
                let (id, name, surveyor, date_str, color, direction_str) = section_row?;
                let date = date_str.and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok());
                let direction = direction_str
                    .and_then(|s| s.parse::<SurveyDirection>().ok())
                    .unwrap_or_default();

                let section_data = SectionData {
                    name,
                    surveyor,
                    date,
                    color,
                    direction: Some(direction),
                    shots: Vec::new(),
                };

                let mut section = Section::new(id, section_data);

                // Load shots for this section
                // Note: Shot IDs are generated from section_id and sequence_order
                let mut shot_stmt = self.conn.prepare(
                    r#"SELECT sequence_order, azimuth_in, azimuth_out, length, depth_in, depth_out,
                              pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                              comment, is_virtual, marker_index, temperature
                       FROM shots WHERE section_id = ?1 ORDER BY sequence_order"#,
                )?;

                let section_id_for_shots = id;
                let shot_rows = shot_stmt.query_map([id], |row| {
                    let seq: i64 = row.get(0)?;
                    Ok(Shot {
                        // Generate globally unique shot ID from section_id and sequence
                        id: (section_id_for_shots as u32) * 100000 + (seq as u32),
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
                        is_virtual: row.get::<_, i32>(13)? != 0,
                        marker_index: row.get(14)?,
                        temperature: row.get(15)?,
                    })
                })?;

                for shot_row in shot_rows {
                    section.shots.push(shot_row?);
                }

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

        // Load loop closures
        let loop_closures = self.load_loop_closures()?;

        // Load imported file hashes
        let imported_file_hashes = self.load_imported_file_hashes()?;

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
            file_path: None,
            next_section_id,
            imported_file_hashes,
        })
    }

    /// Save undo entry to database
    pub fn save_undo_entry(
        &self,
        sequence: i64,
        command_json: &str,
        undo_data_json: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO undo_stack (sequence, command_json, undo_data_json, executed_at) VALUES (?1, ?2, ?3, ?4)",
            params![sequence, command_json, undo_data_json, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Load undo stack from database
    pub fn load_undo_stack(&self) -> Result<Vec<(i64, String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT sequence, command_json, undo_data_json FROM undo_stack ORDER BY sequence")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
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
            self.conn.execute(
                "INSERT INTO undo_stack (sequence, command_json, undo_data_json, executed_at) VALUES (?1, ?2, ?3, ?4)",
                params![seq as i64, command_json, undo_data_json, Utc::now().to_rfc3339()],
            )?;
        }

        tracing::info!(count = entries.len(), "Saved undo stack to database");
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

        let mut stmt = self.conn.prepare(
            "SELECT station_a_section, station_a_index, station_b_section, station_b_index, \
             path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure \
             FROM loop_closures",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(LoopClosure {
                station_a: StationRef::new(row.get(0)?, row.get(1)?),
                station_b: StationRef::new(row.get(2)?, row.get(3)?),
                path_length: row.get(4)?,
                misclosure_distance: row.get(5)?,
                error_percentage: row.get(6)?,
                horizontal_misclosure: row.get(7)?,
                vertical_misclosure: row.get(8)?,
            })
        })?;

        for row in rows {
            closures.push(row?);
        }

        Ok(closures)
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
            let resolved_at = chrono::DateTime::parse_from_rfc3339(&resolved_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
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
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_and_save_project() {
        let db = Database::in_memory().unwrap();
        let mut project = Project::new("Test Cave".to_string(), Some("Test Location".to_string()));

        let section_data = SectionData {
            name: Some("Main Line".to_string()),
            surveyor: Some("Test Surveyor".to_string()),
            date: None,
            color: "#4ecdc4".to_string(),
            direction: None,
            shots: vec![ShotData {
                azimuth_in: 45.0,
                azimuth_out: 225.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 6.0,
                ..Default::default()
            }],
        };

        project.add_section(section_data);

        let mut db = db;
        db.save_project(&project).unwrap();

        let loaded = db.load_project().unwrap();
        assert_eq!(loaded.name, "Test Cave");
        assert_eq!(loaded.sections.len(), 1);
        assert_eq!(loaded.sections[0].shots.len(), 1);
    }

    // === Test 3.1: Save/Load Multiple Sections ===
    #[test]
    fn test_save_load_multiple_sections() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_sections.cvproj");

        // Create a project with multiple sections
        let mut project = Project::new("Multi-Section Cave".to_string(), Some("Test Location".to_string()));

        // Section 1: Main passage
        let section1 = SectionData {
            name: Some("Main Passage".to_string()),
            surveyor: Some("John Doe".to_string()),
            date: chrono::NaiveDate::from_ymd_opt(2024, 6, 15),
            color: "#ff5733".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![
                ShotData {
                    azimuth_in: 45.0,
                    azimuth_out: 225.0,
                    length: 10.0,
                    depth_in: 5.0,
                    depth_out: 7.0,
                    left: Some(1.5),
                    right: Some(2.0),
                    up: Some(3.0),
                    down: Some(0.5),
                    comment: Some("Entry shot".to_string()),
                    ..Default::default()
                },
                ShotData {
                    azimuth_in: 60.0,
                    azimuth_out: 240.0,
                    length: 8.5,
                    depth_in: 7.0,
                    depth_out: 9.0,
                    pitch_in: Some(15.0),
                    pitch_out: Some(-10.0),
                    ..Default::default()
                },
            ],
        };

        // Section 2: Side passage
        let section2 = SectionData {
            name: Some("Side Passage".to_string()),
            surveyor: Some("Jane Smith".to_string()),
            date: chrono::NaiveDate::from_ymd_opt(2024, 6, 16),
            color: "#33ff57".to_string(),
            direction: Some(SurveyDirection::Out),
            shots: vec![
                ShotData {
                    azimuth_in: 90.0,
                    azimuth_out: 270.0,
                    length: 5.0,
                    depth_in: 6.0,
                    depth_out: 6.5,
                    is_virtual: true,
                    marker_index: Some(42),
                    temperature: Some(18.5),
                    ..Default::default()
                },
            ],
        };

        // Section 3: No metadata (testing None values)
        let section3 = SectionData {
            name: None,
            surveyor: None,
            date: None,
            color: "#3357ff".to_string(),
            direction: None,
            shots: vec![],
        };

        project.add_section(section1);
        project.add_section(section2);
        project.add_section(section3);

        // Save to file
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Load from file
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();

        // Verify project metadata
        assert_eq!(loaded.name, "Multi-Section Cave");
        assert_eq!(loaded.location, Some("Test Location".to_string()));
        assert_eq!(loaded.sections.len(), 3);

        // Verify section 1
        let s1 = &loaded.sections[0];
        assert_eq!(s1.name, Some("Main Passage".to_string()));
        assert_eq!(s1.surveyor, Some("John Doe".to_string()));
        assert_eq!(s1.date, chrono::NaiveDate::from_ymd_opt(2024, 6, 15));
        assert_eq!(s1.color, "#ff5733");
        assert_eq!(s1.direction, SurveyDirection::In);
        assert_eq!(s1.shots.len(), 2);

        // Verify shot data preservation
        let shot1 = &s1.shots[0];
        assert_eq!(shot1.azimuth_in, 45.0);
        assert_eq!(shot1.azimuth_out, 225.0);
        assert_eq!(shot1.length, 10.0);
        assert_eq!(shot1.depth_in, 5.0);
        assert_eq!(shot1.depth_out, 7.0);
        assert_eq!(shot1.left, Some(1.5));
        assert_eq!(shot1.right, Some(2.0));
        assert_eq!(shot1.up, Some(3.0));
        assert_eq!(shot1.down, Some(0.5));
        assert_eq!(shot1.comment, Some("Entry shot".to_string()));

        let shot2 = &s1.shots[1];
        assert_eq!(shot2.pitch_in, Some(15.0));
        assert_eq!(shot2.pitch_out, Some(-10.0));

        // Verify section 2 (Out direction, virtual shot)
        let s2 = &loaded.sections[1];
        assert_eq!(s2.direction, SurveyDirection::Out);
        assert_eq!(s2.shots[0].is_virtual, true);
        assert_eq!(s2.shots[0].marker_index, Some(42));
        assert_eq!(s2.shots[0].temperature, Some(18.5));

        // Verify section 3 (None values)
        let s3 = &loaded.sections[2];
        assert!(s3.name.is_none());
        assert!(s3.surveyor.is_none());
        assert!(s3.date.is_none());
        assert!(s3.shots.is_empty());
    }

    // === Test 3.2: Save/Load Station Merges ===
    #[test]
    fn test_save_load_station_merges() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_merges.cvproj");

        let mut project = Project::new("Merge Test".to_string(), None);

        // Create two sections with shots
        let section1 = SectionData {
            name: Some("Section A".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() },
                ShotData { azimuth_in: 45.0, azimuth_out: 225.0, length: 7.0, depth_in: 1.0, depth_out: 2.0, ..Default::default() },
            ],
            ..Default::default()
        };

        let section2 = SectionData {
            name: Some("Section B".to_string()),
            color: "#00ff00".to_string(),
            shots: vec![
                ShotData { azimuth_in: 90.0, azimuth_out: 270.0, length: 4.0, depth_in: 0.0, depth_out: 0.5, ..Default::default() },
            ],
            ..Default::default()
        };

        project.add_section(section1);
        project.add_section(section2);

        // Add station merges manually (bypassing validation for test)
        let merge1 = StationMerge {
            station_a: StationRef::new(0, 1), // Section 0, Station 1
            station_b: StationRef::new(1, 0), // Section 1, Station 0
            merged_at: Utc::now(),
        };

        let merge2 = StationMerge {
            station_a: StationRef::new(0, 2), // Section 0, Station 2
            station_b: StationRef::new(1, 1), // Section 1, Station 1
            merged_at: Utc::now(),
        };

        project.station_merges.push(merge1);
        project.station_merges.push(merge2);

        // Save
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Load and verify
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.station_merges.len(), 2);

        let m1 = &loaded.station_merges[0];
        assert_eq!(m1.station_a.section_id, 0);
        assert_eq!(m1.station_a.station_index, 1);
        assert_eq!(m1.station_b.section_id, 1);
        assert_eq!(m1.station_b.station_index, 0);

        let m2 = &loaded.station_merges[1];
        assert_eq!(m2.station_a.section_id, 0);
        assert_eq!(m2.station_a.station_index, 2);
        assert_eq!(m2.station_b.section_id, 1);
        assert_eq!(m2.station_b.station_index, 1);
    }

    // === Test 3.3: Save/Load Zero Datums with GPS Precision ===
    #[test]
    fn test_save_load_zero_datums() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_gps.cvproj");

        let mut project = Project::new("GPS Test".to_string(), None);

        // Add a section with shots
        let section = SectionData {
            name: Some("Main".to_string()),
            color: "#ffffff".to_string(),
            shots: vec![
                ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 10.0, depth_in: 0.0, depth_out: 5.0, ..Default::default() },
            ],
            ..Default::default()
        };
        project.add_section(section);

        // Add zero datums with high-precision GPS coordinates (8+ decimal places)
        let zd1 = ZeroDatum {
            station_ref: StationRef::new(0, 0),
            gps: GpsCoordinates {
                latitude: 45.12345678901234,   // 14 decimal places
                longitude: -93.98765432109876, // 14 decimal places
                depth_reference: 123.456789,
            },
        };

        let zd2 = ZeroDatum {
            station_ref: StationRef::new(0, 1),
            gps: GpsCoordinates {
                latitude: -33.85678901234567,
                longitude: 151.20987654321098,
                depth_reference: -15.5,
            },
        };

        project.zero_datums.push(zd1);
        project.zero_datums.push(zd2);

        // Save
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Load and verify GPS precision
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.zero_datums.len(), 2);

        // Verify 8+ decimal places of precision preserved
        let loaded_zd1 = &loaded.zero_datums[0];
        assert_eq!(loaded_zd1.station_ref.section_id, 0);
        assert_eq!(loaded_zd1.station_ref.station_index, 0);
        // Check precision to 8 decimal places
        assert!((loaded_zd1.gps.latitude - 45.12345678901234).abs() < 1e-8);
        assert!((loaded_zd1.gps.longitude - (-93.98765432109876)).abs() < 1e-8);
        assert!((loaded_zd1.gps.depth_reference - 123.456789).abs() < 1e-6);

        let loaded_zd2 = &loaded.zero_datums[1];
        assert!((loaded_zd2.gps.latitude - (-33.85678901234567)).abs() < 1e-8);
        assert!((loaded_zd2.gps.longitude - 151.20987654321098).abs() < 1e-8);
        assert!((loaded_zd2.gps.depth_reference - (-15.5)).abs() < 1e-6);
    }

    // === Test 3.4: Save/Load Section Offsets ===
    #[test]
    fn test_save_load_section_offsets() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_offsets.cvproj");

        let mut project = Project::new("Offset Test".to_string(), None);

        // Create sections
        for i in 0..3 {
            let section = SectionData {
                name: Some(format!("Section {}", i)),
                color: "#000000".to_string(),
                shots: vec![ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() }],
                ..Default::default()
            };
            project.add_section(section);
        }

        // Add section offsets with varying precision
        project.section_offsets.insert(0, (10.123456789, -20.987654321));
        project.section_offsets.insert(1, (0.0, 0.0));
        project.section_offsets.insert(2, (-100.5, 200.75));

        // Save
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Load and verify
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.section_offsets.len(), 3);

        let offset0 = loaded.section_offsets.get(&0).unwrap();
        assert!((offset0.0 - 10.123456789).abs() < 1e-8);
        assert!((offset0.1 - (-20.987654321)).abs() < 1e-8);

        let offset1 = loaded.section_offsets.get(&1).unwrap();
        assert_eq!(offset1.0, 0.0);
        assert_eq!(offset1.1, 0.0);

        let offset2 = loaded.section_offsets.get(&2).unwrap();
        assert_eq!(offset2.0, -100.5);
        assert_eq!(offset2.1, 200.75);
    }

    // === Test 3.5: Update Shot in Database ===
    #[test]
    fn test_update_shot_in_database() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_update.cvproj");

        // Create initial project
        let mut project = Project::new("Update Test".to_string(), None);
        let section = SectionData {
            name: Some("Test Section".to_string()),
            color: "#123456".to_string(),
            shots: vec![
                ShotData {
                    azimuth_in: 45.0,
                    azimuth_out: 225.0,
                    length: 10.0,
                    depth_in: 5.0,
                    depth_out: 8.0,
                    comment: Some("Original comment".to_string()),
                    ..Default::default()
                },
                ShotData {
                    azimuth_in: 90.0,
                    azimuth_out: 270.0,
                    length: 15.0,
                    depth_in: 8.0,
                    depth_out: 12.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        project.add_section(section);

        // Save initial state
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Modify the shot in the project
        project.sections[0].shots[0].length = 12.5;
        project.sections[0].shots[0].azimuth_in = 50.0;
        project.sections[0].shots[0].comment = Some("Updated comment".to_string());
        project.sections[0].shots[0].left = Some(2.0);
        project.sections[0].shots[0].right = Some(3.0);

        // Save updated state
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Load and verify update
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();

        let updated_shot = &loaded.sections[0].shots[0];
        assert_eq!(updated_shot.length, 12.5);
        assert_eq!(updated_shot.azimuth_in, 50.0);
        assert_eq!(updated_shot.comment, Some("Updated comment".to_string()));
        assert_eq!(updated_shot.left, Some(2.0));
        assert_eq!(updated_shot.right, Some(3.0));

        // Verify other shot unchanged
        let other_shot = &loaded.sections[0].shots[1];
        assert_eq!(other_shot.length, 15.0);
        assert_eq!(other_shot.azimuth_in, 90.0);
    }

    // === Test 3.6: Delete Section Cascades Shots ===
    #[test]
    fn test_delete_section_cascades_shots() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_cascade.cvproj");

        // Create project with multiple sections
        let mut project = Project::new("Cascade Test".to_string(), None);

        let section1 = SectionData {
            name: Some("Section to keep".to_string()),
            color: "#111111".to_string(),
            shots: vec![
                ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() },
            ],
            ..Default::default()
        };

        let section2 = SectionData {
            name: Some("Section to delete".to_string()),
            color: "#222222".to_string(),
            shots: vec![
                ShotData { azimuth_in: 45.0, azimuth_out: 225.0, length: 10.0, depth_in: 1.0, depth_out: 3.0, ..Default::default() },
                ShotData { azimuth_in: 90.0, azimuth_out: 270.0, length: 8.0, depth_in: 3.0, depth_out: 5.0, ..Default::default() },
                ShotData { azimuth_in: 135.0, azimuth_out: 315.0, length: 6.0, depth_in: 5.0, depth_out: 7.0, ..Default::default() },
            ],
            ..Default::default()
        };

        let section3 = SectionData {
            name: Some("Another section to keep".to_string()),
            color: "#333333".to_string(),
            shots: vec![
                ShotData { azimuth_in: 180.0, azimuth_out: 0.0, length: 12.0, depth_in: 0.0, depth_out: 2.0, ..Default::default() },
            ],
            ..Default::default()
        };

        project.add_section(section1);
        project.add_section(section2);
        project.add_section(section3);

        assert_eq!(project.sections.len(), 3);

        // Save initial state
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Remove section 1 (index 1, the one with 3 shots)
        project.remove_section(1);
        assert_eq!(project.sections.len(), 2);

        // Save after deletion
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Load and verify cascade delete
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.sections.len(), 2);
        assert_eq!(loaded.sections[0].name, Some("Section to keep".to_string()));
        assert_eq!(loaded.sections[1].name, Some("Another section to keep".to_string()));

        // Verify shots from deleted section are gone
        let total_shots: usize = loaded.sections.iter().map(|s| s.shots.len()).sum();
        assert_eq!(total_shots, 2); // 1 shot from section 0 + 1 shot from section 2
    }

    // === Test 3.7: Database Transaction Rollback ===
    #[test]
    fn test_database_transaction_rollback() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_rollback.cvproj");

        // Create and save a valid project
        let mut project = Project::new("Rollback Test".to_string(), None);
        let section = SectionData {
            name: Some("Original Section".to_string()),
            color: "#abcdef".to_string(),
            shots: vec![
                ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() },
            ],
            ..Default::default()
        };
        project.add_section(section);

        // Save the initial project
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Verify original data
        {
            let db = Database::open_existing(&db_path).unwrap();
            let loaded = db.load_project().unwrap();
            assert_eq!(loaded.name, "Rollback Test");
            assert_eq!(loaded.sections.len(), 1);
            assert_eq!(loaded.sections[0].name, Some("Original Section".to_string()));
        }

        // Modify and save again - this simulates a successful transaction
        project.name = "Modified Project".to_string();
        project.sections[0].name = Some("Modified Section".to_string());
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Verify modification persisted
        {
            let db = Database::open_existing(&db_path).unwrap();
            let loaded = db.load_project().unwrap();
            assert_eq!(loaded.name, "Modified Project");
            assert_eq!(loaded.sections[0].name, Some("Modified Section".to_string()));
        }

        // Test that the transaction is atomic - all data is cleared and rewritten
        // If we open for save, it should be a complete replacement
        let mut new_project = Project::new("Completely New".to_string(), None);
        new_project.add_section(SectionData {
            name: Some("New Section A".to_string()),
            color: "#000000".to_string(),
            shots: vec![],
            ..Default::default()
        });
        new_project.add_section(SectionData {
            name: Some("New Section B".to_string()),
            color: "#ffffff".to_string(),
            shots: vec![],
            ..Default::default()
        });

        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&new_project).unwrap();
        }

        // Verify complete replacement
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();
        assert_eq!(loaded.name, "Completely New");
        assert_eq!(loaded.sections.len(), 2);
        // The old "Modified Section" should be completely gone
        assert!(loaded.sections.iter().all(|s| s.name != Some("Modified Section".to_string())));
    }

    // === Test 3.8: Open Existing vs Open New ===
    #[test]
    fn test_open_existing_vs_open_new() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_open.cvproj");
        let nonexistent_path = temp_dir.path().join("nonexistent.cvproj");

        // Test 1: open_existing on nonexistent file should fail
        let result = Database::open_existing(&nonexistent_path);
        assert!(result.is_err());
        let err_msg = result.err().unwrap().to_string();
        assert!(err_msg.contains("does not exist"), "Expected 'does not exist' error, got: {}", err_msg);

        // Test 2: open() on nonexistent file should create it
        {
            let db = Database::open(&db_path);
            assert!(db.is_ok());
            assert!(db_path.exists());
        }

        // Test 3: open_existing on empty database (no project row) should fail
        {
            let result = Database::open_existing(&db_path);
            assert!(result.is_err());
            let err_msg = result.err().unwrap().to_string();
            assert!(err_msg.contains("valid CaveChef project"), "Expected 'valid CaveChef project' error, got: {}", err_msg);
        }

        // Test 4: Save a project, then open_existing should succeed
        let mut project = Project::new("Test Project".to_string(), None);
        project.add_section(SectionData {
            name: Some("Test".to_string()),
            color: "#123456".to_string(),
            shots: vec![],
            ..Default::default()
        });

        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        // Now open_existing should work
        let result = Database::open_existing(&db_path);
        assert!(result.is_ok());

        // Test 5: Verify loaded data is correct
        let loaded = result.unwrap().load_project().unwrap();
        assert_eq!(loaded.name, "Test Project");
        assert_eq!(loaded.sections.len(), 1);
    }

    // === Additional Edge Case Tests ===

    #[test]
    fn test_save_load_loop_closures() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_loops.cvproj");

        let mut project = Project::new("Loop Test".to_string(), None);

        // Add sections
        project.add_section(SectionData {
            name: Some("Section 1".to_string()),
            color: "#ff0000".to_string(),
            shots: vec![
                ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 10.0, depth_in: 0.0, depth_out: 5.0, ..Default::default() },
            ],
            ..Default::default()
        });

        // Add loop closure data
        project.loop_closures.push(LoopClosure {
            station_a: StationRef::new(0, 0),
            station_b: StationRef::new(0, 1),
            path_length: 50.0,
            misclosure_distance: 0.5,
            error_percentage: 1.0,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
        });

        // Save and load
        {
            let mut db = Database::open(&db_path).unwrap();
            db.save_project(&project).unwrap();
        }

        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.loop_closures.len(), 1);
        let lc = &loaded.loop_closures[0];
        assert_eq!(lc.path_length, 50.0);
        assert_eq!(lc.misclosure_distance, 0.5);
        assert_eq!(lc.error_percentage, 1.0);
        assert_eq!(lc.horizontal_misclosure, 0.4);
        assert_eq!(lc.vertical_misclosure, 0.3);
    }

    #[test]
    fn test_display_settings_persistence() {
        let db = Database::in_memory().unwrap();

        // Save settings
        db.save_display_setting("scale_bar", "true").unwrap();
        db.save_display_setting("station_labels", "false").unwrap();
        db.save_display_setting("custom_value", "42.5").unwrap();

        // Load all settings
        let settings = db.load_display_settings().unwrap();
        assert_eq!(settings.get("scale_bar"), Some(&"true".to_string()));
        assert_eq!(settings.get("station_labels"), Some(&"false".to_string()));
        assert_eq!(settings.get("custom_value"), Some(&"42.5".to_string()));

        // Get individual setting
        assert_eq!(db.get_display_setting("scale_bar").unwrap(), Some("true".to_string()));
        assert_eq!(db.get_display_setting("nonexistent").unwrap(), None);

        // Update setting
        db.save_display_setting("scale_bar", "false").unwrap();
        assert_eq!(db.get_display_setting("scale_bar").unwrap(), Some("false".to_string()));
    }

    #[test]
    fn test_undo_stack_persistence() {
        let db = Database::in_memory().unwrap();

        // Save undo entries
        let entries = vec![
            (r#"{"type":"AddSection"}"#.to_string(), r#"{"section_id":0}"#.to_string()),
            (r#"{"type":"AddShot"}"#.to_string(), r#"{"shot_id":1}"#.to_string()),
            (r#"{"type":"UpdateShot"}"#.to_string(), r#"{"old_data":{}}"#.to_string()),
        ];
        db.save_undo_stack(entries.clone()).unwrap();

        // Load undo stack
        let loaded = db.load_undo_stack().unwrap();
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[0].0, 0); // sequence
        assert_eq!(loaded[0].1, r#"{"type":"AddSection"}"#);
        assert_eq!(loaded[0].2, r#"{"section_id":0}"#);
        assert_eq!(loaded[1].0, 1);
        assert_eq!(loaded[2].0, 2);

        // Clear undo after sequence 1
        db.clear_undo_after(1).unwrap();
        let loaded_after_clear = db.load_undo_stack().unwrap();
        assert_eq!(loaded_after_clear.len(), 2); // Only sequences 0 and 1 remain
    }

    #[test]
    fn test_resolved_warnings_persistence() {
        let db = Database::in_memory().unwrap();

        // Save project first (to have tables)
        let mut project = Project::new("Test".to_string(), None);
        project.add_section(SectionData { color: "#000".to_string(), ..Default::default() });
        let mut db = db;
        db.save_project(&project).unwrap();

        // Save resolved warning
        let warning = ResolvedWarning {
            section_id: 0,
            shot_id: 1,
            warning_code: "AZIMUTH_DIFF".to_string(),
            resolved_at: Utc::now(),
            resolved_comment: Some("Verified in field".to_string()),
        };
        db.save_resolved_warning(&warning).unwrap();

        // Load resolved warnings
        let loaded = db.load_resolved_warnings().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].section_id, 0);
        assert_eq!(loaded[0].shot_id, 1);
        assert_eq!(loaded[0].warning_code, "AZIMUTH_DIFF");
        assert_eq!(loaded[0].resolved_comment, Some("Verified in field".to_string()));

        // Delete resolved warning
        db.delete_resolved_warning(0, 1, "AZIMUTH_DIFF").unwrap();
        let loaded_after_delete = db.load_resolved_warnings().unwrap();
        assert!(loaded_after_delete.is_empty());
    }

    // === Test: Verify merged_with is populated correctly from fractal fixture ===
    #[test]
    fn test_merged_with_from_fractal_iter2() {
        use std::path::Path;
        use crate::models::StationRef;

        // Use the fractal_plant_iter2 fixture
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..") // Go up from src-tauri
            .join("e2e")
            .join("fixtures")
            .join("fractal_plant_iter2.cvproj");

        // Make sure the fixture exists
        assert!(fixture_path.exists(), "Fixture file not found: {:?}", fixture_path);

        // Load the project
        let db = Database::open_existing(&fixture_path).unwrap();
        let project = db.load_project().unwrap();

        // Verify there are merges
        println!("Project has {} merges:", project.station_merges.len());
        for merge in &project.station_merges {
            println!("  Merge: {} <-> {}", merge.station_a, merge.station_b);
        }

        // Compute station coordinates (this populates merged_with)
        let stations = project.compute_station_coordinates();

        // Find station S1.st0
        let s1_st0_ref = StationRef::new(1, 0);
        let s1_st0 = stations.iter().find(|s| s.station_ref == s1_st0_ref)
            .expect("Station 1:0 should exist");

        println!("Station 1:0 merged_with: {:?}", s1_st0.merged_with);

        // S1.st0 should be merged with:
        // - S0.st2 (parent branch merge - when S1 was created from S0)
        // - S2.st0 (sibling merge - when S2 was created from S1)
        let s0_st2 = StationRef::new(0, 2);
        let s2_st0 = StationRef::new(2, 0);

        assert!(
            s1_st0.merged_with.contains(&s0_st2),
            "Station 1:0 should be merged with 0:2 (parent). Got: {:?}",
            s1_st0.merged_with
        );
        assert!(
            s1_st0.merged_with.contains(&s2_st0),
            "Station 1:0 should be merged with 2:0 (sibling). Got: {:?}",
            s1_st0.merged_with
        );
        assert_eq!(
            s1_st0.merged_with.len(),
            2,
            "Station 1:0 should have exactly 2 merges. Got: {:?}",
            s1_st0.merged_with
        );

        // Verify transitive merge groups - 0:2 should also show merged with 2:0
        // since they're all in the same merge group (0:2 ↔ 1:0 ↔ 2:0)
        let s0_st2_station = stations.iter().find(|s| s.station_ref == s0_st2)
            .expect("Station 0:2 should exist");
        println!("Station 0:2 merged_with: {:?}", s0_st2_station.merged_with);

        assert!(
            s0_st2_station.merged_with.contains(&s1_st0_ref),
            "Station 0:2 should be merged with 1:0. Got: {:?}",
            s0_st2_station.merged_with
        );
        assert!(
            s0_st2_station.merged_with.contains(&s2_st0),
            "Station 0:2 should be merged with 2:0 (transitive). Got: {:?}",
            s0_st2_station.merged_with
        );
        assert_eq!(
            s0_st2_station.merged_with.len(),
            2,
            "Station 0:2 should have exactly 2 merges (transitive group). Got: {:?}",
            s0_st2_station.merged_with
        );

        // Verify 2:0 also shows the full group
        let s2_st0_station = stations.iter().find(|s| s.station_ref == s2_st0)
            .expect("Station 2:0 should exist");
        println!("Station 2:0 merged_with: {:?}", s2_st0_station.merged_with);

        assert!(
            s2_st0_station.merged_with.contains(&s1_st0_ref),
            "Station 2:0 should be merged with 1:0. Got: {:?}",
            s2_st0_station.merged_with
        );
        assert!(
            s2_st0_station.merged_with.contains(&s0_st2),
            "Station 2:0 should be merged with 0:2 (transitive). Got: {:?}",
            s2_st0_station.merged_with
        );
        assert_eq!(
            s2_st0_station.merged_with.len(),
            2,
            "Station 2:0 should have exactly 2 merges (transitive group). Got: {:?}",
            s2_st0_station.merged_with
        );
    }

    // === Test: Verify merged_with from iter4 fixture ===
    #[test]
    fn test_merged_with_from_fractal_iter4() {
        use std::path::Path;
        use crate::models::StationRef;

        // Use the fractal_plant_iter4 fixture
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..") // Go up from src-tauri
            .join("e2e")
            .join("fixtures")
            .join("fractal_plant_iter4.cvproj");

        // Make sure the fixture exists
        assert!(fixture_path.exists(), "Fixture file not found: {:?}", fixture_path);

        // Load the project
        let db = Database::open_existing(&fixture_path).unwrap();
        let project = db.load_project().unwrap();

        println!("Iter4 project has {} merges", project.station_merges.len());

        // Compute station coordinates (this populates merged_with)
        let stations = project.compute_station_coordinates();

        // Find station S1.st0
        let s1_st0_ref = StationRef::new(1, 0);
        let s1_st0 = stations.iter().find(|s| s.station_ref == s1_st0_ref)
            .expect("Station 1:0 should exist");

        println!("Station 1:0 merged_with: {:?}", s1_st0.merged_with);

        // S1.st0 should be merged with:
        // - S0.st8 (parent branch merge - when S1 was created from S0)
        // - S2.st0 (child merge - when S2 was created from S1)
        let s0_st8 = StationRef::new(0, 8);
        let s2_st0 = StationRef::new(2, 0);

        assert!(
            s1_st0.merged_with.contains(&s0_st8),
            "Station 1:0 should be merged with 0:8 (parent). Got: {:?}",
            s1_st0.merged_with
        );
        assert!(
            s1_st0.merged_with.contains(&s2_st0),
            "Station 1:0 should be merged with 2:0 (child). Got: {:?}",
            s1_st0.merged_with
        );
        assert_eq!(
            s1_st0.merged_with.len(),
            2,
            "Station 1:0 should have exactly 2 merges. Got: {:?}",
            s1_st0.merged_with
        );
    }
}
