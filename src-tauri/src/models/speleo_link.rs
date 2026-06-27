use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// SpeleoDB single-writer hand-off link, persisted as the single `speleo_link`
/// row inside a pulled `.stalx` (schema v9). Records which SpeleoDB project a
/// `.stalx` belongs to plus whether it carries un-pushed edits.
///
/// `is_remote` (on [`crate::models::ProjectMetadata`]) is DERIVED from the
/// existence of this row — it is never stored as a column. The link is stamped
/// once on pull and is intentionally NOT rewritten by `save_project` (a local
/// save/autosave must never clear `has_unpushed_edits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SpeleoLink {
    /// SpeleoDB endpoint the project was pulled from.
    pub endpoint: String,
    /// SpeleoDB project UUID.
    pub project_id: String,
    /// Display name captured at pull time.
    pub project_name: String,
    /// NULL on-disk = empty-repo BASE (a freshly-created, never-committed
    /// project). NEVER coerced to `""`. Captured once on pull, never mutated by
    /// #189 (a later Sync/Release issue re-stamps it).
    pub base_commit_sha: Option<String>,
    /// Set-only in #191 (`false → true` on first successful remote-project
    /// edit); cleared only by a later successful server push (Sync/Release),
    /// never by local save/autosave.
    pub has_unpushed_edits: bool,
}
