//! Reading what this machine holds LOCALLY for a set of SpeleoDB projects.
//!
//! The server-side scans (the held-lock scan behind the resume prompt, the
//! GlobalView remote project list) know only what SpeleoDB knows: who holds which
//! lock. They cannot answer the question the user actually has - "do I have a copy
//! of that project here, and does it have work I never pushed?" - because that
//! answer lives in the local pull cache. This module supplies that half of the
//! join, so the frontend can offer "push and release" instead of a bare "release".
//!
//! Two rules shape the whole module:
//!
//! 1. **Cheap and read-only.** A cached `.stalx` is opened with
//!    `Database::open_for_metadata` (`SQLITE_OPEN_READ_ONLY`, no integrity check,
//!    no migration, no 256 MB mmap) for a single `SELECT`. Never `open_existing`:
//!    this runs over every cached project to paint a list, and it must not
//!    migrate, write to, or mmap files the user did not ask to open.
//! 2. **One bad file never blanks the list.** A missing, unreadable, corrupt or
//!    link-less file degrades to `SpeleoLocalProjectState::default()` (no local
//!    copy) and the walk continues.
//!
//! The OPEN project is answered from the live open database instead of its file on
//! disk - see [`AppState::speleodb_local_project_states`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::AppState;
use crate::persistence::Database;
use crate::speleodb::models::SpeleoLocalProjectState;

/// The file inside each per-project cache directory.
const CACHE_STALX: &str = "project.stalx";

/// `<cache>/speleodb/` - the root of the per-project pull cache, or `None` before
/// the app dirs are resolved (unit tests, pre-`setup`).
pub(super) fn cache_root() -> Option<PathBuf> {
    crate::app_dirs::cache_dir().map(|c| c.join("speleodb"))
}

/// `<root>/<project_id>/project.stalx` - the cached copy's path under a given
/// cache root. Split from [`cache_root`] so the walk below (and its tests) can run
/// against any root.
pub(super) fn cache_path_in(root: &Path, project_id: &str) -> PathBuf {
    root.join(project_id).join(CACHE_STALX)
}

/// What a read of one cached `.stalx` established.
///
/// The two consumers need OPPOSITE defaults when the read fails, which is why the
/// unknown case is a variant rather than a `default()`:
///
/// - the LISTING paints a row per project, so one bad file must cost only its own
///   row - it degrades to "no local copy" ([`SpeleoLocalProjectState::default`]).
/// - the GUARD decides whether to overwrite the file, so the same absence of
///   information has to make it REFUSE. Reporting an unreadable file as clean let
///   the server copy be pulled over work that a read-write open would have
///   recovered: a hot journal after a kill or power loss cannot be rolled back by
///   a read-only connection (`SQLITE_READONLY_ROLLBACK`), and a transient
///   `SQLITE_BUSY` needs only another writer to be mid-commit.
enum LocalRead {
    /// The file was read. Includes "not a managed project" (no link row) and "not
    /// there at all", both of which genuinely have nothing to push.
    Known(SpeleoLocalProjectState),
    /// The file EXISTS but could not be read, so nothing is known about it - in
    /// particular NOT that it is free of un-pushed edits.
    Unreadable,
}

/// Read one cached `.stalx`'s SpeleoDB link state, read-only and best-effort.
///
/// A missing file is `Known` (there is nothing on disk to lose); an unlinked one is
/// `Known` too (a `.stalx` in the cache that is not a managed project has nothing
/// to push). Only a file that is present and unreadable is `Unreadable`.
fn read_local_state_at(path: &Path) -> LocalRead {
    let link = match Database::open_for_metadata(path).and_then(|db| db.load_speleo_link()) {
        Ok(Some(link)) => link,
        // No link row: a `.stalx` sitting in the cache that is not a managed
        // project. Nothing to report, and nothing to push.
        Ok(None) => return LocalRead::Known(SpeleoLocalProjectState::default()),
        Err(e) => {
            // `try_exists` rather than `exists`: an Err there (a permission denial
            // on a parent component) is itself "cannot tell", and must not be
            // rounded down to "absent".
            let present = path.try_exists().unwrap_or(true);
            tracing::debug!(
                path = %path.display(),
                error = %e,
                present,
                purpose = "report local SpeleoDB state for a project list",
                "speleodb: cached .stalx could not be read"
            );
            return if present {
                LocalRead::Unreadable
            } else {
                LocalRead::Known(SpeleoLocalProjectState::default())
            };
        }
    };
    LocalRead::Known(SpeleoLocalProjectState {
        has_local_copy: true,
        has_unpushed_edits: link.has_unpushed_edits,
        last_edit_at: link.last_edit_at,
        is_open: false,
    })
}

