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

/// Upper bound on a marked point's optional label (#298). Enforced on BOTH directions: the
/// write path rejects (a buggy or compromised frontend), and the read path truncates - because
/// the threat this actually names, a hand-edited `.plnx`, enters through the READ path, where a
/// write-side check can never see it.
const MAX_MARKED_LABEL_CHARS: usize = 120;

/// Upper bound on a plan's ordered way points (#298). Every way point costs the engine a full
/// extra Dijkstra and can extend the returned route by the whole station count, so an unbounded
/// list from a hand-edited `.plnx` is a compute/memory amplifier, not just untidy data. 64 is far
/// past any real dive (the ballot's use case is "hit this passage on the way") while staying
/// trivially cheap. Enforced on save (reject), on load (truncate), and on the live compute command
/// (reject - see `commands::gas`), so the bound cannot be walked past from any direction.
pub(crate) const MAX_WAYPOINTS: usize = 64;

/// Upper bound on a plan's marked points (#298). They cost nothing in the engine - they never
/// reach it - but each one is a DOM element plus a station lookup on the frontend, so the same
/// hand-edited-file reasoning applies.
const MAX_MARKED_POINTS: usize = 500;

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
    origin: Option<StoredAnchor>,
    #[serde(default)]
    endpoint: Option<StoredAnchor>,
    #[serde(default)]
    waypoints: Vec<StoredAnchor>,
    #[serde(default = "default_persisted_diver")]
    diver: Diver,
    #[serde(default)]
    cylinders: Vec<Cylinder>,
    #[serde(default)]
    gas_config: GasConfig,
    #[serde(default)]
    stage_drop_overrides: Vec<Option<StoredAnchor>>,
    #[serde(default)]
    marked_points: Vec<PersistedMarkedPoint>,
}

/// On-disk form of a [`MarkedPoint`] (#298): the annotated station as a stable anchor.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedMarkedPoint {
    station: StoredAnchor,
    #[serde(default)]
    label: Option<String>,
}

/// A station identified by the shots it SITS BETWEEN, rather than by its position or by which
/// side of one shot it is on (#24).
///
/// This is the sidecar's own storage form. The project's internal cross-references keep using
/// [`StationKey`] - they are rewritten in place by the edits that move them, which a file
/// outside the project cannot be.
///
/// The point is that a station's neighbours do not care which way you walk the section. Station
/// `i` sits between `shots[i-1]` and `shots[i]`; reverse the section and it sits between the
/// same two shots, so the same record still names it. `AfterShot(uuid)` cannot say that: "after"
/// is defined by traversal order, so a reverse silently slides it onto the neighbouring station
/// while it carries on resolving.
///
/// `a`/`b` are the two neighbours as they stood at save time, `None` for the free end of a
/// terminal station. They are NOT ordered - resolution derives the side from the current
/// positions, so it reads the same after a reverse.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PlanAnchor {
    section_id: crate::models::SectionId,
    #[serde(default)]
    a: Option<String>,
    #[serde(default)]
    b: Option<String>,
    /// Which side of `a` the station sat on when it was saved, in TRAVERSAL terms.
    ///
    /// Only consulted when the pair cannot place the station on its own - a terminal station has
    /// no second neighbour, and a deleted partner leaves only one. On its own this bit is
    /// reverse-UNSAFE, which is what `parity` below repairs.
    #[serde(default)]
    after_a: bool,
    /// The section's [`Section::reverse_parity`] when this anchor was written.
    ///
    /// This is what makes the single-neighbour case correct. `after_a` is expressed in traversal
    /// terms, and a reverse flips traversal - so the same observable state ("`a` is at position
    /// 0 and something follows it") is produced by two different histories that need OPPOSITE
    /// answers:
    ///
    /// ```text
    ///   [s0,s1,s2] reversed          -> a at 0, follower present -> station is index 0
    ///   [s0,s1] delete s0, append s2 -> a at 0, follower present -> station is index 1
    /// ```
    ///
    /// The pair alone cannot tell those apart. Comparing this against the section's parity now
    /// can: differing parity means a reverse happened and the side flips; equal parity means it
    /// did not and the saved side is read literally.
    ///
    /// Absent (`false`) on plans written before this field existed, which is correct for them -
    /// no reverse had been recorded against their sections either.
    #[serde(default)]
    parity: bool,
    /// `length.to_bits()` of the sole neighbouring shot, recorded only for a TERMINAL station.
    ///
    /// Turns the one case the pair genuinely cannot survive - splitting that shot - into a
    /// VISIBLE stale reference instead of a silent one-station error. The split keeps the
    /// original UUID on the shortened tail, so afterwards no shot in the file has this station
    /// as an endpoint and nothing can name it; the length necessarily changed, which is what
    /// gives us a detector.
    ///
    /// Read only when the resolved side is no longer at an end of the section - so a plain
    /// prepend or append, which leaves the shot's length alone, keeps resolving exactly as
    /// before, and a reverse is untouched (length is invariant, and `parity` handles the side).
    /// The one false positive is editing this shot's length AND extending that same end before
    /// the plan is next loaded, which yields a "re-pin this" warning rather than a wrong route.
    #[serde(default)]
    terminal_shot_length_bits: Option<u64>,
}

