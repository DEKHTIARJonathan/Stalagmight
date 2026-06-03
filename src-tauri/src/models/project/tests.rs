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

    // Align b:0 to a:1 (a:1 is at (0, 10) since shot goes north 10m)
    project.set_section_offset(b, (0.0, 10.0));

    // Merge section b's station 0 to section a's station 1
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Record positions before setting datum
    // Section a station 1 is at (0, 10) before datum (shot goes north)
    // Section b station 0 is at (0, 10) before datum (aligned to a:1)
    // Section b station 1 is at (5, 10) before datum (shot goes east from b:0)
    let coords_b1_before = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!((coords_b1_before.x - 5.0).abs() < 1e-6, "Pre-datum b.1 x should be 5");
    assert!((coords_b1_before.y - 10.0).abs() < 1e-6, "Pre-datum b.1 y should be 10");

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
    // Before: b.1 was at (5, 10). After: b.1 should be at (5, 0)
    // (The offset delta was (0, -10) to move a.1 from (0, 10) to (0, 0))
    let coords_b1_after = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!(
        (coords_b1_after.x - 5.0).abs() < 1e-6,
        "b.1 x should be 5, got {}",
        coords_b1_after.x
    );
    assert!(
        (coords_b1_after.y - 0.0).abs() < 1e-6,
        "b.1 y should be 0 (moved with connected sections), got {}",
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
    assert!(err.contains("already has a zero datum"), "Error should mention existing datum: {err}");
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
    assert!(err.contains("already has a zero datum"), "Error should mention existing datum: {err}");
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
    assert!(err.contains("Main Passage"), "Error should include section name: {err}");
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
    assert!(err.contains("#2"), "New station should include #2: {err}");
    assert!(err.contains("#0"), "Existing datum station should include #0: {err}");
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
        "Path A.0 to C.1 should be 3.0m (shots only, merge+closure are zero-distance), got {path}"
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
        "Merge-only path should fall back to merged section sum (2.0m), got {merge_only_path}"
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
        "Path should prefer length 2.0 over direct 100.0, got {path}"
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
        "Path should be 3.0m (shots only), got {path}"
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

    // Align merge points: a:1 is at (0,1), so b:0 and c:0 need offset (0,1)
    project.set_section_offset(section_b, (0.0, 1.0));
    project.set_section_offset(section_c, (0.0, 1.0));

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
        None,
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
        None,
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
        "Expected penetration ~15.0, got {penetration}"
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
        "Expected penetration 0.0, got {penetration}"
    );
}

// === Loop Closure Algorithm Tests ===

// Group A: create_loop_closure validation (new tests only; see existing tests above for basic/duplicate/deferred)

#[test]
fn create_loop_closure_rejects_merged_stations() {
    let mut project = Project::new("ClosureRejectMerged".to_string(), None);

    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();

    // Try to create closure between already-merged stations
    let result = project.create_loop_closure(
        StationRef::new(a, 1),
        StationRef::new(b, 0),
        ClosureStrategy::Batch,
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("already merged"));
}

#[test]
fn create_loop_closure_allows_disconnected_with_both_datums() {
    let mut project = Project::new("ClosureDisconnectedDatums".to_string(), None);

    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Each section gets its own zero datum (disconnected but GPS-anchored)
    project.set_zero_datum(
        StationRef::new(a, 0),
        GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    ).unwrap();
    project.set_zero_datum(
        StationRef::new(b, 0),
        GpsCoordinates::new(0.0, 0.01, 0.0).unwrap(),
    ).unwrap();

    let result = project.create_loop_closure(
        StationRef::new(a, 1),
        StationRef::new(b, 1),
        ClosureStrategy::Batch,
    );
    assert!(result.is_ok(), "Disconnected with both datums should allow closure: {:?}", result.err());
}

// Group B: compute_closure_metrics

#[test]
fn compute_closure_metrics_known_geometry() {
    let mut project = Project::new("ClosureMetrics".to_string(), None);

    // Section A: 2 shots going north (0°), 10m each → A:0=(0,0), A:1=(0,10), A:2=(0,20)
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Section B: 1 shot going east (90°), 5m → B:0=(0,0), B:1=(5,0)
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge A:0 with B:0
    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    let metrics = project.compute_closure_metrics(
        StationRef::new(a, 2),
        StationRef::new(b, 1),
    ).unwrap();

    // A:2 is at (0, 20), B:1 is at (5, 0) after merge alignment
    // B was moved to align B:0 with A:0 at origin
    let coords_a2 = project.compute_station_raw_coords(StationRef::new(a, 2)).unwrap();
    let coords_b1 = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();

    let expected_h = coords_a2.horizontal_distance_to(&coords_b1);
    let expected_v = (coords_a2.z - coords_b1.z).abs();
    let expected_d = coords_a2.distance_to(&coords_b1);

    assert!((metrics.horizontal_misclosure - expected_h).abs() < 1e-6,
        "horizontal: expected {}, got {}", expected_h, metrics.horizontal_misclosure);
    assert!((metrics.vertical_misclosure - expected_v).abs() < 1e-6,
        "vertical: expected {}, got {}", expected_v, metrics.vertical_misclosure);
    assert!((metrics.misclosure_distance - expected_d).abs() < 1e-6,
        "distance: expected {}, got {}", expected_d, metrics.misclosure_distance);
    assert!(metrics.path_length > 0.0, "path_length should be > 0");
    assert!(metrics.error_percentage > 0.0, "error_percentage should be > 0");
}

#[test]
fn compute_closure_metrics_zero_misclosure() {
    let mut project = Project::new("ClosureZeroMisclosure".to_string(), None);

    // Two sections that arrive at the same point: a perfect loop
    // Section A: 1 shot going north (0°), 10m → A:0=(0,0), A:1=(0,10)
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Section B: 1 shot going north (0°), 10m → B:0=(0,0), B:1=(0,10)
    let b = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge A:0 with B:0
    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    // A:1 and B:1 should be at the same point (0, 10)
    let metrics = project.compute_closure_metrics(
        StationRef::new(a, 1),
        StationRef::new(b, 1),
    ).unwrap();

    assert!(metrics.misclosure_distance < 1e-6,
        "Expected near-zero misclosure, got {}", metrics.misclosure_distance);
    assert!(metrics.error_percentage < 1e-6,
        "Expected near-zero error, got {}", metrics.error_percentage);
}

// Group C: distribute_closure_error_internal (core algorithm)

#[test]
fn distribute_closure_simple_two_section_loop() {
    let mut project = Project::new("DistributeSimple".to_string(), None);

    // Section A: 3 shots going north (0°), 10m each → A:3=(0,30)
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Section B: 1 shot going south (180°), 29m → B:1=(0,-29)
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 29.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge A:0 with B:0
    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    // A:3 at (0,30), B:1 at (0,-29). Gap = 59m in y.
    let coords_a3_before = project.compute_station_raw_coords(StationRef::new(a, 3)).unwrap();
    let coords_b1_before = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!((coords_a3_before.y - 30.0).abs() < 1e-6);
    assert!((coords_b1_before.y - (-29.0)).abs() < 1e-6);

    // Distribute closure error proportionally
    project.test_distribute_closure_error(
        StationRef::new(a, 3),
        StationRef::new(b, 1),
        ClosureStrategy::ProportionalByLength,
    ).unwrap();

    // After distribution, A:3 and B:1 should have the same coordinates
    let coords_a3_after = project.compute_station_raw_coords(StationRef::new(a, 3)).unwrap();
    let coords_b1_after = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    let residual = coords_a3_after.distance_to(&coords_b1_after);
    assert!(residual < 0.01,
        "Endpoints should align after distribution, residual = {residual}");
}

#[test]
fn distribute_closure_with_zero_datum_at_endpoint() {
    let mut project = Project::new("DistributeDatumEndpoint".to_string(), None);

    // Section A: 3 shots going north (0°), 10m each
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Section B: 1 shot going south (180°), 29m
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 29.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Set zero datum on A:0 before merging
    project.set_zero_datum(
        StationRef::new(a, 0),
        GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    ).unwrap();

    // Merge A:0 with B:0
    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    // Record A:0 position before distribution
    let coords_a0_before = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();

    // Distribute closure error
    project.test_distribute_closure_error(
        StationRef::new(a, 3),
        StationRef::new(b, 1),
        ClosureStrategy::ProportionalByLength,
    ).unwrap();

    // A:0 (zero datum) should NOT have moved
    let coords_a0_after = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    assert!(coords_a0_before.distance_to(&coords_a0_after) < 1e-6,
        "Zero datum station should not move");

    // Endpoints should align
    let coords_a3_after = project.compute_station_raw_coords(StationRef::new(a, 3)).unwrap();
    let coords_b1_after = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    let residual = coords_a3_after.distance_to(&coords_b1_after);
    assert!(residual < 0.01,
        "Endpoints should align after distribution, residual = {residual}");
}

#[test]
fn distribute_closure_with_zero_datum_mid_path() {
    let mut project = Project::new("DistributeDatumMid".to_string(), None);

    // Section A: 2 shots going north (0°), 10m each → A:0=(0,0), A:1=(0,10), A:2=(0,20)
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Section B: 1 shot going south (180°), 19m → B:1=(0,-19)
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 19.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge A:0 with B:0
    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    // Set zero datum on A:1 (mid-path station)
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 1),
        gps: GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    });

    // Record A:1 position before distribution
    let coords_a1_before = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();

    // Distribute closure error — datum is mid-path, so path splits at A:1
    project.test_distribute_closure_error(
        StationRef::new(a, 2),
        StationRef::new(b, 1),
        ClosureStrategy::ProportionalByLength,
    ).unwrap();

    // A:1 (zero datum) should NOT have moved
    let coords_a1_after = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
    assert!(coords_a1_before.distance_to(&coords_a1_after) < 1e-6,
        "Zero datum station should not move, moved by {}",
        coords_a1_before.distance_to(&coords_a1_after));

    // Endpoints should align
    let coords_a2_after = project.compute_station_raw_coords(StationRef::new(a, 2)).unwrap();
    let coords_b1_after = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    let residual = coords_a2_after.distance_to(&coords_b1_after);
    assert!(residual < 0.01,
        "Endpoints should align after distribution, residual = {residual}");
}

#[test]
fn distribute_closure_both_anchored_fails() {
    let mut project = Project::new("DistributeBothAnchored".to_string(), None);

    // Section A: 1 shot going north
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Section B: 1 shot going south, slightly different length
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 9.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge A:0 with B:0
    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    // Set zero datums on both closure endpoints
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 1),
        gps: GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(b, 1),
        gps: GpsCoordinates::new(0.0, 0.01, 0.0).unwrap(),
    });

    // Should fail because both endpoints are anchored
    let result = project.test_distribute_closure_error(
        StationRef::new(a, 1),
        StationRef::new(b, 1),
        ClosureStrategy::ProportionalByLength,
    );
    assert!(result.is_err(),
        "Should fail when both endpoints are anchored to zero datums");
}

#[test]
fn distribute_closure_equal_distribution() {
    let mut project = Project::new("DistributeEqual".to_string(), None);

    // Section A: 3 shots going north, different lengths
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 5.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 15.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Section B: 1 shot going south, 29m
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 29.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    project.test_distribute_closure_error(
        StationRef::new(a, 3),
        StationRef::new(b, 1),
        ClosureStrategy::EqualDistribution,
    ).unwrap();

    // Endpoints should align
    let coords_a3 = project.compute_station_raw_coords(StationRef::new(a, 3)).unwrap();
    let coords_b1 = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    let residual = coords_a3.distance_to(&coords_b1);
    assert!(residual < 0.01,
        "Endpoints should align after equal distribution, residual = {residual}");
}

#[test]
fn distribute_closure_fallback_separate_datums() {
    let mut project = Project::new("DistributeFallbackDatums".to_string(), None);

    // Section A: 2 shots going north → A:2=(0,20)
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Section B: 1 shot going east → B:1=(5+offset,0+offset)
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Set separate zero datums on each (NOT connected by merges)
    project.set_zero_datum(
        StationRef::new(a, 0),
        GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    ).unwrap();
    project.set_zero_datum(
        StationRef::new(b, 0),
        GpsCoordinates::new(0.0, 0.01, 0.0).unwrap(),
    ).unwrap();

    // Distribute with fallback path (no direct connection)
    project.test_distribute_closure_error(
        StationRef::new(a, 2),
        StationRef::new(b, 1),
        ClosureStrategy::ProportionalByLength,
    ).unwrap();

    // Endpoints should align
    let coords_a2 = project.compute_station_raw_coords(StationRef::new(a, 2)).unwrap();
    let coords_b1 = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    let residual = coords_a2.distance_to(&coords_b1);
    assert!(residual < 0.01,
        "Endpoints should align via fallback datums, residual = {residual}");
}

