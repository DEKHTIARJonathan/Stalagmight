//! Dive-plan (`.plnx`) orchestration on [`AppState`] (#244): derive the sibling path
//! from the open project, delegate CRUD to [`PlnxStore`], and translate between the IPC
//! snapshot (transient positional `StationRef`) and the on-disk form (stable
//! [`StationKey`] anchors). Canonicalizing to `AfterShot(uuid)` on save and re-resolving
//! on load means a saved plan tracks the SAME physical station across survey edits, the
//! way merges/closures/datums already persist references. The gas inputs are the
//! persisted payload; the reachability field is always recomputed by the caller.
//!
//! Design: `git show de8eef91:docs/plans/2026-07-06_dive-plan-persistence.md` (doc removed from master in #229).

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::AppState;
use crate::config::GasConfig;
use crate::models::{
    Cylinder, DivePlan, DivePlanMeta, DivePlanSnapshot, Diver, MarkedPoint, Project, StationKey,
    StationRef, DIVE_PLAN_SCHEMA_VERSION,
};
use crate::persistence::plnx::{PlnxMeta, PlnxStore};

/// Upper bound on a dive-plan name, enforced on the trusted write path independent of
/// the UI input widget (guards an unbounded untrusted string from a hand-edited `.plnx`; #244).
const MAX_PLAN_NAME_CHARS: usize = 200;

/// Upper bound on a marked point's optional label (#298), enforced on the same trusted
/// write path and for the same reason as [`MAX_PLAN_NAME_CHARS`]: the UI caps its input,
/// but a hand-edited `.plnx` must not be able to smuggle an unbounded string back in.
const MAX_MARKED_LABEL_CHARS: usize = 120;

/// The open project's `.plnx` sibling path plus the identity we stamp/verify it
/// with (`created_at` is immutable, so it survives a file rename).
struct PlnxContext {
    path: PathBuf,
    project_created_at: String,
    project_name: String,
}

/// Whether an existing `.plnx` belongs to the open project.
#[derive(PartialEq, Eq)]
enum Ownership {
    /// No identity stamped yet (a brand-new file we may claim).
    Fresh,
    /// Stamped with this project's `created_at`.
    Owned,
    /// Stamped with a different project (a `.plnx` copied next to an unrelated
    /// project that happens to share the filename) - never read or write it.
    Foreign,
}

/// Classify a stored identity (or its absence) against the open project's identity. Pure
/// so both the pre-open probe path and (if ever needed) a post-open path share one
/// classifier.
fn classify_ownership(stored: Option<String>, ctx: &PlnxContext) -> Ownership {
    match stored {
        None => Ownership::Fresh,
        Some(s) if s == ctx.project_created_at => Ownership::Owned,
        Some(_) => Ownership::Foreign,
    }
}

/// Determine ownership of the `.plnx` at `ctx.path` WITHOUT ever opening it via
/// [`PlnxStore::open`] (which unconditionally initializes schema + `user_version`) -
/// every command must resolve ownership before opening, so a `Foreign` file is never
/// mutated (#244 Copilot finding). A non-existent file is `Fresh` (nothing to protect;
/// the write paths create it via `PlnxStore::open`).
fn probe_ownership(ctx: &PlnxContext) -> Result<Ownership, String> {
    if !ctx.path.exists() {
        return Ok(Ownership::Fresh);
    }
    let stored = PlnxStore::probe_stored_project_created_at(&ctx.path)
        .map_err(|e| format!("Could not read the dive-plan file: {e}"))?;
    Ok(classify_ownership(stored, ctx))
}

