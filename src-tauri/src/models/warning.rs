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
}
