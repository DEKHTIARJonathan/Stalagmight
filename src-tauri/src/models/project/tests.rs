use super::*;

fn shot(azimuth_in: f64, azimuth_out: f64, length: f64, depth_in: f64, depth_out: f64) -> ShotData {
    ShotData {
        azimuth_in,
        azimuth_out,
        length,
        depth_in,
        depth_out,
        ..Default::default()
    }
}

#[test]
fn get_connected_section_ids_traverses_merges() {
    let mut project = Project::new("Merged".to_string(), None);
    let a = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let b = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let c = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(b, 0),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    let connected = project.get_connected_section_ids(a);
    assert!(connected.contains(&a));
    assert!(connected.contains(&b));
    assert!(connected.contains(&c));
    assert_eq!(connected.len(), 3);
}

#[test]
fn section_has_zero_datum_with_connected_merges() {
    let mut project = Project::new("Zero".to_string(), None);
    let a = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let b = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let c = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let d = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(b, 0),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(c, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });

    assert!(project.section_has_zero_datum(a));
    assert!(!project.section_has_zero_datum(d));
}

#[test]
fn compute_station_raw_coords_applies_offsets_and_bounds() {
    let mut project = Project::new("Coords".to_string(), None);
    let shot_a = shot(0.0, 0.0, 10.0, 0.0, 0.0);
    let shot_b = shot(90.0, 90.0, 5.0, 0.0, 2.0);
    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot_a.clone(),
                shot_b.clone(),
            ],
            ..Default::default()
        })
        .id;

    project.section_offsets.insert(section_id, (2.0, -3.0));

    let coords = project
        .compute_station_raw_coords(StationRef::new(section_id, 2))
        .expect("coords");
    let expected_x = 2.0 + shot_b.horizontal_length();
    let expected_y = -3.0 + shot_a.horizontal_length();
    assert!((coords.x - expected_x).abs() < 1e-6);
    assert!((coords.y - expected_y).abs() < 1e-6);
    assert!((coords.z - 2.0).abs() < 1e-6);

    let invalid = project.compute_station_raw_coords(StationRef::new(section_id, 5));
    assert!(invalid.is_none());
}

#[test]
fn set_zero_datum_first_datum_positions_station_at_origin() {
    let mut project = Project::new("FirstDatum".to_string(), None);
    // Create a section with a shot going north (azimuth 0)
    let shot_a = shot(0.0, 0.0, 10.0, 0.0, 1.0);
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot_a.clone()],
            ..Default::default()
        })
        .id;

    // Station 1 is at (0, 10, 1) before datum is set
    let station_ref = StationRef::new(section_id, 1);
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();

    // Set first datum on station 1
    project.set_zero_datum(station_ref, gps).unwrap();

    // Check that offset was applied to move station to origin
    let offset = project.section_offsets.get(&section_id).unwrap();
    // Station was at (0, horizontal), needs offset (-0, -horizontal) to be at origin
    assert!((offset.0 - 0.0).abs() < 1e-6, "Expected x offset ~0, got {}", offset.0);
    let expected_y_offset = -shot_a.horizontal_length();
    assert!(
        (offset.1 - expected_y_offset).abs() < 1e-6,
        "Expected y offset ~{}, got {}",
        expected_y_offset,
        offset.1
    );

    // Verify station coordinates after applying offset
    let coords = project.compute_station_raw_coords(station_ref).unwrap();
    assert!((coords.x).abs() < 1e-6, "Expected x ~0, got {}", coords.x);
    assert!((coords.y).abs() < 1e-6, "Expected y ~0, got {}", coords.y);
    // Z should be preserved
    assert!((coords.z - 1.0).abs() < 1e-6, "Expected z ~1, got {}", coords.z);
}

#[test]
fn set_zero_datum_connected_sections_move_together() {
    let mut project = Project::new("Connected".to_string(), None);
    // Create two sections
    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Merge section b's station 0 to section a's station 1
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Record positions before setting datum
    // Section a station 1 is at (0, 10) before datum (shot goes north)
    // Section b station 0 is at (0, 0) before datum (no offset yet)
    // Section b station 1 is at (5, 0) before datum (shot goes east)
    let coords_b1_before = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!((coords_b1_before.x - 5.0).abs() < 1e-6, "Pre-datum b.1 x should be 5");
    assert!((coords_b1_before.y - 0.0).abs() < 1e-6, "Pre-datum b.1 y should be 0");

    // Set datum on section a, station 1 (which is at y=10 before datum)
    // This should move all connected sections so a.1 lands at origin
    let station_ref = StationRef::new(a, 1);
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(station_ref, gps).unwrap();

    // Both sections should have offsets applied
    assert!(project.section_offsets.contains_key(&a));
    assert!(project.section_offsets.contains_key(&b));

    // Section a station 1 (datum station) should be at origin
    let coords_a1 = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
    assert!((coords_a1.x).abs() < 1e-6, "Datum station x should be 0, got {}", coords_a1.x);
    assert!((coords_a1.y).abs() < 1e-6, "Datum station y should be 0, got {}", coords_a1.y);

    // Section a station 0 should be at (0, -10) since it's 10m south of the datum
    let coords_a0 = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    assert!((coords_a0.x).abs() < 1e-6, "a.0 x should be 0, got {}", coords_a0.x);
    assert!((coords_a0.y - (-10.0)).abs() < 1e-6, "a.0 y should be -10, got {}", coords_a0.y);

    // Section b should have moved by the same delta as section a
    // Before: b.1 was at (5, 0). After: b.1 should be at (5, -10)
    // (The offset delta was (0, -10) to move a.1 from (0, 10) to (0, 0))
    let coords_b1_after = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!(
        (coords_b1_after.x - 5.0).abs() < 1e-6,
        "b.1 x should be 5, got {}",
        coords_b1_after.x
    );
    assert!(
        (coords_b1_after.y - (-10.0)).abs() < 1e-6,
        "b.1 y should be -10 (moved with connected sections), got {}",
        coords_b1_after.y
    );
}

#[test]
fn set_zero_datum_subsequent_datum_uses_gps_offset() {
    let mut project = Project::new("SubsequentDatum".to_string(), None);
    // Create two unconnected sections
    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Set first datum on section a, station 0
    let gps_a = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(a, 0), gps_a).unwrap();

    // Section a station 0 should be at origin
    let coords_a0 = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    assert!((coords_a0.x).abs() < 1e-6);
    assert!((coords_a0.y).abs() < 1e-6);

    // Set second datum on section b with GPS offset
    // At equator, 0.01 degree longitude ~ 1113 meters east
    let gps_b = GpsCoordinates::new(0.0, 0.01, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(b, 0), gps_b).unwrap();

    // Section b station 0 should be at approximately (1113, 0)
    let coords_b0 = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
    assert!(
        (coords_b0.x - 1113.2).abs() < 10.0,
        "Expected x ~1113, got {}",
        coords_b0.x
    );
    assert!(coords_b0.y.abs() < 10.0, "Expected y ~0, got {}", coords_b0.y);
}

#[test]
fn set_zero_datum_z_coordinates_preserved() {
    let mut project = Project::new("PreserveZ".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 5.0),
                shot(0.0, 0.0, 10.0, 5.0, 12.0),
            ],
            ..Default::default()
        })
        .id;

    // Set datum on station 1 (which has z=5)
    let station_ref = StationRef::new(section_id, 1);
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(station_ref, gps).unwrap();

    // Check all stations have preserved z coordinates
    let coords_0 = project.compute_station_raw_coords(StationRef::new(section_id, 0)).unwrap();
    let coords_1 = project.compute_station_raw_coords(StationRef::new(section_id, 1)).unwrap();
    let coords_2 = project.compute_station_raw_coords(StationRef::new(section_id, 2)).unwrap();

    assert!((coords_0.z - 0.0).abs() < 1e-6, "Station 0 z should be 0");
    assert!((coords_1.z - 5.0).abs() < 1e-6, "Station 1 z should be 5");
    assert!((coords_2.z - 12.0).abs() < 1e-6, "Station 2 z should be 12");
}

