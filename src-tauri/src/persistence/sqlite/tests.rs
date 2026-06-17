use super::*;
use crate::models::ShotData;
use crate::models::StationAnchor;
use crate::models::StationRef;
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

#[test]
fn test_save_project_name_targeted_update() {
    let mut db = Database::in_memory().unwrap();
    let project = Project::new("Old Name".to_string(), Some("Loc".to_string()));
    db.save_project(&project).unwrap();

    db.save_project_name("New Name").unwrap();

    // Only the name changed; the rest of the project is intact.
    let loaded = db.load_project().unwrap();
    assert_eq!(loaded.name, "New Name");
    assert_eq!(loaded.location.as_deref(), Some("Loc"));

    // And it is visible through the lightweight metadata read.
    let meta = db
        .load_metadata(std::path::PathBuf::from("/tmp/x.stalx"))
        .unwrap();
    assert_eq!(meta.name, "New Name");
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
        date: NaiveDate::from_ymd_opt(2024, 6, 15),
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
        date: NaiveDate::from_ymd_opt(2024, 6, 16),
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
                is_reference: true,
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
    assert_eq!(s1.date, NaiveDate::from_ymd_opt(2024, 6, 15));
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

    // Verify section 2 (Out direction, reference shot)
    let s2 = &loaded.sections[1];
    assert_eq!(s2.direction, SurveyDirection::Out);
    assert!(s2.shots[0].is_reference);
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
        station_a: StationRef::new(0, 1).into(), // Section 0, Station 1
        station_b: StationRef::new(1, 0).into(), // Section 1, Station 0
        merged_at: Utc::now(),
    };

    let merge2 = StationMerge {
        station_a: StationRef::new(0, 2).into(), // Section 0, Station 2
        station_b: StationRef::new(1, 1).into(), // Section 1, Station 1
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

    let m1a = loaded.resolve_key(&loaded.station_merges[0].station_a).unwrap();
    let m1b = loaded.resolve_key(&loaded.station_merges[0].station_b).unwrap();
    assert_eq!(m1a.section_id, 0);
    assert_eq!(m1a.station_index, 1);
    assert_eq!(m1b.section_id, 1);
    assert_eq!(m1b.station_index, 0);

    let m2a = loaded.resolve_key(&loaded.station_merges[1].station_a).unwrap();
    let m2b = loaded.resolve_key(&loaded.station_merges[1].station_b).unwrap();
    assert_eq!(m2a.section_id, 0);
    assert_eq!(m2a.station_index, 2);
    assert_eq!(m2b.section_id, 1);
    assert_eq!(m2b.station_index, 1);
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
        station_ref: StationRef::new(0, 0).into(),
        gps: GpsCoordinates {
            latitude: 45.123_456_789_012_34,   // 14 decimal places
            longitude: -93.987_654_321_098_76, // 14 decimal places
            depth_reference: 123.456_789,
        },
    };

    let zd2 = ZeroDatum {
        station_ref: StationRef::new(0, 1).into(),
        gps: GpsCoordinates {
            latitude: -33.856_789_012_345_67,
            longitude: 151.209_876_543_210_98,
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
    let loaded_zd1_ref = loaded.resolve_key(&loaded_zd1.station_ref).unwrap();
    assert_eq!(loaded_zd1_ref.section_id, 0);
    assert_eq!(loaded_zd1_ref.station_index, 0);
    // Check precision to 8 decimal places
    assert!((loaded_zd1.gps.latitude - 45.123_456_789_012_34).abs() < 1e-8);
    assert!((loaded_zd1.gps.longitude - (-93.987_654_321_098_76)).abs() < 1e-8);
    assert!((loaded_zd1.gps.depth_reference - 123.456_789).abs() < 1e-6);

    let loaded_zd2 = &loaded.zero_datums[1];
    assert!((loaded_zd2.gps.latitude - (-33.856_789_012_345_67)).abs() < 1e-8);
    assert!((loaded_zd2.gps.longitude - 151.209_876_543_210_98).abs() < 1e-8);
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
            name: Some(format!("Section {i}")),
            color: "#000000".to_string(),
            shots: vec![ShotData { azimuth_in: 0.0, azimuth_out: 180.0, length: 5.0, depth_in: 0.0, depth_out: 1.0, ..Default::default() }],
            ..Default::default()
        };
        project.add_section(section);
    }

    // Add section offsets with varying precision
    project.section_offsets.insert(0, (10.123_456_789, -20.987_654_321));
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
    assert!((offset0.0 - 10.123_456_789).abs() < 1e-8);
    assert!((offset0.1 - (-20.987_654_321)).abs() < 1e-8);

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
    assert!(err_msg.contains("does not exist"), "Expected 'does not exist' error, got: {err_msg}");

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
        assert!(err_msg.contains("valid Stalagmight project"), "Expected 'valid Stalagmight project' error, got: {err_msg}");
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
        station_a: StationRef::new(0, 0).into(),
        station_b: StationRef::new(0, 1).into(),
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
    db.save_undo_stack(entries).unwrap();

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
        shot_uuid: None,
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
    db.delete_resolved_warning(0, 1, "AZIMUTH_DIFF", None).unwrap();
    let loaded_after_delete = db.load_resolved_warnings().unwrap();
    assert!(loaded_after_delete.is_empty());
}

#[test]
fn test_resolved_warning_dedup_and_delete_by_uuid() {
    // Issue #57: suppression is keyed by the shot's stable UUID, not the
    // renumber-prone shot_id. Two saves with the same UUID but different
    // shot_id must collapse to a single row, and deletion by UUID must clear
    // it regardless of the shot_id supplied.
    let mut db = Database::in_memory().unwrap();
    let mut project = Project::new("Test".to_string(), None);
    project.add_section(SectionData { color: "#000".to_string(), ..Default::default() });
    db.save_project(&project).unwrap();

    let base = ResolvedWarning {
        section_id: 0,
        shot_id: 1,
        warning_code: "ZERO_LENGTH".to_string(),
        resolved_at: Utc::now(),
        resolved_comment: None,
        shot_uuid: Some("uuid-1".to_string()),
    };
    db.save_resolved_warning(&base).unwrap();
    // Same UUID, drifted shot_id (as an insert-before would produce on reload).
    db.save_resolved_warning(&ResolvedWarning { shot_id: 5, ..base.clone() }).unwrap();

    let loaded = db.load_resolved_warnings().unwrap();
    assert_eq!(loaded.len(), 1, "same UUID must dedup to a single row");
    assert_eq!(loaded[0].shot_uuid.as_deref(), Some("uuid-1"));
    assert_eq!(loaded[0].shot_id, 5, "latest position wins");

    // Deleting by UUID clears it even with an unrelated shot_id.
    db.delete_resolved_warning(0, 999, "ZERO_LENGTH", Some("uuid-1")).unwrap();
    assert!(db.load_resolved_warnings().unwrap().is_empty());
}

// === Test: Verify merged_with is populated correctly from fractal fixture ===
#[test]
#[ignore]
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
    assert!(fixture_path.exists(), "Fixture file not found: {fixture_path:?}");

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
#[ignore]
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
    assert!(fixture_path.exists(), "Fixture file not found: {fixture_path:?}");

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

#[test]
fn test_integrity_check_passes_on_valid_db() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("integrity_valid.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let project = Project::new("Integrity Test".to_string(), None);
    db.save_project(&project).unwrap();
    drop(db);

    // open_existing runs validate_integrity internally — should succeed
    let db = Database::open_existing(&db_path).unwrap();
    // full_integrity_check should also pass
    let errors = db.full_integrity_check().unwrap();
    assert!(errors.is_empty(), "Expected no integrity errors, got: {errors:?}");
}

#[test]
fn test_integrity_check_passes_on_readonly() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("integrity_readonly.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let project = Project::new("Readonly Integrity".to_string(), None);
    db.save_project(&project).unwrap();
    drop(db);

    // open_readonly runs validate_integrity internally — should succeed
    let _db = Database::open_readonly(&db_path).unwrap();
}

#[test]
fn test_integrity_check_fails_on_corrupt_file() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("corrupt.stalx");

    // Write garbage data to simulate a corrupt database file
    std::fs::write(&db_path, b"This is not a valid SQLite database").unwrap();

    // open_existing should fail (either at connection open or integrity check)
    let result = Database::open_existing(&db_path);
    assert!(result.is_err(), "Expected error for corrupt database");
}

