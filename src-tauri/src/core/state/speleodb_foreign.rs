//! Foreign copies of SpeleoDB-managed projects.
//!
//! The invariant this module enforces: a `.stalx` carrying a `speleo_link` row
//! is usable in exactly one place on this machine - the pull cache,
//! `<cache>/speleodb/<project_id>/project.stalx`. Any other file that carries
//! one is *foreign*: opening it is refused (`do_load_project_full` calls
//! [`AppState::foreign_link`] before it opens the database), and the frontend
//! turns the refusal into a prompt with the two real ways forward - open the
//! managed copy from SpeleoDB, or strip this file's link and open it as a
//! plain local project.
//!
//! Foreign copies exist because Save As used to carry the `speleo_link` row
//! onto whatever destination the user picked. That carry is gone (an explicit
//! destination on a linked project now writes an UNLINKED copy - see
//! `save_project`), but files written by older builds, restored from backups,
//! or received from another machine still hold one, and every one of them is a
//! second local copy of a project whose one true home is the cache. Two copies
//! of the same remote project is exactly the shape the SpeleoDB locking
//! protocol cannot express (`docs/plans/2026-07-30_speleodb-lock-session-races.md`,
//! F8): the lock bookkeeping is keyed by project id alone, so a second copy's
//! session is indistinguishable from the first's.
//!
//! The probe is deliberately read-only (`Database::open_for_metadata`): a
//! refusal must not write a byte to - or migrate, or mmap - a file the user
//! may not want touched.

use std::path::Path;

use super::AppState;
use crate::core::loading::SpeleoManagedFile;
use crate::persistence::Database;

/// The refusal for `path`, or `None` when opening it is fine.
///
/// `root` is the pull-cache root (`speleodb_local_state::cache_root()`), passed
/// explicitly so this is unit-testable against a temp tree without latching the
/// process-global app dirs.
///
/// Degradations, each deliberate:
///
/// - **No link row**: not refused - an unmanaged project.
/// - **Unreadable / not sqlite**: not refused. It cannot become a second
///   *usable* copy (it cannot be opened at all), and the full open a few lines
///   after this probe reports `CORRUPT`/`DATABASE`, which routes to the
///   corruption-recovery UI - strictly better than a "managed by SpeleoDB
///   (project unknown)" prompt. This deliberately differs from
///   `local_copy_state`'s fail-closed rule: that decision is "may I OVERWRITE
///   this file", this one is "may I open it".
/// - **Link row with an invalid project id**: refused, with
///   [`SpeleoManagedFile::can_open_remote`] false. An id that fails the same
///   UUID validation the edit verbs use must never be joined into a cache path
///   (route-traversal guard), so the canonical slot cannot be named and the
///   file cannot be proven to be it; the strip action is still offered so the
///   file is not a dead end.
/// - **`root == None`**: not refused. With no cache directory there is no
///   canonical slot to conflict with and no pull can run; in production the
///   app dirs resolve during `setup`, so this branch is tests / pre-setup only.
pub(super) fn foreign_link_in(root: Option<&Path>, path: &Path) -> Option<SpeleoManagedFile> {
    let link = Database::open_for_metadata(path)
        .and_then(|db| db.load_speleo_link())
        .ok()
        .flatten()?;
    let valid_id = super::speleodb::validate_project_id(&link.project_id).is_ok();
    let root = root?;
    if valid_id && super::speleodb_local_state::is_the_cached_copy(root, &link.project_id, path) {
        return None;
    }
    Some(SpeleoManagedFile {
        path: path.display().to_string(),
        project_id: link.project_id,
        project_name: link.project_name,
        endpoint: link.endpoint,
        can_open_remote: valid_id,
    })
}

