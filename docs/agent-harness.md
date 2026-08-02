# Agent harness

An LLM-agent harness for driving the **real** running Stalagmight app: testing,
stress testing, bug discovery, and plain interactive use. An MCP stdio server
owns a persistent WebdriverIO session against the Tauri debug binary (headless
Xvfb on Linux), exposing tools for clicking, typing, screenshots, store-state
reads, IPC invokes, stress scenarios, and a problem sweep. Every tool call is
recorded to a JSONL action log that a generator turns into a runnable WDIO
replay spec and a repro report.

For the agent-facing workflow, see the `app-harness` skill
(`.claude/skills/app-harness/SKILL.md`). This document is the reference.

## Runtime: the repo-pinned Node

The harness runs on whatever `.nvmrc` pins (Node 24), like the rest of the repo.
`nvm use` is enough; there is no separate harness toolchain.

This used to say the harness required Node 22 and would fail on 23+ with
`UND_ERR_INVALID_ARG` at `POST /session`, because webdriverio built an `Agent`
from its bundled undici and handed it to Node's built-in `fetch`, so the two
undici majors had to agree. That mechanism is not what the code does. `webdriver`
9.23.0 imports `fetch` from undici alongside `Agent` (`build/node.js:1614`) and
calls that fetch (`:1986`), so on today's code they cannot disagree: the one place
a dispatcher it did not create could reach its own `fetch` is `getGlobalDispatcher()`
(`:2000-2005`, assigned at `:2031`), and `getDispatcher` declines any foreign
dispatcher by testing `constructor.name` against `Agent`/`MockAgent` (`:2002-2003`).
That guard is a string comparison, so treat this as true-of-this-version rather than
structurally impossible. The
global-`fetch` variant is `request/web.ts`, the browser path, which this harness
does not use.

Checked rather than assumed: driving `remote()` through a full session lifecycle
(`POST /session` -> `GET .../window` -> `DELETE`) against a stub WebDriver server
succeeds identically on Node 22 (built-in undici 6.21.2) and Node 24 (undici
7.29.0). The claim also predates nothing - `webdriverio` has been `^9.23.0` since
the harness was written, so this was never a description of a version we no
longer ship.

That probe is committed as `pnpm agent:http-probe`, so this is one command to
re-check after a webdriverio or Node bump rather than something to re-derive. It
runs anywhere, macOS included, because the stub replaces the driver.

That probe covers only the HTTP layer, so the full stack was checked separately on
Linux, where it actually runs. On the self-hosted runner under Node 24.18.1
(built-in undici 7.29.0), `pnpm agent:smoke` built the debug binary, brought up
tauri-driver plus WebKitWebDriver on an Xvfb display, drove the real app and
passed all 13 checks - including the crash oracle (a thread panic wrote its marker
and `PANIC` ring line while the app stayed responsive) and process-group teardown
with both ports released. Whole job: 7 minutes, of which 4m34s was the build.

That is one green run, on one Node patch, on one Linux box - enough to retire the
claim that Node 22 was required, not enough to call every layer Node-agnostic
forever. `session.ts` still warns (advisorily) when the running major differs from
`.nvmrc`, because the verified envelope is only {22, 24} and `node@26` already
exists.

Reproduce with the `Agent Harness (on-demand)` workflow (`workflow_dispatch`). It
runs on the self-hosted runner, so it consumes no *included* Actions minutes - but
that runner also serves the merge gate, and `ci.yml`'s picker spills `check` to
paid hosted runners whenever it is busy, so dispatching this during a merge window
is not free in practice. The runner image carries webkit's `-dev` packages for
`cargo test` but not the WebDriver daemon, so the job installs `webkit2gtk-driver`
and `tauri-driver` (xvfb is usually already there) - about 40s combined.

If `app_start` ever does fail with `UND_ERR_INVALID_ARG`, suspect `HTTP_PROXY` /
`NO_PROXY` in the environment before the Node version, and record what actually
fixed it here. `agent:http-probe` drops those variables for its own loopback stub
(webdriver snapshots them at module init and would otherwise route a 127.0.0.1
request through the proxy, then blame the driver), so a proxy-caused failure shows
up in `app_start` rather than in the probe.

## Architecture

