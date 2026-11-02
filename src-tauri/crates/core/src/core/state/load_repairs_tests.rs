//! [#576 B35(h), B35(g)] What opening a damaged file resets or drops, and how
//! the user is told.
//!
//! - Non-finite shot values, section offsets and station offsets are reset at
//!   the load boundary (station offsets used to load verbatim), and a save heals
//!   an in-memory non-finite station offset too.
//! - Every reset or dropped value is counted on the load result, so the
//!   frontend can show one notice after the open.
//!
//! All data is synthetic, built in memory or written with SQL into a file this
//! build saved. No fixture is read or written.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;

use super::AppState;
use crate::models::{Project, SectionData, ShotData, StationKey};
use crate::persistence::Database;

/// `do_load_project_full` reports progress through the installed sink; nobody
/// is listening here.
struct NoListener;

impl crate::core::events::EventSink for NoListener {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}

    fn with_app_state(&self, _f: Box<dyn FnOnce(&AppState) + Send>) -> bool {
        false
    }
}

fn state_with_sink() -> AppState {
    let state = AppState::new().unwrap();
    state.set_event_sink(Arc::new(NoListener));
    state
}

fn two_shot_project() -> Project {
    let mut project = Project::new("CaveA".to_string(), None);
    project.add_section(SectionData {
        name: Some("SectionA".to_string()),
        color: "#123456".to_string(),
        shots: vec![
            ShotData {
                length: 5.0,
                ..Default::default()
            },
            ShotData {
                length: 7.0,
                ..Default::default()
            },
        ],
        ..Default::default()
    });
    project.ensure_shot_uuids();
    project
}

/// A file this build saved, then `surgery` (with `{sid}` replaced by the
/// section's id) applied with plain SQL.
fn damaged_file(dir: &Path, surgery: &str) -> PathBuf {
    let path = dir.join("CaveA.stalx");
    let mut db = Database::open(&path).unwrap();
    db.save_project(&two_shot_project()).unwrap();
    drop(db);
    let conn = rusqlite::Connection::open(&path).unwrap();
    let sid: i64 = conn
        .query_row("SELECT id FROM sections LIMIT 1", [], |r| r.get(0))
        .unwrap();
    conn.execute_batch(&surgery.replace("{sid}", &sid.to_string()))
        .unwrap();
    path
}

fn stored_station_offsets(path: &Path) -> Vec<(f64, f64, f64)> {
    let conn = rusqlite::Connection::open(path).unwrap();
    let mut stmt = conn
        .prepare("SELECT offset_x, offset_y, offset_z FROM station_offsets")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

/// [#576 B35(h)] A save heals a non-finite station offset held in memory, as it
/// already did for shots and section offsets: an infinite one used to be written
/// to the file as it was, to poison the next open.
#[test]
fn a_save_heals_a_non_finite_station_offset() {
    let temp = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    let mut project = two_shot_project();
    let sid = project.sections[0].id;
    let mut offsets: HashMap<StationKey, (f64, f64, f64)> = HashMap::new();
    offsets.insert(
        StationKey::positional(sid, 1),
        (f64::INFINITY, 1.5, f64::NEG_INFINITY),
    );
    project.station_offsets = offsets;
    state.set_project_for_tests(project);

    let path = temp.path().join("healed.stalx");
    let result = state.save_project(Some(path.clone()));
    assert!(result.success, "save: {:?}", result.error);
    let stored = stored_station_offsets(&path);
    println!("station_offsets rows written by the save: {stored:?}");
    assert_eq!(
        stored,
        vec![(0.0, 1.5, 0.0)],
        "the save must reset the non-finite components and keep the finite one"
    );
}

/// The envelope's `load_repairs` key, as the frontend decoder reads it.
#[derive(serde::Deserialize, Debug, PartialEq, Eq)]
struct EnvelopeRepairs {
    shots: usize,
    section_offsets: usize,
    station_offsets: usize,
    gps_points: usize,
}

#[derive(serde::Deserialize)]
struct EnvelopeWithRepairs {
    load_repairs: EnvelopeRepairs,
}

/// [#576 B35(h)] The production load path hands the counts to the frontend:
/// on the load result, and as the `load_repairs` key of the binary envelope the
/// frontend actually decodes.
#[test]
fn the_load_result_and_the_binary_envelope_carry_what_the_load_reset() {
    let _cfg = crate::test_helpers::isolated_config();
    let temp = TempDir::new().unwrap();
    let path = damaged_file(
        temp.path(),
        "UPDATE shots SET length = 9e999 WHERE section_id = {sid} AND sequence_order = 1;
         INSERT INTO station_offsets (section_id, station_index, offset_x, offset_y, offset_z)
         VALUES ({sid}, 1, 9e999, 0.0, 0.0), ({sid}, 2, 0.0, -9e999, 0.0);",
    );

    let state = state_with_sink();
    let loaded = state
        .do_load_project_full(path)
        .unwrap_or_else(|e| panic!("a damaged-but-readable file opens: {e:?}"));
    println!("load_repairs on the result: {:?}", loaded.load_repairs);
    assert_eq!(loaded.load_repairs.shots, 1);
    assert_eq!(loaded.load_repairs.station_offsets, 2);
    assert!(
        loaded
            .project
            .station_offsets
            .values()
            .all(|o| o.0.is_finite() && o.1.is_finite() && o.2.is_finite()),
        "no infinity reaches the open project"
    );

    let bytes = crate::core::load_binary::encode(loaded).unwrap();
    let envelope: EnvelopeWithRepairs = rmp_serde::from_slice(&bytes).unwrap();
    println!("envelope load_repairs: {:?}", envelope.load_repairs);
    assert_eq!(
        envelope.load_repairs,
        EnvelopeRepairs {
            shots: 1,
            section_offsets: 0,
            station_offsets: 2,
            gps_points: 0,
        }
    );
}
