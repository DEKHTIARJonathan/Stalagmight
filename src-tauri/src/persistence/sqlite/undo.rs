use anyhow::{Context, Result};
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

    /// [#303] Empty the undo/redo tables in the `.stalx` at `path`, without opening it
    /// as a full [`Database`].
    ///
    /// For the download-replace chokepoint: a freshly-extracted server copy carries the
    /// pusher's history (Full mode ships it deliberately), and every implicit adopt path
    /// must drop it - see `InheritedUndo`. Deliberately a BARE connection rather than
    /// `open_existing`: this runs on a file that is about to be opened properly, and
    /// `open_existing` would run the integrity check and the whole migration chain on it
    /// twice, as well as taking a read-write connection with its 256 MB mmap.
    ///
    /// A missing table is not an error - an older snapshot shape simply has none.
    pub fn clear_undo_history_at(path: &std::path::Path) -> Result<()> {
        let conn = rusqlite::Connection::open(path)
            .with_context(|| format!("open {} to clear inherited undo", path.display()))?;
        for table in ["undo_stack", "redo_stack"] {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                params![table],
                |row| row.get(0),
            )?;
            if exists > 0 {
                conn.execute(&format!("DELETE FROM {table}"), [])
                    .with_context(|| format!("clear {table} in {}", path.display()))?;
            }
        }
        Ok(())
    }

    /// Save undo stack with timestamps (clear existing and save new entries)
    ///
    /// [#303] DELETE-all-then-INSERT-all, with `sequence` renumbered 0..n, is the whole
    /// of it - there is no incremental variant, and an earlier attempt at one silently
    /// dropped the history. See [`crate::core::UndoStack::rows_to_persist`] for why the
    /// save pipeline leaves nothing to be incremental about.
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
    ///
    /// [#303] The redo twin of [`Self::save_undo_stack_with_timestamps`], same shape and
    /// same reasoning. Note that a Full-mode linked project hands this an EMPTY vector
    /// (`persist_undo_stacks_into`), so for those projects it degenerates to a clear.
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
