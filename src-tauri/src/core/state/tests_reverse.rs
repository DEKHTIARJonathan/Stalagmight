//! `Command::ReverseSection` at the state layer (issue #24).
//!
//! The model-level transform is covered in `models::project::reverse`; these
//! tests pin the command's contract: geometry is invariant through the full
//! execute pipeline (including the reconcile epilogue), undo restores exactly,
//! frozen shots do not block it, and warnings are re-emitted.

use std::collections::HashMap;

use super::{AppState, VirtualShotMode};
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

/// `shot`, plus per-shot LRUD and pitch that are distinct from each other and
/// from every other shot's.
///
/// Every field here is one a reverse must either move, mirror or negate, and all
/// of them default to `None` - so a fixture built on `shot()` alone makes any
/// assertion about them vacuously true (that is exactly how the import path's
/// "left/right is never swapped" claim went unguarded). Neither LRUD nor pitch
/// feeds the coordinate walk (`horizontal_length` is derived from `length` and
/// the depth delta), so populating them cannot perturb the geometry assertions.
fn shot_with_lrud(azimuth: f64, length: f64, depth_in: f64, depth_out: f64, n: f64) -> ShotData {
    ShotData {
        left: Some(n),
        right: Some(n + 0.5),
        up: Some(n + 1.0),
        down: Some(n + 1.5),
        pitch_in: Some(n + 2.0),
        pitch_out: Some(-(n + 3.0)),
        ..shot(azimuth, length, depth_in, depth_out)
    }
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
            shot_with_lrud(0.0, 10.0, 0.0, 2.0, 1.0),
            shot_with_lrud(90.0, 5.0, 2.0, 2.0, 10.0),
            shot_with_lrud(210.0, 7.5, 2.0, 1.0, 20.0),
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
        // The fields `swap_left_right: true` and the pitch negation actually
        // touch - without these the test's "exactly" only covered id/uuid/
        // azimuth/depth.
        assert_eq!(a.up, b.up);
        assert_eq!(a.down, b.down);
        assert_eq!(a.pitch_in, b.pitch_in);
        assert_eq!(a.pitch_out, b.pitch_out);
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
        // `swap_left_right: true` twice must land back on the recorded values,
        // and the pitch double-negation must cancel.
        assert_eq!(a.left, b.left);
        assert_eq!(a.right, b.right);
        assert_eq!(a.pitch_in, b.pitch_in);
        assert_eq!(a.pitch_out, b.pitch_out);
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
/// wizard's placement indices address the final order. `station_comments`
/// indices are given in the FILE's order and mirrored backend-side.
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
                shot_with_lrud(0.0, 10.0, 0.0, 2.0, 1.0),
                shot_with_lrud(90.0, 5.0, 2.0, 2.0, 10.0),
                shot_with_lrud(210.0, 7.5, 2.0, 1.0, 20.0),
            ],
            placement: ImportPlacement::Origin,
            // Station 0 of the FILE - the backend mirrors it to station 3.
            station_comments: vec![(0, "file station 0".to_string())],
            reverse: true,
        }],
        Vec::new(),
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
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
    // The file's last shot (left 20.0) is now first, and its LRUD travelled with
    // it UNSWAPPED. Asserting the values rather than `is_none()`: with a fixture
    // that leaves LRUD at its `None` default this assertion holds no matter what
    // the import does, and flipping `reverse_shots(.., false)` to `true` failed
    // no test at all.
    assert_eq!(section.shots[0].left, Some(20.0));
    assert_eq!(section.shots[0].right, Some(20.5));
    assert_eq!(section.shots[2].left, Some(1.0));
    assert_eq!(section.shots[2].right, Some(1.5));

    // The comment was given against the file's station 0, so it must land on the
    // physical station that is now numbered 3.
    assert_eq!(project.station_comments.len(), 1);
    let (key, text) = project.station_comments.iter().next().unwrap();
    assert_eq!(text, "file station 0");
    assert_eq!(
        project.resolve_key(key),
        Some(StationRef::new(section.id, 3))
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
            VirtualShotMode::Auto,
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

/// Reversing a multi-selection goes through a batch so it is one user action:
/// every section or none, and a single Undo to get back.
#[test]
fn batched_multi_section_reverse_is_atomic_and_undoes_in_one_step() {
    let (state, first_id) = state_with_section();
    let second = state.execute(Command::CreateSection {
        name: Some("Side passage".to_string()),
        surveyor: None,
        date: None,
        color: "#ff6b6b".to_string(),
        direction: None,
        shots: vec![shot(45.0, 8.0, 0.0, 1.0), shot(315.0, 6.0, 1.0, 3.0)],
    });
    let second_id = second.section_id.unwrap();

    let before = abs_coord_map(&state.get_project_state().unwrap());
    let first_lengths = |project: &Project| {
        project
            .sections
            .iter()
            .find(|s| s.id == first_id)
            .map(|s| s.shots.iter().map(|shot| shot.length).collect::<Vec<_>>())
            .unwrap()
    };
    let lengths_before = first_lengths(&state.get_project_state().unwrap());

    // A batch whose LAST command names a section that does not exist: the two
    // good reverses must not survive it.
    let failed = state.execute(Command::Batch {
        commands: vec![
            Command::ReverseSection {
                section_id: first_id,
                swap_left_right: false,
            },
            Command::ReverseSection {
                section_id: second_id,
                swap_left_right: false,
            },
            Command::ReverseSection {
                section_id: 9999,
                swap_left_right: false,
            },
        ],
    });
    assert!(!failed.success, "batch with a missing section should fail");
    assert_eq!(
        first_lengths(&state.get_project_state().unwrap()),
        lengths_before,
        "a failed batch left a section reversed"
    );

    // The all-good batch applies to both sections and costs exactly one undo.
    let ok = state.execute(Command::Batch {
        commands: vec![
            Command::ReverseSection {
                section_id: first_id,
                swap_left_right: false,
            },
            Command::ReverseSection {
                section_id: second_id,
                swap_left_right: false,
            },
        ],
    });
    assert!(ok.success, "batch failed: {:?}", ok.error);

    let reversed = state.get_project_state().unwrap();
    let mut expected = lengths_before.clone();
    expected.reverse();
    assert_eq!(first_lengths(&reversed), expected);

    assert!(state.undo().success);
    let restored = state.get_project_state().unwrap();
    assert_eq!(
        first_lengths(&restored),
        lengths_before,
        "one undo should restore both sections"
    );
    let restored_coords = abs_coord_map(&restored);
    assert_eq!(restored_coords.len(), before.len());
    for (station_ref, coords) in &before {
        assert_coords_close(*coords, *restored_coords.get(station_ref).unwrap());
    }
}

/// A shot-less section (GPX imports one per waypoint) reverses to itself, so
/// `generate_undo_data` has nothing to capture - but the command still SUCCEEDS.
/// Pushing that `UndoData::None` entry wedges the whole stack: `undo()` pops it,
/// maps `None` to a failure, and its epilogue pushes it straight back, so every
/// older entry underneath is unreachable forever (and the stack is persisted, so
/// it survives close/reopen). The entry must simply not be pushed.
#[test]
fn reversing_a_shotless_section_leaves_the_undo_stack_usable() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Waypoints".to_string(),
        location: None,
    });

    // An ordinary, undoable edit first - this is what must stay reachable.
    let created = state.execute(Command::CreateSection {
        name: Some("Real line".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        shots: vec![shot(0.0, 10.0, 0.0, 2.0)],
    });
    assert!(created.success);

    // Then a waypoint-style section with no shots, and a reverse of it.
    let empty = state.execute(Command::CreateSection {
        name: Some("Waypoint".to_string()),
        surveyor: None,
        date: None,
        color: "#ff6b6b".to_string(),
        direction: None,
        shots: Vec::new(),
    });
    let empty_id = empty.section_id.unwrap();
    let reversed = state.execute(Command::ReverseSection {
        section_id: empty_id,
        swap_left_right: false,
    });
    assert!(reversed.success, "reverse failed: {:?}", reversed.error);

    // The next undo must do real work, not pop-and-repush the no-op forever.
    let first = state.undo();
    assert!(
        first.success,
        "undo blocked by an unundoable entry: {:?}",
        first.error
    );
    // ... and the section creations underneath it are still reachable.
    assert!(state.undo().success);
    let project = state.get_project_state().unwrap();
    assert!(
        project.sections.is_empty(),
        "older history was left unreachable: {:?}",
        project.sections.iter().map(|s| s.id).collect::<Vec<_>>()
    );
}