impl PlanAnchor {
    /// Position of a neighbour in the section as it stands now.
    /// Position of a neighbour in the section as it stands now.
    ///
    /// Takes the project's shot-UUID index first, the way `Project::resolve_key` does, and only
    /// falls back to a scan when the index is cold or stale. Without it every anchor cost a full
    /// pass per neighbour - two per station - and a hand-edited `.plnx` full of UUIDs that match
    /// nothing would scan the whole section every time.
    fn position_of(
        project: &Project,
        section: &crate::models::Section,
        uuid: &Option<String>,
    ) -> Option<usize> {
        let uuid = uuid.as_deref()?;
        if let Some(&i) = project.shot_uuid_index.get(&(section.id, uuid.to_string())) {
            // Re-check before trusting it, exactly as `Project::resolve_key` does: a stale
            // entry then costs only the scan below and can never resolve to the wrong shot.
            if section
                .shots
                .get(i as usize)
                .and_then(|sh| sh.uuid.as_deref())
                == Some(uuid)
            {
                return Some(i as usize);
            }
        }
        section
            .shots
            .iter()
            .position(|s| s.uuid.as_deref() == Some(uuid))
    }
}

/// Describe the station at `r` by its neighbouring shots.
fn to_anchor(project: &Project, r: Option<StationRef>) -> Option<StoredAnchor> {
    let r = r?;
    let section = project.get_section(r.section_id)?;
    let i = r.station_index as usize;
    if i > section.shots.len() {
        return None;
    }
    // Station `i` is bounded by the shot before it and the shot after it; either is absent at
    // the ends of the section. A SHOT-LESS section - a GPX waypoint imports as exactly one, a
    // single station with no shots at all - has neither, and that is not an error: `None` on
    // both sides is a complete description of "the only station this section has".
    let before = i.checked_sub(1).and_then(|p| section.shots.get(p));
    let after = section.shots.get(i);
    let a = before.and_then(|s| s.uuid.clone());
    let b = after.and_then(|s| s.uuid.clone());
    if before.is_some() && a.is_none() {
        return None;
    }
    if after.is_some() && b.is_none() {
        return None;
    }
    // A terminal station has exactly one neighbour; record its length so a later split of that
    // shot is detectable (see `terminal_shot_length_bits`). An interior station is placed by the
    // pair and needs no such guard; a shot-less section has no neighbour at all.
    let terminal_shot_length_bits = match (before, after) {
        (Some(shot), None) | (None, Some(shot)) => Some(shot.length.to_bits()),
        _ => None,
    };
    Some(StoredAnchor::Pair(PlanAnchor {
        section_id: r.section_id,
        a,
        b,
        // `a` is the shot BEFORE the station, so the station is on its "after" side.
        after_a: true,
        parity: section.reverse_parity,
        terminal_shot_length_bits,
    }))
}

/// Place a stored anchor against the project as it stands now.
///
/// Two cases, and no others:
///
/// 1. **Both neighbours present** - the station is the end of `a` that FACES `b`, derived from
///    their current positions. Survives a reverse (both move together), shots inserted between
///    them, and a split of either (they simply stop being adjacent; the side is unchanged).
/// 2. **One neighbour present** - a terminal station, or one whose partner was deleted. Take the
///    saved side, flipped when the section's parity says a reverse happened since. Position is
///    NOT consulted: an earlier version inferred the side from "is `a` at an end of the
///    section", which reads the same after a reverse as after a delete-then-append and so was
///    wrong for one of them whichever way it guessed.
///
/// Splitting the shot a terminal anchor names FAILS SAFE rather than guessing. The split gives
/// the new half a fresh UUID and keeps the old one on the shortened tail, so afterwards no shot
/// in the file has that station as an endpoint - nothing is left to anchor to, and any answer
/// would silently land on the split point. `terminal_shot_length_bits` detects it (the tail is
/// necessarily shorter, and the station is no longer at an end of the section) and the reference
/// is reported STALE, so the UI can ask the diver to re-pin it.
fn from_anchor(project: &Project, anchor: &StoredAnchor, stale: &mut u32) -> Option<StationRef> {
    let resolved = resolve_stored(project, anchor);
    if resolved.is_none() {
        *stale += 1;
    }
    resolved
}

fn resolve_anchor(project: &Project, anchor: &PlanAnchor) -> Option<StationRef> {
    let section = project.get_section(anchor.section_id)?;
    let n = section.shots.len();
    let pa = PlanAnchor::position_of(project, section, &anchor.a);
    let pb = PlanAnchor::position_of(project, section, &anchor.b);
    // A reverse since this anchor was written flips what "after" means.
    let flipped = anchor.parity != section.reverse_parity;
    let index = match (pa, pb) {
        // (1) Both present: the station is the end of `a` that faces `b`.
        (Some(pa), Some(pb)) if pa < pb => pa + 1,
        (Some(pa), Some(_)) => pa,
        // (2) One present: the saved side, corrected for orientation.
        (Some(p), None) => {
            if anchor.after_a != flipped {
                p + 1
            } else {
                p
            }
        }
        (None, Some(p)) => {
            if anchor.after_a != flipped {
                p
            } else {
                p + 1
            }
        }
        // Recorded with no neighbours at all: a shot-less section's single station, which needs
        // none. Distinguished from "both neighbours were DELETED" by the stored anchor rather
        // than by the lookup, since a missing uuid and a missing shot both come back as `None`.
        (None, None) if anchor.a.is_none() && anchor.b.is_none() => 0,
        // Neither neighbour survives: nothing left to anchor on.
        (None, None) => return None,
    };
    if index > n {
        return None;
    }
    // Fail SAFE on the one shape the pair cannot survive. If a terminal anchor's station is no
    // longer at an end of the section, the section was extended past it OR its shot was split -
    // and only the split changes that shot's length. A split leaves nothing in the file naming
    // this station, so resolving would silently land on the split point; report it stale
    // instead and let the UI ask for a re-pin.
    if let Some(saved_bits) = anchor.terminal_shot_length_bits {
        let still_terminal = index == 0 || index == n;
        if !still_terminal {
            let moved = pa
                .or(pb)
                .and_then(|p| section.shots.get(p))
                .is_none_or(|shot| shot.length.to_bits() != saved_bits);
            if moved {
                return None;
            }
        }
    }
    Some(StationRef::new(anchor.section_id, index as u32))
}

