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

    /// [#303] Apply one stack's [`PersistPlan`] incrementally.
    ///
    /// The DELETE-everything-then-re-INSERT-everything shape this replaces re-gzipped
    /// the whole persisted stack on every save, including the 30s autosave. That is
    /// affordable for a 20-entry window and ruinous for a byte-budgeted one - a
    /// delete-heavy session's whole-project snapshots are megabytes each, so a save
    /// became seconds of compression. Here a save touches only what changed:
    ///
    /// 1. delete every row outside the surviving id range (entries popped by an undo,
    ///    or evicted from the front by a trim), and
    /// 2. upsert the plan's rows, which are only those at or after the first id whose
    ///    content may differ.
    ///
    /// `sequence` carries the stable id, so `ORDER BY sequence` still reproduces stack
    /// order and the on-disk shape is unchanged. Rows are re-inserted rather than
    /// UPDATEd because `sequence` has no unique index (the table is keyed by rowid), so
    /// a delete-then-insert of just the rewritten range is both correct and cheap.
    fn sync_stack_plan(&self, table: &str, plan: &crate::core::PersistPlan) -> Result<()> {
        // Stale rows: anything outside the range memory still holds. An empty stack has
        // no range, so everything goes.
        match plan.keep_range {
            Some((first, last)) => {
                self.conn.execute(
                    &format!("DELETE FROM {table} WHERE sequence < ?1 OR sequence > ?2"),
                    params![first as i64, last as i64],
                )?;
            }
            None => {
                self.conn.execute(&format!("DELETE FROM {table}"), [])?;
            }
        }
        if plan.rows.is_empty() {
            return Ok(());
        }
        // Clear the range being rewritten, then write it. Both statements are scoped to
        // the rewritten ids, so rows below it keep their existing (already compressed)
        // blobs untouched - the entire point.
        let lowest = plan.rows.iter().map(|r| r.id).min().unwrap_or(0);
        self.conn.execute(
            &format!("DELETE FROM {table} WHERE sequence >= ?1"),
            params![lowest as i64],
        )?;
        for row in &plan.rows {
            let executed_at = row
                .timestamp
                .clone()
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            self.conn.execute(
                &format!(
                    "INSERT INTO {table} (sequence, command_json, undo_data_json, executed_at) \
                     VALUES (?1, ?2, ?3, ?4)"
                ),
                params![
                    row.id as i64,
                    compress_json(&row.command_json),
                    compress_json(&row.undo_data_json),
                    executed_at
                ],
            )?;
        }
        tracing::debug!(
            table,
            written = plan.rows.len(),
            "Synced stack rows to database"
        );
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

    /// [#303] `sync_stack_plan` for the undo stack.
    pub fn sync_undo_stack(&self, plan: &crate::core::PersistPlan) -> Result<()> {
        self.sync_stack_plan("undo_stack", plan)
    }

    /// [#303] `sync_stack_plan` for the redo stack.
    pub fn sync_redo_stack(&self, plan: &crate::core::PersistPlan) -> Result<()> {
        self.sync_stack_plan("redo_stack", plan)
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
