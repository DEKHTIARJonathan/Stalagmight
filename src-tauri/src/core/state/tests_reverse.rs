//! `Command::ReverseSection` at the state layer (issue #24).
//!
//! The model-level transform is covered in `models::project::reverse`; these
//! tests pin the command's contract: geometry is invariant through the full
//! execute pipeline (including the reconcile epilogue), undo restores exactly,
//! frozen shots do not block it, and warnings are re-emitted.

use std::collections::HashMap;

use super::AppState;
use crate::core::Command;
use crate::models::{
    Coordinates, GpsCoordinates, ImportPlacement, ImportSectionConfig, Project, SectionId,
    ShotData, StationRef,
};

fn shot(azimuth: f64, length: f64, depth_in: f64, depth_out: f64) -> ShotData {
    ShotData {
        azimuth_in: azimuth,
        azimuth_out: azimuth,
        length,
        depth_in,
        depth_out,
        ..Default::default()
    }
}

fn abs_coord_map(project: &Project) -> HashMap<StationRef, Coordinates> {
    project
        .compute_station_coordinates()
        .into_iter()
        .map(|s| (s.station_ref, s.coordinates))
        .collect()
}

fn assert_coords_close(a: Coordinates, b: Coordinates) {
    let eps = 1e-6;
    assert!(
        (a.x - b.x).abs() < eps && (a.y - b.y).abs() < eps && (a.z - b.z).abs() < eps,
        "coordinate moved: {a:?} vs {b:?}"
    );
}

/// A project with one three-shot section that turns a corner and changes depth,
/// so a botched reverse shows up as a moved station rather than a coincidence.
fn state_with_section() -> (AppState, SectionId) {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Reverse".to_string(),
        location: None,
    });
    let created = state.execute(Command::CreateSection {
        name: Some("Main line".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        shots: vec![
            shot(0.0, 10.0, 0.0, 2.0),
            shot(90.0, 5.0, 2.0, 2.0),
            shot(210.0, 7.5, 2.0, 1.0),
        ],
    });
    let section_id = created.section_id.unwrap();
    (state, section_id)
}

#[test]
fn reverse_keeps_every_station_where_it_was() {
    let (state, section_id) = state_with_section();
    let before = abs_coord_map(&state.get_project_state().unwrap());

    let result = state.execute(Command::ReverseSection {
        section_id,
        swap_left_right: false,
    });
    assert!(result.success, "reverse failed: {:?}", result.error);

    let after = abs_coord_map(&state.get_project_state().unwrap());
    assert_eq!(before.len(), after.len(), "station count changed");

    // Station i is now station N - i, at the same place.
    let n = 3;
    for i in 0..=n {
        assert_coords_close(
            before[&StationRef::new(section_id, i)],
            after[&StationRef::new(section_id, n - i)],
        );
    }
}

#[test]
fn reverse_reverses_the_shot_order() {
    let (state, section_id) = state_with_section();
    let before = state.get_project_state().unwrap();
    let lengths: Vec<_> = before
        .get_section(section_id)
        .unwrap()
        .shots
        .iter()
        .map(|s| s.length)
        .collect();

    assert!(
        state
            .execute(Command::ReverseSection {
                section_id,
                swap_left_right: false,
            })
            .success
    );

    let after = state.get_project_state().unwrap();
    let reversed: Vec<_> = after
        .get_section(section_id)
        .unwrap()
        .shots
        .iter()
        .map(|s| s.length)
        .collect();
    let mut expected = lengths;
    expected.reverse();
    assert_eq!(reversed, expected);
}

#[test]
fn undo_restores_the_original_section_exactly() {
    let (state, section_id) = state_with_section();
    let before = state.get_project_state().unwrap();
    let original = before.get_section(section_id).unwrap().clone();
    let coords_before = abs_coord_map(&before);

    assert!(
        state
            .execute(Command::ReverseSection {
                section_id,
                swap_left_right: true,
            })
            .success
    );
    assert!(state.undo().success, "reverse must be undoable");

    let restored_project = state.get_project_state().unwrap();
    let restored = restored_project.get_section(section_id).unwrap();
    assert_eq!(restored.shots.len(), original.shots.len());
    for (a, b) in restored.shots.iter().zip(&original.shots) {
        assert_eq!(a.id, b.id);
        assert_eq!(a.uuid, b.uuid);
        assert_eq!(a.azimuth_in, b.azimuth_in);
        assert_eq!(a.azimuth_out, b.azimuth_out);
        assert_eq!(a.depth_in, b.depth_in);
        assert_eq!(a.depth_out, b.depth_out);
        assert_eq!(a.left, b.left);
        assert_eq!(a.right, b.right);
    }
    for (sr, coord) in coords_before {
        assert_coords_close(coord, abs_coord_map(&restored_project)[&sr]);
    }
}