impl AppState {
    /// [`foreign_link_in`] against the production cache root. `Some` means the
    /// open must be refused with the carried payload.
    pub(super) fn foreign_link(&self, path: &Path) -> Option<SpeleoManagedFile> {
        foreign_link_in(super::speleodb_local_state::cache_root().as_deref(), path)
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "unit test fixtures fail loudly on setup errors"
)]
mod tests {
    use super::*;
    use crate::models::{Project, SpeleoLink};

    const ID: &str = "11111111-1111-1111-1111-111111111111";
    const OTHER_ID: &str = "22222222-2222-2222-2222-222222222222";

    /// Write a linked `.stalx` at `path` whose `speleo_link` names `project_id`.
    fn seed_linked(path: &Path, project_id: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let mut db = Database::open(path).expect("open db");
        db.save_project(&Project::new("Linked".to_owned(), None))
            .expect("save project");
        db.save_speleo_link(Some(&SpeleoLink {
            endpoint: "http://x/".to_owned(),
            project_id: project_id.to_owned(),
            project_name: "Linked".to_owned(),
            base_commit_sha: Some("abc123".to_owned()),
            has_unpushed_edits: false,
            last_edit_at: None,
            last_verify_at: None,
        }))
        .expect("save link");
    }

    #[test]
    fn a_linked_stalx_outside_the_cache_is_refused() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("cache");
        let foreign = temp.path().join("elsewhere").join("copy.stalx");
        seed_linked(&foreign, ID);

