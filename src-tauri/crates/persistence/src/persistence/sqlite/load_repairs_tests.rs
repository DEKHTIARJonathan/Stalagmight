//! [#576 B35(h)] Non-finite values are reset at the load boundary, and the load
//! report counts every value it reset.
//!
//! Moved out of `tests.rs` unchanged (#576 E8: the monolith is frozen).

use std::path::Path;

use rusqlite::Connection;
use tempfile::TempDir;

use super::upgrade_safety_tests::b6_build_file;
use super::{Database, LoadRepairs};

/// A current file with one section of two shots, then `surgery` with `{sid}`
/// replaced by that section's id.
fn b35_build_file(dir: &Path, surgery: &str) -> std::path::PathBuf {
    let path = b6_build_file(dir, "CaveA.stalx", "");
    let conn = Connection::open(&path).unwrap();
    let sid: i64 = conn
        .query_row("SELECT id FROM sections LIMIT 1", [], |r| r.get(0))
        .unwrap();
    conn.execute_batch(&surgery.replace("{sid}", &sid.to_string()))
        .unwrap();
    path
}

/// [#576 B35(h)] A station offset is loaded with the same finiteness guard as
/// shots and section offsets: a non-finite component (SQLite stores `9e999` as
/// +Inf; NaN cannot be stored) is reset to 0 at the load boundary. It used to be
/// inserted verbatim and added straight into world coordinates, so the whole
/// downstream - gap metrics, the loop-closure solve - ran on infinities.
#[test]
fn a_non_finite_station_offset_is_reset_on_load() {
    let temp = TempDir::new().unwrap();
    let path = b35_build_file(
        temp.path(),
        "INSERT INTO station_offsets (section_id, station_index, offset_x, offset_y, offset_z)
         VALUES ({sid}, 1, 9e999, 2.5, -9e999);",
    );

    let project = Database::open_existing(&path)
        .unwrap()
        .load_project()
        .unwrap();
    let offset = project.station_offsets.values().next().copied();
    println!("station offset after load: {offset:?}");
    assert_eq!(
        offset,
        Some((0.0, 2.5, 0.0)),
        "only the non-finite components are reset; the finite one is a real move"
    );
}

/// [#576 B35(h)] The load report counts every value the load reset, per kind, so
/// the open can tell the user once (the next save makes the reset permanent).
/// A clean file reports nothing.
#[test]
fn the_load_report_counts_every_value_it_reset() {
    let temp = TempDir::new().unwrap();
    let clean = b6_build_file(temp.path(), "Clean.stalx", "");
    let (_, report) = Database::open_existing(&clean)
        .unwrap()
        .load_project_with_report()
        .unwrap();
    assert!(
        report.repairs.is_empty(),
        "a clean file: {:?}",
        report.repairs
    );

    let path = b35_build_file(
        temp.path(),
        "UPDATE shots SET azimuth_in = 9e999 WHERE section_id = {sid} AND sequence_order = 0;
         INSERT OR REPLACE INTO section_offsets (section_id, offset_x, offset_y)
         VALUES ({sid}, 9e999, 1.0);
         INSERT INTO station_offsets (section_id, station_index, offset_x, offset_y, offset_z)
         VALUES ({sid}, 1, 9e999, 0.0, 0.0), ({sid}, 2, 1.0, 2.0, 3.0);",
    );
    let (_, report) = Database::open_existing(&path)
        .unwrap()
        .load_project_with_report()
        .unwrap();
    println!("load repairs: {:?}", report.repairs);
    assert_eq!(
        report.repairs,
        LoadRepairs {
            shots: 1,
            section_offsets: 1,
            station_offsets: 1,
            gps_points: 0,
        }
    );
}
