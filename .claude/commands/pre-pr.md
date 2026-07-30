---
description: Adversarial pre-PR gate - fans out one subagent per review lens plus a lens-free adversarial reviewer, merges one verdict, and logs the run
---
Run the project's pre-PR review on the current change to Stalagmight (Tauri: Rust
backend + React/TS frontend, underwater cave-survey data). This is an ADVERSARIAL
review: assume the change is broken until you've shown otherwise. No rubber-stamping.

This command does NOT replace the bundled `/code-review` - it runs the project's
fixed lenses **in parallel** and merges them into a single verdict. (It keeps a
different name on purpose so `/code-review ultra`, `--comment`, and `--fix` stay
reachable.)

⚠ **`/code-review` cannot be invoked from this command at all.** It ships compiled
into the CLI with `disable-model-invocation`, which blocks BOTH a subagent (`Skill`
tool → "cannot be used ... due to disable-model-invocation") **and** the main thread -
the restriction is on the model, not on subagents, and the `/config` toggle is locked
by the skill's own frontmatter. There is no setting to flip and no file to edit. If you
want that voice on a change, **the user must type `/code-review high` themselves**;
this command cannot summon it. Subagent 10 is a lens-free adversarial reviewer instead.

## Scope
Diff vs base: `git diff master...HEAD` (fall back to staged, then unstaged, if there's
no PR branch). Read enough surrounding code to judge correctness; keep findings
scoped to the change + its blast radius. If the diff is large, tell each subagent to
review the riskiest files first and report what it didn't reach.

## How to run it - fan out, then synthesize

Launch the **subagents below in parallel** with the Task tool (issue them in a
single message so they run concurrently).