/// What a `.plnx` row can hold for one station.
///
/// Plans written before #24 store a [`StationKey`] - `{section_id, anchor}`. Those are still
/// read, and still resolve exactly as they always did (including the reverse blind spot), so
/// upgrading cannot lose anyone's route. They are rewritten in the pair form the next time the
/// user saves that plan, which is also when they stop being vulnerable to it.
///
/// `Legacy` is listed FIRST deliberately: `StationKey` REQUIRES an `anchor` or `station_index`
/// field, so only a pre-#24 blob can match it and a pair-form blob falls through. Reversing the
/// order would make `PlanAnchor` - whose fields all default - swallow legacy rows and quietly
/// blank every reference in them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
enum StoredAnchor {
    Legacy(StationKey),
    Pair(PlanAnchor),
}

/// Place a stored station, whichever form it was written in.
fn resolve_stored(project: &Project, stored: &StoredAnchor) -> Option<StationRef> {
    match stored {
        StoredAnchor::Pair(anchor) => resolve_anchor(project, anchor),
        StoredAnchor::Legacy(key) => project.resolve_key(key),
    }
}

/// Resolve a stored anchor; an unplaceable one increments `stale` and yields `None`.
fn from_anchor_opt(
    project: &Project,
    anchor: Option<StoredAnchor>,
    stale: &mut u32,
) -> Option<StationRef> {
    let anchor = anchor?;
    from_anchor(project, &anchor, stale)
}

/// Resolve a stored LIST of anchors, DROPPING any that no longer place (each counted into
/// `stale`). Used for the way points and marked points (#298), where - unlike the single
/// optional origin/endpoint - there is no "null it out" slot: a dangling entry simply leaves the
/// list, and the UI warns off `stale_ref_count`. Dropping is also what keeps a loaded plan safe
/// to compute: the engine treats an unresolvable way point as a hard stall, so carrying a dead
/// one through would blank the whole field on load.
fn from_anchors(project: &Project, anchors: Vec<StoredAnchor>, stale: &mut u32) -> Vec<StationRef> {
    anchors
        .into_iter()
        .filter_map(|a| from_anchor(project, &a, stale))
        .collect()
}

