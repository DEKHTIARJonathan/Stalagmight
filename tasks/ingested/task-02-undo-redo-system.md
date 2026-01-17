# Task 02: Undo/Redo System Tests

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-02 |
| **Category** | Rust Unit Tests |
| **Target File** | `src-tauri/src/core/undo.rs`, `src-tauri/src/core/state.rs` |
| **Tests** | 8 |
| **Priority** | P1 - High |
| **Dependencies** | task-01 (AppState commands) |

## Affected Files
- `src-tauri/src/core/undo.rs` - Add test module
- `src-tauri/src/core/state.rs` - Test undo/redo integration

## Test Specifications

---

### Test 2.1: `test_undo_create_section`

**Purpose:** Verify undo removes created section and populates redo stack.

**Test Code:**
```rust
#[test]
fn test_undo_create_section() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create section
    state.execute(Command::CreateSection {
        name: Some("Test Section".to_string()),
        shots: vec![ShotData::default(), ShotData::default()],
        placement: Placement::Manual { x: 0.0, y: 0.0 },
        ..Default::default()
    }).unwrap();

    assert_eq!(state.get_project().unwrap().sections.len(), 1);
    assert!(state.can_undo());
    assert!(!state.can_redo());

    // Undo
    let result = state.undo().unwrap();
    assert!(result.success);

    // Verify section removed
    assert_eq!(state.get_project().unwrap().sections.len(), 0);

    // Verify stack states
    assert!(!state.can_undo()); // Undo stack empty
    assert!(state.can_redo()); // Redo stack has entry
}
```

**Assertions:**
- [ ] Section exists before undo
- [ ] can_undo() returns true before undo
- [ ] Section removed after undo
- [ ] can_undo() returns false after undo
- [ ] can_redo() returns true after undo

---

### Test 2.2: `test_redo_after_undo`

**Purpose:** Verify redo restores undone operation.

**Test Code:**
```rust
#[test]
fn test_redo_after_undo() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create section
    state.execute(Command::CreateSection {
        name: Some("Restored Section".to_string()),
        shots: vec![ShotData { length: 5.0, ..Default::default() }],
        placement: Placement::Manual { x: 10.0, y: 20.0 },
        ..Default::default()
    }).unwrap();

    let original_section = state.get_section(0).unwrap().clone();

    // Undo
    state.undo().unwrap();
    assert_eq!(state.get_project().unwrap().sections.len(), 0);

    // Redo
    let result = state.redo().unwrap();
    assert!(result.success);

    // Verify section restored with same data
    let restored_section = state.get_section(0).unwrap();
    assert_eq!(restored_section.name, original_section.name);
    assert_eq!(restored_section.shots.len(), original_section.shots.len());
    assert_eq!(restored_section.shots[0].length, original_section.shots[0].length);

    // Verify stack states
    assert!(state.can_undo()); // Undo stack has entry
    assert!(!state.can_redo()); // Redo stack empty
}
```

---

### Test 2.3: `test_undo_clears_redo_on_new_command`

**Purpose:** Verify new command clears redo stack.

**Test Code:**
```rust
#[test]
fn test_undo_clears_redo_on_new_command() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create section A
    state.execute(Command::CreateSection {
        name: Some("Section A".to_string()),
        shots: vec![ShotData::default()],
        ..Default::default()
    }).unwrap();

    // Undo - A is now in redo stack
    state.undo().unwrap();
    assert!(state.can_redo());

    // Create section B - should clear redo stack
    state.execute(Command::CreateSection {
        name: Some("Section B".to_string()),
        shots: vec![ShotData::default()],
        ..Default::default()
    }).unwrap();

    // Redo stack should be empty - cannot redo A
    assert!(!state.can_redo());

    // Only B exists
    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].name, Some("Section B".to_string()));

    // Can undo B
    assert!(state.can_undo());
}
```

---

### Test 2.4: `test_undo_merge_stations`

**Purpose:** Verify undo restores pre-merge state including section offsets.

