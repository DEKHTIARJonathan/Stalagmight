//! [#576 A4] Every forward mutation entry point runs the shared forward epilogue.
//!
//! Behavioural, through the test seam in `command_epilogue.rs`: each entry point
//! is driven once on a fresh project and the steps of every epilogue run it caused
//! are read back. An entry point that settles and records by hand instead (as
//! Insert station did, running only the reconcile) shows up as a missing run, and
//! one that asks for the wrong steps shows up as a mismatch. Undo and redo are
//! inverses and must run none.
//!
//! All data is synthetic.

use super::command_epilogue::{EpilogueSteps, EPILOGUE_RUNS};
use super::command_import::VirtualShotMode;
use super::AppState;
use crate::core::{Command, CommandResult};
use crate::models::{
    ClosureStrategy, ImportPlacement, ImportSectionConfig, SectionId, ShotData, ShotId,
    ShotUpdates, StationRef,
};

fn shot(length: f64, azimuth: f64) -> ShotData {
    ShotData {
        length,
        azimuth_in: azimuth,
        azimuth_out: azimuth,
        ..Default::default()
    }
}

/// A project with one five-shot section; returns its id and shot ids.
fn fresh() -> (AppState, SectionId, Vec<ShotId>) {
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
        shots: (0..5).map(|i| shot(4.0, 30.0 * f64::from(i))).collect(),
    });
    assert!(created.success, "{:?}", created.error);
    let section_id = created.section_id.unwrap();
    let shots = state
        .get_project_state()
        .unwrap()
        .get_section(section_id)
        .unwrap()
        .shots
        .iter()
        .map(|s| s.id)
        .collect();
    let _ = take_runs();
    (state, section_id, shots)
}

fn take_runs() -> Vec<EpilogueSteps> {
    EPILOGUE_RUNS.with(|runs| std::mem::take(&mut *runs.borrow_mut()))
}

/// Drive one entry point and report what the seam saw.
fn check(name: &str, expected: EpilogueSteps, drive: impl FnOnce() -> Result<(), String>) -> bool {
    let _ = take_runs();
    let outcome = drive();
    let runs = take_runs();
    let ok = outcome.is_ok() && runs == vec![expected];
    println!(
        "{name}: {} - epilogue runs {runs:?}{}",
        if ok { "ok" } else { "MISSED" },
        match &outcome {
            Ok(()) => String::new(),
            Err(e) => format!(", entry point failed: {e}"),
        }
    );
    ok
}

fn ok(result: CommandResult) -> Result<(), String> {
    if result.success {
        Ok(())
    } else {
        Err(result.error.unwrap_or_default())
    }
}

