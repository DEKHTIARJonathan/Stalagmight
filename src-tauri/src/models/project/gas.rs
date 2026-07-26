//! Gas & route-planning engine (issue #38).
//!
//! Phase 0 shipped the pure foundations ([`physics`], [`model`]). Phase 1 adds the
//! gas-weighted reachability compute here as an `impl Project` method, reaching the
//! `pub(super)` graph primitives (`build_survey_graph_weighted` / `dijkstra` /
//! `zero_datum_roots`) exactly as the sibling `distance` module does. The engine consumes
//! the **instant measured** coords (`compute_station_coordinates`) - reachability is
//! coordinate-independent, so it never triggers the slow closure-adjusted solve. The engine is
//! called by the `commands::gas` IPC command via `AppState::gas_reach_field`.

mod model;
mod physics;

#[cfg(test)]
mod tests;

use crate::config::{GasConfig, ReservePreset, ReserveProfile};
use crate::models::{Coordinates, ShotKind, StationKey, StationRef};

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
    /// Contract: `gas_config` is assumed normalized (`GasConfig::normalize` - finite/positive
    /// speeds); a non-positive in-speed defensively yields an all-unreachable field rather
    /// than dividing by zero.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "no-override convenience entry; prod calls _with_overrides, tests call this"
        )
    )]
    pub(crate) fn compute_gas_reach_field(
        &self,
        origin: Option<&StationRef>,
        endpoint: Option<&StationRef>,
        diver: &Diver,
        cylinders: &[Cylinder],
        gas_config: &GasConfig,
    ) -> GasReachField {
        self.compute_gas_reach_field_with_overrides(
            origin,
            endpoint,
            &[],
            diver,
            cylinders,
            gas_config,
            &[],
        )
    }

    /// As [`Self::compute_gas_reach_field`], but with per-stage **drop overrides** (#246): the diver
    /// drags a stage's ▼ drop marker to a route station, and `stage_drop_overrides[k]` pins stage
    /// `k`'s drop there (aligned 1:1 with `stage_drop_refs` / `stage_drop_bars`; `None` = keep the
    /// strategy default; over-long / unresolvable refs fall through to the default).
    ///
    /// A pinned drop redefines how much of that stage is breathed IN: the litres consumed to reach
    /// the pinned station (`gas_in[S] - cumulative-at-prior-drop`), hard-clamped to `[0, tank-empty]`.
    /// The penetration budget becomes `base + Σ(actual - safe)`, so a drop dragged **shallower**
    /// strands surplus stage gas (budget shrinks → reach shortens) and one dragged **deeper** breathes
    /// into reserve (budget grows → reach extends, flagged `stage_drop_over_reserve`). Non-overridden
    /// downstream drops keep their safe pressure but shift position as the cumulative shifts; the
    /// back-gas turn pressure is independent of the stage drops and is unchanged. The reach math stays
    /// exact-litres (from the graph); only the moved drop's readout pressure is inverted from the Z
    /// curve. With an empty `stage_drop_overrides` this is byte-identical to the no-override field.
    ///
    /// `waypoints` (#298) are ordered intermediate route points the dive MUST visit, in order,
    /// between the origin and the endpoint. They re-base the whole field: `gas_to_reach` becomes the
    /// gas to reach a station AFTER flying the whole way-point chain, so the reachable overlay, the
    /// turn frontier and the stage drops all cost the mandated detour instead of quietly planning
    /// the shortest origin-to-endpoint line. With an empty `waypoints` this is byte-identical to the
    /// single-Dijkstra field it replaces.
    pub(crate) fn compute_gas_reach_field_with_overrides(
        &self,
        origin: Option<&StationRef>,
        endpoint: Option<&StationRef>,
        waypoints: &[StationRef],
        diver: &Diver,
        cylinders: &[Cylinder],
        gas_config: &GasConfig,
        stage_drop_overrides: &[Option<StationRef>],
    ) -> GasReachField {
        // Disabled tanks (#245) are excluded from EVERY gas computation - budget, gauges, stage
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
                    .map_or_else(
                        // A set-but-unresolvable origin (e.g. its station was deleted while a
                        // dive plan stayed loaded across a Survey edit, #244) falls back to the
                        // entrance rather than an all-unreachable field - matching the `None`
                        // (entrance) case and the endpoint's own deepest-in-budget fallback.
                        || self.zero_datum_roots(&station_index),
                        |i| vec![i],
                    )
            }
            None => self.zero_datum_roots(&station_index),
        };

        // In-leg cost: survey RMV bump on the slower survey-in speed (falls back to the swim
        // speed when no survey speed is set - symmetric). Depth from the measured coords.
        let in_rmv = diver.rmv_l_per_min * gas_config.survey_rmv_multiplier;
        let in_speed = gas_config
            .survey_speed_m_per_min
            .unwrap_or(gas_config.swim_speed_m_per_min);

        let coords_ref = &coords;
        // Defensive: a non-positive / non-finite in-speed OR in-rmv (e.g. an un-normalized
        // 0 survey_rmv_multiplier) would zero every edge cost and make the whole cave falsely
        // reachable - the unsafe over-stating direction (§6) - so bail to all-unreachable.
        //
        // `adj` is kept alongside the walk: its edge SET is identical to the plain topology
        // graph `build_survey_graph` would return (same shots/merges/closures, just different
        // edge weights), so it doubles as the turn-frontier's adjacency below - no second,
        // purely-topological graph build. In the degenerate branch `gas_in` is all-INFINITY, so
        // `reachable` is all-false and the turn-frontier's `reachable[u] && adj[u]...` filter
        // short-circuits on `reachable[u]` without ever reading `adj` - an empty adjacency list
        // is provably equivalent, so build one instead of paying for a real (unused) graph build.
        let degenerate = n == 0
            || roots.is_empty()
            || in_speed <= 0.0
            || !in_speed.is_finite()
            || in_rmv <= 0.0
            || !in_rmv.is_finite();
        let adj = if degenerate {
            vec![Vec::new(); n]
        } else {
            self.build_survey_graph_weighted(n, &station_index, |shot, fi, ti| {
                // A reference tie is not swimmable (#27 q7), so it must not
                // carry a dive route at all. Give it an INFINITE edge cost
                // rather than skipping the edge: `along_line_between` keys a
                // parallel shot-edge map on this function's edge-emission
                // order, so the edge set must stay identical. An infinite
                // weight never relaxes in Dijkstra, so the leg is unusable
                // while the ordering contract holds. Excluding it can only
                // shrink reach, which is the safe direction (§6).
                if !shot.kind.is_swum() && !gas_config.include_reference_legs {
                    return f64::INFINITY;
                }
                // Virtual legs burn gas at a higher RMV: tying in a jump is
                // extra task-loading. `normalize` keeps the multiplier ≥1.0, so
                // this can only ever *raise* the gas - never under-state it (the
                // safe direction, §6).
                //
                // Keyed on `is_virtual`, not `== Jump`. A Reference only reaches
                // this line when `include_reference_legs` put it back in the
                // graph, and that opt-in is documented as restoring the
                // pre-#27 inclusive behaviour - where every virtual leg carried
                // the multiplier. Charging it base RMV instead made an opted-in
                // route cost LESS gas than the same route did before the split,
                // which overstates the reachable frontier: the unsafe direction.
                let edge_rmv = if shot.kind.is_virtual() {
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
            })
        };

        // Ordered way points (#298), resolved to node indices. An entry that no longer resolves
        // (its station was deleted under a plan that stayed loaded across a Survey edit) or that is
        // graph-disconnected STALLS the walk: the mandated detour cannot be flown, so the field goes
        // all-unreachable rather than quietly planning a route that skips it (the unsafe direction,
        // §6). Unlike the origin and the endpoint - which are hints and degrade to the entrance /
        // deepest point - a way point is a constraint, so dropping one silently would change the
        // plan under the diver.
        let resolved_waypoints: Vec<Option<usize>> = waypoints
            .iter()
            .map(|r| {
                let key: StationKey = (*r).into();
                self.resolve_key(&key)
                    .and_then(|sr| station_index.get(&sr).copied())
            })
            .collect();
        let walk = waypoint_walk(&adj, &roots, &resolved_waypoints, degenerate);
        let gas_in = &walk.gas_in;

        // The strategy actually applied (a stage-short staged request falls back to All-thirds; Free
        // and All-thirds never fall back). Drives the drops AND the gauges so they agree.
        let conservative = gas_config.conservative_tank_gas;
        let effective = effective_preset(active, gas_config.default_reserve);

        // Per-stage drop plans (safe IN gas, physical cap, default drop pressure) for the effective
        // strategy - the building blocks the override recompute (#246) reads. Empty for All-thirds
        // and any fell-back staged rig, so those strategies have no drops to override.
        let plans = stage_drop_plans(
            active,
            effective,
            gas_config.reserve_profile.stage_reserve_bar,
            conservative,
        );
        // Resolve each per-drop override (a StationRef the diver dragged the marker to) to a station
        // index; an unresolvable / off-graph ref falls through to the strategy default in `apply`.
        // Only the first `plans.len()` entries can ever affect a drop, so cap the (frontend-sized)
        // input there - a stray-long list can't cost unbounded `resolve_key` scans.
        let resolved_overrides: Vec<Option<usize>> = stage_drop_overrides
            .iter()
            .take(plans.len())
            .map(|o| {
                o.and_then(|r| {
                    let key: StationKey = r.into();
                    self.resolve_key(&key)
                        .and_then(|sr| station_index.get(&sr).copied())
                })
            })
            .collect();

        // Base penetration budget (litres), then fold in the override deltas: the cumulative stage
        // thresholds, per-drop readout bars, over-reserve flags, and the budget change all come out of
        // one walk over the plans. `apply` returns the STRATEGY defaults untouched for an empty
        // override list, so this stays byte-identical to the no-override field.
        let base_budget = penetration_budget(
            active,
            gas_config.default_reserve,
            &gas_config.reserve_profile,
            conservative,
        );
        // The route target is a plain input lookup, independent of the budget.
        let endpoint_idx = endpoint.and_then(|r| {
            let key: StationKey = (*r).into();
            self.resolve_key(&key)
                .and_then(|sr| station_index.get(&sr).copied())
        });
        // The un-overridden route: what the STRATEGY alone would fly, on the base budget. Its drop
        // stations are the "defaults" a release-in-place must reproduce, so `apply` can recognise a
        // pin to one and stay a true no-op (#246). Deriving them from a route rather than from the
        // predecessor tree is what keeps that check exact once way points can make the route
        // backtrack over a station it already visited (#298).
        let default_thresholds = cumulative(plans.iter().map(|p| p.safe_in_litres));
        let base_view = budget_view(&walk, endpoint_idx, base_budget);
        let default_drop_nodes = drop_nodes(&base_view, &default_thresholds);

        let (thresholds, stage_drop_bars, stage_drop_over_reserve, budget_delta) =
            apply_stage_drop_overrides(
                &plans,
                &resolved_overrides,
                gas_in,
                &default_drop_nodes,
                conservative,
            );
        // A pathological-but-valid cylinder (huge finite fill × volume) can overflow deliverable_gas
        // to a non-finite budget; treat that as all-unreachable (0.0) rather than leaking NaN/Inf to
        // the gauge readout. The staged paths already `.max(0.0)`-guard; this mirrors them. The
        // override budget is always `≥ back-gas ≥ 0` (every contribution is `≥ 0`), so the `.max(0.0)`
        // is only a finite-guard floor - a shallow drag can never drive the budget negative.
        let budget_litres = base_budget + budget_delta;
        let budget_litres = if budget_litres.is_finite() {
            budget_litres.max(0.0)
        } else {
            0.0
        };

        // Everything the final budget decides: the reachable mask, the reported gas-to-reach, and
        // the planned route origin -> way points -> target (populated for ANY strategy when
        // something is reachable). Per-stage drop points are placed on that route only where a
        // threshold exists (none for All-thirds / a fell-back staged rig / a Free rig with no stage
        // usable).
        let view = budget_view(&walk, endpoint_idx, budget_litres);
        let BudgetView {
            reachable,
            gas_to_reach,
            max_reachable_gas,
            target: route_target,
            route: route_nodes,
            route_gas,
        } = view;

        // Turn frontier: reachable stations with at least one neighbour that is NOT reachable
        // (out of budget or in another component). Topology only - `adj`'s edge SET (built
        // above) is enough; the gas weights on it are irrelevant to "who borders whom".
        let turn_frontier: Vec<StationRef> = (0..n)
            .filter(|&u| reachable[u] && adj[u].iter().any(|&(v, _)| !reachable[v]))
            .map(|u| station_refs[u])
            .collect();

        let route_refs: Vec<StationRef> = route_nodes.iter().map(|&i| station_refs[i]).collect();
        let final_turn_ref = route_target.map(|i| station_refs[i]);
        // Drop indices along the route (not refs): a way-point route can revisit a station, so an
        // index is the only unambiguous handle. No target means no plan, hence no drops.
        let drop_indices: Vec<usize> = if route_target.is_some() {
            place_stage_drops(&route_gas, &thresholds)
        } else {
            Vec::new()
        };
        let stage_drop_refs: Vec<StationRef> = drop_indices
            .iter()
            .filter_map(|&j| route_refs.get(j).copied())
            .collect();
        let route = self.route_legs(&route_refs);

        // Physical route metrics from the route's measured coordinates: the one-way swum line length
        // (a 3-D slope distance summed over real shot legs only - see `is_swim_leg`), the deepest
        // point, and the distance-weighted average depth. This is the *swum* distance, NOT the
        // on-screen highlight length (a 2-D plan-view projection, and closure-adjusted in Plan) -
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
        // drop a ref absent from station_index - impossible today (route_refs come from station_refs,
        // which are station_index's keys) - so assert it loudly rather than silently mis-weighting if
        // a future graph change ever introduces a ref that isn't in the index.
        debug_assert_eq!(
            route_pts.len(),
            route_refs.len(),
            "route_pts dropped a route ref - the swim mask would misalign"
        );
        let (route_line_length_m, route_max_depth_m, route_avg_depth_m) =
            route_metrics(&route_pts, &route_swim);
        // Per-stage drop DISTANCE (metres, swum from origin), aligned with `stage_drop_refs`, for the
        // Plan readout - same swum-distance basis as `route_line_length_m`. Read at the drop's route
        // INDEX, so a route that doubles back over a station reports the distance of the pass the
        // drop actually sits on.
        let cum_route_distance = cumulative_distances(&route_pts, &route_swim);
        let stage_drop_distances_m: Vec<f64> = drop_indices
            .iter()
            .map(|&j| cum_route_distance.get(j).copied().unwrap_or(0.0))
            .collect();

        // Back-gas turn gauge - computed here so the UI never re-derives the budget math; honours the
        // conservative cap + effective strategy. Free averages the diver's per-tank turn directly.
        let margin = gas_config.reserve_profile.all_thirds_safety_margin_bar;
        let backgas_turn_bar = match effective {
            ReservePreset::Free => free_backgas_turn(active, conservative),
            ReservePreset::AllThirds => all_thirds_backgas_turn(active, margin, conservative),
            _ => backgas_turn_pressure(active, backgas_fraction(effective), conservative),
        };

        // Per-row "usable gas" column (#245) - over the ORIGINAL cylinders (all rows), so disabled
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
            stage_drop_over_reserve,
            stage_drop_distances_m,
            cylinder_usable_bars,
            route_line_length_m,
            route_max_depth_m,
            route_avg_depth_m,
            waypoint_gas_litres: walk.waypoint_gas,
        }
    }

    /// Build the route-highlight legs from the ordered route stations, flagging each leg whose
    /// connecting shot is a reference/jump (a normally-hidden swum shortcut) so the UI can dash it.
    /// A cross-section tie (a merge / loop closure - coincident points) is not a jump.
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
                        .is_some_and(|shot| shot.kind == ShotKind::Jump);
                RouteLeg { from, to, is_jump }
            })
            .collect()
    }
}

