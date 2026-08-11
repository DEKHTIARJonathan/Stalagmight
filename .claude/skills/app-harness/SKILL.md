---
name: app-harness
description: Drive the real running Stalagmight app to test it, stress it, find bugs, or just use it. Use when asked to interactively exercise the app, reproduce a UI/IPC/persistence bug, run stress scenarios, or produce a repro report / regression replay. Backed by a WebdriverIO session exposed over MCP (server "stalagmight-app").
---

# Stalagmight app harness

You drive the **real** Tauri app (Rust backend + WebKit webview) through the
`stalagmight-app` MCP server. It owns one persistent WebdriverIO session against
a debug build, launched headless under Xvfb on this box. Every tool call is
recorded to a JSONL action log you can later turn into a runnable replay and a
repro report.

Runtime: the server runs on the repo-pinned Node (`.nvmrc`, currently 24) - `nvm
use` is enough, there is no separate harness toolchain.

If the `stalagmight-app` MCP tools are not available in your session (server
disconnected), use the file bridge instead: `pnpm agent:bridge <dir>` in the
background, wait for `<dir>/ready`, then append JSON tool calls to
`<dir>/requests.jsonl` and poll `<dir>/responses.jsonl` (protocol in
`e2e/agent/mcp/bridge.ts`). For feature-level test requests, prefer spawning
the `app-tester` agent (`.claude/agents/app-tester.md`) over testing inline.

## Start here

1. `app_start` (build `auto`; it rebuilds only if the source is newer than the
   binary). Returns the session dir under `.agent-artifacts/sessions/<id>/`.
   Runs invisibly on Xvfb by default; pass `headed: true` only if the user asks
   to watch the app live on their desktop.
2. Harness doctor (do this once per new session so you trust the oracle):
   call `ipc` with `{ command: "debug_trigger_panic", args: { delayMs: 50 } }`,
   then poll `check_problems` until you see a `crash-marker` finding with
   severity `fatal`. The app survives (thread panic) - confirm it still responds
   with `store_state ui view`. If the finding never appears, the oracle is not
   wired to this build; stop and investigate before trusting results.

## The loop: observe, act, verify

- **Prefer state over pixels.** Read `store_state` (Zustand: ui, project,
  globalView, gasPlan, speleo, export, network) and `ipc` results to know what
  happened. Take a `screenshot` for visual confirmation, before/after a risky
  action, or to attach to a finding - not as your primary signal.
