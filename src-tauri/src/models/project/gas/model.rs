//! Gas-planning domain model: divers, cylinders, teams. Canonical SI (L/min, L, bar, m).
//! Constructors guard non-finite / non-positive inputs at the ingest boundary (mirroring
//! `Coordinates::new_checked`), so a NaN RMV or zero cylinder can never poison the gas
//! field downstream. The persisted/per-plan `GasConfig` (units, reserve preset, speeds)
//! lives in `crate::config` - these are the per-dive, ephemeral parts.

// The types/fields are `pub` (re-exported to `models` for IPC + ts-rs), so they are NOT dead;
// but the guarding constructors (`new` / `from_sac` / `gas_volume_l`) are exercised only by
// tests until the Phase-1.3 command uses them for input validation - dead in the lib build
// until then, so the expectation is scoped to the non-test build (matches `models/shot.rs`;
// `#[allow]` is denied crate-wide).
#![cfg_attr(not(test), expect(dead_code))]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::StationRef;

use super::physics::{cylinder_gas_volume, sac_to_rmv};

fn default_true() -> bool {
    true
}

/// Cylinder construction material. Hints role suitability - steel ≈ negative buoyancy →
/// back gas; aluminium ≈ neutral → fine as a stage - but it is guidance, never a hard
/// rule (PRD §5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum TankMaterial {
    Aluminium,
    Steel,
}

/// What a cylinder is carried for. Drives the reserve math (§5.1) and the CCR "dil-out"
/// model (§5.5). `Deco` gas is reserved for a future deco phase and is **never**
/// travel/penetration gas, so it is excluded from the penetration budget (§5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum CylRole {
    BackGas,
    Stage,
    DilOut,
    Bailout,
    Deco,
}

/// Open-circuit vs CCR bailout planning. CCR is not gas-limited on penetration; its
/// constraint is the bailout volume to exit (§5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum PlanMode {
    OpenCircuit,
    CcrBailout,
}

/// A diver identified by RMV - the canonical, persisted gas-rate. SAC is a *constructor*
/// concern only (see [`Diver::from_sac`]); it is never stored, so an inconsistent
/// SAC/reference pair can't linger in the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Diver {
    pub rmv_l_per_min: f64,
    pub label: Option<String>,
}

impl Diver {
    /// Construct from an already-volumetric RMV (L/min). Rejects non-finite / non-positive.
    pub(crate) fn new(rmv_l_per_min: f64, label: Option<String>) -> Result<Self, String> {
        if !rmv_l_per_min.is_finite() || rmv_l_per_min <= 0.0 {
            return Err(format!(
                "RMV must be finite and positive, got {rmv_l_per_min}"
            ));
        }
        Ok(Self {
            rmv_l_per_min,
            label,
        })
    }

    /// Construct from a SAC (bar/min) measured against a reference cylinder's water
    /// volume. The SAC is consumed here and discarded; only the derived RMV is kept.
    pub(crate) fn from_sac(
        sac_bar_per_min: f64,
        ref_cyl_water_volume_l: f64,
        label: Option<String>,
    ) -> Result<Self, String> {
        if !sac_bar_per_min.is_finite() || sac_bar_per_min <= 0.0 {
            return Err(format!(
                "SAC must be finite and positive, got {sac_bar_per_min}"
            ));
        }
        if !ref_cyl_water_volume_l.is_finite() || ref_cyl_water_volume_l <= 0.0 {
            return Err(format!(
                "Reference cylinder volume must be finite and positive, got {ref_cyl_water_volume_l}"
            ));
        }
        Self::new(sac_to_rmv(sac_bar_per_min, ref_cyl_water_volume_l), label)
    }
}