```
MCP client --stdio--> e2e/agent/mcp/server.ts  (tsx, @modelcontextprotocol/sdk)
                        |- AppSession (e2e/agent/session.ts): state machine + command mutex
                        |    |- Xvfb (only if no DISPLAY)
                        |    |- tauri-driver --port 4544 --native-port 5544
                        |    |    -> WebKitWebDriver -> stalagmight debug binary
                        |    |       (isolated HOME/XDG, STALAGMIGHT_TEST_HOOKS=1, RUST_BACKTRACE=1)
                        |    |- webdriverio remote() ('wdio:enforceWebDriverClassic': true)
                        |- Oracles (cheap sweep per mutating action; full sweep on demand)
                        |- Recorder -> .agent-artifacts/sessions/<id>/
                             actions.jsonl, screenshots/, state/, findings/, pids, tauri-driver.log
```

All WebDriver traffic is serialized through a per-session command mutex, so a
sweep never interleaves with a tool call. The session is stateless at the tool
boundary (fresh element resolution every call) to survive WebKit stale-ref
hazards over long runs.

## Setup

- MCP config: `.mcp.json` registers server `stalagmight-app`
  (`pnpm exec tsx e2e/agent/mcp/server.ts`). In Claude Code, `/mcp` shows it.
- Direct scripts (all on the repo-pinned Node, `nvm use`):
  - `pnpm agent:smoke` - session-core smoke (build -> launch -> drive -> stop).
  - `pnpm agent:mcp:smoke` - MCP-layer smoke (spawns the server, round-trips
    every tool through the protocol, self-tests the crash oracle).
  - `pnpm agent:scenarios` - runs all 8 stress scenarios once at small n.
  - `pnpm agent:mcp` - run the server standalone (for an external MCP client).
  - `pnpm agent:bridge <dir>` - file-based access to the same server for plain
    shells and subagents without an MCP client: append JSON tool calls to
    `<dir>/requests.jsonl`, read responses from `<dir>/responses.jsonl`
    (protocol documented in `e2e/agent/mcp/bridge.ts`).
- Agent definitions: `.claude/agents/app-tester.md` (Opus; end-to-end feature
  testing playbook: happy path, edge cases, UI at multiple window sizes and
  zoom levels, per-issue code analysis, structured report) and
  `.claude/agents/code-analyst.md` (Opus, read-only; per-issue root-cause
  analysis it spawns).

## Build freshness + the E2E build stamp

`app_start(build: "auto")` rebuilds when either signal says stale
(`e2e/agent/lib/build.ts`):

1. **mtimes** - any file under `src/`, `src-tauri/src/`, or one of
   `tauri.conf.json` / `package.json` / `index.html` / `vite.config.ts` is newer
   than the debug binary.
2. **E2E build stamp** - `buildApp` writes
   `$CARGO_TARGET_DIR/debug/.stalagmight-e2e-build-stamp.json` after a
   successful build, recording `viteE2E`, the vite mode, and the mtime of the
   binary it produced. A missing stamp, a stamp whose `viteE2E` disagrees with
   what the start needs, or a binary whose mtime no longer matches the stamp
   (`./scripts/dev.sh` or a plain `pnpm tauri build` relinked it) is stale.