- **Act** with `click` / `type_text` / `press_keys` (use `Control`, not `Meta` -
  the app's CMD_KEY convention), `store_action` for direct state driving, and
  `map_click` / `map_view` for the canvas-rendered survey map.
- **Verify** with `wait_for` (selector / app-ready / ui-idle / map-idle /
  active-tool / store-path) instead of guessing timing.
- Mutating tools run a **cheap oracle sweep** automatically; if anything new
  turns up it rides the result under `oracle`. Never ignore an `oracle` block.

## Sweep cadence

Run the **full** sweep (`check_problems`) after every scenario, roughly every
~20 exploratory actions, after any save / import / project open-or-close, and
once before ending the session. It checks crash markers, error/warn logs, the
React error boundary, project integrity, leftover `*.stalx.tmp`, memory growth,
and IPC responsiveness. Treat `fatal` as a hard stop; `error` as a real finding;
`warning` as worth noting. A `ring-overflow` / `dropped` warning means log lines
were lost - slow down and re-check.

## Stress scenarios

`run_scenario` with a `name` (and optional `seed`, `iterations`) runs a seeded
stress loop then a full sweep:

- `seed-large-project` - load a fractal fixture, assert a clean multi-section open
- `undo-redo-churn` - create N sections, undo N + redo N, assert snapshot equality
- `undo-redo-fuzz` - seeded random mutations + random undo/redo walks, asserting an
  EXACT normalized `get_project_state` roundtrip at every history depth. Opens its own
  copy of the fixture with the persisted undo history stripped, from depth 0.
  `STALAGMIGHT_FUZZ_FIXTURE=<basename>.stalx` picks the starting fixture (default
  `fractal_plant_iter3.stalx`; `naharon.stalx` has the loop closures, zero datums and
  null section metadata that reach half the findings). Runs three oracles: state
  roundtrip (including multi-step `undoTo`/`redoTo` jumps against the same snapshots),
  absolute project invariants, and an integrity-verdict delta. Every issue-413 finding
  it reported is FIXED, so it is GREEN and STRICT by default: every known-bug classifier
  and tolerance has been deleted, and a mismatch of any shape at any depth fails the run.
  The recorded repro lines (in the scenario's header comment) are kept verbatim as
  regression checks. `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS` is INERT - still read, and still
  named in a failure's `reproduce:` line so a tolerant-looking invocation cannot be
  mistaken for one that relaxed something, but it allows nothing.
  `STALAGMIGHT_FUZZ_STREAM=v1` restores the
  pre-expansion generator set for repro lines minimized against it. Snapshotting and comparison happen in-page, so a step is one
  round trip. To sweep it, `pnpm agent:fuzz-matrix --fixtures a,b --seeds 1..8 --workers 3`
  runs the matrix in parallel (max 5 workers - one Xvfb display each) and prints a
  results table with every failure's repro line. Add `--release` to either runner to
  drive the release binary (~1.4x on the bigger workloads); debug is the default
  because its `debug_assert!`s are oracles too - see docs/agent-harness.md
- `undo-persistence-fuzz` - the save/reload sibling of the above. Each iteration builds an
  undo stack carrying every `UndoData` variant a live command can produce, forces the shot
  ids to diverge from positional order, leaves the redo stack non-empty, saves/closes/reopens,
  then walks the whole RESTORED history to depth 0 and back up - including the restored REDO
  entries. GREEN and STRICT by default too, and `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS` is
  INERT here as well: it found findings 12 and 13 on issue #413 - undo after a reload
  edited the WRONG shot (`SetShotKind` / `UpdateShot` carried the in-session shot id) or
  failed outright and wedged the history - and both are fixed, with their classifiers
  deleted. `STALAGMIGHT_PERSIST_FUZZ_DELETE_IN_TARGET=1` is finding 13's repro; the wedge
  is fixed, so it now walks the whole restored stack instead of being terminal, and stays
  off by default because the plan's coverage promises are written against the other
  id-space shape - see docs/agent-harness.md
- `dialog-cycling` - open/close dialogs, assert no residue / DOM growth
- `tool-switch-spam` - cycle every tool, assert activeTool tracks each switch
- `map-storm` - seeded jumpTo barrage + main-thread stall probe
- `save-under-churn` - mutate+save loop, assert isDirty=false, no `.tmp`, clean reopen
- `import-repeatedly` - re-import a `.tml`, assert the undo stack stays <= 100
- `rapid-project-cycle` - open/close a fixture, assert clean project transitions

## Fuzz traces: record, replay, shrink

Both undo fuzzers write a TRACE of their resolved moves to
`<session>/traces/<scenario>-seed<N>-<stamp>.json` whenever they FAIL, and name the
path in the failure message. `STALAGMIGHT_FUZZ_TRACE=path` also writes one on success.

- Replay it: `pnpm agent:scenario <scenario> --trace <file> [--release]` - same bridge,
  same oracles, same failure payload; only the source of the decisions changes.
- Minimize it: `pnpm agent:fuzz-shrink <trace.json> [--release]` - ddmin down to a
  1-minimal move list, then read `<trace>.min.json` and the printed action list. Measured
  on the bug 1 repro: 43 steps -> 2, 52 s, ~1.8 s per replay.

A shrunk action list is the body of a red Rust test almost line for line. Do this
INSTEAD of bisecting a fuzz failure by hand. See docs/agent-harness.md for what the
signature match does and does not distinguish.

## When you find a bug

1. **Freeze** - stop exploring; do NOT keep acting (you will bury the repro).
2. **Minimize** - for a fuzz failure, run `pnpm agent:fuzz-shrink` on the trace it
   left; otherwise find the shortest action prefix that still triggers it.
3. **Generate the replay**:
   `node scripts/generate-replay.mjs <sessionDir> --assert-final`
4. **Verify it reproduces**: re-drive the recorded steps through the live
   harness session (the spec maps 1:1 to them). There is no spec runner today -
   #549 retired the WDIO one and the #466 replay-runner phase replaces it (see
   `e2e/agent/replays/README.md`). If it does not reproduce, the repro depends
   on state you did not capture - note that in the report.
5. **Write the report**:
   `node scripts/generate-repro-report.mjs <sessionDir>` -> `report.md`
   (paths are scrubbed of `$HOME` for public issues). Fill in expected-vs-actual.

## Filing an issue (only when asked / confirmed)

Filing is a deliberate, human-gated step - do NOT do it automatically. After the
user confirms, file with:
`gh issue create --title "..." --body-file <sessionDir>/report.md`
(origin is the GitHub repo; `gh` is already authenticated). Curate a committed
regression replay under `e2e/agent/replays/` only for durable, deterministic,
leak-scanned repros.

## Cleanup

`app_stop` when done (frees the driver + app, reaps the process group). If the
server was killed uncleanly, the next `app_start` scoped-reaps the orphans it
recorded. Session artifacts persist under `.agent-artifacts/` (gitignored, last
20 kept).

Full reference: `docs/agent-harness.md`.
