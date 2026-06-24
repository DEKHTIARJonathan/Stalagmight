# Rust module-split refactor — findings & plan

**Status:** scoping/analysis (Phase A). This document inventories oversized
non-test Rust files in the `stalagmight` crate (`src-tauri/src`) and proposes a
concrete, behavior-preserving split of each into logical modules at API
boundaries. Execution lands later as small, per-file, pure-move PRs.

## Why

Large source files hurt three things:

1. **Agent context cost** — the file is the unit an agent ingests to reason about
   a change; a 7k-LOC file burns tokens on every touch.
2. **Human readability** — a single ~8000-line `impl Project` is hard to navigate.
3. **Compile time** — *only marginally.* See the caveat below.

### Compile-time caveat (read this before expecting a speedup)

Rust compiles **per crate**, not per file, and incremental compilation is already
finer-grained than the file. Splitting one file into many **within the same
crate** does **not** meaningfully reduce total compile time. The genuine
compile-time lever is **crate decomposition** (splitting `stalagmight` into a
workspace of smaller crates) or cutting generic monomorphization — a larger,
separate effort, **out of scope here**. This refactor buys readability +
agent-context cost, with at most a marginal incremental-rebuild benefit. Honest
`cargo build --timings` deltas will be reported per PR; we do not claim a speedup.

## How LOC was measured

