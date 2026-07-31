use anyhow::Result;
use chrono::Utc;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::Connection;
use std::io::{Read as _, Write as _};

// Items below are used only by the sibling `tests` module via `use super::*`;
// production code in this residual file no longer references them after the
// `impl Database` split into child modules, so gate them to the test build.
#[cfg(test)]
use crate::models::{
    ClosureStrategy, GpsCoordinates, LoopClosure, Project, SectionData, StationKey, StationMerge,
    SurveyDirection, ZeroDatum,
};
#[cfg(test)]
use chrono::NaiveDate;
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::path::Path;

/// Schema version for migrations
///
/// v8 adds a nullable `shot_uuid` column to `resolved_warnings` (issue #57):
/// "Ignore" suppression is keyed by the shot's stable UUID so it survives shot
/// inserts/deletes/reorders. Backfilled lazily from the legacy
/// `(section_id, shot_id)` key - no rewrite of existing rows at migration time.
///
/// v9 adds the additive single-row `speleo_link` table (SpeleoDB hand-off
/// identity + dirty bit, #189). No existing column or row is touched;
/// forward-looking only - no backfill. The table is created in BOTH
/// `init_schema` and `migrate_schema`, so legacy v8 files gain it on
/// `open_existing`. `is_remote` is DERIVED from `EXISTS(speleo_link)`, never
/// stored. See `PRESERVED_SPELEOLINK_COLUMNS` (the carry-forward fence) for the
/// columns every future bump must preserve.
///
/// v10 adds the additive `speleo_link.last_edit_at` column (RFC-3339 UTC of the
/// most recent accepted edit; #193 guardrail-7 push-start comparison). Added in
/// BOTH `init_schema` and `migrate_schema` (a conditional `ALTER` for existing v9
/// tables, mirroring the shot-uuid pattern); carried forward by the fence.
/// v12 normalises stored pitch to the +down convention (#296). DMP import used
/// to keep the mNemo's +up reading, so pre-v12 files mix conventions: DMP-sourced
/// shots are +up while Walls/Compass-sourced shots are already +down, and nothing
/// records which importer produced a section. `migrate_pitch_to_down_convention`
/// infers it from the geometry and negates only the sections that need it. No
/// column changes, so the carry-forward fence is unaffected.
///
/// v14 normalises stored azimuth readings into `[0, 360)` (#24). Nothing changed
/// meaning - `Shot::average_azimuth` simply used Rust's truncated `%`, which returned
/// the ANTIPODE of the circular mean for a reading pair more than 540 degrees apart,
/// and now wraps with `rem_euclid`. Normalising takes the ambiguity out of the FILE, so
/// a `.stalx` renders identically either side of that fix. See
/// `migrate_azimuths_to_canonical_range`. No column changes, so the carry-forward
/// fence is unaffected.
///
/// v15 drops the single-row `collab_state` table: Ariane collaboration mode was
/// removed, so nothing reads or writes it. Destructive, but inert - the table only
/// ever held local sidecar wiring (the sibling `.tml` path, the per-shot export
/// baseline and a per-machine autosave toggle), never survey data. Existing files
/// take the migration once on open; an older build opening a v15 file still works
/// (it warns about the newer version and recreates the table on its own writes).
///
/// v16 adds the additive `speleo_link.undo_mode` column (#303: the per-project
/// override of whether this project's undo history rides to the server; nullable =
/// follow the global default) and the additive single-row local-only
/// `speleo_undo_chain` table (which server revision the working copy was unwound
/// to, so the next Unwind can walk to its parent). Both are created in BOTH
/// `init_schema` and `migrate_schema` - a conditional `ALTER` for existing tables,
/// mirroring the v10/v11 pattern - and the column is carried forward by the fence.
/// `speleo_undo_chain` is per-machine progress through history, so it is stripped
/// from every push snapshot (`PUSH_SNAPSHOT_LOCAL_TABLES`).
const SCHEMA_VERSION: i32 = 16;

