use crate::models::Project;
use crate::persistence::Database;

use super::AppState;

#[cfg(test)]
impl AppState {
    #[cfg(test)]
    pub fn set_project_for_tests(&self, project: Project) {
        if let Ok(mut guard) = self.project.lock() {
            *guard = Some(project);
        }
    }

    #[cfg(test)]
    pub fn set_database_for_tests(&self, db: Database) {
        if let Ok(mut guard) = self.database.lock() {
            *guard = Some(db);
        }
    }

    #[cfg(test)]
    pub fn set_initial_save_deferred_for_tests(&self, deferred: bool) {
        self.initial_save_deferred
            .store(deferred, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Every production region in the `core::state::speleodb*` family, paired with the
/// file it came from.
///
/// ADD A LINE HERE when a new `speleodb_*.rs` module is born. The tripwires built on
/// this count source-level facts about the orchestration, and the orchestration is
/// spread across the family - a scan that stops seeing a file stops guarding it, and
/// an absence assertion goes on passing while it does.
fn speleodb_prod_sources() -> [(&'static str, &'static str); 8] {
    [
        ("speleodb.rs", include_str!("speleodb.rs")),
        ("speleodb_admin.rs", include_str!("speleodb_admin.rs")),
        ("speleodb_cache.rs", include_str!("speleodb_cache.rs")),
        (
            "speleodb_credentials.rs",
            include_str!("speleodb_credentials.rs"),
        ),
        (
            "speleodb_local_state.rs",
            include_str!("speleodb_local_state.rs"),
        ),
        (
            "speleodb_lock_release.rs",
            include_str!("speleodb_lock_release.rs"),
        ),
        ("speleodb_logout.rs", include_str!("speleodb_logout.rs")),
        ("speleodb_project.rs", include_str!("speleodb_project.rs")),
    ]
    .map(|(name, src)| (name, src.split("#[cfg(test)]").next().unwrap_or(src)))
}

/// How many times `needle` appears across the family's production regions.
///
/// `skip` names files to leave out: an absence assertion about what the
/// orchestration may *call* must not match the definition site itself.
pub(super) fn speleodb_prod_matches(needle: &str, skip: &[&str]) -> usize {
    speleodb_prod_sources()
        .iter()
        .filter(|(name, _)| !skip.contains(name))
        .map(|(_, src)| src.matches(needle).count())
        .sum()
}
