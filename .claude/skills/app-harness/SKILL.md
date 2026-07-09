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

Runtime requirement: the server must run under **Node 22** (the repo `.nvmrc`).
On Node 23+ `app_start` fails with `UND_ERR_INVALID_ARG`; run `nvm use` first.

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
- `dialog-cycling` - open/close dialogs, assert no residue / DOM growth
- `tool-switch-spam` - cycle every tool, assert activeTool tracks each switch
- `map-storm` - seeded jumpTo barrage + main-thread stall probe
- `save-under-churn` - mutate+save loop, assert isDirty=false, no `.tmp`, clean reopen
- `import-repeatedly` - re-import a `.tml`, assert the undo stack stays <= 100
- `rapid-project-cycle` - open/close a fixture, assert clean project transitions

## When you find a bug

1. **Freeze** - stop exploring; do NOT keep acting (you will bury the repro).
2. **Minimize** - find the shortest action prefix that still triggers it.
3. **Generate the replay**:
   `node scripts/generate-replay.mjs <sessionDir> --assert-final`
4. **Verify it reproduces**:
   `REPLAY_SPEC=<sessionDir>/replay.spec.ts pnpm test:e2e:replay` (Node 22).
   If it does not reproduce, the repro depends on state you did not capture -
   note that in the report.
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
