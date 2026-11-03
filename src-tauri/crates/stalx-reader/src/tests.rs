#![expect(clippy::unwrap_used, reason = "test assertions")]
#![expect(
    clippy::float_cmp,
    reason = "values must round-trip through SQLite exactly"
)]

use std::path::{Path, PathBuf};

use stalagmight_models::station::{GpsCoordinates, LoopClosure as ModelClosure, StationRef};
use stalagmight_models::{
    ClosureStrategy, Project, SectionData, ShotData, ShotKind as ModelShotKind, SurveyDirection,
};
use stalagmight_persistence::persistence::Database;
use tempfile::TempDir;

use super::{
    read_bytes, read_file, read_file_with, Direction, ReadError, ReadOptions, ShotKind, StationId,
    SUPPORTED_SCHEMA_VERSION,
};

/// 30-degree descents (length 10, dz 5), pitch stored with `sign`.
fn descending(name: &str, sign: f64, count: usize) -> SectionData {
    SectionData {
        name: Some(name.to_string()),
        surveyor: Some("user1".to_string()),
        date: None,
        color: "#ff5733".to_string(),
        direction: Some(SurveyDirection::In),
        quality: 1.0,
        shots: (0..count)
            .map(|i| ShotData {
                azimuth_in: 90.0,
                azimuth_out: 270.0,
                length: 10.0,
                depth_in: 5.0 * i as f64,
                depth_out: 5.0 * (i + 1) as f64,
                pitch_in: Some(sign * 30.0),
                pitch_out: Some(sign * 30.0),
                ..Default::default()
            })
            .collect(),
    }
}

fn save(dir: &TempDir, project: &Project) -> PathBuf {
    let path = dir.path().join("synthetic.stalx");
    Database::open(&path)
        .unwrap()
        .save_project(project)
        .unwrap();
    path
}

fn set_user_version(path: &Path, version: i32) {
    rusqlite::Connection::open(path)
        .unwrap()
        .pragma_update(None, "user_version", version)
        .unwrap();
}

/// Two sections, one merge, one datum, one closure, one comment.
fn full_project() -> Project {
    let mut project = Project::new("Synthetic".to_string(), Some("Nowhere".to_string()));
    project.add_section(descending("Main", 1.0, 4));
    let mut side = descending("Side", 1.0, 2);
    side.direction = Some(SurveyDirection::Out);
    side.shots[0].left = Some(1.5);
    side.shots[1].kind = ModelShotKind::Jump;
    side.shots[1].comment = Some("sump".to_string());
    project.add_section(side);

    let (main, side) = (project.sections[0].id, project.sections[1].id);
    project
        .merge_stations(StationRef::new(main, 2), StationRef::new(side, 0))
        .unwrap();
    project
        .set_zero_datum(
            StationRef::new(main, 0),
            GpsCoordinates::new(20.5, -87.4, 0.0).unwrap(),
        )
        .unwrap();
    let a = project.key_for_ref(StationRef::new(main, 4)).unwrap();
    let b = project.key_for_ref(StationRef::new(side, 2)).unwrap();
    project.loop_closures.push(ModelClosure {
        id: 7,
        station_a: a.clone(),
        station_b: b,
        path_length: 0.0,
        misclosure_distance: 0.0,
        error_percentage: 0.0,
        horizontal_misclosure: 0.0,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });
    project.station_comments.insert(a, "lead".to_string());
    project
}

