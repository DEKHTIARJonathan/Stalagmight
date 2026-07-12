//! Named dive-plan snapshots (#244), persisted in a sibling `.plnx` SQLite file.
//!
//! A plan captures exactly the input tuple of `compute_gas_reach_field`, so loading
//! a plan is "set the gas inputs and recompute": the reachability field itself is
//! never stored (it is always derived from live geometry, so a stale overlay can
//! never be shown). See `git show de8eef91:docs/plans/2026-07-06_dive-plan-persistence.md` (doc removed from master in #229).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::config::GasConfig;
use crate::models::{Cylinder, Diver, StationRef};

/// Payload schema version stamped into every saved snapshot. Bump only on a
/// breaking change to `DivePlanSnapshot`; additive changes need no bump because
/// unknown fields are ignored and missing fields default (serde, config-style).
pub const DIVE_PLAN_SCHEMA_VERSION: u32 = 1;

/// A missing diver (only reachable from a malformed or truncated blob) defaults to
/// the canonical 20 L/min rather than a zero RMV the engine would reject.
fn default_diver() -> Diver {
    Diver {
        rmv_l_per_min: 20.0,
        label: None,
    }
}

/// The persisted gas-plan inputs: the argument set of `compute_gas_reach_field`.
/// Every field is serde-default tolerant so a plan written by an older or newer
/// build still loads. No `PartialEq` (GasConfig has none); tests compare via JSON.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DivePlanSnapshot {
    #[serde(default)]
    pub origin: Option<StationRef>,
    #[serde(default)]
    pub endpoint: Option<StationRef>,
    #[serde(default = "default_diver")]
    pub diver: Diver,
    #[serde(default)]
    pub cylinders: Vec<Cylinder>,
    #[serde(default)]
    pub gas_config: GasConfig,
    #[serde(default)]
    pub stage_drop_overrides: Vec<Option<StationRef>>,
}

/// A dive plan's dropdown row: identity + name + timestamps (RFC3339). Carries no
/// heavy payload, so listing many plans is cheap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DivePlanMeta {
    /// SQLite rowid. `number` in TS (well under 2^53), not a `bigint`.
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A loaded dive plan: its metadata, the snapshot to apply, and how many station
/// references no longer resolve against the current survey (nulled on load; the UI
/// warns when > 0). See section 6 of the design doc.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DivePlan {
    pub meta: DivePlanMeta,
    pub snapshot: DivePlanSnapshot,
    pub stale_ref_count: u32,
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        clippy::float_cmp,
        reason = "tests build from known-valid literals; a failed unwrap should fail the test"
    )]
    use super::*;

    fn sample_json() -> String {
        // A full v1 snapshot as it would be written by the app.
        serde_json::json!({
            "origin": { "section_id": 1, "station_index": 0 },
            "endpoint": { "section_id": 2, "station_index": 5 },
            "diver": { "rmv_l_per_min": 18.0, "label": "lead" },
            "cylinders": [],
            "gas_config": serde_json::to_value(GasConfig::default()).unwrap(),
            "stage_drop_overrides": [null, { "section_id": 1, "station_index": 3 }]
        })
        .to_string()
    }

    #[test]
    fn round_trips_through_serde() {
        let snap: DivePlanSnapshot = serde_json::from_str(&sample_json()).unwrap();
        assert_eq!(snap.origin.unwrap().station_index, 0);
        assert_eq!(snap.endpoint.unwrap().section_id, 2);
        assert_eq!(snap.diver.rmv_l_per_min, 18.0);
        assert_eq!(snap.stage_drop_overrides.len(), 2);
        assert!(snap.stage_drop_overrides[0].is_none());
        assert_eq!(snap.stage_drop_overrides[1].unwrap().station_index, 3);
        // Re-serialize and reload: the round trip is lossless for the known fields.
        let again: DivePlanSnapshot =
            serde_json::from_str(&serde_json::to_string(&snap).unwrap()).unwrap();
        assert_eq!(again.endpoint.unwrap().station_index, 5);
    }

    #[test]
    fn tolerates_unknown_fields() {
        // A field from a hypothetical newer build must be ignored, not rejected.
        let json = serde_json::json!({
            "origin": null,
            "diver": { "rmv_l_per_min": 20.0, "label": null },
            "future_field_from_v2": { "anything": 42 }
        })
        .to_string();
        let snap: DivePlanSnapshot = serde_json::from_str(&json).unwrap();
        assert!(snap.origin.is_none());
        assert_eq!(snap.diver.rmv_l_per_min, 20.0);
    }

    #[test]
    fn defaults_missing_fields() {
        // An almost-empty blob loads: origin/endpoint None, empty vecs, default
        // config, and the diver falls back to the canonical rate.
        let snap: DivePlanSnapshot = serde_json::from_str("{}").unwrap();
        assert!(snap.origin.is_none());
        assert!(snap.endpoint.is_none());
        assert!(snap.cylinders.is_empty());
        assert!(snap.stage_drop_overrides.is_empty());
        assert_eq!(snap.diver.rmv_l_per_min, 20.0);
    }
}
