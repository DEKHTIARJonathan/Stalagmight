use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};

use super::{compress_json, decompress_json, Database};

type CompressedHistoryRow = (i64, Vec<u8>, Vec<u8>, Option<String>);
type HistoryRow = (i64, String, String, Option<String>);

const MAX_DECOMPRESS_THREADS: usize = 8;

fn rows_per_decompress_batch() -> usize {
    let available = std::thread::available_parallelism().map_or(2, usize::from);
    available.clamp(2, MAX_DECOMPRESS_THREADS) / 2
}

fn decompress_history_rows(
    raw: Vec<CompressedHistoryRow>,
    stack_name: &'static str,
) -> Result<Vec<HistoryRow>> {
    let mut entries = Vec::with_capacity(raw.len());
    for batch in raw.chunks(rows_per_decompress_batch()) {
        let decoded: Result<Vec<_>> = std::thread::scope(|scope| {
            let handles: Vec<_> = batch
                .iter()
                .map(|(seq, cmd_bytes, undo_bytes, ts)| {
                    let h_cmd = scope.spawn(move || decompress_json(cmd_bytes));
                    let h_undo = scope.spawn(move || decompress_json(undo_bytes));
                    (*seq, h_cmd, h_undo, ts.clone())
                })
                .collect();
            handles
                .into_iter()
                .map(|(seq, h_cmd, h_undo, ts)| {
                    let cmd = h_cmd.join().map_err(|_| {
                        anyhow::anyhow!("{stack_name} decompress thread panicked")
                    })??;
                    let undo = h_undo.join().map_err(|_| {
                        anyhow::anyhow!("{stack_name} decompress thread panicked")
                    })??;
                    Ok((seq, cmd, undo, ts))
                })
                .collect()
        });
        entries.extend(decoded?);
    }
    Ok(entries)
}

impl Database {
    pub fn replace_history_stacks_with_timestamps(
        &self,
        undo_entries: Vec<(String, String, Option<String>)>,
        redo_entries: Vec<(String, String, Option<String>)>,
    ) -> Result<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .context("begin undo/redo replacement transaction")?;
        tx.execute("DELETE FROM undo_stack", [])?;
        tx.execute("DELETE FROM redo_stack", [])?;

        for (seq, (command_json, undo_data_json, timestamp)) in undo_entries.iter().enumerate() {
            tx.execute(
                "INSERT INTO undo_stack (sequence, command_json, undo_data_json, executed_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    seq as i64,
                    compress_json(command_json),
                    compress_json(undo_data_json),
                    timestamp.clone().unwrap_or_else(|| Utc::now().to_rfc3339()),
                ],
            )?;
        }
        for (seq, (command_json, undo_data_json, timestamp)) in redo_entries.iter().enumerate() {
            tx.execute(
                "INSERT INTO redo_stack (sequence, command_json, undo_data_json, executed_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    seq as i64,
                    compress_json(command_json),
                    compress_json(undo_data_json),
                    timestamp.clone().unwrap_or_else(|| Utc::now().to_rfc3339()),
                ],
            )?;
        }
        tx.commit().context("commit undo/redo replacement")?;
        Ok(())
    }

    pub fn clear_history_stacks(&self) -> Result<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .context("begin undo/redo clear transaction")?;
        tx.execute("DELETE FROM undo_stack", [])?;
        tx.execute("DELETE FROM redo_stack", [])?;
        tx.commit().context("commit undo/redo clear")?;
        Ok(())
    }

    /// Newest undo timestamp persisted in this database, without decompressing payloads.
    pub fn newest_undo_timestamp(&self) -> Result<Option<DateTime<Utc>>> {
        let raw = self
            .conn
            .query_row(
                "SELECT executed_at FROM undo_stack ORDER BY sequence DESC LIMIT 1",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        raw.map(|stamp| {
            DateTime::parse_from_rfc3339(&stamp)
                .map(|parsed| parsed.with_timezone(&Utc))
                .with_context(|| format!("invalid newest undo timestamp `{stamp}`"))
        })
        .transpose()
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

        // Decompress independent blobs in bounded batches. Large snapshot payloads
        // still use multiple cores, but a deep Full-mode history cannot create two
        // operating-system threads for every row at once.
        let mut raw: Vec<CompressedHistoryRow> = Vec::new();
        for row in rows {
            raw.push(row?);
        }
        decompress_history_rows(raw, "undo")
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
        let tx = conn
            .unchecked_transaction()
            .with_context(|| format!("begin inherited-history cleanup in {}", path.display()))?;
        for table in [
            "undo_stack",
            "redo_stack",
            "speleo_undo_chain",
            "speleo_undo_watermark",
        ] {
            let exists: i64 = tx.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                params![table],
                |row| row.get(0),
            )?;
            if exists > 0 {
                tx.execute(&format!("DELETE FROM {table}"), [])
                    .with_context(|| format!("clear {table} in {}", path.display()))?;
            }
        }
        tx.commit()
            .with_context(|| format!("commit inherited-history cleanup in {}", path.display()))?;
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
        let mut raw: Vec<CompressedHistoryRow> = Vec::new();
        for row in rows {
            raw.push(row?);
        }
        decompress_history_rows(raw, "redo")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decompression_batch_never_exceeds_the_thread_cap() {
        assert!(rows_per_decompress_batch() >= 1);
        assert!(rows_per_decompress_batch() * 2 <= MAX_DECOMPRESS_THREADS);
    }

    #[test]
    fn replacing_both_history_stacks_rolls_back_when_redo_insert_fails() {
        let db = Database::in_memory().unwrap();
        let old = |name: &str| {
            (
                format!(r#"{{"type":"{name}"}}"#),
                r#"{"kind":"old"}"#.to_owned(),
                Some("2026-08-01T00:00:00+00:00".to_owned()),
            )
        };
        db.save_undo_stack_with_timestamps(vec![old("OldUndo")])
            .unwrap();
        db.save_redo_stack_with_timestamps(vec![old("OldRedo")])
            .unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER reject_redo_insert BEFORE INSERT ON redo_stack \
                 BEGIN SELECT RAISE(FAIL, 'redo rejected'); END;",
            )
            .unwrap();

        let result =
            db.replace_history_stacks_with_timestamps(vec![old("NewUndo")], vec![old("NewRedo")]);

        assert!(result.is_err());
        assert_eq!(
            db.load_undo_stack_with_timestamps().unwrap()[0].1,
            r#"{"type":"OldUndo"}"#
        );
        assert_eq!(
            db.load_redo_stack_with_timestamps().unwrap()[0].1,
            r#"{"type":"OldRedo"}"#
        );
    }
}
