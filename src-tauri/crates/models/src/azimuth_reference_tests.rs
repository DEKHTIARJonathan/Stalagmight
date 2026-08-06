//! Cross-cutting behaviour of the section north reference (#438).
//!
//! [`crate::models::azimuth_reference`] unit-tests the type. These exercise the
//! contract across the layers that have to agree about it: the coordinate walk,
//! the paths that write a SOLVED bearing back onto a shot, save/load, undo, and
//! the Ariane export flag.
//!
//! What each of these is trying to catch is a MISSING or MISDIRECTED correction
//! - a walk that forgot to add it, a write-back that forgot to remove it, a
//! persistence hop that dropped it - so every assertion below is written against
//! a section whose correction is large enough (10 degrees, ~1.7 m over 10 m)
//! that no tolerance can hide it.

#![expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test module: a failed unwrap is the failure report"
)]

use crate::models::{
    AzimuthReference, CorrectionSource, NorthReference, Project, Section, SectionData, SectionId,
    ShotData, StationRef,
};

/// 10 degrees east: big enough that a dropped correction cannot pass as noise.
const TEST_CORRECTION: f64 = 10.0;

fn shot(azimuth: f64, length: f64) -> ShotData {
    ShotData {
        azimuth_in: azimuth,
        azimuth_out: azimuth,
        length,
        depth_in: 0.0,
        depth_out: 0.0,
        ..Default::default()
    }
}

fn project_with(shots: Vec<ShotData>, reference: Option<AzimuthReference>) -> (Project, SectionId) {
    let mut project = Project::new("declination".to_string(), None);
    let id = project
        .add_section(SectionData {
            name: Some("S".to_string()),
            surveyor: None,
            date: None,
            color: "#ffffff".to_string(),
            direction: None,
            quality: 1.0,
            shots,
        })
        .id;
    project.get_section_mut(id).unwrap().azimuth_reference = reference;
    project.ensure_shot_uuids();
    (project, id)
}

fn station_xy(project: &Project, section_id: SectionId, index: u32) -> (f64, f64) {
    let coords = project
        .compute_station_raw_coords(StationRef::new(section_id, index))
        .expect("station coords");
    (coords.x, coords.y)
}

/// The whole point of the feature: the shot keeps the measured number and the
/// GEOMETRY moves. Both halves are asserted, because a change that rotated the
/// stored reading instead would satisfy the coordinate half alone.
#[test]
fn the_correction_rotates_the_geometry_and_never_the_reading() {
    let reference = AzimuthReference::magnetic(TEST_CORRECTION, CorrectionSource::FileDeclared);
    let (project, id) = project_with(vec![shot(0.0, 10.0)], Some(reference));

    let stored = &project.get_section(id).unwrap().shots[0];
    assert_eq!(stored.azimuth_in, 0.0, "the measured reading must not move");
    assert_eq!(stored.azimuth_out, 0.0);

    let (x, y) = station_xy(&project, id, 1);
    let expected = TEST_CORRECTION.to_radians();
    assert!(
        (x - 10.0 * expected.sin()).abs() < 1e-9 && (y - 10.0 * expected.cos()).abs() < 1e-9,
        "station 1 should sit 10 degrees east of north, got ({x}, {y})"
    );
}

/// The no-reference case has to be BIT-identical, not merely close: it is what
/// every existing project computes, and this feature is only safe to land
/// because upgrading moves nobody.
#[test]
fn a_section_with_no_reference_walks_exactly_where_it_always_did() {
    let shots = vec![shot(37.5, 12.0), shot(191.25, 7.5), shot(400.0, 3.0)];
    let (with_none, id_a) = project_with(shots.clone(), None);
    let (with_default, id_b) = project_with(shots, Some(AzimuthReference::default()));

    for index in 0..4 {
        let a = station_xy(&with_none, id_a, index);
        let b = station_xy(&with_default, id_b, index);
        assert_eq!(
            a, b,
            "station {index}: an explicit zero reference must be the same walk as none at all"
        );
    }
    // `400.0` is deliberately out of range: the identity path must not silently
    // normalise it, because the pre-#438 walk did not.
    let (x, _) = station_xy(&with_none, id_a, 3);
    assert!(x.is_finite());
}

