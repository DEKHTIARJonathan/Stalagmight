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
  - `pnpm agent:scenarios` - runs all 10 stress scenarios once at small n. Two of them
    are expected-red (see Stress scenarios); the gate reports those as XFAIL.
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
    hard-capped at 5 - the size of the display pool. Pinning the pool spends the
    retries the default 5-display walk would have, so entries are validated
    (`:N`, non-empty) and a pinned display that will not start is a hard error:
    the session never falls back to the real display, where the fuzzer would
    drive a visible window on the user's desktop for the length of the run. A
    cell GENERATES its own
    moves, so `STALAGMIGHT_FUZZ_REPLAY` / `_TRACE` are dropped from the child
    environment rather than inherited (an exported replay path would otherwise
    make every cell replay one trace and report a green matrix for coverage
    nothing ran). `--release=0` means what it says: the flag takes an optional
    `1/0`, `true/false`, `yes/no`, `on/off` value.
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
  `models/project/classify.rs:244`. Each is an
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
repo's own name for this build. That keeps the BODY of `debug_trigger_panic`
compiled in (the `#[cfg(any(debug_assertions, feature = "e2e"))]` sits on the
body blocks, not on the command - the command stays registered in every build so
the invoke-handler and telemetry-registry contracts are build-invariant, see
`src-tauri/src/commands/debug.rs`), so the crash-oracle self-test still works
without `debug_assertions`. The panic hook, the crash marker and the ring buffer
are not feature-gated and behave identically. `window.__E2E_TEST__` is gated on
`import.meta.env.DEV || MODE === 'test' || VITE_E2E === '1'`, and the frontend leg
is the same `pnpm build` in both profiles, so `VITE_E2E=1` supplies the hooks in a
production-mode vite build too; `waitForE2EHooks` fails the start loudly, naming
the profile and the binary path, if they are ever missing. The debug build passes
no features, so the DEFAULT build is byte-for-byte what it always was.

**What release also brings, which is not only a subtraction.** `e2e` enables
`tauri-plugin-webdriver-automation` (`src-tauri/Cargo.toml`), and `lib.rs`
registers it under `#[cfg(feature = "e2e")]`. So the two profiles differ by a
PLUGIN as well as by the compiled-out assertions above, and "release is debug
minus the `debug_assert!`s" is not the whole truth: a finding that reproduces in
one profile and not the other has a second candidate explanation, and the
comparison to reach for is the same seed in the same profile. (The WDIO tier
builds its DEBUG binary with `--features e2e` for this reason; the agent
harness deliberately does not, to leave its default build unchanged.)

**Cost.** One-time cold release build: about 3.5 minutes wall clock on the
self-hosted runner (`Finished release profile [optimized] in 2m 08s` plus the
vite leg and the link), against roughly 4.5 minutes for debug. Both profiles are
cached independently under `$CARGO_TARGET_DIR`, so switching back and forth does
not rebuild.

## Build freshness + the E2E build stamp

`app_start(build: "auto")` rebuilds when either signal says stale
(`e2e/agent/lib/build.ts`):

1. **mtimes** - any file under `src/`, `src-tauri/src/`, `src-tauri/crates/`, or one of
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

