//! Gas-planning domain model: divers, cylinders, teams. Canonical SI (L/min, L, bar, m).
//! Constructors guard non-finite / non-positive inputs at the ingest boundary (mirroring
//! `Coordinates::new_checked`), so a NaN RMV or zero cylinder can never poison the gas
//! field downstream. The persisted/per-plan `GasConfig` (units, reserve preset, speeds)
//! lives in `crate::config` — these are the per-dive, ephemeral parts.

#![expect(
    dead_code,
    reason = "Phase 0 gas foundation: the model is consumed by the Phase 1 gas engine + commands/gas.rs"
)]

use serde::{Deserialize, Serialize};

use super::physics::{cylinder_gas_volume, sac_to_rmv};

/// Cylinder construction material. Hints role suitability — steel ≈ negative buoyancy →
/// back gas; aluminium ≈ neutral → fine as a stage — but it is guidance, never a hard
/// rule (PRD §5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TankMaterial {
    Aluminium,
    Steel,
}

/// What a cylinder is carried for. Drives the reserve math (§5.1) and the CCR "dil-out"
/// model (§5.5). `Deco` gas is reserved for a future deco phase and is **never**
/// travel/penetration gas, so it is excluded from the penetration budget (§5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CylRole {
    BackGas,
    Stage,
    DilOut,
    Bailout,
    Deco,
}

/// Open-circuit vs CCR bailout planning. CCR is not gas-limited on penetration; its
/// constraint is the bailout volume to exit (§5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlanMode {
    OpenCircuit,
    CcrBailout,
}

/// A diver identified by RMV — the canonical, persisted gas-rate. SAC is a *constructor*
/// concern only (see [`Diver::from_sac`]); it is never stored, so an inconsistent
/// SAC/reference pair can't linger in the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Diver {
    pub(crate) rmv_l_per_min: f64,
    pub(crate) label: Option<String>,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Cylinder {
    pub(crate) water_volume_l: f64,
    pub(crate) rated_pressure_bar: f64,
    pub(crate) fill_bar: f64,
    pub(crate) material: TankMaterial,
    pub(crate) role: CylRole,
    pub(crate) label: Option<String>,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Team {
    pub(crate) divers: Vec<Diver>,
    pub(crate) cylinders_per_diver: Vec<Vec<Cylinder>>,
    pub(crate) mode: PlanMode,
}
