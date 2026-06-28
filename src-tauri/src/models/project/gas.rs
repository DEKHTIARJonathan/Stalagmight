//! Gas & route-planning engine (issue #38).
//!
//! Phase 0 shipped the pure foundations ([`physics`], [`model`]). Phase 1 adds the
//! gas-weighted reachability compute here as an `impl Project` method, reaching the
//! `pub(super)` graph primitives (`build_survey_graph_weighted` / `dijkstra` /
//! `zero_datum_roots`) exactly as the sibling `distance` module does. The engine consumes
//! the **instant measured** coords (`compute_station_coordinates`) — reachability is
//! coordinate-independent, so it never triggers the slow closure-adjusted solve. The engine is
//! called by the `commands::gas` IPC command via `AppState::gas_reach_field`.

mod model;
mod physics;

#[cfg(test)]
mod tests;

use crate::config::{GasConfig, ReservePreset, ReserveProfile};
use crate::models::{Coordinates, StationKey, StationRef};

use super::Project;
pub use model::{CylRole, Cylinder, Diver, GasReachField, PlanMode, RouteLeg, TankMaterial, Team};
use physics::{deliverable_gas, edge_gas};

impl Project {
    /// Single-diver open-circuit reachability field (PRD §4/§5.1, the Phase-1 headline).
    ///
    /// Seeds a gas-weighted Dijkstra from `origin` (or the zero datums when `None`) over the
    /// survey graph, weighting each shot by the **in-leg** gas it costs
    /// (`edge_gas(rmv·survey_mult, in_speed, length, avg_depth)`), then marks every station whose
    /// one-way gas-to-reach is within the **turn budget** ([`penetration_budget`] for the active
    /// strategy; the diver holds the rest for the exit). The turn frontier is the reachable
    /// stations bordering an unreachable one. Under a staged (Half-Minus) strategy it also walks
    /// the route to `endpoint` (else the deepest in-budget station) to place per-stage drop points,
    /// and computes the readout gauges; All-thirds leaves those empty.
    ///
    /// Contract: `gas_config` is assumed normalized (`GasConfig::normalize` — finite/positive
    /// speeds); a non-positive in-speed defensively yields an all-unreachable field rather
    /// than dividing by zero.
    pub(crate) fn compute_gas_reach_field(
        &self,
        origin: Option<&StationRef>,
        endpoint: Option<&StationRef>,
        diver: &Diver,
        cylinders: &[Cylinder],
        gas_config: &GasConfig,
    ) -> GasReachField {
        let stations = self.compute_station_coordinates();
        let n = stations.len();
        let station_refs: Vec<StationRef> = stations.iter().map(|s| s.station_ref).collect();
        let station_index = Self::station_index_map(&stations);
        let coords: Vec<Coordinates> = stations.iter().map(|s| s.coordinates).collect();

        let roots: Vec<usize> = match origin {
            Some(r) => {
                let key: StationKey = (*r).into();
                self.resolve_key(&key)
                    .and_then(|sr| station_index.get(&sr).copied())
                    .into_iter()
                    .collect()
            }
            None => self.zero_datum_roots(&station_index),
        };

        // In-leg cost: survey RMV bump on the slower survey-in speed (falls back to the swim
        // speed when no survey speed is set — symmetric). Depth from the measured coords.
        let in_rmv = diver.rmv_l_per_min * gas_config.survey_rmv_multiplier;
        let in_speed = gas_config
            .survey_speed_m_per_min
            .unwrap_or(gas_config.swim_speed_m_per_min);

        let coords_ref = &coords;
        // Defensive: a non-positive / non-finite in-speed OR in-rmv (e.g. an un-normalized
        // 0 survey_rmv_multiplier) would zero every edge cost and make the whole cave falsely
        // reachable — the unsafe over-stating direction (§6) — so bail to all-unreachable.
        // `pred` is the shortest-path predecessor tree (for the staged drop route below).
        let (gas_in, pred) = if n == 0
            || roots.is_empty()
            || in_speed <= 0.0
            || !in_speed.is_finite()
            || in_rmv <= 0.0
            || !in_rmv.is_finite()
        {
            (vec![f64::INFINITY; n], vec![usize::MAX; n])
        } else {
            let adj = self.build_survey_graph_weighted(n, &station_index, |shot, fi, ti| {
                // Jump/reference legs burn gas at a higher RMV: tying in a jump is extra
                // task-loading. `normalize` keeps the multiplier ≥1.0, so this can only ever
                // *raise* a jump's gas — never under-state it (the safe direction, §6).
                let edge_rmv = if shot.is_reference {
                    in_rmv * gas_config.jump_rmv_multiplier
                } else {
                    in_rmv
                };
                edge_gas(
                    edge_rmv,
                    in_speed,
                    shot.length.max(0.0),
                    coords_ref[fi].z,
                    coords_ref[ti].z,
                )
            });
            Self::dijkstra_with_preds(&adj, &roots)
        };

        let budget_litres = penetration_budget(
            cylinders,
            gas_config.default_reserve,
            &gas_config.reserve_profile,
            gas_config.conservative_tank_gas,
        );
        // A pathological-but-valid cylinder (huge finite fill × volume) can overflow deliverable_gas
        // to a non-finite budget; treat that as all-unreachable (0.0) rather than leaking NaN/Inf to
        // the gauge readout. The staged paths already `.max(0.0)`-guard; this mirrors them.
        let budget_litres = if budget_litres.is_finite() {
            budget_litres
        } else {
            0.0
        };

        let reachable: Vec<bool> = gas_in
            .iter()
            .map(|&g| g.is_finite() && g <= budget_litres)
            .collect();

        // `max_reachable_gas` (reported) is the largest in-budget gas-to-reach, floored at 0.
        // `deepest` (the route fallback target) tracks the same arg-max but seeds at -∞ so a
        // degenerate all-at-0 reachable set (only a root in budget) still yields a target.
        let mut max_reachable_gas = 0.0_f64;
        let mut deepest: Option<usize> = None;
        let mut deepest_gas = f64::NEG_INFINITY;
        let gas_to_reach: Vec<Option<f64>> = gas_in
            .iter()
            .zip(&reachable)
            .enumerate()
            .map(|(i, (&g, &ok))| {
                if g.is_finite() {
                    if ok {
                        if g > max_reachable_gas {
                            max_reachable_gas = g;
                        }
                        if g > deepest_gas {
                            deepest_gas = g;
                            deepest = Some(i);
                        }
                    }
                    Some(g)
                } else {
                    None
                }
            })
            .collect();

        // Turn frontier: reachable stations with at least one neighbour that is NOT reachable
        // (out of budget or in another component). Topology only — the unweighted graph's
        // adjacency is enough; the gas weights are irrelevant to "who borders whom".
        let adj_topo = self.build_survey_graph(n, &station_index, None);
        let turn_frontier: Vec<StationRef> = (0..n)
            .filter(|&u| reachable[u] && adj_topo[u].iter().any(|&(v, _)| !reachable[v]))
            .map(|u| station_refs[u])
            .collect();

        // Route target: the user-selected endpoint when it resolves to an in-budget station, else
        // the deepest in-budget station. (An out-of-budget endpoint falls back to deepest — the
        // chosen lead isn't reachable on this gas; the UI still marks the pick.)
        let route_target = endpoint
            .and_then(|r| {
                let key: StationKey = (*r).into();
                self.resolve_key(&key)
                    .and_then(|sr| station_index.get(&sr).copied())
            })
            .filter(|&i| reachable[i])
            .or(deepest);

        // Planned route to the target (for the highlight + final turn) — populated for ANY strategy
        // when something is reachable. Per-stage drop points are placed on it only for a staged
        // strategy (`thresholds` is empty for All-thirds / a fell-back staged rig → no drops).
        let thresholds = stage_drop_thresholds(
            cylinders,
            gas_config.default_reserve,
            &gas_config.reserve_profile,
            gas_config.conservative_tank_gas,
        );
        let (route_refs, stage_drop_refs, final_turn_ref) =
            staged_route(route_target, &pred, &gas_in, &station_refs, &thresholds);
        let route = self.route_legs(&route_refs);

        // Physical route metrics (line length + depths) from the ordered route's measured coords —
        // the same coords the highlight is drawn from, so the reported distance matches the line.
        let route_pts: Vec<Coordinates> = route_refs
            .iter()
            .filter_map(|r| station_index.get(r).map(|&i| coords[i]))
            .collect();
        let (route_line_length_m, route_max_depth_m, route_avg_depth_m) = route_metrics(&route_pts);

        // Readout gauges — computed here so the UI never re-derives the budget math. Both honour the
        // conservative cap + normalized reserve + stage-count fallback (the effective strategy).
        let effective = effective_preset(cylinders, gas_config.default_reserve);
        let backgas_turn_bar = backgas_turn_pressure(
            cylinders,
            backgas_fraction(effective),
            gas_config.conservative_tank_gas,
        );
        let stage_drop_bars = stage_drop_pressures(
            cylinders,
            effective,
            gas_config.reserve_profile.stage_reserve_bar,
            gas_config.conservative_tank_gas,
        );

        GasReachField {
            station_refs,
            gas_to_reach,
            reachable,
            turn_frontier,
            max_reachable_gas,
            budget_litres,
            route,
            stage_drop_refs,
            final_turn_ref,
            backgas_turn_bar,
            stage_drop_bars,
            route_line_length_m,
            route_max_depth_m,
            route_avg_depth_m,
        }
    }

