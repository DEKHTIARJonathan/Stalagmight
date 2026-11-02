//! [#576 NF-PGAS3-1, decided "route computed without pins, then pins applied"] A moved
//! stage drop never redirects the dive.
//!
//! The plan's route and turnaround are the pin-free plan's. Pins are applied to that
//! route: one that strands gas lowers the budget and the dive turns earlier on the same
//! route; one that does not leaves the turnaround where it was. Before, with no endpoint,
//! a lowered budget re-picked the deepest station anywhere - on another branch of the
//! two-branch cave - and the pinned drop's marker was re-placed there by its threshold.
//!
//! Swept like the P-GAS3 probe: three strategies, two fills, three endpoints (none, each
//! branch end), with and without a way point that makes the route double back, with and
//! without a scooter, and every station pinned alone, as the second drop, and in pairs.

#![expect(
    clippy::unwrap_used,
    reason = "tests construct from known-valid literals; a failed unwrap should fail the test"
)]

use std::collections::HashSet;

use super::model::{CylRole, Cylinder, Diver, GasReachField, PlanSegment, TankMaterial};
use super::route_sweep_tests::{scooter, two_branch_cave};
use crate::config::{GasConfig, ReservePreset};
use crate::StationRef;

fn route_stations(field: &GasReachField) -> HashSet<StationRef> {
    field
        .route
        .iter()
        .flat_map(|leg| [leg.from, leg.to])
        .chain(field.final_turn_ref)
        .collect()
}

/// What one pinned plan did that the decision forbids, if anything.
fn verdict(plain: &GasReachField, pinned: &GasReachField) -> Option<String> {
    let base_route = route_stations(plain);
    if let Some(turn) = pinned.final_turn_ref {
        if !base_route.contains(&turn) {
            return Some(format!("turnaround moved off the route to {turn:?}"));
        }
    }
    if let Some(off) = route_stations(pinned)
        .into_iter()
        .find(|s| !base_route.contains(s))
    {
        return Some(format!("route left the pin-free route at {off:?}"));
    }
    if let Some(off) = pinned
        .stage_drop_refs
        .iter()
        .find(|s| !base_route.contains(s))
    {
        return Some(format!("drop marker drawn off the route at {off:?}"));
    }
    if pinned.budget_litres >= plain.budget_litres - 1e-9
        && pinned.final_turn_ref != plain.final_turn_ref
    {
        return Some(format!(
            "turnaround moved ({:?} -> {:?}) although the pins left the budget alone",
            plain.final_turn_ref, pinned.final_turn_ref
        ));
    }
    let gained = pinned
        .reachable
        .iter()
        .zip(&plain.reachable)
        .any(|(&with, &without)| with && !without);
    if pinned.budget_litres > plain.budget_litres + 1e-9 || gained {
        return Some("reaches further than the plan without pins".to_string());
    }
    if let Some(turn) = pinned.final_turn_ref {
        let i = pinned.station_refs.iter().position(|s| *s == turn)?;
        if !pinned.reachable.get(i).copied().unwrap_or(false) {
            return Some(format!("turnaround {turn:?} is out of the pinned budget"));
        }
    }
    None
}

#[test]
fn a_moved_drop_never_moves_the_turnaround_or_a_marker_off_the_route() {
    let (project, origin, trunk_end, side_end) = two_branch_cave();
    let diver = Diver::new(20.0, None).unwrap();
    let endpoints = [None, Some(trunk_end), Some(side_end)];
    let waypoint_sets: [&[StationRef]; 2] = [&[], &[side_end]];
    let mut runs = 0usize;
    let mut turned_earlier = 0usize;
    let mut violations = Vec::new();
    for preset in [
        ReservePreset::OneStage,
        ReservePreset::TwoStage,
        ReservePreset::Free,
    ] {
        for fill in [207.0, 280.0] {
            for on_scooter in [false, true] {
                let cfg = GasConfig {
                    default_reserve: preset,
                    dpv: on_scooter.then(scooter),
                    ..GasConfig::default()
                };
                let segments: Vec<PlanSegment> = if on_scooter {
                    vec![PlanSegment {
                        speed_m_per_min: None,
                        on_scooter: true,
                    }]
                } else {
                    Vec::new()
                };
                let tank = |v: f64, role: CylRole, usable: f64| Cylinder {
                    usable_gas_bar: usable,
                    ..Cylinder::new(v, 207.0, fill, TankMaterial::Steel, role, None).unwrap()
                };
                let rig = [
                    tank(15.0, CylRole::BackGas, 110.0),
                    tank(11.0, CylRole::Stage, 70.0),
                    tank(7.0, CylRole::Stage, 60.0),
                ];
                for endpoint in &endpoints {
                    for waypoints in waypoint_sets {
                        if on_scooter && !waypoints.is_empty() {
                            continue;
                        }
                        let field = |pins: &[Option<StationRef>]| {
                            project.compute_gas_reach_field_with_overrides(
                                Some(&origin),
                                endpoint.as_ref(),
                                waypoints,
                                &segments,
                                &diver,
                                &rig,
                                &cfg,
                                pins,
                            )
                        };
                        let plain = field(&[]);
                        let stations = plain.station_refs.clone();
                        let mut pin_sets: Vec<Vec<Option<StationRef>>> = Vec::new();
                        for (i, &s) in stations.iter().enumerate() {
                            pin_sets.push(vec![Some(s)]);
                            pin_sets.push(vec![None, Some(s)]);
                            for &t in stations.iter().skip(i + 1) {
                                pin_sets.push(vec![Some(s), Some(t)]);
                            }
                        }
                        for pins in &pin_sets {
                            runs += 1;
                            let pinned = field(pins);
                            if pinned.final_turn_ref != plain.final_turn_ref {
                                turned_earlier += 1;
                            }
                            if let Some(why) = verdict(&plain, &pinned) {
                                violations.push(format!(
                                    "{preset:?} fill {fill} scooter {on_scooter} end {endpoint:?} \
                                     way points {waypoints:?} pins {pins:?}: {why} (budget \
                                     {:.1} L against {:.1} L)",
                                    pinned.budget_litres, plain.budget_litres
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    println!(
        "pinned-route sweep: {runs} pinned plans, {turned_earlier} turned earlier, {} off the \
         pin-free route or reaching further",
        violations.len()
    );
    for v in violations.iter().take(6) {
        println!("  {v}");
    }
    assert!(runs > 2000, "sweep ran {runs} plans");
    assert!(
        turned_earlier > 0,
        "the sweep must include pins that strand gas and turn the dive earlier"
    );
    assert!(
        violations.is_empty(),
        "{} of {runs} pinned plans moved the dive or a marker off the pin-free route",
        violations.len()
    );
}