/// A single cylinder. `fill_bar` is an INPUT and may exceed `rated_pressure_bar` -
/// overfilling LP steels to MP or higher is routine (§5.3) - so rated is reference only
/// and is **never** used to clamp the fill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Cylinder {
    pub water_volume_l: f64,
    pub rated_pressure_bar: f64,
    pub fill_bar: f64,
    pub material: TankMaterial,
    pub role: CylRole,
    pub label: Option<String>,
    /// Whether this cylinder is carried on THIS dive (#245). A disabled tank stays in the
    /// table (greyed) but is excluded from every gas computation - budget, gauges, drops -
    /// so a diver can toggle rig variants without deleting rows. `#[serde(default)]` = `true`,
    /// so a plan/config saved before this field loads with all tanks enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Under the **Free** strategy (#245) this is the diver's manually-chosen penetration
    /// allowance (bar) - the gas they'll breathe off this tank on the way IN before turning.
    /// The engine budgets exactly this (Z-derated span from `fill` down to `fill - usable_gas_bar`).
    /// Ignored by every other strategy, which COMPUTE the usable bar from the reserve rules and
    /// report it back on `GasReachField::cylinder_usable_bars`. `#[serde(default)]` = `0.0`.
    #[serde(default)]
    pub usable_gas_bar: f64,
}

impl Cylinder {
    pub(crate) fn new(
        water_volume_l: f64,
        rated_pressure_bar: f64,
        fill_bar: f64,
        material: TankMaterial,
        role: CylRole,
        label: Option<String>,
    ) -> Result<Self, String> {
        for (name, value) in [
            ("water volume", water_volume_l),
            ("rated pressure", rated_pressure_bar),
            ("fill", fill_bar),
        ] {
            if !value.is_finite() || value <= 0.0 {
                return Err(format!(
                    "Cylinder {name} must be finite and positive, got {value}"
                ));
            }
        }
        Ok(Self {
            water_volume_l,
            rated_pressure_bar,
            fill_bar,
            material,
            role,
            label,
            enabled: true,
            usable_gas_bar: 0.0,
        })
    }

    /// Ideal free-gas volume (litres) at the current fill. Ideal-gas (see the §5.3
    /// real-gas caveat - the conservative derate / Z correction is applied by the engine,
    /// not baked in here).
    pub(crate) fn gas_volume_l(&self) -> f64 {
        cylinder_gas_volume(self.fill_bar, self.water_volume_l)
    }
}

/// A team of divers, each with their own cylinders, planned in one [`PlanMode`]. Phase 1
/// collapses to one diver / one cylinder; the `Vec` shape exists from day one so CCR
/// (§5.5) and the team feature (Phase 5) add no migrations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Team {
    pub divers: Vec<Diver>,
    pub cylinders_per_diver: Vec<Vec<Cylinder>>,
    pub mode: PlanMode,
}

/// Result of the gas-weighted reachability compute - the gas analogue of `DistanceField`.
/// Per-station gas-to-reach from the origin (one-way, in-leg), the reachable mask under the
/// reserve budget, and the turn frontier (reachable stations with an unreachable neighbour).
/// `gas_to_reach` is `None` for graph-unreachable stations (JSON-safe ∞); `station_refs` echo
/// the input order so the field is self-describing.
///
/// One leg of the planned route - origin→target, station to station. `is_jump` marks a
/// reference/jump shot (a swum shortcut normally hidden in the survey view), so the UI can draw it
/// dashed and distinct from a regular swum leg. A merge / loop-closure tie (coincident points) is
/// `is_jump = false` (zero-length, drawn solid).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RouteLeg {
    pub from: StationRef,
    pub to: StationRef,
    pub is_jump: bool,
}