/// Schema version at which persisted undo/redo payloads became safe to replay.
///
/// v7 changed the `ShotUpdates` JSON wire format: nullable fields now use a
/// `double_option` deserializer where an explicit `null` means "clear the
/// field" (`Some(None)`), while pre-v7 writers serialized every UNTOUCHED
/// nullable field as an explicit `null`. Replaying a pre-v7 undo/redo entry
/// under the new semantics would silently clear pitch/LRUD/comment/marker/
/// temperature on the target shot. Legacy JSON cannot distinguish "untouched"
/// from "restore-to-empty", so files below this version get their persisted
/// undo/redo stacks dropped on open (see `drop_legacy_undo_history`).
///
/// Deliberately a separate constant from `SCHEMA_VERSION`, but note what that
/// buys and what it does not. It is the floor for exactly ONE purge - the
/// unconditional pre-v7 one above - and it is NOT a promise that later
/// migrations leave persisted history alone. Later migrations drop the stacks
/// too, and none of them bumped this constant, because none of them changed the
/// undo payload FORMAT; each removed a shape the payloads can still name:
///
/// - **v12→v13** removed the legacy `is_reference` boolean in favour of
///   `ShotKind`. Old payloads still deserialize: `de_shot_kind` maps a bare
///   `true` to `Jump`, because a boolean cannot say which virtual kind it meant.
///   Replaying one after the #27 backfill settled that shot on `Reference` would
///   make a non-swimmable tie swimmable again, with no classifier pass on an
///   undo to correct it. Silent MISinterpretation, not a parse failure.
/// - **v14→v15** removed the `ApplyCollabChanges` `Command` variant with Ariane
///   collaboration mode. `Command` is internally tagged (`tag = "type"`) with no
///   catch-all, so a stored `apply_collab_changes` entry stops deserializing
///   outright - and `UndoStack::load_from_persisted_with_timestamps` SKIPS a bad
///   entry rather than truncating, keeping the entries on BOTH sides. The stack
///   loads with a HOLE, and undoing past it replays surviving older entries
///   (position-keyed `ShotSnapshot`s, the apply's own `ProjectSnapshotPair`)
///   against a tree they no longer describe.
///
/// v11→v12 drops the stacks as well, but conditionally - only when the pitch
/// flip actually moved a section (see `invalidate_pre_pitch_flip_state`).
///
/// So the rule for a future bump is narrower than "any time history is
/// dropped": bump this constant only when the payload format changes such that
/// pre-existing entries still PARSE but mean something different across the
/// whole stack. Removing a `Command` variant, or a field the payloads carry, is
/// handled instead by calling `drop_legacy_undo_history` from that migration's
/// own arm in `ensure_schema_version` - which is what v13 and v15 do, and what
/// any future removal has to do as well.
const UNDO_FORMAT_SAFE_VERSION: i32 = 7;

/// Maximum number of rows a single raw-table page request may return.
pub const MAX_RAW_PAGE_ROWS: u32 = 10_000;

/// Render a blob value as a size placeholder, e.g. `<blob 4.2 KB>`.
fn format_blob_placeholder(len: usize) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let len = len as f64;
    if len < KB {
        format!("<blob {len:.0} B>")
    } else if len < MB {
        format!("<blob {:.1} KB>", len / KB)
    } else if len < GB {
        format!("<blob {:.1} MB>", len / MB)
    } else {
        format!("<blob {:.1} GB>", len / GB)
    }
}

fn compress_json(json: &str) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    // write_all and finish are infallible on Vec<u8>
    encoder
        .write_all(json.as_bytes())
        .and_then(|()| encoder.finish())
        .unwrap_or_else(|_| json.as_bytes().to_vec())
}

fn decompress_json(data: &[u8]) -> Result<String> {
    // Gzip magic bytes: 0x1f 0x8b
    if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
        let mut decoder = GzDecoder::new(data);
        let mut s = String::new();
        decoder.read_to_string(&mut s)?;
        Ok(s)
    } else {
        // Backward compat: old TEXT entries (or CAST-ed BLOB) are plain UTF-8
        Ok(String::from_utf8_lossy(data).into_owned())
    }
}

/// Database operations for projects
pub struct Database {
    conn: Connection,
}

mod integrity;
mod open;
mod read;
mod repair;
mod schema;
mod settings;
mod undo;
mod warnings;
mod write;

/// A stringified page of rows from a raw sqlite table.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RawTableData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: u32,
}

/// Information about a backup file.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: String,
}

/// Result of attempting to repair a corrupt database.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    pub success: bool,
    pub backup_path: String,
    pub message: String,
}

/// Data salvaged from a corrupt database.
#[derive(Debug, Clone, Default, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SalvagedData {
    pub project_name: Option<String>,
    pub project_location: Option<String>,
    pub section_count: usize,
    pub shot_count: usize,
    pub merge_count: usize,
    /// Sections as JSON (for display/re-import)
    pub sections_json: Option<String>,
    /// Full project as JSON (if loadable despite corruption)
    pub full_project_json: Option<String>,
    /// Errors encountered while reading individual tables
    pub errors: Vec<String>,
}

/// Minimal section info for salvage display.
#[derive(Debug, Clone, serde::Serialize)]
struct SalvagedSection {
    id: u32,
    name: Option<String>,
    surveyor: Option<String>,
    date: Option<String>,
    color: String,
}

/// Resolved warning record
#[derive(Debug, Clone)]
pub struct ResolvedWarning {
    pub section_id: u32,
    pub shot_id: u32,
    pub warning_code: String,
    pub resolved_at: chrono::DateTime<Utc>,
    pub resolved_comment: Option<String>,
    /// Stable UUID of the suppressed shot (issue #57). `Some` for all warnings
    /// raised against shots that have a UUID (the normal case); `None` only for
    /// pre-v8 rows or shots loaded from pre-v6 .stalx files without a UUID yet.
    /// The suppression is matched by `(shot_uuid, warning_code)` when present,
    /// falling back to the legacy `(section_id, shot_id, warning_code)` key
    /// otherwise. See `AppState::compute_project_warnings`.
    pub shot_uuid: Option<String>,
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::print_stdout,
    clippy::float_cmp,
    clippy::panic
)]
mod tests;
