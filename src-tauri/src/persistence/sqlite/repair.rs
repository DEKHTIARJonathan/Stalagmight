use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use std::path::Path;

use super::{BackupInfo, Database, SalvagedData, SalvagedSection};

impl Database {
    /// Write a self-contained snapshot of an on-disk `.stalx` to `dest` using
    /// `VACUUM INTO` (#195).
    ///
    /// `VACUUM INTO` produces a single, fully-checkpointed database file in
    /// rollback (DELETE) journal mode with NO `-wal`/`-journal`/`-shm` sidecar,
    /// so the snapshot can be uploaded as one blob and reopened with
    /// [`Database::open_existing`]. It reads the source on its own connection and
    /// NEVER mutates it (the live project file is left untouched), and it folds in
    /// any committed WAL frames so the snapshot reflects the source's current
    /// committed state under either journal mode.
    ///
    /// The SpeleoDB push pipeline saves the live project first, then snapshots
    /// here; the caller clears `has_unpushed_edits` in the snapshot copy before
    /// upload so the dirty bit never rides to the server.
    ///
    /// `dest`'s parent directory is created if missing, and any stale file at
    /// `dest` is removed first (`VACUUM INTO` refuses to overwrite an existing
    /// target).
    pub fn vacuum_snapshot(src: &Path, dest: &Path) -> Result<()> {
        if !src.exists() {
            anyhow::bail!("source .stalx does not exist: {}", src.display());
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create snapshot dir {}", parent.display()))?;
        }
        // VACUUM INTO fails outright if the target file already exists.
        if dest.exists() {
            std::fs::remove_file(dest)
                .with_context(|| format!("remove stale snapshot {}", dest.display()))?;
        }
        let conn = Connection::open(src).context("open source .stalx for snapshot")?;
        // The destination filename is a bound parameter (supported by VACUUM INTO
        // since SQLite 3.27); this avoids any path-quoting pitfalls.
        conn.execute("VACUUM INTO ?1", params![dest.to_string_lossy()])
            .context("VACUUM INTO snapshot failed")?;
        Ok(())
    }

    /// The per-session / per-machine LOCAL tables stripped from a push snapshot:
    /// none of these are shared project data, so none may ride to collaborators.
    ///
    /// - `display_settings` - per-machine VIEW toggles (grid, layer/feature
    ///   visibility, color mode, grid spacing); a collaborator pulls their own view.
    /// - `undo_stack` / `redo_stack` - the editor's local edit-session history
    ///   (#194 b3). NOT shared state, and a *data-corruption* vector if it rode: an
    ///   adopting collaborator pressing Ctrl-Z would replay the pusher's command
    ///   (and its `undo_data_json` prior-state payload) against a now-different tree,
    ///   silently wiping pitch/LRUD/comment/marker/temperature - the same hazard
    ///   `drop_legacy_undo_history` guards against. Stripping here is what makes
    ///   every adopt-remote path (`do_load_project_full`) start with a clean slate.
    /// - `collab_state` - the LOCAL Ariane-collab wiring (sibling `.tml` filesystem
    ///   path, baseline, per-machine autosave toggle). Meaningless to a remote
    ///   collaborator and never theirs to inherit.
    const PUSH_SNAPSHOT_LOCAL_TABLES: &[&str] = &[
        "display_settings",
        "undo_stack",
        "redo_stack",
        "collab_state",
    ];