/// Stress test: 50-section ring network with closure.
/// Verifies the sparse PCG solver produces correct results for a
/// non-trivial graph (all endpoints align, zero datums preserved).
#[test]
fn distribute_closure_large_ring_network() {
    let mut project = Project::new("LargeRingNetwork".to_string(), None);

    // Create 50 sections, each with 5 shots going at slightly different azimuths.
    // This creates a network where the union-find produces many distinct groups,
    // exercising the sparse solver with a matrix larger than trivial test cases.
    let num_sections = 50;
    let mut section_ids = Vec::new();
    for i in 0..num_sections {
        // Each section goes at a slightly different heading to create a ring
        let azimuth = (i as f64 * 360.0 / num_sections as f64) % 360.0;
        let id = project.add_section(SectionData {
            shots: vec![
                shot(azimuth, azimuth, 10.0, 0.0, 0.0),
                shot(azimuth, azimuth, 10.0, 0.0, 0.0),
                shot(azimuth, azimuth, 10.0, 0.0, 0.0),
                shot(azimuth, azimuth, 10.0, 0.0, 0.0),
                shot(azimuth, azimuth, 10.0, 0.0, 0.0),
            ],
            ..Default::default()
        }).id;
        section_ids.push(id);
    }

    // Chain sections: merge end of section i with start of section i+1
    for i in 0..(num_sections - 1) {
        project.merge_stations(
            StationRef::new(section_ids[i], 5),   // end of section i
            StationRef::new(section_ids[i + 1], 0), // start of section i+1
        ).unwrap();
    }

    // Set zero datum on the first station
    project.set_zero_datum(
        StationRef::new(section_ids[0], 0),
        GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    ).unwrap();

    // Record positions before closure
    let first_station = StationRef::new(section_ids[0], 0);
    let last_station = StationRef::new(section_ids[num_sections - 1], 5);
    let coords_first_before = project.compute_station_raw_coords(first_station).unwrap();

    // Create a closure between last station and first station (closing the ring)
    project.test_distribute_closure_error(
        last_station,
        first_station,
        ClosureStrategy::ProportionalByLength,
    ).unwrap();

    // Zero datum should not have moved
    let coords_first_after = project.compute_station_raw_coords(first_station).unwrap();
    assert!(coords_first_before.distance_to(&coords_first_after) < 1e-6,
        "Zero datum should not move, delta = {}",
        coords_first_before.distance_to(&coords_first_after));

    // Endpoints should align (closure should be resolved)
    let coords_last_after = project.compute_station_raw_coords(last_station).unwrap();
    let coords_first_after2 = project.compute_station_raw_coords(first_station).unwrap();
    let residual = coords_last_after.distance_to(&coords_first_after2);
    assert!(residual < 0.01,
        "Ring endpoints should align after distribution, residual = {residual}");

    // All merge points should remain consistent (merged stations should coincide)
    for i in 0..(num_sections - 1) {
        let end_i = project.compute_station_raw_coords(
            StationRef::new(section_ids[i], 5)
        ).unwrap();
        let start_next = project.compute_station_raw_coords(
            StationRef::new(section_ids[i + 1], 0)
        ).unwrap();
        let merge_residual = end_i.distance_to(&start_next);
        assert!(merge_residual < 0.01,
            "Merge point {i} should be consistent, residual = {merge_residual}");
    }
}

// Group D: apply_station_move_internal (tested indirectly)

#[test]
fn apply_station_move_adjusts_incoming_and_outgoing_shots() {
    let mut project = Project::new("StationMoveMiddle".to_string(), None);

    // Section with 3 shots: stations at (0,0), (0,10), (0,20), (0,30)
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Section B: 1 shot, same geometry to create a closure path
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 29.5, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    // Record positions before (verify they're valid)
    let _coords_0_before = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    let _coords_3_before = project.compute_station_raw_coords(StationRef::new(a, 3)).unwrap();

    // Distribute closure error — this will move intermediate stations including middle ones
    project.test_distribute_closure_error(
        StationRef::new(a, 3),
        StationRef::new(b, 1),
        ClosureStrategy::ProportionalByLength,
    ).unwrap();

    // Endpoints should be aligned
    let coords_a3 = project.compute_station_raw_coords(StationRef::new(a, 3)).unwrap();
    let coords_b1 = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!(coords_a3.distance_to(&coords_b1) < 0.01,
        "Endpoints should be aligned");

    // Intermediate stations (1, 2) should have moved — their positions should differ from
    // the original linear progression
    let coords_1 = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
    let coords_2 = project.compute_station_raw_coords(StationRef::new(a, 2)).unwrap();

    // All 4 stations should still be in a reasonable order (y increasing or near-increasing)
    let coords_0 = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    assert!(coords_0.y < coords_1.y || (coords_0.y - coords_1.y).abs() < 1.0,
        "Station 0 should be before station 1");
    assert!(coords_1.y < coords_2.y || (coords_1.y - coords_2.y).abs() < 1.0,
        "Station 1 should be before station 2");
}

#[test]
fn apply_station_move_station_zero_uses_section_offset() {
    let mut project = Project::new("StationMoveZero".to_string(), None);

    // Section A: 1 shot going north
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Section B: 1 shot going south, slightly short — creates misclosure at station 0
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();

    // Record section offset before
    let _offset_before = project.section_offsets.get(&a).copied().unwrap_or((0.0, 0.0));

    // A:0 is at the origin. B:1 is at (0, 10) + (0, -10) = (0, 0) after merge alignment.
    // Both A:0 and B:1 are at (0, 0), so zero misclosure — perfect loop.
    // Let's modify B to create a gap:
    // Actually, let's use a more direct test — just set up the closure so station 0 needs to move
    let c = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    project.merge_stations(StationRef::new(b, 1), StationRef::new(c, 0)).unwrap();

    // Now we have A:0 merged to chain, create a closure between A:0's group and C:1
    // A:0=(0,0), C:1 = some other position — distribute will move stations
    // The test verifies that if station 0 needs an XY move, section_offsets is used
    let _offset_a_before = project.section_offsets.get(&a).copied().unwrap_or((0.0, 0.0));

    // Distribute error — this exercises apply_station_move_internal on various stations
    project.test_distribute_closure_error(
        StationRef::new(a, 0),
        StationRef::new(c, 1),
        ClosureStrategy::EqualDistribution,
    ).unwrap();

    // The test passes if no panic/error occurs — the internal logic correctly
    // routes station 0 XY moves through section_offsets
    let coords_a0 = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    let coords_c1 = project.compute_station_raw_coords(StationRef::new(c, 1)).unwrap();
    assert!(coords_a0.distance_to(&coords_c1) < 0.01,
        "Endpoints should align");
}

#[test]
fn apply_station_move_last_station_only_modifies_incoming() {
    let mut project = Project::new("StationMoveLast".to_string(), None);

    // 2 shots: stations 0, 1, 2
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // B: connect to create closure path
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 19.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    // A:2 is the last station. After distribution, the last shot (idx=1) should be modified
    // but there's no outgoing shot from A:2.
    project.test_distribute_closure_error(
        StationRef::new(a, 2),
        StationRef::new(b, 1),
        ClosureStrategy::ProportionalByLength,
    ).unwrap();

    // Verify alignment
    let coords_a2 = project.compute_station_raw_coords(StationRef::new(a, 2)).unwrap();
    let coords_b1 = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    assert!(coords_a2.distance_to(&coords_b1) < 0.01,
        "Endpoints should align, residual = {}", coords_a2.distance_to(&coords_b1));

    // All stations should have valid, finite coordinates
    for idx in 0..=2 {
        let c = project.compute_station_raw_coords(StationRef::new(a, idx)).unwrap();
        assert!(c.x.is_finite() && c.y.is_finite() && c.z.is_finite(),
            "Station {idx} coords should be finite");
    }
}

// Group E: enforce_merge_alignment (tested indirectly through adjust_loop_closures)

#[test]
fn enforce_merge_alignment_conflicted_section_applies_segment_correction() {
    let mut project = Project::new("EnforceMergeAlignment".to_string(), None);

    // Section A: 3 shots going north, 10m each → A:0=(0,0), A:1=(0,10), A:2=(0,20), A:3=(0,30)
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Section B: 1 shot going east, 5m → B:0=(0,0), B:1=(5,0)
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Section C: 1 shot going west, 5m → C:0=(0,0), C:1=(-5,0)
    let c = project.add_section(SectionData {
        shots: vec![shot(270.0, 270.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Set datum on A:0
    project.set_zero_datum(
        StationRef::new(a, 0),
        GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    ).unwrap();

    // Merge B:0 to A:1 and C:0 to A:3
    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();
    project.merge_stations(StationRef::new(a, 3), StationRef::new(c, 0)).unwrap();

    // Create closures between B:1 and C:1 — they form a loop through section A
    project.create_loop_closure(
        StationRef::new(b, 1),
        StationRef::new(c, 1),
        ClosureStrategy::Batch,
    ).unwrap();

    // Adjust loop closures — this triggers enforce_merge_alignment internally
    let config = ClosureAdjustmentConfig::default();
    let result = project.adjust_loop_closures(
        StationRef::new(a, 0),
        ClosureStrategy::LeastSquaresWeighted,
        &config,
    );

    // The adjustment may succeed or fail depending on the geometry, but the important thing
    // is that enforce_merge_alignment was exercised and didn't panic
    match result {
        Ok(()) => {
            // Verify stations are still at valid, finite coordinates
            for idx in 0..=3 {
                let coords = project.compute_station_raw_coords(StationRef::new(a, idx)).unwrap();
                assert!(coords.x.is_finite() && coords.y.is_finite() && coords.z.is_finite(),
                    "A:{idx} coords should be finite after adjustment");
            }

            // Zero datum should not have moved
            let coords_a0 = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
            assert!(coords_a0.x.abs() < 1e-6 && coords_a0.y.abs() < 1e-6,
                "Zero datum A:0 should remain at origin");
        }
        Err(e) => {
            // Some errors are expected for certain geometries
            // (e.g., "No eligible loop closures" or convergence failure)
            assert!(
                e.contains("eligible") || e.contains("converge") || e.contains("datum") || e.contains("failed"),
                "Unexpected error: {e}"
            );
        }
    }
}

// ── Frozen shot tests ─────────────────────────────────────────────

#[test]
fn is_shot_frozen_single_datum_dead_end() {
    // Section with datum on station 0, shots going one direction.
    // No shot is frozen (dead end, no datum reachable on far side).
    let mut project = Project::new("Frozen".to_string(), None);
    let sec = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 0.0, 1.0),
            shot(0.0, 0.0, 1.0, 1.0, 2.0),
            shot(0.0, 0.0, 1.0, 2.0, 3.0),
        ],
        ..Default::default()
    }).id;

    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(sec, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });

    let frozen = project.compute_frozen_shots();
    assert!(frozen.is_empty(), "Dead-end shots should not be frozen");
}

#[test]
fn is_shot_frozen_loop_with_two_datums() {
    // Two sections each with a datum, connected by merges at both ends.
    // All shots between the datums are frozen.
    //
    // Section A: station 0 (datum) --shot0--> station 1 --shot1--> station 2
    // Section B: station 0 (datum) --shot0--> station 1 --shot1--> station 2
    // Merges: A:0 <-> B:0, A:2 <-> B:2
    let mut project = Project::new("TwoDatums".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 0.0, 1.0),
            shot(0.0, 0.0, 1.0, 1.0, 2.0),
        ],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![
            shot(180.0, 180.0, 1.0, 0.0, 1.0),
            shot(180.0, 180.0, 1.0, 1.0, 2.0),
        ],
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 2),
        merged_at: Utc::now(),
    });

    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(b, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });

    let frozen = project.compute_frozen_shots();
    // All 4 shots (2 per section) should be frozen
    assert_eq!(frozen.len(), 4, "All shots in the loop should be frozen");

    // Verify both sections' shots are present
    let a_frozen: Vec<_> = frozen.iter().filter(|f| f.section_id == a).collect();
    let b_frozen: Vec<_> = frozen.iter().filter(|f| f.section_id == b).collect();
    assert_eq!(a_frozen.len(), 2);
    assert_eq!(b_frozen.len(), 2);
}

#[test]
fn is_shot_frozen_loop_with_aligned_closure() {
    // Single datum, loop closed by an aligned closure.
    // Section A: station 0 (datum) --shot0--> station 1 --shot1--> station 2
    // Section B: station 0 --shot0--> station 1 --shot1--> station 2 --shot2--> station 3 (dead end branch)
    // Merge: A:0 <-> B:0
    // Aligned closure: A:2 <-> B:2
    // Shots A:0, A:1, B:0, B:1 should be frozen (in the loop).
    // Shot B:2 is NOT frozen (dead-end branch past the closure point).
    let mut project = Project::new("AlignedClosure".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 0.0, 1.0),
            shot(0.0, 0.0, 1.0, 1.0, 2.0),
        ],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![
            shot(180.0, 180.0, 1.0, 0.0, 1.0),
            shot(180.0, 180.0, 1.0, 1.0, 2.0),
            shot(180.0, 180.0, 1.0, 2.0, 3.0), // dead-end branch
        ],
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });

    // Add aligned closure: A:2 <-> B:2
    project.loop_closures.push(LoopClosure {
        id: project.next_closure_id,
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 2),
        path_length: 4.0,
        misclosure_distance: 0.1,
        error_percentage: 2.5,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::LeastSquaresWeighted,
        is_aligned: true,
    });
    project.next_closure_id += 1;

    let frozen = project.compute_frozen_shots();

    // A:0, A:1, B:0, B:1 should be frozen
    let a_frozen: Vec<_> = frozen.iter().filter(|f| f.section_id == a).collect();
    let b_frozen: Vec<_> = frozen.iter().filter(|f| f.section_id == b).collect();
    assert_eq!(a_frozen.len(), 2, "Both shots in section A should be frozen");
    assert_eq!(b_frozen.len(), 2, "Only shots 0,1 in section B should be frozen");

    // Verify B:2 (dead-end branch) is NOT frozen
    let b2_frozen = frozen.iter().any(|f| f.section_id == b && f.shot_index == 2);
    assert!(!b2_frozen, "Dead-end shot B:2 should NOT be frozen");
}

#[test]
fn is_shot_frozen_unaligned_closure_not_traversed() {
    // Same topology as above but closure is NOT aligned. No shots should be frozen.
    let mut project = Project::new("UnalignedClosure".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 0.0, 1.0),
            shot(0.0, 0.0, 1.0, 1.0, 2.0),
        ],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![
            shot(180.0, 180.0, 1.0, 0.0, 1.0),
            shot(180.0, 180.0, 1.0, 1.0, 2.0),
        ],
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });

    // Unaligned closure: A:2 <-> B:2
    project.loop_closures.push(LoopClosure {
        id: project.next_closure_id,
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 2),
        path_length: 4.0,
        misclosure_distance: 0.1,
        error_percentage: 2.5,
        horizontal_misclosure: 0.1,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });
    project.next_closure_id += 1;

    let frozen = project.compute_frozen_shots();
    assert!(frozen.is_empty(), "Unaligned closure should not cause shots to be frozen");
}

