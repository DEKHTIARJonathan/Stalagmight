# E2E Smoke pare-down - handoff

**Goal:** get the `E2E Smoke` CI job under **7 minutes**.
**Status (2026-07-25):** research + instrumentation done and committed. No test
has been cut yet. The plan below is measured, not guessed.

**Branch:** `chore/smoke-timing-instrumentation` (off `099d86d1`), commits
`a60494ed`, `547688d8`. **Not pushed, no PR.** Repo rules require `/pre-pr`
before any PR, and do not self-merge.

---

## 1. Where the time actually goes

### CI (jobs API; runs 29202438220 / 29119661314 / 29204058662 / 29183195935)

| Component | Measured |
|---|---|
| Whole `smoke` job | 7:00 - 8:15 |
| Setup (checkout → pnpm install → Playwright cache/deps) | 0:35 - 0:44 (**~9%**) |
| `pnpm test:ui:smoke` step | **6:19 - 7:36 (~90%)** |

Setup is already at the floor (the browser cache is hitting; further caching is
worth ~10s). **Every saved minute must come out of test execution.** For a
sub-7:00 job the test step needs to reach ≈**5:00** for margin - a 25-35% cut.

### Local instrumented run (82 `@smoke` tests, 4 workers, retries off, M1)

| Metric | Run 1 (built-in json reporter) | Run 2 (hook-aware reporter) |
|---|---|---|
| Test-time total | 327.2s | 432.1s |
| Hook (setup) time | not measurable | **277.4s = 64%** |
| Wall clock | 89.1s | 115.1s |

⚠ **Run-to-run variance is ~30%, and local wall clock is ~4x faster than the
hosted runner.** The *ranking* and the *hook share* transfer; the seconds do not.
Collect 3-5 instrumented CI runs before finalizing any cut - one run sits inside
the noise band.

### The finding that drives the whole plan

**Setup (beforeEach) is 64% of smoke test time.** Per file it is starker:

| File | tests | % of test time | hook % | avg/test |
|---|---:|---:|---:|---:|
| gas-planning.spec.ts | 21 | **36%** | 75% | 7.4s |
| dive-plan.spec.ts | 7 | **12%** | 43% | 7.5s |
| import-placement-flow.spec.ts | 3 | 5% | 28% | 7.8s |
| display-toggles.spec.ts | 2 | 4% | 88% | 8.0s |
| map-tools.spec.ts | 3 | 4% | 20% | 5.1s |
| back-button-navigation.spec.ts | 2 | 3% | 89% | 7.1s |
| auto-save-status.spec.ts | 2 | 3% | 90% | 6.7s |
| section-shot-editing.spec.ts | 3 | 3% | **95%** | 4.5s |
| zoom-tool.spec.ts | 4 | 3% | 89% | 3.0s |
| undo-redo-dropdown.spec.ts | 4 | 3% | 84% | 3.0s |
| panel-reveal.spec.ts | 1 | 1% | **98%** | 6.4s |
| theme + syntactic-highlighting + walls-import + merge-projects + scroll-containment | 7 | **3.6% combined** | 83-93% | - |

**Cutting tests attacks the 36%. Fixing setup attacks the 64%. Fix first.**

Corollary: the small files are **not** worth cutting. The five listed on the last
row total 3.6% of test time - real coverage loss for almost no minutes. (An
earlier draft of this plan recommended cutting several of them; the measurement
corrected it.)

---

## 2. What is already committed on the branch

| File | What it is |
|---|---|
| `scripts/pw-timing-reporter.mjs` | Custom Playwright reporter. Uses `onStepEnd` to capture `category: 'hook'` durations, so per-test cost splits into hook vs body. Writes `PW_TIMING_OUTPUT` (default `playwright-report/timing.json`). Collapses retries into one row, charging all attempts. |
| `scripts/pw-timing-summary.mjs` | Renders that into a ranked markdown table (by file and by test). Accepts either the reporter's output (has hooks) or a built-in json report (reports hooks as `n/a`). Appends to `$GITHUB_STEP_SUMMARY` when set. |
| `.github/workflows/e2e-smoke.yml` | Runs `--reporter=github,./scripts/pw-timing-reporter.mjs`, prints the ranked table on the run summary page, uploads `timing.json` as the `smoke-timing` artifact (7-day retention). Marked **TEMPORARY**; remove when the pare-down lands. |

