# UAT framework: journey tier, replay corpus, and verdict ledger (#466)

Status: DESIGN - no implementation yet. Open questions at the bottom need maintainer
answers before Phase 3.

## Why

Ship-blocking bugs in this app are overwhelmingly found by driving the REAL
application, and almost never by the automated suites. A retrospective over the
tracker puts it at roughly 12 ship-blockers (range 8-18, medium confidence) found by
real-app driving, split about evenly between hand-driven sessions and LLM-harness
drives, against approximately zero ship-blockers from the automated tiers (which
catch regressions of already-covered behavior, and flakes).

Representative, by channel:

- Hand-driven: #17 (live-demo data corruption), #350 (rc1 invalidly-signed DMG),
  #53 (silent auto-save failure), #391/#409 (field-report journey findings that
  killed an import flow and an interaction model), #410/#429 (Windows sweep: four
  majors in one session).
- Harness-driven: the #411 TML arc (#426, #427, #437, #441, #446, #449 - including
  export-discards-entire-survey data loss and a serde-omitted-field wire-shape crash
  the mocked Playwright tier STRUCTURALLY cannot see, because the mock speaks the
  TypeScript type, not the wire shape), and the #413 undo/redo fuzzer (18 bugs, 4
  silent corruption; two oracles were each the sole detector of a finding).

Channel profile: humans find category/UX errors (interaction models, unfindable
flows, artifact signing); the harness finds correctness errors at volume; platform
sweeps are pure manual yield (no Windows CI exists).

Yet none of this is load-bearing today:

- `e2e/agent/scenarios-smoke.ts` is the only repeatable real-app suite and it gates
  only `fatal` findings - no behavioral assertions (`scenarios-smoke.ts:48-51`).
- `e2e/agent/replays/` is empty; the replay/repro-report generators are built and
  unused as a corpus.
- Harness/session results land in gitignored `.agent-artifacts/` and evaporate.
- The 7 legacy WDIO specs flagged as the only real disk-I/O / round-trip /
  cross-session coverage run in no workflow, including `release.yml`.
- `docs/TESTING.md:36-39` says outright: neither real-app tier runs in an automated
  gate; do not rely on either.

## Build vs adopt

Evaluated and rejected for now:

- **@wdio/tauri-service** (embedded WebDriver provider, native macOS support,
  `browser.tauri.execute()`): would replace only the bespoke session layer, which
  already works. Worth one time-boxed spike (<= 1 day) later; adopt only if it drops
  code without changing the scenario-facing interface. Journeys must not depend on
  the answer.
- **AI-vision frameworks** (Midscene.js, Magnitude): browser-first; bridging to the
  Tauri webview means a third driver stack for a two-person team. The exploratory
  LLM channel already exists via the MCP harness + app-tester playbook - what it
  lacks is durability, not vision.
- **Classic BDD** (Cucumber/Robot): hand-mapped Gherkin is heavy for two people.

Decision: extend the in-house scenario framework (`e2e/agent/scenarios/framework.ts`)
into a journey tier. The session layer, command mutex, waiters, store/IPC
primitives, replay helpers, and oracle sweeps are already the hard 80%.

## Architecture

```
e2e/agent/
  journeys/
    framework.ts        # JourneyContext = ScenarioContext + expect/checkpoint API
    index.ts            # registry, mirroring scenarios/index.ts
    importTml.ts, saveReopen.ts, exportRoundTrip.ts, undoIdentity.ts, ...
  journeys-run.ts       # runner: all journeys, fullSweep between, JSONL verdict out
  replays/              # populated regression corpus (committed, one per fixed bug)
  lib/asserts.ts        # shared behavioral assertions
docs/uat/
  ledger.md             # human-readable index: run date, tier, verdict, issue links
  runs/                 # committed per-run verdict JSONL (small; no fixtures, no names)
  checklists/
    release-candidate.md   # per-platform human UAT script
    journeys/J1..J5.md     # codified field-tester scripts
```

A journey is a deterministic, linear golden flow with explicit expectations - unlike
stress scenarios (loops, PRNG, crash gate). The first journeys transcribe the flows
that already found ship-blockers (#391 import, #426/#437 TML class, #413 undo, #17
corruption class) and the J1-J5 field-report prior art.

### JourneyContext API

- `ctx.expect(label, fn)` records pass/fail as a structured finding
  (`severity: 'error', kind: 'journey-assertion'`) instead of throwing; a journey
  runs to completion and reports all breaches, then the runner fails on any.
- `ctx.checkpoint(name)` captures screenshot + store digest as EVIDENCE for the
  ledger and triage, not assertion - no pixel-golden flakiness; store/disk state is
  what gates.

### New assertions/oracles beyond cheapSweep/fullSweep (`lib/asserts.ts`)

1. **Persistence round-trip**: save -> reopen -> deep-compare project store digest
   (normalized timestamps/ids). The #17/#413 silent-corruption detector the current
   sweeps lack.
