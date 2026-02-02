use super::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::core::undo::{UndoData, UndoEntry};
use crate::core::Command;
use crate::models::{
    ClosureStrategy, Coordinates, GpsCoordinates, Project, SectionData, SectionUpdates, ShotData,
    ShotUpdates, StationRef, SurveyDirection,
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

fn poison_mutex<T>(mutex: &Mutex<T>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = mutex.lock().unwrap();
        panic!("poison mutex for lock failure coverage");
    }));
}

// === Project Operations Tests ===

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
        shots: vec![test_shot_data(1.0)],
    });

    let mut project_b = Project::new("B".to_string(), None);
    project_b.add_section(SectionData {
        name: Some("Section B".to_string()),
        surveyor: None,
        date: None,
        color: "#4ecdc4".to_string(),
        direction: Some(SurveyDirection::Out),
        shots: vec![test_shot_data(2.0)],
    });

    let source_a = temp_dir.path().join("a.cvproj");
    let source_b = temp_dir.path().join("b.cvproj");

    let mut db_a = Database::open(&source_a).unwrap();
    db_a.save_project(&project_a).unwrap();
    let mut db_b = Database::open(&source_b).unwrap();
    db_b.save_project(&project_b).unwrap();
    drop(db_a);
    drop(db_b);

    let existing_archive = temp_dir.path().join("a.cvproj.archived");
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

    let output_with_ext = output_path.with_extension("cvproj");
    assert!(output_with_ext.exists());

    assert!(!source_a.exists());
    assert!(!source_b.exists());

    let archived_entries: Vec<_> = std::fs::read_dir(temp_dir.path())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("a.cvproj.archived"))
                .unwrap_or(false)
        })
        .collect();

    assert!(!archived_entries.is_empty());
    assert!(temp_dir.path().join("b.cvproj.archived").exists());
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
        Command::Batch { commands: Vec::new() },
        UndoData::ProjectSnapshot("not-json".to_string()),
    );
    drop(stack);

    let result = state.undo();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Failed to parse project snapshot"));
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
    assert_eq!(result.error.as_deref(), Some("Failed to parse project snapshot"));
}

#[test]
fn test_redo_fails_for_command_not_allowed_in_undo_context() {
    let state = AppState::new().unwrap();
    let mut stack = state.undo_stack.lock().unwrap();
    let entry = UndoEntry {
        command: Command::MergeProjects {
            source_paths: Vec::new(),
            output_path: PathBuf::from("out.cvproj"),
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
    assert_eq!(
        project.sections[0].name,
        Some("Updated".to_string())
    );
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

    assert_coords_close(station_0_after, station_1_before);
    assert_coords_close(station_1_after, station_2_before);
}

#[test]
fn test_delete_shot_rewires_merges() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    let sec_a = state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        surveyor: None,
        date: None,
        color: "#ff0000".to_string(),
        direction: None,
        shots: vec![test_shot_data(5.0), test_shot_data(7.0)],
    }).section_id.unwrap();

    let sec_b = state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: None,
        shots: vec![test_shot_data(6.0)],
    }).section_id.unwrap();

    let sec_c = state.execute(Command::CreateSection {
        name: Some("C".to_string()),
        surveyor: None,
        date: None,
        color: "#0000ff".to_string(),
        direction: None,
        shots: vec![test_shot_data(8.0)],
    }).section_id.unwrap();

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
    let first_shot_id = project_before.sections.iter().find(|s| s.id == sec_a).unwrap().shots[0].id;

    let delete_result = state.execute(Command::DeleteShot {
        section_id: sec_a,
        shot_id: first_shot_id,
    });
    assert!(delete_result.success);

    let project_after = state.get_project_state().unwrap();
    let has_merge_bc = project_after.station_merges.iter().any(|m| {
        (m.station_a == StationRef::new(sec_b, 0) && m.station_b == StationRef::new(sec_c, 0))
            || (m.station_a == StationRef::new(sec_c, 0) && m.station_b == StationRef::new(sec_b, 0))
    });
    assert!(has_merge_bc, "Expected replacement merge between B:0 and C:0");
}

#[test]
fn test_set_shot_virtual() {
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

    // Initially not virtual
    assert!(!project.sections[0].shots[0].is_virtual);

    let result = state.execute(Command::SetShotVirtual {
        section_id,
        shot_id,
        is_virtual: true,
    });

    assert!(result.success);

    let project = state.get_project_state().unwrap();
    assert!(project.sections[0].shots[0].is_virtual);
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
    assert_eq!(
        project.sections[0].name,
        Some("Will Delete".to_string())
    );
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
        shots: vec![test_shot_data(1.0)],
    });

    let mut after = Project::new("After".to_string(), None);
    after.add_section(SectionData {
        name: Some("After Section".to_string()),
        surveyor: None,
        date: None,
        color: "#00ff00".to_string(),
        direction: Some(SurveyDirection::Out),
        shots: vec![test_shot_data(2.0), test_shot_data(3.0)],
    });

    let before_json = serde_json::to_string(&before).unwrap();
    let after_json = serde_json::to_string(&after).unwrap();

    state.set_project_for_tests(after.clone());

    let mut stack = state.undo_stack.lock().unwrap();
    stack.push_with_data(
        Command::MergeProjects {
            source_paths: Vec::new(),
            output_path: PathBuf::from("out.cvproj"),
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
        Command::Batch { commands: Vec::new() },
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
        Command::Batch { commands: Vec::new() },
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
        path: PathBuf::from("/test.cvproj"),
    }));
    assert!(!AppState::is_undoable(&Command::SaveProject { path: None }));
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
    assert!(AppState::is_undoable(&Command::DeleteSection { section_id: 0 }));
    assert!(AppState::is_undoable(&Command::CreateShot {
        section_id: 0,
        shot: ShotData::default(),
        after_shot_id: None,
        before_shot_id: None,
    }));
}

#[test]
fn test_is_modifying_commands() {
    // Non-modifying commands
    assert!(!AppState::is_modifying(&Command::OpenProject {
        path: PathBuf::from("/test.cvproj"),
    }));
    assert!(!AppState::is_modifying(&Command::SaveProject { path: None }));
    assert!(!AppState::is_modifying(&Command::CloseProject));

    // Modifying commands
    assert!(AppState::is_modifying(&Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    }));
    assert!(AppState::is_modifying(&Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: "#000000".to_string(),
        direction: None,
        shots: vec![],
    }));
}

// === Config Tests ===

#[test]
fn test_get_config() {
    let state = AppState::new().unwrap();
    let config = state.get_config();

    // Should have default values
    assert!(config.general.auto_save);
    assert_eq!(config.general.undo_history_limit, 100);
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
    };

    let err = state.save_resolved_warning(&warning).unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock database");

    let err = state.delete_resolved_warning(1, 2, "TEST").unwrap_err();
    assert_eq!(err.to_string(), "Failed to lock database");
}

