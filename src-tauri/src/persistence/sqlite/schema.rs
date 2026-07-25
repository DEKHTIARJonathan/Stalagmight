use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::models::FEATURE_ID_STRIDE;

use super::{Database, SCHEMA_VERSION, UNDO_FORMAT_SAFE_VERSION};

/// Columns of `speleo_link` that MUST survive every future SCHEMA_VERSION bump
/// unchanged (name, declared type, null-ness). The carry-forward fence (#190)
/// asserts this with `pragma_table_info` so no later migration silently rewrites
/// the SpeleoDB hand-off identity or drops the dirty bit. `(name, decl_type,
/// notnull)`.
pub(super) const PRESERVED_SPELEOLINK_COLUMNS: &[(&str, &str, bool)] = &[
    // `id INTEGER PRIMARY KEY` is a rowid alias: SQLite reports notnull=0 for it
    // in pragma_table_info even though a rowid PK can never be NULL. The fence
    // asserts the column as the schema actually reports it, so notnull is `false`
    // here (the PK + CHECK(id=1) still enforce single-row identity).
    ("id", "INTEGER", false),
    ("endpoint", "TEXT", true),
    ("project_id", "TEXT", true),
    ("project_name", "TEXT", true),
    ("base_commit_sha", "TEXT", false), // nullable = empty-repo BASE
    ("has_unpushed_edits", "INTEGER", true),
    ("last_edit_at", "TEXT", false), // v10; nullable = never edited since pull
    ("last_verify_at", "TEXT", false), // v11; nullable = never re-verified since pull
];

impl Database {
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

