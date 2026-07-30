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

## Pre-flight (you, in the main thread, BEFORE fanning out) = lens 6

Compute the diff surface once and run the deterministic gates once. This used to be
Subagent 6, and it is no longer a subagent: on this command's own review **three
separate finders each independently ran `lint:no-em-dash` and `lint:private-leaks`** -
identical, deterministic, whole-tree commands, paid for three times. A gate that returns
the same answer regardless of which model runs it does not need a model.

⚠ **Pick the diff expression ONCE - the one Scope selected - and use that SAME expression
for every probe below.** They are written `master...HEAD`; on the staged fallback
substitute `--staged`, on the unstaged fallback drop the range entirely. Get this wrong and
all five probes return empty on a real change, every gated lens is skipped, and each one is
logged with a `why` that is false - in the single field the log exists to make trustworthy.
An empty surface list on a fallback path means **recompute with the right expression**, not
*skip*.

```
git diff --name-only master...HEAD                                  # the surface
git diff --name-only master...HEAD -- '*.ts' '*.tsx'                # TS?
git diff --name-only master...HEAD -- 'src-tauri/'                  # Rust crate?
git diff --name-only master...HEAD -- 'src/'                        # frontend?
git diff --name-only master...HEAD -- 'e2e-playwright/'             # Playwright specs?
```

Then, only for the surfaces present:

| Surface in diff | Run |
|---|---|
| always | `pnpm lint:no-em-dash:test && pnpm lint:no-em-dash` · `pnpm lint:private-leaks:test && pnpm lint:private-leaks` |
| `src-tauri/` | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` · `pnpm lint:rust-file-size:test && pnpm lint:rust-file-size` · deny-level clippy |
| `src/` | `pnpm tsc --noEmit` · `pnpm lint:ts-file-size:test && pnpm lint:ts-file-size` · `pnpm lint:readonly-gates:test && pnpm lint:readonly-gates` |
| `e2e-playwright/` | `pnpm typecheck:playwright` · `pnpm test:mock-contract` · `pnpm lint:e2e-parallel` · `pnpm lint:pw-timing:test` |
| `scripts/review/` | `python3 scripts/review/test_log_run.py` |

Each ratchet is paired with its own `:test` because CI pairs them (`ci.yml`, three
instances) - the self-test pins the LOC/strip heuristic the gate depends on, and both are
sub-second.

⚠ **This table is deliberately NOT the whole merge gate, and "gates green" must not be
reported as if it were.** The `check` job also runs `cargo test --features telemetry`,
`pnpm test` (vitest), and `pnpm typecheck:agent`; those take minutes, they are the
**Pre-Push Checklist's** job (`CLAUDE.md`), and running them here would cost more than the
whole fan-out this pre-flight exists to shrink. So say *which* gates you ran, and say that
the test suites were deferred to CI - a reviewer reading "gates green" must not conclude the
merge gate is green.

⚠ A **failing gate is a 🔴 in its own right** - report it, and say which gates you ran
and which the diff made irrelevant. Neither file-size ratchet covers anything outside
`src-tauri/src` and `src/`, so a large new file elsewhere is ungated; say so rather than
implying coverage. Put the gate output in every finder's brief so none of them re-runs it.

⚠ **`.github/workflows/**` has no row above and no gate anywhere** - there is no YAML linter
in this repo and no parser in either runtime here, so a workflow edit can only be checked
structurally (indentation against a sibling step) until CI actually runs it. Say that plainly
when the diff touches one. Note also that `.claude/commands/*.md` matches `ci.yml`'s
`paths-ignore` (`**/*.md`), so a change to THIS file alone runs no CI at all.

**Landmines that are knowledge, not gates** - these were the other half of Subagent 6.
Include this list verbatim in every finder's brief; whichever lens owns the touched area
checks the relevant one:
- Telemetry is self-describing JSON+gzip (v3, #137); event names go out verbatim. There is
  **no numeric wire registry and no `registry.ts`**. A new command/tool/dialog/source must
  be added to `EVENT_NAMES`/`SOURCE_NAMES` in `src-tauri/src/telemetry/registry.rs` and to
  the canonical lists in `src/utils/telemetry.ts`, or `registry_covers_all_*` fails. New
  commands use `command.<name>`. (`docs/telemetry.md`)
- IPC types are **generated**: never hand-edit `src/types/ipc/`; regen with
  `pnpm gen:ipc-types`. (`docs/ipc-typegen.md`)
- Heavy O(N) cross-checks must be `#[cfg(debug_assertions)]`; hot-path logs via
  `debugLog()`, not `console.log`. (`docs/debug-gates.md`, `docs/performance.md`)
- Cross-platform: macOS/Linux vs Windows tile-URL forms; Windows tests need
  `STALAGMIGHT_TEST_MANIFEST=1`. (`docs/architecture.md`, `CLAUDE.md`)