#[test]
fn test_remove_recent_projects_fails_when_lock_poisoned() {
    let state = AppState::new().unwrap();
    poison_mutex(&state.recent_projects);

    let result = state.remove_from_recent_projects(PathBuf::from("missing.cvproj"));
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
    assert_eq!(project.section_offsets.get(&section_id), Some(&(10.0, 20.0)));

    // Undo should reverse the move
    let undo_result = state.undo();
    assert!(undo_result.success);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0)),
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
fn test_create_section_with_validation_warnings() {
    let state = AppState::new().unwrap();

    state.execute(Command::CreateProject {
        name: "Test".to_string(),
        location: None,
    });

    // Create a section with a zero-length shot (should trigger warning)
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

    assert!(result.success);
    assert!(!result.warnings.is_empty());
    assert!(result.warnings.iter().any(|w| w.code == "ZERO_LENGTH"));
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
            name: Some(format!("Section {}", i)),
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
        shots: vec![test_shot_data(10.0), test_shot_data(15.0), test_shot_data(8.0)],
    });

    assert!(result.success);
    let section_id = result.section_id.expect("Section ID should be returned");

    let project = state.get_project_state().unwrap();
    let section = project.get_section(section_id).expect("Section should exist");

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
    assert_eq!(merge.station_a, station_a);
    assert_eq!(merge.station_b, station_b);

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
    assert_eq!(datum.station_ref, station_ref);
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
    assert_ne!(pre_offset_a, post_offset_a, "Section A offset should change");
    assert!(post_offset_b.is_some(), "Section B should now have an offset");
    assert_eq!(post_datum_count, pre_datum_count + 1, "Datum should be added");

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
        shot_id: 999999,
        updates: ShotUpdates::default(),
    });
    assert!(!result.success);

    let result = state.execute(Command::DeleteShot {
        section_id,
        shot_id: 999999,
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
    state.execute(Command::DeleteShot { section_id, shot_id });

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
    assert_eq!(project_after.station_merges[0].station_a, station_a);
    assert_eq!(project_after.station_merges[0].station_b, station_b);

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
    assert!(!project.sections.iter().any(|s| s.name == Some("Third".to_string())));

    // Undo should remove Second
    let result = state.undo();
    assert!(result.success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert!(!project.sections.iter().any(|s| s.name == Some("Second".to_string())));

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
            name: Some(format!("Section {}", i)),
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
    assert!(project.sections.iter().any(|s| s.name == Some("Section 0".to_string())));
    assert!(project.sections.iter().any(|s| s.name == Some("Section 1".to_string())));
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
    assert_eq!(stack.len(), 1, "Entry must remain on undo stack after failure");
    assert!(stack.can_undo(), "can_undo must be true — entry was preserved");
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
    assert_eq!(stack.redo_len(), 1, "Entry must remain on redo stack after failure");
    assert!(stack.can_redo(), "can_redo must be true — entry was preserved");
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
        matches!(top_cmd, Command::UpdateShot { section_id: 999, .. }),
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
    assert_eq!(stack.redo_len(), 2, "Both entries must still be on redo stack");

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
            name: Some(format!("Section {}", i)),
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
        "Expected enhanced message with step count, got: {}",
        error_msg
    );
    assert!(
        error_msg.contains("Failed to parse undo data"),
        "Expected original failure reason in message, got: {}",
        error_msg
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
    assert_eq!(stack.len(), 2, "Section 0 and invalid entry must remain on undo stack");
    let top_cmd = stack.peek_undo().unwrap();
    assert!(
        matches!(top_cmd, Command::UpdateShot { section_id: 999, .. }),
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
        "Expected enhanced message with step count, got: {}",
        error_msg
    );
    assert!(
        error_msg.contains("Failed to parse project snapshot"),
        "Expected original failure reason in message, got: {}",
        error_msg
    );

    // Verify partial completion: SectionA was re-created (step 1 succeeded)
    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.len(),
        1,
        "Only SectionA should have been redone (step 1)"
    );
    assert_eq!(
        project.sections[0].name,
        Some("Section A".to_string())
    );

    // Verify the failed entry was preserved on the redo stack
    let stack = state.undo_stack.lock().unwrap();
    assert_eq!(stack.redo_len(), 2, "Invalid entry and SectionB must remain on redo stack");
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

    let snapshot =
        serde_json::to_string(&Project::new("Test".to_string(), None)).unwrap();
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
    assert_eq!(stack.len(), 1, "Entry must be preserved on undo stack after project lock failure");
    assert!(!stack.can_redo(), "Entry must not appear on redo stack");
}

#[test]
fn test_redo_failure_with_project_lock_preserves_entry() {
    // When the project mutex is poisoned, redo fails but the entry
    // must still be pushed back to the redo stack.
    let state = AppState::new().unwrap();

    let before =
        serde_json::to_string(&Project::new("Before".to_string(), None)).unwrap();
    let after =
        serde_json::to_string(&Project::new("After".to_string(), None)).unwrap();

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
    assert_eq!(stack.redo_len(), 1, "Entry must be preserved on redo stack after project lock failure");
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
                "previous_offsets must contain the datum section ({})",
                section_a
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
            .find(|zd| zd.station_ref == station_ref)
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
            .find(|zd| zd.station_ref == station_ref)
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
            .find(|zd| zd.station_ref == station_ref)
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
        closure_strategy: crate::models::ClosureStrategy::default(),
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
        assert_eq!(project.loop_closures.len(), 0, "Closure should be removed after undo");
    }

    // Redo: closure should be re-added
    let redo_result = state.redo();
    assert!(redo_result.success, "Redo should succeed");

    {
        let project = state.get_project_state().unwrap();
        assert_eq!(project.loop_closures.len(), 1, "Closure should be restored after redo");
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
        closure_strategy: crate::models::ClosureStrategy::default(),
    });

    // Check undo stack has ClosureInfo data
    let stack = state.undo_stack.lock().unwrap();
    let undo_data = stack.peek_undo_data().unwrap();
    match undo_data {
        UndoData::ClosureInfo { closure } => {
            assert_eq!(closure.station_a, StationRef::new(section_a, 0));
            assert_eq!(closure.station_b, StationRef::new(section_b, 1));
            assert!(closure.path_length > 0.0);
        }
        other => panic!("Expected ClosureInfo, got {:?}", other.variant_name()),
    }
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
        project.loop_closures.push(crate::models::LoopClosure {
            id: 1,
            station_a: merge_station_a,
            station_b: merge_station_b,
            path_length: 15.0,
            misclosure_distance: 0.3,
            error_percentage: 2.0,
            horizontal_misclosure: 0.2,
            vertical_misclosure: 0.1,
        strategy: ClosureStrategy::default(),
        });
    }

    {
        let project = state.get_project_state().unwrap();
        assert_eq!(project.loop_closures.len(), 1, "Should have 1 closure before unmerge");
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
            project.loop_closures.len(), 0,
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
            project.loop_closures.len(), 1,
            "Closure should be restored after undo of unmerge"
        );
        let restored_closure = &project.loop_closures[0];
        assert_eq!(restored_closure.station_a, merge_station_a);
        assert_eq!(restored_closure.station_b, merge_station_b);
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
    assert!((shot.length - 15.0).abs() < 1e-6, "Length should be 15.0, got {}", shot.length);
    assert!((shot.azimuth_in - 90.0).abs() < 1e-6, "Azimuth should still be 90°");
    assert!(project.station_offsets.get(&station_ref).is_none(), "Station offset should be cleared");

    // Second move: (0, 10, 3) — shot vector becomes (15, 10, 3)
    let result = state.execute(Command::MoveStation {
        station_ref,
        offset: Coordinates::new(0.0, 10.0, 3.0),
    });
    assert!(result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    let expected_len = (15.0_f64.powi(2) + 10.0_f64.powi(2)).sqrt(); // sqrt(325)
    assert!((shot.length - expected_len).abs() < 1e-6, "Length should be {}, got {}", expected_len, shot.length);
    let expected_azi = (15.0_f64).atan2(10.0).to_degrees(); // atan2(dx, dy)
    assert!((shot.azimuth_in - expected_azi).abs() < 1e-6, "Azimuth should be {:.1}°, got {:.1}°", expected_azi, shot.azimuth_in);
    assert!((shot.depth_out - 3.0).abs() < 1e-6, "Depth out should be 3.0, got {}", shot.depth_out);
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

    assert!((after_station_0.x - 5.0).abs() < 1e-6, "Station 0 x should be 5.0");
    assert!((after_station_0.y).abs() < 1e-6, "Station 0 y should remain 0.0");
    assert!(
        (after_station_1.x - before_station_1.x).abs() < 1e-6,
        "Station 1 x should remain unchanged"
    );
    assert!(
        (after_station_1.y - before_station_1.y).abs() < 1e-6,
        "Station 1 y should remain unchanged"
    );

    let offset = after.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
    assert!((offset.0 - 5.0).abs() < 1e-6, "Section offset x should be 5.0");
    assert!((offset.1).abs() < 1e-6, "Section offset y should remain 0.0");
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
    assert!((shot.length - 5.0).abs() < 1e-6, "Shot length after move should be 5.0");

    // Undo should restore original shot data
    let undo_result = state.undo();
    assert!(undo_result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!((shot.length - 10.0).abs() < 1e-6, "Undo should restore length to 10.0, got {}", shot.length);
    assert!((shot.azimuth_in - 90.0).abs() < 1e-6, "Undo should restore azimuth_in to 90.0");
    assert!((shot.azimuth_out - 90.0).abs() < 1e-6, "Undo should restore azimuth_out to 90.0");
    assert!((shot.depth_in - 0.0).abs() < 1e-6, "Undo should restore depth_in to 0.0");
    assert!((shot.depth_out - 0.0).abs() < 1e-6, "Undo should restore depth_out to 0.0");
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
    assert!((shot.length - 15.0).abs() < 1e-6, "After move: length should be 15.0");

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!((shot.length - 10.0).abs() < 1e-6, "After undo: length should be 10.0");

    // Redo should re-apply the move
    let redo_result = state.redo();
    assert!(redo_result.success);

    let project = state.get_project_state().unwrap();
    let shot = &project.get_section(section_id).unwrap().shots[0];
    assert!((shot.length - 15.0).abs() < 1e-6, "After redo: length should be 15.0, got {}", shot.length);
    assert!((shot.azimuth_in - 90.0).abs() < 1e-6, "After redo: azimuth should be 90°");
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
        "X coordinate should shift by 100.0, got delta {}",
        dx
    );
    assert!(
        (dy - 200.0).abs() < 1e-6,
        "Y coordinate should shift by 200.0, got delta {}",
        dy
    );
    assert!(
        (dz - 50.0).abs() < 1e-6,
        "Z coordinate should shift by 50.0, got delta {}",
        dz
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
        shots: vec![test_shot_data(3.0), test_shot_data(7.0), test_shot_data(11.0)],
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
        shots: vec![test_shot_data(1.0), test_shot_data(2.0), test_shot_data(3.0)],
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
    assert_eq!(state.get_project_state().unwrap().sections[0].shots.len(), 1);
    assert!(state.redo().success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots[1].id, original_shot_id);

    // Second cycle: undo -> redo
    assert!(state.undo().success);
    assert_eq!(state.get_project_state().unwrap().sections[0].shots.len(), 1);
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
    let delete_result = state.execute(Command::DeleteShot { section_id, shot_id });
    assert!(delete_result.success);
    assert!(state.get_project_state().unwrap().sections[0].shots.is_empty());
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
    state.execute(Command::DeleteShot { section_id, shot_id });

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
    assert!(result.shot_id.is_some(), "shot_id must be returned on success");
    let new_shot_id = result.shot_id.unwrap();

    // Verify insertion at position 0
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 3);
    assert_eq!(project.sections[0].shots[0].length, 5.0, "Prepended shot should be first");
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
    assert!(result.error.as_deref().unwrap().contains("Cannot specify both"));
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
    state.execute(Command::DeleteShot { section_id, shot_id });
    assert_eq!(state.get_project_state().unwrap().sections[0].shots.len(), 1);

    // Undo should restore it at its original position
    assert!(state.undo().success);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.sections[0].shots.len(), 2);
    assert_eq!(project.sections[0].shots[0].id, shot_id);
    assert_eq!(project.sections[0].shots[0].length, 5.0);

    // Redo should delete it again
    assert!(state.redo().success);
    assert_eq!(state.get_project_state().unwrap().sections[0].shots.len(), 1);

    // Undo again to restore
    assert!(state.undo().success);
    assert_eq!(state.get_project_state().unwrap().sections[0].shots.len(), 2);
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
        name: None, surveyor: None, date: None,
        color: "#ff0000".to_string(), direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None, surveyor: None, date: None,
        color: "#00ff00".to_string(), direction: None,
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

    assert!(!result.can_merge, "Both sections with zero datums should not be mergeable");
    assert!(!result.connected, "Unconnected sections should not be connected");
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
        name: None, surveyor: None, date: None,
        color: "#ff0000".to_string(), direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None, surveyor: None, date: None,
        color: "#00ff00".to_string(), direction: None,
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

    assert!(result.can_merge, "One section with zero datum should allow merge");
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
        name: None, surveyor: None, date: None,
        color: "#ff0000".to_string(), direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None, surveyor: None, date: None,
        color: "#00ff00".to_string(), direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    let result = state
        .check_merge_connectivity(StationRef::new(a, 1), StationRef::new(b, 0))
        .unwrap();

    assert!(result.can_merge, "Neither having zero datum and no loop should allow merge");
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
        name: None, surveyor: None, date: None,
        color: "#ff0000".to_string(), direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None, surveyor: None, date: None,
        color: "#00ff00".to_string(), direction: None,
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

    assert!(!result.can_merge, "Connected sections should not be mergeable (creates loop)");
    assert!(result.connected, "Merged sections should be connected");
    assert_eq!(
        result.reason.as_deref(),
        Some("Creates survey loop"),
    );
    assert!(result.preview.is_some(), "Connected sections should have closure preview");
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
        name: None, surveyor: None, date: None,
        color: "#ff0000".to_string(), direction: None,
        shots: vec![test_shot_data(10.0)],
    });
    let a = result_a.section_id.unwrap();

    let result_b = state.execute(Command::CreateSection {
        name: None, surveyor: None, date: None,
        color: "#00ff00".to_string(), direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let b = result_b.section_id.unwrap();

    let result_c = state.execute(Command::CreateSection {
        name: None, surveyor: None, date: None,
        color: "#0000ff".to_string(), direction: None,
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
        project.loop_closures.push(crate::models::LoopClosure {
            id: project.next_closure_id,
            station_a: StationRef::new(c, 1),
            station_b: StationRef::new(b, 0),
            path_length: 8.0,
            misclosure_distance: 0.2,
            error_percentage: 2.5,
            horizontal_misclosure: 0.2,
            vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        });
        project.next_closure_id += 1;
    }

    // Now: A-C merged (A has ZD), B has ZD, connected via closure C.1-B.0
    let result = state
        .check_merge_connectivity(StationRef::new(a, 0), StationRef::new(b, 1))
        .unwrap();

    // connected must be true (they ARE connected via merge+closure)
    assert!(result.connected, "Sections connected via merge+closure should report connected=true");
    assert!(result.preview.is_some(), "Connected stations should have closure preview");
    // can_merge must be false (both have ZD — zero datum takes priority)
    assert!(!result.can_merge, "Both sections with ZD should not be mergeable");
    assert_eq!(
        result.reason.as_deref(),
        Some("Both sections have fixed coordinates"),
        "Zero datum reason should take priority over loop reason"
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
        project.loop_closures.push(crate::models::LoopClosure {
            id: closure_id,
            station_a: StationRef::new(a, 2), // A.2 (merged with B.0)
            station_b: StationRef::new(c, 1), // C.1 (not merged with anything)
            path_length: 20.0,
            misclosure_distance: 0.5,
            error_percentage: 2.5,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
        strategy: ClosureStrategy::default(),
        });
        project.next_closure_id += 1;
    }

    // Get computed stations through the full pipeline
    let project = state.get_project_state().unwrap();
    let stations = project.compute_station_coordinates();

    // A.2: direct closure to C.1 (A.2 is the endpoint)
    let a2 = stations.iter().find(|s| s.station_ref == StationRef::new(a, 2)).unwrap();
    let a2_direct = a2.closures_with.iter().find(|cr|
        cr.station_ref == StationRef::new(c, 1) && !cr.is_transitive
    );
    assert!(a2_direct.is_some(), "A.2 should have direct closure to C.1, got: {:?}", a2.closures_with);

    // B.0: transitive closure to C.1 via A.2 (B.0 is merged with A.2)
    let b0 = stations.iter().find(|s| s.station_ref == StationRef::new(b, 0)).unwrap();
    let b0_transitive = b0.closures_with.iter().find(|cr|
        cr.station_ref == StationRef::new(c, 1) && cr.is_transitive
    );
    assert!(
        b0_transitive.is_some(),
        "B.0 should have transitive closure to C.1 (via A.2), got: {:?}", b0.closures_with
    );
    assert_eq!(b0_transitive.unwrap().via_station, Some(StationRef::new(a, 2)));

    // C.1: direct closure to A.2
    let c1 = stations.iter().find(|s| s.station_ref == StationRef::new(c, 1)).unwrap();
    let c1_direct = c1.closures_with.iter().find(|cr|
        cr.station_ref == StationRef::new(a, 2) && !cr.is_transitive
    );
    assert!(c1_direct.is_some(), "C.1 should have direct closure to A.2, got: {:?}", c1.closures_with);

    // C.1: transitive closure to B.0 (via A.2, since B.0 is in A.2's merge group)
    let c1_transitive = c1.closures_with.iter().find(|cr|
        cr.station_ref == StationRef::new(b, 0) && cr.is_transitive
    );
    assert!(
        c1_transitive.is_some(),
        "C.1 should have transitive closure to B.0 (via A.2), got: {:?}", c1.closures_with
    );
    assert_eq!(c1_transitive.unwrap().via_station, Some(StationRef::new(a, 2)));

    // A.0 and A.1: should NOT have any closures (not endpoints, not merged with endpoints)
    let a0 = stations.iter().find(|s| s.station_ref == StationRef::new(a, 0)).unwrap();
    assert!(a0.closures_with.is_empty(), "A.0 should have no closures, got: {:?}", a0.closures_with);
    let a1 = stations.iter().find(|s| s.station_ref == StationRef::new(a, 1)).unwrap();
    assert!(a1.closures_with.is_empty(), "A.1 should have no closures, got: {:?}", a1.closures_with);

    // B.1: NOT in A.2's merge group, IS merged with C.0 but C.0 is not a closure endpoint
    let b1 = stations.iter().find(|s| s.station_ref == StationRef::new(b, 1)).unwrap();
    assert!(b1.closures_with.is_empty(), "B.1 should have no closures, got: {:?}", b1.closures_with);

    // C.0: merged with B.1, but B.1 is not a closure endpoint. C.0 is NOT in C.1's group.
    let c0 = stations.iter().find(|s| s.station_ref == StationRef::new(c, 0)).unwrap();
    assert!(c0.closures_with.is_empty(), "C.0 should have no closures, got: {:?}", c0.closures_with);
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
        project.loop_closures.push(crate::models::LoopClosure {
            id: project.next_closure_id,
            station_a: StationRef::new(a, 1),
            station_b: StationRef::new(c, 1),
            path_length: 15.0,
            misclosure_distance: 0.3,
            error_percentage: 2.0,
            horizontal_misclosure: 0.2,
            vertical_misclosure: 0.2,
        strategy: ClosureStrategy::default(),
        });
        project.next_closure_id += 1;
    }

    // Get stations through the normal pipeline
    let project = state.get_project_state().unwrap();
    let stations = project.compute_station_coordinates();

    // Verify B.0 has transitive closure (it's merged with A.1)
    let b0 = stations.iter().find(|s| s.station_ref == StationRef::new(b, 0)).unwrap();
    assert!(!b0.closures_with.is_empty(), "B.0 should have transitive closures");

    // Now serialize to JSON and deserialize back (simulating Tauri IPC)
    let json = serde_json::to_string(&stations).unwrap();
    let deserialized: Vec<Station> = serde_json::from_str(&json).unwrap();

    // Find B.0 in deserialized
    let b0_de = deserialized.iter().find(|s| s.station_ref == StationRef::new(b, 0)).unwrap();
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
    let a1_de = deserialized.iter().find(|s| s.station_ref == StationRef::new(a, 1)).unwrap();
    assert!(
        a1_de.closures_with.iter().any(|cr| !cr.is_transitive),
        "Direct closure on A.1 should survive serialization"
    );

    // Verify C.1 has closures (direct + transitive)
    let c1_de = deserialized.iter().find(|s| s.station_ref == StationRef::new(c, 1)).unwrap();
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
    let a_before = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_before = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));

    // Move segment starting from section A
    let result = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });
    assert!(result.success);

    // Both sections should have been moved by the offset delta
    let project = state.get_project_state().unwrap();
    let a_after = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_after = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));

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
    let a_pre_move = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_pre_move = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));

    // Move segment
    state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });

    // Verify both moved by delta
    let project = state.get_project_state().unwrap();
    let a_post_move = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_post_move = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));
    assert!((a_post_move.0 - a_pre_move.0 - 10.0).abs() < 0.001);
    assert!((a_post_move.1 - a_pre_move.1 - 20.0).abs() < 0.001);
    assert!((b_post_move.0 - b_pre_move.0 - 10.0).abs() < 0.001);
    assert!((b_post_move.1 - b_pre_move.1 - 20.0).abs() < 0.001);

    // Undo should restore exact pre-move offsets
    let undo_result = state.undo();
    assert!(undo_result.success);

    let project = state.get_project_state().unwrap();
    let a_after_undo = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_after_undo = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));
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
    let a_after_redo = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_after_redo = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));
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
    assert!(!result.success, "MoveSegment should fail for nonexistent section");
}

