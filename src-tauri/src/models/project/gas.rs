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

use crate::config::{GasConfig, ReservePreset};
use crate::models::{Coordinates, StationKey, StationRef};

use super::Project;
pub use model::{CylRole, Cylinder, Diver, GasReachField, PlanMode, TankMaterial, Team};
use physics::edge_gas;

impl Project {
    /// Single-diver open-circuit reachability field (PRD §4/§5.1, the Phase-1 headline).
    ///
    /// Seeds a gas-weighted Dijkstra from `origin` (or the zero datums when `None`) over the
    /// survey graph, weighting each shot by the **in-leg** gas it costs
    /// (`edge_gas(rmv·survey_mult, in_speed, length, avg_depth)`), then marks every station
    /// whose one-way gas-to-reach is within the **turn budget** — `reserve_fraction × usable
    /// open-circuit gas` (strict-thirds default; the diver holds the rest for the exit). The
    /// turn frontier is the reachable stations bordering an unreachable one.
    ///
    /// Contract: `gas_config` is assumed normalized (`GasConfig::normalize` — finite/positive
    /// speeds); a non-positive in-speed defensively yields an all-unreachable field rather
    /// than dividing by zero.
    pub(crate) fn compute_gas_reach_field(
        &self,
        origin: Option<&StationRef>,
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
        let gas_in = if n == 0
            || roots.is_empty()
            || in_speed <= 0.0
            || !in_speed.is_finite()
            || in_rmv <= 0.0
            || !in_rmv.is_finite()
        {
            vec![f64::INFINITY; n]
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
            Self::dijkstra(&adj, &roots)
        };

        let usable = usable_oc_gas(cylinders, gas_config.conservative_tank_gas);
        let budget_litres = usable * reserve_fraction(gas_config.default_reserve);

        let reachable: Vec<bool> = gas_in
            .iter()
            .map(|&g| g.is_finite() && g <= budget_litres)
            .collect();

        let mut max_reachable_gas = 0.0_f64;
        let gas_to_reach: Vec<Option<f64>> = gas_in
            .iter()
            .zip(&reachable)
            .map(|(&g, &ok)| {
                if g.is_finite() {
                    if ok && g > max_reachable_gas {
                        max_reachable_gas = g;
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

        GasReachField {
            station_refs,
            gas_to_reach,
            reachable,
            turn_frontier,
            max_reachable_gas,
            budget_litres,
        }
    }
}

/// Reserve turn-fraction for the preset (PRD §5.1): turn when this fraction of usable gas is
/// consumed on the way in. All-thirds = ⅓; the pushy presets use their back-gas turn fraction
/// (¼ / ⅙) — the full per-stage drop/recalc is Phase 2.
///
/// ⚠ Phase-1 interim: applying ¼/⅙ to TOTAL (back + stage) usable makes OneStage/TwoStage turn
/// EARLIER than AllThirds (a NEARER frontier) — conservative (safe, §6), but the OPPOSITE of
/// their "push farther" intent. Do **not** surface these as "pushier" in the UI until the
/// per-stage drop + total-thirds netting (PRD §5.1/§5.2) lands in Phase 2.
fn reserve_fraction(preset: ReservePreset) -> f64 {
    match preset {
        ReservePreset::AllThirds => 1.0 / 3.0,
        ReservePreset::OneStage => 1.0 / 4.0,
        ReservePreset::TwoStage => 1.0 / 6.0,
    }
}

/// Total usable **open-circuit** breathing gas (litres) across the diver's back-gas + stage
/// cylinders. Dil-out / bailout / deco roles are excluded (CCR / deco, not OC penetration gas
/// — §5.3/§5.5). `conservative` applies the "call-it-an-80" derate — the rated capacity when a
/// tank is overfilled (`min(fill, rated)`), the safe community convention (§5.3); otherwise the
/// actual fill (ideal gas; the real-gas Z correction is deferred).
fn usable_oc_gas(cylinders: &[Cylinder], conservative: bool) -> f64 {
    cylinders
        .iter()
        .filter(|c| matches!(c.role, CylRole::BackGas | CylRole::Stage))
        .map(|c| {
            let pressure = if conservative {
                c.fill_bar.min(c.rated_pressure_bar)
            } else {
                c.fill_bar
            };
            pressure * c.water_volume_l
        })
        .sum()
}
