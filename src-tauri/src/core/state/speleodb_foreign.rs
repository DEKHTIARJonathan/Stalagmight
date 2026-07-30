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

use std::path::{Path, PathBuf};

use super::speleodb::local_dto;
use super::AppState;
use crate::core::loading::SpeleoManagedFile;
use crate::persistence::Database;
use crate::speleodb::{SpeleoDbError, SpeleoErrorDto};

/// What the probe established about the spelling the load was handed.
///
/// Three answers rather than two, because "this IS the canonical copy" and "this
/// is the canonical copy under a name that a save would destroy" are different
/// facts - see [`LinkedSpelling::Canonical`].
#[derive(Debug)]
pub(super) enum LinkedSpelling {
    /// Open the path exactly as it was spelled: an unmanaged project, or the
    /// cache copy reached by a spelling that keeps resolving to it on every
    /// access (a `..` segment, a symlinked parent directory, a Windows case
    /// variant).
    AsSpelled,
    /// The cache copy reached through a symlink AS THE FINAL COMPONENT: open the
    /// carried canonical cache path instead of the spelling that was asked for.
    Canonical(PathBuf),
    /// A second local copy of a managed project: refuse the open, and hand the
    /// frontend this payload for its prompt.
    Foreign(SpeleoManagedFile),
}

/// Whether `path` may be opened, and under which spelling.
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
/// - **A symlink whose target IS the cache copy**: not refused, but the load is
///   redirected to the real cache path ([`LinkedSpelling::Canonical`]). It is
///   the same file to READ - `is_the_cached_copy` follows the link and rightly
///   says yes - and not the same file to WRITE: every save writes a temp sibling
///   and renames it over the destination, and that rename replaces the SYMLINK
///   ENTRY with a regular file. Opening the link by name would therefore leave
///   the cached copy stale at the first implicit save while a brand new linked
///   `.stalx` appeared wherever the link lived, which is two local copies of one
///   remote project - the exact shape this module exists to prevent. Redirecting
///   is better than refusing here: the file behind the link genuinely is the
///   canonical copy, and refusing it would offer "open the managed copy from
///   SpeleoDB" for a copy the user already has.
///
///   Only the FINAL component is treated this way. A symlinked parent DIRECTORY
///   is harmless and stays as spelled, because the rename resolves through it
///   into the real directory and lands on the real entry.
pub(super) fn foreign_link_in(root: Option<&Path>, path: &Path) -> LinkedSpelling {
    let Some(link) = Database::open_for_metadata(path)
        .and_then(|db| db.load_speleo_link())
        .ok()
        .flatten()
    else {
        return LinkedSpelling::AsSpelled;
    };
    let valid_id = super::speleodb::validate_project_id(&link.project_id).is_ok();
    let Some(root) = root else {
        return LinkedSpelling::AsSpelled;
    };
    if valid_id && super::speleodb_local_state::is_the_cached_copy(root, &link.project_id, path) {
        return if final_component_is_a_symlink(path) {
            LinkedSpelling::Canonical(super::speleodb_local_state::cache_path_in(
                root,
                &link.project_id,
            ))
        } else {
            LinkedSpelling::AsSpelled
        };
    }
    LinkedSpelling::Foreign(SpeleoManagedFile {
        path: path.display().to_string(),
        project_id: link.project_id,
        project_name: link.project_name,
        endpoint: link.endpoint,
        can_open_remote: valid_id,
    })
}

/// Whether the LAST component of `path` is itself a symlink.
///
/// `symlink_metadata` follows every parent component but NOT the final one,
/// which is exactly the distinction that matters to the save pipeline: a rename
/// resolves parent directory links and lands on the real entry, so a symlinked
/// parent is safe; the final component is the entry the rename REPLACES.
///
/// A path that cannot be stat'ed answers false: the probe already read a link
/// row out of it, so an error here is a race or a permission quirk, and the open
/// a few lines later reports it far better than a canonical-storage refusal
/// would.
fn final_component_is_a_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_symlink())
}

impl AppState {
    /// [`foreign_link_in`] against the production cache root. See
    /// [`LinkedSpelling`]: the open is refused, redirected to the canonical
    /// cache path, or left alone.
    pub(super) fn foreign_link(&self, path: &Path) -> LinkedSpelling {
        foreign_link_in(super::speleodb_local_state::cache_root().as_deref(), path)
    }

