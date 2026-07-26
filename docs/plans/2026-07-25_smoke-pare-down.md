# E2E Smoke pare-down - handoff

**Goal:** get the `E2E Smoke` CI job reliably under **7 minutes**.
**Status (2026-07-26):** rebased onto ToT `2ab85459`, all measurements re-derived
on the post-#297 tree. No test has been cut yet. **Phase B is parked** until
Phase A is done and re-measured.

**Branch:** `chore/smoke-timing-instrumentation` (rebased onto `2ab85459`, clean,
no conflicts). Commit hashes are deliberately not listed here - a rebase rewrites
them, and a stale list sends the next reader to dangling objects. Use
`git log master..HEAD`. Repo rules require the pre-PR review before any PR, and
do not self-merge.

---

## 0. What the 2026-07-26 rebase changed

182 commits landed between the branch point (`099d86d1`) and ToT. Five of them
move this plan:

| Landed | Effect on this plan |
|---|---|
| **#300** (networkidle sweep) MERGED | `grep -c networkidle e2e-playwright/` is now **0**. Phase A3's networkidle half is **done**. It also cut the CI test step by ~60-90s on its own - see the new baseline below. |
| **#297** (custom WebGL renderer) MERGED | The "defer map trims until post-#297" hold is **lifted**. |
| **#292** (dive-plan flake) CLOSED `NOT_PLANNED` | Subsumed by #300 - the flake mechanism was the `networkidle` wait, now gone. **Phase A4 is a no-op**; the local fix branch was deleted unpushed. |
| **#293** em-dash sweep | New CI gate `pnpm lint:no-em-dash` on the leak-scan job. This branch passes it. |
| **#305** (renderer health canary) MERGED | Adds one `@smoke` test. Baseline is now **83 across 27 files**. It is a **keeper** - see section 3. |

Two handoff assumptions were **wrong** and are corrected here:

- "#297 only trivially touches `gas-planning` (+10/-3)." It was **+189/-73** -
  a substantial rewrite. The file still has **21** `@smoke` tests, so the Phase B
  target is unchanged, but every line number in the old plan is stale.
- "Unknown: which `test()` blocks keep their `@smoke` tag in the rewritten specs."
  Resolved: **none changed.** #297's spec rewrites preserved every tag - the count
  held at exactly 82 across 26 files, identical to the pre-#297 tree, and only
  #305 moved it (to 83/27).

---

## 1. Where the time actually goes (re-derived on ToT)

### CI baseline has MOVED - the gap is much smaller than the old plan assumed

Master runs since #297/#300 (jobs API, runs 30185182612 / 30149840595 /
30145913400 / 30139667882):