/// Reconstruct the shortest path from a predecessor tree's root to `target`, root first. `pred` is
/// acyclic by construction; the node-count cap is a defensive stop so a corrupt tree can never hang
/// the compute.
fn path_to(pred: &[usize], target: usize) -> Vec<usize> {
    let mut chain = vec![target];
    let mut cur = target;
    while pred.get(cur).copied().unwrap_or(usize::MAX) != usize::MAX {
        cur = pred[cur];
        chain.push(cur);
        if chain.len() > pred.len() {
            break;
        }
    }
    chain.reverse();
    chain
}

/// Result of walking the ordered way points (#298) - the gas field the rest of the engine reads,
/// plus the part of the route the way points have already fixed.
struct WaypointWalk {
    /// Gas-to-reach every station AFTER visiting every way point in order: the last leg's Dijkstra
    /// distance offset by the gas already spent getting to the last way point. All-infinite when the
    /// chain stalls, so nothing reads as reachable on a route that cannot be flown.
    gas_in: Vec<f64>,
    /// Predecessor tree of the LAST leg - rooted at the final way point, or at the origin roots when
    /// there are none. Walk it back from the route target to finish the route.
    pred: Vec<usize>,
    /// Route stations the way-point chain has already committed (origin → … → last way point) with
    /// their cumulative gas. Empty when there are no way points, so the route is then purely the
    /// origin→target path and the field is byte-identical to the single-Dijkstra one.
    chain: Vec<usize>,
    chain_gas: Vec<f64>,
    /// Cumulative gas at each way point, in order; `None` from the first one that stalls.
    waypoint_gas: Vec<Option<f64>>,
}

