//! Native Stalagmight downloads and cache installation.
use super::speleodb::{local_dto, validate_project_id};
use super::speleodb_cache::{
    preserved_undo_mode, restore_display_settings, InheritedUndo, LocalEditsPolicy,
};
use super::speleodb_revisions::validate_hexsha;
use super::AppState;
use crate::speleodb::contract::{dto_for_error, Endpoint};
use crate::speleodb::models::SpeleoProjectSummary;
use crate::speleodb::{client, sync, SpeleoDbError, SpeleoErrorDto, SpeleoOpenResult};
pub(super) fn usable_tip(tip: Option<String>, project_id: &str) -> Option<String> {
    let sha = tip?;
    if validate_hexsha(&sha).is_ok() {
        return Some(sha);
    }
    tracing::warn!(
        project_id = %project_id,
        len = sha.len(),
        "server history reported a tip that is not a usable revision id; falling back \
         to an undated HEAD download"
    );
    None
}

const DOWNLOADED_VALUE_LIMIT: i32 = 64 * 1024 * 1024;
const DOWNLOADED_PROCESSING_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

impl AppState {
    pub fn speleodb_list_projects(&self) -> Result<Vec<SpeleoProjectSummary>, SpeleoErrorDto> {
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();
        let projects = self
            .speleodb_handle_auth(
                Endpoint::ListProjects,
                client::list_projects(&endpoint, &token, insecure_http),
            )
            .map_err(|e| dto_for_error(Endpoint::ListProjects, &e))?;
        Ok(projects
            .into_iter()
            .map(SpeleoProjectSummary::from_project)
            .collect())
    }
    pub fn speleodb_open_project(
        &self,
        project_id: String,
        project_name: String,
        latest_commit_sha: Option<String>,
    ) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
        self.speleodb_pull_project(
            project_id,
            project_name,
            latest_commit_sha,
            LocalEditsPolicy::Protect,
        )
    }
    pub fn speleodb_open_project_discarding_local(
        &self,
        project_id: String,
        project_name: String,
        latest_commit_sha: Option<String>,
    ) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
        self.speleodb_pull_project(
            project_id,
            project_name,
            latest_commit_sha,
            LocalEditsPolicy::Discard,
        )
    }
    fn speleodb_pull_project(
        &self,
        project_id: String,
        project_name: String,
        latest_commit_sha: Option<String>,
        policy: LocalEditsPolicy,
    ) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
        validate_project_id(&project_id).map_err(local_dto)?;
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();

        let dest = self.speleodb_cache_path(&project_id).map_err(local_dto)?;
        if policy == LocalEditsPolicy::Protect {
            self.guard_local_edits(&project_id, &dest)
                .map_err(local_dto)?;
        }

        let tip = match client::get_revisions(&endpoint, &token, insecure_http, &project_id) {
            Ok(history) => usable_tip(
                sync::tip_of(&history.commits).map(str::to_owned),
                &project_id,
            ),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "resolve server HEAD on pull",
                    "speleodb_open_project: could not resolve server HEAD; \
                     falling back to an undated HEAD download"
                );
                None
            }
        };
        let native = self
            .speleodb_handle_auth(
                Endpoint::DownloadStalx,
                match tip.as_deref() {
                    Some(sha) => client::download_stalx_at_hash(
                        &endpoint,
                        &token,
                        insecure_http,
                        &project_id,
                        sha,
                    ),
                    None => client::download_stalx(&endpoint, &token, insecure_http, &project_id),
                },
            )
            .map_err(|e| dto_for_error(Endpoint::DownloadStalx, &e))?;

        let base_sha = tip;
        let _ = latest_commit_sha; // A list hint cannot date an unpinned download.
        let link = crate::models::SpeleoLink {
            endpoint: endpoint.clone(),
            project_id: project_id.clone(),
            project_name,
            base_commit_sha: base_sha,
            has_unpushed_edits: false,
            last_edit_at: None,
            last_verify_at: None,
            undo_mode: None,
        };
        self.install_linked_download(native.path(), &dest, link, policy, InheritedUndo::Drop)
            .map_err(local_dto)?;

        let concurrent_session = {
            let holder = self.speleodb_lock_holder(&endpoint, &token, insecure_http, &project_id);
            self.speleodb_my_email()
                .is_some_and(|me| sync::concurrent_session_notice(holder.as_deref(), &me))
        };

        Ok(SpeleoOpenResult {
            local_path: dest.to_string_lossy().into_owned(),
            concurrent_session,
        })
    }
    pub(super) fn speleodb_fast_forward(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        link: &crate::models::SpeleoLink,
        tip: Option<&str>,
        policy: LocalEditsPolicy,
    ) -> Result<String, SpeleoDbError> {
        let project_id = &link.project_id;
        let pinned = usable_tip(tip.map(str::to_owned), project_id);
        let native = self.speleodb_handle_auth(
            Endpoint::DownloadStalx,
            match pinned.as_deref() {
                Some(sha) => {
                    client::download_stalx_at_hash(endpoint, token, insecure_http, project_id, sha)
                }
                None => client::download_stalx(endpoint, token, insecure_http, project_id),
            },
        )?;
        let dest = self.speleodb_cache_path(project_id)?;
        let new_link = crate::models::SpeleoLink {
            endpoint: endpoint.to_owned(),
            project_id: project_id.clone(),
            project_name: link.project_name.clone(),
            base_commit_sha: pinned,
            has_unpushed_edits: false,
            last_edit_at: None,
            last_verify_at: Some(chrono::Utc::now().to_rfc3339()),
            undo_mode: None,
        };
        self.install_linked_download(native.path(), &dest, new_link, policy, InheritedUndo::Drop)?;

        let local_path = dest.to_string_lossy().into_owned();
        self.close_project();
        self.do_load_project_full(dest)
            .map_err(|e| SpeleoDbError::Io(format!("reload after fast-forward failed: {e}")))?;
        self.speleodb_set_unwound_from(None);
        self.speleodb_set_inherited_through(None);
        Ok(local_path)
    }

    /// Validate and stamp the downloaded file before it can replace a working cache.
    /// A failed link write must never turn a remote project into an editable local file.
    pub(super) fn install_linked_download(
        &self,
        source: &std::path::Path,
        dest: &std::path::Path,
        link: crate::models::SpeleoLink,
        policy: LocalEditsPolicy,
        undo: InheritedUndo,
    ) -> Result<(), SpeleoDbError> {
        self.install_linked_download_with_limits(
            source,
            dest,
            link,
            policy,
            undo,
            (DOWNLOADED_VALUE_LIMIT, DOWNLOADED_PROCESSING_DEADLINE),
        )
    }

    fn install_linked_download_with_limits(
        &self,
        source: &std::path::Path,
        dest: &std::path::Path,
        mut link: crate::models::SpeleoLink,
        policy: LocalEditsPolicy,
        undo: InheritedUndo,
        limits: (i32, std::time::Duration),
    ) -> Result<(), SpeleoDbError> {
        {
            let db =
                crate::persistence::Database::open_existing_untrusted(source, limits.0, limits.1)
                    .map_err(|e| {
                    SpeleoDbError::Io(format!("could not open downloaded project: {e}"))
                })?;
            link.undo_mode = Some(self.effective_undo_mode(preserved_undo_mode(&db)));
            db.save_speleo_link(Some(&link)).map_err(|e| {
                SpeleoDbError::Io(format!("could not link downloaded project: {e}"))
            })?;
        }
        let preserved_view =
            self.replace_cache_stalx_with(source, dest, &link.project_id, policy, undo)?;
        let db = crate::persistence::Database::open_existing(dest)
            .map_err(|e| SpeleoDbError::Io(format!("could not reopen downloaded project: {e}")))?;
        restore_display_settings(&db, &preserved_view);
        Ok(())
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "synthetic native download regression fixtures"
)]
mod tests {
    use super::*;
    use crate::models::{Project, SpeleoLink, UndoMode};
    use crate::persistence::Database;