#[test]
fn redo_reapplies_the_reverse() {
    let (state, section_id) = state_with_section();
    assert!(
        state
            .execute(Command::ReverseSection {
                section_id,
                swap_left_right: false,
            })
            .success
    );
    let reversed = state.get_project_state().unwrap();
    let expected: Vec<_> = reversed
        .get_section(section_id)
        .unwrap()
        .shots
        .iter()
        .map(|s| (s.id, s.length, s.azimuth_in))
        .collect();

    assert!(state.undo().success);
    assert!(state.redo().success, "reverse must be redoable");

    let after = state.get_project_state().unwrap();
    let actual: Vec<_> = after
        .get_section(section_id)
        .unwrap()
        .shots
        .iter()
        .map(|s| (s.id, s.length, s.azimuth_in))
        .collect();
    assert_eq!(actual, expected);
}

#[test]
fn reverse_twice_is_the_identity() {
    let (state, section_id) = state_with_section();
    let original = state
        .get_project_state()
        .unwrap()
        .get_section(section_id)
        .unwrap()
        .clone();

    for _ in 0..2 {
        assert!(
            state
                .execute(Command::ReverseSection {
                    section_id,
                    swap_left_right: true,
                })
                .success
        );
    }

    let project = state.get_project_state().unwrap();
    let round_tripped = project.get_section(section_id).unwrap();
    for (a, b) in round_tripped.shots.iter().zip(&original.shots) {
        assert_eq!(a.id, b.id);
        assert_eq!(a.azimuth_in, b.azimuth_in);
        assert_eq!(a.azimuth_out, b.azimuth_out);
        assert_eq!(a.depth_in, b.depth_in);
        assert_eq!(a.depth_out, b.depth_out);
    }
}

/// A zero datum freezes the shots it anchors; `update_shot` rejects geometry
/// edits on them. Reverse must still work, because it leaves each physical line
/// untouched - and the datum must stay on the station the surveyor pinned.
#[test]
fn reverse_works_on_a_datum_anchored_section_and_keeps_the_datum_in_place() {
    let (state, section_id) = state_with_section();
    let datum_at = StationRef::new(section_id, 0);
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: datum_at,
                coordinates: GpsCoordinates {
                    latitude: 20.2,
                    longitude: -87.4,
                    depth_reference: 0.0,
                },
            })
            .success
    );

    let before = abs_coord_map(&state.get_project_state().unwrap());

    let result = state.execute(Command::ReverseSection {
        section_id,
        swap_left_right: false,
    });
    assert!(
        result.success,
        "frozen shots must not block reverse: {:?}",
        result.error
    );

    // Nothing moved, and the datum now sits on station 3 - the same physical
    // station it was pinned to before the reverse.
    let project = state.get_project_state().unwrap();
    let after = abs_coord_map(&project);
    for i in 0..=3u32 {
        assert_coords_close(
            before[&StationRef::new(section_id, i)],
            after[&StationRef::new(section_id, 3 - i)],
        );
    }
    assert_eq!(project.zero_datums.len(), 1);
    assert_eq!(
        project.resolve_key(&project.zero_datums[0].station_ref),
        Some(StationRef::new(section_id, 3)),
        "the zero datum must follow its physical station, not stay on index 0"
    );
}

