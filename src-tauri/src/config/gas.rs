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

fn default_jump_rmv_multiplier() -> f64 {
    1.5
}

fn default_stage_reserve_bar() -> f64 {
    30.0
}

fn default_all_thirds_safety_margin_bar() -> f64 {
    0.0
}

/// Upper bound on the All-thirds safety margin (bar). A margin only ever SHRINKS usable gas (the
/// safe direction), so the high side is merely capped for sanity; per-cylinder the engine clamps
/// the resulting usable at 0, so an over-large margin just zeroes a small tank rather than crediting
/// negative gas.
const MAX_ALL_THIRDS_SAFETY_MARGIN_BAR: f64 = 200.0;

/// Upper bound on the per-stage reserve. A LARGER reserve only shrinks a stage's usable IN gas
/// (`(fill - reserve)/2`) - the *safe* direction - so the high side is merely capped for sanity,
/// not rejected; the genuinely unsafe direction is a *negative* reserve (it would drop the stage
/// lower and over-state reach), which `normalize` resets. No real "half, less a reserve" rule
/// holds back more than ~100 bar of a stage.
const MAX_STAGE_RESERVE_BAR: f64 = 100.0;

fn default_recalc_hold_stage2_bar() -> f64 {
    100.0
}

fn default_recalc_hold_stage1_bar() -> f64 {
    70.0
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
/// pushy and advanced-gated in the UI. `Free` (#245) hands the diver full manual control: the
/// engine ignores the reserve rules and budgets the per-cylinder usable gas the user types
/// (`Cylinder::usable_gas_bar`), clamped to the conservative-capped fill - for planned/tech divers
/// who compute their own reserves.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ReservePreset {
    #[default]
    AllThirds,
    OneStage,
    TwoStage,
    Free,
}

/// Editable reserve constants (PRD §5.1) - kept out of the engine as named, tunable values
/// rather than magic literals. `stage_reserve_bar` is the gas held back in each stage under the
/// **Half Minus** strategy (default 30 bar): a stage is breathed from `fill` down to its drop
/// pressure `(fill + reserve)/2`, contributing `(fill - reserve)/2` of IN gas (the other half is
/// breathed back down to `reserve` on the picked-up exit). The two `recalc_hold_*` constants are
/// the back-gas held pressures (100 / 70 bar) for the Phase-2 return-leg recalc - carried now so
/// the config shape is stable across phases; that compute path is not implemented yet.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
pub struct ReserveProfile {
    #[serde(default = "default_stage_reserve_bar")]
    pub stage_reserve_bar: f64,
    /// Extra gas (bar) held back from EVERY budget-role cylinder under **All-thirds** (#245), on top
    /// of the thirds reserve - a diver-set conservatism knob for teams of two or specific caves.
    /// Default 0 (plain thirds). Only ever shrinks usable gas (the safe direction).
    #[serde(default = "default_all_thirds_safety_margin_bar")]
    pub all_thirds_safety_margin_bar: f64,
    #[serde(default = "default_recalc_hold_stage2_bar")]
    pub recalc_hold_stage2_bar: f64,
    #[serde(default = "default_recalc_hold_stage1_bar")]
    pub recalc_hold_stage1_bar: f64,
}

impl Default for ReserveProfile {
    fn default() -> Self {
        Self {
            stage_reserve_bar: default_stage_reserve_bar(),
            all_thirds_safety_margin_bar: default_all_thirds_safety_margin_bar(),
            recalc_hold_stage2_bar: default_recalc_hold_stage2_bar(),
            recalc_hold_stage1_bar: default_recalc_hold_stage1_bar(),
        }
    }
}

/// DPV (scooter) profile - speed plus range / burn-time for the dead-scooter contingency.
/// Phase 4; same RMV as swimming (no reduced-RMV credit, PRD §10).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default, TS)]
pub struct DpvProfile {
    pub speed_m_per_min: f64,
    pub burn_minutes: Option<f64>,
    pub range_m: Option<f64>,
}

/// Gas & route-planning defaults (issue #38). Persisted *personal defaults* a plan is
/// seeded from - never the per-dive plan itself (that stays ephemeral, never in the
/// project). The master metric/imperial toggle drives `units` alongside `UnitsConfig`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GasConfig {
    /// Display units for gas pressure/volume (kept in step with `UnitsConfig.length` by the
    /// master toggle, PRD §7.2 - not an independent control).
    #[serde(default)]
    pub units: GasUnits,
    /// Default reserve preset for a new plan (PRD §5.1).
    #[serde(default)]
    pub default_reserve: ReservePreset,
    /// Editable reserve constants (the Half-Minus per-stage reserve + the Phase-2 recalc holds), §5.1.
    #[serde(default)]
    pub reserve_profile: ReserveProfile,
    /// Exit-leg swim speed (m/min). Default 10 (no DPV).
    #[serde(default = "default_swim_speed")]
    pub swim_speed_m_per_min: f64,
    /// Survey-in speed (m/min); often 2-3× slower than the swim-out. `None` = symmetric
    /// (swim speed both ways). PRD §5.2.
    #[serde(default)]
    pub survey_speed_m_per_min: Option<f64>,
    /// Opt-in task-loading RMV bump on the survey-in leg only. Default 1.0 (no bump).
    #[serde(default = "default_survey_rmv_multiplier")]
    pub survey_rmv_multiplier: f64,
    /// Stressed-RMV multiplier for CCR bailout / contingency. Default 1.5×, user-settable.
    #[serde(default = "default_stressed_rmv_multiplier")]
    pub stressed_rmv_multiplier: f64,
    /// Per-jump RMV multiplier applied to *reference/jump* legs only (not permanent shots).
    /// Tying in a jump is extra task-loading that raises the breathing rate, so its gas burns
    /// at a higher RMV. **Default 1.5** ("putting in a jump is work"). Always ≥1.0 after
    /// `normalize`, so it can only ever *raise* gas (the conservative direction, §6).
    /// ⚠ **Stacks MULTIPLICATIVELY** with `survey_rmv_multiplier` on `is_reference` legs:
    /// the engine uses `edge_rmv = rmv · survey_rmv_multiplier · jump_rmv_multiplier`. With the
    /// default `survey_rmv_multiplier = 1.0` there is no stacking (jumps burn `rmv · 1.5`);
    /// raising both compounds (e.g. 1.5 × 1.5 = 2.25×).
    /// Today this covers all `is_reference` shots - a non-swimmable backsight is also a reference
    /// (the #77 jump-vs-reference distinction is still future work), and bumping its RMV is safe.
    #[serde(default = "default_jump_rmv_multiplier")]
    pub jump_rmv_multiplier: f64,
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
            reserve_profile: ReserveProfile::default(),
            swim_speed_m_per_min: default_swim_speed(),
            survey_speed_m_per_min: None,
            survey_rmv_multiplier: default_survey_rmv_multiplier(),
            stressed_rmv_multiplier: default_stressed_rmv_multiplier(),
            jump_rmv_multiplier: default_jump_rmv_multiplier(),
            conservative_tank_gas: true,
            dpv: None,
        }
    }
}

