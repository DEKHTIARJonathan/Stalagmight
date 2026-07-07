//! Dive-plan (`.plnx`) orchestration on [`AppState`] (#244): derive the sibling path
//! from the open project, delegate CRUD to [`PlnxStore`], and translate between the IPC
//! snapshot (transient positional `StationRef`) and the on-disk form (stable
//! [`StationKey`] anchors). Canonicalizing to `AfterShot(uuid)` on save and re-resolving
//! on load means a saved plan tracks the SAME physical station across survey edits, the
//! way merges/closures/datums already persist references. The gas inputs are the
//! persisted payload; the reachability field is always recomputed by the caller.
//!
//! Design: `docs/plans/2026-07-06_dive-plan-persistence.md`.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::AppState;
use crate::config::GasConfig;
use crate::models::{
    Cylinder, DivePlan, DivePlanMeta, DivePlanSnapshot, Diver, Project, StationKey, StationRef,
    DIVE_PLAN_SCHEMA_VERSION,
};
use crate::persistence::plnx::{PlnxMeta, PlnxStore};

/// Upper bound on a dive-plan name, enforced on the trusted write path independent of
/// the UI input widget (guards an unbounded untrusted string from a hand-edited `.plnx`; #244).
const MAX_PLAN_NAME_CHARS: usize = 200;

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

fn ownership(store: &PlnxStore, ctx: &PlnxContext) -> Result<Ownership, String> {
    let stored = store
        .stored_project_created_at()
        .map_err(|e| format!("Could not read the dive-plan file: {e}"))?;
    Ok(match stored {
        None => Ownership::Fresh,
        Some(s) if s == ctx.project_created_at => Ownership::Owned,
        Some(_) => Ownership::Foreign,
    })
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
    #[serde(default = "default_persisted_diver")]
    diver: Diver,
    #[serde(default)]
    cylinders: Vec<Cylinder>,
    #[serde(default)]
    gas_config: GasConfig,
    #[serde(default)]
    stage_drop_overrides: Vec<Option<StationKey>>,
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
        let Some(stalx) = p.file_path.as_ref() else {
            return Err("Save the project before saving dive plans.".to_string());
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
        let store =
            PlnxStore::open(&ctx.path).map_err(|e| format!("Could not open dive plans: {e}"))?;
        if ownership(&store, &ctx)? == Ownership::Foreign {
            return Ok(Vec::new());
        }
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
        let store =
            PlnxStore::open(&ctx.path).map_err(|e| format!("Could not open dive plans: {e}"))?;
        if ownership(&store, &ctx)? == Ownership::Foreign {
            return Err("These dive plans belong to a different project.".to_string());
        }
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
        // Canonicalize positional refs to stable keys against the live project BEFORE
        // writing, so the plan survives later survey edits (#2).
        let persisted = self.to_persisted(&snapshot)?;
        let json = serde_json::to_string(&persisted)
            .map_err(|e| format!("Could not serialize the dive plan: {e}"))?;
        let store =
            PlnxStore::open(&ctx.path).map_err(|e| format!("Could not open dive plans: {e}"))?;
        match ownership(&store, &ctx)? {
            Ownership::Foreign => {
                return Err(
                    "A dive-plan file for a different project already exists next to this project."
                        .to_string(),
                );
            }
            Ownership::Fresh => store
                .ensure_identity(&ctx.project_created_at, &ctx.project_name)
                .map_err(|e| format!("Could not initialize the dive-plan file: {e}"))?,
            Ownership::Owned => {}
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
        let store =
            PlnxStore::open(&ctx.path).map_err(|e| format!("Could not open dive plans: {e}"))?;
        if ownership(&store, &ctx)? == Ownership::Foreign {
            return Err("These dive plans belong to a different project.".to_string());
        }
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
            diver: snap.diver.clone(),
            cylinders: snap.cylinders.clone(),
            gas_config: snap.gas_config.clone(),
            stage_drop_overrides: snap
                .stage_drop_overrides
                .iter()
                .map(|o| to_key(project, *o))
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
        let stage_drop_overrides = p
            .stage_drop_overrides
            .into_iter()
            .map(|k| from_key(project, k, &mut stale))
            .collect();
        let snapshot = DivePlanSnapshot {
            origin,
            endpoint,
            diver: p.diver,
            cylinders: p.cylinders,
            gas_config: p.gas_config,
            stage_drop_overrides,
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
    fn ownership_reads_fresh_owned_foreign() {
        let store = PlnxStore::in_memory().unwrap();
        assert!(ownership(&store, &ctx("A")).unwrap() == Ownership::Fresh);
        store.ensure_identity("A", "P").unwrap();
        assert!(ownership(&store, &ctx("A")).unwrap() == Ownership::Owned);
        assert!(ownership(&store, &ctx("B")).unwrap() == Ownership::Foreign);
    }

    #[test]
    fn to_key_uses_stable_anchors_not_positional_index() {
        let (project, sec) = project_3_shots();
        // An interior station canonicalizes to AfterShot(uuid) — the stable form — never Index.
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
        // Follows the station to its new index — NOT the old positional index 2.
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
}
