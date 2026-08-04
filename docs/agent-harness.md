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

## macOS

Since #421 the harness also runs on macOS, through a different WebDriver stack:
`createSession()` picks `MacSession` (`e2e/agent/sessionMac.ts`), which drives
`tauri-wd` (`cargo install --git
https://github.com/FumblingBarbell/tauri-webdriver tauri-webdriver-automation`
installs the `tauri-wd` binary onto PATH) against the in-app
`tauri-plugin-webdriver-automation` server, compiled in by the darwin build arm
(`pnpm tauri build --debug --no-bundle -- --features e2e`; the E2E build stamp
records the feature so a plugin-less binary reads as stale). The feature build
regenerates `src-tauri/gen/schemas/*.json` with the plugin's ACL entries;
`buildApp` restores them when they were clean before the build, and warns
instead of clobbering when they were already modified - never commit them in
the feature shape. `e2e/mac-app-wrapper.mjs` sits between tauri-wd and the
binary exactly as in the legacy WDIO suite.

Platform differences that are contracts, not bugs (full rationale + probe
evidence: `docs/plans/2026-08-05_macos-agent-harness.md`):

- **Always headed.** macOS has no Xvfb; `headed: false` is coerced (the start
  result carries `headedForced: true`) and the window is parked on the RIGHT
  half of the screen so it can share the desktop with a human. Override with
  `STALAGMIGHT_AGENT_WINDOW_RECT="x,y,w,h"`.
- **Input is synthetic.** The plugin dispatches JS events in the webview
  (`isTrusted: false`). Everything testid-driven works; native menu
  accelerators do not - `press_keys` with `Meta` returns a `caveat` saying so.
- **Screenshots are DOM-only.** The plugin rasterizes the DOM, so canvas/WebGL
  (the survey map) is blank; the `screenshot` result carries `domOnly: true`.
- **Teardown is pidfile-based.** tauri-wd SIGKILLs the wrapper on
  `delete_session`, orphaning the app; the wrapper records the real app pid
  into the session pidfile and `MacSession.stop()` reaps it (comm-verified,
  `stalagmight`/`tauri-wd` only).
- **Eval scripts** must finish inside the plugin's 30 s execute-async timeout
  and never resolve to an object carrying both `error` and `message` keys (the
  plugin coerces that shape into a script error). See `e2e/agent/lib/page.ts`.

`pnpm agent:smoke` and `pnpm agent:mcp:smoke` run on macOS unchanged (verified
2026-08-05: 13/13 and full MCP pass on an M1). Real trusted input and real
pixels come from the permission-gated Tier 2 tools under `e2e/agent/os/`,
registered on darwin only: `os_grant`, `os_click`, `os_keys` (real modifier
flags, so Cmd+S reaches the menu bar) and `os_screenshot` (`screencapture` of
the app window). `os_grant` is deliberately never allowlisted, so invoking it
raises a real permission prompt - the human, not the model, decides that a
session may drive the desktop - and the grant lasts until the MCP server exits.
Two TCC permissions gate the machine side: Accessibility for input, Screen
Recording for capture. Both belong to the process that spawns the helper (your
terminal or the editor running the MCP server), never to the helper binary or
to the app, and both fail silently into plausible-looking evidence when denied,
which is why preflight rides every result. Full contract:
[`e2e/agent/os/README.md`](../e2e/agent/os/README.md).

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
  - `pnpm agent:scenarios` - runs all 9 stress scenarios once at small n.
  - `pnpm agent:scenario <name> [--seed N] [--iterations M] [--release]` - runs
    ONE scenario at a chosen seed/n, then a full sweep. The one to reach for when
    a seeded scenario needs re-running: a fuzzer repro, or a soak at a bigger n
    than the gate would tolerate.
  - `pnpm agent:fuzz-matrix [--fixtures a,b] [--seeds 1..8|1,3,7] [--workers K]
    [--iterations M] [--release]` - runs `undo-redo-fuzz` across a (fixture x seed) matrix,
    K child processes at a time, and prints a results table, every failure's
    repro line, merged metric totals and the observed speedup. Each worker slot
    gets its own port block (`STALAGMIGHT_AGENT_BASE_PORT = 4544 + 20*slot`) and
    its own single-entry Xvfb pool (`STALAGMIGHT_AGENT_DISPLAYS`), so `K` is
    hard-capped at 5 - the size of the display pool.
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

## Build profile: debug by default, release opt-in

The harness drives the **debug** binary unless `STALAGMIGHT_AGENT_RELEASE=1` is
set (`--release` on `agent:scenario` and `agent:fuzz-matrix` sets it for their
children). That default is a deliberate trade, not inertia.

**What release costs you.** `debug_assertions` is off, so these stop running:

- Every `debug_assert!` in a live path - `core/state/command_comment.rs:71`,
  four in `core/loading.rs`, `models/project/reverse.rs:358`,
  `models/project/classify.rs:244`, `models/project/offsets.rs:112`. Each is an
  invariant check the app performs on itself during exactly the mutations a
  fuzzer drives.