/// Truncate to at most `max` CHARACTERS (not bytes), so a multi-byte label can never be cut
/// mid-scalar into invalid text.
fn truncate_chars(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    s.chars().take(max).collect()
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
        if snap.waypoints.len() > MAX_WAYPOINTS {
            return Err("That plan has too many way points.".to_string());
        }
        if snap.marked_points.len() > MAX_MARKED_POINTS {
            return Err("That plan has too many marked points.".to_string());
        }
        // A route point that no longer anchors is REFUSED, not dropped. Dropping is what the load
        // path does (there is no empty slot in a list), but on save it would be data loss the user
        // is never told about: the frontend rebaselines its dirty check on the snapshot it SENT, so
        // the plan would read "saved" while the file on disk quietly held a shorter route. Refusing
        // keeps the file and the panel in agreement, and matches the engine's own doctrine that a
        // way point is a constraint rather than a hint.
        let waypoints = snap
            .waypoints
            .iter()
            .map(|w| {
                to_anchor(project, Some(*w)).ok_or_else(|| {
                    "A way point in this plan no longer exists in the survey. Remove it from the \
                     route and save again."
                        .to_string()
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let marked_points = snap
            .marked_points
            .iter()
            .map(|m| {
                to_anchor(project, Some(m.station))
                    .map(|station| PersistedMarkedPoint {
                        station,
                        label: m.label.clone(),
                    })
                    .ok_or_else(|| {
                        "A marked point in this plan no longer exists in the survey. Remove it and \
                         save again."
                            .to_string()
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(PersistedDivePlanSnapshot {
            origin: to_anchor(project, snap.origin),
            endpoint: to_anchor(project, snap.endpoint),
            waypoints,
            diver: snap.diver.clone(),
            cylinders: snap.cylinders.clone(),
            gas_config: snap.gas_config.clone(),
            stage_drop_overrides: snap
                .stage_drop_overrides
                .iter()
                .map(|o| to_anchor(project, *o))
                .collect(),
            marked_points,
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
        let origin = from_anchor_opt(project, p.origin, &mut stale);
        let endpoint = from_anchor_opt(project, p.endpoint, &mut stale);
        // The caps are re-applied HERE, not only on save: the threat they exist for is a
        // hand-edited `.plnx`, which by definition never crosses the write path. Every way point
        // costs the engine a full extra Dijkstra and every marked point a DOM node plus a station
        // lookup, so an unbounded list from a doctored file would be a compute amplifier on every
        // recompute. Truncating (rather than refusing the load) keeps the rest of the plan usable.
        let waypoints = from_anchors(
            project,
            p.waypoints.into_iter().take(MAX_WAYPOINTS).collect(),
            &mut stale,
        );
        // Capped on the way IN like the way points and marked points, and for the same reason:
        // the threat is a hand-edited `.plnx`, which by definition never crosses the write
        // path. One entry per stage cylinder is the real bound (`gas.rs` already truncates the
        // engine side to the plan's cylinder count), so anything past the way-point cap is
        // doctored data, and each entry costs a station lookup on every load.
        let stage_drop_overrides = p
            .stage_drop_overrides
            .into_iter()
            .take(MAX_WAYPOINTS)
            .map(|k| from_anchor_opt(project, k, &mut stale))
            .collect();
        let marked_points = p
            .marked_points
            .into_iter()
            .take(MAX_MARKED_POINTS)
            .filter_map(|m| {
                from_anchor(project, &m.station, &mut stale).map(|station| MarkedPoint {
                    station,
                    // Same reasoning as the list caps: the save path rejects an over-long label,
                    // but a doctored file bypasses it entirely, so truncate on the way in.
                    label: m.label.map(|l| truncate_chars(l, MAX_MARKED_LABEL_CHARS)),
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
    use crate::models::{SectionData, ShotData};
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
    fn an_anchor_records_the_shots_a_station_sits_between() {
        let (project, sec) = project_3_shots();
        // An interior station is bounded on both sides.
        let pair = |r| match to_anchor(&project, Some(r)) {
            Some(StoredAnchor::Pair(p)) => Some(p),
            _ => None,
        };
        let mid = pair(StationRef::new(sec, 2)).expect("an interior station anchors as a pair");
        assert!(mid.a.is_some() && mid.b.is_some());
        // The ends have one neighbour and one free side.
        let start = pair(StationRef::new(sec, 0)).expect("pair anchor");
        assert!(start.a.is_none() && start.b.is_some());
        let end = pair(StationRef::new(sec, 3)).expect("pair anchor");
        assert!(end.a.is_some() && end.b.is_none());
        // A ref into a non-existent section cannot be anchored.
        assert!(to_anchor(&project, Some(StationRef::new(sec + 99, 1))).is_none());
    }

    #[test]
    fn round_trip_is_identity_when_the_survey_is_unchanged() {
        let (project, sec) = project_3_shots();
        let mut stale = 0;
        for idx in 0..=3 {
            let anchor = to_anchor(&project, Some(StationRef::new(sec, idx)));
            assert_eq!(
                from_anchor_opt(&project, anchor, &mut stale),
                Some(StationRef::new(sec, idx))
            );
        }
        assert_eq!(stale, 0);
    }

    /// THE point of the pair form (#24): a reverse renumbers every station in the section, and
    /// every stored reference must come back naming the SAME physical station - because it does
    /// not name a position or a side, it names the two shots the station sits between, and a
    /// reverse does not change what a station sits between.
    #[test]
    fn every_anchor_survives_a_reverse() {
        let (mut project, sec) = project_3_shots();
        let anchors: Vec<_> = (0..=3)
            .map(|i| to_anchor(&project, Some(StationRef::new(sec, i))).unwrap())
            .collect();

        assert!(project.reverse_section(sec, false));

        let mut stale = 0;
        // Station i becomes station N - i, and each anchor must follow it there.
        for (i, anchor) in anchors.iter().enumerate() {
            assert_eq!(
                from_anchor(&project, anchor, &mut stale),
                Some(StationRef::new(sec, 3 - i as u32)),
                "anchor for station {i} must name the same physical station after the reverse"
            );
        }
        assert_eq!(stale, 0, "nothing dangles - the shots all still exist");
    }

    /// Extending a passage is routine, and must not disturb a saved route. The far end of the
    /// section stops being terminal, so this exercises the pair falling back to the saved side.
    #[test]
    fn anchors_survive_a_shot_appended_to_the_end() {
        let (mut project, sec) = project_3_shots();
        let end = to_anchor(&project, Some(StationRef::new(sec, 3))).unwrap();
        let mid = to_anchor(&project, Some(StationRef::new(sec, 2))).unwrap();

        project.add_shot(sec, make_shot()).unwrap();

        let mut stale = 0;
        assert_eq!(
            from_anchor(&project, &end, &mut stale),
            Some(StationRef::new(sec, 3)),
            "the old far end is still station 3; the section simply continues past it"
        );
        assert_eq!(
            from_anchor(&project, &mid, &mut stale),
            Some(StationRef::new(sec, 2))
        );
        assert_eq!(stale, 0);
    }

    /// Splitting a shot inserts a new head before it, so an interior anchor's two neighbours
    /// stop being adjacent. It must still name the same junction - resolution takes the end of
    /// one neighbour that FACES the other, which does not require them to touch.
    #[test]
    fn an_interior_anchor_survives_a_split_between_its_neighbours() {
        let (mut project, sec) = project_3_shots();
        let mid = to_anchor(&project, Some(StationRef::new(sec, 2))).unwrap();
        let shot_id = project.get_section(sec).unwrap().shots[1].id;

        let before = project.get_section(sec).unwrap().shots.len();
        project.split_shot_at_distance(sec, shot_id, 0.5).unwrap();
        assert_eq!(project.get_section(sec).unwrap().shots.len(), before + 1);

        let mut stale = 0;
        assert_eq!(
            from_anchor(&project, &mid, &mut stale),
            Some(StationRef::new(sec, 3)),
            "the junction moved one index along because a shot was inserted before it"
        );
        assert_eq!(stale, 0);
    }

    /// Build a section of `n` shots and return `(project, section_id)`.
    fn project_n_shots(n: usize) -> (Project, u32) {
        let mut project = Project::new("Test".to_string(), None);
        let sec = project
            .add_section(SectionData {
                shots: (0..n).map(|_| make_shot()).collect(),
                ..Default::default()
            })
            .id;
        project.ensure_shot_uuids();
        (project, sec)
    }

    /// A terminal anchor must survive a reverse IN BOTH DIRECTIONS.
    ///
    /// It has one neighbour and so cannot be placed by the pair; the side comes from the saved
    /// `after_a`, which a reverse flips. Comparing the section's parity against the saved one is
    /// what corrects it.
    #[test]
    fn terminal_anchors_survive_a_reverse_both_ways() {
        let (mut project, sec) = project_n_shots(3);
        let start = to_anchor(&project, Some(StationRef::new(sec, 0))).unwrap();
        let end = to_anchor(&project, Some(StationRef::new(sec, 3))).unwrap();
        let mut stale = 0;

        assert!(project.reverse_section(sec, false));
        assert_eq!(
            from_anchor(&project, &start, &mut stale),
            Some(StationRef::new(sec, 3)),
            "the entrance is now the far end"
        );
        assert_eq!(
            from_anchor(&project, &end, &mut stale),
            Some(StationRef::new(sec, 0))
        );

        // ...and back again.
        assert!(project.reverse_section(sec, false));
        assert_eq!(
            from_anchor(&project, &start, &mut stale),
            Some(StationRef::new(sec, 0))
        );
        assert_eq!(
            from_anchor(&project, &end, &mut stale),
            Some(StationRef::new(sec, 3))
        );
        assert_eq!(stale, 0);
    }

    /// Deleting the head and then appending puts the anchored shot back at position 0 with a
    /// follower - the SAME observable state a reverse produces, but needing the opposite answer.
    /// Parity is what tells them apart; an earlier rule inferred the side from position alone
    /// and got this one wrong.
    #[test]
    fn a_terminal_anchor_survives_delete_then_append() {
        let (mut project, sec) = project_n_shots(2);
        let end = to_anchor(&project, Some(StationRef::new(sec, 2))).unwrap();

        let head = project.get_section(sec).unwrap().shots[0].id;
        project.remove_shot(sec, head).unwrap();
        project.add_shot(sec, make_shot()).unwrap();

        let mut stale = 0;
        assert_eq!(
            from_anchor(&project, &end, &mut stale),
            Some(StationRef::new(sec, 1)),
            "no reverse happened, so the saved side is read literally"
        );
        assert_eq!(stale, 0);
    }

    /// Prepending pushes every later station up by one, and the anchored station goes with it.
    #[test]
    fn a_terminal_anchor_survives_a_prepend() {
        let (mut project, sec) = project_n_shots(2);
        let start = to_anchor(&project, Some(StationRef::new(sec, 0))).unwrap();

        let first = project.get_section(sec).unwrap().shots[0].id;
        project
            .insert_shot_before(sec, first, make_shot(), None, None)
            .unwrap();

        let mut stale = 0;
        assert_eq!(
            from_anchor(&project, &start, &mut stale),
            Some(StationRef::new(sec, 1)),
            "the old entrance is now station 1; a new one sits in front of it"
        );
        assert_eq!(stale, 0);
    }

    /// Splitting the shot a terminal anchor names must FAIL SAFE, not guess.
    ///
    /// The split keeps the original UUID on the shortened tail, so afterwards no shot in the
    /// file has that station as an endpoint - nothing can name it, and any answer would be a
    /// guess that silently lands on the split point. The recorded length is what detects it:
    /// the tail is necessarily shorter, and the station is no longer at an end of the section.
    /// The reference is reported STALE so the UI can ask for a re-pin, which is a warning the
    /// diver can act on rather than a route quietly re-priced against the wrong station.
    #[test]
    fn splitting_the_anchored_end_shot_reports_stale_rather_than_guessing() {
        let (mut project, sec) = project_n_shots(2);
        let start = to_anchor(&project, Some(StationRef::new(sec, 0))).unwrap();

        let first = project.get_section(sec).unwrap().shots[0].id;
        project.split_shot_at_distance(sec, first, 0.5).unwrap();

        let mut stale = 0;
        assert_eq!(
            from_anchor(&project, &start, &mut stale),
            None,
            "the station cannot be named after the split, so it must not be guessed"
        );
        assert_eq!(stale, 1, "and the caller is told, so the UI can warn");
    }

    /// The guard must not fire on an ordinary extension: a prepend leaves the anchored shot's
    /// length alone, so the anchor keeps resolving even though its station is no longer
    /// terminal. Without the length check this shape would be indistinguishable from a split.
    #[test]
    fn extending_past_a_terminal_anchor_does_not_make_it_stale() {
        let (mut project, sec) = project_n_shots(2);
        let start = to_anchor(&project, Some(StationRef::new(sec, 0))).unwrap();

        let first = project.get_section(sec).unwrap().shots[0].id;
        project
            .insert_shot_before(sec, first, make_shot(), None, None)
            .unwrap();

        let mut stale = 0;
        assert_eq!(
            from_anchor(&project, &start, &mut stale),
            Some(StationRef::new(sec, 1)),
            "the shot was not split, so the station is still nameable"
        );
        assert_eq!(stale, 0);
    }

    /// A shot-less section is one station and no shots - what a GPX waypoint imports as. It has
    /// no neighbours to be named by, and that is a complete description rather than a failure.
    ///
    /// The old `SectionKey::SectionStart` form persisted it fine, so anchoring it as
    /// unresolvable would have meant a plan SILENTLY dropping an origin or endpoint on a
    /// waypoint, and outright refusing a way point or marked point on one - losing data purely
    /// by being saved after an upgrade.
    #[test]
    fn a_shot_less_section_anchors_its_only_station() {
        let mut project = Project::new("Test".to_string(), None);
        let sec = project
            .add_section(SectionData {
                shots: Vec::new(),
                ..Default::default()
            })
            .id;

        let anchor = to_anchor(&project, Some(StationRef::new(sec, 0)))
            .expect("a waypoint's only station must be anchorable");
        let mut stale = 0;
        assert_eq!(
            from_anchor(&project, &anchor, &mut stale),
            Some(StationRef::new(sec, 0))
        );
        assert_eq!(stale, 0);
    }

    /// ...and it round-trips through a whole persisted plan, which is the path that used to
    /// drop it: the origin/endpoint null out silently and a way point on it is REFUSED.
    #[test]
    fn a_plan_on_a_shot_less_section_round_trips() {
        let mut project = Project::new("Test".to_string(), None);
        let sec = project
            .add_section(SectionData {
                shots: Vec::new(),
                ..Default::default()
            })
            .id;
        let state = AppState::new().unwrap();
        *state.project.lock().unwrap() = Some(project);

        let only = StationRef::new(sec, 0);
        let snapshot = DivePlanSnapshot {
            origin: Some(only),
            endpoint: Some(only),
            waypoints: vec![only],
            diver: default_persisted_diver(),
            cylinders: Vec::new(),
            gas_config: GasConfig::default(),
            stage_drop_overrides: Vec::new(),
            marked_points: vec![MarkedPoint {
                station: only,
                label: Some("wp".to_string()),
            }],
        };

        let persisted = state
            .to_persisted(&snapshot)
            .expect("a way point on a shot-less section must not be refused");
        let (back, stale) = state.resolve_persisted(persisted).unwrap();
        assert_eq!(stale, 0);
        assert_eq!(back.origin, Some(only));
        assert_eq!(back.endpoint, Some(only));
        assert_eq!(back.waypoints, vec![only]);
        assert_eq!(back.marked_points[0].station, only);
    }

    /// A single-shot section has two ends that both touch the same one shot, so the pair cannot
    /// tell them apart - but the section's parity can, and that is enough.
    ///
    /// This used to be an accepted inaccuracy: with only a traversal-relative side recorded, a
    /// reverse flipped the meaning and nothing detected it. Recording the orientation alongside
    /// closes it, so the case now resolves correctly rather than being documented as wrong.
    #[test]
    fn a_single_shot_sections_ends_survive_a_reverse() {
        let mut project = Project::new("Test".to_string(), None);
        let sec = project
            .add_section(SectionData {
                shots: vec![make_shot()],
                ..Default::default()
            })
            .id;
        project.ensure_shot_uuids();

        let start = to_anchor(&project, Some(StationRef::new(sec, 0))).unwrap();
        let end = to_anchor(&project, Some(StationRef::new(sec, 1))).unwrap();
        let mut stale = 0;
        assert_eq!(
            from_anchor(&project, &start, &mut stale),
            Some(StationRef::new(sec, 0))
        );
        assert_eq!(
            from_anchor(&project, &end, &mut stale),
            Some(StationRef::new(sec, 1))
        );

        // Reversing a one-shot section swaps its two stations, and both anchors follow.
        assert!(project.reverse_section(sec, false));
        assert_eq!(
            from_anchor(&project, &start, &mut stale),
            Some(StationRef::new(sec, 1))
        );
        assert_eq!(
            from_anchor(&project, &end, &mut stale),
            Some(StationRef::new(sec, 0))
        );
        assert_eq!(stale, 0);
    }

    #[test]
    fn persisted_key_tracks_the_same_physical_station_across_a_shot_deletion() {
        // THE headline regression (#2): a saved ref must follow its station across a survey
        // edit, not silently rebind to whatever is now at the old index.
        let (mut project, sec) = project_3_shots();
        // Station 2 = the boundary after shot index 1.
        let key = to_anchor(&project, Some(StationRef::new(sec, 2))).expect("stable anchor");
        // Delete shot 0: the physical station that was at index 2 is now at index 1.
        project.sections[0].shots.remove(0);
        let mut stale = 0;
        let resolved = from_anchor(&project, &key, &mut stale);
        assert_eq!(stale, 0);
        // Follows the station to its new index - NOT the old positional index 2.
        assert_eq!(resolved, Some(StationRef::new(sec, 1)));
    }

    #[test]
    fn dangling_key_after_a_section_delete_is_nulled_and_counted() {
        let (mut project, sec) = project_3_shots();
        let key = to_anchor(&project, Some(StationRef::new(sec, 2))).expect("stable anchor");
        project.sections.clear(); // the whole section (and its anchoring shot) is gone
        let mut stale = 0;
        assert_eq!(from_anchor(&project, &key, &mut stale), None);
        assert_eq!(stale, 1);
    }

    #[test]
    fn from_key_leaves_none_refs_untouched_and_uncounted() {
        let (project, _sec) = project_3_shots();
        let mut stale = 0;
        assert_eq!(from_anchor_opt(&project, None, &mut stale), None);
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

        // The plan's ORIGIN was the section's first station, and deleting the first shot deletes
        // that station outright - so it is correctly reported gone rather than quietly re-bound.
        // The old `SectionStart` form could not say that: it resolved to index 0 whatever now
        // sat there, silently moving the dive's start one station down the passage. Exactly the
        // rebinding this test's own premise calls out.
        assert_eq!(stale, 1, "the origin's station no longer exists");
        assert_eq!(snapshot.origin, None);
        assert_eq!(snapshot.waypoints, vec![StationRef::new(sec, 1)]);
        assert_eq!(snapshot.marked_points.len(), 1);
        assert_eq!(snapshot.marked_points[0].station, StationRef::new(sec, 1));
        assert_eq!(snapshot.marked_points[0].label.as_deref(), Some("photo"));
    }

    /// The reverse renumbers every station, and a plan saved beforehand must come back naming
    /// exactly the stations the user picked (#24).
    ///
    /// Under the old `AfterShot(uuid)` form this was the one survey edit whose damage was
    /// silent: the key still resolved, onto the station next door, so `stale_ref_count` stayed 0
    /// and nothing warned while the route - and the gas plan derived from it - had been re-priced
    /// against different stations. An anchor that names the shots a station sits BETWEEN has
    /// nothing to go wrong: a reverse does not change what a station sits between.
    #[test]
    fn a_reverse_leaves_a_saved_plan_pointing_at_the_same_stations() {
        let (mut project, sec) = project_3_shots();
        let state = AppState::new().unwrap();
        *state.project.lock().unwrap() = Some(project.clone());
        let persisted = state
            .to_persisted(&snapshot_with_route_points(sec))
            .unwrap();

        assert!(project.reverse_section(sec, false));
        *state.project.lock().unwrap() = Some(project);

        let (snapshot, stale) = state.resolve_persisted(persisted).unwrap();
        assert_eq!(stale, 0);
        // The plan was saved with origin 0, endpoint 3, way point 2 and a marked point at 2.
        // Those physical stations are now numbered 3, 0, 1 and 1.
        assert_eq!(snapshot.origin, Some(StationRef::new(sec, 3)));
        assert_eq!(snapshot.endpoint, Some(StationRef::new(sec, 0)));
        assert_eq!(snapshot.waypoints, vec![StationRef::new(sec, 1)]);
        assert_eq!(snapshot.marked_points[0].station, StationRef::new(sec, 1));
        assert_eq!(snapshot.marked_points[0].label.as_deref(), Some("photo"));
    }

    /// End to end through the real `.plnx`: the command path has to reach the sidecar,
    /// because `Project::for_each_station_ref` (which the reverse's own ref rewrite walks)
    /// enumerates merges, closures, datums, offsets and comments - not the plan, which
    /// lives outside the project entirely. And it has to reach it on the way BACK too:
    /// undoing a reverse re-reverses the numbering.
    #[test]
    fn a_saved_plan_follows_its_stations_through_a_reverse_and_its_undo() {
        let temp = TempDir::new().unwrap();
        let (mut project, sec) = project_3_shots();
        project.file_path = Some(temp.path().join("cave.stalx"));
        let state = AppState::new().unwrap();
        *state.project.lock().unwrap() = Some(project);

        let saved = state
            .save_dive_plan(None, "Plan".to_string(), snapshot_with_route_points(sec))
            .unwrap();

        let result = state.execute(crate::core::Command::ReverseSection {
            section_id: sec,
            swap_left_right: false,
        });
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            result.reversed_sections,
            Some(vec![crate::core::ReversedSection {
                section_id: sec,
                shot_count: 3,
            }])
        );

        let plan = state.load_dive_plan(saved.id).unwrap();
        assert_eq!(plan.stale_ref_count, 0);
        assert_eq!(plan.snapshot.origin, Some(StationRef::new(sec, 3)));
        assert_eq!(plan.snapshot.endpoint, Some(StationRef::new(sec, 0)));
        assert_eq!(plan.snapshot.waypoints, vec![StationRef::new(sec, 1)]);
        assert_eq!(
            plan.snapshot.marked_points[0].station,
            StationRef::new(sec, 1)
        );
        // The plan still names the same physical stations, so this is not a user edit
        // and must not surface as one in the plan list.
        assert_eq!(plan.meta.updated_at, saved.updated_at);

        let undone = state.undo();
        assert!(undone.success, "{:?}", undone.error);
        assert_eq!(
            undone.reversed_sections,
            Some(vec![crate::core::ReversedSection {
                section_id: sec,
                shot_count: 3,
            }])
        );
        let plan = state.load_dive_plan(saved.id).unwrap();
        assert_eq!(plan.stale_ref_count, 0);
        assert_eq!(plan.snapshot.origin, Some(StationRef::new(sec, 0)));
        assert_eq!(plan.snapshot.endpoint, Some(StationRef::new(sec, 3)));
        assert_eq!(plan.snapshot.waypoints, vec![StationRef::new(sec, 2)]);
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
    fn save_refuses_a_route_point_that_no_longer_anchors_rather_than_dropping_it() {
        // Silently dropping was the original behaviour and it was data loss the user could not see:
        // the frontend rebaselines its dirty check on the snapshot it SENT, so the plan would read
        // "saved" while the file held a shorter route. Refusing keeps file and panel in agreement.
        let temp = TempDir::new().unwrap();
        let (mut project, sec) = project_3_shots();
        project.file_path = Some(temp.path().join("cave.stalx"));
        let state = AppState::new().unwrap();

        // A way point on a section that is then deleted cannot be anchored at save time.
        let mut snapshot = snapshot_with_route_points(sec);
        snapshot.waypoints = vec![StationRef::new(sec + 99, 1)];
        *state.project.lock().unwrap() = Some(project.clone());
        let err = state
            .save_dive_plan(None, "Plan".to_string(), snapshot)
            .unwrap_err();
        assert!(err.contains("way point"), "got: {err}");

        // Same for a marked point, with its own message.
        let mut snapshot = snapshot_with_route_points(sec);
        snapshot.waypoints = Vec::new();
        snapshot.marked_points = vec![MarkedPoint {
            station: StationRef::new(sec + 99, 1),
            label: None,
        }];
        let err = state
            .save_dive_plan(None, "Plan".to_string(), snapshot)
            .unwrap_err();
        assert!(err.contains("marked point"), "got: {err}");

        // Sanity: the same snapshot with anchorable points saves fine, so the refusals above are
        // about the dangling ref and not about some unrelated guard.
        project.ensure_shot_uuids();
        *state.project.lock().unwrap() = Some(project);
        assert!(state
            .save_dive_plan(None, "Plan".to_string(), snapshot_with_route_points(sec))
            .is_ok());
    }

    #[test]
    fn over_long_lists_and_labels_are_capped_on_the_way_in() {
        // The caps exist for a hand-edited `.plnx`, which by definition never crosses the save
        // path - so the LOAD path has to enforce them too. Way points are the expensive one: each
        // costs the engine a full extra Dijkstra on every recompute.
        let (project, sec) = project_3_shots();
        let state = AppState::new().unwrap();
        *state.project.lock().unwrap() = Some(project.clone());
        let key = to_anchor(&project, Some(StationRef::new(sec, 2))).unwrap();

        let persisted = PersistedDivePlanSnapshot {
            origin: None,
            endpoint: None,
            waypoints: vec![key.clone(); MAX_WAYPOINTS + 25],
            diver: default_persisted_diver(),
            cylinders: Vec::new(),
            gas_config: GasConfig::default(),
            stage_drop_overrides: Vec::new(),
            marked_points: vec![
                PersistedMarkedPoint {
                    station: key,
                    label: Some("x".repeat(MAX_MARKED_LABEL_CHARS + 500)),
                };
                MAX_MARKED_POINTS + 25
            ],
        };
        let (snapshot, _stale) = state.resolve_persisted(persisted).unwrap();

        assert_eq!(snapshot.waypoints.len(), MAX_WAYPOINTS);
        assert_eq!(snapshot.marked_points.len(), MAX_MARKED_POINTS);
        assert_eq!(
            snapshot.marked_points[0]
                .label
                .as_ref()
                .unwrap()
                .chars()
                .count(),
            MAX_MARKED_LABEL_CHARS
        );
    }

    #[test]
    fn a_pre_298_plnx_blob_still_loads() {
        // The claim "no schema bump needed" rests on the ON-DISK struct's serde defaults, not the
        // IPC one - `load_dive_plan` parses the blob as PersistedDivePlanSnapshot. Deserialize a
        // blob with neither new field to pin that directly, so dropping a `#[serde(default)]` there
        // cannot make every existing user's plan unloadable with a green suite.
        let json = serde_json::json!({
            "origin": null,
            "endpoint": null,
            "diver": { "rmv_l_per_min": 20.0, "label": null },
            "cylinders": [],
            "gas_config": serde_json::to_value(GasConfig::default()).unwrap(),
            "stage_drop_overrides": []
        })
        .to_string();
        let persisted: PersistedDivePlanSnapshot = serde_json::from_str(&json).unwrap();
        assert!(persisted.waypoints.is_empty());
        assert!(persisted.marked_points.is_empty());
    }

    /// A `.plnx` written before #24 stores `{section_id, anchor}` and must keep working. The
    /// pair form's fields all default, so without the untagged ordering it would swallow a
    /// legacy row and silently blank every reference in it - the whole plan, on upgrade.
    #[test]
    fn a_legacy_station_key_blob_still_resolves() {
        let (project, sec) = project_3_shots();
        let uuid = project.get_section(sec).unwrap().shots[1]
            .uuid
            .clone()
            .unwrap();
        // Exactly the shape the old writer produced.
        let json = serde_json::json!({
            "origin": { "section_id": sec, "anchor": "SectionStart" },
            "endpoint": { "section_id": sec, "anchor": { "AfterShot": uuid } },
            "waypoints": [],
            "diver": { "rmv_l_per_min": 20.0, "label": null },
            "cylinders": [],
            "gas_config": serde_json::to_value(GasConfig::default()).unwrap(),
            "stage_drop_overrides": [],
            "marked_points": []
        })
        .to_string();

        let persisted: PersistedDivePlanSnapshot = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(persisted.origin, Some(StoredAnchor::Legacy(_))),
            "a legacy row must be recognised as legacy, not silently read as an empty pair"
        );

        let state = AppState::new().unwrap();
        *state.project.lock().unwrap() = Some(project);
        let (snapshot, stale) = state.resolve_persisted(persisted).unwrap();
        assert_eq!(stale, 0, "an upgrade must not strand anyone's route");
        assert_eq!(snapshot.origin, Some(StationRef::new(sec, 0)));
        assert_eq!(snapshot.endpoint, Some(StationRef::new(sec, 2)));
    }

    /// A pair-form row must NOT be mistaken for a legacy one.
    #[test]
    fn a_pair_anchor_round_trips_through_json() {
        let (project, sec) = project_3_shots();
        let anchor = to_anchor(&project, Some(StationRef::new(sec, 2))).unwrap();
        let json = serde_json::to_string(&anchor).unwrap();
        let back: StoredAnchor = serde_json::from_str(&json).unwrap();
        assert_eq!(back, anchor);
        assert!(matches!(back, StoredAnchor::Pair(_)));
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
