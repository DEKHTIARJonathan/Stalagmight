# Task 03: Database Operations Tests

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-03 |
| **Category** | Rust Unit Tests |
| **Target File** | `src-tauri/src/persistence/sqlite.rs` |
| **Tests** | 8 |
| **Priority** | P0 - Critical |
| **Dependencies** | None |

## Affected Files
- `src-tauri/src/persistence/sqlite.rs` - Add test module

## Test Specifications

---

### Test 3.1: `test_save_load_multiple_sections`

**Purpose:** Verify multiple sections with shots save and load correctly.

**Test Code:**
```rust
#[test]
fn test_save_load_multiple_sections() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("test.cvproj");

    // Create project with 3 sections
    {
        let db = Database::open(&path).unwrap();

        let mut project = Project::new("Multi-Section Test".to_string());

        // Section 1: 5 shots
        let mut section1 = Section::new("Section A".to_string());
        section1.surveyor = Some("Alice".to_string());
        for i in 0..5 {
            section1.shots.push(Shot {
                id: i,
                azimuth_in: 45.0 + i as f64,
                azimuth_out: 225.0 + i as f64,
                length: 3.0 + i as f64 * 0.5,
                depth_in: i as f64,
                depth_out: (i + 1) as f64,
                ..Default::default()
            });
        }
        project.sections.push(section1);

        // Section 2: 10 shots
        let mut section2 = Section::new("Section B".to_string());
        section2.surveyor = Some("Bob".to_string());
        for i in 0..10 {
            section2.shots.push(Shot {
                id: i,
                azimuth_in: 90.0,
                azimuth_out: 270.0,
                length: 2.0,
                depth_in: i as f64 * 2.0,
                depth_out: (i + 1) as f64 * 2.0,
                ..Default::default()
            });
        }
        project.sections.push(section2);

        // Section 3: 3 shots
        let mut section3 = Section::new("Section C".to_string());
        for i in 0..3 {
            section3.shots.push(Shot {
                id: i,
                azimuth_in: 180.0,
                azimuth_out: 0.0,
                length: 10.0,
                depth_in: 0.0,
                depth_out: 1.0,
                ..Default::default()
            });
        }
        project.sections.push(section3);

        db.save_project(&project).unwrap();
    }

    // Reload and verify
    {
        let db = Database::open_existing(&path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.sections.len(), 3);

        // Verify Section A
        let section_a = loaded.sections.iter().find(|s| s.name == Some("Section A".to_string())).unwrap();
        assert_eq!(section_a.shots.len(), 5);
        assert_eq!(section_a.surveyor, Some("Alice".to_string()));
        assert_eq!(section_a.shots[0].azimuth_in, 45.0);
        assert_eq!(section_a.shots[4].azimuth_in, 49.0);

        // Verify Section B
        let section_b = loaded.sections.iter().find(|s| s.name == Some("Section B".to_string())).unwrap();
        assert_eq!(section_b.shots.len(), 10);
        assert_eq!(section_b.surveyor, Some("Bob".to_string()));

        // Verify Section C
        let section_c = loaded.sections.iter().find(|s| s.name == Some("Section C".to_string())).unwrap();
        assert_eq!(section_c.shots.len(), 3);

        // Verify total shot count
        let total_shots: usize = loaded.sections.iter().map(|s| s.shots.len()).sum();
        assert_eq!(total_shots, 18);
    }
}
```

---

### Test 3.2: `test_save_load_station_merges`

**Purpose:** Verify station merges persist correctly.

**Test Code:**
```rust
#[test]
fn test_save_load_station_merges() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("test.cvproj");

    // Create project with merges
    {
        let db = Database::open(&path).unwrap();

        let mut project = Project::new("Merge Test".to_string());

        // Create sections
        let mut section1 = Section::new("A".to_string());
        section1.id = 0;
        section1.shots = vec![Shot::default(); 5];
        project.sections.push(section1);

        let mut section2 = Section::new("B".to_string());
        section2.id = 1;
        section2.shots = vec![Shot::default(); 3];
        project.sections.push(section2);

        // Add merges
        project.station_merges.push(StationMerge {
            station_a: StationRef { section_id: 0, station_index: 5 },
            station_b: StationRef { section_id: 1, station_index: 0 },
            merged_at: chrono::Utc::now(),
        });

        project.station_merges.push(StationMerge {
            station_a: StationRef { section_id: 0, station_index: 2 },
            station_b: StationRef { section_id: 1, station_index: 3 },
            merged_at: chrono::Utc::now(),
        });

        // Add section offsets resulting from merges
        project.section_offsets.insert(1, (50.0, 75.0));

        db.save_project(&project).unwrap();
    }

    // Reload and verify
    {
        let db = Database::open_existing(&path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.station_merges.len(), 2);

        // Verify first merge
        let merge1 = &loaded.station_merges[0];
        assert_eq!(merge1.station_a, StationRef { section_id: 0, station_index: 5 });
        assert_eq!(merge1.station_b, StationRef { section_id: 1, station_index: 0 });

        // Verify second merge
        let merge2 = &loaded.station_merges[1];
        assert_eq!(merge2.station_a, StationRef { section_id: 0, station_index: 2 });
        assert_eq!(merge2.station_b, StationRef { section_id: 1, station_index: 3 });

        // Verify section offsets
        let offset = loaded.section_offsets.get(&1).unwrap();
        assert!((offset.0 - 50.0).abs() < 0.001);
        assert!((offset.1 - 75.0).abs() < 0.001);
    }
}
```