/// The mirror is `shot_count - station_index`, so an index past the last station
/// has no mirror at all. `saturating_sub` would silently park such a comment on
/// station 0 - a station it was never about - where the un-reversed import just
/// fails `key_for_ref` and drops it.
#[test]
fn import_reverse_drops_an_out_of_range_station_comment() {
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
            shots: vec![shot(0.0, 10.0, 0.0, 2.0), shot(90.0, 5.0, 2.0, 2.0)],
            placement: ImportPlacement::Origin,
            // Two shots means stations 0..2; station 7 does not exist.
            station_comments: vec![(7, "nowhere".to_string()), (1, "the bend".to_string())],
            reverse: true,
        }],
        Vec::new(),
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
    );
    assert!(result.success, "import failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    let section = project.sections.first().unwrap();
    assert_eq!(
        project.station_comments.len(),
        1,
        "the out-of-range comment must be dropped, not relocated: {:?}",
        project.station_comments.values().collect::<Vec<_>>()
    );
    let (key, text) = project.station_comments.iter().next().unwrap();
    assert_eq!(text, "the bend");
    assert_eq!(
        project.resolve_key(key),
        Some(StationRef::new(section.id, 1)),
        "the in-range comment must still mirror to station 1"
    );
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

/// A resolved-warning row with a NULL `shot_uuid` is keyed by `(section_id, shot_id)`,
/// and the reverse deliberately keeps shot IDs attached to POSITIONS - so after it that
/// key names a DIFFERENT physical shot. The save-time carry-over then upgrades the row
/// through `live_by_id.get(&(section_id, shot_id))` and pins it, by UUID, to the mirrored
/// shot - permanently suppressing an unrelated shot's warning.
///
/// Not a legacy-only shape: `commands::validation` deliberately stores `None` whenever the
/// shot's UUID is not yet on disk, which includes any shot created in the current session.
#[test]
fn reverse_keeps_a_position_keyed_ignore_on_its_own_shot() {
    let temp = tempfile::TempDir::new().unwrap();
    let (state, section_id) = state_with_section();
    assert!(
        state
            .execute(Command::SaveProject {
                path: Some(temp.path().join("cave.stalx")),
                is_autosave: false,
            })
            .success
    );

    // Shot ids and UUIDs as they stand before the reverse.
    let (ids, uuids): (Vec<u32>, Vec<String>) = {
        let guard = state.project.lock().unwrap();
        let section = guard.as_ref().unwrap().get_section(section_id).unwrap();
        (
            section.shots.iter().map(|s| s.id).collect(),
            section
                .shots
                .iter()
                .map(|s| s.uuid.clone().unwrap())
                .collect(),
        )
    };
    assert!(ids.len() >= 3);

    // A position-keyed ignore on the FIRST shot.
    state
        .save_resolved_warning(&crate::persistence::ResolvedWarning {
            section_id,
            shot_id: ids[0],
            warning_code: "TEST_IGNORE".to_string(),
            resolved_at: chrono::Utc::now(),
            resolved_comment: None,
            shot_uuid: None,
        })
        .unwrap();

    assert!(
        state
            .execute(Command::ReverseSection {
                section_id,
                swap_left_right: false,
            })
            .success
    );
    // The save is where the row's position key would be re-read as an identity.
    assert!(
        state
            .execute(Command::SaveProject {
                path: None,
                is_autosave: false,
            })
            .success
    );

    let rows = state.load_resolved_warnings().unwrap();
    assert_eq!(rows.len(), 1, "the ignore must survive the reverse");
    assert_eq!(
        rows[0].shot_uuid.as_deref(),
        Some(uuids[0].as_str()),
        "the ignore must stay on the shot it was taken on, not migrate to the \
         shot the reverse moved onto that position (which is {:?})",
        uuids.last()
    );
}

/// `Project`'s `Serialize` includes `collab`, so a snapshot-pair undo reinstates the
/// EXPORT PROVENANCE from before the command - and undo does not un-write the sibling
/// `.tml`. The reverse makes the damage concrete:
///
/// ```text
///   reverse (baseline cleared) -> save (re-exports the .tml, seeds baseline B')
///                              -> undo (resurrects baseline B and sha S)
/// ```
///
/// `compute_collab` then sees a sibling whose sha no longer matches the resurrected S and
/// reports it as collaborator-changed, after which `apply_changeset` writes every matched
/// edit at baseline B's PRE-reverse `shot_index` - scrambling the section.
#[test]
fn undoing_a_reverse_does_not_resurrect_the_pre_reverse_collab_provenance() {
    let temp = tempfile::TempDir::new().unwrap();
    let state = AppState::new().unwrap();

    let mut project = Project::new("Collab".to_string(), None);
    let section_id = project
        .add_section(crate::models::SectionData {
            name: Some("Main".to_string()),
            shots: vec![
                shot(0.0, 10.0, 0.0, 1.0),
                shot(90.0, 5.0, 1.0, 2.0),
                shot(200.0, 7.0, 2.0, 3.0),
            ],
            ..Default::default()
        })
        .id;
    project.collab = Some(crate::models::CollabState::new("collab.tml".to_string()));
    state.set_project_for_tests(project);

    let collab_now = || {
        let guard = state.project.lock().unwrap();
        guard.as_ref().unwrap().collab.clone().unwrap()
    };

    assert!(
        state
            .execute(Command::SaveProject {
                path: Some(temp.path().join("collab.stalx")),
                is_autosave: false,
            })
            .success
    );
    let before = collab_now();
    assert_eq!(
        before.shot_baseline.len(),
        3,
        "first export seeds a baseline"
    );
    let sha_before = before.last_export_tml_sha256.unwrap();

    assert!(
        state
            .execute(Command::ReverseSection {
                section_id,
                swap_left_right: false,
            })
            .success
    );
    assert!(
        state
            .execute(Command::SaveProject {
                path: None,
                is_autosave: false,
            })
            .success
    );
    let after = collab_now();
    let sha_after = after.last_export_tml_sha256.clone().unwrap();
    assert_ne!(
        sha_before, sha_after,
        "the reverse changed the exported .tml"
    );
    assert_eq!(
        after.shot_baseline.len(),
        3,
        "the save re-seeded the baseline"
    );

    let undone = state.undo();
    assert!(undone.success, "{:?}", undone.error);
    let collab = collab_now();
    assert_eq!(
        collab.last_export_tml_sha256.as_deref(),
        Some(sha_after.as_str()),
        "the .tml on disk is still the post-reverse export, so its sha must not rewind - \
         otherwise every later open reports a phantom collaborator edit"
    );
    assert!(
        collab.shot_baseline.is_empty(),
        "a baseline whose shot_index values name the other layout must be dropped, not \
         restored: reconcile applies edits positionally"
    );
}

/// The renumbering signal has to survive the shapes a reverse actually arrives in:
/// batched (reversing a multi-selection is one atomic user action) and replayed through
/// undo/redo, where the snapshot restore leaves NOTHING in the geometry to diff - every
/// station keeps its world position either way.
#[test]
fn reverse_reports_every_renumbered_section_through_batch_undo_and_redo() {
    let (state, first) = state_with_section();
    let second = state
        .execute(Command::CreateSection {
            name: Some("Side".to_string()),
            surveyor: None,
            date: None,
            color: "#ff6b6b".to_string(),
            direction: None,
            shots: vec![shot(45.0, 8.0, 0.0, 1.0), shot(135.0, 4.0, 1.0, 1.0)],
        })
        .section_id
        .unwrap();

    let batch = state.execute(Command::Batch {
        commands: vec![
            Command::ReverseSection {
                section_id: first,
                swap_left_right: false,
            },
            Command::ReverseSection {
                section_id: second,
                swap_left_right: false,
            },
        ],
    });
    assert!(batch.success, "{:?}", batch.error);
    assert_eq!(batch.reversed_section_ids, Some(vec![first, second]));

    let undone = state.undo();
    assert!(undone.success, "{:?}", undone.error);
    assert_eq!(
        undone.reversed_section_ids,
        Some(vec![first, second]),
        "undoing a reverse re-reverses the numbering, so it reports the same sections"
    );

    let redone = state.redo();
    assert!(redone.success, "{:?}", redone.error);
    assert_eq!(redone.reversed_section_ids, Some(vec![first, second]));

    // A command that renumbers nothing must leave the field off the wire entirely.
    let moved = state.execute(Command::MoveSection {
        section_id: first,
        offset: Coordinates::new(1.0, 2.0, 0.0),
    });
    assert!(moved.success, "{:?}", moved.error);
    assert!(moved.reversed_section_ids.is_none());
}