Two of them - `undo-redo-fuzz` and `undo-persistence-fuzz` - reproduce open app
bugs by construction, so they are RED by design and a green run would mean their
oracles had been weakened. They are listed in that file's `EXPECTED_RED`, which
reports them as **XFAIL** and does not fail the gate: with them failing
unconditionally the gate exited 1 whatever the other nine did, and so could no
longer answer the question it exists to answer. The other direction is enforced -
an expected-red scenario that PASSES fails the run, because that means the bug it
pins was fixed and the entry (and the scenario's header) needs updating.

| Scenario | What it asserts |
|---|---|
| `seed-large-project` | A fractal fixture opens cleanly into a multi-section single-system view. |
| `undo-redo-churn` | Create N sections, undo N + redo N; the cheap state signature returns to baseline. |
| `undo-redo-fuzz` | Seeded random mutations interleaved with random undo/redo walks; an EXACT normalized `get_project_state` roundtrip at every history depth (see below). |
| `undo-persistence-fuzz` | Builds an undo stack covering every reachable `UndoData` variant, saves/closes/reopens it, then walks the whole RESTORED history down and back up (see below). |
| `dialog-cycling` | Opening/closing dialogs leaves no residue and no DOM growth. |
| `tool-switch-spam` | `activeTool` tracks every switch. |
| `map-storm` | A seeded `jumpTo` barrage does not stall the main thread. |
| `save-under-churn` | Mutate+save leaves `isDirty=false`, no `.tmp`, and reopens clean. |
| `import-repeatedly` | Re-importing a `.tml` keeps the undo stack at or under 100. |
| `import-dialog-fuzz` | Generates `.dmp` files and walks the real DMP import UI at random; per-step coherence plus a per-flow undo-roundtrip / residue / accounting / receipt / temp-file contract (see below). |
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

A full run today (release, HEAD) costs about 135 ms/iteration on the fractal
fixture and 217 ms/iteration on naharon, against 104 / 189 before the extra
oracles - so the undoTo/redoTo equivalence check, the per-step invariant suite,
the integrity delta and the save/reload boundary together add roughly 30% and 15%
respectively. On naharon, `integrityMs` is ~4% of step time and `canonicalMs` ~7%;
the rest is still the app. Save/close/reopen is charged outside the fused step,
at roughly a second per round trip.

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
| `STALAGMIGHT_FUZZ_STREAM` | `v1` restores the ORIGINAL generator set, weights and value ranges, reproducing the legacy draw stream byte for byte. The default v2 stream adds the delete/split family, batches, comment moves, synthetic imports, boundary-biased values and per-run swarm weights - and necessarily draws differently, so v1-era repro lines need this variable. |
| `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS` | INERT. It used to keep a run going past a mismatch that was entirely a classified known bug; every classifier is deleted now that the findings are fixed, so there is nothing left to allow. Still read, and still named in the failure's `reproduce:` line, so a tolerant-looking invocation cannot be mistaken for one that relaxed something. |

Fixture choice is load-bearing, not cosmetic. The fractal fixture has no loop
closures, no zero datums and a non-null surveyor on all 32 sections; naharon has
all three plus 13 null-surveyor sections, and half the bugs below are only
reachable there.

Three oracles run, not one. The **roundtrip** comparison above; an **absolute
invariant** suite (`checkProjectInvariants`) run in-page on every observed state,
because the roundtrip only sees drift BETWEEN states and a command that corrupts
the project with an undo that faithfully restores the corruption matches at every
depth; and an **integrity delta**, which records
`check_project_integrity`'s own verdict per depth and asserts every history move
restores it. The invariant suite deliberately does not re-check what the integrity
checker owns - the split, and why, is in `fuzzOracleCore.ts`.

About 10% of history moves are taken as a MULTI-step `undoTo`/`redoTo` jump - the
history dropdown's path - verified against the same snapshots single steps
recorded. That decision is drawn from a separate PRNG (`mulberry32(seed ^
0x9e3779b9)`) so the primary draw stream every recorded repro depends on is
untouched.

Runs also cross the PERSISTENCE boundary - save to a temp path, close, reopen -
because undo history is persisted and nothing below a save point is exercised
otherwise. Save-time healing mutations and the reload's zero-trust offset
re-solve are subtracted only from comparisons that cross that boundary (an epoch
stamp per recorded depth), so within an epoch the oracle stays strict.

Each run also picks a SWARM PROFILE from the seed (merge-heavy, delete-heavy,
batch-heavy, split-heavy, move-heavy, metadata-heavy, balanced) on its own
stream, so different seeds explore different shapes of history rather than all
sampling the same uniform mix. The profile is recorded in the metrics and the log
line.

A 60-cell v2 sweep (both fixtures, seeds 1-30, x40) yielded 18 failures and a v2
repro for bugs 1, 5, 6, 7 and 8; bugs 2, 3 and 4 were not re-found and keep their
v1 lines, executable with `STALAGMIGHT_FUZZ_STREAM=v1`. The full table is in the
scenario header.

The findings are tracked at
<https://github.com/Stalagmight/Stalagmight/issues/413>, one comment per finding
with its mechanism, repro and fix direction; the scenario header is the
authoritative copy of the repro commands.

Every one of those findings is FIXED in the Rust tier, so every known-bug
classifier and every tolerance here has been deleted per the delete-when-fixed
contract: a mismatch of any shape, at any depth, fails the run again. The repro
lines are kept verbatim as regression checks, and they are GREEN.

The last one to close was found by this tier after the earlier waves: **finding
11's residue**. That fix re-applied the save heals to a restored project as a
CARRY-FORWARD from the live project, so a `ProjectSnapshotPair` recorded before a
save that RE-CREATES a section (a batch containing a create, a range-split, ...)
still came back without the gauge anchors the save captured - there was no live
section to carry them from, and roughly half the seeds on either fixture reached
it. `pnpm agent:fuzz-shrink` cut fractal seed 1 x40 to two steps for it:
`executeBatch(...+crtSec+...)` then `save`. Closed in b9d6b14b by making snapshot
pairs self-refreshing walls - an undo re-records the entry's `after` half from
the live project before restoring `before`, and a redo mirrors it, so pair
undo/redo are exact inverses by construction. No classifier was ever added for
it; the scenario stayed red until the app was fixed.

### undo-persistence-fuzz

The sibling scenario, and the one that took bug 8 seriously as a MECHANISM rather
than as a single defect. Bug 8 is "shots are renumbered on load, persisted undo
entries are opaque JSON that nothing remaps, and the in-session allocator draws
from the same id space, so a stale id collides". None of that is specific to
`CreatedShotSnapshot` - so this scenario goes looking for the siblings, on
purpose rather than by luck.

Every iteration is one complete, independent cycle:

1. open a fresh copy of the fixture with its persisted undo history stripped;
2. run a fixed COVERAGE PLAN (`undoPersistenceCoverage.ts`) whose targets and
   values are seeded but whose SET and ORDER are not, so the stack carries every
   `UndoData` variant a live command can produce;
3. assert the shot ids really have diverged from positional order (the collision
   precondition), rather than assuming the plan produced it;
4. undo a few entries so the REDO stack is non-empty at save time;
5. save, close, reopen - both stack lengths must come back exactly; and
6. unwind through every restored undo entry to depth 0, then redo back to the
   top, **through the restored redo entries**, which nothing else in the harness
   had ever exercised.

The plan's order is the load-bearing part, and it is not the obvious one.
`Shot::id` is serialized inside a project snapshot, so `UndoData::ProjectSnapshotPair`
restores the PRE-SAVE id space wholesale and heals every stale id beyond it: a
snapshot-pair entry is a WALL, and the exposed window is exactly "from the depth
the reload lands on, down to the first pair beneath it". The first arrangement put
all the pairs above the id-bearing entries and 60 iterations found nothing new;
inverted - pairs as low as their preconditions allow, every id-bearing entry
contiguous at the top - two defects fell out on the third iteration.

Beyond the main fuzzer's three oracles it adds two of its own: COVERAGE (every
variant a guaranteed plan step promises must be present on the RESTORED stack)
and STACK SURVIVAL (both lengths must equal what they were at save time). Six
`UndoData` variants are reported once per run as out of scope: `MergeInfo`,
`UnmergeInfo`, `StationMoveInfo`, `ShotSnapshot`, `SectionSnapshot` and
`ProjectSnapshot` still have restore arms in `undo()` but have no live producer
left, so a project whose history was stripped can never construct one.

