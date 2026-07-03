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
        // Disabled tanks (#245) are excluded from EVERY gas computation — budget, gauges, stage
        // drops. Filter once here so no downstream helper has to know about `enabled`; rig (vec)
        // order is preserved, so "stage 1/2" still means the first/second enabled Stage cylinder.
        // The ORIGINAL `cylinders` (all rows, order intact) is kept only for the per-row
        // `cylinder_usable_bars` display column, which zeroes disabled rows itself.
        let active: Vec<Cylinder> = cylinders.iter().filter(|c| c.enabled).cloned().collect();
        let active = active.as_slice();

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
            active,
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

        // The strategy actually applied (a stage-short staged request falls back to All-thirds;
        // Free and All-thirds never fall back). Drives the drops AND the gauges so they agree.
        let conservative = gas_config.conservative_tank_gas;
        let effective = effective_preset(active, gas_config.default_reserve);

        // Per-stage drop gauges + cumulative IN-gas thresholds. Staged (Half-Minus) presets read
        // them from the reserve rules; Free reads the diver's per-stage usable directly; All-thirds
        // has no stage drops. `thresholds` places the drop markers along the route below.
        let (stage_drop_bars, thresholds) = match effective {
            ReservePreset::Free => free_stage_drops(active, conservative),
            _ => {
                let bars = stage_drop_pressures(
                    active,
                    effective,
                    gas_config.reserve_profile.stage_reserve_bar,
                    conservative,
                );
                let thresholds = stage_drop_thresholds(
                    active,
                    gas_config.default_reserve,
                    &gas_config.reserve_profile,
                    conservative,
                );
                (bars, thresholds)
            }
        };

        // Planned route to the target (for the highlight + final turn) — populated for ANY strategy
        // when something is reachable. Per-stage drop points are placed on it only where a threshold
        // exists (empty for All-thirds / a fell-back staged rig / a Free rig with no stage usable).
        let (route_refs, stage_drop_refs, final_turn_ref) =
            staged_route(route_target, &pred, &gas_in, &station_refs, &thresholds);
        let route = self.route_legs(&route_refs);

        // Physical route metrics from the route's measured coordinates: the one-way swum line length
        // (a 3-D slope distance summed over real shot legs only — see `is_swim_leg`), the deepest
        // point, and the distance-weighted average depth. This is the *swum* distance, NOT the
        // on-screen highlight length (a 2-D plan-view projection, and closure-adjusted in Plan) —
        // the two intentionally differ. `route_swim` excludes zero-distance merge/closure ties so a
        // loop closure's misclosure gap (never swum) doesn't inflate the distance or skew the depth.
        let route_pts: Vec<Coordinates> = route_refs
            .iter()
            .filter_map(|r| station_index.get(r).map(|&i| coords[i]))
            .collect();
        let route_swim: Vec<bool> = route_refs
            .windows(2)
            .map(|w| is_swim_leg(&w[0], &w[1]))
            .collect();
        // route_pts (one coord per ref) and route_swim (one flag per leg) must stay aligned, or
        // route_metrics would apply a leg's flag to the wrong segment. The filter_map above can only
        // drop a ref absent from station_index — impossible today (route_refs come from station_refs,
        // which are station_index's keys) — so assert it loudly rather than silently mis-weighting if
        // a future graph change ever introduces a ref that isn't in the index.
        debug_assert_eq!(
            route_pts.len(),
            route_refs.len(),
            "route_pts dropped a route ref — the swim mask would misalign"
        );
        let (route_line_length_m, route_max_depth_m, route_avg_depth_m) =
            route_metrics(&route_pts, &route_swim);
        // Per-stage drop DISTANCE (metres, swum from origin), aligned with `stage_drop_refs`, for the
        // Plan readout — same swum-distance basis as `route_line_length_m`.
        let stage_drop_distances_m =
            stage_drop_distances(&route_refs, &route_pts, &route_swim, &stage_drop_refs);

        // Back-gas turn gauge — computed here so the UI never re-derives the budget math; honours the
        // conservative cap + effective strategy. Free averages the diver's per-tank turn directly.
        let margin = gas_config.reserve_profile.all_thirds_safety_margin_bar;
        let backgas_turn_bar = match effective {
            ReservePreset::Free => free_backgas_turn(active, conservative),
            ReservePreset::AllThirds => all_thirds_backgas_turn(active, margin, conservative),
            _ => backgas_turn_pressure(active, backgas_fraction(effective), conservative),
        };

        // Per-row "usable gas" column (#245) — over the ORIGINAL cylinders (all rows), so disabled
        // and non-budget rows read 0 and the frontend maps it 1:1 to the table by index.
        let cylinder_usable_bars = cylinder_usable_bars(
            cylinders,
            effective,
            gas_config.reserve_profile.stage_reserve_bar,
            margin,
            conservative,
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
            stage_drop_distances_m,
            cylinder_usable_bars,
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
                let is_jump = is_swim_leg(&from, &to)
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
/// diver's likely drop point). A threshold past the target — the cave is shorter than the staged
/// gas, so the stage isn't fully breathed before turning — clamps its drop to the turnaround (you
/// carry/drop it there), so EVERY threshold yields exactly one drop and `stage_drop_refs` stays
/// aligned 1:1 with the per-stage gauges. Returns `(route_refs, stage_drop_refs, final_turn_ref)`;
/// all empty/None when there is no reachable target.
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
    // at/after a threshold is the drop point. A threshold beyond the target's reach clamps to the
    // target (the turnaround), so every stage gets a drop and the gauges stay aligned.
    let stage_drop_refs: Vec<StationRef> = thresholds
        .iter()
        .map(|&t| {
            chain
                .iter()
                .find(|&&i| gas_in[i] >= t)
                .map_or(station_refs[target], |&i| station_refs[i])
        })
        .collect();
    (route_refs, stage_drop_refs, Some(station_refs[target]))
}

