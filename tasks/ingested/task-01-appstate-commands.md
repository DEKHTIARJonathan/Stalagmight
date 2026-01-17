# Task 01: AppState Command Execution Tests

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-01 |
| **Category** | Rust Unit Tests |
| **Target File** | `src-tauri/src/core/state.rs` |
| **Tests** | 8 |
| **Priority** | P0 - Critical |
| **Dependencies** | None |

## Affected Files
- `src-tauri/src/core/state.rs` - Add test module
- `src-tauri/src/core/mod.rs` - May need test helper exports

## Test Specifications

---

### Test 1.1: `test_execute_create_section_command`

**Purpose:** Verify CreateSection command creates section with correct shots and computed station coordinates.

**Setup:**
```rust
let mut state = AppState::new_in_memory().unwrap();
```

**Test Code:**
```rust
#[test]
fn test_execute_create_section_command() {
    let mut state = AppState::new_in_memory().unwrap();

    let shots = vec![
        ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 5.0,
            depth_in: 0.0,
            depth_out: 1.0,
            pitch_in: None,
            pitch_out: None,
            left: None,
            right: None,
            up: None,
            down: None,
            comment: None,
            is_virtual: false,
            marker_index: None,
            temperature: None,
        },
        ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 3.0,
            depth_in: 1.0,
            depth_out: 2.5,
            ..Default::default()
        },
        ShotData {
            azimuth_in: 30.0,
            azimuth_out: 210.0,
            length: 4.0,
            depth_in: 2.5,
            depth_out: 3.0,
            ..Default::default()
        },
    ];

    let cmd = Command::CreateSection {
        name: Some("Test Section".to_string()),
        surveyor: Some("John Doe".to_string()),
        date: Some(NaiveDate::from_ymd_opt(2024, 1, 15).unwrap()),
        color: Color::from_hex("#4ecdc4"),
        shots: shots.clone(),
        placement: Placement::Manual { x: 0.0, y: 0.0 },
    };

    let result = state.execute(cmd).unwrap();

    // Core assertions
    assert!(result.success);
    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 1);

    let section = &project.sections[0];
    assert_eq!(section.name, Some("Test Section".to_string()));
    assert_eq!(section.surveyor, Some("John Doe".to_string()));
    assert_eq!(section.shots.len(), 3);

    // Verify station coordinates computed (3 shots = 4 stations)
    let stations = state.get_stations().unwrap();
    assert_eq!(stations.len(), 4);

    // Station 0 at origin (placement point)
    assert!((stations[0].x - 0.0).abs() < 0.001);
    assert!((stations[0].y - 0.0).abs() < 0.001);
    assert!((stations[0].depth - 0.0).abs() < 0.001);

    // Station 1: azimuth 45°, length 5m
    // x = 5 * sin(45°) ≈ 3.536
    // y = 5 * cos(45°) ≈ 3.536
    assert!((stations[1].x - 3.536).abs() < 0.01);
    assert!((stations[1].y - 3.536).abs() < 0.01);
    assert!((stations[1].depth - 1.0).abs() < 0.001);
}
```

**Edge Cases to Test:**
```rust
#[test]
fn test_create_section_empty_shots() {
    // Empty shots array should create section with 1 station at placement
    let mut state = AppState::new_in_memory().unwrap();
    let cmd = Command::CreateSection {
        name: Some("Empty".to_string()),
        shots: vec![],
        placement: Placement::Manual { x: 10.0, y: 20.0 },
        ..Default::default()
    };
    let result = state.execute(cmd).unwrap();
    assert!(result.success);
    let stations = state.get_stations().unwrap();
    assert_eq!(stations.len(), 1);
    assert!((stations[0].x - 10.0).abs() < 0.001);
}

#[test]
fn test_create_section_many_shots() {
    // Performance test: 100+ shots
    let mut state = AppState::new_in_memory().unwrap();
    let shots: Vec<ShotData> = (0..150).map(|i| ShotData {
        azimuth_in: (i as f64 * 2.4) % 360.0,
        azimuth_out: ((i as f64 * 2.4) + 180.0) % 360.0,
        length: 2.0 + (i as f64 * 0.1),
        depth_in: i as f64 * 0.5,
        depth_out: (i + 1) as f64 * 0.5,
        ..Default::default()
    }).collect();

    let cmd = Command::CreateSection {
        name: Some("Large Section".to_string()),
        shots,
        ..Default::default()
    };

    let start = std::time::Instant::now();
    let result = state.execute(cmd).unwrap();
    let duration = start.elapsed();

    assert!(result.success);
    assert!(duration.as_millis() < 100, "Should complete in <100ms");
    let stations = state.get_stations().unwrap();
    assert_eq!(stations.len(), 151); // 150 shots = 151 stations
}

#[test]
fn test_create_section_all_optional_null() {
    let mut state = AppState::new_in_memory().unwrap();
    let cmd = Command::CreateSection {
        name: None,
        surveyor: None,
        date: None,
        color: Color::default(),
        shots: vec![ShotData::default()],
        placement: Placement::Manual { x: 0.0, y: 0.0 },
    };
    let result = state.execute(cmd).unwrap();
    assert!(result.success);
}

#[test]
fn test_create_section_duplicate_names_allowed() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create first section
    state.execute(Command::CreateSection {
        name: Some("Duplicate Name".to_string()),
        shots: vec![ShotData::default()],
        ..Default::default()
    }).unwrap();

    // Create second with same name - should succeed
    let result = state.execute(Command::CreateSection {
        name: Some("Duplicate Name".to_string()),
        shots: vec![ShotData::default()],
        ..Default::default()
    });

    assert!(result.is_ok());
    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 2);
}
```