---

### Test 3.3: `test_save_load_zero_datums`

**Purpose:** Verify zero datums with GPS coordinates persist with precision.

**Test Code:**
```rust
#[test]
fn test_save_load_zero_datums() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("test.cvproj");

    let gps1 = GpsCoordinates {
        latitude: 20.50888912,  // 8 decimal places
        longitude: -87.46138945,
        depth_reference: 0.0,
    };

    let gps2 = GpsCoordinates {
        latitude: 20.50912345,
        longitude: -87.46156789,
        depth_reference: 15.5,
    };

    // Create project with zero datums
    {
        let db = Database::open(&path).unwrap();

        let mut project = Project::new("GPS Test".to_string());

        let mut section = Section::new("Main".to_string());
        section.id = 0;
        section.shots = vec![Shot::default(); 10];
        project.sections.push(section);

        project.zero_datums.push(ZeroDatum {
            station_ref: StationRef { section_id: 0, station_index: 0 },
            coordinates: gps1.clone(),
        });

        project.zero_datums.push(ZeroDatum {
            station_ref: StationRef { section_id: 0, station_index: 5 },
            coordinates: gps2.clone(),
        });

        db.save_project(&project).unwrap();
    }

    // Reload and verify precision
    {
        let db = Database::open_existing(&path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.zero_datums.len(), 2);

        let datum1 = &loaded.zero_datums[0];
        assert!((datum1.coordinates.latitude - gps1.latitude).abs() < 1e-8,
            "Latitude precision lost: {} vs {}", datum1.coordinates.latitude, gps1.latitude);
        assert!((datum1.coordinates.longitude - gps1.longitude).abs() < 1e-8,
            "Longitude precision lost");

        let datum2 = &loaded.zero_datums[1];
        assert!((datum2.coordinates.latitude - gps2.latitude).abs() < 1e-8);
        assert!((datum2.coordinates.longitude - gps2.longitude).abs() < 1e-8);
        assert!((datum2.coordinates.depth_reference - 15.5).abs() < 0.001);
    }
}
```

---

### Test 3.4: `test_save_load_section_offsets`

**Purpose:** Verify section offsets persist correctly.

**Test Code:**
```rust
#[test]
fn test_save_load_section_offsets() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("test.cvproj");

    {
        let db = Database::open(&path).unwrap();

        let mut project = Project::new("Offset Test".to_string());

        for i in 0..5 {
            let mut section = Section::new(format!("Section {}", i));
            section.id = i;
            section.shots = vec![Shot::default()];
            project.sections.push(section);

            // Set offsets for sections 1-4 (0 is anchor)
            if i > 0 {
                project.section_offsets.insert(i, (i as f64 * 100.0, i as f64 * -50.0));
            }
        }

        db.save_project(&project).unwrap();
    }

    {
        let db = Database::open_existing(&path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.section_offsets.len(), 4);

        for i in 1..5_u32 {
            let offset = loaded.section_offsets.get(&i).unwrap();
            assert!((offset.0 - i as f64 * 100.0).abs() < 0.001);
            assert!((offset.1 - i as f64 * -50.0).abs() < 0.001);
        }

        // Section 0 should not have offset (anchor)
        assert!(!loaded.section_offsets.contains_key(&0));
    }
}
```

---

### Test 3.5: `test_update_shot_in_database`

**Purpose:** Verify shot updates persist correctly without affecting other shots.

**Test Code:**
```rust
#[test]
fn test_update_shot_in_database() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("test.cvproj");

    // Create initial project
    {
        let db = Database::open(&path).unwrap();

        let mut project = Project::new("Update Test".to_string());
        let mut section = Section::new("Main".to_string());
        section.id = 0;

        for i in 0..5 {
            section.shots.push(Shot {
                id: i,
                azimuth_in: 45.0,
                azimuth_out: 225.0,
                length: 5.0,
                depth_in: i as f64,
                depth_out: (i + 1) as f64,
                comment: Some(format!("Original shot {}", i)),
                ..Default::default()
            });
        }
        project.sections.push(section);
        db.save_project(&project).unwrap();
    }

    // Update single shot
    {
        let db = Database::open_existing(&path).unwrap();
        let mut project = db.load_project().unwrap();

        // Update shot 2
        project.sections[0].shots[2].length = 99.0;
        project.sections[0].shots[2].azimuth_in = 180.0;
        project.sections[0].shots[2].comment = Some("Modified".to_string());

        db.save_project(&project).unwrap();
    }

    // Verify only shot 2 changed
    {
        let db = Database::open_existing(&path).unwrap();
        let loaded = db.load_project().unwrap();

        // Shot 0, 1, 3, 4 unchanged
        assert_eq!(loaded.sections[0].shots[0].length, 5.0);
        assert_eq!(loaded.sections[0].shots[1].length, 5.0);
        assert_eq!(loaded.sections[0].shots[3].length, 5.0);
        assert_eq!(loaded.sections[0].shots[4].length, 5.0);

        // Shot 2 changed
        assert_eq!(loaded.sections[0].shots[2].length, 99.0);
        assert_eq!(loaded.sections[0].shots[2].azimuth_in, 180.0);
        assert_eq!(loaded.sections[0].shots[2].comment, Some("Modified".to_string()));
    }
}
```