#[test]
fn reads_every_part_of_a_current_file() {
    let dir = TempDir::new().unwrap();
    let path = save(&dir, &full_project());

    let survey = read_file(&path).unwrap();

    assert_eq!(survey.schema_version, SUPPORTED_SCHEMA_VERSION);
    assert_eq!(survey.name, "Synthetic");
    assert_eq!(survey.location.as_deref(), Some("Nowhere"));
    assert_eq!(survey.sections.len(), 2);
    let (main, side) = (&survey.sections[0], &survey.sections[1]);
    assert_eq!(main.shots.len(), 4);
    assert_eq!(side.direction, Direction::Out);
    assert_eq!(main.shots[0].pitch_in, Some(30.0), "pitch is +down");
    assert_eq!(main.shots[0].azimuth_out, 270.0);
    assert_eq!(side.shots[0].left, Some(1.5));
    assert_eq!(side.shots[0].right, None, "an absent LRUD stays absent");
    assert_eq!(side.shots[1].kind, ShotKind::Jump);
    assert_eq!(side.shots[1].comment.as_deref(), Some("sump"));
    assert_eq!(main.surveyor.as_deref(), Some("user1"));
    assert_eq!(main.color, "#ff5733");
    assert_eq!(main.north, super::North::Magnetic);
    assert_eq!(main.azimuth_correction_deg, 0.0);

    let id = |section: u32, index| StationId {
        section_id: section,
        index,
    };
    assert_eq!(survey.station_merges.len(), 1);
    assert_eq!(survey.station_merges[0].a, id(main.id, 2));
    assert_eq!(survey.station_merges[0].b, id(side.id, 0));
    assert_eq!(survey.zero_datums.len(), 1);
    assert_eq!(survey.zero_datums[0].station, id(main.id, 0));
    assert_eq!(survey.zero_datums[0].latitude, 20.5);
    assert_eq!(survey.loop_closures.len(), 1);
    assert_eq!(survey.loop_closures[0].id, 7);
    assert_eq!(survey.loop_closures[0].b, id(side.id, 2));
    assert_eq!(survey.station_comments.len(), 1);
    assert_eq!(survey.station_comments[0].station, id(main.id, 4));
    assert_eq!(survey.station_comments[0].text, "lead");
    assert_eq!(survey.unresolved_references, 0);
    assert!(survey.stations.is_none(), "positions are opt-in");
}

#[test]
fn the_source_file_is_never_modified() {
    let dir = TempDir::new().unwrap();
    let path = save(&dir, &full_project());
    // An old version forces the migration chain to run, on the copy only.
    set_user_version(&path, 11);
    let before = std::fs::read(&path).unwrap();

    read_file(&path).unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn an_old_file_is_migrated_before_it_is_read() {
    // A pre-v12 file stored descending pitch as negative; the v12 migration flips
    // it. A raw read would return -30 here.
    let dir = TempDir::new().unwrap();
    let mut project = Project::new("Legacy".to_string(), None);
    project.add_section(descending("OldConvention", -1.0, 4));
    let path = save(&dir, &project);
    set_user_version(&path, 11);

    let survey = read_file(&path).unwrap();

    assert_eq!(survey.schema_version, 11, "reports the file's own version");
    assert!(survey.sections[0]
        .shots
        .iter()
        .all(|s| s.pitch_in == Some(30.0)));
}

#[test]
fn a_newer_schema_is_refused() {
    let dir = TempDir::new().unwrap();
    let path = save(&dir, &full_project());
    set_user_version(&path, SUPPORTED_SCHEMA_VERSION + 1);

    let err = read_file(&path).unwrap_err();

    assert!(
        matches!(err, ReadError::NewerSchema { found, supported }
            if found == SUPPORTED_SCHEMA_VERSION + 1 && supported == SUPPORTED_SCHEMA_VERSION),
        "{err}"
    );
}

#[test]
fn an_oversized_input_is_refused_before_it_is_read() {
    let dir = TempDir::new().unwrap();
    let path = save(&dir, &full_project());

    let err = read_file_with(&path, &ReadOptions::default().max_file_bytes(1024)).unwrap_err();

    assert!(matches!(err, ReadError::TooLarge { max: 1024 }), "{err}");
}

#[test]
fn bytes_that_are_not_a_stalx_are_invalid() {
    for bytes in [b"".as_slice(), b"not a database".as_slice(), &[0u8; 4096]] {
        let err = read_bytes(bytes, &ReadOptions::default()).unwrap_err();
        assert!(matches!(err, ReadError::Invalid(_)), "{err}");
    }
}

#[test]
fn a_sqlite_file_without_project_data_is_invalid() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("empty.stalx");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE t (x INTEGER);")
        .unwrap();

    let err = read_file(&path).unwrap_err();

    assert!(matches!(err, ReadError::Invalid(_)), "{err}");
}