- A file already at/above 1500 prod LOC must be **split**, not rebaselined (#157).

## How to run it - fan out, then synthesize

Launch the **subagents below in parallel** with the Task tool (issue them in a
single message so they run concurrently). **Launch only the lenses whose path gate the
pre-flight satisfied** - a gated-out lens costs a full finder to produce nothing it could
have produced. Record every one you don't launch in `lenses_skipped`.

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

### Which lenses to launch

| Lens | Launch when | `why` if skipped |
|---|---|---|
| 1 state/lifecycle | always | - |
| 2 IPC/async | diff has `*.ts`/`*.tsx` | no TS in diff |
| 3 geometry integrity | diff touches `src-tauri/` | no Rust in diff |
| 4 persistence | diff touches `src-tauri/`, **or** adds any on-disk artifact | no persistence surface in diff |
| 5 guard parity | diff touches `src/` | no UI surface in diff |
| 6 landmines | **retired** - now the Pre-flight, run in the main thread | - |
| 7 tests | always | - |
| 8 security | always | - |
| 9 guarantee trace | **always. Never gate this one.** | - |
| 10 lens-free | **always. Never gate this one.** | - |

A docs-only change therefore launches 1, 7, 8, 9, 10 - five finders, not nine. 9 and 10
are ungated on purpose: they are the two that found what nobody else did on this command's
own review, and a cross-cutting lens cannot be predicted from a path.

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
- **Gate: skip unless the diff touches `src-tauri/`.** Every subject of this lens - the
  reconcile epilogue, `section_id` scoping, immutable id FKs, `Project::touch()` - lives
  in the Rust crate. `why`: "no Rust in diff".
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
- **Gate: skip unless the diff touches `src-tauri/` or a file the app writes/reads.**
  Save pipelines, schema migrations and the atomic-rename contract are all Rust-side.
  `why`: "no persistence surface in diff". ⚠ If the change adds a NEW on-disk artifact
  anywhere (a log, a cache, a sibling file) this lens applies regardless of language - the
  gate is about persistence, not about Rust.
- Never persist transient in-memory values (freshly-minted UUIDs, `Config::default()`)
  before they're real - they orphan on next open. Restore should use the *current*
  project's config, not a hardcoded default.
- Test read-only / legacy / missing-table load paths and `INSERT OR REPLACE` collisions.
- Saves are atomic (temp `.stalx.tmp` → rename); flag direct overwrites.

**Subagent 5 - UI ↔ backend guard parity**
- **Gate: skip unless the diff touches `src/`.** Parity needs a deciding layer to compare
  against; with no frontend change there is no UI guard in the diff to pair with a backend
  one. `why`: "no UI surface in diff". (A Rust-only change that *removes* a backend guard
  is lens 9's territory - it traces consumers across the boundary.)
- A conditionally-disabled action needs a **backend guard** (read-only / DB-open /
  schema check that fails safe) - never rely on the UI disabled state alone.
- Disable destructive-action buttons until the impact preview resolves; the displayed
  impact must match the actions actually offered.
- A nullable-field UI guard must match the backend gate it implies (e.g. `databaseOpen`,
  not `file_path != null`).

**Subagent 6 - RETIRED as a subagent. Do not launch it.**
Its work is split between the **Pre-flight** section above (the deterministic gates, run
once in the main thread) and the landmine list in that same section (included in every
finder's brief, so whichever lens owns the touched area checks it). Nothing was dropped -
what changed is that a whole-tree command with one correct answer is no longer paid for by
three separate finders.
- **Keep logging it as lens 6 in `lenses_run` when the pre-flight ran**, so the log stays
  comparable with earlier records. Do not renumber lenses 7-10 to close the gap: the ids
  are the join key for every record already on disk.
- ⚠ Because it now runs on *every* review and passes on any branch worth opening a PR for,
  lens 6 accrues `ran` with zero findings and is never skipped - which is byte-identical to
  the **retire** signature the log exists to detect. `~/tools/review_log_summary.py` holds it
  in `MANDATORY_LENSES` so it is reported as a clean gate rather than a deletion candidate.
  If lens 6 ever stops being logged, or another gate joins the pre-flight, that set is the
  thing to update - otherwise the log will confidently recommend deleting its own gates.

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
unversioned here. And only the Claude path logs today, which understates the problem: the sibling definitions
(`.agents/skills/pre-pr/SKILL.md` for Codex `$pre-pr`, 97 lines; `.opencode/command/pre-pr.md`,
173 lines) contain **no `Pre-flight`, no path gating, and no log step** - zero hits for any of
those markers, against this file's ~370 lines. So `$pre-pr` and the OpenCode command now run a
structurally *different* review under the same nominal name, not merely an unlogged one: they
still fan out every lens, still pay for lens 6 as a subagent, and contribute nothing to the
log. **The log is therefore a 1-of-3 sample AND the three are not measuring the same thing**
(#358). A skipped lens is evidence of nothing, not evidence against the lens.

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

Self-test: `python3 scripts/review/test_log_run.py` (37 tests, stdlib only, no network).

It **is** a CI step: `Review-log writer` in the `check` job, beside `Release tooling`. Also in
the Pre-flight table above, so a `scripts/review/` diff gates on it during review too.

⚠ Worth knowing why, because this was deferred for one rebase: the objection was that no
workflow invoked `python3`, and `check` is picker-routed onto the self-hosted runner whose
image (`myoung34/github-runner:ubuntu-noble`) was not confirmed to ship it - so the step would
have made the merge gate depend on an unverified interpreter on a box only its owner can
change. **#352 settled that**: `check` now runs `./scripts/test-release.sh`, which needs
`python3` (`ci.yml` says so in its own comment), so the interpreter is already load-bearing for
the gate and this adds no new requirement. The general form is worth keeping: `scripts/` is not
in `ci.yml`'s `paths-ignore`, so such a diff already pays for a full `check` run - **the run
was always free; the dependency was the cost**, and it is now already paid.