    /// Turn the foreign managed copy at `path` into a plain unmanaged project by
    /// deleting its `speleo_link` row. The counterpart for the OPEN project is
    /// `speleodb_unlink`, which also releases the held write lock and moves the
    /// edit gates; `path` here is a file this session does not have open, so
    /// there is no lock and no gate to move.
    ///
    /// `open_existing` rather than the metadata probe: this DOES mutate the
    /// file, so it should refuse one that is not a Stalagmight project and run
    /// the same integrity check + migration a real open would - a corrupt file
    /// is reported instead of half-edited. The handle drops before returning,
    /// which matters on Windows: the frontend reopens this very file right
    /// afterwards, and SQLite holds it without FILE_SHARE_DELETE.
    ///
    /// The row delete itself is idempotent (`DELETE FROM speleo_link`), so a
    /// second invocation - or one against a file whose link is already gone -
    /// succeeds harmlessly.
    pub(crate) fn speleodb_remove_link_at(&self, path: PathBuf) -> Result<(), SpeleoErrorDto> {
        if self
            .open_project_path()
            .is_some_and(|open| super::project_io::same_file(&open, &path))
        {
            return Err(local_dto(SpeleoDbError::Io(
                "that file is the project currently open; detach it from SpeleoDB instead"
                    .to_owned(),
            )));
        }
        let db = Database::open_existing(&path)
            .map_err(|e| local_dto(SpeleoDbError::Io(e.to_string())))?;
        db.save_speleo_link(None)
            .map_err(|e| local_dto(SpeleoDbError::Io(e.to_string())))?;
        tracing::info!(
            path = %path.display(),
            purpose = "keep one local copy per SpeleoDB project",
            "Removed the SpeleoDB link from a foreign copy"
        );
        Ok(())
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

    /// The refusal payload, or `None` when the probe accepted the file (under
    /// either spelling).
    fn refusal(spelling: LinkedSpelling) -> Option<SpeleoManagedFile> {
        match spelling {
            LinkedSpelling::Foreign(managed) => Some(managed),
            LinkedSpelling::AsSpelled | LinkedSpelling::Canonical(_) => None,
        }
    }

    /// Whether the probe accepted the file under the spelling it was given.
    fn accepted_as_spelled(spelling: &LinkedSpelling) -> bool {
        matches!(spelling, LinkedSpelling::AsSpelled)
    }

    #[test]
    fn a_linked_stalx_outside_the_cache_is_refused() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("cache");
        let foreign = temp.path().join("elsewhere").join("copy.stalx");
        seed_linked(&foreign, ID);

        let managed = refusal(foreign_link_in(Some(&root), &foreign))
            .expect("a foreign linked file is refused");
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
            accepted_as_spelled(&foreign_link_in(Some(root), &cached)),
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
            accepted_as_spelled(&foreign_link_in(Some(root), &aliased)),
            "an alias spelling of the cache path is still the cache copy"
        );

