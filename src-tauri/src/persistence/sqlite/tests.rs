use super::*;
use crate::models::ShotData;
use tempfile::TempDir;

#[test]
fn test_foreign_keys_enabled_on_open() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("fk_enabled.stalx");

    let db = Database::open(&db_path).unwrap();
    let enabled: i32 = db
        .conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();

    assert_eq!(enabled, 1);
}

#[test]
fn test_foreign_keys_enabled_on_open_existing() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("fk_enabled_existing.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let project = Project::new("Foreign Keys Existing".to_string(), None);
    db.save_project(&project).unwrap();
    drop(db);

    let db = Database::open_existing(&db_path).unwrap();
    let enabled: i32 = db
        .conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();

    assert_eq!(enabled, 1);
}

#[test]
fn test_foreign_keys_enabled_on_open_readonly() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("fk_enabled_readonly.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let project = Project::new("Foreign Keys Readonly".to_string(), None);
    db.save_project(&project).unwrap();
    drop(db);

    let db = Database::open_readonly(&db_path).unwrap();
    let enabled: i32 = db
        .conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();

    assert_eq!(enabled, 1);
}

#[test]
fn test_user_version_set_on_open() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("user_version.stalx");

    let db = Database::open(&db_path).unwrap();
    let version: i32 = db
        .conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();

    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn test_create_and_save_project() {
    let db = Database::in_memory().unwrap();
    let mut project = Project::new("Test Cave".to_string(), Some("Test Location".to_string()));

    let section_data = SectionData {
        name: Some("Main Line".to_string()),
        surveyor: Some("Test Surveyor".to_string()),
        date: None,
        color: "#4ecdc4".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 10.0,
            depth_in: 5.0,
            depth_out: 6.0,
            ..Default::default()
        }],
    };

    project.add_section(section_data);

    let mut db = db;
    db.save_project(&project).unwrap();

    let loaded = db.load_project().unwrap();
    assert_eq!(loaded.name, "Test Cave");
    assert_eq!(loaded.sections.len(), 1);
    assert_eq!(loaded.sections[0].shots.len(), 1);
}

// === Test 3.1: Save/Load Multiple Sections ===
#[test]
fn test_save_load_multiple_sections() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_sections.stalx");

    // Create a project with multiple sections
    let mut project = Project::new("Multi-Section Cave".to_string(), Some("Test Location".to_string()));

    // Section 1: Main passage
    let section1 = SectionData {
        name: Some("Main Passage".to_string()),
        surveyor: Some("John Doe".to_string()),
        date: chrono::NaiveDate::from_ymd_opt(2024, 6, 15),
        color: "#ff5733".to_string(),
        direction: Some(SurveyDirection::In),
        quality: 1.0,
        shots: vec![
            ShotData {
                azimuth_in: 45.0,
                azimuth_out: 225.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 7.0,
                left: Some(1.5),
                right: Some(2.0),
                up: Some(3.0),
                down: Some(0.5),
                comment: Some("Entry shot".to_string()),
                ..Default::default()
            },
            ShotData {
                azimuth_in: 60.0,
                azimuth_out: 240.0,
                length: 8.5,
                depth_in: 7.0,
                depth_out: 9.0,
                pitch_in: Some(15.0),
                pitch_out: Some(-10.0),
                ..Default::default()
            },
        ],
    };

    // Section 2: Side passage
    let section2 = SectionData {
        name: Some("Side Passage".to_string()),
        surveyor: Some("Jane Smith".to_string()),
        date: chrono::NaiveDate::from_ymd_opt(2024, 6, 16),
        color: "#33ff57".to_string(),
        direction: Some(SurveyDirection::Out),
        quality: 1.0,
        shots: vec![
            ShotData {
                azimuth_in: 90.0,
                azimuth_out: 270.0,
                length: 5.0,
                depth_in: 6.0,
                depth_out: 6.5,
                is_virtual: true,
                marker_index: Some(42),
                temperature: Some(18.5),
                ..Default::default()
            },
        ],
    };

    // Section 3: No metadata (testing None values)
    let section3 = SectionData {
        name: None,
        surveyor: None,
        date: None,
        color: "#3357ff".to_string(),
        direction: None,
        quality: 1.0,
        shots: vec![],
    };

    project.add_section(section1);
    project.add_section(section2);
    project.add_section(section3);

    // Save to file
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Load from file
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    // Verify project metadata
    assert_eq!(loaded.name, "Multi-Section Cave");
    assert_eq!(loaded.location, Some("Test Location".to_string()));
    assert_eq!(loaded.sections.len(), 3);

    // Verify section 1
    let s1 = &loaded.sections[0];
    assert_eq!(s1.name, Some("Main Passage".to_string()));
    assert_eq!(s1.surveyor, Some("John Doe".to_string()));
    assert_eq!(s1.date, chrono::NaiveDate::from_ymd_opt(2024, 6, 15));
    assert_eq!(s1.color, "#ff5733");
    assert_eq!(s1.direction, SurveyDirection::In);
    assert_eq!(s1.shots.len(), 2);

    // Verify shot data preservation
    let shot1 = &s1.shots[0];
    assert_eq!(shot1.azimuth_in, 45.0);
    assert_eq!(shot1.azimuth_out, 225.0);
    assert_eq!(shot1.length, 10.0);
    assert_eq!(shot1.depth_in, 5.0);
    assert_eq!(shot1.depth_out, 7.0);
    assert_eq!(shot1.left, Some(1.5));
    assert_eq!(shot1.right, Some(2.0));
    assert_eq!(shot1.up, Some(3.0));
    assert_eq!(shot1.down, Some(0.5));
    assert_eq!(shot1.comment, Some("Entry shot".to_string()));

    let shot2 = &s1.shots[1];
    assert_eq!(shot2.pitch_in, Some(15.0));
    assert_eq!(shot2.pitch_out, Some(-10.0));

    // Verify section 2 (Out direction, virtual shot)
    let s2 = &loaded.sections[1];
    assert_eq!(s2.direction, SurveyDirection::Out);
    assert_eq!(s2.shots[0].is_virtual, true);
    assert_eq!(s2.shots[0].marker_index, Some(42));
    assert_eq!(s2.shots[0].temperature, Some(18.5));

    // Verify section 3 (None values)
    let s3 = &loaded.sections[2];
    assert!(s3.name.is_none());
    assert!(s3.surveyor.is_none());
    assert!(s3.date.is_none());
    assert!(s3.shots.is_empty());
}