/// [`read_local_state_at`] for the LISTING, which fails open: an unreadable file
/// degrades to "no local copy" so a single bad file costs only its own row.
fn local_state_at(path: &Path) -> SpeleoLocalProjectState {
    match read_local_state_at(path) {
        LocalRead::Known(state) => state,
        LocalRead::Unreadable => SpeleoLocalProjectState::default(),
    }
}

impl AppState {
    /// Per-project local state for the SpeleoDB project ids in `project_ids`, or -
    /// when that is `None` - for every project found in the local pull cache.
    ///
    /// Keyed by project id so the frontend can index the reply directly against a
    /// held-lock scan or a remote project list. Ids that fail the same UUID
    /// validation the edit verbs use are dropped rather than turned into a
    /// filesystem path (they arrive from the webview and are joined into a cache
    /// path); an explicitly requested id with nothing on disk still gets a row, so
    /// the caller can tell "asked, nothing here" from "never asked".
    ///
    /// Never fails: no network, no auth, and every per-file error degrades to a
    /// "no local copy" row.
    pub(crate) fn speleodb_local_project_states(
        &self,
        project_ids: Option<Vec<String>>,
    ) -> HashMap<String, SpeleoLocalProjectState> {
        self.speleodb_local_project_states_in(cache_root().as_deref(), project_ids)
    }

    /// What this machine holds for ONE project at ONE path - the single-file form
    /// of [`Self::speleodb_local_project_states`], for the guard that stands in
    /// front of a download-replace (`AppState::guard_local_edits`). Takes the
    /// destination path explicitly because a replace already knows which file it
    /// is about to overwrite, and that file need not be reachable through the cache
    /// walk (nor the app dirs resolvable at all).
    ///
    /// Reads through the SAME `local_state_at` the listing uses - one reader, one
    /// set of degradation rules - and applies the same live-link rule: the OPEN
    /// project's in-memory link is consulted for this project id because the file
    /// on disk can be staler than the session.
    ///
    /// The two are ORed rather than one winning: a live dirty bit and a dirty copy
    /// at `dest` are BOTH un-pushed work on this machine (they coincide for the
    /// normal case, where the open project IS the cache file), and the guard must
    /// never under-report. `is_open`/`last_edit_at` follow the live link when there
    /// is one, falling back to the file's.
    /// Returns `None` when the file at `dest` exists but could not be read AND the
    /// open project cannot vouch for it - the guard must refuse there rather than
    /// read the silence as "clean" (see [`LocalRead`]).
    pub(super) fn local_copy_state(
        &self,
        project_id: &str,
        dest: &Path,
    ) -> Option<SpeleoLocalProjectState> {
        let read = read_local_state_at(dest);
        let live = self
            .speleodb_open_link()
            .ok()
            .filter(|l| l.project_id == project_id);
        let on_disk = match read {
            LocalRead::Known(state) => state,
            LocalRead::Unreadable => {
                // The LIVE link is first-hand knowledge of this project's dirty bit,
                // read from the open database rather than from the file, so it stands
                // in for a file we cannot read. Only when there is no live link
                // either is the answer genuinely unknown.
                let Some(live) = live else { return None };
                return Some(SpeleoLocalProjectState {
                    has_local_copy: true,
                    has_unpushed_edits: live.has_unpushed_edits,
                    last_edit_at: live.last_edit_at,
                    is_open: true,
                });
            }
        };
        let Some(live) = live else {
            return Some(on_disk);
        };
        Some(SpeleoLocalProjectState {
            has_local_copy: true,
            has_unpushed_edits: live.has_unpushed_edits || on_disk.has_unpushed_edits,
            last_edit_at: live.last_edit_at.or(on_disk.last_edit_at),
            is_open: true,
        })
    }

