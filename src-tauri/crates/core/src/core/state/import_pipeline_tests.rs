//! End-to-end import tests relocated from `parsers::{tml,walls}` ahead of the
//! crate split: they drive the REAL import path through [`AppState`], so they
//! live with the state they construct. `core` depends on `parsers` and
//! `export` non-test, which keeps every import below downward.

use crate::parsers::tml::test_helpers::{
    parse_synthetic_tmlu, tml_shot_xml_depth, tml_shot_xml_gps, wrap_xml_with,
};
use crate::parsers::tml::{convert_tml_to_import_configs, parse_tml};
use crate::parsers::walls::test_support::{convert_one, parse_srv};

/// #431: a round elevation in metres (100.0) stated in feet (328.084)
/// lands in `Project.surface_elevation` correctly converted, not just on
/// the intermediate `TmlFile`/`TmlGeoCoding` structs.
#[test]
fn imperial_elevation_328_084_ft_lands_as_100_m_in_the_project() {
    use crate::core::state::{AppState, VirtualShotMode};
    use crate::core::Command;

    let shots = [
        tml_shot_xml_gps(0, -1, "START", "Start", 20.5, -87.3),
        tml_shot_xml_depth(1, 0, "REAL", "Main", 10.0, -1.0),
    ]
    .join("\n");
    let tml = parse_synthetic_tmlu(&wrap_xml_with("ft", 328.084, &shots));
    assert!((tml.first_start_absolute_elevation - 100.0).abs() < 1e-3);

    let (sections, closures, _) = convert_tml_to_import_configs(&tml, false, false).unwrap();
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Elevation Units".to_string(),
        location: None,
    });
    let elevation = crate::models::ariane_elevation_or_absent(tml.first_start_absolute_elevation);
    let result = state.execute_tml_import_sections(
        sections,
        closures,
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
        elevation,
    );
    assert!(result.success, "import failed: {:?}", result.error);
    let project = state.get_project_state().unwrap();
    let got = project.surface_elevation.expect("elevation must be set");
    assert!((got - 100.0).abs() < 1e-3, "got {got}, want 100.0 +/- 1e-3");
}

/// #431 round trip: a synthetic `.tmlu` carrying
/// `firstStartAbsoluteElevation = 123.5` survives import into a fresh
/// project and back out through export unchanged. Red before #431 (import
/// dropped it on the floor, the TODO(#411) this test replaces); red again
/// if the export side reverts to reading a zero datum's `depth_reference`.
#[test]
fn entrance_elevation_round_trips_through_import_and_export() {
    use crate::core::state::{AppState, VirtualShotMode};
    use crate::core::Command;

    let shots = [
        tml_shot_xml_gps(0, -1, "START", "Start", 20.5, -87.3),
        tml_shot_xml_depth(1, 0, "REAL", "Main", 10.0, -1.0),
    ]
    .join("\n");
    let tml = parse_synthetic_tmlu(&wrap_xml_with("m", 123.5, &shots));

    let (sections, closures, _) = convert_tml_to_import_configs(&tml, false, false).unwrap();
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Round Trip".to_string(),
        location: None,
    });
    let elevation = crate::models::ariane_elevation_or_absent(tml.first_start_absolute_elevation);
    let result = state.execute_tml_import_sections(
        sections,
        closures,
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
        elevation,
    );
    assert!(result.success, "import failed: {:?}", result.error);
    let project = state.get_project_state().unwrap();
    assert_eq!(project.surface_elevation, Some(123.5));

    let out_dir = tempfile::tempdir().unwrap();
    let out_path = out_dir.path().join("roundtrip.tmlu");
    crate::export::tml::export_tml(&project, &out_path).unwrap();
    let round_tripped = parse_tml(&out_path).unwrap();
    assert!(
        (round_tripped.first_start_absolute_elevation - 123.5).abs() < 1e-6,
        "got {}, want 123.5",
        round_tripped.first_start_absolute_elevation
    );
}

/// #431 no-clobber: importing a second file with a DIFFERENT entrance
/// elevation into a project that already has one keeps the existing value
/// and surfaces the mismatch as a receipt warning naming both numbers,
/// rather than silently overwriting it.
#[test]
fn entrance_elevation_import_does_not_clobber_an_existing_value() {
    use crate::core::state::{AppState, VirtualShotMode};
    use crate::core::Command;

    let shots = [
        tml_shot_xml_gps(0, -1, "START", "Start", 20.5, -87.3),
        tml_shot_xml_depth(1, 0, "REAL", "Main", 10.0, -1.0),
    ]
    .join("\n");
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "No Clobber".to_string(),
        location: None,
    });

    let first_tml = parse_synthetic_tmlu(&wrap_xml_with("m", 50.0, &shots));
    let (sections, closures, _) = convert_tml_to_import_configs(&first_tml, false, false).unwrap();
    let result = state.execute_tml_import_sections(
        sections,
        closures,
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
        Some(first_tml.first_start_absolute_elevation),
    );
    assert!(result.success, "first import failed: {:?}", result.error);
    assert_eq!(
        state.get_project_state().unwrap().surface_elevation,
        Some(50.0)
    );

    let second_tml = parse_synthetic_tmlu(&wrap_xml_with("m", 75.0, &shots));
    let (sections, closures, _) = convert_tml_to_import_configs(&second_tml, false, false).unwrap();
    let result = state.execute_tml_import_sections(
        sections,
        closures,
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
        Some(second_tml.first_start_absolute_elevation),
    );
    assert!(result.success, "second import failed: {:?}", result.error);
    assert_eq!(
        state.get_project_state().unwrap().surface_elevation,
        Some(50.0),
        "the existing elevation must survive a conflicting import"
    );
    let warnings = result
        .import_receipt
        .as_ref()
        .map(|r| r.warnings.clone())
        .unwrap_or_default();
    assert!(
        warnings.iter().any(|w| w.contains("kept 50.00")),
        "the clobber must be surfaced naming the KEPT value explicitly \
         (not just both numbers, which a reversed message would also \
         contain), got {warnings:?}"
    );
}