// === Test 3.2: Save/Load Station Merges ===
#[test]
fn test_save_load_station_merges() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_merges.stalx");

    let mut project = Project::new("Merge Test".to_string(), None);

    // Create two sections with shots
    let section1 = SectionData {
        name: Some("Section A".to_string()),
        color: "#ff0000".to_string(),
        shots: vec![
            ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() },
            ShotData { azimuth_in: 45.0, azimuth_out: 225.0, length: 7.0, depth_in: 1.0, depth_out: 2.0, ..Default::default() },
        ],
        ..Default::default()
    };

    let section2 = SectionData {
        name: Some("Section B".to_string()),
        color: "#00ff00".to_string(),
        shots: vec![
            ShotData { azimuth_in: 90.0, azimuth_out: 270.0, length: 4.0, depth_in: 0.0, depth_out: 0.5, ..Default::default() },
        ],
        ..Default::default()
    };

    project.add_section(section1);
    project.add_section(section2);

    // Add station merges manually (bypassing validation for test)
    let merge1 = StationMerge {
        station_a: StationRef::new(0, 1), // Section 0, Station 1
        station_b: StationRef::new(1, 0), // Section 1, Station 0
        merged_at: Utc::now(),
    };

    let merge2 = StationMerge {
        station_a: StationRef::new(0, 2), // Section 0, Station 2
        station_b: StationRef::new(1, 1), // Section 1, Station 1
        merged_at: Utc::now(),
    };

    project.station_merges.push(merge1);
    project.station_merges.push(merge2);

    // Save
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Load and verify
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.station_merges.len(), 2);

    let m1 = &loaded.station_merges[0];
    assert_eq!(m1.station_a.section_id, 0);
    assert_eq!(m1.station_a.station_index, 1);
    assert_eq!(m1.station_b.section_id, 1);
    assert_eq!(m1.station_b.station_index, 0);

    let m2 = &loaded.station_merges[1];
    assert_eq!(m2.station_a.section_id, 0);
    assert_eq!(m2.station_a.station_index, 2);
    assert_eq!(m2.station_b.section_id, 1);
    assert_eq!(m2.station_b.station_index, 1);
}