2. **Wire-shape probe**: call selected IPC commands raw and validate the JSON
   against checked-in structural schemas (required keys present). Catches the
   serde-omitted-field class (#441) the mocked tier cannot represent. Table-driven,
   cheap.
3. **Export round-trip**: export to a temp path, re-import or parse the artifact,
   assert survey counts match the source (the #449 class).
4. **Undo-identity**: lift the #413 fuzzer invariant (edit burst -> undo-all ->
   identical digest) to a journey-level check.
5. **Count/summary goldens**: after importing a MATERIALIZED fixture, assert
   station/shot/section counts and total length against literals in the spec. The
   fixture prohibition stands: fixtures stay generated at runtime, never committed.

### Replay corpus becomes policy

Every ship-blocker found through the real app gets a committed replay spec in
`e2e/agent/replays/` before its issue closes (generated by
`scripts/generate-replay.mjs`; replays import only `replayHelpers.ts`, so refactors
do not break the corpus). Backfill 3-5 from closed bugs (#441 and #413 classes
first). A `replays-run.ts` runner executes the corpus with fullSweep.

### Verdict ledger

Runners emit one JSONL record per run - `{date, tier, gitSha, platform,
journeys: [{name, verdict, assertions, findings}], worstSeverity}` - into
`docs/uat/runs/`, plus an appended line in `docs/uat/ledger.md` linking issues. The
ledger is the durable memory that today gets lost with session context. The
app-tester protocol gains one closing step: file the verdict line.
`.agent-artifacts/` stays the scratch tier; curated repro reports get promoted to
`docs/uat/reports/` SANITIZED (no names, no verbatim tester feedback), and
`lint:private-leaks` is extended to cover `docs/uat/`.

## Gating policy

| Gate | What runs | Fails on |
|------|-----------|----------|
| PR (`check`) | `typecheck:agent` only (unchanged) | type errors |
| Nightly (self-hosted, after the Playwright full run) | replays + journeys + scenarios-smoke | journeys/replays: any `error` or `fatal`; scenarios keep `fatal`-only (stress legitimately surfaces `error` noise; journeys are curated - a small explicit allowlist file covers known-noisy log patterns) |
| Release (RC tag) | journeys + replays + the 7 legacy disk-I/O WDIO specs; human RC checklist per platform | anything red blocks the release; checklist sign-off recorded in the ledger |

**Windows**: no Windows CI; codify instead.
`docs/uat/checklists/release-candidate.md#windows` transcribes the #410/#429
hand-driven sweep (install, SmartScreen, import/save/export on real paths, the
window-size x zoom matrix) - roughly 30 minutes per RC, run by the Windows-side
maintainer. Revisit a Windows runner only if RC cadence exceeds monthly.

## Phases (~8-11 focused days; Phases 1 and 3 deliver most of the risk reduction)

1. **Ledger + replay policy (~2-3d)**: `docs/uat/` skeleton, JSONL verdict emitter
   in the runners, backfill 3-5 replays, add the close-with-replay rule to
   CONTRIBUTING.md/CLAUDE.md, extend the leak lint.
2. **Journey framework + first 4 journeys (~3-4d)**: `JourneyContext`,
   `lib/asserts.ts`, `journeys-run.ts`; journeys: import, save-reopen,
   undo-identity, export round-trip.
3. **Gates (~1-2d)**: nightly self-hosted job (sequenced after the Playwright full
   run to share the box), ledger auto-append, release checklist incl. the Windows
   script and the legacy-suite step wired into `docs/releasing.md`; update the
   `docs/TESTING.md` tier table, which currently documents the gap.
4. **Human + LLM channel durability (~2d, ongoing)**: J1-J5 field-tester
   checklists, app-tester sessions end with a ledger verdict + a replay per
   confirmed bug; optional @wdio/tauri-service spike.

## Verification (per phase, when implemented)

- `pnpm agent:journeys` (new) runs green locally, each journey emitting a verdict
  record; deliberately break one golden count to confirm the runner reds on `error`.
- Replay corpus: `replays-run.ts` green on master, red against a revert of one
  backfilled fix - proving the corpus detects its bug.
- Nightly workflow: one dispatch on the self-hosted runner; confirm the ledger line
  lands and artifacts upload.
- `pnpm lint:private-leaks` covers `docs/uat/` (seed a fake name; confirm it trips).

## Open questions (answer before Phase 3)

1. Nightly journey failures: red-on-ledger with next-morning triage, or auto-file an
   issue? (Determines whether the nightly job needs issue-auto-filing.)
2. Ledger commit mechanics: bot pushes JSONL directly to master or a `uat-ledger`
   branch, or a PR per run?
3. Is replay-before-close a hard rule for ALL real-app-found bugs, or ship-blockers
   only? (Corpus growth rate vs maintenance.)
4. Windows RC checklist: is a per-RC ~30-minute manual sweep an accepted standing
   commitment, or should a Windows runner be budgeted sooner?

## References

- `docs/agent-harness.md`, `docs/TESTING.md`, `docs/testing-recipes.md`
- `docs/plans/2026-07-30_repro-injection-harness.md` (#370) - complementary; its L3
  stratum IS this harness. Journeys are the golden-flow layer above it.
- `.claude/agents/app-tester.md`, `.claude/skills/app-harness/SKILL.md`
- External: wdio-tauri-service (webdriver.io/docs/wdio-tauri-service),
  Tauri v2 WebDriver docs (v2.tauri.app/develop/tests/webdriver),
  Midscene.js (github.com/web-infra-dev/midscene),
  Magnitude (github.com/magnitudedev/magnitude)