#[test]
fn every_forward_entry_point_runs_the_shared_epilogue() {
    let _cfg = crate::test_helpers::isolated_config();
    let mut all = true;

    let (state, sid, shots) = fresh();
    all &= check("execute(UpdateShot)", EpilogueSteps::GEOMETRY, || {
        ok(state.execute(Command::UpdateShot {
            section_id: sid,
            shot_id: shots[1],
            updates: ShotUpdates {
                length: Some(6.0),
                ..ShotUpdates::default()
            },
        }))
    });
    all &= check("execute(DeleteShot)", EpilogueSteps::ALL, || {
        ok(state.execute(Command::DeleteShot {
            section_id: sid,
            shot_id: shots[4],
        }))
    });
    all &= check("execute(SetStationComment)", EpilogueSteps::NONE, || {
        ok(state.execute(Command::SetStationComment {
            station_ref: StationRef::new(sid, 0),
            comment: Some("Entrance".to_string()),
        }))
    });
    all &= check("execute(MoveComment)", EpilogueSteps::NONE, || {
        ok(state.execute(Command::MoveComment {
            source: crate::core::CommentHolder::Station {
                station_ref: StationRef::new(sid, 0),
            },
            target: crate::core::CommentHolder::Station {
                station_ref: StationRef::new(sid, 1),
            },
            swap: false,
        }))
    });
    all &= check("execute(Batch)", EpilogueSteps::ALL, || {
        ok(state.execute(Command::Batch {
            commands: vec![Command::UpdateShot {
                section_id: sid,
                shot_id: shots[2],
                updates: ShotUpdates {
                    length: Some(7.0),
                    ..ShotUpdates::default()
                },
            }],
        }))
    });
    all &= check("repair_open_project_integrity", EpilogueSteps::NONE, || {
        state.repair_open_project_integrity().map(|_| ())
    });
    all &= check("update_project_settings", EpilogueSteps::NONE, || {
        ok(state.update_project_settings(
            "CaveRenamed".to_string(),
            crate::config::ValidationConfig::default(),
            None,
        ))
    });
    all &= check("set_surface_elevation", EpilogueSteps::NONE, || {
        ok(state.set_surface_elevation(Some(12.5)))
    });
    all &= check("execute_split_shot_at_distance", EpilogueSteps::ALL, || {
        ok(state.execute_split_shot_at_distance(sid, shots[1], 2.0))
    });
    all &= check("execute_create_and_merge", EpilogueSteps::GEOMETRY, || {
        ok(state.execute_create_and_merge(
            Some("SectionB".to_string()),
            None,
            None,
            "#993366".to_string(),
            None,
            vec![shot(3.0, 90.0), shot(3.0, 100.0)],
            0,
            StationRef::new(sid, 2),
            ClosureStrategy::Batch,
        ))
    });
    all &= check("execute_import_sections", EpilogueSteps::GEOMETRY, || {
        ok(state.execute_import_sections(
            vec![ImportSectionConfig {
                reverse: false,
                section_index: 0,
                name: Some("SectionC".to_string()),
                surveyor: None,
                date: None,
                color: "#222222".to_string(),
                direction: None,
                quality: 1.0,
                shots: vec![shot(5.0, 200.0), shot(5.0, 210.0)],
                station_comments: Vec::new(),
                placement: ImportPlacement::Origin,
                azimuth_reference: None,
            }],
            Vec::new(),
            None,
            Vec::new(),
            Vec::new(),
            VirtualShotMode::Auto,
        ))
    });

    // Undo and redo are inverses: they RESTORE, so they run no forward epilogue.
    let _ = take_runs();
    assert!(state.undo().success && state.redo().success);
    let inverse_runs = take_runs();
    println!("undo + redo: epilogue runs {inverse_runs:?}");
    all &= inverse_runs.is_empty();

    // The delete/split family, each on a project of its own.
    let (state, sid, shots) = fresh();
    all &= check("execute_delete_shot_and_split", EpilogueSteps::ALL, || {
        ok(state.execute_delete_shot_and_split(sid, shots[2], "A".into(), "B".into()))
    });
    let (state, sid, shots) = fresh();
    all &= check(
        "execute_delete_shot_range_split",
        EpilogueSteps::ALL,
        || {
            ok(state.execute_delete_shot_range_split(
                sid,
                shots[1],
                shots[2],
                "A".into(),
                "B".into(),
            ))
        },
    );
    let (state, sid, shots) = fresh();
    all &= check(
        "execute_delete_shot_range_shift",
        EpilogueSteps::ALL,
        || ok(state.execute_delete_shot_range_shift(sid, shots[1], shots[2])),
    );
    let (state, _, _) = fresh();
    let single = state.execute(Command::CreateSection {
        name: Some("Single".to_string()),
        surveyor: None,
        date: None,
        color: "#445566".to_string(),
        direction: None,
        shots: vec![shot(2.0, 45.0)],
    });
    let single_id = single.section_id.unwrap();
    let single_shot = state
        .get_project_state()
        .unwrap()
        .get_section(single_id)
        .unwrap()
        .shots[0]
        .id;
    all &= check(
        "execute_delete_last_shot_and_section",
        EpilogueSteps::ALL,
        || ok(state.execute_delete_last_shot_and_section(single_id, single_shot)),
    );

    assert!(
        all,
        "a forward entry point settled or recorded its edit outside the shared epilogue"
    );
}