#[test]
fn test_full_integrity_check_on_in_memory() {
    let db = Database::in_memory().unwrap();
    let errors = db.full_integrity_check().unwrap();
    assert!(errors.is_empty(), "In-memory DB should pass integrity check");
}

// === Open Existing edge cases ===

#[test]
fn test_open_existing_fails_on_nonexistent_file() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("does_not_exist.stalx");

    let result = Database::open_existing(&db_path);
    assert!(result.is_err(), "Expected error for nonexistent file");
}

#[test]
fn test_open_existing_fails_on_empty_database() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("empty.stalx");

    // Create an empty SQLite database (no project tables)
    {
        let _conn = Connection::open(&db_path).unwrap();
        // Close without creating tables
    }

    let result = Database::open_existing(&db_path);
    assert!(result.is_err(), "Empty database should fail open_existing");
}

#[test]
fn test_open_readonly_fails_on_nonexistent_file() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("gone.stalx");

    let result = Database::open_readonly(&db_path);
    assert!(result.is_err());
}

#[test]
fn test_open_readonly_fails_on_non_stalx_extension() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("project.sqlite");

    // Create a valid SQLite database with wrong extension
    {
        let mut db = Database::open(&db_path).unwrap();
        let project = Project::new("Wrong Ext".to_string(), None);
        db.save_project(&project).unwrap();
    }

    let result = Database::open_readonly(&db_path);
    assert!(result.is_err(), "Non-.stalx extension should be rejected");
}

// === Round-trip with station offsets (individual station moves) ===

#[test]
fn test_save_load_station_offsets_individual() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("station_offsets.stalx");

    let mut project = Project::new("Station Offsets".to_string(), None);
    let section_data = SectionData {
        shots: vec![
            ShotData {
                azimuth_in: 0.0,
                azimuth_out: 0.0,
                length: 10.0,
                depth_in: 0.0,
                depth_out: 1.0,
                ..Default::default()
            },
            ShotData {
                azimuth_in: 90.0,
                azimuth_out: 90.0,
                length: 5.0,
                depth_in: 1.0,
                depth_out: 2.0,
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let section_id = project.add_section(section_data).id;

    // Add individual station offsets
    let ref_a = StationRef::new(section_id, 0);
    let ref_b = StationRef::new(section_id, 1);
    project.station_offsets.insert(ref_a.into(), (1.5, -2.3, 0.1));
    project.station_offsets.insert(ref_b.into(), (-0.5, 0.8, -0.3));

    // Save
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Load and verify
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.station_offsets.len(), 2);
    let offset_a = loaded.station_offset_for_ref(ref_a).unwrap();
    assert!((offset_a.0 - 1.5).abs() < 1e-10);
    assert!((offset_a.1 - (-2.3)).abs() < 1e-10);
    assert!((offset_a.2 - 0.1).abs() < 1e-10);

    let offset_b = loaded.station_offset_for_ref(ref_b).unwrap();
    assert!((offset_b.0 - (-0.5)).abs() < 1e-10);
    assert!((offset_b.1 - 0.8).abs() < 1e-10);
    assert!((offset_b.2 - (-0.3)).abs() < 1e-10);
}

// === Undo/Redo stack persistence with timestamps ===

#[test]
fn test_undo_stack_timestamps_round_trip() {
    let db = Database::in_memory().unwrap();

    let entries = vec![
        ("cmd1".to_string(), "undo1".to_string(), Some("2025-01-15T10:00:00+00:00".to_string())),
        ("cmd2".to_string(), "undo2".to_string(), None),
        ("cmd3".to_string(), "undo3".to_string(), Some("2025-01-15T12:00:00+00:00".to_string())),
    ];

    db.save_undo_stack_with_timestamps(entries).unwrap();
    let loaded = db.load_undo_stack_with_timestamps().unwrap();

    assert_eq!(loaded.len(), 3);

    // Entry 0: explicit timestamp
    assert_eq!(loaded[0].0, 0); // sequence
    assert_eq!(loaded[0].1, "cmd1");
    assert_eq!(loaded[0].2, "undo1");
    assert_eq!(loaded[0].3.as_deref(), Some("2025-01-15T10:00:00+00:00"));

    // Entry 1: generated timestamp (should exist, not None)
    assert_eq!(loaded[1].1, "cmd2");
    assert!(loaded[1].3.is_some(), "Auto-generated timestamp should be present");

    // Entry 2: explicit timestamp
    assert_eq!(loaded[2].3.as_deref(), Some("2025-01-15T12:00:00+00:00"));
}

#[test]
fn test_redo_stack_timestamps_round_trip() {
    let db = Database::in_memory().unwrap();

    let entries = vec![
        ("redo_cmd1".to_string(), "redo_undo1".to_string(), Some("2025-02-01T08:00:00+00:00".to_string())),
        ("redo_cmd2".to_string(), "redo_undo2".to_string(), None),
    ];

    db.save_redo_stack_with_timestamps(entries).unwrap();
    let loaded = db.load_redo_stack_with_timestamps().unwrap();

    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].1, "redo_cmd1");
    assert_eq!(loaded[0].3.as_deref(), Some("2025-02-01T08:00:00+00:00"));
    assert!(loaded[1].3.is_some());
}

#[test]
fn test_clear_undo_after_sequence() {
    let db = Database::in_memory().unwrap();

    // Save 5 entries
    let entries: Vec<(String, String)> = (0..5)
        .map(|i| (format!("cmd{i}"), format!("undo{i}")))
        .collect();
    db.save_undo_stack(entries).unwrap();

    // Clear everything after sequence 2 (keep 0, 1, 2)
    db.clear_undo_after(2).unwrap();

    let loaded = db.load_undo_stack().unwrap();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded[2].0, 2); // sequence = 2
}

// === Legacy (pre-v7) undo history must be dropped on load ===
//
// Pre-v7 builds serialized every untouched nullable ShotUpdates field as an
// explicit null inside persisted undo/redo payloads. Under the v7
// double_option semantics an explicit null means "clear the field", so
// replaying such an entry would silently wipe pitch/LRUD/comment/marker/
// temperature. The legacy JSON is ambiguous, so the only safe upgrade is to
// drop the stacks (gated on PRAGMA user_version < 7).

/// A pre-v7 UpdateShot command payload: untouched nullable fields serialized
/// as explicit nulls (this is what `serde_json::to_string(&ShotUpdates)`
/// produced before `skip_serializing_if` was added).
fn legacy_null_style_update_shot_command(section_id: u32, shot_id: u32) -> String {
    format!(
        r#"{{"type":"update_shot","section_id":{section_id},"shot_id":{shot_id},"updates":{{"azimuth_in":null,"azimuth_out":null,"length":4.0,"depth_in":null,"depth_out":null,"pitch_in":null,"pitch_out":null,"left":null,"right":null,"up":null,"down":null,"comment":null,"is_reference":null,"marker_index":null,"temperature":null}}}}"#
    )
}

/// A pre-v7 PreviousValues undo payload with the same explicit-null shape.
fn legacy_null_style_previous_values(section_id: u32, shot_id: u32) -> String {
    let values_json = r#"{"azimuth_in":null,"azimuth_out":null,"length":2.0,"depth_in":null,"depth_out":null,"pitch_in":null,"pitch_out":null,"left":null,"right":null,"up":null,"down":null,"comment":null,"is_reference":null,"marker_index":null,"temperature":null}"#;
    format!(
        r#"{{"PreviousValues":{{"section_id":{section_id},"shot_id":{shot_id},"values_json":{}}}}}"#,
        serde_json::to_string(values_json).unwrap()
    )
}

/// Create a v6-stamped project file containing legacy-shaped undo AND redo
/// entries, returning its path.
fn write_legacy_v6_project_with_undo_history(dir: &TempDir, name: &str) -> std::path::PathBuf {
    let path = dir.path().join(name);

    let mut project = Project::new("Legacy Undo".to_string(), None);
    project.add_section(SectionData {
        shots: vec![ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 2.0,
            depth_in: 10.0,
            depth_out: 11.0,
            ..Default::default()
        }],
        ..Default::default()
    });

    let mut db = Database::open(&path).unwrap();
    db.save_project(&project).unwrap();
    let saved = db.load_project().unwrap();
    let section_id = saved.sections[0].id;
    let shot_id = saved.sections[0].shots[0].id;

    let cmd = legacy_null_style_update_shot_command(section_id, shot_id);
    let undo_data = legacy_null_style_previous_values(section_id, shot_id);
    db.save_undo_stack_with_timestamps(vec![(cmd.clone(), undo_data.clone(), None)])
        .unwrap();
    db.save_redo_stack_with_timestamps(vec![(cmd, undo_data, None)])
        .unwrap();

    // Database::open stamped the current schema version; rewind the stamp so
    // the file looks exactly like one written by a pre-v7 build.
    db.set_user_version(6).unwrap();
    drop(db);

    path
}