#[test]
fn remove_zero_datum_keeps_positions_unchanged() {
    let mut project = Project::new("RemoveDatum".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Set datum
    let station_ref = StationRef::new(section_id, 1);
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(station_ref, gps).unwrap();

    // Record offset after setting datum
    let offset_before = project.section_offsets.get(&section_id).copied();

    // Remove datum
    project.remove_zero_datum(station_ref);

    // Offset should be unchanged
    let offset_after = project.section_offsets.get(&section_id).copied();
    assert_eq!(offset_before, offset_after, "Offset should not change when removing datum");
}

#[test]
fn update_first_datum_gps_keeps_station_at_origin() {
    // Issue: Re-setting the first datum should not move it away from origin
    let mut project = Project::new("UpdateFirstDatum".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Set first datum on station 1 (which is at y=10 before datum)
    let station_ref = StationRef::new(section_id, 1);
    let gps1 = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(station_ref, gps1).unwrap();

    // Station 1 should be at origin
    let coords_after_first = project.compute_station_raw_coords(station_ref).unwrap();
    assert!((coords_after_first.x).abs() < 1e-6, "First datum: x should be 0");
    assert!((coords_after_first.y).abs() < 1e-6, "First datum: y should be 0");
    let offset_after_first = project.section_offsets.get(&section_id).copied().unwrap();

    // Update the first datum with different GPS coordinates
    let gps2 = GpsCoordinates::new(46.0, -91.0, 0.0).unwrap();
    project.set_zero_datum(station_ref, gps2).unwrap();

    // Station 1 should STILL be at origin (updating first datum doesn't reposition)
    let coords_after_update = project.compute_station_raw_coords(station_ref).unwrap();
    assert!(
        (coords_after_update.x).abs() < 1e-6,
        "After update: x should still be 0, got {}",
        coords_after_update.x
    );
    assert!(
        (coords_after_update.y).abs() < 1e-6,
        "After update: y should still be 0, got {}",
        coords_after_update.y
    );

    // Offset should be unchanged (no repositioning happened)
    let offset_after_update = project.section_offsets.get(&section_id).copied().unwrap();
    assert_eq!(
        offset_after_first, offset_after_update,
        "Offset should not change when updating first datum GPS"
    );

    // GPS should be updated
    assert_eq!(project.zero_datums[0].gps.latitude, 46.0);
    assert_eq!(project.zero_datums[0].gps.longitude, -91.0);
}

#[test]
fn store_zero_datum_without_repositioning_does_not_modify_offsets() {
    let mut project = Project::new("StoreOnly".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Pre-set an offset manually (simulating merged project scenario)
    project.section_offsets.insert(section_id, (100.0, 200.0));

    // Store datum without repositioning
    let station_ref = StationRef::new(section_id, 0);
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.store_zero_datum_without_repositioning(station_ref, gps).unwrap();

    // Offset should remain unchanged
    let offset = project.section_offsets.get(&section_id).unwrap();
    assert_eq!(*offset, (100.0, 200.0), "Offset should not be modified");

    // But datum should be stored
    assert_eq!(project.zero_datums.len(), 1);
    assert_eq!(project.zero_datums[0].station_ref, station_ref);
}

#[test]
fn coordinate_computation_no_global_datum_subtraction() {
    // Verify that compute_station_coordinates no longer subtracts primary datum
    let mut project = Project::new("NoGlobalSubtract".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Add a datum directly to zero_datums (bypassing set_zero_datum to avoid offset computation)
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(section_id, 1),
        gps: GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
    });

    // Compute coordinates
    let stations = project.compute_station_coordinates();

    // Station 0 should be at (0, 0) - no global subtraction
    let station_0 = stations.iter().find(|s| s.station_ref == StationRef::new(section_id, 0)).unwrap();
    assert!((station_0.coordinates.x).abs() < 1e-6);
    assert!((station_0.coordinates.y).abs() < 1e-6);

    // Station 1 should be at (0, 10) - no global subtraction
    let station_1 = stations.iter().find(|s| s.station_ref == StationRef::new(section_id, 1)).unwrap();
    assert!((station_1.coordinates.x).abs() < 1e-6);
    assert!((station_1.coordinates.y - 10.0).abs() < 1e-6);
}

#[test]
fn merge_stations_propagates_datum_positioning_a_into_b() {
    // Test: Section without datum merges into section group with datum
    // The merged section should be repositioned relative to the datum
    let mut project = Project::new("MergeDatumA".to_string(), None);

    // Section A: has datum, shot goes north 10m
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Set datum on A.0 (positions A.0 at origin)
    project.set_zero_datum(
        StationRef::new(a, 0),
        GpsCoordinates::new(45.0, -90.0, 0.0).unwrap()
    ).unwrap();

    // Verify A is positioned correctly before merge
    let a0_coords = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    assert!((a0_coords.x).abs() < 1e-6, "A.0 x should be 0");
    assert!((a0_coords.y).abs() < 1e-6, "A.0 y should be 0");
    let a1_coords = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
    assert!((a1_coords.y - 10.0).abs() < 1e-6, "A.1 y should be 10");

    // Section B: no datum, shot goes east 5m
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge B.0 into A.1 (B merges into datum group)
    project.merge_stations(
        StationRef::new(a, 1),
        StationRef::new(b, 0),
    ).unwrap();

    // After merge, B should be positioned in datum coordinate system
    // B.0 should be at A.1's position (0, 10)
    let b0_coords = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
    assert!((b0_coords.x).abs() < 1e-6, "B.0 x should be 0, got {}", b0_coords.x);
    assert!((b0_coords.y - 10.0).abs() < 1e-6, "B.0 y should be 10, got {}", b0_coords.y);

    // B.1 should be at (5, 10) - 5m east of B.0
    let b1_coords = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!((b1_coords.x - 5.0).abs() < 1e-6, "B.1 x should be 5, got {}", b1_coords.x);
    assert!((b1_coords.y - 10.0).abs() < 1e-6, "B.1 y should be 10, got {}", b1_coords.y);

    // A's positions should be unchanged
    let a0_after = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    assert!((a0_after.x).abs() < 1e-6, "A.0 x should still be 0");
    assert!((a0_after.y).abs() < 1e-6, "A.0 y should still be 0");
}

#[test]
fn merge_stations_propagates_datum_positioning_b_into_a() {
    // Test: Section with datum merges with section without datum
    // The non-datum section should be repositioned
    let mut project = Project::new("MergeDatumB".to_string(), None);

    // Section A: no datum, shot goes north 10m
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Section B: has datum, shot goes east 5m
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Set datum on B.0 (positions B.0 at origin)
    project.set_zero_datum(
        StationRef::new(b, 0),
        GpsCoordinates::new(45.0, -90.0, 0.0).unwrap()
    ).unwrap();

    // Verify B is positioned correctly before merge
    let b0_coords = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
    assert!((b0_coords.x).abs() < 1e-6, "B.0 x should be 0");
    assert!((b0_coords.y).abs() < 1e-6, "B.0 y should be 0");

    // Merge A.0 into B.1 (A merges into datum group)
    // B.1 is at (5, 0)
    project.merge_stations(
        StationRef::new(a, 0),
        StationRef::new(b, 1),
    ).unwrap();

    // After merge, A should be positioned in datum coordinate system
    // A.0 should be at B.1's position (5, 0)
    let a0_coords = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    assert!((a0_coords.x - 5.0).abs() < 1e-6, "A.0 x should be 5, got {}", a0_coords.x);
    assert!((a0_coords.y).abs() < 1e-6, "A.0 y should be 0, got {}", a0_coords.y);

    // A.1 should be at (5, 10) - 10m north of A.0
    let a1_coords = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
    assert!((a1_coords.x - 5.0).abs() < 1e-6, "A.1 x should be 5, got {}", a1_coords.x);
    assert!((a1_coords.y - 10.0).abs() < 1e-6, "A.1 y should be 10, got {}", a1_coords.y);

    // B's positions should be unchanged
    let b0_after = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
    assert!((b0_after.x).abs() < 1e-6, "B.0 x should still be 0");
    assert!((b0_after.y).abs() < 1e-6, "B.0 y should still be 0");
}

#[test]
fn merge_stations_without_datum_aligns_first_section_to_second() {
    // Test: No datum present; the first section should move to align with the second.
    let mut project = Project::new("MergeNoDatum".to_string(), None);

    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    let a1_before = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
    let b0_before = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
    assert!((a1_before.y - 10.0).abs() < 1e-6);
    assert!((b0_before.x).abs() < 1e-6);
    assert!((b0_before.y).abs() < 1e-6);

    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();

    let a1_after = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
    let b0_after = project.compute_station_raw_coords(StationRef::new(b, 0)).unwrap();
    assert!((a1_after.x - b0_after.x).abs() < 1e-6);
    assert!((a1_after.y - b0_after.y).abs() < 1e-6);

    let offset_a = project.section_offsets.get(&a).copied().unwrap_or((0.0, 0.0));
    assert!((offset_a.0).abs() < 1e-6);
    assert!((offset_a.1 + 10.0).abs() < 1e-6);

    let offset_b = project.section_offsets.get(&b).copied().unwrap_or((0.0, 0.0));
    assert!((offset_b.0).abs() < 1e-6);
    assert!((offset_b.1).abs() < 1e-6);
}

#[test]
fn merge_stations_transitive_datum_propagation() {
    // Test: Merge into a section that's connected to a datum group through another merge
    // C merges into B, which is already merged with datum-holding A
    let mut project = Project::new("TransitiveDatum".to_string(), None);

    // Section A: has datum, shot goes north 10m
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Set datum on A.0
    project.set_zero_datum(
        StationRef::new(a, 0),
        GpsCoordinates::new(45.0, -90.0, 0.0).unwrap()
    ).unwrap();

    // Section B: shot goes east 5m (will be connected to A)
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge B.0 into A.1 - B now connected to datum group
    project.merge_stations(
        StationRef::new(a, 1),
        StationRef::new(b, 0),
    ).unwrap();

    // Section C: shot goes south 3m
    let c = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Verify B.1 position before merging C
    // B.1 should be at (5, 10) - B.0 at (0, 10), B.1 5m east
    let b1_before = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!((b1_before.x - 5.0).abs() < 1e-6, "B.1 x should be 5");
    assert!((b1_before.y - 10.0).abs() < 1e-6, "B.1 y should be 10");

    // Merge C.0 into B.1 - C should be positioned via transitive datum
    project.merge_stations(
        StationRef::new(b, 1),
        StationRef::new(c, 0),
    ).unwrap();

    // C.0 should be at B.1's position (5, 10)
    let c0_coords = project.compute_station_raw_coords(StationRef::new(c, 0)).unwrap();
    assert!((c0_coords.x - 5.0).abs() < 1e-6, "C.0 x should be 5, got {}", c0_coords.x);
    assert!((c0_coords.y - 10.0).abs() < 1e-6, "C.0 y should be 10, got {}", c0_coords.y);

    // C.1 should be at (5, 7) - 3m south of C.0
    let c1_coords = project.compute_station_raw_coords(StationRef::new(c, 1)).unwrap();
    assert!((c1_coords.x - 5.0).abs() < 1e-6, "C.1 x should be 5, got {}", c1_coords.x);
    assert!((c1_coords.y - 7.0).abs() < 1e-6, "C.1 y should be 7, got {}", c1_coords.y);
}

// === Duplicate datum validation tests ===

#[test]
fn set_zero_datum_rejects_duplicate_in_same_section() {
    // Cannot set two datums on different stations in the same section
    let mut project = Project::new("DuplicateSameSection".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    // Set first datum on station 0
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

    // Attempt to set second datum on station 1 (same section) - should fail
    let result = project.set_zero_datum(StationRef::new(section_id, 1), gps);
    assert!(result.is_err(), "Should reject duplicate datum in same section");
    let err = result.unwrap_err();
    assert!(err.contains("already has a zero datum"), "Error should mention existing datum: {}", err);
}

#[test]
fn set_zero_datum_rejects_duplicate_in_connected_group() {
    // Cannot set datum on a station connected through merges to another datum station
    let mut project = Project::new("DuplicateConnected".to_string(), None);

    // Create two sections
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge B.0 to A.1
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Set first datum on section A
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(a, 0), gps).unwrap();

    // Attempt to set second datum on section B (connected through merge) - should fail
    let result = project.set_zero_datum(StationRef::new(b, 1), gps);
    assert!(result.is_err(), "Should reject duplicate datum in connected group");
    let err = result.unwrap_err();
    assert!(err.contains("already has a zero datum"), "Error should mention existing datum: {}", err);
}

#[test]
fn set_zero_datum_allows_disconnected_groups() {
    // Disconnected section groups can each have their own datum
    let mut project = Project::new("DisconnectedGroups".to_string(), None);

    // Create two unconnected sections
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Set datum on section A
    let gps_a = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(a, 0), gps_a).unwrap();

    // Set datum on section B (disconnected) - should succeed
    let gps_b = GpsCoordinates::new(46.0, -91.0, 0.0).unwrap();
    let result = project.set_zero_datum(StationRef::new(b, 0), gps_b);
    assert!(result.is_ok(), "Disconnected groups should each allow their own datum");
    assert_eq!(project.zero_datums.len(), 2);
}

#[test]
fn set_zero_datum_error_includes_section_name() {
    // Error message should include section name if available
    let mut project = Project::new("NamedSection".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            name: Some("Main Passage".to_string()),
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Set first datum
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

    // Attempt duplicate
    let result = project.set_zero_datum(StationRef::new(section_id, 1), gps);
    let err = result.unwrap_err();

    // Error should include section name
    assert!(err.contains("Main Passage"), "Error should include section name: {}", err);
}

#[test]
fn set_zero_datum_error_includes_station_number() {
    // Error message should include station numbers (0-indexed to match canonical IDs)
    let mut project = Project::new("StationNumbers".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    // Set first datum on station 0
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

    // Attempt to set on station 2
    let result = project.set_zero_datum(StationRef::new(section_id, 2), gps);
    let err = result.unwrap_err();

    // Error should reference stations with 0-indexed format (e.g., "Section 0 #2")
    assert!(err.contains("#2"), "New station should include #2: {}", err);
    assert!(err.contains("#0"), "Existing datum station should include #0: {}", err);
}

#[test]
fn set_zero_datum_validation_runs_before_state_changes() {
    // Validation should reject before any section offsets are modified
    let mut project = Project::new("NoStateChange".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Set first datum
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

    // Record state before failed attempt
    let offset_before = project.section_offsets.get(&section_id).copied();
    let datums_count_before = project.zero_datums.len();

    // Attempt duplicate (should fail)
    let result = project.set_zero_datum(StationRef::new(section_id, 1), gps);
    assert!(result.is_err());

    // State should be unchanged
    let offset_after = project.section_offsets.get(&section_id).copied();
    assert_eq!(offset_before, offset_after, "Section offset should not change on validation failure");
    assert_eq!(datums_count_before, project.zero_datums.len(), "Zero datums count should not change");
}

#[test]
fn set_zero_datum_allows_resetting_same_station() {
    // Re-setting datum on the same station (updating GPS) should succeed
    let mut project = Project::new("ResetSame".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Set datum
    let gps1 = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 0), gps1).unwrap();

    // Re-set on same station with different GPS - should succeed
    let gps2 = GpsCoordinates::new(46.0, -91.0, 0.0).unwrap();
    let result = project.set_zero_datum(StationRef::new(section_id, 0), gps2);
    assert!(result.is_ok(), "Resetting same station should succeed");

    // Should still have only one datum
    assert_eq!(project.zero_datums.len(), 1);
    assert_eq!(project.zero_datums[0].gps.latitude, 46.0);
}

#[test]
fn store_zero_datum_without_repositioning_validates_duplicate() {
    // The store-only helper should also validate for duplicates
    let mut project = Project::new("StoreOnlyValidation".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Set first datum normally
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

    // Attempt store-only on different station - should fail
    let result = project.store_zero_datum_without_repositioning(StationRef::new(section_id, 1), gps);
    assert!(result.is_err(), "Store-only should also validate for duplicates");
}

#[test]
fn find_connected_zero_datum_uses_station_connectivity() {
    // Validation should use station-level connectivity (through shots within section)
    // not just section-level connectivity
    let mut project = Project::new("StationConnectivity".to_string(), None);

    // Single section with multiple stations - all connected through shots
    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    // Set datum on station 1 (middle)
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 1), gps).unwrap();

    // Station 0 is connected to station 1 through shot 0
    let result_0 = project.set_zero_datum(StationRef::new(section_id, 0), gps);
    assert!(result_0.is_err(), "Station 0 should be connected to datum at station 1");

    // Station 3 is connected to station 1 through shots 1 and 2
    let result_3 = project.set_zero_datum(StationRef::new(section_id, 3), gps);
    assert!(result_3.is_err(), "Station 3 should be connected to datum at station 1");
}

// === Loop closure tests ===

#[test]
fn create_loop_closure_creates_correct_values() {
    let mut project = Project::new("ClosureTest".to_string(), None);

    // Section A: shot goes north 10m
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 1.0)],
        ..Default::default()
    }).id;

    // Section B: shot goes east 5m
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge B.0 to A.1 so they're connected
    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();

    // Create closure between A.0 and B.1 (same-section closures require same connected group)
    let closure = project.create_loop_closure(
        StationRef::new(a, 0),
        StationRef::new(b, 1),
        ClosureStrategy::Batch,
    ).unwrap();

    assert_eq!(closure.station_a, StationRef::new(a, 0));
    assert_eq!(closure.station_b, StationRef::new(b, 1));

    // Path length should be sum of shot lengths: 10m + 5m = 15m
    assert!((closure.path_length - 15.0).abs() < 0.1,
        "Path length should be ~15m (10+5), got {}", closure.path_length);

    // Misclosure is Euclidean distance between A.0 and B.1
    assert!(closure.misclosure_distance > 0.0, "Misclosure should be positive for non-coincident stations");

    // Verify error_percentage formula: (misclosure / path_length) * 100
    let expected_pct = (closure.misclosure_distance / closure.path_length) * 100.0;
    assert!((closure.error_percentage - expected_pct).abs() < 1e-6,
        "error_percentage should equal misclosure/path_length*100: expected {}, got {}",
        expected_pct, closure.error_percentage);

    // Horizontal + vertical misclosure should be consistent with total misclosure
    // (total >= horizontal because total includes vertical component)
    assert!(closure.misclosure_distance >= closure.horizontal_misclosure,
        "Total misclosure {} should be >= horizontal {}",
        closure.misclosure_distance, closure.horizontal_misclosure);
    assert!(closure.vertical_misclosure >= 0.0);

    assert_eq!(project.loop_closures.len(), 1);
}