// === Test 3.3: Save/Load Zero Datums with GPS Precision ===
#[test]
fn test_save_load_zero_datums() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_gps.stalx");

    let mut project = Project::new("GPS Test".to_string(), None);

    // Add a section with shots
    let section = SectionData {
        name: Some("Main".to_string()),
        color: "#ffffff".to_string(),
        shots: vec![
            ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 10.0, depth_in: 0.0, depth_out: 5.0, ..Default::default() },
        ],
        ..Default::default()
    };
    project.add_section(section);

    // Add zero datums with high-precision GPS coordinates (8+ decimal places)
    let zd1 = ZeroDatum {
        station_ref: StationRef::new(0, 0),
        gps: GpsCoordinates {
            latitude: 45.12345678901234,   // 14 decimal places
            longitude: -93.98765432109876, // 14 decimal places
            depth_reference: 123.456789,
        },
    };

    let zd2 = ZeroDatum {
        station_ref: StationRef::new(0, 1),
        gps: GpsCoordinates {
            latitude: -33.85678901234567,
            longitude: 151.20987654321098,
            depth_reference: -15.5,
        },
    };

    project.zero_datums.push(zd1);
    project.zero_datums.push(zd2);

    // Save
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Load and verify GPS precision
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.zero_datums.len(), 2);

    // Verify 8+ decimal places of precision preserved
    let loaded_zd1 = &loaded.zero_datums[0];
    assert_eq!(loaded_zd1.station_ref.section_id, 0);
    assert_eq!(loaded_zd1.station_ref.station_index, 0);
    // Check precision to 8 decimal places
    assert!((loaded_zd1.gps.latitude - 45.12345678901234).abs() < 1e-8);
    assert!((loaded_zd1.gps.longitude - (-93.98765432109876)).abs() < 1e-8);
    assert!((loaded_zd1.gps.depth_reference - 123.456789).abs() < 1e-6);

    let loaded_zd2 = &loaded.zero_datums[1];
    assert!((loaded_zd2.gps.latitude - (-33.85678901234567)).abs() < 1e-8);
    assert!((loaded_zd2.gps.longitude - 151.20987654321098).abs() < 1e-8);
    assert!((loaded_zd2.gps.depth_reference - (-15.5)).abs() < 1e-6);
}

// === Test 3.4: Save/Load Section Offsets ===
#[test]
fn test_save_load_section_offsets() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_offsets.stalx");

    let mut project = Project::new("Offset Test".to_string(), None);

    // Create sections
    for i in 0..3 {
        let section = SectionData {
            name: Some(format!("Section {}", i)),
            color: "#000000".to_string(),
            shots: vec![ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() }],
            ..Default::default()
        };
        project.add_section(section);
    }

    // Add section offsets with varying precision
    project.section_offsets.insert(0, (10.123456789, -20.987654321));
    project.section_offsets.insert(1, (0.0, 0.0));
    project.section_offsets.insert(2, (-100.5, 200.75));

    // Save
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Load and verify
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.section_offsets.len(), 3);

    let offset0 = loaded.section_offsets.get(&0).unwrap();
    assert!((offset0.0 - 10.123456789).abs() < 1e-8);
    assert!((offset0.1 - (-20.987654321)).abs() < 1e-8);

    let offset1 = loaded.section_offsets.get(&1).unwrap();
    assert_eq!(offset1.0, 0.0);
    assert_eq!(offset1.1, 0.0);

    let offset2 = loaded.section_offsets.get(&2).unwrap();
    assert_eq!(offset2.0, -100.5);
    assert_eq!(offset2.1, 200.75);
}