#[test]
fn test_legacy_v6_undo_history_dropped_on_open_existing() {
    let temp_dir = TempDir::new().unwrap();
    let path = write_legacy_v6_project_with_undo_history(&temp_dir, "legacy_undo.stalx");

    // Sanity: the legacy payload IS the dangerous shape — under the new
    // deserializer its explicit nulls decode to Some(None) ("clear field").
    let dangerous: crate::models::ShotUpdates = serde_json::from_str(
        r#"{"length":2.0,"left":null,"pitch_in":null,"comment":null}"#,
    )
    .unwrap();
    assert_eq!(dangerous.left, Some(None));
    assert_eq!(dangerous.pitch_in, Some(None));
    assert_eq!(dangerous.comment, Some(None));

    let db = Database::open_existing(&path).unwrap();

    // The v6→v7 migration must have dropped both stacks wholesale.
    assert!(
        db.load_undo_stack_with_timestamps().unwrap().is_empty(),
        "legacy undo entries must not survive the v7 upgrade"
    );
    assert!(
        db.load_redo_stack_with_timestamps().unwrap().is_empty(),
        "legacy redo entries must not survive the v7 upgrade"
    );
    // And the file is now stamped current, so the drop happens exactly once.
    assert_eq!(db.get_user_version().unwrap(), SCHEMA_VERSION);

    // The project data itself is untouched.
    let project = db.load_project().unwrap();
    assert_eq!(project.sections.len(), 1);
    assert_eq!(project.sections[0].shots.len(), 1);
}

#[test]
fn test_legacy_v6_undo_history_dropped_on_open() {
    // Database::open stamps SCHEMA_VERSION without running the migration
    // chain, so it must drop legacy stacks itself before the stamp erases the
    // evidence that the file predates the format change.
    let temp_dir = TempDir::new().unwrap();
    let path = write_legacy_v6_project_with_undo_history(&temp_dir, "legacy_undo_open.stalx");

    let db = Database::open(&path).unwrap();
    assert!(db.load_undo_stack_with_timestamps().unwrap().is_empty());
    assert!(db.load_redo_stack_with_timestamps().unwrap().is_empty());
    assert_eq!(db.get_user_version().unwrap(), SCHEMA_VERSION);
}

#[test]
fn test_new_format_undo_history_survives_reload() {
    use crate::core::undo::{UndoData, UndoEntry};
    use crate::core::{Command, UndoStack};
    use crate::models::ShotUpdates;

    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("new_format_undo.stalx");

    let mut project = Project::new("New Undo".to_string(), None);
    project.add_section(SectionData {
        shots: vec![ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 2.0,
            depth_in: 10.0,
            depth_out: 11.0,
            ..Default::default()
        }],
        ..Default::default()
    });

    let mut db = Database::open(&path).unwrap();
    db.save_project(&project).unwrap();
    let saved = db.load_project().unwrap();
    let section_id = saved.sections[0].id;
    let shot_id = saved.sections[0].shots[0].id;

    // New-format entry: only the edited field is present (untouched nullable
    // fields are omitted thanks to skip_serializing_if).
    let prev_values = ShotUpdates {
        comment: Some(Some("original".to_string())),
        ..Default::default()
    };
    let values_json = serde_json::to_string(&prev_values).unwrap();
    assert!(
        !values_json.contains("left") && !values_json.contains("pitch_in"),
        "untouched nullable fields must serialize as absent, got: {values_json}"
    );
    let entry = UndoEntry {
        command: Command::UpdateShot {
            section_id,
            shot_id,
            updates: ShotUpdates {
                comment: Some(Some("edited".to_string())),
                ..Default::default()
            },
        },
        undo_data: UndoData::PreviousValues {
            section_id,
            shot_id: Some(shot_id),
            values_json,
        },
        timestamp: None,
    };
    let persisted = UndoStack::serialize_entry_with_timestamp(&entry).unwrap();
    db.save_undo_stack_with_timestamps(vec![persisted]).unwrap();
    drop(db);

    // Reload: the v7-stamped file keeps its history.
    let db = Database::open_existing(&path).unwrap();
    let loaded = db.load_undo_stack_with_timestamps().unwrap();
    assert_eq!(loaded.len(), 1, "new-format undo entry must survive reload");

    let (_, cmd_json, undo_json, ts) = &loaded[0];
    let restored =
        UndoStack::deserialize_entry_with_timestamp(cmd_json, undo_json, ts.as_deref()).unwrap();
    match &restored.undo_data {
        UndoData::PreviousValues { values_json, .. } => {
            let prev: ShotUpdates = serde_json::from_str(values_json).unwrap();
            // Exactly the edited field round-trips...
            assert_eq!(prev.comment, Some(Some("original".to_string())));
            // ...and untouched nullable fields stay untouched (None), so
            // replaying this entry cannot clear them.
            assert_eq!(prev.left, None);
            assert_eq!(prev.pitch_in, None);
            assert_eq!(prev.marker_index, None);
            assert_eq!(prev.temperature, None);
        }
        other => panic!("Expected PreviousValues, got {}", other.variant_name()),
    }
}

// === Schema migration idempotency ===

#[test]
fn test_migrate_schema_is_idempotent() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("migrate_idem.stalx");

    // Open creates schema
    {
        let mut db = Database::open(&db_path).unwrap();
        let project = Project::new("Migration".to_string(), None);
        db.save_project(&project).unwrap();
    }

    // Opening again re-runs migrations — should not error
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();
    assert_eq!(loaded.name, "Migration");
}

// === Display settings persistence ===

#[test]
fn test_display_settings_round_trip() {
    let db = Database::in_memory().unwrap();

    db.save_display_setting("show_grid", "true").unwrap();
    db.save_display_setting("grid_spacing", "10").unwrap();

    let settings = db.load_display_settings().unwrap();
    assert_eq!(settings.get("show_grid"), Some(&"true".to_string()));
    assert_eq!(settings.get("grid_spacing"), Some(&"10".to_string()));

    // Overwrite existing setting
    db.save_display_setting("show_grid", "false").unwrap();
    let updated = db.load_display_settings().unwrap();
    assert_eq!(updated.get("show_grid"), Some(&"false".to_string()));

    // Get individual setting
    let val = db.get_display_setting("grid_spacing").unwrap();
    assert_eq!(val, Some("10".to_string()));

    let missing = db.get_display_setting("nonexistent").unwrap();
    assert!(missing.is_none());
}

// === Resolved warnings persistence ===

#[test]
fn test_resolved_warnings_round_trip() {
    let mut db = Database::in_memory().unwrap();

    // Create a project with a section and shot so FK constraints are satisfied
    let mut project = Project::new("Warnings Test".to_string(), None);
    project.add_section(SectionData {
        shots: vec![ShotData {
            azimuth_in: 0.0,
            azimuth_out: 0.0,
            length: 5.0,
            depth_in: 0.0,
            depth_out: 0.0,
            ..Default::default()
        }],
        ..Default::default()
    });
    db.save_project(&project).unwrap();

    // Get the actual section and shot IDs from saved project
    let loaded_project = db.load_project().unwrap();
    let section_id = loaded_project.sections[0].id;
    let shot_id = loaded_project.sections[0].shots[0].id;

    let warning = ResolvedWarning {
        section_id,
        shot_id,
        warning_code: "azimuth_deviation".to_string(),
        resolved_at: Utc::now(),
        resolved_comment: Some("Verified in field".to_string()),
        shot_uuid: None,
    };

    db.save_resolved_warning(&warning).unwrap();

    let loaded = db.load_resolved_warnings().unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].section_id, section_id);
    assert_eq!(loaded[0].shot_id, shot_id);
    assert_eq!(loaded[0].warning_code, "azimuth_deviation");
    assert_eq!(loaded[0].resolved_comment.as_deref(), Some("Verified in field"));

    // Delete it
    db.delete_resolved_warning(section_id, shot_id, "azimuth_deviation", None).unwrap();
    let remaining = db.load_resolved_warnings().unwrap();
    assert!(remaining.is_empty());
}

