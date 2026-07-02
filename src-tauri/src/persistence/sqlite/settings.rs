use anyhow::{Context, Result};
use rusqlite::params;
use rusqlite::types::ValueRef;
use std::collections::HashMap;

use super::{format_blob_placeholder, Database, RawTableData, MAX_RAW_PAGE_ROWS};

impl Database {
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
                let json =
                    serde_json::to_string(state).context("Failed to serialize collab state")?;
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

    /// Upsert or clear the SpeleoDB hand-off link (`speleo_link`, schema v9)
    /// without rewriting the whole project (mirrors
    /// [`save_collab_state`](Self::save_collab_state)). `Some(link)` upserts the
    /// single row id=1; `None` deletes it. `base_commit_sha` binds as
    /// `Option<String>` so `None` becomes SQL NULL — **never** `""` (NULL is the
    /// empty-repo BASE sentinel).
    ///
    /// FRESHNESS-FOLD SEAM (D-B1): #185's get_project/list_projects return the
    /// authoritative Project on every call. The persistence fold (cache the
    /// freshness verdict + reset last_verify_at) is a DOCUMENTED NO-OP until the
    /// #202 piggyback path consumes it. base_commit_sha is captured ONCE on pull
    /// and NEVER mutated by #189 (a later Sync/Release issue re-stamps it).
    pub fn save_speleo_link(&self, link: Option<&crate::models::SpeleoLink>) -> Result<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS speleo_link (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                endpoint TEXT NOT NULL,
                project_id TEXT NOT NULL,
                project_name TEXT NOT NULL,
                base_commit_sha TEXT,
                has_unpushed_edits INTEGER NOT NULL DEFAULT 0,
                last_edit_at TEXT,
                last_verify_at TEXT
            )",
            [],
        )?;
        match link {
            Some(link) => {
                self.conn.execute(
                    "INSERT INTO speleo_link
                        (id, endpoint, project_id, project_name, base_commit_sha, has_unpushed_edits, last_edit_at, last_verify_at)
                     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                        endpoint = excluded.endpoint,
                        project_id = excluded.project_id,
                        project_name = excluded.project_name,
                        base_commit_sha = excluded.base_commit_sha,
                        has_unpushed_edits = excluded.has_unpushed_edits,
                        last_edit_at = excluded.last_edit_at,
                        last_verify_at = excluded.last_verify_at",
                    params![
                        link.endpoint,
                        link.project_id,
                        link.project_name,
                        link.base_commit_sha, // Option<String> → SQL NULL when None
                        i64::from(link.has_unpushed_edits),
                        link.last_edit_at, // Option<String> → SQL NULL when None
                        link.last_verify_at, // Option<String> → SQL NULL when None
                    ],
                )?;
            }
            None => {
                self.conn.execute("DELETE FROM speleo_link", [])?;
            }
        }
        Ok(())
    }

    /// Flip the SpeleoDB dirty bit and refresh `last_edit_at` in a SINGLE targeted
    /// `UPDATE`, without loading + re-serialising the whole link. Returns `true` when
    /// a remote-link row was updated (`false` = local-only project: no row → no-op).
    ///
    /// Hot path: called on EVERY accepted remote edit, so it avoids the per-edit
    /// `SELECT` + `CREATE TABLE IF NOT EXISTS` + full upsert that load+save did (#197
    /// review). The `speleo_link` table always exists post-open (schema init/migrate),
    /// and this never touches `base_commit_sha`/`endpoint`/`project_id`, so it cannot
    /// disturb the BASE-advance invariant or the immutable hand-off identity.
    pub fn touch_speleo_link_dirty(&self, last_edit_at: &str) -> Result<bool> {
        let rows = self.conn.execute(
            "UPDATE speleo_link SET has_unpushed_edits = 1, last_edit_at = ?1 WHERE id = 1",
            params![last_edit_at],
        )?;
        Ok(rows > 0)
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

    /// Load all display settings from database
    pub fn load_display_settings(&self) -> Result<HashMap<String, String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM display_settings")?;
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

        let total_rows: u32 =
            self.conn
                .query_row(&format!("SELECT COUNT(*) FROM {ident}"), [], |row| {
                    row.get(0)
                })?;

        let mut stmt = self
            .conn
            .prepare(&format!("SELECT * FROM {ident} LIMIT ?1 OFFSET ?2"))?;
        let columns: Vec<String> = stmt
            .column_names()
            .iter()
            .map(|c| (*c).to_string())
            .collect();
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
}
