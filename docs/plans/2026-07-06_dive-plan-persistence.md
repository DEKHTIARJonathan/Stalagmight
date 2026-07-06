# Dive-plan persistence (`.plnx`): design

Issue: #244 (part of #38, Planning mode). Status: **DESIGN SETTLED** (all three
forks in section 11 resolved 2026-07-06). Ready for Phase 1 (section 13).

## 1. Goal

Persist named **dive plans** so a diver can save, revisit, compare, and delete
route plans for a survey. Storage is a **separate SQLite file next to the project**
(`<stem>.plnx`, alongside `<stem>.stalx`), mirroring the collab-mode sibling-file
precedent. Dive plans are personal/operational data and are **never** written into
the `.stalx` itself, so SpeleoDB pushes and collab reconciliation stay untouched.

Surface: a **"Previous dive plans" dropdown** in the Plan-mode gas panel, with
**Save / Save as... / Delete**.

## 2. The snapshot is the compute input tuple (the hinge)

The state a plan captures is *exactly* the argument set of the existing
`compute_gas_reach_field` command:

```
origin: Option<StationRef>
endpoint: Option<StationRef>
diver: Diver
cylinders: Vec<Cylinder>          // carries `enabled` + `usable_gas_bar`
gas_config: GasConfig             // carries strategy (incl. Free), swim speed, units, profile
stage_drop_overrides: Vec<Option<StationRef>>
```

So a plan = that tuple + identity/meta (name, timestamps, schema version, project
key). **Loading a plan** means setting those six fields in `gasPlanStore` and
letting the existing fetch effect recompute the reach field. No new engine code,
no re-derivation: we persist inputs, never outputs (`GasReachField` is always
recomputed from live geometry, so a stale cached overlay can never be shown).

Snapshotting the **full `GasConfig`** (not a hand-picked subset) means a loaded
plan reproduces the exact gas parameters it was computed under (units, multipliers,
reserve profile, swim speed). Loading a plan sets session working state only; it
does **not** write back to the persisted `projectStore.config.gas`.

## 3. Storage format & versioning

`.plnx` is a SQLite file (per the issue), but with a deliberately **thin schema**:
one table of rows, each row carrying a **serde-JSON snapshot blob**. This gets both
benefits at once - SQLite for list/insert/delete row management (as the issue
specifies), and config-style serde tolerance for the payload.

```sql
CREATE TABLE IF NOT EXISTS dive_plans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    created_at     TEXT    NOT NULL,   -- RFC3339
    updated_at     TEXT    NOT NULL,
    schema_version INTEGER NOT NULL,   -- payload schema version (see below)
    snapshot_json  TEXT    NOT NULL    -- serde_json of DivePlanSnapshot
);
CREATE TABLE IF NOT EXISTS plnx_meta (   -- one row; file-level identity (section 5)
    project_created_at TEXT,
    project_name       TEXT,
    app_schema_version INTEGER
);
```

Two-layer versioning, mirroring the two precedents:
- **File/table schema** via `PRAGMA user_version` + idempotent `CREATE TABLE IF NOT
  EXISTS` / `ALTER TABLE ADD COLUMN` migrations, exactly like the `.stalx` schema.
- **Payload schema** via a `schema_version` field inside `DivePlanSnapshot`, which
  derives serde with `#[serde(default)]` on every field so a plan written by an
  older or newer build still loads (unknown fields ignored, missing fields
  defaulted) - the same tolerance `Config` already relies on.

We reuse the hardened SQLite I/O plumbing (connection open, atomic tmp->rename,
the permission-denied error classification from the `.stalx` save path) but with
this new lightweight schema; we do **not** reuse the `.stalx` `Database` struct
(different tables).