**Assertions Checklist:**
- [ ] Command returns success
- [ ] Section added to project
- [ ] Section metadata matches input
- [ ] Shot count matches
- [ ] Station count = shots + 1
- [ ] Station 0 at placement coordinates
- [ ] Station coordinates computed from azimuth/length
- [ ] Depth values propagated correctly

---

### Test 1.2: `test_execute_merge_stations_command`

**Purpose:** Verify MergeStations updates section offsets to align stations.

**Test Code:**
```rust
#[test]
fn test_execute_merge_stations_command() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create Section A with 5 shots (6 stations)
    create_test_section(&mut state, "Section A", 5, 0.0, 0.0);

    // Create Section B with 3 shots (4 stations) at different location
    create_test_section(&mut state, "Section B", 3, 100.0, 100.0);

    // Get initial position of Section B station 0
    let initial_b0 = state.get_station(StationRef { section_id: 1, station_index: 0 }).unwrap();

    // Merge last station of A (index 5) with first station of B (index 0)
    let cmd = Command::MergeStations {
        station_a: StationRef { section_id: 0, station_index: 5 },
        station_b: StationRef { section_id: 1, station_index: 0 },
        closure_strategy: ClosureStrategy::KeepRaw,
    };

    let result = state.execute(cmd).unwrap();
    assert!(result.success);

    let project = state.get_project().unwrap();

    // Verify merge recorded
    assert_eq!(project.station_merges.len(), 1);
    let merge = &project.station_merges[0];
    assert_eq!(merge.station_a, StationRef { section_id: 0, station_index: 5 });
    assert_eq!(merge.station_b, StationRef { section_id: 1, station_index: 0 });

    // Verify Section B has offset now
    assert!(project.section_offsets.contains_key(&1));

    // Verify stations now align
    let station_a5 = state.get_station(StationRef { section_id: 0, station_index: 5 }).unwrap();
    let station_b0 = state.get_station(StationRef { section_id: 1, station_index: 0 }).unwrap();

    assert!((station_a5.x - station_b0.x).abs() < 0.001,
        "X coords should match: {} vs {}", station_a5.x, station_b0.x);
    assert!((station_a5.y - station_b0.y).abs() < 0.001,
        "Y coords should match: {} vs {}", station_a5.y, station_b0.y);
}

// Helper function
fn create_test_section(state: &mut AppState, name: &str, shot_count: usize, x: f64, y: f64) {
    let shots: Vec<ShotData> = (0..shot_count).map(|i| ShotData {
        azimuth_in: 90.0, // East
        azimuth_out: 270.0,
        length: 5.0,
        depth_in: i as f64,
        depth_out: (i + 1) as f64,
        ..Default::default()
    }).collect();

    state.execute(Command::CreateSection {
        name: Some(name.to_string()),
        shots,
        placement: Placement::Manual { x, y },
        ..Default::default()
    }).unwrap();
}
```

