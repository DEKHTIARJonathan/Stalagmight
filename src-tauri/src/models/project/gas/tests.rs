#![expect(
    clippy::unwrap_used,
    reason = "tests construct from known-valid literals; a failed unwrap should fail the test"
)]

use super::model::{CylRole, Cylinder, Diver, GasReachField, PlanMode, TankMaterial, Team};
use super::physics::{
    air_z_factor, ata, avg_depth, cylinder_gas_volume, deliverable_gas, edge_gas, gas_rate,
    sac_to_rmv,
};
use super::{is_swim_leg, penetration_budget, required_stages, route_metrics, usable_oc_gas};
use crate::config::{GasConfig, ReservePreset, ReserveProfile};
use crate::models::{
    Coordinates, GpsCoordinates, Project, SectionData, ShotData, StationRef, ZeroDatum,
};

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
fn required_stages_matches_presets() {
    assert_eq!(required_stages(ReservePreset::AllThirds), 0);
    assert_eq!(required_stages(ReservePreset::OneStage), 1);
    assert_eq!(required_stages(ReservePreset::TwoStage), 2);
}

#[test]
fn air_z_factor_matches_tabulated_air_and_never_credits() {
    // Anchored to the conservative (upper) end of tabulated air Z at cool cave temps
    // (NIST / US-Navy air tables: ~1.04–1.06 @ 200–232 bar, ~1.10–1.13 @ 300 bar). The fit is
    // derived from the 207 and 300 anchors; 232 bar is an INDEPENDENT interpolation check
    // against the table (not a derivation point), so a wrong coefficient is caught, not hidden.
    assert!((air_z_factor(0.0) - 1.0).abs() < EPS); // surface ≈ ideal
    assert!((air_z_factor(207.0) - 1.045).abs() < 0.008); // ~4.5% derate at a 207-bar fill
    assert!((air_z_factor(232.0) - 1.06).abs() < 0.01); // independent check vs tabulated air
    assert!((air_z_factor(300.0) - 1.12).abs() < 0.01); // ~12% at 300 bar (HP-steel fills)
                                                        // Clamped ≥ 1.0 everywhere — the derate can only ever REDUCE gas, never credit more than
                                                        // ideal (the safe direction), even where real air dips slightly below 1 (~50 bar).
    let mut prev = 0.0;
    for p in [0.0, 30.0, 50.0, 100.0, 150.0, 200.0, 250.0, 300.0] {
        let z = air_z_factor(p);
        assert!(z >= 1.0 - EPS, "z >= 1 at {p} bar");
        assert!(z >= prev - EPS, "monotone non-decreasing at {p} bar");
        prev = z;
    }
}

#[test]
fn deliverable_gas_always_below_ideal_and_conservative_caps_overfill() {
    // At rated (no overfill) the only derate is the Z correction, so deliverable < ideal.
    assert!(deliverable_gas(207.0, 11.1, 207.0, false) < cylinder_gas_volume(207.0, 11.1));
    // Overfilled LP steel: conservative caps to rated THEN applies Z; non-conservative only Z.
    let cons = deliverable_gas(230.0, 12.0, 179.0, true);
    let prec = deliverable_gas(230.0, 12.0, 179.0, false);
    assert!(cons < prec, "conservative rated-cap bites on an overfill");
    assert!((cons - 179.0 * 12.0 / air_z_factor(179.0)).abs() < 1e-6);
    assert!((prec - 230.0 * 12.0 / air_z_factor(230.0)).abs() < 1e-6);
}