/// Walk the ordered way points: one Dijkstra per leg, each seeded at the previous way point, with
/// the legs' costs accumulated. `waypoints` carries `None` for an entry that no longer resolves to a
/// station. A `None` entry, or one the graph cannot reach, **stalls** the walk - every later way
/// point reports `None` and the whole field goes unreachable, because a plan that silently skipped a
/// mandated point would over-state reach (the unsafe direction, §6).
fn waypoint_walk(
    adj: &[Vec<(usize, f64)>],
    roots: &[usize],
    waypoints: &[Option<usize>],
    degenerate: bool,
) -> WaypointWalk {
    let n = adj.len();
    if degenerate {
        return WaypointWalk {
            gas_in: vec![f64::INFINITY; n],
            pred: vec![usize::MAX; n],
            chain: Vec::new(),
            chain_gas: Vec::new(),
            waypoint_gas: vec![None; waypoints.len()],
        };
    }
    let mut leg = Project::dijkstra_with_preds(adj, roots);
    let mut cum = 0.0_f64;
    let mut chain: Vec<usize> = Vec::new();
    let mut chain_gas: Vec<f64> = Vec::new();
    let mut waypoint_gas: Vec<Option<f64>> = Vec::with_capacity(waypoints.len());
    let mut stalled = false;
    for w in waypoints {
        let reached = (!stalled)
            .then_some(*w)
            .flatten()
            .filter(|&i| leg.0.get(i).is_some_and(|d| d.is_finite()));
        let Some(w) = reached else {
            stalled = true;
            waypoint_gas.push(None);
            continue;
        };
        // Commit this leg's path. Its first node is the previous leg's way point, which already
        // closes the chain, so skip it rather than emitting a zero-length duplicate.
        let skip = usize::from(!chain.is_empty());
        for &node in path_to(&leg.1, w).iter().skip(skip) {
            chain.push(node);
            chain_gas.push(cum + leg.0.get(node).copied().unwrap_or(0.0));
        }
        cum += leg.0.get(w).copied().unwrap_or(0.0);
        waypoint_gas.push(Some(cum));
        leg = Project::dijkstra_with_preds(adj, &[w]);
    }
    let (dist, pred) = leg;
    let gas_in = if stalled {
        vec![f64::INFINITY; n]
    } else {
        dist.iter().map(|d| cum + *d).collect()
    };
    WaypointWalk {
        gas_in,
        pred,
        chain,
        chain_gas,
        waypoint_gas,
    }
}

