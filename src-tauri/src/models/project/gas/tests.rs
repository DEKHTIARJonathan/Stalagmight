#![expect(
    clippy::unwrap_used,
    reason = "tests construct from known-valid literals; a failed unwrap should fail the test"
)]

use super::model::{CylRole, Cylinder, Diver, PlanMode, TankMaterial, Team};
use super::physics::{ata, avg_depth, cylinder_gas_volume, edge_gas, gas_rate, sac_to_rmv};

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