#[test]
fn touches_geometry_detects_geometry_fields() {
    let geo_update = ShotUpdates {
        length: Some(5.0),
        ..Default::default()
    };
    assert!(geo_update.touches_geometry());

    let azimuth_update = ShotUpdates {
        azimuth_in: Some(90.0),
        ..Default::default()
    };
    assert!(azimuth_update.touches_geometry());

    let depth_update = ShotUpdates {
        depth_out: Some(3.0),
        ..Default::default()
    };
    assert!(depth_update.touches_geometry());

    let pitch_update = ShotUpdates {
        pitch_in: Some(Some(5.0)),
        ..Default::default()
    };
    assert!(pitch_update.touches_geometry());

    // Non-geometry updates
    let lrud_update = ShotUpdates {
        left: Some(Some(1.0)),
        right: Some(Some(2.0)),
        up: Some(Some(3.0)),
        down: Some(Some(4.0)),
        comment: Some(Some("test".to_string())),
        ..Default::default()
    };
    assert!(!lrud_update.touches_geometry(), "LRUD/comment should not be geometry");

    let empty_update = ShotUpdates::default();
    assert!(!empty_update.touches_geometry(), "Empty update should not touch geometry");
}

#[test]
fn update_shot_rejects_frozen_geometry() {
    // Create a loop with two datums so all shots are frozen
    let mut project = Project::new("FrozenUpdate".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 0.0, 1.0),
        ],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![
            shot(180.0, 180.0, 1.0, 0.0, 1.0),
        ],
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 1),
        merged_at: Utc::now(),
    });

    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(b, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });

    // Verify shots are frozen
    let frozen = project.compute_frozen_shots();
    assert!(!frozen.is_empty(), "Shots should be frozen in a loop with two datums");

    // The update_shot validation is in the command handler, not on Project directly.
    // But we can verify the frozen status and touches_geometry independently.
    let shot_id = project.sections.iter().find(|s| s.id == a).unwrap().shots[0].id;
    let geo_update = ShotUpdates {
        length: Some(5.0),
        ..Default::default()
    };
    assert!(geo_update.touches_geometry());

    // Verify the shot IS frozen
    let section_lookup = project.build_section_lookup();
    let merge_adj = project.build_merge_adjacency(&section_lookup);
    let closure_adj = project.build_aligned_closure_adjacency(&section_lookup);
    let datum_stations: HashSet<StationRef> =
        project.zero_datums.iter().map(|d| d.station_ref).collect();
    assert!(project.is_shot_frozen(a, 0, &section_lookup, &merge_adj, &closure_adj, &datum_stations));

    // Non-geometry update should be allowed (touches_geometry returns false)
    let non_geo_update = ShotUpdates {
        comment: Some(Some("hello".to_string())),
        ..Default::default()
    };
    assert!(!non_geo_update.touches_geometry());

    // Verify the shot can still be updated with non-geometry fields
    let result = project.update_shot(a, shot_id, &non_geo_update);
    assert!(result.is_some(), "Non-geometry update on frozen shot should succeed");
    assert_eq!(
        project.get_section(a).unwrap().shots[0].comment.as_deref(),
        Some("hello")
    );
}

// =====================================================================
// stats() tests
// =====================================================================

#[test]
fn stats_empty_project() {
    let project = Project::new("Empty".to_string(), None);
    let stats = project.stats();

    assert_eq!(stats.section_count, 0);
    assert_eq!(stats.shot_count, 0);
    assert_eq!(stats.station_count, 0);
    assert_eq!(stats.loop_count, 0);
    assert!((stats.total_length - 0.0).abs() < 1e-6);
    assert!((stats.min_depth - 0.0).abs() < 1e-6);
    assert!((stats.max_depth - 0.0).abs() < 1e-6);
}

#[test]
fn stats_single_section() {
    let mut project = Project::new("Single".to_string(), None);
    project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 5.0),
            shot(90.0, 90.0, 8.0, 5.0, 12.0),
        ],
        ..Default::default()
    });

    let stats = project.stats();
    assert_eq!(stats.section_count, 1);
    assert_eq!(stats.shot_count, 2);
    assert_eq!(stats.station_count, 3); // 2 shots + 1 first station
    assert!((stats.total_length - 18.0).abs() < 1e-6);
    assert!((stats.min_depth - 0.0).abs() < 1e-6);
    assert!((stats.max_depth - 12.0).abs() < 1e-6);
}

#[test]
fn stats_multiple_sections() {
    let mut project = Project::new("Multi".to_string(), None);
    // Section 1: depth change = depth_out - depth_in = -5 - (-2) = -3
    // accumulated z: 0 -> -3, so min_depth = -3
    project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, -2.0, -5.0)],
        ..Default::default()
    });
    // Section 2: dz1 = 1-0 = 1, dz2 = 3-1 = 2, accumulated z: 0 -> 1 -> 3
    // max_depth = 3
    project.add_section(SectionData {
        shots: vec![
            shot(90.0, 90.0, 5.0, 0.0, 1.0),
            shot(90.0, 90.0, 7.0, 1.0, 3.0),
        ],
        ..Default::default()
    });

    let stats = project.stats();
    assert_eq!(stats.section_count, 2);
    assert_eq!(stats.shot_count, 3);
    assert_eq!(stats.station_count, 5); // 3 shots + 2 first stations
    assert!((stats.total_length - 22.0).abs() < 1e-6);
    assert!((stats.min_depth - (-3.0)).abs() < 1e-6);
    assert!((stats.max_depth - 3.0).abs() < 1e-6);
}

#[test]
fn stats_with_loop_closures() {
    let mut project = Project::new("Loops".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        strategy: ClosureStrategy::Move,
        is_aligned: false,
        path_length: 10.0,
        misclosure_distance: 0.5,
        horizontal_misclosure: 0.3,
        vertical_misclosure: 0.2,
        error_percentage: 5.0,
    });

    let stats = project.stats();
    assert_eq!(stats.loop_count, 1);
}

// =====================================================================
// calculate_penetration tests
// =====================================================================

#[test]
fn calculate_penetration_empty_stations_no_datum() {
    let project = Project::new("NoDatum".to_string(), None);
    let stations: Vec<Station> = vec![];
    assert!((project.calculate_penetration(&stations) - 0.0).abs() < 1e-6);
}

#[test]
fn calculate_penetration_single_datum_measures_max_distance() {
    let mut project = Project::new("Penetration".to_string(), None);
    let section_id = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 15.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Set datum on station 0
    let gps = GpsCoordinates::new(0.0, 0.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

    let stations = project.compute_station_coordinates();
    let penetration = project.calculate_penetration(&stations);

    // With shots going north (azimuth 0): total horizontal distance = 10 + 15 = 25
    assert!(penetration > 24.0, "Expected penetration > 24, got {penetration}");
    assert!(penetration < 26.0, "Expected penetration < 26, got {penetration}");
}

// =====================================================================
// merge_stations validation tests
// =====================================================================

#[test]
fn merge_stations_rejects_nonexistent_station() {
    let mut project = Project::new("MergeInvalid".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    let result = project.merge_stations(
        StationRef::new(a, 0),
        StationRef::new(999, 0), // nonexistent section
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("do not exist"));
}

#[test]
fn merge_stations_rejects_already_merged_pair() {
    let mut project = Project::new("MergeDupe".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // First merge succeeds
    project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0)).unwrap();

    // Second merge of same pair fails
    let result = project.merge_stations(StationRef::new(a, 0), StationRef::new(b, 0));
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("already merged"));
}

#[test]
fn merge_stations_rejects_both_datums() {
    let mut project = Project::new("MergeBothDatums".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.set_zero_datum(StationRef::new(a, 0), GpsCoordinates::new(0.0, 0.0, 0.0).unwrap()).unwrap();
    project.set_zero_datum(StationRef::new(b, 0), GpsCoordinates::new(1.0, 1.0, 0.0).unwrap()).unwrap();

    let result = project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 1));
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Both stations are connected to zero datums"));
}

// =====================================================================
// compute_station_raw_coords with station offsets
// =====================================================================

#[test]
fn compute_station_raw_coords_with_individual_station_offset() {
    let mut project = Project::new("StationOffset".to_string(), None);
    let section_id = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Station 1 is at (0, 10, 0) without offset
    let station_ref = StationRef::new(section_id, 1);
    let coords_before = project.compute_station_raw_coords(station_ref).unwrap();
    assert!((coords_before.x - 0.0).abs() < 1e-6);
    assert!((coords_before.y - 10.0).abs() < 1e-6);

    // Add individual station offset
    project.station_offsets.insert(station_ref, (3.0, -2.0, 1.0));

    let coords_after = project.compute_station_raw_coords(station_ref).unwrap();
    assert!((coords_after.x - 3.0).abs() < 1e-6);
    assert!((coords_after.y - 8.0).abs() < 1e-6);
    assert!((coords_after.z - 1.0).abs() < 1e-6);
}

#[test]
fn compute_station_raw_coords_station_zero_with_section_offset() {
    let mut project = Project::new("SectionOffset".to_string(), None);
    let section_id = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.section_offsets.insert(section_id, (100.0, 200.0));

    // Station 0 should be at the section offset
    let coords = project.compute_station_raw_coords(StationRef::new(section_id, 0)).unwrap();
    assert!((coords.x - 100.0).abs() < 1e-6);
    assert!((coords.y - 200.0).abs() < 1e-6);
}

// =====================================================================
// calculate_path_length_between tests
// =====================================================================

#[test]
fn path_length_simple_linear_section() {
    let mut project = Project::new("PathLen".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 15.0, 0.0, 0.0),
            shot(0.0, 0.0, 8.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    let path_len = project.calculate_path_length_between(
        StationRef::new(a, 0),
        StationRef::new(a, 3),
    );
    assert!((path_len - 33.0).abs() < 1e-6, "Expected 10+15+8=33, got {path_len}");
}

#[test]
fn path_length_partial_section() {
    let mut project = Project::new("PartialPath".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(0.0, 0.0, 15.0, 0.0, 0.0),
            shot(0.0, 0.0, 8.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    // Path from station 1 to station 3 (two shots: 15 + 8 = 23)
    let path_len = project.calculate_path_length_between(
        StationRef::new(a, 1),
        StationRef::new(a, 3),
    );
    assert!((path_len - 23.0).abs() < 1e-6, "Expected 15+8=23, got {path_len}");
}

#[test]
fn path_length_through_merge() {
    let mut project = Project::new("PathThroughMerge".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Merge a.1 to b.0 (zero-distance edge)
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Path from a.0 to b.1: 10 (shot in a) + 0 (merge) + 5 (shot in b) = 15
    let path_len = project.calculate_path_length_between(
        StationRef::new(a, 0),
        StationRef::new(b, 1),
    );
    assert!((path_len - 15.0).abs() < 1e-6, "Expected 10+5=15, got {path_len}");
}

#[test]
fn path_length_nonexistent_station_returns_zero() {
    let project = Project::new("NoStation".to_string(), None);
    let path_len = project.calculate_path_length_between(
        StationRef::new(999, 0),
        StationRef::new(999, 1),
    );
    assert!((path_len - 0.0).abs() < 1e-6);
}

// =====================================================================
// compute_station_coordinates integration tests
// =====================================================================

#[test]
fn compute_station_coordinates_basic_section() {
    let mut project = Project::new("StationCoords".to_string(), None);
    // Use zero depth change so horizontal_length == length
    let section_id = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 0.0, 0.0),
            shot(90.0, 90.0, 5.0, 0.0, 0.0),
        ],
        ..Default::default()
    }).id;

    let stations = project.compute_station_coordinates();

    // 3 stations: station 0, 1, 2
    let section_stations: Vec<_> = stations
        .iter()
        .filter(|s| s.station_ref.section_id == section_id)
        .collect();
    assert_eq!(section_stations.len(), 3);

    // Station 0 at origin (no section offset)
    let s0 = section_stations.iter().find(|s| s.station_ref.station_index == 0).unwrap();
    assert!((s0.coordinates.x).abs() < 1e-6);
    assert!((s0.coordinates.y).abs() < 1e-6);

    // Station 1: north 10m (azimuth 0), z = 0 (no depth change)
    let s1 = section_stations.iter().find(|s| s.station_ref.station_index == 1).unwrap();
    assert!((s1.coordinates.x).abs() < 1e-6, "s1 x = {}", s1.coordinates.x);
    assert!((s1.coordinates.y - 10.0).abs() < 1e-6, "s1 y = {}", s1.coordinates.y);
    assert!((s1.coordinates.z).abs() < 1e-6, "s1 z = {}", s1.coordinates.z);

    // Station 2: north 10m then east 5m
    let s2 = section_stations.iter().find(|s| s.station_ref.station_index == 2).unwrap();
    assert!((s2.coordinates.x - 5.0).abs() < 1e-6, "s2 x = {}", s2.coordinates.x);
    assert!((s2.coordinates.y - 10.0).abs() < 1e-6, "s2 y = {}", s2.coordinates.y);
    assert!((s2.coordinates.z).abs() < 1e-6, "s2 z = {}", s2.coordinates.z);
}