        #[cfg(unix)]
        {
            // The cache root reached through a symlink is still the same file -
            // and is left AS SPELLED, unlike a symlinked final component: a
            // rename resolves the directory link and still lands on the real
            // entry in the real directory, so nothing here needs rewriting.
            let sym_root = temp.path().join("sym-root");
            std::os::unix::fs::symlink(root, &sym_root).expect("symlink");
            let through_symlink = super::super::speleodb_local_state::cache_path_in(&sym_root, ID);
            assert!(
                accepted_as_spelled(&foreign_link_in(Some(root), &through_symlink)),
                "the cache copy through a symlinked root is still the cache copy"
            );
        }
    }

    /// A symlink to the cache copy is the cache copy to READ, and the probe used
    /// to stop there and accept the link's own name. Saving through that name is
    /// what breaks: the save writes a temp sibling and renames it over the
    /// destination, so the rename replaces the SYMLINK ENTRY with a regular file.
    /// The real cached copy is then stale forever and a second linked `.stalx`
    /// exists wherever the link lived - two local copies of one remote project,
    /// which is precisely what this module exists to prevent.
    #[cfg(unix)]
    #[test]
    fn a_symlink_to_the_cache_copy_opens_the_real_cache_path_instead() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("cache");
        let cached = super::super::speleodb_local_state::cache_path_in(&root, ID);
        seed_linked(&cached, ID);

        let alias = temp.path().join("my-project.stalx");
        std::os::unix::fs::symlink(&cached, &alias).expect("symlink");

        let spelling = foreign_link_in(Some(&root), &alias);
        assert!(
            matches!(&spelling, LinkedSpelling::Canonical(real) if real == &cached),
            "the load must be redirected to the real cache path, not the link: {spelling:?}"
        );
    }

    /// The same rewrite when the CACHE SLOT ITSELF is the symlink (the user
    /// pointed it at a file of their own). The canonical path is the slot, so the
    /// answer is the path we were given - and the first save materialises the real
    /// file in the slot, exactly as a pull's atomic replace would. The old target
    /// is then an ordinary foreign copy, refused by this same probe.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_cache_slot_still_resolves_to_the_canonical_path() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("cache");
        let cached = super::super::speleodb_local_state::cache_path_in(&root, ID);
        let elsewhere = temp.path().join("elsewhere").join("real.stalx");
        seed_linked(&elsewhere, ID);
        std::fs::create_dir_all(cached.parent().expect("parent")).expect("mkdir");
        std::os::unix::fs::symlink(&elsewhere, &cached).expect("symlink");

        let spelling = foreign_link_in(Some(&root), &cached);
        assert!(
            matches!(&spelling, LinkedSpelling::Canonical(real) if real == &cached),
            "the canonical slot is the canonical path even when it is a link: {spelling:?}"
        );
    }

    /// The redirect is for the CACHE COPY only: a link that points at some other
    /// linked `.stalx` is still a second local copy, and is still refused - under
    /// the name the user asked for, so the prompt names the file they picked.
    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_foreign_linked_file_is_still_refused() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("cache");
        let foreign = temp.path().join("elsewhere").join("copy.stalx");
        seed_linked(&foreign, ID);

        let alias = temp.path().join("my-project.stalx");
        std::os::unix::fs::symlink(&foreign, &alias).expect("symlink");

        let managed = refusal(foreign_link_in(Some(&root), &alias))
            .expect("a symlink to a foreign copy is still a second local copy");
        assert_eq!(
            managed.path,
            alias.display().to_string(),
            "the refusal names the file the user asked for"
        );
        assert_eq!(managed.project_id, ID);
    }

    #[test]
    fn a_copy_in_the_wrong_project_folder_is_refused() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path();
        // Sitting at OTHER_ID's slot while its link claims ID: inside the cache
        // tree, but NOT the canonical home of the project it names.
        let misfiled = super::super::speleodb_local_state::cache_path_in(root, OTHER_ID);
        seed_linked(&misfiled, ID);

        let managed = refusal(foreign_link_in(Some(root), &misfiled))
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
            accepted_as_spelled(&foreign_link_in(Some(temp.path()), &plain)),
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
            accepted_as_spelled(&foreign_link_in(Some(temp.path()), &junk)),
            "an unreadable file is the corruption path's problem, not this probe's"
        );
    }

    #[test]
    fn a_non_uuid_project_id_is_refused_with_the_remote_action_withheld() {
        let temp = tempfile::TempDir::new().expect("temp");
        let foreign = temp.path().join("bad-id.stalx");
        seed_linked(&foreign, "../../../etc/passwd");

        let managed = refusal(foreign_link_in(Some(temp.path()), &foreign))
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
            accepted_as_spelled(&foreign_link_in(None, &foreign)),
            "with no cache directory there is no canonical slot to conflict with"
        );
    }

    #[test]
    fn remove_link_at_clears_the_row_and_leaves_the_project_readable() {
        let temp = tempfile::TempDir::new().expect("temp");
        let foreign = temp.path().join("copy.stalx");
        seed_linked(&foreign, ID);
        let state = AppState::new().expect("state");

        state
            .speleodb_remove_link_at(foreign.clone())
            .expect("removing the link from a closed foreign copy succeeds");

        let db = Database::open_for_metadata(&foreign).expect("reopen");
        assert_eq!(
            db.load_speleo_link().expect("read link"),
            None,
            "the link row is gone"
        );
        drop(db);
        let db = Database::open_existing(&foreign).expect("full open still works");
        assert_eq!(
            db.load_project().expect("project still loads").name,
            "Linked",
            "the project data is untouched"
        );

        // Idempotent: a second removal (nothing left to delete) still succeeds.
        state
            .speleodb_remove_link_at(foreign)
            .expect("a second removal is a harmless no-op");
    }

    #[test]
    fn remove_link_at_refuses_the_open_project() {
        let temp = tempfile::TempDir::new().expect("temp");
        let open_path = temp.path().join("open.stalx");
        seed_linked(&open_path, ID);
        let state = AppState::new().expect("state");
        assert!(
            state.open_project(open_path.clone()).success,
            "fixture opens"
        );

        state
            .speleodb_remove_link_at(open_path.clone())
            .expect_err("the open project must detach via speleodb_unlink instead");

        let db = Database::open_for_metadata(&open_path).expect("reopen");
        assert!(
            db.load_speleo_link().expect("read link").is_some(),
            "the refusal must not have touched the row"
        );
    }

    #[test]
    fn remove_link_at_reports_a_file_that_is_not_a_project() {
        let temp = tempfile::TempDir::new().expect("temp");
        let junk = temp.path().join("junk.stalx");
        std::fs::write(&junk, b"not a database at all").expect("write junk");
        let state = AppState::new().expect("state");

        state
            .speleodb_remove_link_at(junk)
            .expect_err("a file that is not a Stalagmight project is reported, not half-edited");
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
