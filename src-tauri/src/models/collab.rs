use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::SectionId;

/// Per-shot baseline captured at the last export to the sibling `.tml`.
///
/// Lets Stalagmight diff a returned (Ariane-edited) `.tml` against exactly what it
/// last wrote, so a one-directional reconcile can classify added/edited/removed shots.
///
/// The identity key is `(section_id, shot_index)` - the only shot identity that
/// survives a save/reload, since `Shot.id` is regenerated on load from the sequence
/// order (see `persistence::sqlite`). It is NOT the in-memory `ShotId`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
pub struct ShotBaselineEntry {
    /// Section this shot belongs to.
    pub section_id: SectionId,
    /// Index of the shot within its section's `shots` vec (0-based, stable).
    pub shot_index: u32,
    /// Ariane integer `ID` assigned to this shot at export (matching tier 2, guarded).
    pub ariane_id: i64,
    /// UUID emitted into the `.tml` (matching tier 1). Empty until exported with UUIDs.
    pub uuid: String,
    /// Quantized geometry fingerprint of the shot (matching tier 3).
    pub geo_key: String,
    /// Section name as written to the `.tml` at export time (rename disambiguation).
    pub section_name: String,
    /// Station-comment text attached to this shot's `to` station at export time.
    /// Captured so a returned `.tml` whose Comment changed only in the station
    /// portion can be detected as an edit instead of being silently overwritten
    /// (or silently ignored). `#[serde(default)]` keeps older baselines loadable.
    #[serde(default)]
    pub station_comment: Option<String>,
}

/// Per-project collaboration state, persisted inside the `.stalx`.
///
/// When `enabled`, every save also writes a sibling `.tml`, and opening the project
/// detects external (Ariane) edits to that `.tml` and reconciles them back in.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CollabState {
    /// Whether collaboration mode is on for this project.
    pub enabled: bool,
    /// Sibling `.tml` path, stored relative to the `.stalx` directory.
    pub sibling_tml_relative: String,
    /// sha256 (hex) of the `.tml` bytes the last time Stalagmight wrote or consumed it.
    /// `None` until the first export. Used to detect external edits on open.
    #[serde(default)]
    pub last_export_tml_sha256: Option<String>,
    /// Per-shot baseline captured at the last export.
    #[serde(default)]
    pub shot_baseline: Vec<ShotBaselineEntry>,
    /// Exported section name -> SectionId, captured at last export (rename detection).
    #[serde(default)]
    pub section_name_map: Vec<(String, SectionId)>,
    /// Names of synthetic export legs (`<name> (reversed)`, `<name> (pre-zero-datum)`)
    /// written at the last export. These are reversed duplicates of forward
    /// geometry, not real sections, so reconcile must ignore returned sections
    /// with these names rather than treat them as new sections.
    #[serde(default)]
    pub synthetic_section_names: Vec<String>,
    /// Timestamp of the last successful reconcile apply.
    #[serde(default)]
    #[ts(type = "string | null")]
    pub last_reconcile_at: Option<DateTime<Utc>>,
    /// Whether auto-save should also rewrite the `.tml` (default true). When false,
    /// only explicit saves rewrite the sibling file (avoids churn on every debounce).
    #[serde(default = "default_true")]
    pub write_tml_on_autosave: bool,
}

fn default_true() -> bool {
    true
}

/// Quantized geometry fingerprint used to match a shot across a TML round-trip
/// when stable IDs are unavailable (Ariane ≤25). Tolerances: azimuth 0.1°,
/// length 5 mm, depth-delta 1 cm. Computed identically on export (from the
/// Stalagmight shot) and on reconcile (from the normalized returned TML shot),
/// so a clean round-trip yields an identical key.
pub fn geo_key(azimuth_in: f64, length: f64, depth_in: f64, depth_out: f64) -> String {
    let q = |v: f64, step: f64| (v / step).round() as i64;
    format!(
        "{}|{}|{}",
        q(azimuth_in.rem_euclid(360.0), 0.1),
        q(length, 0.005),
        q(depth_out - depth_in, 0.01),
    )
}

impl CollabState {
    /// Create freshly-enabled collaboration state for the given sibling `.tml`
    /// (relative to the `.stalx` dir). No baseline yet - seeded on first save.
    pub fn new(sibling_tml_relative: String) -> Self {
        Self {
            enabled: true,
            sibling_tml_relative,
            last_export_tml_sha256: None,
            shot_baseline: Vec::new(),
            section_name_map: Vec::new(),
            synthetic_section_names: Vec::new(),
            last_reconcile_at: None,
            write_tml_on_autosave: true,
        }
    }
}