#[test]
fn create_loop_closure_proportional_is_deferred() {
    let mut project = Project::new("ClosureDist".to_string(), None);

    let section_id = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(90.0, 90.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    let station_a = StationRef::new(section_id, 0);
    let station_b = StationRef::new(section_id, 2);

    let coords_a_before = project.compute_station_raw_coords(station_a).unwrap();
    let coords_b_before = project.compute_station_raw_coords(station_b).unwrap();

    let result = project.create_loop_closure(
        station_a,
        station_b,
        ClosureStrategy::ProportionalByLength,
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("deferred"));
    assert!(project.loop_closures.is_empty());

    let coords_a_after = project.compute_station_raw_coords(station_a).unwrap();
    let coords_b_after = project.compute_station_raw_coords(station_b).unwrap();
    assert!(coords_a_before.distance_to(&coords_a_after) < 1e-6);
    assert!(coords_b_before.distance_to(&coords_b_after) < 1e-6);
}

#[test]
fn create_loop_closure_equal_distribution_is_deferred() {
    let mut project = Project::new("ClosureFallback".to_string(), None);

    let section_id = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 5.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    let station_a = StationRef::new(section_id, 0);
    let station_b = StationRef::new(section_id, 2);

    let result = project.create_loop_closure(
        station_a,
        station_b,
        ClosureStrategy::EqualDistribution,
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("deferred"));
    assert!(project.loop_closures.is_empty());
}

#[test]
fn create_loop_closure_rejects_duplicate() {
    let mut project = Project::new("DupClosure".to_string(), None);

    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();

    // First closure succeeds
    project.create_loop_closure(
        StationRef::new(a, 0),
        StationRef::new(b, 1),
        ClosureStrategy::default(),
    ).unwrap();

    // Duplicate should fail
    let result = project.create_loop_closure(
        StationRef::new(a, 0),
        StationRef::new(b, 1),
        ClosureStrategy::default(),
    );
    assert!(result.is_err(), "Duplicate closure should be rejected");
    assert!(result.unwrap_err().contains("already exists"));

    // Reversed order should also fail
    let result = project.create_loop_closure(
        StationRef::new(b, 1),
        StationRef::new(a, 0),
        ClosureStrategy::default(),
    );
    assert!(result.is_err(), "Reversed duplicate closure should be rejected");
}

#[test]
fn create_loop_closure_allows_same_section() {
    let mut project = Project::new("SameSectionClosure".to_string(), None);

    // A section with 3 shots - all stations are connected within the section
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(90.0, 90.0, 10.0, 0.0, 0.0),
            shot(180.0, 180.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Stations 0 and 3 are in the same section and connected through shots
    let result = project.create_loop_closure(
        StationRef::new(a, 0),
        StationRef::new(a, 3),
        ClosureStrategy::default(),
    );
    assert!(result.is_ok(), "Same-section closure should be allowed: {:?}", result.err());
    assert_eq!(project.loop_closures.len(), 1);
}

#[test]
fn create_loop_closure_rejects_unconnected_stations() {
    let mut project = Project::new("UnconnectedClosure".to_string(), None);

    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Don't merge them - they are unconnected
    let result = project.create_loop_closure(
        StationRef::new(a, 0),
        StationRef::new(b, 0),
        ClosureStrategy::default(),
    );
    assert!(result.is_err(), "Unconnected stations should be rejected");
    assert!(result.unwrap_err().contains("not connected"));
}

#[test]
fn merge_stations_rejects_already_connected() {
    let mut project = Project::new("ConnectedMerge".to_string(), None);

    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // First merge succeeds
    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();

    // Second merge between connected sections should fail
    let result = project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 1));
    assert!(result.is_err(), "Merging already-connected stations should be rejected");
    assert!(result.unwrap_err().contains("already connected"));
}

