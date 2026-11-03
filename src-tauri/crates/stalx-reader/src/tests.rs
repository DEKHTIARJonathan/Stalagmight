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

    assert!(
        matches!(err, ReadError::TooLarge { max: 1024, .. }),
        "{err}"
    );
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
}