/// Swum distance (metres) from the route origin to each stage-drop station, aligned with
/// `stage_drop_refs`. Walks the ordered route accumulating 3-D segment lengths over swum legs only
/// (ties excluded, exactly like `route_metrics`), then reads the cumulative distance at each drop
/// station's position on the route. A drop not on the route (shouldn't happen — drops come from the
/// route chain) reads 0. Backend-computed so the Plan readout never re-derives it.
fn stage_drop_distances(
    route_refs: &[StationRef],
    pts: &[Coordinates],
    swim: &[bool],
    drops: &[StationRef],
) -> Vec<f64> {
    let mut cum = vec![0.0_f64; pts.len()];
    for i in 1..pts.len() {
        let seg = if swim.get(i - 1).copied().unwrap_or(true) {
            let (a, b) = (pts[i - 1], pts[i]);
            ((b.x - a.x).powi(2) + (b.y - a.y).powi(2) + (b.z - a.z).powi(2)).sqrt()
        } else {
            0.0
        };
        cum[i] = cum[i - 1] + seg;
    }
    drops
        .iter()
        .map(|d| {
            route_refs
                .iter()
                .position(|r| r == d)
                .and_then(|j| cum.get(j).copied())
                .unwrap_or(0.0)
        })
        .collect()
}

/// A route leg is a real **swum** leg — a shot (including a reference/jump shot the diver swims) —
/// iff it joins two adjacent stations within one section. A station merge / loop-closure tie is a
/// zero-distance graph edge between non-adjacent or cross-section stations whose endpoints are the
/// *same* surveyed point; the measured-coord gap there (a closure's misclosure) was never swum, so
/// it must not count toward route distance or depth.
fn is_swim_leg(a: &StationRef, b: &StationRef) -> bool {
    a.section_id == b.section_id && a.station_index.abs_diff(b.station_index) == 1
}