#[test]
fn unmerge_stations_removes_matching_closure_and_preserves_others() {
    let mut project = Project::new("UnmergePair".to_string(), None);

    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let c = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge A-B and B-C
    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();
    project.merge_stations(StationRef::new(b, 1), StationRef::new(c, 0)).unwrap();

    // Inject a closure matching the A-B merge pair directly.
    // (create_loop_closure won't accept stations that are the merge pair itself)
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        path_length: 10.0,
        misclosure_distance: 0.2,
        error_percentage: 2.0,
        horizontal_misclosure: 0.15,
        vertical_misclosure: 0.05,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });

    // Also inject an unrelated closure for B-C pair
    project.loop_closures.push(LoopClosure {
        id: 2,
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        path_length: 3.0,
        misclosure_distance: 0.1,
        error_percentage: 3.3,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });

    assert_eq!(project.loop_closures.len(), 2);

    // Unmerge A-B: should remove the A.1-B.0 closure but keep B.1-C.0
    let (success, removed) = project.unmerge_stations(
        StationRef::new(a, 1),
        StationRef::new(b, 0),
    );
    assert!(success);
    assert_eq!(removed.len(), 1, "Should remove exactly 1 closure matching the merge pair");
    assert_eq!(removed[0].station_a, StationRef::new(a, 1));
    assert_eq!(removed[0].station_b, StationRef::new(b, 0));

    // Only the B-C closure should remain
    assert_eq!(project.loop_closures.len(), 1);
    assert_eq!(project.loop_closures[0].station_a, StationRef::new(b, 1));
    assert_eq!(project.loop_closures[0].station_b, StationRef::new(c, 0));
}

#[test]
fn unmerge_stations_preserves_unrelated_closures() {
    let mut project = Project::new("UnmergePreserve".to_string(), None);

    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let c = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge A-B and B-C
    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();
    project.merge_stations(StationRef::new(b, 1), StationRef::new(c, 0)).unwrap();

    // Create closure using B-C pair stations (b.1, c.0)
    // This is a direct closure at the merge point
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        path_length: 3.0,
        misclosure_distance: 0.1,
        error_percentage: 3.3,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });

    assert_eq!(project.loop_closures.len(), 1);

    // Unmerge A-B: should NOT remove the B.1-C.0 closure (different pair)
    let (success, removed) = project.unmerge_stations(
        StationRef::new(a, 1),
        StationRef::new(b, 0),
    );
    assert!(success);
    assert!(removed.is_empty(), "No closures should be removed for unrelated pair");
    assert_eq!(project.loop_closures.len(), 1, "B-C closure should be preserved");
}

#[test]
fn closure_expands_connected_sections_with_existing_merges() {
    // Test: A closure between stations in different sections makes those sections
    // connected (just like a merge). Existing merges are also traversed.
    let mut project = Project::new("ClosureExpands".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let c = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Merge A-B
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Closure B-C (no merge, just a closure)
    project.loop_closures.push(LoopClosure {
        id: project.next_closure_id,
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        path_length: 5.0,
        misclosure_distance: 0.1,
        error_percentage: 2.0,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });
    project.next_closure_id += 1;

    // Merge-only connectivity: A and B are merged, C is NOT in the merge group
    let merged = project.get_merged_section_ids(a);
    assert!(merged.contains(&a), "A should be in merge group");
    assert!(merged.contains(&b), "B should be in merge group");
    assert!(!merged.contains(&c), "C should NOT be in merge group (only closure-linked)");
    assert_eq!(merged.len(), 2);

    // Full connectivity (merges + closures): all three sections are connected
    let reachable = project.get_connected_section_ids(a);
    assert!(reachable.contains(&a), "A should be reachable");
    assert!(reachable.contains(&b), "B should be reachable");
    assert!(reachable.contains(&c), "C should be reachable via closure");
    assert_eq!(reachable.len(), 3);

    // Path length including closures: BFS traverses closure as zero-distance edge
    let path = project.calculate_path_length_between(
        StationRef::new(a, 0),
        StationRef::new(c, 1),
    );
    // A.0 -> A.1 (1m shot) -> B.0 (merge, 0) -> B.1 (1m shot) -> C.0 (closure, 0) -> C.1 (1m shot)
    assert!(
        (path - 3.0).abs() < 1e-6,
        "Path A.0 to C.1 should be 3.0m (shots only, merge+closure are zero-distance), got {}",
        path
    );

    // Merge-only path length: cannot reach C.1 from A.0 without closures
    // Falls back to sum of merged section lengths
    let merge_only_path = project.calculate_merge_only_path_length(
        StationRef::new(a, 0),
        StationRef::new(c, 1),
    );
    // A and B are merge-connected (total 2m), C is not reachable without closures
    // Fallback returns sum of A+B shots = 2.0
    assert!(
        (merge_only_path - 2.0).abs() < 1e-6,
        "Merge-only path should fall back to merged section sum (2.0m), got {}",
        merge_only_path
    );

    // are_stations_in_closure should detect the closure
    assert!(project.are_stations_in_closure(
        StationRef::new(b, 1),
        StationRef::new(c, 0),
    ));
    // Reverse direction also works
    assert!(project.are_stations_in_closure(
        StationRef::new(c, 0),
        StationRef::new(b, 1),
    ));
    // Non-closure pair returns false
    assert!(!project.are_stations_in_closure(
        StationRef::new(a, 0),
        StationRef::new(c, 0),
    ));
}

#[test]
fn calculate_path_length_prefers_shorter_weighted_path() {
    // Two paths between A.0 and A.1:
    // 1) Direct shot length 100
    // 2) Merge to B.0, two shots of length 1, merge back at B.2 (total 2)
    let mut project = Project::new("ShortestPath".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 100.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![
                shot(90.0, 90.0, 1.0, 0.0, 0.0),
                shot(90.0, 90.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 2),
        merged_at: Utc::now(),
    });

    let path = project.calculate_path_length_between(
        StationRef::new(a, 0),
        StationRef::new(a, 1),
    );
    assert!(
        (path - 2.0).abs() < 1e-6,
        "Path should prefer length 2.0 over direct 100.0, got {}",
        path
    );
}

#[test]
fn new_merge_expands_existing_closure_connectivity() {
    // Test: Adding a merge after a closure exists should expand connectivity
    // Setup: A-B closure, then merge B-C -> A should connect to C
    let mut project = Project::new("MergeExpandsClosure".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let c = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Closure A-B (before any merges)
    project.loop_closures.push(LoopClosure {
        id: project.next_closure_id,
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        path_length: 5.0,
        misclosure_distance: 0.1,
        error_percentage: 2.0,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });
    project.next_closure_id += 1;

    // Before merge, A and B are reachable via closure (but not merge-connected)
    let merged_before = project.get_merged_section_ids(a);
    assert!(merged_before.contains(&a));
    assert!(!merged_before.contains(&b), "B not merge-connected to A");
    let connected_before = project.get_connected_section_ids(a);
    assert!(connected_before.contains(&a));
    assert!(connected_before.contains(&b), "B connected via closure");
    assert!(!connected_before.contains(&c), "C not yet connected");

    // Now merge B-C
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    // After merge, A should reach C via closure(A-B) + merge(B-C)
    let connected_after = project.get_connected_section_ids(a);
    assert!(connected_after.contains(&a), "A connected");
    assert!(connected_after.contains(&b), "B connected via closure");
    assert!(connected_after.contains(&c), "C connected via closure+merge");
    assert_eq!(connected_after.len(), 3);

    // Merge-only: A is alone (no merges from A), B and C are merge-connected
    let merged_a = project.get_merged_section_ids(a);
    assert_eq!(merged_a.len(), 1, "A has no merges");
    let merged_b = project.get_merged_section_ids(b);
    assert!(merged_b.contains(&b));
    assert!(merged_b.contains(&c));
    assert_eq!(merged_b.len(), 2, "B and C are merge-connected");

    // Path including closures should traverse both closure and merge with zero distance
    let path = project.calculate_path_length_between(
        StationRef::new(a, 0),
        StationRef::new(c, 1),
    );
    // A.0 -> A.1 (1m) -> B.0 (closure, 0) -> B.1 (1m) -> C.0 (merge, 0) -> C.1 (1m)
    assert!(
        (path - 3.0).abs() < 1e-6,
        "Path should be 3.0m (shots only), got {}",
        path
    );
}

#[test]
fn transitive_closure_computation_correct() {
    // Test: closures_with is computed correctly with transitive relationships
    // Setup: A.1 merged with B.0, closure between A.1 and C.0
    // Expected: B.0 gets transitive closure to C.0 (via A.1)
    //           C.0 gets transitive closure to B.0 (via A.1)
    let mut project = Project::new("TransitiveClosure".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let c = project
        .add_section(SectionData {
            shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Merge A.1 with B.0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Closure A.1 to C.0
    project.loop_closures.push(LoopClosure {
        id: project.next_closure_id,
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(c, 0),
        path_length: 8.0,
        misclosure_distance: 0.2,
        error_percentage: 2.5,
        horizontal_misclosure: 0.2,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });
    let closure_id = project.next_closure_id;
    project.next_closure_id += 1;

    // Set datum so compute_station_coordinates works
    project
        .set_zero_datum(
            StationRef::new(a, 0),
            GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
        )
        .unwrap();

    let stations = project.compute_station_coordinates();

    // A.1: direct closure to C.0 (not transitive, A.1 is the endpoint)
    let a1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 1))
        .unwrap();
    let a1_direct = a1
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(c, 0) && !cr.is_transitive);
    assert!(
        a1_direct.is_some(),
        "A.1 should have direct closure to C.0"
    );
    assert_eq!(a1_direct.unwrap().closure_id, closure_id);
    assert!(a1_direct.unwrap().via_station.is_none());

    // B.0: transitive closure to C.0 via A.1 (B.0 is merged with A.1)
    let b0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 0))
        .unwrap();
    let b0_transitive = b0
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(c, 0) && cr.is_transitive);
    assert!(
        b0_transitive.is_some(),
        "B.0 should have transitive closure to C.0 via A.1"
    );
    assert_eq!(
        b0_transitive.unwrap().via_station,
        Some(StationRef::new(a, 1))
    );

    // C.0: direct closure to A.1 (C.0 is the endpoint)
    let c0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 0))
        .unwrap();
    let c0_direct = c0
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(a, 1) && !cr.is_transitive);
    assert!(
        c0_direct.is_some(),
        "C.0 should have direct closure to A.1"
    );

    // C.0: transitive closure to B.0 via A.1 (B.0 is merged with A.1)
    let c0_transitive = c0
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(b, 0) && cr.is_transitive);
    assert!(
        c0_transitive.is_some(),
        "C.0 should have transitive closure to B.0 via A.1"
    );
    assert_eq!(
        c0_transitive.unwrap().via_station,
        Some(StationRef::new(a, 1))
    );
}