**Edge Cases:**
```rust
#[test]
fn test_merge_same_station_error() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    let result = state.execute(Command::MergeStations {
        station_a: StationRef { section_id: 0, station_index: 1 },
        station_b: StationRef { section_id: 0, station_index: 1 }, // Same station
        closure_strategy: ClosureStrategy::KeepRaw,
    });

    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("same station"));
}

#[test]
fn test_merge_already_merged_stations_error() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);
    create_test_section(&mut state, "B", 3, 50.0, 50.0);

    // First merge
    state.execute(Command::MergeStations {
        station_a: StationRef { section_id: 0, station_index: 3 },
        station_b: StationRef { section_id: 1, station_index: 0 },
        closure_strategy: ClosureStrategy::KeepRaw,
    }).unwrap();

    // Try to merge same pair again
    let result = state.execute(Command::MergeStations {
        station_a: StationRef { section_id: 0, station_index: 3 },
        station_b: StationRef { section_id: 1, station_index: 0 },
        closure_strategy: ClosureStrategy::KeepRaw,
    });

    assert!(result.is_err());
}

#[test]
fn test_merge_creates_loop_shows_closure_error() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create a triangle of sections
    create_test_section(&mut state, "A", 5, 0.0, 0.0);
    create_test_section(&mut state, "B", 5, 25.0, 0.0);
    create_test_section(&mut state, "C", 5, 12.5, 21.65); // Forms equilateral-ish

    // Connect A to B
    state.execute(Command::MergeStations {
        station_a: StationRef { section_id: 0, station_index: 5 },
        station_b: StationRef { section_id: 1, station_index: 0 },
        closure_strategy: ClosureStrategy::KeepRaw,
    }).unwrap();

    // Connect B to C
    state.execute(Command::MergeStations {
        station_a: StationRef { section_id: 1, station_index: 5 },
        station_b: StationRef { section_id: 2, station_index: 0 },
        closure_strategy: ClosureStrategy::KeepRaw,
    }).unwrap();

    // Connect C back to A - creates loop
    let result = state.execute(Command::MergeStations {
        station_a: StationRef { section_id: 2, station_index: 5 },
        station_b: StationRef { section_id: 0, station_index: 0 },
        closure_strategy: ClosureStrategy::KeepRaw,
    });

    // Should succeed but report closure error
    assert!(result.is_ok());
    let project = state.get_project().unwrap();
    assert!(!project.loop_closures.is_empty());
}

#[test]
fn test_merge_with_distribute_proportionally() {
    // Test ClosureStrategy::DistributeProportionally
    // Should adjust shot lengths to eliminate closure error
}

#[test]
fn test_merge_with_large_closure_error() {
    // Closure error >10% should still work but generate warning
}
```

---

### Test 1.3: `test_execute_set_zero_datum_command`

**Purpose:** Verify SetZeroDatum stores GPS coordinates and anchors section.

**Test Code:**
```rust
#[test]
fn test_execute_set_zero_datum_command() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Main", 5, 0.0, 0.0);

    let cmd = Command::SetZeroDatum {
        station_ref: StationRef { section_id: 0, station_index: 0 },
        coordinates: GpsCoordinates {
            latitude: 20.508889,
            longitude: -87.461389,
            depth_reference: 0.0,
        },
    };

    let result = state.execute(cmd).unwrap();
    assert!(result.success);

    let project = state.get_project().unwrap();
    assert_eq!(project.zero_datums.len(), 1);

    let datum = &project.zero_datums[0];
    assert_eq!(datum.station_ref, StationRef { section_id: 0, station_index: 0 });
    assert!((datum.latitude - 20.508889).abs() < 0.000001);
    assert!((datum.longitude - (-87.461389)).abs() < 0.000001);
    assert!((datum.depth_reference - 0.0).abs() < 0.001);
}
```

