# E2E Smoke pare-down - handoff

**Goal:** get the `E2E Smoke` CI job reliably under **7 minutes**.
**Status (2026-07-26):** rebased onto ToT `64986044`, all measurements re-derived
on the post-#297 tree. No test has been cut yet.

**Branch:** `chore/smoke-timing-instrumentation`, commits `a60494ed`, `547688d8`,
`5609f5ee` (rebased, clean, no conflicts). **Not pushed, no PR.** Repo rules
require the pre-PR review before any PR, and do not self-merge.

---

## 0. What the 2026-07-26 rebase changed

180 commits landed between the branch point (`099d86d1`) and ToT. Four of them
move this plan:

| Landed | Effect on this plan |
|---|---|
| **#300** (networkidle sweep) MERGED | `grep -c networkidle e2e-playwright/` is now **0**. Phase A3's networkidle half is **done**. It also cut the CI test step by ~60-90s on its own - see the new baseline below. |
| **#297** (custom WebGL renderer) MERGED | The "defer map trims until post-#297" hold is **lifted**. |
| **#292** (dive-plan flake) CLOSED `NOT_PLANNED` | Subsumed by #300 - the flake mechanism was the `networkidle` wait, now gone. **Phase A4 is a no-op**; the local fix branch was deleted unpushed. |
| **#293** em-dash sweep | New CI gate `pnpm lint:no-em-dash` on the leak-scan job. This branch passes it. |

Two handoff assumptions were **wrong** and are corrected here:

- "#297 only trivially touches `gas-planning` (+10/-3)." It was **+189/-73** -
  a substantial rewrite. The file still has **21** `@smoke` tests, so the Phase B
  target is unchanged, but every line number in the old plan is stale.
- "Unknown: which `test()` blocks keep their `@smoke` tag in the rewritten specs."
  Resolved: **none changed.** The count is still exactly **82 `@smoke` across 26
  files**, identical to the pre-#297 tree. #297's spec rewrites preserved tags.

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

### Local instrumented run (ToT, 82 `@smoke`, 4 workers, retries off, M1)

| Metric | Pre-rebase | **ToT (2026-07-26)** |
|---|---|---|
| Tests | 82 passed | **82 passed** |
| Test-time total | 432.1s | **351.4s** |
| Hook (setup) time | 277.4s = **64%** | **234.5s = 67%** |
| Wall clock | 115.1s | **93.2s** |

⚠ Run-to-run variance is ~30% and local wall clock is ~4x faster than the hosted
runner. The *ranking* and the *hook share* transfer; the seconds do not.

### The finding that drives the plan SURVIVED the renderer swap

**Setup (beforeEach) is 67% of smoke test time** (was 64%). Per file:

| File | tests | % of test time | hook % | avg/test |
|---|---:|---:|---:|---:|
| gas-planning.spec.ts | 21 | **31%** | 70% | 5.2s |
| dive-plan.spec.ts | 7 | **10%** | 62% | 4.8s |
| import-placement-flow.spec.ts | 3 | 6% | 47% | 6.6s |
| back-button-navigation.spec.ts | 2 | 5% | **90%** | 9.4s |
| auto-save-status.spec.ts | 2 | 5% | **90%** | 9.2s |
| map-tools.spec.ts | 3 | 4% | 25% | 5.1s |
| section-shot-editing.spec.ts | 3 | 3% | **94%** | 4.0s |
| window-close-protection.spec.ts | 2 | 3% | 27% | 5.6s |
| undo-redo-dropdown.spec.ts | 4 | 3% | 83% | 2.7s |
| dmp-import / zoom-tool / toolbar-tool-groups / display-toggles | 12 | 12% | 33-89% | - |
| the remaining 12 files | 21 | 15% | 10-100% | - |

Movement vs the pre-rebase table: `back-button-navigation` and `auto-save-status`
climbed into the top five (both ~90% hook, ~9s/test - the worst
setup-to-value ratio in the suite). `gas-planning` fell 36% -> 31% but is still
by far the largest single block.

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