// === Save-load round-trip with all complex fields ===

#[test]
fn test_save_load_complex_project_round_trip() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("complex_roundtrip.stalx");

    let mut project = Project::new("Complex Cave".to_string(), Some("Deep Location".to_string()));

    // Add section with detailed shots
    let section_a = project.add_section(SectionData {
        name: Some("North Passage".to_string()),
        surveyor: Some("Alice".to_string()),
        date: NaiveDate::from_ymd_opt(2025, 6, 15),
        color: "#ff0000".to_string(),
        direction: Some(SurveyDirection::In),
        quality: 0.8,
        shots: vec![
            ShotData {
                azimuth_in: 0.0,
                azimuth_out: 0.0,
                length: 10.0,
                depth_in: 0.0,
                depth_out: 2.0,
                left: Some(1.0),
                right: Some(2.0),
                up: Some(3.0),
                down: Some(0.5),
                pitch_in: Some(5.0),
                pitch_out: Some(-3.0),
                comment: Some("Good visibility".to_string()),
                ..Default::default()
            },
            ShotData {
                azimuth_in: 45.0,
                azimuth_out: 45.0,
                length: 8.0,
                depth_in: 2.0,
                depth_out: 4.0,
                ..Default::default()
            },
        ],
    }).id;

    let section_b = project.add_section(SectionData {
        name: Some("East Branch".to_string()),
        color: "#00ff00".to_string(),
        direction: Some(SurveyDirection::Out),
        quality: 1.0,
        shots: vec![
            ShotData {
                azimuth_in: 90.0,
                azimuth_out: 90.0,
                length: 5.0,
                depth_in: 0.0,
                depth_out: 1.0,
                ..Default::default()
            },
        ],
        ..Default::default()
    }).id;

    // Add section offsets
    project.section_offsets.insert(section_a, (10.0, -5.0));

    // Add station merge
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_a, 2).into(),
        station_b: StationRef::new(section_b, 0).into(),
        merged_at: Utc::now(),
    });

    // Add zero datum
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(section_a, 0).into(),
        gps: GpsCoordinates::new(45.5, -90.3, 0.0).unwrap(),
    });

    // Add loop closure
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(section_a, 1).into(),
        station_b: StationRef::new(section_b, 0).into(),
        strategy: ClosureStrategy::Move,
        is_aligned: false,
        path_length: 15.0,
        misclosure_distance: 0.3,
        horizontal_misclosure: 0.2,
        vertical_misclosure: 0.15,
        error_percentage: 2.0,
    });

    // Add station offset
    project.station_offsets.insert(StationRef::new(section_a, 1).into(), (0.1, -0.2, 0.05));

    // Save
    {
        let mut db = Database::open(&db_path).unwrap();
        db.save_project(&project).unwrap();
    }

    // Load and verify everything
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.name, "Complex Cave");
    assert_eq!(loaded.location, Some("Deep Location".to_string()));
    assert_eq!(loaded.sections.len(), 2);

    // Verify section A
    let s_a = loaded.sections.iter().find(|s| s.name == Some("North Passage".to_string())).unwrap();
    assert_eq!(s_a.direction, SurveyDirection::In);
    assert!((s_a.quality - 0.8).abs() < 1e-6);
    assert_eq!(s_a.shots.len(), 2);
    assert_eq!(s_a.shots[0].comment, Some("Good visibility".to_string()));
    assert_eq!(s_a.shots[0].left, Some(1.0));
    assert_eq!(s_a.shots[0].pitch_in, Some(5.0));

    // Verify section offsets
    let s_a_id = s_a.id;
    let offset = loaded.section_offsets.get(&s_a_id).unwrap();
    assert!((offset.0 - 10.0).abs() < 1e-10);
    assert!((offset.1 - (-5.0)).abs() < 1e-10);

    // Verify merges
    assert_eq!(loaded.station_merges.len(), 1);
    assert_eq!(loaded.resolve_key(&loaded.station_merges[0].station_a).unwrap().station_index, 2);

    // Verify zero datums
    assert_eq!(loaded.zero_datums.len(), 1);
    assert!((loaded.zero_datums[0].gps.latitude - 45.5).abs() < 1e-6);

    // Verify loop closures
    assert_eq!(loaded.loop_closures.len(), 1);
    assert!((loaded.loop_closures[0].path_length - 15.0).abs() < 1e-6);
    assert_eq!(loaded.loop_closures[0].strategy, ClosureStrategy::Move);

    // Verify station offsets
    let st_offset = loaded.station_offset_for_ref(StationRef::new(s_a_id, 1)).unwrap();
    assert!((st_offset.0 - 0.1).abs() < 1e-10);
    assert!((st_offset.1 - (-0.2)).abs() < 1e-10);
    assert!((st_offset.2 - 0.05).abs() < 1e-10);
}

// =========================================================================
// Recovery: create_numbered_backup
// =========================================================================

#[test]
fn test_create_numbered_backup_first_creates_no_suffix() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("project.stalx");

    // Create a minimal source file
    let db = Database::open(&db_path).unwrap();
    drop(db);

    let backup = Database::create_numbered_backup(&db_path).unwrap();
    assert_eq!(backup, temp_dir.path().join("project.stalx.backup"));
    assert!(backup.exists());
}

#[test]
fn test_create_numbered_backup_second_gets_suffix_1() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("project.stalx");

    let db = Database::open(&db_path).unwrap();
    drop(db);

    // Create first backup
    let first = Database::create_numbered_backup(&db_path).unwrap();
    assert!(first.exists());

    // Second backup should be .backup.1
    let second = Database::create_numbered_backup(&db_path).unwrap();
    assert_eq!(second, temp_dir.path().join("project.stalx.backup.1"));
    assert!(second.exists());
}

#[test]
fn test_create_numbered_backup_increments_until_free_slot() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("project.stalx");

    let db = Database::open(&db_path).unwrap();
    drop(db);

    // Create base + .1 through .3
    for _ in 0..4 {
        Database::create_numbered_backup(&db_path).unwrap();
    }

    let fifth = Database::create_numbered_backup(&db_path).unwrap();
    assert_eq!(fifth, temp_dir.path().join("project.stalx.backup.4"));
}

// =========================================================================
// Recovery: list_backups
// =========================================================================

#[test]
fn test_list_backups_empty_when_no_backups() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("project.stalx");
    std::fs::write(&db_path, b"dummy").unwrap();

    let backups = Database::list_backups(&db_path);
    assert!(backups.is_empty());
}

#[test]
fn test_list_backups_finds_backup_files() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("project.stalx");
    std::fs::write(&db_path, b"original").unwrap();

    // Create backup-named files
    std::fs::write(temp_dir.path().join("project.stalx.backup"), b"backup0").unwrap();
    std::fs::write(temp_dir.path().join("project.stalx.backup.1"), b"backup1").unwrap();
    // A .tmp file for the same stem
    std::fs::write(temp_dir.path().join("project.stalx.tmp"), b"tmp").unwrap();
    // Unrelated file should not appear
    std::fs::write(temp_dir.path().join("other.stalx.backup"), b"other").unwrap();

    let backups = Database::list_backups(&db_path);
    // Should find 3 matching files (project.stalx.backup, .backup.1, .tmp)
    assert_eq!(backups.len(), 3);
    // All paths should contain "project.stalx"
    for b in &backups {
        assert!(b.path.contains("project.stalx"));
    }
}

#[test]
fn test_list_backups_sorted_newest_first() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("project.stalx");
    std::fs::write(&db_path, b"original").unwrap();

    // Create files with slightly different timestamps
    std::fs::write(temp_dir.path().join("project.stalx.backup"), b"old").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));
    std::fs::write(temp_dir.path().join("project.stalx.backup.1"), b"newer").unwrap();

    let backups = Database::list_backups(&db_path);
    assert_eq!(backups.len(), 2);
    // Newest first
    assert!(backups[0].path.contains("backup.1"));
    assert!(backups[1].path.contains(".backup"));
    assert!(!backups[1].path.contains("backup.1"));
}

