//! Bounds and repair for the `[general]` config block.
//!
//! Split out of `types.rs` rather than rebaselined, for the same reason
//! `column_widths.rs` was: adding this pushed that file across the file-size
//! ratchet's 1500 prod-LOC line, at which point a file is frozen and may shrink
//! but not grow, and #157 says to split at an API boundary instead of raising
//! the baseline. This is one: nothing here needs the rest of `types.rs` beyond
//! `GeneralConfig` and its two default-tag helpers.

use super::types::{default_format_locale, default_locale, GeneralConfig};
use std::collections::HashSet;

/// Ceilings on the SHAPE of the `[general]` collections, exactly the job
/// `MAX_COLUMN_WIDTH_ENTRIES` / `MAX_COLUMN_KEY_LEN` already do for the
/// data-table maps and lists in `config/column_widths.rs`, and named for this
/// domain rather than shared with that one because the entries here are flow ids
/// and filesystem paths, not grid column keys.
///
/// The hole they close is the same one: every field below is writable through
/// the whole-`Config` `update_config` door, nothing prunes it afterwards, and
/// `config.toml` is re-parsed at every launch - so one oversized write is paid
/// for on every start until someone hand-edits the file.
///
/// The numbers are deliberately far above any real value (the app declares a
/// handful of onboarding flows; `recent_projects_max` defaults to 20; a BCP-47
/// tag is a few characters, and `PATH_MAX` is 4096 on Linux and macOS alike), so
/// reaching one of them means the payload is degenerate, not ambitious.
///
/// Note what this bounds: what we RETAIN and write back, not what a single
/// hostile IPC payload transiently allocates - serde has already materialised
/// the input by the time any of this runs.
const MAX_ONBOARDING_FLOWS: usize = 256;
const MAX_ONBOARDING_FLOW_ID_LEN: usize = 128;
const MAX_LOCALE_TAG_LEN: usize = 64;
const MAX_RECENT_PROJECTS: usize = 256;
const MAX_RECENT_PROJECT_PATH_LEN: usize = 4096;

/// Repair the `[general]` block in place: the three locale-ish tags, the
/// onboarding flow list and the recent-projects list.
///
/// Reached from `Config::normalize_except_shortcuts`, so it runs on BOTH doors -
/// the load path repairing a hand-edited file, and the IPC write path repairing
/// an arriving payload before it is persisted.
pub(super) fn normalize_general(general: &mut GeneralConfig) {
    // All three tags are free-form strings straight off the Settings form and
    // all three are resolved the same way by the frontend, so they get the same
    // repair. Only `locale` was checked before, and only for emptiness.
    normalize_locale_tag(&mut general.locale, default_locale);
    normalize_locale_tag(&mut general.number_format, default_format_locale);
    normalize_locale_tag(&mut general.date_format, default_format_locale);

    // Shape, then count - the same order as `normalize_column_names`, so the
    // survivors of the cap are entries that were individually plausible rather
    // than the first 256 of whatever arrived.
    let mut seen = HashSet::new();
    general.onboarding_completed_flows.retain(|flow_id| {
        let trimmed = flow_id.trim();
        !trimmed.is_empty()
            && trimmed.len() <= MAX_ONBOARDING_FLOW_ID_LEN
            && seen.insert(trimmed.to_string())
    });
    if general.onboarding_completed_flows.len() > MAX_ONBOARDING_FLOWS {
        tracing::warn!(
            "onboarding_completed_flows has {} entries, truncating to {}",
            general.onboarding_completed_flows.len(),
            MAX_ONBOARDING_FLOWS
        );
        general
            .onboarding_completed_flows
            .truncate(MAX_ONBOARDING_FLOWS);
    }

    // The recents list had no ceiling on either axis: `recent_projects_max` is
    // the only thing that ever trims it (in `project_load` / `project_io`), and
    // it was itself unclamped - so a payload could set it to `usize::MAX` and
    // then persist an unbounded list of unbounded paths, which are also the most
    // identifying strings in the file (usernames, dive-site names).
    //
    // Only the upper bound is clamped: 0 is a meaningful setting - "keep no
    // recents" - and must survive.
    general.recent_projects_max = general.recent_projects_max.min(MAX_RECENT_PROJECTS);
    general.recent_projects.retain(|project| {
        let len = project.as_os_str().len();
        len > 0 && len <= MAX_RECENT_PROJECT_PATH_LEN
    });
    general
        .recent_projects
        .truncate(general.recent_projects_max);
}

/// Repair one of the three `[general]` locale-ish tags: blank, or too long to be
/// a locale tag at all, falls back to that field's documented default.
///
/// Reset rather than truncate, because a truncated tag is not a shorter tag - it
/// is a different and almost certainly nonexistent one, and the frontend hands
/// these to `Intl`, where a garbage tag throws rather than falling back. The
/// documented default is the value that is known to render.
///
/// Replaces only; it deliberately does not trim in place, which is the
/// pre-existing contract for these fields.
fn normalize_locale_tag(value: &mut String, default: fn() -> String) {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_LOCALE_TAG_LEN {
        *value = default();
    }
}
