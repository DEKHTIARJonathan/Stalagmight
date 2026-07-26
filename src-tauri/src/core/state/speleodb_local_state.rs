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
//!    link-less file degrades to a "nothing to act on" row and the walk continues.
//!    An unreadable one is degraded WITH `state_unknown` set, so the frontend can
//!    tell "there is no local copy" from "there is one and I could not read it" -
//!    the guard below fails closed on that same input, and the two must not
//!    silently disagree.
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
///   row - it degrades to a "nothing to act on" row flagged `state_unknown`.
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
        state_unknown: false,
    })
}

/// The row an unreadable file degrades to: nothing is claimed about it, and
/// `state_unknown` says so out loud.
///
/// `has_local_copy` stays FALSE - there is no state the caller can act on - but the
/// flag is what stops a consumer reading that as "clean". Without it the listing
/// (which fails open) and the replace guard (which fails closed) reported the same
/// file as clean and as unknown respectively, with nothing on the wire to reveal
/// the disagreement: the held-lock prompt then offered an irreversible "Release
/// lock" over a copy whose un-pushed work simply could not be read.
fn unknown_local_state() -> SpeleoLocalProjectState {
    SpeleoLocalProjectState {
        state_unknown: true,
        ..SpeleoLocalProjectState::default()
    }
}