#[test]
fn gas_reach_field_excludes_disabled_cylinders_from_budget() {
    // A disabled tank (#245) contributes nothing: the field computed WITH a disabled second
    // back-gas tank must match the field from the single enabled tank alone.
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    let enabled_bg = Cylinder::new(
        11.1,
        207.0,
        207.0,
        TankMaterial::Aluminium,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let disabled_bg = Cylinder {
        enabled: false,
        ..enabled_bg.clone()
    };

    let with_disabled = project.compute_gas_reach_field(
        Some(&origin),
        None,
        &diver,
        &[enabled_bg.clone(), disabled_bg],
        &GasConfig::default(),
    );
    let only_enabled = project.compute_gas_reach_field(
        Some(&origin),
        None,
        &diver,
        &[enabled_bg],
        &GasConfig::default(),
    );
    assert!(
        with_disabled.budget_litres > 0.0,
        "the one enabled tank still yields a budget"
    );
    assert!(
        (with_disabled.budget_litres - only_enabled.budget_litres).abs() < 1e-9,
        "the disabled tank must not add to the budget"
    );
}

#[test]
fn gas_reach_field_disabled_stage_falls_back_off_staged_strategy() {
    // When the rig's only Stage cylinder is disabled, a staged request has no stages to count,
    // so the effective strategy falls back to All-thirds — no stage drops (§6, never invent gas).
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    let bg = Cylinder::new(
        24.0,
        232.0,
        200.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let disabled_stage = Cylinder {
        enabled: false,
        ..Cylinder::new(
            11.0,
            207.0,
            200.0,
            TankMaterial::Aluminium,
            CylRole::Stage,
            None,
        )
        .unwrap()
    };
    let cfg = GasConfig {
        default_reserve: ReservePreset::OneStage,
        ..GasConfig::default()
    };
    let field =
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[bg, disabled_stage], &cfg);
    assert!(
        field.stage_drop_refs.is_empty() && field.stage_drop_bars.is_empty(),
        "a disabled-only stage rig falls back to All-thirds (no drops)"
    );
}

#[test]
fn penetration_budget_all_thirds_is_usable_over_three() {
    let bg = Cylinder::new(
        11.1,
        207.0,
        207.0,
        TankMaterial::Aluminium,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let cyls = [bg];
    let budget = penetration_budget(
        &cyls,
        ReservePreset::AllThirds,
        &ReserveProfile::default(),
        true,
    );
    assert!((budget - usable_oc_gas(&cyls, true) / 3.0).abs() < 1e-6);
}

#[test]
fn penetration_budget_half_minus_pins() {
    // Half-Minus, hand-computed at Z == 1 (all pressures < 100 bar ⇒ air_z_factor clamps to 1.0,
    // so deliverable == pressure × water-volume). Default stage reserve = 30 bar. A stage's IN gas
    // = full − deliverable((fill + reserve)/2) = (fill − reserve)/2 × w_s (drop @ (fill+reserve)/2).
    let prof = ReserveProfile::default(); // stage_reserve_bar = 30
    let bg = Cylinder::new(
        24.0,
        232.0,
        90.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let stage = || {
        Cylinder::new(
            11.0,
            207.0,
            90.0,
            TankMaterial::Aluminium,
            CylRole::Stage,
            None,
        )
        .unwrap()
    };
    // back gas deliverable = 90 × 24 = 2160 L; per stage IN = (90 − 30)/2 × 11 = 330 L (drop @ 60).

    let one = [bg.clone(), stage()];
    let b1 = penetration_budget(&one, ReservePreset::OneStage, &prof, false);
    assert!(
        (b1 - (0.25 * 2160.0 + 330.0)).abs() < 1e-6, // ¼·backgas + 1 stage = 540 + 330 = 870
        "1-stage = ¼ back gas + one stage's Half-Minus in-gas"
    );

    let two = [bg, stage(), stage()];
    let b2 = penetration_budget(&two, ReservePreset::TwoStage, &prof, false);
    assert!(
        (b2 - (2160.0 / 6.0 + 2.0 * 330.0)).abs() < 1e-6, // ⅙·backgas + 2 stages = 360 + 660 = 1020
        "2-stage = ⅙ back gas + two stages' Half-Minus in-gas"
    );
}

#[test]
fn penetration_budget_stage_reserve_lowers_budget() {
    // A larger per-stage reserve holds back more of the stage, so the staged budget shrinks
    // monotonically. Hand-computed at Z == 1 (fill 90 bar).
    let bg = Cylinder::new(
        24.0,
        232.0,
        90.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let stage = Cylinder::new(
        11.0,
        207.0,
        90.0,
        TankMaterial::Aluminium,
        CylRole::Stage,
        None,
    )
    .unwrap();
    let rig = [bg, stage];
    let small = ReserveProfile {
        stage_reserve_bar: 10.0,
        ..ReserveProfile::default()
    };
    let big = ReserveProfile {
        stage_reserve_bar: 50.0,
        ..ReserveProfile::default()
    };
    let b_small = penetration_budget(&rig, ReservePreset::OneStage, &small, false);
    let b_big = penetration_budget(&rig, ReservePreset::OneStage, &big, false);
    // in(reserve=10) = (90−10)/2 × 11 = 440 → 540 + 440 = 980; in(reserve=50) = 220 → 760.
    assert!((b_small - 980.0).abs() < 1e-6);
    assert!((b_big - 760.0).abs() < 1e-6);
    assert!(b_big < b_small, "more reserve → smaller penetration budget");
}

#[test]
fn penetration_budget_falls_back_to_all_thirds_without_stages() {
    // Default twin-AL80 rig carries ZERO stages → the pushy presets must fall back to the
    // AllThirds budget (never fabricate stage gas the diver isn't carrying — the safe gate).
    let prof = ReserveProfile::default();
    let bg = Cylinder::new(
        11.1,
        207.0,
        207.0,
        TankMaterial::Aluminium,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let rig = [bg.clone(), bg.clone()];
    let thirds = penetration_budget(&rig, ReservePreset::AllThirds, &prof, true);
    assert!((penetration_budget(&rig, ReservePreset::OneStage, &prof, true) - thirds).abs() < EPS);
    assert!((penetration_budget(&rig, ReservePreset::TwoStage, &prof, true) - thirds).abs() < EPS);

    // Adversarial boundary: TwoStage with EXACTLY ONE stage (1 < 2) must fall back BEFORE the
    // `stages[..2]` slice would panic — guards the count-gate's off-by-one. OneStage with that
    // same single stage does NOT fall back (1 >= 1), so its budget differs from all-thirds.
    let stage = Cylinder::new(
        11.1,
        207.0,
        207.0,
        TankMaterial::Aluminium,
        CylRole::Stage,
        None,
    )
    .unwrap();
    let one_stage_rig = [bg.clone(), bg, stage];
    let thirds_1 = penetration_budget(&one_stage_rig, ReservePreset::AllThirds, &prof, true);
    assert!(
        (penetration_budget(&one_stage_rig, ReservePreset::TwoStage, &prof, true) - thirds_1).abs()
            < EPS,
        "TwoStage with 1 stage falls back to all-thirds (no slice panic)"
    );
    assert!(
        penetration_budget(&one_stage_rig, ReservePreset::OneStage, &prof, true) != thirds_1,
        "OneStage with 1 stage uses the stage path, not the fallback"
    );
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
    // Counts back gas + stage (deco/dilout excluded), each Z-derated via deliverable_gas.
    assert!(
        (usable_oc_gas(&cyls, false)
            - (deliverable_gas(200.0, 12.0, 200.0, false)
                + deliverable_gas(207.0, 11.0, 207.0, false)))
        .abs()
            < 1e-6
    );

    // Overfilled backgas: conservative caps to rated (the "call-it-an-80" convention) then Z;
    // non-conservative applies only Z to the actual fill.
    let over = Cylinder::new(
        12.0,
        179.0,
        230.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    assert!(
        (usable_oc_gas(std::slice::from_ref(&over), true)
            - deliverable_gas(230.0, 12.0, 179.0, true))
        .abs()
            < 1e-6
    );
    assert!(
        (usable_oc_gas(&[over], false) - deliverable_gas(230.0, 12.0, 179.0, false)).abs() < 1e-6
    );
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
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[big], &GasConfig::default());
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
    let field = project.compute_gas_reach_field(
        Some(&origin),
        None,
        &diver,
        &[tiny],
        &GasConfig::default(),
    );
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
fn gas_reach_field_one_stage_route_drop_and_final_turn() {
    // Staged Half-Minus places a drop on the deepest-penetration route + a final turn.
    // gas-to-reach along the descent: station 0/1/2/3 = 0/300/800/1500 L (Z==1 at these depths).
    // OneStage budget = ¼·backgas + stage_in. Back gas 80 bar × 25 L = 2000 L ⇒ ¼ = 500; stage
    // 90 bar × 10 L water, reserve 30 ⇒ stage_in = (90−30)/2 × 10 = 300 L (drop @ 60 bar). Budget
    // = 800 → reaches the 800 L station (index 2); index 3 (1500 L) is out of budget.
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    let bg = Cylinder::new(
        25.0,
        232.0,
        80.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let stage = Cylinder::new(
        10.0,
        207.0,
        90.0,
        TankMaterial::Aluminium,
        CylRole::Stage,
        None,
    )
    .unwrap();
    let cfg = GasConfig {
        default_reserve: ReservePreset::OneStage,
        ..GasConfig::default()
    };
    let field = project.compute_gas_reach_field(Some(&origin), None, &diver, &[bg, stage], &cfg);

    let sec = origin.section_id;
    assert!((field.budget_litres - 800.0).abs() < 1e-6);
    // Stage drops where cumulative in-gas first reaches stage_in (300 L) = station 1; the route runs
    // origin → deepest in-budget station (index 2) = the final turn.
    assert_eq!(field.stage_drop_refs, vec![StationRef::new(sec, 1)]);
    assert_eq!(field.final_turn_ref, Some(StationRef::new(sec, 2)));
}

#[test]
fn gas_reach_field_two_stage_places_two_drops_in_order() {
    // TwoStage: two drops at the two cumulative stage thresholds, then the back-gas leg.
    // budget = ⅙·backgas + 2·stage_in. Back gas 80 bar × 82.5 L = 6600 L ⇒ ⅙ = 1100; each stage
    // 70 bar × 10 L water, reserve 30 ⇒ stage_in = (70−30)/2 × 10 = 200 L. Budget = 1100 + 400 =
    // 1500 → reaches station 3 (1500 L). Thresholds: 200 → first station ≥200 = station 1 (300 L);
    // 400 → first ≥400 = station 2 (800 L).
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    let bg = Cylinder::new(
        82.5,
        232.0,
        80.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let stage = || {
        Cylinder::new(
            10.0,
            207.0,
            70.0,
            TankMaterial::Aluminium,
            CylRole::Stage,
            None,
        )
        .unwrap()
    };
    let cfg = GasConfig {
        default_reserve: ReservePreset::TwoStage,
        ..GasConfig::default()
    };
    let field =
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[bg, stage(), stage()], &cfg);

    let sec = origin.section_id;
    assert!((field.budget_litres - 1500.0).abs() < 1e-6);
    assert_eq!(
        field.stage_drop_refs,
        vec![StationRef::new(sec, 1), StationRef::new(sec, 2)]
    );
    assert_eq!(field.final_turn_ref, Some(StationRef::new(sec, 3)));
}

#[test]
fn gas_reach_field_all_thirds_has_route_and_final_turn_but_no_drops() {
    // All-thirds has the route highlight + final turn (to the deepest reachable station) like any
    // strategy, but NO per-stage drops (those are staged-only).
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    let bg = Cylinder::new(
        25.0,
        232.0,
        80.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let field =
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[bg], &GasConfig::default());
    assert!(field.stage_drop_refs.is_empty());
    assert!(field.stage_drop_bars.is_empty());
    // Route + final turn ARE populated (to the deepest reachable station).
    assert!(!field.route.is_empty());
    assert!(field.final_turn_ref.is_some());
    assert!(field.reachable.iter().any(|&r| r));
}

#[test]
fn gas_reach_field_gauges_use_effective_strategy_and_conservative_cap() {
    // The engine computes the readout gauges (single source of truth). They must honour the
    // conservative cap AND the stage-count fallback, so the UI can display them without drifting.
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    // Matched twin back gas (fill 90, Z=1) + one OVERFILLED stage (fill 230 on a 207-rated AL).
    let bg = || {
        Cylinder::new(
            12.0,
            232.0,
            90.0,
            TankMaterial::Steel,
            CylRole::BackGas,
            None,
        )
        .unwrap()
    };
    let stage = Cylinder::new(
        11.0,
        207.0,
        230.0,
        TankMaterial::Aluminium,
        CylRole::Stage,
        None,
    )
    .unwrap();

    // OneStage with the stage present → effective OneStage (back-gas frac ¼).
    let cfg = GasConfig {
        default_reserve: ReservePreset::OneStage,
        ..GasConfig::default()
    };
    let f = project.compute_gas_reach_field(
        Some(&origin),
        None,
        &diver,
        &[bg(), bg(), stage.clone()],
        &cfg,
    );
    // avg start 90 × (1 − ¼) = 67.5 (Z=1 so usable=90·24; drop = ¼·90·24/24 = 22.5 → 90−22.5).
    assert!((f.backgas_turn_bar.unwrap() - 67.5).abs() < 1e-6);
    // Stage drop uses the CONSERVATIVE-capped basis min(230,207)=207 → (207+30)/2 = 118.5 (NOT
    // (230+30)/2=130 from the raw overfill) — pins that the gauge matches the engine's drop.
    assert_eq!(f.stage_drop_bars.len(), 1);
    assert!((f.stage_drop_bars[0] - 118.5).abs() < 1e-6);

    // TwoStage REQUESTED with only ONE stage → effective falls back to AllThirds: back-gas frac ⅓,
    // and NO stage-drop gauges (mirrors the budget/route fallback).
    let cfg2 = GasConfig {
        default_reserve: ReservePreset::TwoStage,
        ..GasConfig::default()
    };
    let f2 =
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[bg(), bg(), stage], &cfg2);
    assert!((f2.backgas_turn_bar.unwrap() - 90.0 * (2.0 / 3.0)).abs() < 1e-6);
    assert!(f2.stage_drop_bars.is_empty());
}

#[test]
fn gas_reach_field_backgas_turn_none_without_back_gas() {
    // A stage-only rig has no back-gas gauge (None), but the stage still has a drop gauge.
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    let stage = Cylinder::new(
        11.0,
        207.0,
        90.0,
        TankMaterial::Aluminium,
        CylRole::Stage,
        None,
    )
    .unwrap();
    let cfg = GasConfig {
        default_reserve: ReservePreset::OneStage,
        ..GasConfig::default()
    };
    let field = project.compute_gas_reach_field(Some(&origin), None, &diver, &[stage], &cfg);
    assert_eq!(field.backgas_turn_bar, None);
    assert_eq!(field.stage_drop_bars.len(), 1);
}

#[test]
fn gas_reach_field_staged_with_no_stages_falls_back_to_all_thirds() {
    // OneStage REQUESTED but the rig carries ZERO stages → effective AllThirds: NO per-stage drops,
    // empty stage-drop gauges, and the back-gas gauge uses the ⅓ fraction (but the route + final
    // turn are still populated, like any strategy).
    let (project, origin) = linear_descent_project();
    let diver = Diver::new(20.0, None).unwrap();
    let bg = Cylinder::new(
        25.0,
        232.0,
        80.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let cfg = GasConfig {
        default_reserve: ReservePreset::OneStage,
        ..GasConfig::default()
    };
    let field = project.compute_gas_reach_field(Some(&origin), None, &diver, &[bg], &cfg);
    assert!(field.stage_drop_refs.is_empty());
    assert!(field.stage_drop_bars.is_empty());
    assert!(field.final_turn_ref.is_some());
    assert!((field.backgas_turn_bar.unwrap() - 80.0 * (2.0 / 3.0)).abs() < 1e-6);
}

#[test]
fn gas_reach_field_endpoint_selects_the_route_for_drops() {
    // Two branches from a shared origin (section A merged to B at station 0); flat shots ⇒ gas =
    // 2×length. A: a1 300, a2 500 (deepest). B: b1 200, b2 400.
    let mut project = Project::new("Gas".to_string(), None);
    let a = project
        .add_section(SectionData {
            shots: vec![make_shot(150.0, 0.0, 0.0), make_shot(100.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    let b = project
        .add_section(SectionData {
            shots: vec![make_shot(100.0, 0.0, 0.0), make_shot(100.0, 0.0, 0.0)],
            ..Default::default()
        })
        .id;
    project
        .merge_stations(StationRef::new(a, 0), StationRef::new(b, 0))
        .unwrap();
    let origin = StationRef::new(a, 0);
    let diver = Diver::new(20.0, None).unwrap();
    // OneStage: stage_in 300 (fill 90, w 10, reserve 30); ¼ back gas 200 (fill 80, w 10 = 800) →
    // budget 500 reaches a2 (500) and b2 (400). deepest = a2.
    let bg = Cylinder::new(
        10.0,
        232.0,
        80.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let stage = Cylinder::new(
        10.0,
        207.0,
        90.0,
        TankMaterial::Aluminium,
        CylRole::Stage,
        None,
    )
    .unwrap();
    let cyls = [bg, stage];
    let cfg = GasConfig {
        default_reserve: ReservePreset::OneStage,
        ..GasConfig::default()
    };

    // No endpoint → route to the deepest (a2); drop where gas ≥ 300 = a1.
    let d = project.compute_gas_reach_field(Some(&origin), None, &diver, &cyls, &cfg);
    assert_eq!(d.final_turn_ref, Some(StationRef::new(a, 2)));
    assert_eq!(d.stage_drop_refs, vec![StationRef::new(a, 1)]);

    // Endpoint = b2 → route follows B instead; drop where gas ≥ 300 = b2, final turn b2.
    let e = project.compute_gas_reach_field(
        Some(&origin),
        Some(&StationRef::new(b, 2)),
        &diver,
        &cyls,
        &cfg,
    );
    assert_eq!(e.final_turn_ref, Some(StationRef::new(b, 2)));
    assert_eq!(e.stage_drop_refs, vec![StationRef::new(b, 2)]);
}

#[test]
fn gas_reach_field_threshold_past_deepest_yields_fewer_drops() {
    // TwoStage whose budget only reaches the FIRST drop threshold → one ▼, not two (the
    // staged_route filter_map drops a threshold beyond the deepest reachable station).
    let (project, origin) = linear_descent_project(); // gas 0/300/800/1500
    let diver = Diver::new(20.0, None).unwrap();
    let bg = Cylinder::new(
        10.0,
        232.0,
        60.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let stage = || {
        Cylinder::new(
            10.0,
            207.0,
            70.0,
            TankMaterial::Aluminium,
            CylRole::Stage,
            None,
        )
        .unwrap()
    };
    // stage_in = (70−30)/2 × 10 = 200; thresholds 200, 400. ⅙ back gas = 600/6 = 100. budget = 500
    // → reaches station 1 (300), not station 2 (800). drop1 at station 1 (≥200); drop2 (≥400) is
    // past the deepest reachable gas (300) → no second drop.
    let cfg = GasConfig {
        default_reserve: ReservePreset::TwoStage,
        ..GasConfig::default()
    };
    let field =
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[bg, stage(), stage()], &cfg);
    let sec = origin.section_id;
    assert!((field.budget_litres - 500.0).abs() < 1e-6);
    assert_eq!(field.final_turn_ref, Some(StationRef::new(sec, 1)));
    assert_eq!(field.stage_drop_refs, vec![StationRef::new(sec, 1)]);
}

#[test]
fn is_swim_leg_distinguishes_shots_from_ties() {
    // Adjacent stations within a section = a swum shot (incl. a reference/jump).
    assert!(is_swim_leg(&StationRef::new(1, 0), &StationRef::new(1, 1)));
    assert!(is_swim_leg(&StationRef::new(1, 2), &StationRef::new(1, 1)));
    // Cross-section (a merge / closure tie) = NOT a swum leg.
    assert!(!is_swim_leg(&StationRef::new(1, 0), &StationRef::new(2, 0)));
    // Same section but non-adjacent (a closure within one section) = NOT a swum leg.
    assert!(!is_swim_leg(&StationRef::new(1, 0), &StationRef::new(1, 2)));
}

#[test]
fn route_metrics_pure_line_length_and_depths() {
    let pt = |x: f64, y: f64, z: f64| Coordinates { x, y, z };
    // Pure helper: 3-D polyline length + deepest point + distance-weighted average depth.
    // Degenerate cases first: empty route, single station.
    assert_eq!(route_metrics(&[], &[]), (0.0, None, None));
    assert_eq!(
        route_metrics(&[pt(5.0, 5.0, 12.0)], &[]),
        (0.0, Some(12.0), Some(12.0))
    );
    // Vertical descent 0→10→30 m (both legs swum): segments 10 + 20 = 30 m; deepest 30;
    // depth-weighted average = (10·mid5 + 20·mid20) / 30 = (50 + 400) / 30 = 15.
    let descent = [pt(0.0, 0.0, 0.0), pt(0.0, 0.0, 10.0), pt(0.0, 0.0, 30.0)];
    let (len, maxd, avgd) = route_metrics(&descent, &[true, true]);
    assert!((len - 30.0).abs() < EPS);
    assert_eq!(maxd, Some(30.0));
    assert!((avgd.unwrap() - 15.0).abs() < EPS);
    // True 3-D legs (east+north, then a pure depth drop): (0,0,0)→(3,4,0) = 5 m, →(3,4,12) = 12 m
    // ⇒ 17 m total, deepest 12.
    let three_d = [pt(0.0, 0.0, 0.0), pt(3.0, 4.0, 0.0), pt(3.0, 4.0, 12.0)];
    let (len2, maxd2, _) = route_metrics(&three_d, &[true, true]);
    assert!((len2 - 17.0).abs() < EPS);
    assert_eq!(maxd2, Some(12.0));
    // Deepest point at an INTERIOR station (descend then rise): max depth must be the interior 30,
    // not the 10 m terminal — a regression that returned the last station's depth would fail here.
    let dome = [pt(0.0, 0.0, 0.0), pt(0.0, 0.0, 30.0), pt(0.0, 0.0, 10.0)];
    let (_, maxd3, _) = route_metrics(&dome, &[true, true]);
    assert_eq!(maxd3, Some(30.0));
    // A TIE leg (swim=false) with a large coord gap — the loop-closure misclosure case — is
    // excluded from length AND the depth-weighted average: only the first (swum) 10 m leg counts.
    let with_tie = [pt(0.0, 0.0, 0.0), pt(0.0, 0.0, 10.0), pt(100.0, 0.0, 10.0)];
    let (len4, maxd4, avgd4) = route_metrics(&with_tie, &[true, false]);
    assert!((len4 - 10.0).abs() < EPS); // the 90 m tie gap is NOT counted
    assert_eq!(maxd4, Some(10.0));
    assert!((avgd4.unwrap() - 5.0).abs() < EPS); // only the 0→10 m leg, mid-depth 5
}

#[test]
fn gas_reach_field_reports_route_distance_and_depths() {
    // linear_descent (3×100 m shots, 0→10→20→30 m). A huge back-gas rig reaches the deepest
    // station, so the route is the whole descent: line length 3×100 = 300 m, deepest 30 m, and the
    // depth-weighted average over the three equal-length legs (mids 5/15/25 m) = 15 m.
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
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[big], &GasConfig::default());
    assert_eq!(field.final_turn_ref, Some(StationRef::new(sec, 3)));
    // Placement preserves tape length for a constant-azimuth descent ⇒ 3×100 m.
    assert!((field.route_line_length_m - 300.0).abs() < 1e-3);
    assert_eq!(field.route_max_depth_m, Some(30.0));
    assert!((field.route_avg_depth_m.unwrap() - 15.0).abs() < 1e-6);
}

#[test]
fn gas_reach_field_no_route_has_no_distance_or_depth() {
    // An empty project has nothing reachable ⇒ no route ⇒ zero length and no depths (not 0-depth).
    let project = Project::new("Gas".to_string(), None);
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
    let field = project.compute_gas_reach_field(None, None, &diver, &[big], &GasConfig::default());
    assert!(field.final_turn_ref.is_none());
    assert!(field.route_line_length_m.abs() < EPS);
    assert_eq!(field.route_max_depth_m, None);
    assert_eq!(field.route_avg_depth_m, None);
}

#[test]
fn penetration_budget_reserve_at_or_above_fill_zeroes_stage() {
    // reserve == fill ⇒ drop = (fill+reserve)/2 = fill = full ⇒ stage contributes 0 IN gas; the
    // budget collapses to the bare back-gas fraction (no negative / NaN leak).
    let bg = Cylinder::new(
        24.0,
        232.0,
        90.0,
        TankMaterial::Steel,
        CylRole::BackGas,
        None,
    )
    .unwrap();
    let stage = Cylinder::new(
        10.0,
        207.0,
        90.0,
        TankMaterial::Aluminium,
        CylRole::Stage,
        None,
    )
    .unwrap();
    let rig = [bg, stage];
    let high = ReserveProfile {
        stage_reserve_bar: 90.0,
        ..ReserveProfile::default()
    };
    let b = penetration_budget(&rig, ReservePreset::OneStage, &high, false);
    assert!((b - 0.25 * 90.0 * 24.0).abs() < 1e-6); // ¼ back gas only
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
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[big], &GasConfig::default());

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
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[big], &GasConfig::default());

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

    // Route metrics across the merge TIE (#236): the route is A:0→A:1→[merge tie]→B:0→B:1. The two
    // SWUM shots are 100 m each; the 0-cost merge tie (A:1→B:0, cross-section) must NOT be counted in
    // the line length — is_swim_leg excludes it — so the distance is ~200 m end-to-end. This pins the
    // integration wiring (route_refs → is_swim_leg mask → route_metrics); a regression that dropped
    // the mask would count the tie's measured-coord gap and inflate the length. Deepest station is
    // B:1 (20 m); the swum-leg depth-weighted average is (100·5 + 100·15)/200 = 10 m.
    assert_eq!(field.final_turn_ref, Some(StationRef::new(b, 1)));
    assert!(
        (field.route_line_length_m - 200.0).abs() < 1.0,
        "route_line_length_m should be ~200 m (two swum shots; merge tie excluded), got {}",
        field.route_line_length_m
    );
    assert_eq!(field.route_max_depth_m, Some(20.0));
    assert!((field.route_avg_depth_m.unwrap() - 10.0).abs() < 1e-6);
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
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[big], &GasConfig::default());
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
    let field = project.compute_gas_reach_field(Some(&origin), None, &diver, &[big], &config);
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
fn gas_reach_field_route_legs_flag_jumps() {
    // The route's reference (jump) leg is flagged `is_jump` so the UI can dash it (jumps are
    // normally hidden). Route origin → station 2 (deepest): leg 0 (0→1) regular, leg 1 (1→2) jump.
    let (project, origin) = project_with_jump_second_leg();
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
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[big], &GasConfig::default());
    let sec = origin.section_id;
    assert_eq!(field.route.len(), 2);
    assert!(!field.route[0].is_jump);
    assert!(field.route[1].is_jump);
    assert_eq!(field.route[1].from, StationRef::new(sec, 1));
    assert_eq!(field.route[1].to, StationRef::new(sec, 2));
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

    // Explicit 1.0 base — the DEFAULT jump_rmv_multiplier is now 1.5, so a plain
    // `GasConfig::default()` base would already bump the jump leg and collapse the contrast.
    let unbumped = GasConfig {
        jump_rmv_multiplier: 1.0,
        ..GasConfig::default()
    };
    let base = project.compute_gas_reach_field(
        Some(&origin),
        None,
        &diver,
        std::slice::from_ref(&big),
        &unbumped,
    );
    assert!((field_gas(&base, StationRef::new(sec, 1)) - 300.0).abs() < 1e-6);
    assert!((field_gas(&base, StationRef::new(sec, 2)) - 800.0).abs() < 1e-6);

    let bumped = GasConfig {
        jump_rmv_multiplier: 1.5,
        ..GasConfig::default()
    };
    let field = project.compute_gas_reach_field(Some(&origin), None, &diver, &[big], &bumped);
    assert!((field_gas(&field, StationRef::new(sec, 1)) - 300.0).abs() < 1e-6);
    assert!((field_gas(&field, StationRef::new(sec, 2)) - 1050.0).abs() < 1e-6);
}

#[test]
fn gas_reach_field_partial_frontier_between_interior_stations() {
    // AllThirds budget = deliverable(250 bar, 12 L)/3 = 3000 / Z(250)≈1.0753 / 3 ≈ 929.9 L
    // (Z-derated thirds), which sits between gas_in(station 2)=800 and gas_in(station 3)=1500 →
    // reach {0,1,2}, turn at station 2. The budget is pinned to an INDEPENDENT hand-computed
    // literal (catches a wrong /3, a dropped Z, or a bad fit), not re-derived from the function.
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
        project.compute_gas_reach_field(Some(&origin), None, &diver, &[cyl], &GasConfig::default());
    assert!((field.budget_litres - 929.9).abs() < 1.0);
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
            None,
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
    let field = project.compute_gas_reach_field(None, None, &diver, &[big], &GasConfig::default());
    assert!(field_gas(&field, origin).abs() < EPS); // gas to reach the seed datum is 0
    assert!(field.reachable.iter().all(|&r| r)); // huge budget → all reachable from the datum
}