- `Project::debug_assert_merge_alignment` (`models/project/offsets.rs:72`), whose
  whole body is `#[cfg(debug_assertions)]`. In debug it emits a `tracing::error!`
  when a merge ends up more than 5 cm out of alignment inside a single command;
  that line rides the ring buffer into the harness's error-log oracle. In release
  the check does not exist, so that class of drift becomes invisible.
- Rust's debug-only integer-overflow panics: an overflow that aborts loudly in
  debug wraps silently in release.
- `[profile.release]` sets `strip = true`, so a crash marker's
  `Backtrace::force_capture()` has no symbol names.

In other words a debug build is itself an oracle, and the release build trades
several of them for speed. Reach for release when you are sweeping seeds for
throughput; keep debug for the run whose result you intend to trust.

**What release keeps.** The release harness build passes `--features e2e`, the
repo's own name for this build. That keeps `debug_trigger_panic` compiled in
(`#[cfg(any(debug_assertions, feature = "e2e"))]`,
`src-tauri/src/commands/debug.rs`), so the crash-oracle self-test still works
without `debug_assertions`. The panic hook, the crash marker and the ring buffer
are not feature-gated and behave identically. `window.__E2E_TEST__` is gated on
`import.meta.env.DEV || MODE === 'test' || VITE_E2E === '1'`, and the frontend leg
is the same `pnpm build` in both profiles, so `VITE_E2E=1` supplies the hooks in a
production-mode vite build too; `waitForE2EHooks` fails the start loudly, naming
the profile and the binary path, if they are ever missing. The debug build passes
no features, so the DEFAULT build is byte-for-byte what it always was.

**Cost.** One-time cold release build: about 3.5 minutes wall clock on the
self-hosted runner (`Finished release profile [optimized] in 2m 08s` plus the
vite leg and the link), against roughly 4.5 minutes for debug. Both profiles are
cached independently under `$CARGO_TARGET_DIR`, so switching back and forth does
not rebuild.

## Build freshness + the E2E build stamp

`app_start(build: "auto")` rebuilds when either signal says stale
(`e2e/agent/lib/build.ts`):

1. **mtimes** - any file under `src/`, `src-tauri/src/`, or one of
   `tauri.conf.json` / `package.json` / `index.html` / `vite.config.ts` is newer
   than the binary for the profile being started.
2. **E2E build stamp** - `buildApp` writes
   `$CARGO_TARGET_DIR/<profile>/.stalagmight-e2e-build-stamp.json` after a
   successful build, recording the profile, its cargo features, `viteE2E`, the
   vite mode, and the mtime of the binary it produced. A missing stamp, a stamp
   whose profile / features / `viteE2E` disagree with what the start needs, or a
   binary whose mtime no longer matches the stamp (`./scripts/dev.sh` or a plain
   `pnpm tauri build` relinked it) is stale. One stamp per profile, beside the
   binary it vouches for, is what lets debug and release coexist without
   thrashing rebuilds or running the wrong binary; a pre-release-mode `v1` stamp
   cannot name its profile and is treated as absent (one rebuild, once).

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
| `file_dialog_answer(triggerTestid, kind, path\|paths\|cancel)` | Click the named UI control, answer the picker it opens, and verify that exact answer was consumed. |
| `store_action(store, action, args?)` | Call a Zustand action (async-aware). |
| `eval(script, args?)` | Async function body in the webview; returns its value. |
| `ipc(command, args?)` | `window.__TAURI__.core.invoke`; e.g. `get_recent_logs_since`, `check_project_integrity`. |
| `map_view(set?)` | Read or set the MapLibre view (center/zoom/bearing). |
| `map_click(lngLat, button?)` | Click a visible geographic point through the ordinary or placement path, reject half-open viewport edges, and require the map interaction sequence to advance. |
| `map_feature_click(featureType, sectionId, shotId?/stationIndex?, button?, verifySelection?)` | Resolve current WebGL geometry by semantic identity, arm a one-use overlap preference, drive the MapLibre pipeline, and prove this click was processed. Selection is also verified by default. |
| `seed(mode, name?, projectName?)` | Open a fixture / fractal fixture (`e2e/fixtures/`), or create a basic empty project. |
| `driver_script(script, timeoutMs?)` | Node-context async body with `browser`/`ipc`/`evalInApp`/`readStore`/`callAction`/`log` in scope, under the mutex, for tight loops (one MCP call per action is too slow). On timeout the helpers (and the `browser` proxy) are disabled so a still-running body cannot keep driving the app outside the mutex. |

Oracles + scenarios:

| Tool | Purpose |
|---|---|
| `check_problems` | Full oracle sweep (see below). |
| `run_scenario(name, seed?, iterations?)` | Run a named stress scenario, then a full sweep. |

## Stress scenarios