        let managed =
            foreign_link_in(Some(&root), &foreign).expect("a foreign linked file is refused");
        assert_eq!(managed.path, foreign.display().to_string());
        assert_eq!(managed.project_id, ID);
        assert_eq!(managed.project_name, "Linked");
        assert_eq!(managed.endpoint, "http://x/");
        assert!(managed.can_open_remote, "a valid id can be opened remotely");
    }

    #[test]
    fn the_canonical_cache_copy_is_not_refused() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path();
        let cached = super::super::speleodb_local_state::cache_path_in(root, ID);
        seed_linked(&cached, ID);

        assert!(
            foreign_link_in(Some(root), &cached).is_none(),
            "the cache copy is the canonical home and opens normally"
        );
    }

    #[test]
    fn an_alias_spelling_of_the_canonical_copy_is_not_refused() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path();
        let cached = super::super::speleodb_local_state::cache_path_in(root, ID);
        seed_linked(&cached, ID);

        // The same file reached through a `..` segment: literal comparison says
        // "different path", `same_file` canonicalization says "same file".
        let dir = cached.parent().expect("parent");
        let aliased = dir.join("..").join(ID).join("project.stalx");
        assert!(
            foreign_link_in(Some(root), &aliased).is_none(),
            "an alias spelling of the cache path is still the cache copy"
        );

        #[cfg(unix)]
        {
            // The cache root reached through a symlink is still the same file.
            let sym_root = temp.path().join("sym-root");
            std::os::unix::fs::symlink(root, &sym_root).expect("symlink");
            let through_symlink = super::super::speleodb_local_state::cache_path_in(&sym_root, ID);
            assert!(
                foreign_link_in(Some(root), &through_symlink).is_none(),
                "the cache copy through a symlinked root is still the cache copy"
            );
        }
    }

    #[test]
    fn a_copy_in_the_wrong_project_folder_is_refused() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path();
        // Sitting at OTHER_ID's slot while its link claims ID: inside the cache
        // tree, but NOT the canonical home of the project it names.
        let misfiled = super::super::speleodb_local_state::cache_path_in(root, OTHER_ID);
        seed_linked(&misfiled, ID);

        let managed = foreign_link_in(Some(root), &misfiled)
            .expect("a copy in another project's cache slot is refused");
        assert_eq!(managed.project_id, ID);
    }

    #[test]
    fn an_unlinked_stalx_is_not_refused() {
        let temp = tempfile::TempDir::new().expect("temp");
        let plain = temp.path().join("plain.stalx");
        let mut db = Database::open(&plain).expect("open db");
        db.save_project(&Project::new("Plain".to_owned(), None))
            .expect("save project");
        drop(db);

        assert!(
            foreign_link_in(Some(temp.path()), &plain).is_none(),
            "an unmanaged project opens normally from anywhere"
        );
    }

    #[test]
    fn an_unreadable_file_is_refused_by_nothing_so_the_load_can_report_it() {
        let temp = tempfile::TempDir::new().expect("temp");
        let junk = temp.path().join("junk.stalx");
        std::fs::write(&junk, b"not a database at all").expect("write junk");

        // The read really does fail on this input (pinned by
        // `metadata_open_still_propagates_a_genuinely_unreadable_file` in
        // persistence/sqlite/tests.rs) - and the probe still does not refuse:
        // the full open right after it reports CORRUPT through the existing
        // recovery UI, which is the better surface for this file.
        assert!(
            foreign_link_in(Some(temp.path()), &junk).is_none(),
            "an unreadable file is the corruption path's problem, not this probe's"
        );
    }

    #[test]
    fn a_non_uuid_project_id_is_refused_with_the_remote_action_withheld() {
        let temp = tempfile::TempDir::new().expect("temp");
        let foreign = temp.path().join("bad-id.stalx");
        seed_linked(&foreign, "../../../etc/passwd");

        let managed = foreign_link_in(Some(temp.path()), &foreign)
            .expect("a linked file with an unusable id is still refused");
        assert!(
            !managed.can_open_remote,
            "an id that fails validation must never become a cache path or a route"
        );
        assert_eq!(managed.project_id, "../../../etc/passwd");
    }

    #[test]
    fn no_cache_root_refuses_nothing() {
        let temp = tempfile::TempDir::new().expect("temp");
        let foreign = temp.path().join("copy.stalx");
        seed_linked(&foreign, ID);

        assert!(
            foreign_link_in(None, &foreign).is_none(),
            "with no cache directory there is no canonical slot to conflict with"
        );
    }

    #[test]
    fn the_production_load_refuses_a_managed_file_before_it_opens_the_database() {
        // Guarded by ORDER in the source, the `the_pull_runs_the_local_guard_
        // before_it_downloads_the_dump` idiom: a behavioural version would need a
        // Wry AppHandle (`do_load_project_full` hard-requires one), which no unit
        // test has. The ordering is what matters - the probe must run before
        // `open_existing` migrates the file and quick_checks every page.
        let src = include_str!("project_load.rs");
        let start = src
            .find("fn do_load_project_full")
            .expect("the production load is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];
        let probe = body
            .find("self.foreign_link(")
            .expect("the production load must run the canonical-storage probe");
        let open = body
            .find("Database::open_existing(")
            .expect("the production load opens the database");
        assert!(
            probe < open,
            "the canonical-storage refusal must run BEFORE open_existing, not after it"
        );
    }

    #[test]
    fn the_legacy_open_project_is_not_exposed_over_ipc() {
        // `AppState::open_project` deliberately has NO canonical-storage guard
        // (see its doc comment): its one production caller reopens the canonical
        // cache path after a failed replace. That is only sound while the webview
        // cannot reach it, so pin the non-exposure the same way
        // `registry_covers_all_commands` reads the handler block.
        let lib_src = include_str!("../../lib.rs");
        let start = lib_src
            .find("generate_handler![")
            .expect("generate_handler![ not found in lib.rs")
            + "generate_handler![".len();
        let end = start
            + lib_src[start..]
                .find(']')
                .expect("closing ] not found for generate_handler!");
        let block = &lib_src[start..end];
        let exposed = block.lines().any(|line| {
            let trimmed = line.trim();
            !trimmed.starts_with("//")
                && trimmed
                    .rsplit("::")
                    .next()
                    .is_some_and(|name| name.trim_end_matches(',').trim() == "open_project")
        });
        assert!(
            !exposed,
            "open_project gained an IPC registration - it must now run the \
             canonical-storage guard (see AppState::open_project's doc comment)"
        );
    }
}