    /// Build the route-highlight legs from the ordered route stations, flagging each leg whose
    /// connecting shot is a reference/jump (a normally-hidden swum shortcut) so the UI can dash it.
    /// A cross-section tie (a merge / loop closure — coincident points) is not a jump.
    fn route_legs(&self, route_refs: &[StationRef]) -> Vec<RouteLeg> {
        route_refs
            .windows(2)
            .map(|w| {
                let (from, to) = (w[0], w[1]);
                let is_jump = from.section_id == to.section_id
                    && from.station_index.abs_diff(to.station_index) == 1
                    && self
                        .sections
                        .iter()
                        .find(|s| s.id == from.section_id)
                        .and_then(|s| {
                            s.shots
                                .get(from.station_index.min(to.station_index) as usize)
                        })
                        .is_some_and(|shot| shot.is_reference);
                RouteLeg { from, to, is_jump }
            })
            .collect()
    }
}

/// Reconstruct the route to `target` and place the per-stage drop points on it. Walks the
/// predecessor tree from the route target (the user-selected endpoint, else the deepest in-budget
/// station) back to its root, reverses to give the route origin→target, then for each cumulative
/// stage threshold (litres) finds the first route station whose gas-to-reach reaches it (the
/// diver's likely drop point). A threshold past the target — cave shorter than the staged gas —
/// simply yields no drop. Returns `(route_refs, stage_drop_refs, final_turn_ref)`; all empty/None
/// when there is no reachable target.
fn staged_route(
    target: Option<usize>,
    pred: &[usize],
    gas_in: &[f64],
    station_refs: &[StationRef],
    thresholds: &[f64],
) -> (Vec<StationRef>, Vec<StationRef>, Option<StationRef>) {
    let Some(target) = target else {
        return (Vec::new(), Vec::new(), None);
    };
    let mut chain = vec![target];
    let mut cur = target;
    while pred[cur] != usize::MAX {
        cur = pred[cur];
        chain.push(cur);
        // Defensive: pred is a tree (no cycles), but cap the walk at the node count so a corrupt
        // map can never hang the compute.
        if chain.len() > pred.len() {
            break;
        }
    }
    chain.reverse();

    let route_refs: Vec<StationRef> = chain.iter().map(|&i| station_refs[i]).collect();
    // gas-to-reach increases monotonically root→target along the tree path, so the first station
    // at/after a threshold is the drop point.
    let stage_drop_refs: Vec<StationRef> = thresholds
        .iter()
        .filter_map(|&t| {
            chain
                .iter()
                .find(|&&i| gas_in[i] >= t)
                .map(|&i| station_refs[i])
        })
        .collect();
    (route_refs, stage_drop_refs, Some(station_refs[target]))
}