/// The `route` / `stage_drop_refs` / `final_turn_ref` describe the **planned route** to the route
/// target (the user-selected endpoint, else the farthest in-budget point): the ordered legs from
/// the origin to the target (for the route highlight), the station where each stage's IN gas runs
/// out (its drop point - staged strategies only), and the final turn. `route` + `final_turn_ref`
/// are populated for **any** strategy when a target is reachable; `stage_drop_refs` is **empty for
/// All-thirds** (and any rig that falls back to it - no per-stage drops).
///
/// `backgas_turn_bar` and `stage_drop_bars` are the **readout gauges**, computed here (the single
/// source of truth) so the UI never re-derives the budget math and drifts from the reachable
/// overlay: the back-gas turn pressure under the effective strategy's fraction, and each counted
/// stage's Half-Minus drop pressure. Both honour the conservative cap + normalized reserve +
/// stage-count fallback. `backgas_turn_bar` is `None` when the rig has no back gas;
/// `stage_drop_bars` is empty for All-thirds / a fell-back staged strategy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct GasReachField {
    pub station_refs: Vec<StationRef>,
    pub gas_to_reach: Vec<Option<f64>>,
    pub reachable: Vec<bool>,
    pub turn_frontier: Vec<StationRef>,
    pub max_reachable_gas: f64,
    pub budget_litres: f64,
    /// Ordered legs origin→target (for the route highlight); empty when nothing is reachable.
    pub route: Vec<RouteLeg>,
    /// Station where each stage's IN gas is exhausted, in stage order (staged strategies only).
    pub stage_drop_refs: Vec<StationRef>,
    /// The final turn - the route target station; `None` when nothing is reachable.
    pub final_turn_ref: Option<StationRef>,
    /// Back-gas turn pressure gauge (bar); `None` when the rig has no back gas.
    pub backgas_turn_bar: Option<f64>,
    /// Per-stage Half-Minus drop pressure gauge (bar), one per counted stage; empty for All-thirds.
    pub stage_drop_bars: Vec<f64>,
    /// Whether each stage drop is **over-reserve** (#246), aligned 1:1 with `stage_drop_refs` /
    /// `stage_drop_bars`. `true` only when the diver dragged that drop DEEPER than its
    /// strategy-computed (gas-safe) point, so the stage is breathed past its reserve to reach the
    /// pinned station - the UI flags it red. Every entry is `false` for the un-dragged default
    /// (and for All-thirds, which has no drops). The over-reserve reach it produces is honest but
    /// unsafe; the flag is the warning, not a block (the diver asked for it).
    pub stage_drop_over_reserve: Vec<bool>,
    /// Swum distance (metres) from the origin to each stage-drop station, aligned with
    /// `stage_drop_refs` / `stage_drop_bars`, for the Plan readout (#245). Same swum-distance basis
    /// as `route_line_length_m`. Empty when there are no stage drops.
    pub stage_drop_distances_m: Vec<f64>,
    /// Per-cylinder penetration allowance (bar) the engine used, aligned 1:1 with the INPUT
    /// cylinder order (disabled tanks and non-budget roles are `0.0`) so the table can show a
    /// "usable gas" value per row (#245). Under the reserve presets these are engine-COMPUTED
    /// (`fill - turn/drop`): a back-gas tank shows its strategy fraction of usable, a counted
    /// stage its Half-Minus IN half; under **Free** they echo the diver's clamped input. The
    /// single source of truth for the column, so it can never drift from the budget/gauges.
    pub cylinder_usable_bars: Vec<f64>,
    /// Swum line length of the planned route (metres): the one-way penetration distance, summed as
    /// 3-D slope segments over the route's real shot legs (zero-distance merge/closure ties
    /// excluded), origin→turnaround. This is the *swum* distance, not the on-screen highlight length
    /// (a 2-D, closure-adjusted projection). `0.0` when nothing is reachable. (Not straight-line;
    /// not round-trip.)
    pub route_line_length_m: f64,
    /// Deepest point on the route (metres, positive = below surface); `None` when no route.
    pub route_max_depth_m: Option<f64>,
    /// Distance-weighted average depth along the route (metres, positive = below surface); `None`
    /// when no route.
    pub route_avg_depth_m: Option<f64>,
}
