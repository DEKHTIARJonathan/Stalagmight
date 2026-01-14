use anyhow::{Context, Result};
use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection};
use std::path::Path;

use crate::models::{
    GpsCoordinates, Project, Section, SectionData, Shot, StationMerge, StationRef, ZeroDatum,
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
        let conn = Connection::open(path).context("Failed to open database")?;
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
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

            -- Undo/redo stack
            CREATE TABLE IF NOT EXISTS undo_stack (
                id INTEGER PRIMARY KEY,
                sequence INTEGER NOT NULL,
                command_json TEXT NOT NULL,
                undo_data_json TEXT NOT NULL,
                executed_at TEXT NOT NULL
            );

            -- Display settings
            CREATE TABLE IF NOT EXISTS display_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
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
        let tx = self.conn.transaction()?;

        // Clear existing data
        tx.execute_batch(
            r#"
            DELETE FROM project;
            DELETE FROM sections;
            DELETE FROM shots;
            DELETE FROM station_merges;
            DELETE FROM zero_datums;
            "#,
        )?;

        // Save project metadata
        tx.execute(
            "INSERT INTO project (id, name, location, created_at, modified_at, schema_version) VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            params![
                project.name,
                project.location,
                project.created_at.to_rfc3339(),
                project.modified_at.to_rfc3339(),
                SCHEMA_VERSION
            ],
        )?;

        // Save sections and shots
        for section in &project.sections {
            tx.execute(
                "INSERT INTO sections (id, name, surveyor, date, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    section.id,
                    section.name,
                    section.surveyor,
                    section.date.map(|d| d.to_string()),
                    section.color,
                    Utc::now().to_rfc3339()
                ],
            )?;

            for (seq, shot) in section.shots.iter().enumerate() {
                tx.execute(
                    r#"INSERT INTO shots (
                        id, section_id, sequence_order,
                        azimuth_in, azimuth_out, length, depth_in, depth_out,
                        pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                        comment, is_virtual, marker_index, temperature
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"#,
                    params![
                        shot.id,
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

        tx.commit()?;
        tracing::info!("Project saved successfully");
        Ok(())
    }

    /// Load a project from the database
    pub fn load_project(&self) -> Result<Project> {
        // Load project metadata
        let (name, location, created_at, modified_at): (String, Option<String>, String, String) =
            self.conn.query_row(
                "SELECT name, location, created_at, modified_at FROM project WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;

        let created_at = chrono::DateTime::parse_from_rfc3339(&created_at)?.with_timezone(&Utc);
        let modified_at = chrono::DateTime::parse_from_rfc3339(&modified_at)?.with_timezone(&Utc);

        // Load sections
        let mut sections: Vec<Section> = Vec::new();
        let mut next_section_id = 0u32;

        {
            let mut stmt = self
                .conn
                .prepare("SELECT id, name, surveyor, date, color FROM sections ORDER BY id")?;
            let section_rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?;

            for section_row in section_rows {
                let (id, name, surveyor, date_str, color) = section_row?;
                let date = date_str.and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok());

                let section_data = SectionData {
                    name,
                    surveyor,
                    date,
                    color,
                    shots: Vec::new(),
                };

                let mut section = Section::new(id, section_data);

                // Load shots for this section
                let mut shot_stmt = self.conn.prepare(
                    r#"SELECT id, azimuth_in, azimuth_out, length, depth_in, depth_out,
                              pitch_in, pitch_out, left_distance, right_distance, up_distance, down_distance,
                              comment, is_virtual, marker_index, temperature
                       FROM shots WHERE section_id = ?1 ORDER BY sequence_order"#,
                )?;

                let shot_rows = shot_stmt.query_map([id], |row| {
                    Ok(Shot {
                        id: row.get(0)?,
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

        Ok(Project {
            name,
            location,
            created_at,
            modified_at,
            sections,
            station_merges,
            zero_datums,
            file_path: None,
            next_section_id,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_save_project() {
        let db = Database::in_memory().unwrap();
        let mut project = Project::new("Test Cave".to_string(), Some("Test Location".to_string()));

        let section_data = SectionData {
            name: Some("Main Line".to_string()),
            surveyor: Some("Test Surveyor".to_string()),
            date: None,
            color: "#4ecdc4".to_string(),
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
}