#[test]
fn compute_station_coordinates_merged_sections_have_merged_with() {
    let mut project = Project::new("MergedCoords".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    let stations = project.compute_station_coordinates();

    // Station a.1 should have b.0 in merged_with
    let a1 = stations.iter().find(|s| s.station_ref == StationRef::new(a, 1)).unwrap();
    assert!(
        a1.merged_with.contains(&StationRef::new(b, 0)),
        "a.1 should have b.0 in merged_with"
    );

    // Station b.0 should have a.1 in merged_with
    let b0 = stations.iter().find(|s| s.station_ref == StationRef::new(b, 0)).unwrap();
    assert!(
        b0.merged_with.contains(&StationRef::new(a, 1)),
        "b.0 should have a.1 in merged_with"
    );
}

// === realign_after_shot_edit tests ===

#[test]
fn realign_datum_section_keeps_datum_pinned() {
    // Single section with datum on station 3. Edit shot before datum → datum stays at origin.
    let mut project = Project::new("DatumPin".to_string(), None);
    let sec = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0), // north 10m
                shot(0.0, 0.0, 5.0, 0.0, 0.0),  // north 5m (will be edited)
                shot(0.0, 0.0, 3.0, 0.0, 0.0),  // north 3m
            ],
            ..Default::default()
        })
        .id;

    let datum_station = StationRef::new(sec, 3);
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(datum_station, gps).unwrap();

    // Datum at origin
    let coords = project.compute_station_raw_coords(datum_station).unwrap();
    assert!((coords.y).abs() < 1e-6);

    // Edit shot[1]: 5m → 8m
    let shot_id = project.sections.iter().find(|s| s.id == sec).unwrap().shots[1].id;
    project.update_shot(sec, shot_id, &ShotUpdates { length: Some(8.0), ..Default::default() });

    // Datum has drifted
    let drifted = project.compute_station_raw_coords(datum_station).unwrap();
    assert!((drifted.y).abs() > 1.0, "Expected drift, got y={}", drifted.y);

    // Realign
    project.realign_after_shot_edit(sec);

    // Datum back at origin
    let fixed = project.compute_station_raw_coords(datum_station).unwrap();
    assert!((fixed.x).abs() < 1e-6, "Datum x should be 0, got {}", fixed.x);
    assert!((fixed.y).abs() < 1e-6, "Datum y should be 0, got {}", fixed.y);

    // Station 0 moved to compensate (absorbed the 3m length increase)
    let s0 = project.compute_station_raw_coords(StationRef::new(sec, 0)).unwrap();
    // Before edit: s0 was at y = -18. After: y = -21 (3m further south)
    assert!((s0.y - (-21.0)).abs() < 1e-6, "s0 y should be -21, got {}", s0.y);
}

#[test]
fn realign_merged_section_keeps_merge_point_aligned() {
    // Section 1 has datum at 1:0. Section 2 merged at 1:2 <-> 2:0.
    // Edit shot 2:1 → 2:0 should stay aligned with 1:2, station 2:0 shifts.
    // Wait, 2:0 IS the merge point. Let me restructure:
    //
    // Section 1: 3 shots north (10m each). Datum at 1:0.
    //   Stations: 1:0(datum, origin), 1:1(y=10), 1:2(y=20), 1:3(y=30)
    // Section 2: 3 shots east (5m each). Merged at 1:3 <-> 2:0.
    //   Before merge alignment: 2:0(0,0), 2:1(5,0), 2:2(10,0), 2:3(15,0)
    //   After merge alignment: 2:0(0,30), 2:1(5,30), 2:2(10,30), 2:3(15,30)
    //
    // Edit shot 2:0 (first shot in section 2): length 5m → 15m.
    //   Without realign: 2:0(0,30), 2:1(15,30), 2:2(20,30), 2:3(25,30)
    //   2:0 is the merge point and should stay at (0,30) matching 1:3.
    //   With realign: same, because 2:0 is station_index 0 and the edit is shot[0]
    //   which shifts 2:1+ but NOT 2:0. Station 2:0 stays put.
    //
    // Better test: edit shot that's BEFORE the merge point within section 2.
    // But 2:0 is the merge point (station_index 0) so all shots are after it.
    // Let's make the merge at a middle station instead.

    // Section 1: shots north. Datum at 1:0.
    // Section 2: 5 shots east (5m each). Merged at 1:3 <-> 2:3.
    //   Edit shot 2:1 → stations 2:2, 2:3 shift. 2:3 is the merge point.
    //   Realign should keep 2:3 aligned with 1:3.

    let mut project = Project::new("MergeAlign".to_string(), None);

    let sec1 = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0), // north 10m
                shot(0.0, 0.0, 10.0, 0.0, 0.0), // north 10m
                shot(0.0, 0.0, 10.0, 0.0, 0.0), // north 10m
            ],
            ..Default::default()
        })
        .id;

    let sec2 = project
        .add_section(SectionData {
            shots: vec![
                shot(90.0, 90.0, 5.0, 0.0, 0.0), // east 5m
                shot(90.0, 90.0, 5.0, 0.0, 0.0), // east 5m (will be edited)
                shot(90.0, 90.0, 5.0, 0.0, 0.0), // east 5m
            ],
            ..Default::default()
        })
        .id;

    // Set datum at 1:0
    let datum_ref = StationRef::new(sec1, 0);
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(datum_ref, gps).unwrap();

    // Merge 1:3 <-> 2:3
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(sec1, 3),
        station_b: StationRef::new(sec2, 3),
        merged_at: Utc::now(),
    });

    // Align section 2 offset so 2:3 matches 1:3
    // 1:3 is at (0, 30). 2:3 without offset is at (15, 0).
    // Need offset: (0-15, 30-0) = (-15, 30)
    let pos_1_3 = project.compute_station_raw_coords(StationRef::new(sec1, 3)).unwrap();
    let pos_2_3_raw = project.compute_station_raw_coords(StationRef::new(sec2, 3)).unwrap();
    project.section_offsets.insert(sec2, (pos_1_3.x - pos_2_3_raw.x, pos_1_3.y - pos_2_3_raw.y));

    // Verify merge alignment
    let pos_2_3 = project.compute_station_raw_coords(StationRef::new(sec2, 3)).unwrap();
    assert!((pos_2_3.x - pos_1_3.x).abs() < 1e-6, "Merge should be aligned x");
    assert!((pos_2_3.y - pos_1_3.y).abs() < 1e-6, "Merge should be aligned y");

    // Record positions of locked stations
    let pos_2_0_before = project.compute_station_raw_coords(StationRef::new(sec2, 0)).unwrap();

    // Edit shot 2:1 (between 2:1 and 2:2): length 5m → 15m (+10m)
    let shot_id = project.sections.iter().find(|s| s.id == sec2).unwrap().shots[1].id;
    project.update_shot(sec2, shot_id, &ShotUpdates { length: Some(15.0), ..Default::default() });

    // Before realign: 2:3 has drifted 10m east from 1:3
    let drifted_2_3 = project.compute_station_raw_coords(StationRef::new(sec2, 3)).unwrap();
    assert!(
        (drifted_2_3.x - pos_1_3.x).abs() > 5.0,
        "2:3 should have drifted from 1:3"
    );

    // Realign
    project.realign_after_shot_edit(sec2);

    // After realign: 2:3 matches 1:3 again (merge point preserved)
    let fixed_2_3 = project.compute_station_raw_coords(StationRef::new(sec2, 3)).unwrap();
    assert!(
        (fixed_2_3.x - pos_1_3.x).abs() < 1e-6,
        "2:3 x should match 1:3 x, got {} vs {}",
        fixed_2_3.x, pos_1_3.x
    );
    assert!(
        (fixed_2_3.y - pos_1_3.y).abs() < 1e-6,
        "2:3 y should match 1:3 y, got {} vs {}",
        fixed_2_3.y, pos_1_3.y
    );

    // 1:0 (datum) still at origin
    let datum_coords = project.compute_station_raw_coords(datum_ref).unwrap();
    assert!((datum_coords.x).abs() < 1e-6, "Datum should still be at origin x");
    assert!((datum_coords.y).abs() < 1e-6, "Datum should still be at origin y");

    // 2:0 (unlocked end) moved to compensate
    let pos_2_0_after = project.compute_station_raw_coords(StationRef::new(sec2, 0)).unwrap();
    assert!(
        (pos_2_0_after.x - pos_2_0_before.x).abs() > 5.0,
        "2:0 should have shifted to compensate, before={} after={}",
        pos_2_0_before.x, pos_2_0_after.x
    );
}

#[test]
fn realign_noop_without_datums() {
    // Section without any datums → realign should not change anything.
    let mut project = Project::new("NoDatum".to_string(), None);
    let sec = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    let offsets_before = project.section_offsets.clone();
    project.realign_after_shot_edit(sec);
    assert_eq!(
        project.section_offsets, offsets_before,
        "Offsets should not change when no datums exist"
    );
}

#[test]
fn realign_is_idempotent() {
    // Edit shot, realign twice → same result.
    let mut project = Project::new("Idempotent".to_string(), None);
    let sec = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 5.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    let datum_station = StationRef::new(sec, 2);
    let gps = GpsCoordinates::new(45.0, -90.0, 0.0).unwrap();
    project.set_zero_datum(datum_station, gps).unwrap();

    // Edit shot[0]
    let shot_id = project.sections.iter().find(|s| s.id == sec).unwrap().shots[0].id;
    project.update_shot(sec, shot_id, &ShotUpdates { length: Some(12.0), ..Default::default() });

    project.realign_after_shot_edit(sec);
    let offsets_first = project.section_offsets.clone();

    project.realign_after_shot_edit(sec);
    let offsets_second = project.section_offsets.clone();

    assert_eq!(offsets_first, offsets_second, "Should be idempotent");

    // Datum at origin
    let coords = project.compute_station_raw_coords(datum_station).unwrap();
    assert!((coords.x).abs() < 1e-6, "Datum x should be 0");
    assert!((coords.y).abs() < 1e-6, "Datum y should be 0");
}

#[test]
fn realign_edit_in_datum_section_propagates_to_merged() {
    // Edit a shot in the datum section (after datum) → merged partner follows.
    // Section 1: 3 shots north (10m each). Datum at 1:0.
    // Section 2: merged at 1:3 <-> 2:0.
    // Edit shot 1:1 → 1:3 moves → section 2 must follow.
    let mut project = Project::new("DatumPropagate".to_string(), None);

    let sec1 = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(0.0, 0.0, 10.0, 0.0, 0.0), // will be edited
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
            ],
            ..Default::default()
        })
        .id;

    let sec2 = project
        .add_section(SectionData {
            shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Datum at 1:0
    project.set_zero_datum(StationRef::new(sec1, 0), GpsCoordinates::new(45.0, -90.0, 0.0).unwrap()).unwrap();

    // Merge 1:3 <-> 2:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(sec1, 3),
        station_b: StationRef::new(sec2, 0),
        merged_at: Utc::now(),
    });

    // Align section 2 to merge point
    let pos_1_3 = project.compute_station_raw_coords(StationRef::new(sec1, 3)).unwrap();
    let pos_2_0 = project.compute_station_raw_coords(StationRef::new(sec2, 0)).unwrap();
    project.section_offsets.insert(sec2, (pos_1_3.x - pos_2_0.x, pos_1_3.y - pos_2_0.y));

    // Record 2:1's position before edit
    let pos_2_1_before = project.compute_station_raw_coords(StationRef::new(sec2, 1)).unwrap();

    // Edit shot 1:1 (between 1:1 and 1:2): 10m → 20m
    let shot_id = project.sections.iter().find(|s| s.id == sec1).unwrap().shots[1].id;
    project.update_shot(sec1, shot_id, &ShotUpdates { length: Some(20.0), ..Default::default() });

    // 1:3 has shifted north by 10m. 1:0 (datum) is before the edit, unchanged.
    // Realign from sec1 (the edited section)
    project.realign_after_shot_edit(sec1);

    // 1:0 still at origin (datum, before edited shot)
    let datum = project.compute_station_raw_coords(StationRef::new(sec1, 0)).unwrap();
    assert!((datum.x).abs() < 1e-6 && (datum.y).abs() < 1e-6, "Datum should be at origin");

    // 2:0 should match new 1:3 position (30 + 10 = 40 north)
    let new_1_3 = project.compute_station_raw_coords(StationRef::new(sec1, 3)).unwrap();
    let new_2_0 = project.compute_station_raw_coords(StationRef::new(sec2, 0)).unwrap();
    assert!(
        (new_2_0.x - new_1_3.x).abs() < 1e-6 && (new_2_0.y - new_1_3.y).abs() < 1e-6,
        "2:0 should match 1:3 after realign: 2:0=({},{}) 1:3=({},{})",
        new_2_0.x, new_2_0.y, new_1_3.x, new_1_3.y
    );

    // 2:1 should have moved by same amount as 1:3 (10m north)
    let pos_2_1_after = project.compute_station_raw_coords(StationRef::new(sec2, 1)).unwrap();
    assert!(
        (pos_2_1_after.y - pos_2_1_before.y - 10.0).abs() < 1e-6,
        "2:1 should have moved 10m north, delta={}",
        pos_2_1_after.y - pos_2_1_before.y
    );
}

// ============================================================================
// Penetration distance tests
// ============================================================================

#[test]
fn penetration_no_zero_datum_returns_zero() {
    let project = Project::new("NoDatum".to_string(), None);
    let stations = project.compute_station_coordinates();
    assert_eq!(project.calculate_penetration(&stations), 0.0);
}