    /// [`Self::speleodb_local_project_states`] against an explicit cache root
    /// (`None` = the app dirs are not resolved, so only the open project can be
    /// reported). Split out so tests can point the walk at a temp directory.
    fn speleodb_local_project_states_in(
        &self,
        cache_root: Option<&Path>,
        project_ids: Option<Vec<String>>,
    ) -> HashMap<String, SpeleoLocalProjectState> {
        // The OPEN project's live link, read from the open database. This WINS over
        // whatever is on disk for that id, for two reasons: the open project need not
        // be the cache copy at all (an adopted or published `.stalx` lives wherever
        // the user keeps it), and its dirty bit is stamped into the open database on
        // every accepted edit - so the live row is at least as fresh as, and often
        // fresher than, any other copy of that project on this machine.
        let open = self.speleodb_open_link().ok().map(|link| {
            (
                link.project_id,
                SpeleoLocalProjectState {
                    has_local_copy: true,
                    has_unpushed_edits: link.has_unpushed_edits,
                    last_edit_at: link.last_edit_at,
                    is_open: true,
                },
            )
        });

        let explicit = project_ids.is_some();
        let mut out: HashMap<String, SpeleoLocalProjectState> = match project_ids {
            Some(ids) => ids
                .into_iter()
                .filter(|id| super::speleodb::validate_project_id(id).is_ok())
                .map(|id| {
                    let state = cache_root
                        .map(|root| local_state_at(&cache_path_in(root, &id)))
                        .unwrap_or_default();
                    (id, state)
                })
                .collect(),
            None => cache_root.map(scan_cache).unwrap_or_default(),
        };

        // Applied last so the live state overwrites the on-disk row for that id. An
        // open project that is not in the cache at all (an adopted / published
        // `.stalx` the user keeps elsewhere) still joins the unfiltered listing; when
        // ids were requested explicitly it does not, because the caller asked about
        // a specific set.
        if let Some((id, state)) = open {
            if !explicit || out.contains_key(&id) {
                out.insert(id, state);
            }
        }
        out
    }
}

/// Every project directory under the cache root that holds a readable, linked
/// `.stalx`. Directory names are validated as project ids (the cache is written by
/// this app, but a stray directory must not become a project row), and an
/// unreadable cache root simply yields nothing.
fn scan_cache(root: &Path) -> HashMap<String, SpeleoLocalProjectState> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            super::speleodb::validate_project_id(&id).ok()?;
            let state = local_state_at(&cache_path_in(root, &id));
            state.has_local_copy.then_some((id, state))
        })
        .collect()
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "unit test fixtures fail loudly on setup errors"
)]
mod tests {
    use super::*;
    use crate::models::{Project, SpeleoLink};

    const ID_A: &str = "11111111-1111-1111-1111-111111111111";
    const ID_B: &str = "22222222-2222-2222-2222-222222222222";

    /// Write a cached `.stalx` for `project_id` under `root` with the given dirty
    /// bit, and return its path.
    fn seed_cache(root: &Path, project_id: &str, dirty: bool) -> PathBuf {
        let path = cache_path_in(root, project_id);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let mut db = Database::open(&path).expect("open db");
        db.save_project(&Project::new("Cached".to_owned(), None))
            .expect("save project");
        db.save_speleo_link(Some(&SpeleoLink {
            endpoint: "http://x/".to_owned(),
            project_id: project_id.to_owned(),
            project_name: "Cached".to_owned(),
            base_commit_sha: Some("abc123".to_owned()),
            has_unpushed_edits: dirty,
            last_edit_at: dirty.then(|| "2026-07-26T00:00:00Z".to_owned()),
            last_verify_at: None,
        }))
        .expect("save link");
        path
    }

    #[test]
    fn reports_dirty_and_clean_cached_copies() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path();
        seed_cache(root, ID_A, true);
        seed_cache(root, ID_B, false);
        let state = AppState::new().expect("state");

