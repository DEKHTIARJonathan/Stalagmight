---
description: Adversarial code review against the project's agreed quality bar
---
Review the current change to Stalagmight (Tauri: Rust backend + React/TS frontend,
underwater cave-survey data). Be an ADVERSARIAL reviewer, not an approver: assume the
change is broken until you've shown otherwise. No rubber-stamping.

## Scope
Diff vs base (`git diff main...HEAD`, or staged/unstaged if no PR). Read enough
surrounding code to judge correctness; keep findings scoped to the change + its blast
radius. If it's large, review the riskiest files first and say what you didn't reach.

## Lenses — cover every one (this is what makes coverage consistent, not luck)

### 1. State invalidation & lifecycle  ← our #1 source of real bugs
- Cached external state (snap markers, ruler readout, warning identity, clipboard
  match, MapLibre feature-state)? It MUST be invalidated on the relevant mutation
  (reset, IPC reply, project edit, view switch) or re-derived before use.
- Stale index/position after a mutation: rehydrate mutable objects from live data **by
  identity key** (shot_id/uuid), don't trust an index captured before a delete/insert.
- MapLibre: `setData()` wipes `setFeatureState` — re-apply in the post-`setData`
  rebuild, NEVER per-hover in `updateVisualState()` (FPS death). Use `setFeatureState`,
  not `setFilter`, for per-feature visuals.

### 2. IPC / async correctness
- Every async IPC response that paints/mutates must be **version-guarded**: capture
  identity at request time (`created_at` + `modified_at` + file path + geometry-
  readiness) and drop the reply if state moved (undo/redo, reset, project switch).
- An in-flight request whose context was reset must not apply its stale response.

### 3. Geometry & multi-section integrity
- Range/loop ops: state inclusive vs exclusive boundaries explicitly; off-by-one here
  silently displaces or deletes the wrong sections. Add boundary unit tests.
- Anything keyed by uuid/position MUST include `section_id` in *every* read/write/
  delete path — duplicate UUIDs across sections collide. Test that case explicitly.
- IDs (`section_id`, `shot_id`) are immutable FKs for merges/closures/comments — flag
  any path that regenerates or reassigns them.
- Metadata-only edits (comment/LRUD) must NOT trigger geometry `reconcile`, `touch()`,
  or a dirty flag / undo entry. Gate side effects on an actual value change.

### 4. Migration & persistence
- Never persist transient in-memory values (freshly-minted UUIDs, `Config::default()`)
  before they're real — they orphan on next open. Restore should use the *current*
  project's config, not a hardcoded default.
- Test read-only / legacy / missing-table load paths and `INSERT OR REPLACE` collisions.
- Saves are atomic (temp `.stalx.tmp` → rename); flag direct overwrites.

### 5. UI ↔ backend guard parity
- A conditionally-disabled action needs a **backend guard** (read-only / DB-open /
  schema check that fails safe) — never rely on the UI disabled state alone.
- Disable destructive-action buttons until the impact preview resolves; the displayed
  impact must match the actions actually offered.
- A nullable-field UI guard must match the backend gate it implies (e.g. `databaseOpen`,
  not `file_path != null`).

### 6. Project landmines (rare but catastrophic — see linked docs)
- Telemetry registry is **append-only & frozen** in *both* `registry.rs` and
  `registry.ts`; never remove/reorder/renumber; new commands add `command.<name>`.
  (`docs/telemetry.md`; gated by `registry_*` tests.)
- IPC types are **generated** — never hand-edit `src/types/ipc/`; regen via
  `pnpm gen:ipc-types`. (`docs/ipc-typegen.md`)
- **Never** `cargo fmt` (hand-formatted Rust); match surrounding style. (`CLAUDE.md`)
- Heavy O(N) cross-checks must be `#[cfg(debug_assertions)]`; hot-path logs via
  `debugLog()`, not `console.log`. (`docs/debug-gates.md`, `docs/performance.md`)
- Cross-platform: macOS/Linux vs Windows tile-URL forms; Windows tests need
  `STALAGMIGHT_TEST_MANIFEST=1`. (`docs/architecture.md`, `CLAUDE.md`)

### 7. Tests
- Is the **adversarial** case tested (boundary, duplicate-UUID, legacy load), not just
  the happy path? Golden fixtures for parsers (`e2e/fixtures/*.dmp`). No
  `waitForTimeout` in Playwright. Did the change silently drop coverage or a fixture a
  test depends on?

### 8. Security (we're going open-source — assume hostile input)
- Input validation, path traversal, `unsafe` Rust, secret handling, no PII in telemetry.

## Anti-rubber-stamp
- Found nothing 🔴? You didn't look hard enough — name the **riskiest part** of the
  change and exactly what would break it.
- Separate what you **verified** from what you **assumed**; never assert a bug you
  didn't trace.
- Every finding: **file:line · why · fix-or-test**. No vague items.
- Don't re-flag known by-design: interior-station insert (intentional), `project.rs`
  formatting, `#[serde(default)]` config tolerance of unknown fields.

## Output (same shape every time, so reviews are comparable)
1. **Verdict** — Block / Approve-with-nits / Needs-work + the single most important issue.
2. **🔴 Must-fix** (correctness/security/CI/contract) — file:line · why · fix.
3. **🟡 Should-fix** — same format.
4. **🟢 Nits** — terse.
5. **Coverage** — what you reviewed, skipped, couldn't verify.