fn to_meta(m: PlnxMeta) -> DivePlanMeta {
    DivePlanMeta {
        id: m.id,
        name: m.name,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

fn default_persisted_diver() -> Diver {
    Diver {
        rmv_l_per_min: 20.0,
        label: None,
    }
}

/// On-disk form of a dive plan (#244): identical to the IPC [`DivePlanSnapshot`] except
/// station references are persisted as stable [`StationKey`] anchors (`AfterShot(uuid)`),
/// NOT the transient positional `StationRef`. Canonicalized via [`Project::key_for_ref`]
/// on save and re-resolved via [`Project::resolve_key`] on load, so a plan tracks the
/// same physical station across survey edits. Not an IPC type (no `TS` derive); the wire
/// form stays `StationRef`. Serde-default tolerant like the IPC snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedDivePlanSnapshot {
    #[serde(default)]
    origin: Option<StationKey>,
    #[serde(default)]
    endpoint: Option<StationKey>,
    #[serde(default)]
    waypoints: Vec<StationKey>,
    #[serde(default = "default_persisted_diver")]
    diver: Diver,
    #[serde(default)]
    cylinders: Vec<Cylinder>,
    #[serde(default)]
    gas_config: GasConfig,
    #[serde(default)]
    stage_drop_overrides: Vec<Option<StationKey>>,
    #[serde(default)]
    marked_points: Vec<PersistedMarkedPoint>,
}

/// On-disk form of a [`MarkedPoint`] (#298): the annotated station as a stable anchor.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedMarkedPoint {
    station: StationKey,
    #[serde(default)]
    label: Option<String>,
}

/// Canonicalize a positional ref to a stable key against `project`. A ref that does not
/// resolve at save time (already invalid) drops to `None` rather than persisting a
/// positional value that would silently rebind after an edit.
fn to_key(project: &Project, r: Option<StationRef>) -> Option<StationKey> {
    r.and_then(|sr| project.key_for_ref(sr))
}

/// Resolve a stored key back to a positional ref; a dangling anchor (its shot deleted)
/// increments `stale` and yields `None`.
fn from_key(project: &Project, k: Option<StationKey>, stale: &mut u32) -> Option<StationRef> {
    let key = k?;
    let resolved = project.resolve_key(&key);
    if resolved.is_none() {
        *stale += 1;
    }
    resolved
}

/// Resolve a stored LIST of keys, DROPPING any that no longer anchor (each counted into
/// `stale`). Used for the way points and marked points (#298), where - unlike the single
/// optional origin/endpoint - there is no "null it out" slot: a dangling entry simply
/// leaves the list, and the UI warns off `stale_ref_count`. Dropping is also what keeps a
/// loaded plan safe to compute: the engine treats an unresolvable way point as a hard stall,
/// so carrying a dead one through would blank the whole field on load.
fn from_keys(project: &Project, keys: Vec<StationKey>, stale: &mut u32) -> Vec<StationRef> {
    keys.into_iter()
        .filter_map(|k| from_key(project, Some(k), stale))
        .collect()
}

impl AppState {
    /// Resolve the `.plnx` sibling path + project identity for the open project.
    /// `Err` (user-facing) if no project is open or it has never been saved (no path
    /// to sit a sibling beside).
    fn plnx_context(&self) -> Result<PlnxContext, String> {
        let guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let Some(p) = guard.as_ref() else {
            return Err("No project open.".to_string());
        };
        // A deferred new project HAS a reserved file_path, but nothing was ever
        // written there - and its first implicit save auto-renames on collision
        // (next_available_project_path), which would strand a .plnx already
        // sitting beside the reserved name (#275 B3). No .stalx on disk means
        // there is nowhere to anchor a sidecar yet, so treat it the same as
        // having no path at all; the flag clears on the first successful save.
        let stalx = match p.file_path.as_ref() {
            Some(path) if !self.initial_save_deferred() => path,
            _ => return Err("Save the project before saving dive plans.".to_string()),
        };
        let stem = stalx.file_stem().map_or_else(
            || "dive_plans".to_string(),
            |s| s.to_string_lossy().to_string(),
        );
        let path = match stalx.parent() {
            Some(dir) => dir.join(format!("{stem}.plnx")),
            None => PathBuf::from(format!("{stem}.plnx")),
        };
        Ok(PlnxContext {
            path,
            project_created_at: p.created_at.to_rfc3339(),
            project_name: p.name.clone(),
        })
    }

    /// List the dive plans stored next to the open project. Empty (never an error the
    /// UI must shout about) when there is no saved project, no `.plnx` yet, or the
    /// `.plnx` belongs to a different project.
    pub fn list_dive_plans(&self) -> Result<Vec<DivePlanMeta>, String> {
        let Ok(ctx) = self.plnx_context() else {
            return Ok(Vec::new());
        };
        if !ctx.path.exists() {
            return Ok(Vec::new());
        }
        if probe_ownership(&ctx)? == Ownership::Foreign {
            return Ok(Vec::new());
        }
        let store =
            PlnxStore::open(&ctx.path).map_err(|e| format!("Could not open dive plans: {e}"))?;
        let rows = store
            .list()
            .map_err(|e| format!("Could not read dive plans: {e}"))?;
        Ok(rows.into_iter().map(to_meta).collect())
    }