#[test]
fn test_list_backups_nonexistent_parent_returns_empty() {
    let path = std::path::PathBuf::from("/nonexistent/dir/project.stalx");
    let backups = Database::list_backups(&path);
    assert!(backups.is_empty());
}

#[test]
fn test_list_backups_no_parent_returns_empty() {
    // A bare filename with no parent directory
    let path = std::path::PathBuf::from("project.stalx");
    let backups = Database::list_backups(&path);
    // Should not panic, returns empty or finds matches in current dir
    // Just verify it doesn't crash
    let _ = backups;
}

// =========================================================================
// Recovery: open_for_recovery
// =========================================================================

#[test]
fn test_open_for_recovery_nonexistent_file_fails() {
    let result = Database::open_for_recovery(Path::new("/nonexistent/db.stalx"));
    assert!(result.is_err());
}

#[test]
fn test_open_for_recovery_valid_db_succeeds() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("valid.stalx");

    // Create a valid database
    let mut db = Database::open(&db_path).unwrap();
    let project = Project::new("Recovery Test".to_string(), None);
    db.save_project(&project).unwrap();
    drop(db);

    // Open for recovery should succeed even on a healthy file
    let db = Database::open_for_recovery(&db_path).unwrap();
    // Should be able to query basic info
    let result: String = db.conn.query_row("PRAGMA quick_check", [], |row| row.get(0)).unwrap();
    assert_eq!(result, "ok");
}

// =========================================================================
// Recovery: attempt_repair
// =========================================================================

#[test]
fn test_attempt_repair_on_healthy_db() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("healthy.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let project = Project::new("Repair Test".to_string(), None);
    db.save_project(&project).unwrap();
    drop(db);

    let (backup_path, ok) = Database::attempt_repair(&db_path).unwrap();
    assert!(ok, "Healthy database should pass integrity check after repair");
    assert!(backup_path.exists(), "Backup should exist");

    // Verify original file is still valid
    let db = Database::open_existing(&db_path).unwrap();
    let loaded = db.load_project().unwrap();
    assert_eq!(loaded.name, "Repair Test");
}

// =========================================================================
// Recovery: export_salvageable
// =========================================================================

#[test]
fn test_export_salvageable_from_healthy_db() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("salvage.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let mut project = Project::new("Salvage Test".to_string(), Some("Cave X".to_string()));
    let section = SectionData {
        name: Some("Passage A".to_string()),
        color: "#ff0000".to_string(),
        shots: vec![ShotData::default(), ShotData::default()],
        ..Default::default()
    };
    project.add_section(section);
    db.save_project(&project).unwrap();
    drop(db);

    let salvaged = Database::export_salvageable(&db_path).unwrap();
    assert_eq!(salvaged.project_name.as_deref(), Some("Salvage Test"));
    assert_eq!(salvaged.project_location.as_deref(), Some("Cave X"));
    assert_eq!(salvaged.section_count, 1);
    assert_eq!(salvaged.shot_count, 2);
    assert!(salvaged.sections_json.is_some());
    assert!(salvaged.full_project_json.is_some());
    assert!(salvaged.errors.is_empty());
}

#[test]
fn test_export_salvageable_nonexistent_file_fails() {
    let result = Database::export_salvageable(Path::new("/nonexistent/db.stalx"));
    assert!(result.is_err());
}

// =========================================================================
// Recovery: try_read helpers
// =========================================================================

#[test]
fn test_try_read_metadata_from_empty_db() {
    // In-memory DB with schema but no project data
    let db = Database::in_memory().unwrap();
    let result = db.try_read_project_metadata().unwrap();
    assert!(result.is_none());
}

#[test]
fn test_try_read_metadata_from_populated_db() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("metadata.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let project = Project::new("Meta Project".to_string(), Some("Location X".to_string()));
    db.save_project(&project).unwrap();

    let result = db.try_read_project_metadata().unwrap();
    assert!(result.is_some());
    let (name, location) = result.unwrap();
    assert_eq!(name, "Meta Project");
    assert_eq!(location.as_deref(), Some("Location X"));
}

#[test]
fn test_try_read_sections_from_empty_db() {
    let db = Database::in_memory().unwrap();
    let sections = db.try_read_sections().unwrap();
    assert!(sections.is_empty());
}

#[test]
fn test_try_read_sections_from_populated_db() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("sections.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let mut project = Project::new("Sections Test".to_string(), None);
    project.add_section(SectionData {
        name: Some("Passage A".to_string()),
        color: "#ff0000".to_string(),
        ..Default::default()
    });
    project.add_section(SectionData {
        name: Some("Passage B".to_string()),
        color: "#00ff00".to_string(),
        ..Default::default()
    });
    db.save_project(&project).unwrap();

    let sections = db.try_read_sections().unwrap();
    assert_eq!(sections.len(), 2);
}

#[test]
fn test_try_read_shot_count_empty() {
    let db = Database::in_memory().unwrap();
    let count = db.try_read_shot_count().unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_try_read_merge_count_empty() {
    let db = Database::in_memory().unwrap();
    let count = db.try_read_merge_count().unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_has_project_data_empty_db() {
    let db = Database::in_memory().unwrap();
    assert!(!db.has_project_data().unwrap());
}

#[test]
fn test_has_project_data_with_project() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("has_data.stalx");

    let mut db = Database::open(&db_path).unwrap();
    assert!(!db.has_project_data().unwrap());

    let project = Project::new("Test".to_string(), None);
    db.save_project(&project).unwrap();
    assert!(db.has_project_data().unwrap());
}

// ============================================================================
// Schema migration tests
// ============================================================================

#[test]
fn test_migrate_schema_adds_direction_column() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("migrate_direction.stalx");

    // Create a minimal DB without the direction column
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        r"
        CREATE TABLE project (id INTEGER PRIMARY KEY, name TEXT, location TEXT, created_at TEXT, modified_at TEXT, schema_version INTEGER);
        CREATE TABLE sections (id INTEGER PRIMARY KEY, name TEXT, surveyor TEXT, date TEXT, color TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE shots (id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL, sequence_order INTEGER NOT NULL, azimuth_in REAL, azimuth_out REAL, length REAL, depth_in REAL, depth_out REAL, pitch_in REAL, pitch_out REAL, left_distance REAL, right_distance REAL, up_distance REAL, down_distance REAL, comment TEXT, is_virtual INTEGER DEFAULT 0, marker_index INTEGER, temperature REAL);
        CREATE TABLE station_merges (id INTEGER PRIMARY KEY, station_a_section INTEGER, station_a_index INTEGER, station_b_section INTEGER, station_b_index INTEGER, merged_at TEXT);
        CREATE TABLE zero_datums (id INTEGER PRIMARY KEY, section_id INTEGER, station_index INTEGER, latitude REAL, longitude REAL, depth_reference REAL);
        CREATE TABLE section_offsets (section_id INTEGER PRIMARY KEY, offset_x REAL, offset_y REAL);
        CREATE TABLE loop_closures (id INTEGER PRIMARY KEY, station_a_section INTEGER, station_a_index INTEGER, station_b_section INTEGER, station_b_index INTEGER, path_length REAL, misclosure_distance REAL, error_percentage REAL, horizontal_misclosure REAL, vertical_misclosure REAL);
        INSERT INTO project VALUES (1, 'Test', NULL, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 1);
        INSERT INTO sections VALUES (0, 'Sec1', NULL, NULL, '#ff0000', '2024-01-01T00:00:00Z');
        ",
    ).unwrap();
    drop(conn);

    // Open with Database::open_existing which runs migrations
    let db = Database::open_existing(&db_path).unwrap();
    let project = db.load_project().unwrap();
    assert_eq!(project.sections.len(), 1);
    // Direction should default to 'in' after migration
    assert_eq!(project.sections[0].direction.to_string(), "in");
}