/// Everything the penetration budget decides: which stations are in reach, the reported
/// gas-to-reach, the largest in-budget value, and the planned route (with its cumulative gas)
/// origin → way points → target.
struct BudgetView {
    reachable: Vec<bool>,
    gas_to_reach: Vec<Option<f64>>,
    max_reachable_gas: f64,
    target: Option<usize>,
    route: Vec<usize>,
    route_gas: Vec<f64>,
}

/// Apply a budget to the walked field. The route target is the user-selected endpoint when it is in
/// budget, else the deepest in-budget station (an out-of-budget endpoint isn't reachable on this
/// gas; the UI still marks the pick). Computed twice per field - once on the base budget to locate
/// the strategy's own drop stations, once on the final budget - which is two O(n) passes plus one
/// path walk, negligible next to the Dijkstras.
fn budget_view(walk: &WaypointWalk, endpoint: Option<usize>, budget_litres: f64) -> BudgetView {
    let reachable: Vec<bool> = walk
        .gas_in
        .iter()
        .map(|&g| g.is_finite() && g <= budget_litres)
        .collect();

    // `max_reachable_gas` (reported) is the largest in-budget gas-to-reach, floored at 0.
    // `deepest` (the route fallback target) tracks the same arg-max but seeds at -∞ so a
    // degenerate all-at-0 reachable set (only a root in budget) still yields a target.
    let mut max_reachable_gas = 0.0_f64;
    let mut deepest: Option<usize> = None;
    let mut deepest_gas = f64::NEG_INFINITY;
    let gas_to_reach: Vec<Option<f64>> = walk
        .gas_in
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

    let target = endpoint
        .filter(|&i| reachable.get(i).copied().unwrap_or(false))
        .or(deepest);
    // The committed way-point chain, then the last leg's path to the target. That path starts at
    // the final way point, which the chain already ends on, so it is skipped from the tail. With no
    // way points the chain is empty and the route is exactly the origin→target path.
    let mut route = walk.chain.clone();
    let mut route_gas = walk.chain_gas.clone();
    if let Some(t) = target {
        let skip = usize::from(!route.is_empty());
        for &node in path_to(&walk.pred, t).iter().skip(skip) {
            route.push(node);
            route_gas.push(walk.gas_in.get(node).copied().unwrap_or(0.0));
        }
    }
    BudgetView {
        reachable,
        gas_to_reach,
        max_reachable_gas,
        target,
        route,
        route_gas,
    }
}

