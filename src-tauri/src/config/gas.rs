//! Gas & route-planning config types (issue #38).
//!
//! Split out of `config/types.rs` to keep that file under the file-size ratchet
//! (it was already at the 1500-LOC freeze line). Re-exported from `config` via
//! `pub use gas::*`, so `crate::config::GasConfig` etc. resolve unchanged.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

fn default_true() -> bool {
    true
}

fn default_swim_speed() -> f64 {
    10.0
}

fn default_survey_rmv_multiplier() -> f64 {
    1.0
}

fn default_stressed_rmv_multiplier() -> f64 {
    1.5
}

/// Display units for gas: metric (bar / litres) or imperial (psi / cuft).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum GasUnits {
    #[default]
    Metric,
    Imperial,
}

/// Reserve preset (PRD §5.1). All-thirds is the safe default; the 1-/2-stage presets are
/// pushy and advanced-gated in the UI.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ReservePreset {
    #[default]
    AllThirds,
    OneStage,
    TwoStage,
}

/// DPV (scooter) profile — speed plus range / burn-time for the dead-scooter contingency.
/// Phase 4; same RMV as swimming (no reduced-RMV credit, PRD §10).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default, TS)]
pub struct DpvProfile {
    pub speed_m_per_min: f64,
    pub burn_minutes: Option<f64>,
    pub range_m: Option<f64>,
}

/// Gas & route-planning defaults (issue #38). Persisted *personal defaults* a plan is
/// seeded from — never the per-dive plan itself (that stays ephemeral, never in the
/// project). The master metric/imperial toggle drives `units` alongside `UnitsConfig`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GasConfig {
    /// Display units for gas pressure/volume (kept in step with `UnitsConfig.length` by the
    /// master toggle, PRD §7.2 — not an independent control).
    #[serde(default)]
    pub units: GasUnits,
    /// Default reserve preset for a new plan (PRD §5.1).
    #[serde(default)]
    pub default_reserve: ReservePreset,
    /// Exit-leg swim speed (m/min). Default 10 (no DPV).
    #[serde(default = "default_swim_speed")]
    pub swim_speed_m_per_min: f64,
    /// Survey-in speed (m/min); often 2–3× slower than the swim-out. `None` = symmetric
    /// (swim speed both ways). PRD §5.2.
    #[serde(default)]
    pub survey_speed_m_per_min: Option<f64>,
    /// Opt-in task-loading RMV bump on the survey-in leg only. Default 1.0 (no bump).
    #[serde(default = "default_survey_rmv_multiplier")]
    pub survey_rmv_multiplier: f64,
    /// Stressed-RMV multiplier for CCR bailout / contingency. Default 1.5×, user-settable.
    #[serde(default = "default_stressed_rmv_multiplier")]
    pub stressed_rmv_multiplier: f64,
    /// `true` (default) = the conservative "call-it-an-80" derate covers real-gas Z; `false`
    /// = precise `fill × volume × Z` for the few who want it (PRD §5.3).
    #[serde(default = "default_true")]
    pub conservative_tank_gas: bool,
    /// Optional DPV profile (Phase 4). `None` = no scooter.
    #[serde(default)]
    pub dpv: Option<DpvProfile>,
}

impl Default for GasConfig {
    fn default() -> Self {
        Self {
            units: GasUnits::default(),
            default_reserve: ReservePreset::default(),
            swim_speed_m_per_min: default_swim_speed(),
            survey_speed_m_per_min: None,
            survey_rmv_multiplier: default_survey_rmv_multiplier(),
            stressed_rmv_multiplier: default_stressed_rmv_multiplier(),
            conservative_tank_gas: true,
            dpv: None,
        }
    }
}

impl GasConfig {
    /// Clamp non-finite / non-positive speeds and multipliers back to their defaults, and drop a
    /// DPV profile whose speed is invalid. A foreign or hand-edited config can carry a 0 / NaN /
    /// negative `swim_speed_m_per_min` that would later divide into `edge_gas` (→ +Inf or NaN gas
    /// and a poisoned reachability field), so guard it at the config boundary — mirrors the other
    /// sub-configs' `normalize()`. Called from `Config::normalize`.
    pub fn normalize(&mut self) {
        if !self.swim_speed_m_per_min.is_finite() || self.swim_speed_m_per_min <= 0.0 {
            self.swim_speed_m_per_min = default_swim_speed();
        }
        if let Some(survey) = self.survey_speed_m_per_min {
            // Survey-in is slower than (or equal to) the swim-out; a survey speed FASTER than the
            // swim speed is backwards and would make the in-leg-only reach field OVER-state reach
            // (the unsafe direction, §6), so treat it as symmetric (None). Runs after the swim
            // clamp above, so `self.swim_speed_m_per_min` is already valid.
            if !survey.is_finite() || survey <= 0.0 || survey > self.swim_speed_m_per_min {
                self.survey_speed_m_per_min = None;
            }
        }
        if !self.survey_rmv_multiplier.is_finite() || self.survey_rmv_multiplier <= 0.0 {
            self.survey_rmv_multiplier = default_survey_rmv_multiplier();
        }
        if !self.stressed_rmv_multiplier.is_finite() || self.stressed_rmv_multiplier <= 0.0 {
            self.stressed_rmv_multiplier = default_stressed_rmv_multiplier();
        }
        if let Some(dpv) = self.dpv {
            if !dpv.speed_m_per_min.is_finite() || dpv.speed_m_per_min <= 0.0 {
                self.dpv = None;
            }
        }
    }
}