| Env var | Effect |
|---|---|
| `STALAGMIGHT_FUZZ_FIXTURE` | Same as the main fuzzer: which `.stalx` to build on, by basename. |
| `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS` | INERT here too - bug 1, bug 8 and findings 11/12/13 are fixed and their classifiers deleted, so there is nothing to walk past. |
| `STALAGMIGHT_PERSIST_FUZZ_DELETE_IN_TARGET` | `1` moves the plan's mid-section delete onto the section the shot entries target. That was finding 13's repro, and it used to be terminal: the stale id ran past the renumbered range, the undo failed, and the unwind could not continue. The wedge is fixed, so the flag now walks the whole restored stack (measured: 3 cycles x 19 entries); it stays off by default because the two arrangements are different id-space shapes and the plan's coverage promises are written against the default. |

It found two new bugs, both written up on issue #413 and both now FIXED
(b9c9d649), their `open_undo_bugs_tests.rs` tests un-ignored. **Finding 12**:
after a save/reload, undo or redo of `SetShotKind` / `UpdateShot` edited the
WRONG shot - `UndoData::InverseCommand` and `UndoData::PreviousValues { shot_id }`
both named a shot by its in-session id, and `redo_inner`'s catch-all re-executed
the original command with the same id. It needed no delete, unlike bug 8; one
insert-before was enough, and nothing about the resulting project looked wrong.
**Finding 13**: when the section HAS had a shot deleted, the allocator has run
past the renumbered range, so the stale id missed instead of colliding - the undo
failed outright, `undo_inner` pushed the entry back, and the history was WEDGED
with every entry beneath it unreachable.