**Edge Cases:**
```rust
#[test]
fn test_set_zero_datum_nonexistent_station_error() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    let result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef { section_id: 99, station_index: 0 }, // Invalid section
        coordinates: GpsCoordinates::default(),
    });

    assert!(result.is_err());
}

#[test]
fn test_set_multiple_zero_datums() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 5, 0.0, 0.0);
    create_test_section(&mut state, "B", 5, 50.0, 50.0);

    // Set first zero datum
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef { section_id: 0, station_index: 0 },
        coordinates: GpsCoordinates { latitude: 20.0, longitude: -87.0, depth_reference: 0.0 },
    }).unwrap();

    // Set second zero datum on different section
    state.execute(Command::SetZeroDatum {
        station_ref: StationRef { section_id: 1, station_index: 0 },
        coordinates: GpsCoordinates { latitude: 20.001, longitude: -87.001, depth_reference: 5.0 },
    }).unwrap();

    let project = state.get_project().unwrap();
    assert_eq!(project.zero_datums.len(), 2);
}

#[test]
fn test_set_zero_datum_at_poles() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Arctic", 3, 0.0, 0.0);

    // North pole
    let result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef { section_id: 0, station_index: 0 },
        coordinates: GpsCoordinates { latitude: 90.0, longitude: 0.0, depth_reference: 0.0 },
    });
    assert!(result.is_ok());
}

#[test]
fn test_set_zero_datum_at_date_line() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Pacific", 3, 0.0, 0.0);

    // International date line
    let result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef { section_id: 0, station_index: 0 },
        coordinates: GpsCoordinates { latitude: 0.0, longitude: 180.0, depth_reference: 0.0 },
    });
    assert!(result.is_ok());

    // Also test -180
    create_test_section(&mut state, "Pacific2", 3, 10.0, 10.0);
    let result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef { section_id: 1, station_index: 0 },
        coordinates: GpsCoordinates { latitude: 0.0, longitude: -180.0, depth_reference: 0.0 },
    });
    assert!(result.is_ok());
}

#[test]
fn test_set_zero_datum_negative_depth() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Mountain", 3, 0.0, 0.0);

    // Negative depth = above sea level
    let result = state.execute(Command::SetZeroDatum {
        station_ref: StationRef { section_id: 0, station_index: 0 },
        coordinates: GpsCoordinates { latitude: 45.0, longitude: 7.0, depth_reference: -3000.0 },
    });
    assert!(result.is_ok());
}
```

---

### Test 1.4: `test_execute_update_shot_command`

**Purpose:** Verify UpdateShot modifies shot data and recalculates downstream stations.

**Test Code:**
```rust
#[test]
fn test_execute_update_shot_command() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Test", 3, 0.0, 0.0);

    let original_stations = state.get_stations().unwrap();
    let original_station2_x = original_stations[2].x;

    let cmd = Command::UpdateShot {
        section_id: 0,
        shot_id: 1, // Middle shot
        updates: ShotUpdates {
            length: Some(10.0), // Changed from 5.0
            azimuth_in: Some(90.0), // Changed direction
            azimuth_out: Some(270.0),
            ..Default::default()
        },
    };

    let result = state.execute(cmd).unwrap();
    assert!(result.success);

    // Verify shot updated
    let section = state.get_section(0).unwrap();
    assert_eq!(section.shots[1].length, 10.0);
    assert_eq!(section.shots[1].azimuth_in, 90.0);

    // Verify downstream stations recalculated
    let new_stations = state.get_stations().unwrap();
    assert_ne!(original_station2_x, new_stations[2].x,
        "Station 2 should have moved after shot 1 was updated");
}
```

**Edge Cases:**
```rust
#[test]
fn test_update_nonexistent_shot_error() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    let result = state.execute(Command::UpdateShot {
        section_id: 0,
        shot_id: 99, // Doesn't exist
        updates: ShotUpdates { length: Some(5.0), ..Default::default() },
    });

    assert!(result.is_err());
}

#[test]
fn test_update_shot_invalid_values_error() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    // Zero length should error
    let result = state.execute(Command::UpdateShot {
        section_id: 0,
        shot_id: 0,
        updates: ShotUpdates { length: Some(0.0), ..Default::default() },
    });
    assert!(result.is_err());

    // Negative LRUD should error
    let result = state.execute(Command::UpdateShot {
        section_id: 0,
        shot_id: 0,
        updates: ShotUpdates { left: Some(-1.0), ..Default::default() },
    });
    assert!(result.is_err());
}

#[test]
fn test_update_shot_optional_fields_only() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    let original_length = state.get_section(0).unwrap().shots[0].length;

    // Update only optional fields
    state.execute(Command::UpdateShot {
        section_id: 0,
        shot_id: 0,
        updates: ShotUpdates {
            comment: Some("Test comment".to_string()),
            left: Some(1.5),
            right: Some(2.0),
            up: Some(3.0),
            down: Some(1.0),
            ..Default::default()
        },
    }).unwrap();

    let section = state.get_section(0).unwrap();
    assert_eq!(section.shots[0].length, original_length); // Unchanged
    assert_eq!(section.shots[0].comment, Some("Test comment".to_string()));
    assert_eq!(section.shots[0].left, Some(1.5));
}

#[test]
fn test_update_shot_virtual_flag() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    assert!(!state.get_section(0).unwrap().shots[0].is_virtual);

    state.execute(Command::UpdateShot {
        section_id: 0,
        shot_id: 0,
        updates: ShotUpdates { is_virtual: Some(true), ..Default::default() },
    }).unwrap();

    assert!(state.get_section(0).unwrap().shots[0].is_virtual);
}
```