/// Running sums of `values`, i.e. `[v0, v0+v1, …]`.
fn cumulative(values: impl Iterator<Item = f64>) -> Vec<f64> {
    let mut acc = 0.0_f64;
    values
        .map(|v| {
            acc += v;
            acc
        })
        .collect()
}

/// Place each stage's drop on the route: the first station whose cumulative route gas reaches the
/// stage's threshold. Route gas increases monotonically along the route, so that station is the
/// point where the stage runs out. A threshold past the turnaround - the cave is shorter than the
/// staged gas, so the stage isn't fully breathed before turning - clamps to the last route station
/// (you carry/drop it there), so EVERY threshold yields exactly one drop and the per-stage gauges
/// stay aligned 1:1. Returns route INDICES, not refs: a way-point route can double back over a
/// station, and only an index says which pass the drop is on.
fn place_stage_drops(route_gas: &[f64], thresholds: &[f64]) -> Vec<usize> {
    let Some(last) = route_gas.len().checked_sub(1) else {
        return Vec::new();
    };
    thresholds
        .iter()
        .map(|&t| route_gas.iter().position(|&g| g >= t).unwrap_or(last))
        .collect()
}

/// The station nodes a strategy's un-overridden drops land on, for the pin-to-default no-op check.
fn drop_nodes(view: &BudgetView, thresholds: &[f64]) -> Vec<usize> {
    if view.target.is_none() {
        return Vec::new();
    }
    place_stage_drops(&view.route_gas, thresholds)
        .iter()
        .filter_map(|&j| view.route.get(j).copied())
        .collect()
}