#[test]
fn transitive_closure_both_endpoints_merged() {
    // Test: both closure endpoints are in different merge groups
    // Setup: A.1↔B.0 merge, B.1↔C.0 merge, closure between A.1 and C.0
    // Expected: B.0 gets transitive to C.0 (via A.1)
    //           B.1 gets transitive to A.1 (via C.0)
    //           A.1 gets transitive to B.1 (via C.0) - B.1 is in C.0's group
    //           C.0 gets transitive to B.0 (via A.1) - B.0 is in A.1's group
    let mut project = Project::new("TransitiveBothMerged".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let c = project
        .add_section(SectionData {
            shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Merge A.1 ↔ B.0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Merge B.1 ↔ C.0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    // Closure A.1 ↔ C.0 (both endpoints are in merge groups)
    project.loop_closures.push(LoopClosure {
        id: project.next_closure_id,
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(c, 0),
        path_length: 8.0,
        misclosure_distance: 0.2,
        error_percentage: 2.5,
        horizontal_misclosure: 0.2,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });
    let closure_id = project.next_closure_id;
    project.next_closure_id += 1;

    project
        .set_zero_datum(
            StationRef::new(a, 0),
            GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
        )
        .unwrap();

    let stations = project.compute_station_coordinates();

    // A.1: direct closure to C.0
    let a1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 1))
        .unwrap();
    assert!(
        a1.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(c, 0)
                && !cr.is_transitive
                && cr.closure_id == closure_id),
        "A.1 should have direct closure to C.0, got: {:?}",
        a1.closures_with
    );
    // A.1: transitive closure to B.1 (via C.0, since B.1 is in C.0's group)
    assert!(
        a1.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(b, 1)
                && cr.is_transitive
                && cr.via_station == Some(StationRef::new(c, 0))),
        "A.1 should have transitive closure to B.1 (via C.0), got: {:?}",
        a1.closures_with
    );

    // B.0: transitive closure to C.0 (via A.1, since B.0 is in A.1's group)
    let b0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 0))
        .unwrap();
    assert!(
        b0.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(c, 0)
                && cr.is_transitive
                && cr.via_station == Some(StationRef::new(a, 1))),
        "B.0 should have transitive closure to C.0 (via A.1), got: {:?}",
        b0.closures_with
    );
    // B.0: transitive closure to B.1 (via C.0)
    assert!(
        b0.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(b, 1)
                && cr.is_transitive
                && cr.via_station == Some(StationRef::new(c, 0))),
        "B.0 should have transitive closure to B.1 (via C.0), got: {:?}",
        b0.closures_with
    );

    // C.0: direct closure to A.1
    let c0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 0))
        .unwrap();
    assert!(
        c0.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(a, 1)
                && !cr.is_transitive
                && cr.closure_id == closure_id),
        "C.0 should have direct closure to A.1, got: {:?}",
        c0.closures_with
    );
    // C.0: transitive closure to B.0 (via A.1)
    assert!(
        c0.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(b, 0)
                && cr.is_transitive
                && cr.via_station == Some(StationRef::new(a, 1))),
        "C.0 should have transitive closure to B.0 (via A.1), got: {:?}",
        c0.closures_with
    );

    // B.1: transitive closure to A.1 (via C.0, since B.1 is in C.0's group)
    let b1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 1))
        .unwrap();
    assert!(
        b1.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(a, 1)
                && cr.is_transitive
                && cr.via_station == Some(StationRef::new(c, 0))),
        "B.1 should have transitive closure to A.1 (via C.0), got: {:?}",
        b1.closures_with
    );
    // B.1: transitive closure to B.0 (via A.1)
    assert!(
        b1.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(b, 0)
                && cr.is_transitive
                && cr.via_station == Some(StationRef::new(a, 1))),
        "B.1 should have transitive closure to B.0 (via A.1), got: {:?}",
        b1.closures_with
    );

    // A.0 and C.1 should have NO closures (they're not closure endpoints or merged with one)
    let a0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 0))
        .unwrap();
    assert!(
        a0.closures_with.is_empty(),
        "A.0 should have no closures, got: {:?}",
        a0.closures_with
    );

    let c1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 1))
        .unwrap();
    assert!(
        c1.closures_with.is_empty(),
        "C.1 should have no closures, got: {:?}",
        c1.closures_with
    );
}

#[test]
fn transitive_closure_through_create_loop_closure_api() {
    // Test: using the actual create_loop_closure API (not raw push)
    // Setup: 3 sections, merge chain A.1↔B.0 and B.1↔C.0, closure A.0↔C.1
    // Expected: A.0 and C.1 get direct closures to each other
    //           No transitive closures (endpoints not in any merge group)
    let mut project = Project::new("TransitiveAPI".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let c = project
        .add_section(SectionData {
            shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    project
        .set_zero_datum(
            StationRef::new(a, 0),
            GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
        )
        .unwrap();

    // Merge A.1 ↔ B.0 (unconnected, so merge works)
    project
        .merge_stations(StationRef::new(a, 1), StationRef::new(b, 0))
        .unwrap();

    // Merge B.1 ↔ C.0 (B and C not yet connected)
    project
        .merge_stations(StationRef::new(b, 1), StationRef::new(c, 0))
        .unwrap();

    // Now A, B, C are all connected. Create closure A.0 ↔ C.1
    let closure = project
        .create_loop_closure(
            StationRef::new(a, 0),
            StationRef::new(c, 1),
            ClosureStrategy::default(),
        )
        .unwrap();

    let stations = project.compute_station_coordinates();

    // A.0: direct closure to C.1 (endpoint, not merged with anything)
    let a0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 0))
        .unwrap();
    assert!(
        a0.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(c, 1)
                && !cr.is_transitive
                && cr.closure_id == closure.id),
        "A.0 should have direct closure to C.1, got: {:?}",
        a0.closures_with
    );
    assert_eq!(
        a0.closures_with.len(),
        1,
        "A.0 should have exactly 1 closure ref (no transitive since A.0 not merged)"
    );

    // C.1: direct closure to A.0
    let c1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 1))
        .unwrap();
    assert!(
        c1.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(a, 0)
                && !cr.is_transitive
                && cr.closure_id == closure.id),
        "C.1 should have direct closure to A.0, got: {:?}",
        c1.closures_with
    );
    assert_eq!(
        c1.closures_with.len(),
        1,
        "C.1 should have exactly 1 closure ref"
    );

    // Other stations (A.1, B.0, B.1, C.0) should NOT have any closure refs
    // because neither closure endpoint (A.0, C.1) is in a merge group
    for (section_id, station_index, label) in [
        (a, 1, "A.1"),
        (b, 0, "B.0"),
        (b, 1, "B.1"),
        (c, 0, "C.0"),
    ] {
        let station = stations
            .iter()
            .find(|s| {
                s.station_ref == StationRef::new(section_id, station_index)
            })
            .unwrap();
        assert!(
            station.closures_with.is_empty(),
            "{} should have no closures (endpoint not in its merge group), got: {:?}",
            label,
            station.closures_with
        );
    }
}