/// #431 tolerance: re-importing the SAME cave via its metric and
/// imperial twins (100.0 m vs 328.084 ft, which converts to
/// 100.00003... m) must not fire the no-clobber "differs" warning - the
/// unit round-trip's residue is far below `f64::EPSILON` (2.2e-16) but
/// well inside the message's own `{:.2}` precision. Red on
/// `f64::EPSILON` used as the tolerance, which reads this pair as
/// different and prints a warning naming "100.00 m" against "100.00 m".
#[test]
fn reimporting_the_metric_and_imperial_twins_of_one_elevation_warns_never() {
    use crate::core::state::{AppState, VirtualShotMode};
    use crate::core::Command;

    let shots = [
        tml_shot_xml_gps(0, -1, "START", "Start", 20.5, -87.3),
        tml_shot_xml_depth(1, 0, "REAL", "Main", 10.0, -1.0),
    ]
    .join("\n");
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject {
        name: "Unit Twins".to_string(),
        location: None,
    });

    let metric_tml = parse_synthetic_tmlu(&wrap_xml_with("m", 100.0, &shots));
    let (sections, closures, _) = convert_tml_to_import_configs(&metric_tml, false, false).unwrap();
    let result = state.execute_tml_import_sections(
        sections,
        closures,
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
        Some(metric_tml.first_start_absolute_elevation),
    );
    assert!(result.success, "metric import failed: {:?}", result.error);

    let imperial_tml = parse_synthetic_tmlu(&wrap_xml_with("ft", 328.084, &shots));
    let (sections, closures, _) =
        convert_tml_to_import_configs(&imperial_tml, false, false).unwrap();
    let result = state.execute_tml_import_sections(
        sections,
        closures,
        None,
        Vec::new(),
        Vec::new(),
        VirtualShotMode::Auto,
        Some(imperial_tml.first_start_absolute_elevation),
    );
    assert!(result.success, "imperial import failed: {:?}", result.error);
    assert_eq!(
        state.get_project_state().unwrap().surface_elevation,
        Some(100.0),
        "the original metric value must survive unchanged"
    );
    let warnings = result
        .import_receipt
        .as_ref()
        .map(|r| r.warnings.clone())
        .unwrap_or_default();
    assert!(
        warnings.iter().all(|w| !w.contains("differs from")),
        "a unit round-trip must not read as a conflicting elevation, got {warnings:?}"
    );
}

#[test]
fn end_to_end_import_respects_datum_invariants() {
    // Runs the REAL import (execute_import_sections enforces
    // `multiple_datums_per_merge_component`), so a successful result proves
    // the placement respects the model's one-datum-per-component invariant.
    use crate::core::state::{AppState, VirtualShotMode};
    use crate::core::Command;

    let run = |srv: &str| -> (bool, Option<String>, usize) {
        let (sections, closures, _w) = convert_one(parse_srv(srv));
        let state = AppState::new().unwrap();
        state.execute(Command::CreateProject {
            name: "T".to_string(),
            location: None,
        });
        let result = state.execute_import_sections(
            sections,
            closures,
            None,
            Vec::new(),
            Vec::new(),
            VirtualShotMode::Auto,
        );
        let datums = state
            .get_project_state()
            .map(|p| p.zero_datums.len())
            .unwrap_or(0);
        (result.success, result.error, datums)
    };

    // Two separate components, each with its own #Fix -> 2 datums, OK.
    let (ok2, err2, d2) = run("#UNITS meters order=DAV\n\
         #FIX A0 W90:00:00 N30:00:00 0\n\
         A0 A1 10 90 0\n\
         #FIX B0 W91:00:00 N31:00:00 0\n\
         B0 B1 10 90 0\n");
    assert!(ok2, "two-datum import should succeed: {err2:?}");
    assert_eq!(d2, 2);

    // Two #Fix in ONE connected component -> exactly 1 datum, import still
    // succeeds (no multiple_datums_per_merge_component violation).
    let (ok1, err1, d1) = run("#UNITS meters order=DAV\n\
         #FIX A0 W90:00:00 N30:00:00 0\n\
         #FIX B0 W91:00:00 N31:00:00 0\n\
         A0 A1 10 90 0\n\
         A1 J 10 90 0\n\
         B0 J 10 270 0\n");
    assert!(
        ok1,
        "single-datum component import should succeed: {err1:?}"
    );
    assert_eq!(
        d1, 1,
        "exactly one datum survives in a single merge component"
    );
}
