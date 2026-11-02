//! [#576 C7] The geometry queries behind the closure-adjusted view, the distance
//! gradient and the ruler tell "no project open" from "the project cannot be
//! read".
//!
//! The IPC commands for these three were infallible: an unreadable project (a
//! poisoned lock - an earlier operation panicked while holding it) came back as
//! `None`, exactly like "no project open", and reached the frontend as an empty
//! adjusted view, an absent distance field or "no path". The checked variants the
//! commands now use answer `Err` there, so the frontend's failure paths run.
//!
//! All data is synthetic.

use super::AppState;
use crate::core::Command;
use crate::models::{RulerEndpoint, ShotData, StationRef};

fn with_project() -> (AppState, u32) {
    let state = AppState::new().unwrap();
    assert!(
        state
            .execute(Command::CreateProject {
                name: "CaveA".to_string(),
                location: None,
            })
            .success
    );
    let created = state.execute(Command::CreateSection {
        name: Some("SectionA".to_string()),
        surveyor: None,
        date: None,
        color: "#336699".to_string(),
        direction: None,
        shots: (0..3)
            .map(|i| ShotData {
                length: 5.0,
                azimuth_in: 40.0 * f64::from(i),
                azimuth_out: 40.0 * f64::from(i),
                ..Default::default()
            })
            .collect(),
    });
    (state, created.section_id.unwrap())
}

fn station(section_id: u32, station_index: u32) -> RulerEndpoint {
    RulerEndpoint {
        section_id,
        station_index: Some(station_index),
        shot_id: None,
        t: None,
    }
}

/// Poison the project mutex the way a panic inside a guarded section does.
fn poison_project(state: &AppState) {
    std::thread::scope(|scope| {
        let crashed = scope
            .spawn(|| {
                let _guard = state.project.lock().unwrap();
                panic!("synthetic panic while holding the project lock (#576 C7 test)");
            })
            .join();
        assert!(crashed.is_err(), "the helper thread panicked on purpose");
    });
    assert!(
        state.project.lock().is_err(),
        "the project mutex is poisoned"
    );
}

#[test]
fn an_unreadable_project_is_an_error_not_an_empty_answer() {
    let _cfg = crate::test_helpers::isolated_config();

    // Healthy: every query answers.
    let (state, sid) = with_project();
    assert!(matches!(state.adjusted_stations_checked(), Ok(Some(ref s)) if !s.is_empty()));
    assert!(matches!(state.distance_field_checked(None), Ok(Some(_))));
    assert!(matches!(
        state.along_line_between_checked(station(sid, 0), station(sid, 3)),
        Ok(Some(_))
    ));

    // No project open: an honest empty answer, not an error.
    let empty = AppState::new().unwrap();
    assert!(matches!(empty.adjusted_stations_checked(), Ok(None)));
    assert!(matches!(empty.distance_field_checked(None), Ok(None)));
    assert!(matches!(
        empty.along_line_between_checked(station(1, 0), station(1, 1)),
        Ok(None)
    ));

    // A project is open but cannot be read.
    poison_project(&state);
    state.invalidate_adjusted_cache();
    let adjusted = state.adjusted_stations_checked();
    let distance = state.distance_field_checked(None);
    let along = state.along_line_between_checked(station(sid, 0), station(sid, 3));
    println!(
        "unreadable project: adjusted -> {:?}, distance -> {:?}, along-line -> {:?}",
        adjusted.as_ref().map(|s| s.as_ref().map(Vec::len)),
        distance.as_ref().map(Option::is_some),
        along.as_ref().map(Option::is_some),
    );
    println!(
        "  (the internal callers' Option API still reads it as absent: adjusted {:?}, \
         distance {:?})",
        state.get_adjusted_stations().map(|s| s.len()),
        state.distance_field(None).is_some(),
    );
    assert!(
        adjusted.is_err(),
        "the adjusted view must fail, not come back empty"
    );
    assert!(
        distance.is_err(),
        "the distance field must fail, not read as absent"
    );
    assert!(along.is_err(), "the ruler must fail, not read as no path");
}