#[test]
fn test_move_segment_closure_connectivity() {
    // Sections connected only via a loop closure (not merge) should both move
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
        project.loop_closures.push(crate::models::LoopClosure {
            id: closure_id,
            station_a: StationRef::new(sid_a, 1),
            station_b: StationRef::new(sid_b, 0),
            path_length: 10.0,
            misclosure_distance: 0.1,
            error_percentage: 1.0,
            horizontal_misclosure: 0.08,
            vertical_misclosure: 0.06,
        strategy: ClosureStrategy::default(),
        });
        project.next_closure_id += 1;
    }

    // Record offsets before move
    let project = state.get_project_state().unwrap();
    let a_before = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_before = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));

    // Move segment starting from section A
    let result = state.execute(Command::MoveSegment {
        section_id: sid_a,
        offset: Coordinates::new(5.0, 15.0, 0.0),
    });
    assert!(result.success);

    // Both sections should have moved (connected via closure, not merge)
    let project = state.get_project_state().unwrap();
    let a_after = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_after = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));

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
        "Section B x (connected via closure) should increase by 5"
    );
    assert!(
        (b_after.1 - b_before.1 - 15.0).abs() < 0.001,
        "Section B y (connected via closure) should increase by 15"
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
    let a_before = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));
    let b_before = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));

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
    let b_after = project.section_offsets.get(&sid_b).copied().unwrap_or((0.0, 0.0));

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
    let initial = project.section_offsets.get(&sid_a).copied().unwrap_or((0.0, 0.0));

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
            path: std::path::PathBuf::from("/nonexistent"),
        }],
    });
    assert!(!result.success, "Batch should reject non-whitelisted commands");
    assert!(
        result.error.unwrap_or_default().contains("not allowed in batch"),
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

    let result = state.execute_delete_shot_and_split(
        section_id, shot_id, "A".to_string(), "B".to_string(),
    );
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
            shot_data_with_azimuth(10.0, 90.0, 90.0),  // East
            shot_data_with_azimuth(5.0, 90.0, 90.0),   // East (deleted)
            shot_data_with_azimuth(8.0, 90.0, 90.0),   // East
        ],
    });
    let section_id = create_result.section_id.unwrap();

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[1].id
    };

    let result = state.execute_delete_shot_and_split(
        section_id, shot_id, "A".to_string(), "B".to_string(),
    );
    assert!(result.success);
    let new_id = result.section_id.unwrap();

    // Section B offset should be at (accumulated shots_before + deleted shot)
    // shots_before: 10m east, deleted: 5m east = 15m east
    // With azimuth 90, sin(90) = 1, cos(90) = 0
    // So bx = 15, by = 0 (approximately)
    let proj = state.get_project_state().unwrap();
    let b_offset = proj.section_offsets.get(&new_id);
    assert!(b_offset.is_some(), "Section B should have an offset");
    let (bx, by) = b_offset.unwrap();
    assert!((*bx - 15.0).abs() < 0.001, "bx should be ~15, got {}", bx);
    assert!(by.abs() < 0.001, "by should be ~0, got {}", by);
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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
        shots: vec![
            test_shot_data(5.0),
            test_shot_data(7.0),
            test_shot_data(3.0),
        ],
    });
    let section_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None, date: None, color: "#00ff00".to_string(), direction: None,
        shots: vec![test_shot_data(4.0)],
    });
    let section_b_id = create_b.section_id.unwrap();

    // Merge station 3 of section A (after split, belongs to B index 0) with station 0 of section B
    let merge_result = state.execute(Command::MergeStations {
        station_a: StationRef::new(section_a_id, 3),  // This is after split point
        station_b: StationRef::new(section_b_id, 0),
    });
    assert!(merge_result.success, "Merge should succeed: {:?}", merge_result.error);

    // Now split at shot index 1
    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_a_id).unwrap().shots[1].id
    };

    let result = state.execute_delete_shot_and_split(
        section_a_id, shot_id, "A".to_string(), "B".to_string(),
    );
    assert!(result.success);
    let new_section_id = result.section_id.unwrap();

    // The merge with station_index 3 should now be remapped to new_section_id, station_index 1
    // (original index 3, split_station = 2, so new index = 3 - 2 = 1)
    let proj = state.get_project_state().unwrap();
    let has_remapped_merge = proj.station_merges.iter().any(|m| {
        (m.station_a.section_id == new_section_id && m.station_a.station_index == 1
            && m.station_b.section_id == section_b_id)
        || (m.station_b.section_id == new_section_id && m.station_b.station_index == 1
            && m.station_a.section_id == section_b_id)
    });
    assert!(has_remapped_merge, "Merge should be remapped to new section with adjusted index");
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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
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
        surveyor: None, date: None, color: "#00ff00".to_string(), direction: None,
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
        closure_strategy: crate::models::ClosureStrategy::ProportionalByLength,
    });
    assert!(closure_result.success, "Closure should succeed: {:?}", closure_result.error);

    // Split at shot index 2
    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(sec_a_id).unwrap().shots[2].id
    };

    let result = state.execute_delete_shot_and_split(
        sec_a_id, shot_id, "A".to_string(), "B-split".to_string(),
    );
    assert!(result.success);
    let new_section_id = result.section_id.unwrap();

    // Closure should be remapped: station_a was (sec_a_id, 4) -> (new_section_id, 1)
    // (split_station = 3, so 4 - 3 = 1)
    let proj = state.get_project_state().unwrap();
    let has_remapped_closure = proj.loop_closures.iter().any(|lc| {
        (lc.station_a.section_id == new_section_id && lc.station_a.station_index == 1)
        || (lc.station_b.section_id == new_section_id && lc.station_b.station_index == 1)
    });
    assert!(has_remapped_closure, "Closure should be remapped to new section with adjusted index");
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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
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
        proj.station_offsets.insert(StationRef::new(section_id, 3), (1.0, 2.0, 3.0));
        state.set_project_for_tests(proj);
    }

    // Split at shot index 1
    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[1].id
    };

    let result = state.execute_delete_shot_and_split(
        section_id, shot_id, "A".to_string(), "B".to_string(),
    );
    assert!(result.success);
    let new_section_id = result.section_id.unwrap();

    // Station offset should be remapped from (section_id, 3) to (new_section_id, 1)
    // split_station = 2, so 3 - 2 = 1
    let proj = state.get_project_state().unwrap();
    let new_ref = StationRef::new(new_section_id, 1);
    let offset = proj.station_offsets.get(&new_ref);
    assert!(offset.is_some(), "Station offset should be remapped to new section");
    let (ox, oy, oz) = offset.unwrap();
    assert!((ox - 1.0).abs() < 0.001);
    assert!((oy - 2.0).abs() < 0.001);
    assert!((oz - 3.0).abs() < 0.001);

    // Old ref should not exist
    let old_ref = StationRef::new(section_id, 3);
    assert!(proj.station_offsets.get(&old_ref).is_none(), "Old station offset should be removed");
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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
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

    let result = state.execute_delete_shot_and_split(
        section_id, shot_id, "A".to_string(), "B".to_string(),
    );
    assert!(result.success);

    // Verify split happened
    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.sections.len(), initial_section_count + 1);

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo should succeed: {:?}", undo_result.error);

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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
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

    let result = state.execute_delete_shot_and_split(
        section_id, shot_id, "A".to_string(), "B".to_string(),
    );
    assert!(result.success);
    let new_section_id = result.section_id.unwrap();

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success);

    // Redo
    let redo_result = state.redo();
    assert!(redo_result.success, "Redo should succeed: {:?}", redo_result.error);

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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
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
        section_id, first_shot_id, "A".to_string(), "B".to_string(),
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
        section_id, last_shot_id, "A".to_string(), "B".to_string(),
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
    assert!(result.success, "Delete last shot should succeed: {:?}", result.error);

    // Verify section is gone
    let proj = state.get_project_state().unwrap();
    assert!(proj.get_section(section_id).is_none(), "Section should be removed");
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
    assert!(undo_result.success, "Undo should succeed: {:?}", undo_result.error);

    // Verify restored
    let proj = state.get_project_state().unwrap();
    let section = proj.get_section(section_id).expect("Section should be restored");
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
    assert!(!proj.section_offsets.contains_key(&section_id), "Section offset should be removed");
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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None, date: None, color: "#00ff00".to_string(), direction: None,
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
        assert!(!proj.station_merges.is_empty(), "Should have merge before delete");
    }

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_a_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_a_id, shot_id);
    assert!(result.success);

    // Verify merge is cleaned up
    let proj = state.get_project_state().unwrap();
    let remaining_merges: Vec<_> = proj.station_merges.iter()
        .filter(|m| m.station_a.section_id == section_a_id || m.station_b.section_id == section_a_id)
        .collect();
    assert!(remaining_merges.is_empty(), "Merges referencing deleted section should be removed");
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
        project.station_offsets.insert(station_ref, (1.0, 2.0, 3.0));
    }

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_id, shot_id);
    assert!(result.success);

    // Verify station offsets for this section are cleaned up
    let proj = state.get_project_state().unwrap();
    let remaining_station_offsets: Vec<_> = proj.station_offsets.keys()
        .filter(|sr| sr.section_id == section_id)
        .collect();
    assert!(remaining_station_offsets.is_empty(), "Station offsets referencing deleted section should be removed");
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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None, date: None, color: "#00ff00".to_string(), direction: None,
        shots: vec![test_shot_data(4.0), test_shot_data(3.0)],
    });
    let section_b_id = create_b.section_id.unwrap();

    // Manually insert a loop closure referencing section A
    {
        let mut proj_guard = state.project.lock().unwrap();
        let project = proj_guard.as_mut().unwrap();
        project.loop_closures.push(crate::models::LoopClosure {
            id: project.next_closure_id,
            station_a: StationRef::new(section_a_id, 0),
            station_b: StationRef::new(section_b_id, 1),
            path_length: 10.0,
            misclosure_distance: 0.5,
            error_percentage: 5.0,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
        strategy: ClosureStrategy::default(),
        });
        project.next_closure_id += 1;
    }

    // Verify closure exists
    {
        let proj = state.get_project_state().unwrap();
        assert_eq!(proj.loop_closures.len(), 1, "Should have 1 closure before delete");
    }

    let shot_id = {
        let proj = state.get_project_state().unwrap();
        proj.get_section(section_a_id).unwrap().shots[0].id
    };

    let result = state.execute_delete_last_shot_and_section(section_a_id, shot_id);
    assert!(result.success);

    // Verify closure is cleaned up
    let proj = state.get_project_state().unwrap();
    let remaining_closures: Vec<_> = proj.loop_closures.iter()
        .filter(|lc| lc.station_a.section_id == section_a_id || lc.station_b.section_id == section_a_id)
        .collect();
    assert!(remaining_closures.is_empty(), "Closures referencing deleted section should be removed");
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
        surveyor: None, date: None, color: "#ff0000".to_string(), direction: None,
        shots: vec![test_shot_data(5.0)],
    });
    let section_a_id = create_a.section_id.unwrap();

    let create_b = state.execute(Command::CreateSection {
        name: Some("Other".to_string()),
        surveyor: None, date: None, color: "#00ff00".to_string(), direction: None,
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
        project.station_offsets.insert(StationRef::new(section_a_id, 0), (1.0, 2.0, 3.0));
        // Add a closure referencing section A
        project.loop_closures.push(crate::models::LoopClosure {
            id: project.next_closure_id,
            station_a: StationRef::new(section_a_id, 0),
            station_b: StationRef::new(section_b_id, 1),
            path_length: 10.0,
            misclosure_distance: 0.5,
            error_percentage: 5.0,
            horizontal_misclosure: 0.4,
            vertical_misclosure: 0.3,
        strategy: ClosureStrategy::default(),
        });
        project.next_closure_id += 1;
    }

    // Capture counts before deletion
    let (merges_before, closures_before, station_offsets_a_before) = {
        let proj = state.get_project_state().unwrap();
        let merges = proj.station_merges.len();
        let closures = proj.loop_closures.len();
        let so = proj.station_offsets.keys().filter(|sr| sr.section_id == section_a_id).count();
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
        let a_merges: Vec<_> = proj.station_merges.iter()
            .filter(|m| m.station_a.section_id == section_a_id || m.station_b.section_id == section_a_id)
            .collect();
        assert!(a_merges.is_empty());
        let a_closures: Vec<_> = proj.loop_closures.iter()
            .filter(|lc| lc.station_a.section_id == section_a_id || lc.station_b.section_id == section_a_id)
            .collect();
        assert!(a_closures.is_empty());
    }

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo should succeed: {:?}", undo_result.error);

    // Verify all references restored
    let proj = state.get_project_state().unwrap();
    assert!(proj.get_section(section_a_id).is_some(), "Section should be restored");
    assert_eq!(proj.station_merges.len(), merges_before, "Merges should be restored");
    assert_eq!(proj.loop_closures.len(), closures_before, "Closures should be restored");
    let so_after = proj.station_offsets.keys().filter(|sr| sr.section_id == section_a_id).count();
    assert_eq!(so_after, station_offsets_a_before, "Station offsets should be restored");
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
        coordinates: crate::models::GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
    });
    assert!(datum_result.success, "SetZeroDatum should succeed");

    // Directly insert a station offset for sec_a:0 (MoveStation now modifies shot data directly)
    {
        let mut proj = state.get_project_state().unwrap();
        proj.station_offsets.insert(StationRef::new(sec_a, 0), (1.0, 2.0, 0.0));
        state.set_project_for_tests(proj);
    }

    // Capture state before deletion
    let proj_before = state.get_project_state().unwrap();
    let merges_before = proj_before.station_merges.len();
    let zero_datums_before = proj_before.zero_datums.len();
    let station_offsets_a_before = proj_before.station_offsets.keys()
        .filter(|sr| sr.section_id == sec_a).count();
    assert!(merges_before >= 1, "Should have at least 1 merge");
    assert!(zero_datums_before >= 1, "Should have at least 1 zero datum");
    assert!(station_offsets_a_before >= 1, "Should have at least 1 station offset for sec_a");

    // Delete section A (triggers cleanup of merges, offsets, zero datums)
    let del_result = state.execute(Command::DeleteSection { section_id: sec_a });
    assert!(del_result.success, "Delete should succeed");

    // Verify cleanup happened: merges, zero datums, station offsets
    let proj_after = state.get_project_state().unwrap();
    assert!(proj_after.get_section(sec_a).is_none(), "Section A should be gone");
    assert_eq!(
        proj_after.station_merges.iter().filter(|m|
            m.station_a.section_id == sec_a || m.station_b.section_id == sec_a
        ).count(),
        0,
        "No merges should reference deleted section A"
    );
    assert_eq!(
        proj_after.zero_datums.iter().filter(|zd| zd.station_ref.section_id == sec_a).count(),
        0,
        "No zero datums should reference deleted section A"
    );
    assert_eq!(
        proj_after.station_offsets.keys().filter(|sr| sr.section_id == sec_a).count(),
        0,
        "No station offsets should reference deleted section A"
    );

    // Undo should restore everything
    let undo_result = state.undo();
    assert!(undo_result.success, "Undo should succeed");

    let proj_restored = state.get_project_state().unwrap();
    assert!(proj_restored.get_section(sec_a).is_some(), "Section A should be restored");
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
        proj_restored.station_offsets.keys().filter(|sr| sr.section_id == sec_a).count(),
        station_offsets_a_before,
        "Station offsets should be fully restored"
    );

    // Redo should re-delete and re-cleanup
    let redo_result = state.redo();
    assert!(redo_result.success, "Redo should succeed");

    let proj_redone = state.get_project_state().unwrap();
    assert!(proj_redone.get_section(sec_a).is_none(), "Section A should be gone after redo");
    assert_eq!(
        proj_redone.station_merges.iter().filter(|m|
            m.station_a.section_id == sec_a || m.station_b.section_id == sec_a
        ).count(),
        0,
        "No merges should reference deleted section after redo"
    );
    assert_eq!(
        proj_redone.zero_datums.iter().filter(|zd| zd.station_ref.section_id == sec_a).count(),
        0,
        "No zero datums should reference deleted section after redo"
    );
    assert_eq!(
        proj_redone.station_offsets.keys().filter(|sr| sr.section_id == sec_a).count(),
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
    assert_eq!(proj.station_merges[0].station_a, StationRef::new(sec_a, 0));
    assert_eq!(proj.station_merges[0].station_b, StationRef::new(sec_b, 0));

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
    assert_eq!(
        proj.station_merges[0].station_a,
        StationRef::new(sec_a, 1),
        "Merge station_a should shift from 0 to 1 after insert_before"
    );
    assert_eq!(
        proj.station_merges[0].station_b,
        StationRef::new(sec_b, 0),
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
    assert_eq!(proj.zero_datums[0].station_ref, StationRef::new(sec_id, 0));

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
    assert_eq!(
        proj.zero_datums[0].station_ref,
        StationRef::new(sec_id, 1),
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
        project.station_offsets.insert(
            StationRef::new(sec_id, 0),
            (1.0, 2.0, 3.0),
        );
    }

    let proj = state.get_project_state().unwrap();
    assert!(proj.station_offsets.contains_key(&StationRef::new(sec_id, 0)));

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
        !proj.station_offsets.contains_key(&StationRef::new(sec_id, 0)),
        "Station offset at old index 0 should be gone"
    );
    assert_eq!(
        proj.station_offsets.get(&StationRef::new(sec_id, 1)),
        Some(&(1.0, 2.0, 3.0)),
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
        closure_strategy: ClosureStrategy::ProportionalByLength,
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
    let a_merges: Vec<_> = proj.station_merges.iter()
        .filter(|m| m.station_a.section_id == sec_a || m.station_b.section_id == sec_a)
        .collect();
    assert_eq!(a_merges.len(), 2);

    // Check the merge that was at station 0 of A
    let merge_a0 = proj.station_merges.iter().find(|m|
        m.station_b == StationRef::new(sec_b, 0)
    ).unwrap();
    assert_eq!(
        merge_a0.station_a,
        StationRef::new(sec_a, 1),
        "Merge at original station 0 should shift to station 1"
    );

    // Check the merge that was at station 2 of A (now station 3)
    let merge_a2 = proj.station_merges.iter().find(|m|
        m.station_b == StationRef::new(sec_c, 0) || m.station_a == StationRef::new(sec_c, 0)
    ).unwrap();
    let a_ref = if merge_a2.station_a.section_id == sec_a {
        merge_a2.station_a
    } else {
        merge_a2.station_b
    };
    assert_eq!(
        a_ref,
        StationRef::new(sec_a, 3),
        "Merge at original station 2 should shift to station 3"
    );

    // Loop closure refs should NOT have changed (they reference sec_b and sec_c, not sec_a)
    assert_eq!(proj.loop_closures[0].station_a, StationRef::new(sec_b, 2));
    assert_eq!(proj.loop_closures[0].station_b, StationRef::new(sec_c, 1));
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
    assert_eq!(proj.station_merges[0].station_a, StationRef::new(sec_a, 1));

    // Undo the insert
    let undo_result = state.undo();
    assert!(undo_result.success);

    // Verify merge returned to original position
    let proj = state.get_project_state().unwrap();
    assert_eq!(
        proj.station_merges[0].station_a,
        StationRef::new(sec_a, 0),
        "Merge should return to station 0 after undo"
    );
    assert_eq!(
        proj.station_merges[0].station_b,
        StationRef::new(sec_b, 0),
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
    assert_eq!(
        proj.station_merges[0].station_a,
        StationRef::new(sec_a, 1),
        "Merge should shift to station 1 after redo"
    );
    assert_eq!(
        proj.station_merges[0].station_b,
        StationRef::new(sec_b, 0),
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
        project.station_offsets.insert(
            StationRef::new(sec_a, 1),
            (5.0, 6.0, 7.0),
        );
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
    assert_eq!(
        proj.station_merges[0].station_a,
        StationRef::new(sec_a, 0),
        "Merge at station 0 should not shift for insert_after shot 0"
    );

    // Station offset at station 1 should NOT shift (1 < 2)
    assert!(
        proj.station_offsets.contains_key(&StationRef::new(sec_a, 1)),
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
    let sec_a_shots: Vec<_> = proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots.iter().collect();
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
    assert_eq!(
        proj.zero_datums[0].station_ref,
        StationRef::new(sec_a, 1),
        "Zero datum should shift from station 2 to station 1 after delete shot 0"
    );

    // Undo the delete — should restore via ProjectSnapshotPair
    let undo_result = state.undo();
    assert!(undo_result.success);

    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots.len(), 2);
    assert_eq!(
        proj.station_merges[0].station_a,
        StationRef::new(sec_a, 0),
        "Merge should be at station 0 after undo"
    );
    assert_eq!(
        proj.zero_datums[0].station_ref,
        StationRef::new(sec_a, 2),
        "Zero datum should be at station 2 after undo"
    );

    // Redo the delete
    let redo_result = state.redo();
    assert!(redo_result.success);

    let proj = state.get_project_state().unwrap();
    assert_eq!(proj.sections.iter().find(|s| s.id == sec_a).unwrap().shots.len(), 1);
    assert_eq!(
        proj.zero_datums[0].station_ref,
        StationRef::new(sec_a, 1),
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
        shots: vec![directional_shot_data(0.0, 10.0), directional_shot_data(0.0, 5.0)],
    });
    let sec_a = result.section_id.unwrap();

    // Capture initial coordinates
    let orig_coords: Vec<_> = {
        let proj = state.get_project_state().unwrap();
        let stations = proj.compute_station_coordinates();
        stations
            .iter()
            .filter(|s| s.station_ref.section_id == sec_a)
            .map(|s| (s.station_ref.station_index, s.coordinates.x, s.coordinates.y))
            .collect()
    };
    // station 0: (0, 0), station 1: (0, 10), station 2: (0, 15)
    assert!((orig_coords[0].1).abs() < 1e-6); // x=0
    assert!((orig_coords[0].2).abs() < 1e-6); // y=0
    assert!((orig_coords[1].2 - 10.0).abs() < 1e-6); // y=10
    assert!((orig_coords[2].2 - 15.0).abs() < 1e-6); // y=15

    // Insert shot heading east (azimuth 90, length 3) before first shot
    let proj = state.get_project_state().unwrap();
    let first_shot_id = proj
        .sections
        .iter()
        .find(|s| s.id == sec_a)
        .unwrap()
        .shots[0]
        .id;
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

    let s0 = stations.iter().find(|s| s.station_ref == StationRef::new(sec_a, 0)).unwrap();
    let s1 = stations.iter().find(|s| s.station_ref == StationRef::new(sec_a, 1)).unwrap();
    let s2 = stations.iter().find(|s| s.station_ref == StationRef::new(sec_a, 2)).unwrap();
    let s3 = stations.iter().find(|s| s.station_ref == StationRef::new(sec_a, 3)).unwrap();

    // Station 0 (new) at section_offset = (-3, 0)
    assert!((s0.coordinates.x - (-3.0)).abs() < 1e-6, "New station 0 x={}", s0.coordinates.x);
    assert!((s0.coordinates.y).abs() < 1e-6, "New station 0 y={}", s0.coordinates.y);

    // Station 1 (was station 0): (0, 0) — same as original station 0
    assert!((s1.coordinates.x).abs() < 1e-6, "Station 1 (was 0) x={}", s1.coordinates.x);
    assert!((s1.coordinates.y).abs() < 1e-6, "Station 1 (was 0) y={}", s1.coordinates.y);

    // Station 2 (was station 1): (0, 10) — same as original station 1
    assert!((s2.coordinates.x).abs() < 1e-6, "Station 2 (was 1) x={}", s2.coordinates.x);
    assert!((s2.coordinates.y - 10.0).abs() < 1e-6, "Station 2 (was 1) y={}", s2.coordinates.y);

    // Station 3 (was station 2): (0, 15) — same as original station 2
    assert!((s3.coordinates.x).abs() < 1e-6, "Station 3 (was 2) x={}", s3.coordinates.x);
    assert!((s3.coordinates.y - 15.0).abs() < 1e-6, "Station 3 (was 2) y={}", s3.coordinates.y);
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
        shots: vec![directional_shot_data(0.0, 10.0), directional_shot_data(0.0, 5.0)],
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
        let b0 = stations.iter().find(|s| s.station_ref == StationRef::new(sec_b, 0)).unwrap().coordinates;
        let b1 = stations.iter().find(|s| s.station_ref == StationRef::new(sec_b, 1)).unwrap().coordinates;
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
    let b0_after = stations.iter().find(|s| s.station_ref == StationRef::new(sec_b, 0)).unwrap().coordinates;
    let b1_after = stations.iter().find(|s| s.station_ref == StationRef::new(sec_b, 1)).unwrap().coordinates;

    assert!((b0_after.x - b0_before.x).abs() < 1e-6, "B station 0 x moved: {} -> {}", b0_before.x, b0_after.x);
    assert!((b0_after.y - b0_before.y).abs() < 1e-6, "B station 0 y moved: {} -> {}", b0_before.y, b0_after.y);
    assert!((b1_after.x - b1_before.x).abs() < 1e-6, "B station 1 x moved: {} -> {}", b1_before.x, b1_after.x);
    assert!((b1_after.y - b1_before.y).abs() < 1e-6, "B station 1 y moved: {} -> {}", b1_before.y, b1_after.y);
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
        let offset = proj.section_offsets.get(&sec_a).copied().unwrap_or((0.0, 0.0));
        assert!((offset.0 - (-5.0)).abs() < 1e-6, "Section offset x should be -5, got {}", offset.0);
    }

    // Undo
    let undo_result = state.undo();
    assert!(undo_result.success);

    // Coordinates should be exactly as before (section has 2 stations again)
    let proj = state.get_project_state().unwrap();
    let stations = proj.compute_station_coordinates();
    for (ref_orig, coord_orig) in &orig_coords {
        let station = stations.iter().find(|s| s.station_ref == *ref_orig).unwrap();
        assert!(
            (station.coordinates.x - coord_orig.x).abs() < 1e-6,
            "Station {:?} x should match after undo: {} vs {}",
            ref_orig, station.coordinates.x, coord_orig.x
        );
        assert!(
            (station.coordinates.y - coord_orig.y).abs() < 1e-6,
            "Station {:?} y should match after undo: {} vs {}",
            ref_orig, station.coordinates.y, coord_orig.y
        );
    }

    // Redo
    let redo_result = state.redo();
    assert!(redo_result.success);

    // Old stations should be at the same position again (not moved)
    let proj = state.get_project_state().unwrap();
    let stations = proj.compute_station_coordinates();
    // Old station 0 is now station 1
    let s1 = stations.iter().find(|s| s.station_ref == StationRef::new(sec_a, 1)).unwrap();
    assert!(
        (s1.coordinates.x - orig_coords[0].1.x).abs() < 1e-6,
        "Station 1 (was 0) x after redo: {} vs {}",
        s1.coordinates.x, orig_coords[0].1.x
    );
    assert!(
        (s1.coordinates.y - orig_coords[0].1.y).abs() < 1e-6,
        "Station 1 (was 0) y after redo: {} vs {}",
        s1.coordinates.y, orig_coords[0].1.y
    );
    // Old station 1 is now station 2
    let s2 = stations.iter().find(|s| s.station_ref == StationRef::new(sec_a, 2)).unwrap();
    assert!(
        (s2.coordinates.x - orig_coords[1].1.x).abs() < 1e-6,
        "Station 2 (was 1) x after redo: {} vs {}",
        s2.coordinates.x, orig_coords[1].1.x
    );
    assert!(
        (s2.coordinates.y - orig_coords[1].1.y).abs() < 1e-6,
        "Station 2 (was 1) y after redo: {} vs {}",
        s2.coordinates.y, orig_coords[1].1.y
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
        shots: vec![directional_shot_data(0.0, 10.0), directional_shot_data(0.0, 5.0)],
    });
    let sec_a = result.section_id.unwrap();

    // Get the section offset before insert
    let offset_before = {
        let proj = state.get_project_state().unwrap();
        proj.section_offsets.get(&sec_a).copied().unwrap_or((0.0, 0.0))
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
    let offset_after = proj.section_offsets.get(&sec_a).copied().unwrap_or((0.0, 0.0));
    assert!(
        (offset_after.0 - offset_before.0).abs() < 1e-6,
        "Section offset x should not change for pos>0"
    );
    assert!(
        (offset_after.1 - offset_before.1).abs() < 1e-6,
        "Section offset y should not change for pos>0"
    );
}