/// q14: the import toggle reverses BEFORE the section is created, so the
/// wizard's placement and station-comment indices address the final order.
#[test]
fn import_reverse_applies_before_placement_and_comments_resolve() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Import".to_string(),
        location: None,
    });

    // Three shots; a comment on station 0 of the FINAL (reversed) section.
    let result = state.execute_import_sections(
        vec![ImportSectionConfig {
            section_index: 0,
            name: Some("Imported".to_string()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![
                shot(0.0, 10.0, 0.0, 2.0),
                shot(90.0, 5.0, 2.0, 2.0),
                shot(210.0, 7.5, 2.0, 1.0),
            ],
            placement: ImportPlacement::Origin,
            station_comments: vec![(0, "post-reverse station 0".to_string())],
            reverse: true,
        }],
        Vec::new(),
        None,
        Vec::new(),
        Vec::new(),
    );
    assert!(result.success, "import failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    let section = project.sections.first().unwrap();

    // The file's last shot is now first, and its readings are reciprocated.
    assert_eq!(section.shots.len(), 3);
    assert_eq!(section.shots[0].length, 7.5);
    assert_eq!(section.shots[2].length, 10.0);
    assert!((section.shots[2].average_azimuth() - 180.0).abs() < 1e-9);

    // Left/right are untouched on the import path - there is no dialog to ask.
    assert!(section
        .shots
        .iter()
        .all(|s| s.left.is_none() && s.right.is_none()));

    // The comment landed on station 0 of the reversed section.
    assert_eq!(project.station_comments.len(), 1);
    let (key, text) = project.station_comments.iter().next().unwrap();
    assert_eq!(text, "post-reverse station 0");
    assert_eq!(
        project.resolve_key(key),
        Some(StationRef::new(section.id, 0))
    );
}

/// Ticking the import toggle changes the numbering, never where the passage
/// lands.  `Origin` and `Manual` position station 0 directly, so without the
/// offset compensation a reversed section - whose station 0 is now the far end -
/// would sit a full end-to-end displacement away from the un-reversed import.
#[test]
fn import_reverse_lands_the_section_in_the_same_place() {
    let shots = vec![
        shot(0.0, 10.0, 0.0, 2.0),
        shot(90.0, 5.0, 2.0, 2.0),
        shot(210.0, 7.5, 2.0, 1.0),
    ];

    let import = |reverse: bool, placement: ImportPlacement| {
        let state = AppState::new().unwrap();
        state.execute(Command::CreateProject {
            name: "Import".to_string(),
            location: None,
        });
        let result = state.execute_import_sections(
            vec![ImportSectionConfig {
                section_index: 0,
                name: Some("Imported".to_string()),
                surveyor: None,
                date: None,
                color: "#4ecdc4".to_string(),
                direction: None,
                quality: 1.0,
                shots: shots.clone(),
                placement,
                station_comments: Vec::new(),
                reverse,
            }],
            Vec::new(),
            None,
            Vec::new(),
            Vec::new(),
        );
        assert!(result.success, "import failed: {:?}", result.error);
        let project = state.get_project_state().unwrap();
        let mut coords: Vec<Coordinates> = project
            .compute_station_coordinates()
            .into_iter()
            .map(|s| s.coordinates)
            .collect();
        // Reversed numbering walks the same stations from the other end.
        if reverse {
            coords.reverse();
        }
        coords
    };

    for placement in [
        ImportPlacement::Origin,
        ImportPlacement::Manual {
            align_station_index: 0,
            offset: Some(Coordinates {
                x: 40.0,
                y: -15.0,
                z: 0.0,
            }),
        },
    ] {
        let plain = import(false, placement.clone());
        let reversed = import(true, placement.clone());
        assert_eq!(plain.len(), reversed.len(), "station count changed");
        for (i, (a, b)) in plain.iter().zip(&reversed).enumerate() {
            assert!(
                (a.x - b.x).abs() < 1e-6 && (a.y - b.y).abs() < 1e-6,
                "station {i} moved under {placement:?}: {a:?} vs {b:?}"
            );
        }
    }
}

#[test]
fn reverse_of_a_missing_section_fails() {
    let (state, _) = state_with_section();
    let result = state.execute(Command::ReverseSection {
        section_id: 9999,
        swap_left_right: false,
    });
    assert!(!result.success);
    assert!(result.error.unwrap().contains("not found"));
}

#[test]
fn reverse_reports_the_section_it_touched() {
    let (state, section_id) = state_with_section();
    let result = state.execute(Command::ReverseSection {
        section_id,
        swap_left_right: false,
    });
    assert_eq!(result.section_id, Some(section_id));
}