/// Physical metrics of the planned route from its ordered station coordinates and a per-leg swim
/// mask (`swim[i]` = the leg `pts[i]→pts[i+1]` is a real swum shot, not a tie): the one-way swum
/// line length (sum of 3-D segment lengths over swum legs only), the deepest point, and the
/// distance-weighted average depth over the swum legs. `z` is depth in metres (positive below
/// surface, `station.rs`), so the deepest point is `max z` over *all* route stations. Max-depth is
/// deliberately over all stations, not just swum legs: both ends of a tie are real surveyed stations
/// the route passes through, so the deeper one is a genuine depth the diver reaches — only the
/// un-swum tie *distance* (and its depth-weight) is excluded, from length/avg. An empty route →
/// `(0.0, None, None)`; a single station (or all-tie route) → zero length with the depth at the
/// first point. A missing mask entry conservatively counts the leg.
fn route_metrics(pts: &[Coordinates], swim: &[bool]) -> (f64, Option<f64>, Option<f64>) {
    let Some(first) = pts.first() else {
        return (0.0, None, None);
    };
    let max_depth = pts.iter().map(|c| c.z).fold(f64::NEG_INFINITY, f64::max);
    let mut length = 0.0;
    let mut depth_len_sum = 0.0;
    for (i, w) in pts.windows(2).enumerate() {
        // Skip zero-distance ties (merges / loop closures): their measured-coord gap was not swum.
        if !swim.get(i).copied().unwrap_or(true) {
            continue;
        }
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
        // Free needs no stages — it budgets the diver's per-cylinder usable gas directly, so
        // like All-thirds it never falls back (required_stages 0 ⇒ effective_preset keeps it).
        ReservePreset::AllThirds | ReservePreset::Free => 0,
        ReservePreset::OneStage => 1,
        ReservePreset::TwoStage => 2,
    }
}

/// Conservative-capped fill (bar) — the pressure basis every strategy computes drops/usable from.
/// The "call-it-an-80" cap (§5.3) treats an overfill as its rated capacity; precise mode uses the
/// real fill.
fn cyl_basis(c: &Cylinder, conservative: bool) -> f64 {
    if conservative {
        c.fill_bar.min(c.rated_pressure_bar)
    } else {
        c.fill_bar
    }
}

/// The diver's Free usable allowance (bar), sanitized: a non-finite input (NaN / ±inf — serde_json
/// can't carry those today, but a future non-JSON deserializer might, and NaN would slip a bare
/// `u <= 0.0` skip since NaN comparisons are false) becomes 0, then clamps to `[0, basis]` (the
/// conservative-capped fill the budget credits). One helper so every Free path — budget, turn,
/// drops, column — treats a stray value identically, and none can propagate NaN into a gauge.
fn free_usable_bar(c: &Cylinder, conservative: bool) -> f64 {
    if !c.usable_gas_bar.is_finite() {
        return 0.0;
    }
    c.usable_gas_bar.clamp(0.0, cyl_basis(c, conservative))
}

/// Free-strategy IN gas for one cylinder (litres): the Z-derated span from full down to the diver's
/// chosen turn pressure `fill − usable_gas_bar`. The usable bar is clamped to `[0, basis]` so a
/// stray/over-large input can never credit more than the tank holds (the unsafe direction, §6).
/// Mirrors `stage_in_gas`'s basis-scale deliverable arithmetic.
fn free_in_gas(c: &Cylinder, conservative: bool) -> f64 {
    let basis = cyl_basis(c, conservative);
    let u = free_usable_bar(c, conservative);
    let full = deliverable_gas(basis, c.water_volume_l, c.rated_pressure_bar, conservative);
    let held = deliverable_gas(
        basis - u,
        c.water_volume_l,
        c.rated_pressure_bar,
        conservative,
    );
    (full - held).max(0.0)
}

/// Free-strategy penetration budget (litres): the sum of each enabled budget-role (back-gas /
/// stage) cylinder's user-chosen IN gas. Dil-out / bailout / deco are excluded as elsewhere.
fn free_budget(cylinders: &[Cylinder], conservative: bool) -> f64 {
    cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::BackGas | CylRole::Stage))
        .map(|c| free_in_gas(c, conservative))
        .sum()
}