    /// Sanitize a push SNAPSHOT in place (#197/#194) before upload:
    ///
    /// - clears `speleo_link.has_unpushed_edits` / `last_edit_at` - the dirty bit is
    ///   local hand-off state, never server state (the next puller re-stamps it);
    /// - empties every table in [`Self::PUSH_SNAPSHOT_LOCAL_TABLES`] - per-machine /
    ///   per-session local state that must not proliferate.
    ///
    /// Everything else PROLIFERATES with the project, by design: survey data,
    /// `project_settings` (shared validation config #57), AND the durable
    /// project-data tables `imported_file_hashes` / `imported_section_hashes`
    /// (project-wide import-dedup - collaborators must not re-import the same file)
    /// and `resolved_warnings` (a resolved warning stays resolved for everyone, like
    /// a comment). These are NOT stripped - only a writer holding the lock can push,
    /// so anything in the snapshot is a legitimate editor's change.
    ///
    /// Operates on a SNAPSHOT copy via its own connection; the live project file is
    /// never touched. Statements run independently so a missing table (an older
    /// snapshot shape) is logged, not fatal.
    pub fn sanitize_push_snapshot(snapshot: &Path) -> Result<()> {
        let conn = Connection::open(snapshot).context("open snapshot to sanitize for push")?;
        // Every statement below runs INDEPENDENTLY + best-effort: a failure of one
        // (e.g. a missing table on an older snapshot shape) is logged, never aborts,
        // and - crucially - never skips the others. The undo/redo strip is FIRST
        // because it is the data-CORRUPTION vector on adopt (#194 b3): it must run
        // even if the dirty-bit clear below were to fail, which the old ordering
        // (fatal dirty-clear first) did not guarantee (#197 review). Per-machine /
        // per-session local tables never proliferate; the names are compile-time
        // literals (no injection surface).
        for table in Self::PUSH_SNAPSHOT_LOCAL_TABLES {
            if let Err(e) = conn.execute(&format!("DELETE FROM {table}"), []) {
                tracing::warn!(
                    error = %e,
                    table = %table,
                    "sanitize_push_snapshot: failed to strip local-only table from snapshot"
                );
            }
        }
        // The dirty bit / edit timestamp are local hand-off state, never server state.
        if let Err(e) = conn.execute(
            "UPDATE speleo_link SET has_unpushed_edits = 0, last_edit_at = NULL",
            [],
        ) {
            tracing::warn!(
                error = %e,
                "sanitize_push_snapshot: failed to clear the dirty bit in the push snapshot"
            );
        }
        Ok(())
    }

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
        // Skip integrity check intentionally - we know the file may be corrupt
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
        let conn = Connection::open(path).context("Failed to open database for repair")?;

        // 3. Rebuild indexes
        if let Err(e) = conn.execute_batch("REINDEX;") {
            tracing::warn!(error = %e, "REINDEX failed, continuing with VACUUM");
        }

        // 4. VACUUM rebuilds the entire database from readable pages
        conn.execute_batch("VACUUM;")
            .context("VACUUM failed - database may be too damaged to repair")?;

        // 5. Verify result
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap_or_else(|_| "error".to_string());
        let ok = check == "ok";

        if ok {
            tracing::info!("Repair succeeded - integrity check passed");
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
            Err(e) => salvaged
                .errors
                .push(format!("Failed to read project metadata: {e}")),
        }

        // Sections
        match db.try_read_sections() {
            Ok(sections) => {
                salvaged.section_count = sections.len();
                salvaged.sections_json = serde_json::to_string(&sections).ok();
            }
            Err(e) => salvaged
                .errors
                .push(format!("Failed to read sections: {e}")),
        }

        // Shots
        match db.try_read_shot_count() {
            Ok(count) => salvaged.shot_count = count,
            Err(e) => salvaged.errors.push(format!("Failed to read shots: {e}")),
        }

        // Station merges
        match db.try_read_merge_count() {
            Ok(count) => salvaged.merge_count = count,
            Err(e) => salvaged
                .errors
                .push(format!("Failed to read station merges: {e}")),
        }

        // Full project (best-effort)
        match db.load_project() {
            Ok(project) => {
                salvaged.full_project_json = serde_json::to_string(&project).ok();
            }
            Err(e) => salvaged
                .errors
                .push(format!("Failed to load full project: {e}")),
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
    pub(super) fn create_numbered_backup(path: &Path) -> Result<std::path::PathBuf> {
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

    pub(super) fn try_read_project_metadata(&self) -> Result<Option<(String, Option<String>)>> {
        if !self.table_exists("project")? {
            return Ok(None);
        }
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM project", [], |row| row.get(0))?;
        if count == 0 {
            return Ok(None);
        }
        let (name, location): (String, Option<String>) =
            self.conn
                .query_row("SELECT name, location FROM project LIMIT 1", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
        Ok(Some((name, location)))
    }

    pub(super) fn try_read_sections(&self) -> Result<Vec<SalvagedSection>> {
        if !self.table_exists("sections")? {
            return Ok(Vec::new());
        }
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, surveyor, date, color FROM sections ORDER BY id")?;
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

    pub(super) fn try_read_shot_count(&self) -> Result<usize> {
        if !self.table_exists("shots")? {
            return Ok(0);
        }
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM shots", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    pub(super) fn try_read_merge_count(&self) -> Result<usize> {
        if !self.table_exists("station_merges")? {
            return Ok(0);
        }
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM station_merges", [], |row| row.get(0))?;
        Ok(count as usize)
    }
}
