---
description: Adversarial pre-PR gate — fans out one subagent per review lens plus the bundled /code-review, then merges one verdict
---
Run the project's pre-PR review on the current change to Stalagmight (Tauri: Rust
backend + React/TS frontend, underwater cave-survey data). This is an ADVERSARIAL
review: assume the change is broken until you've shown otherwise. No rubber-stamping.

This command does NOT replace the bundled `/code-review` — it runs the project's
fixed lenses **in parallel**, folds the bundled review in as one more voice, and
merges everything into a single verdict. (It keeps a different name on purpose so
`/code-review ultra`, `--comment`, and `--fix` stay reachable.)

## Scope
Diff vs base: `git diff master...HEAD` (fall back to staged, then unstaged, if there's
no PR branch). Read enough surrounding code to judge correctness; keep findings
scoped to the change + its blast radius. If the diff is large, tell each subagent to
review the riskiest files first and report what it didn't reach.

## How to run it — fan out, then synthesize

Launch the **9 subagents below in parallel** with the Task tool (issue them in a
single message so they run concurrently). Give every subagent the diff/scope above
plus this shared contract:

> Review ONLY through your assigned lens — do not defer to or suppress another lens.
> Return findings as `file:line · why · fix-or-test`. Separate what you VERIFIED
> (traced in the code) from what you ASSUMED; never assert a bug you didn't trace.
> If you find nothing, name the riskiest part of the change in your area and exactly
> what would break it. Highest-signal findings first.

Subagents 1–8 each own exactly one numbered lens:

**Subagent 1 — State invalidation & lifecycle** ← our #1 source of real bugs
- Cached external state (snap markers, ruler readout, warning identity, clipboard
  match, MapLibre feature-state) MUST be invalidated on the relevant mutation
  (reset, IPC reply, project edit, view switch) or re-derived before use.
- Stale index/position after a mutation: rehydrate mutable objects from live data **by
  identity key** (shot_id/uuid), never an index captured before a delete/insert.
- MapLibre: `setData()` wipes `setFeatureState` — re-apply in the post-`setData`
  rebuild, NEVER per-hover in `updateVisualState()` (FPS death). Use `setFeatureState`,
  not `setFilter`, for per-feature visuals.

**Subagent 2 — IPC / async correctness** (this guard is frontend/TS only)
- Every async IPC response that paints/mutates must be **version-guarded**: capture
  identity at request time (`created_at` + `modified_at` + file path — see
  `projectIdentityKey` in `src/hooks/useMapTools.ts`) and drop the reply if state moved
  (undo/redo, reset, project switch).
- Geometry-readiness is a **separate** guard, not part of that identity tuple: the async
  measured→adjusted swap doesn't bump `modified_at`, so a ruler-clearing effect keyed on
  `stationsAdjusted`/`surveyDataAdjusted` in `closureAdjusted` mode handles it
  (`src/components/Map/MapCanvas.tsx`) — check both.
- An in-flight request whose context was reset must not apply its stale response.
- Look in TS only (`src/hooks`, `src/components/Map`, `src/store`). Rust's analogous
  staleness handling is a different concern — a server-side solved-geometry cache keyed on
  `modified_at` nanos (`src-tauri/src/core/state/app_state.rs`) + load-token filtering.

**Subagent 3 — Geometry & multi-section integrity**
- Range/loop ops: state inclusive vs exclusive boundaries explicitly; off-by-one here
  silently displaces or deletes the wrong sections. Add boundary unit tests.
- Anything keyed by uuid/position MUST include `section_id` in *every* read/write/
  delete path — duplicate UUIDs across sections collide. Test that case explicitly.
- IDs (`section_id`, `shot_id`) are immutable FKs for merges/closures/comments — flag
  any path that regenerates or reassigns them.
- Metadata-only edits (comment/LRUD) must NOT trigger the geometry reconcile epilogue
  (`reconcile_geometry()`) — but they DO still `touch()` (bump `modified_at`) and push an
  undo entry; that's correct. Gate the *reconcile*, not the dirty/undo, on an actual
  geometry change. (There's no boolean `is_dirty`; the dirty signal is the `modified_at`
  timestamp that `Project::touch()` bumps.)

**Subagent 4 — Migration & persistence**
- Never persist transient in-memory values (freshly-minted UUIDs, `Config::default()`)
  before they're real — they orphan on next open. Restore should use the *current*
  project's config, not a hardcoded default.
