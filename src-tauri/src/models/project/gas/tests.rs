#![expect(
    clippy::unwrap_used,
    reason = "tests construct from known-valid literals; a failed unwrap should fail the test"
)]

use super::model::{CylRole, Cylinder, Diver, GasReachField, PlanMode, TankMaterial, Team};
use super::physics::{ata, avg_depth, cylinder_gas_volume, edge_gas, gas_rate, sac_to_rmv};
use super::{reserve_fraction, usable_oc_gas};
use crate::config::{GasConfig, ReservePreset};
use crate::models::{GpsCoordinates, Project, SectionData, ShotData, StationRef, ZeroDatum};

const EPS: f64 = 1e-9;

#[test]
fn ata_surface_depth_and_above_surface_clamp() {
    assert!((ata(0.0) - 1.0).abs() < EPS); // surface = 1 ATA
    assert!((ata(10.0) - 2.0).abs() < EPS); // +1 bar per 10 msw
    assert!((ata(30.0) - 4.0).abs() < EPS);
    assert!((ata(-5.0) - 1.0).abs() < EPS); // above surface clamps to 1 ATA
}

#[test]
fn gas_rate_scales_with_ambient_pressure() {
    // 20 L/min at 20 m (3 ATA) = 60 L/min.
    assert!((gas_rate(20.0, 20.0) - 60.0).abs() < EPS);
}

#[test]
fn avg_depth_is_the_midpoint() {
    assert!((avg_depth(10.0, 30.0) - 20.0).abs() < EPS);
}

#[test]
fn edge_gas_hand_computed() {
    // rmv 20, swim 10 m/min, 100 m leg, depth 10→30 (avg 20 m = 3 ATA):
    // rate = 60 L/min, time = 10 min ⇒ 600 L.
    assert!((edge_gas(20.0, 10.0, 100.0, 10.0, 30.0) - 600.0).abs() < 1e-6);
}

#[test]
fn sac_to_rmv_hand_computed() {
    // 0.5 bar/min against a 24 L reference cylinder ⇒ 12 L/min.
    assert!((sac_to_rmv(0.5, 24.0) - 12.0).abs() < EPS);
}

#[test]
fn cylinder_gas_volume_is_ideal() {
    // LP85 at 230 bar overfill: 230 × 12 = 2760 L ideal.
    assert!((cylinder_gas_volume(230.0, 12.0) - 2760.0).abs() < EPS);
}

#[test]
fn diver_new_rejects_nonpositive_and_nonfinite() {
    assert!(Diver::new(0.0, None).is_err());
    assert!(Diver::new(-1.0, None).is_err());
    assert!(Diver::new(f64::NAN, None).is_err());
    assert!(Diver::new(f64::INFINITY, None).is_err());
    assert!(Diver::new(14.0, Some("me".into())).is_ok());
}

#[test]
fn diver_from_sac_derives_rmv_and_guards_inputs() {
    let diver = Diver::from_sac(0.5, 24.0, None).unwrap();
    assert!((diver.rmv_l_per_min - 12.0).abs() < EPS);
    assert!(Diver::from_sac(0.0, 24.0, None).is_err());
    assert!(Diver::from_sac(0.5, 0.0, None).is_err());
}

