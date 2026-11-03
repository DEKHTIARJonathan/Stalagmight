//! [#576 RV8c-2] A pinned plan is monotone in its gas.
//!
//! The rule this replaced (NF-PGAS3-1) priced a pin only when the pin-free route passed it, so
//! LESS gas - which can move the pin-free route to another branch, or end it short of the pin -
//! dropped the pin, handed back the gas it stranded, and reached further (RV8c-2: 27 of 60,000
//! cross-build scenarios, and on one build alone with fills below the Z == 1 knee). With the pin
//! deciding the route (D1-D3) the route does not depend on the gas at all, so for one fixed pinned
//! plan lowering a gas input can only shrink it.
//!
//! The sweep: random tree caves, rigs, endpoints, way points, scooters and pins (anywhere,
//! including off every route), one input lowered at a time - a back-gas fill, a stage fill, a
//! cylinder's size. Fills stay where the strategy's own per-cylinder credit is monotone in them:
//! at or below the rating under the conservative cap, up to 300 bar without it. Above the rating
//! under the cap, and under Free with a usable allowance below the fill, the decided gauge rule
//! (#576 A18(e)) credits a LOWER fill MORE even without a pin - the same usable bar sits lower on
//! the Z curve - so there only the cylinder's size is lowered. The pin-free plan's budget never
//! rising is asserted too, as the check that each case is in that domain. What is asserted for
//! every lowering, with nothing set aside: the budget never rises, no station is newly painted
//! (the overlay is priced on the route through the pins, D4), the turn never moves later, and the
//! pinned plan never has more budget or reach than the same plan without its pins. The sweep is a
//! fixed 2,500 plans from a fixed seed, so it runs the same cases in the same few seconds every
//! time.
//!
//! The corner this sweep used to set aside is asserted now (#576 RV8c-2-D5, decided "next stage
//! starts at pin"): a stage pinned past its own tank-empty point ahead of a later stage. Its drop
//! snaps back to the empty point (#246), and the next stage used to be breathed from there, so a
//! SMALLER first stage emptied sooner, handed more of the route to the next one, and was credited
//! less of the stranding - 18 of 563 such lowerings raised the budget, one from 1302 to 1805 L
//! (rebuilt below). The next stage now starts at the pin.

#![expect(
    clippy::unwrap_used,
    reason = "tests construct from known-valid literals; a failed unwrap should fail the test"
)]

