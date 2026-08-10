//! [#517] A save must not turn "I could not read the ignore list" into "there
//! are no ignores".
//!
//! `save_project` (`project_io.rs`, "carry resolved warnings across save")
//! snapshots `resolved_warnings` off the live handle and re-applies it to the
//! fresh `.stalx.tmp` it renames over the destination, so that snapshot IS the
//! saved file's ignore list. #485 closed the migration-skip that made the read
//! fail; this pins the amplifier behind it, which survived that fix:
//!
//! * a shape the current SELECT cannot name (a pre-v8 table with no
//!   `shot_uuid`, reachable with a FORGED `PRAGMA user_version` claiming the
//!   chain already ran) is now read verbatim and carried, and
//! * a table that cannot be read at all REFUSES the save instead of writing a
//!   file with zero ignores over the one that had them.
//!
//! All data here is synthetic: a project built in memory, saved by this build,
//! then hand-narrowed. No fixture is read or written.

use tempfile::TempDir;

use super::AppState;
use crate::models::{Project, SectionData, ShotData};
use crate::persistence::Database;

const IGNORED_CODE: &str = "SHORT_SHOT";
const RESOLVED_AT: &str = "2026-01-01T00:00:00+00:00";

/// The pre-v8 `resolved_warnings` shape: every current column except
/// `shot_uuid`.
const PRE_V8_COLUMNS: &str = "section_id INTEGER NOT NULL, \
     shot_id INTEGER NOT NULL, \
     warning_code TEXT NOT NULL, \
     resolved_at TEXT NOT NULL, \
     resolved_comment TEXT, \
     UNIQUE(section_id, shot_id, warning_code)";

/// A table whose rows do not say WHICH warning was ignored - no amount of
/// leniency recovers that.
const UNREADABLE_COLUMNS: &str = "section_id INTEGER NOT NULL, \
     shot_id INTEGER NOT NULL, \
     resolved_at TEXT NOT NULL";

/// What the seeded file holds, as this build wrote it.
struct Seeded {
    section_id: u32,
    shot_id: u32,
    shot_uuid: String,
}

/// Two shots with nothing for the v12 pitch-flip migration to vote on, so no
/// arm of the migration chain can be what an assertion below is measuring (the
/// same reasoning as `issue_485_tests::synthetic_project`).
fn synthetic_project() -> Project {
    let unflippable = |length: f64| ShotData {
        length,
        pitch_in: None,
        pitch_out: None,
        depth_in: 10.0,
        depth_out: 10.0,
        ..Default::default()
    };
    let mut project = Project::new("Forged".to_string(), None);
    project.add_section(SectionData {
        color: "#abcdef".to_string(),
        shots: vec![unflippable(5.0), unflippable(7.0)],
        ..Default::default()
    });
    project
}

/// Write a `.stalx` this build considers current, and report the ids it chose.
fn seed_current_file(path: &std::path::Path) -> Seeded {
    let mut db = Database::open(path).unwrap();
    db.save_project(&synthetic_project()).unwrap();
    let saved = db.load_project().unwrap();
    Seeded {
        section_id: saved.sections[0].id,
        shot_id: saved.sections[0].shots[0].id,
        shot_uuid: saved.sections[0].shots[0].uuid.clone().unwrap(),
    }
}

/// Replace `resolved_warnings` with `ddl` holding one ignore, WITHOUT touching
/// the stamp `Database::open` wrote.
///
/// That is the hostile shape: `PRAGMA user_version` says the whole migration
/// chain ran - so `ensure_schema_version` fast-paths and no `ALTER` ever fires
/// (#516 closed the ACCIDENTAL route into that state, not a deliberate one) -
/// while the table underneath is whatever `ddl` says. The stamp is read back
/// from the file rather than hard-coded, so this keeps meaning "the CURRENT
/// version" after the next schema bump.
fn forge_ignore_table(path: &std::path::Path, ddl: &str, columns: &str, values: &str) {
    let conn = rusqlite::Connection::open(path).unwrap();
    let stamped: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    conn.execute_batch(&format!(
        "DROP TABLE resolved_warnings;
         CREATE TABLE resolved_warnings (
            id INTEGER PRIMARY KEY,
            {ddl},
            FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
         );
         INSERT INTO resolved_warnings ({columns}) VALUES ({values});"
    ))
    .unwrap();

    // The fixture must really be the shape under test, or every assertion in
    // the tests below could pass vacuously.
    assert!(
        stamped >= 8,
        "the current schema must be past the v8 shot_uuid migration, got {stamped}"
    );
    let still_stamped: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        still_stamped, stamped,
        "the forged file must still CLAIM the current schema"
    );
    let has_uuid_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('resolved_warnings') WHERE name='shot_uuid'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_uuid_column, 0, "the forged table must be pre-v8");
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM resolved_warnings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "the forged file must hold exactly one ignore");
}