Rejected alternative - a plain JSON `.plnx` file: simpler and natively
serde-tolerant, but (a) the issue specifies SQLite, and (b) reusing the `.stalx`
save hardening (atomic rename + the permission-denied humanization that the
#92/#104/#145 data-safety work built) is worth more than saving the schema code,
and rebuilding atomic-write + error classification for JSON risks re-opening that
data-loss class.

## 4. Data model (Rust)

```rust
// New IPC types (ts-rs), in a new commands/dive_plan module + models re-export.

pub struct DivePlanSnapshot {          // the compute input tuple, serde-default tolerant
    #[serde(default)] pub origin: Option<StationRef>,
    #[serde(default)] pub endpoint: Option<StationRef>,
    #[serde(default)] pub diver: Diver,
    #[serde(default)] pub cylinders: Vec<Cylinder>,
    #[serde(default)] pub gas_config: GasConfig,
    #[serde(default)] pub stage_drop_overrides: Vec<Option<StationRef>>,
}

pub struct DivePlanMeta {              // dropdown row (no heavy payload)
    pub id: i64,
    pub name: String,
    pub created_at: String,            // RFC3339
    pub updated_at: String,
}

pub struct DivePlan {                  // load result
    pub meta: DivePlanMeta,
    pub snapshot: DivePlanSnapshot,
    pub stale_ref_count: u32,          // refs that no longer resolve (section 6)
}
```

`Diver`/`Cylinder`/`GasConfig`/`StationRef` already derive serde + ts-rs, so the
snapshot composes cleanly.

## 5. Project keying, rename, move

Location: **sibling-by-stem**, derived fresh from the current `.stalx` path on every
access (the `.tml` precedent). `<stem>.plnx` sits next to `<stem>.stalx`.

Identity guard: the `plnx_meta` row stores the project's immutable `created_at`.
On load we compare it to the live project's `created_at`:
- **Match** -> the plans belong to this project; list them.
- **Mismatch** -> the `.plnx` was authored for a different project that happens to
  share this filename (e.g. someone copied a `.plnx` next to an unrelated `.stalx`).
  Do **not** silently merge foreign plans; treat as "no plans for this project"
  and surface a quiet notice. (Adopt-anyway is a possible later affordance.)

Rename/move behavior:
- Move/rename **both files together** (outside the app) -> plans follow, identity
  matches. Works.
- Move only the `.stalx` -> the `.plnx` is left behind and effectively orphaned
  (acceptable; documented). We do not chase it.
- **Save As within the app** -> a fork (section 11). v1 recommendation: a Save-As
  starts a **fresh** (empty) `.plnx` next to the new file; plans do not carry.
  Simpler, and consistent with the `.tml` precedent (Save-As writes a new sibling
  next to the new stem). Carrying plans across a Save-As is a clean later add.

If the project has **no `file_path` yet** (unsaved / deferred project), there is no
sibling location, so plan save/list is disabled with a friendly reason ("Save the
project before saving dive plans"). Mirrors the `.tml` requirement of a real path.

## 6. Stale `StationRef` degradation

Only the station refs in a snapshot (`origin`, `endpoint`, each
`stage_drop_overrides` entry) can go stale when the survey is edited; cylinders /
strategy / swim speed / RMV are geometry-independent and always load cleanly.

`resolve_key` already returns `Option<StationRef>` (None if the section was deleted
or the index is out of range), and the gas engine already degrades safely on None:
origin-None -> datum roots; endpoint-None -> deepest in-budget; an unresolved
override -> strategy default. So load-time degradation is:

1. Resolve each ref in the snapshot against the **current** project.
2. **Null** the ones that no longer resolve (leave the rest intact).
3. Count them into `stale_ref_count` and surface **one non-blocking warning**:
   "This plan references N stations that no longer exist; they have been cleared."
4. **Never hard-reject** the plan - a plan whose endpoint vanished still restores
   its rig, strategy, and origin.

Resolution runs backend-side (the command has the live project) so the frontend
just applies the (already-nulled) snapshot and shows the warning when count > 0.

## 7. Atomic write & side-effect isolation

Atomicity comes from SQLite's in-place **ACID transaction** (rollback journal +
`synchronous=FULL`), not a tmp->rename of the whole file. That is the right model
for an *incrementally maintained* store: a single insert/update/delete commits whole
or rolls back, and a power loss leaves the old-or-new committed file, never a torn
one. (The `.stalx` uses tmp->rename because it rebuilds the entire file from the
in-memory project each save; a row store that is edited in place does not - a
whole-file swap there would be more I/O with no added safety.) A refinement from the
approved plan's "tmp->rename" wording; the substance of the requirement - crash-safe,
no phantom side effects - is fully met. Strict isolation - a plan write must **not**:
- touch `recent_projects` (plans are not projects),
- bump the project's `modified_at` or mark the `.stalx` dirty (saving a plan is not
  editing the survey),
