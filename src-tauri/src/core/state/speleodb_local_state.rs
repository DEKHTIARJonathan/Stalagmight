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

/// Read one cached `.stalx`'s SpeleoDB link state, read-only and best-effort.
///
/// Returns the default ("no local copy") for a missing, unreadable, corrupt or
/// unlinked file: the caller is painting a list, so a single bad file must cost
/// only its own row. A corrupt cache genuinely has no state that can be pushed or
/// reconciled, so reporting it as absent is also the safe answer for the UI - it
/// offers a plain re-pull instead of a push.
fn local_state_at(path: &Path) -> SpeleoLocalProjectState {
    let link = match Database::open_for_metadata(path).and_then(|db| db.load_speleo_link()) {
        Ok(Some(link)) => link,
        // No link row: a `.stalx` sitting in the cache that is not a managed
        // project. Nothing to report, and nothing to push.
        Ok(None) => return SpeleoLocalProjectState::default(),
        Err(e) => {
            tracing::debug!(
                path = %path.display(),
                error = %e,
                purpose = "report local SpeleoDB state for a project list",
                "speleodb: cached .stalx could not be read; reporting no local state"
            );
            return SpeleoLocalProjectState::default();
        }
    };
    SpeleoLocalProjectState {
        has_local_copy: true,
        has_unpushed_edits: link.has_unpushed_edits,
        last_edit_at: link.last_edit_at,
        is_open: false,
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
    pub(super) fn local_copy_state(
        &self,
        project_id: &str,
        dest: &Path,
    ) -> SpeleoLocalProjectState {
        let on_disk = local_state_at(dest);
        let Some(live) = self
            .speleodb_open_link()
            .ok()
            .filter(|l| l.project_id == project_id)
        else {
            return on_disk;
        };
        SpeleoLocalProjectState {
            has_local_copy: true,
            has_unpushed_edits: live.has_unpushed_edits || on_disk.has_unpushed_edits,
            last_edit_at: live.last_edit_at.or(on_disk.last_edit_at),
            is_open: true,
        }
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
}