/// THE forged-stamp regression guard. A hostile (or merely hand-edited) file
/// can stamp the current `user_version` over pre-v8 tables, which sends
/// `ensure_schema_version` down its fast path and leaves `shot_uuid` missing
/// forever.
///
/// Red before the fix: swap `load_resolved_warnings_verbatim` back to
/// `load_resolved_warnings` in `project_io.rs` and the read fails with
/// `no such column: shot_uuid`, the old `Vec::new()` arm carries nothing, and
/// the saved file comes back with 0 rows.
#[test]
fn a_forged_current_stamp_over_pre_v8_tables_does_not_erase_the_ignore_list() {
    // open_project records the path in recent projects (global config).
    let _cfg = crate::test_helpers::isolated_config();
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("forged.stalx");
    let seeded = seed_current_file(&path);
    forge_ignore_table(
        &path,
        PRE_V8_COLUMNS,
        "section_id, shot_id, warning_code, resolved_at",
        &format!(
            "{}, {}, '{IGNORED_CODE}', '{RESOLVED_AT}'",
            seeded.section_id, seeded.shot_id
        ),
    );

    let state = AppState::new().unwrap();
    let opened = state.open_project(path.clone());
    assert!(opened.success, "open failed: {:?}", opened.error);

    let saved = state.save_project(Some(path.clone()));
    assert!(saved.success, "save failed: {:?}", saved.error);

    let rows = Database::open_existing(&path)
        .unwrap()
        .load_resolved_warnings()
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "the ignore must survive a save through a forged-stamp pre-v8 file"
    );
    assert_eq!(rows[0].warning_code, IGNORED_CODE);
    assert_eq!(
        rows[0].shot_uuid.as_deref(),
        Some(seeded.shot_uuid.as_str()),
        "and must still name the shot it was recorded against"
    );
}

/// A table this build cannot make sense of AT ALL - here one whose rows do not
/// say which warning was ignored. The save rebuilds the file's ignore list from
/// what it reads, so guessing "empty" would destroy the rows on disk; it
/// refuses instead, and the file is left as it was.
///
/// Red before the fix: restore the `Vec::new()` arm and the save reports
/// success, failing both the `!success` assertion and (because the rebuilt file
/// carries no ignores) the "the file still holds its row" one.
#[test]
fn a_save_is_refused_when_the_ignore_list_cannot_be_read_at_all() {
    let _cfg = crate::test_helpers::isolated_config();
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("unreadable.stalx");
    let seeded = seed_current_file(&path);
    forge_ignore_table(
        &path,
        UNREADABLE_COLUMNS,
        "section_id, shot_id, resolved_at",
        &format!("{}, {}, '{RESOLVED_AT}'", seeded.section_id, seeded.shot_id),
    );
    let has_code_column: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('resolved_warnings') WHERE \
             name='warning_code'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        has_code_column, 0,
        "the fixture must be missing the column that makes a row readable"
    );

    let state = AppState::new().unwrap();
    let opened = state.open_project(path.clone());
    assert!(opened.success, "open failed: {:?}", opened.error);

    let saved = state.save_project(Some(path.clone()));
    assert!(
        !saved.success,
        "a save that cannot read the ignore list it is about to rewrite must be refused"
    );
    let error = saved.error.unwrap_or_default();
    assert!(
        error.contains("ignored warnings"),
        "the refusal must say what it could not read, got: {error}"
    );

    // The refusal lands before the temp file is created, so the destination is
    // untouched: the row is still there, and no debris was left beside it.
    let rows: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM resolved_warnings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "the refused save must leave the old rows in place");
    assert!(
        !path.with_extension("stalx.tmp").exists(),
        "a refused save must not leave a temp file behind"
    );
}

/// The other half of the distinction: genuinely EMPTY still saves clean. Two
/// spellings of empty - a table with no rows, and (the pre-#57 file) no table
/// at all - because a fix that answered "cannot tell" to both would refuse
/// every save of every legacy project.
///
/// Red if `load_resolved_warnings_verbatim` reported a missing table as an
/// error: the second save would be refused.
#[test]
fn an_absent_or_empty_ignore_list_still_saves_clean() {
    let _cfg = crate::test_helpers::isolated_config();
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("empty.stalx");
    seed_current_file(&path);

    let state = AppState::new().unwrap();
    assert!(state.open_project(path.clone()).success);
    let saved = state.save_project(Some(path.clone()));
    assert!(
        saved.success,
        "an empty ignore list must save: {:?}",
        saved.error
    );
    assert!(Database::open_existing(&path)
        .unwrap()
        .load_resolved_warnings()
        .unwrap()
        .is_empty());
    state.close_project();

    // Now the pre-#57 shape: no resolved_warnings table at all. The save above
    // left the stamp current, so no migration recreates it before the next save
    // reads it.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE resolved_warnings;")
        .unwrap();
    let table_gone: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='resolved_warnings'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(table_gone, 0, "the fixture must have no ignore table");

    let state = AppState::new().unwrap();
    assert!(state.open_project(path.clone()).success);
    let saved = state.save_project(Some(path));
    assert!(
        saved.success,
        "a file with no ignore table must save: {:?}",
        saved.error
    );
}
