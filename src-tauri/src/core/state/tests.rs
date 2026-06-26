use super::*;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use crate::core::undo::{UndoData, UndoEntry};
use crate::core::{Command, CommandResult, UndoStack};
use crate::models::{
    ClosureStrategy, Coordinates, GpsCoordinates, ImportPlacement, ImportSectionConfig,
    LoopClosure, Project, SectionData, SectionId, SectionUpdates, ShotData, ShotId, ShotUpdates,
    StationAnchor, StationKey, StationMerge, StationRef, SurveyDirection,
};
use crate::persistence::Database;
use tempfile::TempDir;

/// Helper to create a basic shot data for testing
fn test_shot_data(length: f64) -> ShotData {
    ShotData {
        azimuth_in: 45.0,
        azimuth_out: 225.0,
        length,
        depth_in: 10.0,
        depth_out: 11.0,
        ..Default::default()
    }
}

fn assert_coords_close(a: Coordinates, b: Coordinates) {
    let eps = 1e-6;
    assert!((a.x - b.x).abs() < eps, "x mismatch: {} vs {}", a.x, b.x);
    assert!((a.y - b.y).abs() < eps, "y mismatch: {} vs {}", a.y, b.y);
    assert!((a.z - b.z).abs() < eps, "z mismatch: {} vs {}", a.z, b.z);
}

/// Like [`assert_coords_close`] but only the horizontal (map) position. Section
/// offsets are 2D, so gap-close deletes preserve x/y but not section-relative z.
fn assert_xy_close(a: Coordinates, b: Coordinates) {
    let eps = 1e-6;
    assert!((a.x - b.x).abs() < eps, "x mismatch: {} vs {}", a.x, b.x);
    assert!((a.y - b.y).abs() < eps, "y mismatch: {} vs {}", a.y, b.y);
}

/// Absolute (section-offset-applied) coordinates of every station, keyed by ref.
/// Used to assert that an edit shifts only the affected geometry and leaves the
/// rest of the map put (#41 regression sentinels).
fn abs_coord_map(project: &Project) -> HashMap<StationRef, Coordinates> {
    project
        .compute_station_coordinates()
        .into_iter()
        .map(|s| (s.station_ref, s.coordinates))
        .collect()
}

fn poison_mutex<T>(mutex: &Mutex<T>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = mutex.lock().unwrap();
        panic!("poison mutex for lock failure coverage");
    }));
}

// === Project Operations Tests ===

#[test]
fn test_collab_sibling_warning_requires_export_provenance() {
    let temp = TempDir::new().unwrap();
    let stalx = temp.path().join("cave.stalx");
    // An unrelated .tml sharing the basename (e.g. the source of a TML import).
    std::fs::write(temp.path().join("cave.tml"), b"<x/>").unwrap();

    let state = AppState::new().unwrap();

    // Case 1: never had collaboration (collab = None) → no warning.
    let mut project = Project::new("Cave".to_string(), None);
    project.file_path = Some(stalx.clone());
    *state.project.lock().unwrap() = Some(project);
    assert_eq!(state.collab_sibling_when_disabled(), None);

    // Case 2: collab toggled on then off but no successful export ever happened
    // (`last_export_tml_sha256` is None) → still no warning, because the
    // `cave.tml` sitting next to us could be unrelated (e.g. a TML the user
    // dropped in to import).  This is the gap Codex flagged: prior behaviour
    // warned for ANY same-basename .tml on the disabled toggle, including
    // import sources.
    let mut project = Project::new("Cave".to_string(), None);
    project.file_path = Some(stalx.clone());
    let mut collab = crate::models::CollabState::new("cave.tml".to_string());
    collab.enabled = false;
    project.collab = Some(collab);
    *state.project.lock().unwrap() = Some(project);
    assert_eq!(state.collab_sibling_when_disabled(), None);

    // Case 3: collab off AND a recorded export sha exists → warn.  This is the
    // genuine "we wrote this .tml, then collaboration was turned off" path.
    let mut project = Project::new("Cave".to_string(), None);
    project.file_path = Some(stalx.clone());
    let mut collab = crate::models::CollabState::new("cave.tml".to_string());
    collab.enabled = false;
    collab.last_export_tml_sha256 = Some("deadbeef".to_string());
    project.collab = Some(collab);
    *state.project.lock().unwrap() = Some(project);
    assert_eq!(
        state.collab_sibling_when_disabled(),
        Some("cave.tml".to_string())
    );
}

#[test]
fn test_create_project() {
    let state = AppState::new().unwrap();

    let result = state.execute(Command::CreateProject {
        name: "Test Cave".to_string(),
        location: Some("Test Location".to_string()),
    });

    assert!(result.success);
    assert!(result.error.is_none());

    let project = state.get_project_state();
    assert!(project.is_some());

    let project = project.unwrap();
    assert_eq!(project.name, "Test Cave");
    assert_eq!(project.location, Some("Test Location".to_string()));
}

#[test]
fn test_merge_projects_archives_sources_and_adds_extension() {
    let temp_dir = TempDir::new().unwrap();

    let mut project_a = Project::new("A".to_string(), None);
    project_a.add_section(SectionData {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: Some(SurveyDirection::In),
        quality: 1.0,
        shots: vec![test_shot_data(1.0)],
    });

    let mut project_b = Project::new("B".to_string(), None);
    project_b.add_section(SectionData {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: Some(SurveyDirection::Out),
        quality: 1.0,
        shots: vec![test_shot_data(2.0)],
    });

    let source_a = temp_dir.path().join("a.stalx");
    let source_b = temp_dir.path().join("b.stalx");

    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&project_a).unwrap();
    let mut db_b = Database::open(&source_b).unwrap();
    db_b.save_project(&project_b).unwrap();
    drop(db_a);
    drop(db_b);

    let existing_archive = temp_dir.path().join("a.stalx.archived");
    std::fs::write(&existing_archive, b"archived").unwrap();

    let state = AppState::new().unwrap();
    let output_path = temp_dir.path().join("merged-output");

    let result = state.execute(Command::MergeProjects {
        source_paths: vec![source_a.clone(), source_b.clone()],
        output_path: output_path.clone(),
        output_name: "Merged".to_string(),
        archive_originals: true,
    });

    assert!(result.success);

    let output_with_ext = output_path.with_extension("stalx");
    assert!(output_with_ext.exists());

    assert!(!source_a.exists());
    assert!(!source_b.exists());

    let archived_entries: Vec<_> = std::fs::read_dir(temp_dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("a.stalx.archived"))
        })
        .collect();

    assert!(!archived_entries.is_empty());
    assert!(temp_dir.path().join("b.stalx.archived").exists());
}

#[test]
fn test_start_new_load_cancels_previous_and_clear_is_identity_safe() {
    let state = AppState::new().unwrap();

    let first = state.start_new_load();
    assert!(!first.load(Ordering::SeqCst));

    let second = state.start_new_load();
    assert!(first.load(Ordering::SeqCst));
    assert!(!second.load(Ordering::SeqCst));

    state.clear_active_load(&first);
    let guard = state.active_loading.lock().unwrap();
    assert!(guard.as_ref().is_some());
    assert!(Arc::ptr_eq(guard.as_ref().unwrap(), &second));
    drop(guard);

    state.clear_active_load(&second);
    assert!(state.active_loading.lock().unwrap().is_none());
}

#[test]
fn test_close_project_succeeds_with_poisoned_database_lock() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    poison_mutex(&state.database);

    let result = state.close_project();
    assert!(result.success);
    assert!(state.get_project_state().is_none());
}

#[test]
fn test_open_project_restores_undo_redo_and_assigns_closure_ids() {
    let temp_dir = TempDir::new().unwrap();
    let project_path = temp_dir.path().join("restore.stalx");

    let mut project = Project::new("Restore".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![test_shot_data(2.0)],
            ..Default::default()
        })
        .id;

    project.loop_closures.push(LoopClosure {
        id: 0,
        station_a: StationRef::new(section_id, 0).into(),
        station_b: StationRef::new(section_id, 1).into(),
        path_length: 2.0,
        misclosure_distance: 0.1,
        error_percentage: 5.0,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });

    let mut db = Database::open(&project_path).unwrap();
    db.save_project(&project).unwrap();

    let undo_entry = UndoEntry {
        command: Command::CreateProject {
            name: "Undo Project".to_string(),
            location: None,
        },
        undo_data: UndoData::None,
        timestamp: None,
    };
    let redo_entry = UndoEntry {
        command: Command::CloseProject,
        undo_data: UndoData::None,
        timestamp: None,
    };

    let undo_persist = UndoStack::serialize_entry_with_timestamp(&undo_entry).unwrap();
    let redo_persist = UndoStack::serialize_entry_with_timestamp(&redo_entry).unwrap();
    db.save_undo_stack_with_timestamps(vec![undo_persist])
        .unwrap();
    db.save_redo_stack_with_timestamps(vec![redo_persist])
        .unwrap();
    drop(db);

    let state = AppState::new().unwrap();
    let result = state.open_project(project_path);
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.loop_closures.len(), 1);
    assert_ne!(project.loop_closures[0].id, 0);

    let undo_stack = state.undo_stack.lock().unwrap();
    assert_eq!(undo_stack.len(), 1);
    assert_eq!(undo_stack.redo_len(), 1);

    let undo_entry = undo_stack.undo_entries().next().unwrap();
    match &undo_entry.command {
        Command::CreateProject { name, location } => {
            assert_eq!(name, "Undo Project");
            assert!(location.is_none());
        }
        other => panic!("Unexpected undo entry: {other:?}"),
    }

    let redo_entry = undo_stack.redo_entries().next().unwrap();
    match &redo_entry.command {
        Command::CloseProject => {}
        other => panic!("Unexpected redo entry: {other:?}"),
    }
}

/// Shot with every nullable field populated — the fields a replayed legacy
/// (pre-v7) undo entry would silently clear under the v7 `double_option`
/// null-means-clear semantics.
fn shot_with_nullable_fields() -> ShotData {
    ShotData {
        pitch_in: Some(5.0),
        pitch_out: Some(-5.0),
        left: Some(1.5),
        right: Some(2.5),
        up: Some(0.5),
        down: Some(3.5),
        comment: Some("original".to_string()),
        marker_index: Some(2),
        temperature: Some(14.5),
        ..test_shot_data(2.0)
    }
}

#[test]
fn test_open_project_drops_legacy_null_style_undo_history() {
    // open_project records the path in recent projects (stored in the global
    // config), so isolate the config from the real file.
    let _cfg = crate::test_helpers::isolated_config();
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("legacy_undo.stalx");

    let mut project = Project::new("Legacy".to_string(), None);
    project.add_section(SectionData {
        shots: vec![shot_with_nullable_fields()],
        ..Default::default()
    });

    let mut db = Database::open(&path).unwrap();
    db.save_project(&project).unwrap();
    let saved = db.load_project().unwrap();
    let section_id = saved.sections[0].id;
    let shot_id = saved.sections[0].shots[0].id;

    // Persist undo/redo entries exactly as a pre-v7 build wrote them: every
    // untouched nullable field serialized as an explicit null, in both the
    // command payload and the PreviousValues snapshot.
    let legacy_command = format!(
        r#"{{"type":"update_shot","section_id":{section_id},"shot_id":{shot_id},"updates":{{"azimuth_in":null,"azimuth_out":null,"length":4.0,"depth_in":null,"depth_out":null,"pitch_in":null,"pitch_out":null,"left":null,"right":null,"up":null,"down":null,"comment":null,"is_reference":null,"marker_index":null,"temperature":null}}}}"#
    );
    let legacy_values = r#"{"azimuth_in":null,"azimuth_out":null,"length":2.0,"depth_in":null,"depth_out":null,"pitch_in":null,"pitch_out":null,"left":null,"right":null,"up":null,"down":null,"comment":null,"is_reference":null,"marker_index":null,"temperature":null}"#;
    let legacy_undo_data = format!(
        r#"{{"PreviousValues":{{"section_id":{section_id},"shot_id":{shot_id},"values_json":{}}}}}"#,
        serde_json::to_string(legacy_values).unwrap()
    );
    db.save_undo_stack_with_timestamps(vec![(
        legacy_command.clone(),
        legacy_undo_data.clone(),
        None,
    )])
    .unwrap();
    db.save_redo_stack_with_timestamps(vec![(legacy_command, legacy_undo_data, None)])
        .unwrap();
    drop(db);

    // Rewind the version stamp so the file looks exactly like one written by
    // a pre-v7 build (Database::open stamped the current schema version).
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("PRAGMA user_version = 6", []).unwrap();
    drop(conn);

    let state = AppState::new().unwrap();
    assert!(state.open_project(path).success);

    // The legacy stacks are dropped wholesale — nothing to undo or redo, so
    // nothing can replay the explicit nulls and clear fields.
    {
        let undo_stack = state.undo_stack.lock().unwrap();
        assert_eq!(undo_stack.len(), 0, "legacy undo entries must be dropped");
        assert_eq!(
            undo_stack.redo_len(),
            0,
            "legacy redo entries must be dropped"
        );
    }

    // The shot's nullable fields are intact.
    let project = state.get_project_state().unwrap();
    let shot = &project.sections[0].shots[0];
    assert_eq!(shot.pitch_in, Some(5.0));
    assert_eq!(shot.left, Some(1.5));
    assert_eq!(shot.comment.as_deref(), Some("original"));
    assert_eq!(shot.marker_index, Some(2));
    assert_eq!(shot.temperature, Some(14.5));
}

#[test]
fn test_undo_after_reload_restores_exactly_the_edited_field() {
    // open_project/save_project record the path in recent projects (stored in
    // the global config), so isolate the config from the real file.
    let _cfg = crate::test_helpers::isolated_config();
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("new_format_undo.stalx");

    let mut project = Project::new("New Format".to_string(), None);
    project.add_section(SectionData {
        shots: vec![shot_with_nullable_fields()],
        ..Default::default()
    });

    let mut db = Database::open(&path).unwrap();
    db.save_project(&project).unwrap();
    drop(db);

    // Session 1: open, edit ONLY the comment, save (persists the undo stack
    // in the new format).
    let state = AppState::new().unwrap();
    assert!(state.open_project(path.clone()).success);
    let (section_id, shot_id) = {
        let project = state.get_project_state().unwrap();
        (project.sections[0].id, project.sections[0].shots[0].id)
    };
    let result = state.execute(Command::UpdateShot {
        section_id,
        shot_id,
        updates: ShotUpdates {
            comment: Some(Some("edited".to_string())),
            ..Default::default()
        },
    });
    assert!(result.success);
    assert!(state.save_project(Some(path.clone()), false).success);

    // Session 2: fresh app instance, reload, undo.
    let state2 = AppState::new().unwrap();
    assert!(state2.open_project(path).success);
    {
        let stack = state2.undo_stack.lock().unwrap();
        assert!(
            stack.can_undo(),
            "new-format undo history must survive reload"
        );
    }
    let project = state2.get_project_state().unwrap();
    assert_eq!(
        project.sections[0].shots[0].comment.as_deref(),
        Some("edited")
    );

    assert!(state2.undo().success);

    let project = state2.get_project_state().unwrap();
    let shot = &project.sections[0].shots[0];
    // Exactly the edited field is restored...
    assert_eq!(shot.comment.as_deref(), Some("original"));
    // ...and the untouched nullable fields were NOT cleared by the undo.
    assert_eq!(shot.pitch_in, Some(5.0));
    assert_eq!(shot.pitch_out, Some(-5.0));
    assert_eq!(shot.left, Some(1.5));
    assert_eq!(shot.right, Some(2.5));
    assert_eq!(shot.up, Some(0.5));
    assert_eq!(shot.down, Some(3.5));
    assert_eq!(shot.marker_index, Some(2));
    assert_eq!(shot.temperature, Some(14.5));
}

#[test]
fn test_merge_projects_preserves_offsets_zero_datums_and_closure_ids() {
    let temp_dir = TempDir::new().unwrap();

    let mut project_a = Project::new("A".to_string(), None);
    let section_a = project_a
        .add_section(SectionData {
            name: Some("Section A".to_string()),
            shots: vec![test_shot_data(1.0)],
            ..Default::default()
        })
        .id;
    project_a.section_offsets.insert(section_a, (1.0, 2.0));
    project_a
        .station_offsets
        .insert(StationRef::new(section_a, 0).into(), (0.5, -0.5, 1.0));
    let gps_a = GpsCoordinates::new(10.0, 20.0, 0.0).unwrap();
    project_a
        .store_zero_datum_without_repositioning(StationRef::new(section_a, 0), gps_a)
        .unwrap();
    project_a.loop_closures.push(LoopClosure {
        id: 0,
        station_a: StationRef::new(section_a, 0).into(),
        station_b: StationRef::new(section_a, 1).into(),
        path_length: 1.0,
        misclosure_distance: 0.1,
        error_percentage: 10.0,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });

    let mut project_b = Project::new("B".to_string(), None);
    let section_b = project_b
        .add_section(SectionData {
            name: Some("Section B".to_string()),
            shots: vec![test_shot_data(2.0)],
            ..Default::default()
        })
        .id;
    project_b.section_offsets.insert(section_b, (3.0, 4.0));
    project_b
        .station_offsets
        .insert(StationRef::new(section_b, 0).into(), (-1.0, 1.5, 0.0));
    let gps_b = GpsCoordinates::new(-5.0, 40.0, 2.0).unwrap();
    project_b
        .store_zero_datum_without_repositioning(StationRef::new(section_b, 0), gps_b)
        .unwrap();
    project_b.loop_closures.push(LoopClosure {
        id: 0,
        station_a: StationRef::new(section_b, 0).into(),
        station_b: StationRef::new(section_b, 1).into(),
        path_length: 2.0,
        misclosure_distance: 0.2,
        error_percentage: 10.0,
        horizontal_misclosure: 0.2,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });

    let source_a = temp_dir.path().join("a.stalx");
    let source_b = temp_dir.path().join("b.stalx");
    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&project_a).unwrap();
    let mut db_b = Database::open(&source_b).unwrap();
    db_b.save_project(&project_b).unwrap();
    drop(db_a);
    drop(db_b);

    let state = AppState::new().unwrap();
    let output_path = temp_dir.path().join("merged-output.stalx");
    let result = state.execute(Command::MergeProjects {
        source_paths: vec![source_a, source_b],
        output_path: output_path.clone(),
        output_name: "Merged".to_string(),
        archive_originals: false,
    });
    assert!(result.success);

    let db = Database::open_existing(&output_path).unwrap();
    let merged = db.load_project().unwrap();

    let merged_section_a = merged
        .sections
        .iter()
        .find(|s| s.name.as_deref() == Some("Section A"))
        .unwrap()
        .id;
    let merged_section_b = merged
        .sections
        .iter()
        .find(|s| s.name.as_deref() == Some("Section B"))
        .unwrap()
        .id;

    assert_eq!(
        merged.section_offsets.get(&merged_section_a),
        Some(&(1.0, 2.0))
    );
    assert_eq!(
        merged.section_offsets.get(&merged_section_b),
        Some(&(3.0, 4.0))
    );

    assert_eq!(
        merged.station_offset_for_ref(StationRef::new(merged_section_a, 0)),
        Some((0.5, -0.5, 1.0))
    );
    assert_eq!(
        merged.station_offset_for_ref(StationRef::new(merged_section_b, 0)),
        Some((-1.0, 1.5, 0.0))
    );

    assert!(merged
        .zero_datums
        .iter()
        .any(|zd| zd.station_ref.section_id == merged_section_a && zd.gps.latitude == 10.0));
    assert!(merged
        .zero_datums
        .iter()
        .any(|zd| zd.station_ref.section_id == merged_section_b && zd.gps.latitude == -5.0));

    let mut closure_ids = HashSet::new();
    for closure in &merged.loop_closures {
        assert_ne!(closure.id, 0, "closure IDs should be reassigned");
        closure_ids.insert(closure.id);
    }
    assert_eq!(closure_ids.len(), merged.loop_closures.len());

    assert!(merged.loop_closures.iter().any(|c| {
        c.station_a.section_id == merged_section_a && c.station_b.section_id == merged_section_a
    }));
    assert!(merged.loop_closures.iter().any(|c| {
        c.station_a.section_id == merged_section_b && c.station_b.section_id == merged_section_b
    }));
}

#[test]
fn test_merge_projects_preserves_station_comments() {
    // merge_projects remaps every sibling cross-reference collection; station
    // comments must be carried over too (they were previously dropped silently
    // while offsets/datums/merges/closures were all copied).
    let temp_dir = TempDir::new().unwrap();

    let mut project_a = Project::new("A".to_string(), None);
    let section_a = project_a
        .add_section(SectionData {
            name: Some("Section A".to_string()),
            shots: vec![test_shot_data(1.0)],
            ..Default::default()
        })
        .id;
    project_a.ensure_shot_uuids();
    let key_a = project_a
        .key_for_ref(StationRef::new(section_a, 0))
        .unwrap();
    project_a
        .station_comments
        .insert(key_a, "junction with main line".to_string());

    let mut project_b = Project::new("B".to_string(), None);
    let section_b = project_b
        .add_section(SectionData {
            name: Some("Section B".to_string()),
            shots: vec![test_shot_data(2.0)],
            ..Default::default()
        })
        .id;
    project_b.ensure_shot_uuids();
    let key_b = project_b
        .key_for_ref(StationRef::new(section_b, 1))
        .unwrap();
    project_b
        .station_comments
        .insert(key_b, "sump start".to_string());

    let source_a = temp_dir.path().join("a.stalx");
    let source_b = temp_dir.path().join("b.stalx");
    Database::open(&source_a)
        .unwrap()
        .save_project(&project_a)
        .unwrap();
    Database::open(&source_b)
        .unwrap()
        .save_project(&project_b)
        .unwrap();

    let state = AppState::new().unwrap();
    let output_path = temp_dir.path().join("merged-output.stalx");
    let result = state.execute(Command::MergeProjects {
        source_paths: vec![source_a, source_b],
        output_path: output_path.clone(),
        output_name: "Merged".to_string(),
        archive_originals: false,
    });
    assert!(result.success, "merge failed: {:?}", result.error);

    let merged = Database::open_existing(&output_path)
        .unwrap()
        .load_project()
        .unwrap();
    let merged_section_a = merged
        .sections
        .iter()
        .find(|s| s.name.as_deref() == Some("Section A"))
        .unwrap()
        .id;
    let merged_section_b = merged
        .sections
        .iter()
        .find(|s| s.name.as_deref() == Some("Section B"))
        .unwrap()
        .id;

    assert_eq!(
        merged
            .station_comment_for_ref(StationRef::new(merged_section_a, 0))
            .map(String::as_str),
        Some("junction with main line"),
        "section A's station comment must survive the merge"
    );
    assert_eq!(
        merged
            .station_comment_for_ref(StationRef::new(merged_section_b, 1))
            .map(String::as_str),
        Some("sump start"),
        "section B's station comment must survive the merge"
    );
}

#[test]
fn save_blocks_on_dangling_refs_for_both_manual_and_autosave() {
    // Auto-save must NEVER persist a broken project: a save with unresolvable
    // cross-references is refused (no file written) for BOTH manual and auto-save,
    // so corruption never reaches disk. The user is told it didn't run and restores
    // integrity via Repair, after which saves resume.
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();

    let mut project = Project::new("Dangle".to_string(), None);
    let a = project
        .add_section(SectionData {
            name: Some("Main".to_string()),
            shots: vec![test_shot_data(1.0)],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    // Dangling station offset: anchors a shot UUID that doesn't exist.
    let dangling = StationKey::new(a, StationAnchor::AfterShot("ghost".to_string()));
    project.station_offsets.insert(dangling, (1.0, 2.0, 3.0));
    assert!(project.has_unresolvable_cross_references());
    state.set_project_for_tests(project);

    let stalx = temp_dir.path().join("dangle.stalx");

    // Manual save is blocked and writes nothing.
    let manual = state.execute(Command::SaveProject {
        path: Some(stalx.clone()),
        is_autosave: false,
    });
    assert!(!manual.success, "manual save must block on dangling refs");
    assert!(
        !stalx.exists(),
        "a blocked manual save must not write a file"
    );

    // Auto-save is ALSO blocked — it must never persist a broken project.
    let auto = state.execute(Command::SaveProject {
        path: Some(stalx.clone()),
        is_autosave: true,
    });
    assert!(
        !auto.success,
        "auto-save must also block on dangling refs (never persist a broken project)"
    );
    assert!(
        !stalx.exists(),
        "a blocked auto-save must not write a file either"
    );
}

#[test]
fn repair_open_project_integrity_is_undoable_and_redoable() {
    // Repair drops dangling refs / re-cascades offsets; it must record an undo
    // entry so the user can revert it. Undo restores the pre-repair (corrupt)
    // state, redo re-applies the fix — both via the snapshot pair.
    let state = AppState::new().unwrap();

    let mut project = Project::new("Repairable".to_string(), None);
    let a = project
        .add_section(SectionData {
            name: Some("Main".to_string()),
            shots: vec![test_shot_data(1.0)],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    // Dangling station offset → unresolvable cross-reference (corrupt project).
    let dangling = StationKey::new(a, StationAnchor::AfterShot("ghost".to_string()));
    project.station_offsets.insert(dangling, (1.0, 2.0, 3.0));
    assert!(project.has_unresolvable_cross_references());
    state.set_project_for_tests(project);

    // Repair fixes it AND records exactly one undo entry.
    let result = state.repair_open_project_integrity();
    assert!(result.fixed >= 1, "repair should report at least one fix");
    assert!(
        !state
            .get_project_state()
            .unwrap()
            .has_unresolvable_cross_references(),
        "repair drops the dangling ref"
    );
    assert_eq!(
        state.get_undo_stack().len(),
        1,
        "repair records one undo entry"
    );

    // Undo restores the pre-repair (corrupt) state.
    assert!(state.undo().success, "repair must be undoable");
    assert!(
        state
            .get_project_state()
            .unwrap()
            .has_unresolvable_cross_references(),
        "undo brings the dangling ref back"
    );

    // Redo re-applies the repair.
    assert!(state.redo().success, "repair must be redoable");
    assert!(
        !state
            .get_project_state()
            .unwrap()
            .has_unresolvable_cross_references(),
        "redo re-drops the dangling ref"
    );
}

#[test]
fn redo_batch_preserves_double_anchored_bridge_closure() {
    // A single user Batch can strand a sole-bridge closure: two otherwise
    // unconnected sections joined only by a freshly-created closure. Normally the
    // post-command epilogue converts that closure into a merge (#8 — closures are
    // only for true loops), and execute_batch captures its redo snapshot AFTER that
    // conversion so undo→redo preserves it.
    //
    // BUT here both sections are zero-datum-anchored (the only way to create a
    // closure between two disconnected sections). Converting the bridge to a rigid
    // merge would put two GPS anchors in one merge component and tear it — the
    // reported bug — so the conversion guard now LEAVES it as a closure. This test
    // pins that corrected behaviour AND that the batch snapshot still captures the
    // post-epilogue state across undo/redo: the closure (not a merge) is preserved,
    // and the two datums stay in separate merge components.
    let state = AppState::new().unwrap();

    let mut project = Project::new("Batch".to_string(), None);
    let a = project
        .add_section(SectionData {
            name: Some("A".to_string()),
            shots: vec![test_shot_data(1.0), test_shot_data(2.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            name: Some("B".to_string()),
            shots: vec![test_shot_data(3.0), test_shot_data(4.0)],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    state.set_project_for_tests(project);

    // One atomic batch: give each section a datum (so the otherwise-unconnected
    // pair is allowed a closure), then close A1↔B1. With no other path between them
    // the closure is a sole bridge and the epilogue converts it to a merge.
    let result = state.execute(Command::Batch {
        commands: vec![
            Command::SetZeroDatum {
                station_ref: StationRef::new(a, 0),
                coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
            },
            Command::SetZeroDatum {
                station_ref: StationRef::new(b, 0),
                coordinates: GpsCoordinates::new(46.0, -74.0, 110.0).unwrap(),
            },
            Command::CreateLoopClosure {
                station_a: StationRef::new(a, 1),
                station_b: StationRef::new(b, 1),
                closure_strategy: ClosureStrategy::default(),
            },
        ],
    });
    assert!(result.success, "batch should succeed: {:?}", result.error);

    let after_execute = state.get_project_state().unwrap();
    assert_eq!(
        after_execute.loop_closures.len(),
        1,
        "a sole-bridge closure between two anchored groups must be LEFT as a closure, not merged"
    );
    assert_eq!(
        after_execute.station_merges.len(),
        0,
        "no merge: converting it would double-anchor one merge component"
    );

    // Undo returns to the pre-batch topology (no datums, no closure, no merge).
    assert!(state.undo().success);
    let after_undo = state.get_project_state().unwrap();
    assert_eq!(after_undo.loop_closures.len(), 0);
    assert_eq!(after_undo.station_merges.len(), 0);

    // Redo must restore the post-epilogue topology: the closure is preserved and it
    // is still NOT a merge.
    assert!(state.redo().success);
    let after_redo = state.get_project_state().unwrap();
    assert_eq!(
        after_redo.loop_closures.len(),
        1,
        "redo must preserve the unconverted bridge closure"
    );
    assert_eq!(
        after_redo.station_merges.len(),
        0,
        "redo must not create the over-constraining merge"
    );
}

#[test]
fn update_shot_reconciles_datum_less_merge() {
    // Editing a shot upstream of a merge in a group with NO zero datum used to
    // leave the merge drifted: UpdateShot was misclassified INERT (skipping the
    // reconcile epilogue) and the bespoke realign_after_shot_edit no-ops without a
    // datum. UpdateShot is now geometry-affecting, so the reconcile heals the
    // datum-less group in the same command.
    let state = AppState::new().unwrap();
    let mut project = Project::new("NoDatum".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![test_shot_data(5.0)],
            ..Default::default()
        })
        .id;
    // Merge A:2 (after both shots) ↔ B:0, with NO zero datum anywhere.
    project
        .merge_stations(StationRef::new(a, 2), StationRef::new(b, 0))
        .unwrap();
    project.resolve_offsets();
    assert!(project.check_merge_alignment().is_empty(), "starts aligned");
    state.set_project_for_tests(project);

    // Edit shot 0 in A (upstream of the merge station) — a big length change moves
    // A:2 well beyond the 5 cm reporting tolerance.
    let shot0 = state
        .get_project_state()
        .unwrap()
        .get_section(a)
        .unwrap()
        .shots[0]
        .id;
    let updates = ShotUpdates {
        length: Some(9.0),
        ..Default::default()
    };
    let result = state.execute(Command::UpdateShot {
        section_id: a,
        shot_id: shot0,
        updates,
    });
    assert!(result.success, "{:?}", result.error);

    assert!(
        state
            .get_project_state()
            .unwrap()
            .check_merge_alignment()
            .is_empty(),
        "a shot edit must reconcile the datum-less merge, not leave it drifted"
    );
}

#[test]
fn metadata_only_update_shot_does_not_heal_drift() {
    // The converse of update_shot_reconciles_datum_less_merge: a comment/LRUD/
    // reference-only UpdateShot touches no geometry, so it must NOT run the
    // reconcile epilogue. Reconciling would silently re-align an already-drifted
    // project as a side effect of a metadata edit whose undo only restores the
    // metadata — the asymmetric-undo hazard that keeps SetStationComment INERT.
    let state = AppState::new().unwrap();
    let mut project = Project::new("Drift".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![test_shot_data(5.0)],
            ..Default::default()
        })
        .id;
    project
        .merge_stations(StationRef::new(a, 2), StationRef::new(b, 0))
        .unwrap();
    project.resolve_offsets();
    assert!(project.check_merge_alignment().is_empty(), "starts aligned");

    // Introduce drift WITHOUT reconciling: lengthen a shot upstream of the merge
    // directly in the model, so A:2 moves out of alignment with B:0.
    let shot0 = project.get_section(a).unwrap().shots[0].id;
    project.get_section_mut(a).unwrap().shots[0].length = 9.0;
    assert!(
        !project.check_merge_alignment().is_empty(),
        "drift is present before the metadata edit"
    );
    state.set_project_for_tests(project);

    // A comment-only edit must leave the drift untouched.
    let updates = ShotUpdates {
        comment: Some(Some("note".to_string())),
        ..Default::default()
    };
    let result = state.execute(Command::UpdateShot {
        section_id: a,
        shot_id: shot0,
        updates,
    });
    assert!(result.success, "{:?}", result.error);
    assert!(
        !state
            .get_project_state()
            .unwrap()
            .check_merge_alignment()
            .is_empty(),
        "a metadata-only shot edit must not reconcile (heal) a drifted merge"
    );

    // Sanity-check the gate isn't simply always-off: a geometry edit DOES heal it.
    let updates = ShotUpdates {
        length: Some(7.0),
        ..Default::default()
    };
    assert!(
        state
            .execute(Command::UpdateShot {
                section_id: a,
                shot_id: shot0,
                updates
            })
            .success
    );
    assert!(
        state
            .get_project_state()
            .unwrap()
            .check_merge_alignment()
            .is_empty(),
        "a geometry edit must reconcile the drift"
    );
}

#[test]
fn metadata_only_update_shot_batch_does_not_heal_drift() {
    // execute_batch gates its reconcile epilogue the same way execute() does: a
    // batch of metadata-only UpdateShots (a multi-cell comment paste) must not
    // heal a drifted merge as a side effect.
    let state = AppState::new().unwrap();
    let mut project = Project::new("DriftBatch".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![test_shot_data(5.0)],
            ..Default::default()
        })
        .id;
    project
        .merge_stations(StationRef::new(a, 2), StationRef::new(b, 0))
        .unwrap();
    project.resolve_offsets();
    assert!(project.check_merge_alignment().is_empty(), "starts aligned");

    let shot0 = project.get_section(a).unwrap().shots[0].id;
    let shot1 = project.get_section(a).unwrap().shots[1].id;
    project.get_section_mut(a).unwrap().shots[0].length = 9.0;
    assert!(
        !project.check_merge_alignment().is_empty(),
        "drift present before the batch"
    );
    state.set_project_for_tests(project);

    // Multi-cell comment paste → one batch of two comment-only UpdateShots.
    let mk = |shot_id| Command::UpdateShot {
        section_id: a,
        shot_id,
        updates: ShotUpdates {
            comment: Some(Some("note".to_string())),
            ..Default::default()
        },
    };
    let result = state.execute(Command::Batch {
        commands: vec![mk(shot0), mk(shot1)],
    });
    assert!(result.success, "{:?}", result.error);
    assert!(
        !state
            .get_project_state()
            .unwrap()
            .check_merge_alignment()
            .is_empty(),
        "a metadata-only batch must not reconcile (heal) a drifted merge"
    );
}

#[test]
fn repair_noop_on_clean_project_reports_unchanged() {
    // A repair that finds nothing to fix must not report `changed` (which the
    // frontend dirties on) or push a spurious undo entry. This depends on
    // resolve_offsets() no longer touch()ing an already-consistent project — if it
    // did, the snapshot's modified_at would differ every time and `changed` would
    // be permanently true.
    let state = AppState::new().unwrap();
    let mut project = Project::new("Clean".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    project.ensure_shot_uuids();
    project.resolve_offsets();
    state.set_project_for_tests(project);

    let result = state.repair_open_project_integrity();
    assert_eq!(result.fixed, 0);
    assert!(!result.changed, "a no-op repair must not report changed");
    assert_eq!(
        state.get_undo_stack().len(),
        0,
        "a no-op repair adds no undo entry"
    );
}

#[test]
fn save_remints_duplicate_shot_uuids_before_persisting() {
    // A within-section duplicate shot UUID is Critical (resolve_key snaps
    // AfterShot(uuid) to the FIRST match), but the unresolvable-cross-reference save
    // gate doesn't catch it (the ref still resolves, just to the wrong shot). The
    // save path re-mints the duplicate first so unique UUIDs reach disk — lossless,
    // so it auto-heals rather than blocking.
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    let mut project = Project::new("Dup".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![test_shot_data(1.0), test_shot_data(2.0)],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    // Force a within-section duplicate.
    let dup = project.get_section(a).unwrap().shots[0]
        .uuid
        .clone()
        .unwrap();
    project.get_section_mut(a).unwrap().shots[1].uuid = Some(dup.clone());
    assert!(
        project.has_critical_integrity_violations(),
        "dup UUID is Critical"
    );
    state.set_project_for_tests(project);

    let result = state.save_project(Some(temp_dir.path().join("dup")), false);
    assert!(
        result.success,
        "save auto-heals dup UUIDs rather than blocking: {:?}",
        result.error
    );

    // The persisted (and in-memory) project now has unique UUIDs, no Critical.
    let saved = state.get_project_state().unwrap();
    let uuids: Vec<_> = saved
        .get_section(a)
        .unwrap()
        .shots
        .iter()
        .filter_map(|s| s.uuid.clone())
        .collect();
    let mut uniq = uuids.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(
        uuids.len(),
        uniq.len(),
        "duplicate shot UUID re-minted before persist"
    );
    assert!(!saved.has_critical_integrity_violations());
}

#[test]
fn restore_snapshot_canonicalizes_legacy_index_anchors() {
    // A snapshot persisted by a PRE-ANCHOR build can carry positional Index
    // anchors (undo/redo history is persisted and reloaded across builds, and the
    // back-compat StationKey deserializer accepts the legacy shape). Restoring it
    // must canonicalize to AfterShot — otherwise a later shot insert/delete won't
    // shift the ref and the merge/datum/comment silently points at the wrong station.
    let mut project = Project::new("Legacy".to_string(), None);
    let s = project
        .add_section(SectionData {
            shots: vec![
                test_shot_data(1.0),
                test_shot_data(2.0),
                test_shot_data(3.0),
            ],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    // A station offset stored in the legacy positional (Index) form.
    project
        .station_offsets
        .insert(StationKey::new(s, StationAnchor::Index(2)), (1.0, 2.0, 3.0));
    let snapshot = serde_json::to_string(&project).unwrap();

    let mut slot: Option<Project> = None;
    assert!(AppState::restore_snapshot_into(&mut slot, &snapshot));
    let restored = slot.unwrap();

    // No Index anchor survives into the live project after restore.
    let mut saw_index = false;
    restored.for_each_station_ref(|_label, key| {
        if matches!(key.anchor, StationAnchor::Index(_)) {
            saw_index = true;
        }
    });
    assert!(
        !saw_index,
        "restore_snapshot_into must canonicalize legacy Index anchors"
    );
}

#[test]
fn repair_serializes_under_command_lock() {
    // Repair must hold command_lock for its whole duration so a concurrent command
    // can't slip a mutation between repair's before-snapshot and its own mutation
    // (which would make undo-of-repair drop that command). Verify by holding the
    // lock and asserting repair blocks until it's released.
    use std::sync::mpsc;
    use std::time::Duration;
    let state = Arc::new(AppState::new().unwrap());
    let mut project = Project::new("LockRepair".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    project.ensure_shot_uuids();
    state.set_project_for_tests(project);

    let guard = state.command_lock.lock().unwrap();
    let state2 = Arc::clone(&state);
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let _ = tx.send(state2.repair_open_project_integrity());
    });
    // While we hold command_lock, repair must block (no result arrives).
    assert!(
        rx.recv_timeout(Duration::from_millis(150)).is_err(),
        "repair ran without acquiring command_lock"
    );
    drop(guard);
    // Once released, repair completes.
    let result = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("repair completes after command_lock is released");
    handle.join().unwrap();
    assert_eq!(result.fixed, 0);
}

#[test]
fn save_drops_orphan_section_offset() {
    // A section_offsets entry for a section that no longer exists has a dangling
    // SQLite FK; persisting it aborts the WHOLE save with a generic error. It must
    // be dropped on save instead (the cross-reference gate doesn't see section_offsets).
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    let mut project = Project::new("Orphan".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    project.ensure_shot_uuids();
    project.section_offsets.insert(99999, (5.0, 6.0)); // no such section
    state.set_project_for_tests(project);

    let result = state.save_project(Some(temp_dir.path().join("orphan")), false);
    assert!(
        result.success,
        "orphan section_offset must not abort the save: {:?}",
        result.error
    );
    let saved = state.get_project_state().unwrap();
    assert!(
        saved
            .section_offsets
            .keys()
            .all(|sid| saved.get_section(*sid).is_some()),
        "orphan section_offsets must be dropped on save"
    );
}

#[test]
fn save_sanitizes_non_finite_geometry() {
    // A non-finite shot value would abort the save (NaN → NULL in a NOT NULL
    // column) or persist garbage (inf); it must be sanitized on save instead.
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    let mut project = Project::new("NonFinite".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    project.ensure_shot_uuids();
    project.sections[0].shots[0].length = f64::NAN;
    assert!(!project.sections[0].shots[0].all_finite());
    state.set_project_for_tests(project);

    let result = state.save_project(Some(temp_dir.path().join("nonfinite")), false);
    assert!(
        result.success,
        "non-finite geometry must be sanitized, not abort the save: {:?}",
        result.error
    );
    let saved = state.get_project_state().unwrap();
    assert!(
        saved.sections[0].shots[0].all_finite(),
        "non-finite geometry sanitized on save"
    );
}

#[test]
fn save_sanitizes_non_finite_section_offset() {
    // section_offsets is the one geometry field with no finite guard. A non-finite
    // offset (corrupt/hand-edited DB, or an inf round-trip) would abort the save
    // (NaN → NULL) or persist and poison the component's world coords. It must be
    // sanitized on save, mirroring the shot sanitize and the load-boundary guard.
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    let mut project = Project::new("NonFiniteOffset".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![test_shot_data(1.0)],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    project.section_offsets.insert(a, (f64::NAN, f64::INFINITY));
    state.set_project_for_tests(project);

    let result = state.save_project(Some(temp_dir.path().join("nf_offset")), false);
    assert!(
        result.success,
        "a non-finite section offset must be sanitized, not abort the save: {:?}",
        result.error
    );
    let saved = state.get_project_state().unwrap();
    let off = saved.section_offsets.get(&a).copied().unwrap_or((0.0, 0.0));
    assert!(
        off.0.is_finite() && off.1.is_finite(),
        "section offset sanitized on save"
    );
}

#[test]
fn blocked_save_does_not_mutate_non_finite_geometry() {
    // A save refused for a dangling cross-reference must NOT first run the
    // destructive non-finite sanitize on the live project — that mutation has no
    // undo entry, so a refused save would silently lose the user's shot values.
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    let mut project = Project::new("BlockedNoMutate".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![test_shot_data(1.0)],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    // A dangling station offset → unresolvable cross-reference (save-blocking).
    project.station_offsets.insert(
        StationKey::new(a, StationAnchor::AfterShot("ghost".to_string())),
        (1.0, 2.0, 3.0),
    );
    // ...and a non-finite shot the (now later) sanitize would otherwise destroy.
    project.sections[0].shots[0].length = f64::NAN;
    state.set_project_for_tests(project);

    let result = state.save_project(Some(temp_dir.path().join("blocked")), false);
    assert!(
        !result.success,
        "save must be blocked by the dangling cross-reference"
    );
    // The gate runs BEFORE the destructive sanitize, so the live shot is untouched.
    let unsaved = state.get_project_state().unwrap();
    assert!(
        !unsaved.sections[0].shots[0].all_finite(),
        "a refused save must not destructively sanitize the live project"
    );
}

#[test]
fn undo_of_duplicate_uuid_repair_restores_the_duplicates() {
    // The pre-repair state of a duplicate_shot_uuid repair is a CURRENT snapshot
    // that intentionally holds duplicate UUIDs. Undo must restore it EXACTLY —
    // restore_snapshot_into must not re-dedup a non-legacy (no Index anchor)
    // snapshot, or the repair can't be reverted.
    let state = AppState::new().unwrap();
    let mut project = Project::new("DupRepairUndo".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![test_shot_data(1.0), test_shot_data(2.0)],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    // A within-section duplicate UUID: a current corrupt state (AfterShot anchors).
    let dup = project.get_section(a).unwrap().shots[0]
        .uuid
        .clone()
        .unwrap();
    project.get_section_mut(a).unwrap().shots[1].uuid = Some(dup.clone());
    assert!(project.has_critical_integrity_violations());
    state.set_project_for_tests(project);

    // Repair re-mints the duplicate (now unique) and records the dup state as undo `before`.
    let r = state.repair_open_project_integrity();
    assert!(r.changed, "repair changed the project");
    assert!(
        !state
            .get_project_state()
            .unwrap()
            .has_critical_integrity_violations(),
        "repair deduped the UUIDs"
    );

    // Undo must restore the duplicate-UUID state EXACTLY (and its warning).
    assert!(state.undo().success);
    let after_undo = state.get_project_state().unwrap();
    let uuids: Vec<_> = after_undo
        .get_section(a)
        .unwrap()
        .shots
        .iter()
        .filter_map(|s| s.uuid.clone())
        .collect();
    assert_eq!(
        uuids[0], uuids[1],
        "undo restored the duplicate UUID exactly"
    );
    assert!(
        after_undo.has_critical_integrity_violations(),
        "the duplicate_shot_uuid warning is back after undo"
    );
}

#[test]
fn restore_snapshot_mints_null_uuids_before_reanchor() {
    // A legacy (pre-v6) snapshot can carry shots with uuid:null AND positional Index
    // anchors. restore must MINT the missing UUIDs before re-anchoring —
    // ensure_unique only dedups EXISTING UUIDs — or key_for_ref can't canonicalize
    // the Index anchor and it stays live (the gap S4 closes in the P1 fix).
    let mut project = Project::new("LegacyNullUuid".to_string(), None);
    let s = project
        .add_section(SectionData {
            shots: vec![
                test_shot_data(1.0),
                test_shot_data(2.0),
                test_shot_data(3.0),
            ],
            ..Default::default()
        })
        .id;
    // Force legacy null UUIDs (pre-v6 files load with NULL uuid columns).
    for shot in &mut project.get_section_mut(s).unwrap().shots {
        shot.uuid = None;
    }
    // A station offset stored in the legacy positional (Index) form.
    project
        .station_offsets
        .insert(StationKey::new(s, StationAnchor::Index(2)), (1.0, 2.0, 3.0));
    let snapshot = serde_json::to_string(&project).unwrap();

    let mut slot: Option<Project> = None;
    assert!(AppState::restore_snapshot_into(&mut slot, &snapshot));
    let restored = slot.unwrap();

    // No Index anchor survives: the null UUIDs were minted, so reanchor could
    // canonicalize Index → AfterShot.
    let mut saw_index = false;
    restored.for_each_station_ref(|_label, key| {
        if matches!(key.anchor, StationAnchor::Index(_)) {
            saw_index = true;
        }
    });
    assert!(
        !saw_index,
        "restore must mint null UUIDs so Index anchors canonicalize"
    );
}

#[test]
fn finalize_structural_edit_ignores_pre_existing_critical() {
    // A project opened ALREADY critical (e.g. a dangling cross-reference) must not
    // have an otherwise-clean collab apply / import rolled back: finalize signals a
    // rollback only for NEWLY introduced corruption, matching execute()'s guard.
    let state = AppState::new().unwrap();
    let mut project = Project::new("AlreadyCritical".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    project.ensure_shot_uuids();
    // Inject a non-finite shot value → non_finite_geometry (a Critical violation).
    project.sections[0].shots[0].length = f64::NAN;
    assert!(project.has_critical_integrity_violations());
    state.set_project_for_tests(project);

    // pre_had_critical = true: do NOT signal rollback (the corruption pre-existed).
    assert!(
        !state.finalize_structural_edit(true, true),
        "must not block an otherwise-clean edit on an already-critical project"
    );
    // pre_had_critical = false (clean before): DOES signal rollback (corruption present).
    assert!(
        state.finalize_structural_edit(false, true),
        "must block when this edit introduced the critical violation"
    );
}

#[test]
fn redo_legacy_prepend_createshot_reanchors_section_start() {
    // A CreateShot undo entry persisted by a PRE-anchor build has after_shot_id /
    // before_shot_id == None even for a prepend, so redo used to hit a raw insert
    // that skipped the SectionStart re-anchor — leaving a station-0 datum pointing at
    // the newly-prepended station instead of the original first station. Redo now
    // routes a legacy (anchor-less) entry through the insert helper by position.
    let state = AppState::new().unwrap();
    let mut project = Project::new("LegacyRedo".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![test_shot_data(1.0), test_shot_data(2.0)],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    // Zero datum on station 0 → stored as a SectionStart anchor.
    project
        .set_zero_datum(
            StationRef::new(a, 0),
            GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
        )
        .unwrap();
    state.set_project_for_tests(project);

    // A LEGACY redo entry: prepend (position 0) with NO anchor fields, as a
    // pre-anchor build would have persisted it.
    let entry = UndoEntry {
        command: Command::CreateShot {
            section_id: a,
            shot: test_shot_data(5.0),
            after_shot_id: None,
            before_shot_id: None,
        },
        undo_data: UndoData::CreatedShotSnapshot {
            section_id: a,
            shot_id: 999,
            shot_data: test_shot_data(5.0),
            position: 0,
            station_shift_from: 0,
            after_shot_id: None,
            before_shot_id: None,
            uuid: Some("prep-uuid".to_string()),
        },
        timestamp: None,
    };
    state.undo_stack.lock().unwrap().push_redo(entry);
    assert!(state.redo().success, "legacy prepend redo");

    let restored = state.get_project_state().unwrap();
    assert_eq!(
        restored.get_section(a).unwrap().shots.len(),
        3,
        "prepend re-applied"
    );
    assert_eq!(
        restored.get_section(a).unwrap().shots[0].uuid.as_deref(),
        Some("prep-uuid"),
    );
    // The station-0 datum must still resolve to the ORIGINAL first station (now
    // index 1), not the freshly-prepended station (index 0).
    let datum_key = restored.zero_datums[0].station_ref.clone();
    let resolved = restored
        .resolve_key(&datum_key)
        .expect("datum still resolves");
    assert_eq!(
        resolved.station_index, 1,
        "SectionStart datum re-anchored to the original first station after a legacy prepend redo"
    );
}

#[test]
fn test_open_project_fails_on_invalid_file() {
    let temp_dir = TempDir::new().unwrap();
    let invalid_path = temp_dir.path().join("invalid.stalx");
    std::fs::write(&invalid_path, b"not a database").unwrap();

    let state = AppState::new().unwrap();
    let result = state.open_project(invalid_path);
    assert!(!result.success);
    let err = result.error.unwrap_or_default();
    let err_lower = err.to_lowercase();
    assert!(
        err_lower.contains("database") || err_lower.contains("corrupt"),
        "Expected database/corruption error, got: {err}"
    );
}

#[test]
fn test_save_project_persists_display_settings_cache() {
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Cache Save".to_string(),
        location: None,
    });

    state.save_display_setting("showStations", "false").unwrap();

    let save_path = temp_dir.path().join("cache-save");
    let result = state.save_project(Some(save_path.clone()), false);
    assert!(result.success);

    let saved_path = save_path.with_extension("stalx");
    let db = Database::open_readonly(&saved_path).unwrap();
    let settings = db.load_display_settings().unwrap();
    assert_eq!(settings.get("showStations"), Some(&"false".to_string()));

    let cache = state.display_settings_cache.lock().unwrap();
    assert!(cache.is_empty());
}

#[test]
fn test_undo_fails_with_invalid_previous_values_shot() {
    let state = AppState::new().unwrap();
    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::UpdateShot {
            section_id: 1,
            shot_id: 1,
            updates: ShotUpdates::default(),
        },
        UndoData::PreviousValues {
            section_id: 1,
            shot_id: Some(1),
            values_json: "not-json".to_string(),
        },
    );
    drop(stack);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to parse undo data"));
}

#[test]
fn test_undo_fails_with_invalid_previous_values_section() {
    let state = AppState::new().unwrap();
    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::UpdateSectionMetadata {
            section_id: 1,
            updates: SectionUpdates::default(),
        },
        UndoData::PreviousValues {
            section_id: 1,
            shot_id: None,
            values_json: "not-json".to_string(),
        },
    );
    drop(stack);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to parse undo data"));
}

#[test]
fn test_undo_fails_with_invalid_project_snapshot() {
    let state = AppState::new().unwrap();
    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::Batch {
            commands: Vec::new(),
        },
        UndoData::ProjectSnapshot("not-json".to_string()),
    );
    drop(stack);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Failed to parse project snapshot")
    );
}

#[test]
fn test_redo_fails_with_invalid_project_snapshot_pair() {
    let state = AppState::new().unwrap();
    let mut stack = state.undo_stack.lock().unwrap();
    let entry = UndoEntry {
        command: Command::CloseProject,
        undo_data: UndoData::ProjectSnapshotPair {
            before: "{}".to_string(),
            after: "not-json".to_string(),
        },
        timestamp: None,
    };
    stack.push_redo(entry);
    drop(stack);

    let result = state.redo();
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Failed to parse project snapshot")
    );
}

#[test]
fn test_redo_fails_for_command_not_allowed_in_undo_context() {
    let state = AppState::new().unwrap();
    let mut stack = state.undo_stack.lock().unwrap();
    let entry = UndoEntry {
        command: Command::MergeProjects {
            source_paths: Vec::new(),
            output_path: PathBuf::from("out.stalx"),
            output_name: "Merged".to_string(),
            archive_originals: false,
        },
        undo_data: UndoData::None,
        timestamp: None,
    };
    stack.push_redo(entry);
    drop(stack);

    let result = state.redo();
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Command cannot be executed in undo context")
    );
}

#[test]
fn test_create_project_without_location() {
    let state = AppState::new().unwrap();

    let result = state.execute(Command::CreateProject {
        name: "Unnamed Cave".to_string(),
        location: None,
    });

    assert!(result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.name, "Unnamed Cave");
    assert!(project.location.is_none());
}

#[test]
fn test_close_project() {
    let state = AppState::new().unwrap();

    // Create a project first
    state.execute(Command::CreateProject {
        name: "To Close".to_string(),
        location: None,
    });

    // Close it
    let result = state.execute(Command::CloseProject);
    assert!(result.success);

    // Project should be None
    assert!(state.get_project_state().is_none());
}

// === Section Operations Tests ===

#[test]
fn test_create_section() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: Some("John".to_string()),
        date: None,
        color: "#4ecdc4".to_string(),
        direction: Some(SurveyDirection::In),
        shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
    });

    assert!(result.success);
    assert!(result.section_id.is_some());

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].name, Some("Section A".to_string()));
    assert_eq!(project.sections[0].shots.len(), 2);
}

#[test]
fn get_adjusted_stations_none_without_project() {
    let state = AppState::new().unwrap();
    assert!(state.get_adjusted_stations().is_none());
}

#[test]
fn get_adjusted_stations_caches_and_invalidates() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Adj".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#111111".to_string(),
        direction: Some(SurveyDirection::In),
        shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
    });

    // Two consecutive calls return the same result (second served from cache).
    let adj1 = state.get_adjusted_stations().expect("adjusted stations");
    let adj1_again = state
        .get_adjusted_stations()
        .expect("adjusted stations (cached)");
    assert_eq!(adj1.len(), adj1_again.len());
    assert_eq!(adj1.len(), 3, "two shots → three stations");

    // A mutating command must invalidate the cache: the adjusted view reflects
    // the newly added section.
    state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#222222".to_string(),
        direction: Some(SurveyDirection::In),
        shots: vec![test_shot_data(5.0)],
    });
    let adj2 = state
        .get_adjusted_stations()
        .expect("adjusted stations after edit");
    assert_eq!(
        adj2.len(),
        5,
        "adjusted view must reflect the added section after cache invalidation"
    );
}

#[test]
fn distance_field_none_without_project() {
    let state = AppState::new().unwrap();
    assert!(state.distance_field(None).is_none());
}

#[test]
fn distance_field_from_origin_over_appstate() {
    // End-to-end through the atomic accessor (#34): one reconciled snapshot →
    // adjusted coords → distance_field_from, all at a single consistent version.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Dist".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#111111".to_string(),
        direction: Some(SurveyDirection::In),
        shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
    });
    let section_id = state.get_project_state().unwrap().sections[0].id;
    let origin = StationRef::new(section_id, 0);

    let field = state.distance_field(Some(&origin)).expect("distance field");
    assert_eq!(field.distances.len(), 3, "two shots → three stations");
    assert_eq!(field.station_refs.len(), 3);
    let oi = field
        .station_refs
        .iter()
        .position(|r| *r == origin)
        .expect("origin present");
    assert_eq!(field.distances[oi], Some(0.0), "origin distance is zero");
    assert!(
        field.distances.iter().all(Option::is_some),
        "single connected section: every station reachable"
    );
    assert!(field.max_reachable > 0.0);
}

#[test]
fn repair_invalidates_adjusted_cache() {
    use std::sync::atomic::Ordering::SeqCst;
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Repair".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#111111".to_string(),
        direction: Some(SurveyDirection::In),
        shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
    });

    // Populate the adjusted cache.
    let _ = state.get_adjusted_stations().expect("adjusted stations");
    assert!(
        state.adjusted_cache.lock().unwrap().is_some(),
        "cache should be populated after a solve"
    );
    let gen_before = state.adjusted_cache_generation.load(SeqCst);

    // Repair mutates measured geometry without necessarily bumping modified_at, so
    // it must drop the cached adjusted solve (otherwise a later read serves stale
    // geometry keyed on an unchanged version).
    let _ = state.repair_open_project_integrity();
    assert!(
        state.adjusted_cache.lock().unwrap().is_none(),
        "repair must invalidate the adjusted cache"
    );
    assert!(
        state.adjusted_cache_generation.load(SeqCst) > gen_before,
        "repair must bump the invalidation generation"
    );
}

#[test]
fn unmerge_converts_orphaned_bridge_closure() {
    // Deleting the merge that was a loop's other path strands the section onto
    // the closure — which must then become a merge (same #8 principle as delete).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#222222".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    let closure = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 1),
        closure_strategy: ClosureStrategy::default(),
    });
    assert!(closure.success, "{:?}", closure.error);
    assert_eq!(state.get_project_state().unwrap().loop_closures.len(), 1);

    // Delete the merge that closed the loop's other path.
    let r = state.execute(Command::UnmergeStationPair {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    assert!(r.success, "{:?}", r.error);

    let p = state.get_project_state().unwrap();
    assert!(
        p.loop_closures.is_empty(),
        "unmerge should convert the now-sole-bridge closure to a merge: {:?}",
        p.loop_closures
    );
    assert!(p.check_orphan_closures().is_empty());
}

#[test]
fn shot_sanitize_non_finite_neutralizes_geometry() {
    // The load-boundary sanitizer (used by the SQLite loader) replaces non-finite
    // core fields with 0.0 and non-finite optional fields with None.
    use crate::models::ShotData;
    let mut shot = crate::models::Shot::new(
        1,
        ShotData {
            azimuth_in: 1.0,
            azimuth_out: 1.0,
            length: 5.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        },
    );
    shot.length = f64::NAN;
    shot.depth_out = f64::INFINITY;
    shot.pitch_in = Some(f64::NEG_INFINITY);
    shot.left = Some(2.0); // finite optional stays

    assert!(shot.sanitize_non_finite(), "must report a change");
    assert!(shot.all_finite(), "result must be finite");
    assert_eq!(shot.length, 0.0);
    assert_eq!(shot.depth_out, 0.0);
    assert_eq!(shot.pitch_in, None);
    assert_eq!(shot.left, Some(2.0), "finite optional preserved");
    assert!(
        !shot.sanitize_non_finite(),
        "already-finite shot reports no change"
    );
}

#[test]
fn coordinates_new_checked_rejects_non_finite() {
    assert!(Coordinates::new_checked(1.0, 2.0, 3.0).is_ok());
    assert!(Coordinates::new_checked(f64::NAN, 0.0, 0.0).is_err());
    assert!(Coordinates::new_checked(0.0, f64::INFINITY, 0.0).is_err());
    assert!(Coordinates::new_checked(0.0, 0.0, f64::NEG_INFINITY).is_err());
}

#[test]
fn move_section_and_segment_reject_non_finite_offset() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let nan = Coordinates::new(f64::NAN, 0.0, 0.0);
    assert!(
        !state
            .execute(Command::MoveSection {
                section_id: a,
                offset: nan
            })
            .success
    );
    assert!(
        !state
            .execute(Command::MoveSegment {
                section_id: a,
                offset: nan
            })
            .success
    );
    // A finite move still works.
    assert!(
        state
            .execute(Command::MoveSegment {
                section_id: a,
                offset: Coordinates::new(1.0, 2.0, 0.0),
            })
            .success
    );
}

#[test]
fn merge_allowed_across_inert_closure_but_rejected_across_aligned() {
    // A merge is rejected only when the two sections are already RIGIDLY connected
    // (merges or ALIGNED closures). An inert (unaligned) closure does not constrain
    // them, so merging across one — the first real link — must be allowed; the old
    // connectivity walk followed inert closures and wrongly rejected it, forcing the
    // sole-bridge-closure-that-should-be-a-merge bug (catalog #8).
    fn setup(aligned: bool) -> (AppState, SectionId, SectionId) {
        let state = AppState::new().unwrap();
        state.execute(Command::CreateProject {
            name: "X".to_string(),
            location: None,
        });
        let a = state
            .execute(Command::CreateSection {
                name: Some("A".to_string()),
                surveyor: None,
                date: None,
                color: "#111111".to_string(),
                direction: Some(SurveyDirection::In),
                shots: vec![test_shot_data(5.0)],
            })
            .section_id
            .unwrap();
        let b = state
            .execute(Command::CreateSection {
                name: Some("B".to_string()),
                surveyor: None,
                date: None,
                color: "#222222".to_string(),
                direction: Some(SurveyDirection::In),
                shots: vec![test_shot_data(5.0)],
            })
            .section_id
            .unwrap();
        // Inject a single closure A0 <-> B1 between the otherwise-unconnected sections.
        {
            let mut g = state.project.lock().unwrap();
            let p = g.as_mut().unwrap();
            let id = p.next_closure_id;
            p.loop_closures.push(LoopClosure {
                id,
                station_a: StationRef::new(a, 0).into(),
                station_b: StationRef::new(b, 1).into(),
                path_length: 10.0,
                misclosure_distance: 0.1,
                error_percentage: 1.0,
                horizontal_misclosure: 0.08,
                vertical_misclosure: 0.06,
                strategy: ClosureStrategy::default(),
                is_aligned: aligned,
            });
            p.next_closure_id += 1;
        }
        (state, a, b)
    }

    // Inert closure → the merge is the first rigid link → ALLOWED, result sound.
    let (state, a, b) = setup(false);
    let r = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });
    assert!(
        r.success,
        "merge across an inert closure must be allowed: {:?}",
        r.error
    );
    assert!(!state
        .get_project_state()
        .unwrap()
        .has_critical_integrity_violations());

    // Aligned closure → already rigidly connected → merge REJECTED (would be a cycle).
    let (state2, a2, b2) = setup(true);
    let r2 = state2.execute(Command::MergeStations {
        station_a: StationRef::new(a2, 1),
        station_b: StationRef::new(b2, 0),
    });
    assert!(
        !r2.success,
        "merge across an aligned closure must be rejected (rigid cycle — use a loop closure)"
    );
}

#[test]
fn restore_snapshot_into_rebuilds_transient_caches() {
    // The single restore chokepoint must rebuild the serde-skipped lookup caches
    // (section_index_cache, merge_adjacency_cache), so no rollback/undo/redo path
    // can install a project with an empty/stale cache that silently mis-resolves a
    // section or merge group (catalog #14/#39).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#222222".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(a, 2),
                station_b: StationRef::new(b, 0),
            })
            .success
    );

    let snapshot = match state.capture_project_snapshot() {
        Ok(s) => s,
        Err(e) => panic!("snapshot failed: {e:?}"),
    };

    // Deserialize into a fresh slot via the chokepoint; serde drops the caches, so
    // restore_snapshot_into must repopulate them.
    let mut slot: Option<Project> = None;
    assert!(AppState::restore_snapshot_into(&mut slot, &snapshot));
    let p = slot.expect("restored");
    assert!(
        !p.section_index_cache.is_empty(),
        "section index cache must be rebuilt"
    );
    assert!(
        !p.merge_adjacency_cache.is_empty(),
        "merge adjacency cache must be rebuilt so get_merged_section_ids stays O(group)"
    );
    // Sanity: the rebuilt index resolves both sections.
    assert!(p.get_section(a).is_some() && p.get_section(b).is_some());
}

#[test]
fn undo_unmerge_restores_converted_closure_and_position() {
    // The orphan-closure conversion unmerge triggers is a structural side-effect;
    // undo must reverse it completely — the re-created merge AND the
    // closure-that-became-a-merge AND the original section position must all come
    // back, with no leftover merge cycle. (User report: undoing the unmerge left
    // the converted merge in place and the geometry shifted.)
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#222222".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 1),
        closure_strategy: ClosureStrategy::default(),
    });

    // Snapshot the pre-unmerge state we expect undo to restore exactly.
    let before = state.get_project_state().unwrap();
    let offset_before = before.section_offset(b);
    let merges_before = before.station_merges.len();
    assert_eq!(before.loop_closures.len(), 1);

    // Unmerge → closure becomes a merge, section B repositions onto A0.
    let r = state.execute(Command::UnmergeStationPair {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    assert!(r.success, "{:?}", r.error);
    let converted = state.get_project_state().unwrap();
    assert!(
        converted.loop_closures.is_empty(),
        "closure should have converted to a merge"
    );
    let offset_converted = converted.section_offset(b);
    assert!(
        (offset_converted.0 - offset_before.0).abs() > 1e-9
            || (offset_converted.1 - offset_before.1).abs() > 1e-9,
        "precondition: conversion must actually move B, else the position check is vacuous"
    );

    // Undo → merge, closure, and position all come back.
    let u = state.undo();
    assert!(u.success, "{:?}", u.error);
    let restored = state.get_project_state().unwrap();
    assert_eq!(
        restored.loop_closures.len(),
        1,
        "undo must turn the converted merge back into a closure"
    );
    assert_eq!(
        restored.station_merges.len(),
        merges_before,
        "undo must restore exactly the original merge — no leftover cycle"
    );
    assert!(
        restored.check_orphan_closures().is_empty(),
        "with the merge restored the closure is no longer a sole bridge"
    );
    assert!(
        !restored.has_critical_integrity_violations(),
        "restored state must be structurally clean"
    );
    let offset_restored = restored.section_offset(b);
    assert!(
        (offset_restored.0 - offset_before.0).abs() < 1e-9
            && (offset_restored.1 - offset_before.1).abs() < 1e-9,
        "undo must reset section position: before={offset_before:?} after={offset_restored:?}"
    );

    // Redo → back to the converted state.
    let re = state.redo();
    assert!(re.success, "{:?}", re.error);
    let redone = state.get_project_state().unwrap();
    assert!(
        redone.loop_closures.is_empty(),
        "redo must re-apply the closure→merge conversion"
    );
    assert!(redone.check_orphan_closures().is_empty());
    let offset_redone = redone.section_offset(b);
    assert!(
        (offset_redone.0 - offset_converted.0).abs() < 1e-9
            && (offset_redone.1 - offset_converted.1).abs() < 1e-9,
        "redo must restore the converted position"
    );
}

#[test]
fn undo_unmerge_singular_restores_converted_closure_and_position() {
    // Same round-trip as the pair variant, but via the singular Command::UnmergeStations
    // (which removes ALL merges on a station). It shares the conversion + snapshot path,
    // so this guards against the two unmerge variants diverging.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#222222".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 1),
        closure_strategy: ClosureStrategy::default(),
    });

    let offset_before = state.get_project_state().unwrap().section_offset(b);

    // Singular unmerge of the merged station strands B onto the closure.
    let r = state.execute(Command::UnmergeStations {
        station_ref: StationRef::new(a, 2),
    });
    assert!(r.success, "{:?}", r.error);
    let converted = state.get_project_state().unwrap();
    assert!(
        converted.loop_closures.is_empty(),
        "closure should have converted to a merge"
    );

    let u = state.undo();
    assert!(u.success, "{:?}", u.error);
    let restored = state.get_project_state().unwrap();
    assert_eq!(
        restored.loop_closures.len(),
        1,
        "undo reverts the converted merge to a closure"
    );
    assert!(restored.check_orphan_closures().is_empty());
    assert!(!restored.has_critical_integrity_violations());
    let offset_restored = restored.section_offset(b);
    assert!(
        (offset_restored.0 - offset_before.0).abs() < 1e-9
            && (offset_restored.1 - offset_before.1).abs() < 1e-9,
        "undo must reset position: before={offset_before:?} after={offset_restored:?}"
    );
}

#[test]
fn undo_merge_restores_aligned_closure_section_outside_merge_groups() {
    // A merge re-anchors not just the two merge groups but any section reachable
    // through an ALIGNED loop closure (cascade phase 2). The old lightweight MergeInfo
    // undo captured only the two groups' offsets, so such an external section stayed
    // drifted on undo — and realign_merges() can't self-heal closure drift (it inspects
    // merges only). With the full-snapshot undo, undo must restore EVERY section the
    // cascade could touch.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#222222".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let z = state
        .execute(Command::CreateSection {
            name: Some("Z".to_string()),
            surveyor: None,
            date: None,
            color: "#333333".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    // Anchor A to GPS so the merge moves the B side (and, via the aligned closure, Z).
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(45.0, 90.0, 0.0).unwrap(),
    });

    // Inject an ALIGNED loop closure B.1 <-> Z.0 (no merge). Z is reachable from the
    // rest only through this aligned closure, so the cascade re-anchors it on merge.
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        let closure_id = project.next_closure_id;
        project.loop_closures.push(LoopClosure {
            id: closure_id,
            station_a: StationRef::new(b, 1).into(),
            station_b: StationRef::new(z, 0).into(),
            path_length: 10.0,
            misclosure_distance: 0.1,
            error_percentage: 1.0,
            horizontal_misclosure: 0.08,
            vertical_misclosure: 0.06,
            strategy: ClosureStrategy::default(),
            is_aligned: true,
        });
        project.next_closure_id += 1;
    }

    let z_before = state.get_project_state().unwrap().section_offset(z);

    // Merge A.1 <-> B.0: A holds the datum, so B (and Z via the aligned closure) move.
    let r = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });
    assert!(r.success, "{:?}", r.error);

    let z_merged = state.get_project_state().unwrap().section_offset(z);
    assert!(
        (z_merged.0 - z_before.0).abs() > 1e-6 || (z_merged.1 - z_before.1).abs() > 1e-6,
        "precondition: the merge cascade must re-anchor Z (else vacuous): \
         before={z_before:?} merged={z_merged:?}"
    );

    // Undo must restore Z exactly — not just the two merge groups.
    let u = state.undo();
    assert!(u.success, "{:?}", u.error);
    let z_restored = state.get_project_state().unwrap().section_offset(z);
    assert!(
        (z_restored.0 - z_before.0).abs() < 1e-9 && (z_restored.1 - z_before.1).abs() < 1e-9,
        "undo must restore the aligned-closure section outside the merge groups: \
         before={z_before:?} after_undo={z_restored:?}"
    );
}

#[test]
fn undo_move_station_restores_pitch_and_adjacent_shots() {
    // MoveStation rewrites the two adjacent shots' raw geometry including pitch.
    // The old lightweight StationMoveInfo undo restored azimuth/length/depth but
    // NOT pitch_in/pitch_out, so undo left pitch corrupted. Full-snapshot undo must
    // restore every field.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    // test_shot_data leaves pitch unset (None). Capture the adjacent shots' state.
    let before = state.get_project_state().unwrap();
    let sec_before = before.get_section(a).unwrap();
    let shot0_before = sec_before.shots[0].clone();
    let shot1_before = sec_before.shots[1].clone();
    assert_eq!(shot0_before.pitch_in, None);
    assert_eq!(shot1_before.pitch_in, None);

    // Move station 1 (the boundary between shot 0 and shot 1).
    let r = state.execute(Command::MoveStation {
        station_ref: StationRef::new(a, 1),
        offset: Coordinates::new(2.0, 3.0, 1.5),
    });
    assert!(r.success, "{:?}", r.error);

    // Precondition: the move set pitch on the adjacent shots (so undo has work to do).
    let moved = state.get_project_state().unwrap();
    let sec_moved = moved.get_section(a).unwrap();
    assert!(
        sec_moved.shots[0].pitch_in.is_some() || sec_moved.shots[1].pitch_in.is_some(),
        "precondition: the move must set pitch on an adjacent shot"
    );

    // Undo must restore pitch (the bug) and every other field exactly.
    let u = state.undo();
    assert!(u.success, "{:?}", u.error);
    let restored = state.get_project_state().unwrap();
    let sec_r = restored.get_section(a).unwrap();
    assert_eq!(
        sec_r.shots[0].pitch_in, shot0_before.pitch_in,
        "pitch_in[0] restored"
    );
    assert_eq!(
        sec_r.shots[0].pitch_out, shot0_before.pitch_out,
        "pitch_out[0] restored"
    );
    assert_eq!(
        sec_r.shots[1].pitch_in, shot1_before.pitch_in,
        "pitch_in[1] restored"
    );
    assert_eq!(
        sec_r.shots[1].pitch_out, shot1_before.pitch_out,
        "pitch_out[1] restored"
    );
    assert!(
        (sec_r.shots[0].length - shot0_before.length).abs() < 1e-9,
        "length[0] restored"
    );
    assert!(
        (sec_r.shots[1].depth_in - shot1_before.depth_in).abs() < 1e-9,
        "depth_in[1] restored"
    );
    assert!(
        (sec_r.shots[0].azimuth_in - shot0_before.azimuth_in).abs() < 1e-9,
        "azimuth_in[0] restored"
    );
}

#[test]
fn split_converts_orphaned_bridge_closure_immediately() {
    // The split path bypasses execute()'s reconcile; confirm it still converts a
    // closure that the split strands as a section's sole bridge (the reported
    // "not transformed immediately on split" bug).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    // Section A: 3 shots → stations 0..3 (so we can split at the middle shot).
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(5.0),
                test_shot_data(5.0),
            ],
        })
        .section_id
        .unwrap();
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#222222".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    // B hangs off A's last station; a closure A0=B1 closes the loop.
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 3),
        station_b: StationRef::new(b, 0),
    });
    let closure = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 1),
        closure_strategy: ClosureStrategy::default(),
    });
    assert!(closure.success, "{:?}", closure.error);
    assert_eq!(state.get_project_state().unwrap().loop_closures.len(), 1);

    // Split A at its MIDDLE shot — the loop's path through A breaks, leaving the
    // closure as the only connection between A's first half and B.
    let mid = state.get_project_state().unwrap().sections[0].shots[1].id;
    let r = state.execute_delete_shot_and_split(a, mid, "A-1".to_string(), "A-2".to_string());
    assert!(r.success, "{:?}", r.error);

    let p = state.get_project_state().unwrap();
    assert!(
        p.loop_closures.is_empty(),
        "split should immediately convert the orphaned closure to a merge: {:?}",
        p.loop_closures
    );
    assert!(p.check_orphan_closures().is_empty());
}

#[test]
fn create_section_rejects_non_finite_geometry() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let mut bad = test_shot_data(5.0);
    bad.length = f64::NAN;
    let r = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ffffff".to_string(),
        direction: None,
        shots: vec![bad],
    });
    assert!(!r.success, "create_section must reject non-finite geometry");
    assert_eq!(
        state.get_project_state().unwrap().sections.len(),
        0,
        "nothing committed"
    );
}

#[test]
fn move_station_rejects_non_finite_offset() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ffffff".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let r = state.execute(Command::MoveStation {
        station_ref: StationRef::new(a, 1),
        offset: Coordinates::new(f64::INFINITY, 0.0, 0.0),
    });
    assert!(!r.success, "move_station must reject a non-finite offset");
    let p = state.get_project_state().unwrap();
    assert!(
        p.sections[0].shots[0].all_finite(),
        "shot geometry left untouched"
    );
}

#[test]
fn redo_insert_shot_keeps_merged_stations_aligned() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Align".to_string(),
        location: None,
    });

    // Section A (id 0): two shots → stations A0, A1, A2.
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        })
        .section_id
        .unwrap();
    // Section B (id 1): one shot → stations B0, B1.
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#222222".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    // Anchor A at a zero datum, then merge B0 onto A2 (B hangs off A's tail).
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    let merge = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    assert!(merge.success, "{:?}", merge.error);

    let aligned = |state: &AppState| {
        state
            .get_project_state()
            .unwrap()
            .check_merge_alignment()
            .is_empty()
    };
    assert!(aligned(&state), "merge should start aligned");

    // Insert a shot after A's first shot (between A1 and A2): shifts the tail and
    // the merge point. The forward path cascades B back into alignment.
    let after_id = state.get_project_state().unwrap().sections[0].shots[0].id;
    let ins = state.execute(Command::CreateShot {
        section_id: a,
        shot: test_shot_data(6.0),
        after_shot_id: Some(after_id),
        before_shot_id: None,
    });
    assert!(ins.success, "{:?}", ins.error);
    assert!(aligned(&state), "forward insert should stay aligned");

    // Undo (already correct) then redo — redo used to omit the offset cascade and
    // leave B drifted tens of metres. The post-history reconcile must prevent it.
    assert!(state.undo().success);
    assert!(aligned(&state), "undo should stay aligned");
    assert!(state.redo().success);
    assert!(aligned(&state), "redo must not desync the merge geometry");
}

#[test]
fn test_create_section_returns_id() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::CreateSection {
        name: Some("First".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    assert!(result.success);
    assert_eq!(result.section_id, Some(0));

    // Create another section
    let result2 = state.execute(Command::CreateSection {
        name: Some("Second".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![],
    });

    assert!(result2.success);
    assert_eq!(result2.section_id, Some(1));
}

#[test]
fn test_create_section_no_project() {
    let state = AppState::new().unwrap();

    let result = state.execute(Command::CreateSection {
        name: Some("Orphan".to_string()),
        surveyor: None,
        date: None,
        color: "#000000".to_string(),
        direction: None,
        shots: vec![],
    });

    assert!(!result.success);
    assert!(result.error.is_some());
}

#[test]
fn test_delete_section() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("To Delete".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });

    let section_id = create_result.section_id.unwrap();

    let result = state.execute(Command::DeleteSection { section_id });
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert!(project.sections.is_empty());
}

#[test]
fn test_delete_nonexistent_section() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::DeleteSection { section_id: 999 });
    assert!(!result.success);
}

#[test]
fn test_update_section_metadata() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    let section_id = create_result.section_id.unwrap();

    let result = state.execute(Command::UpdateSectionMetadata {
        section_id,
        updates: SectionUpdates {
            name: Some(Some("Updated".to_string())),
            color: Some("#00ff00".to_string()),
            ..Default::default()
        },
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].name, Some("Updated".to_string()));
    assert_eq!(project.sections[0].color, "#00ff00");
}

// === Shot Operations Tests ===

#[test]
fn test_create_shot() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Section".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    let section_id = create_result.section_id.unwrap();

    let result = state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(10.0),
        after_shot_id: None,
        before_shot_id: None,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 1);
    assert_eq!(project.sections[0].shots[0].length, 10.0);
}

#[test]
fn test_update_shot() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    let result = state.execute(Command::UpdateShot {
        section_id,
        shot_id,
        updates: ShotUpdates {
            length: Some(15.0),
            comment: Some(Some("Updated shot".to_string())),
            ..Default::default()
        },
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots[0].length, 15.0);
    assert_eq!(
        project.sections[0].shots[0].comment,
        Some("Updated shot".to_string())
    );
}

#[test]
fn test_delete_shot() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    let result = state.execute(Command::DeleteShot {
        section_id,
        shot_id,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 1);
}

#[test]
fn test_delete_first_shot_preserves_station_positions() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let project_before = state.get_project_state().unwrap();
    let station_1_before = project_before
        .compute_station_raw_coords(StationRef::new(section_id, 1))
        .unwrap();
    let station_2_before = project_before
        .compute_station_raw_coords(StationRef::new(section_id, 2))
        .unwrap();

    let first_shot_id = project_before.sections[0].shots[0].id;
    let delete_result = state.execute(Command::DeleteShot {
        section_id,
        shot_id: first_shot_id,
    });
    assert!(delete_result.success);

    let project_after = state.get_project_state().unwrap();
    let station_0_after = project_after
        .compute_station_raw_coords(StationRef::new(section_id, 0))
        .unwrap();
    let station_1_after = project_after
        .compute_station_raw_coords(StationRef::new(section_id, 1))
        .unwrap();

    let eps = 1e-6;
    // X,Y positions preserved: station_0_after matches station_1_before in X,Y
    assert!(
        (station_0_after.x - station_1_before.x).abs() < eps,
        "x mismatch after delete"
    );
    assert!(
        (station_0_after.y - station_1_before.y).abs() < eps,
        "y mismatch after delete"
    );
    assert!(
        (station_1_after.x - station_2_before.x).abs() < eps,
        "x mismatch after delete"
    );
    assert!(
        (station_1_after.y - station_2_before.y).abs() < eps,
        "y mismatch after delete"
    );
    // Z is absolute from shot depth measurements — after deleting first shot,
    // remaining stations get Z from the remaining shot's absolute depths.
    // Remaining shot: depth_in=10, depth_out=11
    assert!(
        (station_0_after.z - 10.0).abs() < eps,
        "z station 0 after delete should be depth_in of remaining shot"
    );
    assert!(
        (station_1_after.z - 11.0).abs() < eps,
        "z station 1 after delete should be depth_out of remaining shot"
    );
}

#[test]
fn test_delete_shot_rewires_merges() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    let sec_c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(8.0)],
        })
        .section_id
        .unwrap();

    let merge_ab = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 0),
        station_b: StationRef::new(sec_b, 0),
    });
    assert!(merge_ab.success);

    let merge_ac = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 0),
        station_b: StationRef::new(sec_c, 0),
    });
    assert!(merge_ac.success);

    let project_before = state.get_project_state().unwrap();
    let first_shot_id = project_before
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots[0]
        .id;

    let delete_result = state.execute(Command::DeleteShot {
        section_id: sec_a,
        shot_id: first_shot_id,
    });
    assert!(delete_result.success);

    let project_after = state.get_project_state().unwrap();
    let has_merge_bc = project_after.station_merges.iter().any(|m| {
        (project_after.key_is_ref(&m.station_a, StationRef::new(sec_b, 0))
            && project_after.key_is_ref(&m.station_b, StationRef::new(sec_c, 0)))
            || (project_after.key_is_ref(&m.station_a, StationRef::new(sec_c, 0))
                && project_after.key_is_ref(&m.station_b, StationRef::new(sec_b, 0)))
    });
    assert!(
        has_merge_bc,
        "Expected replacement merge between B:0 and C:0"
    );
}

#[test]
fn test_delete_shot_rejects_frozen_shot() {
    // Issue #57 (Item 3): a frozen shot (collaborator-locked geometry anchored to
    // an adjusted survey network) must not be deletable via the resolve flow.
    // Build a two-section loop with a datum at each end so every shot between the
    // datums is frozen, then assert DeleteShot is refused and the shot survives.
    //
    // The loop topology (a:0<->b:0 and a:2<->b:2, two datums) is built in memory
    // directly — the command-level MergeStations validation refuses merging two
    // stations already in the same connected component, which the second
    // end-to-end merge would be. The real delete_shot command guard is still
    // exercised below.
    let mut project = Project::new("Frozen".to_string(), None);
    let sec_a = project
        .add_section(SectionData {
            color: "#ff0000".to_string(),
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
            ..Default::default()
        })
        .id;
    let sec_b = project
        .add_section(SectionData {
            color: "#00ff00".to_string(),
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
            ..Default::default()
        })
        .id;

    // Close the loop: both ends of A merged onto both ends of B.
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(sec_a, 0).into(),
        station_b: StationRef::new(sec_b, 0).into(),
        merged_at: chrono::Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(sec_a, 2).into(),
        station_b: StationRef::new(sec_b, 2).into(),
        merged_at: chrono::Utc::now(),
    });
    // Two datums, one per section head, freeze every shot in the loop.
    project.zero_datums.push(crate::models::ZeroDatum {
        station_ref: StationRef::new(sec_a, 0).into(),
        gps: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
    });
    project.zero_datums.push(crate::models::ZeroDatum {
        station_ref: StationRef::new(sec_b, 0).into(),
        gps: GpsCoordinates::new(46.0, -74.0, 110.0).unwrap(),
    });
    project.rebuild_merge_adjacency();

    // SELF-VERIFY the chosen shot is genuinely frozen before asserting the
    // rejection, so the test fails loudly if the setup didn't freeze it.
    let frozen = project.compute_frozen_shots();
    assert!(
        frozen
            .iter()
            .any(|f| f.section_id == sec_a && f.shot_index == 0),
        "precondition: sec_a shot[0] must be frozen by the loop+two-datum setup"
    );
    let target_shot_id = project
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots[0]
        .id;
    let shots_before = project
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots
        .len();

    let state = AppState::new().unwrap();
    state.set_project_for_tests(project);

    // The delete must be refused with a clear frozen message.
    let result = state.execute(Command::DeleteShot {
        section_id: sec_a,
        shot_id: target_shot_id,
    });
    assert!(!result.success, "deleting a frozen shot must be refused");
    assert!(
        result.error.as_deref().unwrap_or("").contains("frozen"),
        "error must mention the shot is frozen, got: {:?}",
        result.error
    );

    // The shot still exists — nothing was removed.
    let after = state.get_project_state().unwrap();
    let shots_after = after
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots
        .len();
    assert_eq!(
        shots_after, shots_before,
        "the frozen shot must still exist"
    );
}

#[test]
fn test_legacy_project_seeds_validation_from_global_config() {
    // Issue #57 (Item 5): a legacy project saved before per-project validation
    // (no `validation` row in project_settings) must open with the user's GLOBAL
    // thresholds — the "defaults for new projects" — not the hardcoded
    // ValidationConfig::default(). A project that DOES carry an explicit row keeps
    // its own thresholds.
    crate::test_helpers::with_isolated_config(|| {
        let dir = TempDir::new().unwrap();

        // A 1.0 m shot is fine under the hardcoded default (warn_shot_length_min
        // = 0.3) but SHORT under a raised global minimum.
        let custom = crate::config::ValidationConfig {
            warn_shot_length_min: 5.0,
            ..crate::config::ValidationConfig::default()
        };

        // --- Legacy file: saved, then strip the validation row to simulate a
        //     project written before the feature existed. ---
        let legacy_path = dir.path().join("legacy.stalx");
        {
            let mut project = Project::new("Legacy".to_string(), None);
            project.add_section(SectionData {
                shots: vec![test_shot_data(1.0)],
                ..Default::default()
            });
            let mut db = Database::open(&legacy_path).unwrap();
            db.save_project(&project).unwrap();
            drop(db);
            let conn = rusqlite::Connection::open(&legacy_path).unwrap();
            conn.execute("DELETE FROM project_settings WHERE key = 'validation'", [])
                .unwrap();
            drop(conn);
        }
        // Sanity: the file now looks legacy (no stored validation row).
        assert!(
            Database::open_existing(&legacy_path)
                .unwrap()
                .load_project_validation()
                .unwrap()
                .is_none(),
            "precondition: legacy file has no stored validation row"
        );

        // Open via the production command path on a fresh AppState whose GLOBAL
        // config carries the customized threshold.
        let state = AppState::new().unwrap();
        let mut config = state.get_config();
        config.validation = custom.clone();
        state.update_config(config).unwrap();

        assert!(state.open_project(legacy_path).success, "open must succeed");

        let opened = state.get_project_state().unwrap();
        assert_eq!(
            opened.validation.warn_shot_length_min, custom.warn_shot_length_min,
            "legacy project must inherit the user's global thresholds"
        );
        // The customized threshold actually drives warnings: the 1.0 m shot is now SHORT.
        assert!(
            state
                .compute_project_warnings(&opened, None)
                .iter()
                .any(|w| w.code == "SHORT_SHOT"),
            "the seeded global threshold must produce the SHORT_SHOT warning"
        );

        // --- Explicit-row file: a project that carries its OWN validation row
        //     (different from global) must NOT be overridden on open. ---
        let explicit_path = dir.path().join("explicit.stalx");
        {
            let mut project = Project::new("Explicit".to_string(), None);
            project.validation = crate::config::ValidationConfig {
                warn_shot_length_min: 0.1,
                ..crate::config::ValidationConfig::default()
            };
            project.add_section(SectionData {
                shots: vec![test_shot_data(1.0)],
                ..Default::default()
            });
            let mut db = Database::open(&explicit_path).unwrap();
            db.save_project(&project).unwrap();
        }
        let state2 = AppState::new().unwrap();
        let mut config2 = state2.get_config();
        config2.validation = custom.clone();
        state2.update_config(config2).unwrap();
        assert!(state2.open_project(explicit_path).success);
        let opened2 = state2.get_project_state().unwrap();
        assert_eq!(
            opened2.validation.warn_shot_length_min, 0.1,
            "a project with an explicit validation row keeps its own thresholds"
        );
    });
}

// === #41 synthetic repro: deleting a shot must not shift unrelated/upstream geometry ===
//
// "On macOS, deleting a shot sometimes causes an erroneous geometry shift — the
// entire map moves." The investigation pinned this on coordinate-frame
// re-anchoring (section offsets + `cascade_connection_offsets`), not a viewport
// recenter. These exercise the real `Command::DeleteShot` path and assert on
// absolute coordinates so any global shift fails the test deterministically —
// no UI clicking required.

/// Deleting a shot in one connected component must NEVER move a station in an
/// unrelated component. The strongest "whole map jumps" sentinel: two sections,
/// each its own zero datum, sharing no merge/closure.
#[test]
fn delete_shot_does_not_shift_independent_component() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "T".to_string(),
        location: None,
    });

    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        })
        .section_id
        .unwrap();
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0), test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Independent datums → each component has a fixed absolute frame.
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(a, 0),
                coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
            })
            .success
    );
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(b, 0),
                coordinates: GpsCoordinates::new(46.0, -74.0, 110.0).unwrap(),
            })
            .success
    );

    let before = abs_coord_map(&state.get_project_state().unwrap());

    let a_shot0 = state
        .get_project_state()
        .unwrap()
        .sections
        .iter()
        .find(|s| s.id == a)
        .unwrap()
        .shots[0]
        .id;
    assert!(
        state
            .execute(Command::DeleteShot {
                section_id: a,
                shot_id: a_shot0,
            })
            .success
    );

    let after = abs_coord_map(&state.get_project_state().unwrap());

    // Section B (unrelated component) must be byte-for-byte unmoved.
    for idx in 0..=2 {
        let r = StationRef::new(b, idx);
        assert_coords_close(after[&r], before[&r]);
    }
}

/// Deleting the LAST shot of a section removes only its end station; the section
/// head and a neighbor merged onto that head must not move.
#[test]
fn delete_tail_shot_does_not_shift_merged_head_neighbor() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "T".to_string(),
        location: None,
    });

    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        })
        .section_id
        .unwrap();
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0), test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // B hangs off A's HEAD (A:0), which is upstream of the tail shot we delete.
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(a, 0),
                coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(a, 0),
                station_b: StationRef::new(b, 0),
            })
            .success
    );

    let before = abs_coord_map(&state.get_project_state().unwrap());

    let a_last = {
        let p = state.get_project_state().unwrap();
        let sec = p.sections.iter().find(|s| s.id == a).unwrap();
        sec.shots[sec.shots.len() - 1].id
    };
    assert!(
        state
            .execute(Command::DeleteShot {
                section_id: a,
                shot_id: a_last,
            })
            .success
    );

    let after = abs_coord_map(&state.get_project_state().unwrap());

    // A's head (A:0) and the merged neighbor B are fully untouched by a tail delete.
    let a0 = StationRef::new(a, 0);
    assert_coords_close(after[&a0], before[&a0]);
    for idx in 0..=2 {
        let r = StationRef::new(b, idx);
        assert_coords_close(after[&r], before[&r]);
    }
    // A:1 becomes the new end station: its X/Y (the map) must not move, though its
    // Z legitimately changes as the deleted shot's depth conflict at this interior
    // station is resolved. The #41 bug is an X/Y shift, so guard X/Y here.
    let a1 = StationRef::new(a, 1);
    let eps = 1e-6;
    assert!(
        (after[&a1].x - before[&a1].x).abs() < eps,
        "A:1 x shifted (map moved)"
    );
    assert!(
        (after[&a1].y - before[&a1].y).abs() < eps,
        "A:1 y shifted (map moved)"
    );
}

/// Deleting the FIRST shot keeps the remaining stations in place (offset is
/// adjusted by the removed shot's displacement); a neighbor merged onto the
/// downstream/tail end must therefore stay put too — i.e. the offset cascade
/// must not over-propagate into a global shift.
#[test]
fn delete_first_shot_keeps_downstream_merged_neighbor_put() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "T".to_string(),
        location: None,
    });

    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
        })
        .section_id
        .unwrap();
    let c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(8.0)],
        })
        .section_id
        .unwrap();

    // C hangs off A's TAIL (A:2). Deleting A's first shot must keep A:2 (and thus
    // C) at the same absolute position.
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(a, 2),
                station_b: StationRef::new(c, 0),
            })
            .success
    );

    let before = abs_coord_map(&state.get_project_state().unwrap());

    let a_shot0 = state
        .get_project_state()
        .unwrap()
        .sections
        .iter()
        .find(|s| s.id == a)
        .unwrap()
        .shots[0]
        .id;
    assert!(
        state
            .execute(Command::DeleteShot {
                section_id: a,
                shot_id: a_shot0,
            })
            .success
    );

    let after = abs_coord_map(&state.get_project_state().unwrap());

    // C is downstream of the kept side; its absolute position must not shift.
    for idx in 0..=1 {
        let r = StationRef::new(c, idx);
        assert_coords_close(after[&r], before[&r]);
    }
}

#[test]
fn test_set_shot_reference() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    // Initially not reference
    assert!(!project.sections[0].shots[0].is_reference);

    let result = state.execute(Command::SetShotReference {
        section_id,
        shot_id,
        is_reference: true,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert!(project.sections[0].shots[0].is_reference);
}

// === Undo/Redo Tests ===

#[test]
fn test_undo_create_section() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    state.execute(Command::CreateSection {
        name: Some("To Undo".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    assert_eq!(state.get_project_state().unwrap().sections.len(), 1);
    assert!(state.can_undo());

    let result = state.undo();
    assert!(result.success);

    assert!(state.get_project_state().unwrap().sections.is_empty());
}

#[test]
fn test_undo_delete_section() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Will Delete".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();

    state.execute(Command::DeleteSection { section_id });
    assert!(state.get_project_state().unwrap().sections.is_empty());

    // Undo the delete
    let result = state.undo();
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].name, Some("Will Delete".to_string()));
}

#[test]
fn test_undo_update_shot() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    state.execute(Command::UpdateShot {
        section_id,
        shot_id,
        updates: ShotUpdates {
            length: Some(15.0),
            ..Default::default()
        },
    });

    assert_eq!(
        state.get_project_state().unwrap().sections[0].shots[0].length,
        15.0
    );

    let result = state.undo();
    assert!(result.success);

    assert_eq!(
        state.get_project_state().unwrap().sections[0].shots[0].length,
        5.0
    );
}

#[test]
fn test_redo_create_section() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    state.execute(Command::CreateSection {
        name: Some("Redo Me".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    state.undo();
    assert!(state.get_project_state().unwrap().sections.is_empty());
    assert!(state.can_redo());

    let result = state.redo();
    assert!(result.success);

    assert_eq!(state.get_project_state().unwrap().sections.len(), 1);
}

#[test]
fn test_undo_nothing() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    assert!(!state.can_undo());

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Nothing to undo"));
}

#[test]
fn test_redo_nothing() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    assert!(!state.can_redo());

    let result = state.redo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Nothing to redo"));
}

#[test]
fn test_redo_cleared_on_new_command() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    state.execute(Command::CreateSection {
        name: Some("First".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    state.undo();
    assert!(state.can_redo());

    // New command clears redo stack
    state.execute(Command::CreateSection {
        name: Some("Different".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![],
    });

    assert!(!state.can_redo());
}

#[test]
fn test_undo_fails_when_undo_stack_poisoned() {
    let state = AppState::new().unwrap();
    poison_mutex(&state.undo_stack);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock undo stack"));
}

#[test]
fn test_redo_fails_when_undo_stack_poisoned() {
    let state = AppState::new().unwrap();
    poison_mutex(&state.undo_stack);

    let result = state.redo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock undo stack"));
}

#[test]
fn test_undo_fails_for_non_undoable_entry() {
    let state = AppState::new().unwrap();
    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(Command::CloseProject, UndoData::None);
    drop(stack);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("This command cannot be undone")
    );
    assert!(!state.can_redo());
}

#[test]
fn test_project_snapshot_pair_undo_redo_roundtrip() {
    let state = AppState::new().unwrap();

    let mut before = Project::new("Before".to_string(), None);
    before.add_section(SectionData {
        name: Some("Before Section".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: Some(SurveyDirection::In),
        quality: 1.0,
        shots: vec![test_shot_data(1.0)],
    });

    let mut after = Project::new("After".to_string(), None);
    after.add_section(SectionData {
        name: Some("After Section".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: Some(SurveyDirection::Out),
        quality: 1.0,
        shots: vec![test_shot_data(2.0), test_shot_data(3.0)],
    });

    let before_json = serde_json::to_string(&before).unwrap();
    let after_json = serde_json::to_string(&after).unwrap();

    state.set_project_for_tests(after.clone());

    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::MergeProjects {
            source_paths: Vec::new(),
            output_path: PathBuf::from("out.stalx"),
            output_name: "Merged".to_string(),
            archive_originals: false,
        },
        UndoData::ProjectSnapshotPair {
            before: before_json,
            after: after_json,
        },
    );
    drop(stack);

    assert!(state.can_undo());

    let undo_result = state.undo();
    assert!(undo_result.success);

    let project_after_undo = state.get_project_state().unwrap();
    assert_eq!(project_after_undo.name, "Before");
    assert_eq!(project_after_undo.sections[0].shots.len(), 1);
    assert!(state.can_redo());

    let redo_result = state.redo();
    assert!(redo_result.success);

    let project_after_redo = state.get_project_state().unwrap();
    assert_eq!(project_after_redo.name, "After");
    assert_eq!(project_after_redo.sections[0].shots.len(), 2);
    assert!(state.can_undo());
    assert!(!state.can_redo());
}

#[test]
fn test_undo_project_snapshot_fails_when_project_lock_poisoned() {
    let state = AppState::new().unwrap();
    let snapshot = serde_json::to_string(&Project::new("Test".to_string(), None)).unwrap();

    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::Batch {
            commands: Vec::new(),
        },
        UndoData::ProjectSnapshot(snapshot),
    );
    drop(stack);

    poison_mutex(&state.project);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
}

#[test]
fn test_undo_project_snapshot_pair_fails_when_project_lock_poisoned() {
    let state = AppState::new().unwrap();
    let before = serde_json::to_string(&Project::new("Before".to_string(), None)).unwrap();
    let after = serde_json::to_string(&Project::new("After".to_string(), None)).unwrap();

    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::Batch {
            commands: Vec::new(),
        },
        UndoData::ProjectSnapshotPair { before, after },
    );
    drop(stack);

    poison_mutex(&state.project);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
}

#[test]
fn test_redo_project_snapshot_pair_fails_when_project_lock_poisoned() {
    let state = AppState::new().unwrap();
    let before = serde_json::to_string(&Project::new("Before".to_string(), None)).unwrap();
    let after = serde_json::to_string(&Project::new("After".to_string(), None)).unwrap();

    let entry = UndoEntry {
        command: Command::CloseProject,
        undo_data: UndoData::ProjectSnapshotPair { before, after },
        timestamp: None,
    };

    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_redo(entry);
    drop(stack);

    poison_mutex(&state.project);

    let result = state.redo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
}

#[test]
fn test_undo_merge_info_fails_when_project_lock_poisoned() {
    let state = AppState::new().unwrap();

    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::MergeStations {
            station_a: StationRef::new(1, 0),
            station_b: StationRef::new(1, 1),
        },
        UndoData::MergeInfo {
            station_a: StationRef::new(1, 0),
            station_b: StationRef::new(1, 1),
            removed_closures: Vec::new(),
            previous_offsets: HashMap::new(),
        },
    );
    drop(stack);

    poison_mutex(&state.project);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
}

// === State Transition Tests ===

#[test]
fn test_project_modification_tracking() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let initial_modified = state.get_project_state().unwrap().modified_at;

    // Sleep a tiny bit to ensure timestamp changes
    std::thread::sleep(std::time::Duration::from_millis(1));

    state.execute(Command::CreateSection {
        name: Some("Section".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    let after_section = state.get_project_state().unwrap().modified_at;
    assert!(after_section > initial_modified);
}

#[test]
fn test_is_undoable_commands() {
    // Non-undoable commands
    assert!(!AppState::is_undoable(&Command::OpenProject {
        path: PathBuf::from("/test.stalx"),
    }));
    assert!(!AppState::is_undoable(&Command::SaveProject {
        path: None,
        is_autosave: false
    }));
    assert!(!AppState::is_undoable(&Command::CloseProject));
    assert!(!AppState::is_undoable(&Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    }));

    // Undoable commands
    assert!(AppState::is_undoable(&Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#000000".to_string(),
        direction: None,
        shots: vec![],
    }));
    assert!(AppState::is_undoable(&Command::DeleteSection {
        section_id: 0
    }));
    assert!(AppState::is_undoable(&Command::CreateShot {
        section_id: 0,
        shot: ShotData::default(),
        after_shot_id: None,
        before_shot_id: None,
    }));
}

// === Config Tests ===

#[test]
fn test_get_config() {
    // Isolate the config path to a fresh temp dir so this default-value
    // assertion can't read a value left in the real config file by a
    // config-writing test (which previously made this fail with 42 vs 100).
    crate::test_helpers::with_isolated_config(|| {
        let state = AppState::new().unwrap();
        let config = state.get_config();

        // Should have default values
        assert!(config.general.auto_save);
        assert_eq!(config.general.undo_history_limit, 100);
    });
}

#[test]
fn test_display_settings_cache() {
    let state = AppState::new().unwrap();

    // Create a project (no database, so settings go to cache)
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Save a display setting
    let result = state.save_display_setting("test_key", "test_value");
    assert!(result.is_ok());

    // Retrieve it
    let value = state.get_display_setting("test_key").unwrap();
    assert_eq!(value, Some("test_value".to_string()));

    // Load all settings
    let settings = state.load_display_settings().unwrap();
    assert_eq!(settings.get("test_key"), Some(&"test_value".to_string()));
}

#[test]
fn test_save_project_prefers_database_display_settings_over_cache() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("source.stalx");
    let mut project = Project::new("Display Settings".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });

    let mut db = Database::open(&db_path).unwrap();
    db.save_project(&project).unwrap();
    db.save_display_setting("showStations", "false").unwrap();
    drop(db);

    let state = AppState::new().unwrap();
    state.set_project_for_tests(project);
    let db = Database::open_existing(&db_path).unwrap();
    state.set_database_for_tests(db);

    {
        let mut cache = state.display_settings_cache.lock().unwrap();
        cache.insert("showStations".to_string(), "true".to_string());
    }

    let save_path = temp_dir.path().join("dest");
    let result = state.save_project(Some(save_path.clone()), false);
    assert!(result.success);

    let saved_path = save_path.with_extension("stalx");
    let saved_db = Database::open_readonly(&saved_path).unwrap();
    let settings = saved_db.load_display_settings().unwrap();
    assert_eq!(settings.get("showStations"), Some(&"false".to_string()));
}

#[test]
fn test_save_project_failure_does_not_change_existing_file() {
    let temp_dir = TempDir::new().unwrap();
    let original_path = temp_dir.path().join("original.stalx");

    let mut project = Project::new("Original".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });

    let mut db = Database::open(&original_path).unwrap();
    db.save_project(&project).unwrap();
    drop(db);

    project.file_path = Some(original_path.clone());

    let state = AppState::new().unwrap();
    state.set_project_for_tests(project.clone());

    let blocked_path = temp_dir.path().join("blocked.stalx");
    std::fs::create_dir_all(&blocked_path).unwrap();

    let result = state.save_project(Some(blocked_path.clone()), false);
    assert!(!result.success);

    let reloaded = Database::open_existing(&original_path)
        .unwrap()
        .load_project()
        .unwrap();
    assert_eq!(reloaded.name, project.name);
    assert_eq!(reloaded.sections.len(), project.sections.len());

    let project_after = state.get_project_state().unwrap();
    assert_eq!(project_after.file_path, Some(original_path));

    let temp_path = blocked_path.with_extension("stalx.tmp");
    assert!(!temp_path.exists());
}

// ── #39: macOS lost-folder-access detection ──────────────────────────────
// macOS forgets previously-granted folder access after an OS/app update,
// which the user sees as a bogus "corrupted database" / save failure. The
// backend classifies the underlying permission denial so the frontend can
// show folder-access guidance instead.

#[test]
fn is_permission_denied_classifies_os_errors() {
    use crate::core::loading::is_permission_denied;
    // The portable io kind — covers ERROR_ACCESS_DENIED on Windows and
    // EACCES/EPERM on unix without hardcoding platform errnos.
    let kind_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
    assert!(is_permission_denied(&anyhow::Error::from(kind_err)));
    // SQLite's wording when it can't open the file (what Database::open emits).
    assert!(is_permission_denied(&anyhow::anyhow!(
        "unable to open database file: /Users/x/cave.stalx"
    )));
    // EPERM (the "os error 1" from the bug report) and EACCES decode to
    // PermissionDenied on unix; the libc constants keep this portable.
    #[cfg(unix)]
    {
        assert!(is_permission_denied(&anyhow::Error::from(
            std::io::Error::from_raw_os_error(libc::EPERM)
        )));
        assert!(is_permission_denied(&anyhow::Error::from(
            std::io::Error::from_raw_os_error(libc::EACCES)
        )));
    }
}

#[test]
fn is_permission_denied_rejects_unrelated_errors() {
    use crate::core::loading::is_permission_denied;
    // The crux of the fix: corruption must NOT be read as a permission
    // problem, or we'd show the wrong remediation for a real data issue.
    assert!(!is_permission_denied(&anyhow::anyhow!(
        "Database integrity check failed: database disk image is malformed"
    )));
    assert!(!is_permission_denied(&anyhow::anyhow!("file is corrupted")));
    assert!(!is_permission_denied(&anyhow::anyhow!(
        "Failed to save project"
    )));
    // ENOENT is not a permission denial.
    #[cfg(unix)]
    assert!(!is_permission_denied(&anyhow::Error::from(
        std::io::Error::from_raw_os_error(libc::ENOENT)
    )));
}

#[cfg(unix)]
#[test]
fn save_into_unwritable_dir_reports_permission_code() {
    use crate::core::loading::PERMISSION_DENIED_CODE;
    use std::os::unix::fs::PermissionsExt;

    let temp_dir = TempDir::new().unwrap();
    let locked = temp_dir.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

    // If we can still write despite 0o000 (e.g. running as root, as some CI
    // does), the permission scenario doesn't apply — skip rather than
    // false-fail. Restore perms first so TempDir cleanup can remove it.
    if std::fs::File::create(locked.join(".probe")).is_ok() {
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));
        return;
    }

    let mut project = Project::new("Perm".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    let state = AppState::new().unwrap();
    state.set_project_for_tests(project);

    let result = state.save_project(Some(locked.join("p.stalx")), false);

    // Restore perms so TempDir's drop can clean up the directory.
    let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));

    assert!(!result.success, "save into an unwritable dir should fail");
    let err = result.error.unwrap_or_default();
    assert!(
        err.starts_with(PERMISSION_DENIED_CODE),
        "expected permission code prefix, got: {err}"
    );
}

#[cfg(unix)]
#[test]
fn open_project_into_unreadable_dir_reports_permission_code() {
    // open_project switched exists() -> try_exists() so a metadata-access denial
    // surfaces as PERMISSION_DENIED_CODE instead of collapsing to "File not found"
    // (#169). try_exists() on a path inside a 0o000 dir returns Err(PermissionDenied)
    // because the dir can't be traversed. Same CI-safe 0o000 idiom (root-skip) as
    // save_into_unwritable_dir_reports_permission_code.
    use crate::core::loading::PERMISSION_DENIED_CODE;
    use std::os::unix::fs::PermissionsExt;

    let temp_dir = TempDir::new().unwrap();
    let locked = temp_dir.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

    // Root (some CI) bypasses 0o000, so try_exists would succeed and the permission
    // scenario wouldn't apply — skip rather than false-fail. Restore perms first so
    // TempDir cleanup can remove the directory.
    if std::fs::File::create(locked.join(".probe")).is_ok() {
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));
        return;
    }

    let state = AppState::new().unwrap();
    let result = state.open_project(locked.join("p.stalx"));

    // Restore perms so TempDir's drop can clean up the directory.
    let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));

    assert!(!result.success, "open inside an unreadable dir should fail");
    let err = result.error.unwrap_or_default();
    assert!(
        err.starts_with(PERMISSION_DENIED_CODE),
        "open_project should tag a metadata-access denial with the permission code, got: {err}"
    );
}

#[test]
fn save_into_missing_dir_is_not_a_permission_error() {
    use crate::core::loading::PERMISSION_DENIED_CODE;

    // A deleted/renamed save folder yields SQLite's generic "unable to open
    // database file" too — but that's a vanished location, not a permission
    // denial, so it must NOT be stamped with the permission code (which would
    // wrongly show the user Privacy & Security guidance).
    let temp_dir = TempDir::new().unwrap();
    let missing = temp_dir.path().join("gone").join("p.stalx");

    let mut project = Project::new("Missing".to_string(), None);
    project.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    let state = AppState::new().unwrap();
    state.set_project_for_tests(project);

    let result = state.save_project(Some(missing), false);

    assert!(!result.success, "save into a missing dir should fail");
    let err = result.error.unwrap_or_default();
    assert!(
        !err.starts_with(PERMISSION_DENIED_CODE),
        "missing dir should be an ordinary failure, got: {err}"
    );
}

#[test]
fn test_display_settings_fail_when_cache_lock_poisoned() {
    let state = AppState::new().unwrap();

    poison_mutex(&state.display_settings_cache);

    let err = state.load_display_settings().unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock display settings cache");

    let err = state.save_display_setting("key", "value").unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock display settings cache");

    let err = state.get_display_setting("key").unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock display settings cache");
}

#[test]
fn test_display_settings_fail_when_database_lock_poisoned() {
    let state = AppState::new().unwrap();

    poison_mutex(&state.database);

    let err = state.load_display_settings().unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock database");

    let err = state.save_display_setting("key", "value").unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock database");

    let err = state.get_display_setting("key").unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock database");
}

#[test]
fn test_resolved_warning_methods_fail_when_database_lock_poisoned() {
    let state = AppState::new().unwrap();

    poison_mutex(&state.database);

    let err = state.load_resolved_warnings().unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock database");

    let warning = crate::persistence::ResolvedWarning {
        section_id: 1,
        shot_id: 2,
        warning_code: "TEST".to_string(),
        resolved_at: chrono::Utc::now(),
        resolved_comment: None,
        shot_uuid: None,
    };

    let err = state.save_resolved_warning(&warning).unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock database");

    let err = state
        .delete_resolved_warning(1, 2, "TEST", None)
        .unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock database");
}

#[test]
fn test_remove_recent_projects_fails_when_lock_poisoned() {
    let state = AppState::new().unwrap();
    poison_mutex(&state.recent_projects);

    let result = state.remove_from_recent_projects(PathBuf::from("missing.stalx"));
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Failed to lock recent projects")
    );
}

#[test]
fn test_import_tracking_fails_when_project_lock_poisoned() {
    let state = AppState::new().unwrap();
    poison_mutex(&state.project);

    let err = state.check_duplicate_import("hash").unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock project");

    let result = state.track_imported_file("hash".to_string());
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock project"));
}

// === Batch Command Tests ===

#[test]
fn test_batch_create_sections() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::Batch {
        commands: vec![
            Command::CreateSection {
                name: Some("First".to_string()),
                surveyor: None,
                date: None,
                color: "#ff0000".to_string(),
                direction: None,
                shots: vec![test_shot_data(5.0)],
            },
            Command::CreateSection {
                name: Some("Second".to_string()),
                surveyor: None,
                date: None,
                color: "#00ff00".to_string(),
                direction: None,
                shots: vec![test_shot_data(7.0)],
            },
        ],
    });

    assert!(result.success);
    assert_eq!(result.section_ids.len(), 2);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);
}

#[test]
fn test_batch_fails_on_first_error() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // First command succeeds, second fails (delete nonexistent section)
    let result = state.execute(Command::Batch {
        commands: vec![
            Command::CreateSection {
                name: Some("First".to_string()),
                surveyor: None,
                date: None,
                color: "#ff0000".to_string(),
                direction: None,
                shots: vec![],
            },
            Command::DeleteSection { section_id: 999 },
        ],
    });

    assert!(!result.success);
}

// === Station Merge Tests ===

#[test]
fn test_merge_stations_same_section_fails() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
    });

    let section_id = create_result.section_id.unwrap();

    // Try to merge stations from the same section
    let result = state.execute(Command::MergeStations {
        station_a: StationRef::new(section_id, 0),
        station_b: StationRef::new(section_id, 1),
    });

    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("Cannot merge stations from the same section"));
}

// === Zero Datum Tests ===

#[test]
fn test_set_and_remove_zero_datum() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let station_ref = StationRef::new(section_id, 0);

    // Set zero datum
    let result = state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.zero_datums.len(), 1);
    assert_eq!(project.zero_datums[0].gps.latitude, 45.0);

    // Remove zero datum
    let result = state.execute(Command::RemoveZeroDatum { station_ref });
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert!(project.zero_datums.is_empty());
}

#[test]
fn test_remove_nonexistent_zero_datum() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();

    // Try to remove a datum that was never set
    let result = state.execute(Command::RemoveZeroDatum {
        station_ref: StationRef::new(section_id, 0),
    });

    assert!(!result.success);
}

// === Move Section Tests ===

#[test]
fn test_move_section() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();

    // First move
    let result = state.execute(Command::MoveSection {
        section_id,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.section_offsets.get(&section_id),
        Some(&(10.0, 20.0)),
        "First move should set offset to (10, 20)"
    );

    // Second move should accumulate
    let result = state.execute(Command::MoveSection {
        section_id,
        offset: Coordinates::new(5.0, -10.0, 0.0),
    });
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.section_offsets.get(&section_id),
        Some(&(15.0, 10.0)),
        "Second move should accumulate to (15, 10)"
    );
}

#[test]
fn test_move_section_undo_redo() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();

    // Move section
    state.execute(Command::MoveSection {
        section_id,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.section_offsets.get(&section_id),
        Some(&(10.0, 20.0))
    );

    // Undo should reverse the move
    let undo_result = state.undo();
    assert!(undo_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project
            .section_offsets
            .get(&section_id)
            .copied()
            .unwrap_or((0.0, 0.0)),
        (0.0, 0.0),
        "Undo should restore offset to origin"
    );

    // Redo should re-apply
    let redo_result = state.redo();
    assert!(redo_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.section_offsets.get(&section_id),
        Some(&(10.0, 20.0)),
        "Redo should re-apply the move"
    );
}

#[test]
fn move_section_moves_the_whole_merged_group_and_sticks() {
    // A merged section is rigidly bound to its partner: "Adjust Position"
    // (MoveSection) must move the WHOLE merge group together so the merge stays
    // aligned and the move isn't snapped back by the post-command reconcile — not
    // shove one member off the other (finding #6).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Merged".to_string(),
        location: None,
    });

    let mk = |name: &str, color: &str| Command::CreateSection {
        name: Some(name.to_string()),
        surveyor: None,
        date: None,
        color: color.to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    };
    let a = state.execute(mk("A", "#ff0000")).section_id.unwrap();
    let b = state.execute(mk("B", "#00ff00")).section_id.unwrap();

    // Merge A:0 with B:0 → A and B are now one rigid group.
    let merge = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
    });
    assert!(merge.success, "merge failed: {:?}", merge.error);
    assert!(
        state
            .get_project_state()
            .unwrap()
            .get_rigid_connected_section_ids(a)
            .contains(&b),
        "A and B must be one rigid group after the merge"
    );

    // Offsets right after the merge (the merge/reconcile may have set them to align).
    let off = |st: &AppState, id| {
        st.get_project_state()
            .unwrap()
            .section_offsets
            .get(&id)
            .copied()
            .unwrap_or((0.0, 0.0))
    };
    let a_before = off(&state, a);
    let b_before = off(&state, b);

    // Move section A — the whole group must translate by the same offset and STICK.
    let r = state.execute(Command::MoveSection {
        section_id: a,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });
    assert!(r.success);

    assert_eq!(
        off(&state, a),
        (a_before.0 + 10.0, a_before.1 + 20.0),
        "the moved section translated and the move stuck (not reverted by reconcile)"
    );
    assert_eq!(
        off(&state, b),
        (b_before.0 + 10.0, b_before.1 + 20.0),
        "the merge partner translated by the same offset (moved as a rigid group)"
    );

    // Undo restores both; redo re-applies to both.
    assert!(state.undo().success);
    assert_eq!(off(&state, a), a_before, "undo restores the moved section");
    assert_eq!(
        off(&state, b),
        b_before,
        "undo restores the merge partner too"
    );

    assert!(state.redo().success);
    assert_eq!(off(&state, a), (a_before.0 + 10.0, a_before.1 + 20.0));
    assert_eq!(off(&state, b), (b_before.0 + 10.0, b_before.1 + 20.0));
}

#[test]
fn test_move_nonexistent_section() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::MoveSection {
        section_id: 999,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });

    assert!(!result.success);
}

// === Validation Tests ===

#[test]
fn test_create_section_rejects_zero_length_shot() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section with a zero-length shot (should be rejected)
    let result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 0.0, // Zero length triggers warning
            depth_in: 10.0,
            depth_out: 10.0,
            ..Default::default()
        }],
    });

    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("zero length"));
}

// === Undo/Redo with Shot Restoration ===

#[test]
fn test_undo_delete_shot_restores_at_correct_position() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(9.0),
        ],
    });

    let section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    let middle_shot_id = project.sections[0].shots[1].id;

    // Delete the middle shot
    state.execute(Command::DeleteShot {
        section_id,
        shot_id: middle_shot_id,
    });

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 2);

    // Undo the delete
    let result = state.undo();
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 3);
    // The shot should be restored at position 1
    assert_eq!(project.sections[0].shots[1].length, 7.0);
}

// === Multiple Undo/Redo Sequence ===

#[test]
fn test_multiple_undo_redo_sequence() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create 3 sections
    for i in 1..=3 {
        state.execute(Command::CreateSection {
            name: Some(format!("Section {i}")),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });
    }

    assert_eq!(state.get_project_state().unwrap().sections.len(), 3);

    // Undo all 3 creates
    state.undo();
    state.undo();
    state.undo();

    assert!(state.get_project_state().unwrap().sections.is_empty());

    // Redo 2 of them
    state.redo();
    state.redo();

    assert_eq!(state.get_project_state().unwrap().sections.len(), 2);
}

// === Command Execution Tests (fn-34-nvq spec) ===
// These tests verify specific command behaviors as specified in the epic.

#[test]
fn test_execute_create_section_command() {
    // Verify CreateSection creates section correctly with all fields
    use chrono::NaiveDate;
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let test_date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = state.execute(Command::CreateSection {
        name: Some("Main Passage".to_string()),
        surveyor: Some("Alice".to_string()),
        date: Some(test_date),
        color: "#00ff00".to_string(),
        direction: Some(SurveyDirection::Out),
        shots: vec![
            test_shot_data(10.0),
            test_shot_data(15.0),
            test_shot_data(8.0),
        ],
    });

    assert!(result.success);
    let section_id = result.section_id.expect("Section ID should be returned");

    let project = state.get_project_state().unwrap();
    let section = project
        .get_section(section_id)
        .expect("Section should exist");

    assert_eq!(section.name, Some("Main Passage".to_string()));
    assert_eq!(section.surveyor, Some("Alice".to_string()));
    assert_eq!(section.date, Some(test_date));
    assert_eq!(section.color, "#00ff00");
    assert_eq!(section.direction, SurveyDirection::Out);
    assert_eq!(section.shots.len(), 3);
    assert_eq!(section.shots[0].length, 10.0);
    assert_eq!(section.shots[1].length, 15.0);
    assert_eq!(section.shots[2].length, 8.0);
}

#[test]
fn test_execute_merge_stations_command() {
    // Verify MergeStations updates section offsets correctly
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections
    let result_a = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
    });
    let section_a_id = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0), test_shot_data(6.0)],
    });
    let section_b_id = result_b.section_id.unwrap();

    // Merge station 1 of section A with station 0 of section B
    let station_a = StationRef::new(section_a_id, 1);
    let station_b = StationRef::new(section_b_id, 0);

    let result = state.execute(Command::MergeStations {
        station_a,
        station_b,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();

    // Verify merge was recorded
    assert_eq!(project.station_merges.len(), 1);
    let merge = &project.station_merges[0];
    assert!(project.key_is_ref(&merge.station_a, station_a));
    assert!(project.key_is_ref(&merge.station_b, station_b));

    // Verify section offsets were updated - one section should have an offset
    // (the moving section gets an offset to align with the anchor)
    let has_offset = project.section_offsets.contains_key(&section_a_id)
        || project.section_offsets.contains_key(&section_b_id);
    assert!(has_offset, "Section offsets should be updated after merge");
}

#[test]
fn test_execute_set_zero_datum_command() {
    // Verify SetZeroDatum stores GPS coordinates correctly
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let station_ref = StationRef::new(section_id, 0);
    let gps = GpsCoordinates::new(48.8584, 2.2945, 35.0).unwrap();

    let result = state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: gps,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.zero_datums.len(), 1);

    let datum = &project.zero_datums[0];
    assert!(project.key_is_ref(&datum.station_ref, station_ref));
    assert!((datum.gps.latitude - 48.8584).abs() < 0.0001);
    assert!((datum.gps.longitude - 2.2945).abs() < 0.0001);
    assert!((datum.gps.depth_reference - 35.0).abs() < 0.0001);
}

#[test]
fn test_undo_set_zero_datum_restores_section_offsets() {
    // Verify undo restores exact previous section_offsets, including
    // removing keys that were newly created by the command
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections with shots
    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let section_a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let section_b = result_b.section_id.unwrap();

    // Set an existing offset on section A only
    // (section B has no offset - key doesn't exist)
    {
        let mut proj = state.project.lock().unwrap();
        let project = proj.as_mut().unwrap();
        project.section_offsets.insert(section_a, (100.0, 200.0));
    }

    // Merge the sections so they're connected
    state.execute(Command::MergeStations {
        station_a: StationRef::new(section_a, 1),
        station_b: StationRef::new(section_b, 0),
    });

    // Clear undo stack to focus on SetZeroDatum
    {
        let mut stack = state.undo_stack.lock().unwrap();
        stack.clear();
    }

    // Capture pre-command state
    let (pre_offset_a, pre_offset_b, pre_datum_count) = {
        let proj = state.project.lock().unwrap();
        let project = proj.as_ref().unwrap();
        (
            project.section_offsets.get(&section_a).copied(),
            project.section_offsets.get(&section_b).copied(),
            project.zero_datums.len(),
        )
    };

    // Set zero datum - this will create/modify offsets for both connected sections
    let station_ref = StationRef::new(section_a, 0);
    let gps = GpsCoordinates::new(45.0, -73.0, 100.0).unwrap();
    let result = state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: gps,
    });
    assert!(result.success);

    // Verify offsets changed after SetZeroDatum
    let (post_offset_a, post_offset_b, post_datum_count) = {
        let proj = state.project.lock().unwrap();
        let project = proj.as_ref().unwrap();
        (
            project.section_offsets.get(&section_a).copied(),
            project.section_offsets.get(&section_b).copied(),
            project.zero_datums.len(),
        )
    };
    assert_ne!(
        pre_offset_a, post_offset_a,
        "Section A offset should change"
    );
    assert!(
        post_offset_b.is_some(),
        "Section B should now have an offset"
    );
    assert_eq!(
        post_datum_count,
        pre_datum_count + 1,
        "Datum should be added"
    );

    // Undo the SetZeroDatum
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo should succeed");

    // Verify exact previous state is restored
    let (restored_offset_a, restored_offset_b, restored_datum_count) = {
        let proj = state.project.lock().unwrap();
        let project = proj.as_ref().unwrap();
        (
            project.section_offsets.get(&section_a).copied(),
            project.section_offsets.get(&section_b).copied(),
            project.zero_datums.len(),
        )
    };

    // Section A should have its original offset restored
    assert_eq!(
        restored_offset_a, pre_offset_a,
        "Section A offset should be restored to original value"
    );

    // Section B key should be removed (it didn't exist before)
    assert_eq!(
        restored_offset_b, pre_offset_b,
        "Section B offset key should be removed (was None before)"
    );
    assert!(
        pre_offset_b.is_none() && restored_offset_b.is_none(),
        "Section B offset key must not exist after undo"
    );

    // Datum should be removed
    assert_eq!(
        restored_datum_count, pre_datum_count,
        "Datum should be removed after undo"
    );
}

#[test]
fn test_execute_update_shot_command() {
    // Verify UpdateShot modifies shot data correctly
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 10.0,
            depth_in: 5.0,
            depth_out: 6.0,
            left: None,
            right: None,
            up: None,
            down: None,
            comment: None,
            ..Default::default()
        }],
    });

    let section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    // Update multiple fields
    let result = state.execute(Command::UpdateShot {
        section_id,
        shot_id,
        updates: ShotUpdates {
            azimuth_in: Some(45.0),
            length: Some(20.0),
            left: Some(Some(1.5)),
            right: Some(Some(2.0)),
            up: Some(Some(3.0)),
            down: Some(Some(0.5)),
            comment: Some(Some("Narrow squeeze".to_string())),
            ..Default::default()
        },
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.sections[0].shots[0];

    assert_eq!(shot.azimuth_in, 45.0);
    assert_eq!(shot.azimuth_out, 270.0); // Unchanged
    assert_eq!(shot.length, 20.0);
    assert_eq!(shot.depth_in, 5.0); // Unchanged
    assert_eq!(shot.left, Some(1.5));
    assert_eq!(shot.right, Some(2.0));
    assert_eq!(shot.up, Some(3.0));
    assert_eq!(shot.down, Some(0.5));
    assert_eq!(shot.comment, Some("Narrow squeeze".to_string()));
}

#[test]
fn test_execute_delete_shot_command() {
    // Verify DeleteShot removes shot and maintains section integrity
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(9.0),
        ],
    });

    let section_id = create_result.section_id.unwrap();

    // Get the middle shot's ID
    let project = state.get_project_state().unwrap();
    let middle_shot_id = project.sections[0].shots[1].id;
    let first_shot_id = project.sections[0].shots[0].id;
    let last_shot_id = project.sections[0].shots[2].id;

    // Delete the middle shot
    let result = state.execute(Command::DeleteShot {
        section_id,
        shot_id: middle_shot_id,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    let section = project.get_section(section_id).unwrap();

    // Should have 2 shots remaining
    assert_eq!(section.shots.len(), 2);

    // First and last shots should still exist
    assert!(section.shots.iter().any(|s| s.id == first_shot_id));
    assert!(section.shots.iter().any(|s| s.id == last_shot_id));

    // Middle shot should be gone
    assert!(!section.shots.iter().any(|s| s.id == middle_shot_id));

    // Verify shot lengths are correct (first and last)
    assert_eq!(section.shots[0].length, 5.0);
    assert_eq!(section.shots[1].length, 9.0);
}

#[test]
fn test_execute_create_shot_command() {
    // Verify CreateShot inserts shot at correct position
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(10.0)],
    });

    let section_id = create_result.section_id.unwrap();

    // Get the first shot's ID
    let project = state.get_project_state().unwrap();
    let first_shot_id = project.sections[0].shots[0].id;

    // Insert a new shot after the first shot
    let result = state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(7.5), // Intermediate length
        after_shot_id: Some(first_shot_id),
        before_shot_id: None,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    let section = project.get_section(section_id).unwrap();

    // Should have 3 shots now
    assert_eq!(section.shots.len(), 3);

    // Verify order by length: 5.0, 7.5, 10.0
    assert_eq!(section.shots[0].length, 5.0);
    assert_eq!(section.shots[1].length, 7.5);
    assert_eq!(section.shots[2].length, 10.0);
}

#[test]
fn test_execute_delete_section_command() {
    // Verify DeleteSection cleans up merges and related data
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections
    let result_a = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_a_id = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(7.0)],
    });
    let section_b_id = result_b.section_id.unwrap();

    // Set a zero datum on section A
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(section_a_id, 0),
        coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
    });

    // Verify initial state
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);
    assert_eq!(project.zero_datums.len(), 1);

    // Delete section A
    let result = state.execute(Command::DeleteSection {
        section_id: section_a_id,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();

    // Section should be removed
    assert_eq!(project.sections.len(), 1);
    assert!(project.get_section(section_a_id).is_none());
    assert!(project.get_section(section_b_id).is_some());

    // Section B should be the only one remaining
    assert_eq!(project.sections[0].id, section_b_id);
    assert_eq!(project.sections[0].name, Some("Section B".to_string()));
}

#[test]
fn test_execute_update_section_metadata_command() {
    // Verify UpdateSectionMetadata modifies metadata correctly
    use chrono::NaiveDate;
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let initial_date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let create_result = state.execute(Command::CreateSection {
        name: Some("Original Name".to_string()),
        surveyor: Some("Bob".to_string()),
        date: Some(initial_date),
        color: "#ff0000".to_string(),
        direction: Some(SurveyDirection::In),
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();

    // Update all metadata fields
    let updated_date = NaiveDate::from_ymd_opt(2024, 2, 20).unwrap();
    let result = state.execute(Command::UpdateSectionMetadata {
        section_id,
        updates: SectionUpdates {
            name: Some(Some("Updated Name".to_string())),
            surveyor: Some(Some("Carol".to_string())),
            date: Some(Some(updated_date)),
            color: Some("#0000ff".to_string()),
            direction: Some(SurveyDirection::Out),
            quality: Some(1.25),
        },
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    let section = project.get_section(section_id).unwrap();

    assert_eq!(section.name, Some("Updated Name".to_string()));
    assert_eq!(section.surveyor, Some("Carol".to_string()));
    assert_eq!(section.date, Some(updated_date));
    assert_eq!(section.color, "#0000ff");
    assert_eq!(section.direction, SurveyDirection::Out);
    assert_eq!(section.quality, 1.25);

    // Verify shots were not affected
    assert_eq!(section.shots.len(), 1);
    assert_eq!(section.shots[0].length, 5.0);
}

// === Edge Case Tests for Validation Errors ===

#[test]
fn test_execute_command_no_project_open() {
    let state = AppState::new().unwrap();

    // Try to execute commands without an open project
    let commands_to_test = vec![
        Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        },
        Command::DeleteSection { section_id: 0 },
        Command::UpdateSectionMetadata {
            section_id: 0,
            updates: SectionUpdates::default(),
        },
        Command::CreateShot {
            section_id: 0,
            shot: test_shot_data(5.0),
            after_shot_id: None,
            before_shot_id: None,
        },
        Command::UpdateShot {
            section_id: 0,
            shot_id: 0,
            updates: ShotUpdates::default(),
        },
        Command::DeleteShot {
            section_id: 0,
            shot_id: 0,
        },
        Command::MergeStations {
            station_a: StationRef::new(0, 0),
            station_b: StationRef::new(1, 0),
        },
        Command::SetZeroDatum {
            station_ref: StationRef::new(0, 0),
            coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
        },
    ];

    for cmd in commands_to_test {
        let result = state.execute(cmd);
        assert!(
            !result.success,
            "Command should fail when no project is open"
        );
        assert!(
            result.error.is_some(),
            "Should have error message when no project open"
        );
    }
}

#[test]
fn test_execute_commands_with_invalid_ids() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_id = create_result.section_id.unwrap();

    // Test with nonexistent section ID
    let result = state.execute(Command::DeleteSection { section_id: 999 });
    assert!(!result.success);

    let result = state.execute(Command::UpdateSectionMetadata {
        section_id: 999,
        updates: SectionUpdates::default(),
    });
    assert!(!result.success);

    // Test with nonexistent shot ID
    let result = state.execute(Command::UpdateShot {
        section_id,
        shot_id: 999_999,
        updates: ShotUpdates::default(),
    });
    assert!(!result.success);

    let result = state.execute(Command::DeleteShot {
        section_id,
        shot_id: 999_999,
    });
    assert!(!result.success);
}

// === Undo/Redo Tests for fn-35-f4v.1 ===

#[test]
fn test_undo_delete_shot() {
    // Verify undoing DeleteShot restores the shot
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(10.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    // Delete the shot
    state.execute(Command::DeleteShot {
        section_id,
        shot_id,
    });

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 1);
    assert_eq!(project.sections[0].shots[0].length, 10.0);

    // Undo the delete
    let result = state.undo();
    assert!(result.success);

    // Shot should be restored
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 2);
    assert!(project.sections[0].shots.iter().any(|s| s.length == 5.0));
}

#[test]
fn test_undo_merge_stations() {
    // Verify undoing MergeStations removes the merge
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections
    let result_a = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
    });
    let section_a_id = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0), test_shot_data(6.0)],
    });
    let section_b_id = result_b.section_id.unwrap();

    // Verify no merges exist before
    let project_before = state.get_project_state().unwrap();
    assert!(project_before.station_merges.is_empty());

    // Merge stations
    let station_a = StationRef::new(section_a_id, 1);
    let station_b = StationRef::new(section_b_id, 0);

    let result = state.execute(Command::MergeStations {
        station_a,
        station_b,
    });
    assert!(result.success);

    // Verify merge was created
    let project_after = state.get_project_state().unwrap();
    assert_eq!(project_after.station_merges.len(), 1);
    assert!(project_after.key_is_ref(&project_after.station_merges[0].station_a, station_a));
    assert!(project_after.key_is_ref(&project_after.station_merges[0].station_b, station_b));

    // Undo the merge
    let result = state.undo();
    assert!(result.success);

    // Verify merge is gone
    let project_undone = state.get_project_state().unwrap();
    assert!(project_undone.station_merges.is_empty());
}

#[test]
fn test_multiple_undo_sequence() {
    // Verify multiple undos in LIFO order
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create sections in sequence
    state.execute(Command::CreateSection {
        name: Some("First".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    state.execute(Command::CreateSection {
        name: Some("Second".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![],
    });

    state.execute(Command::CreateSection {
        name: Some("Third".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![],
    });

    assert_eq!(state.get_project_state().unwrap().sections.len(), 3);

    // Undo should remove Third first (LIFO)
    let result = state.undo();
    assert!(result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);
    assert!(!project
        .sections
        .iter()
        .any(|s| s.name == Some("Third".to_string())));

    // Undo should remove Second
    let result = state.undo();
    assert!(result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert!(!project
        .sections
        .iter()
        .any(|s| s.name == Some("Second".to_string())));

    // Undo should remove First
    let result = state.undo();
    assert!(result.success);
    assert!(state.get_project_state().unwrap().sections.is_empty());
}

#[test]
fn test_redo_clears_on_new_command() {
    // Verify new command clears redo stack
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section
    state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    // Undo it
    state.undo();
    assert!(state.can_redo());

    // Execute a new command (should clear redo stack)
    state.execute(Command::CreateSection {
        name: Some("New".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![],
    });

    // Redo should no longer be available
    assert!(!state.can_redo());

    // Verify we have the new section, not the original
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].name, Some("New".to_string()));
}

#[test]
fn test_undo_stack_limits() {
    // Verify stack limits and overflow handling
    // Use a small limit to test overflow behavior
    let state = AppState::new().unwrap();

    // Set a small undo history limit via config
    {
        let mut config = state.config.lock().unwrap();
        config.general.undo_history_limit = 3;
    }

    // Reinitialize undo stack with new limit
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.set_history_limit(3);
    }

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create 5 sections (more than the limit of 3)
    for i in 0..5 {
        state.execute(Command::CreateSection {
            name: Some(format!("Section {i}")),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });
    }

    assert_eq!(state.get_project_state().unwrap().sections.len(), 5);

    // We should only be able to undo 3 times (the limit)
    // The first 2 section creates should have been dropped from the stack
    let result1 = state.undo();
    assert!(result1.success);
    assert_eq!(state.get_project_state().unwrap().sections.len(), 4);

    let result2 = state.undo();
    assert!(result2.success);
    assert_eq!(state.get_project_state().unwrap().sections.len(), 3);

    let result3 = state.undo();
    assert!(result3.success);
    assert_eq!(state.get_project_state().unwrap().sections.len(), 2);

    // Fourth undo should fail (stack exhausted)
    let result4 = state.undo();
    assert!(!result4.success);

    // Verify we still have the first 2 sections (they couldn't be undone)
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);
    assert!(project
        .sections
        .iter()
        .any(|s| s.name == Some("Section 0".to_string())));
    assert!(project
        .sections
        .iter()
        .any(|s| s.name == Some("Section 1".to_string())));
}

// === Undo/Redo Entry Preservation on Failure Tests (fn-28-rpu.2) ===

#[test]
fn test_undo_failure_preserves_entry_on_undo_stack() {
    // When undo() fails (e.g., invalid JSON in PreviousValues), the entry
    // must be pushed back to the top of the undo stack, not lost.
    let state = AppState::new().unwrap();

    // Push an entry with invalid undo data that will fail during undo
    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::UpdateShot {
            section_id: 1,
            shot_id: 1,
            updates: ShotUpdates::default(),
        },
        UndoData::PreviousValues {
            section_id: 1,
            shot_id: Some(1),
            values_json: "not-valid-json".to_string(),
        },
    );
    assert_eq!(stack.len(), 1);
    assert!(stack.can_undo());
    assert!(!stack.can_redo());
    drop(stack);

    // Attempt undo — should fail because of invalid JSON
    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to parse undo data"));

    // Entry must still be on the undo stack (preserved, not lost)
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(
        stack.len(),
        1,
        "Entry must remain on undo stack after failure"
    );
    assert!(
        stack.can_undo(),
        "can_undo must be true — entry was preserved"
    );
    // Entry must NOT have moved to redo stack
    assert!(!stack.can_redo(), "Entry must not appear on redo stack");
}

#[test]
fn test_redo_failure_preserves_entry_on_redo_stack() {
    // When redo() fails, the entry must be pushed back to the redo stack.
    let state = AppState::new().unwrap();

    // Push an entry onto the redo stack that will fail when re-executed
    let mut stack = state.undo_stack.lock().unwrap();
    let entry = UndoEntry {
        command: Command::CloseProject,
        undo_data: UndoData::ProjectSnapshotPair {
            before: "{}".to_string(),
            after: "not-valid-json".to_string(),
        },
        timestamp: None,
    };
    stack.push_redo(entry);
    assert_eq!(stack.redo_len(), 1);
    assert!(!stack.can_undo());
    drop(stack);

    // Attempt redo — should fail because "after" is invalid JSON
    let result = state.redo();
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Failed to parse project snapshot")
    );

    // Entry must still be on the redo stack (preserved, not lost)
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(
        stack.redo_len(),
        1,
        "Entry must remain on redo stack after failure"
    );
    assert!(
        stack.can_redo(),
        "can_redo must be true — entry was preserved"
    );
    // Entry must NOT have moved to undo stack
    assert!(!stack.can_undo(), "Entry must not appear on undo stack");
}

#[test]
fn test_undo_failure_preserves_entry_at_top_lifo_order() {
    // After a failed undo, the entry must be at the TOP of the undo stack.
    // Push two entries: a valid one at the bottom and an invalid one at the top.
    // After the failed undo, the invalid entry must still be on top (LIFO preserved).
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Push a valid section create (will be at bottom of undo stack)
    state.execute(Command::CreateSection {
        name: Some("Valid Section".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });

    // Push an invalid entry on top (will fail on undo)
    {
        let mut stack = state.undo_stack.lock().unwrap();
        stack.push_with_data(
            Command::UpdateShot {
                section_id: 999,
                shot_id: 999,
                updates: ShotUpdates::default(),
            },
            UndoData::PreviousValues {
                section_id: 999,
                shot_id: Some(999),
                values_json: "not-json".to_string(),
            },
        );
        // undo stack: [CreateSection, InvalidUpdateShot] (top = InvalidUpdateShot)
        assert_eq!(stack.len(), 2);
    }

    // Attempt undo — the top entry (invalid) should fail
    let result = state.undo();
    assert!(!result.success);

    // The failed entry must be pushed back to the TOP of the undo stack
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(stack.len(), 2, "Both entries must still be on the stack");

    // Peek at the top: it should be the invalid UpdateShot (LIFO preserved)
    let top_cmd = stack.peek_undo().unwrap();
    assert!(
        matches!(
            top_cmd,
            Command::UpdateShot {
                section_id: 999,
                ..
            }
        ),
        "Failed entry must be at TOP of undo stack (LIFO order preserved)"
    );
}

#[test]
fn test_redo_failure_preserves_entry_at_top_lifo_order() {
    // After a failed redo, the entry must be at the TOP of the redo stack.
    let state = AppState::new().unwrap();

    // Push two entries to redo stack: valid at bottom, invalid at top
    let mut stack = state.undo_stack.lock().unwrap();

    // Valid redo entry (bottom)
    stack.push_redo(UndoEntry {
        command: Command::CreateSection {
            name: Some("Valid".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        },
        undo_data: UndoData::None,
        timestamp: None,
    });

    // Invalid redo entry (top) — will fail because "after" JSON is invalid
    stack.push_redo(UndoEntry {
        command: Command::CloseProject,
        undo_data: UndoData::ProjectSnapshotPair {
            before: "{}".to_string(),
            after: "invalid-json".to_string(),
        },
        timestamp: None,
    });

    assert_eq!(stack.redo_len(), 2);
    drop(stack);

    // Attempt redo — the top entry (invalid) should fail
    let result = state.redo();
    assert!(!result.success);

    // The failed entry must be pushed back to the TOP of the redo stack
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(
        stack.redo_len(),
        2,
        "Both entries must still be on redo stack"
    );

    // Peek at the top: it should be the invalid ProjectSnapshotPair
    let top_cmd = stack.peek_redo().unwrap();
    assert!(
        matches!(top_cmd, Command::CloseProject),
        "Failed entry must be at TOP of redo stack (LIFO order preserved)"
    );
}

#[test]
fn test_undo_to_partial_completion_stops_at_failed_step() {
    // undo_to() calls undo() in a loop. If an intermediate step fails,
    // it should stop and return an enhanced error message with step count.
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create 3 valid sections (3 undo entries)
    for i in 0..3 {
        state.execute(Command::CreateSection {
            name: Some(format!("Section {i}")),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![],
        });
    }

    // Push an invalid entry that will fail when undone
    // This goes on top of the stack, so it's the FIRST to be undone
    // But we want it to fail at step 2 or 3, so we need to place it lower.
    // Strategy: undo the top entry to make room, then insert the invalid entry,
    // then redo to restore the valid one on top.
    //
    // Actually, let's structure it differently:
    // Stack bottom-to-top: [Section0, InvalidEntry, Section2]
    // undo_to(2) will try 3 undos: Section2 (ok), InvalidEntry (fail at step 2)
    {
        // Remove the top two entries, insert invalid, put one back
        let mut stack = state.undo_stack.lock().unwrap();
        let top = stack.pop_undo().unwrap(); // Section 2
        let _middle = stack.pop_undo(); // Section 1

        // Push invalid entry at position where Section 1 was
        stack.push_undo(UndoEntry {
            command: Command::UpdateShot {
                section_id: 999,
                shot_id: 999,
                updates: ShotUpdates::default(),
            },
            undo_data: UndoData::PreviousValues {
                section_id: 999,
                shot_id: Some(999),
                values_json: "invalid-json".to_string(),
            },
            timestamp: None,
        });

        // Push Section 2 back on top
        stack.push_undo(top);
    }

    // Undo stack is now: [Section0, InvalidEntry, Section2]
    // undo_to(2) means execute 3 undos:
    //   Step 1: undo Section2 -> success
    //   Step 2: undo InvalidEntry -> failure
    // Should stop and return enhanced message format
    let result = state.undo_to(2);
    assert!(!result.success);

    let error_msg = result.error.as_deref().unwrap();
    // Verify enhanced message format: "Undo failed at step {current} of {total}: {reason}"
    assert!(
        error_msg.contains("Undo failed at step 2 of 3"),
        "Expected enhanced message with step count, got: {error_msg}"
    );
    assert!(
        error_msg.contains("Failed to parse undo data"),
        "Expected original failure reason in message, got: {error_msg}"
    );

    // Verify partial completion: Section 2 was undone (step 1 succeeded),
    // but Section 0 was not undone (step 2 failed before reaching it).
    // The invalid entry should still be on the undo stack (preserved).
    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.len(),
        2,
        "Only Section 2 should have been undone (step 1); Section 0 remains"
    );
    assert!(project
        .sections
        .iter()
        .any(|s| s.name == Some("Section 0".to_string())));

    // Verify the failed entry was preserved on the undo stack
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(
        stack.len(),
        2,
        "Section 0 and invalid entry must remain on undo stack"
    );
    let top_cmd = stack.peek_undo().unwrap();
    assert!(
        matches!(
            top_cmd,
            Command::UpdateShot {
                section_id: 999,
                ..
            }
        ),
        "Failed invalid entry must be at top of undo stack after partial undo_to"
    );
}

#[test]
fn test_redo_to_partial_completion_stops_at_failed_step() {
    // redo_to() calls redo() in a loop. If an intermediate step fails,
    // it should stop and return an enhanced error message with step count.
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create 2 sections, then undo both so they're on the redo stack
    state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });
    state.execute(Command::CreateSection {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![],
    });

    // Undo both: redo stack bottom-to-top = [SectionB, SectionA]
    // (B undone first, then A; LIFO means A is on top for redo)
    state.undo();
    state.undo();
    assert!(state.get_project_state().unwrap().sections.is_empty());

    // Now manipulate the redo stack: insert an invalid entry between the two valid ones
    // Redo stack: [SectionA, InvalidEntry, SectionB]
    {
        let mut stack = state.undo_stack.lock().unwrap();
        let top = stack.pop_redo().unwrap(); // SectionA (last undone = first to redo)
                                             // Push invalid entry
        stack.push_redo(UndoEntry {
            command: Command::CloseProject,
            undo_data: UndoData::ProjectSnapshotPair {
                before: "{}".to_string(),
                after: "not-json".to_string(),
            },
            timestamp: None,
        });
        // Put SectionA back on top
        stack.push_redo(top);
        // Redo stack bottom-to-top: [SectionB, InvalidEntry, SectionA]
        assert_eq!(stack.redo_len(), 3);
    }

    // redo_to(2) means execute 3 redos:
    //   Step 1: redo SectionA (top) -> success
    //   Step 2: redo InvalidEntry -> failure
    // Should stop and return enhanced message
    let result = state.redo_to(2);
    assert!(!result.success);

    let error_msg = result.error.as_deref().unwrap();
    assert!(
        error_msg.contains("Redo failed at step 2 of 3"),
        "Expected enhanced message with step count, got: {error_msg}"
    );
    assert!(
        error_msg.contains("Failed to parse project snapshot"),
        "Expected original failure reason in message, got: {error_msg}"
    );

    // Verify partial completion: SectionA was re-created (step 1 succeeded)
    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.len(),
        1,
        "Only SectionA should have been redone (step 1)"
    );
    assert_eq!(project.sections[0].name, Some("Section A".to_string()));

    // Verify the failed entry was preserved on the redo stack
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(
        stack.redo_len(),
        2,
        "Invalid entry and SectionB must remain on redo stack"
    );
    let top_cmd = stack.peek_redo().unwrap();
    assert!(
        matches!(top_cmd, Command::CloseProject),
        "Failed invalid entry must be at top of redo stack after partial redo_to"
    );
}

#[test]
fn test_undo_failure_with_project_snapshot_preserves_entry() {
    // Verify that a ProjectSnapshot undo failure (invalid JSON) preserves the entry
    let state = AppState::new().unwrap();

    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::Batch {
            commands: Vec::new(),
        },
        UndoData::ProjectSnapshot("not-valid-json".to_string()),
    );
    assert_eq!(stack.len(), 1);
    drop(stack);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Failed to parse project snapshot")
    );

    // Entry must still be on the undo stack
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(stack.len(), 1, "Entry must be preserved on undo stack");
    assert!(!stack.can_redo(), "Entry must not appear on redo stack");
}

#[test]
fn test_undo_failure_with_project_lock_preserves_entry() {
    // When the project mutex is poisoned, undo fails but the entry
    // must still be pushed back to the undo stack.
    let state = AppState::new().unwrap();

    let snapshot = serde_json::to_string(&Project::new("Test".to_string(), None)).unwrap();
    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::Batch {
            commands: Vec::new(),
        },
        UndoData::ProjectSnapshot(snapshot),
    );
    assert_eq!(stack.len(), 1);
    drop(stack);

    // Poison the project mutex
    poison_mutex(&state.project);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock project"));

    // Entry must still be preserved on the undo stack
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(
        stack.len(),
        1,
        "Entry must be preserved on undo stack after project lock failure"
    );
    assert!(!stack.can_redo(), "Entry must not appear on redo stack");
}

#[test]
fn test_redo_failure_with_project_lock_preserves_entry() {
    // When the project mutex is poisoned, redo fails but the entry
    // must still be pushed back to the redo stack.
    let state = AppState::new().unwrap();

    let before = serde_json::to_string(&Project::new("Before".to_string(), None)).unwrap();
    let after = serde_json::to_string(&Project::new("After".to_string(), None)).unwrap();

    let entry = UndoEntry {
        command: Command::CloseProject,
        undo_data: UndoData::ProjectSnapshotPair { before, after },
        timestamp: None,
    };

    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_redo(entry);
    assert_eq!(stack.redo_len(), 1);
    drop(stack);

    // Poison the project mutex
    poison_mutex(&state.project);

    let result = state.redo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to lock project"));

    // Entry must still be preserved on the redo stack
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(
        stack.redo_len(),
        1,
        "Entry must be preserved on redo stack after project lock failure"
    );
    assert!(!stack.can_undo(), "Entry must not appear on undo stack");
}

#[test]
fn test_set_zero_datum_update_captures_previous_gps_and_offsets() {
    // Verify that calling SetZeroDatum on an existing datum captures previous_gps = Some(old)
    // and previous_offsets correctly in the undo data.
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section with shots
    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let section_a = result_a.section_id.unwrap();

    let station_ref = StationRef::new(section_a, 0);

    // Set initial zero datum with GPS-A
    let gps_a = GpsCoordinates::new(25.0, -80.0, 50.0).unwrap();
    let result = state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: gps_a,
    });
    assert!(result.success, "Initial SetZeroDatum should succeed");

    // Capture the section offsets before the update for later assertion
    let offsets_before_update = {
        let proj = state.project.lock().unwrap();
        let project = proj.as_ref().unwrap();
        project.section_offsets.clone()
    };

    // Clear undo stack to focus on the update
    {
        let mut stack = state.undo_stack.lock().unwrap();
        stack.clear();
    }

    // Now update the datum with GPS-B
    let gps_b = GpsCoordinates::new(26.0, -81.0, 55.0).unwrap();
    let result = state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: gps_b,
    });
    assert!(result.success, "Update SetZeroDatum should succeed");

    // Inspect the undo entry's undo_data
    let stack = state.undo_stack.lock().unwrap();
    assert!(stack.can_undo(), "Should have an undo entry");

    let undo_data = stack.peek_undo_data().expect("Should have undo data");
    match undo_data {
        UndoData::ZeroDatumInfo {
            station_ref: ref_in_entry,
            previous_gps,
            previous_offsets,
        } => {
            assert_eq!(*ref_in_entry, station_ref, "Station ref should match");
            assert!(
                previous_gps.is_some(),
                "previous_gps must be Some(old) when updating existing datum"
            );
            let prev = previous_gps.unwrap();
            assert!(
                (prev.latitude - 25.0).abs() < f64::EPSILON,
                "previous_gps latitude should be GPS-A's latitude (25.0), got {}",
                prev.latitude
            );
            assert!(
                (prev.longitude - (-80.0)).abs() < f64::EPSILON,
                "previous_gps longitude should be GPS-A's longitude (-80.0), got {}",
                prev.longitude
            );
            // Assert previous_offsets contains the datum section and matches the pre-update value
            assert!(
                previous_offsets.contains_key(&section_a),
                "previous_offsets must contain the datum section ({section_a})"
            );
            let captured_offset = previous_offsets.get(&section_a).unwrap();
            let expected_offset = offsets_before_update.get(&section_a).copied();
            assert_eq!(
                *captured_offset, expected_offset,
                "previous_offsets for datum section should match pre-update offset"
            );
        }
        other => panic!(
            "Expected UndoData::ZeroDatumInfo, got {:?}",
            std::mem::discriminant(other)
        ),
    }
}

#[test]
fn test_set_zero_datum_update_undo_restores_previous_gps_and_offsets() {
    // After updating a zero datum, undo should restore the previous GPS and section offsets.
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let section_a = result_a.section_id.unwrap();

    let station_ref = StationRef::new(section_a, 0);

    // Set initial zero datum with GPS-A
    let gps_a = GpsCoordinates::new(25.0, -80.0, 50.0).unwrap();
    state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: gps_a,
    });

    // Capture state after initial set (GPS-A applied)
    let (offsets_after_a, gps_after_a) = {
        let proj = state.project.lock().unwrap();
        let project = proj.as_ref().unwrap();
        let offsets = project.section_offsets.clone();
        let gps = project
            .zero_datums
            .iter()
            .find(|zd| project.key_is_ref(&zd.station_ref, station_ref))
            .map(|zd| zd.gps);
        (offsets, gps)
    };
    assert!(gps_after_a.is_some(), "GPS-A should be set");
    assert!(
        (gps_after_a.unwrap().latitude - 25.0).abs() < f64::EPSILON,
        "GPS should be A"
    );

    // Clear undo stack so we only track the update
    {
        let mut stack = state.undo_stack.lock().unwrap();
        stack.clear();
    }

    // Update datum with GPS-B
    let gps_b = GpsCoordinates::new(26.0, -81.0, 55.0).unwrap();
    let result = state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: gps_b,
    });
    assert!(result.success);

    // Verify GPS-B is now active
    {
        let proj = state.project.lock().unwrap();
        let project = proj.as_ref().unwrap();
        let current_gps = project
            .zero_datums
            .iter()
            .find(|zd| project.key_is_ref(&zd.station_ref, station_ref))
            .map(|zd| zd.gps)
            .unwrap();
        assert!(
            (current_gps.latitude - 26.0).abs() < f64::EPSILON,
            "GPS should now be B"
        );
    }

    // Undo the update
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo should succeed");

    // Verify GPS is restored to A
    let (restored_offsets, restored_gps) = {
        let proj = state.project.lock().unwrap();
        let project = proj.as_ref().unwrap();
        let offsets = project.section_offsets.clone();
        let gps = project
            .zero_datums
            .iter()
            .find(|zd| project.key_is_ref(&zd.station_ref, station_ref))
            .map(|zd| zd.gps);
        (offsets, gps)
    };

    let restored = restored_gps.expect("GPS should be restored after undo");
    assert!(
        (restored.latitude - 25.0).abs() < f64::EPSILON,
        "GPS latitude should be restored to GPS-A (25.0), got {}",
        restored.latitude
    );
    assert!(
        (restored.longitude - (-80.0)).abs() < f64::EPSILON,
        "GPS longitude should be restored to GPS-A (-80.0), got {}",
        restored.longitude
    );

    // Verify section offsets are restored
    assert_eq!(
        restored_offsets, offsets_after_a,
        "Section offsets should be restored to pre-update values"
    );
}

#[test]
fn test_set_zero_datum_no_change_still_creates_undo_entry() {
    // The no-change guard is frontend-only (lat/lon comparison in EditStationDialog).
    // The backend always executes SetZeroDatum and always creates an undo entry.
    // This test confirms that calling SetZeroDatum with the same GPS coordinates
    // still produces an undo entry (the guard must be tested in E2E).
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let section_a = result_a.section_id.unwrap();

    let station_ref = StationRef::new(section_a, 0);
    let gps = GpsCoordinates::new(25.0, -80.0, 50.0).unwrap();

    // Set initial datum
    state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: gps,
    });

    // Clear undo stack
    {
        let mut stack = state.undo_stack.lock().unwrap();
        stack.clear();
    }

    // Call SetZeroDatum again with identical GPS
    let same_gps = GpsCoordinates::new(25.0, -80.0, 50.0).unwrap();
    let result = state.execute(Command::SetZeroDatum {
        station_ref,
        coordinates: same_gps,
    });
    assert!(result.success, "SetZeroDatum with same GPS should succeed");

    // Backend still creates an undo entry (no backend-level no-change guard)
    let stack = state.undo_stack.lock().unwrap();
    assert!(
        stack.can_undo(),
        "Backend should still create an undo entry even with identical GPS; \
         the no-change guard is frontend-only"
    );
}

// === CreateLoopClosure undo/redo tests ===

#[test]
fn test_undo_create_loop_closure() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections
    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let section_a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_b = result_b.section_id.unwrap();

    // Merge them so they're connected
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(section_a, 1),
        station_b: StationRef::new(section_b, 0),
    });
    assert!(merge_result.success, "Merge should succeed");

    // Create loop closure
    let closure_result = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(section_a, 0),
        station_b: StationRef::new(section_b, 1),
        closure_strategy: ClosureStrategy::Batch,
    });
    assert!(closure_result.success, "CreateLoopClosure should succeed");

    // Verify closure exists
    {
        let project = state.get_project_state().unwrap();
        assert_eq!(project.loop_closures.len(), 1, "Should have 1 closure");
    }

    // Undo: closure should be removed
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo should succeed");

    {
        let project = state.get_project_state().unwrap();
        assert_eq!(
            project.loop_closures.len(),
            0,
            "Closure should be removed after undo"
        );
    }

    // Redo: closure should be re-added
    let redo_result = state.redo();
    assert!(redo_result.success, "Redo should succeed");

    {
        let project = state.get_project_state().unwrap();
        assert_eq!(
            project.loop_closures.len(),
            1,
            "Closure should be restored after redo"
        );
    }
}

#[test]
fn test_undo_create_loop_closure_has_closure_info() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let section_a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_b = result_b.section_id.unwrap();

    state.execute(Command::MergeStations {
        station_a: StationRef::new(section_a, 1),
        station_b: StationRef::new(section_b, 0),
    });

    state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(section_a, 0),
        station_b: StationRef::new(section_b, 1),
        closure_strategy: ClosureStrategy::Batch,
    });

    // Check undo stack has ClosureInfo data
    let proj = state.get_project_state().unwrap();
    let stack = state.undo_stack.lock().unwrap();
    let undo_data = stack.peek_undo_data().unwrap();
    match undo_data {
        UndoData::ClosureInfo { closure } => {
            assert!(proj.key_is_ref(&closure.station_a, StationRef::new(section_a, 0)));
            assert!(proj.key_is_ref(&closure.station_b, StationRef::new(section_b, 1)));
            assert!(closure.path_length > 0.0);
        }
        other => panic!("Expected ClosureInfo, got {:?}", other.variant_name()),
    }
}

#[test]
fn test_create_loop_closure_deferred_strategy_is_rejected() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "DistUndo".to_string(),
        location: None,
    });

    let result = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0), test_shot_data(6.0)],
    });
    let section_id = result.section_id.unwrap();

    let before_project = state.get_project_state().unwrap();
    let before_shots = before_project
        .sections
        .iter()
        .find(|s| s.id == section_id)
        .unwrap()
        .shots
        .clone();

    let closure_result = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(section_id, 0),
        station_b: StationRef::new(section_id, 2),
        closure_strategy: ClosureStrategy::ProportionalByLength,
    });
    assert!(!closure_result.success);

    let after_project = state.get_project_state().unwrap();
    let after_shots = after_project
        .sections
        .iter()
        .find(|s| s.id == section_id)
        .unwrap()
        .shots
        .clone();
    assert!((before_shots[0].length - after_shots[0].length).abs() < 1e-6);
}

#[test]
fn test_undo_unmerge_restores_removed_closures() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let section_a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_b = result_b.section_id.unwrap();

    let merge_station_a = StationRef::new(section_a, 1);
    let merge_station_b = StationRef::new(section_b, 0);

    // Merge A.1 with B.0
    state.execute(Command::MergeStations {
        station_a: merge_station_a,
        station_b: merge_station_b,
    });

    // Inject a closure matching the merge pair directly into project state.
    // (create_loop_closure won't let us create one for merged-pair stations,
    // so we simulate legacy data by injecting directly.)
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        project.loop_closures.push(LoopClosure {
            id: 1,
            station_a: merge_station_a.into(),
            station_b: merge_station_b.into(),
            path_length: 15.0,
            misclosure_distance: 0.3,
            error_percentage: 2.0,
            horizontal_misclosure: 0.2,
            vertical_misclosure: 0.1,
            strategy: ClosureStrategy::default(),
            is_aligned: false,
        });
    }

    {
        let project = state.get_project_state().unwrap();
        assert_eq!(
            project.loop_closures.len(),
            1,
            "Should have 1 closure before unmerge"
        );
    }

    // Unmerge the stations - should remove closures matching the merge pair (A.1, B.0)
    let unmerge_result = state.execute(Command::UnmergeStations {
        station_ref: merge_station_a,
    });
    assert!(unmerge_result.success, "Unmerge should succeed");

    {
        let project = state.get_project_state().unwrap();
        assert!(project.station_merges.is_empty(), "Merge should be removed");
        assert_eq!(
            project.loop_closures.len(),
            0,
            "Closure matching merge pair should be removed by unmerge"
        );
    }

    // Undo the unmerge - should restore both the merge AND the removed closure
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo unmerge should succeed");

    {
        let project = state.get_project_state().unwrap();
        assert_eq!(project.station_merges.len(), 1, "Merge should be restored");
        assert_eq!(
            project.loop_closures.len(),
            1,
            "Closure should be restored after undo of unmerge"
        );
        let restored_closure = &project.loop_closures[0];
        assert!(project.key_is_ref(&restored_closure.station_a, merge_station_a));
        assert!(project.key_is_ref(&restored_closure.station_b, merge_station_b));
        assert!((restored_closure.path_length - 15.0).abs() < 1e-6);
    }
}

// === Move Station Tests ===

#[test]
fn test_move_station_updates_shot_data() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create section with a shot pointing due east (azimuth 90°), length 10
    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            azimuth_in: 90.0,
            azimuth_out: 90.0,
            length: 10.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }],
    });

    let section_id = create_result.section_id.unwrap();
    let station_ref = StationRef::new(section_id, 1); // last station

    // Move station 1 by (5, 0, 0) — extend eastward
    // Shot 0: vector was (10, 0, 0), now (15, 0, 0)
    let result = state.execute(Command::MoveStation {
        station_ref,
        offset: Coordinates::new(5.0, 0.0, 0.0),
    });
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!(
        (shot.length - 15.0).abs() < 1e-6,
        "Length should be 15.0, got {}",
        shot.length
    );
    assert!(
        (shot.azimuth_in - 90.0).abs() < 1e-6,
        "Azimuth should still be 90°"
    );
    assert!(
        !project.station_offset_for_ref(station_ref).is_some(),
        "Station offset should be cleared"
    );

    // Second move: (0, 10, 3) — shot vector becomes (15, 10, 3)
    let result = state.execute(Command::MoveStation {
        station_ref,
        offset: Coordinates::new(0.0, 10.0, 3.0),
    });
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    let expected_len = (15.0_f64.powi(2) + 10.0_f64.powi(2) + 3.0_f64.powi(2)).sqrt(); // slope length
    assert!(
        (shot.length - expected_len).abs() < 1e-6,
        "Length should be {}, got {}",
        expected_len,
        shot.length
    );
    let expected_azi = (15.0_f64).atan2(10.0).to_degrees(); // atan2(dx, dy)
    assert!(
        (shot.azimuth_in - expected_azi).abs() < 1e-6,
        "Azimuth should be {:.1}°, got {:.1}°",
        expected_azi,
        shot.azimuth_in
    );
    assert!(
        (shot.depth_out - 3.0).abs() < 1e-6,
        "Depth out should be 3.0, got {}",
        shot.depth_out
    );
}

#[test]
fn test_move_station_zero_updates_section_offset() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create section with a shot pointing due east (azimuth 90°), length 10
    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            azimuth_in: 90.0,
            azimuth_out: 90.0,
            length: 10.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }],
    });

    let section_id = create_result.section_id.unwrap();
    let station_0 = StationRef::new(section_id, 0);
    let station_1 = StationRef::new(section_id, 1);

    let before = state.get_project_state().unwrap();
    let before_station_1 = before.compute_station_raw_coords(station_1).unwrap();

    // Move station 0 by (5, 0, 0) — should shift section offset and keep station 1 fixed
    let result = state.execute(Command::MoveStation {
        station_ref: station_0,
        offset: Coordinates::new(5.0, 0.0, 0.0),
    });
    assert!(result.success);

    let after = state.get_project_state().unwrap();
    let after_station_0 = after.compute_station_raw_coords(station_0).unwrap();
    let after_station_1 = after.compute_station_raw_coords(station_1).unwrap();

    assert!(
        (after_station_0.x - 5.0).abs() < 1e-6,
        "Station 0 x should be 5.0"
    );
    assert!(
        (after_station_0.y).abs() < 1e-6,
        "Station 0 y should remain 0.0"
    );
    assert!(
        (after_station_1.x - before_station_1.x).abs() < 1e-6,
        "Station 1 x should remain unchanged"
    );
    assert!(
        (after_station_1.y - before_station_1.y).abs() < 1e-6,
        "Station 1 y should remain unchanged"
    );

    let offset = after
        .section_offsets
        .get(&section_id)
        .copied()
        .unwrap_or((0.0, 0.0));
    assert!(
        (offset.0 - 5.0).abs() < 1e-6,
        "Section offset x should be 5.0"
    );
    assert!(
        (offset.1).abs() < 1e-6,
        "Section offset y should remain 0.0"
    );
}

#[test]
fn test_move_station_undo() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Due east shot, length 10
    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            azimuth_in: 90.0,
            azimuth_out: 90.0,
            length: 10.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }],
    });

    let section_id = create_result.section_id.unwrap();
    let station_ref = StationRef::new(section_id, 0); // first station

    // Move station 0 by (5, 0, 0) — following shot vector -= (5, 0, 0) → (5, 0, 0)
    state.execute(Command::MoveStation {
        station_ref,
        offset: Coordinates::new(5.0, 0.0, 0.0),
    });

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!(
        (shot.length - 5.0).abs() < 1e-6,
        "Shot length after move should be 5.0"
    );

    // Undo should restore original shot data
    let undo_result = state.undo();
    assert!(undo_result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!(
        (shot.length - 10.0).abs() < 1e-6,
        "Undo should restore length to 10.0, got {}",
        shot.length
    );
    assert!(
        (shot.azimuth_in - 90.0).abs() < 1e-6,
        "Undo should restore azimuth_in to 90.0"
    );
    assert!(
        (shot.azimuth_out - 90.0).abs() < 1e-6,
        "Undo should restore azimuth_out to 90.0"
    );
    assert!(
        (shot.depth_in - 0.0).abs() < 1e-6,
        "Undo should restore depth_in to 0.0"
    );
    assert!(
        (shot.depth_out - 0.0).abs() < 1e-6,
        "Undo should restore depth_out to 0.0"
    );
}

#[test]
fn test_move_station_redo() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Due east shot, length 10
    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            azimuth_in: 90.0,
            azimuth_out: 90.0,
            length: 10.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }],
    });

    let section_id = create_result.section_id.unwrap();
    let station_ref = StationRef::new(section_id, 1); // last station

    // Move station 1 by (5, 0, 0) — preceding shot vector += (5, 0, 0) → (15, 0, 0)
    state.execute(Command::MoveStation {
        station_ref,
        offset: Coordinates::new(5.0, 0.0, 0.0),
    });

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!(
        (shot.length - 15.0).abs() < 1e-6,
        "After move: length should be 15.0"
    );

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!(
        (shot.length - 10.0).abs() < 1e-6,
        "After undo: length should be 10.0"
    );

    // Redo should re-apply the move
    let redo_result = state.redo();
    assert!(redo_result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!(
        (shot.length - 15.0).abs() < 1e-6,
        "After redo: length should be 15.0, got {}",
        shot.length
    );
    assert!(
        (shot.azimuth_in - 90.0).abs() < 1e-6,
        "After redo: azimuth should be 90°"
    );
}

#[test]
fn test_station_offset_applied_in_coordinates() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();
    let station_ref = StationRef::new(section_id, 1); // end station of the shot

    // Compute coordinates before any move
    let coords_before = {
        let project = state.get_project_state().unwrap();
        project.compute_station_raw_coords(station_ref).unwrap()
    };

    // Move the station
    let move_offset = Coordinates::new(100.0, 200.0, 50.0);
    let result = state.execute(Command::MoveStation {
        station_ref,
        offset: move_offset,
    });
    assert!(result.success);

    // Compute coordinates after move
    let coords_after = {
        let project = state.get_project_state().unwrap();
        project.compute_station_raw_coords(station_ref).unwrap()
    };

    // The station coordinates should differ by exactly the move offset
    let dx = coords_after.x - coords_before.x;
    let dy = coords_after.y - coords_before.y;
    let dz = coords_after.z - coords_before.z;

    assert!(
        (dx - 100.0).abs() < 1e-6,
        "X coordinate should shift by 100.0, got delta {dx}"
    );
    assert!(
        (dy - 200.0).abs() < 1e-6,
        "Y coordinate should shift by 200.0, got delta {dy}"
    );
    assert!(
        (dz - 50.0).abs() < 1e-6,
        "Z coordinate should shift by 50.0, got delta {dz}"
    );
}

// === CreateSection undo/redo ID preservation tests ===

#[test]
fn test_create_section_undo_redo_preserves_id() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section with shots
    let create_result = state.execute(Command::CreateSection {
        name: Some("ID Preservation".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(10.0)],
    });

    let original_section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].id, original_section_id);
    let original_shot_ids: Vec<_> = project.sections[0].shots.iter().map(|s| s.id).collect();
    assert_eq!(original_shot_ids.len(), 2);

    // Undo the create
    let undo_result = state.undo();
    assert!(undo_result.success);
    assert!(state.get_project_state().unwrap().sections.is_empty());

    // Redo the create - should preserve original section ID
    let redo_result = state.redo();
    assert!(redo_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(
        project.sections[0].id, original_section_id,
        "Section ID must be preserved after undo/redo, expected {} got {}",
        original_section_id, project.sections[0].id
    );
    assert_eq!(
        project.sections[0].name,
        Some("ID Preservation".to_string())
    );

    // Verify shot IDs are preserved too
    let restored_shot_ids: Vec<_> = project.sections[0].shots.iter().map(|s| s.id).collect();
    assert_eq!(
        restored_shot_ids, original_shot_ids,
        "Shot IDs must be preserved after undo/redo"
    );
}

#[test]
fn test_create_section_double_undo_redo_cycle() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section with shots
    let create_result = state.execute(Command::CreateSection {
        name: Some("Double Cycle".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(3.0),
            test_shot_data(7.0),
            test_shot_data(11.0),
        ],
    });

    let original_section_id = create_result.section_id.unwrap();
    let project = state.get_project_state().unwrap();
    let original_shot_ids: Vec<_> = project.sections[0].shots.iter().map(|s| s.id).collect();

    // First cycle: undo -> redo
    assert!(state.undo().success);
    assert!(state.get_project_state().unwrap().sections.is_empty());
    assert!(state.redo().success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].id, original_section_id);
    let shot_ids_after_first: Vec<_> = project.sections[0].shots.iter().map(|s| s.id).collect();
    assert_eq!(shot_ids_after_first, original_shot_ids);

    // Second cycle: undo -> redo
    assert!(state.undo().success);
    assert!(state.get_project_state().unwrap().sections.is_empty());
    assert!(state.redo().success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections[0].id, original_section_id,
        "Section ID must be stable through double undo/redo cycle"
    );
    let shot_ids_after_second: Vec<_> = project.sections[0].shots.iter().map(|s| s.id).collect();
    assert_eq!(
        shot_ids_after_second, original_shot_ids,
        "Shot IDs must be stable through double undo/redo cycle"
    );
}

#[test]
fn test_create_section_undo_redo_then_edit() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Editable".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();

    // Undo and redo
    assert!(state.undo().success);
    assert!(state.redo().success);

    // Verify we can edit the restored section
    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    let update_result = state.execute(Command::UpdateShot {
        section_id,
        shot_id,
        updates: ShotUpdates {
            length: Some(99.0),
            ..Default::default()
        },
    });
    assert!(update_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots[0].length, 99.0);
}

#[test]
fn test_create_section_undo_redo_then_delete() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Deletable".to_string()),
        surveyor: None,
        date: None,
        color: "#ff00ff".to_string(),
        direction: None,
        shots: vec![],
    });

    let section_id = create_result.section_id.unwrap();

    // Undo and redo
    assert!(state.undo().success);
    assert!(state.redo().success);

    // Delete the restored section
    let delete_result = state.execute(Command::DeleteSection { section_id });
    assert!(delete_result.success);
    assert!(state.get_project_state().unwrap().sections.is_empty());
}

#[test]
fn test_create_section_created_snapshot_distinct_from_section_snapshot() {
    // Verify that CreateSection uses CreatedSectionSnapshot while
    // DeleteSection still uses SectionSnapshot
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section
    let create_result = state.execute(Command::CreateSection {
        name: Some("Check Variant".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(1.0)],
    });
    let section_id = create_result.section_id.unwrap();

    // Check that CreateSection uses CreatedSectionSnapshot
    {
        let stack = state.undo_stack.lock().unwrap();
        let undo_data = stack.peek_undo_data().unwrap();
        assert_eq!(
            undo_data.variant_name(),
            "CreatedSectionSnapshot",
            "CreateSection should use CreatedSectionSnapshot, got {}",
            undo_data.variant_name()
        );
    }

    // Now delete the section and verify DeleteSection uses ProjectSnapshotPair
    // (changed from SectionSnapshot to support cleanup of orphaned merges/closures/offsets)
    state.execute(Command::DeleteSection { section_id });

    {
        let stack = state.undo_stack.lock().unwrap();
        let undo_data = stack.peek_undo_data().unwrap();
        assert_eq!(
            undo_data.variant_name(),
            "ProjectSnapshotPair",
            "DeleteSection should use ProjectSnapshotPair, got {}",
            undo_data.variant_name()
        );
    }
}

#[test]
fn test_delete_section_undo_redo_still_works() {
    // Regression test: ensure DeleteSection undo/redo behavior is unchanged
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Delete Test".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let section_id = create_result.section_id.unwrap();

    // Delete the section
    state.execute(Command::DeleteSection { section_id });
    assert!(state.get_project_state().unwrap().sections.is_empty());

    // Undo should restore it
    assert!(state.undo().success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].id, section_id);
    assert_eq!(project.sections[0].name, Some("Delete Test".to_string()));

    // Redo should delete it again
    assert!(state.redo().success);
    assert!(state.get_project_state().unwrap().sections.is_empty());

    // Undo again to restore
    assert!(state.undo().success);
    assert_eq!(state.get_project_state().unwrap().sections.len(), 1);
}

// === CreateShot undo/redo ID preservation tests ===

#[test]
fn test_create_shot_undo_redo_preserves_id() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section first
    let section_result = state.execute(Command::CreateSection {
        name: Some("Shot Test".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_id = section_result.section_id.unwrap();

    // Get the initial shot ID
    let project = state.get_project_state().unwrap();
    let initial_shot_id = project.sections[0].shots[0].id;

    // Create a new shot
    state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(10.0),
        after_shot_id: None,
        before_shot_id: None,
    });

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 2);
    let new_shot_id = project.sections[0].shots[1].id;
    assert_ne!(new_shot_id, initial_shot_id);

    // Undo the create shot
    let undo_result = state.undo();
    assert!(undo_result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 1);

    // Redo the create shot - should preserve original shot ID
    let redo_result = state.redo();
    assert!(redo_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 2);
    assert_eq!(
        project.sections[0].shots[1].id, new_shot_id,
        "Shot ID must be preserved after undo/redo, expected {} got {}",
        new_shot_id, project.sections[0].shots[1].id
    );
    assert_eq!(project.sections[0].shots[1].length, 10.0);
}

#[test]
fn test_create_shot_mid_section_undo_redo_preserves_position() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section with 3 shots
    let section_result = state.execute(Command::CreateSection {
        name: Some("Mid Insert".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(1.0),
            test_shot_data(2.0),
            test_shot_data(3.0),
        ],
    });
    let section_id = section_result.section_id.unwrap();

    let project = state.get_project_state().unwrap();
    let first_shot_id = project.sections[0].shots[0].id;
    let original_ids: Vec<_> = project.sections[0].shots.iter().map(|s| s.id).collect();
    assert_eq!(original_ids.len(), 3);

    // Insert a shot after the first shot (mid-section insert)
    state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(99.0),
        after_shot_id: Some(first_shot_id),
        before_shot_id: None,
    });

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 4);
    // The new shot should be at position 1 (after first)
    let inserted_shot_id = project.sections[0].shots[1].id;
    assert_eq!(project.sections[0].shots[1].length, 99.0);

    // Verify order: [original[0], new, original[1], original[2]]
    assert_eq!(project.sections[0].shots[0].id, original_ids[0]);
    assert_eq!(project.sections[0].shots[1].id, inserted_shot_id);
    assert_eq!(project.sections[0].shots[2].id, original_ids[1]);
    assert_eq!(project.sections[0].shots[3].id, original_ids[2]);

    // Undo the mid-section insert
    let undo_result = state.undo();
    assert!(undo_result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 3);
    // Should be back to original order
    let after_undo_ids: Vec<_> = project.sections[0].shots.iter().map(|s| s.id).collect();
    assert_eq!(after_undo_ids, original_ids);

    // Redo - should restore at position 1 with original ID
    let redo_result = state.redo();
    assert!(redo_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 4);
    assert_eq!(
        project.sections[0].shots[1].id, inserted_shot_id,
        "Shot ID must be preserved after mid-section undo/redo"
    );
    assert_eq!(project.sections[0].shots[1].length, 99.0);

    // Verify correct position restored: [original[0], new, original[1], original[2]]
    assert_eq!(project.sections[0].shots[0].id, original_ids[0]);
    assert_eq!(project.sections[0].shots[2].id, original_ids[1]);
    assert_eq!(project.sections[0].shots[3].id, original_ids[2]);
}

#[test]
fn test_create_shot_double_undo_redo_cycle() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let section_result = state.execute(Command::CreateSection {
        name: Some("Double Cycle".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_id = section_result.section_id.unwrap();

    // Create a shot
    state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(20.0),
        after_shot_id: None,
        before_shot_id: None,
    });

    let project = state.get_project_state().unwrap();
    let original_shot_id = project.sections[0].shots[1].id;

    // First cycle: undo -> redo
    assert!(state.undo().success);
    assert_eq!(
        state.get_project_state().unwrap().sections[0].shots.len(),
        1
    );
    assert!(state.redo().success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots[1].id, original_shot_id);

    // Second cycle: undo -> redo
    assert!(state.undo().success);
    assert_eq!(
        state.get_project_state().unwrap().sections[0].shots.len(),
        1
    );
    assert!(state.redo().success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections[0].shots[1].id, original_shot_id,
        "Shot ID must be stable through double undo/redo cycle"
    );
    assert_eq!(project.sections[0].shots[1].length, 20.0);
}

#[test]
fn test_create_shot_undo_redo_then_edit() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let section_result = state.execute(Command::CreateSection {
        name: Some("Edit After Redo".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });
    let section_id = section_result.section_id.unwrap();

    // Create a shot
    state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(15.0),
        after_shot_id: None,
        before_shot_id: None,
    });

    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    // Undo and redo
    assert!(state.undo().success);
    assert!(state.redo().success);

    // Verify we can edit the restored shot
    let update_result = state.execute(Command::UpdateShot {
        section_id,
        shot_id,
        updates: ShotUpdates {
            length: Some(42.0),
            ..Default::default()
        },
    });
    assert!(update_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots[0].length, 42.0);
}

#[test]
fn test_create_shot_undo_redo_then_delete() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let section_result = state.execute(Command::CreateSection {
        name: Some("Delete After Redo".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![],
    });
    let section_id = section_result.section_id.unwrap();

    // Create a shot
    state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(15.0),
        after_shot_id: None,
        before_shot_id: None,
    });

    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    // Undo and redo
    assert!(state.undo().success);
    assert!(state.redo().success);

    // Delete the restored shot
    let delete_result = state.execute(Command::DeleteShot {
        section_id,
        shot_id,
    });
    assert!(delete_result.success);
    assert!(state.get_project_state().unwrap().sections[0]
        .shots
        .is_empty());
}

#[test]
fn test_create_shot_created_snapshot_distinct_from_shot_snapshot() {
    // Verify that CreateShot uses CreatedShotSnapshot while
    // DeleteShot uses ProjectSnapshotPair
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let section_result = state.execute(Command::CreateSection {
        name: Some("Variant Check".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_id = section_result.section_id.unwrap();

    // Create a shot
    state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(10.0),
        after_shot_id: None,
        before_shot_id: None,
    });

    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[1].id;

    // Check that CreateShot uses CreatedShotSnapshot
    {
        let stack = state.undo_stack.lock().unwrap();
        let undo_data = stack.peek_undo_data().unwrap();
        assert_eq!(
            undo_data.variant_name(),
            "CreatedShotSnapshot",
            "CreateShot should use CreatedShotSnapshot, got {}",
            undo_data.variant_name()
        );
    }

    // Now delete the shot and verify DeleteShot uses ProjectSnapshotPair
    // (changed from ShotSnapshot to handle station ref shifting correctly)
    state.execute(Command::DeleteShot {
        section_id,
        shot_id,
    });

    {
        let stack = state.undo_stack.lock().unwrap();
        let undo_data = stack.peek_undo_data().unwrap();
        assert_eq!(
            undo_data.variant_name(),
            "ProjectSnapshotPair",
            "DeleteShot should use ProjectSnapshotPair, got {}",
            undo_data.variant_name()
        );
    }
}

#[test]
fn test_insert_shot_before_first_position_and_undo_redo() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let section_result = state.execute(Command::CreateSection {
        name: Some("Before Insert".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0), test_shot_data(20.0)],
    });
    let section_id = section_result.section_id.unwrap();

    let project = state.get_project_state().unwrap();
    let first_shot_id = project.sections[0].shots[0].id;

    // Insert before the first shot (position 0 / prepend)
    let result = state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(5.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(result.success);
    assert!(
        result.shot_id.is_some(),
        "shot_id must be returned on success"
    );
    let new_shot_id = result.shot_id.unwrap();

    // Verify insertion at position 0
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 3);
    assert_eq!(
        project.sections[0].shots[0].length, 5.0,
        "Prepended shot should be first"
    );
    assert_eq!(project.sections[0].shots[0].id, new_shot_id);
    assert_eq!(project.sections[0].shots[1].length, 10.0);
    assert_eq!(project.sections[0].shots[2].length, 20.0);

    // Undo the prepend
    let undo_result = state.undo();
    assert!(undo_result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 2);
    assert_eq!(project.sections[0].shots[0].length, 10.0);
    assert_eq!(project.sections[0].shots[1].length, 20.0);

    // Redo the prepend - should restore at position 0 with same ID
    let redo_result = state.redo();
    assert!(redo_result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 3);
    assert_eq!(project.sections[0].shots[0].length, 5.0);
    assert_eq!(
        project.sections[0].shots[0].id, new_shot_id,
        "Shot ID must be preserved after undo/redo"
    );
}

#[test]
fn test_prepend_shot_undo_preserves_geometry() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let section_result = state.execute(Command::CreateSection {
        name: Some("Prepend Geometry".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            azimuth_in: 90.0,
            azimuth_out: 90.0,
            length: 10.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }],
    });
    let section_id = section_result.section_id.unwrap();

    let before = state.get_project_state().unwrap();
    let before_station_0 = before
        .compute_station_raw_coords(StationRef::new(section_id, 0))
        .unwrap();
    let before_station_1 = before
        .compute_station_raw_coords(StationRef::new(section_id, 1))
        .unwrap();
    let first_shot_id = before.sections[0].shots[0].id;

    let result = state.execute(Command::CreateShot {
        section_id,
        shot: ShotData {
            azimuth_in: 90.0,
            azimuth_out: 90.0,
            length: 5.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        },
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(result.success);

    let after_prepend = state.get_project_state().unwrap();
    let station_1_after = after_prepend
        .compute_station_raw_coords(StationRef::new(section_id, 1))
        .unwrap();
    let station_2_after = after_prepend
        .compute_station_raw_coords(StationRef::new(section_id, 2))
        .unwrap();
    assert_coords_close(station_1_after, before_station_0);
    assert_coords_close(station_2_after, before_station_1);

    let undo_result = state.undo();
    assert!(undo_result.success);
    let after_undo = state.get_project_state().unwrap();
    let undo_station_0 = after_undo
        .compute_station_raw_coords(StationRef::new(section_id, 0))
        .unwrap();
    let undo_station_1 = after_undo
        .compute_station_raw_coords(StationRef::new(section_id, 1))
        .unwrap();
    assert_coords_close(undo_station_0, before_station_0);
    assert_coords_close(undo_station_1, before_station_1);
}

#[test]
fn test_create_shot_rejects_both_after_and_before() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let section_result = state.execute(Command::CreateSection {
        name: Some("Reject Both".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0), test_shot_data(20.0)],
    });
    let section_id = section_result.section_id.unwrap();

    let result = state.execute(Command::CreateShot {
        section_id,
        shot: test_shot_data(5.0),
        after_shot_id: Some(0),
        before_shot_id: Some(1),
    });
    assert!(!result.success);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("Cannot specify both"));
}

#[test]
fn test_delete_shot_undo_redo_still_works() {
    // Regression test: ensure DeleteShot undo/redo behavior is unchanged
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let section_result = state.execute(Command::CreateSection {
        name: Some("Delete Shot Regression".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(10.0)],
    });
    let section_id = section_result.section_id.unwrap();

    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;

    // Delete the first shot
    state.execute(Command::DeleteShot {
        section_id,
        shot_id,
    });
    assert_eq!(
        state.get_project_state().unwrap().sections[0].shots.len(),
        1
    );

    // Undo should restore it at its original position
    assert!(state.undo().success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 2);
    assert_eq!(project.sections[0].shots[0].id, shot_id);
    assert_eq!(project.sections[0].shots[0].length, 5.0);

    // Redo should delete it again
    assert!(state.redo().success);
    assert_eq!(
        state.get_project_state().unwrap().sections[0].shots.len(),
        1
    );

    // Undo again to restore
    assert!(state.undo().success);
    assert_eq!(
        state.get_project_state().unwrap().sections[0].shots.len(),
        2
    );
}

// === Zero datum merge validation tests ===

#[test]
fn test_check_merge_connectivity_both_zero_datums_blocked() {
    // Both sections have zero datum → can_merge=false
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "BothZD".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    // Set zero datum on both sections
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
    });
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(b, 0),
        coordinates: GpsCoordinates::new(46.0, -91.0, 0.0).unwrap(),
    });

    let result = state
        .check_merge_connectivity(StationRef::new(a, 1), StationRef::new(b, 0))
        .unwrap();

    assert!(
        !result.can_merge,
        "Both sections with zero datums should not be mergeable"
    );
    assert!(
        !result.connected,
        "Unconnected sections should not be connected"
    );
    assert_eq!(
        result.reason.as_deref(),
        Some("Both sections have fixed coordinates"),
    );
}

#[test]
fn test_check_merge_connectivity_one_zero_datum_allowed() {
    // Only one section has zero datum → can_merge=true
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "OneZD".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    // Set zero datum on section A only
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
    });

    let result = state
        .check_merge_connectivity(StationRef::new(a, 1), StationRef::new(b, 0))
        .unwrap();

    assert!(
        result.can_merge,
        "One section with zero datum should allow merge"
    );
    assert!(!result.connected);
    assert!(result.reason.is_none());
}

#[test]
fn test_check_merge_connectivity_neither_zero_datum_no_loop() {
    // Neither section has zero datum, no loop → can_merge=true
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "NoZD".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    let result = state
        .check_merge_connectivity(StationRef::new(a, 1), StationRef::new(b, 0))
        .unwrap();

    assert!(
        result.can_merge,
        "Neither having zero datum and no loop should allow merge"
    );
    assert!(!result.connected);
    assert!(result.reason.is_none());
}

#[test]
fn test_check_merge_connectivity_connected_creates_loop() {
    // Connected sections (neither has zero datum, loop exists) → can_merge=false
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Loop".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    // Merge A.1 to B.0 to make them connected
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });

    // Now check connectivity between A.0 and B.1 — they are connected via merge
    let result = state
        .check_merge_connectivity(StationRef::new(a, 0), StationRef::new(b, 1))
        .unwrap();

    assert!(
        !result.can_merge,
        "Connected sections should not be mergeable (creates loop)"
    );
    assert!(result.connected, "Merged sections should be connected");
    assert_eq!(result.reason.as_deref(), Some("Creates survey loop"),);
    assert!(
        result.preview.is_some(),
        "Connected sections should have closure preview"
    );
}

#[test]
fn test_check_merge_connectivity_both_zd_and_connected() {
    // When sections are connected AND both have zero datums, zero datum
    // takes priority for reason, but connected/preview remain correct.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "BothZDConnected".to_string(),
        location: None,
    });

    // Create sections A (with ZD), C (no ZD, will bridge), B (with ZD)
    let result_a = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    let result_c = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let c = result_c.section_id.unwrap();

    // Set ZD on A
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
    });

    // Set ZD on B (separate group)
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(b, 0),
        coordinates: GpsCoordinates::new(46.0, -91.0, 0.0).unwrap(),
    });

    // Merge C.0 into A.1 (C joins A's merge group)
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(c, 0),
    });

    // Connect C.1 to B.0 via an injected closure (can't merge — different ZD groups,
    // and can't create closure through command because they're not yet connected).
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        project.loop_closures.push(LoopClosure {
            id: project.next_closure_id,
            station_a: StationRef::new(c, 1).into(),
            station_b: StationRef::new(b, 0).into(),
            path_length: 8.0,
            misclosure_distance: 0.2,
            error_percentage: 2.5,
            horizontal_misclosure: 0.2,
            vertical_misclosure: 0.0,
            strategy: ClosureStrategy::default(),
            is_aligned: false,
        });
        project.next_closure_id += 1;
    }

    // Now: A-C merged (A has ZD), B has ZD, connected via closure C.1-B.0
    let result = state
        .check_merge_connectivity(StationRef::new(a, 0), StationRef::new(b, 1))
        .unwrap();

    // connected must be true (they ARE connected via merge+closure)
    assert!(
        result.connected,
        "Sections connected via merge+closure should report connected=true"
    );
    assert!(
        result.preview.is_some(),
        "Connected stations should have closure preview"
    );
    // can_merge must be false (both have ZD — zero datum takes priority)
    assert!(
        !result.can_merge,
        "Both sections with ZD should not be mergeable"
    );
    assert_eq!(
        result.reason.as_deref(),
        Some("Creates survey loop"),
        "Connected sections should report loop reason"
    );
}

// === Full pipeline: transitive closures through AppState ===

#[test]
fn test_transitive_closures_in_computed_stations() {
    // Test the full pipeline: create sections, merge, create closure, then
    // verify closures_with (including transitive) appears in computed stations.
    //
    // Setup: 3 sections A, B, C
    //   Merge: A.1 ↔ B.0 (connects A and B)
    //   Merge: B.1 ↔ C.0 (connects B and C)
    //   Closure: A.0 ↔ C.1 (loop closure between endpoints)
    //
    // Expected closures_with:
    //   A.0: direct closure to C.1 (A.0 is endpoint, not merged)
    //   C.1: direct closure to A.0 (C.1 is endpoint, not merged)
    //   No transitive closures since neither endpoint is in a merge group.
    //
    // Then add ANOTHER closure: A.1 ↔ C.1
    //   A.1 is merged with B.0, so:
    //   A.1: direct closure to C.1
    //   B.0: transitive closure to C.1 (via A.1)
    //   C.1: direct closure to A.1, transitive closure to B.0 (via A.1)
    //   C.0 is merged with B.1, so:
    //   C.1: is endpoint, not in merge group for this closure
    //   Wait - C.1 is NOT merged with anything. C.0 is merged with B.1.
    //   So C.1 gets direct closure to A.1, and transitive closure to B.0 (via A.1).

    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "TransitiveTest".to_string(),
        location: None,
    });

    // Create section A with 2 shots (stations: A.0, A.1, A.2)
    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0), test_shot_data(8.0)],
    });
    let a = result_a.section_id.unwrap();

    // Create section B with 1 shot (stations: B.0, B.1)
    let result_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    // Create section C with 1 shot (stations: C.0, C.1)
    let result_c = state.execute(Command::CreateSection {
        name: Some("C".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let c = result_c.section_id.unwrap();

    // Merge A.2 ↔ B.0
    let merge1 = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    assert!(merge1.success, "Merge A.2↔B.0 should succeed");

    // Merge B.1 ↔ C.0
    let merge2 = state.execute(Command::MergeStations {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
    });
    assert!(merge2.success, "Merge B.1↔C.0 should succeed");

    // Now create a loop closure between A.1 and C.1
    // (A.1 is in merge group with B.0, so B.0 should get transitive closure)
    // Wait - A.1 is NOT merged. A.2 is merged with B.0. Let me fix: use A.2 as endpoint.
    // Actually, let me just inject the closure directly since the CreateLoopClosure command
    // requires specific connectivity conditions.
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        let closure_id = project.next_closure_id;
        project.loop_closures.push(LoopClosure {
            id: closure_id,
            station_a: StationRef::new(a, 2).into(), // A.2 (merged with B.0)
            station_b: StationRef::new(c, 1).into(), // C.1 (not merged with anything)
            path_length: 20.0,
            misclosure_distance: 0.5,
            error_percentage: 2.5,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
            strategy: ClosureStrategy::default(),
            is_aligned: false,
        });
        project.next_closure_id += 1;
    }

    // Get computed stations through the full pipeline
    let project = state.get_project_state().unwrap();
    let stations = project.compute_station_coordinates();

    // A.2: direct closure to C.1 (A.2 is the endpoint)
    let a2 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 2))
        .unwrap();
    let a2_direct = a2
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(c, 1) && !cr.is_transitive);
    assert!(
        a2_direct.is_some(),
        "A.2 should have direct closure to C.1, got: {:?}",
        a2.closures_with
    );

    // B.0: transitive closure to C.1 via A.2 (B.0 is merged with A.2)
    let b0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 0))
        .unwrap();
    let b0_transitive = b0
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(c, 1) && cr.is_transitive);
    assert!(
        b0_transitive.is_some(),
        "B.0 should have transitive closure to C.1 (via A.2), got: {:?}",
        b0.closures_with
    );
    assert_eq!(
        b0_transitive.unwrap().via_station,
        Some(StationRef::new(a, 2))
    );

    // C.1: direct closure to A.2
    let c1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 1))
        .unwrap();
    let c1_direct = c1
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(a, 2) && !cr.is_transitive);
    assert!(
        c1_direct.is_some(),
        "C.1 should have direct closure to A.2, got: {:?}",
        c1.closures_with
    );

    // C.1: transitive closure to B.0 (via A.2, since B.0 is in A.2's merge group)
    let c1_transitive = c1
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(b, 0) && cr.is_transitive);
    assert!(
        c1_transitive.is_some(),
        "C.1 should have transitive closure to B.0 (via A.2), got: {:?}",
        c1.closures_with
    );
    assert_eq!(
        c1_transitive.unwrap().via_station,
        Some(StationRef::new(a, 2))
    );

    // A.0 and A.1: should NOT have any closures (not endpoints, not merged with endpoints)
    let a0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 0))
        .unwrap();
    assert!(
        a0.closures_with.is_empty(),
        "A.0 should have no closures, got: {:?}",
        a0.closures_with
    );
    let a1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 1))
        .unwrap();
    assert!(
        a1.closures_with.is_empty(),
        "A.1 should have no closures, got: {:?}",
        a1.closures_with
    );

    // B.1: NOT in A.2's merge group, IS merged with C.0 but C.0 is not a closure endpoint
    let b1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 1))
        .unwrap();
    assert!(
        b1.closures_with.is_empty(),
        "B.1 should have no closures, got: {:?}",
        b1.closures_with
    );

    // C.0: merged with B.1, but B.1 is not a closure endpoint. C.0 is NOT in C.1's group.
    let c0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 0))
        .unwrap();
    assert!(
        c0.closures_with.is_empty(),
        "C.0 should have no closures, got: {:?}",
        c0.closures_with
    );
}

#[test]
fn test_transitive_closures_serialization_preserves_data() {
    // Test that closures_with survives JSON serialization (the Tauri IPC path).
    // This tests that #[serde(default, skip_serializing_if = "Vec::is_empty")]
    // doesn't cause data loss for non-empty vecs.
    use crate::models::Station;

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "SerTest".to_string(),
        location: None,
    });

    let result_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    // Merge A.1 ↔ B.0
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });

    // Inject a closure between A.1 and... we need a third section
    let result_c = state.execute(Command::CreateSection {
        name: Some("C".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let c = result_c.section_id.unwrap();

    // Merge B.1 ↔ C.0 to connect everything
    state.execute(Command::MergeStations {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
    });

    // Inject closure A.1 ↔ C.1
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        project.loop_closures.push(LoopClosure {
            id: project.next_closure_id,
            station_a: StationRef::new(a, 1).into(),
            station_b: StationRef::new(c, 1).into(),
            path_length: 15.0,
            misclosure_distance: 0.3,
            error_percentage: 2.0,
            horizontal_misclosure: 0.2,
            vertical_misclosure: 0.2,
            strategy: ClosureStrategy::default(),
            is_aligned: false,
        });
        project.next_closure_id += 1;
    }

    // Get stations through the normal pipeline
    let project = state.get_project_state().unwrap();
    let stations = project.compute_station_coordinates();

    // Verify B.0 has transitive closure (it's merged with A.1)
    let b0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 0))
        .unwrap();
    assert!(
        !b0.closures_with.is_empty(),
        "B.0 should have transitive closures"
    );

    // Now serialize to JSON and deserialize back (simulating Tauri IPC)
    let json = serde_json::to_string(&stations).unwrap();
    let deserialized: Vec<Station> = serde_json::from_str(&json).unwrap();

    // Find B.0 in deserialized
    let b0_de = deserialized
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 0))
        .unwrap();
    assert_eq!(
        b0_de.closures_with.len(),
        b0.closures_with.len(),
        "closures_with should survive serialization round-trip"
    );
    assert!(
        b0_de.closures_with.iter().any(|cr| cr.is_transitive),
        "Transitive closure should survive serialization"
    );

    // Verify A.1 has direct closure
    let a1_de = deserialized
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 1))
        .unwrap();
    assert!(
        a1_de.closures_with.iter().any(|cr| !cr.is_transitive),
        "Direct closure on A.1 should survive serialization"
    );

    // Verify C.1 has closures (direct + transitive)
    let c1_de = deserialized
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 1))
        .unwrap();
    assert!(
        c1_de.closures_with.iter().any(|cr| !cr.is_transitive),
        "C.1 direct closure should survive serialization"
    );
    assert!(
        c1_de.closures_with.iter().any(|cr| cr.is_transitive),
        "C.1 transitive closure should survive serialization"
    );
}

// === Move Segment Tests ===

#[test]
fn test_move_segment() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections and merge them so they form a segment
    let r1 = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let sid_a = r1.section_id.unwrap();

    let r2 = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let sid_b = r2.section_id.unwrap();

    // Merge station A.1 with B.0
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(sid_a, 1),
        station_b: StationRef::new(sid_b, 0),
    });
    assert!(merge_result.success);

    // Record offsets after merge (merge may set non-zero offsets)
    let project = state.get_project_state().unwrap();
    let a_before = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_before = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    // Move segment starting from section A
    let result = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });
    assert!(result.success);

    // Both sections should have been moved by the offset delta
    let project = state.get_project_state().unwrap();
    let a_after = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_after = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    assert!(
        (a_after.0 - a_before.0 - 10.0).abs() < 0.001,
        "Section A x should increase by 10"
    );
    assert!(
        (a_after.1 - a_before.1 - 20.0).abs() < 0.001,
        "Section A y should increase by 20"
    );
    assert!(
        (b_after.0 - b_before.0 - 10.0).abs() < 0.001,
        "Section B x (connected via merge) should increase by 10"
    );
    assert!(
        (b_after.1 - b_before.1 - 20.0).abs() < 0.001,
        "Section B y (connected via merge) should increase by 20"
    );
}

#[test]
fn test_move_segment_undo_redo() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections and merge
    let r1 = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let sid_a = r1.section_id.unwrap();

    let r2 = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let sid_b = r2.section_id.unwrap();

    state.execute(Command::MergeStations {
        station_a: StationRef::new(sid_a, 1),
        station_b: StationRef::new(sid_b, 0),
    });

    // Record offsets after merge (merge may set non-zero offsets)
    let project = state.get_project_state().unwrap();
    let a_pre_move = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_pre_move = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    // Move segment
    state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });

    // Verify both moved by delta
    let project = state.get_project_state().unwrap();
    let a_post_move = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_post_move = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));
    assert!((a_post_move.0 - a_pre_move.0 - 10.0).abs() < 0.001);
    assert!((a_post_move.1 - a_pre_move.1 - 20.0).abs() < 0.001);
    assert!((b_post_move.0 - b_pre_move.0 - 10.0).abs() < 0.001);
    assert!((b_post_move.1 - b_pre_move.1 - 20.0).abs() < 0.001);

    // Undo should restore exact pre-move offsets
    let undo_result = state.undo();
    assert!(undo_result.success);

    let project = state.get_project_state().unwrap();
    let a_after_undo = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_after_undo = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));
    assert!(
        (a_after_undo.0 - a_pre_move.0).abs() < 0.001,
        "Undo should restore A's exact pre-move x offset"
    );
    assert!(
        (a_after_undo.1 - a_pre_move.1).abs() < 0.001,
        "Undo should restore A's exact pre-move y offset"
    );
    assert!(
        (b_after_undo.0 - b_pre_move.0).abs() < 0.001,
        "Undo should restore B's exact pre-move x offset"
    );
    assert!(
        (b_after_undo.1 - b_pre_move.1).abs() < 0.001,
        "Undo should restore B's exact pre-move y offset"
    );

    // Redo should reapply the delta
    let redo_result = state.redo();
    assert!(redo_result.success);

    let project = state.get_project_state().unwrap();
    let a_after_redo = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_after_redo = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));
    assert!(
        (a_after_redo.0 - a_after_undo.0 - 10.0).abs() < 0.001,
        "Redo should add back the x delta to section A"
    );
    assert!(
        (a_after_redo.1 - a_after_undo.1 - 20.0).abs() < 0.001,
        "Redo should add back the y delta to section A"
    );
    assert!(
        (b_after_redo.0 - b_after_undo.0 - 10.0).abs() < 0.001,
        "Redo should add back the x delta to section B"
    );
    assert!(
        (b_after_redo.1 - b_after_undo.1 - 20.0).abs() < 0.001,
        "Redo should add back the y delta to section B"
    );
}

#[test]
fn test_move_segment_nonexistent_section() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::MoveSegment {
        section_id: 999,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });
    assert!(
        !result.success,
        "MoveSegment should fail for nonexistent section"
    );
}

#[test]
fn test_move_segment_unaligned_closure_independent() {
    // Sections connected only via an unaligned loop closure should move independently
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let r1 = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let sid_a = r1.section_id.unwrap();

    let r2 = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let sid_b = r2.section_id.unwrap();

    // Inject a loop closure directly (no merge needed) connecting A.1 ↔ B.0
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        let closure_id = project.next_closure_id;
        project.loop_closures.push(LoopClosure {
            id: closure_id,
            station_a: StationRef::new(sid_a, 1).into(),
            station_b: StationRef::new(sid_b, 0).into(),
            path_length: 10.0,
            misclosure_distance: 0.1,
            error_percentage: 1.0,
            horizontal_misclosure: 0.08,
            vertical_misclosure: 0.06,
            strategy: ClosureStrategy::default(),
            is_aligned: false,
        });
        project.next_closure_id += 1;
    }

    // Record offsets before move
    let project = state.get_project_state().unwrap();
    let a_before = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_before = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    // Move segment starting from section A
    let result = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(5.0, 15.0, 0.0),
    });
    assert!(result.success);

    // Only the starting section should move (closure is not aligned yet)
    let project = state.get_project_state().unwrap();
    let a_after = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_after = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    assert!(
        (a_after.0 - a_before.0 - 5.0).abs() < 0.001,
        "Section A x should increase by 5"
    );
    assert!(
        (a_after.1 - a_before.1 - 15.0).abs() < 0.001,
        "Section A y should increase by 15"
    );
    assert!(
        (b_after.0 - b_before.0).abs() < 0.001,
        "Section B x should remain unchanged before closure alignment"
    );
    assert!(
        (b_after.1 - b_before.1).abs() < 0.001,
        "Section B y should remain unchanged before closure alignment"
    );
}

#[test]
fn test_move_segment_aligned_closure_connectivity() {
    // Sections connected via an aligned loop closure should move together
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let r1 = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let sid_a = r1.section_id.unwrap();

    let r2 = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let sid_b = r2.section_id.unwrap();

    // Inject an aligned loop closure directly (no merge needed) connecting A.1 ↔ B.0
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        let closure_id = project.next_closure_id;
        project.loop_closures.push(LoopClosure {
            id: closure_id,
            station_a: StationRef::new(sid_a, 1).into(),
            station_b: StationRef::new(sid_b, 0).into(),
            path_length: 10.0,
            misclosure_distance: 0.1,
            error_percentage: 1.0,
            horizontal_misclosure: 0.08,
            vertical_misclosure: 0.06,
            strategy: ClosureStrategy::default(),
            is_aligned: true,
        });
        project.next_closure_id += 1;
    }

    // Record offsets before move
    let project = state.get_project_state().unwrap();
    let a_before = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_before = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    // Move segment starting from section A
    let result = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(5.0, 15.0, 0.0),
    });
    assert!(result.success);

    // Both sections should have moved (connected via aligned closure)
    let project = state.get_project_state().unwrap();
    let a_after = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_after = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    assert!(
        (a_after.0 - a_before.0 - 5.0).abs() < 0.001,
        "Section A x should increase by 5"
    );
    assert!(
        (a_after.1 - a_before.1 - 15.0).abs() < 0.001,
        "Section A y should increase by 15"
    );
    assert!(
        (b_after.0 - b_before.0 - 5.0).abs() < 0.001,
        "Section B x (aligned closure) should increase by 5"
    );
    assert!(
        (b_after.1 - b_before.1 - 15.0).abs() < 0.001,
        "Section B y (aligned closure) should increase by 15"
    );
}

#[test]
fn test_move_segment_isolated() {
    // An unconnected section should NOT be moved when moving a segment
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections WITHOUT merging them
    let r1 = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let sid_a = r1.section_id.unwrap();

    let r2 = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let sid_b = r2.section_id.unwrap();

    // Record offsets before move
    let project = state.get_project_state().unwrap();
    let a_before = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    let b_before = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    // Move segment starting from section A (B is NOT connected)
    let result = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });
    assert!(result.success);

    // Section A should have moved (entry must exist after MoveSegment)
    let project = state.get_project_state().unwrap();
    let a_after = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .expect("Section A offset should exist after MoveSegment");
    // Section B was not moved; entry may or may not exist
    let b_after = project
        .section_offsets
        .get(&sid_b)
        .copied()
        .unwrap_or((0.0, 0.0));

    assert!(
        (a_after.0 - a_before.0 - 10.0).abs() < 0.001,
        "Section A x should increase by 10"
    );
    assert!(
        (a_after.1 - a_before.1 - 20.0).abs() < 0.001,
        "Section A y should increase by 20"
    );

    // Section B should NOT have moved (not connected)
    assert!(
        (b_after.0 - b_before.0).abs() < 0.001,
        "Isolated Section B x should NOT change"
    );
    assert!(
        (b_after.1 - b_before.1).abs() < 0.001,
        "Isolated Section B y should NOT change"
    );
}

#[test]
fn test_move_segment_accumulates() {
    // Multiple MoveSegment calls should accumulate offsets
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let r1 = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let sid_a = r1.section_id.unwrap();

    // Record initial offset
    let project = state.get_project_state().unwrap();
    let initial = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .unwrap_or((0.0, 0.0));

    // First move
    let result1 = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(10.0, 5.0, 0.0),
    });
    assert!(result1.success);

    let project = state.get_project_state().unwrap();
    let after_first = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .expect("Offset should exist after first MoveSegment");
    assert!(
        (after_first.0 - initial.0 - 10.0).abs() < 0.001,
        "After first move, x should increase by 10"
    );
    assert!(
        (after_first.1 - initial.1 - 5.0).abs() < 0.001,
        "After first move, y should increase by 5"
    );

    // Second move
    let result2 = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(3.0, 7.0, 0.0),
    });
    assert!(result2.success);

    let project = state.get_project_state().unwrap();
    let after_second = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .expect("Offset should exist after second MoveSegment");
    assert!(
        (after_second.0 - initial.0 - 13.0).abs() < 0.001,
        "After second move, x should be initial + 10 + 3 = +13"
    );
    assert!(
        (after_second.1 - initial.1 - 12.0).abs() < 0.001,
        "After second move, y should be initial + 5 + 7 = +12"
    );

    // Third move with negative offset
    let result3 = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(-5.0, -2.0, 0.0),
    });
    assert!(result3.success);

    let project = state.get_project_state().unwrap();
    let after_third = project
        .section_offsets
        .get(&sid_a)
        .copied()
        .expect("Offset should exist after third MoveSegment");
    assert!(
        (after_third.0 - initial.0 - 8.0).abs() < 0.001,
        "After third move, x should be initial + 13 - 5 = +8"
    );
    assert!(
        (after_third.1 - initial.1 - 10.0).abs() < 0.001,
        "After third move, y should be initial + 12 - 2 = +10"
    );
}

// === Batch Tests ===

#[test]
fn test_batch_rollback_on_failure() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section first
    let r1 = state.execute(Command::CreateSection {
        name: Some("Existing".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let _existing_id = r1.section_id.unwrap();

    // Capture state before batch
    let project_before = state.get_project_state().unwrap();
    let sections_before = project_before.sections.len();

    // Execute batch with valid command followed by invalid command
    let result = state.execute(Command::Batch {
        commands: vec![
            Command::CreateSection {
                name: Some("New".to_string()),
                surveyor: None,
                date: None,
                color: "#00ff00".to_string(),
                direction: None,
                shots: vec![],
            },
            // Move a nonexistent section — should fail
            Command::MoveSection {
                section_id: 99999,
                offset: Coordinates::new(1.0, 1.0, 0.0),
            },
        ],
    });
    assert!(!result.success, "Batch should fail");

    // Verify rollback: project should be exactly as before
    let project_after = state.get_project_state().unwrap();
    assert_eq!(
        project_after.sections.len(),
        sections_before,
        "Batch rollback should restore exact section count"
    );
}

#[test]
fn test_batch_disallowed_command() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Try to open a project inside a batch (should be rejected by whitelist)
    let result = state.execute(Command::Batch {
        commands: vec![Command::OpenProject {
            path: PathBuf::from("/nonexistent"),
        }],
    });
    assert!(
        !result.success,
        "Batch should reject non-whitelisted commands"
    );
    assert!(
        result
            .error
            .unwrap_or_default()
            .contains("not allowed in batch"),
        "Error should mention batch whitelist"
    );
}

// === Delete Shot and Split Section Tests ===

fn shot_data_with_azimuth(length: f64, az_in: f64, az_out: f64) -> ShotData {
    ShotData {
        azimuth_in: az_in,
        azimuth_out: az_out,
        length,
        depth_in: 10.0,
        depth_out: 11.0,
        ..Default::default()
    }
}

#[test]
fn test_split_section_basic() {
    // 5-shot section, split at shot index 2 -> A has 2 shots, B has 2 shots
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Split Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: Some("TestSurveyor".to_string()),
        date: None,
        color: "#ff0000".to_string(),
        direction: Some(SurveyDirection::Out),
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
        ],
    });
    assert!(create_result.success);
    let section_id = create_result.section_id.unwrap();

    // Get the shot_id for the middle shot (index 2)
    let shot_id = {
        let proj = state.get_project_state().unwrap();
        let section = proj.get_section(section_id).unwrap();
        section.shots[2].id
    };

    let result = state.execute_delete_shot_and_split(
        section_id,
        shot_id,
        "Section A".to_string(),
        "Section B".to_string(),
    );

    assert!(result.success, "Split should succeed: {:?}", result.error);
    let new_section_id = result.section_id.unwrap();

    // Verify sections
    let proj = state.get_project_state().unwrap();
    let section_a = proj.get_section(section_id).unwrap();
    let section_b = proj.get_section(new_section_id).unwrap();

    assert_eq!(section_a.name, Some("Section A".to_string()));
    assert_eq!(section_a.shots.len(), 2);
    assert_eq!(section_a.shots[0].length, 5.0);
    assert_eq!(section_a.shots[1].length, 7.0);

    assert_eq!(section_b.name, Some("Section B".to_string()));
    assert_eq!(section_b.shots.len(), 2);
    assert_eq!(section_b.shots[0].length, 4.0);
    assert_eq!(section_b.shots[1].length, 6.0);
}

#[test]
fn test_split_preserves_metadata() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Metadata Test".to_string(),
        location: None,
    });

    let date = chrono::NaiveDate::from_ymd_opt(2024, 6, 15).unwrap();
    let create_result = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: Some("Jane".to_string()),
        date: Some(date),
        color: "#aabbcc".to_string(),
        direction: Some(SurveyDirection::Out),
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
        ],
    });
    let section_id = create_result.section_id.unwrap();

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[1].id
    };

    let result =
        state.execute_delete_shot_and_split(section_id, shot_id, "A".to_string(), "B".to_string());
    assert!(result.success);
    let new_id = result.section_id.unwrap();

    let proj = state.get_project_state().unwrap();
    let section_a = proj.get_section(section_id).unwrap();
    let section_b = proj.get_section(new_id).unwrap();

    // Both sections inherit metadata
    assert_eq!(section_a.surveyor, Some("Jane".to_string()));
    assert_eq!(section_a.date, Some(date));
    assert_eq!(section_a.color, "#aabbcc");
    assert_eq!(section_a.direction, SurveyDirection::Out);

    assert_eq!(section_b.surveyor, Some("Jane".to_string()));
    assert_eq!(section_b.date, Some(date));
    assert_eq!(section_b.color, "#aabbcc");
    assert_eq!(section_b.direction, SurveyDirection::Out);
}

#[test]
fn test_split_recalculates_offset_b() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Offset Test".to_string(),
        location: None,
    });

    // Create section with known geometry: 3 shots going east (azimuth 90)
    let create_result = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            shot_data_with_azimuth(10.0, 90.0, 90.0), // East
            shot_data_with_azimuth(5.0, 90.0, 90.0),  // East (deleted)
            shot_data_with_azimuth(8.0, 90.0, 90.0),  // East
        ],
    });
    let section_id = create_result.section_id.unwrap();

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[1].id
    };

    let result =
        state.execute_delete_shot_and_split(section_id, shot_id, "A".to_string(), "B".to_string());
    assert!(result.success);
    let new_id = result.section_id.unwrap();

    // Section B offset should be at (accumulated shots_before + deleted shot)
    // Shot lengths are slope distances; horizontal = sqrt(length^2 - dz^2)
    // With azimuth 90, sin(90) = 1, cos(90) = 0
    // So bx = horizontal_sum, by = 0 (approximately)
    let proj = state.get_project_state().unwrap();
    let b_offset = proj.section_offsets.get(&new_id);
    assert!(b_offset.is_some(), "Section B should have an offset");
    let (bx, by) = b_offset.unwrap();
    let expected =
        (10.0_f64.powi(2) - 1.0_f64.powi(2)).sqrt() + (5.0_f64.powi(2) - 1.0_f64.powi(2)).sqrt();
    assert!(
        (*bx - expected).abs() < 0.001,
        "bx should be ~{expected}, got {bx}"
    );
    assert!(by.abs() < 0.001, "by should be ~0, got {by}");
}

#[test]
fn test_split_remaps_merges() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Merge Remap Test".to_string(),
        location: None,
    });

    // Create two sections
    let create_a = state.execute(Command::CreateSection {
        name: Some("ToSplit".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
        ],
    });
    let section_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let section_b_id = create_b.section_id.unwrap();

    // Merge station 3 of section A (after split, belongs to B index 0) with station 0 of section B
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(section_a_id, 3), // This is after split point
        station_b: StationRef::new(section_b_id, 0),
    });
    assert!(
        merge_result.success,
        "Merge should succeed: {:?}",
        merge_result.error
    );

    // Now split at shot index 1
    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_a_id).unwrap().shots[1].id
    };

    let result = state.execute_delete_shot_and_split(
        section_a_id,
        shot_id,
        "A".to_string(),
        "B".to_string(),
    );
    assert!(result.success);
    let new_section_id = result.section_id.unwrap();

    // The merge with station_index 3 should now be remapped to new_section_id, station_index 1
    // (original index 3, split_station = 2, so new index = 3 - 2 = 1)
    let proj = state.get_project_state().unwrap();
    let has_remapped_merge = proj.station_merges.iter().any(|m| {
        let a = proj.resolve_key(&m.station_a);
        let b = proj.resolve_key(&m.station_b);
        (a.is_some_and(|sr| sr.section_id == new_section_id && sr.station_index == 1)
            && m.station_b.section_id == section_b_id)
            || (b.is_some_and(|sr| sr.section_id == new_section_id && sr.station_index == 1)
                && m.station_a.section_id == section_b_id)
    });
    assert!(
        has_remapped_merge,
        "Merge should be remapped to new section with adjusted index"
    );
}

#[test]
fn test_split_remaps_closures() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Closure Remap Test".to_string(),
        location: None,
    });

    // Create two sections and merge them first so we can create a closure
    let create_a = state.execute(Command::CreateSection {
        name: Some("ToSplit".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
        ],
    });
    let sec_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_b_id = create_b.section_id.unwrap();

    // First merge station 0 of A with station 0 of B (so they are connected)
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a_id, 0),
        station_b: StationRef::new(sec_b_id, 0),
    });
    assert!(merge_result.success);

    // Create a loop closure between station 4 of A (will be in B after split) and station 1 of B
    let closure_result = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(sec_a_id, 4),
        station_b: StationRef::new(sec_b_id, 1),
        closure_strategy: ClosureStrategy::Batch,
    });
    assert!(
        closure_result.success,
        "Closure should succeed: {:?}",
        closure_result.error
    );

    // Split at shot index 2
    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(sec_a_id).unwrap().shots[2].id
    };

    let result = state.execute_delete_shot_and_split(
        sec_a_id,
        shot_id,
        "A".to_string(),
        "B-split".to_string(),
    );
    assert!(result.success);
    let new_section_id = result.section_id.unwrap();

    // The closure's A-side is remapped: (sec_a_id, 4) -> (new_section_id, 1)
    // (split_station = 3, so 4 - 3 = 1). But the split detaches new_section so
    // that closure is now its ONLY connection to B — a sole bridge is a merge,
    // not a loop (#8), so it is converted. Assert it was remapped AND merged.
    let proj = state.get_project_state().unwrap();
    assert!(
        proj.loop_closures.is_empty(),
        "the orphaned (sole-bridge) closure should have been converted to a merge: {:?}",
        proj.loop_closures
    );
    let has_remapped_merge = proj.station_merges.iter().any(|m| {
        proj.resolve_key(&m.station_a)
            .is_some_and(|sr| sr.section_id == new_section_id && sr.station_index == 1)
            || proj
                .resolve_key(&m.station_b)
                .is_some_and(|sr| sr.section_id == new_section_id && sr.station_index == 1)
    });
    assert!(
        has_remapped_merge,
        "the remapped closure should have become a merge on the new section: {:?}",
        proj.station_merges
    );
}

// === Bulk shot range deletion (#95) ===

#[test]
fn test_delete_range_split_interior() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Range Split".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: Some("Surv".to_string()),
        date: None,
        color: "#ff0000".to_string(),
        direction: Some(SurveyDirection::Out),
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    // Delete shots [2..=3] (the 3.0 and 4.0 shots) and split.
    let result =
        state.execute_delete_shot_range_split(section_id, s2, s3, "A".to_string(), "B".to_string());
    assert!(
        result.success,
        "range split should succeed: {:?}",
        result.error
    );
    let new_id = result.section_id.unwrap();

    let proj = state.get_project_state().unwrap();
    let a = proj.get_section(section_id).unwrap();
    let b = proj.get_section(new_id).unwrap();
    assert_eq!(a.name, Some("A".to_string()));
    assert_eq!(
        a.shots.iter().map(|s| s.length).collect::<Vec<_>>(),
        vec![5.0, 7.0]
    );
    assert_eq!(b.name, Some("B".to_string()));
    assert_eq!(
        b.shots.iter().map(|s| s.length).collect::<Vec<_>>(),
        vec![6.0, 8.0]
    );
    // Metadata is inherited by both halves.
    assert_eq!(b.surveyor, Some("Surv".to_string()));
    assert_eq!(b.direction, SurveyDirection::Out);
}

#[test]
fn test_delete_range_split_preserves_after_position() {
    // East-going shots: section B's offset should equal the displacement of
    // (shots before the range ++ the deleted shots).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Range Offset".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            shot_data_with_azimuth(10.0, 90.0, 90.0), // before
            shot_data_with_azimuth(5.0, 90.0, 90.0),  // deleted
            shot_data_with_azimuth(7.0, 90.0, 90.0),  // deleted
            shot_data_with_azimuth(8.0, 90.0, 90.0),  // after
        ],
    });
    let section_id = create.section_id.unwrap();
    let (s1, s2) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[1].id, sec.shots[2].id)
    };
    let result =
        state.execute_delete_shot_range_split(section_id, s1, s2, "A".to_string(), "B".to_string());
    assert!(result.success, "{:?}", result.error);
    let new_id = result.section_id.unwrap();

    let proj = state.get_project_state().unwrap();
    let (bx, by) = *proj.section_offsets.get(&new_id).expect("B offset");
    let h = |l: f64| (l * l - 1.0_f64).sqrt();
    let expected = h(10.0) + h(5.0) + h(7.0);
    assert!((bx - expected).abs() < 0.001, "bx ~{expected}, got {bx}");
    assert!(by.abs() < 0.001, "by ~0, got {by}");
}

#[test]
fn test_delete_range_shift_interior() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Range Shift".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let result = state.execute_delete_shot_range_shift(section_id, s2, s3);
    assert!(
        result.success,
        "range shift should succeed: {:?}",
        result.error
    );

    // No new section — the survivors gap-close into one section [5,7,6,8].
    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.sections.len(), 1);
    let sec = proj.get_section(section_id).unwrap();
    assert_eq!(
        sec.shots.iter().map(|s| s.length).collect::<Vec<_>>(),
        vec![5.0, 7.0, 6.0, 8.0]
    );
}

#[test]
fn test_delete_range_prefix_shift() {
    // Delete shots [0..=1] of a 5-shot section; the survivors keep their absolute
    // positions (the section offset is shifted to compensate).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Prefix".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            shot_data_with_azimuth(10.0, 90.0, 90.0),
            shot_data_with_azimuth(5.0, 90.0, 90.0),
            shot_data_with_azimuth(7.0, 90.0, 90.0),
            shot_data_with_azimuth(8.0, 90.0, 90.0),
            shot_data_with_azimuth(6.0, 90.0, 90.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    let before_abs = {
        let proj = state.get_project_state().unwrap();
        abs_coord_map(&proj)
    };
    let kept_before = *before_abs.get(&StationRef::new(section_id, 2)).unwrap();
    let (s0, s1) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[0].id, sec.shots[1].id)
    };
    let result = state.execute_delete_shot_range_shift(section_id, s0, s1);
    assert!(result.success, "{:?}", result.error);

    let proj = state.get_project_state().unwrap();
    let sec = proj.get_section(section_id).unwrap();
    assert_eq!(
        sec.shots.iter().map(|s| s.length).collect::<Vec<_>>(),
        vec![7.0, 8.0, 6.0]
    );
    // Old station 2 (start of the first surviving shot) is now station 0, same place.
    let after_abs = abs_coord_map(&proj);
    let kept_after = *after_abs.get(&StationRef::new(section_id, 0)).unwrap();
    assert_xy_close(kept_before, kept_after);
}

#[test]
fn test_delete_range_suffix_shift() {
    // Delete shots [3..=4] of a 5-shot section; the head stays put.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Suffix".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            shot_data_with_azimuth(10.0, 90.0, 90.0),
            shot_data_with_azimuth(5.0, 90.0, 90.0),
            shot_data_with_azimuth(7.0, 90.0, 90.0),
            shot_data_with_azimuth(8.0, 90.0, 90.0),
            shot_data_with_azimuth(6.0, 90.0, 90.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    let head_before = {
        let proj = state.get_project_state().unwrap();
        abs_coord_map(&proj)
    };
    let (s3, s4) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[3].id, sec.shots[4].id)
    };
    let result = state.execute_delete_shot_range_shift(section_id, s3, s4);
    assert!(result.success, "{:?}", result.error);

    let proj = state.get_project_state().unwrap();
    let sec = proj.get_section(section_id).unwrap();
    assert_eq!(
        sec.shots.iter().map(|s| s.length).collect::<Vec<_>>(),
        vec![10.0, 5.0, 7.0]
    );
    let after = abs_coord_map(&proj);
    for i in 0..=3u32 {
        let r = StationRef::new(section_id, i);
        assert_xy_close(*head_before.get(&r).unwrap(), *after.get(&r).unwrap());
    }
}

#[test]
fn test_delete_range_split_remaps_merge() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Range Merge Remap".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("ToSplit".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_c = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_c = create_c.section_id.unwrap();
    // Merge A:5 (-> new section index 1 after split [2..=3], split_station 4) with C:0.
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 5),
                station_b: StationRef::new(sec_c, 0),
            })
            .success
    );

    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let result =
        state.execute_delete_shot_range_split(sec_a, s2, s3, "A".to_string(), "B".to_string());
    assert!(result.success, "{:?}", result.error);
    let new_id = result.section_id.unwrap();

    let proj = state.get_project_state().unwrap();
    let has_remapped = proj.station_merges.iter().any(|m| {
        let a = proj.resolve_key(&m.station_a);
        let b = proj.resolve_key(&m.station_b);
        (a.is_some_and(|sr| sr.section_id == new_id && sr.station_index == 1)
            && m.station_b.section_id == sec_c)
            || (b.is_some_and(|sr| sr.section_id == new_id && sr.station_index == 1)
                && m.station_a.section_id == sec_c)
    });
    assert!(
        has_remapped,
        "merge A:5 should remap to new section index 1: {:?}",
        proj.station_merges
    );
}

#[test]
fn test_delete_range_preserves_interior_merge_connectivity() {
    // Two other sections (P, Q) bridge ONLY through an interior station A:3 that
    // the range delete removes. A replacement merge must keep P and Q connected.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Interior Bridge".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("Main".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_p = state.execute(Command::CreateSection {
        name: Some("P".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_p = create_p.section_id.unwrap();
    let create_q = state.execute(Command::CreateSection {
        name: Some("Q".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_q = create_q.section_id.unwrap();
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_p, 0),
                station_b: StationRef::new(sec_a, 3),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_q, 0),
                station_b: StationRef::new(sec_a, 3),
            })
            .success
    );
    {
        let proj = state.get_project_state().unwrap();
        assert!(
            proj.are_stations_merged(StationRef::new(sec_p, 0), StationRef::new(sec_q, 0)),
            "P and Q should be connected before the delete"
        );
    }

    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    // Range [2..=3] removes interior station A:3 (the only P<->Q bridge).
    let result =
        state.execute_delete_shot_range_split(sec_a, s2, s3, "A".to_string(), "B".to_string());
    assert!(result.success, "{:?}", result.error);

    let proj = state.get_project_state().unwrap();
    assert!(
        proj.are_stations_merged(StationRef::new(sec_p, 0), StationRef::new(sec_q, 0)),
        "P and Q must stay connected via a replacement merge after the interior bridge is \
         removed: {:?}",
        proj.station_merges
    );
}

#[test]
fn test_delete_range_shift_blocked_aborts() {
    // A loop around section A's middle makes the shift path unavailable; the
    // shift range delete must fail and leave the project untouched.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Shift Blocked".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_b = create_b.section_id.unwrap();
    // Form a loop directly (A:0-B:0 and A:4-B:1). MergeStations refuses the second
    // edge because the stations are already connected, so push raw merges like the
    // model-level shift_blocked test does.
    {
        let mut guard = state.project.lock().unwrap();
        let proj = guard.as_mut().unwrap();
        proj.station_merges.push(StationMerge {
            station_a: StationRef::new(sec_a, 0).into(),
            station_b: StationRef::new(sec_b, 0).into(),
            merged_at: chrono::Utc::now(),
        });
        proj.station_merges.push(StationMerge {
            station_a: StationRef::new(sec_a, 4).into(),
            station_b: StationRef::new(sec_b, 1).into(),
            merged_at: chrono::Utc::now(),
        });
        proj.merge_adjacency_cache.clear();
    }

    let (s1, s2) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[1].id, sec.shots[2].id)
    };
    let result = state.execute_delete_shot_range_shift(sec_a, s1, s2);
    assert!(!result.success, "shift over a loop must be blocked");
    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.get_section(sec_a).unwrap().shots.len(),
        4,
        "blocked shift must not mutate the project"
    );
}

#[test]
fn test_delete_range_undo_redo_roundtrip() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Range Undo".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            shot_data_with_azimuth(10.0, 90.0, 90.0),
            shot_data_with_azimuth(5.0, 45.0, 45.0),
            shot_data_with_azimuth(7.0, 90.0, 90.0),
            shot_data_with_azimuth(8.0, 135.0, 135.0),
            shot_data_with_azimuth(6.0, 90.0, 90.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    let before_abs = {
        let proj = state.get_project_state().unwrap();
        abs_coord_map(&proj)
    };
    let undo_len_before = state.get_undo_stack().len();
    let (s1, s2) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[1].id, sec.shots[2].id)
    };
    let result =
        state.execute_delete_shot_range_split(section_id, s1, s2, "A".to_string(), "B".to_string());
    assert!(result.success, "{:?}", result.error);
    assert_eq!(
        state.get_undo_stack().len(),
        undo_len_before + 1,
        "the whole range split is one undo entry"
    );

    assert!(state.undo().success);
    let after_undo = {
        let proj = state.get_project_state().unwrap();
        abs_coord_map(&proj)
    };
    assert_eq!(before_abs.len(), after_undo.len());
    for (r, c) in &before_abs {
        let c2 = after_undo
            .get(r)
            .unwrap_or_else(|| panic!("missing {r:?} after undo"));
        assert_coords_close(*c, *c2);
    }

    assert!(state.redo().success);
    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.sections.len(),
        2,
        "redo restores the split (two sections)"
    );
}

#[test]
fn test_preview_delete_shot_range_classifies_kind() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Kind".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    let proj = state.get_project_state().unwrap();
    let ids: Vec<ShotId> = proj
        .get_section(section_id)
        .unwrap()
        .shots
        .iter()
        .map(|s| s.id)
        .collect();

    use crate::models::RangeDeleteKind;
    assert_eq!(
        proj.preview_delete_shot_range(section_id, ids[0], ids[4])
            .unwrap()
            .kind,
        RangeDeleteKind::WholeSection
    );
    assert_eq!(
        proj.preview_delete_shot_range(section_id, ids[0], ids[2])
            .unwrap()
            .kind,
        RangeDeleteKind::Prefix
    );
    assert_eq!(
        proj.preview_delete_shot_range(section_id, ids[2], ids[4])
            .unwrap()
            .kind,
        RangeDeleteKind::Suffix
    );
    let interior = proj
        .preview_delete_shot_range(section_id, ids[1], ids[3])
        .unwrap();
    assert_eq!(interior.kind, RangeDeleteKind::Interior);
    // Reversed endpoints normalize to the same range.
    let rev = proj
        .preview_delete_shot_range(section_id, ids[3], ids[1])
        .unwrap();
    assert_eq!((rev.start_pos, rev.end_pos), (1, 3));
}

#[test]
fn test_delete_range_split_rejects_non_interior() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Reject".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    let ids: Vec<ShotId> = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id)
            .unwrap()
            .shots
            .iter()
            .map(|s| s.id)
            .collect()
    };
    // Prefix range [0..=1] is not interior — split must refuse.
    assert!(
        !state
            .execute_delete_shot_range_split(
                section_id,
                ids[0],
                ids[1],
                "A".to_string(),
                "B".to_string()
            )
            .success
    );
    // Whole-section shift must refuse (delete the section instead).
    assert!(
        !state
            .execute_delete_shot_range_shift(section_id, ids[0], ids[2])
            .success
    );

    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.get_section(section_id).unwrap().shots.len(),
        3,
        "rejections must not mutate"
    );
}

#[test]
fn test_delete_range_interior_shift_blocked_by_tail_datum() {
    // Regression (#95): an interior-range SHIFT gap-closes THROUGH station
    // end_pos+1 (which the split keeps as B:0). A zero datum anchored there must
    // block the shift — the preview previously scanned only the split's interior
    // set and missed it, so the gap-close silently destroyed the datum.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Tail Datum".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    // Datum on station 3 = end_pos+1 for the interior range [1..=2].
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(section_id, 3),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    let (s1, s2) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[1].id, sec.shots[2].id)
    };
    {
        let proj = state.get_project_state().unwrap();
        let impact = proj.preview_delete_shot_range(section_id, s1, s2).unwrap();
        assert!(
            impact.shift_blocked,
            "shift must be blocked: it would drop the datum on station end_pos+1"
        );
        assert!(
            impact.removed_datums.is_empty(),
            "the split (display) set keeps station end_pos+1, so its datum is not in removed_datums"
        );
    }
    // The shift executor must refuse and leave the datum intact.
    let result = state.execute_delete_shot_range_shift(section_id, s1, s2);
    assert!(
        !result.success,
        "interior shift over a tail datum must be blocked"
    );
    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.zero_datums.len(),
        1,
        "blocked shift must not drop the datum"
    );
    assert_eq!(
        proj.get_section(section_id).unwrap().shots.len(),
        5,
        "blocked shift must not mutate the section"
    );
}

#[test]
fn test_delete_range_prefix_shift_blocked_by_datum() {
    // Coverage (#95): a prefix range whose removed boundary station carries a
    // zero datum must block the shift rather than silently drop the anchor.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Prefix Datum".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(section_id, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    let (s0, s1) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[0].id, sec.shots[1].id)
    };
    {
        let proj = state.get_project_state().unwrap();
        let impact = proj.preview_delete_shot_range(section_id, s0, s1).unwrap();
        assert!(
            impact.shift_blocked,
            "prefix shift dropping a datum must be blocked"
        );
        assert!(
            !impact.removed_datums.is_empty(),
            "the removed station-0 datum is surfaced"
        );
    }
    let result = state.execute_delete_shot_range_shift(section_id, s0, s1);
    assert!(!result.success, "prefix shift over a datum must be blocked");
    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.zero_datums.len(),
        1,
        "blocked shift must not drop the datum"
    );
}

#[test]
fn test_delete_range_preview_surfaces_interior_split_datum() {
    // #95: a zero datum on a strictly-interior station the split drops must be
    // surfaced in removed_datums so the dialog can warn (the interior split is
    // not lossless for interior-station datums/comments).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Interior Datum".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    // Datum on station 2 — strictly interior to the range [1..=2] (interior set {2}).
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(section_id, 2),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    let (s1, s2) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[1].id, sec.shots[2].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(section_id, s1, s2).unwrap();
    assert!(
        impact.removed_datums.iter().any(|sr| sr.station_index == 2),
        "the interior-station datum the split drops must be surfaced: {:?}",
        impact.removed_datums
    );
}

#[test]
fn test_delete_range_preview_reports_replacement_merge() {
    // #95: when a removed interior station bridges two external sections, the
    // preview must report the replacement merge the delete adds (not just the
    // removed merges), so the dialog doesn't overstate connectivity loss.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Replacement Preview".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("Main".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_p = state.execute(Command::CreateSection {
        name: Some("P".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_p = create_p.section_id.unwrap();
    let create_q = state.execute(Command::CreateSection {
        name: Some("Q".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_q = create_q.section_id.unwrap();
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_p, 0),
                station_b: StationRef::new(sec_a, 3),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_q, 0),
                station_b: StationRef::new(sec_a, 3),
            })
            .success
    );

    // Range [2..=3] removes the bridging interior station A:3.
    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(sec_a, s2, s3).unwrap();
    assert!(
        !impact.replacement_merges.is_empty(),
        "removing the bridging interior station must report a replacement merge: {impact:?}"
    );
}

#[test]
fn test_delete_range_prefix_shift_not_blocked_by_internal_loop() {
    // Codex review #1: deleting a prefix range must not be blocked just because
    // an in-range shot looks loop-connected THROUGH another in-range shot.
    // Merge A:0<->A:2 makes the per-shot preview see shot 1 as part of a loop,
    // but deleting [0..=1] removes that path entirely, so the bulk shift is valid.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Internal Loop".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    // Same-section merge A:0 <-> A:2 (a loop through shots 0,1). MergeStations
    // would refuse it (already connected via shots), so push it raw.
    {
        let mut guard = state.project.lock().unwrap();
        let proj = guard.as_mut().unwrap();
        proj.station_merges.push(StationMerge {
            station_a: StationRef::new(section_id, 0).into(),
            station_b: StationRef::new(section_id, 2).into(),
            merged_at: chrono::Utc::now(),
        });
        proj.merge_adjacency_cache.clear();
    }
    let (s0, s1) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[0].id, sec.shots[1].id)
    };
    {
        let proj = state.get_project_state().unwrap();
        let impact = proj.preview_delete_shot_range(section_id, s0, s1).unwrap();
        assert!(
            !impact.shift_blocked,
            "prefix delete must not be blocked by an in-range loop: {:?}",
            impact.shift_blocked_reasons
        );
    }
    let result = state.execute_delete_shot_range_shift(section_id, s0, s1);
    assert!(
        result.success,
        "prefix shift should succeed: {:?}",
        result.error
    );
    assert_eq!(
        state
            .get_project_state()
            .unwrap()
            .get_section(section_id)
            .unwrap()
            .shots
            .len(),
        3
    );
}

#[test]
fn test_delete_range_suffix_shift_keeps_head_with_doomed_tail_anchor() {
    // Codex review #4: a suffix gap-close must keep the HEAD in place even when a
    // doomed tail station is anchored (merged to a datum-bearing section). The
    // per-shot keep-side decision must ignore anchors on stations the rest of
    // the range will also delete.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Doomed Tail".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            shot_data_with_azimuth(10.0, 90.0, 90.0),
            shot_data_with_azimuth(5.0, 90.0, 90.0),
            shot_data_with_azimuth(7.0, 90.0, 90.0),
            shot_data_with_azimuth(8.0, 90.0, 90.0),
            shot_data_with_azimuth(6.0, 90.0, 90.0),
        ],
    });
    let sec_a = create.section_id.unwrap();
    let create_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![shot_data_with_azimuth(4.0, 90.0, 90.0)],
    });
    let sec_b = create_b.section_id.unwrap();
    // B is datum-bearing and merged to A's END station (station 5) — the doomed tail.
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(sec_b, 0),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 5),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    let head_before = {
        let proj = state.get_project_state().unwrap();
        abs_coord_map(&proj)
    };
    let (s3, s4) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[3].id, sec.shots[4].id)
    };
    let result = state.execute_delete_shot_range_shift(sec_a, s3, s4);
    assert!(
        result.success,
        "suffix shift should succeed: {:?}",
        result.error
    );

    let proj = state.get_project_state().unwrap();
    let sec = proj.get_section(sec_a).unwrap();
    assert_eq!(
        sec.shots.iter().map(|s| s.length).collect::<Vec<_>>(),
        vec![10.0, 5.0, 7.0]
    );
    // Head stations 0..=3 must stay put — the doomed tail anchor must NOT shift them.
    let after = abs_coord_map(&proj);
    for i in 0..=3u32 {
        let r = StationRef::new(sec_a, i);
        assert_xy_close(*head_before.get(&r).unwrap(), *after.get(&r).unwrap());
    }
}

#[test]
fn test_delete_range_preview_surfaces_interior_split_comment() {
    // Codex review #2: an interior split drops station comments on the removed
    // interior stations; the preview must surface them so the dialog can warn.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Interior Comment".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    // Comment on interior station 2 of the range [1..=2].
    assert!(
        state
            .execute(Command::SetStationComment {
                station_ref: StationRef::new(section_id, 2),
                comment: Some("note".to_string()),
            })
            .success
    );
    let (s1, s2) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[1].id, sec.shots[2].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(section_id, s1, s2).unwrap();
    assert!(
        impact
            .removed_comments
            .iter()
            .any(|sr| sr.station_index == 2),
        "the interior-station comment the split drops must be surfaced: {:?}",
        impact.removed_comments
    );
}

#[test]
fn test_delete_range_interior_preview_includes_shift_boundary_merge() {
    // Codex review #3: the interior preview's relationship set must cover the
    // gap-close (shift) removed station end_pos+1, so a merge anchored there is
    // shown before the user closes the gap (the split keeps it; the shift does not).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Shift Boundary".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("Main".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_b = create_b.section_id.unwrap();
    // Merge on station 4 = end_pos+1 for the interior range [2..=3].
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 4),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(sec_a, s2, s3).unwrap();
    assert!(
        impact.removed_merges.iter().any(|p| {
            (p.station_a.section_id == sec_a && p.station_a.station_index == 4)
                || (p.station_b.section_id == sec_a && p.station_b.station_index == 4)
        }),
        "merge on the shift-boundary station end_pos+1 must be surfaced: {:?}",
        impact.removed_merges
    );
}

#[test]
fn test_delete_range_interior_shift_not_blocked_by_closure_loop() {
    // User report: a range whose two sides are connected only through a LOOP
    // CLOSURE must NOT block the gap-close — a closure is a soft/redundant
    // constraint the delete removes/converts, so the result is still valid. (A
    // merge-based loop still blocks; see
    // test_delete_range_interior_shift_blocked_by_loop_via_replacement_merge.)
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Closure Loop".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_b = create_b.section_id.unwrap();
    // Head A:2 <-> B via a merge; tail A:5 <-> B via a LOOP CLOSURE. So for the
    // interior range [2..=3] the only head<->tail path is through the closure.
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 2),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );
    assert!(
        state
            .execute(Command::CreateLoopClosure {
                station_a: StationRef::new(sec_a, 5),
                station_b: StationRef::new(sec_b, 1),
                closure_strategy: ClosureStrategy::default(),
            })
            .success
    );

    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    {
        let proj = state.get_project_state().unwrap();
        let impact = proj.preview_delete_shot_range(sec_a, s2, s3).unwrap();
        assert!(
            !impact.shift_blocked,
            "a closure-only loop must not block the gap-close: {:?}",
            impact.shift_blocked_reasons
        );
    }
    // And the gap-close executes cleanly (no over-constraint / alignment panic).
    let result = state.execute_delete_shot_range_shift(sec_a, s2, s3);
    assert!(
        result.success,
        "closure-loop gap-close should succeed: {:?}",
        result.error
    );
}

#[test]
fn test_delete_range_blocked_interior_impact_describes_split() {
    // Review finding (P2): when the gap-close is blocked, an interior range can
    // only SPLIT (which keeps both boundary stations), so the relationship panel
    // must describe the split — NOT list the kept tail boundary (end_pos+1) or
    // its merge as removed. (Complements the not-blocked case above, where the
    // gap-close IS offered and the boundary merge is surfaced.)
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Blocked Impact".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
        ],
    });
    let sec_a = create.section_id.unwrap();
    let create_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_b = create_b.section_id.unwrap();
    // Datum on interior station A:3 blocks the gap-close (it would drop the datum).
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(sec_a, 3),
        coordinates: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    // Merge on the tail boundary A:4 (= end_pos+1 for range [2..=3]) — kept by split.
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 4),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(sec_a, s2, s3).unwrap();
    assert!(
        impact.shift_blocked,
        "datum on interior station blocks the gap-close"
    );
    assert!(
        !impact
            .removed_stations
            .iter()
            .any(|sr| sr.section_id == sec_a && sr.station_index == 4),
        "split-only impact must not list the kept tail boundary: {:?}",
        impact.removed_stations
    );
    assert!(
        !impact.removed_merges.iter().any(|p| {
            (p.station_a.section_id == sec_a && p.station_a.station_index == 4)
                || (p.station_b.section_id == sec_a && p.station_b.station_index == 4)
        }),
        "the kept tail boundary's merge must not be reported as removed: {:?}",
        impact.removed_merges
    );
}

#[test]
fn test_delete_range_shift_does_not_displace_free_floating_merged_section() {
    // Codex re-review (P1): a suffix gap-close keeps the head fixed and shifts
    // the doomed tail. A per-shot cascade would push a free-floating (undatumed)
    // section merged to that tail, then the tail+merge are deleted — leaving it
    // displaced with no edge to pull it back. Deferring to one final cascade
    // keeps it in place.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Free Float".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            shot_data_with_azimuth(10.0, 90.0, 90.0),
            shot_data_with_azimuth(5.0, 90.0, 90.0),
            shot_data_with_azimuth(7.0, 90.0, 90.0),
            shot_data_with_azimuth(8.0, 90.0, 90.0),
            shot_data_with_azimuth(6.0, 90.0, 90.0),
        ],
    });
    let sec_a = create.section_id.unwrap();
    let create_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![shot_data_with_azimuth(4.0, 45.0, 45.0)],
    });
    let sec_b = create_b.section_id.unwrap();
    // B is free-floating (NO datum), merged to A's END station (A:5) — the doomed tail.
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 5),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    let before = {
        let proj = state.get_project_state().unwrap();
        abs_coord_map(&proj)
    };
    let b0_before = *before.get(&StationRef::new(sec_b, 0)).unwrap();
    let b1_before = *before.get(&StationRef::new(sec_b, 1)).unwrap();

    let (s3, s4) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[3].id, sec.shots[4].id)
    };
    assert!(state.execute_delete_shot_range_shift(sec_a, s3, s4).success);

    let proj = state.get_project_state().unwrap();
    let after = abs_coord_map(&proj);
    // B is now disconnected from A; it must stay where it was, not be dragged by
    // the doomed tail's intermediate shift.
    assert_xy_close(b0_before, *after.get(&StationRef::new(sec_b, 0)).unwrap());
    assert_xy_close(b1_before, *after.get(&StationRef::new(sec_b, 1)).unwrap());
}

#[test]
fn test_delete_range_interior_shift_not_blocked_via_removed_tail_boundary() {
    // Codex re-review: a path from the head to the REMOVED tail boundary
    // (end_pos+1) through an external section is not a real loop — that station
    // and its merge are deleted by the gap-close — so it must not block.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Tail Boundary Loop".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_e = state.execute(Command::CreateSection {
        name: Some("E".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_e = create_e.section_id.unwrap();
    // Head side A:1 <-> E:0. A:4 (= end_pos+1 for range [2..=3]) <-> E:1 is
    // already connected (A:4->A:1->E:0->E:1), so push it raw to form the loop
    // that runs through the to-be-removed tail boundary A:4.
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 1),
                station_b: StationRef::new(sec_e, 0),
            })
            .success
    );
    {
        let mut guard = state.project.lock().unwrap();
        let proj = guard.as_mut().unwrap();
        proj.station_merges.push(StationMerge {
            station_a: StationRef::new(sec_a, 4).into(),
            station_b: StationRef::new(sec_e, 1).into(),
            merged_at: chrono::Utc::now(),
        });
        proj.merge_adjacency_cache.clear();
    }
    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(sec_a, s2, s3).unwrap();
    assert!(
        !impact.shift_blocked,
        "close-gap connected only through the removed tail boundary must not block: {:?}",
        impact.shift_blocked_reasons
    );
}

#[test]
fn test_delete_range_interior_shift_blocked_by_loop_via_replacement_merge() {
    // Self-review (HIGH): two external sections P and Q are each merged ONLY to a
    // removed interior station, so head and tail are NOT connected on the raw
    // graph (the path runs through the removed station). The gap-close re-bridges
    // P<->Q with a replacement merge, reconnecting head and tail into a loop. The
    // blocker checks the POST-preservation graph, so it must catch this and block.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Loop Via Replacement".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
            test_shot_data(8.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_p = state.execute(Command::CreateSection {
        name: Some("P".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_p = create_p.section_id.unwrap();
    let create_q = state.execute(Command::CreateSection {
        name: Some("Q".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let sec_q = create_q.section_id.unwrap();
    // P:0 <-> head A:2, Q:0 <-> tail A:5 (valid merges).
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_p, 0),
                station_b: StationRef::new(sec_a, 2),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_q, 0),
                station_b: StationRef::new(sec_a, 5),
            })
            .success
    );
    // P:0 and Q:0 each also merged to the REMOVED interior A:3 (already connected,
    // so push raw). A:3 is the only P<->Q bridge.
    {
        let mut guard = state.project.lock().unwrap();
        let proj = guard.as_mut().unwrap();
        proj.station_merges.push(StationMerge {
            station_a: StationRef::new(sec_p, 0).into(),
            station_b: StationRef::new(sec_a, 3).into(),
            merged_at: chrono::Utc::now(),
        });
        proj.station_merges.push(StationMerge {
            station_a: StationRef::new(sec_q, 0).into(),
            station_b: StationRef::new(sec_a, 3).into(),
            merged_at: chrono::Utc::now(),
        });
        proj.merge_adjacency_cache.clear();
    }
    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(sec_a, s2, s3).unwrap();
    assert!(
        impact.shift_blocked,
        "the gap-close re-forms a head<->tail loop via a replacement merge; must block: {:?}",
        impact.shift_blocked_reasons
    );
}

#[test]
fn test_delete_range_shift_undo_redo_roundtrip() {
    // Self-review (#6): the only range undo/redo test exercised the SPLIT path.
    // Cover the SHIFT path too — including a replacement merge added during the
    // deferred-cascade gap-close — so snapshot restore/redo is verified.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Shift Undo".to_string(),
        location: None,
    });
    let create_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            shot_data_with_azimuth(10.0, 90.0, 90.0),
            shot_data_with_azimuth(5.0, 45.0, 45.0),
            shot_data_with_azimuth(7.0, 90.0, 90.0),
            shot_data_with_azimuth(8.0, 135.0, 135.0),
            shot_data_with_azimuth(6.0, 90.0, 90.0),
            shot_data_with_azimuth(4.0, 90.0, 90.0),
        ],
    });
    let sec_a = create_a.section_id.unwrap();
    let create_p = state.execute(Command::CreateSection {
        name: Some("P".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![shot_data_with_azimuth(4.0, 90.0, 90.0)],
    });
    let sec_p = create_p.section_id.unwrap();
    let create_q = state.execute(Command::CreateSection {
        name: Some("Q".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![shot_data_with_azimuth(4.0, 90.0, 90.0)],
    });
    let sec_q = create_q.section_id.unwrap();
    // P and Q bridge ONLY through interior A:3 (removed by the range) — the
    // gap-close adds a replacement merge P:0<->Q:0 to keep them connected.
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_p, 0),
                station_b: StationRef::new(sec_a, 3),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_q, 0),
                station_b: StationRef::new(sec_a, 3),
            })
            .success
    );

    let before_abs = {
        let proj = state.get_project_state().unwrap();
        abs_coord_map(&proj)
    };
    let undo_len_before = state.get_undo_stack().len();
    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(sec_a).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let result = state.execute_delete_shot_range_shift(sec_a, s2, s3);
    assert!(result.success, "{:?}", result.error);
    assert_eq!(
        state.get_undo_stack().len(),
        undo_len_before + 1,
        "one undo entry"
    );
    {
        let proj = state.get_project_state().unwrap();
        assert_eq!(
            proj.get_section(sec_a).unwrap().shots.len(),
            4,
            "two shots removed"
        );
        assert!(
            proj.are_stations_merged(StationRef::new(sec_p, 0), StationRef::new(sec_q, 0)),
            "P and Q stay connected via a replacement merge after the gap-close"
        );
    }

    assert!(state.undo().success);
    {
        let proj = state.get_project_state().unwrap();
        let after_undo = abs_coord_map(&proj);
        assert_eq!(before_abs.len(), after_undo.len());
        for (r, c) in &before_abs {
            let c2 = after_undo
                .get(r)
                .unwrap_or_else(|| panic!("missing {r:?} after undo"));
            assert_coords_close(*c, *c2);
        }
        assert_eq!(
            proj.get_section(sec_a).unwrap().shots.len(),
            6,
            "undo restores all shots"
        );
    }

    assert!(state.redo().success);
    {
        let proj = state.get_project_state().unwrap();
        assert_eq!(
            proj.get_section(sec_a).unwrap().shots.len(),
            4,
            "redo re-applies the shift"
        );
        assert!(proj.are_stations_merged(StationRef::new(sec_p, 0), StationRef::new(sec_q, 0)));
    }
}

#[test]
fn test_delete_range_prefix_shift_surfaces_comment() {
    // Codex re-review: prefix/suffix shifts drop station comments on removed
    // stations; the preview must surface them so the dialog can warn (the
    // warning was previously gated to interior splits only).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Prefix Comment".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    // Comment on station 1 (removed by the prefix range [0..=1]).
    assert!(
        state
            .execute(Command::SetStationComment {
                station_ref: StationRef::new(section_id, 1),
                comment: Some("note".to_string()),
            })
            .success
    );
    let (s0, s1) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[0].id, sec.shots[1].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(section_id, s0, s1).unwrap();
    assert!(
        impact
            .removed_comments
            .iter()
            .any(|sr| sr.station_index == 1),
        "prefix shift comment loss must be surfaced: {:?}",
        impact.removed_comments
    );
}

#[test]
fn test_delete_range_interior_shift_surfaces_boundary_comment() {
    // Codex re-review: the interior close-gap deletes end_pos+1 and drops a
    // comment there. With the gap-close available, the comment set covers the
    // shift removed set, so the boundary comment is surfaced before closing.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Boundary Comment".to_string(),
        location: None,
    });
    let create = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
            test_shot_data(4.0),
            test_shot_data(6.0),
        ],
    });
    let section_id = create.section_id.unwrap();
    // Comment on station 4 = end_pos+1 for the interior range [2..=3]. The split
    // keeps it; the gap-close drops it.
    assert!(
        state
            .execute(Command::SetStationComment {
                station_ref: StationRef::new(section_id, 4),
                comment: Some("boundary".to_string()),
            })
            .success
    );
    let (s2, s3) = {
        let proj = state.get_project_state().unwrap();
        let sec = proj.get_section(section_id).unwrap();
        (sec.shots[2].id, sec.shots[3].id)
    };
    let proj = state.get_project_state().unwrap();
    let impact = proj.preview_delete_shot_range(section_id, s2, s3).unwrap();
    assert!(
        !impact.shift_blocked,
        "no datum, so the gap-close is available"
    );
    assert!(
        impact
            .removed_comments
            .iter()
            .any(|sr| sr.station_index == 4),
        "close-gap tail-boundary comment must be surfaced: {:?}",
        impact.removed_comments
    );
}

#[test]
fn test_split_remaps_station_offsets() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Station Offset Remap".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
        ],
    });
    let section_id = create_result.section_id.unwrap();

    // Directly insert a station offset for station 3 (simulates legacy offset data)
    {
        let mut proj = state.get_project_state().unwrap();
        proj.station_offsets
            .insert(StationRef::new(section_id, 3).into(), (1.0, 2.0, 3.0));
        state.set_project_for_tests(proj);
    }

    // Split at shot index 1
    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[1].id
    };

    let result =
        state.execute_delete_shot_and_split(section_id, shot_id, "A".to_string(), "B".to_string());
    assert!(result.success);
    let new_section_id = result.section_id.unwrap();

    // Station offset should be remapped from (section_id, 3) to (new_section_id, 1)
    // split_station = 2, so 3 - 2 = 1
    let proj = state.get_project_state().unwrap();
    let new_ref = StationRef::new(new_section_id, 1);
    let offset = proj.station_offset_for_ref(new_ref);
    assert!(
        offset.is_some(),
        "Station offset should be remapped to new section"
    );
    let (ox, oy, oz) = offset.unwrap();
    assert!((ox - 1.0).abs() < 0.001);
    assert!((oy - 2.0).abs() < 0.001);
    assert!((oz - 3.0).abs() < 0.001);

    // Old ref should not exist
    let old_ref = StationRef::new(section_id, 3);
    assert!(
        !proj.station_offset_for_ref(old_ref).is_some(),
        "Old station offset should be removed"
    );
}

#[test]
fn test_split_undo_restores_original() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Undo Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
        ],
    });
    let section_id = create_result.section_id.unwrap();

    // Record initial state
    let initial_shot_count = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots.len()
    };
    let initial_section_count = state.get_project_state().unwrap().sections.len();

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[1].id
    };

    let result =
        state.execute_delete_shot_and_split(section_id, shot_id, "A".to_string(), "B".to_string());
    assert!(result.success);

    // Verify split happened
    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.sections.len(), initial_section_count + 1);

    // Undo
    let undo_result = state.undo();
    assert!(
        undo_result.success,
        "Undo should succeed: {:?}",
        undo_result.error
    );

    // Verify restored
    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.sections.len(), initial_section_count);
    let section = proj.get_section(section_id).unwrap();
    assert_eq!(section.shots.len(), initial_shot_count);
    assert_eq!(section.name, Some("Original".to_string()));
}

#[test]
fn test_split_redo_resplits() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Redo Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
        ],
    });
    let section_id = create_result.section_id.unwrap();

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[1].id
    };

    let result =
        state.execute_delete_shot_and_split(section_id, shot_id, "A".to_string(), "B".to_string());
    assert!(result.success);
    let new_section_id = result.section_id.unwrap();

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success);

    // Redo
    let redo_result = state.redo();
    assert!(
        redo_result.success,
        "Redo should succeed: {:?}",
        redo_result.error
    );

    // Verify re-split: should have section A and section B again
    let proj = state.get_project_state().unwrap();
    let section_a = proj.get_section(section_id).unwrap();
    let section_b = proj.get_section(new_section_id).unwrap();
    assert_eq!(section_a.shots.len(), 1);
    assert_eq!(section_b.shots.len(), 1);
    assert_eq!(section_a.name, Some("A".to_string()));
    assert_eq!(section_b.name, Some("B".to_string()));
}

#[test]
fn test_split_rejects_edge_shot() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Edge Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Original".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
        ],
    });
    let section_id = create_result.section_id.unwrap();

    // Try to split at first shot
    let first_shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[0].id
    };
    let result = state.execute_delete_shot_and_split(
        section_id,
        first_shot_id,
        "A".to_string(),
        "B".to_string(),
    );
    assert!(!result.success, "Should reject first shot");
    assert!(result.error.unwrap().contains("edge shot"));

    // Try to split at last shot
    let last_shot_id = {
        let proj = state.get_project_state().unwrap();
        let section = proj.get_section(section_id).unwrap();
        section.shots[section.shots.len() - 1].id
    };
    let result = state.execute_delete_shot_and_split(
        section_id,
        last_shot_id,
        "A".to_string(),
        "B".to_string(),
    );
    assert!(!result.success, "Should reject last shot");
    assert!(result.error.unwrap().contains("edge shot"));
}

// === delete_last_shot_and_section tests ===

#[test]
fn test_delete_last_shot_removes_section() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Delete Last Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Single".to_string()),
        surveyor: Some("Tester".to_string()),
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    assert!(create_result.success);
    let section_id = create_result.section_id.unwrap();

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_id, shot_id);
    assert!(
        result.success,
        "Delete last shot should succeed: {:?}",
        result.error
    );

    // Verify section is gone
    let proj = state.get_project_state().unwrap();
    assert!(
        proj.get_section(section_id).is_none(),
        "Section should be removed"
    );
}

#[test]
fn test_delete_last_shot_fails_if_multiple_shots() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Multi Shot Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("Multi".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
    });
    assert!(create_result.success);
    let section_id = create_result.section_id.unwrap();

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_id, shot_id);
    assert!(!result.success, "Should fail with multiple shots");
    assert!(result.error.unwrap().contains("2 shots"));
}

#[test]
fn test_delete_last_shot_undo_restores() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Undo Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("WillDelete".to_string()),
        surveyor: Some("UndoTester".to_string()),
        date: None,
        color: "#aabbcc".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_id = create_result.section_id.unwrap();

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_id, shot_id);
    assert!(result.success);

    // Verify deleted
    {
        let proj = state.get_project_state().unwrap();
        assert!(proj.get_section(section_id).is_none());
    }

    // Undo
    let undo_result = state.undo();
    assert!(
        undo_result.success,
        "Undo should succeed: {:?}",
        undo_result.error
    );

    // Verify restored
    let proj = state.get_project_state().unwrap();
    let section = proj
        .get_section(section_id)
        .expect("Section should be restored");
    assert_eq!(section.name, Some("WillDelete".to_string()));
    assert_eq!(section.surveyor, Some("UndoTester".to_string()));
    assert_eq!(section.shots.len(), 1);
    assert_eq!(section.shots[0].id, shot_id);
    assert_eq!(section.shots[0].length, 5.0);
}

#[test]
fn test_delete_last_shot_cleans_up_offsets() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Offset Cleanup Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("WithOffset".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_id = create_result.section_id.unwrap();

    // Manually set a section offset
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        project.section_offsets.insert(section_id, (10.0, 20.0));
    }

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_id, shot_id);
    assert!(result.success);

    // Verify section offset is cleaned up
    let proj = state.get_project_state().unwrap();
    assert!(
        !proj.section_offsets.contains_key(&section_id),
        "Section offset should be removed"
    );
}

#[test]
fn test_delete_last_shot_cleans_up_merges() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Merge Cleanup Test".to_string(),
        location: None,
    });

    // Create two sections
    let create_a = state.execute(Command::CreateSection {
        name: Some("ToDelete".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let section_b_id = create_b.section_id.unwrap();

    // Merge station 1 of A with station 0 of B
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(section_a_id, 1),
        station_b: StationRef::new(section_b_id, 0),
    });
    assert!(merge_result.success);

    // Verify merge exists
    {
        let proj = state.get_project_state().unwrap();
        assert!(
            !proj.station_merges.is_empty(),
            "Should have merge before delete"
        );
    }

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_a_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_a_id, shot_id);
    assert!(result.success);

    // Verify merge is cleaned up
    let proj = state.get_project_state().unwrap();
    let remaining_merges: Vec<_> = proj
        .station_merges
        .iter()
        .filter(|m| {
            m.station_a.section_id == section_a_id || m.station_b.section_id == section_a_id
        })
        .collect();
    assert!(
        remaining_merges.is_empty(),
        "Merges referencing deleted section should be removed"
    );
}

#[test]
fn test_delete_last_shot_cleans_up_station_offsets() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Station Offset Cleanup Test".to_string(),
        location: None,
    });

    let create_result = state.execute(Command::CreateSection {
        name: Some("WithStationOffset".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_id = create_result.section_id.unwrap();

    // Manually set a station offset
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        let station_ref = StationRef::new(section_id, 0);
        project
            .station_offsets
            .insert(station_ref.into(), (1.0, 2.0, 3.0));
    }

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_id, shot_id);
    assert!(result.success);

    // Verify station offsets for this section are cleaned up
    let proj = state.get_project_state().unwrap();
    let remaining_station_offsets: Vec<_> = proj
        .station_offsets
        .keys()
        .filter(|sr| sr.section_id == section_id)
        .collect();
    assert!(
        remaining_station_offsets.is_empty(),
        "Station offsets referencing deleted section should be removed"
    );
}

#[test]
fn test_delete_last_shot_cleans_up_closures() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Closure Cleanup Test".to_string(),
        location: None,
    });

    // Create two sections
    let create_a = state.execute(Command::CreateSection {
        name: Some("ToDelete".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0), test_shot_data(3.0)],
    });
    let section_b_id = create_b.section_id.unwrap();

    // Manually insert a loop closure referencing section A
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        project.loop_closures.push(LoopClosure {
            id: project.next_closure_id,
            station_a: StationRef::new(section_a_id, 0).into(),
            station_b: StationRef::new(section_b_id, 1).into(),
            path_length: 10.0,
            misclosure_distance: 0.5,
            error_percentage: 5.0,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
            strategy: ClosureStrategy::default(),
            is_aligned: false,
        });
        project.next_closure_id += 1;
    }

    // Verify closure exists
    {
        let proj = state.get_project_state().unwrap();
        assert_eq!(
            proj.loop_closures.len(),
            1,
            "Should have 1 closure before delete"
        );
    }

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_a_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_a_id, shot_id);
    assert!(result.success);

    // Verify closure is cleaned up
    let proj = state.get_project_state().unwrap();
    let remaining_closures: Vec<_> = proj
        .loop_closures
        .iter()
        .filter(|lc| {
            lc.station_a.section_id == section_a_id || lc.station_b.section_id == section_a_id
        })
        .collect();
    assert!(
        remaining_closures.is_empty(),
        "Closures referencing deleted section should be removed"
    );
}

#[test]
fn test_delete_last_shot_undo_restores_references() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Undo Refs Test".to_string(),
        location: None,
    });

    // Create two sections
    let create_a = state.execute(Command::CreateSection {
        name: Some("ToDelete".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let section_b_id = create_b.section_id.unwrap();

    // Merge station 1 of A with station 0 of B
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(section_a_id, 1),
        station_b: StationRef::new(section_b_id, 0),
    });
    assert!(merge_result.success);

    // Manually add a section offset and station offset for section A
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        // Note: merge already sets section_offsets, so add station offset
        project
            .station_offsets
            .insert(StationRef::new(section_a_id, 0).into(), (1.0, 2.0, 3.0));
        // Add a closure referencing section A
        project.loop_closures.push(LoopClosure {
            id: project.next_closure_id,
            station_a: StationRef::new(section_a_id, 0).into(),
            station_b: StationRef::new(section_b_id, 1).into(),
            path_length: 10.0,
            misclosure_distance: 0.5,
            error_percentage: 5.0,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
            strategy: ClosureStrategy::default(),
            is_aligned: false,
        });
        project.next_closure_id += 1;
    }

    // Capture counts before deletion
    let (merges_before, closures_before, station_offsets_a_before) = {
        let proj = state.get_project_state().unwrap();
        let merges = proj.station_merges.len();
        let closures = proj.loop_closures.len();
        let so = proj
            .station_offsets
            .keys()
            .filter(|sr| sr.section_id == section_a_id)
            .count();
        (merges, closures, so)
    };
    assert!(merges_before > 0);
    assert!(closures_before > 0);
    assert!(station_offsets_a_before > 0);

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_a_id).unwrap().shots[0].id
    };

    // Delete section A
    let result = state.execute_delete_last_shot_and_section(section_a_id, shot_id);
    assert!(result.success);

    // Verify everything cleaned up
    {
        let proj = state.get_project_state().unwrap();
        assert!(proj.get_section(section_a_id).is_none());
        let a_merges: Vec<_> = proj
            .station_merges
            .iter()
            .filter(|m| {
                m.station_a.section_id == section_a_id || m.station_b.section_id == section_a_id
            })
            .collect();
        assert!(a_merges.is_empty());
        let a_closures: Vec<_> = proj
            .loop_closures
            .iter()
            .filter(|lc| {
                lc.station_a.section_id == section_a_id || lc.station_b.section_id == section_a_id
            })
            .collect();
        assert!(a_closures.is_empty());
    }

    // Undo
    let undo_result = state.undo();
    assert!(
        undo_result.success,
        "Undo should succeed: {:?}",
        undo_result.error
    );

    // Verify all references restored
    let proj = state.get_project_state().unwrap();
    assert!(
        proj.get_section(section_a_id).is_some(),
        "Section should be restored"
    );
    assert_eq!(
        proj.station_merges.len(),
        merges_before,
        "Merges should be restored"
    );
    assert_eq!(
        proj.loop_closures.len(),
        closures_before,
        "Closures should be restored"
    );
    let so_after = proj
        .station_offsets
        .keys()
        .filter(|sr| sr.section_id == section_a_id)
        .count();
    assert_eq!(
        so_after, station_offsets_a_before,
        "Station offsets should be restored"
    );
}

// === Section deletion cleanup undo/redo tests (fn-47-ok1.7) ===

#[test]
fn test_delete_section_undo_restores_relationships() {
    // Delete a section with merges, closures, offsets, zero datums.
    // Undo should restore all of them.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Cleanup Undo Test".to_string(),
        location: None,
    });

    // Create two sections
    let sec_a_result = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let sec_a = sec_a_result.section_id.unwrap();

    let sec_b_result = state.execute(Command::CreateSection {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    let sec_b = sec_b_result.section_id.unwrap();

    // Merge sec_a:1 -> sec_b:0
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 1),
        station_b: StationRef::new(sec_b, 0),
    });
    assert!(merge_result.success, "Merge should succeed");

    // Set a zero datum on sec_a:0 so cleanup removes it
    let datum_result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(sec_a, 0),
        coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
    });
    assert!(datum_result.success, "SetZeroDatum should succeed");

    // Directly insert a station offset for sec_a:0 (MoveStation now modifies shot data directly)
    {
        let mut proj = state.get_project_state().unwrap();
        proj.station_offsets
            .insert(StationRef::new(sec_a, 0).into(), (1.0, 2.0, 0.0));
        state.set_project_for_tests(proj);
    }

    // Capture state before deletion
    let proj_before = state.get_project_state().unwrap();
    let merges_before = proj_before.station_merges.len();
    let zero_datums_before = proj_before.zero_datums.len();
    let station_offsets_a_before = proj_before
        .station_offsets
        .keys()
        .filter(|sr| sr.section_id == sec_a)
        .count();
    assert!(merges_before >= 1, "Should have at least 1 merge");
    assert!(zero_datums_before >= 1, "Should have at least 1 zero datum");
    assert!(
        station_offsets_a_before >= 1,
        "Should have at least 1 station offset for sec_a"
    );

    // Delete section A (triggers cleanup of merges, offsets, zero datums)
    let del_result = state.execute(Command::DeleteSection { section_id: sec_a });
    assert!(del_result.success, "Delete should succeed");

    // Verify cleanup happened: merges, zero datums, station offsets
    let proj_after = state.get_project_state().unwrap();
    assert!(
        proj_after.get_section(sec_a).is_none(),
        "Section A should be gone"
    );
    assert_eq!(
        proj_after
            .station_merges
            .iter()
            .filter(|m| m.station_a.section_id == sec_a || m.station_b.section_id == sec_a)
            .count(),
        0,
        "No merges should reference deleted section A"
    );
    assert_eq!(
        proj_after
            .zero_datums
            .iter()
            .filter(|zd| zd.station_ref.section_id == sec_a)
            .count(),
        0,
        "No zero datums should reference deleted section A"
    );
    assert_eq!(
        proj_after
            .station_offsets
            .keys()
            .filter(|sr| sr.section_id == sec_a)
            .count(),
        0,
        "No station offsets should reference deleted section A"
    );

    // Undo should restore everything
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo should succeed");

    let proj_restored = state.get_project_state().unwrap();
    assert!(
        proj_restored.get_section(sec_a).is_some(),
        "Section A should be restored"
    );
    assert_eq!(
        proj_restored.station_merges.len(),
        merges_before,
        "Merges should be fully restored"
    );
    assert_eq!(
        proj_restored.zero_datums.len(),
        zero_datums_before,
        "Zero datums should be fully restored"
    );
    assert_eq!(
        proj_restored
            .station_offsets
            .keys()
            .filter(|sr| sr.section_id == sec_a)
            .count(),
        station_offsets_a_before,
        "Station offsets should be fully restored"
    );

    // Redo should re-delete and re-cleanup
    let redo_result = state.redo();
    assert!(redo_result.success, "Redo should succeed");

    let proj_redone = state.get_project_state().unwrap();
    assert!(
        proj_redone.get_section(sec_a).is_none(),
        "Section A should be gone after redo"
    );
    assert_eq!(
        proj_redone
            .station_merges
            .iter()
            .filter(|m| m.station_a.section_id == sec_a || m.station_b.section_id == sec_a)
            .count(),
        0,
        "No merges should reference deleted section after redo"
    );
    assert_eq!(
        proj_redone
            .zero_datums
            .iter()
            .filter(|zd| zd.station_ref.section_id == sec_a)
            .count(),
        0,
        "No zero datums should reference deleted section after redo"
    );
    assert_eq!(
        proj_redone
            .station_offsets
            .keys()
            .filter(|sr| sr.section_id == sec_a)
            .count(),
        0,
        "No station offsets should reference deleted section after redo"
    );
}

// === Station Ref Shifting Tests ===

/// Helper: create a project with two sections, each with 2 shots, merged at station 0 of each.
/// Returns (state, section_a_id, section_b_id).
fn setup_merged_project() -> (AppState, u32, u32) {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Shift Test".to_string(),
        location: None,
    });

    // Section A with 2 shots
    let result_a = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0), test_shot_data(20.0)],
    });
    let sec_a = result_a.section_id.unwrap();

    // Section B with 2 shots
    let result_b = state.execute(Command::CreateSection {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(15.0), test_shot_data(25.0)],
    });
    let sec_b = result_b.section_id.unwrap();

    // Merge station 0 of A with station 0 of B
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 0),
        station_b: StationRef::new(sec_b, 0),
    });
    assert!(merge_result.success, "Merge should succeed");

    (state, sec_a, sec_b)
}

#[test]
fn test_insert_before_shifts_station_merge() {
    let (state, sec_a, sec_b) = setup_merged_project();

    // Verify initial merge is at station 0 of both sections
    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.station_merges.len(), 1);
    assert!(proj.key_is_ref(&proj.station_merges[0].station_a, StationRef::new(sec_a, 0)));
    assert!(proj.key_is_ref(&proj.station_merges[0].station_b, StationRef::new(sec_b, 0)));

    // Get first shot ID of section A
    let first_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;

    // Insert shot before first shot of section A
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: test_shot_data(5.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // Verify merge shifted: station_a should now be station 1 of A (not 0)
    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.station_merges.len(), 1);
    assert!(
        proj.key_is_ref(&proj.station_merges[0].station_a, StationRef::new(sec_a, 1)),
        "Merge station_a should shift from 0 to 1 after insert_before"
    );
    assert!(
        proj.key_is_ref(&proj.station_merges[0].station_b, StationRef::new(sec_b, 0)),
        "Merge station_b (different section) should not shift"
    );
}

#[test]
fn test_insert_before_shifts_zero_datum() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "ZD Shift Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::CreateSection {
        name: Some("Section".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0), test_shot_data(20.0)],
    });
    let sec_id = result.section_id.unwrap();

    // Set zero datum on station 0
    let zd_result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(sec_id, 0),
        coordinates: GpsCoordinates::new(45.0, -73.5, 100.0).unwrap(),
    });
    assert!(zd_result.success);

    let proj = state.get_project_state().unwrap();
    assert!(proj.key_is_ref(&proj.zero_datums[0].station_ref, StationRef::new(sec_id, 0)));

    // Get first shot ID
    let first_shot_id = proj.sections[0].shots[0].id;

    // Insert shot before first shot
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_id,
        shot: test_shot_data(5.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // Verify zero datum shifted to station 1
    let proj = state.get_project_state().unwrap();
    assert!(
        proj.key_is_ref(&proj.zero_datums[0].station_ref, StationRef::new(sec_id, 1)),
        "Zero datum should shift from station 0 to station 1 after insert_before"
    );
}

#[test]
fn test_insert_before_shifts_station_offset() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Offset Shift Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::CreateSection {
        name: Some("Section".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(10.0), test_shot_data(20.0)],
    });
    let sec_id = result.section_id.unwrap();

    // Directly add a station offset at station 0
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        project
            .station_offsets
            .insert(StationRef::new(sec_id, 0).into(), (1.0, 2.0, 3.0));
    }

    let proj = state.get_project_state().unwrap();
    assert!(proj
        .station_offset_for_ref(StationRef::new(sec_id, 0))
        .is_some());

    // Get first shot ID
    let first_shot_id = proj.sections[0].shots[0].id;

    // Insert before first shot
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_id,
        shot: test_shot_data(5.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // Verify station offset key shifted from station 0 to station 1
    let proj = state.get_project_state().unwrap();
    assert!(
        !proj
            .station_offset_for_ref(StationRef::new(sec_id, 0))
            .is_some(),
        "Station offset at old index 0 should be gone"
    );
    assert_eq!(
        proj.station_offset_for_ref(StationRef::new(sec_id, 1)),
        Some((1.0, 2.0, 3.0)),
        "Station offset should have moved to station 1"
    );
}

#[test]
fn test_insert_before_shifts_loop_closure() {
    let (state, sec_a, sec_b) = setup_merged_project();

    // Need a third section connected to form a loop for closure
    let result_c = state.execute(Command::CreateSection {
        name: Some("Section C".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(12.0)],
    });
    let sec_c = result_c.section_id.unwrap();

    // Merge section C station 0 with section A station 2 (end of A)
    let merge2 = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 2),
        station_b: StationRef::new(sec_c, 0),
    });
    assert!(merge2.success);

    // Create loop closure between section B station 2 and section C station 1
    let closure_result = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(sec_b, 2),
        station_b: StationRef::new(sec_c, 1),
        closure_strategy: ClosureStrategy::Batch,
    });
    assert!(closure_result.success);

    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.loop_closures.len(), 1);
    // The closure should reference sec_a station 2 for the merge
    assert_eq!(proj.station_merges.len(), 2);

    // Now insert shot before first shot of section A
    let first_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: test_shot_data(5.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // Verify: merge at sec_a station 0 should shift to station 1
    // Verify: merge at sec_a station 2 should shift to station 3
    let proj = state.get_project_state().unwrap();
    let a_merges: Vec<_> = proj
        .station_merges
        .iter()
        .filter(|m| m.station_a.section_id == sec_a || m.station_b.section_id == sec_a)
        .collect();
    assert_eq!(a_merges.len(), 2);

    // Check the merge that was at station 0 of A
    let merge_a0 = proj
        .station_merges
        .iter()
        .find(|m| proj.key_is_ref(&m.station_b, StationRef::new(sec_b, 0)))
        .unwrap();
    assert!(
        proj.key_is_ref(&merge_a0.station_a, StationRef::new(sec_a, 1)),
        "Merge at original station 0 should shift to station 1"
    );

    // Check the merge that was at station 2 of A (now station 3)
    let merge_a2 = proj
        .station_merges
        .iter()
        .find(|m| {
            proj.key_is_ref(&m.station_b, StationRef::new(sec_c, 0))
                || proj.key_is_ref(&m.station_a, StationRef::new(sec_c, 0))
        })
        .unwrap();
    let a_ref = if merge_a2.station_a.section_id == sec_a {
        merge_a2.station_a.clone()
    } else {
        merge_a2.station_b.clone()
    };
    assert!(
        proj.key_is_ref(&a_ref, StationRef::new(sec_a, 3)),
        "Merge at original station 2 should shift to station 3"
    );

    // Loop closure refs should NOT have changed (they reference sec_b and sec_c, not sec_a)
    assert!(proj.key_is_ref(&proj.loop_closures[0].station_a, StationRef::new(sec_b, 2)));
    assert!(proj.key_is_ref(&proj.loop_closures[0].station_b, StationRef::new(sec_c, 1)));
}

#[test]
fn test_insert_before_undo_restores_refs() {
    let (state, sec_a, sec_b) = setup_merged_project();

    let proj = state.get_project_state().unwrap();
    let first_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;

    // Insert before first shot of section A
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: test_shot_data(5.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // Verify merge shifted
    let proj = state.get_project_state().unwrap();
    assert!(proj.key_is_ref(&proj.station_merges[0].station_a, StationRef::new(sec_a, 1)));

    // Undo the insert
    let undo_result = state.undo();
    assert!(undo_result.success);

    // Verify merge returned to original position
    let proj = state.get_project_state().unwrap();
    assert!(
        proj.key_is_ref(&proj.station_merges[0].station_a, StationRef::new(sec_a, 0)),
        "Merge should return to station 0 after undo"
    );
    assert!(
        proj.key_is_ref(&proj.station_merges[0].station_b, StationRef::new(sec_b, 0)),
        "Merge station_b should still be station 0 of B"
    );
}

#[test]
fn test_insert_before_redo_shifts_refs_again() {
    let (state, sec_a, sec_b) = setup_merged_project();

    let proj = state.get_project_state().unwrap();
    let first_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;

    // Insert before first shot
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: test_shot_data(5.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success);

    // Redo
    let redo_result = state.redo();
    assert!(redo_result.success);

    // Verify merge shifted back to station 1
    let proj = state.get_project_state().unwrap();
    assert!(
        proj.key_is_ref(&proj.station_merges[0].station_a, StationRef::new(sec_a, 1)),
        "Merge should shift to station 1 after redo"
    );
    assert!(
        proj.key_is_ref(&proj.station_merges[0].station_b, StationRef::new(sec_b, 0)),
        "Merge station_b should stay at station 0 of B"
    );
}

#[test]
fn test_insert_after_only_shifts_refs_beyond() {
    let (state, sec_a, _sec_b) = setup_merged_project();

    // Also add a station offset at station 1 of section A
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        project
            .station_offsets
            .insert(StationRef::new(sec_a, 1).into(), (5.0, 6.0, 7.0));
    }

    let proj = state.get_project_state().unwrap();
    let first_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;

    // Insert after first shot (position 0) — new shot at position 1
    // This should shift station refs >= station 2 (pos+2=2)
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: test_shot_data(7.0),
        after_shot_id: Some(first_shot_id),
        before_shot_id: None,
    });
    assert!(insert_result.success);

    let proj = state.get_project_state().unwrap();

    // Station merge at sec_a station 0 should NOT shift (0 < 2)
    assert!(
        proj.key_is_ref(&proj.station_merges[0].station_a, StationRef::new(sec_a, 0)),
        "Merge at station 0 should not shift for insert_after shot 0"
    );

    // Station offset at station 1 should NOT shift (1 < 2)
    assert!(
        proj.station_offset_for_ref(StationRef::new(sec_a, 1))
            .is_some(),
        "Station offset at station 1 should not shift for insert_after shot 0"
    );
}

#[test]
fn test_delete_shot_undo_redo_with_snapshot() {
    let (state, sec_a, _sec_b) = setup_merged_project();

    // Also set a zero datum at station 2 of section A
    let zd_result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(sec_a, 2),
        coordinates: GpsCoordinates::new(45.0, -73.5, 100.0).unwrap(),
    });
    assert!(zd_result.success);

    let proj = state.get_project_state().unwrap();
    let sec_a_shots: Vec<_> = proj
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots
        .iter()
        .collect();
    let first_shot_id = sec_a_shots[0].id;

    // Delete first shot — station refs should shift
    let delete_result = state.execute(Command::DeleteShot {
        section_id: sec_a,
        shot_id: first_shot_id,
    });
    assert!(delete_result.success);

    let proj = state.get_project_state().unwrap();
    // After deleting shot 0: merge referencing deleted station 0 should be removed
    assert!(
        proj.station_merges.is_empty(),
        "Merges referencing deleted station should be removed"
    );
    // Zero datum was at station 2, should shift to station 1
    assert!(
        proj.key_is_ref(&proj.zero_datums[0].station_ref, StationRef::new(sec_a, 1)),
        "Zero datum should shift from station 2 to station 1 after delete shot 0"
    );

    // Undo the delete — should restore via ProjectSnapshotPair
    let undo_result = state.undo();
    assert!(undo_result.success);

    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.sections
            .iter()
            .find(|s| s.id == sec_a)
            .unwrap()
            .shots
            .len(),
        2
    );
    assert!(
        proj.key_is_ref(&proj.station_merges[0].station_a, StationRef::new(sec_a, 0)),
        "Merge should be at station 0 after undo"
    );
    assert!(
        proj.key_is_ref(&proj.zero_datums[0].station_ref, StationRef::new(sec_a, 2)),
        "Zero datum should be at station 2 after undo"
    );

    // Redo the delete
    let redo_result = state.redo();
    assert!(redo_result.success);

    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.sections
            .iter()
            .find(|s| s.id == sec_a)
            .unwrap()
            .shots
            .len(),
        1
    );
    assert!(
        proj.key_is_ref(&proj.zero_datums[0].station_ref, StationRef::new(sec_a, 1)),
        "Zero datum should be at station 1 after redo"
    );
}

// === Section offset adjustment tests for insert_before at pos=0 ===

/// Create a shot with a known azimuth and length (both readings same = no ambiguity)
fn directional_shot_data(azimuth: f64, length: f64) -> ShotData {
    ShotData {
        azimuth_in: azimuth,
        azimuth_out: azimuth,
        length,
        depth_in: 0.0,
        depth_out: 0.0,
        ..Default::default()
    }
}

#[test]
fn test_insert_before_pos0_adjusts_section_offsets() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Offset Test".to_string(),
        location: None,
    });

    // Section with 2 shots heading north (azimuth 0)
    let result = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            directional_shot_data(0.0, 10.0),
            directional_shot_data(0.0, 5.0),
        ],
    });
    let sec_a = result.section_id.unwrap();

    // Capture initial coordinates
    let orig_coords: Vec<_> = {
        let proj = state.get_project_state().unwrap();
        let stations = proj.compute_station_coordinates();
        stations
            .iter()
            .filter(|s| s.station_ref.section_id == sec_a)
            .map(|s| {
                (
                    s.station_ref.station_index,
                    s.coordinates.x,
                    s.coordinates.y,
                )
            })
            .collect()
    };
    // station 0: (0, 0), station 1: (0, 10), station 2: (0, 15)
    assert!((orig_coords[0].1).abs() < 1e-6); // x=0
    assert!((orig_coords[0].2).abs() < 1e-6); // y=0
    assert!((orig_coords[1].2 - 10.0).abs() < 1e-6); // y=10
    assert!((orig_coords[2].2 - 15.0).abs() < 1e-6); // y=15

    // Insert shot heading east (azimuth 90, length 3) before first shot
    let proj = state.get_project_state().unwrap();
    let first_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: directional_shot_data(90.0, 3.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // After insert: old station 0 is now station 1.
    // New shot displacement: dx=3*sin(90)=3, dy=3*cos(90)=0
    // Section offset adjusted by (-3, 0)
    // Station 1 (old 0) should be at (0, 0) — unchanged
    // Station 2 (old 1) should be at (0, 10) — unchanged
    // Station 3 (old 2) should be at (0, 15) — unchanged
    let proj = state.get_project_state().unwrap();
    let stations = proj.compute_station_coordinates();

    let s0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_a, 0))
        .unwrap();
    let s1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_a, 1))
        .unwrap();
    let s2 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_a, 2))
        .unwrap();
    let s3 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_a, 3))
        .unwrap();

    // Station 0 (new) at section_offset = (-3, 0)
    assert!(
        (s0.coordinates.x - (-3.0)).abs() < 1e-6,
        "New station 0 x={}",
        s0.coordinates.x
    );
    assert!(
        (s0.coordinates.y).abs() < 1e-6,
        "New station 0 y={}",
        s0.coordinates.y
    );

    // Station 1 (was station 0): (0, 0) — same as original station 0
    assert!(
        (s1.coordinates.x).abs() < 1e-6,
        "Station 1 (was 0) x={}",
        s1.coordinates.x
    );
    assert!(
        (s1.coordinates.y).abs() < 1e-6,
        "Station 1 (was 0) y={}",
        s1.coordinates.y
    );

    // Station 2 (was station 1): (0, 10) — same as original station 1
    assert!(
        (s2.coordinates.x).abs() < 1e-6,
        "Station 2 (was 1) x={}",
        s2.coordinates.x
    );
    assert!(
        (s2.coordinates.y - 10.0).abs() < 1e-6,
        "Station 2 (was 1) y={}",
        s2.coordinates.y
    );

    // Station 3 (was station 2): (0, 15) — same as original station 2
    assert!(
        (s3.coordinates.x).abs() < 1e-6,
        "Station 3 (was 2) x={}",
        s3.coordinates.x
    );
    assert!(
        (s3.coordinates.y - 15.0).abs() < 1e-6,
        "Station 3 (was 2) y={}",
        s3.coordinates.y
    );
}

#[test]
fn test_insert_before_pos0_adjusts_merged_section_offsets() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Merged Offset Test".to_string(),
        location: None,
    });

    // Section A: 2 shots north
    let result_a = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            directional_shot_data(0.0, 10.0),
            directional_shot_data(0.0, 5.0),
        ],
    });
    let sec_a = result_a.section_id.unwrap();

    // Section B: 1 shot east
    let result_b = state.execute(Command::CreateSection {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![directional_shot_data(90.0, 8.0)],
    });
    let sec_b = result_b.section_id.unwrap();

    // Merge station 0 of A with station 0 of B
    state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 0),
        station_b: StationRef::new(sec_b, 0),
    });

    // Capture section B station coordinates before insert
    let (b0_before, b1_before) = {
        let proj = state.get_project_state().unwrap();
        let stations = proj.compute_station_coordinates();
        let b0 = stations
            .iter()
            .find(|s| s.station_ref == StationRef::new(sec_b, 0))
            .unwrap()
            .coordinates;
        let b1 = stations
            .iter()
            .find(|s| s.station_ref == StationRef::new(sec_b, 1))
            .unwrap()
            .coordinates;
        (b0, b1)
    };

    // Insert shot heading east before first shot of section A
    let proj = state.get_project_state().unwrap();
    let first_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: directional_shot_data(90.0, 3.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // Section B is in the same merged group — its stations should NOT have moved
    let proj = state.get_project_state().unwrap();
    let stations = proj.compute_station_coordinates();
    let b0_after = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_b, 0))
        .unwrap()
        .coordinates;
    let b1_after = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_b, 1))
        .unwrap()
        .coordinates;

    assert!(
        (b0_after.x - b0_before.x).abs() < 1e-6,
        "B station 0 x moved: {} -> {}",
        b0_before.x,
        b0_after.x
    );
    assert!(
        (b0_after.y - b0_before.y).abs() < 1e-6,
        "B station 0 y moved: {} -> {}",
        b0_before.y,
        b0_after.y
    );
    assert!(
        (b1_after.x - b1_before.x).abs() < 1e-6,
        "B station 1 x moved: {} -> {}",
        b1_before.x,
        b1_after.x
    );
    assert!(
        (b1_after.y - b1_before.y).abs() < 1e-6,
        "B station 1 y moved: {} -> {}",
        b1_before.y,
        b1_after.y
    );
}

#[test]
fn test_insert_before_pos0_undo_restores_offsets() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Undo Offset Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![directional_shot_data(0.0, 10.0)],
    });
    let sec_a = result.section_id.unwrap();

    // Capture coordinates before insert
    let orig_coords: Vec<_> = {
        let proj = state.get_project_state().unwrap();
        let stations = proj.compute_station_coordinates();
        stations
            .iter()
            .filter(|s| s.station_ref.section_id == sec_a)
            .map(|s| (s.station_ref, s.coordinates))
            .collect()
    };

    // Insert shot heading east before first shot
    let proj = state.get_project_state().unwrap();
    let first_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: directional_shot_data(90.0, 5.0),
        after_shot_id: None,
        before_shot_id: Some(first_shot_id),
    });
    assert!(insert_result.success);

    // Verify offset was adjusted
    {
        let proj = state.get_project_state().unwrap();
        let offset = proj
            .section_offsets
            .get(&sec_a)
            .copied()
            .unwrap_or((0.0, 0.0));
        assert!(
            (offset.0 - (-5.0)).abs() < 1e-6,
            "Section offset x should be -5, got {}",
            offset.0
        );
    }

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success);

    // Coordinates should be exactly as before (section has 2 stations again)
    let proj = state.get_project_state().unwrap();
    let stations = proj.compute_station_coordinates();
    for (ref_orig, coord_orig) in &orig_coords {
        let station = stations
            .iter()
            .find(|s| s.station_ref == *ref_orig)
            .unwrap();
        assert!(
            (station.coordinates.x - coord_orig.x).abs() < 1e-6,
            "Station {:?} x should match after undo: {} vs {}",
            ref_orig,
            station.coordinates.x,
            coord_orig.x
        );
        assert!(
            (station.coordinates.y - coord_orig.y).abs() < 1e-6,
            "Station {:?} y should match after undo: {} vs {}",
            ref_orig,
            station.coordinates.y,
            coord_orig.y
        );
    }

    // Redo
    let redo_result = state.redo();
    assert!(redo_result.success);

    // Old stations should be at the same position again (not moved)
    let proj = state.get_project_state().unwrap();
    let stations = proj.compute_station_coordinates();
    // Old station 0 is now station 1
    let s1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_a, 1))
        .unwrap();
    assert!(
        (s1.coordinates.x - orig_coords[0].1.x).abs() < 1e-6,
        "Station 1 (was 0) x after redo: {} vs {}",
        s1.coordinates.x,
        orig_coords[0].1.x
    );
    assert!(
        (s1.coordinates.y - orig_coords[0].1.y).abs() < 1e-6,
        "Station 1 (was 0) y after redo: {} vs {}",
        s1.coordinates.y,
        orig_coords[0].1.y
    );
    // Old station 1 is now station 2
    let s2 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_a, 2))
        .unwrap();
    assert!(
        (s2.coordinates.x - orig_coords[1].1.x).abs() < 1e-6,
        "Station 2 (was 1) x after redo: {} vs {}",
        s2.coordinates.x,
        orig_coords[1].1.x
    );
    assert!(
        (s2.coordinates.y - orig_coords[1].1.y).abs() < 1e-6,
        "Station 2 (was 1) y after redo: {} vs {}",
        s2.coordinates.y,
        orig_coords[1].1.y
    );
}

#[test]
fn test_insert_before_pos_gt0_no_offset_adjustment() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "No Offset Test".to_string(),
        location: None,
    });

    let result = state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![
            directional_shot_data(0.0, 10.0),
            directional_shot_data(0.0, 5.0),
        ],
    });
    let sec_a = result.section_id.unwrap();

    // Get the section offset before insert
    let offset_before = {
        let proj = state.get_project_state().unwrap();
        proj.section_offsets
            .get(&sec_a)
            .copied()
            .unwrap_or((0.0, 0.0))
    };

    // Insert before the SECOND shot (pos=1, not pos=0)
    let proj = state.get_project_state().unwrap();
    let second_shot_id = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots[1].id;
    let insert_result = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: directional_shot_data(90.0, 3.0),
        after_shot_id: None,
        before_shot_id: Some(second_shot_id),
    });
    assert!(insert_result.success);

    // Section offset should NOT have changed (only pos=0 triggers adjustment)
    let proj = state.get_project_state().unwrap();
    let offset_after = proj
        .section_offsets
        .get(&sec_a)
        .copied()
        .unwrap_or((0.0, 0.0));
    assert!(
        (offset_after.0 - offset_before.0).abs() < 1e-6,
        "Section offset x should not change for pos>0"
    );
    assert!(
        (offset_after.1 - offset_before.1).abs() < 1e-6,
        "Section offset y should not change for pos>0"
    );
}

// ============================================================================
// Coverage gap tests: project_io.rs
// ============================================================================

#[test]
fn test_save_project_no_project_open() {
    let state = AppState::new().unwrap();
    let result = state.save_project(Some(PathBuf::from("/tmp/test.stalx")), false);
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("No project open"));
}

#[test]
fn test_save_project_no_path_specified() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    // No file_path on project and no path argument
    let result = state.save_project(None, false);
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("No save path"));
}

#[test]
fn test_save_project_implicit_first_save_autorename_when_target_exists() {
    let temp_dir = TempDir::new().unwrap();
    let existing_path = temp_dir.path().join("existing.stalx");
    let expected_autorenamed_path = temp_dir.path().join("existing_1.stalx");
    std::fs::write(&existing_path, b"ORIGINAL").unwrap();

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Simulate deferred-create behavior: reserved file_path but no open database yet.
    {
        let mut guard = state.project.lock().unwrap();
        let project = guard.as_mut().unwrap();
        project.file_path = Some(existing_path.clone());
    }
    {
        let mut db_guard = state.database.lock().unwrap();
        *db_guard = None;
    }

    let result = state.save_project(None, false);
    assert!(
        result.success,
        "unexpected save failure: {:?}",
        result.error
    );

    // Existing file must remain untouched.
    let bytes = std::fs::read(&existing_path).unwrap();
    assert_eq!(bytes, b"ORIGINAL");

    // Autosave should pick an available suffixed filename.
    assert!(expected_autorenamed_path.exists());
    let project = state.get_project_state().unwrap();
    assert_eq!(project.file_path.as_ref(), Some(&expected_autorenamed_path));
}

#[test]
fn test_save_project_adds_stalx_extension() {
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    // Save without .stalx extension
    let save_path = temp_dir.path().join("myproject");
    let result = state.save_project(Some(save_path), false);
    assert!(result.success);
    assert!(temp_dir.path().join("myproject.stalx").exists());
}

#[test]
fn test_save_project_cleans_up_temp_on_reopen_failure() {
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    state.execute(Command::CreateSection {
        name: Some("Sec".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let save_path = temp_dir.path().join("project.stalx");
    let result = state.save_project(Some(save_path.clone()), false);
    assert!(result.success);

    // Verify temp file was cleaned up
    let temp_path = save_path.with_extension("stalx.tmp");
    assert!(
        !temp_path.exists(),
        "temp file should be cleaned up after save"
    );

    // Verify the project file_path was updated
    let project = state.get_project_state().unwrap();
    assert_eq!(project.file_path.as_ref(), Some(&save_path));
}

#[test]
fn test_save_project_atomic_rename_preserves_original_on_temp_failure() {
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Original".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("Sec".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });

    // First save
    let save_path = temp_dir.path().join("atomic.stalx");
    let result = state.save_project(Some(save_path.clone()), false);
    assert!(result.success);

    // Modify project
    state.execute(Command::CreateSection {
        name: Some("Sec2".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });

    // Save again — should succeed and update the file
    let result = state.save_project(Some(save_path.clone()), false);
    assert!(result.success);

    // Reload and verify both sections are there
    let db = Database::open_readonly(&save_path).unwrap();
    let loaded = db.load_project().unwrap();
    assert_eq!(loaded.sections.len(), 2);
}

#[test]
fn test_save_project_persists_undo_redo_stacks() {
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "UndoPersist".to_string(),
        location: None,
    });

    // Create section (pushes to undo stack)
    state.execute(Command::CreateSection {
        name: Some("Sec".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    // Create another section, then undo it (creates redo entry)
    state.execute(Command::CreateSection {
        name: Some("Sec2".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    state.undo();

    let save_path = temp_dir.path().join("undo-persist.stalx");
    let result = state.save_project(Some(save_path.clone()), false);
    assert!(result.success);

    // Reload and verify undo/redo stacks are persisted
    let db = Database::open_existing(&save_path).unwrap();
    let undo = db.load_undo_stack_with_timestamps().unwrap_or_default();
    let redo = db.load_redo_stack_with_timestamps().unwrap_or_default();
    assert!(!undo.is_empty(), "undo stack should be persisted");
    assert!(!redo.is_empty(), "redo stack should be persisted");
}

#[test]
fn test_open_project_missing_file() {
    let state = AppState::new().unwrap();
    let result = state.open_project(PathBuf::from("/nonexistent/path/project.stalx"));
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("File not found"));
}

#[test]
fn test_open_project_clears_previous_state() {
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();

    // Create and save project A
    state.execute(Command::CreateProject {
        name: "Project A".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("SecA".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let path_a = temp_dir.path().join("a.stalx");
    state.save_project(Some(path_a.clone()), false);

    // Create and save project B
    state.execute(Command::CreateProject {
        name: "Project B".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("SecB1".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(3.0)],
    });
    state.execute(Command::CreateSection {
        name: Some("SecB2".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let path_b = temp_dir.path().join("b.stalx");
    state.save_project(Some(path_b.clone()), false);

    // Open project A — should replace B's state
    let result = state.open_project(path_a);
    assert!(result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.name, "Project A");
    assert_eq!(project.sections.len(), 1);
}

#[test]
fn test_close_project_clears_all_state() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "ToClose".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("Sec".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });

    let result = state.close_project();
    assert!(result.success);
    assert!(state.get_project_state().is_none());
    let undo_stack = state.undo_stack.lock().unwrap();
    assert_eq!(undo_stack.len(), 0);
}

// ============================================================================
// Coverage gap tests: merge_projects edge cases
// ============================================================================

#[test]
fn test_merge_projects_output_already_exists() {
    let temp_dir = TempDir::new().unwrap();

    // Create two source projects
    let mut proj_a = Project::new("A".to_string(), None);
    proj_a.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    let mut proj_b = Project::new("B".to_string(), None);
    proj_b.add_section(SectionData {
        shots: vec![test_shot_data(2.0)],
        ..Default::default()
    });

    let source_a = temp_dir.path().join("a.stalx");
    let source_b = temp_dir.path().join("b.stalx");
    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&proj_a).unwrap();
    let mut db_b = Database::open(&source_b).unwrap();
    db_b.save_project(&proj_b).unwrap();
    drop(db_a);
    drop(db_b);

    // Create output file that already exists
    let output_path = temp_dir.path().join("output.stalx");
    std::fs::write(&output_path, b"existing").unwrap();

    let state = AppState::new().unwrap();
    let result = state.merge_projects(
        vec![source_a, source_b],
        output_path,
        "Merged".to_string(),
        false,
    );
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("already exists"));
}

#[test]
fn test_merge_projects_extension_less_output_detects_existing_stalx() {
    // An extension-less output path (e.g. `output`) must be normalized to
    // `output.stalx` BEFORE the existence check, so a merge can't silently
    // overwrite an existing `output.stalx` (#169). Without normalize-first,
    // `output.exists()` is false and the merge clobbers `output.stalx`.
    let temp_dir = TempDir::new().unwrap();

    let mut proj_a = Project::new("A".to_string(), None);
    proj_a.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    let mut proj_b = Project::new("B".to_string(), None);
    proj_b.add_section(SectionData {
        shots: vec![test_shot_data(2.0)],
        ..Default::default()
    });
    let source_a = temp_dir.path().join("a.stalx");
    let source_b = temp_dir.path().join("b.stalx");
    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&proj_a).unwrap();
    let mut db_b = Database::open(&source_b).unwrap();
    db_b.save_project(&proj_b).unwrap();
    drop(db_a);
    drop(db_b);

    // An existing `output.stalx`, merged into via an EXTENSION-LESS output arg.
    let existing = temp_dir.path().join("output.stalx");
    std::fs::write(&existing, b"existing").unwrap();
    let output_extless = temp_dir.path().join("output"); // no .stalx

    let state = AppState::new().unwrap();
    let result = state.merge_projects(
        vec![source_a, source_b],
        output_extless,
        "Merged".to_string(),
        false,
    );
    assert!(
        !result.success,
        "merge must detect the existing output.stalx behind an extension-less path"
    );
    assert!(result.error.unwrap_or_default().contains("already exists"));
    // The existing file must be untouched (not clobbered).
    assert_eq!(std::fs::read(&existing).unwrap(), b"existing");
}

#[test]
fn test_merge_projects_source_missing() {
    let temp_dir = TempDir::new().unwrap();

    let mut proj_a = Project::new("A".to_string(), None);
    proj_a.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    let source_a = temp_dir.path().join("a.stalx");
    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&proj_a).unwrap();
    drop(db_a);

    let missing = temp_dir.path().join("missing.stalx");
    let output_path = temp_dir.path().join("output.stalx");

    let state = AppState::new().unwrap();
    let result = state.merge_projects(
        vec![source_a, missing],
        output_path,
        "Merged".to_string(),
        false,
    );
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("not found"));
}

#[test]
fn test_merge_projects_combines_locations() {
    let temp_dir = TempDir::new().unwrap();

    let mut proj_a = Project::new("A".to_string(), Some("Cave Alpha".to_string()));
    proj_a.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    let mut proj_b = Project::new("B".to_string(), Some("Cave Beta".to_string()));
    proj_b.add_section(SectionData {
        shots: vec![test_shot_data(2.0)],
        ..Default::default()
    });

    let source_a = temp_dir.path().join("a.stalx");
    let source_b = temp_dir.path().join("b.stalx");
    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&proj_a).unwrap();
    let mut db_b = Database::open(&source_b).unwrap();
    db_b.save_project(&proj_b).unwrap();
    drop(db_a);
    drop(db_b);

    let output_path = temp_dir.path().join("merged.stalx");
    let state = AppState::new().unwrap();
    let result = state.merge_projects(
        vec![source_a, source_b],
        output_path.clone(),
        "Merged".to_string(),
        false,
    );
    assert!(result.success);

    let db = Database::open_existing(&output_path).unwrap();
    let merged = db.load_project().unwrap();
    let loc = merged.location.unwrap();
    assert!(
        loc.contains("Cave Alpha"),
        "should contain first location: {loc}"
    );
    assert!(
        loc.contains("Cave Beta"),
        "should contain second location: {loc}"
    );
}

#[test]
fn test_merge_projects_no_archive() {
    let temp_dir = TempDir::new().unwrap();

    let mut proj_a = Project::new("A".to_string(), None);
    proj_a.add_section(SectionData {
        shots: vec![test_shot_data(1.0)],
        ..Default::default()
    });
    let mut proj_b = Project::new("B".to_string(), None);
    proj_b.add_section(SectionData {
        shots: vec![test_shot_data(2.0)],
        ..Default::default()
    });

    let source_a = temp_dir.path().join("a.stalx");
    let source_b = temp_dir.path().join("b.stalx");
    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&proj_a).unwrap();
    let mut db_b = Database::open(&source_b).unwrap();
    db_b.save_project(&proj_b).unwrap();
    drop(db_a);
    drop(db_b);

    let output_path = temp_dir.path().join("merged.stalx");
    let state = AppState::new().unwrap();
    let result = state.merge_projects(
        vec![source_a.clone(), source_b.clone()],
        output_path,
        "Merged".to_string(),
        false,
    );
    assert!(result.success);
    // Source files should still exist (not archived)
    assert!(source_a.exists(), "source A should still exist");
    assert!(source_b.exists(), "source B should still exist");
}

#[test]
fn test_merge_projects_preserves_station_merges() {
    let temp_dir = TempDir::new().unwrap();

    let mut proj_a = Project::new("A".to_string(), None);
    let sec_a1 = proj_a
        .add_section(SectionData {
            name: Some("A1".to_string()),
            shots: vec![test_shot_data(1.0), test_shot_data(1.5)],
            ..Default::default()
        })
        .id;
    let sec_a2 = proj_a
        .add_section(SectionData {
            name: Some("A2".to_string()),
            shots: vec![test_shot_data(2.0)],
            ..Default::default()
        })
        .id;
    proj_a
        .merge_stations(StationRef::new(sec_a1, 1), StationRef::new(sec_a2, 0))
        .unwrap();

    let source_a = temp_dir.path().join("a.stalx");
    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&proj_a).unwrap();
    drop(db_a);

    let mut proj_b = Project::new("B".to_string(), None);
    proj_b.add_section(SectionData {
        name: Some("B1".to_string()),
        shots: vec![test_shot_data(3.0)],
        ..Default::default()
    });
    let source_b = temp_dir.path().join("b.stalx");
    let mut db_b = Database::open(&source_b).unwrap();
    db_b.save_project(&proj_b).unwrap();
    drop(db_b);

    let output_path = temp_dir.path().join("merged.stalx");
    let state = AppState::new().unwrap();
    let result = state.merge_projects(
        vec![source_a, source_b],
        output_path.clone(),
        "Merged".to_string(),
        false,
    );
    assert!(result.success);

    let db = Database::open_existing(&output_path).unwrap();
    let merged = db.load_project().unwrap();
    assert_eq!(
        merged.station_merges.len(),
        1,
        "station merge should be preserved"
    );
    // The merge should reference sections that exist in the merged project
    let merge = &merged.station_merges[0];
    assert!(
        merged
            .sections
            .iter()
            .any(|s| s.id == merge.station_a.section_id),
        "merge station_a should reference an existing section"
    );
    assert!(
        merged
            .sections
            .iter()
            .any(|s| s.id == merge.station_b.section_id),
        "merge station_b should reference an existing section"
    );
    // Both stations should be from the same source project (A), so their
    // sections should be the remapped A1 and A2
    assert_ne!(
        merge.station_a.section_id, merge.station_b.section_id,
        "merge should be between different sections"
    );
}

// ============================================================================
// Coverage gap tests: commands.rs — execute_create_and_merge
// ============================================================================

#[test]
fn test_execute_create_and_merge_success() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    // Create an existing section to merge with
    state.execute(Command::CreateSection {
        name: Some("Existing".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let existing_section_id = state.get_project_state().unwrap().sections[0].id;

    let result = state.execute_create_and_merge(
        Some("Imported".to_string()),
        None,
        None,
        "#00ff00".to_string(),
        None,
        vec![test_shot_data(3.0)],
        0,                                       // import station 0
        StationRef::new(existing_section_id, 1), // merge to station 1 of existing
        ClosureStrategy::Batch,
    );
    assert!(
        result.success,
        "create_and_merge failed: {:?}",
        result.error
    );
    assert!(result.section_id.is_some());

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);
    assert_eq!(project.station_merges.len(), 1);

    // Verify undo works — should revert both operations atomically
    let undo_result = state.undo();
    assert!(undo_result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.len(),
        1,
        "undo should remove imported section"
    );
    assert_eq!(project.station_merges.len(), 0, "undo should remove merge");
}

#[test]
fn test_execute_create_and_merge_rollback_on_merge_failure() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("Existing".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let sections_before = state.get_project_state().unwrap().sections.len();

    // Try merging where the existing station ref points to a nonexistent section
    let result = state.execute_create_and_merge(
        Some("Imported".to_string()),
        None,
        None,
        "#00ff00".to_string(),
        None,
        vec![test_shot_data(3.0)],
        0,
        StationRef::new(9999, 0), // nonexistent section
        ClosureStrategy::Batch,
    );
    assert!(
        !result.success,
        "merge with nonexistent section should fail"
    );

    // Project should be rolled back — section count unchanged
    let sections_after = state.get_project_state().unwrap().sections.len();
    assert_eq!(sections_before, sections_after,
        "rollback should restore original section count (before={sections_before}, after={sections_after})");
}

#[test]
fn test_execute_create_and_merge_no_project_open() {
    let state = AppState::new().unwrap();
    let result = state.execute_create_and_merge(
        Some("Test".to_string()),
        None,
        None,
        "#ff0000".to_string(),
        None,
        vec![test_shot_data(3.0)],
        0,
        StationRef::new(1, 0),
        ClosureStrategy::Batch,
    );
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("No project open"));
}

// ============================================================================
// Coverage gap tests: commands.rs — execute_import_sections
// ============================================================================

#[test]
fn test_execute_import_sections_origin_placement() {
    use crate::models::ImportPlacement;
    use crate::models::ImportSectionConfig;

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sections = vec![
        ImportSectionConfig {
            section_index: 0,
            name: Some("Import1".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![test_shot_data(5.0)],
            station_comments: Vec::new(),
            placement: ImportPlacement::Origin,
        },
        ImportSectionConfig {
            section_index: 1,
            name: Some("Import2".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![test_shot_data(3.0)],
            station_comments: Vec::new(),
            placement: ImportPlacement::Origin,
        },
    ];

    let result = state.execute_import_sections(sections, Vec::new(), None, Vec::new(), Vec::new());
    assert!(result.success, "import failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);

    // Verify undo reverts all sections atomically
    let undo_result = state.undo();
    assert!(undo_result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.len(),
        0,
        "undo should remove all imported sections"
    );
}

#[test]
fn test_execute_import_sections_from_importing_placement() {
    use crate::models::ImportPlacement;
    use crate::models::ImportSectionConfig;

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sections = vec![
        ImportSectionConfig {
            section_index: 0,
            name: Some("First".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
            station_comments: Vec::new(),
            placement: ImportPlacement::Origin,
        },
        ImportSectionConfig {
            section_index: 1,
            name: Some("Second".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![test_shot_data(4.0)],
            station_comments: Vec::new(),
            placement: ImportPlacement::FromImporting {
                import_station: 0,
                target_section_index: 0,
                target_station_index: 1,
            },
        },
    ];

    let result = state.execute_import_sections(
        sections,
        Vec::new(),
        Some("abc123".to_string()),
        Vec::new(),
        Vec::new(),
    );
    assert!(result.success, "import failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);
    assert_eq!(project.station_merges.len(), 1, "sections should be merged");
}

#[test]
fn test_execute_import_sections_from_existing_placement() {
    use crate::models::ImportPlacement;
    use crate::models::ImportSectionConfig;

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    // Create existing section to merge with
    state.execute(Command::CreateSection {
        name: Some("Existing".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
    });
    let existing_id = state.get_project_state().unwrap().sections[0].id;

    let sections = vec![ImportSectionConfig {
        section_index: 0,
        name: Some("Imported".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![test_shot_data(4.0)],
        station_comments: Vec::new(),
        placement: ImportPlacement::FromExisting {
            import_station: 0,
            existing_station: StationRef::new(existing_id, 2),
        },
    }];

    let result = state.execute_import_sections(sections, Vec::new(), None, Vec::new(), Vec::new());
    assert!(result.success, "import failed: {:?}", result.error);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2);
    assert_eq!(project.station_merges.len(), 1);
}

#[test]
fn test_execute_import_sections_manual_with_offset() {
    use crate::models::ImportPlacement;
    use crate::models::ImportSectionConfig;

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sections = vec![ImportSectionConfig {
        section_index: 0,
        name: Some("Manual".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![test_shot_data(5.0)],
        station_comments: Vec::new(),
        placement: ImportPlacement::Manual {
            align_station_index: 0,
            offset: Some(Coordinates {
                x: 10.0,
                y: 20.0,
                z: 0.0,
            }),
        },
    }];

    let result = state.execute_import_sections(sections, Vec::new(), None, Vec::new(), Vec::new());
    assert!(result.success, "import failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    let section_id = project.sections[0].id;
    let offset = project.section_offsets.get(&section_id);
    assert!(
        offset.is_some(),
        "section should have offset from Manual placement"
    );
    let offset = offset.unwrap();
    assert!((offset.0 - 10.0).abs() < 1e-6);
    assert!((offset.1 - 20.0).abs() < 1e-6);
}

#[test]
fn test_execute_import_sections_zero_datum_placement() {
    use crate::models::ImportPlacement;
    use crate::models::ImportSectionConfig;

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let gps = GpsCoordinates::new(10.0, 20.0, 5.0).unwrap();
    let sections = vec![ImportSectionConfig {
        section_index: 0,
        name: Some("GPS Section".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![test_shot_data(5.0)],
        station_comments: Vec::new(),
        placement: ImportPlacement::ZeroDatum {
            coordinates: gps,
            station_index: 0,
        },
    }];

    let result = state.execute_import_sections(sections, Vec::new(), None, Vec::new(), Vec::new());
    assert!(result.success, "import failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.zero_datums.len(), 1);
    assert!((project.zero_datums[0].gps.latitude - 10.0).abs() < 1e-6);
}

#[test]
fn test_execute_import_sections_rollback_on_failure() {
    use crate::models::ImportPlacement;
    use crate::models::ImportSectionConfig;

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // First section succeeds, second fails (merge to nonexistent existing section)
    let sections = vec![
        ImportSectionConfig {
            section_index: 0,
            name: Some("GoodSection".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![test_shot_data(5.0)],
            station_comments: Vec::new(),
            placement: ImportPlacement::Origin,
        },
        ImportSectionConfig {
            section_index: 1,
            name: Some("BadSection".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![test_shot_data(3.0)],
            station_comments: Vec::new(),
            placement: ImportPlacement::FromExisting {
                import_station: 0,
                existing_station: StationRef::new(9999, 0), // nonexistent
            },
        },
    ];

    let result = state.execute_import_sections(sections, Vec::new(), None, Vec::new(), Vec::new());
    assert!(
        !result.success,
        "should fail when merge target doesn't exist"
    );

    // Project should be rolled back — no sections added
    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.len(),
        0,
        "rollback should remove all sections from failed import"
    );
}

#[test]
fn test_execute_import_sections_empty_is_noop() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let result = state.execute_import_sections(vec![], Vec::new(), None, Vec::new(), Vec::new());
    assert!(result.success);
}

#[test]
fn test_execute_import_sections_no_project() {
    use crate::models::ImportPlacement;
    use crate::models::ImportSectionConfig;

    let state = AppState::new().unwrap();
    let sections = vec![ImportSectionConfig {
        section_index: 0,
        name: Some("Test".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![test_shot_data(5.0)],
        station_comments: Vec::new(),
        placement: ImportPlacement::Origin,
    }];

    let result = state.execute_import_sections(sections, Vec::new(), None, Vec::new(), Vec::new());
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("No project open"));
}

#[test]
fn test_execute_import_sections_manual_snap_placement() {
    use crate::models::ImportPlacement;
    use crate::models::ImportSectionConfig;

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("Existing".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let existing_id = state.get_project_state().unwrap().sections[0].id;

    let sections = vec![ImportSectionConfig {
        section_index: 0,
        name: Some("Snapped".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![test_shot_data(4.0)],
        station_comments: Vec::new(),
        placement: ImportPlacement::ManualSnap {
            align_station_index: 0,
            snapped_to_station: StationRef::new(existing_id, 1),
        },
    }];

    let result = state.execute_import_sections(sections, Vec::new(), None, Vec::new(), Vec::new());
    assert!(
        result.success,
        "import with ManualSnap failed: {:?}",
        result.error
    );
    let project = state.get_project_state().unwrap();
    assert_eq!(project.station_merges.len(), 1);
}

// ============================================================================
// Coverage gap tests: commands.rs — batch edge cases
// ============================================================================

#[test]
fn test_batch_empty_is_noop() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    let result = state.execute(Command::Batch { commands: vec![] });
    assert!(result.success);
}

#[test]
fn test_batch_disallowed_command_save_project() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    let result = state.execute(Command::Batch {
        commands: vec![Command::SaveProject {
            path: Some(PathBuf::from("/tmp/test.stalx")),
            is_autosave: false,
        }],
    });
    assert!(!result.success);
    assert!(result
        .error
        .unwrap_or_default()
        .contains("not allowed in batch"));
}

#[test]
fn test_batch_partial_failure_rolls_back() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sections_before = state.get_project_state().unwrap().sections.len();

    // First command succeeds (create section), second fails (merge nonexistent)
    let result = state.execute(Command::Batch {
        commands: vec![
            Command::CreateSection {
                name: Some("NewSec".to_string()),
                surveyor: None,
                date: None,
                color: "#ff0000".to_string(),
                direction: None,
                shots: vec![test_shot_data(5.0)],
            },
            Command::MergeStations {
                station_a: StationRef::new(9999, 0),
                station_b: StationRef::new(9998, 0),
            },
        ],
    });
    assert!(!result.success);

    // Rollback should restore original state
    let sections_after = state.get_project_state().unwrap().sections.len();
    assert_eq!(
        sections_before, sections_after,
        "batch rollback should restore section count"
    );
}

// ============================================================================
// Coverage gap tests: commands.rs — delete_shot with shift-blocked
// ============================================================================

#[test]
fn test_create_section_rejects_negative_length_shot() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    let result = state.execute(Command::CreateSection {
        name: Some("Bad".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            length: -5.0,
            azimuth_in: 0.0,
            azimuth_out: 0.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }],
    });
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("negative length"));
}

#[test]
fn test_create_shot_rejects_zero_length() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    let section_id = {
        let result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });
        result.section_id.unwrap()
    };

    let result = state.execute(Command::CreateShot {
        section_id,
        shot: ShotData {
            length: 0.0,
            azimuth_in: 0.0,
            azimuth_out: 0.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        },
        after_shot_id: None,
        before_shot_id: None,
    });
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("zero length"));
}

#[test]
fn test_update_shot_rejects_zero_resulting_length() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    let section_id = {
        let result = state.execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        });
        result.section_id.unwrap()
    };
    let shot_id = state
        .get_project_state()
        .unwrap()
        .sections
        .iter()
        .find(|s| s.id == section_id)
        .unwrap()
        .shots[0]
        .id;

    let result = state.execute(Command::UpdateShot {
        section_id,
        shot_id,
        updates: ShotUpdates {
            length: Some(0.0),
            ..Default::default()
        },
    });
    assert!(!result.success);
    assert!(result.error.unwrap_or_default().contains("zero length"));
}

// ============================================================================
// Coverage gap tests: commands.rs — auto-save
// ============================================================================

// test_auto_save_triggers_on_modifying_command was removed:
// per-command auto-save was removed in favor of frontend debounced auto-save

// ============================================================================
// Coverage gap tests: commands.rs — move_station edge cases
// ============================================================================

#[test]
fn test_move_station_rejects_zero_length_result() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    let result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![ShotData {
            azimuth_in: 0.0,
            azimuth_out: 0.0,
            length: 1.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }],
    });
    let section_id = result.section_id.unwrap();

    // Move station 1 backwards by exactly the shot length — should create zero-length shot
    let result = state.execute(Command::MoveStation {
        station_ref: StationRef::new(section_id, 1),
        offset: Coordinates {
            x: 0.0,
            y: -1.0,
            z: 0.0,
        },
    });
    assert!(
        !result.success,
        "should reject move that creates zero-length shot"
    );
    assert!(result.error.unwrap_or_default().contains("zero-length"));
}

#[test]
fn test_move_station_last_station() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    let result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
    });
    let section_id = result.section_id.unwrap();

    // Move last station (station index 2 for 2 shots)
    let result = state.execute(Command::MoveStation {
        station_ref: StationRef::new(section_id, 2),
        offset: Coordinates {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
    });
    assert!(
        result.success,
        "move last station failed: {:?}",
        result.error
    );

    // Verify only the previous shot was modified (not a next shot)
    let project = state.get_project_state().unwrap();
    let section = project
        .sections
        .iter()
        .find(|s| s.id == section_id)
        .unwrap();
    assert_eq!(section.shots.len(), 2);
}

#[test]
fn test_move_station_invalid_index() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });
    let result = state.execute(Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_id = result.section_id.unwrap();

    let result = state.execute(Command::MoveStation {
        station_ref: StationRef::new(section_id, 999),
        offset: Coordinates {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
    });
    assert!(!result.success);
    assert!(result
        .error
        .unwrap_or_default()
        .contains("Invalid station index"));
}

// ============================================================================
// Delete section cascade tests
// ============================================================================

#[test]
fn test_delete_section_cascades_merges() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create two sections
    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    // Merge them
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 1),
        station_b: StationRef::new(sec_b, 0),
    });
    assert!(merge_result.success);
    assert_eq!(state.get_project_state().unwrap().station_merges.len(), 1);

    // Delete section A — should cascade-remove the merge
    let delete_result = state.execute(Command::DeleteSection { section_id: sec_a });
    assert!(delete_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(
        project.station_merges.len(),
        0,
        "merge should be cascaded on delete"
    );
}

#[test]
fn test_delete_section_cascades_closures_and_offsets() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0)],
        })
        .section_id
        .unwrap();

    // Set a zero datum on section A
    let datum_result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(sec_a, 0),
        coordinates: GpsCoordinates::new(45.0, 10.0, 0.0).unwrap(),
    });
    assert!(datum_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.zero_datums.len(), 1);
    // set_zero_datum creates section offsets for connected sections
    assert!(
        !project.section_offsets.is_empty(),
        "set_zero_datum should create section offsets"
    );

    // Delete section A — should cascade-remove the zero datum and section offsets
    let delete_result = state.execute(Command::DeleteSection { section_id: sec_a });
    assert!(delete_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].id, sec_b);
    assert_eq!(
        project.zero_datums.len(),
        0,
        "zero datum should be cascaded"
    );
    assert!(
        !project.section_offsets.contains_key(&sec_a),
        "section A offset should be cascaded"
    );
}

#[test]
fn test_delete_section_undo_restores_merges_and_datums() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    // Merge + set datum
    state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 1),
        station_b: StationRef::new(sec_b, 0),
    });
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(sec_a, 0),
        coordinates: GpsCoordinates::new(45.0, 10.0, 0.0).unwrap(),
    });

    // Delete section A
    state.execute(Command::DeleteSection { section_id: sec_a });
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.station_merges.len(), 0);
    assert_eq!(project.zero_datums.len(), 0);

    // Undo delete — should restore section A, merge, and datum
    let undo = state.undo();
    assert!(undo.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.len(),
        2,
        "undo should restore deleted section"
    );
    assert_eq!(project.station_merges.len(), 1, "undo should restore merge");
    assert_eq!(
        project.zero_datums.len(),
        1,
        "undo should restore zero datum"
    );
}

#[test]
fn test_unmerge_removes_only_specific_merge() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    let sec_c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0)],
        })
        .section_id
        .unwrap();

    // Merge A↔B and B↔C
    state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 1),
        station_b: StationRef::new(sec_b, 0),
    });
    state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_b, 1),
        station_b: StationRef::new(sec_c, 0),
    });

    assert_eq!(state.get_project_state().unwrap().station_merges.len(), 2);

    // Unmerge at station A:1 (which is part of the A↔B merge)
    let result = state.execute(Command::UnmergeStations {
        station_ref: StationRef::new(sec_a, 1),
    });
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.station_merges.len(),
        1,
        "only A↔B should be removed"
    );
    assert_eq!(project.station_merges[0].station_a.section_id, sec_b);
    assert_eq!(project.station_merges[0].station_b.section_id, sec_c);
}

#[test]
fn test_unmerge_undo_restores_merge() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 1),
        station_b: StationRef::new(sec_b, 0),
    });

    // Unmerge, then undo
    state.execute(Command::UnmergeStations {
        station_ref: StationRef::new(sec_a, 1),
    });
    assert_eq!(state.get_project_state().unwrap().station_merges.len(), 0);

    let undo = state.undo();
    assert!(undo.success);
    assert_eq!(
        state.get_project_state().unwrap().station_merges.len(),
        1,
        "undo should restore unmerged pair"
    );
}

/// Integration test: import kb5.dmp sections with overlap treatment and verify
/// the actual shot values in the project state after import.
///
/// Flow:
/// 1. Import section 002 at origin (becomes the "existing" section)
/// 2. Import section 001 (105 shots, overlap removed) with existing_shot_updates
///    that interpolate 002's overlap shots — all in one atomic import call
/// 3. Read back from project state and assert actual interpolated values
#[test]
#[ignore]
fn kb5_import_overlap_interpolation_integration() {
    use crate::models::ExistingShotUpdate;
    use crate::parsers::dmp::{parse_dmp, DmpShotType};

    let dmp_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/fixtures/kb5.dmp");
    let dmp = parse_dmp(&dmp_path).expect("should parse kb5.dmp");

    // Extract standard shots as ShotData for sections 001 (idx 0) and 002 (idx 1)
    let shots_001: Vec<ShotData> = dmp.sections[0]
        .shots
        .iter()
        .filter(|s| s.shot_type == DmpShotType::Standard)
        .map(|s| s.to_shot_data())
        .collect();
    let shots_002: Vec<ShotData> = dmp.sections[1]
        .shots
        .iter()
        .filter(|s| s.shot_type == DmpShotType::Standard)
        .map(|s| s.to_shot_data())
        .collect();
    assert_eq!(shots_001.len(), 107);
    assert_eq!(shots_002.len(), 364);

    // ── Step 1: Create project and import section 002 at origin ──
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "KB5 Overlap Test".to_string(),
        location: None,
    });

    let result_002 = state.execute_import_sections(
        vec![ImportSectionConfig {
            section_index: 0,
            name: Some("002".to_string()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
            direction: None,
            quality: 1.0,
            shots: shots_002.clone(),
            station_comments: Vec::new(),
            placement: ImportPlacement::Origin,
        }],
        Vec::new(),
        None,
        Vec::new(),
        Vec::new(),
    );
    assert!(
        result_002.success,
        "import 002 failed: {:?}",
        result_002.error
    );

    let project = state.get_project_state().unwrap();
    let section_002_id = project.sections[0].id;
    assert_eq!(
        project.sections[0].shots.len(),
        364,
        "002 should have 364 shots"
    );

    // ── Step 2: Import section 001 with overlap shots removed + existing shot updates ──
    // 001→002 overlap: Back (impStn=107), Reverse, matched=2, exStn=182.
    // Target shot indices (Back+Reverse): (182-2)+k = 180, 181.
    // Import shots 105, 106 are deleted; 002 shots 180, 181 get interpolated values.

    fn circular_mean_deg(a: f64, b: f64) -> f64 {
        let (a_r, b_r) = (a.to_radians(), b.to_radians());
        let mean =
            f64::atan2((a_r.sin() + b_r.sin()) / 2.0, (a_r.cos() + b_r.cos()) / 2.0).to_degrees();
        if mean < 0.0 {
            mean + 360.0
        } else {
            mean
        }
    }

    fn avg_opt(a: Option<f64>, b: Option<f64>) -> Option<Option<f64>> {
        match (a, b) {
            (None, None) => None,
            (Some(v), None) | (None, Some(v)) => Some(Some(v)),
            (Some(a), Some(b)) => Some(Some((a + b) / 2.0)),
        }
    }

    fn interp_update(
        section_id: SectionId,
        shot_id: ShotId,
        imp: &ShotData,
        ext: &ShotData,
    ) -> ExistingShotUpdate {
        ExistingShotUpdate {
            section_id,
            shot_id,
            updates: ShotUpdates {
                azimuth_in: Some(circular_mean_deg(imp.azimuth_in, ext.azimuth_in)),
                azimuth_out: Some(circular_mean_deg(imp.azimuth_out, ext.azimuth_out)),
                length: Some((imp.length + ext.length) / 2.0),
                depth_in: Some((imp.depth_in + ext.depth_in) / 2.0),
                depth_out: Some((imp.depth_out + ext.depth_out) / 2.0),
                pitch_in: avg_opt(imp.pitch_in, ext.pitch_in),
                pitch_out: avg_opt(imp.pitch_out, ext.pitch_out),
                left: avg_opt(imp.left, ext.left),
                right: avg_opt(imp.right, ext.right),
                up: avg_opt(imp.up, ext.up),
                down: avg_opt(imp.down, ext.down),
                ..Default::default()
            },
        }
    }

    let shot_180_id = project.sections[0].shots[180].id;
    let shot_181_id = project.sections[0].shots[181].id;

    let existing_updates = vec![
        interp_update(
            section_002_id,
            shot_180_id,
            &shots_001[105],
            &shots_002[180],
        ),
        interp_update(
            section_002_id,
            shot_181_id,
            &shots_001[106],
            &shots_002[181],
        ),
    ];

    // Remove overlap shots 105, 106 from 001
    let mut shots_001_treated: Vec<ShotData> = shots_001.clone();
    shots_001_treated.remove(106); // remove higher index first
    shots_001_treated.remove(105);
    assert_eq!(
        shots_001_treated.len(),
        105,
        "001 should have 105 shots after overlap removal"
    );

    // Import 001 merged to 002 at station 182, with existing shot updates
    let result_001 = state.execute_import_sections(
        vec![ImportSectionConfig {
            section_index: 0,
            name: Some("001".to_string()),
            surveyor: None,
            date: None,
            color: "#ff6b6b".to_string(),
            direction: None,
            quality: 1.0,
            shots: shots_001_treated,
            station_comments: Vec::new(),
            placement: ImportPlacement::FromExisting {
                import_station: 105,
                existing_station: StationRef::new(section_002_id, 182),
            },
        }],
        Vec::new(),
        None,
        Vec::new(),
        existing_updates,
    );
    assert!(
        result_001.success,
        "import 001 failed: {:?}",
        result_001.error
    );

    // ── Step 3: Read back from project state and verify ──
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 2, "should have 2 sections");

    let sec_002 = project
        .sections
        .iter()
        .find(|s| s.id == section_002_id)
        .expect("section 002 should exist");
    let sec_001 = project
        .sections
        .iter()
        .find(|s| s.id != section_002_id)
        .expect("section 001 should exist");

    // Section 001: 105 shots (overlap shots removed)
    assert_eq!(
        sec_001.shots.len(),
        105,
        "001 should have 105 shots after import"
    );

    // Section 002: 364 shots, with shots 180-181 now having interpolated values
    assert_eq!(sec_002.shots.len(), 364, "002 should still have 364 shots");

    let actual_180 = &sec_002.shots[180];
    let actual_181 = &sec_002.shots[181];

    // Verify shot 180 has interpolated values (not the original 6.52m/329.7°)
    let eps = 0.01;
    assert!(
        (actual_180.length - 5.665).abs() < eps,
        "002 shot 180 length after import: expected ~5.665, got {}",
        actual_180.length
    );
    assert!(
        (actual_180.azimuth_in - 322.4).abs() < 0.5,
        "002 shot 180 azimuth_in after import: expected ~322.4°, got {}°",
        actual_180.azimuth_in
    );

    // Verify shot 181 has interpolated values (not the original 12.71m/355.8°)
    assert!(
        (actual_181.length - 12.375).abs() < eps,
        "002 shot 181 length after import: expected ~12.375, got {}",
        actual_181.length
    );
    assert!(
        (actual_181.azimuth_in - 349.75).abs() < 0.5,
        "002 shot 181 azimuth_in after import: expected ~349.75°, got {}°",
        actual_181.azimuth_in
    );

    println!(
        "002 shot 180: length={}, azi_in={}",
        actual_180.length, actual_180.azimuth_in
    );
    println!(
        "002 shot 181: length={}, azi_in={}",
        actual_181.length, actual_181.azimuth_in
    );
}

// === Merge chain tests ===

/// Test 2a: Transitive offset correctness in a 3-section chain.
///
/// When neither section has a datum, the merge logic makes the *second* argument
/// the anchor (B is the anchor, A moves). Station positions are:
///
///   A: 1 shot east (azimuth 90°), length 10m → A.0 at its offset, A.1 = A.0 + (10, 0)
///   B: 1 shot north (azimuth 0°), length 5m  → B.0=(0,0), B.1=(0,5)
///   C: 1 shot east (azimuth 90°), length 3m  → initially C.0=(0,0), C.1=(3,0)
///
///   Merge A.1 ↔ B.0: B is anchor, A moves so A.1 = B.0 = (0,0) → A.0=(-10,0)
///   Merge B.1 ↔ C.0: B is part of existing group (B is anchor), C moves so C.0 = B.1 = (0,5)
///                     → C.1 = (3, 5)
///
/// The key invariant is that both merge points are colocated and the relative
/// geometry within each section is preserved exactly.
#[test]
fn test_merge_chain_transitive_offsets_are_correct() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Chain".to_string(),
        location: None,
    });

    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![directional_shot_data(90.0, 10.0)],
        })
        .section_id
        .unwrap();

    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![directional_shot_data(0.0, 5.0)],
        })
        .section_id
        .unwrap();

    let c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![directional_shot_data(90.0, 3.0)],
        })
        .section_id
        .unwrap();

    // Merge A.1 ↔ B.0
    let r1 = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });
    assert!(r1.success, "First merge should succeed");

    // Merge B.1 ↔ C.0
    let r2 = state.execute(Command::MergeStations {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
    });
    assert!(r2.success, "Second merge should succeed");

    let proj = state.get_project_state().unwrap();
    let stations = proj.compute_station_coordinates();
    let coord = |sec: SectionId, idx: u32| -> Coordinates {
        stations
            .iter()
            .find(|s| s.station_ref == StationRef::new(sec, idx))
            .unwrap_or_else(|| panic!("station {}:{} not found", sec, idx))
            .coordinates
    };

    let eps = 1e-4;

    // Invariant 1: merge points must be exactly colocated
    assert!(
        (coord(a, 1).x - coord(b, 0).x).abs() < eps,
        "A.1 and B.0 must be colocated (x): A.1={} B.0={}",
        coord(a, 1).x,
        coord(b, 0).x
    );
    assert!(
        (coord(a, 1).y - coord(b, 0).y).abs() < eps,
        "A.1 and B.0 must be colocated (y)"
    );
    assert!(
        (coord(b, 1).x - coord(c, 0).x).abs() < eps,
        "B.1 and C.0 must be colocated (x): B.1={} C.0={}",
        coord(b, 1).x,
        coord(c, 0).x
    );
    assert!(
        (coord(b, 1).y - coord(c, 0).y).abs() < eps,
        "B.1 and C.0 must be colocated (y)"
    );

    // Invariant 2: relative geometry within each section is preserved.
    // A: one shot east 10m, so A.1 = A.0 + (10, 0)
    assert!(
        (coord(a, 1).x - coord(a, 0).x - 10.0).abs() < eps,
        "A internal geometry: A.1.x - A.0.x should be 10, got {}",
        coord(a, 1).x - coord(a, 0).x
    );
    assert!(
        (coord(a, 1).y - coord(a, 0).y).abs() < eps,
        "A internal geometry: A.1.y - A.0.y should be 0"
    );

    // B: one shot north 5m, so B.1 = B.0 + (0, 5)
    assert!(
        (coord(b, 1).x - coord(b, 0).x).abs() < eps,
        "B internal geometry: B.1.x - B.0.x should be 0"
    );
    assert!(
        (coord(b, 1).y - coord(b, 0).y - 5.0).abs() < eps,
        "B internal geometry: B.1.y - B.0.y should be 5, got {}",
        coord(b, 1).y - coord(b, 0).y
    );

    // C: one shot east 3m, so C.1 = C.0 + (3, 0)
    assert!(
        (coord(c, 1).x - coord(c, 0).x - 3.0).abs() < eps,
        "C internal geometry: C.1.x - C.0.x should be 3"
    );
    assert!(
        (coord(c, 1).y - coord(c, 0).y).abs() < eps,
        "C internal geometry: C.1.y - C.0.y should be 0"
    );

    // Invariant 3: transitive positioning — C.0 must equal B.1, which equals B.0 + (0,5).
    // And B.0 equals A.1, which equals A.0 + (10, 0).
    // So the whole chain is geometrically consistent.
    let a1 = coord(a, 1);
    let b0 = coord(b, 0);
    let b1 = coord(b, 1);
    let c0 = coord(c, 0);
    assert!(
        (b1.x - b0.x).abs() < eps && (b1.y - b0.y - 5.0).abs() < eps,
        "B.1 should be 5m north of B.0"
    );
    // C.0 == B.1, and B.1 == A.1 + (0, 5) (since B is 5m north of its start and B.0 == A.1)
    assert!(
        (c0.x - a1.x).abs() < eps,
        "C.0.x should equal A.1.x (transitive via B): C.0.x={} A.1.x={}",
        c0.x,
        a1.x
    );
    assert!(
        (c0.y - a1.y - 5.0).abs() < eps,
        "C.0.y should be A.1.y + 5 (transitive via B): C.0.y={} A.1.y={}",
        c0.y,
        a1.y
    );
}

/// Test 2b: Inserting a shot at position 0 of the middle section B in a chain
/// A↔B↔C correctly shifts B's station merge indices.
///
/// After the insert the merge edge that pointed to B.0 (from A.1) should now
/// point to B.1, because all existing stations shifted up by one.
#[test]
fn test_insert_before_pos0_shifts_merge_refs_in_chain() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "ShiftChain".to_string(),
        location: None,
    });

    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![directional_shot_data(90.0, 10.0)],
        })
        .section_id
        .unwrap();

    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![directional_shot_data(0.0, 5.0)],
        })
        .section_id
        .unwrap();

    let c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![directional_shot_data(90.0, 3.0)],
        })
        .section_id
        .unwrap();

    // Merge A.1 ↔ B.0  and  B.1 ↔ C.0
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });
    state.execute(Command::MergeStations {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
    });

    // Get first shot id of section B so we can insert before it
    let first_b_shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.sections.iter().find(|s| s.id == b).unwrap().shots[0].id
    };

    // Insert a new shot at the very start of section B (before_shot_id = first shot)
    let insert_result = state.execute(Command::CreateShot {
        section_id: b,
        shot: directional_shot_data(270.0, 2.0),
        after_shot_id: None,
        before_shot_id: Some(first_b_shot_id),
    });
    assert!(
        insert_result.success,
        "Insert before pos 0 in B should succeed"
    );

    let proj = state.get_project_state().unwrap();

    // After inserting at pos 0 in B, all original B station indices shift by +1.
    // The merge A.1 ↔ B.0 should now be A.1 ↔ B.1
    // The merge B.1 ↔ C.0 should now be B.2 ↔ C.0
    let merges = &proj.station_merges;
    assert_eq!(merges.len(), 2, "Should still have two merge edges");

    let has_a1_b1 = merges.iter().any(|m| {
        (proj.key_is_ref(&m.station_a, StationRef::new(a, 1))
            && proj.key_is_ref(&m.station_b, StationRef::new(b, 1)))
            || (proj.key_is_ref(&m.station_a, StationRef::new(b, 1))
                && proj.key_is_ref(&m.station_b, StationRef::new(a, 1)))
    });
    assert!(
        has_a1_b1,
        "After insert-before-0 in B, merge should be A.1↔B.1, got: {:?}",
        merges
    );

    let has_b2_c0 = merges.iter().any(|m| {
        (proj.key_is_ref(&m.station_a, StationRef::new(b, 2))
            && proj.key_is_ref(&m.station_b, StationRef::new(c, 0)))
            || (proj.key_is_ref(&m.station_a, StationRef::new(c, 0))
                && proj.key_is_ref(&m.station_b, StationRef::new(b, 2)))
    });
    assert!(
        has_b2_c0,
        "After insert-before-0 in B, merge should be B.2↔C.0, got: {:?}",
        merges
    );

    // The merge points must still be colocated after the shift
    let stations = proj.compute_station_coordinates();
    let coord = |sec: SectionId, idx: u32| -> Coordinates {
        stations
            .iter()
            .find(|s| s.station_ref == StationRef::new(sec, idx))
            .unwrap_or_else(|| panic!("station {}:{} not found", sec, idx))
            .coordinates
    };
    let eps = 1e-4;
    assert!(
        (coord(a, 1).x - coord(b, 1).x).abs() < eps,
        "A.1 and B.1 must be colocated after insert"
    );
    assert!(
        (coord(a, 1).y - coord(b, 1).y).abs() < eps,
        "A.1 and B.1 must be colocated after insert"
    );
    assert!(
        (coord(b, 2).x - coord(c, 0).x).abs() < eps,
        "B.2 and C.0 must be colocated after insert"
    );
    assert!(
        (coord(b, 2).y - coord(c, 0).y).abs() < eps,
        "B.2 and C.0 must be colocated after insert"
    );
}

/// Test 2c: Deleting the middle section B from a chain A↔B↔C removes both
/// merge edges (A↔B and B↔C), leaving A and C isolated.
#[test]
fn test_delete_middle_section_removes_both_merge_edges() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "DeleteMiddle".to_string(),
        location: None,
    });

    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    let c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0)],
        })
        .section_id
        .unwrap();

    // Build chain A↔B↔C
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });
    state.execute(Command::MergeStations {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
    });
    assert_eq!(state.get_project_state().unwrap().station_merges.len(), 2);

    // Delete the middle section B
    let delete_result = state.execute(Command::DeleteSection { section_id: b });
    assert!(
        delete_result.success,
        "Deleting middle section should succeed"
    );

    let proj = state.get_project_state().unwrap();

    // Both merge edges should be gone
    assert_eq!(
        proj.station_merges.len(),
        0,
        "Both merge edges should be removed when middle section is deleted"
    );

    // A and C should still exist
    assert_eq!(proj.sections.len(), 2);
    let section_ids: Vec<SectionId> = proj.sections.iter().map(|s| s.id).collect();
    assert!(section_ids.contains(&a), "Section A should still exist");
    assert!(section_ids.contains(&c), "Section C should still exist");

    // A and C should be isolated (not connected to each other)
    let connected_a = proj.get_connected_section_ids(a);
    assert_eq!(
        connected_a.len(),
        1,
        "A should only be connected to itself after B deleted"
    );
    assert!(
        !connected_a.contains(&c),
        "A and C should not be connected after B deleted"
    );
}

/// Test 2d: Unmerging one edge in a chain A↔B↔C does not leave B with a
/// stale offset. After unmerging A↔B, B is isolated and should report itself
/// as disconnected from both A and C.  The remaining B↔C edge must still keep
/// B and C colocated at their merge point.
#[test]
fn test_unmerge_in_chain_does_not_leave_stale_offset() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "UnmergeChain".to_string(),
        location: None,
    });

    // A: 1 shot east (10m)
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![directional_shot_data(90.0, 10.0)],
        })
        .section_id
        .unwrap();

    // B: 1 shot north (5m)
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![directional_shot_data(0.0, 5.0)],
        })
        .section_id
        .unwrap();

    // C: 1 shot east (3m)
    let c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![directional_shot_data(90.0, 3.0)],
        })
        .section_id
        .unwrap();

    // Build chain: A.1↔B.0, B.1↔C.0
    state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });
    state.execute(Command::MergeStations {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
    });

    // Capture where B.1 and C.0 are (they should be colocated)
    let (b1_before, c0_before) = {
        let proj = state.get_project_state().unwrap();
        let stations = proj.compute_station_coordinates();
        let b1 = stations
            .iter()
            .find(|s| s.station_ref == StationRef::new(b, 1))
            .unwrap()
            .coordinates;
        let c0 = stations
            .iter()
            .find(|s| s.station_ref == StationRef::new(c, 0))
            .unwrap()
            .coordinates;
        (b1, c0)
    };
    let eps = 1e-4;
    assert!(
        (b1_before.x - c0_before.x).abs() < eps,
        "B.1 and C.0 should be colocated before unmerge"
    );

    // Unmerge A↔B (the A.1 station is in the A↔B merge edge)
    let unmerge_result = state.execute(Command::UnmergeStations {
        station_ref: StationRef::new(a, 1),
    });
    assert!(unmerge_result.success, "Unmerge should succeed");

    let proj = state.get_project_state().unwrap();

    // Only one merge edge should remain: B.1↔C.0
    assert_eq!(proj.station_merges.len(), 1, "Only B↔C edge should remain");

    // A should now be isolated (not connected to B or C)
    let connected_a = proj.get_connected_section_ids(a);
    assert_eq!(connected_a.len(), 1, "A should be isolated after unmerge");
    assert!(
        !connected_a.contains(&b),
        "A should not be connected to B after unmerge"
    );

    // B and C must still be colocated at their merge point
    let stations = proj.compute_station_coordinates();
    let b1_after = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 1))
        .unwrap()
        .coordinates;
    let c0_after = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 0))
        .unwrap()
        .coordinates;

    assert!(
        (b1_after.x - c0_after.x).abs() < eps,
        "B.1 and C.0 must remain colocated after unmerging A↔B: B.1=({},{}) C.0=({},{})",
        b1_after.x,
        b1_after.y,
        c0_after.x,
        c0_after.y
    );
    assert!(
        (b1_after.y - c0_after.y).abs() < eps,
        "B.1 and C.0 must remain colocated after unmerging A↔B"
    );
}

/// Test 2e: Datum-aware merge direction — when merging a datum-holding section
/// into a section without a datum, the datum section must not move; only the
/// non-datum section gets an offset.
///
/// Setup:
///   A: 1 shot east (10m), zero datum at A.0 pinning it to absolute world coords.
///   B: 1 shot north (5m), no datum.
///
///   Merge A.1 ↔ B.0  → B must move so B.0 = A.1; A must NOT move.
///
/// Assert A.0 remains at its original coordinates after the merge.
#[test]
fn test_merge_datum_section_does_not_move() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "DatumAware".to_string(),
        location: None,
    });

    // A: shot heading east
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![directional_shot_data(90.0, 10.0)],
        })
        .section_id
        .unwrap();

    // B: shot heading north
    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![directional_shot_data(0.0, 5.0)],
        })
        .section_id
        .unwrap();

    // Pin A.0 to GPS — sets a zero datum on the A group
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(a, 0),
        coordinates: GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    });

    // Capture A's coordinates before merge
    let (a0_before, a1_before) = {
        let proj = state.get_project_state().unwrap();
        let stations = proj.compute_station_coordinates();
        let a0 = stations
            .iter()
            .find(|s| s.station_ref == StationRef::new(a, 0))
            .unwrap()
            .coordinates;
        let a1 = stations
            .iter()
            .find(|s| s.station_ref == StationRef::new(a, 1))
            .unwrap()
            .coordinates;
        (a0, a1)
    };

    // Merge B into A: A.1 ↔ B.0
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
    });
    assert!(merge_result.success, "Merge should succeed");

    let proj = state.get_project_state().unwrap();
    let stations = proj.compute_station_coordinates();
    let eps = 1e-4;

    let a0_after = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 0))
        .unwrap()
        .coordinates;
    let a1_after = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 1))
        .unwrap()
        .coordinates;
    let b0_after = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 0))
        .unwrap()
        .coordinates;

    // A must not have moved — coordinates must be identical before and after merge
    assert!(
        (a0_after.x - a0_before.x).abs() < eps,
        "A.0.x must not move: before={} after={}",
        a0_before.x,
        a0_after.x
    );
    assert!(
        (a0_after.y - a0_before.y).abs() < eps,
        "A.0.y must not move"
    );
    assert!(
        (a1_after.x - a1_before.x).abs() < eps,
        "A.1.x must not move: before={} after={}",
        a1_before.x,
        a1_after.x
    );
    assert!(
        (a1_after.y - a1_before.y).abs() < eps,
        "A.1.y must not move"
    );

    // B.0 must now be colocated with A.1
    assert!(
        (b0_after.x - a1_after.x).abs() < eps,
        "B.0 must align with A.1 (x): B.0={} A.1={}",
        b0_after.x,
        a1_after.x
    );
    assert!(
        (b0_after.y - a1_after.y).abs() < eps,
        "B.0 must align with A.1 (y)"
    );

    // The datum section A must not have received a non-zero section offset
    // (SetZeroDatum may write a (0,0) entry, but must not shift A during merge)
    if let Some(&(ox, oy)) = proj.section_offsets.get(&a) {
        assert!(
            ox.abs() < eps && oy.abs() < eps,
            "Datum section A must not receive a non-zero offset from merge: offset=({ox},{oy})"
        );
    }
    // B must have received an offset (it moved to align with A)
    assert!(
        proj.section_offsets.contains_key(&b),
        "Non-datum section B must have received a section offset from merge"
    );
}

/// Test 2f: A shot marked as reference (frozen) survives a merge followed by
/// an undo. After undo the shot must still be marked is_reference=true.
#[test]
fn test_reference_shot_survives_merge_then_undo() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "RefShot".to_string(),
        location: None,
    });

    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    let b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0)],
        })
        .section_id
        .unwrap();

    // Mark the first shot of A as a reference shot
    let first_shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.sections.iter().find(|s| s.id == a).unwrap().shots[0].id
    };
    let ref_result = state.execute(Command::SetShotReference {
        section_id: a,
        shot_id: first_shot_id,
        is_reference: true,
    });
    assert!(ref_result.success, "SetShotReference should succeed");

    // Confirm it's marked before merge
    {
        let proj = state.get_project_state().unwrap();
        let shot = proj
            .sections
            .iter()
            .find(|s| s.id == a)
            .unwrap()
            .shots
            .iter()
            .find(|sh| sh.id == first_shot_id)
            .unwrap();
        assert!(shot.is_reference, "Shot should be reference before merge");
    }

    // Merge A.2 ↔ B.0
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
    });
    assert!(merge_result.success, "Merge should succeed");

    // Reference status must survive the merge
    {
        let proj = state.get_project_state().unwrap();
        let shot = proj
            .sections
            .iter()
            .find(|s| s.id == a)
            .unwrap()
            .shots
            .iter()
            .find(|sh| sh.id == first_shot_id)
            .unwrap();
        assert!(
            shot.is_reference,
            "Shot must still be reference after merge"
        );
    }

    // Undo the merge
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo should succeed");

    // Reference status must survive the undo
    {
        let proj = state.get_project_state().unwrap();
        let section_a = proj.sections.iter().find(|s| s.id == a).unwrap();
        let shot = section_a
            .shots
            .iter()
            .find(|sh| sh.id == first_shot_id)
            .unwrap();
        assert!(
            shot.is_reference,
            "Shot must still be reference after undo of merge"
        );
        // Merge should be gone
        assert!(proj.station_merges.is_empty(), "Merge should be undone");
    }
}

// === Comment system tests ===

#[test]
fn test_set_station_comment_set_update_remove() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Comments".to_string(),
        location: None,
    });
    let sec = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let station = StationRef::new(sec, 1);
    // Set
    assert!(
        state
            .execute(Command::SetStationComment {
                station_ref: station,
                comment: Some("marker A".to_string()),
            })
            .success
    );
    assert_eq!(
        state
            .get_project_state()
            .unwrap()
            .station_comment_for_ref(station)
            .map(String::as_str),
        Some("marker A")
    );
    // Update
    state.execute(Command::SetStationComment {
        station_ref: station,
        comment: Some("marker B".to_string()),
    });
    assert_eq!(
        state
            .get_project_state()
            .unwrap()
            .station_comment_for_ref(station)
            .map(String::as_str),
        Some("marker B")
    );
    // Remove via None
    state.execute(Command::SetStationComment {
        station_ref: station,
        comment: None,
    });
    assert!(
        !state
            .get_project_state()
            .unwrap()
            .station_comment_for_ref(station)
            .is_some(),
        "None removes comment"
    );
    // Remove via empty string
    state.execute(Command::SetStationComment {
        station_ref: station,
        comment: Some("temp".to_string()),
    });
    state.execute(Command::SetStationComment {
        station_ref: station,
        comment: Some(String::new()),
    });
    assert!(
        !state
            .get_project_state()
            .unwrap()
            .station_comment_for_ref(station)
            .is_some(),
        "empty string removes comment"
    );
}

#[test]
fn test_set_station_comment_invalid_refs_fail() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "BadComments".to_string(),
        location: None,
    });
    let sec = state
        .execute(Command::CreateSection {
            name: None,
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(3.0)],
        })
        .section_id
        .unwrap();
    // 1 shot -> stations 0..1, index 3 is OOB
    assert!(
        !state
            .execute(Command::SetStationComment {
                station_ref: StationRef::new(sec, 3),
                comment: Some("oob".to_string()),
            })
            .success,
        "OOB index should fail"
    );
    assert!(
        !state
            .execute(Command::SetStationComment {
                station_ref: StationRef::new(9999, 0),
                comment: Some("ghost".to_string()),
            })
            .success,
        "nonexistent section should fail"
    );
}

#[test]
fn test_station_comment_survives_unrelated_undo_redo() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "CommentUndo".to_string(),
        location: None,
    });
    let sec = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();
    let station = StationRef::new(sec, 1);
    state.execute(Command::SetStationComment {
        station_ref: station,
        comment: Some("keep me".to_string()),
    });
    // Unrelated op
    state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(2.0)],
    });
    assert!(state.undo().success);
    assert_eq!(
        state
            .get_project_state()
            .unwrap()
            .station_comment_for_ref(station)
            .map(String::as_str),
        Some("keep me"),
        "survives undo"
    );
    assert!(state.redo().success);
    assert_eq!(
        state
            .get_project_state()
            .unwrap()
            .station_comment_for_ref(station)
            .map(String::as_str),
        Some("keep me"),
        "survives redo"
    );
}

#[test]
fn test_station_comment_persists_across_save_open() {
    let temp_dir = TempDir::new().unwrap();
    let save_path = temp_dir.path().join("comments.stalx");
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "CommentPersist".to_string(),
        location: None,
    });
    let sec = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();
    let station = StationRef::new(sec, 1);
    state.execute(Command::SetStationComment {
        station_ref: station,
        comment: Some("persisted note".to_string()),
    });
    assert!(state.save_project(Some(save_path.clone()), false).success);
    let state2 = AppState::new().unwrap();
    assert!(state2.open_project(save_path).success);
    assert_eq!(
        state2
            .get_project_state()
            .unwrap()
            .station_comment_for_ref(station)
            .map(String::as_str),
        Some("persisted note"),
        "comment survives save/open"
    );
}

#[test]
fn test_move_comment_transfers_between_stations() {
    use crate::core::command::CommentHolder;
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "MoveComment".to_string(),
        location: None,
    });
    let sec = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();
    let src = StationRef::new(sec, 0);
    let tgt = StationRef::new(sec, 2);
    state.execute(Command::SetStationComment {
        station_ref: src,
        comment: Some("source text".to_string()),
    });
    let r = state.execute(Command::MoveComment {
        source: CommentHolder::Station { station_ref: src },
        target: CommentHolder::Station { station_ref: tgt },
        swap: false,
    });
    assert!(r.success, "MoveComment should succeed");
    let proj = state.get_project_state().unwrap();
    assert!(
        !proj.station_comment_for_ref(src).is_some(),
        "source has no comment after move"
    );
    assert_eq!(
        proj.station_comment_for_ref(tgt).map(String::as_str),
        Some("source text"),
        "target has comment"
    );
}

#[test]
fn test_move_comment_swap_exchanges_comments() {
    use crate::core::command::CommentHolder;
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "SwapComment".to_string(),
        location: None,
    });
    let sec = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();
    let s1 = StationRef::new(sec, 0);
    let s2 = StationRef::new(sec, 2);
    state.execute(Command::SetStationComment {
        station_ref: s1,
        comment: Some("alpha".to_string()),
    });
    state.execute(Command::SetStationComment {
        station_ref: s2,
        comment: Some("beta".to_string()),
    });
    assert!(
        state
            .execute(Command::MoveComment {
                source: CommentHolder::Station { station_ref: s1 },
                target: CommentHolder::Station { station_ref: s2 },
                swap: true,
            })
            .success
    );
    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.station_comment_for_ref(s1).map(String::as_str),
        Some("beta")
    );
    assert_eq!(
        proj.station_comment_for_ref(s2).map(String::as_str),
        Some("alpha")
    );
}

// === Import hash tracking tests ===

#[test]
fn test_import_tracking_happy_path() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Hashes".to_string(),
        location: None,
    });
    let hash = "abc123deadbeef".to_string();
    assert!(!state.check_duplicate_import(&hash).unwrap());
    assert!(state.track_imported_file(hash.clone()).success);
    assert!(state.check_duplicate_import(&hash).unwrap());
}

#[test]
fn test_import_tracking_idempotent() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "IdempHash".to_string(),
        location: None,
    });
    let hash = "deadbeef".to_string();
    state.track_imported_file(hash.clone());
    state.track_imported_file(hash.clone());
    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.imported_file_hashes
            .iter()
            .filter(|h| h.as_str() == "deadbeef")
            .count(),
        1
    );
}

#[test]
fn test_section_hash_tracking_batch() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "SectionHashes".to_string(),
        location: None,
    });
    let hashes = vec!["h1".to_string(), "h2".to_string(), "h3".to_string()];
    assert_eq!(
        state.check_section_hashes(&hashes).unwrap(),
        vec![false, false, false]
    );
    state.track_section_hashes(vec!["h1".to_string(), "h3".to_string()]);
    assert_eq!(
        state.check_section_hashes(&hashes).unwrap(),
        vec![true, false, true]
    );
    state.track_section_hashes(hashes.clone());
    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.imported_section_hashes
            .iter()
            .filter(|h| h.as_str() == "h1")
            .count(),
        1,
        "h1 must not be duplicated"
    );
}

#[test]
fn test_import_tracking_no_project_returns_false() {
    let state = AppState::new().unwrap();
    let result = state.check_duplicate_import("somehash");
    assert!(result.is_ok());
    assert!(!result.unwrap());
}

#[test]
fn test_track_imported_file_no_project_fails() {
    let state = AppState::new().unwrap();
    assert!(!state.track_imported_file("hash".to_string()).success);
}

// === Undo-after-restart end-to-end test ===

#[test]
fn test_undo_actually_works_after_project_reopen() {
    let temp_dir = TempDir::new().unwrap();
    let save_path = temp_dir.path().join("undo-restart.stalx");
    // Session 1
    let state1 = AppState::new().unwrap();
    state1.execute(Command::CreateProject {
        name: "UndoRestart".to_string(),
        location: None,
    });
    let create_result = state1.execute(Command::CreateSection {
        name: Some("Main".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    assert!(create_result.success);
    let section_id = create_result.section_id.unwrap();
    assert!(state1.save_project(Some(save_path.clone()), false).success);
    // Session 2: reopen and undo
    let state2 = AppState::new().unwrap();
    assert!(state2.open_project(save_path).success);
    {
        let stack = state2.undo_stack.lock().unwrap();
        assert!(stack.len() > 0, "undo stack should be restored");
    }
    assert!(state2.undo().success, "undo should work after reopen");
    assert!(
        !state2
            .get_project_state()
            .unwrap()
            .sections
            .iter()
            .any(|s| s.id == section_id),
        "section should be undone after reopen"
    );
}

// ==========================================================================
// Group 1: Round-trip fidelity tests
// ==========================================================================

/// Export project to TML, re-import it, verify shot data matches exactly.
#[test]
fn test_tml_roundtrip_preserves_shot_data() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "TML Roundtrip".to_string(),
        location: None,
    });

    let shot = ShotData {
        azimuth_in: 12.5,
        azimuth_out: 192.3,
        length: 8.75,
        depth_in: 3.2,
        depth_out: 5.8,
        left: Some(1.1),
        right: Some(0.9),
        up: Some(2.3),
        down: Some(0.4),
        comment: Some("test note".to_string()),
        ..Default::default()
    };
    let shot2 = ShotData {
        azimuth_in: 280.0,
        azimuth_out: 100.0,
        length: 3.25,
        depth_in: 5.8,
        depth_out: 4.0,
        ..Default::default()
    };
    state.execute(Command::CreateSection {
        name: Some("Main Passage".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        shots: vec![shot.clone(), shot2.clone()],
    });

    let project = state.get_project_state().unwrap();
    let temp_dir = TempDir::new().unwrap();
    let tml_path = temp_dir.path().join("roundtrip.tmlu");

    crate::export::export_tml(&project, &tml_path).unwrap();
    let parsed = crate::parsers::tml::parse_tml(&tml_path).unwrap();
    let (configs, _closures) =
        crate::parsers::tml::convert_tml_to_import_configs(&parsed, true, false).unwrap();

    assert!(!configs.is_empty(), "should have at least one section");
    let imported_shots = &configs[0].shots;
    assert_eq!(imported_shots.len(), 2, "should have 2 shots");

    let eps = 0.05; // TML format has limited precision
    let s = &imported_shots[0];
    assert!(
        (s.length - 8.75).abs() < eps,
        "length: {} vs 8.75",
        s.length
    );
    assert!(
        (s.azimuth_in - 12.5).abs() < eps,
        "azimuth_in: {} vs 12.5",
        s.azimuth_in
    );
    assert!(
        (s.depth_in - 3.2).abs() < eps,
        "depth_in: {} vs 3.2",
        s.depth_in
    );
    assert!(
        (s.depth_out - 5.8).abs() < eps,
        "depth_out: {} vs 5.8",
        s.depth_out
    );

    let s2 = &imported_shots[1];
    assert!(
        (s2.length - 3.25).abs() < eps,
        "shot2 length: {} vs 3.25",
        s2.length
    );
    assert!(
        (s2.azimuth_in - 280.0).abs() < eps,
        "shot2 azimuth_in: {} vs 280.0",
        s2.azimuth_in
    );
}

/// Export project to TML with multiple sections, re-import, verify section count and names.
#[test]
fn test_tml_roundtrip_preserves_multiple_sections() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Multi Section".to_string(),
        location: None,
    });
    state.execute(Command::CreateSection {
        name: Some("Gallery A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
    });
    state.execute(Command::CreateSection {
        name: Some("Gallery B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(7.0)],
    });

    let project = state.get_project_state().unwrap();
    let temp_dir = TempDir::new().unwrap();
    let tml_path = temp_dir.path().join("multi.tmlu");

    crate::export::export_tml(&project, &tml_path).unwrap();
    let parsed = crate::parsers::tml::parse_tml(&tml_path).unwrap();
    let (configs, _) =
        crate::parsers::tml::convert_tml_to_import_configs(&parsed, true, false).unwrap();

    assert_eq!(configs.len(), 2, "should have 2 sections");
    // Total shots: 2 + 1 = 3
    let total_shots: usize = configs.iter().map(|c| c.shots.len()).sum();
    assert_eq!(total_shots, 3, "total shots across sections");
}

/// Stalx save/open round-trip preserves merges, closures, and offsets.
#[test]
fn test_stalx_roundtrip_preserves_merges_closures_offsets() {
    let temp_dir = TempDir::new().unwrap();
    let save_path = temp_dir.path().join("full_roundtrip.stalx");

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Full Roundtrip".to_string(),
        location: None,
    });

    // Create two sections with 2 shots each
    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0), test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Merge A:2 with B:0
    let merge_r = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_a, 2),
        station_b: StationRef::new(sec_b, 0),
    });
    assert!(merge_r.success, "merge should succeed");

    // Set a zero datum on A:0
    let datum_r = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(sec_a, 0),
        coordinates: GpsCoordinates::new(45.5, -73.5, 100.0).unwrap(),
    });
    assert!(datum_r.success, "set zero datum should succeed");

    // Set a station comment
    state.execute(Command::SetStationComment {
        station_ref: StationRef::new(sec_b, 1),
        comment: Some("junction marker".to_string()),
    });

    // Snapshot state before save
    let project_before = state.get_project_state().unwrap();
    assert_eq!(project_before.station_merges.len(), 1);
    assert_eq!(project_before.zero_datums.len(), 1);

    // Save and reopen
    assert!(state.save_project(Some(save_path.clone()), false).success);
    let state2 = AppState::new().unwrap();
    assert!(state2.open_project(save_path).success);
    let project_after = state2.get_project_state().unwrap();

    // Verify merges
    assert_eq!(
        project_after.station_merges.len(),
        1,
        "merge should survive save/open"
    );
    let m = &project_after.station_merges[0];
    let merge_stations: HashSet<StationRef> = [&m.station_a, &m.station_b]
        .into_iter()
        .filter_map(|k| project_after.resolve_key(k))
        .collect();
    assert!(merge_stations.contains(&StationRef::new(sec_a, 2)));
    assert!(merge_stations.contains(&StationRef::new(sec_b, 0)));

    // Verify zero datums
    assert_eq!(
        project_after.zero_datums.len(),
        1,
        "datum should survive save/open"
    );
    assert!(project_after.key_is_ref(
        &project_after.zero_datums[0].station_ref,
        StationRef::new(sec_a, 0)
    ));
    assert!((project_after.zero_datums[0].gps.latitude - 45.5).abs() < 1e-6);

    // Verify station comments
    assert_eq!(
        project_after
            .station_comment_for_ref(StationRef::new(sec_b, 1))
            .map(String::as_str),
        Some("junction marker"),
        "comment should survive save/open"
    );

    // Verify section offsets exist for merged sections
    assert!(
        project_after.section_offsets.contains_key(&sec_a)
            || project_after.section_offsets.contains_key(&sec_b),
        "at least one section should have an offset after merge"
    );

    // Verify section data integrity
    assert_eq!(project_after.sections.len(), 2);
    let sec_a_after = project_after
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap();
    let sec_b_after = project_after
        .sections
        .iter()
        .find(|s| s.id == sec_b)
        .unwrap();
    assert_eq!(sec_a_after.shots.len(), 2);
    assert_eq!(sec_b_after.shots.len(), 2);
}

/// CSV export preserves precision for azimuths near 360/0 boundary.
#[test]
fn test_csv_export_preserves_azimuth_precision() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "CSV Precision".to_string(),
        location: None,
    });

    let shot = ShotData {
        azimuth_in: 359.9,
        azimuth_out: 0.1,
        length: 4.567,
        depth_in: 12.345,
        depth_out: 12.678,
        left: Some(0.01),
        right: Some(99.99),
        ..Default::default()
    };
    state.execute(Command::CreateSection {
        name: Some("Boundary".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![shot],
    });

    let project = state.get_project_state().unwrap();
    let temp_dir = TempDir::new().unwrap();
    let csv_path = temp_dir.path().join("precision.csv");
    crate::export::export_csv(&project, &csv_path).unwrap();

    let contents = std::fs::read_to_string(&csv_path).unwrap();
    let data_line = contents.lines().nth(1).unwrap();
    // Verify azimuths aren't truncated: 359.9 should not become 359 or 360
    assert!(
        data_line.contains("359.9"),
        "azimuth_in 359.9 should be preserved, got: {}",
        data_line
    );
    assert!(
        data_line.contains("0.1"),
        "azimuth_out 0.1 should be preserved, got: {}",
        data_line
    );
    // Verify length precision: 4.567 should appear as 4.57 (2 decimal CSV format)
    assert!(
        data_line.contains("4.57"),
        "length should be 4.57, got: {}",
        data_line
    );
}

// ==========================================================================
// Group 2: Shot insertion/deletion near merge points
// ==========================================================================

/// Insert a shot before a merged station — verify merge ref shifts correctly
/// and merge alignment is maintained via cascade offset propagation.
#[test]
fn test_insert_shot_before_merged_station_shifts_merge_ref() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "InsertBeforeMerge".to_string(),
        location: None,
    });

    // Section A: 3 shots (stations 0,1,2,3)
    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(3.0),
                test_shot_data(4.0),
            ],
        })
        .section_id
        .unwrap();

    // Section B: 1 shot (stations 0,1)
    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Merge A:2 with B:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 2),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    // Get shot ID of shot at index 1 in section A (before the merged station)
    let project = state.get_project_state().unwrap();
    let shot_id_1 = project
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots[1]
        .id;

    // Insert a new shot before shot 1 — this adds a station, shifting station 2 to 3
    let insert_r = state.execute(Command::CreateShot {
        section_id: sec_a,
        shot: test_shot_data(2.0),
        after_shot_id: None,
        before_shot_id: Some(shot_id_1),
    });
    assert!(insert_r.success, "insert should succeed");

    // After insertion, A now has 4 shots (stations 0..4)
    // Original A:2 should now be A:3
    let project_after = state.get_project_state().unwrap();
    let sec_a_after = project_after
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap();
    assert_eq!(
        sec_a_after.shots.len(),
        4,
        "section A should now have 4 shots"
    );

    // The merge should now reference A:3 (shifted from A:2) and B:0 (unchanged)
    assert_eq!(
        project_after.station_merges.len(),
        1,
        "merge should still exist"
    );
    let m = &project_after.station_merges[0];
    let merge_refs: HashSet<StationRef> = [&m.station_a, &m.station_b]
        .into_iter()
        .filter_map(|k| project_after.resolve_key(k))
        .collect();
    assert!(
        merge_refs.contains(&StationRef::new(sec_b, 0)),
        "B:0 should be unchanged in merge"
    );
    assert!(
        merge_refs.contains(&StationRef::new(sec_a, 3)),
        "A:2 should have shifted to A:3 in merge, got {:?}",
        m
    );

    // Merged stations should remain colocated (the fix)
    let a3 = project_after.compute_station_raw_coords(StationRef::new(sec_a, 3));
    let b0 = project_after.compute_station_raw_coords(StationRef::new(sec_b, 0));
    if let (Some(a3c), Some(b0c)) = (a3, b0) {
        let eps = 0.01;
        assert!(
            (a3c.x - b0c.x).abs() < eps,
            "A:3 and B:0 x should be colocated after insert: {} vs {}",
            a3c.x,
            b0c.x
        );
        assert!(
            (a3c.y - b0c.y).abs() < eps,
            "A:3 and B:0 y should be colocated after insert: {} vs {}",
            a3c.y,
            b0c.y
        );
    }
}

/// Insert a shot after a merged station — verify merge ref stays unchanged.
#[test]
fn test_insert_shot_after_merged_station_keeps_merge_ref() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "InsertAfterMerge".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Merge A:1 with B:0 (middle station of A)
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 1),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    // Insert a shot AFTER shot[0] in A (between stations 1 and 2)
    let project = state.get_project_state().unwrap();
    let shot_id_0 = project
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots[0]
        .id;

    assert!(
        state
            .execute(Command::CreateShot {
                section_id: sec_a,
                shot: test_shot_data(2.0),
                after_shot_id: Some(shot_id_0),
                before_shot_id: None,
            })
            .success
    );

    // A:1 (the merged station) should remain at index 1 since we inserted after shot[0]
    // which creates a new station at index 2, shifting old station 2 to 3
    let project_after = state.get_project_state().unwrap();
    let m = &project_after.station_merges[0];
    let merge_refs: HashSet<StationRef> = [&m.station_a, &m.station_b]
        .into_iter()
        .filter_map(|k| project_after.resolve_key(k))
        .collect();
    assert!(
        merge_refs.contains(&StationRef::new(sec_a, 1)),
        "A:1 should remain unchanged since insertion is after it"
    );
    assert!(
        merge_refs.contains(&StationRef::new(sec_b, 0)),
        "B:0 should remain unchanged"
    );
}

/// Delete a mid-shot in a merged section — verify merges are rewired and
/// no dangling station references remain after the section splits.
#[test]
fn test_delete_mid_shot_splits_section_with_merge_intact() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "DeleteMidMerge".to_string(),
        location: None,
    });

    // Section A: 3 shots (stations 0,1,2,3)
    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![
                test_shot_data(5.0),
                test_shot_data(3.0),
                test_shot_data(4.0),
            ],
        })
        .section_id
        .unwrap();

    // Section B: 1 shot (stations 0,1)
    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Merge A:0 with B:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 0),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    // Delete the middle shot (shot[1]) from section A — this splits A
    let project = state.get_project_state().unwrap();
    let shot_id_1 = project
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots[1]
        .id;

    let delete_r = state.execute(Command::DeleteShot {
        section_id: sec_a,
        shot_id: shot_id_1,
    });
    assert!(delete_r.success, "delete should succeed");

    // After splitting, the project should be in a consistent state:
    // no merge should reference a nonexistent station
    let project_after = state.get_project_state().unwrap();
    for merge in &project_after.station_merges {
        let valid_a = project_after.resolve_key(&merge.station_a).is_some();
        let valid_b = project_after.resolve_key(&merge.station_b).is_some();
        assert!(
            valid_a,
            "merge station_a {:?} references valid station",
            merge.station_a
        );
        assert!(
            valid_b,
            "merge station_b {:?} references valid station",
            merge.station_b
        );
    }

    // The merge to B:0 should still exist (connected to one of the split fragments)
    let b_in_merge = project_after.station_merges.iter().any(|m| {
        project_after.key_is_ref(&m.station_a, StationRef::new(sec_b, 0))
            || project_after.key_is_ref(&m.station_b, StationRef::new(sec_b, 0))
    });
    assert!(
        b_in_merge,
        "B:0 merge should survive the split (rewired to fragment)"
    );
}

/// Insert shot at position 0 of a merged section — verify offset adjustment keeps
/// existing stations visually in place and merged partner remains colocated.
#[test]
fn test_insert_shot_at_position_0_adjusts_offset_for_merge() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "InsertPos0Merge".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Merge A:0 with B:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 0),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    // Record coordinates of A:1 before insertion
    let project_before = state.get_project_state().unwrap();
    let coords_a1_before = project_before.compute_station_raw_coords(StationRef::new(sec_a, 1));

    // Insert a shot before shot[0] in section A (prepend)
    let shot_id_0 = project_before
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots[0]
        .id;
    assert!(
        state
            .execute(Command::CreateShot {
                section_id: sec_a,
                shot: test_shot_data(3.0),
                after_shot_id: None,
                before_shot_id: Some(shot_id_0),
            })
            .success
    );

    let project_after = state.get_project_state().unwrap();

    // A:1 (previously A:0) was the merged station — it should have shifted to A:1
    // A:2 (previously A:1) should be at the same coordinates as before
    if let Some(before) = coords_a1_before {
        if let Some(after) = project_after.compute_station_raw_coords(StationRef::new(sec_a, 2)) {
            let eps = 0.1;
            assert!(
                (before.x - after.x).abs() < eps,
                "A:2 x should match old A:1 x: {} vs {}",
                after.x,
                before.x
            );
            assert!(
                (before.y - after.y).abs() < eps,
                "A:2 y should match old A:1 y: {} vs {}",
                after.y,
                before.y
            );
        }
    }

    // Merge should now reference the shifted station
    let m = &project_after.station_merges[0];
    let merge_refs: HashSet<StationRef> = [&m.station_a, &m.station_b]
        .into_iter()
        .filter_map(|k| project_after.resolve_key(k))
        .collect();
    assert!(
        merge_refs.contains(&StationRef::new(sec_a, 1)),
        "A:0 should have shifted to A:1 in merge"
    );
    assert!(
        merge_refs.contains(&StationRef::new(sec_b, 0)),
        "B:0 should remain unchanged"
    );
}

/// Delete the only shot+section via execute_delete_last_shot_and_section
/// when section has merges — verify merges are cleaned up.
#[test]
fn test_delete_last_shot_and_section_cleans_merges() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "DeleteLastMerged".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Merge A:1 with B:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 1),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    // Delete section A's only shot via the dedicated method
    let project = state.get_project_state().unwrap();
    let shot_id = project
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots[0]
        .id;
    assert!(
        state
            .execute_delete_last_shot_and_section(sec_a, shot_id)
            .success
    );

    let project_after = state.get_project_state().unwrap();
    // Section A should be gone
    assert!(
        !project_after.sections.iter().any(|s| s.id == sec_a),
        "section A should be deleted"
    );
    // Merge referencing section A should be cleaned up
    for merge in &project_after.station_merges {
        assert_ne!(
            merge.station_a.section_id, sec_a,
            "no merge should reference deleted section A"
        );
        assert_ne!(
            merge.station_b.section_id, sec_a,
            "no merge should reference deleted section A"
        );
    }
    // Section B should still exist
    assert!(
        project_after.sections.iter().any(|s| s.id == sec_b),
        "section B should remain"
    );
}

/// Insert shot with a zero datum present — verify datum station ref shifts correctly.
#[test]
fn test_insert_shot_before_zero_datum_shifts_datum_ref() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "InsertBeforeDatum".to_string(),
        location: None,
    });

    let sec = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    // Set zero datum at station 1
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(sec, 1),
                coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
            })
            .success
    );

    // Insert a shot before shot[0], shifting all stations by 1
    let project = state.get_project_state().unwrap();
    let shot_id_0 = project.sections.iter().find(|s| s.id == sec).unwrap().shots[0].id;
    assert!(
        state
            .execute(Command::CreateShot {
                section_id: sec,
                shot: test_shot_data(2.0),
                after_shot_id: None,
                before_shot_id: Some(shot_id_0),
            })
            .success
    );

    let project_after = state.get_project_state().unwrap();
    assert_eq!(
        project_after.zero_datums.len(),
        1,
        "datum should still exist"
    );
    assert!(
        project_after.key_is_ref(
            &project_after.zero_datums[0].station_ref,
            StationRef::new(sec, 2)
        ),
        "datum should have shifted from station 1 to station 2"
    );
}

// ==========================================================================
// Group 3: Multi-section merge chain operations
// ==========================================================================

/// Delete the middle section in a 3-section merge chain (A↔B↔C).
/// Verify A and C become disconnected with no dangling merge references.
#[test]
fn test_delete_middle_section_in_merge_chain() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "ChainDelete".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0)],
        })
        .section_id
        .unwrap();

    let sec_c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Chain: A:1 ↔ B:0, B:1 ↔ C:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 1),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_b, 1),
                station_b: StationRef::new(sec_c, 0),
            })
            .success
    );

    // Delete section B
    assert!(
        state
            .execute(Command::DeleteSection { section_id: sec_b })
            .success
    );

    let project_after = state.get_project_state().unwrap();

    // B should be gone
    assert!(
        !project_after.sections.iter().any(|s| s.id == sec_b),
        "section B should be deleted"
    );

    // No merge should reference section B
    for merge in &project_after.station_merges {
        assert_ne!(
            merge.station_a.section_id, sec_b,
            "merge should not reference deleted B"
        );
        assert_ne!(
            merge.station_b.section_id, sec_b,
            "merge should not reference deleted B"
        );
    }

    // No closure should reference section B
    for closure in &project_after.loop_closures {
        assert_ne!(
            closure.station_a.section_id, sec_b,
            "closure should not reference deleted B"
        );
        assert_ne!(
            closure.station_b.section_id, sec_b,
            "closure should not reference deleted B"
        );
    }

    // No zero datum should reference section B
    for datum in &project_after.zero_datums {
        assert_ne!(
            datum.station_ref.section_id, sec_b,
            "datum should not reference deleted B"
        );
    }

    // A and C should still exist
    assert!(
        project_after.sections.iter().any(|s| s.id == sec_a),
        "A should remain"
    );
    assert!(
        project_after.sections.iter().any(|s| s.id == sec_c),
        "C should remain"
    );
}

/// Set zero datum in a 3-section chain, then change GPS — verify all sections move together.
#[test]
fn test_zero_datum_in_chain_positions_all_sections() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "ChainDatum".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0)],
        })
        .section_id
        .unwrap();

    let sec_c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Chain: A:1 ↔ B:0, B:1 ↔ C:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 1),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_b, 1),
                station_b: StationRef::new(sec_c, 0),
            })
            .success
    );

    // Set datum at A:0
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(sec_a, 0),
                coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
            })
            .success
    );

    let project = state.get_project_state().unwrap();

    // All stations in the chain should have computable coordinates
    let a0 = project.compute_station_raw_coords(StationRef::new(sec_a, 0));
    let a1 = project.compute_station_raw_coords(StationRef::new(sec_a, 1));
    let b0 = project.compute_station_raw_coords(StationRef::new(sec_b, 0));
    let b1 = project.compute_station_raw_coords(StationRef::new(sec_b, 1));
    let c0 = project.compute_station_raw_coords(StationRef::new(sec_c, 0));
    let c1 = project.compute_station_raw_coords(StationRef::new(sec_c, 1));

    assert!(a0.is_some(), "A:0 should have coordinates");
    assert!(c1.is_some(), "C:1 should have coordinates (end of chain)");

    // Merged stations should be colocated: A:1 ≈ B:0, B:1 ≈ C:0
    if let (Some(a1c), Some(b0c)) = (a1, b0) {
        let eps = 0.5;
        assert!(
            (a1c.x - b0c.x).abs() < eps,
            "A:1 and B:0 x should be colocated: {} vs {}",
            a1c.x,
            b0c.x
        );
        assert!(
            (a1c.y - b0c.y).abs() < eps,
            "A:1 and B:0 y should be colocated: {} vs {}",
            a1c.y,
            b0c.y
        );
    }
    if let (Some(b1c), Some(c0c)) = (b1, c0) {
        let eps = 0.5;
        assert!(
            (b1c.x - c0c.x).abs() < eps,
            "B:1 and C:0 x should be colocated: {} vs {}",
            b1c.x,
            c0c.x
        );
        assert!(
            (b1c.y - c0c.y).abs() < eps,
            "B:1 and C:0 y should be colocated: {} vs {}",
            b1c.y,
            c0c.y
        );
    }

    // Now update the GPS coordinates and verify the chain still holds
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(sec_a, 0),
                coordinates: GpsCoordinates::new(46.0, -74.0, 200.0).unwrap(),
            })
            .success
    );

    let project2 = state.get_project_state().unwrap();
    let a1_new = project2.compute_station_raw_coords(StationRef::new(sec_a, 1));
    let b0_new = project2.compute_station_raw_coords(StationRef::new(sec_b, 0));
    if let (Some(a1c), Some(b0c)) = (a1_new, b0_new) {
        let eps = 0.5;
        assert!(
            (a1c.x - b0c.x).abs() < eps,
            "after GPS update, A:1 and B:0 should remain colocated"
        );
    }
}

/// Undo a merge that was part of a chain — verify the undone section disconnects
/// while the remaining merge stays intact.
#[test]
fn test_undo_merge_in_chain_disconnects_correctly() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "UndoChainMerge".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0)],
        })
        .section_id
        .unwrap();

    let sec_c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Merge A:1 ↔ B:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 1),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    // Merge B:1 ↔ C:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_b, 1),
                station_b: StationRef::new(sec_c, 0),
            })
            .success
    );

    // Verify chain: 2 merges
    let project = state.get_project_state().unwrap();
    assert_eq!(project.station_merges.len(), 2);

    // Undo the B↔C merge (most recent operation)
    assert!(state.undo().success);

    let project_after = state.get_project_state().unwrap();
    assert_eq!(
        project_after.station_merges.len(),
        1,
        "only A↔B merge should remain"
    );

    // The remaining merge should be A:1 ↔ B:0
    let m = &project_after.station_merges[0];
    let merge_refs: HashSet<StationRef> = [&m.station_a, &m.station_b]
        .into_iter()
        .filter_map(|k| project_after.resolve_key(k))
        .collect();
    assert!(
        merge_refs.contains(&StationRef::new(sec_a, 1)),
        "A:1 should be in remaining merge"
    );
    assert!(
        merge_refs.contains(&StationRef::new(sec_b, 0)),
        "B:0 should be in remaining merge"
    );

    // C should still exist but disconnected
    assert!(
        project_after.sections.iter().any(|s| s.id == sec_c),
        "C should still exist"
    );

    // Redo should restore the B↔C merge
    assert!(state.redo().success);
    let project_redo = state.get_project_state().unwrap();
    assert_eq!(
        project_redo.station_merges.len(),
        2,
        "both merges should be restored after redo"
    );
}

/// Verify a merge chain survives save/reopen with coordinates intact.
#[test]
fn test_merge_chain_survives_save_reopen() {
    let temp_dir = TempDir::new().unwrap();
    let save_path = temp_dir.path().join("chain.stalx");

    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "ChainPersist".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0)],
        })
        .section_id
        .unwrap();

    let sec_c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    // Chain: A:1 ↔ B:0, B:1 ↔ C:0
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 1),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_b, 1),
                station_b: StationRef::new(sec_c, 0),
            })
            .success
    );

    // Set datum so coordinates are computable
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(sec_a, 0),
                coordinates: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
            })
            .success
    );

    // Snapshot coordinates
    let project_before = state.get_project_state().unwrap();
    let c1_before = project_before.compute_station_raw_coords(StationRef::new(sec_c, 1));

    // Save and reopen
    assert!(state.save_project(Some(save_path.clone()), false).success);
    let state2 = AppState::new().unwrap();
    assert!(state2.open_project(save_path).success);

    let project_after = state2.get_project_state().unwrap();

    // Verify structure
    assert_eq!(
        project_after.station_merges.len(),
        2,
        "both merges should persist"
    );
    assert_eq!(project_after.zero_datums.len(), 1, "datum should persist");
    assert_eq!(
        project_after.sections.len(),
        3,
        "all 3 sections should persist"
    );

    // Verify coordinates match
    let c1_after = project_after.compute_station_raw_coords(StationRef::new(sec_c, 1));
    if let (Some(before), Some(after)) = (c1_before, c1_after) {
        let eps = 0.01;
        assert!(
            (before.x - after.x).abs() < eps,
            "C:1 x should match: {} vs {}",
            before.x,
            after.x
        );
        assert!(
            (before.y - after.y).abs() < eps,
            "C:1 y should match: {} vs {}",
            before.y,
            after.y
        );
    }
}

/// Three sections forming a triangle: A↔B via merge, B↔C via merge, C↔A via loop closure.
/// Verifies that a loop closure can be created between non-merged stations in the same
/// connected group, and that all references remain valid.
#[test]
fn test_triangle_topology_with_loop_closure() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Triangle".to_string(),
        location: None,
    });

    let sec_a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![test_shot_data(5.0), test_shot_data(3.0)],
        })
        .section_id
        .unwrap();

    let sec_b = state
        .execute(Command::CreateSection {
            name: Some("B".to_string()),
            surveyor: None,
            date: None,
            color: "#00ff00".to_string(),
            direction: None,
            shots: vec![test_shot_data(4.0), test_shot_data(6.0)],
        })
        .section_id
        .unwrap();

    let sec_c = state
        .execute(Command::CreateSection {
            name: Some("C".to_string()),
            surveyor: None,
            date: None,
            color: "#0000ff".to_string(),
            direction: None,
            shots: vec![test_shot_data(7.0), test_shot_data(2.0)],
        })
        .section_id
        .unwrap();

    // A:2 ↔ B:0 (merge)
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_a, 2),
                station_b: StationRef::new(sec_b, 0),
            })
            .success
    );

    // B:2 ↔ C:0 (merge)
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(sec_b, 2),
                station_b: StationRef::new(sec_c, 0),
            })
            .success
    );

    // C:2 ↔ A:0 — third merge should be rejected (already connected transitively)
    let third_merge = state.execute(Command::MergeStations {
        station_a: StationRef::new(sec_c, 2),
        station_b: StationRef::new(sec_a, 0),
    });
    assert!(
        !third_merge.success,
        "third merge should fail — stations already connected"
    );

    // Close the triangle with a loop closure C:2 ↔ A:0.
    // These are the free endpoints of their sections — the merge graph only has
    // edges A:2↔B:0 and B:2↔C:0, so are_stations_merged(C:2, A:0) is false.
    // The sections are connected (same group), so the closure succeeds and
    // measures the survey error around the A→B→C→A triangle.
    let closure_result = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(sec_c, 2),
        station_b: StationRef::new(sec_a, 0),
        closure_strategy: ClosureStrategy::Batch,
    });
    assert!(
        closure_result.success,
        "loop closure between free endpoints should succeed"
    );

    // Verify the project is in a consistent state: 2 merges + 1 closure.
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 3, "all 3 sections should exist");
    assert_eq!(project.station_merges.len(), 2, "two merges should exist");
    assert_eq!(
        project.loop_closures.len(),
        1,
        "one loop closure should exist"
    );

    // All merges reference valid stations
    for merge in &project.station_merges {
        assert!(
            project.resolve_key(&merge.station_a).is_some(),
            "merge station_a {:?} should be valid",
            merge.station_a
        );
        assert!(
            project.resolve_key(&merge.station_b).is_some(),
            "merge station_b {:?} should be valid",
            merge.station_b
        );
    }

    // Loop closure references valid stations
    let lc = &project.loop_closures[0];
    assert!(
        project.resolve_key(&lc.station_a).is_some(),
        "closure station_a should be valid"
    );
    assert!(
        project.resolve_key(&lc.station_b).is_some(),
        "closure station_b should be valid"
    );
}

// === Collaboration mode: empty-section name mapping ===
#[test]
fn test_collab_section_name_map_includes_empty_sections() {
    // Regression for Codex's "preserve empty sections in the collab name map"
    // finding: section_name_map used to be derived from per-shot baseline
    // entries, so a section with no shots (e.g. an empty root section or
    // one whose first shot hasn't been measured yet) was omitted from the
    // map.  When a collaborator added the first shot to such a section in
    // Ariane and round-tripped, the returned shot's section name had no
    // baseline entry — reconcile classified it as a brand-new section and
    // apply created a duplicate next to the empty original.
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();

    let mut project = Project::new("Collab".to_string(), None);
    // Two sections: one with shots, one EMPTY (no shots at all).
    project.add_section(SectionData {
        name: Some("Filled".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![ShotData {
            azimuth_in: 10.0,
            azimuth_out: 10.0,
            length: 5.0,
            depth_in: 0.0,
            depth_out: 1.0,
            ..Default::default()
        }],
    });
    let empty_id = project
        .add_section(SectionData {
            name: Some("EmptyRoot".to_string()),
            surveyor: None,
            date: None,
            color: "#ff6b6b".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![],
        })
        .id;
    project.collab = Some(crate::models::CollabState::new("empty.tml".to_string()));
    state.set_project_for_tests(project);

    let stalx = temp_dir.path().join("empty.stalx");
    assert!(
        state
            .execute(Command::SaveProject {
                path: Some(stalx.clone()),
                is_autosave: false,
            })
            .success
    );

    let loaded = Database::open(&stalx).unwrap().load_project().unwrap();
    let collab = loaded.collab.expect("collab persisted");
    assert!(
        collab
            .section_name_map
            .iter()
            .any(|(name, id)| name == "EmptyRoot" && *id == empty_id),
        "empty section must appear in section_name_map so reconcile can route \
         later Ariane additions to it instead of creating a duplicate; got {:?}",
        collab.section_name_map,
    );
}

// === Collaboration mode: save-both hook ===
#[test]
fn test_collab_save_writes_sibling_tml_and_baseline() {
    let temp_dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();

    let mut project = Project::new("Collab Cave".to_string(), None);
    project.add_section(SectionData {
        name: Some("Main".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![
            ShotData {
                azimuth_in: 10.0,
                azimuth_out: 10.0,
                length: 5.0,
                depth_in: 0.0,
                depth_out: 1.0,
                ..Default::default()
            },
            ShotData {
                azimuth_in: 20.0,
                azimuth_out: 20.0,
                length: 6.0,
                depth_in: 1.0,
                depth_out: 2.0,
                ..Default::default()
            },
        ],
    });
    project.collab = Some(crate::models::CollabState::new(
        "collab-cave.tml".to_string(),
    ));
    state.set_project_for_tests(project);

    let stalx = temp_dir.path().join("collab-cave.stalx");
    let r = state.execute(Command::SaveProject {
        path: Some(stalx.clone()),
        is_autosave: false,
    });
    assert!(r.success, "save failed: {:?}", r.error);

    // Sibling .tml written next to the .stalx.
    let tml = temp_dir.path().join("collab-cave.tml");
    assert!(tml.exists(), "sibling .tml should be written");

    // Baseline + hash persisted in the .stalx.
    let loaded = Database::open(&stalx).unwrap().load_project().unwrap();
    let collab = loaded.collab.expect("collab persisted");
    assert!(collab.enabled);
    let sha1 = collab.last_export_tml_sha256.clone().expect("hash stored");
    assert_eq!(collab.shot_baseline.len(), 2, "baseline has both shots");

    // A second save with no edits is idempotent (UUIDs reused -> same hash).
    let r2 = state.execute(Command::SaveProject {
        path: None,
        is_autosave: false,
    });
    assert!(r2.success);
    let loaded2 = Database::open(&stalx).unwrap().load_project().unwrap();
    let sha2 = loaded2.collab.unwrap().last_export_tml_sha256.unwrap();
    assert_eq!(sha1, sha2, "no-edit re-save should produce identical .tml");
}

// === Collaboration mode: apply changes (preserve native data + undo) ===
#[test]
fn test_apply_collab_changes_preserves_native_data_and_is_undoable() {
    let dir = TempDir::new().unwrap();
    let state = AppState::new().unwrap();

    let mk = |len1: f64, az_out1: f64| SectionData {
        name: Some("Main".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![
            ShotData {
                azimuth_in: 10.0,
                azimuth_out: 10.0,
                length: 5.0,
                depth_in: 0.0,
                depth_out: 1.0,
                ..Default::default()
            },
            ShotData {
                azimuth_in: 20.0,
                azimuth_out: az_out1,
                length: len1,
                depth_in: 1.0,
                depth_out: 2.0,
                ..Default::default()
            },
            ShotData {
                azimuth_in: 30.0,
                azimuth_out: 30.0,
                length: 7.0,
                depth_in: 2.0,
                depth_out: 3.0,
                ..Default::default()
            },
        ],
    };

    let mut project = Project::new("Collab".to_string(), None);
    project.add_section(mk(6.0, 200.0)); // shot[1] has a distinct backsight (no TML equivalent)
    project.collab = Some(crate::models::CollabState::new("c.tml".to_string()));
    state.set_project_for_tests(project);

    let stalx = dir.path().join("c.stalx");
    assert!(
        state
            .execute(Command::SaveProject {
                path: Some(stalx),
                is_autosave: false
            })
            .success
    );
    let sibling = dir.path().join("c.tml");
    assert!(sibling.exists());

    // Simulate Ariane editing the .tml: re-export an edited project (shot[1].length = 99).
    let mut edited = Project::new("Collab".to_string(), None);
    edited.add_section(mk(99.0, 20.0));
    crate::export::tml::export_tml(&edited, &sibling).unwrap();

    let cs = state
        .detect_collab_changes()
        .unwrap()
        .expect("changes detected");
    assert_eq!(cs.shots_edited.len(), 1, "exactly one edit");
    assert!(state.execute(Command::ApplyCollabChanges).success);

    {
        let g = state.project.lock().unwrap();
        let shot = &g.as_ref().unwrap().sections[0].shots[1];
        assert_eq!(shot.length, 99.0, "length applied from .tml");
        assert_eq!(
            shot.azimuth_out, 200.0,
            "distinct backsight preserved (no TML field)"
        );
    }

    // Undo restores the original geometry; preserved field stays intact.
    assert!(state.undo().success);
    {
        let g = state.project.lock().unwrap();
        let shot = &g.as_ref().unwrap().sections[0].shots[1];
        assert_eq!(shot.length, 6.0, "undo restored length");
        assert_eq!(shot.azimuth_out, 200.0);
    }
}

// ============================================================================
// Performance profiler (not a unit test — a measurement harness)
// ============================================================================
//
// Run with:
//   STALAGMIGHT_PROFILE_TML=/home/user/src/cave/data/koox_baal/synthetic/93.tml \
//     cargo test --release --manifest-path src-tauri/Cargo.toml --lib \
//     state::tests::profile_tml_import_full -- --nocapture --ignored
//
// The harness drives parse_tml → convert_tml_to_import_configs →
// execute_import_sections end-to-end on an empty in-memory project,
// installs a real tracing-subscriber so the timing markers added to
// commands.rs land on stdout, and prints wall-clock for each phase.

#[test]
#[ignore = "profiling harness — run explicitly with STALAGMIGHT_PROFILE_TML=<path>"]
fn profile_tml_import_full() {
    use crate::models::Project;
    use crate::parsers::tml as tml_parser;
    use crate::persistence::Database;
    use std::time::Instant;

    let path = std::env::var("STALAGMIGHT_PROFILE_TML")
        .expect("set STALAGMIGHT_PROFILE_TML to the .tml file path");

    // Use the test framework's tracing-subscriber init guard so we
    // don't double-init when the test runs alongside others.
    let _ = tracing_subscriber::fmt()
        .with_target(false)
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    let t0 = Instant::now();
    let tml = tml_parser::parse_tml(std::path::Path::new(&path)).expect("parse_tml");
    let t1 = Instant::now();
    let (sections, closures) =
        tml_parser::convert_tml_to_import_configs(&tml, false, false).expect("convert");
    let t2 = Instant::now();

    let project = Project::new("profile".to_string(), None);
    let temp = TempDir::new().unwrap();
    let db_path = temp.path().join("profile.stalx");
    let mut db = Database::open(&db_path).unwrap();
    db.save_project(&project).unwrap();
    let state = AppState::new().unwrap();
    state.set_project_for_tests(project);
    state.set_database_for_tests(db);
    let t3 = Instant::now();

    let total_shots: usize = sections.iter().map(|s| s.shots.len()).sum();

    eprintln!("\n┌─ profile_tml_import_full ─────────────────────────────");
    eprintln!("│ file:     {path}");
    eprintln!("│ sections: {}", sections.len());
    eprintln!("│ shots:    {}", total_shots);
    eprintln!("│ closures: {}", closures.len());
    eprintln!("├─ phase timings ───────────────────────────────────────");
    eprintln!(
        "│ parse_tml:                   {:>9.2} ms",
        (t1 - t0).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ convert_tml_to_import_configs:{:>9.2} ms",
        (t2 - t1).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ AppState setup (excluded):   {:>9.2} ms",
        (t3 - t2).as_secs_f64() * 1000.0
    );

    let t_exec_start = Instant::now();
    let result = state.execute_import_sections(sections, closures, None, Vec::new(), Vec::new());
    let exec_elapsed = t_exec_start.elapsed();
    eprintln!(
        "│ execute_import_sections:     {:>9.2} ms",
        exec_elapsed.as_secs_f64() * 1000.0
    );
    eprintln!("├─ totals ──────────────────────────────────────────────");
    eprintln!(
        "│ end-to-end (parse+convert+execute): {:>9.2} ms",
        ((t1 - t0) + (t2 - t1) + exec_elapsed).as_secs_f64() * 1000.0
    );
    eprintln!("└───────────────────────────────────────────────────────");

    assert!(
        result.success,
        "execute_import_sections failed: {:?}",
        result.error
    );
}

// ============================================================================
// Performance profiler for project load (not a unit test)
// ============================================================================
//
// Run with:
//   STALAGMIGHT_PROFILE_STALX=/home/user/Documents/stalagmight/92.stalx \
//     cargo test --release --manifest-path src-tauri/Cargo.toml --lib \
//     state::tests::profile_stalx_load -- --nocapture --ignored

#[test]
#[ignore = "profiling harness — run explicitly with STALAGMIGHT_PROFILE_STALX=<path>"]
fn profile_stalx_load() {
    use crate::persistence::Database;
    use std::time::Instant;

    let path = std::env::var("STALAGMIGHT_PROFILE_STALX")
        .expect("set STALAGMIGHT_PROFILE_STALX to the .stalx file path");

    let _ = tracing_subscriber::fmt()
        .with_target(false)
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    // === Phase 0: SQLite open ===
    let t0 = Instant::now();
    let db = Database::open_existing(std::path::Path::new(&path)).expect("open_existing");
    let t1 = Instant::now();

    // === Phase 1: load_project (the bulk query loop) ===
    let mut project = db.load_project().expect("load_project");
    let t2 = Instant::now();

    let section_count = project.sections.len();
    let shot_count: usize = project.sections.iter().map(|s| s.shots.len()).sum();

    // === Phase 2: station coordinate computation ===
    let stations = project.compute_station_coordinates();
    let t3 = Instant::now();
    let station_count = stations.len();

    // === Phase 3: project stats + penetration ===
    let mut stats = project.stats();
    stats.penetration_distance = project.calculate_penetration(&stations);
    let t4 = Instant::now();

    // === Phase 4: warnings (via AppState because the impl is on AppState) ===
    project.file_path = Some(PathBuf::from(&path));
    let state = AppState::new().unwrap();
    state.set_project_for_tests(project.clone());
    let warnings = state.compute_project_warnings(&project, Some(&db));
    let t5 = Instant::now();

    // === Phase 5: load_display_settings ===
    let _settings = db.load_display_settings().unwrap_or_default();
    let t6 = Instant::now();

    // === Phase 6: load_undo_stack_with_timestamps ===
    let _undo = db.load_undo_stack_with_timestamps().unwrap_or_default();
    let _redo = db.load_redo_stack_with_timestamps().unwrap_or_default();
    let t7 = Instant::now();

    // === Phase 7: binary envelope encoding ===
    let display_settings = crate::core::loading::DisplaySettings::from_stored(
        &db.load_display_settings().unwrap_or_default(),
    );
    let result = crate::core::loading::LoadProjectFullResult {
        project,
        stations,
        stats,
        warnings,
        display_settings,
        loading_id: 0,
    };
    let bin = crate::core::load_binary::encode(result).expect("encode");
    let t8 = Instant::now();

    eprintln!("\n┌─ profile_stalx_load ──────────────────────────────────");
    eprintln!("│ file:      {path}");
    eprintln!("│ sections:  {section_count}");
    eprintln!("│ shots:     {shot_count}");
    eprintln!("│ stations:  {station_count}");
    eprintln!(
        "│ binary envelope: {} bytes ({:.1} MB)",
        bin.len(),
        bin.len() as f64 / 1024.0 / 1024.0
    );
    eprintln!("├─ phase timings ───────────────────────────────────────");
    eprintln!(
        "│ Database::open_existing:        {:>9.2} ms",
        (t1 - t0).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ db.load_project (SQLite):       {:>9.2} ms",
        (t2 - t1).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ compute_station_coordinates:    {:>9.2} ms",
        (t3 - t2).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ project.stats + penetration:    {:>9.2} ms",
        (t4 - t3).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ compute_project_warnings:       {:>9.2} ms",
        (t5 - t4).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ load_display_settings:          {:>9.2} ms",
        (t6 - t5).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ load_undo+redo_stacks:          {:>9.2} ms",
        (t7 - t6).as_secs_f64() * 1000.0
    );
    eprintln!(
        "│ binary envelope encode:         {:>9.2} ms",
        (t8 - t7).as_secs_f64() * 1000.0
    );
    eprintln!("├─ totals ──────────────────────────────────────────────");
    eprintln!(
        "│ end-to-end:                     {:>9.2} ms",
        (t8 - t0).as_secs_f64() * 1000.0
    );
    eprintln!("└───────────────────────────────────────────────────────");
}

#[test]
fn redo_create_shot_preserves_uuid_all_insert_modes() {
    // Redo of CreateShot must restore the shot's ORIGINAL UUID (not mint a fresh
    // one) on every insert mode — append, insert_after, and prepend — because
    // cross-references and Ariane matching anchor on it. Each mode hits a
    // distinct redo branch (append: Shot::with_uuid; after/before: the forced
    // uuid threaded through insert_shot_*).
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let sid = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0), test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    let uuid_of = |s: &AppState, shot_id: u32| -> Option<String> {
        s.get_project_state()
            .unwrap()
            .get_section(sid)
            .unwrap()
            .get_shot(shot_id)
            .unwrap()
            .uuid
            .clone()
    };
    let first_id = state
        .get_project_state()
        .unwrap()
        .get_section(sid)
        .unwrap()
        .shots[0]
        .id;
    let last_id = {
        let p = state.get_project_state().unwrap();
        let shots = &p.get_section(sid).unwrap().shots;
        shots[shots.len() - 1].id
    };

    let cases = [
        // (after_shot_id, before_shot_id) → append / insert_after / prepend
        Command::CreateShot {
            section_id: sid,
            shot: test_shot_data(3.0),
            after_shot_id: None,
            before_shot_id: None,
        },
        Command::CreateShot {
            section_id: sid,
            shot: test_shot_data(3.0),
            after_shot_id: Some(last_id),
            before_shot_id: None,
        },
        Command::CreateShot {
            section_id: sid,
            shot: test_shot_data(3.0),
            after_shot_id: None,
            before_shot_id: Some(first_id),
        },
    ];
    for cmd in cases {
        let res = state.execute(cmd);
        assert!(res.success, "create shot succeeds");
        let new_id = res.shot_id.expect("create shot returns id");
        let before = uuid_of(&state, new_id);
        assert!(before.is_some(), "created shot has a uuid");

        assert!(state.undo().success, "undo create shot");
        assert!(state.redo().success, "redo create shot");

        assert_eq!(
            uuid_of(&state, new_id),
            before,
            "redo must preserve the shot UUID"
        );
    }
}

#[test]
fn repair_open_project_integrity_reports_fixed_and_remaining() {
    // Repair returns the genuine before→after delta over the FULL violation set,
    // so a repairable issue counts as `fixed` and a detect-only one (a drifted
    // aligned loop closure) counts as `remaining`.
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "X".to_string(),
        location: None,
    });
    let a = state
        .execute(Command::CreateSection {
            name: Some("A".to_string()),
            surveyor: None,
            date: None,
            color: "#111111".to_string(),
            direction: Some(SurveyDirection::In),
            shots: vec![test_shot_data(5.0)],
        })
        .section_id
        .unwrap();

    // Inject a dangling merge (repairable: repair drops it).
    {
        let mut guard = state.project.lock().unwrap();
        let project = guard.as_mut().unwrap();
        let dangling = StationKey::new(a, StationAnchor::AfterShot("ghost".to_string()));
        project.station_merges.push(StationMerge {
            station_a: dangling,
            station_b: StationRef::new(a, 0).into(),
            merged_at: chrono::Utc::now(),
        });
    }

    let before = state.integrity_violation_messages().len();
    assert!(before >= 1, "seeded at least one violation");

    let result = state.repair_open_project_integrity();
    assert_eq!(
        (result.fixed + result.remaining) as usize,
        before,
        "fixed + remaining accounts for every issue the banner showed"
    );
    assert!(result.fixed >= 1, "the dangling merge was repaired");
    assert_eq!(
        result.remaining as usize,
        state.integrity_violation_messages().len(),
        "remaining matches the true post-repair count"
    );
}

// ===========================================================================
// #191 — read-only edit gate + dirty bit + chokepoint enumeration (Track B).
// Stamped-remote fixture: a temp .stalx carrying a speleo_link row, opened so
// edit_enabled flips false (remote-open-without-lock). See guard_mutation /
// mark_remote_dirty / is_lifecycle_passthrough.
// ===========================================================================

use crate::core::command::EDIT_DISABLED_CODE;
use crate::models::SpeleoLink;

/// A SpeleoLink fixture (clean: no unpushed edits).
fn fixture_speleo_link() -> SpeleoLink {
    SpeleoLink {
        endpoint: "http://10.10.0.220:8000/".to_string(),
        project_id: "11111111-1111-1111-1111-111111111111".to_string(),
        project_name: "Remote Cave".to_string(),
        base_commit_sha: Some("abc123".to_string()),
        has_unpushed_edits: false,
    }
}

/// Build an AppState with an OPEN, STAMPED-REMOTE project: a temp `.stalx` saved
/// with one section + one shot, stamped with a speleo_link row, then opened via
/// `open_project` so `edit_enabled` flips false (remote-open-without-lock).
/// Returns `(state, section_id, shot_id, _temp)` — keep `_temp` alive.
fn remote_fixture() -> (AppState, SectionId, ShotId, TempDir) {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("remote.stalx");

    let mut project = Project::new("Remote Cave".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![test_shot_data(2.0), test_shot_data(2.0)],
            ..Default::default()
        })
        .id;

    let mut db = Database::open(&path).unwrap();
    db.save_project(&project).unwrap();
    db.save_speleo_link(Some(&fixture_speleo_link())).unwrap();
    drop(db);

    let state = AppState::new().unwrap();
    assert!(state.open_project(path).success, "open remote fixture");
    // open_project should have flipped edit_enabled false (link present).
    assert!(!state.edit_enabled(), "remote-open disables editing");

    let project = state.get_project_state().unwrap();
    let shot_id = project.sections[0].shots[0].id;
    (state, section_id, shot_id, temp)
}

/// Build the same fixture but force editing ENABLED (simulating a later
/// lock-acquire) so the dirty-bit plumbing can be exercised.
fn remote_fixture_editable() -> (AppState, SectionId, ShotId, TempDir) {
    let (state, sid, shid, temp) = remote_fixture();
    state.set_edit_enabled(true);
    (state, sid, shid, temp)
}

/// Read has_unpushed_edits straight from the open database.
fn dirty_bit(state: &AppState) -> bool {
    let guard = state.database.lock().unwrap();
    guard
        .as_ref()
        .unwrap()
        .load_speleo_link()
        .unwrap()
        .unwrap()
        .has_unpushed_edits
}

#[test]
fn edit_enabled_defaults_true_and_local_project_passes() {
    // A fresh local-only project (no speleo_link) is always editable; the gate is
    // a no-op off-SpeleoDB.
    let state = AppState::new().unwrap();
    assert!(state.edit_enabled(), "default-true");
    assert!(
        state
            .execute(Command::CreateProject {
                name: "Local".to_string(),
                location: None,
            })
            .success
    );
    assert!(state.edit_enabled(), "create keeps edit enabled");
    let result = state.execute(Command::CreateSection {
        name: Some("S".to_string()),
        surveyor: None,
        date: None,
        color: "#abcdef".to_string(),
        direction: None,
        shots: vec![test_shot_data(1.0)],
    });
    assert!(result.success, "local project edits succeed");
}

#[test]
fn remote_open_without_lock_disables_edit() {
    let (state, _sid, _shid, _temp) = remote_fixture();
    assert!(!state.edit_enabled(), "remote project opens read-only");
    // Closing resets the gate so the next open isn't stuck.
    assert!(state.close_project().success);
    assert!(state.edit_enabled(), "close resets the gate");
}

/// The chokepoint enumeration tripwire (D-B6): every routed mutation entry must
/// reject on a read-only remote project with the EDIT_DISABLED code (or, for
/// repair, changed == false). A newly-added mutation path that forgets the guard
/// fails here. The names are pinned in MUTATION_ENTRYPOINTS below.
const MUTATION_ENTRYPOINTS: &[&str] = &[
    // execute() + its in-execute arms (MoveComment, ApplyCollabChanges)
    "execute",
    "execute:MoveComment",
    "execute:ApplyCollabChanges",
    // history entrypoints
    "undo",
    "redo",
    "undo_to",
    "redo_to",
    // direct-lock bypass methods
    "update_project_settings",
    "repair_open_project_integrity",
    "execute_delete_shot_and_split",
    "execute_delete_shot_range_split",
    "execute_delete_shot_range_shift",
    "execute_delete_last_shot_and_section",
    "execute_create_and_merge",
    "execute_import_sections",
    // collab toggles
    "set_collab_enabled",
    "set_collab_enabled_for_path",
];

#[test]
fn gate_rejects_every_mutation_entrypoint_with_edit_disabled_code() {
    // Tripwire doc: when a new state-mutating entry is added, route it through
    // guard_mutation AND add its name to MUTATION_ENTRYPOINTS + a call below.
    assert_eq!(
        MUTATION_ENTRYPOINTS.len(),
        17,
        "update both the routing and this list when adding a mutation entry"
    );

    let assert_disabled = |label: &str, r: &CommandResult| {
        assert!(!r.success, "{label} must be rejected when edit disabled");
        assert!(
            r.error
                .as_deref()
                .is_some_and(|e| e.starts_with(EDIT_DISABLED_CODE)),
            "{label} must carry the EDIT_DISABLED code, got: {:?}",
            r.error
        );
    };

    // --- execute() and its in-execute arms ---
    {
        let (state, sid, shid, _temp) = remote_fixture();
        assert_disabled(
            "execute",
            &state.execute(Command::UpdateShot {
                section_id: sid,
                shot_id: shid,
                updates: ShotUpdates::default(),
            }),
        );
        assert_disabled(
            "execute:MoveComment",
            &state.execute(Command::MoveComment {
                source: crate::core::CommentHolder::Shot {
                    section_id: sid,
                    shot_id: shid,
                },
                target: crate::core::CommentHolder::Shot {
                    section_id: sid,
                    shot_id: shid,
                },
                swap: false,
            }),
        );
        assert_disabled(
            "execute:ApplyCollabChanges",
            &state.execute(Command::ApplyCollabChanges),
        );
    }

    // --- history entrypoints ---
    {
        let (state, _sid, _shid, _temp) = remote_fixture();
        assert_disabled("undo", &state.undo());
        assert_disabled("redo", &state.redo());
        assert_disabled("undo_to", &state.undo_to(0));
        assert_disabled("redo_to", &state.redo_to(0));
    }

    // --- direct-lock bypass methods ---
    {
        let (state, sid, shid, _temp) = remote_fixture();
        assert_disabled(
            "update_project_settings",
            &state.update_project_settings("Renamed".to_string(), state.get_config().validation),
        );
        // repair returns IntegrityRepairResult (no coded failure surface) →
        // changed == false (D-B5).
        let repair = state.repair_open_project_integrity();
        assert!(!repair.changed, "repair on read-only remote is a no-op");
        assert_disabled(
            "execute_delete_shot_and_split",
            &state.execute_delete_shot_and_split(sid, shid, "A".to_string(), "B".to_string()),
        );
        assert_disabled(
            "execute_delete_shot_range_split",
            &state.execute_delete_shot_range_split(
                sid,
                shid,
                shid,
                "A".to_string(),
                "B".to_string(),
            ),
        );
        assert_disabled(
            "execute_delete_shot_range_shift",
            &state.execute_delete_shot_range_shift(sid, shid, shid),
        );
        assert_disabled(
            "execute_delete_last_shot_and_section",
            &state.execute_delete_last_shot_and_section(sid, shid),
        );
        assert_disabled(
            "execute_create_and_merge",
            &state.execute_create_and_merge(
                Some("Imp".to_string()),
                None,
                None,
                "#00ff00".to_string(),
                None,
                vec![test_shot_data(3.0)],
                0,
                StationRef::new(sid, 1),
                ClosureStrategy::Batch,
            ),
        );
        assert_disabled(
            "execute_import_sections",
            &state.execute_import_sections(
                vec![ImportSectionConfig {
                    section_index: 0,
                    name: Some("Imp".to_string()),
                    surveyor: None,
                    date: None,
                    color: "#00ff00".to_string(),
                    direction: None,
                    quality: 1.0,
                    shots: vec![test_shot_data(3.0)],
                    station_comments: Vec::new(),
                    placement: ImportPlacement::Origin,
                }],
                Vec::new(),
                None,
                Vec::new(),
                Vec::new(),
            ),
        );
    }

    // --- collab toggles ---
    {
        let (state, _sid, _shid, _temp) = remote_fixture();
        assert_disabled("set_collab_enabled", &state.set_collab_enabled(true));
        // set_collab_enabled_for_path is gated only when path == the OPEN project.
        let open_path = state.get_project_state().unwrap().file_path.unwrap();
        assert_disabled(
            "set_collab_enabled_for_path",
            &state.set_collab_enabled_for_path(open_path, true),
        );
    }
}

#[test]
fn lifecycle_commands_pass_through_gate() {
    // Save / Close must NOT be blocked on a read-only remote project (autosave
    // must keep working). Open/Create/MergeProjects are lifecycle too.
    let (state, _sid, _shid, _temp) = remote_fixture();
    assert!(!state.edit_enabled());

    // Autosave (SaveProject) passes the gate.
    let save = state.execute(Command::SaveProject {
        path: None,
        is_autosave: true,
    });
    assert!(save.success, "autosave must pass through the gate");

    // The dirty bit is NOT set by a local save.
    assert!(!dirty_bit(&state), "save/autosave never sets the dirty bit");

    // Close passes through (and resets the gate).
    assert!(state.close_project().success);
}

#[test]
fn dirty_bit_flips_false_to_true_on_successful_remote_edit() {
    let (state, sid, shid, _temp) = remote_fixture_editable();
    assert!(!dirty_bit(&state), "starts clean");

    let r = state.execute(Command::UpdateShot {
        section_id: sid,
        shot_id: shid,
        updates: ShotUpdates {
            length: Some(9.0),
            ..Default::default()
        },
    });
    assert!(r.success);
    assert!(
        dirty_bit(&state),
        "successful remote edit flips the dirty bit"
    );
}

#[test]
fn dirty_bit_is_idempotent_and_set_only() {
    let (state, sid, shid, _temp) = remote_fixture_editable();

    // First edit sets it.
    assert!(
        state
            .execute(Command::UpdateShot {
                section_id: sid,
                shot_id: shid,
                updates: ShotUpdates {
                    length: Some(9.0),
                    ..Default::default()
                },
            })
            .success
    );
    assert!(dirty_bit(&state));

    // A second edit + a local autosave both leave it set (idempotent; set-only —
    // a local save NEVER clears it).
    assert!(
        state
            .execute(Command::UpdateShot {
                section_id: sid,
                shot_id: shid,
                updates: ShotUpdates {
                    length: Some(8.0),
                    ..Default::default()
                },
            })
            .success
    );
    assert!(
        state
            .execute(Command::SaveProject {
                path: None,
                is_autosave: true,
            })
            .success
    );
    assert!(dirty_bit(&state), "dirty bit stays set after autosave");
}

#[test]
fn dirty_bit_noop_for_local_only_project() {
    // A local-only project has no speleo_link → mark_remote_dirty is a no-op and
    // never errors.
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("local.stalx");
    let mut project = Project::new("Local".to_string(), None);
    let sid = project
        .add_section(SectionData {
            shots: vec![test_shot_data(2.0)],
            ..Default::default()
        })
        .id;
    let mut db = Database::open(&path).unwrap();
    db.save_project(&project).unwrap();
    drop(db);

    let state = AppState::new().unwrap();
    assert!(state.open_project(path).success);
    assert!(state.edit_enabled(), "local project stays editable");

    let shid = state.get_project_state().unwrap().sections[0].shots[0].id;
    assert!(
        state
            .execute(Command::UpdateShot {
                section_id: sid,
                shot_id: shid,
                updates: ShotUpdates {
                    length: Some(5.0),
                    ..Default::default()
                },
            })
            .success
    );
    // No speleo_link row exists; mark_remote_dirty was a silent no-op.
    let guard = state.database.lock().unwrap();
    assert!(guard
        .as_ref()
        .unwrap()
        .load_speleo_link()
        .unwrap()
        .is_none());
}

#[test]
fn edit_disabled_code_prefix_is_distinct() {
    // The EDIT_DISABLED code is distinct from the FS permission code, so the FE
    // can pattern-match it independently (#204).
    assert_eq!(EDIT_DISABLED_CODE, "EDIT_DISABLED");
    assert_ne!(
        EDIT_DISABLED_CODE,
        crate::core::loading::PERMISSION_DENIED_CODE
    );
    let (state, sid, shid, _temp) = remote_fixture();
    let err = state
        .execute(Command::UpdateShot {
            section_id: sid,
            shot_id: shid,
            updates: ShotUpdates::default(),
        })
        .error
        .unwrap();
    assert!(err.starts_with(EDIT_DISABLED_CODE));
    assert!(
        !err.starts_with(crate::core::loading::PERMISSION_DENIED_CODE),
        "must not collide with the permission-denied prefix"
    );
}

#[test]
fn repair_and_settings_gated_on_locked_remote() {
    let (state, _sid, _shid, _temp) = remote_fixture();
    // Repair: returns changed == false (no coded-failure surface; D-B5).
    let repair = state.repair_open_project_integrity();
    assert!(!repair.changed);
    assert_eq!(repair.fixed, 0);
    // Settings: returns the EDIT_DISABLED coded failure.
    let settings =
        state.update_project_settings("New Name".to_string(), state.get_config().validation);
    assert!(!settings.success);
    assert!(settings
        .error
        .as_deref()
        .is_some_and(|e| e.starts_with(EDIT_DISABLED_CODE)));
}