        // Ensure project_settings table exists (#57: per-project validation
        // thresholds stored in the .stalx so they travel with the file).
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS project_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )?;

        // Add direction column to sections table if it doesn't exist (added for direction field)
        // Check if column exists first
        let has_direction_column: bool = self
            .conn
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
        let has_quality_column: bool = self
            .conn
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
        let has_closure_id: bool = self
            .conn
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
        let has_strategy: bool = self
            .conn
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
        let has_is_aligned: bool = self
            .conn
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
        let has_next_closure_id: bool = self
            .conn
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

        // Ensure speleo_link table exists (schema v9: SpeleoDB hand-off identity
        // + dirty bit, #189). This CREATE IF NOT EXISTS is what makes the table
        // appear on open_existing() of a legacy v8 file (mirrors the collab_state
        // pattern, not the shot_uuid ALTER pattern). No ALTER, no backfill. The
        // DDL is byte-identical to init_schema's so the carry-forward fence
        // (PRESERVED_SPELEOLINK_COLUMNS) holds on either open shape.
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

        // Add last_edit_at column to an EXISTING v9 speleo_link (schema v9→v10:
        // guardrail-7 push-start comparison, #193). CREATE IF NOT EXISTS above is
        // a no-op when the table already exists, so a pre-v10 table needs the
        // column added explicitly — same idempotent ALTER pattern as shot uuid.
        let has_last_edit_at_column: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('speleo_link') WHERE name='last_edit_at'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_last_edit_at_column {
            self.conn
                .execute("ALTER TABLE speleo_link ADD COLUMN last_edit_at TEXT", [])?;
            // Backfill (#197 review): a row already dirtied under v9 has
            // has_unpushed_edits=1 but no last_edit_at. Without a timestamp,
            // edits_captured_by_push(None, push_start) is false, so a confirmed push
            // could NEVER clear that legacy dirty bit — the project would show
            // un-pushed edits forever and re-push a no-op on every Done. The edit
            // demonstrably predates any future push, so stamp the Unix epoch
            // (guaranteed <= any push-start) and let the next confirmed push clear it.
            // Fresh v10 rows stamp last_edit_at at edit time, so this only ever
            // touches a pre-existing dirty row during the one-time v9→v10 migration.
            self.conn.execute(
                "UPDATE speleo_link SET last_edit_at = '1970-01-01T00:00:00+00:00' \
                 WHERE has_unpushed_edits = 1 AND last_edit_at IS NULL",
                [],
            )?;
            tracing::info!("Added last_edit_at column to speleo_link table (schema v10)");
        }

        // Add last_verify_at column to an EXISTING v10 speleo_link (schema v10→v11:
        // lazy 20-min lock re-verify, #202). Same idempotent ALTER pattern as
        // last_edit_at above; CREATE IF NOT EXISTS is a no-op on a pre-v11 table.
        // No backfill: a NULL last_verify_at means "never verified since pull", which
        // simply forces the first lock-held edit to re-verify - safe, since #202 only
        // bounds wasted work (the release fence is the correctness backstop).
        let has_last_verify_at_column: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('speleo_link') WHERE name='last_verify_at'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !has_last_verify_at_column {
            self.conn
                .execute("ALTER TABLE speleo_link ADD COLUMN last_verify_at TEXT", [])?;
            tracing::info!("Added last_verify_at column to speleo_link table (schema v11)");
        }

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
            self.conn.execute(
                "ALTER TABLE resolved_warnings ADD COLUMN shot_uuid TEXT",
                [],
            )?;
            // Backfill the UUID for existing rows so suppressions survive the
            // migration. The legacy key stored `shot_id`, which on load is
            // `section_id * FEATURE_ID_STRIDE + sequence_order`, so we can
            // recover each shot's row and copy its UUID. Rows whose shot has no
            // UUID yet (pre-v6 .stalx, before the lazy in-memory mint) stay NULL
            // and fall back to legacy-position matching. The stride is
            // interpolated from the constant so this stays correct if it changes.
            self.conn.execute(
                &format!(
                    "UPDATE resolved_warnings \
                     SET shot_uuid = ( \
                         SELECT s.uuid FROM shots s \
                         WHERE s.section_id = resolved_warnings.section_id \
                           AND s.sequence_order = resolved_warnings.shot_id - resolved_warnings.section_id * {FEATURE_ID_STRIDE} \
                     ) \
                     WHERE shot_uuid IS NULL"
                ),
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
        let needs_rename = conn.prepare("SELECT is_virtual FROM shots LIMIT 0").is_ok();
        if needs_rename {
            conn.execute_batch("ALTER TABLE shots RENAME COLUMN is_virtual TO is_reference;")?;
        }
        // Always update display_settings key (idempotent UPDATE).
        conn.execute_batch(
            "UPDATE display_settings SET key = 'showReferenceShots' WHERE key = 'showVirtualShots';"
        )?;
        Ok(())
    }

    /// Normalise stored pitch to the +down convention (schema v11→v12, #296).
    ///
    /// DMP import used to keep the mNemo's +up reading, so shots from a DMP
    /// were stored with a pitch that contradicted their own depth change while
    /// Walls- and Compass-sourced shots were already +down. Nothing on a shot
    /// or a section records which importer produced it, so the origin cannot be
    /// looked up, it has to be inferred from the numbers.
    ///
    /// Decided per SECTION, never per shot. A single shot is often ambiguous:
    /// near-horizontal and very short shots carry almost no signal (1 cm depth
    /// resolution swamps the implied angle), and on real data individual shots
    /// do score better in the wrong direction. A section is decisive because
    /// the convention is a property of the file it was imported from, uniform
    /// across it. Deciding per section also means a genuinely blundered shot
    /// cannot flip itself into agreement with its own depth change: it inherits
    /// the section verdict and stays flagged by validation, which is the whole
    /// point of the cross-check.
    ///
    /// A section is only flipped when the evidence is lopsided: at least
    /// `MIN_VOTING_SHOTS` usable shots and a flipped error less than half the
    /// as-is error. On real DMP data the flipped error is 3-7x smaller, and on
    /// already-correct Walls/Compass data it is far larger, so the gap is wide.
    /// Anything in between is left alone rather than guessed at; sections whose
    /// pitch is entirely zero (Ariane never populates inclination) produce no
    /// signal at all and are untouched.
    /// Returns `true` when at least one section was flipped, so the caller can
    /// invalidate the state that still holds pre-flip pitch (persisted undo
    /// history, dismissed inclination warnings, the collab sidecar baseline).
    pub(super) fn migrate_pitch_to_down_convention(conn: &Connection) -> Result<bool> {
        /// Below this a shot's implied angle is mostly depth-gauge quantisation.
        const MIN_LENGTH_M: f64 = 0.05;
        /// Same, for the vertical change.
        const MIN_DZ_M: f64 = 0.05;
        /// Fewer usable shots than this is not a section-wide verdict.
        const MIN_VOTING_SHOTS: usize = 3;
        /// Flipped must beat as-is by this factor to count as decisive.
        const DECISIVE_RATIO: f64 = 2.0;
        /// A leg steeper than vertical is a blunder and casts no vote.
        const MAX_VOTING_PITCH_DEG: f64 = 90.0;

        let mut stmt = conn.prepare(
            "SELECT section_id, length, depth_in, depth_out, pitch_in, pitch_out
             FROM shots
             WHERE pitch_in IS NOT NULL OR pitch_out IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, Option<f64>>(4)?,
                row.get::<_, Option<f64>>(5)?,
            ))
        })?;

        // section_id -> (as-is error, flipped error, usable shot count)
        let mut tally: HashMap<i64, (f64, f64, usize)> = HashMap::new();
        for row in rows {
            let (section_id, length, depth_in, depth_out, pitch_in, pitch_out) = row?;
            let recorded = match (pitch_in, pitch_out) {
                (Some(a), Some(b)) => (a + b) / 2.0,
                (Some(a), None) | (None, Some(a)) => a,
                (None, None) => continue,
            };
            let dz = depth_out - depth_in;
            // Skip shots the geometry cannot speak to, and impossible ones.
            if length <= MIN_LENGTH_M || dz.abs() <= MIN_DZ_M || length < dz.abs() {
                continue;
            }
            if !recorded.is_finite() || !dz.is_finite() || !length.is_finite() {
                continue;
            }
            // Out-of-range legs are blunders, not evidence.  Validation skips
            // the cross-check for them (see `Validator::validate_shot`), so
            // letting them vote here would let a single 120 degree typo drag a
            // section's verdict in either direction depending on its sign.
            if recorded.abs() > MAX_VOTING_PITCH_DEG {
                continue;
            }
            let horizontal = (length * length - dz * dz).max(0.0).sqrt();
            let implied = dz.atan2(horizontal).to_degrees();

            let entry = tally.entry(section_id).or_insert((0.0, 0.0, 0));
            entry.0 += (recorded - implied).abs();
            entry.1 += (-recorded - implied).abs();
            entry.2 += 1;
        }
        drop(stmt);

        let flip: Vec<i64> = tally
            .iter()
            .filter(|(_, (as_is, flipped, count))| {
                *count >= MIN_VOTING_SHOTS && *flipped * DECISIVE_RATIO < *as_is
            })
            .map(|(section_id, _)| *section_id)
            .collect();

        // Sections that had usable geometry but were not decisive enough to
        // flip keep whatever convention they were stored in, and the v12 stamp
        // means they are never re-examined.  If one of those was in fact a +up
        // section, validation will now flag every sloped shot in it, so name
        // them in the log rather than leaving the user to guess.
        let declined: Vec<i64> = tally
            .iter()
            .filter(|(section_id, (_, _, count))| {
                *count >= MIN_VOTING_SHOTS && !flip.contains(section_id)
            })
            .map(|(section_id, _)| *section_id)
            .collect();
        if !declined.is_empty() {
            tracing::warn!(
                declined_sections = ?declined,
                "Pitch convention was not decisive for these sections; leaving them as stored (v11 to v12)"
            );
        }

        if flip.is_empty() {
            tracing::info!(
                sections_examined = tally.len(),
                "No sections needed pitch-convention normalisation (v11 to v12)"
            );
            return Ok(false);
        }

        // No transaction here on purpose: the caller wraps this call and the
        // invalidation that follows it in one, so the two cannot be separated
        // by a crash.
        for section_id in &flip {
            conn.execute(
                "UPDATE shots
                 SET pitch_in  = CASE WHEN pitch_in  IS NULL THEN NULL ELSE -pitch_in  END,
                     pitch_out = CASE WHEN pitch_out IS NULL THEN NULL ELSE -pitch_out END
                 WHERE section_id = ?1",
                [section_id],
            )?;
        }

        tracing::info!(
            sections_flipped = flip.len(),
            sections_examined = tally.len(),
            "Normalised stored pitch to the +down convention (v11 to v12)"
        );
        Ok(true)
    }

    /// Migrate undo/redo tables from TEXT to BLOB columns (schema v2→v3).
    /// Existing TEXT data is CAST to BLOB; on read, `decompress_json` detects
    /// whether content is gzip-compressed or plain UTF-8, so old entries remain
    /// readable without re-encoding.
    pub(super) fn migrate_undo_redo_to_blob(&self) -> Result<()> {
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
    pub(super) fn drop_legacy_undo_history(&self) -> Result<()> {
        for table in ["undo_stack", "redo_stack"] {
            if !self.table_exists(table)? {
                continue;
            }
            let removed = self.conn.execute(&format!("DELETE FROM {table}"), [])?;
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

    /// Discard everything outside the `shots` table that still holds a
    /// pre-#296 pitch, after `migrate_pitch_to_down_convention` flipped at
    /// least one section (schema v11 to v12).
    ///
    /// The migration rewrites `shots` only. Three other stores keep pitch, or a
    /// verdict derived from it, and none of them is versioned, so a stale copy
    /// would outlive the migration and there is no second pass to catch it:
    ///
    /// 1. Persisted undo/redo. Payloads carry absolute pitch values and whole
    ///    project snapshots, so one undo of a pre-upgrade edit writes the +up
    ///    value straight back into a file already stamped v12.
    /// 2. Dismissed inclination warnings. `resolved_warnings` is keyed by
    ///    `(section_id, shot_id, warning_code)` with no value component, so a
    ///    mismatch the user dismissed under the old convention would keep
    ///    suppressing the check now that the number means something else.
    /// 3. The collab sidecar baseline. The sibling `.tml` on disk was written
    ///    by a pre-#296 build in the unflipped convention; clearing the hash and
    ///    the per-shot baseline forces a fresh export before the next reconcile,
    ///    instead of diffing the new frame against an old-frame file.
    fn invalidate_pre_pitch_flip_state(&self) -> Result<()> {
        self.drop_legacy_undo_history()?;

        if self.table_exists("resolved_warnings")? {
            let cleared = self.conn.execute(
                "DELETE FROM resolved_warnings
                 WHERE warning_code IN ('INCLINATION_DEPTH_MISMATCH', 'LENGTH_BELOW_DEPTH_CHANGE')",
                [],
            )?;
            if cleared > 0 {
                tracing::info!(
                    cleared,
                    "Cleared inclination warning dismissals taken under the pre-#296 convention"
                );
            }
        }

        if self.table_exists("collab_state")? {
            let updated = self.conn.execute(
                "UPDATE collab_state
                 SET state_json = json_remove(
                         json_remove(state_json, '$.last_export_tml_sha256'),
                         '$.shot_baseline')
                 WHERE id = 1",
                [],
            )?;
            if updated > 0 {
                tracing::info!(
                    "Cleared collab sidecar baseline; the .tml will be re-exported before the next reconcile"
                );
            }
        }

        Ok(())
    }

    /// Enable foreign key enforcement on this connection.
    pub(super) fn enable_foreign_keys(&self) -> Result<()> {
        self.conn.execute("PRAGMA foreign_keys = ON;", [])?;
        Ok(())
    }

    /// Check if a table exists in the database.
    pub(super) fn table_exists(&self, name: &str) -> Result<bool> {
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

        let has_column: bool = self
            .conn
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

        let version: i32 =
            self.conn
                .query_row("SELECT schema_version FROM project LIMIT 1", [], |row| {
                    row.get(0)
                })?;
        Ok(Some(version))
    }

    /// Read the current schema version from PRAGMA user_version.
    pub(super) fn get_user_version(&self) -> Result<i32> {
        let version: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok(version)
    }

    /// Persist the schema version to PRAGMA user_version.
    pub(super) fn set_user_version(&self, version: i32) -> Result<()> {
        self.conn
            .execute(&format!("PRAGMA user_version = {version}"), [])?;
        Ok(())
    }

    /// Ensure schema migrations are applied and user_version is current.
    pub(super) fn ensure_schema_version(&mut self) -> Result<()> {
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
        if current < 12 {
            // The flip and the invalidation have to land together. The verdict
            // is re-derived from the rows themselves, so a flip that committed
            // alone would look already-correct on the next open: the migration
            // would decline, the invalidation would never run, and v12 would be
            // stamped over permanently stale undo history, warning dismissals
            // and collab baseline. One transaction removes that window. The
            // invalidation runs on this same connection, so its statements join
            // this transaction.
            let tx = self.conn.unchecked_transaction()?;
            if Self::migrate_pitch_to_down_convention(&tx)? {
                self.invalidate_pre_pitch_flip_state()?;
            }
            tx.commit()?;
        }
        self.set_user_version(SCHEMA_VERSION)?;
        // Keep project-level schema_version in sync with PRAGMA user_version.
        let _ = self.conn.execute(
            "UPDATE project SET schema_version = ?1",
            params![SCHEMA_VERSION],
        );

        Ok(())
    }

    /// Initialize the database schema
    pub(super) fn init_schema(&self) -> Result<()> {
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

            -- SpeleoDB single-writer hand-off link (schema v9). Single row id=1.
            -- base_commit_sha NULL = empty-repo BASE (never coerced to ''). is_remote is
            -- DERIVED from EXISTS(this table), never stored. ADDITIVE: no future migration
            -- rewrites this table (see PRESERVED_SPELEOLINK_COLUMNS / carry-forward fence).
            CREATE TABLE IF NOT EXISTS speleo_link (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                endpoint TEXT NOT NULL,
                project_id TEXT NOT NULL,
                project_name TEXT NOT NULL,
                base_commit_sha TEXT,
                has_unpushed_edits INTEGER NOT NULL DEFAULT 0,
                last_edit_at TEXT,
                last_verify_at TEXT
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

            -- Per-project settings (validation thresholds, #57)
            CREATE TABLE IF NOT EXISTS project_settings (
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
}