---

### Test 1.5: `test_execute_delete_shot_command`

**Purpose:** Verify DeleteShot removes shot and splits section if mid-section.

**Test Code:**
```rust
#[test]
fn test_execute_delete_shot_command_mid_section() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Test", 5, 0.0, 0.0);

    // Delete middle shot (index 2)
    let cmd = Command::DeleteShot {
        section_id: 0,
        shot_id: 2,
    };

    let result = state.execute(cmd).unwrap();
    assert!(result.success);

    let project = state.get_project().unwrap();

    // Section should split into two
    assert_eq!(project.sections.len(), 2);

    // Original section has shots 0, 1 (2 shots)
    assert_eq!(project.sections[0].shots.len(), 2);

    // New section has what was shots 3, 4 (now renumbered as 0, 1)
    assert_eq!(project.sections[1].shots.len(), 2);

    // New section should have suffix in name
    let new_name = project.sections[1].name.as_ref().unwrap();
    assert!(new_name.contains(" A") || new_name.contains(" B") || new_name.contains("_"),
        "Split section should have suffix: {}", new_name);
}
```

**Edge Cases:**
```rust
#[test]
fn test_delete_first_shot_no_split() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 5, 0.0, 0.0);

    state.execute(Command::DeleteShot {
        section_id: 0,
        shot_id: 0, // First shot
    }).unwrap();

    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 1); // No split
    assert_eq!(project.sections[0].shots.len(), 4); // 5 - 1 = 4
}

#[test]
fn test_delete_last_shot_no_split() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 5, 0.0, 0.0);

    state.execute(Command::DeleteShot {
        section_id: 0,
        shot_id: 4, // Last shot
    }).unwrap();

    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 1); // No split
    assert_eq!(project.sections[0].shots.len(), 4);
}

#[test]
fn test_delete_only_shot_deletes_section() {
    let mut state = AppState::new_in_memory().unwrap();

    // Create section with single shot
    state.execute(Command::CreateSection {
        name: Some("Single".to_string()),
        shots: vec![ShotData::default()],
        placement: Placement::Manual { x: 0.0, y: 0.0 },
        ..Default::default()
    }).unwrap();

    state.execute(Command::DeleteShot {
        section_id: 0,
        shot_id: 0,
    }).unwrap();

    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 0); // Section deleted
}

#[test]
fn test_delete_shot_in_merged_section() {
    // If section is merged, deleting shot might need to:
    // 1. Unmerge first
    // 2. Or prevent deletion
    // Test actual behavior
}
```

---

### Test 1.6: `test_execute_create_shot_command`

**Purpose:** Verify CreateShot inserts shot at correct position.

**Test Code:**
```rust
#[test]
fn test_execute_create_shot_command() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Test", 3, 0.0, 0.0);

    let cmd = Command::CreateShot {
        section_id: 0,
        shot: ShotData {
            azimuth_in: 180.0,
            azimuth_out: 0.0,
            length: 2.5,
            depth_in: 5.0,
            depth_out: 6.0,
            ..Default::default()
        },
        after_shot_id: Some(1), // Insert after shot 1
    };

    let result = state.execute(cmd).unwrap();
    assert!(result.success);

    let section = state.get_section(0).unwrap();
    assert_eq!(section.shots.len(), 4);

    // New shot should be at index 2
    assert_eq!(section.shots[2].length, 2.5);
    assert_eq!(section.shots[2].azimuth_in, 180.0);
}
```

**Edge Cases:**
```rust
#[test]
fn test_create_shot_at_beginning() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    state.execute(Command::CreateShot {
        section_id: 0,
        shot: ShotData { length: 99.0, ..Default::default() },
        after_shot_id: None, // Insert at beginning
    }).unwrap();

    let section = state.get_section(0).unwrap();
    assert_eq!(section.shots.len(), 4);
    assert_eq!(section.shots[0].length, 99.0);
}

#[test]
fn test_create_shot_at_end() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    state.execute(Command::CreateShot {
        section_id: 0,
        shot: ShotData { length: 99.0, ..Default::default() },
        after_shot_id: Some(2), // After last shot
    }).unwrap();

    let section = state.get_section(0).unwrap();
    assert_eq!(section.shots.len(), 4);
    assert_eq!(section.shots[3].length, 99.0);
}

#[test]
fn test_create_shot_invalid_section_error() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    let result = state.execute(Command::CreateShot {
        section_id: 99, // Invalid
        shot: ShotData::default(),
        after_shot_id: None,
    });

    assert!(result.is_err());
}
```