#[test]
fn closure_chain_transitivity_two_closures_shared_endpoint() {
    // Test: closure-chain transitivity
    // Setup: 3 sections A, B, C. Merge chain: A.1↔B.0, B.1↔C.0
    //   Closure 1: A.0 ↔ B.1 (between A start and B end)
    //   Closure 2: B.1 ↔ C.1 (between B end and C end)
    //
    // B.1 has 2 direct closures: to A.0 and to C.1
    // A.0 should see transitive closure to C.1 via B.1
    // C.1 should see transitive closure to A.0 via B.1
    let mut project = Project::new("ChainTransitive".to_string(), None);

    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let c = project
        .add_section(SectionData {
            shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    project
        .set_zero_datum(
            StationRef::new(a, 0),
            GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
        )
        .unwrap();

    // Merge chain
    project
        .merge_stations(StationRef::new(a, 1), StationRef::new(b, 0))
        .unwrap();
    project
        .merge_stations(StationRef::new(b, 1), StationRef::new(c, 0))
        .unwrap();

    // Closure 1: A.0 ↔ B.1 (they're connected via merges)
    let closure1 = project
        .create_loop_closure(
            StationRef::new(a, 0),
            StationRef::new(b, 1),
            ClosureStrategy::default(),
        )
        .unwrap();

    // Closure 2: B.1 ↔ C.1 (B.1 is merged with C.0, so B and C are connected)
    // Wait - B.1 and C.0 are merged. So B.1 and C.1 are in the same section group.
    // But are_stations_merged(B.1, C.1)? No (direct check only).
    // Actually C.1 is in section C. B.1 is in section B. They're connected through merge.
    // create_loop_closure checks connectivity via get_connected_section_ids.
    let closure2 = project
        .create_loop_closure(
            StationRef::new(b, 1),
            StationRef::new(c, 1),
            ClosureStrategy::default(),
        )
        .unwrap();

    let stations = project.compute_station_coordinates();

    // B.1: should have 2 direct closures (to A.0 and to C.1)
    let b1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(b, 1))
        .unwrap();
    let b1_to_a0 = b1
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(a, 0) && !cr.is_transitive);
    assert!(
        b1_to_a0.is_some(),
        "B.1 should have direct closure to A.0, got: {:?}",
        b1.closures_with
    );
    let b1_to_c1 = b1
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(c, 1) && !cr.is_transitive);
    assert!(
        b1_to_c1.is_some(),
        "B.1 should have direct closure to C.1, got: {:?}",
        b1.closures_with
    );

    // A.0: should have direct closure to B.1 AND transitive closure to C.1 (via B.1)
    let a0 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(a, 0))
        .unwrap();
    let a0_direct = a0
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(b, 1) && !cr.is_transitive);
    assert!(
        a0_direct.is_some(),
        "A.0 should have direct closure to B.1, got: {:?}",
        a0.closures_with
    );
    let a0_transitive = a0
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(c, 1) && cr.is_transitive);
    assert!(
        a0_transitive.is_some(),
        "A.0 should have transitive closure to C.1 (via B.1), got: {:?}",
        a0.closures_with
    );
    assert_eq!(
        a0_transitive.unwrap().via_station,
        Some(StationRef::new(b, 1)),
        "A.0 transitive to C.1 should be via B.1"
    );
    assert_eq!(
        a0_transitive.unwrap().closure_id,
        closure2.id,
        "A.0 transitive to C.1 should reference closure2's id"
    );

    // C.1: should have direct closure to B.1 AND transitive closure to A.0 (via B.1)
    let c1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(c, 1))
        .unwrap();
    let c1_direct = c1
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(b, 1) && !cr.is_transitive);
    assert!(
        c1_direct.is_some(),
        "C.1 should have direct closure to B.1, got: {:?}",
        c1.closures_with
    );
    let c1_transitive = c1
        .closures_with
        .iter()
        .find(|cr| cr.station_ref == StationRef::new(a, 0) && cr.is_transitive);
    assert!(
        c1_transitive.is_some(),
        "C.1 should have transitive closure to A.0 (via B.1), got: {:?}",
        c1.closures_with
    );
    assert_eq!(
        c1_transitive.unwrap().via_station,
        Some(StationRef::new(b, 1)),
        "C.1 transitive to A.0 should be via B.1"
    );
    assert_eq!(
        c1_transitive.unwrap().closure_id,
        closure1.id,
        "C.1 transitive to A.0 should reference closure1's id"
    );
}

#[test]
fn closure_chain_transitivity_three_closures_shared_endpoint() {
    // Test: station with 3 closures creates transitive refs for all pairs
    // Setup: 4 sections, all connected through merges
    //   Station X has closures to A, B, and C
    //   A should see transitive to B (via X) and transitive to C (via X)
    //   B should see transitive to A (via X) and transitive to C (via X)
    //   C should see transitive to A (via X) and transitive to B (via X)
    let mut project = Project::new("ChainTriple".to_string(), None);

    let sec_main = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    let sec_a = project
        .add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let sec_b = project
        .add_section(SectionData {
            shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let sec_c = project
        .add_section(SectionData {
            shots: vec![shot(270.0, 270.0, 4.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    project
        .set_zero_datum(
            StationRef::new(sec_main, 0),
            GpsCoordinates::new(45.0, -90.0, 0.0).unwrap(),
        )
        .unwrap();

    // Connect all sections to main: main.1↔A.0, main.2↔B.0, main.3↔C.0
    project
        .merge_stations(StationRef::new(sec_main, 1), StationRef::new(sec_a, 0))
        .unwrap();
    project
        .merge_stations(StationRef::new(sec_main, 2), StationRef::new(sec_b, 0))
        .unwrap();
    project
        .merge_stations(StationRef::new(sec_main, 3), StationRef::new(sec_c, 0))
        .unwrap();

    // Station main.0 (X) has closures to A.1, B.1, C.1
    let cl_a = project
        .create_loop_closure(
            StationRef::new(sec_main, 0),
            StationRef::new(sec_a, 1),
            ClosureStrategy::default(),
        )
        .unwrap();
    let cl_b = project
        .create_loop_closure(
            StationRef::new(sec_main, 0),
            StationRef::new(sec_b, 1),
            ClosureStrategy::default(),
        )
        .unwrap();
    let cl_c = project
        .create_loop_closure(
            StationRef::new(sec_main, 0),
            StationRef::new(sec_c, 1),
            ClosureStrategy::default(),
        )
        .unwrap();

    let stations = project.compute_station_coordinates();

    // X (main.0) should have 3 direct closures
    let x = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_main, 0))
        .unwrap();
    let x_directs: Vec<_> = x
        .closures_with
        .iter()
        .filter(|cr| !cr.is_transitive)
        .collect();
    assert_eq!(
        x_directs.len(),
        3,
        "X should have 3 direct closures, got: {:?}",
        x.closures_with
    );

    // A.1 should have: direct to X, transitive to B.1 (via X), transitive to C.1 (via X)
    let a1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_a, 1))
        .unwrap();
    assert!(
        a1.closures_with
            .iter()
            .any(|cr| cr.station_ref == StationRef::new(sec_main, 0) && !cr.is_transitive),
        "A.1 direct to X"
    );
    assert!(
        a1.closures_with.iter().any(|cr| cr.station_ref
            == StationRef::new(sec_b, 1)
            && cr.is_transitive
            && cr.via_station == Some(StationRef::new(sec_main, 0))
            && cr.closure_id == cl_b.id),
        "A.1 transitive to B.1 via X, got: {:?}",
        a1.closures_with
    );
    assert!(
        a1.closures_with.iter().any(|cr| cr.station_ref
            == StationRef::new(sec_c, 1)
            && cr.is_transitive
            && cr.via_station == Some(StationRef::new(sec_main, 0))
            && cr.closure_id == cl_c.id),
        "A.1 transitive to C.1 via X, got: {:?}",
        a1.closures_with
    );

    // B.1 should have: direct to X, transitive to A.1 (via X), transitive to C.1 (via X)
    let b1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_b, 1))
        .unwrap();
    assert!(
        b1.closures_with.iter().any(|cr| cr.station_ref
            == StationRef::new(sec_a, 1)
            && cr.is_transitive
            && cr.closure_id == cl_a.id),
        "B.1 transitive to A.1 via X, got: {:?}",
        b1.closures_with
    );
    assert!(
        b1.closures_with.iter().any(|cr| cr.station_ref
            == StationRef::new(sec_c, 1)
            && cr.is_transitive
            && cr.closure_id == cl_c.id),
        "B.1 transitive to C.1 via X, got: {:?}",
        b1.closures_with
    );

    // C.1 should have: direct to X, transitive to A.1 (via X), transitive to B.1 (via X)
    let c1 = stations
        .iter()
        .find(|s| s.station_ref == StationRef::new(sec_c, 1))
        .unwrap();
    assert!(
        c1.closures_with.iter().any(|cr| cr.station_ref
            == StationRef::new(sec_a, 1)
            && cr.is_transitive
            && cr.closure_id == cl_a.id),
        "C.1 transitive to A.1 via X, got: {:?}",
        c1.closures_with
    );
    assert!(
        c1.closures_with.iter().any(|cr| cr.station_ref
            == StationRef::new(sec_b, 1)
            && cr.is_transitive
            && cr.closure_id == cl_b.id),
        "C.1 transitive to B.1 via X, got: {:?}",
        c1.closures_with
    );
}

