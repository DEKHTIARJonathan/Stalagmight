use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::HashMap;

use super::{Database, ResolvedWarning};

impl Database {
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
            let resolved_at = chrono::DateTime::parse_from_rfc3339(&resolved_at_str)
                .map_or_else(|_| Utc::now(), |dt| dt.with_timezone(&Utc));
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
    /// any prior row for the same identity (the UUID when present, else the
    /// legacy `(section_id, shot_id)` position), then insert the fresh record.
    /// Falls back to the legacy position key when the shot has no UUID. Legacy
    /// NULL-uuid rows are upgraded to the UUID key by the load-time backfill
    /// (`backfill_resolved_warning_uuids`), not here.
    pub fn save_resolved_warning(&self, warning: &ResolvedWarning) -> Result<()> {
        // The legacy UNIQUE(section_id, shot_id, warning_code) keys rows by
        // POSITION, but a UUID-keyed ignore's real identity is its shot_uuid. A
        // plain INSERT OR REPLACE would, on a positional collision, delete a
        // DIFFERENT live shot's by-UUID ignore that occupies that slot - e.g. after
        // a save remapped rows to sequence positions while the open project still
        // uses pre-save shot ids - silently losing it (issue #57 / Codex). Use a
        // conditional upsert that only ever overwrites the SAME shot's row (or
        // upgrades a legacy NULL-uuid row at that position), never a different
        // shot's UUID-keyed row. `excluded` is the row we tried to insert.
        //
        // The dedup-delete + insert run in ONE transaction: if the insert is
        // refused (the slot is held by a different shot), dropping the transaction
        // rolls the delete back too, so this shot's OWN prior ignore is preserved
        // rather than dropped on the way to refusing (issue #57 / Codex).
        let tx = self.conn.unchecked_transaction()?;
        Self::delete_matching_resolved(&tx, warning)?;
        let affected = tx.execute(
            "INSERT INTO resolved_warnings (section_id, shot_id, warning_code, resolved_at, resolved_comment, shot_uuid) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(section_id, shot_id, warning_code) DO UPDATE SET \
                 resolved_at = excluded.resolved_at, \
                 resolved_comment = excluded.resolved_comment, \
                 shot_uuid = excluded.shot_uuid \
             WHERE resolved_warnings.shot_uuid IS NULL \
                OR resolved_warnings.shot_uuid = excluded.shot_uuid",
            params![
                warning.section_id,
                warning.shot_id,
                warning.warning_code,
                warning.resolved_at.to_rfc3339(),
                warning.resolved_comment,
                warning.shot_uuid,
            ],
        )?;
        if affected == 0 {
            // The positional slot is held by a DIFFERENT shot's UUID-keyed ignore
            // (a stale position from a prior save, before the ids re-sync on
            // reload). Roll back (drop without commit) so neither ignore is lost,
            // and surface the failure so the caller can prompt a reload + retry.
            anyhow::bail!(
                "could not record this ignore: its position is held by another shot's ignore - reload the project and try again"
            );
        }
        tx.commit()?;
        Ok(())
    }

    /// Whether `uuid` is already stored in the on-disk `shots` table. A pre-v6
    /// shot's UUID is minted only in memory until the project is saved, so keying
    /// a new ignore by such an unpersisted UUID would orphan the row on the next
    /// open (different UUIDs are minted) - the resolve path keeps those ignores
    /// position-keyed instead (issue #57 / Codex).
    pub fn shot_uuid_is_persisted(&self, uuid: &str) -> Result<bool> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM shots WHERE uuid = ?1)",
            params![uuid],
            |row| row.get(0),
        )?;
        Ok(exists)
    }

    /// Delete any resolved-warning rows matching `warning`. When a `shot_uuid`
    /// is present we match its own (section_id, uuid) row, plus any *legacy*
    /// NULL-uuid row at the same `(section_id, shot_id)` - but NEVER a *different*
    /// shot's valid by-UUID row that happens to occupy that position after a
    /// renumber (the `shot_uuid IS NULL` guard on the position branch ensures
    /// that). The UUID branch is constrained by `section_id` because
    /// `ensure_unique_shot_uuids` only de-dups within a section, so two sections
    /// can share a shot UUID - without the section guard, ignoring/un-ignoring on
    /// one section would clear the other's suppression too (issue #57 / Codex).
    /// This lets un-ignoring a live shot still clear a legacy position-keyed
    /// suppression of that same shot even on a load path that did not run the
    /// backfill. When no UUID is supplied (a legacy row), match purely by
    /// position. Shared by save (dedup) and unresolve (clear).
    fn delete_matching_resolved(conn: &Connection, warning: &ResolvedWarning) -> Result<()> {
        if let Some(uuid) = warning.shot_uuid.as_deref() {
            conn.execute(
                "DELETE FROM resolved_warnings WHERE warning_code = ?1 \
                 AND section_id = ?3 \
                 AND (shot_uuid = ?2 \
                      OR (shot_uuid IS NULL AND shot_id = ?4))",
                params![
                    warning.warning_code,
                    uuid,
                    warning.section_id,
                    warning.shot_id
                ],
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

    /// Upgrade legacy NULL-uuid resolved-warning rows to UUID keying using the
    /// supplied (section_id, shot_id) -> uuid map (issue #57, Item 4). Idempotent:
    /// only rewrites rows whose shot_uuid IS NULL and whose (section_id, shot_id)
    /// still maps to a live shot. A row with no live shot is left NULL so it keeps
    /// falling back to legacy position matching and is never mis-keyed.
    pub fn backfill_resolved_warning_uuids(
        &self,
        live: &HashMap<(u32, u32), String>,
    ) -> Result<usize> {
        let mut to_fix: Vec<(i64, String)> = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT id, section_id, shot_id FROM resolved_warnings WHERE shot_uuid IS NULL",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, u32>(2)?,
                ))
            })?;
            for row in rows {
                let (id, sec, shot) = row?;
                if let Some(uuid) = live.get(&(sec, shot)) {
                    to_fix.push((id, uuid.clone()));
                }
            }
        }
        for (id, uuid) in &to_fix {
            self.conn.execute(
                "UPDATE resolved_warnings SET shot_uuid = ?1 WHERE id = ?2",
                params![uuid, id],
            )?;
        }
        Ok(to_fix.len())
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
            // Conditional upsert (see save_resolved_warning): on a positional
            // collision only the SAME shot's row is overwritten, or a legacy
            // NULL-uuid row at that position is UPGRADED to the new UUID - a
            // different shot's UUID-keyed ignore is never clobbered. This both
            // collapses a batch that maps two warnings to one (shot, code) and
            // absorbs a legacy NULL-uuid row colliding with a remapped UUID row
            // on the save carry-over, order-independently (issue #57 / Codex).
            let mut stmt = tx.prepare(
                "INSERT INTO resolved_warnings (section_id, shot_id, warning_code, resolved_at, resolved_comment, shot_uuid) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(section_id, shot_id, warning_code) DO UPDATE SET \
                     resolved_at = excluded.resolved_at, \
                     resolved_comment = excluded.resolved_comment, \
                     shot_uuid = excluded.shot_uuid \
                 WHERE resolved_warnings.shot_uuid IS NULL \
                    OR resolved_warnings.shot_uuid = excluded.shot_uuid",
            )?;
            for warning in warnings {
                // A 0-row result means a different shot's UUID row already holds
                // this position; preserving it (not aborting the save) is correct.
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
}