    /// Load one plan, resolving its stable station keys against the live survey (dangling
    /// anchors are nulled and counted into `stale_ref_count`).
    pub fn load_dive_plan(&self, id: i64) -> Result<DivePlan, String> {
        let ctx = self.plnx_context()?;
        if !ctx.path.exists() {
            return Err("That dive plan no longer exists.".to_string());
        }
        if probe_ownership(&ctx)? == Ownership::Foreign {
            return Err("These dive plans belong to a different project.".to_string());
        }
        let store =
            PlnxStore::open(&ctx.path).map_err(|e| format!("Could not open dive plans: {e}"))?;
        let row = store
            .get(id)
            .map_err(|e| format!("Could not read the dive plan: {e}"))?
            .ok_or_else(|| "That dive plan no longer exists.".to_string())?;
        let persisted: PersistedDivePlanSnapshot = serde_json::from_str(&row.snapshot_json)
            .map_err(|e| format!("Could not parse the dive plan: {e}"))?;
        let (snapshot, stale_ref_count) = self.resolve_persisted(persisted)?;
        Ok(DivePlan {
            meta: to_meta(row.meta),
            snapshot,
            stale_ref_count,
        })
    }

    /// Save (insert when `id` is `None`, else update) a plan next to the open
    /// project, writing the `.plnx` atomically (SQLite transaction).
    pub fn save_dive_plan(
        &self,
        id: Option<i64>,
        name: String,
        snapshot: DivePlanSnapshot,
    ) -> Result<DivePlanMeta, String> {
        let ctx = self.plnx_context()?;
        let name = name.trim();
        if name.is_empty() {
            return Err("Give the dive plan a name.".to_string());
        }
        if name.chars().count() > MAX_PLAN_NAME_CHARS {
            return Err("That dive-plan name is too long.".to_string());
        }
        if snapshot
            .marked_points
            .iter()
            .filter_map(|m| m.label.as_ref())
            .any(|l| l.chars().count() > MAX_MARKED_LABEL_CHARS)
        {
            return Err("A marked-point label is too long.".to_string());
        }
        // Resolve ownership BEFORE opening the store: opening unconditionally initializes
        // schema/user_version, which must never happen to a Foreign file (#244 Copilot
        // finding). Fresh vs Owned is stable across the subsequent open() (identity is only
        // ever stamped, never changed by opening), so the probed value is still valid once
        // we open below.
        let ownership_before_open = probe_ownership(&ctx)?;
        if ownership_before_open == Ownership::Foreign {
            return Err(
                "A dive-plan file for a different project already exists next to this project."
                    .to_string(),
            );
        }
        // Canonicalize positional refs to stable keys against the live project BEFORE
        // writing, so the plan survives later survey edits (#2).
        let persisted = self.to_persisted(&snapshot)?;
        let json = serde_json::to_string(&persisted)
            .map_err(|e| format!("Could not serialize the dive plan: {e}"))?;
        let store =
            PlnxStore::open(&ctx.path).map_err(|e| format!("Could not open dive plans: {e}"))?;
        if ownership_before_open == Ownership::Fresh {
            store
                .ensure_identity(&ctx.project_created_at, &ctx.project_name)
                .map_err(|e| format!("Could not initialize the dive-plan file: {e}"))?;
        }
        let now = Utc::now().to_rfc3339();
        let sv = DIVE_PLAN_SCHEMA_VERSION as i32;
        let meta = match id {
            Some(id) => store
                .update(id, name, &now, sv, &json)
                .map_err(|e| format!("Could not save the dive plan: {e}"))?
                .ok_or_else(|| "That dive plan no longer exists.".to_string())?,
            None => store
                .insert(name, &now, sv, &json)
                .map_err(|e| format!("Could not save the dive plan: {e}"))?,
        };
        Ok(to_meta(meta))
    }

    /// Delete a plan next to the open project.
    pub fn delete_dive_plan(&self, id: i64) -> Result<(), String> {
        let ctx = self.plnx_context()?;
        if !ctx.path.exists() {
            return Err("That dive plan no longer exists.".to_string());
        }
        if probe_ownership(&ctx)? == Ownership::Foreign {
            return Err("These dive plans belong to a different project.".to_string());
        }
        let store =
            PlnxStore::open(&ctx.path).map_err(|e| format!("Could not open dive plans: {e}"))?;
        if !store
            .delete(id)
            .map_err(|e| format!("Could not delete the dive plan: {e}"))?
        {
            return Err("That dive plan no longer exists.".to_string());
        }
        Ok(())
    }