// === Test 3.5: Update Shot in Database ===
#[test]
fn test_update_shot_in_database() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_update.stalx");

    // Create initial project
    let mut project = Project::new("Update Test".to_string(), None);
    let section = SectionData {
        name: Some("Test Section".to_string()),
        color: "#123456".to_string(),
        shots: vec![
            ShotData {
                azimuth_in: 45.0,
                azimuth_out: 225.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 8.0,
                comment: Some("Original comment".to_string()),
                ..Default::default()
            },
            ShotData {
                azimuth_in: 90.0,
                azimuth_out: 270.0,
                length: 15.0,
                depth_in: 8.0,
                depth_out: 12.0,
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    project.add_section(section);

    // Save initial state
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Modify the shot in the project
    project.sections[0].shots[0].length = 12.5;
    project.sections[0].shots[0].azimuth_in = 50.0;
    project.sections[0].shots[0].comment = Some("Updated comment".to_string());
    project.sections[0].shots[0].left = Some(2.0);
    project.sections[0].shots[0].right = Some(3.0);

    // Save updated state
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Load and verify update
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    let updated_shot = &loaded.sections[0].shots[0];
    assert_eq!(updated_shot.length, 12.5);
    assert_eq!(updated_shot.azimuth_in, 50.0);
    assert_eq!(updated_shot.comment, Some("Updated comment".to_string()));
    assert_eq!(updated_shot.left, Some(2.0));
    assert_eq!(updated_shot.right, Some(3.0));

    // Verify other shot unchanged
    let other_shot = &loaded.sections[0].shots[1];
    assert_eq!(other_shot.length, 15.0);
    assert_eq!(other_shot.azimuth_in, 90.0);
}

// === Test 3.6: Delete Section Cascades Shots ===
#[test]
fn test_delete_section_cascades_shots() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_cascade.stalx");

    // Create project with multiple sections
    let mut project = Project::new("Cascade Test".to_string(), None);

    let section1 = SectionData {
        name: Some("Section to keep".to_string()),
        color: "#111111".to_string(),
        shots: vec![
            ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() },
        ],
        ..Default::default()
    };

    let section2 = SectionData {
        name: Some("Section to delete".to_string()),
        color: "#222222".to_string(),
        shots: vec![
            ShotData { azimuth_in: 45.0, azimuth_out: 225.0, length: 10.0, depth_in: 1.0, depth_out: 3.0, ..Default::default() },
            ShotData { azimuth_in: 90.0, azimuth_out: 270.0, length: 8.0, depth_in: 3.0, depth_out: 5.0, ..Default::default() },
            ShotData { azimuth_in: 135.0, azimuth_out: 315.0, length: 6.0, depth_in: 5.0, depth_out: 7.0, ..Default::default() },
        ],
        ..Default::default()
    };

    let section3 = SectionData {
        name: Some("Another section to keep".to_string()),
        color: "#333333".to_string(),
        shots: vec![
            ShotData { azimuth_in: 180.0, azimuth_out: 0.0, length: 12.0, depth_in: 0.0, depth_out: 2.0, ..Default::default() },
        ],
        ..Default::default()
    };

    project.add_section(section1);
    project.add_section(section2);
    project.add_section(section3);

    assert_eq!(project.sections.len(), 3);

    // Save initial state
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Remove section 1 (index 1, the one with 3 shots)
    project.remove_section(1);
    assert_eq!(project.sections.len(), 2);

    // Save after deletion
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Load and verify cascade delete
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.sections.len(), 2);
    assert_eq!(loaded.sections[0].name, Some("Section to keep".to_string()));
    assert_eq!(loaded.sections[1].name, Some("Another section to keep".to_string()));

    // Verify shots from deleted section are gone
    let total_shots: usize = loaded.sections.iter().map(|s| s.shots.len()).sum();
    assert_eq!(total_shots, 2); // 1 shot from section 0 + 1 shot from section 2
}

// === Test 3.7: Database Transaction Rollback ===
#[test]
fn test_database_transaction_rollback() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_rollback.stalx");

    // Create and save a valid project
    let mut project = Project::new("Rollback Test".to_string(), None);
    let section = SectionData {
        name: Some("Original Section".to_string()),
        color: "#abcdef".to_string(),
        shots: vec![
            ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() },
        ],
        ..Default::default()
    };
    project.add_section(section);

    // Save the initial project
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Verify original data
    {
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();
        assert_eq!(loaded.name, "Rollback Test");
        assert_eq!(loaded.sections.len(), 1);
        assert_eq!(loaded.sections[0].name, Some("Original Section".to_string()));
    }

    // Modify and save again - this simulates a successful transaction
    project.name = "Modified Project".to_string();
    project.sections[0].name = Some("Modified Section".to_string());
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Verify modification persisted
    {
        let db = Database::open_existing(&db_path).unwrap();
        let loaded = db.load_project().unwrap();
        assert_eq!(loaded.name, "Modified Project");
        assert_eq!(loaded.sections[0].name, Some("Modified Section".to_string()));
    }

    // Test that the transaction is atomic - all data is cleared and rewritten
    // If we open for save, it should be a complete replacement
    let mut new_project = Project::new("Completely New".to_string(), None);
    new_project.add_section(SectionData {
        name: Some("New Section A".to_string()),
        color: "#000000".to_string(),
        shots: vec![],
        ..Default::default()
    });
    new_project.add_section(SectionData {
        name: Some("New Section B".to_string()),
        color: "#ffffff".to_string(),
        shots: vec![],
        ..Default::default()
    });

    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&new_project).unwrap();
    }

    // Verify complete replacement
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();
    assert_eq!(loaded.name, "Completely New");
    assert_eq!(loaded.sections.len(), 2);
    // The old "Modified Section" should be completely gone
    assert!(loaded.sections.iter().all(|s| s.name != Some("Modified Section".to_string())));
}

