//! [#576 NF-W14BE-1] `sections.created_at` holds when each section was CREATED.
//!
//! Every save overwrote the column with the save's own time, and the load never
//! read it back, so the column held the last save time. A section's first save
//! stamps it now; every later save keeps the stored value, and a section added
//! later gets its own.
//!
//! The "first save an hour ago" is injected by backdating the column of a saved
//! file, so the tests need no clock. All data is synthetic.

use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use rusqlite::Connection;
use tempfile::TempDir;

use super::Database;
use crate::models::{Project, SectionData, ShotData};

fn section(name: &str) -> SectionData {
    SectionData {
        name: Some(name.to_string()),
        surveyor: None,
        date: None,
        color: "#123456".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![ShotData {
            length: 5.0,
            ..Default::default()
        }],
    }
}

/// `(section name, created_at)` of every row, in id order.
fn created_at(path: &Path) -> Vec<(String, String)> {
    let conn = Connection::open(path).unwrap();
    let mut stmt = conn
        .prepare("SELECT name, created_at FROM sections ORDER BY id")
        .unwrap();
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// Rewrite every section's `created_at` to `at`: the stamp a save made then.
fn backdate(path: &Path, at: &str) {
    let conn = Connection::open(path).unwrap();
    conn.execute("UPDATE sections SET created_at = ?1", [at])
        .unwrap();
}

/// A one-section project saved to `CaveA.stalx`, its section stamped an hour
/// ago. Returns the file and that stamp.
fn saved_an_hour_ago(dir: &TempDir) -> (std::path::PathBuf, String) {
    let path = dir.path().join("CaveA.stalx");
    let mut project = Project::new("CaveA".to_string(), None);
    project.add_section(section("SectionA"));
    Database::open(&path)
        .unwrap()
        .save_project(&project)
        .unwrap();
    let first_save = (Utc::now() - Duration::hours(1)).to_rfc3339();
    backdate(&path, &first_save);
    (path, first_save)
}

#[test]
fn a_second_save_an_hour_later_keeps_the_first_saves_created_at() {
    let dir = TempDir::new().unwrap();
    let (path, first_save) = saved_an_hour_ago(&dir);
    let reopened = Database::open_existing(&path)
        .unwrap()
        .load_project()
        .unwrap();

    // What the app's save does: a fresh file, renamed over the destination.
    let fresh = dir.path().join("CaveA-fresh.stalx");
    Database::open(&fresh)
        .unwrap()
        .save_project(&reopened)
        .unwrap();
    // What the in-place writers do: the same file again.
    Database::open_existing(&path)
        .unwrap()
        .save_project(&reopened)
        .unwrap();

    let expected = vec![("SectionA".to_string(), first_save.clone())];
    println!("NF-W14BE-1 first save stamped SectionA {first_save}");
    println!(
        "NF-W14BE-1 after a second save to a fresh file: {:?}",
        created_at(&fresh)
    );
    println!(
        "NF-W14BE-1 after a second save in place: {:?}",
        created_at(&path)
    );
    assert_eq!(created_at(&fresh), expected, "save to a fresh file");
    assert_eq!(created_at(&path), expected, "save in place");
}

#[test]
fn a_section_added_after_the_first_save_gets_its_own_time() {
    let dir = TempDir::new().unwrap();
    let (path, first_save) = saved_an_hour_ago(&dir);
    let mut reopened = Database::open_existing(&path)
        .unwrap()
        .load_project()
        .unwrap();
    reopened.add_section(section("SectionB"));

    let again = dir.path().join("CaveA-again.stalx");
    let before = Utc::now();
    Database::open(&again)
        .unwrap()
        .save_project(&reopened)
        .unwrap();
    let after = Utc::now();

    let rows = created_at(&again);
    println!("NF-W14BE-1 first save stamped SectionA {first_save}");
    println!("NF-W14BE-1 after adding SectionB and saving: {rows:?}");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], ("SectionA".to_string(), first_save), "SectionA");
    let stamped_b = DateTime::parse_from_rfc3339(&rows[1].1)
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(rows[1].0, "SectionB");
    assert!(
        before <= stamped_b && stamped_b <= after,
        "SectionB is stamped by the save that first wrote it: {stamped_b} not in [{before}, {after}]"
    );
}

#[test]
fn a_stored_created_at_reads_back_into_the_model_and_an_unparseable_one_does_not() {
    let dir = TempDir::new().unwrap();
    let (path, first_save) = saved_an_hour_ago(&dir);
    let loaded = Database::open_existing(&path)
        .unwrap()
        .load_project()
        .unwrap();
    let expected = DateTime::parse_from_rfc3339(&first_save)
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(loaded.sections[0].created_at, Some(expected));

    // Not a value this app writes: it loads as "never stamped", so the next
    // save writes a time it can read rather than carrying text it cannot.
    backdate(&path, "yesterday");
    let loaded = Database::open_existing(&path)
        .unwrap()
        .load_project()
        .unwrap();
    assert_eq!(loaded.sections[0].created_at, None);
}