`tokei` `Code` column (excludes comments + blanks). **Production-only** LOC
additionally strips **every** `#[cfg(test)]`-gated item — the trailing `mod tests
{ … }` block *and* any scattered mid-file test items (`#[cfg(test)] fn`,
`#[cfg(test)] use …;`, debug-assert helpers) — not just a single truncation at the
test module. The inventory figures below are a tokei approximation that truncates
at the trailing test module, so a file with scattered mid-file `#[cfg(test)]`
items (notably `project.rs` and `lib.rs`) is slightly *over*-stated in Prod /
under-stated in Inline-test. The **exact** production metric — strip-all-cfg(test),
comment/blank-aware — is the one the committed file-size ratchet computes
(`scripts/check-rust-file-size.mjs` → `src-tauri/file-size-baseline.json`, #159);
treat that baseline as authoritative for the precise per-file numbers. The
as-written total is shown alongside so inline-test bloat stays visible.

## Priority inventory (production-only LOC, ≥1000)

| Tier | File | Prod | Total | Inline-test |
|------|------|-----:|------:|-----:|
| **HIGH** | `models/project.rs` | 7174 | 7174 | ~0 trailing; a few scattered `#[cfg(test)]` helpers (see method note) |
| **HIGH** | `persistence/sqlite.rs` | 2844 | 2844 | ~0 (tests already external) |
| **HIGH** | `core/state/commands.rs` | 2734 | 2904 | ~170 |
| **MED** | `core/state/project_io.rs` | 1510 | 1613 | ~103 |
| **LOW** | `config/types.rs` | 1400 | 1400 | ~0 |
| **LOW** | `core/state/undo.rs` | 1261 | 1261 | ~0 |
| **LOW** | `parsers/tml.rs` | 1217 | 2727 | ~1510 |
| **LOW** | `export/tml.rs` | 1130 | 2194 | ~1064 |
| **LOW** | `models/placement_suggest.rs` | 1116 | 2481 | ~1365 |
| **LOW** | `lib.rs` | 1101 | 2277 | ~1176 |
| **LOW** | `parsers/compass.rs` | 1060 | 1355 | ~295 |

Tiers: **HIGH** >2000 · **MED** 1500–2000 · **LOW** 1000–1500 prod LOC.

**Scope:** non-test production `.rs` under `src-tauri/src`. Excluded: test files,
`scripts/lib/slice-rs`, vendored `src-tauri/vendor/compass_data`, generated IPC
types.

## The split pattern (idiomatic for this codebase)

1. **God `impl` → multiple `impl` blocks across child modules.** Inherent-impl
   methods stay callable as `x.method()` regardless of which file holds the
   block. Already an established convention here: `impl AppState` is spread across
   `core/state/{commands,project_io,undo}.rs` (its fields are `pub(super)`); we
   extend that. For type-owning files, **child** modules (`models/project/graph.rs`)
   get private-field access via descendant visibility — no `pub(crate)` widening.
2. **Keep `foo.rs` as the module root** (do **not** rename to `foo/mod.rs`). A
   file-module resolves `mod sub;` to `foo/sub.rs` — proven by the existing
   `project.rs` + `project/tests.rs`. Lower blame churn.
3. **Explicit `pub(crate) use` / `pub use` re-exports, never globs.**
4. **Co-locate tests with the module they exercise** — keep small unit-test modules
   inline; spill a *large* one to a sibling `<mod>/tests.rs` (still a `#[cfg(test)]
   mod tests`, private access intact); move `#[expect(…)]` with the code. See the
   **Test placement policy** below.

### Guardrails ("logical, not tiny")

- Split only at a real interface/responsibility boundary.
- Floor ~150–200 LOC per unit; target ~300–600. A sub-150 seam folds into the
  nearest sibling rather than spawning a tiny file.
- Zero behavior change — pure movement + re-exports; no caller-path churn.
- Move `#[cfg(test)]` / `#[expect(…)]` attributes with their exact code.

## Test placement policy

This repo has three test homes; we keep its existing convention rather than invent one:

- **Inline `#[cfg(test)] mod tests { … }`** — unit tests in the production file (private
  access via `use super::*`). **The default** — ~34 files.
- **Sibling-file test module (`#[cfg(test)] mod tests;` / `mod <name>_tests;` → a separate
  `.rs`)** — the *same* unit tests spilled to a file when the module is large. Still a child
  module → still private access; **not** an integration test. Used today by the large test
  bodies: `config/`, `core/state/`, `models/project`, `persistence/sqlite` (`mod tests;`),
  **plus `commands/command_tests.rs`** (`mod command_tests;`). So the precedent for spilling
  a big test module to a sibling file is already well established.
- **`tests/integration_tests.rs`** — true integration tests, separate crate, **public-API
  only** (~1943 code LOC / 2632 total lines, 80 tests). Out of scope; we add nothing to it.

**Policy:**
1. **Keep each module's tests as ONE `mod tests`** — do *not* fragment a test module across
   child modules by sub-helper. A narrow-vs-broad classification of the three big modules
   (below) confirmed that "distribute into children" forces cross-module `pub(super)` and
   duplicates shared test fixtures — it *defeats* the encapsulation the split buys. So:
   **spill-whole, don't distribute.**
2. **Inline by default; spill to a sibling `<mod>/tests.rs` only when the test body is large**
   (≳ production LOC, roughly ≥ ~800 test LOC) — the `project`/`sqlite` precedent.
3. When production splits into children, the spilled/inline test module reaches child-private
   items via **`pub(super)` on exactly those items** (a small, enumerable surface; use
   `pub(in crate::<mod>)` if the reach crosses siblings) — never via re-export globs.
4. **Never migrate unit → integration** — every candidate test module touches private items,
   so it can't be an integration test anyway.

Per-candidate (test-body LOC, tokei; classification = `#[test]` counts narrow/broad):

| File | Prod | Test | Handling | Classification |
|---|---:|---:|---|---|
| `parsers/tml.rs` | 1217 | 1510 | **spill** → `tml/tests.rs` | 40 `#[test]` (spill whole) → still (B) |
| `models/placement_suggest.rs` | 1116 | 1365 | **spill** → `placement_suggest/tests.rs` | 45 `#[test]` (spill whole) → (B) |
| `lib.rs` → `tile_fetch.rs` | 1101 | 1176 | **spill** → `tile_fetch/tests.rs` | all narrow, single module → no `pub(super)` |
| `export/tml.rs` | 1130 | 1064 | **spill** → `export/tml/tests.rs` | 17 / 13, 16-of-17 → one child → (B) |
| `parsers/compass.rs` | 1060 | 295 | **inline** (small) | stays in `compass.rs` |
| `core/state/project_io.rs` | 1510 | 103 | **inline** (small) | stays (in `project_create.rs`) |
| `core/state/commands.rs` | 2734 | 170 | **inline** (small) | 2 named mods stay in `commands.rs` |

## Lint constraints (deny-level, CI-gated — see `docs/linting.md`)

A move perturbs exactly the lints this repo denies. The proposals account for:

- **`unreachable_pub` (deny)** — internal items must be `pub(crate)`, not `pub`.
- **`unused_qualifications` (deny)** — strip now-redundant full paths after moving.
- **`wildcard_imports` (deny)** — explicit imports only; no `use super::*` in prod.
- **`allow_attributes` (deny)** — only `#[expect]`, never `#[allow]`.
- **Per-module `#[expect]`** must list exactly the lints the moved test module
  triggers (over-broad → "unfulfilled expectation"; too narrow → the lint fires).
- Not a driver: `too_many_lines`/`too_many_arguments` are *deliberately allowed*
  for the geometry/numerical code, so large fns may survive a move unobjected.

## Verification (per pure-move PR — independently verifiable)

Every check is a deterministic command anyone can re-run (binary pass/fail):

  All `cargo` commands need `TELEMETRY_ENDPOINT` set and the manifest pinned, or
  `build.rs` hard-errors before any test compiles (and `--features telemetry` gates
  the `registry_covers_all_*` tests, so the flag genuinely changes the count):
  `TELEMETRY_ENDPOINT=http://localhost/dummy cargo <cmd> --manifest-path
  src-tauri/Cargo.toml --features telemetry …`.
- **Tier 0 (baseline, on the base commit):** record `TELEMETRY_ENDPOINT=…
  cargo test --manifest-path src-tauri/Cargo.toml --features telemetry` `test
  result` counts; `cargo build --timings`; confirm `pnpm gen:ipc-types` is clean.
- **Tier 1 (must pass):** `cargo fmt --manifest-path src-tauri/Cargo.toml --check`;
  `TELEMETRY_ENDPOINT=… cargo clippy --manifest-path src-tauri/Cargo.toml
  --all-targets --features telemetry` clean (proves the move-hazard lints absent);
  `TELEMETRY_ENDPOINT=… cargo test --manifest-path src-tauri/Cargo.toml --features
  telemetry` green **and counts == Tier-0** (no test silently dropped);
  `pnpm gen:ipc-types && git diff --exit-code src/types/` **empty** (no ts-rs
  drift).
- **Tier 2 (reviewer confidence):** item/token-multiset diff (old vs new, minus
  `mod`/`use`/`pub use` wiring) is empty; `git diff --stat` line-conservation;
  optional `cargo public-api` diff.

## Regression guard (prevent recurrence)

A **file-size ratchet + budget**, enforced on three surfaces:

- **CI `check` gate** — `scripts/check-rust-file-size.py` (self-contained,
  comment- + inline-test-aware) against a committed
  `src-tauri/file-size-baseline.json`. Fails if a tracked file **grows past its
  baseline** (monotonic — may shrink, never grow) or a **new/under-budget** file
  crosses the budget (**warn 1500 / fail 2000** prod LOC). Splitting a file drops
  its baseline and locks the win in. Legitimate growth bumps the baseline in the
  same PR (visible to the reviewer). Escape hatch: explicit allow-list entry with
  a one-line justification. Ratchet over a flat cap because `too_many_lines` is
  deliberately allowed for the numerical code — a hard cap would fight
  legitimately-large files.
- **`/pre-pr` lens** — flags a PR pushing any file over budget or adding a new
  god-`impl`, before the PR is opened.
- **Docs rule** — a "keep modules focused; split at ~1000 prod LOC at an API
  boundary" note in `CLAUDE.md` / `docs/architecture.md` pointing here.

---

# Per-file split proposals

> _Filled from per-file structural analysis. Each section: current structure →
> proposed child-module layout (with LOC estimates) → re-export plan → risks
> (ts-rs / `#[expect]` / privacy) → effort + PR boundary._
>
> **Unit note:** the per-child `est LOC` columns are **raw** line counts (each
> child carries its own `use`/re-export overhead), so they sum ~20–40% above the
> parent's tokei **prod** LOC from the inventory — the two figures are different
> units and are *not* expected to reconcile. No child crosses the 1500 warn line
> in either unit.

## HIGH

### `models/project.rs` (7174 prod) — flagship

One `impl Project` of ~8100 lines as-written (two blocks, L492–8590; 7174 prod
LOC) over ~20 type defs. Split into the root
+ **11 child modules** (`project/*.rs`); child layout means every cluster reaches
`Project`'s private fields by descendant visibility — **no method needs its
visibility raised** (the property that makes this clean).

| Child module | What moves | est LOC |
|---|---|---:|
| `project.rs` (root) | imports; **all 14 ts-rs type defs incl. `Project`**; serde free-fns + `ProjectIpc`/`serialize_project_ipc`; core CRUD/lifecycle (`new`, `add/get/update/remove_section`, shot-uuid, `rebuild_*`); `mod` decls + re-exports | ~700 |
| `project/relationships.rs` | connection-preservation cluster | ~590 |
| `project/offsets.rs` | section offsets + merge-graph primitives | ~560 |
| `project/shots.rs` | shot editing + delete-impact preview | ~1050 |
| `project/connectivity.rs` | section connectivity + offset cascade | ~580 |
| `project/pathfinding.rs` | graph primitives + shortest-path + survey graph + dijkstra; private `PathEdge`/`HeapItem`/etc. | ~750 |
| `project/closure.rs` | closure adjustment + LSQ solver (`adjust_least_squares`, `coords_*`) | ~1300 |
| `project/mutations.rs` | merge/datum mutations | ~800 |
| `project/coordinates.rs` | coordinate engine (`compute_station_coordinates*`) | ~540 |
| `project/distance.rs` | distance field + reachability + along-line + frozen-shots | ~880 |
| `project/stats.rs` | `stats`/`metadata`/GPS | ~200 |
| `project/integrity.rs` | the 2nd `impl Project` block + `ViolationSeverity`/`IntegrityViolation` | ~790 |

**Re-export plan:** inherent methods need none. **Keep all 14 ts-rs types on the
root** (don't redistribute to owning clusters) → `gen:ipc-types` output unchanged,
the 3 external `serialize_project_ipc` callers keep resolving. The **only**
type-move is the non-ts `ViolationSeverity`/`IntegrityViolation` → `integrity.rs`,
re-exported from root for `crate::models::IntegrityViolation` (the `models/mod.rs`
glob); **verify external vs crate-internal use to pick `pub` vs `pub(crate) use`**
(`unreachable_pub`).

**Risks:** per-child import slicing is the main mechanical watch-item (root imports
the union of ~25 names → `unused_qualifications`/unused-import per child). LSQ
invariant-`assert!` in a `Result` fn lands in `closure.rs` (`panic_in_result_fn`
deferred — fine, just note). Scattered `#[cfg(test)]` helpers/items move *with their
cluster* (they're not the `mod tests`, which already lives in `project/tests.rs`).

**Effort: L.** Suggested **3 PRs** by group, each independently green: (1)
peripheral — `stats`+`integrity`+`relationships`+`offsets` (settles the lone
type-move/re-export pattern first); (2) editing — `shots`+`connectivity`+`mutations`;
(3) geometry — `pathfinding`+`closure`+`coordinates`+`distance`. `closure.rs` (~1300)
is the one over-target file; optional grandchild `closure/solver.rs` for the LSQ
stack. **Do only when `project.rs` is quiescent** (geometry is Daniel's lane).

### `persistence/sqlite.rs` (2844 prod)

One giant `impl Database` + 6 result structs + 3 free helpers. Split into **9 children**
under `persistence/sqlite/` (dir already exists via `sqlite/tests.rs`); root keeps the
`Database` struct, the 3 free helpers, consts, `mod` decls + re-exports.

| Child | What moves | est LOC | ts-rs? |
|---|---|---:|:--:|
| `sqlite.rs` (root) | `struct Database`, `compress_json`/`decompress_json`/`format_blob_placeholder` (**keep private** — descendants see them), consts, `mod` decls + re-exports | ~120 | no |
| `sqlite/open.rs` | `open*`/`in_memory`/`has_project_data` | ~265 | no |
| `sqlite/migrate.rs` | the 4 migration fns | ~410 | no |
| `sqlite/schema.rs` | `init_schema` DDL + integrity/version helpers | ~660 | no |
| `sqlite/save.rs` | `save_project`/`save_project_name`/`save_collab_state` | ~375 | no |
| `sqlite/load.rs` | `load_metadata`/`load_project` + sub-loaders (+ fold tiny `settings`) | ~660 | no |
| `sqlite/undo.rs` | 9 undo/redo stack methods | ~220 | no |
| `sqlite/warnings.rs` | 7 resolved-warning methods + `ResolvedWarning` | ~280 | no |
| `sqlite/inspect.rs` | `read_raw_table` etc. + `RawTableData` | ~85 | **yes** |
| `sqlite/recovery.rs` | repair/salvage/backup + `BackupInfo`/`RepairResult`/`SalvagedData`/`SalvagedSection` | ~310 | **yes** |

**Re-export plan:** `pub use recovery::{BackupInfo, RepairResult, SalvagedData}` +
`pub use inspect::RawTableData` + `pub use warnings::ResolvedWarning` (all reached by
external `crate::persistence::…` callers via `mod.rs` glob, and by `tests.rs`' `use super::*`).
**Keep the 3 free helpers + consts + `Database` in the root** — descendants reference a
private root fn directly (no `pub(crate)`, no `unreachable_pub` risk); import consts via
`use super::{SCHEMA_VERSION, …}` to avoid `unused_qualifications`. `mod tests;` stays in
root → the 115 KB test file needs **zero edits** (verify with a no-edit test run).

**Risks:** `db.conn` private field is seen by all descendants (no visibility change — the
load-bearing reason for child layout). ts-rs: 4 `#[ts(export)]` structs move; output is
name-keyed so expect **zero `gen:ipc-types` diff** — but confirm per-PR. Leave `MAX_RAW_PAGE_ROWS`
`pub` as-is (tightening = a fresh `unreachable_pub` decision, out of scope).

**Effort: L.** Suggested **3 PRs**: (1) self-contained `undo`+`warnings`+`recovery`; (2)
the migration/DDL spine `open`+`migrate`+`schema`; (3) `save`+`load`+`inspect` (run ts-rs
regen here).

### `core/state/commands.rs` (2734 prod)

One `impl AppState` + 2 file-private helper structs + 2 inline test mods. Split into
**flat sibling files** under `core/state/` (NOT a subdir — every existing
`impl AppState` split is a flat sibling; a subdir would force a `commands/mod.rs`
rename for no benefit). `commands.rs` stays as the **dispatcher + integrity + batch
orchestration core**.

| Sibling file | What moves | est LOC |
|---|---|---:|
| `commands.rs` (keep) | `CommandIntegrity`, `command_integrity`, `cmd_affects_geometry`, integrity gate/repair/query, `execute` (dispatcher), `is_batch_allowed`, `execute_batch` | ~560 |
| `command_import.rs` | `execute_import_sections`, `execute_create_and_merge` + `CascadeDeferGuard` (its sole user) | ~860 |
| `command_shot.rs` | `create/update/delete_shot`, `set_shot_reference` | ~255 |
| `command_section.rs` | `create/delete/update_section` | ~110 |
| `command_station.rs` | merge/closure/datum station commands | ~210 |
| `command_move.rs` | `move_section/segment/station` | ~230 |
| `command_comment.rs` | comment commands + holder helpers | ~200 |
| `command_delete_split.rs` | 4 `execute_delete_*` composites | ~800 |
| `command_query.rs` | 5 connectivity/geometry query fns | ~250 |

**Re-export plan:** **none** — inherent `impl AppState` methods stay callable
regardless of file; `pub`/`pub(super)` consumers (`collab.rs`, `undo.rs`) keep
working. `CommandIntegrity` stays file-private (its users stay in `commands.rs`);
`CascadeDeferGuard` moves with its sole caller, stays file-private. Per-file
explicit imports (no `use super::*`).

**Risks:** the 2 test mods (`integrity_capability_tests`, `update_shot_clear_undo_tests`)
reach file-private items (`command_integrity`, `is_batch_allowed`, `CommandIntegrity`).
**Recommended: leave both test mods inline in `commands.rs`** — avoids 3 visibility
widenings for ~little gain; carry their `#[cfg(test)]`/`#[expect(clippy::unwrap_used)]`
verbatim. `command_import` (~860) and `command_delete_split` (~800) stay over-target
but cohesive (splitting `execute_import_sections` further = behavior-adjacent, not a
move).

**Effort: M.** Single PR; natural 2-PR fault line if smaller diffs wanted: low-coupling
domains first, then `command_import` + `command_delete_split` (carry the
`CascadeDeferGuard` relocation).

## MED

### `core/state/project_io.rs` (1510 prod)

One `impl AppState` (load/save/merge/create pipelines). Split into flat siblings under
`core/state/`. **Keep the save pipeline whole** — `save_project` (~573 LOC: atomic
`.stalx.tmp`→rename, deferred-save contract, permission-denied humanization,
collab-sibling) + `write_collab_sibling` + `save_failure` co-located; this is a cut at
method boundaries, zero internal logic touched.

| Sibling file | What moves | est LOC |
|---|---|---:|
| `project_io.rs` (keep) | `save_failure` (→`pub(super)`), `save_project`, `write_collab_sibling`, `initial_save_deferred`, `close_project` | ~670 |
| `project_load.rs` | `open_project`, `do_load_project_full` | ~550 |
| `project_create.rs` | `create_project`, `update_project_settings`, `do_create_project_full` (+ fold the 2 path fns here, see below) | ~430 |
| `project_merge.rs` | `merge_projects`, `archive_project_file` | ~410 |

**Tests (~103 LOC — stay inline):** the `mod tests` targets only `resolve_project_path`/
`next_available_project_path` → keep it **inline in `project_create.rs`** (where those fns
land); no separate test file. Carry `#[expect(clippy::unwrap_used, clippy::expect_used)]`.

**Re-export plan:** `save_failure` (free fn) → `pub(super)`, imported by `project_merge.rs`
via explicit `use super::project_io::save_failure;`. The 2 private path assoc-fns
(`resolve_project_path`, `next_available_project_path`) → `pub(super)` **only if**
separated from all callers — so **fold them into `project_create.rs`** (their consumer)
to avoid both the visibility bump and a sub-floor `project_paths.rs` (~110 LOC). Other
helpers are inherent methods, no change.

**Risks:** save-pipeline sensitivity (keep cohesive — don't carve its phases). The
progress fns use fn-local `macro_rules!` — self-contained, move with the fn.

**Effort: L.** **One PR** (pure move; `mod.rs` is a conflict magnet — land fast).

## LOW

### `config/types.rs` (1400 prod)

~25 config structs, each with `Default` (many in the sibling `config/defaults.rs`) +
`default_*` serde fns. Root keeps `Config` + `impl Config`; group sub-structs by domain
into `config/types/*.rs`.

| Child module | Structs (grouped by domain) | est LOC |
|---|---|---:|
| `config/types.rs` (root) | `Config` + full `impl Config`, `LegacySnapConfig`, `mod` decls + re-exports | ~180 |
| `config/types/map.rs` | Station/Shot/MapSnap/MapAnimation/Debug/MapDebug/GlobalView/Gps/Map/MapControls | ~430 |
| `config/types/appearance.rs` | Theme/Color/Appearance/SyntacticHighlight*/ShortcutFeedback | ~185 |
| `config/types/display.rs` | Display/DepthGradient/SectionColors/Units/DecimalPrecision/Validation | ~250 |
| `config/types/import.rs` | PlacementSuggestion/Overlap/Import/ClosureAdjustment | ~340 |
| `config/types/shortcuts.rs` | ShortcutsConfig + normalize helpers | ~393 |
| `config/types/panels.rs` | Panels/ProviderCache/Cache/General/Export/Logging | ~210 |

**⚠ ts-rs (the dominant risk):** **all 7 modules carry `#[derive(TS)]` types** — there is
no TS-free module to carve. The empty-`gen:ipc-types`-diff gate is **mandatory** here.
Safe because ts-rs keys output on **type name** not module path, and `gen_ipc_types`
imports via the `config::*` re-export (verified) — but it must be confirmed per-PR.

**Re-export plan:** explicit `pub use` of every moved struct from the root (list in the
analysis). Cross-module helpers needing re-export: `default_sigma_*` (read by
`defaults.rs`), `normalize_shortcut` (read by tests). `default_true` is shared across
map+panels → give it **one home** (a tiny shared module or `pub(super)` in root). Widen
cross-boundary items to `pub(crate)` (not `pub`) for `unreachable_pub`. The existing
`config/mod.rs` `pub use types::*` glob is an **in-crate re-export** → does NOT trip
`wildcard_imports`, stays as-is (keeps `crate::config::X` resolving everywhere).

**Effort: M.** One PR (this file → its own dir). Gate must include `pnpm gen:ipc-types`
→ empty diff.

### `core/state/undo.rs` (1261 prod)

One `impl AppState`, **no inline tests** (coverage is in the shared `core/state/tests.rs`).
The clean seam is **capture (build `UndoData`) vs. apply (consume it)** — *not* undo-vs-redo
(`undo_inner`/`redo_inner` share `reconcile_geometry`, `execute_without_undo`,
`restore_*`; splitting them would cross-file-couple the shared helpers).

**Recommended 2-way cut:**

| Sibling file | What moves | est LOC |
|---|---|---:|
| `undo_capture.rs` (new) | `generate_undo_data`, `finalize_undo_data`, `is_undoable` | ~530 |
| `undo.rs` (keep) | apply (`undo`/`undo_inner`/`redo`/`redo_inner`/`reconcile_geometry`/`execute_without_undo`/`restore_*`) + stack queries/navigation | ~1030 |

(3-way variant carves `undo_queries.rs` ~150 but lands at the floor — only if you want
the query surface isolated.)

**Re-export plan: none.** All inherent methods; `is_undoable` is already `pub(super)`,
IPC fns stay `pub`. **Zero visibility changes, zero re-exports, zero test relocation.**

**Effort: M.** Lowest-risk split of the batch — **do this one first** to settle the
`mod.rs`-declaration + `impl AppState`-sibling rhythm.

### `parsers/tml.rs` (1217 prod)

Ariane TML parse pipeline (xml → raw shots → sectioning → import-config). Root keeps the
7 ts-rs types + public entries; children under `parsers/tml/`.

| Child | What moves | est LOC | ts-rs? |
|---|---|---:|:--:|
| `parsers/tml.rs` (root) | 7 `#[ts(export)]` types, `parse_tml`, `convert_tml_to_import_configs`, `tml_content_sha256`; `mod` decls + re-exports; `mod tests;` | ~280 | **yes (all 7)** |
| `parsers/tml/xml.rs` | `RawShot`/`FileMetadata` + xml-load + raw-shot parse + field cleanup | ~360 | no |
| `parsers/tml/sections.rs` | `build_sections`/`linearize_section`/topology + `extract_closures` + unit conv | ~520 | no |
| `parsers/tml/import_config.rs` | `convert_shots_to_shot_data`, `determine_placement`, `normalize_tml_shot`, `resolve_tml_depth_in`, topo-sort | ~330 | no |
| `parsers/tml/tests.rs` | inline `mod tests` (carry `#[expect(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stderr)]` verbatim) | ~1830 | no |

**Re-export plan:** 7 types + `parse_tml`/`convert_tml_to_import_configs`/`tml_content_sha256`
stay in root (already `pub`). The 2 cross-crate `pub(crate)` fns
(`normalize_tml_shot`, `resolve_tml_depth_in`, used by `reconcile.rs`) →
`pub(crate) use import_config::{…}`. Root adds plain `use child::{…}` for its own bodies.

**Risk — the test `super::*` rule (applies to both parsers):** `mod tests;` resolves
`super` to the **root**, but the private fns the tests call now live in children → mark each
moved private item `pub(super)` (does *not* trip `unreachable_pub`) and add named
`use xml::{parse_raw_shots, …}; use sections::{build_sections, …};` etc. in the root so
`super::*` finds them. ts-rs types in root → **empty `gen:ipc-types` diff**.

**Effort: L.** **2 steps:** (1) extract `mod tests` → `tests.rs` (mechanical, halves the file,
de-risks); (2) carve the 3 modules + wire `pub(super)`/root `use`.

### `export/tml.rs` (1130 prod)

XML/zip exporter dominated by `build_export_shots` (~810 LOC). Root keeps the public
entries; children under `export/tml/`.

| Child | What moves | est LOC |
|---|---|---:|
| `export/tml.rs` (root) | `export_tml`, `export_tml_with_baseline`, `sha256_hex`, `names_for_path`, `write_output`, `write_zip` (20 LOC, fold here); `mod` decls + `pub use` | ~140 |
| `export/tml/names.rs` | `Names` + `LONG`/`SHORT` consts | ~110 |
| `export/tml/xml.rs` | `build_xml`, `write_shot`, `write_text_element`, `format_f64` | ~190 |
| `export/tml/shots.rs` | `pick_uuid`, `build_export_shots`, + the sub-floor azimuth/color/`station_depth` helpers folded in | ~840 |
| `export/tml/parent_tree.rs` | `ParentLink`, `build_parent_map`, `choose_default_root_section_id` | ~140 |
| `export/tml/tests.rs` | inline `mod tests` (carry `#[expect(clippy::unwrap_used, clippy::approx_constant)]`) | ~780 |

**Re-export plan:** root keeps `pub fn export_tml*`/`sha256_hex` (callers use
`crate::export::tml::*` + `export/mod.rs` `pub use tml::*`). Children private; `ExportShot`
→ `pub(super)` in `shots.rs`, consumed by `xml.rs` via explicit `use super::shots::ExportShot`.
Tests reach private helpers → root `use self::shots::{…}` so `tests.rs`' `use super::*` resolves
(enumerate explicitly, no glob).

**Tests (spill-whole — verified):** 30 tests, 17 narrow / 13 broad, but **16 of 17 narrow
target `shots`** (`xml` has 1, `names`/`parent_tree` have 0), so distributing buys nothing —
keep one `export/tml/tests.rs`. `pub(super)` surface: `build_export_shots`, `color_to_ariane`,
`reverse_pre_zero_azimuth`, `format_f64`, and `ExportShot` + its read fields. `#[expect]`:
`clippy::unwrap_used, clippy::approx_constant` (the lone `approx_constant` driver is the π
literal in `test_format_f64` — keep it).

**Effort: L** (one big function-cluster move). One PR. No ts-rs.

### `models/placement_suggest.rs` (1116 prod)

Suggestion engine: 7 ts-rs types, a DP **matching engine** (a distinct ~410-LOC band the
shape-of-file undersells), scoring, geometry. Root keeps types + public entries; children
under `placement_suggest/`.

| Child | What moves | est LOC |
|---|---|---:|
| `placement_suggest.rs` (root) | **all 7 ts-rs types** + `ExistingSection` + `suggest_all_placements`/`suggest_placements`; `mod` decls + re-exports | ~360 |
| `placement_suggest/config.rs` | `SuggestionConfig` + `Default`/`From` | ~95 |
| `placement_suggest/geometry.rs` | `MatchShot`/`TracePoint`, az/length/trace/intersection/clearance helpers | ~250 |
| `placement_suggest/scoring.rs` | the 4 `compute_*_score` + `shot_weight`/`cell_final_score` | ~200 |
| `placement_suggest/matching.rs` | DP engine: `SequenceMatch`/`DpCell`/`try_match_sequence` + suppress/key/run helpers | ~410 |
| `placement_suggest/tests.rs` | inline `mod tests` | ~1120 |

**Re-export plan:** **7 ts-rs types stay on root** → `gen:ipc-types` unchanged, `models/mod.rs`
glob intact (**no regen needed** — pure move preserves type module path). Children private;
cross-child items `pub(super)` with explicit `use super::{…}` (dense wiring is the real work).
Prefer `crate::models::horizontal_length_from_slope` over `super::super::` to avoid
`unused_qualifications`.

**Tests (spill-whole — verified):** 45 `#[test]` fns, but shared `make_*`/`MatchShot`
fixtures + a 4-child cross-cutting test (`single_adjacent_shot_can_support_station_alignment`)
make distribution spray `pub(super)` and duplicate fixtures → keep one `placement_suggest/tests.rs`.
`pub(super)` surface: `compute_shot_score`/`compute_single_shot_score`, `try_match_sequence`,
`station_context_multiplier`, `suppress_*`, `angular_difference`, `placement_crossing_clearance_ok`,
`ignored_crossing_pairs_for_suggestion`, `section_trace_points` + `MatchShot`/`TracePoint`/
`SuggestionConfig` (and read fields). The mod has **no `#[expect]` today** — needs
`clippy::float_cmp` (several `assert_eq!(score, 0.0)`) and likely
`clippy::field_reassign_with_default`; confirm against the deny gate, don't over-list.

**Effort: L.** One PR. No `pnpm gen:ipc-types` change expected.

### `lib.rs` (1101 prod) — crate root, special

The crate root + Tauri entry. **The `pub mod` block and all of `run()`** (builder,
`register_asynchronous_uri_scheme_protocol` closure, `on_window_event`, `setup`,
`generate_handler!`, `generate_context!`) **stay.** The misplaced tenant is the entire
**tile-fetch / HTTP machinery** (L38–1041) — caches, stats, consts, network fetch, overzoom,
response builders, content-type helpers, `parse_tile_uri` — plus its inline tests.

| Target | What | est LOC |
|---|---|---:|
| `src/lib.rs` (keep) | `pub mod` block, `mod tile_fetch;`, `run()` + only the imports `run()` needs | ~340 |
| `src/tile_fetch.rs` (**new**) | all tile-fetch machinery L38–1041 + its `use` block | ~1000 |
| `src/tile_fetch/tests.rs` (**spill** — large) | the moved `mod tests` (`parse_tile_uri`/`sanitize` + `parse_case!`/`sanitize_case!` macros) | ~1340 |

**Placement:** a **new top-level `tile_fetch.rs`**, *not* folded into `cache/` (the on-disk
SQLite tile store) or `tilemap_cache.rs` (the in-memory LRU) — the moved code is the
*network-fetch* layer that consumes both; keep it distinct.

**Re-export plan:** `pub use tile_fetch::{TileFetchStats, TileFetchStatsSnapshot}` (keeps
`crate::TileFetchStats` for `app_state.rs`) + `pub use tile_fetch::tile_fetch_impl` (keeps
`crate::tile_fetch_impl` for `commands/cache.rs`) — both genuinely crate-public so
`unreachable_pub` is satisfied. The closure's helpers (`parse_tile_uri`, `handle_tile_request`,
`build_error_response`) → `pub(crate)`. **Audit lib.rs for now-dead imports** (`unused_imports`)
but keep `http::StatusCode` (the closure passes it directly).

**Tests (spill — large, but trivial):** all tests exercise `parse_tile_uri`/`sanitize_content_type`,
both private to the single `tile_fetch.rs` module — so spilling to a sibling `tile_fetch/tests.rs`
needs **no `pub(super)`** (no child split; `use super::*` reaches everything). The
`#[expect(clippy::unwrap_used)]` (+ a nested `#[expect(unnecessary_wraps)]` on a helper) and the
2 macros travel with the tests. No ts-rs.

**Effort: M.** One contiguous block lifted to a new sibling + ~3 `pub(crate)` + 2 `pub use`;
lower-risk than the other LOW files. One PR.

### `parsers/compass.rs` (1060 prod)

Compass MAK/DAT parse + geometry + georeferencing + import-config. Root keeps the shared
internal types + 2 ts-rs types + `parse_compass`; children under `parsers/compass/`.

| Child | What moves | est LOC | ts-rs? |
|---|---|---:|:--:|
| `parsers/compass.rs` (root) | consts; `CompassFile`/`CompassSurveySummary` (ts) + `CompassImportOptions`; the 4 shared internal types (`FixedStation`/`CompassFileState`/`SurveyWithState`/`ParsedCompass`); `parse_compass`; `mod` decls + re-exports; **inline `#[cfg(test)] mod tests {}` (small — stays here)** | ~230 | **yes (2)** |
| `parsers/compass/parse.rs` | `parse_mak`/`parse_dat`/`read_latin1`/`build_preview` + shared `non_empty` | ~280 | no |
| `parsers/compass/geometry.rs` | `SurveyCtx`/`shot_geometry`/`shot_backsight_geometry`/`build_ctx` etc. | ~300 | no |
| `parsers/compass/georef.rs` | declination/IGRF/UTM→WGS84/datum/`resolve_anchor` | ~250 | no |
| `parsers/compass/convert.rs` | `split_into_chains`/`build_elevation`/`convert_compass_to_import_configs`/topo-sort | ~400 | no |

**Re-export plan:** only the 2 crossing public fns need `pub use parse::build_preview` +
`pub use convert::convert_compass_to_import_configs`. `parse_compass` + the 4 internal
types stay in root; children `use super::ParsedCompass` etc. Cross-child flow
parse→(geometry, georef)→convert is acyclic; all imports **explicit named**
(`compass_data::{…}` items repeated per child, never glob).

**Tests (~295 LOC — stay inline):** the `mod tests` stays inline in `compass.rs`; the carve
makes it reach child-private `utm_to_wgs84`/`resolve_anchor`/`parse_mak`/`build_preview`/
`shot_backsight_geometry` → mark exactly those `pub(super)`. Keep its `#[expect]` **exactly**
`clippy::unwrap_used, clippy::expect_used` (0 panic, 0 print — adding more trips
`unfulfilled_lint_expectations`). ts-rs in root → empty diff.

**Effort: M.** One PR — carve the 4 modules; tests stay put.

---

# Execution phases

This document is **Phase A (scoping) — complete.** The work below is **Phase B
(execution)**, ordered by risk and dependency. Every split PR is a pure move:
verify with the per-PR protocol above and **lower the file-size baseline** in the
same PR (the ratchet locks each win). ~16 PRs total.

| Phase | Scope | PRs | Depends on |
|---|---|---:|---|
| 1 — Foundations & warm-up | regression guard + `undo.rs` | 2 | — |
| 2 — `core/state` decomposition | `commands.rs`, `project_io.rs` | 2–3 | 1 |
| 3 — LOW-tier leaf files | `config/types`, `tml`, `compass`, `export/tml`, `placement_suggest`, `lib` | 6 | 1 (parallel to 2) |
| 4 — `persistence/sqlite.rs` | 9 children | 3 | 1 |
| 5 — `models/project.rs` (flagship) | 11 children | 3 | all; **quiescent only** |

### Phase 1 — Foundations & warm-up
**Goal:** stand up the recurrence guard before any split (so every later split
locks its win in), and prove the pure-move + verification loop on the safest target.
- **PR 1.1 — Regression guard:** `scripts/check-rust-file-size.py` + committed
  `src-tauri/file-size-baseline.json` (current sizes) + wire into CI `check`, add the
  `/pre-pr` lens, add the `CLAUDE.md`/`docs/architecture.md` rule.
- **PR 1.2 — `core/state/undo.rs`** (2-way: `undo_capture.rs` + slimmed `undo.rs`).
  Zero re-exports / visibility / test changes — settles the `mod.rs`-sibling rhythm.
- **Exit:** guard green on `master`; warm-up merged; Tier-0/Tier-1 verification validated end-to-end.

### Phase 2 — `core/state` decomposition
**Goal:** finish the established `impl AppState`-per-file pattern (`pub(super)` fields
already in place → no visibility changes).
- **PR 2.1 — `commands.rs`** → `command_{shot,station,section,move,comment,delete_split,query,import}.rs` (tests stay inline).
- **PR 2.2 — `project_io.rs`** → `project_{load,create,merge}.rs` (save pipeline whole; tests inline in `project_create.rs`).
- **Notes:** `core/state/mod.rs` is a conflict magnet — land fast. **Exit:** both files under budget.

### Phase 3 — LOW-tier leaf files (independent; parallelizable, one PR each)
**Goal:** split the six independent LOW files. No cross-dependencies — can interleave with Phase 2.
- **3.1 `config/types.rs`** → `config/types/{map,appearance,display,import,shortcuts,panels}.rs`. **⚠ ts-rs in every module → the `pnpm gen:ipc-types` empty-diff check is the gate.**
- **3.2 `parsers/tml.rs`** → `tml/{xml,sections,import_config}.rs` + spill `tml/tests.rs` (lift tests first).
- **3.3 `parsers/compass.rs`** → `compass/{parse,geometry,georef,convert}.rs` (tests stay inline).
- **3.4 `export/tml.rs`** → `tml/{names,xml,shots,parent_tree}.rs` + spill `tml/tests.rs`.
- **3.5 `models/placement_suggest.rs`** → `placement_suggest/{config,geometry,scoring,matching}.rs` + spill `tests.rs`.
- **3.6 `lib.rs`** → extract `tile_fetch.rs` (+ spill `tile_fetch/tests.rs`); keep the Tauri builder/`generate_handler!`/protocol in `lib.rs`.
- **Exit:** all six under budget.

### Phase 4 — `persistence/sqlite.rs` (HIGH, 3 PRs)
**Goal:** decompose the `impl Database` god-file.
- **4.1** self-contained clusters: `sqlite/{undo,warnings,recovery}.rs` (+ struct moves + re-exports).
- **4.2** migration/DDL spine: `sqlite/{open,migrate,schema}.rs`.
- **4.3** read/write: `sqlite/{save,load,inspect}.rs` — run the ts-rs regen + empty-diff check here.
- **Exit:** `sqlite.rs` root ≤ ~120 LOC; all clusters under budget.

### Phase 5 — `models/project.rs` flagship (HIGH, 3 PRs — LAST)
**Goal:** decompose the ~8k-line `impl Project`. Riskiest + most conflict-prone — do **last,
only when `project.rs` is quiescent** (geometry is Daniel's lane; coordinate on the in-flight board).
- **5.1** peripheral: `project/{stats,integrity,relationships,offsets}.rs` (settles the lone type-move + re-export pattern).
- **5.2** editing: `project/{shots,connectivity,mutations}.rs`.
- **5.3** geometry core: `project/{pathfinding,closure,coordinates,distance}.rs` (optional `closure/solver.rs` grandchild for the LSQ stack).
- **Exit:** `project.rs` root ≤ ~700 LOC; refactor complete.

### Optional / anytime — appendix test-spills
The sub-threshold but inline-test-heavy files (Appendix) can have their test modules spilled
to siblings independently of these phases — pure readability/token wins, not gated by anything.

### Two mechanical rules recur in every split
(a) cross-module-internal items are `pub(crate)`/`pub(super)`, **never bare `pub`**
(`unreachable_pub` is deny); (b) ts-rs `#[derive(TS)]` types **stay at the module root** so
`pnpm gen:ipc-types` yields an empty diff — `config/types.rs` is the one file with *no*
TS-free module, so it gets the most gen-diff attention.

---

# Appendix: test-extraction-only candidates

Files **below** the 1000-prod-LOC structural threshold whose on-disk bulk is a
large inline `#[cfg(test)]` module. No module split needed — just extract the
test module to a sibling `tests.rs` (the `project.rs`/`sqlite.rs` pattern) for a
cheap agent-token + readability win. Representative (prod / total):

| File | Prod | Total | Inline-test |
|------|-----:|------:|-----:|
| `parsers/dmp.rs` | 469 | 2229 | ~1760 |
| `export/image.rs` | 785 | 2098 | ~1313 |
| `core/undo.rs` | 343 | 1156 | ~813 |
| `models/section.rs` | 371 | 1007 | ~636 |
| `core/validation.rs` | 234 | 855 | ~621 |
| `telemetry/registry.rs` | 415 | 1008 | ~593 |

(Others with smaller inline-test tails exist; these are the clearest wins.)