**Brief finders blind to author intent - this is load-bearing.** Give each subagent
ONLY the diff/scope above + the files to read. Do NOT tell them what the change "is
trying to do," why it's correct, or that any part is safe - author framing biases
finders into confirming the author's mental model, and is exactly how a P1 has
slipped through here (the orchestrator handed finders its own conclusion and they
confirmed it). The PR description and in-code "why" comments are **claims to verify,
not facts.** If a finder needs orientation, give neutral file pointers ("the
close-guard lives in `useBeforeUnload.ts`") - never a verdict ("the close-guard
protects this").

Give every subagent this shared contract:

> Review ONLY through your assigned lens - do not defer to or suppress another lens.
> Return findings as `file:line · why · fix-or-test`. Separate what you VERIFIED
> (traced in the code) from what you ASSUMED; never assert a bug you didn't trace.
> **Apply that same burden of proof to SAFETY:** a "this is correct/safe because X"
> conclusion needs the line that proves X quoted. An unverified load-bearing
> assumption - a membership/enumeration/config/consumer you did not actually read -
> is itself a finding: report it as `ASSUMPTION (unverified): … · what to check`.
> Naming a risk and then dismissing it without tracing is NOT allowed.
> **Verify consumers, not just producers:** for any state/flag/field the change
> writes, grep its consumers and confirm at least one delivers the change's intended
> effect for the specific route/state in question - quote the consumer's gating line.
> If you find nothing, name the riskiest part of the change in your area, exactly what
> would break it, then verify-or-flag it per above. Highest-signal findings first.

Subagents 1-8 each own exactly one numbered lens:

**Subagent 1 - State invalidation & lifecycle** ← our #1 source of real bugs
- Cached external state (snap markers, ruler readout, warning identity, clipboard
  match, MapLibre feature-state) MUST be invalidated on the relevant mutation
  (reset, IPC reply, project edit, view switch) or re-derived before use.
- Stale index/position after a mutation: rehydrate mutable objects from live data **by
  identity key** (shot_id/uuid), never an index captured before a delete/insert.
- MapLibre: `setData()` wipes `setFeatureState` - re-apply in the post-`setData`
  rebuild, NEVER per-hover in `updateVisualState()` (FPS death). Use `setFeatureState`,
  not `setFilter`, for per-feature visuals.

**Subagent 2 - IPC / async correctness** (this guard is frontend/TS only)
- **Do not launch this lens when the diff contains no TypeScript at all.** The lens is
  TS-only by its own definition (the Rust note at the end of it says so), so on a
  Rust-only, docs-only, or CI-only diff it can produce nothing and costs a full finder.
  Gate on the SAME diff expression Scope selected (below it is the committed-branch
  form; on the staged/unstaged fallback substitute that, or the gate reports empty for
  every change and skips this lens on a pure-TS diff):
  `git diff --name-only master...HEAD -- '*.ts' '*.tsx'`
  Empty output means skip it, and record `{"lens": 2, "why": "no TS in diff"}` in
  `lenses_skipped` when you log the run - a skip that isn't recorded is
  indistinguishable from a lens that ran and found nothing.
  ⚠ Match those two patterns exactly. `'src/**/*.ts'` looks equivalent and is **not**:
  git pathspecs are fnmatch without `:(glob)`, so `*` already spans `/` and the literal
  slash before `*.ts` forces at least one directory level - it silently misses
  `src/App.tsx`, `src/main.tsx`, and `src/globals.d.ts`, which is exactly where
  mount-time IPC wiring lives. The bare `'*.ts' '*.tsx'` form also correctly catches TS
  outside `src/`, such as `e2e-playwright/mocks/tauri-ipc.ts`.
- Every async IPC response that paints/mutates must be **version-guarded**: capture
  identity at request time (`created_at` + `modified_at` + file path - see
  `projectIdentityKey` in `src/hooks/useMapTools.ts`) and drop the reply if state moved
  (undo/redo, reset, project switch).
- Geometry-readiness is a **separate** guard, not part of that identity tuple: the async
  measured→adjusted swap doesn't bump `modified_at`, so a ruler-clearing effect keyed on
  `stationsAdjusted`/`surveyDataAdjusted` in `closureAdjusted` mode handles it
  (`src/components/Map/MapCanvas.tsx`) - check both.
- An in-flight request whose context was reset must not apply its stale response.
- Look in TS only (`src/hooks`, `src/components/Map`, `src/store`). Rust's analogous
  staleness handling is a different concern - a server-side solved-geometry cache keyed on
  `modified_at` nanos (`src-tauri/src/core/state/app_state.rs`) + load-token filtering.

**Subagent 3 - Geometry & multi-section integrity**
- Range/loop ops: state inclusive vs exclusive boundaries explicitly; off-by-one here
  silently displaces or deletes the wrong sections. Add boundary unit tests.
- Anything keyed by uuid/position MUST include `section_id` in *every* read/write/
  delete path - duplicate UUIDs across sections collide. Test that case explicitly.
- IDs (`section_id`, `shot_id`) are immutable FKs for merges/closures/comments - flag
  any path that regenerates or reassigns them.
- Metadata-only edits (comment/LRUD) must NOT trigger the geometry reconcile epilogue
  (`reconcile_geometry()`) - but they DO still `touch()` (bump `modified_at`) and push an
  undo entry; that's correct. Gate the *reconcile*, not the dirty/undo, on an actual
  geometry change. (There's no boolean `is_dirty`; the dirty signal is the `modified_at`
  timestamp that `Project::touch()` bumps.)

**Subagent 4 - Migration & persistence**
- Never persist transient in-memory values (freshly-minted UUIDs, `Config::default()`)
  before they're real - they orphan on next open. Restore should use the *current*
  project's config, not a hardcoded default.
- Test read-only / legacy / missing-table load paths and `INSERT OR REPLACE` collisions.
- Saves are atomic (temp `.stalx.tmp` → rename); flag direct overwrites.

**Subagent 5 - UI ↔ backend guard parity**
- A conditionally-disabled action needs a **backend guard** (read-only / DB-open /
  schema check that fails safe) - never rely on the UI disabled state alone.
- Disable destructive-action buttons until the impact preview resolves; the displayed
  impact must match the actions actually offered.
- A nullable-field UI guard must match the backend gate it implies (e.g. `databaseOpen`,
  not `file_path != null`).

**Subagent 6 - Project landmines** (rare but catastrophic - read the linked docs)
- Telemetry wire format is **self-describing JSON+gzip (v3, #137)**: event names are sent
  verbatim - there is **no numeric wire registry and no `registry.ts`**.
  `src-tauri/src/telemetry/registry.rs` still exists but only as the canonical
  `EVENT_NAMES`/`SOURCE_NAMES` vocabulary backing the `registry_covers_all_*` tests (order
  is irrelevant; no worker-side copy to sync). Adding a command/tool/dialog/source means
  adding its name there (and to the canonical lists in `src/utils/telemetry.ts`) so those
  tests pass; new commands use `command.<name>`. (`docs/telemetry.md`.)
- IPC types are **generated** - never hand-edit `src/types/ipc/`; regen via
  `pnpm gen:ipc-types`. (`docs/ipc-typegen.md`)
- Rust **formatting + lints are CI-gated** (`check` job): `cargo fmt --check` and
  `cargo clippy` (deny-level) on `src-tauri` must pass - run `cargo fmt` and clear
  clippy before pushing; flag any drift. Match the surrounding style. (`CLAUDE.md`,
  `docs/linting.md`)
- **File-size ratchet is CI-gated** (`check` job, `pnpm lint:rust-file-size` vs
  `src-tauri/file-size-baseline.json`): flag a PR that grows a non-test `src-tauri/src`
  file already at/above 1500 prod LOC past its baseline, introduces a *new* file at/above
  1500, pushes any new/grown file over the 2000-prod-LOC hard cap, or adds a new
  god-`impl`/god-file - those belong in a module split (#157), not a bigger file. A
  legitimate growth must bump the baseline (`--update`) in the same PR.
- Heavy O(N) cross-checks must be `#[cfg(debug_assertions)]`; hot-path logs via
  `debugLog()`, not `console.log`. (`docs/debug-gates.md`, `docs/performance.md`)
- Cross-platform: macOS/Linux vs Windows tile-URL forms; Windows tests need
  `STALAGMIGHT_TEST_MANIFEST=1`. (`docs/architecture.md`, `CLAUDE.md`)

**Subagent 7 - Tests**
- Is the **adversarial** case tested (boundary, duplicate-UUID, legacy load), not just
  the happy path? Golden fixtures for parsers (`e2e/fixtures/*.dmp`). `waitForTimeout` is
  discouraged (the #1 Playwright flake source, `docs/TESTING.md`) but is NOT lint-enforced
  and is still widely used - flag NEW uses, don't assume a guard exists. Did the change
  silently drop coverage or a fixture a test depends on?

**Subagent 8 - Security** (going open-source - assume hostile input)
- Input validation, path traversal, `unsafe` Rust, secret handling, no PII in telemetry.

**Subagent 9 - Goal & guarantee trace** (end-to-end; cross-cutting, not lens-bound)
- From the DIFF ALONE infer what user-facing guarantee the change must deliver
  (data-safety, close/unsaved guard, persistence, undo, UI↔backend parity), then
  trace each guarantee end-to-end: **trigger → state written → consumer that reads
  it → effect.** Do not assume any link in that chain; read each one.
- Confirm the SPECIFIC route/dialog/state this change touches is actually in the set
  the consumer checks - read the enumerated list/condition, never assume membership.
  (The canonical miss: a flag was set correctly but no consumer read it for that
  dialog state, so the guard never fired.) Quote the consumer's gating line.
- A broken or unverifiable guarantee chain is a high-signal finding even when every
  individual hunk is correct. If the change's own claims can't be traced to the code
  that delivers them, say so explicitly.

**Subagent 10 - Lens-free adversarial reviewer** (no assigned area; that is the point)
- Give it the same diff and the same shared contract, but **no lens**. Tell it explicitly
  that it owns no area and must follow the change wherever it leads - build/lint output,
  generated files, dependency and cost implications, docs and release text that ship
  alongside the code, dead code, a formula duplicated in a second language, a comment
  that asserts something the code does not do. Anything the eight fixed lenses have no
  column for.
- It exists because the eight fixed lenses share their blind spots. Its recurring value
  is a **class** of finding none of them has a column for: build/lint output, provenance,
  duplicated rules, and prose that ships with the code. On this command's own review it
  was the only voice to find that two sibling copies of this very file existed and had
  not been updated. (Earlier rounds credited it with catching net-new clippy warnings and
  a triple `Project` deep-clone; treat single-round anecdotes as weak evidence, which is
  what `.claude/review-log.jsonl` exists to replace.)
- Like Subagent 9 this is a judgment voice, not a checklist walk. If per-lens model
  routing is ever added, **9 and 10 are the two that must not be down-tiered.**
- Do **not** try to invoke the bundled `/code-review` here (see the warning at the top);
  both the subagent path and the main-thread fallback are blocked, and attempting it has
  twice burned a full finder's tokens before failing.

## Synthesize (you, in the main thread)
Wait for all subagents, then merge:
- Dedup findings pointing at the same `file:line` + mechanism; keep the most concrete
  one and note every lens/subagent that raised it (multi-lens findings rank higher).
- Drop anything REFUTED on a second look; keep VERIFIED above ASSUMED.
- Don't re-flag known by-design: mid-section shot insert renumbering later stations
  (intentional - `insert_shot_after`/`insert_shot_before` in `src-tauri/src/models/project.rs`,
  and the `CreateShot` comment in `src-tauri/src/core/state/commands.rs`), `project.rs`
  formatting, `#[serde(default)]` config tolerance of unknown fields.

## Output (same shape every time, so reviews are comparable)
1. **Verdict** - Block / Approve-with-nits / Needs-work + the single most important issue.
   ⚠ When you log the run, these map to `block` / **`nits`** / `needs-work`. The middle
   one is not a case transform of its display label, and the logger rejects anything
   else - so "Approve-with-nits" written verbatim costs a wasted round.
2. **🔴 Must-fix** (correctness/security/CI/contract) - `file:line · why · fix`.
3. **🟡 Should-fix** - same format.
4. **🟢 Nits** - terse.
5. **Coverage** - which lenses ran, what each reviewed / skipped / couldn't verify, and
   **why** any lens did not run (a path gate, an unreachable file, a large diff you ran
   out of room on). Name skips explicitly; silent omission reads as coverage.

## Log the run (instrumentation - one line per review)
After printing the verdict, log the run with the vendored script rather than appending a
line by hand - it validates the record and appends exactly one JSON line to
`<repo-root>/.claude/review-log.jsonl`, creating the file if absent and never rewriting
existing content. The log is gitignored and per-contributor.

What this can answer: **which lenses produce must-fixes, and which run clean.** A lens
that runs and finds nothing is the signal; without `lenses_run` and `lenses_skipped`,
ran-clean and never-ran are indistinguishable. It does **not** record duration or cost, so
it cannot rank lenses by wall-clock - the schema has no field for it and rejects unknown
keys.

⚠ **Read this before retiring a lens on the log's evidence.** Nothing in the repo reads
the log; the only reader is `~/tools/review_log_summary.py`, which is personal and
unversioned here. And only the Claude path logs today - the sibling definitions
(`.agents/skills/pre-pr/SKILL.md` for Codex `$pre-pr`, `.opencode/command/pre-pr.md`) have
no log step, so **the log is a partial sample of runs.** A skipped lens is evidence of
nothing, not evidence against the lens.

Record shape:

```json
{"verdict":"block|nits|needs-work","findings":[{"lens":<1-10>,"severity":"red|yellow|green","file":"<path:line>","verified":true}],"lenses_run":[1,3,4,5,6,7,8,9,10],"lenses_skipped":[{"lens":2,"why":"no TS in diff"}]}
```

**Write the record to a file and redirect it in. Do not splice it into a quoted shell
word:** a record embeds `file:line` values taken from the diff under review, and a path
containing a single quote closes the quoting and turns the rest into shell syntax. On a
hostile branch that is arbitrary command execution, and this command exists to review
exactly such branches. Use the Write tool, then:

```
python3 scripts/review/log_run.py < <path-to-record>.json
```

- **Omit `date` and `branch`** - the script fills them (today's UTC date, and
  `git rev-parse --abbrev-ref HEAD`, or a short commit sha if HEAD is detached). If you do
  supply them they are recorded **as given and not cross-checked**, so a wrong value
  silently poisons the log. Note the script's date is UTC and may be a day ahead of local.
- Include every 🔴/🟡 finding (🟢 optional); set `verified:true` only for findings actually
  traced in code, `false` for ASSUMED/unverified.
- **`lenses_run` and `lenses_skipped` must account for every lens exactly once**: disjoint,
  no duplicates, and together covering 1-10. Every `findings[].lens` must appear in
  `lenses_run`. The script rejects a record that breaks any of those - a lens claimed as
  both run and skipped, an unaccounted lens, or a finding from a lens that sat the run out
  each corrupt the keep/retire decision. `lenses_run` may be empty if genuinely every lens
  was skipped; `lenses_skipped` may be omitted and is always written as `[]`.
- **The exit code tells you what went wrong, if anything:**
  - `0` - logged. The review is not logged until you see this.
  - `1` - the record was rejected (bad verdict, out-of-range lens, unknown key, malformed
    JSON, broken lens accounting) and the log file was left untouched. Fix the record.
  - `2` - an environment problem (not inside a repo, empty/absent stdin, git missing, the
    log path unwritable or a symlink), not a content problem - the record may be fine.
    Fix the invocation, not the JSON.
- ⚠ The log path comes from `git rev-parse --show-toplevel`, so **cwd decides which
  checkout gets written** - a sibling clone or a worktree each keeps its own log, and
  because the file is gitignored a stray write is invisible to `git status`. When probing
  or testing the script by hand, set `STALAGMIGHT_REVIEW_LOG` to an absolute scratch path.

Self-test: `python3 scripts/review/test_log_run.py` (36 tests, stdlib only, no network).
Not wired into CI, unlike every sibling gate's `lint:*:test` - run it by hand after
editing the logger.
