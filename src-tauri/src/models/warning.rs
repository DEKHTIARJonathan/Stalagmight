//! Project warning types.
//!
//! This module contains warning types that are used for validation and
//! displayed in the UI. Moved from commands/validation.rs for reuse
//! across the codebase.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::core::WarningSeverity;
use crate::models::{SectionId, ShotId};

/// A project-level warning with reference to the source shot.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ProjectWarning {
    pub section_id: SectionId,
    pub shot_id: ShotId,
    pub shot_index: usize,
    pub code: String,
    pub message: String,
    pub severity: WarningSeverity,
    pub is_resolved: bool,
    /// Stable UUID of the shot this warning is attached to. The basis for the
    /// "Ignore" persistence (issue #57): keying suppression by the shot's
    /// `uuid` rather than the regenerated `shot_id` keeps an ignore bound to
    /// the same shot even after the user inserts, deletes, or reorders shots.
    /// `None` only for shots loaded from pre-v6 .stalx files that have not yet
    /// had a UUID minted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shot_uuid: Option<String>,
    /// For `multiple_datums_per_merge_component` only: the `station_index`
    /// (within `section_id`) of the over-anchoring zero datum this row points
    /// to. Lets the Resolve view offer "Remove this zero datum" / "Go to
    /// station" without re-deriving the ambiguous station↔shot mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub datum_station_index: Option<u32>,
}