// === Section cleanup tests (fn-47-ok1.7) ===

/// Helper: build a project with 3 sections (a, b, c) where:
/// - a is merged to b (station a:1 -> b:0)
/// - b has a loop closure to c (b:1 -> c:0)
/// - a has a section offset
/// - a has a station offset on station 0
/// - a has a zero datum on station 0
fn build_project_with_relationships() -> (Project, SectionId, SectionId, SectionId) {
    let mut project = Project::new("Cleanup Test".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 2.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let c = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 3.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge a -> b
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Loop closure b -> c
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        path_length: 5.0,
        misclosure_distance: 0.1,
        error_percentage: 2.0,
        horizontal_misclosure: 0.08,
        vertical_misclosure: 0.06,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });
    project.next_closure_id = 2;

    // Section offset for a
    project.section_offsets.insert(a, (10.0, 20.0));

    // Station offset for a:0
    project.station_offsets.insert(StationRef::new(a, 0), (1.0, 2.0, 3.0));

    // Zero datum for a:0
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(45.0, -73.0, 100.0).unwrap(),
    });

    (project, a, b, c)
}

#[test]
fn test_cleanup_removes_merges() {
    let (mut project, a, _b, _c) = build_project_with_relationships();
    assert_eq!(project.station_merges.len(), 1);

    project.cleanup_section_references(a);

    assert_eq!(project.station_merges.len(), 0, "Merge referencing section A should be removed");
}

#[test]
fn test_cleanup_removes_closures() {
    let (mut project, _a, b, _c) = build_project_with_relationships();
    assert_eq!(project.loop_closures.len(), 1);

    project.cleanup_section_references(b);

    assert_eq!(project.loop_closures.len(), 0, "Closure referencing section B should be removed");
}

#[test]
fn test_cleanup_removes_offsets() {
    let (mut project, a, _b, _c) = build_project_with_relationships();
    assert!(project.section_offsets.contains_key(&a));
    assert_eq!(project.station_offsets.len(), 1);

    project.cleanup_section_references(a);

    assert!(!project.section_offsets.contains_key(&a), "Section offset for A should be removed");
    assert_eq!(project.station_offsets.len(), 0, "Station offset for A:0 should be removed");
}

#[test]
fn test_cleanup_removes_zero_datums() {
    let (mut project, a, _b, _c) = build_project_with_relationships();
    assert_eq!(project.zero_datums.len(), 1);

    project.cleanup_section_references(a);

    assert_eq!(project.zero_datums.len(), 0, "Zero datum for A:0 should be removed");
}

#[test]
fn test_cleanup_guarded_by_existence() {
    // Cleanup on a non-existent section should not mutate anything
    let (mut project, _a, _b, _c) = build_project_with_relationships();
    let orig_merges = project.station_merges.len();
    let orig_closures = project.loop_closures.len();
    let orig_offsets = project.section_offsets.len();
    let orig_station_offsets = project.station_offsets.len();
    let orig_datums = project.zero_datums.len();

    // Section 999 doesn't exist — cleanup should be a no-op
    project.cleanup_section_references(999);

    assert_eq!(project.station_merges.len(), orig_merges);
    assert_eq!(project.loop_closures.len(), orig_closures);
    assert_eq!(project.section_offsets.len(), orig_offsets);
    assert_eq!(project.station_offsets.len(), orig_station_offsets);
    assert_eq!(project.zero_datums.len(), orig_datums);
}

#[test]
fn test_cleanup_preserves_unrelated_relationships() {
    let (mut project, a, b, c) = build_project_with_relationships();

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    assert_eq!(project.station_merges.len(), 2);
    assert_eq!(project.loop_closures.len(), 1);

    project.cleanup_section_references(a);

    assert_eq!(project.station_merges.len(), 1);
    assert!(project.station_merges.iter().any(|m| {
        (m.station_a.section_id == b && m.station_b.section_id == c)
            || (m.station_a.section_id == c && m.station_b.section_id == b)
    }));

    assert_eq!(project.loop_closures.len(), 1);
    let closure = &project.loop_closures[0];
    assert_eq!(closure.station_a.section_id, b);
    assert_eq!(closure.station_b.section_id, c);
}

#[test]
fn test_get_section_relationships() {
    let (project, a, b, _c) = build_project_with_relationships();

    let rel_a = project.get_section_relationships(a);
    assert_eq!(rel_a.merges.len(), 1, "Section A has one merge");
    assert_eq!(rel_a.closures.len(), 0, "Section A has no closures");
    assert!(rel_a.has_section_offset, "Section A has a section offset");
    assert_eq!(rel_a.station_offset_count, 1, "Section A has one station offset");
    assert_eq!(rel_a.zero_datum_count, 1, "Section A has one zero datum");

    let rel_b = project.get_section_relationships(b);
    assert_eq!(rel_b.merges.len(), 1, "Section B has one merge");
    assert_eq!(rel_b.closures.len(), 1, "Section B has one closure");
    assert!(!rel_b.has_section_offset, "Section B has no section offset");
    assert_eq!(rel_b.station_offset_count, 0, "Section B has no station offsets");
    assert_eq!(rel_b.zero_datum_count, 0, "Section B has no zero datums");
}

#[test]
fn shift_station_refs_updates_related_collections() {
    let mut project = Project::new("Shift".to_string(), None);
    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(90.0, 90.0, 1.0, 0.0, 0.0),
                shot(180.0, 180.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    project
        .station_offsets
        .insert(StationRef::new(section_id, 1), (1.0, 1.0, 1.0));
    project
        .station_offsets
        .insert(StationRef::new(section_id, 3), (3.0, 3.0, 3.0));

    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(section_id, 2),
        gps: GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    });

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_id, 2),
        station_b: StationRef::new(section_id, 3),
        merged_at: Utc::now(),
    });

    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(section_id, 1),
        station_b: StationRef::new(section_id, 3),
        path_length: 2.0,
        misclosure_distance: 0.1,
        error_percentage: 5.0,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });

    project.shift_station_refs(section_id, 2, -1);

    assert!(project
        .station_offsets
        .contains_key(&StationRef::new(section_id, 1)));
    assert!(!project
        .station_offsets
        .contains_key(&StationRef::new(section_id, 3)));
    assert_eq!(
        project
            .station_offsets
            .get(&StationRef::new(section_id, 2)),
        Some(&(3.0, 3.0, 3.0))
    );

    assert_eq!(
        project.zero_datums[0].station_ref,
        StationRef::new(section_id, 1)
    );

    let merge = &project.station_merges[0];
    assert_eq!(merge.station_a, StationRef::new(section_id, 1));
    assert_eq!(merge.station_b, StationRef::new(section_id, 2));

    let closure = &project.loop_closures[0];
    assert_eq!(closure.station_a, StationRef::new(section_id, 1));
    assert_eq!(closure.station_b, StationRef::new(section_id, 2));
}

#[test]
fn preview_delete_shot_basic() {
    let mut project = Project::new("PreviewDelete".to_string(), None);
    let section_a = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;
    let section_b = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    // Merge station_a:1 with station_b:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_a, 1),
        station_b: StationRef::new(section_b, 0),
        merged_at: Utc::now(),
    });

    // Preview deleting section_a shot at position 1 (second shot)
    // removed_station = (section_a, 2)
    let shot1_id = project.get_section(section_a).unwrap().shots[1].id;
    let impact = project.preview_delete_shot(section_a, shot1_id).unwrap();
    assert_eq!(impact.removed_station, StationRef::new(section_a, 2));
    // Merge is at station_a:1, not station_a:2 => removed_merges empty
    assert!(impact.removed_merges.is_empty());

    // Preview deleting section_a shot at position 0 (first shot)
    // removed_station = (section_a, 0)
    let shot0_id = project.get_section(section_a).unwrap().shots[0].id;
    let impact = project.preview_delete_shot(section_a, shot0_id).unwrap();
    assert_eq!(impact.removed_station, StationRef::new(section_a, 0));
    // Merge is at station_a:1, not station_a:0 => removed_merges empty
    assert!(impact.removed_merges.is_empty());

    // Add a merge at station_a:2 with station_b:1
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_a, 2),
        station_b: StationRef::new(section_b, 1),
        merged_at: Utc::now(),
    });

    // Preview deleting section_a's second shot again
    // removed_station = (section_a, 2), which matches the new merge
    let impact = project.preview_delete_shot(section_a, shot1_id).unwrap();
    assert_eq!(impact.removed_station, StationRef::new(section_a, 2));
    assert_eq!(impact.removed_merges.len(), 1);
    assert_eq!(impact.removed_merges[0].station_a, StationRef::new(section_a, 2));
    assert_eq!(impact.removed_merges[0].station_b, StationRef::new(section_b, 1));
}