### Why a custom reporter (do not undo this)

**Playwright's built-in `json` reporter does not emit `steps` at all.** The first
attempt used it and silently printed `hook: 0ms / 0%` - which reads as "setup is
free," the exact opposite of the truth, and would have pushed the work straight
into deleting tests. The summary script now reports `n/a` rather than `0%` when
the source cannot supply hook data. Verified by inspecting result keys:
`['workerIndex','parallelIndex','status','duration','errors','stdout','stderr','retry','startTime','annotations','attachments']` - no `steps`.

### Reproduce the measurement

```
PW_RETRIES=0 PW_WORKERS=4 \
PW_TIMING_OUTPUT=<abs-path>/timing.json \
pnpm --dir <repo> exec playwright test --grep @smoke \
  --reporter=./scripts/pw-timing-reporter.mjs

node scripts/pw-timing-summary.mjs <abs-path>/timing.json --top 25
```

---

## 3. Constraint: #300 and #297 are landing

- **#300** (`fix/294-sweep-networkidle`, open) - closes #294. Removes 56
  `waitForLoadState('networkidle')` calls across 23 specs (11 insertions / 56
  deletions). No files added/deleted/renamed, no `@smoke` tag changes, no mock or
  `playwright.config.ts` change. **It already does part of Phase A3 - do not
  duplicate that work.**