        let all = state.speleodb_local_project_states_in(Some(root), None);
        assert_eq!(all.len(), 2, "both cached projects are reported");
        let a = all.get(ID_A).expect("dirty project reported");
        assert!(a.has_local_copy && a.has_unpushed_edits, "A is dirty");
        assert_eq!(
            a.last_edit_at.as_deref(),
            Some("2026-07-26T00:00:00Z"),
            "the dirty copy carries its edit time"
        );
        assert!(!a.is_open, "nothing is open in this fixture");
        let b = all.get(ID_B).expect("clean project reported");
        assert!(b.has_local_copy && !b.has_unpushed_edits, "B is clean");
    }

    #[test]
    fn missing_and_corrupt_files_report_no_local_state_without_failing() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path();
        seed_cache(root, ID_A, true);
        // A corrupt cache entry for B: a file of the right name that is not SQLite.
        let corrupt = cache_path_in(root, ID_B);
        std::fs::create_dir_all(corrupt.parent().expect("parent")).expect("mkdir");
        std::fs::write(&corrupt, b"not a database at all").expect("write corrupt");
        let state = AppState::new().expect("state");

        // The scan drops the corrupt entry but still reports the good one.
        let scanned = state.speleodb_local_project_states_in(Some(root), None);
        assert!(
            scanned.get(ID_A).is_some_and(|s| s.has_unpushed_edits),
            "one unreadable file must not blank the rest of the list"
        );
        assert!(!scanned.contains_key(ID_B), "corrupt entry is not listed");

        // Asked about explicitly, corrupt and absent both come back as "nothing here".
        let missing_id = "33333333-3333-3333-3333-333333333333";
        let asked = state.speleodb_local_project_states_in(
            Some(root),
            Some(vec![ID_B.to_owned(), missing_id.to_owned()]),
        );
        for id in [ID_B, missing_id] {
            let s = asked
                .get(id)
                .expect("an explicitly requested id gets a row");
            assert_eq!(
                s,
                &SpeleoLocalProjectState::default(),
                "{id} reports no local state"
            );
        }
    }

    #[test]
    fn traversal_ids_are_dropped_before_they_become_paths() {
        let temp = tempfile::TempDir::new().expect("temp");
        let state = AppState::new().expect("state");
        let out = state.speleodb_local_project_states_in(
            Some(temp.path()),
            Some(vec!["../../etc/passwd".to_owned(), ID_A.to_owned()]),
        );
        assert!(
            !out.contains_key("../../etc/passwd"),
            "a non-UUID id never reaches the filesystem"
        );
        assert!(out.contains_key(ID_A), "valid ids are still reported");
    }

    #[test]
    fn open_projects_live_state_wins_over_the_cached_copy() {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("cache");
        // The cached copy of A is CLEAN on disk.
        seed_cache(&root, ID_A, false);
        // The open copy of A lives elsewhere and is dirty.
        let open_path = temp.path().join("open.stalx");
        let mut db = Database::open(&open_path).expect("open db");
        db.save_project(&Project::new("Open".to_owned(), None))
            .expect("save project");
        db.save_speleo_link(Some(&SpeleoLink {
            endpoint: "http://x/".to_owned(),
            project_id: ID_A.to_owned(),
            project_name: "Open".to_owned(),
            base_commit_sha: Some("abc123".to_owned()),
            has_unpushed_edits: true,
            last_edit_at: Some("2026-07-26T12:00:00Z".to_owned()),
            last_verify_at: None,
        }))
        .expect("save link");
        drop(db);

        let state = AppState::new().expect("state");
        assert!(state.open_project(open_path).success, "open the fixture");

        let out = state.speleodb_local_project_states_in(Some(&root), None);
        let a = out.get(ID_A).expect("A reported");
        assert!(
            a.has_unpushed_edits,
            "the live open link wins over the clean file in the cache"
        );
        assert!(a.is_open, "and is flagged as the open project");
        assert_eq!(a.last_edit_at.as_deref(), Some("2026-07-26T12:00:00Z"));
    }
    #[test]
    fn the_listing_fails_open_for_an_unreadable_file_but_the_guard_does_not() {
        // The two consumers need OPPOSITE defaults when a read fails, which is the
        // whole reason `read_local_state_at` reports `Unreadable` instead of a
        // `default()`:
        //
        // - the LISTING paints one row per project, so a single bad file may cost only
        //   its own row and must never blank the list.
        // - the GUARD decides whether to overwrite that very file, so the same absence
        //   of information has to make it REFUSE. Reporting an unreadable file as clean
        //   let the server copy be pulled over work a read-write open would have
        //   recovered (a hot journal after a kill cannot be rolled back by a read-only
        //   connection - SQLITE_READONLY_ROLLBACK; a transient SQLITE_BUSY needs only
        //   another writer mid-commit).
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path();
        let path = cache_path_in(root, ID_A);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, b"not a sqlite database at all").expect("write junk");
        let state = AppState::new().expect("state");

        let out = state.speleodb_local_project_states_in(Some(root), Some(vec![ID_A.to_owned()]));
        let row = out.get(ID_A).expect("the id was asked for explicitly");
        assert!(
            !row.has_local_copy && !row.has_unpushed_edits,
            "the listing degrades to a 'no local copy' row: {row:?}"
        );

        assert!(
            state.local_copy_state(ID_A, &path).is_none(),
            "but the guard's reader reports UNKNOWN, so it can fail closed"
        );

        // A file that is simply not there is different: there is nothing to lose, so
        // the guard must still allow a first pull.
        let missing = cache_path_in(root, ID_B);
        assert!(
            state
                .local_copy_state(ID_B, &missing)
                .is_some_and(|s| !s.has_unpushed_edits),
            "an absent copy is KNOWN-clean, not unknown"
        );
    }
}