- interact with the `.stalx` close-guard, undo/redo, collab, or SpeleoDB paths.

It is an independent write to an independent sibling. A failed `.plnx` write returns
a humanized error to the panel and changes nothing about the project.

## 8. Save lifecycle & close-guard (DECIDED: dirty-tracked)

Decision: **plans are dirty-tracked with a close-guard.** A loaded plan establishes
a baseline; when the live inputs diverge from it, the plan is dirty, and the app
guards against silently losing those edits.

Store additions (`gasPlanStore`):
- `loadedPlanId: number | null` - the currently-selected plan (null = unsaved
  working state / no plan loaded).
- `loadedPlanBaseline: DivePlanSnapshot | null` - the snapshot as loaded, or as of
  the last successful Save.
- derived `isPlanDirty = loadedPlanId != null && !snapshotEquals(currentInputs,
  loadedPlanBaseline)`, where `currentInputs = {origin, endpoint, diver, cylinders,
  gasConfig, stage_drop_overrides}` and `snapshotEquals` is a small structural
  deep-equality helper (the tuple is plain serde data).

Transitions:
- **Load** a plan: apply its snapshot to the inputs, set `loadedPlanId` +
  `loadedPlanBaseline` to it (clean).
- **Save**: write, then set `loadedPlanBaseline = currentInputs` (clean again).
- **Save as...**: insert, set `loadedPlanId = new id`, baseline = current (clean).
- **Any input setter**: baseline unchanged, so `isPlanDirty` recomputes to true.

Guard triggers (reuse the existing close-guard machinery - `useBeforeUnload` + the
confirm dialog - do not build a parallel one):
- **Switch plan** in the dropdown while dirty -> confirm "Discard unsaved changes to
  '<name>'?" before loading the other plan.
- **Leave Plan mode / switch project / close the app** while dirty -> the plan-dirty
  flag is OR'd into the same close-guard the survey `modified_at` dirty already
  feeds, so the user is warned before the session inputs (and the unsaved plan
  edits) are reset.
- **Delete** the loaded plan: the existing delete-confirm already covers it.

Scope: the guard fires only for a **loaded** plan whose inputs diverged
(`loadedPlanId != null`). A never-saved exploration (`loadedPlanId == null`) is the
same disposable session state Plan mode already has, and is not guarded - guarding
every Plan-mode exit would nag. ("You have an unsaved new plan" protection for the
no-plan-loaded case is a later heuristic if wanted; deferred.)

Independence from `.stalx`: plan-dirty is a **separate** signal from survey dirty.
Saving a plan never touches survey `modified_at`; editing the survey never makes a
plan dirty. They converge only at the shared close-guard prompt, which now warns on
either.

## 9. UI surface

In the Plan-mode gas panel, a compact plans bar above the rig/strategy controls:

```
Dive plans  [ v Deep push - stage at T (2h ago)   v ]  [ Save ]  [ Save as... ]  [ Delete ]
```

- **Dropdown**: lists `DivePlanMeta` (name + relative updated time), newest first.
  Selecting one loads it (sets the six store fields -> recompute) and shows the
  stale-ref warning inline if any.