/// Gas (litres) the All-thirds safety margin (#245) holds back from one cylinder: the deliverable in
/// the top `margin_bar` of the conservative-capped tank. 0 when the margin is 0.
fn all_thirds_margin_litres(c: &Cylinder, margin_bar: f64, conservative: bool) -> f64 {
    if margin_bar <= 0.0 {
        return 0.0;
    }
    let basis = cyl_basis(c, conservative);
    let full = deliverable_gas(basis, c.water_volume_l, c.rated_pressure_bar, conservative);
    let held = deliverable_gas(
        (basis - margin_bar).max(0.0),
        c.water_volume_l,
        c.rated_pressure_bar,
        conservative,
    );
    (full - held).max(0.0)
}

/// One budget-role cylinder's All-thirds usable IN gas (litres): ⅓ of its deliverable gas, less the
/// safety margin, clamped ≥ 0. At `margin_bar == 0` this is exactly ⅓ · deliverable (plain thirds),
/// so the default path is unchanged.
fn all_thirds_usable_litres(c: &Cylinder, margin_bar: f64, conservative: bool) -> f64 {
    let deliverable = deliverable_gas(
        c.fill_bar,
        c.water_volume_l,
        c.rated_pressure_bar,
        conservative,
    );
    (deliverable / 3.0 - all_thirds_margin_litres(c, margin_bar, conservative)).max(0.0)
}

/// All-thirds back-gas turn gauge (bar) with the safety margin folded in: the volume-weighted start
/// gauge less the back-gas usable IN gas expressed as a common-gauge drop. At `margin_bar == 0` it
/// equals `backgas_turn_pressure(.., 1/3, ..)`.
fn all_thirds_backgas_turn(
    cylinders: &[Cylinder],
    margin_bar: f64,
    conservative: bool,
) -> Option<f64> {
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
        .map(|c| all_thirds_usable_litres(c, margin_bar, conservative))
        .sum();
    Some((avg_start - usable / sum_wv).max(0.0))
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
        // Free has no single back-gas fraction (the diver sets each tank's usable directly), so
        // its turn gauge is computed separately and never calls this; ⅓ is a harmless placeholder.
        ReservePreset::AllThirds | ReservePreset::Free => 1.0 / 3.0,
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

/// Per-cylinder penetration allowance (bar), one entry per INPUT cylinder (original order) for the
/// "usable gas" table column (#245). Disabled tanks and non-budget roles are `0.0`. Computed as
/// `fill − turn/drop` so the column can never drift from the gauges/budget: a back-gas tank shows
/// its strategy fraction of usable (`frac · deliverable ÷ water-vol`, matching `backgas_turn`), a
/// counted stage its Half-Minus IN half (`(basis − reserve)/2`, matching its drop), an uncounted
/// stage `0`. Under **Free** it echoes the diver's own clamped input. `enabled_stage_i` counts only
/// enabled Stage cylinders, so "counted" tracks the same first-N-enabled-stages the budget uses.
fn cylinder_usable_bars(
    cylinders: &[Cylinder],
    effective: ReservePreset,
    reserve_bar: f64,
    margin_bar: f64,
    conservative: bool,
) -> Vec<f64> {
    let needed = required_stages(effective);
    let mut enabled_stage_i = 0usize;
    cylinders
        .iter()
        .map(|c| {
            if !c.enabled {
                return 0.0;
            }
            let deliverable_bar = deliverable_gas(
                c.fill_bar,
                c.water_volume_l,
                c.rated_pressure_bar,
                conservative,
            ) / c.water_volume_l;
            let basis = cyl_basis(c, conservative);
            match effective {
                ReservePreset::Free => match c.role {
                    // The same sanitized `[0, basis]` clamp the budget uses, so the displayed usable
                    // bar equals what `free_in_gas` credits (the "single source of truth" guarantee)
                    // even on an overfilled tank under conservative, and a NaN input reads 0.
                    CylRole::BackGas | CylRole::Stage => free_usable_bar(c, conservative),
                    _ => 0.0,
                },
                // Thirds counts back gas AND stages at ⅓ (both are in `usable_oc_gas`), less the
                // safety margin — expressed as bar so the column equals what the budget credits.
                ReservePreset::AllThirds => match c.role {
                    CylRole::BackGas | CylRole::Stage => {
                        all_thirds_usable_litres(c, margin_bar, conservative) / c.water_volume_l
                    }
                    _ => 0.0,
                },
                ReservePreset::OneStage | ReservePreset::TwoStage => match c.role {
                    CylRole::BackGas => backgas_fraction(effective) * deliverable_bar,
                    CylRole::Stage => {
                        let counted = enabled_stage_i < needed;
                        enabled_stage_i += 1;
                        if counted {
                            (0.5 * (basis - reserve_bar)).max(0.0)
                        } else {
                            0.0
                        }
                    }
                    _ => 0.0,
                },
            }
        })
        .collect()
}

/// Free-strategy back-gas turn gauge (bar): the volume-weighted mean of each enabled back-gas
/// tank's chosen turn pressure `fill − usable_gas_bar`. The usable bar is clamped to `[0, basis]`
/// (the conservative-capped fill, same ceiling the budget uses) so the gauge can't credit more than
/// the plan does. `None` when the rig carries no back gas — matching [`backgas_turn_pressure`].
fn free_backgas_turn(cylinders: &[Cylinder], conservative: bool) -> Option<f64> {
    let back: Vec<&Cylinder> = cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::BackGas))
        .collect();
    let sum_wv: f64 = back.iter().map(|c| c.water_volume_l).sum();
    if sum_wv <= 0.0 {
        return None;
    }
    let turn = back
        .iter()
        .map(|c| {
            let u = free_usable_bar(c, conservative);
            (c.fill_bar - u) * c.water_volume_l
        })
        .sum::<f64>()
        / sum_wv;
    Some(turn.max(0.0))
}