mtimes alone cannot see *how* a binary was built, so before the stamp a
`dev.sh`-built binary looked fresh and `auto` attached to a hookless dist, only
to fail the post-attach `__E2E_TEST__` check - a full attach cycle plus a manual
`build: "force"` per rerun (issue #260). The stamp lives in the cargo target dir
(a build output, gitignored / outside the repo), never in the source tree. The
post-attach `__E2E_TEST__` check remains the definitive backstop.

## Tools

Lifecycle:

| Tool | Purpose |
|---|---|
| `app_start(build?, headed?, freshProfile?)` | Build if stale, launch, attach, verify hooks. `build`: auto/skip/force. Staleness = source mtimes newer than the binary **or** the E2E build stamp not vouching for it (see below). Default is headless on Xvfb even when a desktop display exists (no window pops up, no focus stealing); `headed: true` shows the window on the real display. |
| `app_stop` | Close app + driver, reap the process group. |
| `app_restart(freshProfile?=false)` | Restart keeping the profile (persisted-state repros). |
| `app_status` | Liveness: state, uptime, driverAlive, sessionDir, node. |

Observation:

| Tool | Purpose |
|---|---|
| `screenshot(name?)` | PNG as MCP image + saved to the session dir. |
| `store_state(store, path?, maxBytes?)` | Read a Zustand store; no path = key/type summary, dot path = value (JSON-capped). |
| `logs(level?, peek?)` | New ring lines since last read (error/warn/all); `peek` does not advance. |
| `wait_for(condition, ...)` | selector / hidden / app-ready / ui-idle / map-idle / active-tool / store-path. |
| `element_state(testid\|selector)` | Matching count plus visible/enabled/value/checked/ARIA state. `unique: false` flags duplicate runtime IDs. |

Interaction (each runs a cheap oracle sweep after; findings ride the result under `oracle`):

| Tool | Purpose |
|---|---|
| `click(testid\|selector\|x+y, button?, double?, modifiers?)` | Fresh element resolution, waitForClickable, or a canvas pointer at coords. |
| `type_text(text, testid?/selector?, clear?, submit?)` | Focus + type; `Control` not `Meta`. |
| `press_keys(keys[])` | WebDriver key sequence. |
| `hover(testid\|selector)` | Move the pointer over a fresh element reference. |
| `drag(from..., to..., button?, durationMs?)` | Drag between test IDs, selectors, or viewport points. |
| `scroll(testid?/selector?, deltaX?, deltaY?)` | Scroll a target into view or scroll a target/window by pixels. |
| `select_option(testid\|selector, value)` | Select a native option or a portaled Stalagmight `Select` option by value. |
| `file_dialog_answer(kind, path\|paths\|cancel)` | Queue the next E2E-only native open/save picker answer, then activate the real UI flow. |
| `store_action(store, action, args?)` | Call a Zustand action (async-aware). |
| `eval(script, args?)` | Async function body in the webview; returns its value. |
| `ipc(command, args?)` | `window.__TAURI__.core.invoke`; e.g. `get_recent_logs_since`, `check_project_integrity`. |
| `map_view(set?)` | Read or set the MapLibre view (center/zoom/bearing). |
| `map_click(lngLat, button?)` | Geo point -> `map.project()` -> canvas-relative pointer. |
| `map_feature_click(featureType, sectionId, shotId?/stationIndex?, button?, verifySelection?)` | Resolve current WebGL geometry by semantic identity, choose a safe point, click it, and verify selection by default. Disable verification for tools whose click intentionally has another effect. |
| `seed(mode, name?, projectName?)` | Open a fixture / fractal fixture (`e2e/fixtures/`), or create a basic empty project. |
| `driver_script(script, timeoutMs?)` | Node-context async body with `browser`/`ipc`/`evalInApp`/`readStore`/`callAction`/`log` in scope, under the mutex, for tight loops (one MCP call per action is too slow). On timeout the helpers (and the `browser` proxy) are disabled so a still-running body cannot keep driving the app outside the mutex. |

Oracles + scenarios:

| Tool | Purpose |
|---|---|
| `check_problems` | Full oracle sweep (see below). |
| `run_scenario(name, seed?, iterations?)` | Run a named stress scenario, then a full sweep. |

## Oracles

- **Cheap sweep** (auto after every mutating tool): crash-marker glob (fatal
  even if the process survived), React error-boundary probe, new error/warn ring
  lines since an internal cursor. A `dropped`/`ring-overflow` warning means the
  500-entry ring rotated past the cursor.
- **Full sweep** (`check_problems`): cheap sweep plus `check_project_integrity`
  (`save_blocked` = fatal, non-empty messages = error), leftover `*.stalx.tmp`
  beside `projectStore.projectPath`, `get_memory_stats` vs a session baseline
  (total RSS > baseline*1.5 + 300MB = warning, with per-process breakdown), and
  a read-only responsiveness probe (a hung IPC = possible command-lock deadlock,
  fatal).

Findings are deduped by kind+message. The first fatal/error occurrence captures
a screenshot + `finding.json` + any crash markers into `findings/<n>/` and emits
a `finding` event to the action log. Severity ranks: `warning` < `error` <
`fatal`.

## Observability hooks (app-side)

Added under a small, always-safe surface:

- **Ring buffer** (`src-tauri/src/logging/mod.rs`): `VecDeque<RingLogEntry>`
  (`{seq, ts_ms, line}`), cap 500. `get_recent_logs_since(after_seq)` returns
  `{entries, latest_seq, dropped}` where `dropped` is true when the ring rotated
  past the checkpoint.
- **Rust panic hook** (`src-tauri/src/logging/panic_hook.rs`): writes a
  synchronous crash-marker JSON `crash-<pid>-<millis>.json` into the log
  directory (message, location, thread, `Backtrace::force_capture()`) and logs
  `PANIC: ...` to the ring. The marker is the durable signal (the file log layer
  can drop tail lines on abort). A thread panic leaves the app alive but the
  marker is fatal regardless.
- **Frontend global error capture** (`src/utils/globalErrorCapture.ts`):
  `window` `error` / `unhandledrejection` -> `console.error` with the
  `[unhandled-error]` / `[unhandled-rejection]` prefixes (the oracle contract),
  rides the console bridge into the ring, rate-limited.
- **Self-test command** (`src-tauri/src/commands/debug.rs`):
  `debug_trigger_panic(delay_ms)` panics on a spawned thread (app survives; hook
  fires). Inert unless `STALAGMIGHT_TEST_HOOKS=1` (the session sets it). This is
  the harness doctor primitive.

## Action-log JSONL contract (v1)

```jsonc
{"type":"session-start","v":1,"sessionId":"...","gitHead":"...","binaryPath":"...","display":":89","headed":false,"profileDir":"...","freshProfile":true}
{"type":"action","v":1,"seq":12,"ts":"...","tool":"click","params":{...},"resolved":{"selector":"...","point":{"x":412,"y":333}},"outcome":{"ok":true,"durationMs":184},"result":{...},"artifacts":{"screenshot":"screenshots/0012-shot.png"},"post":{"view":"single","dialog":null,"activeTool":"select","projectName":"...","projectOpen":true}}
{"type":"event","v":1,"seq":40,"ts":"...","event":"finding|crash-detected|scenario-log","detail":{...}}
{"type":"session-end","v":1,"ts":"...","reason":"app_stop","actions":57}
```

`resolved` carries the concrete selector/coords the replay generator needs;
`eval`/`ipc`/`store_action` embed their full script/command/args. Generators
tolerate a truncated final line.

## Replay + report

- **Replay**: `node scripts/generate-replay.mjs <sessionDir> [--out f] [--name n]
  [--assert-final]`. Interaction tools become real WDIO code using `resolved`,
  including `seed` (replayed as `openProject`/`createProject`), `driver_script`
  (re-run with the same helpers), and `run_scenario` (re-run with the recorded
  seed/iterations). Map clicks re-project their recorded longitude/latitude,
  semantic waiters stay semantic, and test IDs are CSS-escaped. Observation
  tools become numbered comments; inter-action gaps > 250ms become bounded
  pauses; `--assert-final` turns the last
  `store_state` into a hard expect (skipped if the recorded value was
  truncated). Run via `REPLAY_SPEC=<file> pnpm test:e2e:replay` (spreads the
  base wdio config; single instance, no retries). Curated replays live under
  `e2e/agent/replays/`.
- **Report**: `node scripts/generate-repro-report.mjs <sessionDir>` ->
  `report.md` (steps, environment, oracle findings, evidence paths), with
  `$HOME`/session paths scrubbed for public issues.

## Artifacts layout

```
.agent-artifacts/sessions/<yyyymmdd-hhmmss-rand>/
  actions.jsonl        # the action log (JSONL contract above)
  screenshots/         # <seq>-<name>.png
  state/               # state snapshots
  findings/<n>/        # finding.json + screenshot.png + crash markers
  pids                 # recorded PIDs (for scoped orphan reaping)
  tauri-driver.log     # continuous driver stderr/stdout
  replay.spec.ts       # if a replay was generated here
  report.md            # if a report was generated here
```

Gitignored; the 20 newest sessions are kept.

## Troubleshooting

- `app_start` fails `UND_ERR_INVALID_ARG` -> an error from webdriverio's undici
  HTTP layer. Session creation works on Node 22 and 24, so check `HTTP_PROXY` /
  `NO_PROXY` in the environment before blaming the Node version.
- `window.__E2E_TEST__ not present` -> the binary was built without `VITE_E2E=1`.
  `build: "auto"` should have caught that before attach (see the build stamp
  below); if you land here anyway, rerun `app_start` with `build: "force"`.
- The window never appears on screen -> that is the default: sessions run on a
  throwaway Xvfb even when a desktop display exists (GDK is pinned to X11 there,
  since a Wayland-preferring GTK would otherwise render to the real compositor).
  Pass `headed: true` to watch the app live on the real display.
- Orphan `tauri-driver` / `WebKitWebDriver` after an unclean server kill -> the
  next `app_start` scoped-reaps PIDs recorded in each session's `pids` file
  (verified by `/proc/<pid>/comm`); it never broadly `pkill`s.
- Second instance -> set `STALAGMIGHT_AGENT_BASE_PORT` to move the driver/native
  ports (default 4544 / 5544, probed +1 up to +10).