/// A section that declares its own reference must not read the project default,
/// and one that declares none must.
#[test]
fn the_section_reference_wins_over_the_project_default() {
    let (mut project, id) = project_with(
        vec![shot(0.0, 10.0)],
        Some(AzimuthReference::magnetic(
            TEST_CORRECTION,
            CorrectionSource::Manual,
        )),
    );
    project.default_azimuth_reference =
        Some(AzimuthReference::magnetic(-45.0, CorrectionSource::Manual));

    let section = project.get_section(id).unwrap();
    assert_eq!(
        project.azimuth_reference_for(section).applied_correction(),
        TEST_CORRECTION
    );

    project.get_section_mut(id).unwrap().azimuth_reference = None;
    let section = project.get_section(id).unwrap();
    assert_eq!(
        project.azimuth_reference_for(section).applied_correction(),
        -45.0,
        "a section with no reference of its own inherits the project's"
    );
}

/// Moving a station solves in WORLD space and writes an azimuth back onto the
/// shot. Without the inverse conversion the stored bearing gains one correction,
/// and the station lands rotated away from where the user dropped it - by the
/// declination, every time, and the move is repeatable.
#[test]
fn a_station_move_lands_where_it_was_dropped_on_a_corrected_section() {
    use crate::core::command::Command;
    use crate::core::state::AppState;
    use crate::models::Coordinates;

    let reference = AzimuthReference::magnetic(TEST_CORRECTION, CorrectionSource::FileDeclared);
    let (project, id) = project_with(vec![shot(0.0, 10.0), shot(90.0, 10.0)], Some(reference));
    let before = station_xy(&project, id, 1);

    let state = AppState::new().unwrap();
    state.set_project_for_tests(project);
    let result = state.execute(Command::MoveStation {
        station_ref: StationRef::new(id, 1),
        offset: Coordinates::new(1.0, 2.0, 0.0),
    });
    assert!(result.success, "move failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    let after = station_xy(&project, id, 1);
    assert!(
        (after.0 - (before.0 + 1.0)).abs() < 1e-9 && (after.1 - (before.1 + 2.0)).abs() < 1e-9,
        "the station did not land where it was dropped: wanted {:?}, got {after:?}",
        (before.0 + 1.0, before.1 + 2.0)
    );
}

/// Reversing a section must not move the cave: station 0 becomes the far end
/// and the section offset gains the span it used to cover. That span is measured
/// by `shot_run_displacement`, which has to work in the SAME rotated frame as
/// the walk - otherwise a section carrying a declination slides by the
/// difference between the two frames, which for a 100 m passage at 10 degrees is
/// most of 17 m.
#[test]
fn reversing_a_corrected_section_keeps_every_station_where_it_was() {
    let reference = AzimuthReference::magnetic(TEST_CORRECTION, CorrectionSource::FileDeclared);
    let (mut project, id) = project_with(
        vec![shot(0.0, 40.0), shot(75.0, 30.0), shot(310.0, 30.0)],
        Some(reference),
    );
    let before: Vec<(f64, f64)> = (0..4).map(|i| station_xy(&project, id, i)).collect();

    assert!(project.reverse_section(id, false), "reverse should succeed");

    let after: Vec<(f64, f64)> = (0..4).map(|i| station_xy(&project, id, i)).collect();
    for (index, expected) in before.iter().enumerate() {
        // The reverse renumbers, so station i is now station N - i.
        let got = after[before.len() - 1 - index];
        assert!(
            (got.0 - expected.0).abs() < 1e-6 && (got.1 - expected.1).abs() < 1e-6,
            "station {index} moved across the reverse: {expected:?} -> {got:?}"
        );
    }
}

/// `SectionData` cannot carry the reference, so an undo that re-creates a
/// section restores it from [`crate::models::SectionIdentity`]. Losing it
/// rotates that section by the declination on the next redraw.
#[test]
fn restoring_a_section_from_its_identity_keeps_the_reference() {
    let reference = AzimuthReference::grid(-3.25, CorrectionSource::IgrfAuto { epoch_year: 2019 });
    let (project, id) = project_with(vec![shot(0.0, 10.0)], Some(reference));
    let section = project.get_section(id).unwrap();

    let identity = crate::models::SectionIdentity::of(section);
    let restored = Section::restore_with_identity(id, section.to_section_data(), &identity);

    assert_eq!(
        restored.azimuth_reference,
        Some(reference),
        "the restored section lost its north reference"
    );
    // A legacy entry (no recorded reference) must still restore, inheriting the
    // project default - the pre-#438 behaviour, not a panic or a zero override.
    let legacy = crate::models::SectionIdentity::default();
    let restored = Section::restore_with_identity(id, section.to_section_data(), &legacy);
    assert_eq!(restored.azimuth_reference, None);
}

/// Splitting a section produces a second section from the same survey. It must
/// inherit the reference, exactly as it inherits surveyor/date/colour.
#[test]
fn a_split_gives_both_halves_the_same_reference() {
    use crate::core::state::AppState;

    let reference = AzimuthReference::magnetic(TEST_CORRECTION, CorrectionSource::FileDeclared);
    let state = AppState::new().unwrap();
    let mut project = Project::new("split".to_string(), None);
    let id = project
        .add_section(SectionData {
            name: Some("S".to_string()),
            surveyor: None,
            date: None,
            color: "#ffffff".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![shot(0.0, 10.0), shot(10.0, 10.0), shot(20.0, 10.0)],
        })
        .id;
    project.get_section_mut(id).unwrap().azimuth_reference = Some(reference);
    project.ensure_shot_uuids();
    let middle = project.get_section(id).unwrap().shots[1].id;
    state.set_project_for_tests(project);

    let result = state.execute_delete_shot_and_split(id, middle, "A".to_string(), "B".to_string());
    assert!(result.success, "split failed: {:?}", result.error);

    let project = state.get_project_state().unwrap();
    assert_eq!(
        project.sections.len(),
        2,
        "the split should make two sections"
    );
    for section in &project.sections {
        assert_eq!(
            section.azimuth_reference,
            Some(reference),
            "section {} lost the reference across the split",
            section.id
        );
    }
}

/// Save/load has to preserve all three parts - the north, the number and where
/// the number came from - or the UI explains a value it no longer knows the
/// provenance of, and a policy change recomputes one it should not touch.
#[test]
fn the_reference_and_its_provenance_survive_save_and_load() {
    use crate::persistence::sqlite::Database;
    use tempfile::TempDir;

    let temp = TempDir::new().unwrap();
    let path = temp.path().join("declination.stalx");
    let mut db = Database::open(&path).unwrap();

    let recorded =
        AzimuthReference::magnetic(-2.13, CorrectionSource::IgrfAuto { epoch_year: 2024 });
    let (mut project, id) = project_with(vec![shot(12.5, 10.0)], Some(recorded));
    project.default_azimuth_reference =
        Some(AzimuthReference::true_north(CorrectionSource::Manual));
    db.save_project(&project).unwrap();

    let loaded = db.load_project().unwrap();
    let section = loaded
        .get_section(id)
        .expect("section survives the round trip");
    assert_eq!(section.azimuth_reference, Some(recorded));
    assert_eq!(
        loaded.default_azimuth_reference,
        Some(AzimuthReference::true_north(CorrectionSource::Manual))
    );
    assert_eq!(
        section.shots[0].azimuth_in, 12.5,
        "the stored reading is still the measured one"
    );
}

/// The absent case is the one every existing file takes. It must load as "no
/// reference recorded" - `None`, not `Some(default)` - so that a later project
/// default can still reach the section.
#[test]
fn a_project_that_declares_nothing_round_trips_as_nothing() {
    use crate::persistence::sqlite::Database;
    use tempfile::TempDir;

    let temp = TempDir::new().unwrap();
    let path = temp.path().join("plain.stalx");
    let mut db = Database::open(&path).unwrap();

    let (project, id) = project_with(vec![shot(12.5, 10.0)], None);
    assert_eq!(project.default_azimuth_reference, None, "precondition");
    db.save_project(&project).unwrap();

    let loaded = db.load_project().unwrap();
    assert_eq!(
        loaded.get_section(id).unwrap().azimuth_reference,
        None,
        "an unrecorded reference must not materialise as an explicit one"
    );
    assert_eq!(loaded.default_azimuth_reference, None);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

fn exported_xml(project: &Project) -> String {
    use tempfile::TempDir;
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("out.tmlu");
    crate::export::export_tml(project, &path).unwrap();
    std::fs::read_to_string(&path).unwrap()
}

fn azimuths_in(xml: &str) -> Vec<f64> {
    xml.split("<AZ>")
        .skip(1)
        .filter_map(|chunk| chunk.split("</AZ>").next())
        .filter_map(|text| text.trim().parse::<f64>().ok())
        .collect()
}

/// A magnetic project hands Ariane the readings and lets Ariane correct them.
#[test]
fn an_all_magnetic_project_exports_its_readings_and_declares_them_magnetic() {
    let reference = AzimuthReference::magnetic(TEST_CORRECTION, CorrectionSource::FileDeclared);
    let (project, _) = project_with(vec![shot(30.0, 10.0)], Some(reference));

    let xml = exported_xml(&project);
    assert!(
        xml.contains("<useMagneticAzimuth>true</useMagneticAzimuth>"),
        "magnetic project must declare magnetic"
    );
    assert!(
        azimuths_in(&xml).contains(&30.0),
        "the measured reading must be written verbatim: {:?}",
        azimuths_in(&xml)
    );
}

/// The bug this issue opened on: a true-north project used to be declared
/// magnetic, and Ariane rotated it again on the way in.
#[test]
fn an_all_true_north_project_is_no_longer_declared_magnetic() {
    let (project, _) = project_with(
        vec![shot(30.0, 10.0)],
        Some(AzimuthReference::true_north(CorrectionSource::FileDeclared)),
    );

    let xml = exported_xml(&project);
    assert!(
        xml.contains("<useMagneticAzimuth>false</useMagneticAzimuth>"),
        "a true-north project told Ariane its azimuths were magnetic"
    );
    assert!(azimuths_in(&xml).contains(&30.0));
}

/// Mixed: one flag cannot describe two conventions, so every bearing is rotated
/// into true north on the way out and the file says so. The PROJECT keeps its
/// measured readings.
#[test]
fn a_mixed_project_exports_true_north_bearings_and_leaves_the_project_alone() {
    let mut project = Project::new("mixed".to_string(), None);
    let magnetic = project
        .add_section(SectionData {
            name: Some("Magnetic".to_string()),
            surveyor: None,
            date: None,
            color: "#ffffff".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![shot(30.0, 10.0)],
        })
        .id;
    let true_north = project
        .add_section(SectionData {
            name: Some("True".to_string()),
            surveyor: None,
            date: None,
            color: "#ffffff".to_string(),
            direction: None,
            quality: 1.0,
            shots: vec![shot(200.0, 10.0)],
        })
        .id;
    project.get_section_mut(magnetic).unwrap().azimuth_reference = Some(
        AzimuthReference::magnetic(TEST_CORRECTION, CorrectionSource::FileDeclared),
    );
    project
        .get_section_mut(true_north)
        .unwrap()
        .azimuth_reference = Some(AzimuthReference::true_north(CorrectionSource::FileDeclared));
    project.ensure_shot_uuids();

    let xml = exported_xml(&project);
    assert!(
        xml.contains("<useMagneticAzimuth>false</useMagneticAzimuth>"),
        "a mixed project can only honestly declare true north"
    );
    let azimuths = azimuths_in(&xml);
    assert!(
        azimuths.contains(&40.0),
        "the magnetic section's 30 degrees should leave as 40: {azimuths:?}"
    );
    assert!(
        azimuths.contains(&200.0),
        "the true-north section must be written unchanged: {azimuths:?}"
    );

    assert_eq!(
        project.get_section(magnetic).unwrap().shots[0].azimuth_in,
        30.0,
        "export must not write the correction back into the project"
    );
}

/// A project with no references at all is the historical case, and it has to
/// keep producing the historical document.
#[test]
fn an_unreferenced_project_still_exports_the_historical_declaration() {
    let (project, _) = project_with(vec![shot(30.0, 10.0)], None);
    let xml = exported_xml(&project);
    assert!(xml.contains("<useMagneticAzimuth>true</useMagneticAzimuth>"));
    assert!(azimuths_in(&xml).contains(&30.0));
}

/// Grid bearings are neither magnetic nor true: declaring them either way hands
/// Ariane a rotation it will not undo, so they are converted out.
#[test]
fn a_grid_referenced_project_is_converted_rather_than_mislabelled() {
    let (project, _) = project_with(
        vec![shot(30.0, 10.0)],
        Some(AzimuthReference::grid(2.0, CorrectionSource::FileDeclared)),
    );
    let xml = exported_xml(&project);
    assert!(xml.contains("<useMagneticAzimuth>false</useMagneticAzimuth>"));
    assert!(
        azimuths_in(&xml).contains(&32.0),
        "the grid correction should be applied on the way out: {:?}",
        azimuths_in(&xml)
    );
}

/// Guards the enum's meaning rather than its spelling: `north` describes the
/// STORED numbers, so a magnetic section with a correction is still magnetic.
#[test]
fn a_corrected_magnetic_section_is_still_magnetic() {
    let reference = AzimuthReference::magnetic(TEST_CORRECTION, CorrectionSource::FileDeclared);
    assert_eq!(reference.north, NorthReference::Magnetic);
    assert!(!reference.is_identity());
}