/// [`read_local_state_at`] for the LISTING, which fails open: an unreadable file
/// degrades to a "nothing to act on" row so a single bad file costs only its own
/// row - flagged [`SpeleoLocalProjectState::state_unknown`] so the frontend renders
/// it as unknown rather than clean.
fn local_state_at(path: &Path) -> SpeleoLocalProjectState {
    match read_local_state_at(path) {
        LocalRead::Known(state) => state,
        LocalRead::Unreadable => unknown_local_state(),
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
                // The LIVE link stands in for a file we cannot read - but ONLY when
                // it is first-hand knowledge of THIS file. Matching on the project id
                // alone was not enough: the same project can be open from outside the
                // cache (Save-As carries the `speleo_link` row forward), so a clean
                // live link for project P waived the guard over an unreadable CACHE
                // copy of P that a read-write open might have recovered. Two
                // different files, one of them unread, and the replace went ahead.
                //
                // Both halves have to hold - the id (this project) and the path (this
                // very file) - or the answer is genuinely unknown and the guard fails
                // closed.
                let live = live.filter(|_| {
                    self.open_project_path()
                        .is_some_and(|open| super::project_io::same_file(&open, dest))
                })?;
                return Some(SpeleoLocalProjectState {
                    has_local_copy: true,
                    has_unpushed_edits: live.has_unpushed_edits,
                    last_edit_at: live.last_edit_at,
                    is_open: true,
                    state_unknown: false,
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
            state_unknown: false,
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
                    state_unknown: false,
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

/// Every project directory under the cache root that holds a linked `.stalx` -
/// plus the ones whose `.stalx` is there but could not be read. Directory names are
/// validated as project ids (the cache is written by this app, but a stray
/// directory must not become a project row), and an unreadable cache root simply
/// yields nothing.
///
/// The unreadable rows are KEPT (flagged `state_unknown`) rather than filtered out:
/// dropping them told the caller "this machine holds no copy of that project",
/// which is exactly the claim the read failed to establish - and it is the claim
/// under which the held-lock prompt offers to release the lock.
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
            (state.has_local_copy || state.state_unknown).then_some((id, state))
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

        // The scan still reports the good one - one unreadable file may never blank
        // the rest of the list.
        let scanned = state.speleodb_local_project_states_in(Some(root), None);
        assert!(
            scanned.get(ID_A).is_some_and(|s| s.has_unpushed_edits),
            "one unreadable file must not blank the rest of the list"
        );
        // UPDATED: the corrupt entry used to be DROPPED from the scan entirely, and an
        // explicitly-asked corrupt id used to be indistinguishable from an absent one
        // (`SpeleoLocalProjectState::default()`). Both claimed "this machine holds no
        // copy of that project" - which is exactly the claim the read failed to
        // establish, and exactly the claim under which the held-lock prompt offers an
        // irreversible "Release lock". So an unreadable file now keeps its row and
        // carries `state_unknown`.
        let corrupt_row = scanned.get(ID_B).expect("the corrupt entry keeps its row");
        assert!(
            corrupt_row.state_unknown && !corrupt_row.has_local_copy,
            "and says its state is UNKNOWN rather than clean: {corrupt_row:?}"
        );

        // Asked about explicitly, corrupt and absent are now DIFFERENT answers.
        let missing_id = "33333333-3333-3333-3333-333333333333";
        let asked = state.speleodb_local_project_states_in(
            Some(root),
            Some(vec![ID_B.to_owned(), missing_id.to_owned()]),
        );
        let corrupt = asked.get(ID_B).expect("an explicit id gets a row");
        assert!(
            corrupt.state_unknown,
            "a present-but-unreadable copy reports unknown: {corrupt:?}"
        );
        assert_eq!(
            asked
                .get(missing_id)
                .expect("an explicitly requested id gets a row"),
            &SpeleoLocalProjectState::default(),
            "an ABSENT copy is the genuine 'nothing here' - known, and not unknown"
        );
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
            "the listing degrades to a 'nothing to act on' row: {row:?}"
        );
        // ...but it SAYS SO. The two consumers disagreeing is fine; disagreeing with
        // nothing on the wire to reveal it is not. The held-lock prompt offers an
        // irreversible "Release lock" for any row that reports clean, and the likely
        // cause of an unreadable copy - a hot journal from a kill or power loss - IS
        // the abandoned session that raises that prompt, so a row that merely looked
        // clean got Release offered over work that could not be read.
        assert!(
            row.state_unknown,
            "the listing must flag the row UNKNOWN, not clean: {row:?}"
        );

        assert!(
            state.local_copy_state(ID_A, &path).is_none(),
            "and the guard's reader reports UNKNOWN, so it can fail closed"
        );

        // A file that is simply not there is different: there is nothing to lose, so
        // the guard must still allow a first pull - and the row must NOT be flagged
        // unknown, or every never-pulled project would render as unknown.
        let missing = cache_path_in(root, ID_B);
        assert!(
            state
                .local_copy_state(ID_B, &missing)
                .is_some_and(|s| !s.has_unpushed_edits && !s.state_unknown),
            "an absent copy is KNOWN-clean, not unknown"
        );
        let absent_row = state
            .speleodb_local_project_states_in(Some(root), Some(vec![ID_B.to_owned()]))
            .remove(ID_B)
            .expect("the absent id was asked for explicitly");
        assert!(
            !absent_row.state_unknown,
            "and the listing agrees: absent is known, not unknown"
        );
    }

    #[test]
    fn a_legacy_cached_stalx_reads_as_a_known_local_copy_not_as_unreadable() {
        // A `.stalx` pulled by an older build has a NARROWER `speleo_link` table, and
        // `open_for_metadata` runs no migration - so the reader used to fail it with
        // `no such column` and the failure landed in the Unreadable branch. That
        // wedged the project permanently in both directions at once: the guard refused
        // every pull / adopt / revision-restore with a factually wrong "has local edits
        // that were never pushed", while the cache scan claimed there was no local copy
        // at all. Neither statement was true, and neither could be cleared by anything
        // the user could do.
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path();
        let path = seed_cache(root, ID_A, false);
        // Rebuild the link table in its pre-v10 shape, as an older build wrote it.
        let conn = rusqlite::Connection::open(&path).expect("open to narrow the table");
        conn.execute_batch(
            "DROP TABLE speleo_link;
             CREATE TABLE speleo_link (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 endpoint TEXT NOT NULL,
                 project_id TEXT NOT NULL,
                 project_name TEXT NOT NULL,
                 base_commit_sha TEXT,
                 has_unpushed_edits INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO speleo_link (id, endpoint, project_id, project_name, base_commit_sha, has_unpushed_edits)
             VALUES (1, 'http://x/', '11111111-1111-1111-1111-111111111111', 'Cached', 'abc123', 0);",
        )
        .expect("narrow the table");
        drop(conn);

        let state = AppState::new().expect("state");
        let row = state
            .speleodb_local_project_states_in(Some(root), Some(vec![ID_A.to_owned()]))
            .remove(ID_A)
            .expect("the id was asked for explicitly");
        assert!(
            row.has_local_copy && !row.state_unknown,
            "a legacy cached copy is a KNOWN local copy: {row:?}"
        );
        assert!(!row.has_unpushed_edits, "and known-clean");

        assert!(
            state
                .local_copy_state(ID_A, &path)
                .is_some_and(|s| !s.has_unpushed_edits),
            "so the guard lets the re-pull through instead of refusing forever"
        );
    }

    #[test]
    fn a_live_link_only_vouches_for_an_unreadable_copy_when_it_is_that_file() {
        // The waiver the fail-closed guard had. In the Unreadable branch the live open
        // link stood in for the file we could not read, matched on the PROJECT ID
        // alone - never on the path. But the same project can be open from outside the
        // cache: Save-As carries the `speleo_link` row forward, so the user can have a
        // clean copy of project P open somewhere of their own while the CACHE copy of P
        // is the one that cannot be read. That clean live link then waived the guard
        // over a completely different file, and the re-pull overwrote it.
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("cache");
        // The CACHE copy of A: present, unreadable, un-vouchable.
        let cached = cache_path_in(&root, ID_A);
        std::fs::create_dir_all(cached.parent().expect("parent")).expect("mkdir");
        std::fs::write(&cached, b"not a sqlite database at all").expect("write junk");

        // A CLEAN copy of the same project, open from elsewhere (the Save-As shape).
        let open_path = temp.path().join("my-copy.stalx");
        let mut db = Database::open(&open_path).expect("open db");
        db.save_project(&Project::new("Mine".to_owned(), None))
            .expect("save project");
        db.save_speleo_link(Some(&SpeleoLink {
            endpoint: "http://x/".to_owned(),
            project_id: ID_A.to_owned(),
            project_name: "Mine".to_owned(),
            base_commit_sha: Some("abc123".to_owned()),
            has_unpushed_edits: false,
            last_edit_at: None,
            last_verify_at: None,
        }))
        .expect("save link");
        drop(db);

        let state = AppState::new().expect("state");
        assert!(
            state.open_project(open_path.clone()).success,
            "open the clean copy from outside the cache"
        );

        assert!(
            state.local_copy_state(ID_A, &cached).is_none(),
            "a live link for a DIFFERENT file must not vouch for the unreadable cache copy"
        );
        // The stand-in itself is intact for the case it was written for: the open
        // project IS the file being asked about.
        assert!(
            state
                .local_copy_state(ID_A, &open_path)
                .is_some_and(|s| !s.has_unpushed_edits),
            "the live link still answers for its own file"
        );
    }
}