impl GasConfig {
    /// Clamp non-finite / non-positive speeds and multipliers back to their defaults, and drop a
    /// DPV profile whose speed is invalid. A foreign or hand-edited config can carry a 0 / NaN /
    /// negative `swim_speed_m_per_min` that would later divide into `edge_gas` (→ +Inf or NaN gas
    /// and a poisoned reachability field), so guard it at the config boundary - mirrors the other
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
        // survey / stressed / jump RMV multipliers are all work-factors RELATIVE to the
        // baseline swim RMV, so none is ever LESS work than baseline: a value below 1.0 would
        // under-state a leg's gas and over-state reach (the unsafe direction, #241 / §6). Clamp
        // anything non-finite or < 1.0 back to its default (defaults: survey 1.0, stressed 1.5,
        // jump 1.5), so a hand-edited config can only ever raise gas, never lower it.
        if !self.survey_rmv_multiplier.is_finite() || self.survey_rmv_multiplier < 1.0 {
            self.survey_rmv_multiplier = default_survey_rmv_multiplier();
        }
        if !self.stressed_rmv_multiplier.is_finite() || self.stressed_rmv_multiplier < 1.0 {
            self.stressed_rmv_multiplier = default_stressed_rmv_multiplier();
        }
        if !self.jump_rmv_multiplier.is_finite() || self.jump_rmv_multiplier < 1.0 {
            self.jump_rmv_multiplier = default_jump_rmv_multiplier();
        }
        // Reserve-profile constants. The per-stage reserve feeds the Half-Minus stage drop
        // `(fill + reserve)/2` and IN gas `(fill - reserve)/2`: a NEGATIVE reserve drops the
        // stage lower and credits more IN gas → the budget OVER-states reach (the unsafe
        // direction, §6), so reset it to the default. A LARGE reserve only shrinks the IN gas
        // (the safe side), so the high side is merely capped at MAX rather than reset (resetting
        // it to the smaller default would be *less* conservative). The recalc holds are carried
        // for Phase 2 but guarded now.
        let p = &mut self.reserve_profile;
        if !p.stage_reserve_bar.is_finite() || p.stage_reserve_bar < 0.0 {
            p.stage_reserve_bar = default_stage_reserve_bar();
        } else if p.stage_reserve_bar > MAX_STAGE_RESERVE_BAR {
            p.stage_reserve_bar = MAX_STAGE_RESERVE_BAR;
        }
        // All-thirds safety margin: a NEGATIVE margin would ADD usable gas (over-state reach, the
        // unsafe direction) so reset it to 0; a large one only shrinks usable (safe) so just cap it.
        if !p.all_thirds_safety_margin_bar.is_finite() || p.all_thirds_safety_margin_bar < 0.0 {
            p.all_thirds_safety_margin_bar = default_all_thirds_safety_margin_bar();
        } else if p.all_thirds_safety_margin_bar > MAX_ALL_THIRDS_SAFETY_MARGIN_BAR {
            p.all_thirds_safety_margin_bar = MAX_ALL_THIRDS_SAFETY_MARGIN_BAR;
        }
        if !p.recalc_hold_stage2_bar.is_finite() || p.recalc_hold_stage2_bar < 0.0 {
            p.recalc_hold_stage2_bar = default_recalc_hold_stage2_bar();
        }
        if !p.recalc_hold_stage1_bar.is_finite() || p.recalc_hold_stage1_bar < 0.0 {
            p.recalc_hold_stage1_bar = default_recalc_hold_stage1_bar();
        }
        if let Some(dpv) = self.dpv {
            if !dpv.speed_m_per_min.is_finite() || dpv.speed_m_per_min <= 0.0 {
                self.dpv = None;
            }
        }
        // Drop a NaN / non-positive burn-time or range too (the Phase-4 dead-scooter path
        // would otherwise divide by them). Runs after the speed clamp above, so `dpv` is
        // only still Some when its speed is already valid.
        if let Some(dpv) = self.dpv.as_mut() {
            if dpv.burn_minutes.is_some_and(|b| !b.is_finite() || b <= 0.0) {
                dpv.burn_minutes = None;
            }
            if dpv.range_m.is_some_and(|r| !r.is_finite() || r <= 0.0) {
                dpv.range_m = None;
            }
        }
    }
}