---

### Test 1.7: `test_execute_delete_section_command`

**Purpose:** Verify DeleteSection removes section and cleans up merges.

**Test Code:**
```rust
#[test]
fn test_execute_delete_section_command() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);
    create_test_section(&mut state, "B", 5, 50.0, 50.0);

    // Merge sections
    state.execute(Command::MergeStations {
        station_a: StationRef { section_id: 0, station_index: 3 },
        station_b: StationRef { section_id: 1, station_index: 0 },
        closure_strategy: ClosureStrategy::KeepRaw,
    }).unwrap();

    // Delete section A
    let cmd = Command::DeleteSection { section_id: 0 };
    let result = state.execute(cmd).unwrap();

    assert!(result.success);
    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].name, Some("B".to_string()));
    assert_eq!(project.station_merges.len(), 0); // Merge cleaned up
}
```

**Edge Cases:**
```rust
#[test]
fn test_delete_nonexistent_section_error() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    let result = state.execute(Command::DeleteSection { section_id: 99 });
    assert!(result.is_err());
}

#[test]
fn test_delete_section_with_zero_datum() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    state.execute(Command::SetZeroDatum {
        station_ref: StationRef { section_id: 0, station_index: 0 },
        coordinates: GpsCoordinates::default(),
    }).unwrap();

    state.execute(Command::DeleteSection { section_id: 0 }).unwrap();

    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 0);
    assert_eq!(project.zero_datums.len(), 0); // Datum removed
}

#[test]
fn test_delete_only_section() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "A", 3, 0.0, 0.0);

    state.execute(Command::DeleteSection { section_id: 0 }).unwrap();

    let project = state.get_project().unwrap();
    assert_eq!(project.sections.len(), 0);
}
```

---

### Test 1.8: `test_execute_update_section_metadata_command`

**Purpose:** Verify UpdateSectionMetadata changes metadata without affecting shots.

**Test Code:**
```rust
#[test]
fn test_execute_update_section_metadata_command() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Original Name", 3, 0.0, 0.0);

    let original_shot_count = state.get_section(0).unwrap().shots.len();

    let cmd = Command::UpdateSectionMetadata {
        section_id: 0,
        name: Some("New Name".to_string()),
        surveyor: Some("Jane Doe".to_string()),
        date: None, // Don't change
        color: Some(Color::from_hex("#ff6b6b")),
    };

    let result = state.execute(cmd).unwrap();
    assert!(result.success);

    let section = state.get_section(0).unwrap();
    assert_eq!(section.name, Some("New Name".to_string()));
    assert_eq!(section.surveyor, Some("Jane Doe".to_string()));
    assert_eq!(section.color.to_hex(), "#ff6b6b");
    assert_eq!(section.shots.len(), original_shot_count); // Unchanged
}
```

**Edge Cases:**
```rust
#[test]
fn test_update_section_all_none_noop() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Original", 3, 0.0, 0.0);

    let original = state.get_section(0).unwrap().clone();

    state.execute(Command::UpdateSectionMetadata {
        section_id: 0,
        name: None,
        surveyor: None,
        date: None,
        color: None,
    }).unwrap();

    let updated = state.get_section(0).unwrap();
    assert_eq!(original.name, updated.name);
    assert_eq!(original.surveyor, updated.surveyor);
}

#[test]
fn test_update_section_empty_string_name() {
    let mut state = AppState::new_in_memory().unwrap();
    create_test_section(&mut state, "Has Name", 3, 0.0, 0.0);

    state.execute(Command::UpdateSectionMetadata {
        section_id: 0,
        name: Some("".to_string()), // Empty string
        ..Default::default()
    }).unwrap();

    let section = state.get_section(0).unwrap();
    assert_eq!(section.name, Some("".to_string()));
}
```

---

## Verification

Run tests with:
```bash
cd src-tauri && cargo test state::tests -- --nocapture
```

## Definition of Done
- [ ] All 8 tests implemented
- [ ] All edge case tests implemented
- [ ] Tests pass locally
- [ ] Test helper functions created
- [ ] No new warnings from `cargo clippy`