#[test]
fn station_positions_cover_every_station_when_requested() {
    let dir = TempDir::new().unwrap();
    let path = save(&dir, &full_project());

    let survey = read_file_with(&path, &ReadOptions::default().with_stations(true)).unwrap();

    let stations = survey.stations.unwrap();
    let main = survey.sections[0].id;
    let origin = stations
        .iter()
        .find(|s| {
            s.station
                == StationId {
                    section_id: main,
                    index: 0,
                }
        })
        .unwrap();
    let last = stations
        .iter()
        .find(|s| {
            s.station
                == StationId {
                    section_id: main,
                    index: 4,
                }
        })
        .unwrap();
    assert!(
        (last.z - origin.z - 20.0).abs() < 1e-9,
        "four 5 m descents put the end 20 m deeper"
    );
    for section in &survey.sections {
        for index in 0..=section.shots.len() as u32 {
            let want = StationId {
                section_id: section.id,
                index,
            };
            assert!(
                stations.iter().any(|s| s.station == want),
                "missing position for {want:?}"
            );
        }
    }
}

/// A file whose own schema would run SQL during the load.
fn with_schema_sql(sql: &str) -> PathBuf {
    let dir = Box::leak(Box::new(TempDir::new().unwrap()));
    let path = save(dir, &full_project());
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(sql)
        .unwrap();
    path
}

#[test]
fn views_triggers_and_virtual_tables_are_refused() {
    for sql in [
        // An endless recursive view standing in for a real table.
        "ALTER TABLE shots RENAME TO real_shots;
         CREATE VIEW shots AS WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n)
           SELECT * FROM real_shots, n;",
        "CREATE TRIGGER t AFTER UPDATE ON shots BEGIN UPDATE shots SET length = 0; END;",
        "CREATE VIRTUAL TABLE v USING rtree(id, a, b);",
        // A non-canonical spelling SQLite still parses as a virtual table, which
        // a match on the stored text would miss.
        "PRAGMA writable_schema = ON;
         INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql)
           VALUES ('table', 'v2', 'v2', 0, 'CREATE/**/VIRTUAL  TABLE v2 USING rtree(id, a, b)');",
    ] {
        let err = read_file(&with_schema_sql(sql)).unwrap_err();
        assert!(
            matches!(&err, ReadError::Invalid(m) if m.contains("view(s), trigger(s)")),
            "{sql}: {err}"
        );
    }
}

#[test]
fn a_newer_version_claimed_by_the_project_row_is_refused() {
    // Files from before the pragma carry their version in the project row; the
    // app falls back to it when user_version is 0, and so must the reader.
    let path = with_schema_sql(&format!(
        "PRAGMA user_version = 0; UPDATE project SET schema_version = {};",
        SUPPORTED_SCHEMA_VERSION + 1
    ));

    let err = read_file(&path).unwrap_err();

    assert!(matches!(err, ReadError::NewerSchema { .. }), "{err}");
}

#[test]
fn a_negative_schema_version_is_invalid() {
    let path = with_schema_sql("PRAGMA user_version = -1;");

    let err = read_file(&path).unwrap_err();

    assert!(matches!(err, ReadError::Invalid(_)), "{err}");
}

#[test]
fn read_bytes_enforces_its_own_size_cap() {
    let err = read_bytes(&[0u8; 2048], &ReadOptions::default().max_file_bytes(1024)).unwrap_err();

    assert!(matches!(err, ReadError::TooLarge { max: 1024 }), "{err}");
}