#[test]
fn test_migrate_schema_adds_quality_column() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("migrate_quality.stalx");

    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        r"
        CREATE TABLE project (id INTEGER PRIMARY KEY, name TEXT, location TEXT, created_at TEXT, modified_at TEXT, schema_version INTEGER);
        CREATE TABLE sections (id INTEGER PRIMARY KEY, name TEXT, surveyor TEXT, date TEXT, color TEXT NOT NULL, direction TEXT DEFAULT 'in', created_at TEXT NOT NULL);
        CREATE TABLE shots (id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL, sequence_order INTEGER NOT NULL, azimuth_in REAL, azimuth_out REAL, length REAL, depth_in REAL, depth_out REAL, pitch_in REAL, pitch_out REAL, left_distance REAL, right_distance REAL, up_distance REAL, down_distance REAL, comment TEXT, is_virtual INTEGER DEFAULT 0, marker_index INTEGER, temperature REAL);
        CREATE TABLE station_merges (id INTEGER PRIMARY KEY, station_a_section INTEGER, station_a_index INTEGER, station_b_section INTEGER, station_b_index INTEGER, merged_at TEXT);
        CREATE TABLE zero_datums (id INTEGER PRIMARY KEY, section_id INTEGER, station_index INTEGER, latitude REAL, longitude REAL, depth_reference REAL);
        CREATE TABLE section_offsets (section_id INTEGER PRIMARY KEY, offset_x REAL, offset_y REAL);
        CREATE TABLE loop_closures (id INTEGER PRIMARY KEY, station_a_section INTEGER, station_a_index INTEGER, station_b_section INTEGER, station_b_index INTEGER, path_length REAL, misclosure_distance REAL, error_percentage REAL, horizontal_misclosure REAL, vertical_misclosure REAL);
        INSERT INTO project VALUES (1, 'QualityTest', NULL, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 1);
        INSERT INTO sections VALUES (0, 'Sec1', NULL, NULL, '#00ff00', 'out', '2024-01-01T00:00:00Z');
        ",
    ).unwrap();
    drop(conn);

    let db = Database::open_existing(&db_path).unwrap();
    let project = db.load_project().unwrap();
    // Quality should default to 1.0 after migration
    assert!((project.sections[0].quality - 1.0).abs() < f64::EPSILON);
}

#[test]
fn test_migrate_schema_adds_closure_columns() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("migrate_closure.stalx");

    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        r"
        CREATE TABLE project (id INTEGER PRIMARY KEY, name TEXT, location TEXT, created_at TEXT, modified_at TEXT, schema_version INTEGER);
        CREATE TABLE sections (id INTEGER PRIMARY KEY, name TEXT, surveyor TEXT, date TEXT, color TEXT NOT NULL, direction TEXT DEFAULT 'in', quality REAL DEFAULT 1.0, created_at TEXT NOT NULL);
        CREATE TABLE shots (id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL, sequence_order INTEGER NOT NULL, azimuth_in REAL, azimuth_out REAL, length REAL, depth_in REAL, depth_out REAL, pitch_in REAL, pitch_out REAL, left_distance REAL, right_distance REAL, up_distance REAL, down_distance REAL, comment TEXT, is_virtual INTEGER DEFAULT 0, marker_index INTEGER, temperature REAL);
        CREATE TABLE station_merges (id INTEGER PRIMARY KEY, station_a_section INTEGER, station_a_index INTEGER, station_b_section INTEGER, station_b_index INTEGER, merged_at TEXT);
        CREATE TABLE zero_datums (id INTEGER PRIMARY KEY, section_id INTEGER, station_index INTEGER, latitude REAL, longitude REAL, depth_reference REAL);
        CREATE TABLE section_offsets (section_id INTEGER PRIMARY KEY, offset_x REAL, offset_y REAL);
        CREATE TABLE loop_closures (id INTEGER PRIMARY KEY, station_a_section INTEGER, station_a_index INTEGER, station_b_section INTEGER, station_b_index INTEGER, path_length REAL, misclosure_distance REAL, error_percentage REAL, horizontal_misclosure REAL, vertical_misclosure REAL);
        INSERT INTO project VALUES (1, 'ClosureTest', NULL, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 1);
        INSERT INTO sections VALUES (0, 'Sec1', NULL, NULL, '#ff0000', 'in', 1.0, '2024-01-01T00:00:00Z');
        INSERT INTO loop_closures VALUES (1, 0, 0, 0, 1, 100.0, 0.5, 0.5, 0.3, 0.2);
        ",
    ).unwrap();
    drop(conn);

    let db = Database::open_existing(&db_path).unwrap();
    // Verify migration added closure_id, strategy, and is_aligned columns
    let has_closure_id: bool = db.conn
        .query_row("SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='closure_id'", [], |row| row.get::<_, i64>(0))
        .map(|c| c > 0).unwrap();
    let has_strategy: bool = db.conn
        .query_row("SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='strategy'", [], |row| row.get::<_, i64>(0))
        .map(|c| c > 0).unwrap();
    let has_is_aligned: bool = db.conn
        .query_row("SELECT COUNT(*) FROM pragma_table_info('loop_closures') WHERE name='is_aligned'", [], |row| row.get::<_, i64>(0))
        .map(|c| c > 0).unwrap();

    assert!(has_closure_id, "migration should add closure_id column");
    assert!(has_strategy, "migration should add strategy column");
    assert!(has_is_aligned, "migration should add is_aligned column");
}

#[test]
fn test_migrate_schema_idempotent() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("idempotent.stalx");

    // Create and save a full project
    let mut db = Database::open(&db_path).unwrap();
    let project = Project::new("Idempotent".to_string(), None);
    db.save_project(&project).unwrap();
    drop(db);

    // Open it twice — migration runs both times, second should be a no-op
    let db1 = Database::open_existing(&db_path).unwrap();
    let p1 = db1.load_project().unwrap();
    drop(db1);

    let db2 = Database::open_existing(&db_path).unwrap();
    let p2 = db2.load_project().unwrap();
    drop(db2);

    assert_eq!(p1.name, p2.name);
    assert_eq!(p1.sections.len(), p2.sections.len());
}

// ============================================================================
// Special float values in save/load round-trips
// ============================================================================

#[test]
fn test_save_load_round_trip_extreme_coordinates() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("extreme_coords.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let mut project = Project::new("Extreme".to_string(), None);
    project.add_section(SectionData {
        name: Some("Deep".to_string()),
        color: "#ff0000".to_string(),
        shots: vec![ShotData {
            azimuth_in: 359.9,
            azimuth_out: 0.1,
            length: 999.99,
            depth_in: 0.0,
            depth_out: 999.99,
            pitch_in: Some(-89.9),
            pitch_out: Some(89.9),
            left: Some(0.01),
            right: Some(999.0),
            up: Some(0.0),
            down: Some(0.0),
            temperature: Some(-2.0),
            ..Default::default()
        }],
        ..Default::default()
    });

    db.save_project(&project).unwrap();
    let loaded = db.load_project().unwrap();

    let shot = &loaded.sections[0].shots[0];
    assert!((shot.azimuth_in - 359.9).abs() < 1e-6);
    assert!((shot.azimuth_out - 0.1).abs() < 1e-6);
    assert!((shot.length - 999.99).abs() < 1e-6);
    assert!((shot.depth_out - 999.99).abs() < 1e-6);
    assert!((shot.pitch_in.unwrap() - (-89.9)).abs() < 1e-6);
    assert!((shot.temperature.unwrap() - (-2.0)).abs() < 1e-6);
}

#[test]
fn test_save_load_round_trip_zero_values() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("zeros.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let mut project = Project::new("Zeros".to_string(), None);
    project.add_section(SectionData {
        name: None, // no name
        color: "#000000".to_string(),
        shots: vec![ShotData {
            azimuth_in: 0.0,
            azimuth_out: 0.0,
            length: 0.01, // smallest valid length
            depth_in: 0.0,
            depth_out: 0.0,
            pitch_in: None,
            pitch_out: None,
            left: None,
            right: None,
            up: None,
            down: None,
            comment: None,
            is_reference: false,
            marker_index: None,
            temperature: None,
        }],
        ..Default::default()
    });

    db.save_project(&project).unwrap();
    let loaded = db.load_project().unwrap();

    assert!(loaded.sections[0].name.is_none());
    let shot = &loaded.sections[0].shots[0];
    assert!(shot.pitch_in.is_none());
    assert!(shot.left.is_none());
    assert!(shot.comment.is_none());
    assert!(shot.temperature.is_none());
}

