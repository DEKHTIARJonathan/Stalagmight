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
    let section_id = project
        .add_section(SectionData {
            shots: vec![
                shot(0.0, 0.0, 10.0, 0.0, 0.0),
                shot(90.0, 90.0, 5.0, 0.0, 2.0),
            ],
            ..Default::default()
        })
        .id;

    project.section_offsets.insert(section_id, (2.0, -3.0));

    let coords = project
        .compute_station_raw_coords(StationRef::new(section_id, 2))
        .expect("coords");
    assert!((coords.x - 7.0).abs() < 1e-6);
    assert!((coords.y - 7.0).abs() < 1e-6);
    assert!((coords.z - 2.0).abs() < 1e-6);

    let invalid = project.compute_station_raw_coords(StationRef::new(section_id, 5));
    assert!(invalid.is_none());
}

#[test]
fn set_zero_datum_first_datum_positions_station_at_origin() {
    let mut project = Project::new("FirstDatum".to_string(), None);
    // Create a section with a shot going north (azimuth 0)
    let section_id = project
        .add_section(SectionData {
            shots: vec![shot(0.0, 0.0, 10.0, 0.0, 1.0)],
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
    // Station was at (0, 10), needs offset (-0, -10) to be at origin
    assert!((offset.0 - 0.0).abs() < 1e-6, "Expected x offset ~0, got {}", offset.0);
    assert!((offset.1 - (-10.0)).abs() < 1e-6, "Expected y offset ~-10, got {}", offset.1);

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
        ClosureStrategy::default(),
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
    });
    project.next_closure_id += 1;

    // All three sections should be connected via merge A-B and closure B-C
    let connected = project.get_connected_section_ids(a);
    assert!(connected.contains(&a), "A should be connected");
    assert!(connected.contains(&b), "B should be connected");
    assert!(connected.contains(&c), "C should be connected via closure");
    assert_eq!(connected.len(), 3);

    // Path length between A.0 and C.1 should work (BFS traverses closure)
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
    });
    project.next_closure_id += 1;

    // Before merge, A and B are connected via closure
    let connected_before = project.get_connected_section_ids(a);
    assert!(connected_before.contains(&a));
    assert!(connected_before.contains(&b));
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

    // Path should traverse both closure and merge with zero distance
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