/// Cumulative swum distance (metres) at each route station: 3-D segment lengths accumulated over
/// swum legs only, with zero-distance merge/closure ties excluded exactly as [`route_metrics`] does.
fn cumulative_distances(pts: &[Coordinates], swim: &[bool]) -> Vec<f64> {
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
    cum
}

/// A route leg is a real **swum** leg - a shot (including a reference/jump shot the diver swims) -
/// iff it joins two adjacent stations within one section. A station merge / loop-closure tie is a
/// zero-distance graph edge between non-adjacent or cross-section stations whose endpoints are the
/// *same* surveyed point; the measured-coord gap there (a closure's misclosure) was never swum, so
/// it must not count toward route distance or depth.
fn is_swim_leg(a: &StationRef, b: &StationRef) -> bool {
    a.section_id == b.section_id && a.station_index.abs_diff(b.station_index) == 1
}

/// One stage's drop, as the override recompute (#246) needs it. `safe_in_litres` is the strategy's
/// IN gas off this stage (Half-Minus half / Free usable span); `phys_cap_litres` is its FULL
/// deliverable (breathing it to empty - the hard clamp a deeper drag can't cross); `default_bar` is
/// the un-dragged drop-pressure gauge. The `fill/water/rated/basis` fields let a moved drop invert
/// its litres-consumed back to a pressure on the conservative-capped basis scale.
struct StageDropPlan {
    safe_in_litres: f64,
    phys_cap_litres: f64,
    default_bar: f64,
    water_volume_l: f64,
    rated_pressure_bar: f64,
    basis: f64,
}

/// Per-drop plans for the effective strategy, in stage order, aligned 1:1 with the drops the field
/// exposes. Staged (Half-Minus) counts the first `required_stages` stages; Free takes every enabled
/// stage with a positive usable allowance (skipping the rest, exactly as the drops did before);
/// All-thirds and a fell-back staged rig have none. This is the single producer of the strategy
/// defaults the override walk starts from, so drops/thresholds/bars can never diverge from it.
fn stage_drop_plans(
    cylinders: &[Cylinder],
    effective: ReservePreset,
    reserve_bar: f64,
    conservative: bool,
) -> Vec<StageDropPlan> {
    let stages: Vec<&Cylinder> = cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::Stage))
        .collect();
    let plan_for = |c: &Cylinder, safe_in_litres: f64, default_bar: f64| {
        let basis = cyl_basis(c, conservative);
        StageDropPlan {
            safe_in_litres,
            phys_cap_litres: deliverable_gas(
                basis,
                c.water_volume_l,
                c.rated_pressure_bar,
                conservative,
            ),
            default_bar,
            water_volume_l: c.water_volume_l,
            rated_pressure_bar: c.rated_pressure_bar,
            basis,
        }
    };
    match effective {
        ReservePreset::Free => stages
            .iter()
            .filter_map(|&c| {
                let u = free_usable_bar(c, conservative);
                if u <= 0.0 {
                    return None;
                }
                Some(plan_for(
                    c,
                    free_in_gas(c, conservative),
                    (c.fill_bar - u).max(0.0),
                ))
            })
            .collect(),
        ReservePreset::OneStage | ReservePreset::TwoStage => {
            let needed = required_stages(effective);
            if stages.len() < needed {
                return Vec::new();
            }
            stages[..needed]
                .iter()
                .map(|&c| {
                    let basis = cyl_basis(c, conservative);
                    plan_for(
                        c,
                        stage_in_gas(c, reserve_bar, conservative),
                        (0.5 * (basis + reserve_bar)).clamp(0.0, basis),
                    )
                })
                .collect()
        }
        ReservePreset::AllThirds => Vec::new(),
    }
}

/// A drop dragged over-reserve is one whose actual IN gas exceeds the safe half by more than this
/// (litres) - a slop floor against float noise once we've already excluded the default station.
const OVER_RESERVE_EPS_LITRES: f64 = 1e-6;