    fn link() -> SpeleoLink {
        SpeleoLink {
            endpoint: "https://example.com".into(),
            project_id: "11111111-1111-1111-1111-111111111111".into(),
            project_name: "Remote project".into(),
            base_commit_sha: Some("abc123".into()),
            has_unpushed_edits: false,
            last_edit_at: None,
            last_verify_at: None,
            undo_mode: None,
        }
    }

    #[test]
    fn hostile_downloads_and_resource_limits_preserve_the_working_cache() {
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("temp");
            let dest = dir.path().join("working.stalx");
            Database::open(&dest)
                .expect("database")
                .save_project(&Project::new("Unpushed local work".into(), None))
                .expect("project");
            let before = std::fs::read(&dest).expect("bytes");
            let state = AppState::new().expect("state");
            for case in ["invalid", "schema", "value", "deadline"] {
                let source = dir.path().join(format!("{case}.stalx"));
                if case == "invalid" {
                    std::fs::write(&source, b"not SQLite").expect("invalid");
                } else {
                    Database::open(&source)
                        .expect("database")
                        .save_project(&Project::new("X".repeat(4096), None))
                        .expect("project");
                    if case == "schema" {
                        rusqlite::Connection::open(&source)
                            .expect("connection")
                            .execute_batch("CREATE VIEW hostile AS SELECT 1;")
                            .expect("schema");
                    }
                }
                let limits = match case {
                    "value" => (1024, DOWNLOADED_PROCESSING_DEADLINE),
                    "deadline" => (DOWNLOADED_VALUE_LIMIT, std::time::Duration::ZERO),
                    _ => (DOWNLOADED_VALUE_LIMIT, DOWNLOADED_PROCESSING_DEADLINE),
                };
                assert!(
                    state
                        .install_linked_download_with_limits(
                            &source,
                            &dest,
                            link(),
                            LocalEditsPolicy::Protect,
                            InheritedUndo::Drop,
                            limits
                        )
                        .is_err(),
                    "{case} must be refused"
                );
                assert_eq!(std::fs::read(&dest).expect("cache bytes"), before, "{case}");
            }
        });
    }

    #[test]
    fn first_download_creates_its_nested_cache_directory() {
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("temp");
            let source = dir.path().join("download.stalx");
            let dest = dir.path().join("cache/speleodb/new-project/project.stalx");
            Database::open(&source)
                .expect("download")
                .save_project(&Project::new("First download".into(), None))
                .expect("project");
            assert!(!dest.parent().expect("cache directory").exists());

            AppState::new()
                .expect("state")
                .install_linked_download(
                    &source,
                    &dest,
                    link(),
                    LocalEditsPolicy::Protect,
                    InheritedUndo::Drop,
                )
                .expect("first download installs without a pre-existing cache");

            let db = Database::open_existing(&dest).expect("installed SQLite");
            assert_eq!(db.load_project().expect("project").name, "First download");
            let installed = db.load_speleo_link().expect("link").expect("linked");
            assert_eq!(installed.project_id, link().project_id);
            assert_eq!(installed.endpoint, link().endpoint);
        });
    }

    #[test]
    fn failed_download_link_write_keeps_the_previous_project_open_and_untouched() {
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("temp");
            let source = dir.path().join("download.stalx");
            let dest = dir.path().join("project.stalx");
            for (path, name) in [(&source, "Downloaded"), (&dest, "Previous")] {
                Database::open(path)
                    .expect("database")
                    .save_project(&Project::new(name.into(), None))
                    .expect("project");
            }
            // A readable database can still reject the link upsert, just as a full
            // disk or write failure can. No trigger or external fixture is needed.
            rusqlite::Connection::open(&source)
                .expect("download")
                .execute_batch("ALTER TABLE speleo_link ADD COLUMN required_value TEXT NOT NULL")
                .expect("make link inserts fail");
            let state = AppState::new().expect("state");
            assert!(state.open_project(dest.clone()).success);
            let before = std::fs::read(&dest).expect("previous bytes");
            let err = state
                .install_linked_download(
                    &source,
                    &dest,
                    link(),
                    LocalEditsPolicy::Protect,
                    InheritedUndo::Drop,
                )
                .expect_err("a remote project must not open without its link");
            assert!(
                err.to_string()
                    .contains("could not link downloaded project"),
                "{err}"
            );
            assert_eq!(std::fs::read(&dest).expect("unchanged cache"), before);
            assert_eq!(
                state.get_project_state().expect("still open").name,
                "Previous"
            );
        });
    }

    #[test]
    fn installed_download_keeps_remote_undo_policy_and_local_display_settings() {
        crate::test_helpers::with_isolated_config(|| {
            let dir = tempfile::tempdir().expect("temp");
            let source = dir.path().join("download.stalx");
            let dest = dir.path().join("project.stalx");
            {
                let mut db = Database::open(&source).expect("download");
                db.save_project(&Project::new("Downloaded".into(), None))
                    .expect("project");
                let mut old_link = link();
                old_link.endpoint = "https://old.example.com".into();
                old_link.undo_mode = Some(UndoMode::Disabled);
                db.save_speleo_link(Some(&old_link))
                    .expect("old identity and undo policy");
            }
            {
                let mut db = Database::open(&dest).expect("cache");
                db.save_project(&Project::new("Previous".into(), None))
                    .expect("project");
                db.save_display_setting("test_view", "local").expect("view");
            }
            AppState::new()
                .expect("state")
                .install_linked_download(
                    &source,
                    &dest,
                    link(),
                    LocalEditsPolicy::Protect,
                    InheritedUndo::Drop,
                )
                .expect("install");
            let db = Database::open_existing(&dest).expect("installed");
            let actual = db.load_speleo_link().expect("link").expect("linked");
            assert_eq!(actual.endpoint, "https://example.com");
            assert_eq!(actual.base_commit_sha.as_deref(), Some("abc123"));
            assert_eq!(actual.undo_mode, Some(UndoMode::Disabled));
            assert_eq!(
                db.load_display_settings()
                    .expect("view")
                    .get("test_view")
                    .map(String::as_str),
                Some("local")
            );
        });
    }
}