#[test]
fn cylinder_guards_and_gas_volume() {
    // Fill (230) may exceed rated (179) — overfilling is routine, never clamped.
    let cyl = Cylinder::new(
        12.0,
        179.0,
        230.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    assert!((cyl.gas_volume_l() - 2760.0).abs() < EPS);
    assert!(Cylinder::new(
        0.0,
        179.0,
        230.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None
    )
    .is_err());
    assert!(Cylinder::new(
        12.0,
        179.0,
        f64::NAN,
        TankMaterial::Steel,
        CylRole::BackGas,
        None
    )
    .is_err());
}

#[test]
fn team_holds_divers_cylinders_and_mode() {
    let diver = Diver::new(14.0, None).unwrap();
    let cyl = Cylinder::new(
        12.0,
        179.0,
        230.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let team = Team {
        divers: vec![diver],
        cylinders_per_diver: vec![vec![cyl]],
        mode: PlanMode::OpenCircuit,
    };
    assert_eq!(team.divers.len(), 1);
    assert_eq!(team.cylinders_per_diver[0].len(), 1);
    assert_eq!(team.mode, PlanMode::OpenCircuit);
}

// ---- Phase 1: gas reachability field ------------------------------------------------

fn make_shot(length: f64, depth_in: f64, depth_out: f64) -> ShotData {
    ShotData {
        length,
        depth_in,
        depth_out,
        ..Default::default()
    }
}

/// One straight section of 3 shots descending 0 → 10 → 20 → 30 m, 100 m each (4 stations).
fn linear_descent_project() -> (Project, StationRef) {
    let mut project = Project::new("Gas".to_string(), None);
    let sec = project
        .add_section(SectionData {
            shots: vec![
                make_shot(100.0, 0.0, 10.0),
                make_shot(100.0, 10.0, 20.0),
                make_shot(100.0, 20.0, 30.0),
            ],
            ..Default::default()
        })
        .id;
    (project, StationRef::new(sec, 0))
}

fn field_gas(field: &GasReachField, sr: StationRef) -> f64 {
    let idx = field.station_refs.iter().position(|r| *r == sr).unwrap();
    field.gas_to_reach[idx].unwrap()
}

#[test]
fn reserve_fraction_matches_presets() {
    assert!((reserve_fraction(ReservePreset::AllThirds) - 1.0 / 3.0).abs() < EPS);
    assert!((reserve_fraction(ReservePreset::OneStage) - 0.25).abs() < EPS);
    assert!((reserve_fraction(ReservePreset::TwoStage) - 1.0 / 6.0).abs() < EPS);
}

#[test]
fn usable_oc_gas_counts_backgas_stage_excludes_others_and_derates() {
    let bg = Cylinder::new(
        12.0,
        200.0,
        200.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let stage = Cylinder::new(
        11.0,
        207.0,
        207.0,
        TankMaterial::Aluminium,
        CylRole::Stage,
        None,
    )
    .unwrap();
    let deco = Cylinder::new(
        5.7,
        207.0,
        207.0,
        TankMaterial::Aluminium,
        CylRole::Deco,
        None,
    )
    .unwrap();
    let dilout = Cylinder::new(
        3.0,
        237.0,
        200.0,
        TankMaterial::Steel,
        CylRole::DilOut,
        None,
    )
    .unwrap();
    let cyls = [bg, stage, deco, dilout];
    // Non-conservative (actual fill): backgas 12×200 + stage 11×207; deco/dilout excluded.
    assert!((usable_oc_gas(&cyls, false) - (2400.0 + 2277.0)).abs() < 1e-6);

    // Overfilled backgas derates to rated under the conservative "call-it-an-80" convention.
    let over = Cylinder::new(
        12.0,
        179.0,
        230.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    assert!((usable_oc_gas(std::slice::from_ref(&over), true) - 179.0 * 12.0).abs() < 1e-6);
    assert!((usable_oc_gas(&[over], false) - 230.0 * 12.0).abs() < 1e-6);
}

#[test]
fn gas_reach_field_huge_budget_reaches_everything_no_frontier() {
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    // Absurdly large cylinder → budget dwarfs the cave → all reachable, no turn needed.
    let big = Cylinder::new(
        1000.0,
        300.0,
        300.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let field =
        project.compute_gas_reach_field(Some(&origin), &diver, &[big], &GasConfig::default());
    assert_eq!(field.station_refs.len(), 4); // 3 shots → 4 stations
    assert!(field.reachable.iter().all(|&r| r));
    assert!(field.gas_to_reach.iter().all(Option::is_some));
    assert!(field.turn_frontier.is_empty()); // nothing borders an unreachable station
}

#[test]
fn gas_reach_field_tiny_budget_only_origin_is_the_frontier() {
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    // Negligible cylinder → budget ≈ 0 → only the origin (gas_in 0) qualifies; it's the frontier.
    let tiny = Cylinder::new(
        0.01,
        1.0,
        1.0,
        TankMaterial::Aluminium,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let field =
        project.compute_gas_reach_field(Some(&origin), &diver, &[tiny], &GasConfig::default());
    let origin_idx = field
        .station_refs
        .iter()
        .position(|r| *r == origin)
        .unwrap();
    assert!(field.reachable[origin_idx]);
    assert_eq!(field.reachable.iter().filter(|&&r| r).count(), 1); // only the origin
    assert_eq!(field.turn_frontier, vec![origin]);
    assert_eq!(field.gas_to_reach[origin_idx], Some(0.0)); // gas to reach the origin is 0
}

#[test]
fn gas_reach_field_monotonic_and_disconnected_is_none() {
    let mut project = Project::new("Gas".to_string(), None);
    let sec = project
        .add_section(SectionData {
            shots: vec![make_shot(100.0, 0.0, 10.0), make_shot(100.0, 10.0, 20.0)],
            ..Default::default()
        })
        .id;
    // A second, unconnected section (no merge/closure) → separate component.
    let other = project
        .add_section(SectionData {
            shots: vec![make_shot(50.0, 0.0, 5.0)],
            ..Default::default()
        })
        .id;
    let origin = StationRef::new(sec, 0);
    let diver = Diver::new(20.0, None).unwrap();
    let big = Cylinder::new(
        1000.0,
        300.0,
        300.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let field =
        project.compute_gas_reach_field(Some(&origin), &diver, &[big], &GasConfig::default());

    // Same-section stations: gas_to_reach is monotonically non-decreasing along the line.
    let g0 = field_gas(&field, StationRef::new(sec, 0));
    let g1 = field_gas(&field, StationRef::new(sec, 1));
    let g2 = field_gas(&field, StationRef::new(sec, 2));
    assert!(g0 <= g1 && g1 <= g2);
    assert!(g0.abs() < EPS); // origin is 0

    // The disconnected section is unreachable: gas_to_reach None, reachable false.
    let oidx = field
        .station_refs
        .iter()
        .position(|r| *r == StationRef::new(other, 0))
        .unwrap();
    assert_eq!(field.gas_to_reach[oidx], None);
    assert!(!field.reachable[oidx]);
}

#[test]
fn gas_reach_field_reaches_across_a_station_merge() {
    // Cross-section reachability over a survey-tied StationMerge (0-cost edge in
    // build_survey_graph_weighted). The disconnected test above proves separate
    // components stay unreachable; this proves a merge bridges them — the multi-section
    // integrity case (a diver swimming A→B via the join). LoopClosures take the same
    // 0-cost path in the graph builder, so the merge exercises that edge class.
    let mut project = Project::new("Gas".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![make_shot(100.0, 0.0, 10.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![make_shot(100.0, 10.0, 20.0)],
            ..Default::default()
        })
        .id;
    // Join A's terminal station (index 1) to B's entry station (index 0).
    project
        .merge_stations(StationRef::new(a, 1), StationRef::new(b, 0))
        .unwrap();

    let origin = StationRef::new(a, 0);
    let diver = Diver::new(20.0, None).unwrap();
    let big = Cylinder::new(
        1000.0,
        300.0,
        300.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let field =
        project.compute_gas_reach_field(Some(&origin), &diver, &[big], &GasConfig::default());

    // B's far station is reachable across the merge (a separate component would be None).
    let bidx = field
        .station_refs
        .iter()
        .position(|r| *r == StationRef::new(b, 1))
        .unwrap();
    assert!(
        field.reachable[bidx],
        "station in section B must be reachable across the merge"
    );
    // Crossing the 0-cost merge adds no gas: A's terminal and B's entry are the same
    // physical point, so they share a gas_to_reach.
    let ga1 = field_gas(&field, StationRef::new(a, 1));
    let gb0 = field_gas(&field, StationRef::new(b, 0));
    assert!(
        (ga1 - gb0).abs() < EPS,
        "merged stations share gas_to_reach (0-cost join)"
    );
}

#[test]
fn gas_reach_field_pins_in_leg_gas_values() {
    // Default config: RMV 20, swim 10 m/min, multiplier 1.0, no survey speed. The three legs
    // (avg depths 5/15/25 m → 1.5/2.5/3.5 ATA) cost 20·1.5·10 / 20·2.5·10 / 20·3.5·10 =
    // 300/500/700 L; cumulative gas_in = 300/800/1500. Pins the engine's depth + ATA + speed +
    // RMV wiring end-to-end (a flattened depth, a swapped length↔speed, or a dropped multiplier
    // would all change these — the structural tests would not catch it).
    let (project, origin) = linear_descent_project();
    let sec = origin.section_id;
    let diver = Diver::new(20.0, None).unwrap();
    let big = Cylinder::new(
        1000.0,
        300.0,
        300.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let field =
        project.compute_gas_reach_field(Some(&origin), &diver, &[big], &GasConfig::default());
    assert!((field_gas(&field, StationRef::new(sec, 1)) - 300.0).abs() < 1e-6);
    assert!((field_gas(&field, StationRef::new(sec, 2)) - 800.0).abs() < 1e-6);
    assert!((field_gas(&field, StationRef::new(sec, 3)) - 1500.0).abs() < 1e-6);
}

#[test]
fn gas_reach_field_honors_survey_speed_and_multiplier() {
    // survey_speed 5 (½ the swim 10) and survey_rmv_multiplier 1.3 scale the in-leg gas by
    // (10/5)·1.3 = 2.6× — station-1 reach 300 → 780 L. Pins the §5.2 in-leg inputs.
    let (project, origin) = linear_descent_project();
    let sec = origin.section_id;
    let diver = Diver::new(20.0, None).unwrap();
    let big = Cylinder::new(
        1000.0,
        300.0,
        300.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let config = GasConfig {
        survey_speed_m_per_min: Some(5.0),
        survey_rmv_multiplier: 1.3,
        ..GasConfig::default()
    };
    let field = project.compute_gas_reach_field(Some(&origin), &diver, &[big], &config);
    assert!((field_gas(&field, StationRef::new(sec, 1)) - 780.0).abs() < 1e-6);
}

/// One permanent shot then a reference/jump shot (0 → 10 → 20 m, 100 m each): 3 stations.
fn project_with_jump_second_leg() -> (Project, StationRef) {
    let mut project = Project::new("Gas".to_string(), None);
    let sec = project
        .add_section(SectionData {
            shots: vec![
                make_shot(100.0, 0.0, 10.0),
                ShotData {
                    length: 100.0,
                    depth_in: 10.0,
                    depth_out: 20.0,
                    is_reference: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        })
        .id;
    (project, StationRef::new(sec, 0))
}

#[test]
fn gas_reach_field_jump_multiplier_raises_only_jump_legs() {
    // Leg 0 is a permanent shot (avg 5 m → 1.5 ATA → 20·1.5·10 = 300 L); leg 1 is a
    // reference/jump (avg 15 m → 2.5 ATA → base 20·2.5·10 = 500 L). A 1.5× jump multiplier
    // scales ONLY the jump leg's RMV (20 → 30 → 750 L): station 1 is untouched at 300, while
    // station 2 rises from 300+500=800 to 300+750=1050. Pins that the bump targets is_reference
    // legs and nothing else (a misapplied multiplier would also move station 1).
    let (project, origin) = project_with_jump_second_leg();
    let sec = origin.section_id;
    let diver = Diver::new(20.0, None).unwrap();
    let big = Cylinder::new(
        1000.0,
        300.0,
        300.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();

    let base = project.compute_gas_reach_field(
        Some(&origin),
        &diver,
        std::slice::from_ref(&big),
        &GasConfig::default(),
    );
    assert!((field_gas(&base, StationRef::new(sec, 1)) - 300.0).abs() < 1e-6);
    assert!((field_gas(&base, StationRef::new(sec, 2)) - 800.0).abs() < 1e-6);

    let bumped = GasConfig {
        jump_rmv_multiplier: 1.5,
        ..GasConfig::default()
    };
    let field = project.compute_gas_reach_field(Some(&origin), &diver, &[big], &bumped);
    assert!((field_gas(&field, StationRef::new(sec, 1)) - 300.0).abs() < 1e-6);
    assert!((field_gas(&field, StationRef::new(sec, 2)) - 1050.0).abs() < 1e-6);
}

#[test]
fn gas_reach_field_partial_frontier_between_interior_stations() {
    // usable = 12·250 = 3000 → AllThirds budget = 1000 L, between gas_in(station 2)=800 and
    // gas_in(station 3)=1500 → reach {0,1,2}, turn at station 2. Pins the preset→fraction→budget
    // wiring and the frontier detection at an interior station (not just the origin).
    let (project, origin) = linear_descent_project();
    let sec = origin.section_id;
    let diver = Diver::new(20.0, None).unwrap();
    let cyl = Cylinder::new(
        12.0,
        250.0,
        250.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let field =
        project.compute_gas_reach_field(Some(&origin), &diver, &[cyl], &GasConfig::default());
    assert!((field.budget_litres - 1000.0).abs() < 1e-6);
    assert_eq!(field.reachable.iter().filter(|&&r| r).count(), 3); // stations 0,1,2
    let idx = |sr| field.station_refs.iter().position(|r| *r == sr).unwrap();
    assert!(field.reachable[idx(StationRef::new(sec, 2))]);
    assert!(!field.reachable[idx(StationRef::new(sec, 3))]);
    assert_eq!(field.turn_frontier, vec![StationRef::new(sec, 2)]);
    // max_reachable_gas is the deepest WITHIN-budget cost (station 2 = 800 L), NOT the
    // out-of-budget station 3's finite 1500 — it feeds the "max penetration gas" readout,
    // which must never report gas the diver can't actually turn at.
    assert!((field.max_reachable_gas - 800.0).abs() < 1e-6);
}

#[test]
fn gas_reach_field_unnormalized_config_bails_to_all_unreachable() {
    // The engine's defensive guard: a non-positive / non-finite in-speed or in-rmv (a config
    // that skipped GasConfig::normalize) MUST yield an all-unreachable field — never the unsafe
    // over-stating direction (§6). compute_gas_reach_field is called DIRECTLY here, bypassing
    // normalize (covered separately in config/tests.rs), so a future refactor can't silently
    // invert the guard without failing this test.
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    let cyl = Cylinder::new(
        12.0,
        250.0,
        250.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();

    for cfg in [
        // Zero survey-in speed (present, so in_speed uses it rather than the swim fallback).
        GasConfig {
            survey_speed_m_per_min: Some(0.0),
            ..GasConfig::default()
        },
        // Zero / NaN survey-RMV multiplier → in_rmv = 0 / NaN.
        GasConfig {
            survey_rmv_multiplier: 0.0,
            ..GasConfig::default()
        },
        GasConfig {
            survey_rmv_multiplier: f64::NAN,
            ..GasConfig::default()
        },
    ] {
        let field = project.compute_gas_reach_field(
            Some(&origin),
            &diver,
            std::slice::from_ref(&cyl),
            &cfg,
        );
        assert!(
            field.reachable.iter().all(|&r| !r),
            "all stations unreachable"
        );
        assert!(
            field.gas_to_reach.iter().all(|g| g.is_none()),
            "all gas_to_reach None"
        );
        assert!(field.turn_frontier.is_empty(), "empty turn frontier");
        assert!(
            field.max_reachable_gas.abs() < EPS,
            "max_reachable_gas == 0"
        );
    }
}

#[test]
fn gas_reach_field_none_origin_seeds_from_zero_datums() {
    let (mut project, origin) = linear_descent_project();
    project.zero_datums.push(ZeroDatum {
        station_ref: origin.into(),
        gps: GpsCoordinates::new(0.0, 0.0, 0.0).unwrap(),
    });
    let diver = Diver::new(20.0, None).unwrap();
    let big = Cylinder::new(
        1000.0,
        300.0,
        300.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    // None origin → seeds from the zero datum (the entrance station).
    let field = project.compute_gas_reach_field(None, &diver, &[big], &GasConfig::default());
    assert!(field_gas(&field, origin).abs() < EPS); // gas to reach the seed datum is 0
    assert!(field.reachable.iter().all(|&r| r)); // huge budget → all reachable from the datum
}