use super::model::{CylRole, Cylinder, Diver, GasReachField, PlanSegment, TankMaterial};
use crate::config::{DpvRig, DpvUnit, GasConfig, ReservePreset};
use crate::{Project, SectionData, ShotData, StationRef};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
    fn pick(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// A random tree cave: a first line, then branches each joined at its first station to a random
/// station already in the cave. Returns the project, the origin and every station.
fn random_cave(r: &mut Rng) -> (Project, StationRef, Vec<StationRef>) {
    let mut p = Project::new("Gas".to_string(), None);
    let mut stations: Vec<StationRef> = Vec::new();
    let sections = 2 + r.pick(4);
    for k in 0..sections {
        let legs = if k == 0 { 3 + r.pick(7) } else { 1 + r.pick(7) };
        let mut depth = r.range(0.0, 20.0);
        let shots = (0..legs)
            .map(|_| {
                let from = depth;
                depth = (depth + r.range(-5.0, 8.0)).max(0.0);
                ShotData {
                    length: r.range(20.0, 200.0),
                    azimuth_in: r.range(0.0, 360.0),
                    azimuth_out: 0.0,
                    depth_in: from,
                    depth_out: depth,
                    ..Default::default()
                }
            })
            .collect::<Vec<_>>();
        let id = p
            .add_section(SectionData {
                shots,
                ..Default::default()
            })
            .id;
        if k > 0 {
            let at = stations[r.pick(stations.len())];
            p.merge_stations(at, StationRef::new(id, 0)).unwrap();
        }
        stations.extend((0..=legs).map(|i| StationRef::new(id, i as u32)));
    }
    let origin = stations[0];
    (p, origin, stations)
}

fn random_cylinder(r: &mut Rng, role: CylRole, conservative: bool) -> Cylinder {
    let rated = [176.0, 200.0, 207.0, 232.0, 300.0][r.pick(5)];
    let fill = if conservative {
        r.range(30.0, rated)
    } else {
        r.range(30.0, 300.0)
    };
    Cylinder {
        usable_gas_bar: r.range(0.0, 250.0),
        ..Cylinder::new(
            r.range(3.0, 20.0),
            rated,
            fill,
            TankMaterial::Steel,
            role,
            None,
        )
        .unwrap()
    }
}

fn reach_within(smaller: &GasReachField, larger: &GasReachField) -> Option<StationRef> {
    debug_assert_eq!(smaller.station_refs, larger.station_refs);
    smaller
        .reachable
        .iter()
        .zip(&larger.reachable)
        .position(|(&a, &b)| a && !b)
        .map(|i| smaller.station_refs[i])
}

/// Whether lowering stage `k` (its index among the plan's stage drops) is the D5 corner the module
/// doc names - counted so the sweep shows it reaches it: stage `k` is pinned, has a later stage
/// behind it, and reads empty at its drop in either plan - breathed to tank-empty before its pin.
/// In this sweep's domain (fills at or below the rating under the cap, or no cap) a drained
/// stage's gauge reads 0.
fn drains_ahead_of_another(
    k: Option<usize>,
    pins: &[Option<StationRef>],
    plans: [&GasReachField; 2],
) -> bool {
    let Some(k) = k else { return false };
    pins.get(k).copied().flatten().is_some()
        && plans
            .iter()
            .any(|f| k + 1 < f.stage_drop_bars.len() && f.stage_drop_bars[k] < 1e-6)
}

/// Route gas at the turnaround: the last outbound profile point (0 for a route with no swum leg);
/// `None` with no turnaround.
fn turn_gas(f: &GasReachField) -> Option<f64> {
    f.final_turn_ref?;
    Some(
        f.route_profile
            .iter()
            .rev()
            .find(|p| p.outbound)
            .map_or(0.0, |p| p.gas_l),
    )
}

#[test]
fn lowering_any_gas_input_never_lets_a_pinned_plan_reach_further() {
    let diver = Diver::new(20.0, None).unwrap();
    let mut r = Rng(0x2545_F491_4F6C_DD1D);
    let mut runs = 0usize;
    let mut lowered_budget = 0usize;
    let mut drained_corner = 0usize;
    let mut violations: Vec<String> = Vec::new();
    for case in 0..2500 {
        let (project, origin, stations) = random_cave(&mut r);
        let preset = [
            ReservePreset::OneStage,
            ReservePreset::TwoStage,
            ReservePreset::Free,
        ][r.pick(3)];
        let conservative = r.unit() < 0.7;
        let backs = 1 + r.pick(2);
        let mut rig: Vec<Cylinder> = (0..backs)
            .map(|_| random_cylinder(&mut r, CylRole::BackGas, conservative))
            .collect();
        rig.extend((0..=r.pick(3)).map(|_| random_cylinder(&mut r, CylRole::Stage, conservative)));
        let mut cfg = GasConfig {
            default_reserve: preset,
            conservative_tank_gas: conservative,
            ..GasConfig::default()
        };
        cfg.reserve_profile.stage_reserve_bar = r.range(0.0, 60.0);
        let scootered = r.unit() < 0.25;
        if scootered {
            cfg.dpv = Some(DpvRig {
                primary: DpvUnit {
                    speed_m_per_min: r.range(25.0, 60.0),
                    burn_minutes: r.range(5.0, 60.0),
                },
                backup: DpvUnit {
                    speed_m_per_min: r.range(25.0, 60.0),
                    burn_minutes: r.range(5.0, 60.0),
                },
                range_reserve_fraction: r.range(0.0, 0.4),
            });
        }
        cfg.normalize();
        let endpoint = (r.unit() < 0.5).then(|| stations[r.pick(stations.len())]);
        let waypoints: Vec<StationRef> = if r.unit() < 0.25 {
            vec![stations[r.pick(stations.len())]]
        } else {
            Vec::new()
        };
        let segments: Vec<PlanSegment> = (0..=waypoints.len())
            .map(|_| PlanSegment {
                speed_m_per_min: None,
                on_scooter: scootered && r.unit() < 0.7,
            })
            .collect();
        let pins: Vec<Option<StationRef>> = (0..=r.pick(2))
            .map(|_| (r.unit() < 0.85).then(|| stations[r.pick(stations.len())]))
            .collect();
        let field = |rig: &[Cylinder], pins: &[Option<StationRef>]| {
            project.compute_gas_reach_field_with_overrides(
                Some(&origin),
                endpoint.as_ref(),
                &waypoints,
                &segments,
                &diver,
                rig,
                &cfg,
                pins,
            )
        };
        let pinned = field(&rig, &pins);
        let pin_free = field(&rig, &[]);
        let label = |what: &str| {
            format!(
                "case {case} {preset:?} cons {conservative} end {endpoint:?} wp {waypoints:?} \
                 pins {pins:?}: {what}"
            )
        };
        // (c) A pinned plan never exceeds the plan without its pins.
        if pinned.budget_litres > pin_free.budget_litres + 1e-9 {
            violations.push(label(&format!(
                "pinned budget {:.3} L above the pin-free {:.3} L",
                pinned.budget_litres, pin_free.budget_litres
            )));
        }
        if let Some(s) = reach_within(&pinned, &pin_free) {
            violations.push(label(&format!("pin made {s:?} reachable")));
        }
        for _ in 0..3 {
            let budget_cyls: Vec<usize> = (0..rig.len()).collect();
            let i = budget_cyls[r.pick(budget_cyls.len())];
            let mut lower = rig.clone();
            let c = &mut lower[i];
            // Fills only where the strategy's own credit is monotone in them (module doc).
            let fill_is_monotone = preset != ReservePreset::Free
                && (!conservative || c.fill_bar <= c.rated_pressure_bar);
            let what = if fill_is_monotone && r.unit() < 0.6 {
                let from = c.fill_bar;
                c.fill_bar = (from * r.range(0.4, 0.99)).max(5.0);
                format!("{:?} {i} fill {from:.2} -> {:.2}", c.role, c.fill_bar)
            } else {
                let from = c.water_volume_l;
                c.water_volume_l = (from * r.range(0.4, 0.99)).max(0.5);
                format!(
                    "{:?} {i} size {from:.3} -> {:.3} L",
                    c.role, c.water_volume_l
                )
            };
            runs += 1;
            let after = field(&lower, &pins);
            let free_after = field(&lower, &[]);
            assert!(
                free_after.budget_litres <= pin_free.budget_litres + 1e-9,
                "test domain: the pin-free budget rose ({what}), {:.3} -> {:.3} L",
                pin_free.budget_litres,
                free_after.budget_litres
            );
            if after.budget_litres < pinned.budget_litres - 1e-9 {
                lowered_budget += 1;
            }
            let mut found: Vec<String> = Vec::new();
            if after.budget_litres > pinned.budget_litres + 1e-9 {
                found.push(format!(
                    "{what}: budget {:.3} -> {:.3} L",
                    pinned.budget_litres, after.budget_litres
                ));
            }
            if let Some(s) = reach_within(&after, &pinned) {
                found.push(format!("{what}: {s:?} became reachable"));
            }
            match (turn_gas(&pinned), turn_gas(&after)) {
                (Some(before), Some(now)) if now > before + 1e-6 => found.push(format!(
                    "{what}: turn moved later, {before:.2} -> {now:.2} L of route gas ({:?} -> {:?})",
                    pinned.final_turn_ref, after.final_turn_ref
                )),
                (None, Some(_)) => found.push(format!("{what}: a turnaround appeared")),
                _ => {}
            }
            let stage_k = (rig[i].role == CylRole::Stage).then(|| i - backs);
            if drains_ahead_of_another(stage_k, &pins, [&pinned, &after]) {
                drained_corner += 1;
            }
            violations.extend(found.iter().map(|f| label(f)));
        }
    }
    println!(
        "pinned monotonicity sweep: {runs} lowered inputs over 2500 pinned plans, {lowered_budget} \
         lowered the budget, {drained_corner} in the D5 corner (a stage drained ahead of another), \
         0 set aside, {} violations",
        violations.len()
    );
    for v in violations.iter().take(8) {
        println!("  {v}");
    }
    assert!(
        runs >= 7500 && lowered_budget > runs / 4,
        "the sweep must bite"
    );
    assert!(
        drained_corner > 100,
        "the sweep must reach the D5 corner ({drained_corner})"
    );
    assert!(
        violations.is_empty(),
        "{} pinned plans reached further on less gas, or past the plan without their pins",
        violations.len()
    );
}

/// The sweep's case 791, rebuilt: a five-leg line (lengths and depths as the sweep drew them,
/// rounded to the millimetre), with two side passages joined at its end, 0:5.
fn case_791_cave() -> (Project, StationRef, [StationRef; 2]) {
    let mut p = Project::new("Gas".to_string(), None);
    let leg = |length: f64, depth_in: f64, depth_out: f64| ShotData {
        length,
        depth_in,
        depth_out,
        ..Default::default()
    };
    let line = p
        .add_section(SectionData {
            shots: vec![
                leg(114.447, 0.414, 4.986),
                leg(123.952, 4.986, 7.380),
                leg(195.989, 7.380, 4.909),
                leg(144.319, 4.909, 12.504),
                leg(23.379, 12.504, 9.073),
            ],
            ..Default::default()
        })
        .id;
    let end = StationRef::new(line, 5);
    let mut side = |shots: Vec<ShotData>| {
        let id = p
            .add_section(SectionData {
                shots,
                ..Default::default()
            })
            .id;
        p.merge_stations(end, StationRef::new(id, 0)).unwrap();
        StationRef::new(id, 0)
    };
    let first = side(vec![leg(150.895, 9.073, 8.289), leg(35.917, 8.289, 6.731)]);
    let second = side(vec![
        leg(161.595, 9.073, 12.904),
        leg(113.914, 12.904, 16.607),
    ]);
    (p, StationRef::new(line, 0), [first, second])
}

#[test]
fn case_791_a_smaller_first_stage_no_longer_hands_the_route_to_the_second() {
    // #576 RV8c-2-D5, the W9-GAS sweep's worst set-aside case. TwoStage under the conservative cap,
    // the endpoint back at the entrance, both drops pinned at the end of the line (stage 1 on one
    // side passage's first station, stage 2 on the other's - the same place, 0:5). Stage 1 holds
    // more than the route to the pin, so stage 2 is dropped there full and its gas stranded:
    // 1302 L, and the dive turns at 0:2, short of the pins.
    //
    // Lowering stage 1's fill from 130.61 to 54.05 bar empties it before the pin. Breathed from
    // that empty point, stage 2 was credited the rest of the way to the pin and the budget went UP
    // to 1805 L - the turn moved on to 0:3 on less gas. Starting stage 2 at the pin, it stays full
    // and stranded, and the budget falls by exactly what the pin-free plan loses.
    let (project, origin, [first_side, second_side]) = case_791_cave();
    let diver = Diver::new(20.0, None).unwrap();
    let mut cfg = GasConfig {
        default_reserve: ReservePreset::TwoStage,
        conservative_tank_gas: true,
        ..GasConfig::default()
    };
    cfg.reserve_profile.stage_reserve_bar = 1.936;
    cfg.normalize();
    let cylinder = |volume: f64, rated: f64, fill: f64, role: CylRole| {
        Cylinder::new(volume, rated, fill, TankMaterial::Steel, role, None).unwrap()
    };
    let rig = |stage_1_fill: f64| {
        [
            cylinder(15.696, 300.0, 114.360, CylRole::BackGas),
            cylinder(15.986, 207.0, stage_1_fill, CylRole::Stage),
            cylinder(13.002, 232.0, 205.065, CylRole::Stage),
        ]
    };
    let pins = [Some(second_side), Some(first_side)];
    let plan = |stage_1_fill: f64, pins: &[Option<StationRef>]| {
        project.compute_gas_reach_field_with_overrides(
            Some(&origin),
            Some(&origin),
            &[],
            &[],
            &diver,
            &rig(stage_1_fill),
            &cfg,
            pins,
        )
    };
    let full = plan(130.61, &pins);
    let lowered = plan(54.05, &pins);
    let (free_full, free_lowered) = (plan(130.61, &[]), plan(54.05, &[]));
    let show = |label: &str, f: &GasReachField| {
        println!(
            "CASE-791 {label}: budget {:.2} L, turn {:?}, drop bars {:?}, over {:?}",
            f.budget_litres,
            f.final_turn_ref.map(|s| (s.section_id, s.station_index)),
            f.stage_drop_bars
                .iter()
                .map(|b| (b * 100.0).round() / 100.0)
                .collect::<Vec<_>>(),
            f.stage_drop_over_reserve
        );
    };
    show("stage 1 at 130.61 bar", &full);
    show("stage 1 at 54.05 bar", &lowered);
    assert!(
        lowered.stage_drop_bars[0] < 1e-6,
        "the lowered stage 1 must run dry before its pin ({:.2} bar)",
        lowered.stage_drop_bars[0]
    );
    for (f, what) in [(&full, "130.61"), (&lowered, "54.05")] {
        assert!(
            (f.stage_drop_bars[1] - 205.065).abs() < 1e-6,
            "stage 1 at {what} bar: stage 2 breathed before the shared pin ({:.2} bar left)",
            f.stage_drop_bars[1]
        );
    }
    assert!(
        lowered.budget_litres < full.budget_litres,
        "less stage gas raised the budget: {:.2} -> {:.2} L",
        full.budget_litres,
        lowered.budget_litres
    );
    let free_loss = free_full.budget_litres - free_lowered.budget_litres;
    assert!(
        ((full.budget_litres - lowered.budget_litres) - free_loss).abs() < 1e-6,
        "the pinned plan loses {:.2} L, the plan without pins {free_loss:.2} L",
        full.budget_litres - lowered.budget_litres
    );
    assert!(
        reach_within(&lowered, &full).is_none(),
        "less gas painted a station"
    );
    let (before, after) = (turn_gas(&full).unwrap(), turn_gas(&lowered).unwrap());
    assert!(
        after <= before + 1e-9,
        "the turn moved later: {before:.2} -> {after:.2} L"
    );
}