/// Physical metrics of the planned route from its ordered station coordinates: the swum line length
/// (sum of 3-D segment lengths between consecutive route stations — the one-way penetration
/// distance, matching the drawn route), the deepest point, and the distance-weighted average depth.
/// `z` is depth in metres (positive below surface, `station.rs`), so the deepest point is `max z`.
/// An empty route → `(0.0, None, None)`; a single station → zero length with that point's depth.
fn route_metrics(pts: &[Coordinates]) -> (f64, Option<f64>, Option<f64>) {
    let Some(first) = pts.first() else {
        return (0.0, None, None);
    };
    let max_depth = pts.iter().map(|c| c.z).fold(f64::NEG_INFINITY, f64::max);
    let mut length = 0.0;
    let mut depth_len_sum = 0.0;
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let seg = ((b.x - a.x).powi(2) + (b.y - a.y).powi(2) + (b.z - a.z).powi(2)).sqrt();
        length += seg;
        // Weight each segment's mean depth by its length → the depth-along-distance average.
        depth_len_sum += seg * 0.5 * (a.z + b.z);
    }
    let avg_depth = if length > 0.0 {
        depth_len_sum / length
    } else {
        first.z
    };
    (length, Some(max_depth), Some(avg_depth))
}

/// Number of `Stage` cylinders a preset requires in the rig. The pushy presets are valid
/// only when the diver actually carries that many stages: the engine falls back to All-thirds
/// otherwise (never invents stage gas — the safe direction, §6) and the UI greys the preset
/// (the §5.1 "advanced gate").
fn required_stages(preset: ReservePreset) -> usize {
    match preset {
        ReservePreset::AllThirds => 0,
        ReservePreset::OneStage => 1,
        ReservePreset::TwoStage => 2,
    }
}