#[test]
fn test_save_load_round_trip_all_metadata() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("all_meta.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let mut project = Project::new("FullMeta".to_string(), Some("Underwater Cave".to_string()));
    project.add_section(SectionData {
        name: Some("Section A".to_string()),
        surveyor: Some("Diver One".to_string()),
        date: Some(NaiveDate::from_ymd_opt(2025, 12, 25).unwrap()),
        color: "#abcdef".to_string(),
        direction: Some(SurveyDirection::Out),
        quality: 0.75,
        shots: vec![ShotData {
            azimuth_in: 90.0,
            azimuth_out: 270.0,
            length: 5.0,
            depth_in: 10.0,
            depth_out: 12.0,
            comment: Some("Test shot".to_string()),
            is_reference: true,
            marker_index: Some(42),
            ..Default::default()
        }],
    });

    // Add station merge, zero datum, section offset, station offset
    let section_id = project.sections[0].id;
    project.add_section(SectionData {
        name: Some("Section B".to_string()),
        color: "#fedcba".to_string(),
        shots: vec![ShotData {
            azimuth_in: 45.0,
            azimuth_out: 225.0,
            length: 3.0,
            depth_in: 0.0,
            depth_out: 1.0,
            ..Default::default()
        }],
        ..Default::default()
    });
    let section_b_id = project.sections[1].id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_id, 1).into(),
        station_b: StationRef::new(section_b_id, 0).into(),
        merged_at: Utc::now(),
    });

    let gps = GpsCoordinates::new(48.8566, 2.3522, 5.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

    // set_zero_datum creates section offsets for all connected sections (A and B are merged),
    // so we don't add a manual section_offset — we just verify the ones set_zero_datum created.
    project.station_offsets.insert(StationRef::new(section_id, 1).into(), (1.0, 2.0, 3.0));
    project.imported_file_hashes.push("abc123def456".to_string());
    project.next_closure_id = 42;

    db.save_project(&project).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.name, "FullMeta");
    assert_eq!(loaded.location.as_deref(), Some("Underwater Cave"));
    assert_eq!(loaded.sections.len(), 2);
    assert_eq!(loaded.sections[0].surveyor.as_deref(), Some("Diver One"));
    assert_eq!(loaded.sections[0].direction.to_string(), "out");
    assert!((loaded.sections[0].quality - 0.75).abs() < 1e-6);
    assert!(loaded.sections[0].shots[0].is_reference);
    assert_eq!(loaded.sections[0].shots[0].marker_index, Some(42));
    assert_eq!(loaded.station_merges.len(), 1);
    assert_eq!(loaded.zero_datums.len(), 1);
    assert!((loaded.zero_datums[0].gps.latitude - 48.8566).abs() < 1e-6);
    // Both sections get offsets from set_zero_datum (they're merged)
    assert_eq!(loaded.section_offsets.len(), 2);
    assert_eq!(loaded.station_offsets.len(), 1);
    assert_eq!(loaded.imported_file_hashes.len(), 1);
    assert_eq!(loaded.imported_file_hashes[0], "abc123def456");
    assert_eq!(loaded.next_closure_id, 42);
}

#[test]
fn test_save_load_round_trip_loop_closures_with_strategy() {
    let temp_dir = TempDir::new().unwrap();
    let db_path = temp_dir.path().join("closure_strategy.stalx");

    let mut db = Database::open(&db_path).unwrap();
    let mut project = Project::new("Closures".to_string(), None);
    project.add_section(SectionData {
        color: "#ff0000".to_string(),
        shots: vec![ShotData { length: 5.0, ..Default::default() }],
        ..Default::default()
    });
    let sec_id = project.sections[0].id;

    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(sec_id, 0).into(),
        station_b: StationRef::new(sec_id, 1).into(),
        path_length: 50.0,
        misclosure_distance: 0.1,
        error_percentage: 0.2,
        horizontal_misclosure: 0.05,
        vertical_misclosure: 0.08,
        strategy: ClosureStrategy::Move,
        is_aligned: true,
    });
    project.loop_closures.push(LoopClosure {
        id: 2,
        station_a: StationRef::new(sec_id, 0).into(),
        station_b: StationRef::new(sec_id, 1).into(),
        path_length: 100.0,
        misclosure_distance: 0.5,
        error_percentage: 0.5,
        horizontal_misclosure: 0.3,
        vertical_misclosure: 0.2,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });
    project.next_closure_id = 3;

    db.save_project(&project).unwrap();
    let loaded = db.load_project().unwrap();

    assert_eq!(loaded.loop_closures.len(), 2);
    let lc1 = &loaded.loop_closures[0];
    assert_eq!(lc1.id, 1);
    assert_eq!(lc1.strategy, ClosureStrategy::Move);
    assert!(lc1.is_aligned);
    assert!((lc1.path_length - 50.0).abs() < 1e-6);

    let lc2 = &loaded.loop_closures[1];
    assert_eq!(lc2.id, 2);
    assert_eq!(lc2.strategy, ClosureStrategy::Batch);
    assert!(!lc2.is_aligned);
    assert_eq!(loaded.next_closure_id, 3);
}

// ── Gzip compression unit tests ─────────────────────────────────────

#[test]
fn test_compress_decompress_round_trip() {
    let original = r#"{"type":"AddSection","data":{"name":"Main"}}"#;
    let compressed = compress_json(original);
    let decompressed = decompress_json(&compressed).unwrap();
    assert_eq!(decompressed, original);
}

#[test]
fn test_compress_produces_gzip_magic_bytes() {
    let compressed = compress_json("hello");
    assert!(compressed.len() >= 2, "compressed output should have at least 2 bytes");
    assert_eq!(compressed[0], 0x1f, "first magic byte");
    assert_eq!(compressed[1], 0x8b, "second magic byte");
}

#[test]
fn test_decompress_plain_utf8_backward_compat() {
    // Old uncompressed TEXT entries should be returned as-is
    let plain = b"plain JSON string";
    let result = decompress_json(plain).unwrap();
    assert_eq!(result, "plain JSON string");
}

#[test]
fn test_decompress_empty_data() {
    let result = decompress_json(b"").unwrap();
    assert_eq!(result, "");
}

#[test]
fn test_compress_empty_string() {
    let compressed = compress_json("");
    let decompressed = decompress_json(&compressed).unwrap();
    assert_eq!(decompressed, "");
}

#[test]
fn test_compress_large_json() {
    // Large repetitive JSON compresses well
    let large = format!(r#"{{"data":[{}]}}"#, "1,".repeat(10_000).trim_end_matches(','));
    let compressed = compress_json(&large);
    let decompressed = decompress_json(&compressed).unwrap();
    assert_eq!(decompressed, large);
    // Compression should be significantly smaller
    assert!(
        compressed.len() < large.len() / 2,
        "compressed ({}) should be much smaller than original ({})",
        compressed.len(),
        large.len()
    );
}

#[test]
fn test_compress_unicode() {
    let unicode = r#"{"name":"Grotte de l'Émeraude","探検":"洞窟"}"#;
    let compressed = compress_json(unicode);
    let decompressed = decompress_json(&compressed).unwrap();
    assert_eq!(decompressed, unicode);
}

#[test]
fn test_decompress_single_byte_not_gzip() {
    // Single byte can't be gzip — should return as lossy UTF-8
    let result = decompress_json(&[0x41]).unwrap();
    assert_eq!(result, "A");
}

#[test]
fn test_undo_stack_round_trips_through_compression() {
    // Verify the full pipeline: save → (compress) → load → (decompress) matches
    let db = Database::in_memory().unwrap();
    let json_with_special_chars = r##"{"color":"#ff0000","value":"hello\nworld"}"##;
    let entries = vec![
        (json_with_special_chars.to_string(), r#"{"undo":"data"}"#.to_string()),
    ];
    db.save_undo_stack(entries).unwrap();
    let loaded = db.load_undo_stack().unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].1, json_with_special_chars);
    assert_eq!(loaded[0].2, r#"{"undo":"data"}"#);
}

#[test]
fn test_migrate_undo_redo_to_blob_on_fresh_db() {
    // Fresh in-memory DB already has BLOB columns (schema v3).
    // Migration should be idempotent and not error.
    let db = Database::in_memory().unwrap();
    db.migrate_undo_redo_to_blob().unwrap();
    // Save and load should still work after migration
    let entries = vec![("cmd".to_string(), "undo".to_string())];
    db.save_undo_stack(entries).unwrap();
    let loaded = db.load_undo_stack().unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].1, "cmd");
}

