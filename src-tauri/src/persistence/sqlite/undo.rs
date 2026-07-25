use anyhow::Result;
use chrono::Utc;
use rusqlite::params;

use super::{compress_json, decompress_json, Database};

impl Database {
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
        let mut stmt = self.conn.prepare(
            "SELECT sequence, command_json, undo_data_json FROM undo_stack ORDER BY sequence",
        )?;
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
    pub fn load_undo_stack_with_timestamps(
        &self,
    ) -> Result<Vec<(i64, String, String, Option<String>)>> {
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

        // Collect compressed blobs first, then decompress in parallel -
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
                    let cmd = h_cmd
                        .join()
                        .map_err(|_| anyhow::anyhow!("undo decompress thread panicked"))??;
                    let undo = h_undo
                        .join()
                        .map_err(|_| anyhow::anyhow!("undo decompress thread panicked"))??;
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
    pub fn save_undo_stack_with_timestamps(
        &self,
        entries: Vec<(String, String, Option<String>)>,
    ) -> Result<()> {
        // Clear existing
        self.conn.execute("DELETE FROM undo_stack", [])?;

        // Save new entries
        for (seq, (command_json, undo_data_json, timestamp_str)) in entries.iter().enumerate() {
            // Use provided timestamp or fall back to current time
            let executed_at = timestamp_str
                .clone()
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let cmd_compressed = compress_json(command_json);
            let undo_compressed = compress_json(undo_data_json);
            self.conn.execute(
                "INSERT INTO undo_stack (sequence, command_json, undo_data_json, executed_at) VALUES (?1, ?2, ?3, ?4)",
                params![seq as i64, cmd_compressed, undo_compressed, executed_at],
            )?;
        }

        tracing::debug!(
            count = entries.len(),
            "Saved undo stack with timestamps to database"
        );
        Ok(())
    }

    /// Load redo stack from database with timestamps
    pub fn load_redo_stack_with_timestamps(
        &self,
    ) -> Result<Vec<(i64, String, String, Option<String>)>> {
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

        // Parallel gzip decompression of the per-entry blobs - see
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
                    let cmd = h_cmd
                        .join()
                        .map_err(|_| anyhow::anyhow!("redo decompress thread panicked"))??;
                    let undo = h_undo
                        .join()
                        .map_err(|_| anyhow::anyhow!("redo decompress thread panicked"))??;
                    Ok((seq, cmd, undo, ts))
                })
                .collect()
        });
        let entries = entries?;
        Ok(entries)
    }

    /// Save redo stack with timestamps (clear existing and save new entries)
    pub fn save_redo_stack_with_timestamps(
        &self,
        entries: Vec<(String, String, Option<String>)>,
    ) -> Result<()> {
        self.conn.execute("DELETE FROM redo_stack", [])?;

        for (seq, (command_json, undo_data_json, timestamp_str)) in entries.iter().enumerate() {
            let executed_at = timestamp_str
                .clone()
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            let cmd_compressed = compress_json(command_json);
            let undo_compressed = compress_json(undo_data_json);
            self.conn.execute(
                "INSERT INTO redo_stack (sequence, command_json, undo_data_json, executed_at) VALUES (?1, ?2, ?3, ?4)",
                params![seq as i64, cmd_compressed, undo_compressed, executed_at],
            )?;
        }

        Ok(())
    }
}