#[test]
fn an_expired_deadline_interrupts_a_long_statement() {
    // A plain filler table is allowed, but the integrity check walks it in one
    // long statement, which the deadline must interrupt.
    let path = with_schema_sql(
        "CREATE TABLE filler (x);
         WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50000)
           INSERT INTO filler SELECT x FROM n;",
    );

    let err = read_file_with(
        &path,
        &ReadOptions::default().deadline(std::time::Duration::ZERO),
    )
    .unwrap_err();

    assert!(
        matches!(&err, ReadError::Invalid(m) if m.contains("interrupt")),
        "{err}"
    );
}

#[test]
fn a_dangling_cross_reference_is_dropped_and_counted() {
    let path = with_schema_sql("UPDATE station_comments SET station_index = 999;");

    let survey = read_file(&path).unwrap();

    assert!(survey.station_comments.is_empty());
    assert_eq!(survey.unresolved_references, 1);
}

#[test]
fn generated_columns_are_refused() {
    // 2 MiB per row from a tiny file; allowed with trusted_schema off.
    let path = with_schema_sql(
        "ALTER TABLE sections ADD COLUMN g TEXT
           GENERATED ALWAYS AS (hex(zeroblob(1048576))) VIRTUAL;",
    );

    let err = read_file(&path).unwrap_err();

    assert!(
        matches!(&err, ReadError::Invalid(m) if m.contains("generated column")),
        "{err}"
    );
}

#[test]
fn a_pending_kind_classification_is_completed_like_the_app_does() {
    // Without the loop closure, the Side section's Jump reaches real survey at one
    // point only, which the classifier calls a Reference - but only when an old
    // file's migration left the one-shot classification pending.
    let path = with_schema_sql(
        "DELETE FROM loop_closures;
         INSERT INTO project_settings (key, value) VALUES ('pending_kind_classification', '1');",
    );

    let survey = read_file(&path).unwrap();

    assert_eq!(survey.sections[1].shots[1].kind, ShotKind::Reference);
}

#[test]
fn drifted_section_offsets_are_re_derived_before_positions() {
    let dir = TempDir::new().unwrap();
    let path = save(&dir, &full_project());
    let survey = read_file(&path).unwrap();
    let (main, side) = (survey.sections[0].id, survey.sections[1].id);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE section_offsets SET offset_x = offset_x + 100 WHERE section_id = ?1",
            [side],
        )
        .unwrap();

    let survey = read_file_with(&path, &ReadOptions::default().with_stations(true)).unwrap();

    let at = |section_id, index| {
        survey
            .stations
            .as_ref()
            .unwrap()
            .iter()
            .find(|s| s.station == StationId { section_id, index })
            .copied()
            .unwrap()
    };
    let (a, b) = (at(main, 2), at(side, 0));
    assert!(
        (a.x - b.x).abs() < 1e-6 && (a.y - b.y).abs() < 1e-6,
        "merged stations coincide: {a:?} vs {b:?}"
    );
}

#[test]
fn legacy_closures_get_ids_like_the_app_assigns() {
    let path = with_schema_sql("UPDATE loop_closures SET closure_id = 0;");

    let survey = read_file(&path).unwrap();

    assert_eq!(survey.loop_closures.len(), 1);
    assert_ne!(survey.loop_closures[0].id, 0);
}

#[test]
fn an_oversized_file_is_refused_without_buffering_it() {
    // `read_file_with` streams into the copy and stops one byte past the cap.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("big.stalx");
    std::fs::write(&path, vec![0u8; 4096]).unwrap();

    let err = read_file_with(&path, &ReadOptions::default().max_file_bytes(1024)).unwrap_err();

    assert!(matches!(err, ReadError::TooLarge { max: 1024 }), "{err}");
}