| Component | Old (pre-#300) | **ToT** |
|---|---|---|
| Whole `smoke` job | 7:00 - 8:15 | **5:59 - 7:07** |
| Setup (checkout -> pnpm install -> PW cache/deps) | 0:35 - 0:44 | 0:35 - 0:45 (unchanged) |
| `pnpm test:ui:smoke` step | 6:19 - 7:36 | **5:01 - 6:24 (301-384s)** |

**The job already hits the target on a good run and misses it on a bad one.** The
remaining ask is roughly a **20-25% cut off the test step** (to ~280s for margin),
not the 25-35% the original plan scoped. Reducing *variance* now matters as much
as reducing the mean.

Setup remains at the floor; every saved minute still has to come out of test
execution.

### Local instrumented runs (4 workers, retries off, M1)

| Metric | Pre-rebase | ToT run 1 | ToT run 2 (post-#305) | **run 3 (fixed reporter)** |
|---|---|---|---|---|
| Tests | 82 passed | 82 passed | 83 passed | **83 passed** |
| Test-time total | 432.1s | 351.4s | 339.8s | **590.5s** |
| Hook (setup) time | 277.4s = **64%** | 234.5s = **67%** | 223.2s = **66%** | **377.0s = 64%** |
| Wall clock | 115.1s | 93.2s | 90.1s | **154.6s** |

Run 3 is the authoritative one: it is the only sample taken with the corrected
hook attribution (see section 2). Its absolute seconds are inflated because the
machine was running other work concurrently - which is exactly why the *ratio*
is the number to carry, not the seconds.

The hook share is stable at **64-67% across four samples**, two very different
trees, and both the buggy and fixed reporters. That is the one number this plan
rests on, and it is not noise.

⚠ Run-to-run variance is ~30% and local wall clock is ~4x faster than the hosted
runner. The *ranking* and the *hook share* transfer; the seconds do not.

### The finding that drives the plan SURVIVED the renderer swap

**Setup (beforeEach) is 66% of smoke test time.** Per file (ToT run 2):

| File | tests | % of test time | hook % | avg/test |
|---|---:|---:|---:|---:|
| gas-planning.spec.ts | 21 | **28%** | 71% | 4.5s |
| dive-plan.spec.ts | 7 | **10%** | 64% | 4.9s |
| import-placement-flow.spec.ts | 3 | 5% | 53% | 5.8s |
| back-button-navigation.spec.ts | 2 | 4% | **85%** | 6.8s |
| undo-redo-dropdown.spec.ts | 4 | 4% | **86%** | 3.4s |
| auto-save-status.spec.ts | 2 | 4% | **84%** | 6.6s |
| zoom-tool.spec.ts | 4 | 4% | **87%** | 3.3s |
| window-close-protection.spec.ts | 2 | 4% | 32% | 6.6s |
| toolbar-tool-groups.spec.ts | 3 | 4% | 38% | 4.2s |
| dmp-import.spec.ts | 3 | 4% | 39% | 4.0s |
| map-tools.spec.ts | 3 | 4% | 24% | 4.0s |
| section-shot-editing.spec.ts | 3 | 3% | **94%** | 4.0s |
| the remaining 15 files | 26 | 22% | 4-99% | - |

Movement vs the pre-rebase table: `back-button-navigation` and `auto-save-status`
climbed into the top group (both ~85% hook - the worst setup-to-value ratio in
the suite alongside `section-shot-editing` at 94%). `gas-planning` fell 36% ->
28% but is still by far the largest single block, at more than twice the next
file.

**#305's canary is cheap and well-built:** 4.3s, only 4% hook (it drives the app
directly rather than through the shared per-test seed). It is the model for what
Phase A should make the rest of the suite look like.

**Cutting tests attacks the 31%. Fixing setup attacks the 67%. Fix first.**

The small files remain not worth cutting: the bottom 12 files carry 21 tests for
15% of test time, and several are the data-safety guards.

---

## 2. What is committed on the branch

| File | What it is |
|---|---|
| `scripts/pw-timing-reporter.mjs` | Custom Playwright reporter. Uses `onStepEnd` to capture `category: 'hook'` durations, so per-test cost splits into hook vs body. Writes `PW_TIMING_OUTPUT` (default `playwright-report/timing.json`). Collapses retries into one row, charging all attempts. |
| `scripts/pw-timing-summary.mjs` | Renders that into a ranked markdown table (by file and by test). Accepts either the reporter's output (has hooks) or a built-in json report (reports hooks as `n/a`). Appends to `$GITHUB_STEP_SUMMARY` when set. |
| `.github/workflows/e2e-smoke.yml` | Runs `--reporter=github,./scripts/pw-timing-reporter.mjs`, prints the ranked table on the run summary page, uploads `timing.json` as the `smoke-timing` artifact (7-day retention). Marked **TEMPORARY**; remove when the pare-down lands. |

| `scripts/pw-timing-reporter.test.mjs`, `scripts/pw-timing-summary.test.mjs` | Fixture tests for the two above, in the repo's pure-Node `lint:*:test` style. Wired as `pnpm lint:pw-timing:test` and run in the smoke job before the browser install. Each pins a bug that produced a confident WRONG number rather than an error - see below. |

Gates re-run on the rebased branch: `lint:e2e-parallel` clean (104 files),
`lint:ts-file-size` clean (354 files), `lint:private-leaks` clean (1094 files),
`lint:no-em-dash` clean (1095 files), `lint:pw-timing:test` 26 passed.

### Two attribution bugs the pre-PR review caught (both now fixed + pinned)

Both produced a confident, plausible number rather than an error, which is the
dangerous failure mode for a tool whose output decides what gets deleted:

1. **`Worker Cleanup` was counted as setup time.** Playwright emits it as a
   *sibling* of `Before Hooks`/`After Hooks` and charges it to whichever test ran
   last on that worker; `testInfo.duration` excludes it. Counting it as `before`
   inflated the last test of every worker and every test adjacent to a failure -
   exactly the population a cost investigation looks at - and could push a row's
   hook share above 100%. **This explains the `hook % = 101-105%` seen in the
   broken run below.** Now tracked in its own `worker` field and excluded from
   hook totals.
2. **Test status never reached the output.** A timed-out test bills the full
   30s timeout, so it sorted to the top of the ranking looking like an expensive
   but legitimate test. The summary now flags any non-green run and marks each
   non-passing row.

Neither bug affects the headline finding: the 64-67% hook share was measured on
green runs, where `Worker Cleanup` is a small tail. But re-measure with the fixed
reporter before acting on any per-file number.

### Why a custom reporter (do not undo this)

**Playwright's built-in `json` reporter does not emit `steps` at all.** The first
attempt used it and silently printed `hook: 0ms / 0%` - which reads as "setup is
free," the exact opposite of the truth, and would have pushed the work straight
into deleting tests. The summary script now reports `n/a` rather than `0%` when
the source cannot supply hook data.

### Reproduce the measurement

```
PW_RETRIES=0 PW_WORKERS=4 \
PW_TIMING_OUTPUT=<abs-path>/timing.json \
pnpm --dir <repo> exec playwright test --grep @smoke \
  --reporter=line,./scripts/pw-timing-reporter.mjs

node scripts/pw-timing-summary.mjs <abs-path>/timing.json --top 25
```

⚠ Always pass a **second, human-readable reporter** (`line`). With only the
timing reporter there is no pass/fail output, and a fully-red run looks like a
valid measurement. That happened on the first ToT attempt: a missed
`pnpm install` after the 182-commit rebase left `@mapbox/tiny-sdf` unresolved,
every test timed out in `beforeEach`, and the table read "hook = 98% of test
time" - garbage that superficially confirmed the thesis. The summary now flags a
non-green run explicitly, but **check the pass count anyway.** (Also: `pnpm
install` run under the Bash sandbox silently no-ops here; run it with the sandbox
disabled.)

---

## 3. Inbound work

- **#305 MERGED** (`2ab85459`) - `e2e-playwright/custom-renderer-health.spec.ts`,
  the WebGL-health canary for the now-unfallback-able custom renderer. It closes
  the automated-coverage gap this plan flagged against #297, so it is a
  **keeper**: it must not be a pare-down target, and any shared-fixture refactor
  in Phase A has to accommodate it.
  ⚠ It is the first spec whose *prose* contains the string `@smoke` (line 44, a
  comment). A bare `grep -c @smoke` now overcounts by one - count `test(` lines,
  or trust the reporter.
- **PR #307** (`fix/301-review-fallout`, open) - core/mock fidelity fixes. Touches
  the e2e mock; re-check `tauri-ipc.ts` assumptions after it lands.
- **PR #291 / `goblinland`** is unrelated (zero `e2e-playwright` files). There is
  a worktree at `.claude/worktrees/goblinland-291`; leave it alone.

---

## 4. Reliability

- Over the 60-day window: **61 green, 1 red** in 62 smoke runs. Not flaky in
  aggregate. All 25 runs in the last 48h are green or cancelled-by-supersede.
- The one recurring flake, `dive-plan.spec.ts:220`, is **resolved by #300**
  (#292 closed as subsumed). Its `enterPlan` helper still carries a
  sub-default 3000ms `dive-plan-bar` visibility timeout
  (`dive-plan.spec.ts:60`) - harmless now that the 30s `networkidle` stall is
  gone, but it is the first thing to widen if that line flakes again.
- **The single red run was `dive-plan` catching a real regression** - 6 tests
  failing together, the #277 "new gate reads state the mock never sets" class.
  dive-plan is the best-evidenced catch in the suite. **De-flake it; do not
  delete it.**
- Tool: `python3 ~/tools/ci_flake_report.py --repo Stalagmight/Stalagmight
  --days 30 --workflows "E2E Smoke"`. (`~/tools/gh_actions_report.py` errors with
  `IncompleteRead` on this repo's run history.)

---

## 5. The plan

### Phase A - setup cost (attacks the 67%, zero coverage loss)

- **A1. Done** - instrumentation (this branch). Keep it running in CI until the
  pare-down lands, so we measure on the real runner and not just an M1.
- **A2. Cut the per-test re-seed. This is the single biggest lever.** Every smoke
  file re-seeds a full mocked project in `beforeEach` per test; several pay it
  across many nested describes to run 2-4 smoke tests (`settings-dialog` and
  `display-toggles` have 9 `beforeEach` each, `undo-redo-dropdown` 7). Ties to already-filed
  **#295**. Worst ratios first on ToT: `panel-reveal` (99%),
  `scroll-containment` / `corruption-recovery` / `merge-closure-dialogs` /
  `section-shot-editing` (94-97%), `walls-import-dialog` (93%), `zoom-tool` (87%),
  `undo-redo-dropdown` (86%), `back-button-navigation` and `auto-save-status`
  (84-85% **and** ~6.7s/test - the best absolute prize per test), `gas-planning`
  (71%, and still the largest absolute block at 67s of hook).
  A 50% cut in hook time is ~33% of test time - on its own past the target.
  `custom-renderer-health.spec.ts` (4% hook) is the shape to aim for.
- **A3. Remove the remaining `waitForTimeout` sleeps in smoke files.** The
  networkidle half is done (#300). What is left, re-derived on ToT:
  `undo-redo-dropdown:705,825` (400ms x2), `map-tools:449` (400ms),
  `back-button-navigation:227` (500ms), `import-placement-flow:156,288` (300ms x2),
  `settings-dialog:67,120,794`, `zoom-tool:62` (shared helper),
  `toolbar-tool-groups:51` (25ms), plus `helpers/app.ts:316` (100ms, in the
  shared `placeAllSections` poll loop - hit by every import-flow test).
  Follow-up issue: **#294**.
- **A4. Dropped** - #292 is closed as subsumed by #300. No work.

**Re-measure after Phase A before cutting anything.**

### Phase B - test count, only as deep as the shortfall requires

- **`gas-planning.spec.ts` 21 -> ~6** remains the one large cut: 28% of test time
  for a single feature. Keep: overlay renders, preset apply, cylinder edit, route
  pick, read-only guard, one readout. ⚠ 71% of its cost is hook, so **A2 shrinks
  this prize** - sequence A2 first and re-derive rather than assuming ~65s.
- **Map/canvas trims are now unblocked** (#297 merged). But re-derive from the
  merged tree: the rewritten specs' `@smoke` sets are unchanged in count, and
  `map-tools` (24% hook) / `window-close-protection` (32%) /
  `toolbar-tool-groups` (38%) / `dmp-import` (39%) are body-dominated, so A2 will
  not shrink them - they are the genuine Phase B candidates.
- **Keep regardless:** `dive-plan` (proven catch), `project-crud` (critical path),
  `custom-renderer-health` (sole renderer canary, and already cheap), and the
  data-safety cluster `error-handling` / `auto-save-status` /
  `window-close-protection` (guards the #92/#53 data-loss class). Note
  `auto-save-status` is 84% hook - **fix its setup, do not cut it.**
- **Do not bother cutting** the sub-1% files.
- Remove the **tag**, not the test - everything dropped from `@smoke` must still
  run in the nightly full suite.

### Rejected (with reasons, so they don't get re-proposed)

- **Sharding smoke across runners.** Halves wall-clock but **raises billed
  minutes** (duplicate ~40s setup + a second runner). Wrong lever when the cost
  being optimized is per-minute.
- **More Playwright browser caching.** Already cache-hit; worth ~10s.
- **Chasing the p90.** Wall-clock p90 is 23.8 min and max 115.7 min, but the
  timing API shows those same runs at 7.3-8.5 min of real execution - that tail is
  **runner queue time**, and no amount of test deletion touches it.

---

## 6. Decisions taken (2026-07-26)

1. **Land the instrumentation.** Local M1 estimates cannot resolve a 5:59-7:07
   variance band; only repeated real-runner samples can. "We can't change what we
   don't measure." -> this branch goes to PR.
2. **Do Phase A. Park Phase B.** The goal stands even though ToT already
   straddles 7:00, because suite time does not stay down on its own - it only
   ratchets up. Phase A is zero-coverage-loss, so it is worth doing regardless of
   the current gap. Revisit B only after A is done and re-measured.
3. **#305 has landed**, so a Phase A fixture refactor must accommodate the
   renderer canary from the start. #307 is still open and touches the e2e mock -
   re-check `tauri-ipc.ts` assumptions after it lands.

---

## 7. Gotchas for whoever picks this up

- **After any rebase, `pnpm install` before measuring** - and check the pass count
  on the run. See the section-2 warning: a stale `node_modules` produces a
  plausible-looking, entirely wrong timing table.
- **Run Playwright with the Bash sandbox DISABLED** - the dev server cannot bind
  :1420 otherwise (EPERM). Check the port is free first; a second clone's dev
  server on :1420 would silently serve the wrong code to the tests.
- **`git checkout` / `reset` touching `.claude/**` fails under the sandbox**
  ("Operation not permitted") and can leave the worktree half-updated with the
  ref behind. Re-run the git command with the sandbox disabled.
- **`pnpm <script> -- <flags>` forwards `--` literally**, and Playwright reads it
  as a positional test filter ("No tests found"). Use
  `pnpm exec playwright test <flags>`. Keep the workflow's `--grep @smoke` in sync
  with the `test:ui:smoke` script.
- **`@smoke` is a plain `--grep` on test titles**, not a describe-level tag. But
  Playwright still runs a whole file's fixtures if it has >=1 matching test.
- Baseline count: **83 `@smoke` tests across 27 files** on ToT. Count `test(`
  lines, not raw `@smoke` matches - `custom-renderer-health.spec.ts` mentions the
  tag in a comment too.
- `pnpm lint:e2e-parallel` gates `fullyParallel` safety and runs in this job - a
  shared-fixture refactor must keep it green.
- `pnpm lint:no-em-dash` is a leak-scan gate since #293 - ASCII hyphens only in
  new prose.
- Docs changes do **not** trigger smoke/check (`docs/**` is in `paths-ignore`), but
  `.github/**` deliberately does - so a workflow edit gets a CI run for free.
- Repo rules: the pre-PR review before any PR; do not self-merge.

## 8. Related issues

#23 (smoke/nightly split) · #294 (networkidle sweep, closed by #300) ·
#295 (app-boot beforeEach cost - **the Phase A2 ticket**) · #305 (renderer health
canary, merged) · #307 (mock fidelity, open) · #287 (zoom-tool ctrl-drag drift,
suspected real bug)