/// The strategy actually applied: the requested preset when the rig carries enough `Stage`
/// cylinders, else All-thirds (the fallback `penetration_budget` already takes). The gauges key off
/// this so a stage-short staged request shows All-thirds numbers, matching the budget + map.
fn effective_preset(cylinders: &[Cylinder], preset: ReservePreset) -> ReservePreset {
    let stages = cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::Stage))
        .count();
    if stages < required_stages(preset) {
        ReservePreset::AllThirds
    } else {
        preset
    }
}

/// Fraction of usable back gas spent on the way in, per strategy (PRD §5.1): thirds / quarters /
/// sixths as the stages carry more of the penetration.
fn backgas_fraction(preset: ReservePreset) -> f64 {
    match preset {
        ReservePreset::AllThirds => 1.0 / 3.0,
        ReservePreset::OneStage => 0.25,
        ReservePreset::TwoStage => 1.0 / 6.0,
    }
}

/// Back-gas turn pressure gauge (bar): the volume-weighted average back-gas start gauge minus the
/// `frac` of usable back gas expressed as a common-gauge drop (`frac · Σdeliverable ÷ Σwater-vol`).
/// `None` when the rig carries no back gas. Z-derated (and conservative-capped) via
/// [`deliverable_gas`], so it tracks the reachable overlay's budget rather than the raw fill.
fn backgas_turn_pressure(cylinders: &[Cylinder], frac: f64, conservative: bool) -> Option<f64> {
    let back: Vec<&Cylinder> = cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::BackGas))
        .collect();
    let sum_wv: f64 = back.iter().map(|c| c.water_volume_l).sum();
    if sum_wv <= 0.0 {
        return None;
    }
    let avg_start = back
        .iter()
        .map(|c| c.fill_bar * c.water_volume_l)
        .sum::<f64>()
        / sum_wv;
    let usable: f64 = back
        .iter()
        .map(|c| {
            deliverable_gas(
                c.fill_bar,
                c.water_volume_l,
                c.rated_pressure_bar,
                conservative,
            )
        })
        .sum();
    Some((avg_start - frac * usable / sum_wv).max(0.0))
}

/// Per-stage Half-Minus drop pressure gauge (bar), one per counted stage of `preset` (in rig order).
/// `drop = (basis + reserve)/2` with `basis` the conservative-capped fill — mirrors `stage_in_gas`
/// so the gauge matches where the engine drops the stage. Empty when `preset` counts no stages
/// (All-thirds) or the rig is stage-short (the caller passes the effective preset).
fn stage_drop_pressures(
    cylinders: &[Cylinder],
    preset: ReservePreset,
    reserve_bar: f64,
    conservative: bool,
) -> Vec<f64> {
    let needed = required_stages(preset);
    if needed == 0 {
        return Vec::new();
    }
    let stages: Vec<&Cylinder> = cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::Stage))
        .collect();
    if stages.len() < needed {
        return Vec::new();
    }
    stages[..needed]
        .iter()
        .map(|c| {
            let basis = if conservative {
                c.fill_bar.min(c.rated_pressure_bar)
            } else {
                c.fill_bar
            };
            (0.5 * (basis + reserve_bar)).clamp(0.0, basis)
        })
        .collect()
}

