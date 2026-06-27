//! Gas-planning domain model: divers, cylinders, teams. Canonical SI (L/min, L, bar, m).
//! Constructors guard non-finite / non-positive inputs at the ingest boundary (mirroring
//! `Coordinates::new_checked`), so a NaN RMV or zero cylinder can never poison the gas
//! field downstream. The persisted/per-plan `GasConfig` (units, reserve preset, speeds)
//! lives in `crate::config` — these are the per-dive, ephemeral parts.

// The types/fields are `pub` (re-exported to `models` for IPC + ts-rs), so they are NOT dead;
// but the guarding constructors (`new` / `from_sac` / `gas_volume_l`) are exercised only by
// tests until the Phase-1.3 command uses them for input validation — dead in the lib build
// until then, so the expectation is scoped to the non-test build (matches `models/shot.rs`;
// `#[allow]` is denied crate-wide).
#![cfg_attr(not(test), expect(dead_code))]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::StationRef;

use super::physics::{cylinder_gas_volume, sac_to_rmv};

/// Cylinder construction material. Hints role suitability — steel ≈ negative buoyancy →
/// back gas; aluminium ≈ neutral → fine as a stage — but it is guidance, never a hard
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

/// A diver identified by RMV — the canonical, persisted gas-rate. SAC is a *constructor*
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

/// A single cylinder. `fill_bar` is an INPUT and may exceed `rated_pressure_bar` —
/// overfilling LP steels to MP or higher is routine (§5.3) — so rated is reference only
/// and is **never** used to clamp the fill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Cylinder {
    pub water_volume_l: f64,
    pub rated_pressure_bar: f64,
    pub fill_bar: f64,
    pub material: TankMaterial,
    pub role: CylRole,
    pub label: Option<String>,
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
        })
    }

    /// Ideal free-gas volume (litres) at the current fill. Ideal-gas (see the §5.3
    /// real-gas caveat — the conservative derate / Z correction is applied by the engine,
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

/// Result of the gas-weighted reachability compute — the gas analogue of `DistanceField`.
/// Per-station gas-to-reach from the origin (one-way, in-leg), the reachable mask under the
/// reserve budget, and the turn frontier (reachable stations with an unreachable neighbour).
/// `gas_to_reach` is `None` for graph-unreachable stations (JSON-safe ∞); `station_refs` echo
/// the input order so the field is self-describing.
///
/// The `route_refs` / `stage_drop_refs` / `final_turn_ref` describe the **deepest-penetration
/// route** under a staged (Half-Minus) strategy — the ordered stations from the origin to the
/// farthest in-budget point, the station where each stage's IN gas runs out (its drop point), and
/// the final turn. They are **empty / `None` for All-thirds** (and for any rig that falls back to
/// it): All-thirds keeps the plain reachable field + turn frontier with no per-stage drops.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct GasReachField {
    pub station_refs: Vec<StationRef>,
    pub gas_to_reach: Vec<Option<f64>>,
    pub reachable: Vec<bool>,
    pub turn_frontier: Vec<StationRef>,
    pub max_reachable_gas: f64,
    pub budget_litres: f64,
    /// Ordered stations origin→deepest in-budget point (staged strategies only; else empty).
    pub route_refs: Vec<StationRef>,
    /// Station where each stage's IN gas is exhausted, in stage order (staged strategies only).
    pub stage_drop_refs: Vec<StationRef>,
    /// The final turn — deepest in-budget station on the route (staged strategies only; else None).
    pub final_turn_ref: Option<StationRef>,
}