**Test Code:**
```rust
#[test]
fn test_undo_merge_stations() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create two sections
    create_test_section(&mut state, "A", 3, 0.0, 0.0);
    create_test_section(&mut state, "B", 3, 100.0, 100.0);

    // Record original section B position
    let original_b0 = state.get_station(StationRef { section_id: 1, station_index: 0 }).unwrap().clone();

    // Merge stations
    state.execute(Command::MergeStations {
        station_a: StationRef { section_id: 0, station_index: 3 },
        station_b: StationRef { section_id: 1, station_index: 0 },
        closure_strategy: ClosureStrategy::KeepRaw,
    }).unwrap();

    // Verify merge exists
    assert_eq!(state.get_project().unwrap().station_merges.len(), 1);

    // Undo
    state.undo().unwrap();

    // Verify merge removed
    assert_eq!(state.get_project().unwrap().station_merges.len(), 0);

    // Verify section B returned to original position
    let restored_b0 = state.get_station(StationRef { section_id: 1, station_index: 0 }).unwrap();
    assert!((restored_b0.x - original_b0.x).abs() < 0.001);
    assert!((restored_b0.y - original_b0.y).abs() < 0.001);
}
```

---

### Test 2.5: `test_undo_delete_shot`

**Purpose:** Verify undo restores deleted shot at correct position.

**Test Code:**
```rust
#[test]
fn test_undo_delete_shot() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Test", 5, 0.0, 0.0);

    // Record original shot data
    let original_shot = state.get_section(0).unwrap().shots[2].clone();
    let original_section_count = state.get_project().unwrap().sections.len();

    // Delete middle shot (causes split)
    state.execute(Command::DeleteShot {
        section_id: 0,
        shot_id: 2,
    }).unwrap();

    // Verify split happened
    assert_eq!(state.get_project().unwrap().sections.len(), 2);

    // Undo
    state.undo().unwrap();

    // Verify section restored (not split)
    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), original_section_count);
    assert_eq!(project.sections[0].shots.len(), 5);

    // Verify shot restored at correct position with correct data
    let restored_shot = &project.sections[0].shots[2];
    assert_eq!(restored_shot.length, original_shot.length);
    assert_eq!(restored_shot.azimuth_in, original_shot.azimuth_in);
}
```

---

### Test 2.6: `test_undo_stack_limit`

**Purpose:** Verify undo stack respects maximum size limit.

**Test Code:**
```rust
#[test]
fn test_undo_stack_limit() {
    let mut state = AppState::new_in_memory_with_config(Config {
        max_undo_stack_size: 10,
        ..Default::default()
    }).unwrap();

    // Execute 15 commands
    for i in 0..15 {
        state.execute(Command::CreateSection {
            name: Some(format!("Section {}", i)),
            shots: vec![ShotData::default()],
            ..Default::default()
        }).unwrap();
    }

    // Should have 15 sections
    assert_eq!(state.get_project().unwrap().sections.len(), 15);

    // Undo all possible - should only be able to undo 10
    let mut undo_count = 0;
    while state.can_undo() {
        state.undo().unwrap();
        undo_count += 1;
    }

    assert_eq!(undo_count, 10, "Should only be able to undo 10 commands");

    // 5 sections remain (first 5 commands cannot be undone)
    assert_eq!(state.get_project().unwrap().sections.len(), 5);

    // Oldest sections should remain
    let names: Vec<_> = state.get_project().unwrap().sections.iter()
        .filter_map(|s| s.name.clone())
        .collect();
    assert!(names.contains(&"Section 0".to_string()));
    assert!(names.contains(&"Section 4".to_string()));
    assert!(!names.contains(&"Section 5".to_string())); // This was undone
}
```

---

### Test 2.7: `test_undo_batch_command`

**Purpose:** Verify batch command undoes all commands atomically.

**Test Code:**
```rust
#[test]
fn test_undo_batch_command() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create initial section
    state.execute(Command::CreateSection {
        name: Some("Initial".to_string()),
        shots: vec![ShotData::default(), ShotData::default(), ShotData::default()],
        ..Default::default()
    }).unwrap();

    // Execute batch of 3 commands
    state.execute(Command::Batch {
        commands: vec![
            Command::UpdateSectionMetadata {
                section_id: 0,
                name: Some("Updated Name".to_string()),
                ..Default::default()
            },
            Command::UpdateShot {
                section_id: 0,
                shot_id: 0,
                updates: ShotUpdates { length: Some(99.0), ..Default::default() },
            },
            Command::UpdateShot {
                section_id: 0,
                shot_id: 1,
                updates: ShotUpdates { length: Some(88.0), ..Default::default() },
            },
        ],
    }).unwrap();

    // Verify changes applied
    let section = state.get_section(0).unwrap();
    assert_eq!(section.name, Some("Updated Name".to_string()));
    assert_eq!(section.shots[0].length, 99.0);
    assert_eq!(section.shots[1].length, 88.0);

    // Single undo should revert ALL batch commands
    state.undo().unwrap();

    let section = state.get_section(0).unwrap();
    assert_eq!(section.name, Some("Initial".to_string()));
    assert_ne!(section.shots[0].length, 99.0);
    assert_ne!(section.shots[1].length, 88.0);

    // Single redo should restore ALL batch commands
    state.redo().unwrap();

    let section = state.get_section(0).unwrap();
    assert_eq!(section.name, Some("Updated Name".to_string()));
    assert_eq!(section.shots[0].length, 99.0);
    assert_eq!(section.shots[1].length, 88.0);
}
```