Both were the same root cause as bug 8 and got the same fix: undo entries address
a shot by `uuid` (the route `StationKey` and `CreatedShotSnapshot { uuid }`
already took), with a load-time pass that DROPS an entry whose target no longer
resolves rather than leaving it to wedge the stack.

Found here on naharon and since FIXED (b9d6b14b, f16c96a8): **finding 27** - an
undo of `update_shot` DROPPED `section_offsets.0` where the state it restores had
`[0,0]`. In-session (no save involved), and the exact mirror of finding 2:
a67dd1b5 made adjust-style offset writes drop a key that lands within
`OFFSET_DUST_M` of zero, and an undo re-executes the command through that same
cascade, so a key whose legitimate value is (0,0) was deleted rather than left
alone. Fixed on the rule that an inverse RESTORES rather than RE-DERIVES (the
undo data captures the rigid set's offsets pre-command and puts them back
verbatim), after which f16c96a8 made a dust-zero entry unrepresentable outright -
one normalizing writer, plus re-normalization at the loader and at snapshot
restore, the two boundaries that ingest maps this app did not write.
`STALAGMIGHT_FUZZ_FIXTURE=naharon.stalx --seed 5 --iterations 2` is kept as its
regression check; the shrinker had reduced it to five steps.

### import-dialog-fuzz

The first scenario that drives the app by CLICKING it rather than by calling
store actions, so it is the first one whose oracle has to know what is on screen.
That job belongs to `e2e/agent/lib/importScreenDigest.ts`: one self-contained
function, injected exactly the way `fuzzOracleCore.ts` injects its oracle, that
returns in a single in-page pass which screen is up, which testids are actionable
and what the project looks like. `scenarios/importDialogModel.ts` owns the screen
table, the verified testid inventory and the escape paths;
`scenarios/importDialogGenerators.ts` is the weighted move catalog;
`scenarios/importDialogBridge.ts` holds the testid ALLOWLISTS, which are the
security boundary for a replayed trace exactly as `REPLAYABLE_MUTATIONS` is for
store actions.

An EPISODE opens a fresh fixture and runs a few FLOWS with no reload between
them; a FLOW is one generated `.dmp` from an entry point to whatever ends it.
Per-step oracles cover the screen table, the error boundary, the project
invariants, unexpected error dialogs and wedges, plus an integrity check after
any step that pushed an undo entry. Per-flow oracles are in
`e2e/agent/lib/importFlowOracles.ts`: the undo roundtrip, dialog/placement/context
residue, the receipt's numbers against the project's delta, the receipt's own
rendering, and leftover staging files.

Not in `pnpm agent:scenarios`. It is listed in that file's `SMOKE_EXCLUDED` and
runs on explicit request only - `pnpm agent:scenario`, `pnpm agent:fuzz-matrix`,
or the MCP `run_scenario` tool. That is not an expected-failure list in disguise:
the scenario has no classifier and no tolerance, so a red from it is the app's.

```bash
pnpm agent:scenario import-dialog-fuzz --seed 7 --iterations 8
pnpm agent:fuzz-matrix --scenario import-dialog-fuzz --seeds 1..4 --workers 2
# sweep a knob as a third matrix dimension:
pnpm agent:fuzz-matrix --scenario import-dialog-fuzz \
  --axis STALAGMIGHT_FUZZ_IMPORT_MALFORMED_P=0,0.5,1
```

Its knobs, all read at call time so a replayed trace's restored environment
reaches them: `STALAGMIGHT_FUZZ_IMPORT_FLOWS_PER_EPISODE` (3),
`_MAX_FLOW_STEPS` (140), `_MALFORMED_P` (0.2), `_INTERJECT_P` (0.08),
`_SETTLE_MS` (12000).

The open findings it has produced are written up in the scenario file's header,
each with the `reproduce:` line that still runs.

### Three tiers, and which one gates CI

The harness is the middle tier of three, and it is worth being clear about what
each one buys:

| tier | drives | catches | runs |
|---|---|---|---|
| `src-tauri/crates/core/src/core/state/fuzz_undo_tests.rs` | `AppState` directly | undo/redo model + persistence regressions | **every CI run** |
| this harness | the real app over IPC | anything the frontend store or the IPC boundary breaks | on demand |
| `open_undo_bugs_tests.rs` | `AppState` directly | one reduction per finding, kept as its regression guard | **every CI run** |