Gates re-run on the rebased branch: `lint:e2e-parallel` clean (103 files),
`lint:ts-file-size` clean (354 files), `lint:private-leaks` clean,
`lint:no-em-dash` clean (1094 files).

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
`pnpm install` after the 180-commit rebase left `@mapbox/tiny-sdf` unresolved,
every test timed out in `beforeEach`, and the table read "hook = 98% of test
time" - garbage that superficially confirmed the thesis. **Check the pass count
before trusting a timing table.** (Also: `pnpm install` run under the Bash
sandbox silently no-ops here; run it with the sandbox disabled.)

---

## 3. Inbound work

- **PR #305** (`test/custom-renderer-health-smoke`, open, smoke+leak-scan green,
  held for Daniel) adds **one** `@smoke` spec,
  `e2e-playwright/custom-renderer-health.spec.ts`, the WebGL-health canary for
  the now-unfallback-able custom renderer. **Assume it lands: budget for 83
  `@smoke` tests across 27 files.** It closes the automated-coverage gap this
  plan flagged against #297, so it is a *keeper* - it must not be a pare-down
  target, and any shared-fixture refactor has to accommodate it.
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
  across many nested describes to run 2-4 smoke tests (`settings-dialog` has 8
  `beforeEach`, `display-toggles` 9, `undo-redo-dropdown` 6). Ties to already-filed
  **#295**. Worst ratios first on ToT: `panel-reveal` (100%),
  `corruption-recovery` / `merge-closure-dialogs` / `section-shot-editing`
  (94-95%), `back-button-navigation` and `auto-save-status` (90% **and** ~9s/test
  - the best absolute prize per test), `zoom-tool` (89%), `gas-planning` (70%,
  and still the largest absolute block at 76s of hook).
  A 50% cut in hook time is ~33% of test time - on its own past the target.
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

- **`gas-planning.spec.ts` 21 -> ~6** remains the one large cut: 31% of test time
  for a single feature. Keep: overlay renders, preset apply, cylinder edit, route
  pick, read-only guard, one readout. ⚠ 70% of its cost is hook, so **A2 shrinks
  this prize** - sequence A2 first and re-derive rather than assuming ~75s.
- **Map/canvas trims are now unblocked** (#297 merged). But re-derive from the
  merged tree: the rewritten specs' `@smoke` sets are unchanged in count, and
  `map-tools` (25% hook) / `toolbar-tool-groups` (33% hook) are body-dominated,
  so A2 will not shrink them - they are genuine Phase B candidates.
- **Keep regardless:** `dive-plan` (proven catch), `project-crud` (critical path),
  `custom-renderer-health` once #305 lands (sole renderer canary), and the
  data-safety cluster `error-handling` / `auto-save-status` /
  `window-close-protection` (guards the #92/#53 data-loss class). Note
  `auto-save-status` is 90% hook - **fix its setup, do not cut it.**
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

## 6. Open decisions

1. **Is the goal still worth it?** ToT master runs are 5:59-7:07 - the job now
   straddles the 7:00 line rather than sitting above it. Phase A alone (zero
   coverage loss) plausibly closes the gap. Confirm whether Phase B should run at
   all, or only if A under-delivers.
2. Push `chore/smoke-timing-instrumentation` and open a PR (needs the pre-PR
   review first), or keep the instrumentation local and run it by hand? Landing
   it is what gets real-runner data across several runs instead of M1 estimates.
3. Start A2 now, or wait for #305 / #307 to land first? #305 adds a spec that a
   fixture refactor would have to accommodate; #307 touches the e2e mock.

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
- Baseline count: **82 `@smoke` tests across 26 files** on ToT (83/27 once #305
  lands).
- `pnpm lint:e2e-parallel` gates `fullyParallel` safety and runs in this job - a
  shared-fixture refactor must keep it green.
- `pnpm lint:no-em-dash` is a leak-scan gate since #293 - ASCII hyphens only in
  new prose.
- Docs changes do **not** trigger smoke/check (`docs/**` is in `paths-ignore`), but
  `.github/**` deliberately does - so a workflow edit gets a CI run for free.
- Repo rules: the pre-PR review before any PR; do not self-merge.

## 8. Related issues

#23 (smoke/nightly split) · #294 (networkidle sweep, closed by #300) ·
#295 (app-boot beforeEach cost - the Phase A2 ticket) · #305 (renderer health
canary, open) · #307 (mock fidelity, open) · #287 (zoom-tool ctrl-drag drift,
suspected real bug)