/// Fold the per-drop overrides (#246) into the drops, in ONE cumulative walk. Returns
/// `(cumulative_thresholds, drop_bars, over_reserve, budget_delta_litres)`:
/// - `cumulative_thresholds[k]` (litres) is where drop `k` lands on the route (fed to `staged_route`).
/// - `drop_bars[k]` is the readout pressure - the strategy default, or (when overridden) the tank
///   pressure left after breathing the litres consumed to the pinned station, inverted from the Z
///   curve so it matches the gas the reach actually spent.
/// - `over_reserve[k]` is true only for a drag DEEPER than the safe point (breathing into reserve).
/// - `budget_delta_litres` is `Σ(actual - safe)`, added to the base budget to move the reach.
///
/// A pinned station's contribution is `gas_in[S] - effective-cumulative-so-far`, hard-clamped to
/// `[0, phys_cap]` - so dragging past tank-empty snaps the drop back to the empty point, and dragging
/// a drop shallower than the one before it contributes 0 (drops the stage full) rather than going
/// negative. An unresolved / off-graph / non-finite override falls through to the strategy default.
///
/// ⚠ Pin-to-the-default-station is a NO-OP. The default ▼ is rendered at the first route station
/// whose route gas ≥ the stage's threshold, so that station's gas usually OVERSHOOTS the sub-station
/// threshold. Reading the override as `gas_in[station] - eff_cum` there would fabricate an
/// over-reserve plan and extend the reach on a mere jiggle / release-in-place (the unsafe
/// direction). `default_drop_nodes[k]` - stage `k`'s drop station on the UN-overridden route - lets
/// us recognise that station exactly and reproduce the un-dragged default. (It replaces an earlier
/// predecessor-tree heuristic, which could not stay exact once way points let a route double back
/// over a station, #298.)
fn apply_stage_drop_overrides(
    plans: &[StageDropPlan],
    overrides: &[Option<usize>],
    gas_in: &[f64],
    default_drop_nodes: &[usize],
    conservative: bool,
) -> (Vec<f64>, Vec<f64>, Vec<bool>, f64) {
    let mut thresholds = Vec::with_capacity(plans.len());
    let mut bars = Vec::with_capacity(plans.len());
    let mut over = Vec::with_capacity(plans.len());
    let mut eff_cum = 0.0_f64;
    let mut delta = 0.0_f64;
    for (k, p) in plans.iter().enumerate() {
        let pinned = overrides
            .get(k)
            .copied()
            .flatten()
            .filter(|&si| gas_in.get(si).is_some_and(|g| g.is_finite()));
        let (contribution, bar, is_over) = match pinned {
            // Pinned to the stage's OWN default drop station: reproduce the un-dragged default so a
            // jiggle / release-in-place can't fabricate over-reserve or extend the reach.
            Some(si) if default_drop_nodes.get(k) == Some(&si) => {
                (p.safe_in_litres, p.default_bar, false)
            }
            Some(si) => {
                let contribution = (gas_in[si] - eff_cum).clamp(0.0, p.phys_cap_litres);
                (
                    contribution,
                    drop_pressure_for_contribution(p, contribution, conservative),
                    contribution > p.safe_in_litres + OVER_RESERVE_EPS_LITRES,
                )
            }
            None => (p.safe_in_litres, p.default_bar, false),
        };
        delta += contribution - p.safe_in_litres;
        eff_cum += contribution;
        thresholds.push(eff_cum);
        bars.push(bar.max(0.0));
        over.push(is_over);
    }
    (thresholds, bars, over, delta)
}