---

### Test 2.8: `test_redo_stack_preserved_across_multiple_undos`

**Purpose:** Verify multiple undos build up redo stack correctly.

**Test Code:**
```rust
#[test]
fn test_redo_stack_preserved_across_multiple_undos() {
    let mut state = AppState::new_in_memory().unwrap();

    // Execute commands A, B, C
    state.execute(Command::CreateSection {
        name: Some("A".to_string()),
        shots: vec![ShotData::default()],
        ..Default::default()
    }).unwrap();

    state.execute(Command::CreateSection {
        name: Some("B".to_string()),
        shots: vec![ShotData::default()],
        ..Default::default()
    }).unwrap();

    state.execute(Command::CreateSection {
        name: Some("C".to_string()),
        shots: vec![ShotData::default()],
        ..Default::default()
    }).unwrap();

    assert_eq!(state.get_project().unwrap().sections.len(), 3);

    // Undo C
    state.undo().unwrap();
    assert_eq!(state.get_project().unwrap().sections.len(), 2);

    // Undo B
    state.undo().unwrap();
    assert_eq!(state.get_project().unwrap().sections.len(), 1);

    // Verify redo stack has B and C (in order)
    assert!(state.can_redo());

    // Redo B first
    state.redo().unwrap();
    let sections = &state.get_project().unwrap().sections;
    assert_eq!(sections.len(), 2);
    assert!(sections.iter().any(|s| s.name == Some("B".to_string())));

    // Redo C
    state.redo().unwrap();
    let sections = &state.get_project().unwrap().sections;
    assert_eq!(sections.len(), 3);
    assert!(sections.iter().any(|s| s.name == Some("C".to_string())));

    // No more to redo
    assert!(!state.can_redo());
}
```

---

## Edge Cases

```rust
#[test]
fn test_undo_when_empty_returns_error() {
    let mut state = AppState::new_in_memory().unwrap();
    assert!(!state.can_undo());
    let result = state.undo();
    assert!(result.is_err());
}

#[test]
fn test_redo_when_empty_returns_error() {
    let mut state = AppState::new_in_memory().unwrap();
    assert!(!state.can_redo());
    let result = state.redo();
    assert!(result.is_err());
}

#[test]
fn test_undo_redo_state_query() {
    let mut state = AppState::new_in_memory().unwrap();

    // Initial state
    let undo_state = state.get_undo_state();
    assert!(!undo_state.can_undo);
    assert!(!undo_state.can_redo);
    assert_eq!(undo_state.undo_count, 0);
    assert_eq!(undo_state.redo_count, 0);

    // After command
    state.execute(Command::CreateSection {
        name: Some("Test".to_string()),
        shots: vec![],
        ..Default::default()
    }).unwrap();

    let undo_state = state.get_undo_state();
    assert!(undo_state.can_undo);
    assert!(!undo_state.can_redo);
    assert_eq!(undo_state.undo_count, 1);

    // After undo
    state.undo().unwrap();
    let undo_state = state.get_undo_state();
    assert!(!undo_state.can_undo);
    assert!(undo_state.can_redo);
    assert_eq!(undo_state.redo_count, 1);
}
```

---

## Verification

```bash
cd src-tauri && cargo test undo::tests -- --nocapture
cd src-tauri && cargo test state::tests::test_undo -- --nocapture
```

## Definition of Done
- [ ] All 8 tests implemented
- [ ] Edge case tests implemented
- [ ] Tests pass locally
- [ ] Undo/redo works for all Command variants
- [ ] Stack limits respected
- [ ] Batch commands handled atomically