---

### Test 3.6: `test_delete_section_cascades_shots`

**Purpose:** Verify deleting section removes all its shots (no orphans).

**Test Code:**
```rust
#[test]
fn test_delete_section_cascades_shots() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("test.cvproj");

    // Create project with section
    {
        let db = Database::open(&path).unwrap();

        let mut project = Project::new("Cascade Test".to_string());
        let mut section = Section::new("To Delete".to_string());
        section.id = 0;
        section.shots = (0..10).map(|i| Shot { id: i, ..Default::default() }).collect();
        project.sections.push(section);
        db.save_project(&project).unwrap();
    }

    // Delete section and save
    {
        let db = Database::open_existing(&path).unwrap();
        let mut project = db.load_project().unwrap();
        project.sections.clear();
        db.save_project(&project).unwrap();
    }

    // Verify no orphan shots
    {
        let db = Database::open_existing(&path).unwrap();

        // Direct SQL query to check for orphan shots
        let conn = db.get_connection();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM shots",
            [],
            |row| row.get(0)
        ).unwrap();

        assert_eq!(count, 0, "Should be no orphan shots after section deletion");
    }
}
```

---

### Test 3.7: `test_database_transaction_rollback`

**Purpose:** Verify failed operation rolls back transaction.

**Test Code:**
```rust
#[test]
fn test_database_transaction_rollback() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("test.cvproj");

    // Create initial state
    {
        let db = Database::open(&path).unwrap();
        let mut project = Project::new("Rollback Test".to_string());
        let mut section = Section::new("Original".to_string());
        section.id = 0;
        section.shots = vec![Shot::default()];
        project.sections.push(section);
        db.save_project(&project).unwrap();
    }

    // Attempt operation that should fail mid-transaction
    {
        let db = Database::open_existing(&path).unwrap();

        // This simulates a constraint violation or other error
        // The exact implementation depends on how your Database handles errors
        let result = db.execute_with_transaction(|tx| {
            // Insert valid data
            tx.execute(
                "UPDATE project SET name = 'Modified' WHERE id = 1",
                [],
            )?;

            // Force error
            Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(1),
                Some("Simulated error".to_string())
            ))
        });

        assert!(result.is_err());
    }

    // Verify original state preserved
    {
        let db = Database::open_existing(&path).unwrap();
        let loaded = db.load_project().unwrap();

        assert_eq!(loaded.name, "Rollback Test".to_string());
        assert_eq!(loaded.sections.len(), 1);
        assert_eq!(loaded.sections[0].name, Some("Original".to_string()));
    }
}
```

---

### Test 3.8: `test_open_existing_vs_open_new`

**Purpose:** Verify open_existing fails for non-existent files.

**Test Code:**
```rust
#[test]
fn test_open_existing_vs_open_new() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("test.cvproj");

    // open_existing on non-existent file should error
    let result = Database::open_existing(&path);
    assert!(result.is_err(), "open_existing should fail for non-existent file");

    // open on non-existent file should create it
    {
        let db = Database::open(&path).unwrap();
        let project = Project::new("New Project".to_string());
        db.save_project(&project).unwrap();
    }

    assert!(path.exists(), "open() should create file");

    // open_existing on existing file should succeed
    {
        let db = Database::open_existing(&path).unwrap();
        let loaded = db.load_project().unwrap();
        assert_eq!(loaded.name, "New Project".to_string());
    }
}

#[test]
fn test_open_creates_schema() {
    let temp_dir = tempfile::tempdir().unwrap();
    let path = temp_dir.path().join("new.cvproj");

    let db = Database::open(&path).unwrap();

    // Verify schema tables exist
    let conn = db.get_connection();

    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")?
        .query_map([], |row| row.get(0))?
        .filter_map(Result::ok)
        .collect();

    assert!(tables.contains(&"project".to_string()));
    assert!(tables.contains(&"sections".to_string()));
    assert!(tables.contains(&"shots".to_string()));
    assert!(tables.contains(&"station_merges".to_string()));
    assert!(tables.contains(&"zero_datums".to_string()));
}
```

---

## Verification

```bash
cd src-tauri && cargo test persistence::sqlite::tests -- --nocapture
```

## Definition of Done
- [ ] All 8 tests implemented
- [ ] All tests use temp directories (cleaned up automatically)
- [ ] Tests verify data integrity across save/load cycles
- [ ] Transaction rollback works correctly
- [ ] No data corruption on error scenarios