/// Invert the Z-derated deliverable curve to the tank pressure (bar) left after breathing
/// `contribution` litres off a stage from full (its conservative-capped `basis`). `deliverable_gas`
/// is monotone non-decreasing over `[0, basis]` for every realistic fill (the `p / Z(p)` curve only
/// turns over above ~714 bar - ~2× any real cylinder - where a non-conservative fill could pick a
/// wrong root; that mis-reports only this DISPLAY gauge, never the litres-exact reach). ~50 bisection
/// halvings converge to sub-microbar, and at `contribution == safe` it inverts back to `default_bar`.
fn drop_pressure_for_contribution(p: &StageDropPlan, contribution: f64, conservative: bool) -> f64 {
    let target_held = (p.phys_cap_litres - contribution).max(0.0);
    let (mut lo, mut hi) = (0.0_f64, p.basis.max(0.0));
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        if deliverable_gas(mid, p.water_volume_l, p.rated_pressure_bar, conservative) < target_held
        {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// Physical metrics of the planned route from its ordered station coordinates and a per-leg swim
/// mask (`swim[i]` = the leg `pts[i]→pts[i+1]` is a real swum shot, not a tie): the one-way swum
/// line length (sum of 3-D segment lengths over swum legs only), the deepest point, and the
/// distance-weighted average depth over the swum legs. `z` is depth in metres (positive below
/// surface, `station.rs`), so the deepest point is `max z` over *all* route stations. Max-depth is
/// deliberately over all stations, not just swum legs: both ends of a tie are real surveyed stations
/// the route passes through, so the deeper one is a genuine depth the diver reaches - only the
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
/// otherwise (never invents stage gas - the safe direction, §6) and the UI greys the preset
/// (the §5.1 "advanced gate").
fn required_stages(preset: ReservePreset) -> usize {
    match preset {
        // Free needs no stages - it budgets the diver's per-cylinder usable gas directly, so
        // like All-thirds it never falls back (required_stages 0 ⇒ effective_preset keeps it).
        ReservePreset::AllThirds | ReservePreset::Free => 0,
        ReservePreset::OneStage => 1,
        ReservePreset::TwoStage => 2,
    }
}

/// Conservative-capped fill (bar) - the pressure basis every strategy computes drops/usable from.
/// The "call-it-an-80" cap (§5.3) treats an overfill as its rated capacity; precise mode uses the
/// real fill.
fn cyl_basis(c: &Cylinder, conservative: bool) -> f64 {
    if conservative {
        c.fill_bar.min(c.rated_pressure_bar)
    } else {
        c.fill_bar
    }
}

/// The diver's Free usable allowance (bar), sanitized: a non-finite input (NaN / ±inf - serde_json
/// can't carry those today, but a future non-JSON deserializer might, and NaN would slip a bare
/// `u <= 0.0` skip since NaN comparisons are false) becomes 0, then clamps to `[0, basis]` (the
/// conservative-capped fill the budget credits). One helper so every Free path - budget, turn,
/// drops, column - treats a stray value identically, and none can propagate NaN into a gauge.
fn free_usable_bar(c: &Cylinder, conservative: bool) -> f64 {
    if !c.usable_gas_bar.is_finite() {
        return 0.0;
    }
    c.usable_gas_bar.clamp(0.0, cyl_basis(c, conservative))
}

/// Free-strategy IN gas for one cylinder (litres): the Z-derated span from full down to the diver's
/// chosen turn pressure `fill - usable_gas_bar`. The usable bar is clamped to `[0, basis]` so a
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

/// Per-cylinder penetration allowance (bar), one entry per INPUT cylinder (original order) for the
/// "usable gas" table column (#245). Disabled tanks and non-budget roles are `0.0`. Computed as
/// `fill - turn/drop` so the column can never drift from the gauges/budget: a back-gas tank shows
/// its strategy fraction of usable (`frac · deliverable ÷ water-vol`, matching `backgas_turn`), a
/// counted stage its Half-Minus IN half (`(basis - reserve)/2`, matching its drop), an uncounted
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
                // safety margin - expressed as bar so the column equals what the budget credits.
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
/// tank's chosen turn pressure `fill - usable_gas_bar`. The usable bar is clamped to `[0, basis]`
/// (the conservative-capped fill, same ceiling the budget uses) so the gauge can't credit more than
/// the plan does. `None` when the rig carries no back gas - matching [`backgas_turn_pressure`].
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

/// One-way IN penetration budget (litres), PRD §5.1 - the gas a diver may consume on the way
/// in before turning. The strategies:
/// - **All-thirds**: ⅓ of every back-gas + stage cylinder's deliverable gas (= ⅓ of total).
/// - **Half Minus, 1-stage**: ¼ of back gas + stage 1's IN gas.
/// - **Half Minus, 2-stage**: ⅙ of back gas + that IN gas for the first two stages.
///
/// Under **Half Minus** a stage is breathed from full down to its drop pressure `(fill + reserve)/2`,
/// contributing `(fill - reserve)/2` of IN gas; the other half is breathed back down to `reserve` on
/// the picked-up exit. With the stages carrying the penetration the diver dips less of the back gas
/// (¼ / ⅙ instead of ⅓) without breaking thirds. If the rig lacks the required stages it falls back
/// to the All-thirds budget (never invents stage gas - the safe direction, §6). Z-derated throughout
/// (back-gas AND stage term) via [`deliverable_gas`]. The reserve is the editable
/// [`ReserveProfile::stage_reserve_bar`] (default 30 bar).
///
/// "Stage 1"/"the first two stages" = the first `Stage`-role cylinder(s) by rig (vec) order -
/// v1 has no per-stage drop-order field. With ≥3 stages on `TwoStage` only the first two count
/// (the ≥3-stage case is deferred - PRD §5.1); excluding the extra only shrinks the budget (safe).
fn penetration_budget(
    cylinders: &[Cylinder],
    preset: ReservePreset,
    profile: &ReserveProfile,
    conservative: bool,
) -> f64 {
    // All-thirds = ⅓ of each budget-role cylinder's deliverable, less the safety margin (0 by
    // default, so this is plain thirds). The margin is All-thirds-only - a fell-back staged rig is
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
/// `full` down to its drop pressure `(fill + reserve)/2`, i.e. `(fill - reserve)/2` of pressure.
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

/// Total usable **open-circuit** breathing gas (litres) across the diver's back-gas + stage
/// cylinders. Dil-out / bailout / deco roles are excluded (CCR / deco, not OC penetration gas
/// - §5.3/§5.5). Every cylinder is Z-derated via [`deliverable_gas`] (real-gas correction is
/// always applied); `conservative` additionally caps an overfilled tank to its rated capacity
/// (the "call-it-an-80" community convention, §5.3). Retained as a tested building block - the
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