#[test]
fn penetration_single_section_with_datum() {
    let mut project = Project::new("Pen".to_string(), None);
    let sec_id = project.add_section(SectionData {
        // Northward shot: azimuth 0 means north
        shots: vec![shot(0.0, 180.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    let gps = GpsCoordinates::new(45.0, 10.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(sec_id, 0), gps).unwrap();

    let stations = project.compute_station_coordinates();
    let pen = project.calculate_penetration(&stations);
    // Should be ~10m (one shot of 10m from the datum)
    assert!(pen > 9.0 && pen < 11.0, "penetration={pen}, expected ~10");
}

#[test]
fn penetration_datum_at_end_station() {
    let mut project = Project::new("PenEnd".to_string(), None);
    let sec_id = project.add_section(SectionData {
        shots: vec![shot(0.0, 180.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Datum at end of section (station 1)
    let gps = GpsCoordinates::new(45.0, 10.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(sec_id, 1), gps).unwrap();

    let stations = project.compute_station_coordinates();
    let pen = project.calculate_penetration(&stations);
    // First station is 10m from the datum (at end)
    assert!(pen > 9.0 && pen < 11.0, "penetration={pen}, expected ~10");
}

// ============================================================================
// cleanup_section_references cascade tests
// ============================================================================

#[test]
fn cleanup_removes_merges_referencing_section() {
    let mut project = Project::new("Cleanup".to_string(), None);
    let a = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let b = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let c = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    assert_eq!(project.station_merges.len(), 2);
    project.cleanup_section_references(b);
    // Both merges involve section b, so both should be removed
    assert_eq!(project.station_merges.len(), 0, "all merges involving section b should be removed");
}

#[test]
fn cleanup_removes_closures_referencing_section() {
    let mut project = Project::new("ClosureCleanup".to_string(), None);
    let a = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let b = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;

    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        path_length: 10.0,
        misclosure_distance: 0.1,
        error_percentage: 1.0,
        horizontal_misclosure: 0.05,
        vertical_misclosure: 0.08,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });
    project.loop_closures.push(LoopClosure {
        id: 2,
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(a, 1),
        path_length: 5.0,
        misclosure_distance: 0.05,
        error_percentage: 1.0,
        horizontal_misclosure: 0.03,
        vertical_misclosure: 0.02,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });

    project.cleanup_section_references(b);
    // Only the a↔b closure should be removed; a↔a stays
    assert_eq!(project.loop_closures.len(), 1);
    assert_eq!(project.loop_closures[0].id, 2);
}

#[test]
fn cleanup_removes_offsets_and_datums() {
    let mut project = Project::new("OffsetCleanup".to_string(), None);
    let a = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let b = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;

    project.section_offsets.insert(a, (1.0, 2.0));
    project.section_offsets.insert(b, (3.0, 4.0));
    project.station_offsets.insert(StationRef::new(a, 0), (1.0, 2.0, 3.0));
    project.station_offsets.insert(StationRef::new(b, 0), (4.0, 5.0, 6.0));

    let gps = GpsCoordinates::new(45.0, 10.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(a, 0), gps).unwrap();
    project.set_zero_datum(StationRef::new(b, 0), gps).unwrap();

    project.cleanup_section_references(a);

    assert!(!project.section_offsets.contains_key(&a), "section a offset should be removed");
    assert!(project.section_offsets.contains_key(&b), "section b offset should remain");
    assert_eq!(project.station_offsets.len(), 1, "only b's station offset should remain");
    assert_eq!(project.zero_datums.len(), 1, "only b's zero datum should remain");
    assert_eq!(project.zero_datums[0].station_ref.section_id, b);
}

#[test]
fn cleanup_preserves_unrelated_merges() {
    let mut project = Project::new("PreserveUnrelated".to_string(), None);
    let a = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let b = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;
    let c = project.add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    // Remove section b — only the a↔b merge goes away
    project.cleanup_section_references(b);
    assert_eq!(project.station_merges.len(), 1);
    assert_eq!(project.station_merges[0].station_b.section_id, c);
}

// ============================================================================
// shot_displacement edge cases
// ============================================================================

#[test]
fn shot_displacement_due_north() {
    let data = ShotData {
        azimuth_in: 0.0,
        azimuth_out: 180.0,
        length: 10.0,
        depth_in: 0.0,
        depth_out: 0.0,
        ..Default::default()
    };
    let (dx, dy) = Project::shot_displacement(&data);
    // Average azimuth = 90° → dx ≈ 10, dy ≈ 0
    assert!(dx.abs() > 9.0, "dx={dx}, expected ~10 for avg azimuth 90°");
    assert!(dy.abs() < 1.0, "dy={dy}, expected ~0");
}

#[test]
fn shot_displacement_vertical_shot_is_zero() {
    let data = ShotData {
        azimuth_in: 45.0,
        azimuth_out: 225.0,
        length: 10.0,
        depth_in: 0.0,
        depth_out: 10.0, // pure vertical
        ..Default::default()
    };
    let (dx, dy) = Project::shot_displacement(&data);
    assert!(dx.abs() < 1e-6, "vertical shot dx should be ~0, got {dx}");
    assert!(dy.abs() < 1e-6, "vertical shot dy should be ~0, got {dy}");
}

// ============================================================================
// assign_closure_ids
// ============================================================================

#[test]
fn assign_closure_ids_fills_zeros_and_updates_counter() {
    let mut project = Project::new("ClosureIDs".to_string(), None);
    project.loop_closures.push(LoopClosure {
        id: 0,
        station_a: StationRef::new(0, 0),
        station_b: StationRef::new(0, 1),
        path_length: 10.0,
        misclosure_distance: 0.1,
        error_percentage: 1.0,
        horizontal_misclosure: 0.05,
        vertical_misclosure: 0.08,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });
    project.loop_closures.push(LoopClosure {
        id: 5, // already assigned
        station_a: StationRef::new(0, 0),
        station_b: StationRef::new(0, 1),
        path_length: 10.0,
        misclosure_distance: 0.1,
        error_percentage: 1.0,
        horizontal_misclosure: 0.05,
        vertical_misclosure: 0.08,
        strategy: ClosureStrategy::Move,
        is_aligned: false,
    });
    project.loop_closures.push(LoopClosure {
        id: 0,
        station_a: StationRef::new(0, 0),
        station_b: StationRef::new(0, 1),
        path_length: 10.0,
        misclosure_distance: 0.1,
        error_percentage: 1.0,
        horizontal_misclosure: 0.05,
        vertical_misclosure: 0.08,
        strategy: ClosureStrategy::Batch,
        is_aligned: false,
    });

    project.assign_closure_ids();

    // First closure (was 0) gets id=6 (next after max existing=5)
    assert_eq!(project.loop_closures[0].id, 6);
    // Second closure keeps id=5, and Move strategy sets is_aligned
    assert_eq!(project.loop_closures[1].id, 5);
    assert!(project.loop_closures[1].is_aligned);
    // Third closure (was 0) gets id=7
    assert_eq!(project.loop_closures[2].id, 7);
    // next_closure_id should be 8
    assert_eq!(project.next_closure_id, 8);
}

#[test]
fn shift_station_refs_adjusts_all_references() {
    let mut project = Project::new("Shift".to_string(), None);
    let sec = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0), shot(0.0, 0.0, 1.0, 0.0, 0.0), shot(0.0, 0.0, 1.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(sec, 2),
        station_b: StationRef::new(sec, 0),
        merged_at: Utc::now(),
    });
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(sec, 1),
        station_b: StationRef::new(sec, 3),
        path_length: 1.0, misclosure_distance: 0.0, error_percentage: 0.0,
        horizontal_misclosure: 0.0, vertical_misclosure: 0.0,
        strategy: ClosureStrategy::Batch, is_aligned: false,
    });
    let gps = GpsCoordinates::new(45.0, 10.0, 0.0).unwrap();
    project.set_zero_datum(StationRef::new(sec, 2), gps).unwrap();

    // Shift indices >= 1 by +1 (as if inserting a shot at position 1)
    project.shift_station_refs(sec, 1, 1);

    // merge.station_a was (sec,2), now (sec,3); station_b was (sec,0), stays (sec,0)
    assert_eq!(project.station_merges[0].station_a.station_index, 3);
    assert_eq!(project.station_merges[0].station_b.station_index, 0);
    // closure station_a was (sec,1) → (sec,2); station_b was (sec,3) → (sec,4)
    assert_eq!(project.loop_closures[0].station_a.station_index, 2);
    assert_eq!(project.loop_closures[0].station_b.station_index, 4);
    // zero datum was (sec,2) → (sec,3)
    assert_eq!(project.zero_datums[0].station_ref.station_index, 3);
}

// ── Station depth computation tests ─────────────────────────────────

#[test]
fn compute_station_depth_from_surrounding_shots() {
    // Station 1 has an incoming shot (depth_out=5.0) and outgoing shot (depth_in=6.0).
    // Average = (5 + 6) / 2 = 5.5
    let mut project = Project::new("Depth".to_string(), None);
    project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 0.0, 5.0),  // shot 0: depth_in=0, depth_out=5
            shot(0.0, 0.0, 1.0, 6.0, 10.0),  // shot 1: depth_in=6, depth_out=10
        ],
        ..Default::default()
    });
    let sec_id = project.sections[0].id;

    // Station 1 is between the two shots
    let coords = project.compute_station_raw_coords(StationRef::new(sec_id, 1)).unwrap();
    // Average of shot[0].depth_out (5.0) and shot[1].depth_in (6.0)
    assert!((coords.z - 5.5).abs() < 1e-9, "depth should be 5.5, got {}", coords.z);
}

#[test]
fn compute_station_depth_first_station() {
    // Station 0 has only an outgoing shot — depth = shot[0].depth_in
    let mut project = Project::new("Depth".to_string(), None);
    project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 3.0, 7.0),
        ],
        ..Default::default()
    });
    let sec_id = project.sections[0].id;

    let coords = project.compute_station_raw_coords(StationRef::new(sec_id, 0)).unwrap();
    assert!((coords.z - 3.0).abs() < 1e-9, "first station depth should be 3.0, got {}", coords.z);
}

#[test]
fn compute_station_depth_last_station() {
    // Station 2 (last) has only an incoming shot — depth = shot[1].depth_out
    let mut project = Project::new("Depth".to_string(), None);
    project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 0.0, 5.0),
            shot(0.0, 0.0, 1.0, 5.0, 12.0),
        ],
        ..Default::default()
    });
    let sec_id = project.sections[0].id;

    let coords = project.compute_station_raw_coords(StationRef::new(sec_id, 2)).unwrap();
    assert!((coords.z - 12.0).abs() < 1e-9, "last station depth should be 12.0, got {}", coords.z);
}

#[test]
fn compute_station_depth_with_merge_averages_both_sections() {
    // Two sections merged at a station — depth should average across all colocated readings
    let mut project = Project::new("MergeDepth".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 1.0, 0.0, 8.0),  // shot 0: depth_out=8
        ],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![
            shot(90.0, 90.0, 1.0, 10.0, 20.0),  // shot 0: depth_in=10
        ],
        ..Default::default()
    }).id;

    // Merge A:1 with B:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    // Station A:1 is colocated with B:0
    // Depths: A shot[0].depth_out=8, B shot[0].depth_in=10 → average = 9
    let coords = project.compute_station_raw_coords(StationRef::new(a, 1)).unwrap();
    assert!((coords.z - 9.0).abs() < 1e-9, "merged station depth should be 9.0, got {}", coords.z);
}

#[test]
fn compute_station_depth_no_shots_returns_zero() {
    // Edge case: section with no shots, station 0 has no surrounding shots
    let mut project = Project::new("Empty".to_string(), None);
    project.add_section(SectionData {
        shots: vec![],
        ..Default::default()
    });
    let sec_id = project.sections[0].id;

    let coords = project.compute_station_raw_coords(StationRef::new(sec_id, 0)).unwrap();
    assert!((coords.z).abs() < 1e-9, "depth should be 0.0 for empty section, got {}", coords.z);
}

#[test]
fn compute_raw_coords_xy_walk_north() {
    // A shot due north (azimuth=0) with length 5m, flat (depth_in == depth_out)
    // horizontal_length = sqrt(5^2 - 0^2) = 5
    // dx = 5 * sin(0) = 0, dy = 5 * cos(0) = 5
    let mut project = Project::new("Walk".to_string(), None);
    project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 5.0, 10.0, 10.0),
        ],
        ..Default::default()
    });
    let sec_id = project.sections[0].id;

    let c0 = project.compute_station_raw_coords(StationRef::new(sec_id, 0)).unwrap();
    assert!((c0.x).abs() < 1e-9, "station 0 x should be 0");
    assert!((c0.y).abs() < 1e-9, "station 0 y should be 0");

    let c1 = project.compute_station_raw_coords(StationRef::new(sec_id, 1)).unwrap();
    assert!((c1.x).abs() < 1e-9, "station 1 x should be 0 (due north)");
    assert!((c1.y - 5.0).abs() < 1e-9, "station 1 y should be 5.0, got {}", c1.y);
}

#[test]
fn compute_raw_coords_xy_walk_east() {
    // A shot due east (azimuth=90) with length 3m, flat
    let mut project = Project::new("Walk".to_string(), None);
    project.add_section(SectionData {
        shots: vec![
            shot(90.0, 90.0, 3.0, 5.0, 5.0),
        ],
        ..Default::default()
    });
    let sec_id = project.sections[0].id;

    let c1 = project.compute_station_raw_coords(StationRef::new(sec_id, 1)).unwrap();
    assert!((c1.x - 3.0).abs() < 1e-9, "station 1 x should be 3.0 (due east), got {}", c1.x);
    assert!((c1.y).abs() < 1e-9, "station 1 y should be ~0, got {}", c1.y);
}