    /// Canonicalize an IPC snapshot's positional refs to stable keys against the open
    /// project (for on-disk persistence).
    fn to_persisted(&self, snap: &DivePlanSnapshot) -> Result<PersistedDivePlanSnapshot, String> {
        let guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let Some(project) = guard.as_ref() else {
            return Err("No project open.".to_string());
        };
        Ok(PersistedDivePlanSnapshot {
            origin: to_key(project, snap.origin),
            endpoint: to_key(project, snap.endpoint),
            waypoints: snap
                .waypoints
                .iter()
                .filter_map(|w| to_key(project, Some(*w)))
                .collect(),
            diver: snap.diver.clone(),
            cylinders: snap.cylinders.clone(),
            gas_config: snap.gas_config.clone(),
            stage_drop_overrides: snap
                .stage_drop_overrides
                .iter()
                .map(|o| to_key(project, *o))
                .collect(),
            marked_points: snap
                .marked_points
                .iter()
                .filter_map(|m| {
                    to_key(project, Some(m.station)).map(|station| PersistedMarkedPoint {
                        station,
                        label: m.label.clone(),
                    })
                })
                .collect(),
        })
    }

    /// Resolve a persisted (key) snapshot back to the IPC (`StationRef`) form against the
    /// open project, nulling dangling anchors and counting them into `stale_ref_count`.
    fn resolve_persisted(
        &self,
        p: PersistedDivePlanSnapshot,
    ) -> Result<(DivePlanSnapshot, u32), String> {
        let guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let Some(project) = guard.as_ref() else {
            return Err("No project open.".to_string());
        };
        let mut stale = 0u32;
        let origin = from_key(project, p.origin, &mut stale);
        let endpoint = from_key(project, p.endpoint, &mut stale);
        let waypoints = from_keys(project, p.waypoints, &mut stale);
        let stage_drop_overrides = p
            .stage_drop_overrides
            .into_iter()
            .map(|k| from_key(project, k, &mut stale))
            .collect();
        let marked_points = p
            .marked_points
            .into_iter()
            .filter_map(|m| {
                from_key(project, Some(m.station), &mut stale).map(|station| MarkedPoint {
                    station,
                    label: m.label,
                })
            })
            .collect();
        let snapshot = DivePlanSnapshot {
            origin,
            endpoint,
            waypoints,
            diver: p.diver,
            cylinders: p.cylinders,
            gas_config: p.gas_config,
            stage_drop_overrides,
            marked_points,
        };
        Ok((snapshot, stale))
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        clippy::expect_used,
        reason = "tests build from known-valid literals; a failed unwrap should fail the test"
    )]
    use super::*;
    use crate::models::{SectionData, ShotData, StationAnchor};
    use tempfile::TempDir;

    fn make_shot() -> ShotData {
        ShotData {
            length: 10.0,
            ..Default::default()
        }
    }

    /// A one-section project with 3 shots (stations 0..=3) and minted shot UUIDs so
    /// `key_for_ref` can anchor to `AfterShot(uuid)`.
    fn project_3_shots() -> (Project, u32) {
        let mut project = Project::new("Test".to_string(), None);
        let sec = project
            .add_section(SectionData {
                shots: vec![make_shot(), make_shot(), make_shot()],
                ..Default::default()
            })
            .id;
        project.ensure_shot_uuids();
        (project, sec)
    }

    fn ctx(created_at: &str) -> PlnxContext {
        PlnxContext {
            path: PathBuf::from("/tmp/unused.plnx"),
            project_created_at: created_at.to_string(),
            project_name: "P".to_string(),
        }
    }

    #[test]
    fn classify_ownership_reads_fresh_owned_foreign() {
        assert!(classify_ownership(None, &ctx("A")) == Ownership::Fresh);
        assert!(classify_ownership(Some("A".to_string()), &ctx("A")) == Ownership::Owned);
        assert!(classify_ownership(Some("A".to_string()), &ctx("B")) == Ownership::Foreign);
    }

    #[test]
    fn probe_ownership_matches_classify_ownership_against_a_real_file() {
        let dir = std::env::temp_dir().join(format!("plnx_ownership_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("owned.plnx");
        let _ = std::fs::remove_file(&path);

        // No file yet => Fresh.
        let ctx_a = PlnxContext {
            path: path.clone(),
            project_created_at: "A".to_string(),
            project_name: "P".to_string(),
        };
        assert!(probe_ownership(&ctx_a).unwrap() == Ownership::Fresh);

        // Stamp it as "A"'s file (via the normal open+ensure_identity path).
        {
            let store = PlnxStore::open(&path).unwrap();
            store.ensure_identity("A", "P").unwrap();
        }
        assert!(probe_ownership(&ctx_a).unwrap() == Ownership::Owned);

        let ctx_b = PlnxContext {
            path,
            project_created_at: "B".to_string(),
            project_name: "P".to_string(),
        };
        assert!(probe_ownership(&ctx_b).unwrap() == Ownership::Foreign);

        let _ = std::fs::remove_file(dir.join("owned.plnx"));
        let _ = std::fs::remove_dir(&dir);
    }

    /// Regression guard for the Copilot #256 finding: every command called
    /// `PlnxStore::open()` (which unconditionally runs `init_schema` +
    /// `set_user_version`) BEFORE checking ownership, so a `Foreign` `.plnx` (one
    /// stamped with a different project's identity) got its schema/pragma silently
    /// touched before being rejected. Proves the fix by asserting the file's bytes
    /// are bit-for-bit unchanged after every command rejects it.
    ///
    /// Prove-via-injection: reverting the `probe_ownership`-before-`open` guard in
    /// `list_dive_plans`/`load_dive_plan`/`save_dive_plan`/`delete_dive_plan` (i.e.
    /// restoring the old open-then-check order) makes this test fail the final byte
    /// comparison, since `PlnxStore::open` on an already-v1-schema file still issues
    /// a `PRAGMA user_version = 1` write even when the value doesn't change.
    #[test]
    fn foreign_plnx_is_never_opened_by_the_dive_plan_commands() {
        let temp = TempDir::new().unwrap();
        let stalx = temp.path().join("cave.stalx");
        let plnx_path = temp.path().join("cave.plnx");

        // A .plnx belonging to a DIFFERENT project ("Owner"), with a plan in it.
        {
            let store = PlnxStore::open(&plnx_path).unwrap();
            store
                .ensure_identity("2020-01-01T00:00:00Z", "Owner")
                .unwrap();
            store
                .insert("Owner's plan", "2020-01-01T00:00:00Z", 1, "{}")
                .unwrap();
        }
        let bytes_before = std::fs::read(&plnx_path).unwrap();

        let state = AppState::new().unwrap();
        let mut project = Project::new("Mine".to_string(), None);
        project.file_path = Some(stalx);
        // Project::new stamps a fresh created_at (now), which differs from the
        // "2020-01-01T00:00:00Z" stamped above => Foreign.
        *state.project.lock().unwrap() = Some(project);

        let list = state.list_dive_plans().unwrap();
        assert!(
            list.is_empty(),
            "a Foreign file's plans must never be listed"
        );

        let load_err = state.load_dive_plan(1).unwrap_err();
        assert!(load_err.contains("different project"), "got: {load_err}");

        let snapshot: DivePlanSnapshot = serde_json::from_str("{}").unwrap();
        let save_err = state
            .save_dive_plan(None, "New".to_string(), snapshot)
            .unwrap_err();
        assert!(save_err.contains("different project"), "got: {save_err}");

        let delete_err = state.delete_dive_plan(1).unwrap_err();
        assert!(
            delete_err.contains("different project"),
            "got: {delete_err}"
        );

        let bytes_after = std::fs::read(&plnx_path).unwrap();
        assert_eq!(
            bytes_before, bytes_after,
            "a Foreign .plnx must not be mutated by ANY dive-plan command"
        );
    }

    /// #275 B3: a deferred new project has a RESERVED file_path that was never
    /// written. Its first implicit save may auto-rename the .stalx on collision,
    /// which would strand any .plnx created beside the reserved name. So while
    /// the initial save is deferred, every dive-plan command must refuse (same
    /// error as the no-path case) and write nothing; once the flag clears (first
    /// successful save), saving works against the real path.
    #[test]
    fn deferred_initial_save_blocks_dive_plan_persistence() {
        let temp = TempDir::new().unwrap();
        let stalx = temp.path().join("reserved.stalx");
        let plnx_path = temp.path().join("reserved.plnx");

        let state = AppState::new().unwrap();
        let mut project = Project::new("Mine".to_string(), None);
        project.file_path = Some(stalx);
        *state.project.lock().unwrap() = Some(project);
        state.set_initial_save_deferred_for_tests(true);

        let snapshot: DivePlanSnapshot = serde_json::from_str("{}").unwrap();
        let save_err = state
            .save_dive_plan(None, "New".to_string(), snapshot.clone())
            .unwrap_err();
        assert!(
            save_err.contains("Save the project"),
            "deferred project must refuse dive-plan saves, got: {save_err}"
        );
        assert!(
            !plnx_path.exists(),
            "no .plnx may be written beside a reserved-but-unwritten .stalx"
        );
        // list degrades to empty (never an error the UI must shout about).
        assert!(state.list_dive_plans().unwrap().is_empty());
        // load and delete route through the same plnx_context chokepoint and
        // must refuse identically while deferred (no ID-first side path).
        let load_err = state.load_dive_plan(1).unwrap_err();
        assert!(
            load_err.contains("Save the project"),
            "deferred project must refuse dive-plan loads, got: {load_err}"
        );
        let delete_err = state.delete_dive_plan(1).unwrap_err();
        assert!(
            delete_err.contains("Save the project"),
            "deferred project must refuse dive-plan deletes, got: {delete_err}"
        );

        // After the first real save the flag clears and persistence works.
        state.set_initial_save_deferred_for_tests(false);
        let meta = state
            .save_dive_plan(None, "New".to_string(), snapshot)
            .unwrap();
        assert_eq!(meta.name, "New");
        assert!(plnx_path.exists(), "post-save the sidecar lands normally");
    }

    #[test]
    fn to_key_uses_stable_anchors_not_positional_index() {
        let (project, sec) = project_3_shots();
        // An interior station canonicalizes to AfterShot(uuid) - the stable form - never Index.
        let key = to_key(&project, Some(StationRef::new(sec, 2))).unwrap();
        assert!(matches!(key.anchor, StationAnchor::AfterShot(_)));
        // Station 0 is the section start.
        let key0 = to_key(&project, Some(StationRef::new(sec, 0))).unwrap();
        assert!(matches!(key0.anchor, StationAnchor::SectionStart));
        // A ref into a non-existent section can't be anchored → None (dropped, not positional).
        assert!(to_key(&project, Some(StationRef::new(sec + 99, 1))).is_none());
    }

    #[test]
    fn round_trip_is_identity_when_the_survey_is_unchanged() {
        let (project, sec) = project_3_shots();
        let mut stale = 0;
        for idx in 0..=3 {
            let key = to_key(&project, Some(StationRef::new(sec, idx)));
            assert_eq!(
                from_key(&project, key, &mut stale),
                Some(StationRef::new(sec, idx))
            );
        }
        assert_eq!(stale, 0);
    }

    #[test]
    fn persisted_key_tracks_the_same_physical_station_across_a_shot_deletion() {
        // THE headline regression (#2): a saved ref must follow its station across a survey
        // edit, not silently rebind to whatever is now at the old index.
        let (mut project, sec) = project_3_shots();
        // Station 2 = the boundary after shot index 1.
        let key = to_key(&project, Some(StationRef::new(sec, 2))).expect("stable key");
        // Delete shot 0: the physical station that was at index 2 is now at index 1.
        project.sections[0].shots.remove(0);
        let mut stale = 0;
        let resolved = from_key(&project, Some(key), &mut stale);
        assert_eq!(stale, 0);
        // Follows the station to its new index - NOT the old positional index 2.
        assert_eq!(resolved, Some(StationRef::new(sec, 1)));
    }

    #[test]
    fn dangling_key_after_a_section_delete_is_nulled_and_counted() {
        let (mut project, sec) = project_3_shots();
        let key = to_key(&project, Some(StationRef::new(sec, 2))).expect("stable key");
        project.sections.clear(); // the whole section (and its anchoring shot) is gone
        let mut stale = 0;
        assert_eq!(from_key(&project, Some(key), &mut stale), None);
        assert_eq!(stale, 1);
    }

    #[test]
    fn from_key_leaves_none_refs_untouched_and_uncounted() {
        let (project, _sec) = project_3_shots();
        let mut stale = 0;
        assert_eq!(from_key(&project, None, &mut stale), None);
        assert_eq!(stale, 0);
    }

    /// A snapshot carrying way points and marked points, for the #298 persistence tests.
    fn snapshot_with_route_points(sec: u32) -> DivePlanSnapshot {
        DivePlanSnapshot {
            origin: Some(StationRef::new(sec, 0)),
            endpoint: Some(StationRef::new(sec, 3)),
            waypoints: vec![StationRef::new(sec, 2)],
            diver: default_persisted_diver(),
            cylinders: Vec::new(),
            gas_config: GasConfig::default(),
            stage_drop_overrides: Vec::new(),
            marked_points: vec![MarkedPoint {
                station: StationRef::new(sec, 2),
                label: Some("photo".to_string()),
            }],
        }
    }

    #[test]
    fn waypoints_and_marked_points_track_their_station_across_a_shot_deletion() {
        // Same headline guarantee the origin/endpoint already had (#244 §2): a saved route point is
        // an anchor, not an index, so a survey edit must move it WITH its physical station rather
        // than silently rebinding it to whatever now sits at the old index. A way point that
        // rebinds is worse than a stale origin - it re-routes the dive.
        let (mut project, sec) = project_3_shots();
        let state = AppState::new().unwrap();
        let persisted = {
            *state.project.lock().unwrap() = Some(project.clone());
            state
                .to_persisted(&snapshot_with_route_points(sec))
                .unwrap()
        };

        // Delete shot 0: the physical station that was at index 2 is now at index 1.
        project.sections[0].shots.remove(0);
        *state.project.lock().unwrap() = Some(project);
        let (snapshot, stale) = state.resolve_persisted(persisted).unwrap();

        assert_eq!(stale, 0);
        assert_eq!(snapshot.waypoints, vec![StationRef::new(sec, 1)]);
        assert_eq!(snapshot.marked_points.len(), 1);
        assert_eq!(snapshot.marked_points[0].station, StationRef::new(sec, 1));
        assert_eq!(snapshot.marked_points[0].label.as_deref(), Some("photo"));
    }

    #[test]
    fn dangling_waypoints_and_marked_points_are_dropped_and_counted() {
        // Unlike the single origin/endpoint slots there is nothing to null out, so a dangling entry
        // leaves the list entirely - and MUST, because the engine treats an unresolvable way point
        // as a hard stall that would blank the whole field on load. It still counts as stale so the
        // UI can warn that the loaded plan is not what was saved.
        let (mut project, sec) = project_3_shots();
        let state = AppState::new().unwrap();
        *state.project.lock().unwrap() = Some(project.clone());
        let persisted = state
            .to_persisted(&snapshot_with_route_points(sec))
            .unwrap();

        project.sections.clear(); // every anchoring shot is gone
        *state.project.lock().unwrap() = Some(project);
        let (snapshot, stale) = state.resolve_persisted(persisted).unwrap();

        assert!(snapshot.waypoints.is_empty());
        assert!(snapshot.marked_points.is_empty());
        // origin + endpoint + way point + marked point all dangled.
        assert_eq!(stale, 4);
    }

    #[test]
    fn over_long_marked_point_label_is_rejected() {
        // The UI caps its input; this is the trusted-write-path guard against a hand-edited .plnx
        // (mirrors the plan-name cap).
        let temp = TempDir::new().unwrap();
        let (mut project, sec) = project_3_shots();
        project.file_path = Some(temp.path().join("cave.stalx"));
        let state = AppState::new().unwrap();
        *state.project.lock().unwrap() = Some(project);

        let mut snapshot = snapshot_with_route_points(sec);
        snapshot.marked_points[0].label = Some("x".repeat(MAX_MARKED_LABEL_CHARS + 1));
        let err = state
            .save_dive_plan(None, "Plan".to_string(), snapshot.clone())
            .unwrap_err();
        assert!(err.contains("label is too long"), "got: {err}");

        // Exactly at the cap is fine - the boundary is inclusive.
        snapshot.marked_points[0].label = Some("x".repeat(MAX_MARKED_LABEL_CHARS));
        assert!(state
            .save_dive_plan(None, "Plan".to_string(), snapshot)
            .is_ok());
    }
}