Registered in `e2e/agent/scenarios/index.ts`; each is a seeded loop that FAILS by
throwing. Small-n values for the `pnpm agent:scenarios` gate live in
`e2e/agent/scenarios-smoke.ts`.

| Scenario | What it asserts |
|---|---|
| `seed-large-project` | A fractal fixture opens cleanly into a multi-section single-system view. |
| `undo-redo-churn` | Create N sections, undo N + redo N; the cheap state signature returns to baseline. |
| `undo-redo-fuzz` | Seeded random mutations interleaved with random undo/redo walks; an EXACT normalized `get_project_state` roundtrip at every history depth (see below). |
| `dialog-cycling` | Opening/closing dialogs leaves no residue and no DOM growth. |
| `tool-switch-spam` | `activeTool` tracks every switch. |
| `map-storm` | A seeded `jumpTo` barrage does not stall the main thread. |
| `save-under-churn` | Mutate+save leaves `isDirty=false`, no `.tmp`, and reopens clean. |
| `import-repeatedly` | Re-importing a `.tml` keeps the undo stack at or under 100. |
| `rapid-project-cycle` | Open/close cycles leave clean project transitions. |

### undo-redo-fuzz

The oracle is a full canonical `get_project_state` snapshot per undo depth: every
field it drops is justified in `e2e/agent/lib/fuzzOracleCore.ts`'s header, map key
order is canonicalized rather than ignored, and when two canonical strings
disagree Node re-compares with a 1e-9 absolute / 1e-12 relative tolerance
(`projectSnapshot.ts`), because geometry is re-derived rather than copied after
every undo/redo. Backend truth for the model is the app's own `get_undo_stack` /
`get_redo_stack` lengths.

The snapshot is taken and compared IN THE WEBVIEW. `fuzzOracleCore.ts` holds the
serializer and the targeting digest as two self-contained functions that Node
calls directly and also injects into the page via `Function.prototype.toString()`
- one implementation, with a unit test that feeds the same state to both and
asserts byte-identical output. Each step is then a single fused `executeAsync`
(`undoRedoFuzzBridge.ts`): call the projectStore action, observe, canonicalize,
compare, return a verdict plus the digest. Full canonical strings cross the
bridge only after a comparison has already failed.

That leaves the bridge at roughly 6% of a step. Measured on fractal seed 4 x60
(90 steps, `actionMs`/`observeMs`/`canonicalMs` are reported as metrics): 4775 ms
in the store action's own `flushPlanAnchors` + command + `refreshProjectState` +
`checkProjectIntegrity` chain, 810 ms in the three read-only IPC reads, 132 ms
canonicalizing, ~390 ms of WebDriver. The action chain is the boundary coverage
that found the `updateSection` and undo-fails-outright bugs, so it stays; further
speedup has to come from parallelism, which is what `agent:fuzz-matrix` is for.

The starting point is chosen and cleaned rather than inherited. The scenario
closes whatever project is open, materializes its own copy of the fixture,
DELETES that copy's persisted undo history, loads it, and then asserts both
history stacks are empty. Tracked fixtures ship with a stack
(`undo_persist_limit`, 20 rows in the fractal fixture and 2 in naharon), and a
scenario that models undo depth must not fuzz on top of somebody else's entries
or burn the headroom below the 100-entry limit. `stripUndoHistory`
(`e2e/agent/lib/fixtures.ts`) is the harness-side replica of the app's own
`Database::clear_undo_history_at`, and refuses any path inside `e2e/fixtures/`
so it can only ever touch a temp copy.

| Env var | Effect |
|---|---|
| `STALAGMIGHT_FUZZ_FIXTURE` | Which `.stalx` under `e2e/fixtures/` to fuzz, by BASENAME (`fixtureSourcePath`'s `path.basename` is the containment guard). Defaults to `DEFAULT_FIXTURE`. Recorded in the metrics and the log line so a run stays attributable. |
| `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS` | `1` keeps going past a mismatch that is ENTIRELY a classified known bug (logged, counted, model resynced). Not the default: a green default would mean the oracle had been weakened. |

Fixture choice is load-bearing, not cosmetic. The fractal fixture has no loop
closures, no zero datums and a non-null surveyor on all 32 sections; naharon has
all three plus 13 null-surveyor sections, and half the bugs below are only
reachable there.

It currently reproduces six open undo bugs, enumerated with per-fixture,
per-seed repro commands in the scenario's header comment, so it is RED by
default. Three are classified (`KNOWN_UNDO_ASYMMETRIES` plus
`LOOP_CLOSURE_REORDER`), which makes the failure message name the bug and makes
them tolerable under the env var above. The other three - a section displaced by
undoing its first shot, an undo that cannot restore a previously-null section
field, and an undo that FAILS OUTRIGHT and wedges the history - are deliberately
never tolerated.

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
  including `seed` (replayed as `loadProject`/`createProject`), `driver_script`
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
