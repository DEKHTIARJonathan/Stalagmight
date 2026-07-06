//! Dive-plan (`.plnx`) orchestration on [`AppState`] (#244): derive the sibling
//! path from the open project, delegate CRUD to [`PlnxStore`], and degrade stale
//! station references on load. The gas inputs are the persisted payload; the
//! reachability field is always recomputed by the caller, never stored.
//!
//! Design: `docs/plans/2026-07-06_dive-plan-persistence.md`.

use chrono::Utc;
use std::path::PathBuf;

use super::AppState;
use crate::models::{
    DivePlan, DivePlanMeta, DivePlanSnapshot, StationKey, StationRef, DIVE_PLAN_SCHEMA_VERSION,
};
use crate::persistence::plnx::{PlnxMeta, PlnxStore};

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

/// Null any station ref that no longer resolves, returning the degraded snapshot
/// and how many refs were dropped. Pure over an injected `exists` predicate so it
/// unit-tests without a full `Project` (the caller passes `resolve_key`).
fn degrade_snapshot(
    mut s: DivePlanSnapshot,
    exists: impl Fn(StationRef) -> bool,
) -> (DivePlanSnapshot, u32) {
    let mut stale = 0u32;
    let mut check = |slot: &mut Option<StationRef>| {
        if let Some(sr) = *slot {
            if !exists(sr) {
                *slot = None;
                stale += 1;
            }
        }
    };
    check(&mut s.origin);
    check(&mut s.endpoint);
    for slot in &mut s.stage_drop_overrides {
        check(slot);
    }
    (s, stale)
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

    /// Load one plan, degrading any station refs that no longer resolve against the
    /// live survey (nulled, and counted into `stale_ref_count`).
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
        let snapshot: DivePlanSnapshot = serde_json::from_str(&row.snapshot_json)
            .map_err(|e| format!("Could not parse the dive plan: {e}"))?;
        let (snapshot, stale_ref_count) = self.degrade_against_project(snapshot)?;
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
        let json = serde_json::to_string(&snapshot)
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

    /// Degrade a snapshot's station refs against the currently open project.
    fn degrade_against_project(
        &self,
        snapshot: DivePlanSnapshot,
    ) -> Result<(DivePlanSnapshot, u32), String> {
        let guard = self
            .project
            .lock()
            .map_err(|_| "Failed to lock project".to_string())?;
        let Some(project) = guard.as_ref() else {
            return Err("No project open.".to_string());
        };
        Ok(degrade_snapshot(snapshot, |sr| {
            let key: StationKey = sr.into();
            project.resolve_key(&key).is_some()
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sr(section: u32, index: u32) -> StationRef {
        StationRef::new(section, index)
    }

    fn diver() -> crate::models::Diver {
        crate::models::Diver {
            rmv_l_per_min: 20.0,
            label: None,
        }
    }

    #[test]
    fn degrade_keeps_resolvable_refs_and_counts_zero() {
        let snap = DivePlanSnapshot {
            origin: Some(sr(1, 0)),
            endpoint: Some(sr(1, 5)),
            diver: diver(),
            cylinders: vec![],
            gas_config: crate::config::GasConfig::default(),
            stage_drop_overrides: vec![Some(sr(2, 3)), None],
        };
        // Everything resolves.
        let (out, stale) = degrade_snapshot(snap, |_| true);
        assert_eq!(stale, 0);
        assert_eq!(out.origin, Some(sr(1, 0)));
        assert_eq!(out.stage_drop_overrides[0], Some(sr(2, 3)));
    }

    #[test]
    fn degrade_nulls_and_counts_stale_refs() {
        let snap = DivePlanSnapshot {
            origin: Some(sr(1, 0)),
            endpoint: Some(sr(9, 9)), // gone
            diver: diver(),
            cylinders: vec![],
            gas_config: crate::config::GasConfig::default(),
            stage_drop_overrides: vec![Some(sr(9, 1)), None, Some(sr(1, 2))],
        };
        // Only section 1 survives; section 9 refs are stale.
        let (out, stale) = degrade_snapshot(snap, |r| r.section_id == 1);
        assert_eq!(stale, 2); // endpoint + one override
        assert_eq!(out.origin, Some(sr(1, 0))); // kept
        assert_eq!(out.endpoint, None); // nulled
        assert_eq!(out.stage_drop_overrides[0], None); // nulled
        assert_eq!(out.stage_drop_overrides[1], None); // stays None (not counted)
        assert_eq!(out.stage_drop_overrides[2], Some(sr(1, 2))); // kept
    }
}