`open_undo_bugs_tests.rs` holds nothing `#[ignore]`d today: every bug it pinned is
fixed and every test was un-ignored as the fix landed, which is what the module's
own rule asks for. Its filters are still the way to run the whole family together,
since two findings are pinned by a SEED in the fuzz module rather than by a
reduction in the red one:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  -p stalagmight-core --lib -- open_undo_bugs finding_14 bug_7
```

The Rust tier exists because the harness GATES nothing: it needs a built desktop
app and a display. It runs the same model - a canonical snapshot per undo depth, asserted
after every move - about a thousand times cheaper per sequence, which is what
makes it affordable as a `#[test]`. See docs/testing-recipes.md for how to run it
and its soak.

It is not a replacement. It cannot see the projectStore actions or the IPC
serialization, which is where the `updateSection` double-option bug (finding 5)
was found and where the undo-fails-outright bug (finding 6) surfaced. Equally it
sees two things the harness cannot: `station_offsets` / `station_comments`, which
`ProjectIpc` omits entirely, and the app's own `#[cfg(test)]`
`debug_assert_merge_alignment`. Findings 14, 16 and 17 came from those.

**Every finding the harness found is now reachable in the Rust tier too, and
classified by id there.** Its header carries a BUG IDENTIFICATION MATRIX: per
finding, the mode, seed and move count under which it fires and is named. That
is worth having for two reasons beyond convenience - a finding you can only
reach by driving a desktop app is a finding nobody re-checks after a refactor,
and the matrix is what made three duplicates and three NEW defects visible
(finding 15 is finding 3 re-measured; findings 16 and 17 and finding 14's
mirror image were found while building the modes). The harness stays the tier
that owns everything above `AppState`.

### Record, replay, shrink

Triage used to be the expensive human step: a failure gave you a seed and an
iteration count, and finding out which of the 37 mutations mattered meant seed
sweeps and bisecting by eye. Both fuzzers now record a TRACE, replay one, and
minimize one automatically.

**Record.** Every fuzz run collects its RESOLVED move list - each generator draw
already collapsed into a concrete `projectStore` action and its arguments - and
writes it to `<session>/traces/<scenario>-seed<N>-<stamp>.json` whenever the run
FAILS. The path is appended to the failure message. `STALAGMIGHT_FUZZ_TRACE=path`
also writes the trace of a run that PASSED, which is how you capture a baseline
to shrink against later. Recording is observe-only - it draws nothing, reads no
app state and runs after the decision it records - so a seed's trajectory is
identical with it on or off (re-verified against the bug 1 and bug 8 repro
lines).

The header carries scenario, seed, iterations, fixture, generator stream, the
`STALAGMIGHT_*` knobs that were set, the git rev and the failure message with its
parsed signature. `undo-persistence-fuzz` resets its recorder per iteration,
because its cycles are independent: the trace is of the cycle that failed.

**Replay.**

```
pnpm agent:scenario undo-redo-fuzz --trace <file> [--release]
```

Replay is a MODE of the scenario, never a separate one. Only the source of the
decisions changes: the fused step, the three oracles, the model bookkeeping, the
classification and the failure payload are the same code, so a replayed failure
is the same failure rather than a lookalike. A replayed run says so in its
`reproduce:` line.

The recording's ENVIRONMENT is part of the repro, so `--trace` restores the
header's `STALAGMIGHT_*` knobs (fixture, tolerance, stream, the persistence
ones) and prints what it restored. It has to happen before `./scenarios` is
imported - the fuzz scenarios freeze those knobs into module-level constants at
import time - which is why both `agent:scenario` and `agent:fuzz-shrink` import
the registry dynamically. A trace recorded by a different scenario, or on a
different fixture, is REFUSED: the steps carry resolved section and shot ids, so
replaying them against another project drives moves at ids that do not exist
there and reports an invented failure (or none) while the operator believes they
are looking at the recorded one.

Two rules make replay work on a trace that has been CUT, which is what the
shrinker needs:

- a history move whose precondition no longer holds (undo at depth 0, redo at
  the top) is SKIPPED, and a jump wider than the reach is CLAMPED to it. Skipping
  asserts nothing, so it cannot turn a failing candidate green by hiding
  something; it just declines to pretend a move was possible. Every skip is
  counted.
- the closing unwind/rewind is never recorded and always REGENERATED. A shrink
  therefore cannot remove the walk that visits every depth in both directions,
  which is where most failures are actually observed.