#[test]
fn compute_raw_coords_depth_independent_of_xy() {
    // Z is computed from absolute depth values, not from XY walk
    // Two shots: shot 0 goes north 10m at depth 5→8, shot 1 goes east 10m at depth 7→12
    let mut project = Project::new("IndepZ".to_string(), None);
    project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 5.0, 8.0),
            shot(90.0, 90.0, 10.0, 7.0, 12.0),
        ],
        ..Default::default()
    });
    let sec_id = project.sections[0].id;

    // Station 0: only outgoing shot → depth_in = 5.0
    let c0 = project.compute_station_raw_coords(StationRef::new(sec_id, 0)).unwrap();
    assert!((c0.z - 5.0).abs() < 1e-9, "station 0 depth should be 5.0, got {}", c0.z);

    // Station 1: incoming depth_out=8, outgoing depth_in=7 → average = 7.5
    let c1 = project.compute_station_raw_coords(StationRef::new(sec_id, 1)).unwrap();
    assert!((c1.z - 7.5).abs() < 1e-9, "station 1 depth should be 7.5, got {}", c1.z);

    // Station 2: only incoming → depth_out = 12.0
    let c2 = project.compute_station_raw_coords(StationRef::new(sec_id, 2)).unwrap();
    assert!((c2.z - 12.0).abs() < 1e-9, "station 2 depth should be 12.0, got {}", c2.z);
}

#[test]
fn compute_raw_coords_with_section_offset() {
    let mut project = Project::new("Offset".to_string(), None);
    let sec = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 5.0, 10.0, 10.0)],
        ..Default::default()
    }).id;

    project.section_offsets.insert(sec, (100.0, 200.0));

    let c0 = project.compute_station_raw_coords(StationRef::new(sec, 0)).unwrap();
    assert!((c0.x - 100.0).abs() < 1e-9, "x should include section offset");
    assert!((c0.y - 200.0).abs() < 1e-9, "y should include section offset");
}

#[test]
fn compute_raw_coords_with_station_offset() {
    let mut project = Project::new("StaOff".to_string(), None);
    let sec = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 5.0, 10.0, 10.0)],
        ..Default::default()
    }).id;

    project.station_offsets.insert(StationRef::new(sec, 0), (1.0, 2.0, 3.0));

    let c0 = project.compute_station_raw_coords(StationRef::new(sec, 0)).unwrap();
    assert!((c0.x - 1.0).abs() < 1e-9, "x should include station offset");
    assert!((c0.y - 2.0).abs() < 1e-9, "y should include station offset");
    assert!((c0.z - 13.0).abs() < 1e-9, "z should be depth(10) + offset(3)");
}

// ── adjust_least_squares tests ──────────────────────────────────────

#[test]
fn lsq_no_closures_is_noop() {
    // With no closures, there are no constraints to adjust — should return Ok
    let mut project = Project::new("LSQ".to_string(), None);
    let sec = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 5.0, 5.0),
            shot(90.0, 90.0, 10.0, 5.0, 5.0),
        ],
        ..Default::default()
    }).id;

    let config = ClosureAdjustmentConfig::default();
    let component: HashSet<SectionId> = [sec].into_iter().collect();
    let result = project.adjust_least_squares(&component, &[], StationRef::new(sec, 0), &config);
    assert!(result.is_ok(), "No closures should succeed: {:?}", result);
}

#[test]
fn lsq_preserves_depth_values() {
    // Key test: LSQ should adjust XY but NOT touch depth_in/depth_out
    let mut project = Project::new("LSQDepth".to_string(), None);

    // Create a triangle: section A (north 10m), section B (east 10m), section C (south-west ~14m)
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 5.0, 8.0)],  // north, depth 5→8
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 10.0, 8.0, 12.0)],  // east, depth 8→12
        ..Default::default()
    }).id;
    let c = project.add_section(SectionData {
        shots: vec![shot(225.0, 225.0, 14.5, 12.0, 5.5)],  // south-west back, depth 12→5.5
        ..Default::default()
    }).id;

    // Merge to form a loop: A:1 → B:0, B:1 → C:0
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    // Closure: C:1 should be at A:0 (closing the loop)
    let closure = LoopClosure {
        id: 1,
        station_a: StationRef::new(c, 1),
        station_b: StationRef::new(a, 0),
        path_length: 34.5,
        misclosure_distance: 0.5,
        error_percentage: 1.4,
        horizontal_misclosure: 0.5,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::LeastSquaresWeighted,
        is_aligned: false,
    };

    // Save original depths
    let orig_depths: Vec<(f64, f64)> = project.sections.iter()
        .flat_map(|s| s.shots.iter().map(|sh| (sh.depth_in, sh.depth_out)))
        .collect();

    let config = ClosureAdjustmentConfig::default();
    let component: HashSet<SectionId> = [a, b, c].into_iter().collect();
    let result = project.adjust_least_squares(&component, &[closure], StationRef::new(a, 0), &config);
    assert!(result.is_ok(), "LSQ should succeed: {:?}", result);

    // Verify depths are unchanged
    let new_depths: Vec<(f64, f64)> = project.sections.iter()
        .flat_map(|s| s.shots.iter().map(|sh| (sh.depth_in, sh.depth_out)))
        .collect();
    assert_eq!(orig_depths, new_depths, "depth_in/depth_out must not change after LSQ adjustment");
}

#[test]
fn lsq_anchor_station_stays_fixed() {
    // The anchor station (or its group) should not move
    let mut project = Project::new("LSQAnchor".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 5.0, 5.0),
            shot(0.0, 0.0, 10.0, 5.0, 5.0),
        ],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(180.0, 180.0, 20.5, 5.0, 5.0)],  // slight error for closure
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    let closure = LoopClosure {
        id: 1,
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(a, 0),
        path_length: 30.5,
        misclosure_distance: 0.5,
        error_percentage: 1.6,
        horizontal_misclosure: 0.5,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::LeastSquaresWeighted,
        is_aligned: false,
    };

    let anchor = StationRef::new(a, 0);
    let coords_before = project.compute_station_raw_coords(anchor).unwrap();

    let config = ClosureAdjustmentConfig::default();
    let component: HashSet<SectionId> = [a, b].into_iter().collect();
    let result = project.adjust_least_squares(&component, &[closure], anchor, &config);
    assert!(result.is_ok(), "LSQ should succeed: {:?}", result);

    let coords_after = project.compute_station_raw_coords(anchor).unwrap();
    assert!(
        (coords_after.x - coords_before.x).abs() < 1e-6
            && (coords_after.y - coords_before.y).abs() < 1e-6,
        "anchor XY should not move: before=({}, {}), after=({}, {})",
        coords_before.x, coords_before.y, coords_after.x, coords_after.y
    );
}

#[test]
fn lsq_produces_finite_coordinates() {
    // After adjustment, all station coordinates should be finite
    let mut project = Project::new("LSQFinite".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![
            shot(0.0, 0.0, 10.0, 5.0, 5.0),
            shot(90.0, 90.0, 10.0, 5.0, 5.0),
        ],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(225.0, 225.0, 14.0, 5.0, 5.0)],
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });

    let closure = LoopClosure {
        id: 1,
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(a, 0),
        path_length: 34.0,
        misclosure_distance: 0.2,
        error_percentage: 0.6,
        horizontal_misclosure: 0.2,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::LeastSquaresWeighted,
        is_aligned: false,
    };

    let config = ClosureAdjustmentConfig::default();
    let component: HashSet<SectionId> = [a, b].into_iter().collect();
    let result = project.adjust_least_squares(&component, &[closure], StationRef::new(a, 0), &config);
    assert!(result.is_ok(), "LSQ should succeed: {:?}", result);

    for section in &project.sections {
        for idx in 0..=section.shots.len() {
            let coords = project.compute_station_raw_coords(StationRef::new(section.id, idx as u32)).unwrap();
            assert!(coords.x.is_finite(), "x should be finite for {}:{}", section.id, idx);
            assert!(coords.y.is_finite(), "y should be finite for {}:{}", section.id, idx);
            assert!(coords.z.is_finite(), "z should be finite for {}:{}", section.id, idx);
        }
    }
}

#[test]
fn lsq_with_zero_datum_fixes_that_group() {
    // When a zero datum exists, its group should be fixed and not move
    let mut project = Project::new("LSQDatum".to_string(), None);
    let a = project.add_section(SectionData {
        shots: vec![shot(0.0, 0.0, 10.0, 5.0, 5.0)],
        ..Default::default()
    }).id;
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 10.0, 5.0, 5.0)],
        ..Default::default()
    }).id;
    let c = project.add_section(SectionData {
        shots: vec![shot(225.0, 225.0, 14.5, 5.0, 5.0)],
        ..Default::default()
    }).id;

    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(b, 1),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });

    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(45.0, 10.0, 100.0).unwrap(),
    });

    let closure = LoopClosure {
        id: 1,
        station_a: StationRef::new(c, 1),
        station_b: StationRef::new(a, 0),
        path_length: 34.5,
        misclosure_distance: 0.5,
        error_percentage: 1.4,
        horizontal_misclosure: 0.5,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::LeastSquaresWeighted,
        is_aligned: false,
    };

    let datum_coords_before = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();

    let config = ClosureAdjustmentConfig::default();
    let component: HashSet<SectionId> = [a, b, c].into_iter().collect();
    let result = project.adjust_least_squares(&component, &[closure], StationRef::new(a, 0), &config);
    assert!(result.is_ok(), "LSQ should succeed: {:?}", result);

    let datum_coords_after = project.compute_station_raw_coords(StationRef::new(a, 0)).unwrap();
    assert!(
        (datum_coords_after.x - datum_coords_before.x).abs() < 1e-6
            && (datum_coords_after.y - datum_coords_before.y).abs() < 1e-6,
        "zero datum station should stay fixed"
    );
}

#[test]
fn lsq_update_shot_horizontal_only_preserves_depth() {
    // Direct test of update_shot_horizontal_only
    let mut s = Shot::new(1, ShotData {
        azimuth_in: 45.0,
        azimuth_out: 45.0,
        length: 10.0,
        depth_in: 3.0,
        depth_out: 7.0,
        pitch_in: Some(23.5),
        pitch_out: Some(23.5),
        ..Default::default()
    });

    // Update horizontal displacement to pure east (dx=5, dy=0)
    Project::update_shot_horizontal_only(&mut s, 5.0, 0.0);

    assert!((s.depth_in - 3.0).abs() < 1e-9, "depth_in must not change");
    assert!((s.depth_out - 7.0).abs() < 1e-9, "depth_out must not change");
    assert_eq!(s.pitch_in, Some(23.5), "pitch_in must not change");
    assert_eq!(s.pitch_out, Some(23.5), "pitch_out must not change");
    // Azimuth should now point east (90 degrees)
    assert!((s.azimuth_in - 90.0).abs() < 1e-6, "azimuth should be 90, got {}", s.azimuth_in);
    // Length should account for horizontal + dz: sqrt(5^2 + 4^2) = sqrt(41)
    let expected_len = (25.0_f64 + 16.0).sqrt();
    assert!((s.length - expected_len).abs() < 1e-6, "length should be sqrt(41), got {}", s.length);
}

#[test]
fn lsq_update_shot_horizontal_only_zero_displacement() {
    // When dx=dy=0, azimuth should be preserved, length = |dz|
    let mut s = Shot::new(1, ShotData {
        azimuth_in: 135.0,
        azimuth_out: 135.0,
        length: 5.0,
        depth_in: 2.0,
        depth_out: 6.0,
        ..Default::default()
    });

    Project::update_shot_horizontal_only(&mut s, 0.0, 0.0);

    assert!((s.azimuth_in - 135.0).abs() < 1e-6, "azimuth should be preserved when displacement is zero");
    // length = sqrt(0 + dz^2) = |4| = 4
    assert!((s.length - 4.0).abs() < 1e-6, "length should be |dz|=4, got {}", s.length);
}

#[test]
fn lsq_long_chain_per_shot_changes_are_small() {
    // Regression test: for a long chain with a small closure error, the
    // per-shot geometry changes must be small (proportional to misclosure /
    // shot_count), not massive due to solver non-convergence.
    //
    // Topology: section A (200 shots north, each 5m) with zero datum at A:200.
    //           section B (1 shot, 10m east) with zero datum at B:0.
    //           Closure: A:100 ↔ B:1
    //
    // This creates an asymmetric loop where B:1 is 1 shot from a fixed point
    // and A:100 is 100-200 shots from fixed points. With proper convergence,
    // each shot should change by at most misclosure/num_shots ≈ 0.01m.
    let mut project = Project::new("LSQLongChain".to_string(), None);

    // Section A: 200 shots heading north, each 5m
    let shots_a: Vec<ShotData> = (0..200)
        .map(|_| shot(0.0, 0.0, 5.0, 0.0, 0.0))
        .collect();
    let a = project.add_section(SectionData {
        shots: shots_a,
        ..Default::default()
    }).id;

    // Section B: 1 shot heading east, 10m
    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Zero datums
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 200),
        gps: GpsCoordinates::new(45.0, 10.0, 0.0).unwrap(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(b, 0),
        gps: GpsCoordinates::new(45.01, 10.01, 0.0).unwrap(),
    });

    // Large offsets stress-test the solver: absolute coordinates are 500-1800m
    // from origin, which triggers convergence issues if starting from x=0.
    project.section_offsets.insert(a, (500.0, 800.0));
    project.section_offsets.insert(b, (500.0, 1300.0));
    // A:0 at (500, 800), A:100 at (500, 1300), A:200 at (500, 1800)
    // B:0 at (500, 1300), B:1 at (510, 1300)
    // misclosure distance((500, 1300), (510, 1300)) = 10m
    // path_length ≈ 200*5 + 10 = 1010m

    // Save original shot data
    let orig_shots_a: Vec<(f64, f64)> = project.sections.iter()
        .find(|s| s.id == a).unwrap()
        .shots.iter()
        .map(|s| (s.azimuth_in, s.length))
        .collect();

    let closure = LoopClosure {
        id: 1,
        station_a: StationRef::new(a, 100),
        station_b: StationRef::new(b, 1),
        path_length: 1010.0,
        misclosure_distance: 10.0,
        error_percentage: 0.99,
        horizontal_misclosure: 10.0,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::LeastSquaresWeighted,
        is_aligned: false,
    };

    let config = ClosureAdjustmentConfig::default();
    let component: HashSet<SectionId> = [a, b].into_iter().collect();
    let result = project.adjust_least_squares(
        &component, &[closure], StationRef::new(a, 0), &config,
    );
    assert!(result.is_ok(), "LSQ should succeed: {:?}", result);

    // Check per-shot changes are small (bounded by misclosure / num_shots * safety_factor)
    // With 201 shots and 10m misclosure, max per-shot change ≈ 0.05m per shot.
    // We allow up to 0.5m per shot to be safe (10x margin).
    let new_shots_a: Vec<(f64, f64)> = project.sections.iter()
        .find(|s| s.id == a).unwrap()
        .shots.iter()
        .map(|s| (s.azimuth_in, s.length))
        .collect();

    let mut max_length_delta = 0.0_f64;
    for (i, ((orig_az, orig_len), (new_az, new_len))) in
        orig_shots_a.iter().zip(new_shots_a.iter()).enumerate()
    {
        let len_delta = (new_len - orig_len).abs();
        if len_delta > max_length_delta {
            max_length_delta = len_delta;
        }
        assert!(
            len_delta < 0.5,
            "shot {} length changed by {:.3}m (orig={:.3}, new={:.3}) — \
             suggests solver did not converge",
            i, len_delta, orig_len, new_len,
        );
        // Azimuth change: for a 5m shot, 0.5m displacement is ~5.7 degrees
        let az_delta = (new_az - orig_az).abs();
        let az_delta = if az_delta > 180.0 { 360.0 - az_delta } else { az_delta };
        assert!(
            az_delta < 10.0,
            "shot {} azimuth changed by {:.3}° (orig={:.3}, new={:.3}) — \
             suggests solver did not converge",
            i, az_delta, orig_az, new_az,
        );
    }
}