#[test]
fn preview_delete_shot_with_closure_rewire() {
    let mut project = Project::new("ClosureRewire".to_string(), None);
    let section_a = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;
    let section_b = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    // Merge section_a:1 with section_b:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_a, 1),
        station_b: StationRef::new(section_b, 0),
        merged_at: Utc::now(),
    });

    // Add a loop closure between section_a:1 and section_b:1
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(section_a, 1),
        station_b: StationRef::new(section_b, 1),
        path_length: 2.0,
        misclosure_distance: 0.1,
        error_percentage: 5.0,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });

    // Preview deleting section_a's second shot (position 1)
    // removed_station = (section_a, 2), but closure is on station_a:1 which is NOT removed
    let shot1_id = project.get_section(section_a).unwrap().shots[1].id;
    let impact = project.preview_delete_shot(section_a, shot1_id).unwrap();
    assert_eq!(impact.removed_station, StationRef::new(section_a, 2));
    assert!(impact.removed_closures.is_empty());

    // Now add a closure with section_a:2 and section_b:1
    project.loop_closures.push(LoopClosure {
        id: 2,
        station_a: StationRef::new(section_a, 2),
        station_b: StationRef::new(section_b, 1),
        path_length: 3.0,
        misclosure_distance: 0.2,
        error_percentage: 6.7,
        horizontal_misclosure: 0.2,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });

    // Preview delete of section_a's second shot => removed_station = (section_a, 2)
    // The closure IS on the removed station
    let impact = project.preview_delete_shot(section_a, shot1_id).unwrap();
    assert_eq!(impact.removed_station, StationRef::new(section_a, 2));
    assert_eq!(impact.removed_closures.len(), 1);
    assert_eq!(impact.removed_closures[0].closure_id, 2);

    // The merge group of station_a:2 is just {station_a:2} (not merged with anything)
    // So merge_group_without is empty => no replacement candidate => closure_rewire_skipped
    assert!(impact.closure_rewire_skipped);
    assert!(impact.replacement_closure_updates.is_empty());
}

#[test]
fn preview_delete_shot_mid_shot_loop_blocks_shift() {
    let mut project = Project::new("MidShotLoop".to_string(), None);

    // Section A with 3 shots: stations 0,1,2,3
    let section_a = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    // Section B with 1 shot: stations 0,1
    let section_b = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Merge A:0 with B:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_a, 0),
        station_b: StationRef::new(section_b, 0),
        merged_at: Utc::now(),
    });

    // Merge A:3 with B:1
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_a, 3),
        station_b: StationRef::new(section_b, 1),
        merged_at: Utc::now(),
    });

    // Delete middle shot of A (position 1). This is a mid-shot (pos > 0 && pos < len-1).
    // station_before = A:1, station_after = A:2
    // Path: A:1 -> (shot 0 backward) -> A:0 -> (merge) -> B:0 -> (shot 0) -> B:1
    //   -> (merge) -> A:3 -> (shot 2 backward) -> A:2
    // This connects them excluding shot at pos 1, so shift_blocked should be true.
    let mid_shot_id = project.get_section(section_a).unwrap().shots[1].id;
    let impact = project.preview_delete_shot(section_a, mid_shot_id).unwrap();
    assert!(impact.shift_blocked, "Expected shift_blocked to be true for loop");
    assert!(
        !impact.shift_blocked_reasons.is_empty(),
        "Expected at least one shift_blocked reason"
    );
    assert!(
        impact.shift_blocked_reasons[0].contains("loop"),
        "Expected loop-related reason, got: {}",
        impact.shift_blocked_reasons[0]
    );
}

#[test]
fn remove_shot_with_rewire_first_shot_adjusts_offset() {
    let mut project = Project::new("OffsetAdjust".to_string(), None);

    // First shot going east (azimuth 90), second shot going north
    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot(90.0, 90.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 5.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    let first_shot_id = project.get_section(section_id).unwrap().shots[0].id;

    // Offset before should be (0, 0) by default
    let offset_before = project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
    assert!((offset_before.0).abs() < 1e-6);
    assert!((offset_before.1).abs() < 1e-6);

    // Remove the first shot
    let result = project.remove_shot_with_rewire(section_id, first_shot_id);
    assert!(result.is_ok());

    // Displacement of shot going east at 90°:
    // horizontal_length * sin(90°) = 10.0 * 1.0 = 10.0  (x)
    // horizontal_length * cos(90°) = 10.0 * 0.0 = ~0.0   (y)
    // After removing, offset = (0.0 + 10.0, 0.0 + ~0.0) = (~10.0, ~0.0)
    let offset_after = project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
    assert!(
        (offset_after.0 - 10.0).abs() < 1e-6,
        "Expected x offset ~10.0, got {}",
        offset_after.0
    );
    assert!(
        (offset_after.1).abs() < 1e-6,
        "Expected y offset ~0.0, got {}",
        offset_after.1
    );
}

#[test]
fn remove_shot_with_rewire_replaces_merges() {
    let mut project = Project::new("ReplaceMerges".to_string(), None);

    let section_a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let section_b = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let section_c = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Merge section_a:1 with section_b:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_a, 1),
        station_b: StationRef::new(section_b, 0),
        merged_at: Utc::now(),
    });

    // Merge section_b:0 with section_c:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_b, 0),
        station_b: StationRef::new(section_c, 0),
        merged_at: Utc::now(),
    });

    // Delete section_b's first shot (pos=0) => removed_station = section_b:0
    let shot_id = project.get_section(section_b).unwrap().shots[0].id;
    let (_, impact) = project.remove_shot_with_rewire(section_b, shot_id).unwrap();

    // removed_merges should include both merges involving section_b:0
    assert_eq!(impact.removed_merges.len(), 2);

    // After removal, there should be a replacement merge between section_a:1 and section_c:0
    let has_replacement = project.station_merges.iter().any(|m| {
        (m.station_a == StationRef::new(section_a, 1)
            && m.station_b == StationRef::new(section_c, 0))
            || (m.station_a == StationRef::new(section_c, 0)
                && m.station_b == StationRef::new(section_a, 1))
    });
    assert!(
        has_replacement,
        "Expected replacement merge between section_a:1 and section_c:0"
    );
}

#[test]
fn insert_shot_before_at_position_zero_adjusts_offset() {
    let mut project = Project::new("InsertBefore".to_string(), None);

    // Section with 1 shot going north
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    let first_shot_id = project.get_section(section_id).unwrap().shots[0].id;

    // Insert a shot going east before the first shot
    let inserted = project.insert_shot_before(
        section_id,
        first_shot_id,
        shot(90.0, 90.0, 5.0, 0.0, 0.0),
    );
    assert!(inserted.is_some());

    // Displacement of inserted shot going east at 90°:
    // (horizontal * sin(90°), horizontal * cos(90°)) = (5.0, ~0.0)
    // Offset adjusted by (-5.0, ~0.0) to keep existing stations in place
    let offset = project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
    assert!(
        (offset.0 - (-5.0)).abs() < 1e-6,
        "Expected x offset ~-5.0, got {}",
        offset.0
    );
    assert!(
        (offset.1).abs() < 1e-6,
        "Expected y offset ~0.0, got {}",
        offset.1
    );
}

#[test]
fn insert_shot_after_shifts_station_refs() {
    let mut project = Project::new("InsertAfterShift".to_string(), None);

    let section_a = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;
    let section_b = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
                shot(0.0, 0.0, 1.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    // Add a merge between section_a:2 (after second shot) and section_b:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(section_a, 2),
        station_b: StationRef::new(section_b, 0),
        merged_at: Utc::now(),
    });

    // Add a loop closure between section_a:2 and section_b:1
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(section_a, 2),
        station_b: StationRef::new(section_b, 1),
        path_length: 2.0,
        misclosure_distance: 0.1,
        error_percentage: 5.0,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });
    project.next_closure_id = 2;

    // Insert a shot after section_a's first shot (position 0)
    let first_shot_id = project.get_section(section_a).unwrap().shots[0].id;
    let inserted = project.insert_shot_after(
        section_a,
        first_shot_id,
        shot(0.0, 0.0, 1.0, 0.0, 0.0),
    );
    assert!(inserted.is_some());

    // The new shot goes at position 1. Old stations at index >= 2 shift to index+1.
    // So section_a:2 becomes section_a:3.
    // The merge should now reference section_a:3.
    let merge = &project.station_merges[0];
    assert_eq!(
        merge.station_a,
        StationRef::new(section_a, 3),
        "Merge station_a should have shifted from 2 to 3"
    );
    assert_eq!(merge.station_b, StationRef::new(section_b, 0));

    // The closure should reference section_a:3 (was section_a:2).
    let closure = &project.loop_closures[0];
    assert_eq!(
        closure.station_a,
        StationRef::new(section_a, 3),
        "Closure station_a should have shifted from 2 to 3"
    );
    assert_eq!(closure.station_b, StationRef::new(section_b, 1));
}

#[test]
fn calculate_penetration_with_zero_datum() {
    let mut project = Project::new("Penetration".to_string(), None);

    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 5.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    // Set a zero datum on station 0
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(section_id, 0),
        gps: GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    });

    // Compute stations
    let stations = project.compute_station_coordinates();

    // Station 0 at origin, station 1 at (0, 10, 0), station 2 at (0, 15, 0)
    // Penetration = max distance from datum station to any station = 15.0
    let penetration = project.calculate_penetration(&stations);
    assert!(
        (penetration - 15.0).abs() < 1e-6,
        "Expected penetration ~15.0, got {}",
        penetration
    );
}

#[test]
fn calculate_penetration_no_datums_returns_zero() {
    let mut project = Project::new("NoDatums".to_string(), None);

    project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    });

    // No zero datums set
    let stations = project.compute_station_coordinates();
    let penetration = project.calculate_penetration(&stations);
    assert!(
        (penetration - 0.0).abs() < 1e-6,
        "Expected penetration 0.0, got {}",
        penetration
    );
}