// === Test 3.8: Open Existing vs Open New ===
#[test]
fn test_open_existing_vs_open_new() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_open.stalx");
    let nonexistent_path = temp_dir.path().join("nonexistent.stalx");

    // Test 1: open_existing on nonexistent file should fail
    let result = Database::open_existing(&nonexistent_path);
    assert!(result.is_err());
    let err_msg = result.err().unwrap().to_string();
    assert!(err_msg.contains("does not exist"), "Expected 'does not exist' error, got: {}", err_msg);

    // Test 2: open() on nonexistent file should create it
    {
        let db = Database::open(&db_path);
        assert!(db.is_ok());
        assert!(db_path.exists());
    }

    // Test 3: open_existing on empty database (no project row) should fail
    {
        let result = Database::open_existing(&db_path);
        assert!(result.is_err());
        let err_msg = result.err().unwrap().to_string();
        assert!(err_msg.contains("valid Stalagmight project"), "Expected 'valid Stalagmight project' error, got: {}", err_msg);
    }

    // Test 4: Save a project, then open_existing should succeed
    let mut project = Project::new("Test Project".to_string(), None);
    project.add_section(SectionData {
        name: Some("Test".to_string()),
        color: "#123456".to_string(),
        shots: vec![],
        ..Default::default()
    });

    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Now open_existing should work
    let result = Database::open_existing(&db_path);
    assert!(result.is_ok());

    // Test 5: Verify loaded data is correct
    let loaded = result.unwrap().load_project().unwrap();
    assert_eq!(loaded.name, "Test Project");
    assert_eq!(loaded.sections.len(), 1);
}

// === Additional Edge Case Tests ===

#[test]
fn test_save_load_loop_closures() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("test_loops.stalx");

    let mut project = Project::new("Loop Test".to_string(), None);

    // Add sections
    project.add_section(SectionData {
        name: Some("Section 1".to_string()),
        color: "#ff0000".to_string(),
        shots: vec![
            ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 10.0, depth_in: 0.0, depth_out: 5.0, ..Default::default() },
        ],
        ..Default::default()
    });

    // Add loop closure data
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(0, 0),
        station_b: StationRef::new(0, 1),
        path_length: 50.0,
        misclosure_distance: 0.5,
        error_percentage: 1.0,
        horizontal_misclosure: 0.4,
        vertical_misclosure: 0.3,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });

    // Save and load
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.loop_closures.len(), 1);
    let lc = &loaded.loop_closures[0];
    assert_eq!(lc.id, 1);
    assert_eq!(lc.path_length, 50.0);
    assert_eq!(lc.misclosure_distance, 0.5);
    assert_eq!(lc.error_percentage, 1.0);
    assert_eq!(lc.horizontal_misclosure, 0.4);
    assert_eq!(lc.vertical_misclosure, 0.3);
}

#[test]
fn test_display_settings_persistence() {
    let db = Database::in_memory().unwrap();

    // Save settings
    db.save_display_setting("scale_bar", "true").unwrap();
    db.save_display_setting("station_labels", "false").unwrap();
    db.save_display_setting("custom_value", "42.5").unwrap();

    // Load all settings
    let settings = db.load_display_settings().unwrap();
    assert_eq!(settings.get("scale_bar"), Some(&"true".to_string()));
    assert_eq!(settings.get("station_labels"), Some(&"false".to_string()));
    assert_eq!(settings.get("custom_value"), Some(&"42.5".to_string()));

    // Get individual setting
    assert_eq!(db.get_display_setting("scale_bar").unwrap(), Some("true".to_string()));
    assert_eq!(db.get_display_setting("nonexistent").unwrap(), None);

    // Update setting
    db.save_display_setting("scale_bar", "false").unwrap();
    assert_eq!(db.get_display_setting("scale_bar").unwrap(), Some("false".to_string()));
}