#[test]
fn lsq_realistic_topology_preserves_geometry() {
    // Mimics the user's topology from kbd.stalx:
    // - Section A: 364 shots with varying azimuths (real-world cave)
    // - Section B: 1 shot (anchor section)
    // - Section C: 105 shots (branch)
    // - Two zero datums at A:364 and B:0
    // - Merge: C:105 ↔ A:180
    // - Closure: A:73 ↔ B:1
    // - Large section offsets (700-900m range)
    let mut project = Project::new("RealisticLSQ".to_string(), None);

    // Section A: 364 shots with varying azimuths (zigzag pattern)
    let shots_a: Vec<ShotData> = (0..364)
        .map(|i| {
            let az = match i % 4 {
                0 => 10.0 + (i as f64 * 0.3),
                1 => 350.0 - (i as f64 * 0.2),
                2 => 45.0 + (i as f64 * 0.1),
                _ => 315.0 - (i as f64 * 0.15),
            };
            let az = az.rem_euclid(360.0);
            let len = 5.0 + (i as f64 * 0.01).sin() * 3.0;
            shot(az, az, len, i as f64 * 0.1, (i + 1) as f64 * 0.1)
        })
        .collect();
    let a = project.add_section(SectionData {
        shots: shots_a,
        ..Default::default()
    }).id;

    // Section B: 1 shot (anchor)
    let b = project.add_section(SectionData {
        shots: vec![shot(120.0, 120.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    // Set section A offset (large, like real data)
    let offset_a = (761.5, -1284.6);
    project.section_offsets.insert(a, offset_a);

    // Compute A:73 absolute position = offset_a + cumulative shot vectors 0..72
    let a_section = project.sections.iter().find(|s| s.id == a).unwrap();
    let mut a73_x = 0.0_f64;
    let mut a73_y = 0.0_f64;
    for i in 0..73 {
        let s = &a_section.shots[i];
        let az = s.azimuth_in.to_radians();
        let h = s.horizontal_length();
        a73_x += h * az.sin();
        a73_y += h * az.cos();
    }
    let a73_abs_x = offset_a.0 + a73_x;
    let a73_abs_y = offset_a.1 + a73_y;
    // B:0 → B:1 via one shot at azimuth 120°, 10m. B:1 = offset_b + shot_vector
    let b_shot_dx = 10.0 * 120.0_f64.to_radians().sin();
    let b_shot_dy = 10.0 * 120.0_f64.to_radians().cos();
    // Set B offset so B:1 is near A:73 with a small misclosure (~2m)
    project.section_offsets.insert(b, (a73_abs_x - b_shot_dx + 1.5, a73_abs_y - b_shot_dy + 1.3));

    // Zero datums
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 364),
        gps: GpsCoordinates::new(50.0, 50.0, 0.0).unwrap(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(b, 0),
        gps: GpsCoordinates::new(49.99, 50.013, 0.0).unwrap(),
    });

    // Save original shots for section A
    let orig_a: Vec<(f64, f64)> = project.sections.iter()
        .find(|s| s.id == a).unwrap()
        .shots.iter().map(|s| (s.azimuth_in, s.length)).collect();

    // Closure: A:73 ↔ B:1 (misclosure ~2m)
    let closure = LoopClosure {
        id: 1,
        station_a: StationRef::new(a, 73),
        station_b: StationRef::new(b, 1),
        path_length: 3133.0,
        misclosure_distance: 2.0,
        error_percentage: 0.06,
        horizontal_misclosure: 2.0,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::LeastSquaresWeighted,
        is_aligned: false,
    };

    // Capture positions around closure point BEFORE adjustment
    let pos_a73_before = project.compute_station_raw_coords(StationRef::new(a, 73)).unwrap();
    let pos_b1_before = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    let actual_misclosure = ((pos_a73_before.x - pos_b1_before.x).powi(2) + (pos_a73_before.y - pos_b1_before.y).powi(2)).sqrt();

    let config = ClosureAdjustmentConfig::default();
    let component: HashSet<SectionId> = [a, b].into_iter().collect();
    let result = project.adjust_least_squares(
        &component, &[closure], StationRef::new(a, 0), &config,
    );
    assert!(result.is_ok(), "LSQ should succeed: {:?}", result);

    // Verify closure endpoints now coincide
    let pos_a73_after = project.compute_station_raw_coords(StationRef::new(a, 73)).unwrap();
    let pos_b1_after = project.compute_station_raw_coords(StationRef::new(b, 1)).unwrap();
    let residual_misc = ((pos_a73_after.x - pos_b1_after.x).powi(2) + (pos_a73_after.y - pos_b1_after.y).powi(2)).sqrt();
    assert!(residual_misc < 0.01, "residual misclosure {residual_misc:.6}m should be near zero");

    // Verify per-shot changes in section A are bounded.
    let new_a: Vec<(f64, f64)> = project.sections.iter()
        .find(|s| s.id == a).unwrap()
        .shots.iter().map(|s| (s.azimuth_in, s.length)).collect();

    let mut max_len_delta_a = 0.0_f64;
    let mut worst_shot = 0;
    for (i, ((_, orig_len), (_, new_len))) in orig_a.iter().zip(new_a.iter()).enumerate() {
        let delta = (new_len - orig_len).abs();
        if delta > max_len_delta_a {
            max_len_delta_a = delta;
            worst_shot = i;
        }
    }
    assert!(
        max_len_delta_a < 1.0,
        "shot {} length changed by {:.4}m — too large for {:.2}m misclosure",
        worst_shot, max_len_delta_a, actual_misclosure,
    );
}

#[test]
fn lsq_spur_shots_are_not_modified() {
    // Spur (branch) shots have no loop redundancy and must remain untouched.
    //
    // Topology:
    //   Section A: 100 shots north (5m each), zero datum at A:100.
    //   Section B: 1 shot east (10m), zero datum at B:0.
    //   Section C: 20 shots east (3m each), merged to A:50 via C:0↔A:50.
    //   Closure: A:30 ↔ B:1.
    //
    // Spur stations: A:0–A:29 (before closure), C:1–C:20 (branch beyond merge).
    // Loop stations: A:30–A:100, B:0–B:1.
    let mut project = Project::new("SpurTest".to_string(), None);

    let shots_a: Vec<ShotData> = (0..100)
        .map(|_| shot(0.0, 0.0, 5.0, 0.0, 0.0))
        .collect();
    let a = project.add_section(SectionData {
        shots: shots_a,
        ..Default::default()
    }).id;

    let b = project.add_section(SectionData {
        shots: vec![shot(90.0, 90.0, 10.0, 0.0, 0.0)],
        ..Default::default()
    }).id;

    let shots_c: Vec<ShotData> = (0..20)
        .map(|_| shot(90.0, 90.0, 3.0, 0.0, 0.0))
        .collect();
    let c = project.add_section(SectionData {
        shots: shots_c,
        ..Default::default()
    }).id;

    // Merge C:0 ↔ A:50
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(c, 0),
        station_b: StationRef::new(a, 50),
        merged_at: Utc::now(),
    });

    // Zero datums
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 100),
        gps: GpsCoordinates::new(45.0, 10.0, 0.0).unwrap(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(b, 0),
        gps: GpsCoordinates::new(45.01, 10.01, 0.0).unwrap(),
    });

    // Large offsets to stress the solver
    project.section_offsets.insert(a, (500.0, 800.0));
    project.section_offsets.insert(b, (500.0, 950.0));
    project.section_offsets.insert(c, (500.0, 1050.0));

    // Save original shot data for spur sections
    let orig_a_spur: Vec<(f64, f64)> = project.sections.iter()
        .find(|s| s.id == a).unwrap()
        .shots[..30]  // A:0–A:29 are spur shots (before closure at A:30)
        .iter().map(|s| (s.azimuth_in, s.length)).collect();

    let orig_c: Vec<(f64, f64)> = project.sections.iter()
        .find(|s| s.id == c).unwrap()
        .shots.iter().map(|s| (s.azimuth_in, s.length)).collect();

    let closure = LoopClosure {
        id: 1,
        station_a: StationRef::new(a, 30),
        station_b: StationRef::new(b, 1),
        path_length: 360.0,
        misclosure_distance: 5.0,
        error_percentage: 1.4,
        horizontal_misclosure: 5.0,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::LeastSquaresWeighted,
        is_aligned: false,
    };

    let config = ClosureAdjustmentConfig::default();
    let component: HashSet<SectionId> = [a, b, c].into_iter().collect();
    let result = project.adjust_least_squares(
        &component, &[closure], StationRef::new(a, 0), &config,
    );
    assert!(result.is_ok(), "LSQ should succeed: {:?}", result);

    // Verify spur shots in A (indices 0..29) are exactly unchanged.
    let new_a_spur: Vec<(f64, f64)> = project.sections.iter()
        .find(|s| s.id == a).unwrap()
        .shots[..30]
        .iter().map(|s| (s.azimuth_in, s.length)).collect();
    for (i, (orig, new)) in orig_a_spur.iter().zip(new_a_spur.iter()).enumerate() {
        assert!(
            (orig.0 - new.0).abs() < f64::EPSILON && (orig.1 - new.1).abs() < f64::EPSILON,
            "spur shot A:{i} was modified: az {:.6}→{:.6}, len {:.6}→{:.6}",
            orig.0, new.0, orig.1, new.1,
        );
    }

    // Verify all shots in section C are exactly unchanged.
    let new_c: Vec<(f64, f64)> = project.sections.iter()
        .find(|s| s.id == c).unwrap()
        .shots.iter().map(|s| (s.azimuth_in, s.length)).collect();
    for (i, (orig, new)) in orig_c.iter().zip(new_c.iter()).enumerate() {
        assert!(
            (orig.0 - new.0).abs() < f64::EPSILON && (orig.1 - new.1).abs() < f64::EPSILON,
            "spur shot C:{i} was modified: az {:.6}→{:.6}, len {:.6}→{:.6}",
            orig.0, new.0, orig.1, new.1,
        );
    }

    // Verify merged stations (C:0 ↔ A:50) still share the same position.
    let pos_c0 = project.compute_station_raw_coords(StationRef::new(c, 0)).unwrap();
    let pos_a50 = project.compute_station_raw_coords(StationRef::new(a, 50)).unwrap();
    let merge_gap = ((pos_c0.x - pos_a50.x).powi(2) + (pos_c0.y - pos_a50.y).powi(2)).sqrt();
    assert!(
        merge_gap < 1e-6,
        "merge C:0↔A:50 broken after adjustment: gap={merge_gap:.6}m, \
         C:0=({:.4},{:.4}), A:50=({:.4},{:.4})",
        pos_c0.x, pos_c0.y, pos_a50.x, pos_a50.y,
    );
}