/// One-way IN penetration budget (litres), PRD §5.1 — the gas a diver may consume on the way
/// in before turning. The strategies:
/// - **All-thirds**: ⅓ of every back-gas + stage cylinder's deliverable gas (= ⅓ of total).
/// - **Half Minus, 1-stage**: ¼ of back gas + stage 1's IN gas.
/// - **Half Minus, 2-stage**: ⅙ of back gas + that IN gas for the first two stages.
///
/// Under **Half Minus** a stage is breathed from full down to its drop pressure `(fill + reserve)/2`,
/// contributing `(fill − reserve)/2` of IN gas; the other half is breathed back down to `reserve` on
/// the picked-up exit. With the stages carrying the penetration the diver dips less of the back gas
/// (¼ / ⅙ instead of ⅓) without breaking thirds. If the rig lacks the required stages it falls back
/// to the All-thirds budget (never invents stage gas — the safe direction, §6). Z-derated throughout
/// (back-gas AND stage term) via [`deliverable_gas`]. The reserve is the editable
/// [`ReserveProfile::stage_reserve_bar`] (default 30 bar).
///
/// "Stage 1"/"the first two stages" = the first `Stage`-role cylinder(s) by rig (vec) order —
/// v1 has no per-stage drop-order field. With ≥3 stages on `TwoStage` only the first two count
/// (the ≥3-stage case is deferred — PRD §5.1); excluding the extra only shrinks the budget (safe).
fn penetration_budget(
    cylinders: &[Cylinder],
    preset: ReservePreset,
    profile: &ReserveProfile,
    conservative: bool,
) -> f64 {
    let all_thirds = || usable_oc_gas(cylinders, conservative) / 3.0;

    let stages: Vec<&Cylinder> = cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::Stage))
        .collect();
    if stages.len() < required_stages(preset) {
        return all_thirds();
    }

    let back_gas = |frac: f64| -> f64 {
        cylinders
            .iter()
            .filter(|c| matches!(c.role, CylRole::BackGas))
            .map(|c| {
                deliverable_gas(
                    c.fill_bar,
                    c.water_volume_l,
                    c.rated_pressure_bar,
                    conservative,
                )
            })
            .sum::<f64>()
            * frac
    };
    let stage_in = |c: &Cylinder| stage_in_gas(c, profile.stage_reserve_bar, conservative);

    match preset {
        ReservePreset::AllThirds => all_thirds(),
        ReservePreset::OneStage => back_gas(0.25) + stage_in(stages[0]),
        ReservePreset::TwoStage => {
            back_gas(1.0 / 6.0) + stages[..2].iter().map(|&c| stage_in(c)).sum::<f64>()
        }
    }
}

/// Gas breathed off one stage on the way IN under the **Half-Minus** strategy (litres): from
/// `full` down to its drop pressure `(fill + reserve)/2`, i.e. `(fill − reserve)/2` of pressure.
/// The drop keys off the SAME (conservative-capped) basis as `full`, so an overfilled stage's
/// start and drop pressures stay on one consistent scale. The other half is breathed back down to
/// `reserve` on the picked-up exit; only this IN half is penetration gas. Z-derated via
/// [`deliverable_gas`].
fn stage_in_gas(c: &Cylinder, reserve_bar: f64, conservative: bool) -> f64 {
    let basis = if conservative {
        c.fill_bar.min(c.rated_pressure_bar)
    } else {
        c.fill_bar
    };
    let full = deliverable_gas(basis, c.water_volume_l, c.rated_pressure_bar, conservative);
    let drop = (0.5 * (basis + reserve_bar)).clamp(0.0, basis);
    let held = deliverable_gas(drop, c.water_volume_l, c.rated_pressure_bar, conservative);
    (full - held).max(0.0)
}

/// Cumulative stage IN-gas thresholds (litres) along the penetration route for a **staged**
/// (Half-Minus) strategy: element `k` = the total IN gas consumed by the time stage `k` is
/// dropped (Σ of `stage_in_gas` over stages `0..=k`, rig/vec order). The diver drops stage `k`
/// where cumulative gas-to-reach first reaches `thresholds[k]`. Empty for All-thirds and for any
/// rig that lacks the required stages (falls back to All-thirds — no staged drops).
fn stage_drop_thresholds(
    cylinders: &[Cylinder],
    preset: ReservePreset,
    profile: &ReserveProfile,
    conservative: bool,
) -> Vec<f64> {
    let needed = required_stages(preset);
    if needed == 0 {
        return Vec::new();
    }
    let stages: Vec<&Cylinder> = cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::Stage))
        .collect();
    if stages.len() < needed {
        return Vec::new();
    }
    let mut acc = 0.0;
    stages[..needed]
        .iter()
        .map(|&c| {
            acc += stage_in_gas(c, profile.stage_reserve_bar, conservative);
            acc
        })
        .collect()
}

/// Total usable **open-circuit** breathing gas (litres) across the diver's back-gas + stage
/// cylinders. Dil-out / bailout / deco roles are excluded (CCR / deco, not OC penetration gas
/// — §5.3/§5.5). Every cylinder is Z-derated via [`deliverable_gas`] (real-gas correction is
/// always applied); `conservative` additionally caps an overfilled tank to its rated capacity
/// (the "call-it-an-80" community convention, §5.3).
fn usable_oc_gas(cylinders: &[Cylinder], conservative: bool) -> f64 {
    cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::BackGas | CylRole::Stage))
        .map(|c| {
            deliverable_gas(
                c.fill_bar,
                c.water_volume_l,
                c.rated_pressure_bar,
                conservative,
            )
        })
        .sum()
}