`undo-persistence-fuzz` skips its PLAN's own preconditions on a replay - id
divergence, the renumbering check, variant coverage - because a shrunk trace is
by construction not the plan. No app oracle is skipped on either scenario.

**Shrink.**

```
pnpm agent:fuzz-shrink <trace.json> [--release] [--max-tests N] [--out FILE]
```

Textbook ddmin (`e2e/agent/lib/fuzzShrink.ts`) over the recorded move list, with
a candidate cache. It replays the whole trace first to establish the baseline
signature, then repeatedly replays subsequences until no single step can be
removed, and writes `<trace>.min.json` plus a numbered action list.

Exit status is the signal, so a recorded trace doubles as a regression check:
**0** only when the trace reproduced and was minimized, **1** when it replayed
GREEN (the bug is fixed, or the failure needed something the trace does not
carry) or the shrink itself threw.

A candidate "preserves" the failure only when its FailureSignature matches:
headline, first differing path, the `error:` line of a move that failed outright,
and every classifier id the message named. Digits and array indices are
normalized out of those, because removing a mutation moves every depth and index
while the defect stays the same; the sentence shape, the field at the end of the
path and the classifier ids are NOT normalized, so a candidate that fails
DIFFERENTLY is rejected exactly like one that passes. That is standard ddmin
practice and it is what stops a shrink wandering onto one of the other ten open
bugs; the count of rejected-as-divergent candidates is reported.

Measured, on the two current reds:

| trace | before | after | replays | divergent, rejected | per replay | wall clock |
|---|---|---|---|---|---|---|
| bug 1 (`undo-redo-fuzz`, fractal seed 1 x40) | 43 | **2** | 28 (+20 cached) | 3 | 1.8 s | 52.5 s |
| finding 12 (`undo-persistence-fuzz`, seed 1 x1, strict) | 20 | **4** | 58 (+41 cached) | 20 | 1.7 s | 97.6 s |

Both results are 1-minimal, and both replay deterministically twice. The finding
12 one is the better demonstration: its minimal list is

```
1. createSection(shots=3)
2. createShot(s=32,before=3200000)
3. setShotKind(s=32,shot=3200003,Jump)
4. save
```

which is, step for step, the synthetic Rust test that was written for that
finding by hand - create a section, insert before the first shot so the ids stop
matching positional order, mark a shot whose id will land on a different slot,
save. The shrinker got there from a 20-step cycle without being told what the bug
was. Its 20 divergent rejections are the guard doing its job: subsets that still
failed, but as bug 8 or as the stale-id wedge rather than as finding 12.

The whole shrink runs against ONE app session -
each scenario run already closes the project, materializes a fresh fixture copy,
strips its history and asserts both stacks came up empty, so a replay inherits
nothing from the one before it.

**From a shrunk trace to a red Rust test.** The action list is already the test
body: each `mutate` line is one `Command` with its arguments, in order, and the
`save` line is `state.save_project(Some(path))` followed by a reopen if the trace
crossed the boundary. Add the closing `undo()` / `redo()` walk the replayer
regenerates, assert what the fuzzer's diff said should have been restored, and
`#[ignore]` it per the convention in
`src-tauri/crates/core/src/core/state/open_undo_bugs_tests.rs`. Everything is synthetic by
construction - a trace holds generated values, never fixture data.

**One caveat, worth knowing before you trust a minimal trace.** ddmin finds the
smallest input with the same SIGNATURE, and two defects that produce the same
message are indistinguishable to it. The bug 1 shrink above lands on
`executeBatch(...)` + `save`, whose failure is really finding 11 (a pre-save
snapshot pair reverting the save's gauge capture) - `undo-redo-fuzz` has no
classifier that separates the two, so both read as
`create-section-redo-drops-gauge-anchors`. The shrinker did exactly what it
promises; the ambiguity is in the message. Read the minimal action list before
writing the test, and if it does not look like the bug you started from, that
ambiguity is the reason. (`undo-persistence-fuzz` names the entry each move
consumed, which is what resolves it there.)

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

- **Ring buffer** (`src-tauri/crates/telemetry/src/logging/mod.rs`): `VecDeque<RingLogEntry>`
  (`{seq, ts_ms, line}`), cap 500. `get_recent_logs_since(after_seq)` returns
  `{entries, latest_seq, dropped}` where `dropped` is true when the ring rotated
  past the checkpoint.
- **Rust panic hook** (`src-tauri/crates/telemetry/src/logging/panic_hook.rs`): writes a
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