- **#297** (`feat/custom-renderer`, open) - the real event. Replaces the stock
  MapLibre survey renderer with a custom WebGL renderer: ~28.7k added / 5.8k
  deleted across 100 files, **no fallback**. #300 is its prerequisite because the
  new renderer's worker keeps the network permanently active, so `networkidle`
  never fires (#297's branch measured 615 pass / 301 fail before the sweep).
  - Rewrites: `hitbox-detection` (+588/-653), `move-drag-zoom-tracking`,
    `non-interactive-tools`, `issue-severity`, `measure-tool`, the gradient specs.
  - Touches: `display-toggles`, `toolbar-tool-groups`, `zoom-tool`,
    `section-highlighting`.
  - Only trivially touches `gas-planning` (+10/-3) and `dive-plan` (1 line).
- **#297 ships no new automated smoke coverage** for the new renderer; its
  checklist defers to a manual WebKit visual pass. Worth raising with the author:
  a wholesale renderer swap is the largest regression risk in the repo's recent
  history, and map/canvas is already the highest-churn frontend surface (40 fix
  commits in 4 months).
- **PR #291 / `goblinland`** is **unrelated** - touches zero `e2e-playwright`
  files. (There is a worktree for it at `.claude/worktrees/goblinland-291`; leave
  it alone, another agent owns it.)

**Consequence: do not trim map/canvas smoke coverage now.** Cutting map tests in
the same window the renderer is replaced is backwards, and today's line numbers
in the rewritten specs will be stale regardless.

⚠ Unknown: which specific `test()` blocks keep their `@smoke` tag inside the
rewritten specs. That was assessed from file-level diffstats, not per-line
patches. Read the actual patches when #297 nears merge.

---

## 4. Reliability (60 days, 62 smoke runs)

- **61 green, 1 red.** The suite is not flaky in aggregate.
- Only recurring flake: `dive-plan.spec.ts:220` - 3 flaked-then-passed, 1 hard
  fail. Ticketed **#292**; a fix is already committed on
  `fix/292-dive-plan-mode-switch-flake` (local, ~40 behind master, needs rebase).
- **The single red run was `dive-plan` catching a real regression** - 6 tests
  failing together, the #277 "new gate reads state the mock never sets" class.
  So dive-plan is simultaneously the flakiest file and the best-evidenced catch
  in the suite. **De-flake it; do not delete it.**
- Tool for this: `python3 ~/tools/ci_flake_report.py --repo Stalagmight/Stalagmight
  --days 30 --workflows "E2E Smoke"`. (`~/tools/gh_actions_report.py` currently
  errors with `IncompleteRead` on this repo's run history.)

---

## 5. The plan

### Phase A - setup cost (attacks the 64%, zero coverage loss, renderer-independent)

Safe to do before #297 lands: it does not touch `e2e-playwright/mocks/tauri-ipc.ts`,
the fixtures, or `playwright.config.ts`, so this will not need rework.

- **A1. Done** - instrumentation (this branch). Keep it running in CI until the
  pare-down lands, so we measure on the real runner and not just an M1.
- **A2. Cut the per-test re-seed. This is the single biggest lever.** Every smoke
  file re-seeds a full mocked project in `beforeEach` per test; several pay it
  across many nested describes to run 2-4 smoke tests (`settings-dialog` has 8
  `beforeEach`, `display-toggles` 9, `undo-redo-dropdown` 6). Ties to already-filed
  **#295**. Worst ratios first: `panel-reveal` (98%), `section-shot-editing` (95%),
  `corruption-recovery` (94%), `auto-save-status` (90%), `zoom-tool` /
  `back-button-navigation` / `display-toggles` (~89%), `gas-planning` (75%, and by
  far the largest absolute block at 116s).
  A 50% cut in hook time ≈ **32% of test time** - on its own close to the target.
- **A3. Remove the remaining `waitForTimeout` sleeps:** `undo-redo-dropdown:706,827`
  (400ms), `map-tools:449` (400ms), `back-button-navigation:227` (500ms),
  `import-placement-flow:156,288` (300ms x2), `settings-dialog:68,121,801`,
  `zoom-tool:62` (shared helper). Re-scope around #300, which handles the
  `networkidle` half. Related follow-up: **#294**.
- **A4. Land #292** (rebase the existing branch onto master, `/pre-pr`, PR).
  Removes retry cost - a retried test costs 2-3x under `retries: 2`.

**Re-measure after Phase A before cutting anything.**

### Phase B - test count, only as deep as the shortfall requires

- **`gas-planning.spec.ts` 21 → ~6** is the one large cut that is safe now: 36% of
  test time for a single feature, and #297 barely touches it. Keep: overlay
  renders, preset apply, cylinder edit, route pick, read-only guard, one readout.
  ⚠ 75% of its cost is hook, so **A2 shrinks this prize** - sequence A2 first and
  re-derive rather than assuming ~110s.
- **Defer all map/canvas trims until post-#297**, then re-derive `@smoke` counts
  from the merged tree.
- **Keep regardless:** `dive-plan` (proven catch), `project-crud` (critical path),
  and the data-safety cluster `error-handling` / `auto-save-status` /
  `window-close-protection` (guards the #92/#53 data-loss class).
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

## 6. Open decisions for the user

1. Push `chore/smoke-timing-instrumentation` and open a PR (needs `/pre-pr` first),
   or keep the instrumentation local and run it by hand?
2. Start A2 now (where the 64% is), or wait for #300/#297 to land first?
3. Raise the "#297 has no automated renderer smoke coverage" gap with its author?

---

## 7. Gotchas for whoever picks this up

- **Run Playwright with the Bash sandbox DISABLED** - the dev server cannot bind
  :1420 otherwise (EPERM). Check ports are free first; a second clone's dev server
  on :1420 would silently serve the wrong code to the tests.
- **`pnpm <script> -- <flags>` forwards `--` literally**, and Playwright reads it
  as a positional test filter ("No tests found"). Use
  `pnpm exec playwright test <flags>`. Keep the workflow's `--grep @smoke` in sync
  with the `test:ui:smoke` script.
- **`@smoke` is a plain `--grep` on test titles**, not a describe-level tag. But
  Playwright still runs a whole file's fixtures if it has ≥1 matching test.
- Baseline count: **82 `@smoke` tests across 26 files** (an earlier hand count said
  80/25 - trust the reporter).
- `pnpm lint:e2e-parallel` gates `fullyParallel` safety and runs in this job - a
  shared-fixture refactor must keep it green.
- Docs changes do **not** trigger smoke/check (`docs/**` is in `paths-ignore`), but
  `.github/**` deliberately does - so a workflow edit gets a CI run for free.
- Repo rules: `/pre-pr` before any PR; do not self-merge; no em-dashes in new prose.

## 8. Related issues

#23 (smoke/nightly split) · #292 (dive-plan flake) · #294 (networkidle sweep) ·
#295 (app-boot beforeEach cost) · #297 (custom renderer) · #300 (sweep PR) ·
#287 (zoom-tool ctrl-drag drift, suspected real bug)