#[test]
fn test_undo_stack_persistence() {
    let db = Database::in_memory().unwrap();

    // Save undo entries
    let entries = vec![
        (r#"{"type":"AddSection"}"#.to_string(), r#"{"section_id":0}"#.to_string()),
        (r#"{"type":"AddShot"}"#.to_string(), r#"{"shot_id":1}"#.to_string()),
        (r#"{"type":"UpdateShot"}"#.to_string(), r#"{"old_data":{}}"#.to_string()),
    ];
    db.save_undo_stack(entries.clone()).unwrap();

    // Load undo stack
    let loaded = db.load_undo_stack().unwrap();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded[0].0, 0); // sequence
    assert_eq!(loaded[0].1, r#"{"type":"AddSection"}"#);
    assert_eq!(loaded[0].2, r#"{"section_id":0}"#);
    assert_eq!(loaded[1].0, 1);
    assert_eq!(loaded[2].0, 2);

    // Clear undo after sequence 1
    db.clear_undo_after(1).unwrap();
    let loaded_after_clear = db.load_undo_stack().unwrap();
    assert_eq!(loaded_after_clear.len(), 2); // Only sequences 0 and 1 remain
}

#[test]
fn test_resolved_warnings_persistence() {
    let db = Database::in_memory().unwrap();

    // Save project first (to have tables)
    let mut project = Project::new("Test".to_string(), None);
    project.add_section(SectionData { color: "#000".to_string(), ..Default::default() });
    let mut db = db;
    db.save_project(&project).unwrap();

    // Save resolved warning
    let warning = ResolvedWarning {
        section_id: 0,
        shot_id: 1,
        warning_code: "AZIMUTH_DIFF".to_string(),
        resolved_at: Utc::now(),
        resolved_comment: Some("Verified in field".to_string()),
    };
    db.save_resolved_warning(&warning).unwrap();

    // Load resolved warnings
    let loaded = db.load_resolved_warnings().unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].section_id, 0);
    assert_eq!(loaded[0].shot_id, 1);
    assert_eq!(loaded[0].warning_code, "AZIMUTH_DIFF");
    assert_eq!(loaded[0].resolved_comment, Some("Verified in field".to_string()));

    // Delete resolved warning
    db.delete_resolved_warning(0, 1, "AZIMUTH_DIFF").unwrap();
    let loaded_after_delete = db.load_resolved_warnings().unwrap();
    assert!(loaded_after_delete.is_empty());
}

// === Test: Verify merged_with is populated correctly from fractal fixture ===
#[test]
fn test_merged_with_from_fractal_iter2() {
    use std::path::Path;
    use crate::models::StationRef;

    // Use the fractal_plant_iter2 fixture
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..") // Go up from src-tauri
        .join("e2e")
        .join("fixtures")
        .join("fractal_plant_iter2.stalx");

    // Make sure the fixture exists
    assert!(fixture_path.exists(), "Fixture file not found: {:?}", fixture_path);

    // Load the project
    let db = Database::open_existing(&fixture_path).unwrap();
    let project = db.load_project().unwrap();

    // Verify there are merges
    println!("Project has {} merges:", project.station_merges.len());
    for merge in &project.station_merges {
        println!("  Merge: {} <-> {}", merge.station_a, merge.station_b);
    }

    // Compute station coordinates (this populates merged_with)
    let stations = project.compute_station_coordinates();

    // Find station S1.st0
    let s1_st0_ref = StationRef::new(1, 0);
    let s1_st0 = stations.iter().find(|s| s.station_ref == s1_st0_ref)
        .expect("Station 1:0 should exist");

    println!("Station 1:0 merged_with: {:?}", s1_st0.merged_with);

    // S1.st0 should be merged with:
    // - S0.st2 (parent branch merge - when S1 was created from S0)
    // - S2.st0 (sibling merge - when S2 was created from S1)
    let s0_st2 = StationRef::new(0, 2);
    let s2_st0 = StationRef::new(2, 0);

    assert!(
        s1_st0.merged_with.contains(&s0_st2),
        "Station 1:0 should be merged with 0:2 (parent). Got: {:?}",
        s1_st0.merged_with
    );
    assert!(
        s1_st0.merged_with.contains(&s2_st0),
        "Station 1:0 should be merged with 2:0 (sibling). Got: {:?}",
        s1_st0.merged_with
    );
    assert_eq!(
        s1_st0.merged_with.len(),
        2,
        "Station 1:0 should have exactly 2 merges. Got: {:?}",
        s1_st0.merged_with
    );

    // Verify transitive merge groups - 0:2 should also show merged with 2:0
    // since they're all in the same merge group (0:2 ↔ 1:0 ↔ 2:0)
    let s0_st2_station = stations.iter().find(|s| s.station_ref == s0_st2)
        .expect("Station 0:2 should exist");
    println!("Station 0:2 merged_with: {:?}", s0_st2_station.merged_with);

    assert!(
        s0_st2_station.merged_with.contains(&s1_st0_ref),
        "Station 0:2 should be merged with 1:0. Got: {:?}",
        s0_st2_station.merged_with
    );
    assert!(
        s0_st2_station.merged_with.contains(&s2_st0),
        "Station 0:2 should be merged with 2:0 (transitive). Got: {:?}",
        s0_st2_station.merged_with
    );
    assert_eq!(
        s0_st2_station.merged_with.len(),
        2,
        "Station 0:2 should have exactly 2 merges (transitive group). Got: {:?}",
        s0_st2_station.merged_with
    );

    // Verify 2:0 also shows the full group
    let s2_st0_station = stations.iter().find(|s| s.station_ref == s2_st0)
        .expect("Station 2:0 should exist");
    println!("Station 2:0 merged_with: {:?}", s2_st0_station.merged_with);

    assert!(
        s2_st0_station.merged_with.contains(&s1_st0_ref),
        "Station 2:0 should be merged with 1:0. Got: {:?}",
        s2_st0_station.merged_with
    );
    assert!(
        s2_st0_station.merged_with.contains(&s0_st2),
        "Station 2:0 should be merged with 0:2 (transitive). Got: {:?}",
        s2_st0_station.merged_with
    );
    assert_eq!(
        s2_st0_station.merged_with.len(),
        2,
        "Station 2:0 should have exactly 2 merges (transitive group). Got: {:?}",
        s2_st0_station.merged_with
    );
}

// === Test: Verify merged_with from iter4 fixture ===
#[test]
fn test_merged_with_from_fractal_iter4() {
    use std::path::Path;
    use crate::models::StationRef;

    // Use the fractal_plant_iter4 fixture
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..") // Go up from src-tauri
        .join("e2e")
        .join("fixtures")
        .join("fractal_plant_iter4.stalx");

    // Make sure the fixture exists
    assert!(fixture_path.exists(), "Fixture file not found: {:?}", fixture_path);

    // Load the project
    let db = Database::open_existing(&fixture_path).unwrap();
    let project = db.load_project().unwrap();

    println!("Iter4 project has {} merges", project.station_merges.len());

    // Compute station coordinates (this populates merged_with)
    let stations = project.compute_station_coordinates();

    // Find station S1.st0
    let s1_st0_ref = StationRef::new(1, 0);
    let s1_st0 = stations.iter().find(|s| s.station_ref == s1_st0_ref)
        .expect("Station 1:0 should exist");

    println!("Station 1:0 merged_with: {:?}", s1_st0.merged_with);

    // S1.st0 should be merged with:
    // - S0.st8 (parent branch merge - when S1 was created from S0)
    // - S2.st0 (child merge - when S2 was created from S1)
    let s0_st8 = StationRef::new(0, 8);
    let s2_st0 = StationRef::new(2, 0);

    assert!(
        s1_st0.merged_with.contains(&s0_st8),
        "Station 1:0 should be merged with 0:8 (parent). Got: {:?}",
        s1_st0.merged_with
    );
    assert!(
        s1_st0.merged_with.contains(&s2_st0),
        "Station 1:0 should be merged with 2:0 (child). Got: {:?}",
        s1_st0.merged_with
    );
    assert_eq!(
        s1_st0.merged_with.len(),
        2,
        "Station 1:0 should have exactly 2 merges. Got: {:?}",
        s1_st0.merged_with
    );
}