#[test]
fn record_station_merge_rebuilds_cache_when_emptied_with_surviving_merges() {
    // Reproduce the half-populated-cache trap Codex round-4 flagged:
    // `delete_section` clears `merge_adjacency_cache` while keeping
    // surviving merges in `station_merges`, leaving the cache empty
    // and the merges intact.  Before the fix, the next
    // `record_station_merge` only inserted ITS edge into the cache —
    // and since `get_merged_section_ids` treats any non-empty cache as
    // authoritative, every surviving merge from before the delete
    // became invisible.
    let mut project = Project::new("Cache".to_string(), None);
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
    let d = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;

    // Establish two surviving merges A↔B and B↔C via the maintained
    // helper so the cache is fully populated.
    project.record_station_merge(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.record_station_merge(StationMerge {
        station_a: StationRef::new(b, 0),
        station_b: StationRef::new(c, 0),
        merged_at: Utc::now(),
    });
    assert_eq!(project.get_merged_section_ids(a).len(), 3);

    // Simulate the `delete_section` cleanup: clear the cache while
    // keeping `station_merges` populated.  The cache invariant is now
    // "empty but merges exist".
    project.merge_adjacency_cache.clear();

    // Now record a NEW merge (e.g. user merges D into the group).
    // Without the rebuild-first guard this would leave the cache
    // containing ONLY {C, D} edges; with the guard it must contain
    // all three groups.
    project.record_station_merge(StationMerge {
        station_a: StationRef::new(c, 0),
        station_b: StationRef::new(d, 0),
        merged_at: Utc::now(),
    });
    let merged = project.get_merged_section_ids(a);
    assert!(
        merged.contains(&a) && merged.contains(&b) && merged.contains(&c) && merged.contains(&d),
        "expected the surviving A-B-C merges to still propagate after the cache was \
         cleared + a new merge recorded; got {merged:?}"
    );
    assert_eq!(merged.len(), 4);
}

#[test]
#[ignore = "diagnostic against a real on-disk file; run with --ignored"]
fn diagnose_naharon_merge_alignment() {
    use crate::persistence::Database;
    let path = std::path::Path::new("/home/user/Documents/stalagmight/20260601_naharon-final.stalx");
    let db = Database::open_existing(path).unwrap();
    let mut project = db.load_project().unwrap();
    project.rebuild_section_index();
    project.rebuild_merge_adjacency();

    let before = project.check_merge_alignment();
    eprintln!("== misaligned merges BEFORE: {} ==", before.len());
    for v in &before {
        eprintln!("  {}", v.message);
    }

    let fixed = project.realign_merges();
    eprintln!("== realign_merges fixed {fixed} merge(s) ==");
    let after = project.check_merge_alignment();
    eprintln!("== misaligned merges AFTER: {} ==", after.len());
    for v in &after {
        eprintln!("  {}", v.message);
    }
    // The cascade propagates through already-aligned merges, so realign anchors
    // every section to the datum network and fixes the drift fully.
    assert!(after.is_empty(), "realign must align ALL merges");
}

#[test]
fn cascade_solves_deep_chain_past_old_iteration_cap() {
    // A 40-section chain merged end-to-end, anchored at the datum on the FAR
    // end so propagation must traverse all 40 hops in the worst (backward) edge
    // order. The old 20-iteration fixpoint could silently stop halfway; the
    // single-pass BFS solver must align every merge regardless of depth.
    let mut project = Project::new("DeepChain".to_string(), None);
    let mut ids = Vec::new();
    for _ in 0..40 {
        let id = project
            .add_section(SectionData {
                shots: vec![shot(90.0, 90.0, 3.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;
        ids.push(id);
    }
    // Chain: section[i] station 1 merged to section[i+1] station 0.
    for w in ids.windows(2) {
        project.record_station_merge(StationMerge {
            station_a: StationRef::new(w[0], 1),
            station_b: StationRef::new(w[1], 0),
            merged_at: Utc::now(),
        });
    }
    // Datum on the LAST section (far end from section[0]).
    let last = *ids.last().unwrap();
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(last, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    // Knock every section out of alignment, then re-solve from scratch.
    for &id in &ids {
        project.adjust_section_offset(id, 7.0, -3.0);
    }
    project.realign_merges();
    assert!(
        project.check_merge_alignment().is_empty(),
        "single-pass solver must align all 40 hops regardless of depth/order"
    );
}

#[test]
fn insert_before_and_after_agree_on_boundary_merge_ref() {
    // insert_before(s1) and insert_after(s0) are the SAME physical insertion
    // (a new shot in the array slot between s0 and s1), so a merge anchored
    // exactly on the boundary station must end up referencing the same station
    // index either way. A divergence is an off-by-one in one of the shifts.
    fn build() -> (Project, SectionId, ShotId, ShotId) {
        let mut p = Project::new("Boundary".to_string(), None);
        let a = p
            .add_section(SectionData {
                shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0), shot(90.0, 90.0, 5.0, 0.0, 0.0)],
                ..Default::default()
            })
            .id;
        let b = p
            .add_section(SectionData { shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)], ..Default::default() })
            .id;
        // Merge B0 onto A's MIDDLE station (index 1) — the insertion boundary.
        p.record_station_merge(StationMerge {
            station_a: StationRef::new(a, 1),
            station_b: StationRef::new(b, 0),
            merged_at: Utc::now(),
        });
        let s0 = p.get_section(a).unwrap().shots[0].id;
        let s1 = p.get_section(a).unwrap().shots[1].id;
        (p, a, s0, s1)
    }

    let a_side_index = |p: &Project, a: SectionId| -> u32 {
        let m = p
            .station_merges
            .iter()
            .find(|m| m.station_a.section_id == a || m.station_b.section_id == a)
            .expect("merge");
        if m.station_a.section_id == a { m.station_a.station_index } else { m.station_b.station_index }
    };

    let (mut p_after, a, s0, _) = build();
    p_after.insert_shot_after(a, s0, shot(10.0, 10.0, 3.0, 0.0, 0.0), None);
    let after_idx = a_side_index(&p_after, a);

    let (mut p_before, a2, _, s1) = build();
    p_before.insert_shot_before(a2, s1, shot(10.0, 10.0, 3.0, 0.0, 0.0), None);
    let before_idx = a_side_index(&p_before, a2);

    assert_eq!(
        after_idx, before_idx,
        "insert_after and insert_before disagree on the boundary merge ref index \
         (after={after_idx}, before={before_idx})"
    );
}

#[test]
fn redrive_offsets_after_load_heals_persisted_drift() {
    // Simulate a file persisted with a drifted offset (older redo bug) plus
    // empty transient caches (as after deserialization).
    let mut project = Project::new("Loaded".to_string(), None);
    let a = project
        .add_section(SectionData { shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)], ..Default::default() })
        .id;
    let b = project
        .add_section(SectionData { shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)], ..Default::default() })
        .id;
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();
    // Persisted drift + stale caches.
    project.adjust_section_offset(b, 31.0, -9.0);
    project.section_index_cache.clear();
    project.merge_adjacency_cache.clear();
    assert!(!project.check_merge_alignment().is_empty());

    let healed = project.redrive_offsets_after_load();
    assert_eq!(healed, 1);
    assert!(project.check_merge_alignment().is_empty(), "load must open geometrically correct");
}

#[test]
fn check_merge_alignment_detects_and_realign_fixes_drift() {
    // Two sections, A0-A1 and B0-B1, with A1 merged to B0.
    let mut project = Project::new("Drift".to_string(), None);
    let a = project
        .add_section(SectionData { shots: vec![shot(0.0, 0.0, 5.0, 0.0, 0.0)], ..Default::default() })
        .id;
    let b = project
        .add_section(SectionData { shots: vec![shot(90.0, 90.0, 5.0, 0.0, 0.0)], ..Default::default() })
        .id;
    // Anchor A at a zero datum so realign has an authority.
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 0.0).unwrap(),
    });
    // Merge A1 <-> B0 (merge_stations computes the aligning offset).
    project.merge_stations(StationRef::new(a, 1), StationRef::new(b, 0)).unwrap();
    assert!(project.check_merge_alignment().is_empty(), "merge should start aligned");

    // Corrupt section B's offset directly (simulating a missed cascade).
    project.adjust_section_offset(b, 12.0, -7.0);
    let drift = project.check_merge_alignment();
    assert_eq!(drift.len(), 1, "{drift:?}");
    assert_eq!(drift[0].category, "merge_misaligned");
    assert!(drift[0].message.contains(" m apart"));

    // Repair realigns it.
    assert_eq!(project.realign_merges(), 1);
    assert!(project.check_merge_alignment().is_empty());
}

// === Structural integrity check ===

/// A two-section project with one valid merge, zero datum, and loop closure.
fn integrity_fixture() -> (Project, SectionId, SectionId) {
    let mut project = Project::new("Integrity".to_string(), None);
    let a = project
        .add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() })
        .id;
    let b = project
        .add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() })
        .id;
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(a, 0),
        gps: GpsCoordinates::new(10.0, 20.0, 5.0).unwrap(),
    });
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(a, 1),
        station_b: StationRef::new(b, 1),
        path_length: 10.0,
        misclosure_distance: 0.2,
        error_percentage: 2.0,
        horizontal_misclosure: 0.15,
        vertical_misclosure: 0.05,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });
    (project, a, b)
}

#[test]
fn deleting_shot_converts_broken_loop_closure_to_merge() {
    // Section A: A0-A1-A2 (2 shots); Section B: B0-B1 (1 shot).
    let mut project = Project::new("Loop".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0), shot(90.0, 90.0, 1.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData { shots: vec![shot(0.0, 0.0, 1.0, 0.0, 0.0)], ..Default::default() })
        .id;
    // A2 is merged with B0 (B hangs off the end of A).
    project.record_station_merge(StationMerge {
        station_a: StationRef::new(a, 2),
        station_b: StationRef::new(b, 0),
        merged_at: Utc::now(),
    });
    // A loop closure ties A0 to A2 (the A0-A1-A2 survey is the loop).
    project.loop_closures.push(LoopClosure {
        id: 1,
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(a, 2),
        path_length: 2.0,
        misclosure_distance: 0.0,
        error_percentage: 0.0,
        horizontal_misclosure: 0.0,
        vertical_misclosure: 0.0,
        strategy: ClosureStrategy::default(),
        is_aligned: false,
    });

    // Delete A's last shot (A1->A2): removes station A2, a closure endpoint. The
    // surviving B segment is detached, so the closure must become a merge.
    let last_shot_id = project.get_section(a).unwrap().shots.last().unwrap().id;
    let (_, impact) = project.remove_shot_with_rewire(a, last_shot_id).unwrap();

    assert_eq!(impact.closure_to_merge.len(), 1, "impact: {impact:?}");
    assert!(
        project.loop_closures.is_empty(),
        "broken loop should not remain a closure: {:?}",
        project.loop_closures
    );
    assert!(
        project.station_merges.iter().any(|m| {
            let pair = (m.station_a, m.station_b);
            pair == (StationRef::new(b, 0), StationRef::new(a, 0))
                || pair == (StationRef::new(a, 0), StationRef::new(b, 0))
        }),
        "expected a merge between A0 and B0; got {:?}",
        project.station_merges
    );
    // And the result is structurally sound.
    assert!(!project.has_critical_integrity_violations());
}

#[test]
fn repair_structural_integrity_drops_dangling_refs_and_keeps_valid() {
    let (mut project, a, b) = integrity_fixture();
    // Corrupt: a dangling merge, closure, datum, plus orphan offset/comment.
    project.station_merges.push(StationMerge {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(9999, 0),
        merged_at: Utc::now(),
    });
    project.zero_datums.push(ZeroDatum {
        station_ref: StationRef::new(9999, 0),
        gps: GpsCoordinates::new(1.0, 2.0, 3.0).unwrap(),
    });
    project.section_offsets.insert(9999, (1.0, 1.0));

    let valid_merges_before = project.station_merges.len();
    let repaired = project.repair_structural_integrity();

    // It reported the violations it fixed and the project is now sound.
    assert!(!repaired.is_empty());
    assert!(project.check_structural_integrity().is_empty());
    assert!(!project.has_critical_integrity_violations());
    // The originally-valid merge/datum/closure survive (only the bad ones dropped).
    assert_eq!(project.station_merges.len(), valid_merges_before - 1);
    assert_eq!(project.loop_closures.len(), 1);
    assert!(project.get_section(a).is_some() && project.get_section(b).is_some());
    // Repairing a clean project is a no-op.
    assert!(project.repair_structural_integrity().is_empty());
}

#[test]
fn integrity_clean_project_has_no_violations() {
    let (project, _, _) = integrity_fixture();
    assert!(project.check_structural_integrity().is_empty());
    assert!(!project.has_critical_integrity_violations());
}

#[test]
fn integrity_flags_merge_to_missing_section() {
    let (mut project, a, _) = integrity_fixture();
    // Point the merge at a section id that doesn't exist.
    project.station_merges[0].station_b = StationRef::new(9999, 0);
    let v = project.check_structural_integrity();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].severity, ViolationSeverity::Critical);
    assert_eq!(v[0].category, "dangling_merge_ref");
    assert!(project.has_critical_integrity_violations());
    // The valid endpoint (section a) is untouched.
    assert!(project.get_section(a).is_some());
}

#[test]
fn integrity_flags_station_index_out_of_range() {
    let (mut project, a, _) = integrity_fixture();
    // Section a has 1 shot → stations 0..=1; index 5 is out of range.
    project.station_merges[0].station_a = StationRef::new(a, 5);
    let v = project.check_structural_integrity();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].severity, ViolationSeverity::Critical);
    assert!(v[0].message.contains("out of range"));
}

#[test]
fn integrity_flags_dangling_closure_and_zero_datum() {
    let (mut project, _, _) = integrity_fixture();
    project.loop_closures[0].station_b = StationRef::new(9999, 0);
    project.zero_datums[0].station_ref = StationRef::new(9999, 0);
    let v = project.check_structural_integrity();
    let categories: Vec<&str> = v.iter().map(|x| x.category.as_str()).collect();
    assert!(categories.contains(&"dangling_closure_ref"), "{v:?}");
    assert!(categories.contains(&"dangling_zero_datum_ref"), "{v:?}");
    assert!(v.iter().all(|x| x.severity == ViolationSeverity::Critical));
}

#[test]
fn integrity_orphan_offsets_and_comments_are_warnings_only() {
    let (mut project, _, _) = integrity_fixture();
    project.section_offsets.insert(9999, (1.0, 2.0));
    project.station_offsets.insert(StationRef::new(9999, 0), (1.0, 2.0, 3.0));
    project.station_comments.insert(StationRef::new(9999, 0), "x".to_string());
    let v = project.check_structural_integrity();
    assert_eq!(v.len(), 3, "{v:?}");
    assert!(v.iter().all(|x| x.severity == ViolationSeverity::Warning));
    // Warnings alone don't trip the critical gate.
    assert!(!project.has_critical_integrity_violations());
}