- **Save**: upserts the currently-selected plan's row from the live inputs
  (no-op create if nothing selected -> behaves as Save as...).
- **Save as...**: prompts for a name (reuse the existing name-prompt dialog
  pattern), inserts a new row.
- **Delete**: removes the selected row (confirm dialog).
- **Disabled state**: whole bar disabled with a tooltip when the project has no
  `file_path` yet (section 5).

Exact placement/spacing is a UX detail to tune against the live panel; the data
model above is independent of it.

## 10. IPC & registry surface

New commands (module `commands/dive_plan.rs`), each async, returning
`Result<_, String>`:

- `list_dive_plans() -> Vec<DivePlanMeta>` - reads the sibling next to the current
  project; `[]` if none / identity mismatch / no path.
- `load_dive_plan(id: i64) -> DivePlan` - full snapshot + `stale_ref_count`
  (resolved against the live project).
- `save_dive_plan(id: Option<i64>, name: String, snapshot: DivePlanSnapshot) ->
  DivePlanMeta` - upsert (None id = insert). Re-validates the snapshot via
  constructors (serde bypasses `new_checked`). Writes `.plnx` atomically.
- `delete_dive_plan(id: i64) -> ()`.

Per the add-a-command checklist: register each in `lib.rs generate_handler!`, add
`"command.<name>"` to `EVENT_NAMES` (registry.rs) and bump the count assertion, and
`registry_covers_all_commands` (which parses `lib.rs`) then passes. Add the three
IPC structs to the `gen_ipc_types` exports (both the `export::<T>` call and the
barrel) and `pnpm gen:ipc-types`. Tauri camelCase arg keys map to snake_case.

## 11. Forks (resolved 2026-07-06)

1. **Save lifecycle** -> **dirty-tracked with a close-guard** (section 8). Plans are
   guarded documents, not throwaway snapshots.
2. **Save-As carries plans?** -> **fresh/empty `.plnx` on Save-As** (section 5);
   `created_at` identity guard applies regardless. Carry-on-Save-As deferred.
3. **Snapshot scope** -> **full `GasConfig`** (section 2); a loaded plan reproduces
   the exact parameters it was computed under, session-only (no global-config
   write-back).

## 12. Test plan (adversarial-first)

- **Round-trip**: save -> list -> load reproduces the exact input tuple; recompute
  yields the same `GasReachField`.
- **Serde tolerance**: a snapshot JSON with an unknown field loads (ignored); a
  snapshot missing a newer field loads (defaulted). Golden fixture.
- **Stale refs**: delete the section the endpoint / an override points at, reload ->
  plan loads, stale refs nulled, `stale_ref_count` correct, engine falls back
  safely (no panic, no over-stated reach).
- **Identity mismatch**: a `.plnx` whose `plnx_meta.project_created_at` differs ->
  `list_dive_plans` returns `[]` (no foreign-plan bleed).
- **No path**: deferred/unsaved project -> save/list return the friendly guard,
  write nothing.
- **Atomic + isolation**: a forced `.plnx` write failure leaves recents, project
  `modified_at`, and the `.stalx` untouched; no phantom entries (root-safe inducer
  per the deferred-save test precedent).
- **Delete**: removing a row leaves the others intact and the file valid.

## 13. Implementation phases

1. Backend: `.plnx` schema + I/O helper (open/init/atomic-write, identity meta) +
   the four commands + snapshot model + Rust tests.
2. IPC types + regen; registry entries + count bump.
3. Frontend: `gasPlanStore` load/apply + plan-dirty tracking (`loadedPlanId`,
   `loadedPlanBaseline`, `isPlanDirty`, `snapshotEquals`); the plans bar UI;
   Save/Save-as/Delete dialogs; stale-ref warning surfacing; close-guard OR-in.
4. E2E: mock the four commands; dropdown + save/load/delete + stale-ref-warning +
   dirty-guard specs. Vitest for the store apply + dirty-equality logic.

Each phase small and committed; PR held for review per project policy.