- Test read-only / legacy / missing-table load paths and `INSERT OR REPLACE` collisions.
- Saves are atomic (temp `.stalx.tmp` → rename); flag direct overwrites.

**Subagent 5 — UI ↔ backend guard parity**
- A conditionally-disabled action needs a **backend guard** (read-only / DB-open /
  schema check that fails safe) — never rely on the UI disabled state alone.
- Disable destructive-action buttons until the impact preview resolves; the displayed
  impact must match the actions actually offered.
- A nullable-field UI guard must match the backend gate it implies (e.g. `databaseOpen`,
  not `file_path != null`).

**Subagent 6 — Project landmines** (rare but catastrophic — read the linked docs)
- Telemetry wire format is **self-describing JSON+gzip (v3, #137)**: event names are sent
  verbatim — there is **no numeric wire registry and no `registry.ts`**.
  `src-tauri/src/telemetry/registry.rs` still exists but only as the canonical
  `EVENT_NAMES`/`SOURCE_NAMES` vocabulary backing the `registry_covers_all_*` tests (order
  is irrelevant; no worker-side copy to sync). Adding a command/tool/dialog/source means
  adding its name there (and to the canonical lists in `src/utils/telemetry.ts`) so those
  tests pass; new commands use `command.<name>`. (`docs/telemetry.md`.)
- IPC types are **generated** — never hand-edit `src/types/ipc/`; regen via
  `pnpm gen:ipc-types`. (`docs/ipc-typegen.md`)
- Rust **formatting + lints are CI-gated** (`check` job): `cargo fmt --check` and
  `cargo clippy` (deny-level) on `src-tauri` must pass — run `cargo fmt` and clear
  clippy before pushing; flag any drift. Match the surrounding style. (`CLAUDE.md`,
  `docs/linting.md`)
- Heavy O(N) cross-checks must be `#[cfg(debug_assertions)]`; hot-path logs via
  `debugLog()`, not `console.log`. (`docs/debug-gates.md`, `docs/performance.md`)
- Cross-platform: macOS/Linux vs Windows tile-URL forms; Windows tests need
  `STALAGMIGHT_TEST_MANIFEST=1`. (`docs/architecture.md`, `CLAUDE.md`)

**Subagent 7 — Tests**
- Is the **adversarial** case tested (boundary, duplicate-UUID, legacy load), not just
  the happy path? Golden fixtures for parsers (`e2e/fixtures/*.dmp`). `waitForTimeout` is
  discouraged (the #1 Playwright flake source, `docs/TESTING.md`) but is NOT lint-enforced
  and is still widely used — flag NEW uses, don't assume a guard exists. Did the change
  silently drop coverage or a fixture a test depends on?

**Subagent 8 — Security** (going open-source — assume hostile input)
- Input validation, path traversal, `unsafe` Rust, secret handling, no PII in telemetry.

**Subagent 9 — Bundled `/code-review`**
- Task this subagent to run the bundled reviewer and report its findings verbatim:
  invoke the `code-review` skill at high effort (Skill tool → skill `code-review`,
  args `high`) against the same diff, and return its 🔴/🟡 list as
  `file:line · why · fix-or-test`.
- Fallback: if your harness disallows invoking a skill inside a subagent, skip this
  subagent and instead run `/code-review high` yourself in the main thread, in
  parallel with collecting subagents 1–8, and treat its output as the 9th input.

## Synthesize (you, in the main thread)
Wait for all subagents, then merge:
- Dedup findings pointing at the same `file:line` + mechanism; keep the most concrete
  one and note every lens/subagent that raised it (multi-lens findings rank higher).
- Drop anything REFUTED on a second look; keep VERIFIED above ASSUMED.
- Don't re-flag known by-design: mid-section shot insert renumbering later stations
  (intentional — `insert_shot_after`/`insert_shot_before` in `src-tauri/src/models/project.rs`,
  and the `CreateShot` comment in `src-tauri/src/core/state/commands.rs`), `project.rs`
  formatting, `#[serde(default)]` config tolerance of unknown fields.

## Output (same shape every time, so reviews are comparable)
1. **Verdict** — Block / Approve-with-nits / Needs-work + the single most important issue.
2. **🔴 Must-fix** (correctness/security/CI/contract) — `file:line · why · fix`.
3. **🟡 Should-fix** — same format.
4. **🟢 Nits** — terse.
5. **Coverage** — which lenses ran, what each reviewed / skipped / couldn't verify, and
   the `/code-review` subagent's verdict shown alongside the lens verdicts.