/// Free-strategy per-stage drop gauges: `(drop_bars, cumulative_thresholds)`. Each enabled stage
/// with a positive usable allowance is dropped where that gas is spent — drop pressure `fill −
/// usable`, cumulative IN-gas threshold (litres). Stages with no allowance yield no drop.
fn free_stage_drops(cylinders: &[Cylinder], conservative: bool) -> (Vec<f64>, Vec<f64>) {
    let mut bars = Vec::new();
    let mut thresholds = Vec::new();
    let mut acc = 0.0;
    for c in cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::Stage))
    {
        // Clamp to `basis` (same ceiling as the budget's `free_in_gas`) so the drop gauge agrees
        // with the credited gas on an overfilled tank under conservative; a NaN input sanitizes to
        // 0 so it takes the skip below rather than pushing a bogus drop.
        let u = free_usable_bar(c, conservative);
        if u <= 0.0 {
            continue;
        }
        acc += free_in_gas(c, conservative);
        bars.push((c.fill_bar - u).max(0.0));
        thresholds.push(acc);
    }
    (bars, thresholds)
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
    // All-thirds = ⅓ of each budget-role cylinder's deliverable, less the safety margin (0 by
    // default, so this is plain thirds). The margin is All-thirds-only — a fell-back staged rig is
    // now effectively All-thirds, so it inherits the margin too.
    let all_thirds = || {
        cylinders
            .iter()
            .filter(|c| matches!(c.role, CylRole::BackGas | CylRole::Stage))
            .map(|c| {
                all_thirds_usable_litres(c, profile.all_thirds_safety_margin_bar, conservative)
            })
            .sum::<f64>()
    };

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
        ReservePreset::Free => free_budget(cylinders, conservative),
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
/// (the "call-it-an-80" community convention, §5.3). Retained as a tested building block — the
/// All-thirds budget now sums per-cylinder `all_thirds_usable_litres` (to fold in the safety margin),
/// so this is exercised only by tests.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "tested building block; budget now sums per-cylinder"
    )
)]
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