// === Collaboration mode persistence (schema v5) ===
#[test]
fn test_collab_state_roundtrip() {
    use crate::models::{CollabState, ShotBaselineEntry};
    let mut db = Database::in_memory().unwrap();
    let mut project = Project::new("Collab Cave".to_string(), None);
    let mut collab = CollabState::new("collab-cave.tml".to_string());
    collab.last_export_tml_sha256 = Some("deadbeef".to_string());
    collab.shot_baseline = vec![ShotBaselineEntry {
        section_id: 0,
        shot_index: 3,
        ariane_id: 42,
        uuid: "11111111-2222-3333-4444-555555555555".to_string(),
        geo_key: "351.5|2.27|0.10".to_string(),
        section_name: "Mainline 2".to_string(),
        station_comment: None,
    }];
    collab.section_name_map = vec![("Mainline 2".to_string(), 0)];
    project.collab = Some(collab);

    db.save_project(&project).unwrap();
    let loaded = db.load_project().unwrap();

    let c = loaded.collab.expect("collab state should round-trip");
    assert!(c.enabled);
    assert_eq!(c.sibling_tml_relative, "collab-cave.tml");
    assert_eq!(c.last_export_tml_sha256.as_deref(), Some("deadbeef"));
    assert_eq!(c.shot_baseline.len(), 1);
    assert_eq!(c.shot_baseline[0].ariane_id, 42);
    assert_eq!(c.shot_baseline[0].shot_index, 3);
    assert_eq!(c.section_name_map, vec![("Mainline 2".to_string(), 0)]);
    assert!(c.write_tml_on_autosave);
}

#[test]
fn test_collab_none_when_absent() {
    // A normal (non-collab) project must load with collab == None,
    // proving collaboration persistence doesn't affect existing projects.
    let mut db = Database::in_memory().unwrap();
    let project = Project::new("Plain Cave".to_string(), None);
    assert!(project.collab.is_none());
    db.save_project(&project).unwrap();
    let loaded = db.load_project().unwrap();
    assert!(loaded.collab.is_none());
}

#[test]
fn test_save_collab_state_upsert() {
    use crate::models::CollabState;
    let mut db = Database::in_memory().unwrap();
    let project = Project::new("Upsert Cave".to_string(), None);
    db.save_project(&project).unwrap();

    // Upsert a state without rewriting the whole project.
    db.save_collab_state(Some(&CollabState::new("up.tml".to_string()))).unwrap();
    assert_eq!(
        db.load_project().unwrap().collab.unwrap().sibling_tml_relative,
        "up.tml"
    );
    // Upsert again (ON CONFLICT path).
    let mut c2 = CollabState::new("up.tml".to_string());
    c2.last_export_tml_sha256 = Some("abc".to_string());
    db.save_collab_state(Some(&c2)).unwrap();
    assert_eq!(
        db.load_project().unwrap().collab.unwrap().last_export_tml_sha256.as_deref(),
        Some("abc")
    );
    // Clearing removes the row.
    db.save_collab_state(None).unwrap();
    assert!(db.load_project().unwrap().collab.is_none());
}

#[test]
fn two_dangling_station_offsets_in_one_section_save_without_pk_collision() {
    // Regression for the save crash (review finding #7): two dangling station
    // offsets in one section both used to resolve to (section, 0) via
    // key_to_ref_lossy and collide on the (section_id, station_index) PRIMARY
    // KEY, aborting the entire save. The persistence layer now skips a key that
    // doesn't resolve, so the save succeeds and the dangling offsets are dropped
    // (not persisted as phantom station-0 rows).
    let mut db = Database::in_memory().unwrap();
    let mut project = Project::new("Dangling".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![ShotData { length: 5.0, ..Default::default() }],
            ..Default::default()
        })
        .id;
    project.ensure_shot_uuids();
    project
        .station_offsets
        .insert(StationKey::new(a, StationAnchor::AfterShot("ghost-1".into())), (1.0, 0.0, 0.0));
    project
        .station_offsets
        .insert(StationKey::new(a, StationAnchor::AfterShot("ghost-2".into())), (2.0, 0.0, 0.0));

    db.save_project(&project)
        .expect("save must not PK-collide on two dangling offsets");

    let loaded = db.load_project().unwrap();
    assert!(
        loaded.station_offsets.is_empty(),
        "dangling offsets are dropped on save, not written as phantom station-0 rows"
    );
}

// === Raw table browsing ===

#[test]
fn test_list_raw_table_names_excludes_sqlite_internal() {
    let mut db = Database::in_memory().unwrap();
    let project = Project::new("Raw Cave".to_string(), None);
    db.save_project(&project).unwrap();

    let names = db.list_raw_table_names().unwrap();
    assert!(names.iter().any(|n| n == "project"));
    assert!(names.iter().any(|n| n == "sections"));
    assert!(names.iter().any(|n| n == "shots"));
    assert!(!names.iter().any(|n| n.starts_with("sqlite_")));
}

#[test]
fn test_read_raw_table_stringifies_values() {
    let db = Database::in_memory().unwrap();
    db.conn
        .execute_batch(
            "CREATE TABLE mixed (i INTEGER, r REAL, t TEXT, b BLOB, n TEXT);
             INSERT INTO mixed VALUES (42, 1.5, 'hello', x'0102030405', NULL);",
        )
        .unwrap();

    let data = db.read_raw_table("mixed", 100, 0).unwrap();
    assert_eq!(data.columns, vec!["i", "r", "t", "b", "n"]);
    assert_eq!(data.total_rows, 1);
    assert_eq!(
        data.rows,
        vec![vec![
            "42".to_string(),
            "1.5".to_string(),
            "hello".to_string(),
            "<blob 5 B>".to_string(),
            "NULL".to_string(),
        ]]
    );
}

#[test]
fn test_read_raw_table_rejects_unknown_names() {
    let mut db = Database::in_memory().unwrap();
    let project = Project::new("Inject Cave".to_string(), None);
    db.save_project(&project).unwrap();

    // Injection attempts and internal tables must be rejected by the
    // exact-member guard, never interpolated into SQL.
    for name in [
        "shots; DROP TABLE shots",
        "shots\" --",
        "sqlite_master",
        "no_such_table",
        "",
    ] {
        let err = db.read_raw_table(name, 100, 0).unwrap_err();
        assert!(
            err.to_string().contains("Unknown table"),
            "expected rejection for {name:?}, got: {err}"
        );
    }
    // The guard must not have damaged anything.
    assert!(db.read_raw_table("shots", 100, 0).is_ok());
}

#[test]
fn test_read_raw_table_limit_clamp_and_offset_paging() {
    let db = Database::in_memory().unwrap();
    db.conn
        .execute_batch(
            "CREATE TABLE big (v INTEGER);
             INSERT INTO big (v)
             WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10050)
             SELECT x FROM cnt;",
        )
        .unwrap();

    // Oversized limit is clamped to MAX_RAW_PAGE_ROWS.
    let page = db.read_raw_table("big", u32::MAX, 0).unwrap();
    assert_eq!(page.total_rows, 10_050);
    assert_eq!(page.rows.len(), MAX_RAW_PAGE_ROWS as usize);

    // Offset paging returns the remaining rows past the clamp boundary.
    let rest = db.read_raw_table("big", u32::MAX, 10_000).unwrap();
    assert_eq!(rest.total_rows, 10_050);
    assert_eq!(rest.rows.len(), 50);

    // Small pages line up back-to-back.
    let first = db.read_raw_table("big", 2, 0).unwrap();
    let second = db.read_raw_table("big", 2, 2).unwrap();
    assert_eq!(first.rows[0], vec!["1".to_string()]);
    assert_eq!(first.rows[1], vec!["2".to_string()]);
    assert_eq!(second.rows[0], vec!["3".to_string()]);
    assert_eq!(second.rows[1], vec!["4".to_string()]);
}

#[test]
fn test_format_blob_placeholder_units() {
    assert_eq!(format_blob_placeholder(0), "<blob 0 B>");
    assert_eq!(format_blob_placeholder(512), "<blob 512 B>");
    assert_eq!(format_blob_placeholder(1024), "<blob 1.0 KB>");
    assert_eq!(format_blob_placeholder(4300), "<blob 4.2 KB>");
    assert_eq!(format_blob_placeholder(1024 * 1024), "<blob 1.0 MB>");
    assert_eq!(format_blob_placeholder(3 * 1024 * 1024 + 512 * 1024), "<blob 3.5 MB>");
    assert_eq!(format_blob_placeholder(2 * 1024 * 1024 * 1024), "<blob 2.0 GB>");
}
